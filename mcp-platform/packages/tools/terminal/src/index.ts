/**
 * Terminal package: runs allow-listed local programs with an argument array, never through a
 * shell. Command interpreters and script files are refused outright, so arguments can never be
 * reinterpreted as commands. terminal.exec is denied by default; the user enables it per program
 * in the permission policy.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { PermissionDeniedError, ValidationError, defineTool, defineToolPackage, text } from "@lmp/core";
import { canonicalizePath, lastLines, locateBinary, runProcess } from "@lmp/toolkit";
import { z } from "zod";

const ProgramSchema = z
  .object({
    path: z.string().optional().describe("Absolute path; default: found via LMP_BIN_DIR or PATH"),
    description: z.string().max(200).optional(),
  })
  .strict();

const SettingsSchema = z
  .object({
    /** Program name → where to find it. Only these can run. */
    programs: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), ProgramSchema)
      .default({
        git: { description: "Version control" },
        ffmpeg: { description: "Media conversion" },
        ffprobe: { description: "Media inspection" },
        exiftool: { description: "Media metadata" },
        mediainfo: { description: "Media information" },
        magick: { description: "ImageMagick image processing" },
      }),
  })
  .strict();

/** Interpreters and launchers that would turn arguments into commands. */
const FORBIDDEN_PROGRAMS = new Set([
  "cmd", "command", "powershell", "powershell_ise", "pwsh", "bash", "sh", "zsh", "fish", "dash", "ksh", "csh", "tcsh",
  "wsl", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "msiexec", "schtasks", "at", "start", "explorer",
  "osascript", "env", "sudo", "su", "runas", "xargs", "nohup", "script", "python", "python3", "py", "pythonw", "node",
  "perl", "ruby", "php", "lua", "deno", "bun",
]);
const FORBIDDEN_EXTENSIONS = new Set([".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".msc", ".lnk", ".sh", ".py", ".scr", ".com", ".pif"]);

export function assertRunnable(file: string): void {
  const p = file.includes("\\") ? path.win32 : path.posix;
  const ext = p.extname(file).toLowerCase();
  const base = p.basename(file, ext).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) throw new PermissionDeniedError(`${p.basename(file)}: script files cannot be run (no shell is ever used).`);
  if (FORBIDDEN_PROGRAMS.has(base)) throw new PermissionDeniedError(`${p.basename(file)} is a command interpreter or launcher and cannot be run.`);
}

const MAX_OUTPUT = 2 * 1024 * 1024;

export default defineToolPackage({
  manifest: {
    id: "terminal",
    version: "0.1.0",
    displayName: "Terminal",
    description: "Runs allow-listed programs (git, ffmpeg, exiftool…) without a shell.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["terminal.exec", "fs.read"],
  },
  configSchema: SettingsSchema,
  register: ({ config }) => {
    const resolve = async (name: string) => {
      const entry = config.programs[name];
      if (!entry) throw new ValidationError(`"${name}" is not an allowed program. Allowed: ${Object.keys(config.programs).join(", ")}. Add it under tools.settings.terminal.programs.`);
      assertRunnable(name);
      const file = await locateBinary(name, { configured: entry.path, configKey: `tools.settings.terminal.programs.${name}.path` });
      assertRunnable(file);
      return file;
    };
    return {
      tools: [
        defineTool({
          name: "terminal.programs",
          title: "Allowed programs",
          description: "Lists the programs terminal.run may start and whether each is installed.",
          input: z.object({}).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async () => {
            const programs = await Promise.all(
              Object.entries(config.programs).map(async ([name, entry]) => {
                const found = await resolve(name).then((p) => ({ path: p, error: null }), (e: Error) => ({ path: null, error: e.message }));
                return { name, description: entry.description ?? null, ...found };
              }),
            );
            return {
              content: [text(programs.map((p) => `${p.name}: ${p.path ?? `unavailable (${p.error})`}`).join("\n"))],
              structured: { programs },
            };
          },
        }),

        defineTool({
          name: "terminal.run",
          title: "Run program",
          description:
            "Runs an allowed program with an argument list (no shell: no pipes, redirects, globbing or variable expansion) and returns its exit code and output. Use terminal.programs to see what is allowed.",
          input: z
            .object({
              program: z.string().min(1).max(64).describe("Name from terminal.programs, e.g. git"),
              args: z.array(z.string().max(32_767)).max(500).default([]),
              cwd: z.string().min(1).max(32_767).optional().describe("Working directory (absolute)"),
              stdin: z.string().max(1_000_000).optional(),
              timeoutSec: z.number().int().min(1).max(3600).default(120),
            })
            .strict(),
          annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
          execution: { resourceClass: "external", longRunning: true, timeoutMs: 3600_000 + 5000 },
          capabilities: (input) => [
            { kind: "terminal.exec", target: input.program.toLowerCase(), reason: `run ${input.program} ${input.args.join(" ").slice(0, 200)}` },
            ...(input.cwd ? [{ kind: "fs.read" as const, target: input.cwd, reason: "working directory" }] : []),
          ],
          run: async (input, ctx) => {
            const program = await resolve(input.program.toLowerCase());
            const cwd = input.cwd ? await canonicalizePath(input.cwd, { platform: process.platform }) : undefined;
            if (cwd && !(await stat(cwd).catch(() => undefined))?.isDirectory()) throw new ValidationError(`Not a directory: ${cwd}`);
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(input.timeoutSec * 1000)]);
            const r = await runProcess(program, input.args, {
              signal,
              okExitCodes: "any",
              maxOutputBytes: MAX_OUTPUT,
              label: input.program,
              ...(cwd ? { cwd } : {}),
              ...(input.stdin !== undefined ? { input: input.stdin } : {}),
            });
            const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);
            const body = [
              `exit code ${r.exitCode} (${r.durationMs} ms)`,
              r.stdout ? `stdout:\n${tail(r.stdout, 20_000)}` : "",
              r.stderr ? `stderr:\n${tail(r.stderr, 8_000)}` : "",
            ].filter(Boolean).join("\n");
            return {
              content: [text(body)],
              structured: {
                exitCode: r.exitCode,
                stdout: tail(r.stdout, 200_000),
                stderr: tail(r.stderr, 50_000),
                stdoutTruncated: r.stdoutTruncated,
                stderrTruncated: r.stderrTruncated,
                durationMs: r.durationMs,
                summary: r.exitCode === 0 ? "ok" : lastLines(r.stderr || r.stdout, 4),
              },
            };
          },
        }),
      ],
    };
  },
});
