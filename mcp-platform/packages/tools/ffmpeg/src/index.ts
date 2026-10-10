/**
 * FFmpeg tool package: probe, frame extraction (returned as images the assistant can see), audio
 * extraction and preset-based transcoding. Outputs are written to a temporary name and renamed on
 * success, so cancelled or failed jobs never leave half-written files behind.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  defineTool,
  defineToolPackage,
  image,
  text,
  throwIfAborted,
  type ContentPart,
} from "@lmp/core";
import { canonicalizePath, cacheKey, locateFfmpeg, probeMedia, runFfmpeg, safeFileName, type FfmpegBinaries, type MediaInfo } from "@lmp/toolkit";
import { z } from "zod";
import { PRESETS, PRESET_NAMES } from "./presets.js";

const SettingsSchema = z
  .object({
    ffmpegPath: z.string().optional(),
    ffprobePath: z.string().optional(),
  })
  .strict();

const PATH = z.string().min(1).max(32_767).describe("Absolute path");
const SECONDS = z.number().min(0).max(24 * 3600);
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });

const fingerprint = async (p: string) => {
  const s = await stat(p).catch(() => undefined);
  return s ? [s.size, Math.trunc(s.mtimeMs)] : null;
};

const MediaInfoSchema = z.object({
  path: z.string(),
  formatName: z.string().nullable(),
  durationSec: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  bitRate: z.number().nullable(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  streams: z.array(z.record(z.string(), z.unknown())),
});

export function describeMedia(info: MediaInfo): string {
  const lines = [`${info.path}`, `format ${info.formatName ?? "?"}, duration ${info.durationSec?.toFixed(3) ?? "?"} s, ${info.sizeBytes ?? "?"} bytes`];
  for (const s of info.streams) {
    if (s.type === "video") lines.push(`#${s.index} video ${s.codec} ${s.width}x${s.height} @ ${s.fps ?? "?"} fps${s.rotation ? `, rotated ${s.rotation}°` : ""}`);
    else if (s.type === "audio") lines.push(`#${s.index} audio ${s.codec} ${s.sampleRate ?? "?"} Hz ${s.channels ?? "?"} ch`);
    else lines.push(`#${s.index} ${s.type} ${s.codec ?? ""}`);
  }
  return lines.join("\n");
}

/** Writes through a temporary sibling file; renames on success, deletes on failure/cancel. */
async function withTempOutput<T>(output: string, overwrite: boolean, work: (temp: string) => Promise<T>): Promise<T> {
  const existing = await stat(output).catch(() => undefined);
  if (existing && !overwrite) throw new ConflictError(`${output} already exists. Set overwrite to replace it.`);
  if (existing?.isDirectory()) throw new ConflictError(`${output} is a folder.`);
  const ext = path.extname(output);
  const temp = path.join(path.dirname(output), `.${path.basename(output, ext)}.${randomBytes(4).toString("hex")}.partial${ext}`);
  try {
    const result = await work(temp);
    await rename(temp, output);
    return result;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export default defineToolPackage({
  manifest: {
    id: "ffmpeg",
    version: "0.1.0",
    displayName: "FFmpeg",
    description: "Probe media, extract audio and frames, and transcode with safe presets using the local FFmpeg.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["fs.read", "fs.write", "process.spawn"],
  },
  configSchema: SettingsSchema,
  register: ({ config, services }) => {
    const binaries = (): Promise<FfmpegBinaries> => locateFfmpeg(config, "tools.settings.ffmpeg");
    const spawn = (name: string) => ({ kind: "process.spawn" as const, target: name, reason: "run the local media engine" });
    const probe = async (file: string, signal: AbortSignal) => probeMedia((await binaries()).ffprobe, file, signal);

    return {
      tools: [
        defineTool({
          name: "ffmpeg.probe",
          title: "Media information",
          description: "Container, duration, size and every stream (codec, resolution, frame rate, rotation, sample rate, channels) of a media file.",
          input: z.object({ path: PATH }).strict(),
          output: MediaInfoSchema,
          annotations: READ_ONLY,
          execution: { resourceClass: "io", timeoutMs: 60_000 },
          cache: { ttlMs: 30 * 24 * 3600 * 1000, key: (input) => fingerprint(input.path) },
          capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "inspect media" }, spawn("ffprobe")],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
            const info = await probe(file, ctx.signal);
            return { content: [text(describeMedia(info))], structured: { ...info, streams: info.streams.map((s) => ({ ...s })) } };
          },
        }),

        defineTool({
          name: "ffmpeg.extract_frames",
          title: "Look at frames",
          description:
            "Extracts still frames as images the assistant can see: either explicit times (seconds) or a number of evenly spaced frames. Use to review footage, check framing, or pick cut points.",
          input: z
            .object({
              path: PATH,
              times: z.array(SECONDS).min(1).max(24).optional(),
              count: z.number().int().min(1).max(24).optional(),
              width: z.number().int().min(64).max(1920).default(768),
              format: z.enum(["jpeg", "png"]).default("jpeg"),
            })
            .strict()
            .refine((v) => (v.times === undefined) !== (v.count === undefined), { message: "Provide exactly one of times or count" }),
          annotations: READ_ONLY,
          execution: { resourceClass: "external", timeoutMs: 5 * 60_000 },
          cache: { ttlMs: 24 * 3600 * 1000, key: (input) => fingerprint(input.path) },
          capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "read video frames" }, spawn("ffmpeg")],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            const { ffmpeg } = await binaries();
            const info = await probe(file, ctx.signal);
            if (!info.hasVideo) throw new ValidationError(`${file} has no video stream.`);
            const duration = info.durationSec ?? 0;
            const times = input.times ?? Array.from({ length: input.count ?? 1 }, (_, i) => ((i + 0.5) * duration) / (input.count ?? 1));
            const outDir = path.join(services.artifactsDir, "frames", cacheKey(file, info.sizeBytes, input.width, input.format).slice(0, 16));
            await mkdir(outDir, { recursive: true });
            const ext = input.format === "png" ? "png" : "jpg";
            const content: ContentPart[] = [];
            const frames: Array<{ time: number; file: string }> = [];
            for (const [i, rawTime] of times.entries()) {
              throwIfAborted(ctx.signal);
              const time = Math.max(0, Math.min(rawTime, Math.max(0, duration - 0.05)));
              const target = path.join(outDir, `frame_${String(i).padStart(2, "0")}_${time.toFixed(3)}.${ext}`);
              await runFfmpeg(
                ffmpeg,
                ["-y", "-ss", time.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${input.width}:-2`, ...(ext === "jpg" ? ["-q:v", "3"] : []), target],
                { signal: ctx.signal },
              );
              const data = await readFile(target);
              content.push(text(`Frame at ${time.toFixed(2)} s:`), image(data.toString("base64"), ext === "png" ? "image/png" : "image/jpeg"));
              frames.push({ time, file: target });
              ctx.progress({ progress: i + 1, total: times.length, message: `frame ${i + 1}/${times.length}` });
            }
            return { content, structured: { path: file, durationSec: duration, frames } };
          },
        }),

        defineTool({
          name: "ffmpeg.extract_audio",
          title: "Extract audio",
          description:
            "Extracts the audio track to WAV/MP3/FLAC (optionally a time range, resampled, mono/stereo). Without an output path the file is written to the platform's artifacts folder.",
          input: z
            .object({
              path: PATH,
              output: PATH.optional(),
              format: z.enum(["wav", "mp3", "flac"]).default("wav"),
              sampleRate: z.number().int().min(8000).max(96_000).default(48_000),
              channels: z.number().int().min(1).max(2).default(2),
              startSec: SECONDS.optional(),
              durationSec: SECONDS.optional(),
              overwrite: z.boolean().default(false),
            })
            .strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 3 * 3600_000 },
          capabilities: (input) => [
            { kind: "fs.read", target: input.path, reason: "read media" },
            ...(input.output ? [{ kind: "fs.write" as const, target: input.output, reason: "write extracted audio" }] : []),
            spawn("ffmpeg"),
          ],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            const { ffmpeg } = await binaries();
            const info = await probe(file, ctx.signal);
            if (!info.hasAudio) throw new ValidationError(`${file} has no audio stream.`);
            const output = input.output
              ? await canonical(input.output)
              : path.join(services.artifactsDir, "audio", `${safeFileName(path.parse(file).name)}_${cacheKey(file, info.sizeBytes, input).slice(0, 10)}.${input.format}`);
            if (path.extname(output).toLowerCase() !== `.${input.format}`) throw new ValidationError(`Output must end with .${input.format}`);
            await mkdir(path.dirname(output), { recursive: true });
            const range = Math.max(0, (info.durationSec ?? 0) - (input.startSec ?? 0));
            const span = input.durationSec !== undefined ? Math.min(input.durationSec, range) : range;
            const codec = input.format === "wav" ? ["-c:a", "pcm_s16le"] : input.format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "256k"] : ["-c:a", "flac"];
            await withTempOutput(output, input.overwrite || !input.output, (temp) =>
              runFfmpeg(
                ffmpeg,
                [
                  ...(input.startSec !== undefined ? ["-ss", input.startSec.toFixed(3)] : []),
                  "-i", file,
                  ...(input.durationSec !== undefined ? ["-t", input.durationSec.toFixed(3)] : []),
                  "-vn", "-map", "0:a:0", ...codec, "-ar", String(input.sampleRate), "-ac", String(input.channels), "-y", temp,
                ],
                { signal: ctx.signal, durationSec: span, onProgress: (f) => ctx.progress({ progress: Math.round(f * 1000) / 10, total: 100, message: "extracting audio" }) },
              ),
            );
            const size = (await stat(output)).size;
            return {
              content: [text(`Audio written to ${output} (${size} bytes, ${span.toFixed(2)} s, ${input.sampleRate} Hz, ${input.channels} ch).`)],
              structured: { output, bytes: size, durationSec: span },
            };
          },
        }),

        defineTool({
          name: "ffmpeg.transcode",
          title: "Transcode",
          description: `Converts a media file with a named preset (optionally a time range). Presets: ${PRESET_NAMES.map((n) => `${n} - ${PRESETS[n].description}`).join("; ")}.`,
          input: z
            .object({
              path: PATH,
              output: PATH,
              preset: z.enum(PRESET_NAMES),
              startSec: SECONDS.optional(),
              durationSec: SECONDS.optional(),
              overwrite: z.boolean().default(false),
            })
            .strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 12 * 3600_000 },
          capabilities: (input) => [
            { kind: "fs.read", target: input.path, reason: "read source media" },
            { kind: "fs.write", target: input.output, reason: "write converted media" },
            spawn("ffmpeg"),
          ],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            const output = await canonical(input.output);
            if (file.toLowerCase() === output.toLowerCase()) throw new ValidationError("Output must differ from the input file.");
            const preset = PRESETS[input.preset];
            const ext = path.extname(output).toLowerCase();
            if (!(preset.extensions as readonly string[]).includes(ext)) throw new ValidationError(`Preset ${input.preset} writes ${preset.extensions.join("/")} files, not ${ext || "(none)"}.`);
            if (!(await stat(path.dirname(output)).catch(() => undefined))?.isDirectory()) throw new NotFoundError(`Output folder does not exist: ${path.dirname(output)}`);
            const { ffmpeg } = await binaries();
            const info = await probe(file, ctx.signal);
            if (!("audioOnly" in preset && preset.audioOnly) && !info.hasVideo) throw new ValidationError(`${file} has no video stream; use an audio preset.`);
            const range = Math.max(0, (info.durationSec ?? 0) - (input.startSec ?? 0));
            const span = input.durationSec !== undefined ? Math.min(input.durationSec, range) : range;
            const started = Date.now();
            await withTempOutput(output, input.overwrite, (temp) =>
              runFfmpeg(
                ffmpeg,
                [
                  ...(input.startSec !== undefined ? ["-ss", input.startSec.toFixed(3)] : []),
                  "-i", file,
                  ...(input.durationSec !== undefined ? ["-t", input.durationSec.toFixed(3)] : []),
                  ...preset.args, "-y", temp,
                ],
                { signal: ctx.signal, durationSec: span, onProgress: (f) => ctx.progress({ progress: Math.round(f * 1000) / 10, total: 100, message: `transcoding (${input.preset})` }) },
              ),
            );
            const size = (await stat(output)).size;
            return {
              content: [text(`Converted to ${output} with ${input.preset} in ${((Date.now() - started) / 1000).toFixed(1)} s (${size} bytes).`)],
              structured: { output, preset: input.preset, bytes: size, durationSec: span },
            };
          },
        }),
      ],
    };
  },
});
