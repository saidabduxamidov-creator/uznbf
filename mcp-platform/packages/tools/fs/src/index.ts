/**
 * File system tool package. Every path is canonicalized with the same rules as the permission gate
 * and every call declares exactly the capability/target it needs, so the local policy decides.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
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
  type ImageContent,
} from "@lmp/core";
import { canonicalizePath, wildcardMatch, writeFileAtomic } from "@lmp/toolkit";
import { z } from "zod";

const PATH = z.string().min(1).max(32_767).describe("Absolute path");
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;

const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });

type EntryType = "file" | "directory" | "symlink" | "other";
const typeOf = (s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryType =>
  s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other";

const notFound = (error: unknown, p: string): never => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundError(`Not found: ${p}`);
  throw error;
};

const IMAGE_SIGNATURES: ReadonlyArray<[ImageContent["mimeType"], (b: Buffer) => boolean]> = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a"],
  ["image/webp", (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP"],
];

/** Decodes text honouring UTF-8/UTF-16 byte order marks (Windows tools often write UTF-16 SRT files). */
export function decodeText(buffer: Buffer): { text: string; encoding: "utf8" | "utf16le" | "utf16be" } {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf16le" };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return { text: swapped.toString("utf16le"), encoding: "utf16be" };
  }
  const start = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  return { text: buffer.subarray(start).toString("utf8"), encoding: "utf8" };
}

/** Largest index <= end at which a UTF-8 buffer can be cut without splitting a character. */
export function utf8SafeEnd(buffer: Buffer, end: number): number {
  for (let i = end - 1; i >= Math.max(0, end - 4); i--) {
    const byte = buffer[i] ?? 0;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte - keep looking for the lead byte
    const width = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return i + width <= end ? end : i;
  }
  return end;
}

export function looksBinary(sample: Buffer): boolean {
  if (sample.length >= 2 && ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))) return false;
  return sample.includes(0);
}

export default defineToolPackage({
  manifest: {
    id: "fs",
    version: "0.1.0",
    displayName: "File system",
    description: "Browse, read, write, find, move and hash files inside the folders the local permission policy allows.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["fs.read", "fs.write"],
  },
  register: () => ({
    tools: [
      defineTool({
        name: "fs.list_directory",
        title: "List directory",
        description: "Lists entries of a folder (optionally recursive, filtered by a name wildcard such as *.mp4). Symlinked folders are listed but not followed.",
        input: z.object({
          path: PATH,
          pattern: z.string().max(200).optional().describe('Name wildcard, e.g. "*.mp4"'),
          recursive: z.boolean().default(false),
          maxDepth: z.number().int().min(1).max(8).default(4),
          includeHidden: z.boolean().default(false),
          maxEntries: z.number().int().min(1).max(5000).default(500),
        }).strict(),
        annotations: READ_ONLY,
        execution: { resourceClass: "io" },
        capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "list folder contents" }],
        run: async (input, ctx) => {
          const root = await canonical(input.path);
          const rootStat = await stat(root).catch((e: unknown) => notFound(e, input.path));
          if (!rootStat.isDirectory()) throw new ValidationError(`Not a folder: ${input.path}`);
          const entries: Array<{ path: string; name: string; type: EntryType; size: number; modifiedMs: number }> = [];
          let truncated = false;
          const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 1 }];
          while (queue.length && !truncated) {
            throwIfAborted(ctx.signal);
            const { dir, depth } = queue.shift() as { dir: string; depth: number };
            let names: string[];
            try {
              names = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
            } catch (error) {
              ctx.logger.debug("unreadable folder skipped", { dir, error });
              continue;
            }
            for (const name of names) {
              if (!input.includeHidden && name.startsWith(".")) continue;
              const full = path.join(dir, name);
              const s = await lstat(full).catch(() => undefined);
              if (!s) continue;
              const type = typeOf(s);
              if (!input.pattern || wildcardMatch(input.pattern, name)) {
                if (entries.length >= input.maxEntries) {
                  truncated = true;
                  break;
                }
                entries.push({ path: full, name, type, size: type === "file" ? s.size : 0, modifiedMs: Math.trunc(s.mtimeMs) });
              }
              if (input.recursive && type === "directory" && depth < input.maxDepth) queue.push({ dir: full, depth: depth + 1 });
            }
          }
          const summary = entries.map((e) => `${e.type === "directory" ? "[dir] " : ""}${path.relative(root, e.path) || e.name}${e.type === "file" ? `  (${e.size} B)` : ""}`).join("\n");
          return {
            content: [text(`${root}\n${summary || "(empty)"}${truncated ? `\n… truncated at ${input.maxEntries} entries` : ""}`)],
            structured: { root, entries, truncated },
          };
        },
      }),

      defineTool({
        name: "fs.stat",
        title: "File information",
        description: "Whether a path exists, its type, size and timestamps.",
        input: z.object({ path: PATH }).strict(),
        output: z.object({
          path: z.string(),
          exists: z.boolean(),
          type: z.enum(["file", "directory", "symlink", "other"]).optional(),
          size: z.number().optional(),
          modifiedMs: z.number().optional(),
          createdMs: z.number().optional(),
        }),
        annotations: READ_ONLY,
        execution: { resourceClass: "inline" },
        capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "read file information" }],
        run: async (input) => {
          const p = await canonical(input.path);
          const s = await lstat(p).catch(() => undefined);
          if (!s) return { content: [text(`${p} does not exist.`)], structured: { path: p, exists: false } };
          const info = { path: p, exists: true, type: typeOf(s), size: s.size, modifiedMs: Math.trunc(s.mtimeMs), createdMs: Math.trunc(s.birthtimeMs) };
          return { content: [text(JSON.stringify(info))], structured: info };
        },
      }),

      defineTool({
        name: "fs.read_text",
        title: "Read text file",
        description: "Reads a text file (UTF-8 or UTF-16 with BOM), in chunks for large files: pass nextOffset from the previous call as offset.",
        input: z.object({
          path: PATH,
          offset: z.number().int().min(0).default(0).describe("Byte offset"),
          maxBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024),
        }).strict(),
        annotations: READ_ONLY,
        execution: { resourceClass: "io" },
        capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "read file" }],
        run: async (input, ctx) => {
          const p = await canonical(input.path);
          const handle = await open(p, "r").catch((e: unknown) => notFound(e, input.path));
          try {
            const { size } = await handle.stat();
            const sample = Buffer.alloc(Math.min(8192, size));
            await handle.read(sample, 0, sample.length, 0);
            if (looksBinary(sample)) throw new ValidationError(`${p} is a binary file. Use fs.read_image for images or fs.hash to fingerprint it.`);
            throwIfAborted(ctx.signal);
            // At least 4 bytes so one complete UTF-8 character always fits.
            const length = Math.max(0, Math.min(Math.max(4, input.maxBytes), size - input.offset));
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, input.offset);
            // Never split a UTF-8 sequence: skip a partial character at the start, stop before one at the end.
            let start = 0;
            while (start < bytesRead && start < 3 && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++;
            const end = input.offset + bytesRead < size ? utf8SafeEnd(buffer, bytesRead) : bytesRead;
            const slice = buffer.subarray(start, end);
            const chunk = input.offset === 0 ? decodeText(slice) : { text: slice.toString("utf8"), encoding: "utf8" as const };
            const next = input.offset + end;
            const truncated = next < size;
            return {
              content: [text(chunk.text + (truncated ? `\n… (${size - next} more bytes; call again with offset ${next})` : ""))],
              structured: { path: p, encoding: chunk.encoding, totalBytes: size, offset: input.offset, bytesRead: end, truncated, ...(truncated ? { nextOffset: next } : {}) },
            };
          } finally {
            await handle.close();
          }
        },
      }),

      defineTool({
        name: "fs.read_image",
        title: "View image",
        description: "Returns an image file (PNG, JPEG, WebP or GIF, up to 8 MB) so the assistant can look at it.",
        input: z.object({ path: PATH }).strict(),
        annotations: READ_ONLY,
        execution: { resourceClass: "io" },
        capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "view image" }],
        run: async (input) => {
          const p = await canonical(input.path);
          const s = await stat(p).catch((e: unknown) => notFound(e, input.path));
          if (!s.isFile()) throw new ValidationError(`Not a file: ${p}`);
          if (s.size > 8 * 1024 * 1024) throw new ValidationError(`Image is too large (${s.size} bytes; limit 8 MB). Use ffmpeg.extract_frames or a smaller export.`);
          const handle = await open(p, "r");
          let data: Buffer;
          try {
            data = await handle.readFile();
          } finally {
            await handle.close();
          }
          const mime = IMAGE_SIGNATURES.find(([, test]) => test(data))?.[0];
          if (!mime) throw new ValidationError(`${p} is not a PNG, JPEG, WebP or GIF image.`);
          return { content: [image(data.toString("base64"), mime), text(`${p} (${mime}, ${data.length} bytes)`)], structured: { path: p, mimeType: mime, bytes: data.length } };
        },
      }),

      defineTool({
        name: "fs.write_text",
        title: "Write text file",
        description: 'Writes a UTF-8 text file. mode "create" fails if the file exists, "overwrite" replaces it atomically, "append" adds to the end.',
        input: z.object({
          path: PATH,
          content: z.string().max(10 * 1024 * 1024),
          mode: z.enum(["create", "overwrite", "append"]).default("create"),
          createDirectories: z.boolean().default(false),
          bom: z.boolean().default(false).describe("Write a UTF-8 byte order mark (some Windows apps need it for SRT)"),
        }).strict(),
        output: z.object({ path: z.string(), bytes: z.number(), mode: z.string() }),
        annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
        execution: { resourceClass: "io" },
        capabilities: (input) => [{ kind: "fs.write", target: input.path, reason: `${input.mode} file` }],
        run: async (input) => {
          const p = await canonical(input.path);
          const dir = path.dirname(p);
          if (input.createDirectories) await mkdir(dir, { recursive: true });
          else if (!(await stat(dir).catch(() => undefined))?.isDirectory()) throw new NotFoundError(`Folder does not exist: ${dir} (set createDirectories to create it).`);
          const body = Buffer.concat([input.bom && input.mode !== "append" ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(input.content, "utf8")]);
          const existing = await lstat(p).catch(() => undefined);
          if (existing && !existing.isFile()) throw new ConflictError(`${p} exists and is not a regular file.`);
          if (input.mode === "create" && existing) throw new ConflictError(`${p} already exists. Use mode "overwrite" to replace it.`);
          if (input.mode === "append") await appendFile(p, body);
          else await writeFileAtomic(p, body, { exclusive: input.mode === "create" });
          return { content: [text(`Wrote ${body.length} bytes to ${p} (${input.mode}).`)], structured: { path: p, bytes: body.length, mode: input.mode } };
        },
      }),

      defineTool({
        name: "fs.make_directory",
        title: "Create folder",
        description: "Creates a folder (and missing parents).",
        input: z.object({ path: PATH }).strict(),
        annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
        execution: { resourceClass: "io" },
        capabilities: (input) => [{ kind: "fs.write", target: input.path, reason: "create folder" }],
        run: async (input) => {
          const p = await canonical(input.path);
          await mkdir(p, { recursive: true });
          return { content: [text(`Folder ready: ${p}`)], structured: { path: p } };
        },
      }),

      defineTool({
        name: "fs.move",
        title: "Move or rename",
        description: "Moves or renames a file or folder. Refuses to replace an existing target unless overwrite is true (files only).",
        input: z.object({ from: PATH, to: PATH, overwrite: z.boolean().default(false) }).strict(),
        annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
        execution: { resourceClass: "io" },
        capabilities: (input) => [
          { kind: "fs.write", target: input.from, reason: "move away from here" },
          { kind: "fs.write", target: input.to, reason: "move here" },
        ],
        run: async (input) => {
          const from = await canonical(input.from);
          const to = await canonical(input.to);
          const source = await lstat(from).catch((e: unknown) => notFound(e, input.from));
          const target = await lstat(to).catch(() => undefined);
          if (target && (!input.overwrite || target.isDirectory() || source.isDirectory())) {
            throw new ConflictError(`Target exists: ${to}${input.overwrite ? " (folders are never replaced)" : " (set overwrite to replace a file)"}`);
          }
          try {
            await rename(from, to);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EXDEV" || source.isDirectory()) throw error;
            // Different drive: copy then remove the original.
            await copyFile(from, to);
            await rm(from);
          }
          return { content: [text(`Moved ${from} → ${to}`)], structured: { from, to } };
        },
      }),

      defineTool({
        name: "fs.find",
        title: "Find files",
        description: "Finds files or folders by name wildcard under a root folder (breadth-first, bounded).",
        input: z.object({
          root: PATH,
          pattern: z.string().min(1).max(200).describe('Name wildcard, e.g. "*interview*.mp4"'),
          type: z.enum(["file", "directory", "any"]).default("file"),
          maxDepth: z.number().int().min(1).max(16).default(8),
          maxResults: z.number().int().min(1).max(2000).default(200),
        }).strict(),
        annotations: READ_ONLY,
        execution: { resourceClass: "io" },
        capabilities: (input) => [{ kind: "fs.read", target: input.root, reason: "search folder" }],
        run: async (input, ctx) => {
          const root = await canonical(input.root);
          const results: string[] = [];
          const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 1 }];
          let visited = 0;
          while (queue.length && results.length < input.maxResults) {
            throwIfAborted(ctx.signal);
            const { dir, depth } = queue.shift() as { dir: string; depth: number };
            const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
            visited++;
            if (visited % 50 === 0) ctx.progress({ progress: visited, message: `${visited} folders searched` });
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              const isDir = entry.isDirectory();
              const kind = isDir ? "directory" : entry.isFile() ? "file" : "other";
              if ((input.type === "any" || input.type === kind) && wildcardMatch(input.pattern, entry.name)) {
                results.push(full);
                if (results.length >= input.maxResults) break;
              }
              if (isDir && depth < input.maxDepth) queue.push({ dir: full, depth: depth + 1 });
            }
          }
          return {
            content: [text(results.length ? results.join("\n") : `No matches for "${input.pattern}" under ${root}.`)],
            structured: { root, matches: results, truncated: results.length >= input.maxResults },
          };
        },
      }),

      defineTool({
        name: "fs.hash",
        title: "File hash",
        description: "SHA-256 (or SHA-1) of a file, streamed; useful to detect duplicates or verify exports.",
        input: z.object({ path: PATH, algorithm: z.enum(["sha256", "sha1"]).default("sha256") }).strict(),
        output: z.object({ path: z.string(), algorithm: z.string(), hex: z.string(), bytes: z.number() }),
        annotations: READ_ONLY,
        execution: { resourceClass: "io" },
        cache: {
          ttlMs: 7 * 24 * 3600 * 1000,
          key: async (input) => {
            const s = await stat(input.path).catch(() => undefined);
            return s ? [s.size, Math.trunc(s.mtimeMs)] : null;
          },
        },
        capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "hash file" }],
        run: async (input, ctx) => {
          const p = await canonical(input.path);
          const s = await stat(p).catch((e: unknown) => notFound(e, input.path));
          if (!s.isFile()) throw new ValidationError(`Not a file: ${p}`);
          const hash = createHash(input.algorithm);
          let bytes = 0;
          let lastReport = 0;
          for await (const chunk of createReadStream(p, { signal: ctx.signal, highWaterMark: 1024 * 1024 })) {
            hash.update(chunk as Buffer);
            bytes += (chunk as Buffer).length;
            if (bytes - lastReport > 64 * 1024 * 1024) {
              lastReport = bytes;
              ctx.progress({ progress: bytes, total: s.size, message: "hashing" });
            }
          }
          const hex = hash.digest("hex");
          return { content: [text(`${input.algorithm} ${hex}  ${p}`)], structured: { path: p, algorithm: input.algorithm, hex, bytes } };
        },
      }),
    ],
  }),
});
