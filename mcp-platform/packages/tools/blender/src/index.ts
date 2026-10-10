/**
 * Blender package: renders .blend scenes and creates animated 3D titles (transparent PNG
 * sequences that Premiere, After Effects and Resolve import as one clip) with the Blender installed
 * on this computer, in background mode.
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ExternalProcessError, NotFoundError, ValidationError, defineTool, defineToolPackage, text } from "@lmp/core";
import { canonicalizePath, locateBinary, runProcess } from "@lmp/toolkit";
import { z } from "zod";
import { INSPECT_SCRIPT, TEXT3D_SCRIPT } from "./scripts.js";

const SettingsSchema = z.object({ blenderPath: z.string().optional(), threads: z.number().int().min(0).max(256).default(0) }).strict();

const PATH = z.string().min(1).max(32_767).describe("Absolute path");
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });
const ENGINE = z.enum(["eevee", "cycles", "workbench"]);

/** Finds Blender: configuration, then the newest "Blender Foundation\\Blender x.y" install, then PATH. */
export async function locateBlender(configured: string | undefined): Promise<string> {
  const configKey = "tools.settings.blender.blenderPath";
  if (configured) return locateBinary("blender", { configured, configKey });
  if (process.platform === "win32") {
    const root = path.win32.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Blender Foundation");
    const versions = (await readdir(root).catch(() => [] as string[]))
      .map((d) => ({ d, v: (/(\d+)\.(\d+)/.exec(d) ?? []).slice(1).map(Number) }))
      .filter((x) => x.v.length === 2)
      .sort((a, b) => (b.v[0] ?? 0) - (a.v[0] ?? 0) || (b.v[1] ?? 0) - (a.v[1] ?? 0));
    for (const { d } of versions) {
      const found = await locateBinary("blender", { configured: path.win32.join(root, d, "blender.exe"), configKey }).catch(() => null);
      if (found) return found;
    }
  } else if (process.platform === "darwin") {
    const mac = await locateBinary("Blender", { configured: "/Applications/Blender.app/Contents/MacOS/Blender", configKey }).catch(() => null);
    if (mac) return mac;
  }
  return locateBinary("blender", { configKey }).catch(() => {
    throw new NotFoundError(`Blender was not found. Install it from blender.org, or set "${configKey}".`);
  });
}

const BASE_ARGS = ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "3"];

/** Tracks "Fra:N" lines (and Cycles "Sample a/b") into overall progress. */
export function frameProgress(line: string, first: number, last: number): number | null {
  const m = /^Fra:(\d+)\b/.exec(line) ?? /\bFra:(\d+)\b/.exec(line);
  if (!m) return null;
  const f = Number(m[1]);
  return Math.max(0, Math.min(1, (f - first) / Math.max(1, last - first + 1)));
}

export default defineToolPackage({
  manifest: {
    id: "blender",
    version: "0.1.0",
    displayName: "Blender",
    description: "Renders Blender scenes and animated 3D titles with the local Blender.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["fs.read", "fs.write", "process.spawn"],
  },
  configSchema: SettingsSchema,
  register: ({ config, services }) => {
    const threads = config.threads ? ["--threads", String(config.threads)] : [];
    return {
      tools: [
        defineTool({
          name: "blender.inspect",
          title: "Inspect .blend file",
          description: "Reports Blender's version and a .blend file's scene: frame range, fps, resolution, render engine, camera.",
          input: z.object({ path: PATH }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", timeoutMs: 2 * 60_000 },
          capabilities: (input) => [
            { kind: "fs.read", target: input.path, reason: "read Blender scene" },
            { kind: "process.spawn", target: "blender", reason: "inspect scene" },
          ],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
            const blender = await locateBlender(config.blenderPath);
            const r = await runProcess(blender, [...BASE_ARGS, file, "--python-expr", INSPECT_SCRIPT], { signal: ctx.signal, label: "Blender" });
            const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("LMP_INFO "));
            if (!line) throw new ExternalProcessError("Blender did not report the scene.");
            const info = JSON.parse(line.slice(9)) as Record<string, unknown>;
            return {
              content: [text(`Blender ${String(info["version"])}: scene "${String(info["scene"])}", frames ${String(info["frameStart"])}–${String(info["frameEnd"])} @ ${String(info["fps"])} fps, ${String(info["width"])}×${String(info["height"])}, ${String(info["engine"])}`)],
              structured: info,
            };
          },
        }),

        defineTool({
          name: "blender.render",
          title: "Render .blend",
          description:
            "Renders a .blend file in the background: one frame (still) or a frame range, as PNG images (with alpha when the scene has a transparent film) or an MP4.",
          input: z
            .object({
              path: PATH,
              outputDir: PATH,
              frame: z.number().int().min(0).max(1_000_000).optional().describe("Render only this frame"),
              start: z.number().int().min(0).max(1_000_000).optional(),
              end: z.number().int().min(0).max(1_000_000).optional(),
              format: z.enum(["png", "mp4"]).default("png"),
              engine: ENGINE.optional().describe("Default: the scene's engine"),
              scene: z.string().min(1).max(64).optional(),
            })
            .strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 24 * 3600_000 },
          capabilities: (input) => [
            { kind: "fs.read", target: input.path, reason: "read Blender scene" },
            { kind: "fs.write", target: input.outputDir, reason: "write rendered frames" },
            { kind: "process.spawn", target: "blender", reason: "render" },
          ],
          run: async (input, ctx) => {
            const file = await canonical(input.path);
            if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
            if (input.start !== undefined && input.end !== undefined && input.end < input.start) throw new ValidationError("end must not be before start");
            const outDir = await canonical(input.outputDir);
            await mkdir(outDir, { recursive: true });
            const blender = await locateBlender(config.blenderPath);
            const engine = input.engine ? ["-E", { eevee: "BLENDER_EEVEE_NEXT", cycles: "CYCLES", workbench: "BLENDER_WORKBENCH" }[input.engine]] : [];
            const outPattern = path.join(outDir, `${safeStem(file)}_####`);
            const range = input.frame !== undefined
              ? ["-f", String(input.frame)]
              : [...(input.start !== undefined ? ["-s", String(input.start)] : []), ...(input.end !== undefined ? ["-e", String(input.end)] : []), "-a"];
            const format = input.format === "mp4" ? ["-F", "FFMPEG"] : ["-F", "PNG"];
            const first = input.frame ?? input.start ?? 1;
            const last = input.frame ?? input.end ?? first + 250;
            let rendered = 0;
            const args = [...BASE_ARGS, file, ...(input.scene ? ["-S", input.scene] : []), ...engine, ...threads, "-o", outPattern, ...format, ...range];
            ctx.progress({ progress: 0, total: 100, message: "starting Blender" });
            const r = await runProcess(blender, args, {
              signal: ctx.signal,
              label: "Blender",
              onStdoutLine: (line) => {
                if (/^Saved: /.test(line.trim())) rendered++;
                const f = frameProgress(line, first, last);
                if (f !== null) ctx.progress({ progress: Math.round(f * 99), total: 100, message: `rendering frame ${line.match(/Fra:(\d+)/)?.[1] ?? ""}` });
              },
            });
            if (input.format === "mp4" && input.engine === undefined && /Error: .*FFMPEG/i.test(r.stdout)) throw new ExternalProcessError("This Blender build cannot write MP4; render PNG instead.");
            const files = (await readdir(outDir)).filter((f) => f.startsWith(`${safeStem(file)}_`)).sort();
            if (!files.length) throw new ExternalProcessError(`Blender rendered nothing. ${r.stdout.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(-3).join(" ")}`.trim());
            ctx.progress({ progress: 100, total: 100, message: "done" });
            return {
              content: [text(`Rendered ${rendered || files.length} file(s) to ${outDir}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`)],
              structured: { outputDir: outDir, files: files.map((f) => path.join(outDir, f)) },
            };
          },
        }),

        defineTool({
          name: "blender.title_3d",
          title: "3D title",
          description:
            "Creates an animated 3D text title (extruded, bevelled, metallic or matte) on a transparent background and renders it as a PNG sequence ready to import into Premiere, After Effects or Resolve.",
          input: z
            .object({
              text: z.string().min(1).max(200),
              outputDir: PATH.optional().describe("Default: artifacts folder"),
              animation: z.enum(["spin", "rise", "pop", "swing", "none"]).default("pop"),
              color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).default("#f5c542"),
              metallic: z.number().min(0).max(1).default(0.8),
              roughness: z.number().min(0).max(1).default(0.25),
              extrude: z.number().min(0).max(1).default(0.12),
              bevel: z.number().min(0).max(0.2).default(0.02),
              font: PATH.optional().describe(".ttf/.otf font file"),
              width: z.number().int().min(128).max(7680).default(1920),
              height: z.number().int().min(128).max(4320).default(1080),
              fps: z.number().int().min(12).max(120).default(30),
              durationSec: z.number().min(0.5).max(30).default(3),
              engine: ENGINE.default("eevee"),
              quality: z.enum(["draft", "final"]).default("final"),
            })
            .strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 6 * 3600_000 },
          capabilities: (input) => [
            ...(input.outputDir ? [{ kind: "fs.write" as const, target: input.outputDir, reason: "write title frames" }] : []),
            ...(input.font ? [{ kind: "fs.read" as const, target: input.font, reason: "read font" }] : []),
            { kind: "process.spawn", target: "blender", reason: "render 3D title" },
          ],
          run: async (input, ctx) => {
            const blender = await locateBlender(config.blenderPath);
            const outDir = input.outputDir ? await canonical(input.outputDir) : path.join(services.artifactsDir, "titles", `title_${Date.now()}`);
            await mkdir(outDir, { recursive: true });
            const font = input.font ? await canonical(input.font) : null;
            if (font && !/\.(ttf|otf)$/i.test(font)) throw new ValidationError("font must be a .ttf or .otf file");
            const hex = input.color.replace("#", "");
            // Blender colours are linear; convert from sRGB.
            const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
            const color = [0, 2, 4].map((i) => Math.round(lin(parseInt(hex.slice(i, i + 2), 16) / 255) * 10_000) / 10_000);
            const frames = Math.max(2, Math.round(input.durationSec * input.fps));
            const params = {
              text: input.text,
              outputDir: outDir,
              animation: input.animation,
              color,
              metallic: input.metallic,
              roughness: input.roughness,
              extrude: input.extrude,
              bevel: input.bevel,
              font,
              width: input.width,
              height: input.height,
              fps: input.fps,
              frames,
              engine: input.engine,
              samples: input.quality === "draft" ? (input.engine === "cycles" ? 16 : 8) : input.engine === "cycles" ? 128 : 64,
            };
            ctx.progress({ progress: 0, total: frames, message: "building scene" });
            const r = await runProcess(blender, [...BASE_ARGS, ...threads, "--python-expr", TEXT3D_SCRIPT], {
              signal: ctx.signal,
              label: "Blender",
              env: { LMP_BLENDER_PARAMS: JSON.stringify(params) },
              onStdoutLine: (line) => {
                const m = /Fra:(\d+)/.exec(line);
                if (m) ctx.progress({ progress: Math.min(frames, Number(m[1]) - 1), total: frames, message: `rendering frame ${m[1]}/${frames}` });
              },
            });
            if (!r.stdout.includes("LMP_DONE")) throw new ExternalProcessError(`Blender did not finish the title. ${r.stdout.split(/\r?\n/).filter((l) => /error|Traceback/i.test(l)).slice(-3).join(" ")}`.trim());
            const files = (await readdir(outDir)).filter((f) => /^title_\d+\.png$/.test(f)).sort();
            ctx.progress({ progress: frames, total: frames, message: "done" });
            return {
              content: [text(`3D title "${input.text}" rendered: ${files.length} transparent PNG frames (${input.width}×${input.height} @ ${input.fps} fps) in ${outDir}. Import the first frame as an image sequence.`)],
              structured: { outputDir: outDir, frames: files.length, firstFrame: files[0] ? path.join(outDir, files[0]) : null, fps: input.fps },
            };
          },
        }),
      ],
    };
  },
});

function safeStem(s: string): string {
  return path.parse(s).name.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "render";
}

export { INSPECT_SCRIPT, TEXT3D_SCRIPT } from "./scripts.js";
