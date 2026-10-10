/**
 * Test harness for tool packages: registers a package with in-memory services and runs tools the
 * same way the executor does (input validated and defaulted by the tool's schema, abortable).
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ValidationError, type Logger, type ProgressReport, type ToolPackage, type ToolResult } from "@lmp/core";

const silentLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  isLevelEnabled: () => false,
  child: () => silentLogger,
};

export interface ToolHarness {
  readonly dir: string;
  run(name: string, input: unknown, options?: { signal?: AbortSignal; onProgress?: (r: ProgressReport) => void }): Promise<ToolResult>;
  capabilities(name: string, input: unknown): unknown[];
  close(): Promise<void>;
}

export async function createToolHarness(pkg: ToolPackage<unknown>, settings: unknown = {}, options: { readonly platformDataDir?: string } = {}): Promise<ToolHarness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `lmp-${pkg.manifest.id}-`));
  const store = new Map<string, unknown>();
  const config = pkg.configSchema ? pkg.configSchema.parse(settings) : settings;
  const contribution = await pkg.register({
    manifest: pkg.manifest,
    config,
    logger: silentLogger,
    platform: process.platform,
    platformDataDir: options.platformDataDir ?? path.join(dir, "platform-data"),
    services: {
      cache: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
      kv: {
        get: async <T>(k: string) => store.get(k) as T | undefined,
        set: async (k, v) => void store.set(k, v),
        delete: async (k) => store.delete(k),
        keys: async () => [...store.keys()],
      },
      dataDir: path.join(dir, "data"),
      artifactsDir: path.join(dir, "artifacts"),
    },
  });
  const tools = new Map((contribution.tools ?? []).map((t) => [t.name, t]));
  const find = (name: string) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No tool ${name} in package ${pkg.manifest.id}`);
    return tool;
  };
  const parse = (name: string, input: unknown) => {
    const parsed = find(name).input.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return parsed.data;
  };
  return {
    dir,
    capabilities: (name, input) => [...find(name).capabilities(parse(name, input))],
    run: async (name, input, options = {}) => {
      const tool = find(name);
      const result = await tool.run(parse(name, input), {
        signal: options.signal ?? new AbortController().signal,
        logger: silentLogger,
        requestId: "test",
        client: { kind: "unknown", name: "test", version: "0" },
        progress: options.onProgress ?? (() => undefined),
      });
      if (tool.output) tool.output.parse(result.structured);
      return result;
    },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Generates a 6-second test clip with ffmpeg: three solid-colour shots (scene cuts at 2 s and 4 s)
 * and a 440 Hz tone with a silent gap from 1.5 s to 3.0 s.
 */
export async function makeTestClip(ffmpeg: string, file: string): Promise<void> {
  const { runProcess } = await import("./process.js");
  await runProcess(ffmpeg, [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=25",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=25",
    "-f", "lavfi", "-i", "color=c=green:s=320x240:d=2:r=25",
    "-f", "lavfi", "-i", "aevalsrc='if(between(t,1.5,3),0,0.5*sin(2*PI*440*t))':s=48000:d=6",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ]);
}
