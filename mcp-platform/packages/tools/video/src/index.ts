/**
 * Video analysis package. Everything runs through the local FFmpeg filters; results are compact
 * structured data (segments, timestamps, measurements) plus a readable summary for the assistant.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  NotFoundError,
  ValidationError,
  defineTool,
  defineToolPackage,
  image,
  text,
} from "@lmp/core";
import { cacheKey, canonicalizePath, locateFfmpeg, probeMedia, runFfmpeg, type FfmpegBinaries, type MediaInfo } from "@lmp/toolkit";
import { z } from "zod";
import { SilenceCollector, parseEbur128Summary, parseShowinfoTime, round3, speechSegments } from "./parsers.js";

const PATH = z.string().min(1).max(32_767).describe("Absolute path of a local media file");
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });
const fingerprint = async (p: string) => {
  const s = await stat(p).catch(() => undefined);
  return s ? [s.size, Math.trunc(s.mtimeMs)] : null;
};
const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

const SettingsSchema = z.object({ ffmpegPath: z.string().optional(), ffprobePath: z.string().optional() }).strict();

export default defineToolPackage({
  manifest: {
    id: "video",
    version: "0.1.0",
    displayName: "Video analysis",
    description: "Silence, scene, loudness and contact-sheet analysis of local media with FFmpeg.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["fs.read", "process.spawn"],
  },
  configSchema: SettingsSchema,
  register: ({ config, services }) => {
    const binaries = (): Promise<FfmpegBinaries> => locateFfmpeg(config, "tools.settings.video");
    const access = (p: string, reason: string) => [
      { kind: "fs.read" as const, target: p, reason },
      { kind: "process.spawn" as const, target: "ffmpeg", reason: "run the local media engine" },
    ];
    const open = async (p: string, signal: AbortSignal): Promise<{ file: string; info: MediaInfo; ffmpeg: string }> => {
      const file = await canonical(p);
      if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
      const bins = await binaries();
      return { file, info: await probeMedia(bins.ffprobe, file, signal), ffmpeg: bins.ffmpeg };
    };
    const percent = (ctx: { progress: (r: { progress: number; total: number; message: string }) => void }, message: string) => (f: number) =>
      ctx.progress({ progress: Math.round(f * 1000) / 10, total: 100, message });

    return {
      tools: [
        defineTool({
          name: "video.detect_silence",
          title: "Find pauses and speech",
          description:
            "Finds silent pauses in the audio and returns the speech segments between them (with padding). Use to plan jump cuts or remove dead air. Times are in seconds from the start of the file.",
          input: z
            .object({
              path: PATH,
              noiseDb: z.number().min(-90).max(-10).default(-35).describe("Below this level counts as silence (dBFS)"),
              minSilenceSec: z.number().min(0.05).max(30).default(0.4),
              padSec: z.number().min(0).max(2).default(0.1).describe("Kept around each speech segment"),
              minSpeechSec: z.number().min(0).max(10).default(0.15),
            })
            .strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 2 * 3600_000 },
          cache: { ttlMs: 30 * 24 * 3600 * 1000, key: (input) => fingerprint(input.path) },
          capabilities: (input) => access(input.path, "analyse audio levels"),
          run: async (input, ctx) => {
            const { file, info, ffmpeg } = await open(input.path, ctx.signal);
            if (!info.hasAudio) throw new ValidationError(`${file} has no audio stream.`);
            const total = info.durationSec ?? 0;
            const collector = new SilenceCollector();
            await runFfmpeg(ffmpeg, ["-i", file, "-map", "0:a:0", "-vn", "-af", `silencedetect=noise=${input.noiseDb}dB:d=${input.minSilenceSec}`, "-f", "null", "-"], {
              signal: ctx.signal,
              durationSec: total,
              onStderrLine: (line) => collector.line(line),
              onProgress: percent(ctx, "detecting silence"),
            });
            const silences = collector.finish(total).map((s) => ({ start: round3(s.start), end: round3(s.end) }));
            const speech = speechSegments(silences, total, input.padSec, input.minSpeechSec);
            const silentSec = silences.reduce((a, s) => a + (s.end - s.start), 0);
            const speechSec = speech.reduce((a, s) => a + (s.end - s.start), 0);
            const summary =
              `${file}: ${silences.length} pauses (${silentSec.toFixed(1)} s silent of ${total.toFixed(1)} s); ` +
              `${speech.length} speech segments totalling ${speechSec.toFixed(1)} s.\n` +
              speech.slice(0, 200).map((s, i) => `${i + 1}. ${fmt(s.start)} – ${fmt(s.end)}`).join("\n") +
              (speech.length > 200 ? `\n… ${speech.length - 200} more in structured output` : "");
            return { content: [text(summary)], structured: { path: file, durationSec: total, silences, speech, silentSec: round3(silentSec), speechSec: round3(speechSec) } };
          },
        }),

        defineTool({
          name: "video.detect_scenes",
          title: "Find scene changes",
          description: "Detects shot/scene changes (cuts) in the video and returns their times in seconds.",
          input: z
            .object({
              path: PATH,
              threshold: z.number().min(0.05).max(0.9).default(0.3).describe("Lower finds more (subtler) changes"),
              minSceneSec: z.number().min(0).max(60).default(0.5),
              maxScenes: z.number().int().min(1).max(2000).default(500),
            })
            .strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 3 * 3600_000 },
          cache: { ttlMs: 30 * 24 * 3600 * 1000, key: (input) => fingerprint(input.path) },
          capabilities: (input) => access(input.path, "analyse video"),
          run: async (input, ctx) => {
            const { file, info, ffmpeg } = await open(input.path, ctx.signal);
            if (!info.hasVideo) throw new ValidationError(`${file} has no video stream.`);
            const cuts: number[] = [];
            let dropped = 0;
            await runFfmpeg(ffmpeg, ["-i", file, "-map", "0:v:0", "-an", "-vf", `scale=320:-2,select='gt(scene\\,${input.threshold})',showinfo`, "-f", "null", "-"], {
              signal: ctx.signal,
              durationSec: info.durationSec,
              onProgress: percent(ctx, "detecting scenes"),
              onStderrLine: (line) => {
                const t = parseShowinfoTime(line);
                if (t === null) return;
                const prev = cuts.at(-1) ?? 0;
                if (t - prev < input.minSceneSec) return;
                if (cuts.length >= input.maxScenes) {
                  dropped++;
                  return;
                }
                cuts.push(round3(t));
              },
            });
            const total = info.durationSec ?? 0;
            const bounds = [0, ...cuts, total];
            const scenes = bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] ?? total }));
            return {
              content: [text(`${file}: ${cuts.length} cuts, ${scenes.length} scenes${dropped ? ` (${dropped} more cuts beyond maxScenes)` : ""}.\n${cuts.map((c, i) => `${i + 1}. ${fmt(c)}`).join("\n")}`)],
              structured: { path: file, durationSec: total, cuts, scenes, truncated: dropped > 0 },
            };
          },
        }),

        defineTool({
          name: "video.loudness",
          title: "Measure loudness",
          description:
            "Measures integrated loudness (LUFS), loudness range and true peak (EBU R128), and the gain needed to reach common targets (-14 LUFS social/streaming, -16 podcasts, -23 broadcast).",
          input: z.object({ path: PATH }).strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 2 * 3600_000 },
          cache: { ttlMs: 30 * 24 * 3600 * 1000, key: (input) => fingerprint(input.path) },
          capabilities: (input) => access(input.path, "measure loudness"),
          run: async (input, ctx) => {
            const { file, info, ffmpeg } = await open(input.path, ctx.signal);
            if (!info.hasAudio) throw new ValidationError(`${file} has no audio stream.`);
            const tail: string[] = [];
            await runFfmpeg(ffmpeg, ["-i", file, "-map", "0:a:0", "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], {
              signal: ctx.signal,
              durationSec: info.durationSec,
              onProgress: percent(ctx, "measuring loudness"),
              onStderrLine: (line) => {
                tail.push(line);
                if (tail.length > 60) tail.shift();
              },
            });
            const m = parseEbur128Summary(tail);
            const gainTo = (target: number) => (m.integratedLufs === null ? null : Math.round((target - m.integratedLufs) * 10) / 10);
            const targets = { social: gainTo(-14), podcast: gainTo(-16), broadcast: gainTo(-23) };
            return {
              content: [
                text(
                  `${file}: integrated ${m.integratedLufs ?? "?"} LUFS, range ${m.loudnessRangeLu ?? "?"} LU, true peak ${m.truePeakDbfs ?? "?"} dBFS. ` +
                    `Gain to -14 LUFS: ${targets.social ?? "?"} dB, -16: ${targets.podcast ?? "?"} dB, -23: ${targets.broadcast ?? "?"} dB.`,
                ),
              ],
              structured: { path: file, ...m, gainDb: targets },
            };
          },
        }),

        defineTool({
          name: "video.contact_sheet",
          title: "Contact sheet",
          description: "One image with evenly spaced thumbnails of the whole video (grid), so the assistant can see the content at a glance.",
          input: z
            .object({
              path: PATH,
              columns: z.number().int().min(2).max(8).default(4),
              rows: z.number().int().min(1).max(8).default(4),
              tileWidth: z.number().int().min(120).max(480).default(320),
            })
            .strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "external", timeoutMs: 30 * 60_000 },
          cache: { ttlMs: 7 * 24 * 3600 * 1000, key: (input) => fingerprint(input.path) },
          capabilities: (input) => access(input.path, "read video frames"),
          run: async (input, ctx) => {
            const { file, info, ffmpeg } = await open(input.path, ctx.signal);
            if (!info.hasVideo) throw new ValidationError(`${file} has no video stream.`);
            const tiles = input.columns * input.rows;
            const total = info.durationSec ?? 0;
            if (total <= 0) throw new ValidationError(`${file} has no measurable duration.`);
            const interval = total / tiles;
            const out = path.join(services.artifactsDir, "contact-sheets", `${cacheKey(file, info.sizeBytes, input).slice(0, 20)}.jpg`);
            await mkdir(path.dirname(out), { recursive: true });
            await runFfmpeg(
              ffmpeg,
              [
                "-i", file, "-map", "0:v:0", "-an",
                "-vf", `fps=1/${interval.toFixed(6)},scale=${input.tileWidth}:-2,tile=${input.columns}x${input.rows}:padding=4:margin=4`,
                "-frames:v", "1", "-q:v", "4", "-y", out,
              ],
              { signal: ctx.signal, durationSec: total, onProgress: percent(ctx, "building contact sheet") },
            );
            const data = await readFile(out);
            const times = Array.from({ length: tiles }, (_, i) => round3(Math.min(total, (i + 0.5) * interval)));
            return {
              content: [
                image(data.toString("base64"), "image/jpeg"),
                text(`${file}: ${input.columns}x${input.rows} thumbnails, left-to-right then top-to-bottom, about every ${interval.toFixed(1)} s (first at ~${fmt(times[0] ?? 0)}).`),
              ],
              structured: { path: file, sheet: out, columns: input.columns, rows: input.rows, approxTimes: times },
            };
          },
        }),
      ],
    };
  },
});
