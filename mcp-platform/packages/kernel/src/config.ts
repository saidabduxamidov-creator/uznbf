/**
 * Configuration: built-in defaults < config.json < environment < CLI overrides, validated with zod.
 * Invalid configuration fails fast with the exact key path. The file is watched; on change the
 * new configuration is validated and published (consumers decide which parts they hot-apply).
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CAPABILITY_KINDS, ENV_PREFIX, LOG_LEVELS, PACKAGE_ID_PATTERN, ValidationError, type CapabilityKind, type Logger } from "@lmp/core";
import { z } from "zod";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export const PermissionEffectSchema = z.enum(["allow", "deny", "ask"]);

export const PermissionRuleSchema = z
  .object({
    capability: z.enum(CAPABILITY_KINDS),
    effect: PermissionEffectSchema,
    /**
     * fs.* and database.*: directory roots (the target must be inside one of them).
     * Others: exact names or "*" wildcards (e.g. "*.example.com", "ffmpeg*"). Omitted = any target.
     */
    targets: z.array(z.string().min(1).max(1024)).max(256).optional(),
    /** Restrict the rule to these tool names (exact). Omitted = any tool. */
    tools: z.array(z.string().min(1).max(128)).max(256).optional(),
    description: z.string().max(200).optional(),
  })
  .strict();

export type PermissionRule = z.output<typeof PermissionRuleSchema>;

const DEFAULT_EFFECTS: Readonly<Record<CapabilityKind, "allow" | "deny" | "ask">> = {
  "fs.read": "ask",
  "fs.write": "ask",
  "process.spawn": "allow",
  "terminal.exec": "deny",
  network: "deny",
  "clipboard.read": "ask",
  "clipboard.write": "allow",
  "database.read": "ask",
  "database.write": "ask",
  host: "allow",
};

export const PermissionPolicySchema = z
  .object({
    defaults: z
      .partialRecord(z.enum(CAPABILITY_KINDS), PermissionEffectSchema)
      .transform((partial) => ({ ...DEFAULT_EFFECTS, ...partial }) as Record<CapabilityKind, "allow" | "deny" | "ask">)
      .prefault({}),
    /** Evaluated in order; the first matching rule wins. */
    rules: z.array(PermissionRuleSchema).max(1000).default([]),
    /** Remember "ask" approvals for the lifetime of the server process. */
    rememberApprovals: z.boolean().default(true),
  })
  .strict();

export type PermissionPolicy = z.output<typeof PermissionPolicySchema>;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/i, "sha-256 hex digest");

export const PlatformConfigSchema = z
  .object({
    logging: z
      .object({
        level: z.enum(LOG_LEVELS).default("info"),
        stderrLevel: z.enum(LOG_LEVELS).default("warn"),
        file: z.boolean().default(true),
        maxFileBytes: z.number().int().min(64 * KB).max(GB).default(10 * MB),
        maxFiles: z.number().int().min(1).max(50).default(5),
      })
      .strict()
      .prefault({}),
    cache: z
      .object({
        memoryMaxBytes: z.number().int().min(MB).max(4 * GB).default(64 * MB),
        /** Values larger than this are kept on disk only. */
        memoryMaxEntryBytes: z.number().int().min(KB).max(256 * MB).default(2 * MB),
        diskMaxBytes: z.number().int().min(16 * MB).max(1024 * GB).default(2 * GB),
        defaultTtlMs: z.number().int().min(1000).default(7 * 24 * 3600 * 1000),
      })
      .strict()
      .prefault({}),
    queue: z
      .object({
        cpu: z.number().int().min(1).max(256).default(Math.max(1, os.availableParallelism() - 1)),
        io: z.number().int().min(1).max(256).default(8),
        external: z.number().int().min(1).max(64).default(2),
        /** How long a long-running call waits before returning a job reference. */
        syncWaitMs: z.number().int().min(0).max(110_000).default(20_000),
        defaultTimeoutMs: z.number().int().min(1000).max(24 * 3600 * 1000).default(10 * 60 * 1000),
        jobRetentionMs: z.number().int().min(10_000).default(60 * 60 * 1000),
        maxRetainedJobs: z.number().int().min(10).max(100_000).default(500),
      })
      .strict()
      .prefault({}),
    permissions: PermissionPolicySchema.prefault({}),
    tools: z
      .object({
        /** Extra directories scanned for tool packages (built-in packages are always loaded). */
        directories: z.array(z.string().min(1)).max(64).default([]),
        /** Third-party packages: lmpTool.id → sha-256 of the entry file. Untrusted packages are skipped. */
        trusted: z.record(z.string().regex(PACKAGE_ID_PATTERN), sha256Hex).default({}),
        disabled: z.array(z.string().regex(PACKAGE_ID_PATTERN)).default([]),
        /** Per-package settings, validated by each package's own schema. */
        settings: z.record(z.string().regex(PACKAGE_ID_PATTERN), z.unknown()).default({}),
        registerTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
      })
      .strict()
      .prefault({}),
    audit: z
      .object({
        retentionDays: z.number().int().min(1).max(3650).default(90),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type PlatformConfig = z.output<typeof PlatformConfigSchema>;
export type PlatformConfigInput = z.input<typeof PlatformConfigSchema>;

export const CONFIG_FILE_NAME = "config.json";

/** Environment overrides: LMP_LOG_LEVEL=debug, LMP_QUEUE_CPU=4 … (section_key in upper snake case). */
const ENV_KEYS: ReadonlyArray<readonly [string, readonly [string, string], "string" | "number" | "boolean"]> = [
  ["LOG_LEVEL", ["logging", "level"], "string"],
  ["LOG_STDERR_LEVEL", ["logging", "stderrLevel"], "string"],
  ["LOG_FILE", ["logging", "file"], "boolean"],
  ["CACHE_MEMORY_MAX_BYTES", ["cache", "memoryMaxBytes"], "number"],
  ["CACHE_DISK_MAX_BYTES", ["cache", "diskMaxBytes"], "number"],
  ["QUEUE_CPU", ["queue", "cpu"], "number"],
  ["QUEUE_IO", ["queue", "io"], "number"],
  ["QUEUE_EXTERNAL", ["queue", "external"], "number"],
  ["QUEUE_SYNC_WAIT_MS", ["queue", "syncWaitMs"], "number"],
  ["QUEUE_DEFAULT_TIMEOUT_MS", ["queue", "defaultTimeoutMs"], "number"],
];

type Json = Record<string, unknown>;

export function environmentOverrides(env: Readonly<Record<string, string | undefined>>): Json {
  const out: Json = {};
  for (const [suffix, [section, key], type] of ENV_KEYS) {
    const raw = env[`${ENV_PREFIX}${suffix}`];
    if (raw === undefined || raw === "") continue;
    let value: unknown = raw;
    if (type === "number") value = Number(raw);
    if (type === "boolean") value = /^(1|true|yes|on)$/i.test(raw);
    const sectionObject = (out[section] ??= {}) as Json;
    sectionObject[key] = value;
  }
  return out;
}

export function deepMerge(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

export function parseConfig(input: unknown, source: string): PlatformConfig {
  const result = PlatformConfigSchema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message }));
  throw new ValidationError(`Invalid configuration in ${source}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, issues);
}

export interface LoadConfigOptions {
  readonly configDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly overrides?: Json;
  /** Explicit config file; defaults to <configDir>/config.json. */
  readonly file?: string;
}

export interface LoadedConfig {
  readonly config: PlatformConfig;
  readonly file: string;
  readonly fileExists: boolean;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const file = options.file ? path.resolve(options.file) : path.join(options.configDir, CONFIG_FILE_NAME);
  const { json, exists } = await readJsonFile(file);
  const merged = deepMerge(deepMerge(json, environmentOverrides(options.env ?? process.env)), options.overrides ?? {});
  return { config: parseConfig(merged, exists ? file : "defaults/environment"), file, fileExists: exists };
}

async function readJsonFile(file: string): Promise<{ json: Json; exists: boolean }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { json: {}, exists: false };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (error) {
    throw new ValidationError(`Configuration file is not valid JSON: ${file} (${(error as Error).message})`);
  }
  if (!isPlainObject(parsed)) throw new ValidationError(`Configuration root must be a JSON object: ${file}`);
  return { json: parsed, exists: true };
}

/**
 * Watches the configuration file and reloads it (debounced). Invalid edits are reported and the
 * previous configuration stays active.
 */
export class ConfigWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private current: PlatformConfig;

  constructor(
    private readonly options: LoadConfigOptions & { readonly file: string },
    initial: PlatformConfig,
    private readonly onChange: (next: PlatformConfig, previous: PlatformConfig) => void,
    private readonly onError: (error: unknown) => void,
    private readonly logger: Logger,
    private readonly debounceMs = 300,
  ) {
    this.current = initial;
  }

  get config(): PlatformConfig {
    return this.current;
  }

  start(): void {
    if (this.watcher) return;
    try {
      // Watch the directory: editors replace files atomically, which breaks file-level watches.
      this.watcher = watch(path.dirname(this.options.file), { persistent: false }, (_event, name) => {
        if (name && path.basename(name.toString()) !== path.basename(this.options.file)) return;
        this.schedule();
      });
      this.watcher.on("error", (error) => this.logger.warn("config watcher error", { error }));
    } catch (error) {
      this.logger.warn("config file watching unavailable", { error, file: this.options.file });
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  async reload(): Promise<void> {
    try {
      const { config } = await loadConfig(this.options);
      const previous = this.current;
      if (JSON.stringify(previous) === JSON.stringify(config)) return;
      this.current = config;
      this.onChange(config, previous);
    } catch (error) {
      this.onError(error);
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reload();
    }, this.debounceMs);
    this.timer.unref();
  }
}

/** Top-level sections whose JSON differs between two configurations. */
export function changedSections(a: PlatformConfig, b: PlatformConfig): string[] {
  return (Object.keys(a) as Array<keyof PlatformConfig>).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
