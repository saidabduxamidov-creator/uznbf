/**
 * Safe external process execution for tool packages.
 *
 * - Never uses a shell: the executable and an argument array are passed directly (no injection).
 * - Output is captured with byte limits (memory-bounded) and optionally streamed line by line.
 * - Cancellation kills the whole process tree (Windows: taskkill /T /F; POSIX: process group).
 * - Windows console windows are hidden.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { CancelledError, ExternalProcessError, NotFoundError, PlatformError, TimeoutError } from "@lmp/core";

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Bytes of stdout/stderr kept in memory (each). Further output is counted but discarded. */
  readonly maxOutputBytes?: number;
  readonly onStdoutLine?: (line: string) => void;
  readonly onStderrLine?: (line: string) => void;
  /** Data written to stdin, which is then closed. */
  readonly input?: string | Buffer;
  /** Exit codes treated as success (default [0]). */
  readonly okExitCodes?: readonly number[];
  /** Short label used in error messages (defaults to the executable name). */
  readonly label?: string;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  private partial = "";

  constructor(private readonly max: number, private readonly onLine?: (line: string) => void) {}

  push(chunk: Buffer): void {
    if (this.size < this.max) {
      const room = this.max - this.size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(part);
      this.size += part.length;
      if (part.length < chunk.length) this.truncated = true;
    } else {
      this.truncated = true;
    }
    if (this.onLine) {
      const text = this.partial + chunk.toString("utf8");
      const lines = text.split(/\r\n|\n|\r/);
      this.partial = lines.pop() ?? "";
      if (this.partial.length > 65_536) this.partial = this.partial.slice(-65_536);
      for (const line of lines) this.emit(line);
    }
  }

  end(): void {
    if (this.onLine && this.partial) this.emit(this.partial);
    this.partial = "";
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  private emit(line: string): void {
    try {
      this.onLine?.(line);
    } catch {
      /* a faulty line consumer must not break process supervision */
    }
  }
}

export function runProcess(executable: string, args: readonly string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const label = options.label ?? executable.split(/[\\/]/).pop() ?? executable;
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const started = performance.now();
  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(spawnError(error, executable, label));
      return;
    }
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const out = new BoundedBuffer(max, options.onStdoutLine);
    const err = new BoundedBuffer(max, options.onStderrLine);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    let settled = false;
    let aborted: PlatformError | undefined;
    const onAbort = () => {
      aborted = signal ? abortReason(signal) : new CancelledError();
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("error", (error) => finish(() => reject(spawnError(error, executable, label))));
    child.on("close", (code, killedBy) => {
      out.end();
      err.end();
      finish(() => {
        if (aborted) {
          reject(aborted);
          return;
        }
        const exitCode = code ?? (killedBy ? 128 : -1);
        const result: ProcessResult = {
          exitCode,
          stdout: out.text(),
          stderr: err.text(),
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          durationMs: Math.round(performance.now() - started),
        };
        if (!(options.okExitCodes ?? [0]).includes(exitCode)) {
          reject(
            new ExternalProcessError(`${label} failed (exit code ${exitCode}): ${lastLines(result.stderr || result.stdout, 6)}`, {
              details: { executable, exitCode, stderr: lastLines(result.stderr, 40) },
            }),
          );
          return;
        }
        resolve(result);
      });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
  });
}

/** Kills a process and all of its children. Safe to call more than once. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
      killer.on("error", () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function abortReason(signal: AbortSignal): PlatformError {
  const reason: unknown = signal.reason;
  if (reason instanceof PlatformError) return reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") return new TimeoutError("The operation timed out.");
  return new CancelledError(undefined, { cause: reason });
}

function spawnError(error: unknown, executable: string, label: string): PlatformError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new NotFoundError(`${label} was not found at ${executable}.`, { cause: error });
  if (code === "EACCES") return new ExternalProcessError(`${label} is not executable: ${executable}`, { cause: error });
  return new ExternalProcessError(`${label} could not be started: ${(error as Error).message}`, { cause: error });
}

export function lastLines(text: string, count: number): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-count).join(" | ").slice(0, 2000);
}
