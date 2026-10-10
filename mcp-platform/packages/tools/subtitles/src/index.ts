/**
 * Subtitles package: offline transcription with whisper.cpp, readable caption building, and
 * SRT/WebVTT reading, writing and reformatting. The assistant can proofread the returned text and
 * write the corrected captions back with subtitles.write, then import them with
 * editor.import_subtitles.
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ConflictError, NotFoundError, ValidationError, defineTool, defineToolPackage, text } from "@lmp/core";
import { cacheKey, canonicalizePath, locateFfmpeg, probeMedia, runFfmpeg, safeFileName, writeFileAtomic } from "@lmp/toolkit";
import { z } from "zod";
import { DEFAULT_READABILITY, applyCase, buildCues, formatTimestamp, parseSubtitles, toSrt, toVtt, type Cue } from "./cues.js";
import { defaultThreads, listModels, locateWhisper, modelsDirectory, resolveModel, runWhisper } from "./whisper.js";

const SettingsSchema = z
  .object({
    whisperPath: z.string().optional(),
    ffmpegPath: z.string().optional(),
    ffprobePath: z.string().optional(),
    modelsDir: z.string().optional(),
    defaultModel: z.string().default("base"),
    threads: z.number().int().min(1).max(64).optional(),
  })
  .strict();

const PATH = z.string().min(1).max(32_767).describe("Absolute path");
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });
const LAYOUT = {
  maxChars: z.number().int().min(10).max(80).default(42).describe("Characters per line"),
  maxLines: z.number().int().min(1).max(3).default(2),
  maxDurationSec: z.number().min(1).max(10).default(6),
};
const CueSchema = z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string().min(1).max(500) }).refine((c) => c.end > c.start, { message: "end must be after start" });

function preview(cues: readonly Cue[], limit = 120): string {
  const lines = cues.slice(0, limit).map((c, i) => `${i + 1}. [${formatTimestamp(c.start, "srt")}] ${c.text.replace(/\n/g, " / ")}`);
  return lines.join("\n") + (cues.length > limit ? `\n… ${cues.length - limit} more cues` : "");
}

async function writeSubtitles(file: string, cues: readonly Cue[], overwrite: boolean): Promise<"srt" | "vtt"> {
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".srt" && ext !== ".vtt") throw new ValidationError("Subtitle files must end with .srt or .vtt");
  if (!overwrite && (await stat(file).catch(() => undefined))) throw new ConflictError(`${file} already exists. Set overwrite to replace it.`);
  // UTF-8 with BOM: Premiere and Windows tools read non-English captions (Uzbek, Russian) reliably.
  const body = ext === ".srt" ? toSrt(cues) : toVtt(cues);
  await writeFileAtomic(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body.replace(/\n/g, "\r\n"), "utf8")]));
  return ext === ".srt" ? "srt" : "vtt";
}

export default defineToolPackage({
  manifest: {
    id: "subtitles",
    version: "0.1.0",
    displayName: "Subtitles",
    description: "Offline speech-to-text with whisper.cpp and subtitle files (SRT/VTT) for the editors.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["fs.read", "fs.write", "process.spawn"],
  },
  configSchema: SettingsSchema,
  register: ({ config, services }) => {
    const settings = { ...config, defaultModel: config.defaultModel };
    return {
      tools: [
        defineTool({
          name: "subtitles.models",
          title: "Speech models",
          description: "Installed whisper.cpp speech models (larger = more accurate, slower).",
          input: z.object({}).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async () => {
            const dir = modelsDirectory(settings);
            const models = await listModels(dir);
            return {
              content: [text(models.length ? models.map((m) => `${m.name} (${Math.round(m.bytes / 1_048_576)} MB)`).join("\n") : `No speech models found${dir ? ` in ${dir}` : ""}.`)],
              structured: { directory: dir ?? null, models, default: settings.defaultModel },
            };
          },
        }),

        defineTool({
          name: "subtitles.transcribe",
          title: "Transcribe to subtitles (offline)",
          description:
            "Transcribes speech from a media file on this computer with whisper.cpp (no internet) and writes readable subtitles (.srt/.vtt). Returns the captions so you can proofread them; write corrections with subtitles.write.",
          input: z
            .object({
              path: PATH,
              language: z.string().regex(/^(auto|[a-z]{2,3})$/).default("auto").describe('ISO code such as "uz", "ru", "en", or "auto"'),
              model: z.string().max(40).optional(),
              translateToEnglish: z.boolean().default(false),
              prompt: z.string().max(800).optional().describe("Names and terms that should be spelled exactly (improves accuracy)"),
              startSec: z.number().min(0).optional(),
              durationSec: z.number().min(0.5).optional(),
              output: PATH.optional().describe("Where to write the .srt/.vtt; default: artifacts folder"),
              overwrite: z.boolean().default(false),
              ...LAYOUT,
            })
            .strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 6 * 3600_000 },
          cache: {
            ttlMs: 30 * 24 * 3600_000,
            key: async (input) => {
              const s = await stat(input.path).catch(() => undefined);
              return s ? [s.size, Math.trunc(s.mtimeMs)] : null;
            },
          },
          capabilities: (input) => [
            { kind: "fs.read", target: input.path, reason: "read speech audio" },
            ...(input.output ? [{ kind: "fs.write" as const, target: input.output, reason: "write subtitles" }] : []),
            { kind: "process.spawn", target: "ffmpeg", reason: "prepare audio" },
            { kind: "process.spawn", target: "whisper-cli", reason: "offline speech recognition" },
          ],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
            const [whisper, { ffmpeg, ffprobe }, model] = await Promise.all([
              locateWhisper(settings),
              locateFfmpeg(config, "tools.settings.subtitles"),
              resolveModel(settings, input.model),
            ]);
            const info = await probeMedia(ffprobe, file, ctx.signal);
            if (!info.hasAudio) throw new ValidationError(`${file} has no audio stream.`);
            const work = path.join(services.artifactsDir, "transcribe", cacheKey(file, info.sizeBytes, input).slice(0, 16));
            await mkdir(work, { recursive: true });
            try {
              const wav = path.join(work, "speech.wav");
              const span = input.durationSec ?? Math.max(0, (info.durationSec ?? 0) - (input.startSec ?? 0));
              ctx.progress({ progress: 0, total: 100, message: "preparing audio" });
              await runFfmpeg(
                ffmpeg,
                [
                  ...(input.startSec !== undefined ? ["-ss", input.startSec.toFixed(3)] : []),
                  "-i", file,
                  ...(input.durationSec !== undefined ? ["-t", input.durationSec.toFixed(3)] : []),
                  "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wav,
                ],
                { signal: ctx.signal, durationSec: span, onProgress: (f) => ctx.progress({ progress: Math.round(f * 10), total: 100, message: "preparing audio" }) },
              );
              const transcript = await runWhisper(whisper, {
                wav,
                model: model.file,
                language: input.language,
                translate: input.translateToEnglish,
                prompt: input.prompt,
                outBase: path.join(work, "transcript"),
                threads: settings.threads ?? defaultThreads(),
                signal: ctx.signal,
                onProgress: (p) => ctx.progress({ progress: 10 + Math.round(p * 0.88), total: 100, message: `recognising speech (${model.name})` }),
              });
              const offset = input.startSec ?? 0;
              const segments = transcript.segments.map((s) => ({ start: s.start + offset, end: s.end + offset, text: s.text }));
              const cues = buildCues(segments, { maxChars: input.maxChars, maxLines: input.maxLines, maxDurationSec: input.maxDurationSec, minDurationSec: DEFAULT_READABILITY.minDurationSec });
              const output = input.output ? await canonical(input.output) : path.join(services.artifactsDir, "subtitles", `${safeFileName(path.parse(file).name)}_${Date.now()}.srt`);
              await mkdir(path.dirname(output), { recursive: true });
              const format = await writeSubtitles(output, cues, input.overwrite || !input.output);
              ctx.progress({ progress: 100, total: 100, message: "done" });
              return {
                content: [text(`${cues.length} captions (${transcript.language ?? input.language}, model ${model.name}) written to ${output}.\n\n${preview(cues)}`)],
                structured: { output, format, language: transcript.language ?? input.language, model: model.name, cues },
              };
            } finally {
              await rm(work, { recursive: true, force: true }).catch(() => undefined);
            }
          },
        }),

        defineTool({
          name: "subtitles.read",
          title: "Read subtitles",
          description: "Reads an .srt or .vtt file into timed captions.",
          input: z.object({ path: PATH }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "io" },
          capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "read subtitles" }],
          run: async (input) => {
            const file = await canonical(input.path);
            const cues = parseSubtitles(await readFile(file, "utf8").catch(() => { throw new NotFoundError(`File not found: ${file}`); }));
            return { content: [text(`${cues.length} captions in ${file}.\n\n${preview(cues)}`)], structured: { path: file, cues } };
          },
        }),

        defineTool({
          name: "subtitles.write",
          title: "Write subtitles",
          description: "Writes captions (e.g. proofread text) to .srt or .vtt. With reflow, long captions are re-split for readability.",
          input: z
            .object({
              output: PATH,
              cues: z.array(CueSchema).min(1).max(20_000),
              overwrite: z.boolean().default(false),
              reflow: z.boolean().default(false),
              ...LAYOUT,
            })
            .strict(),
          annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
          execution: { resourceClass: "io" },
          capabilities: (input) => [{ kind: "fs.write", target: input.output, reason: "write subtitles" }],
          run: async (input) => {
            const output = await canonical(input.output);
            const sorted = [...input.cues].sort((a, b) => a.start - b.start);
            const cues = input.reflow
              ? buildCues(sorted, { maxChars: input.maxChars, maxLines: input.maxLines, maxDurationSec: input.maxDurationSec, minDurationSec: DEFAULT_READABILITY.minDurationSec })
              : sorted;
            const format = await writeSubtitles(output, cues, input.overwrite);
            return { content: [text(`${cues.length} captions written to ${output}.`)], structured: { output, format, count: cues.length } };
          },
        }),

        defineTool({
          name: "subtitles.reformat",
          title: "Reformat subtitles",
          description: "Re-splits an .srt/.vtt for readability (characters per line, lines, duration) and optionally changes letter case.",
          input: z
            .object({
              path: PATH,
              output: PATH,
              case: z.enum(["none", "upper", "lower", "sentence"]).default("none"),
              overwrite: z.boolean().default(false),
              ...LAYOUT,
            })
            .strict(),
          annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
          execution: { resourceClass: "io" },
          capabilities: (input) => [
            { kind: "fs.read", target: input.path, reason: "read subtitles" },
            { kind: "fs.write", target: input.output, reason: "write subtitles" },
          ],
          run: async (input) => {
            const source = await canonical(input.path);
            const output = await canonical(input.output);
            const cues = parseSubtitles(await readFile(source, "utf8"));
            if (!cues.length) throw new ValidationError(`${source} contains no captions.`);
            const flat = cues.map((c) => ({ ...c, text: applyCase(c.text.replace(/\n/g, " "), input.case) }));
            const reflowed = buildCues(flat, { maxChars: input.maxChars, maxLines: input.maxLines, maxDurationSec: input.maxDurationSec, minDurationSec: DEFAULT_READABILITY.minDurationSec });
            await writeSubtitles(output, reflowed, input.overwrite);
            return { content: [text(`${cues.length} → ${reflowed.length} captions written to ${output}.`)], structured: { output, before: cues.length, after: reflowed.length } };
          },
        }),
      ],
    };
  },
});

export { buildCues, parseSubtitles, toSrt, toVtt, wrapLines, applyCase } from "./cues.js";
export { parseWhisperJson } from "./whisper.js";
