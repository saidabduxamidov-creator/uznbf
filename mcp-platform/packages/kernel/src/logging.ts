/**
 * Structured logging. JSON lines to a size-rotated file and, above a threshold, a compact line to
 * stderr. stdout is never used: it carries the MCP JSON-RPC stream.
 *
 * Writes are buffered and flushed asynchronously in order; the buffer is bounded so a stalled disk
 * cannot grow memory without limit (excess lines are dropped and counted).
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { LOG_LEVELS, PlatformError, type LogFields, type LogLevel, type Logger } from "@lmp/core";

const LEVEL_VALUE: Readonly<Record<LogLevel, number>> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly pid: number;
  readonly [field: string]: unknown;
}

export interface LogSink {
  write(record: LogRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/* ------------------------------ redaction ------------------------------ */

const SENSITIVE_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 4000;
const MAX_ARRAY = 100;

export function sanitizeForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING})` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value instanceof Error) return serializeError(value, depth, seen);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => sanitizeForLog(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY})`);
    return out;
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `[binary ${(value as ArrayBufferView).byteLength} bytes]`;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeForLog(v, depth + 1, seen);
  }
  return out;
}

function serializeError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  if (error instanceof PlatformError) {
    out["code"] = error.code;
    out["details"] = sanitizeForLog(error.details, depth + 1, seen);
  } else {
    const code: unknown = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") out["code"] = code;
  }
  if (error.stack) out["stack"] = error.stack.split("\n").slice(0, 25).join("\n");
  if (error.cause !== undefined && depth < MAX_DEPTH) out["cause"] = sanitizeForLog(error.cause, depth + 1, seen);
  return out;
}

/* ------------------------------ logger ------------------------------ */

export class StructuredLogger implements Logger {
  private readonly threshold: number;

  constructor(
    private readonly sink: LogSink,
    readonly level: LogLevel,
    private readonly bindings: LogFields = {},
  ) {
    this.threshold = LEVEL_VALUE[level];
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_VALUE[level] >= this.threshold;
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger(this.sink, this.level, { ...this.bindings, ...bindings });
  }

  trace(message: string, fields?: LogFields): void { this.log("trace", message, fields); }
  debug(message: string, fields?: LogFields): void { this.log("debug", message, fields); }
  info(message: string, fields?: LogFields): void { this.log("info", message, fields); }
  warn(message: string, fields?: LogFields): void { this.log("warn", message, fields); }
  error(message: string, fields?: LogFields): void { this.log("error", message, fields); }
  fatal(message: string, fields?: LogFields): void { this.log("fatal", message, fields); }

  private log(level: LogLevel, message: string, fields: LogFields | undefined): void {
    if (LEVEL_VALUE[level] < this.threshold) return;
    const merged = sanitizeForLog({ ...this.bindings, ...(fields ?? {}) }) as Record<string, unknown>;
    this.sink.write({ ...merged, time: new Date().toISOString(), level, msg: message, pid: process.pid });
  }
}

/* ------------------------------ sinks ------------------------------ */

export interface RotatingFileSinkOptions {
  readonly directory: string;
  readonly fileName: string;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  /** Maximum buffered lines before new lines are dropped. */
  readonly maxBufferedLines?: number;
}

export class RotatingFileSink implements LogSink {
  private buffer: string[] = [];
  private stream: WriteStream | undefined;
  private size = 0;
  private chain: Promise<void> = Promise.resolve();
  private scheduled = false;
  private closed = false;
  private dropped = 0;
  private readonly maxBuffered: number;
  private readonly filePath: string;

  constructor(private readonly options: RotatingFileSinkOptions) {
    this.maxBuffered = options.maxBufferedLines ?? 10_000;
    this.filePath = path.join(options.directory, options.fileName);
  }

  get currentFile(): string {
    return this.filePath;
  }

  write(record: LogRecord): void {
    if (this.closed) return;
    if (this.buffer.length >= this.maxBuffered) {
      this.dropped++;
      return;
    }
    this.buffer.push(`${safeStringify(record)}\n`);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        void this.flush();
      });
    }
  }

  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.drain()).catch((error: unknown) => {
      process.stderr.write(`[log] write failed: ${(error as Error).message}\n`);
    });
    return this.chain;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    const s = this.stream;
    this.stream = undefined;
    if (s) await new Promise<void>((resolve) => s.end(resolve));
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const lines = this.buffer;
      this.buffer = [];
      if (this.dropped > 0) {
        lines.unshift(`${safeStringify({ time: new Date().toISOString(), level: "warn", msg: "log lines dropped (buffer full)", dropped: this.dropped, pid: process.pid })}\n`);
        this.dropped = 0;
      }
      await this.ensureStream();
      // Group lines into chunks that fit in the current file; rotate between chunks.
      let chunk = "";
      let chunkBytes = 0;
      for (const line of lines) {
        const bytes = Buffer.byteLength(line);
        if (this.size + chunkBytes + bytes > this.options.maxFileBytes && this.size + chunkBytes > 0) {
          if (chunkBytes > 0) {
            await this.writeChunk(chunk);
            this.size += chunkBytes;
            chunk = "";
            chunkBytes = 0;
          }
          await this.rotate();
        }
        chunk += line;
        chunkBytes += bytes;
      }
      if (chunkBytes > 0) {
        await this.writeChunk(chunk);
        this.size += chunkBytes;
      }
    }
  }

  private async ensureStream(): Promise<void> {
    if (this.stream) return;
    await mkdir(this.options.directory, { recursive: true });
    try {
      this.size = (await stat(this.filePath)).size;
    } catch {
      this.size = 0;
    }
    this.stream = createWriteStream(this.filePath, { flags: "a", encoding: "utf8" });
    this.stream.on("error", (error) => process.stderr.write(`[log] stream error: ${error.message}\n`));
  }

  private writeChunk(chunk: string): Promise<void> {
    const s = this.stream;
    if (!s) return Promise.resolve();
    return new Promise((resolve, reject) => {
      s.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  }

  private async rotate(): Promise<void> {
    const s = this.stream;
    this.stream = undefined;
    if (s) await new Promise<void>((resolve) => s.end(resolve));
    const { maxFiles } = this.options;
    await rm(`${this.filePath}.${maxFiles}`, { force: true });
    for (let i = maxFiles - 1; i >= 1; i--) {
      await rename(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`).catch(() => undefined);
    }
    await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
    this.size = 0;
    await this.ensureStream();
  }
}

/** Compact human-readable lines on stderr (visible in the MCP clients' server logs). */
export class StderrSink implements LogSink {
  private readonly threshold: number;
  constructor(level: LogLevel, private readonly out: NodeJS.WritableStream = process.stderr) {
    this.threshold = LEVEL_VALUE[level];
  }
  write(record: LogRecord): void {
    if (LEVEL_VALUE[record.level] < this.threshold) return;
    const { time, level, msg, pid: _pid, ...rest } = record;
    const extra = Object.keys(rest).length ? ` ${safeStringify(rest)}` : "";
    this.out.write(`${time} ${level.toUpperCase()} ${msg}${extra}\n`);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export class MultiSink implements LogSink {
  constructor(private readonly sinks: readonly LogSink[]) {}
  write(record: LogRecord): void {
    for (const s of this.sinks) s.write(record);
  }
  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush()));
  }
  async close(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.close()));
  }
}

/** Collects records in memory; used by tests and diagnostics. */
export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  constructor(private readonly max = 5000) {}
  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.max) this.records.splice(0, this.records.length - this.max);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ msg: "[unserializable log record]" });
  }
}
