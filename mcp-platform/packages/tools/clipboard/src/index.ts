/**
 * Clipboard package: text, images and copied files. Reading the clipboard asks the user by default
 * (it may hold passwords); writing is allowed by default. Images read from the clipboard are shown
 * to the assistant directly, so a screenshot can be pasted into the conversation from any app.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ConflictError, NotFoundError, ValidationError, defineTool, defineToolPackage, image, text } from "@lmp/core";
import { canonicalizePath, writeFileAtomic } from "@lmp/toolkit";
import { z } from "zod";
import { systemBackend, type BackendSettings, type ClipboardBackend, type ImageMime } from "./backends.js";

const SettingsSchema = z.object({ powershellPath: z.string().optional(), xclipPath: z.string().optional() }).strict();

const PATH = z.string().min(1).max(32_767).describe("Absolute path");
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });
const MAX_INLINE_IMAGE = 8 * 1024 * 1024;

function imageMime(data: Buffer): ImageMime | null {
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

function pngSize(png: Buffer): { width: number; height: number } | null {
  return png.length >= 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null;
}

export function createClipboardPackage(makeBackend: (settings: BackendSettings) => ClipboardBackend) {
  return defineToolPackage({
    manifest: {
      id: "clipboard",
      version: "0.1.0",
      displayName: "Clipboard",
      description: "Reads and writes the system clipboard: text, images and copied files.",
      platforms: ["win32", "darwin", "linux"],
      capabilities: ["clipboard.read", "clipboard.write", "fs.read", "fs.write"],
    },
    configSchema: SettingsSchema,
    register: ({ config }) => {
      const backend = makeBackend(config);
      return {
        tools: [
          defineTool({
            name: "clipboard.read_text",
            title: "Read clipboard text",
            description: "Returns the text currently on the clipboard.",
            input: z.object({ maxChars: z.number().int().min(1).max(1_000_000).default(100_000) }).strict(),
            output: z.object({ text: z.string(), length: z.number(), truncated: z.boolean() }),
            annotations: { readOnly: true, destructive: false, idempotent: false, openWorld: false },
            execution: { resourceClass: "inline", timeoutMs: 20_000 },
            capabilities: () => [{ kind: "clipboard.read", reason: "read copied text" }],
            run: async (input, ctx) => {
              const value = await backend.readText(ctx.signal);
              const truncated = value.length > input.maxChars;
              const shown = truncated ? value.slice(0, input.maxChars) : value;
              return {
                content: [text(value.length ? shown + (truncated ? `\n… (${value.length - input.maxChars} more characters)` : "") : "The clipboard holds no text.")],
                structured: { text: shown, length: value.length, truncated },
              };
            },
          }),

          defineTool({
            name: "clipboard.write_text",
            title: "Copy text",
            description: "Puts text on the clipboard so the user can paste it anywhere (an empty string clears the clipboard).",
            input: z.object({ text: z.string().max(5_000_000) }).strict(),
            annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
            execution: { resourceClass: "inline", timeoutMs: 20_000 },
            capabilities: () => [{ kind: "clipboard.write", reason: "copy text" }],
            run: async (input, ctx) => {
              await backend.writeText(input.text, ctx.signal);
              return { content: [text(input.text.length ? `Copied ${input.text.length} characters.` : "Clipboard cleared.")], structured: { length: input.text.length } };
            },
          }),

          defineTool({
            name: "clipboard.read_image",
            title: "Read clipboard image",
            description: "Shows the image on the clipboard (e.g. a screenshot) and optionally saves it as PNG.",
            input: z.object({ saveTo: PATH.optional().describe("Optional .png file to save it to"), overwrite: z.boolean().default(false) }).strict(),
            annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
            execution: { resourceClass: "inline", timeoutMs: 30_000 },
            capabilities: (input) => [
              { kind: "clipboard.read", reason: "read copied image" },
              ...(input.saveTo ? [{ kind: "fs.write" as const, target: input.saveTo, reason: "save clipboard image" }] : []),
            ],
            run: async (input, ctx) => {
              const png = await backend.readImage(ctx.signal);
              if (!png) return { content: [text("The clipboard holds no image.")], structured: { found: false } };
              const size = pngSize(png);
              let saved: string | null = null;
              if (input.saveTo) {
                saved = await canonical(input.saveTo);
                if (path.extname(saved).toLowerCase() !== ".png") throw new ValidationError("saveTo must end with .png");
                if (!input.overwrite && (await stat(saved).catch(() => undefined))) throw new ConflictError(`${saved} already exists. Set overwrite to replace it.`);
                await mkdir(path.dirname(saved), { recursive: true });
                await writeFileAtomic(saved, png);
              }
              const note = `${size ? `${size.width}×${size.height} ` : ""}PNG, ${png.length} bytes${saved ? `, saved to ${saved}` : ""}`;
              const parts = png.length <= MAX_INLINE_IMAGE ? [image(png.toString("base64"), "image/png"), text(note)] : [text(`${note}. Too large to show; save it with saveTo.`)];
              return { content: parts, structured: { found: true, bytes: png.length, ...(size ?? {}), saved } };
            },
          }),

          defineTool({
            name: "clipboard.write_image",
            title: "Copy image",
            description: "Puts a PNG or JPEG file on the clipboard as an image, ready to paste into an editor or chat.",
            input: z.object({ path: PATH }).strict(),
            annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
            execution: { resourceClass: "inline", timeoutMs: 30_000 },
            capabilities: (input) => [
              { kind: "fs.read", target: input.path, reason: "read image" },
              { kind: "clipboard.write", reason: "copy image" },
            ],
            run: async (input, ctx) => {
              const file = await canonical(input.path);
              const head = await readFile(file).catch(() => {
                throw new NotFoundError(`File not found: ${file}`);
              });
              const mime = imageMime(head);
              if (!mime) throw new ValidationError(`${file} is not a PNG or JPEG image.`);
              await backend.writeImage(file, mime, ctx.signal);
              return { content: [text(`Copied image ${path.basename(file)} to the clipboard.`)], structured: { path: file, mimeType: mime } };
            },
          }),

          defineTool({
            name: "clipboard.read_files",
            title: "Read copied files",
            description: "Lists files and folders copied in Explorer (Ctrl+C), so the assistant can work on what the user copied.",
            input: z.object({}).strict(),
            output: z.object({ files: z.array(z.string()) }),
            annotations: { readOnly: true, destructive: false, idempotent: false, openWorld: false },
            execution: { resourceClass: "inline", timeoutMs: 20_000 },
            capabilities: () => [{ kind: "clipboard.read", reason: "read copied file list" }],
            run: async (_input, ctx) => {
              const files = await backend.readFiles(ctx.signal);
              return { content: [text(files.length ? files.join("\n") : "No files are copied.")], structured: { files } };
            },
          }),

          defineTool({
            name: "clipboard.write_files",
            title: "Copy files",
            description: "Copies files to the clipboard like Ctrl+C in Explorer, so the user can paste them into a folder or an editor's project panel.",
            input: z.object({ paths: z.array(PATH).min(1).max(1000) }).strict(),
            annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
            execution: { resourceClass: "inline", timeoutMs: 20_000 },
            capabilities: (input) => [
              ...input.paths.map((p) => ({ kind: "fs.read" as const, target: p, reason: "offer file for pasting" })),
              { kind: "clipboard.write", reason: "copy files" },
            ],
            run: async (input, ctx) => {
              const files: string[] = [];
              for (const p of input.paths) {
                const file = await canonical(p);
                if (!(await stat(file).catch(() => undefined))) throw new NotFoundError(`Not found: ${file}`);
                files.push(file);
              }
              await backend.writeFiles(files, ctx.signal);
              return { content: [text(`Copied ${files.length} item(s); paste with Ctrl+V.`)], structured: { files } };
            },
          }),
        ],
      };
    },
  });
}

export default createClipboardPackage((settings) => systemBackend(settings));
export { WINDOWS_SCRIPTS, encodePowerShell, linuxBackend, systemBackend, windowsBackend, type ClipboardBackend } from "./backends.js";
