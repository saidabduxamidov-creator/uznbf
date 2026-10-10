/**
 * Photoshop package (Windows): fills PSD templates (e.g. thumbnails: replace text layers, toggle
 * layers, export PNG/JPEG), runs recorded actions over files, and lists a document's layers.
 * Drives the installed Photoshop through its COM interface; documents are opened, processed and
 * closed without saving the source.
 */
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { ConflictError, ExternalProcessError, NotFoundError, UnsupportedError, ValidationError, defineTool, defineToolPackage, text } from "@lmp/core";
import { canonicalizePath, locateBinary, runProcess } from "@lmp/toolkit";
import { z } from "zod";
import { ES_OPERATIONS, PS_HOST, esJson, type EsOperation } from "./scripts.js";

const SettingsSchema = z.object({ powershellPath: z.string().optional() }).strict();

const PATH = z.string().min(1).max(32_767).describe("Absolute path");
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });
const EXPORT = {
  format: z.enum(["png", "jpg"]).default("png"),
  quality: z.number().int().min(1).max(12).default(10).describe("JPEG quality 1-12"),
  longSide: z.number().int().min(16).max(30_000).optional().describe("Downscale so the longer side is at most this many pixels"),
};

async function existingFile(p: string): Promise<string> {
  const file = await canonical(p);
  if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
  return file;
}

/** ExtendScript wants forward slashes. */
const esPath = (p: string) => p.replace(/\\/g, "/");

export default defineToolPackage({
  manifest: {
    id: "photoshop",
    version: "0.1.0",
    displayName: "Adobe Photoshop",
    description: "Fills PSD templates, runs actions and exports images with the installed Photoshop (Windows).",
    platforms: ["win32"],
    capabilities: ["fs.read", "fs.write", "host"],
  },
  configSchema: SettingsSchema,
  register: ({ config }) => {
    async function call<T>(op: EsOperation, params: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<T> {
      const configKey = "tools.settings.photoshop.powershellPath";
      const root = process.env["SystemRoot"] ?? "C:\\Windows";
      const ps = await locateBinary("powershell", {
        configured: config.powershellPath ?? path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        configKey,
        ...(config.powershellPath ? {} : { platform: "win32" as const }),
      });
      const request = Buffer.from(JSON.stringify({ code: ES_OPERATIONS[op], params: esJson(params) }), "utf8").toString("base64");
      const r = await runProcess(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(PS_HOST, "utf16le").toString("base64")], {
        label: "Photoshop",
        input: request,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        okExitCodes: [0, 5, 6],
        maxOutputBytes: 16 * 1024 * 1024,
      });
      if (r.exitCode === 5) throw new UnsupportedError(r.stderr || "Photoshop is not installed.");
      if (r.exitCode === 6) throw new ExternalProcessError(r.stderr.trim() || "Photoshop reported an error.");
      const raw = Buffer.from(r.stdout.trim(), "base64").toString("utf8");
      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        throw new ExternalProcessError(`Photoshop returned an unexpected reply: ${raw.slice(0, 200)}`, { cause: error });
      }
    }

    const hostCap = (reason: string) => ({ kind: "host" as const, target: "photoshop", reason });

    return {
      tools: [
        defineTool({
          name: "photoshop.status",
          title: "Photoshop status",
          description: "Photoshop version and open documents (starts Photoshop if needed).",
          input: z.object({}).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "host:photoshop", timeoutMs: 3 * 60_000 },
          capabilities: () => [hostCap("read Photoshop status")],
          run: async (_input, ctx) => {
            const s = await call<{ version: string; documents: { name: string }[]; active: string | null }>("status", {}, ctx.signal, 170_000);
            return { content: [text(`Photoshop ${s.version}; ${s.documents.length} open document(s)${s.active ? `, active: ${s.active}` : ""}.`)], structured: s };
          },
        }),

        defineTool({
          name: "photoshop.layers",
          title: "PSD layers",
          description: "Lists the layers of a PSD (names, kinds, visibility, current text), e.g. to find the text layers of a thumbnail template.",
          input: z.object({ path: PATH }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "host:photoshop", timeoutMs: 3 * 60_000 },
          capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "read PSD" }, hostCap("open document")],
          run: async (input, ctx) => {
            const file = await existingFile(input.path);
            const r = await call<{ width: number; height: number; layers: { path: string; kind: string; visible: boolean; text: string | null }[] }>("layers", { path: esPath(file) }, ctx.signal, 170_000);
            const lines = r.layers.map((l) => `${l.visible ? "●" : "○"} ${l.path} (${l.kind})${l.text !== null ? `: "${l.text.replace(/\r/g, " / ")}"` : ""}`);
            return { content: [text(`${r.width}×${r.height}\n${lines.join("\n")}`)], structured: r };
          },
        }),

        defineTool({
          name: "photoshop.fill_template",
          title: "Fill PSD template",
          description:
            "Opens a PSD template, replaces the text of named text layers, shows/hides named layers, and exports a PNG or JPEG (e.g. a YouTube thumbnail). The template itself is not changed.",
          input: z
            .object({
              template: PATH,
              output: PATH,
              texts: z.record(z.string().min(1).max(255), z.string().max(5000)).default({}),
              visibility: z.record(z.string().min(1).max(255), z.boolean()).default({}),
              overwrite: z.boolean().default(false),
              ...EXPORT,
            })
            .strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "host:photoshop", timeoutMs: 5 * 60_000 },
          capabilities: (input) => [
            { kind: "fs.read", target: input.template, reason: "read template" },
            { kind: "fs.write", target: input.output, reason: "write exported image" },
            hostCap("fill template"),
          ],
          run: async (input, ctx) => {
            if (!Object.keys(input.texts).length && !Object.keys(input.visibility).length) throw new ValidationError("Give texts and/or visibility to change.");
            const template = await existingFile(input.template);
            const output = await canonical(input.output);
            const ext = path.extname(output).toLowerCase();
            if (ext !== (input.format === "png" ? ".png" : ".jpg") && !(input.format === "jpg" && ext === ".jpeg")) throw new ValidationError(`output must end with .${input.format}`);
            if (!input.overwrite && (await stat(output).catch(() => undefined))) throw new ConflictError(`${output} already exists. Set overwrite to replace it.`);
            await mkdir(path.dirname(output), { recursive: true });
            const r = await call<{ replaced: string[]; missing: string[]; output: { path: string; width: number; height: number } }>(
              "replaceText",
              { template: esPath(template), output: esPath(output), texts: input.texts, visibility: input.visibility, format: input.format, quality: input.quality, longSide: input.longSide ?? 0 },
              ctx.signal,
              290_000,
            );
            return {
              content: [text(`Exported ${r.output.width}×${r.output.height} to ${output}. Replaced: ${r.replaced.join(", ") || "none"}.${r.missing.length ? ` Not found: ${r.missing.join(", ")} (see photoshop.layers).` : ""}`)],
              structured: { output, width: r.output.width, height: r.output.height, replaced: r.replaced, missing: r.missing },
            };
          },
        }),

        defineTool({
          name: "photoshop.run_action",
          title: "Run Photoshop action",
          description: "Runs a recorded Photoshop action (from the Actions panel) on each file and exports the results as PNG or JPEG. Source files are not changed.",
          input: z
            .object({
              files: z.array(PATH).min(1).max(500),
              set: z.string().min(1).max(255).describe("Action set name"),
              action: z.string().min(1).max(255),
              outputDir: PATH,
              suffix: z.string().max(40).regex(/^[\p{L}\p{N} _.-]*$/u).default("_edit"),
              ...EXPORT,
            })
            .strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "host:photoshop", longRunning: true, timeoutMs: 6 * 3600_000 },
          capabilities: (input) => [
            ...input.files.map((f) => ({ kind: "fs.read" as const, target: f, reason: "read image" })),
            { kind: "fs.write", target: input.outputDir, reason: "write results" },
            hostCap(`run action "${input.action}"`),
          ],
          run: async (input, ctx) => {
            const outDir = await canonical(input.outputDir);
            await mkdir(outDir, { recursive: true });
            const results: { path: string; width: number; height: number }[] = [];
            // One file per call keeps progress reporting and cancellation responsive.
            for (const [i, f] of input.files.entries()) {
              ctx.progress({ progress: i, total: input.files.length, message: path.basename(f) });
              const file = await existingFile(f);
              const r = await call<{ files: { path: string; width: number; height: number }[] }>(
                "runAction",
                { files: [esPath(file)], set: input.set, action: input.action, outputDir: esPath(outDir), suffix: input.suffix, format: input.format, quality: input.quality, longSide: input.longSide ?? 0 },
                ctx.signal,
                30 * 60_000,
              );
              results.push(...r.files);
            }
            ctx.progress({ progress: input.files.length, total: input.files.length });
            return { content: [text(`"${input.action}" applied to ${results.length} file(s) in ${outDir}.`)], structured: { files: results } };
          },
        }),
      ],
    };
  },
});

export { ES_OPERATIONS, PS_HOST, esJson } from "./scripts.js";
