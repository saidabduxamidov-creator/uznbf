/**
 * OCR package: reads text from images and video frames (titles, burned-in subtitles, documents,
 * screenshots) with the engine built into Windows, or Tesseract. Images are normalised with FFmpeg
 * first (crop, grayscale, upscale small text) when FFmpeg is available.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { NotFoundError, defineTool, defineToolPackage, text } from "@lmp/core";
import { canonicalizePath, locateFfmpeg, probeMedia, runFfmpeg } from "@lmp/toolkit";
import { z } from "zod";
import { LanguageUnavailableError, tesseractLanguages, tesseractOcr, windowsLanguages, windowsOcr, type OcrResult } from "./engines.js";

const SettingsSchema = z
  .object({
    engine: z.enum(["auto", "windows", "tesseract"]).default("auto"),
    powershellPath: z.string().optional(),
    tesseractPath: z.string().optional(),
    tessdataDir: z.string().optional(),
    ffmpegPath: z.string().optional(),
    ffprobePath: z.string().optional(),
  })
  .strict();

const PATH = z.string().min(1).max(32_767).describe("Absolute path");
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });
const COMMON = {
  language: z.string().regex(/^[A-Za-z_]{2,10}([-+][A-Za-z_]{2,10})*$/).optional().describe('e.g. "en", "ru", "uz", "uz-Cyrl", "en+ru"; default: system languages'),
  engine: z.enum(["auto", "windows", "tesseract"]).optional(),
  region: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.01).max(1), height: z.number().min(0.01).max(1) })
    .strict()
    .optional()
    .describe("Part of the image to read, as fractions (e.g. bottom third: x 0, y 0.66, width 1, height 0.34)"),
};
const MAX_DIMENSION = 4000;

let counter = 0;

export default defineToolPackage({
  manifest: {
    id: "ocr",
    version: "0.1.0",
    displayName: "Text recognition",
    description: "Reads text from images and video frames with Windows OCR or Tesseract.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["fs.read", "process.spawn"],
  },
  configSchema: SettingsSchema,
  register: ({ config, services }) => {
    const engineFor = (requested: "auto" | "windows" | "tesseract" | undefined) => {
      const e = requested ?? config.engine;
      return e === "auto" ? (process.platform === "win32" ? "windows" : "tesseract") : e;
    };

    async function recognise(file: string, language: string | undefined, requested: "auto" | "windows" | "tesseract" | undefined, signal: AbortSignal): Promise<OcrResult> {
      const engine = engineFor(requested);
      if (engine === "tesseract") return tesseractOcr(config, file, language, signal);
      try {
        return await windowsOcr(config, file, language, signal);
      } catch (error) {
        // Windows OCR lacks the language (e.g. Uzbek): fall back to Tesseract when it can do it.
        if (error instanceof LanguageUnavailableError && (requested ?? config.engine) === "auto") {
          return tesseractOcr(config, file, language, signal).catch(() => {
            throw error;
          });
        }
        throw error;
      }
    }

    /** Crops, converts to grayscale and scales the image so small text is legible to the engine. */
    async function prepare(source: string, region: z.output<typeof COMMON.region>, seekSec: number | null, signal: AbortSignal): Promise<{ file: string; cleanup: () => Promise<void> }> {
      const ff = await locateFfmpeg(config, "tools.settings.ocr").catch((e: unknown) => {
        if (seekSec !== null) throw e;
        return null;
      });
      if (!ff) return { file: source, cleanup: async () => undefined };
      const info = await probeMedia(ff.ffprobe, source, signal);
      const stream = info.streams.find((s) => s.type === "video");
      if (!stream?.width || !stream.height) throw new NotFoundError(`${source} has no image.`);
      const w = Math.round(stream.width * (region?.width ?? 1));
      const h = Math.round(stream.height * (region?.height ?? 1));
      const longest = Math.max(w, h);
      const factor = longest < 1600 ? Math.min(3, 1600 / longest) : longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1;
      const filters = [
        ...(region ? [`crop=iw*${region.width}:ih*${region.height}:iw*${region.x}:ih*${region.y}`] : []),
        ...(factor !== 1 ? [`scale=trunc(iw*${factor.toFixed(4)}/2)*2:-2:flags=lanczos`] : []),
        "format=gray",
      ];
      const dir = path.join(services.artifactsDir, "ocr");
      await mkdir(dir, { recursive: true });
      const out = path.join(dir, `frame-${process.pid}-${++counter}.png`);
      await runFfmpeg(ff.ffmpeg, ["-y", ...(seekSec !== null ? ["-ss", seekSec.toFixed(3)] : []), "-i", source, "-frames:v", "1", "-vf", filters.join(","), out], { signal });
      if (!(await stat(out).catch(() => undefined))) throw new NotFoundError(`No frame at ${seekSec ?? 0} s in ${source}.`);
      return { file: out, cleanup: () => rm(out, { force: true }) };
    }

    const respond = (source: string, r: OcrResult, extra: Record<string, unknown> = {}) => ({
      content: [text(r.text ? `${r.text}\n\n(${r.lines.length} line(s), ${r.engine} OCR, ${r.language})` : `No text found (${r.engine} OCR, ${r.language}).`)],
      structured: { source, ...extra, engine: r.engine, language: r.language, text: r.text, lines: r.lines },
    });

    return {
      tools: [
        defineTool({
          name: "ocr.languages",
          title: "OCR languages",
          description: "Lists the languages each OCR engine on this computer can read.",
          input: z.object({}).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", timeoutMs: 60_000 },
          capabilities: () => [{ kind: "process.spawn", target: "ocr", reason: "list OCR languages" }],
          run: async (_input, ctx) => {
            const settle = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null }), (e: Error) => ({ value: null, error: e.message }));
            const [win, tess] = await Promise.all([
              process.platform === "win32" ? settle(windowsLanguages(config, ctx.signal)) : Promise.resolve({ value: null, error: "Windows only" }),
              settle(tesseractLanguages(config, ctx.signal)),
            ]);
            const lines = [
              `Windows OCR: ${win.value ? win.value.languages.join(", ") || "no language packs" : `unavailable (${win.error})`}`,
              `Tesseract: ${tess.value ? tess.value.join(", ") || "no languages" : `unavailable (${tess.error})`}`,
            ];
            return { content: [text(lines.join("\n"))], structured: { windows: win.value?.languages ?? null, tesseract: tess.value } };
          },
        }),

        defineTool({
          name: "ocr.image",
          title: "Read text in image",
          description: "Recognises text in an image file (PNG, JPEG, TIFF, BMP, WebP), with word positions.",
          input: z.object({ path: PATH, ...COMMON }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", timeoutMs: 3 * 60_000 },
          cache: {
            ttlMs: 7 * 24 * 3600_000,
            key: async (input) => {
              const s = await stat(input.path).catch(() => undefined);
              return s ? [s.size, Math.trunc(s.mtimeMs)] : null;
            },
          },
          capabilities: (input) => [
            { kind: "fs.read", target: input.path, reason: "read image" },
            { kind: "process.spawn", target: "ocr", reason: "recognise text" },
          ],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
            const prepared = await prepare(file, input.region, null, ctx.signal);
            try {
              return respond(file, await recognise(prepared.file, input.language, input.engine, ctx.signal));
            } finally {
              await prepared.cleanup();
            }
          },
        }),

        defineTool({
          name: "ocr.video_frame",
          title: "Read text in video",
          description: "Recognises text in video frames (titles, burned-in subtitles, lower thirds) at one or more times.",
          input: z.object({ path: PATH, times: z.array(z.number().min(0)).min(1).max(60).describe("Seconds"), ...COMMON }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", timeoutMs: 15 * 60_000 },
          capabilities: (input) => [
            { kind: "fs.read", target: input.path, reason: "read video" },
            { kind: "process.spawn", target: "ffmpeg", reason: "extract frames" },
            { kind: "process.spawn", target: "ocr", reason: "recognise text" },
          ],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
            const frames = [];
            for (const [i, t] of input.times.entries()) {
              ctx.progress({ progress: i, total: input.times.length, message: `frame at ${t} s` });
              const prepared = await prepare(file, input.region, t, ctx.signal);
              try {
                const r = await recognise(prepared.file, input.language, input.engine, ctx.signal);
                frames.push({ time: t, engine: r.engine, language: r.language, text: r.text, lines: r.lines });
              } finally {
                await prepared.cleanup();
              }
            }
            ctx.progress({ progress: input.times.length, total: input.times.length });
            const body = frames.map((f) => `[${f.time.toFixed(2)} s] ${f.text ? f.text.replace(/\n/g, " / ") : "(no text)"}`).join("\n");
            return { content: [text(body)], structured: { source: file, frames } };
          },
        }),
      ],
    };
  },
});

export { WINDOWS_OCR_SCRIPT, parseTesseractTsv, tesseractLanguage } from "./engines.js";
