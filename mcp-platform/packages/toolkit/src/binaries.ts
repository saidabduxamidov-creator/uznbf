/**
 * Locates external executables: explicit configuration → bundled directory (LMP_BIN_DIR, set by the
 * installer) → PATH. Results are cached per process. A missing binary is a clear NotFoundError that
 * tells the user what to configure.
 */
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import { ENV_PREFIX, NotFoundError, ValidationError } from "@lmp/core";

export interface LocateOptions {
  /** Explicit absolute path from configuration (wins when set). */
  readonly configured?: string | undefined;
  /** Name of the configuration key to mention in errors, e.g. "tools.settings.ffmpeg.ffmpegPath". */
  readonly configKey: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const cache = new Map<string, Promise<string>>();

export const BIN_DIR_ENV = `${ENV_PREFIX}BIN_DIR`;

export function locateBinary(name: string, options: LocateOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const key = JSON.stringify([name, options.configured ?? null, env[BIN_DIR_ENV] ?? null, platform]);
  let pending = cache.get(key);
  if (!pending) {
    pending = find(name, options, platform, env);
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

/** Forgets cached locations (tests, configuration changes). */
export function clearBinaryCache(): void {
  cache.clear();
}

async function find(name: string, options: LocateOptions, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const p = platform === "win32" ? path.win32 : path.posix;
  const exe = platform === "win32" && !/\.exe$/i.test(name) ? `${name}.exe` : name;
  if (options.configured) {
    if (!p.isAbsolute(options.configured)) throw new ValidationError(`${options.configKey} must be an absolute path.`);
    if (await isExecutable(options.configured, platform)) return options.configured;
    throw new NotFoundError(`${name} not found at ${options.configured} (${options.configKey}).`);
  }
  const candidates: string[] = [];
  const binDir = env[BIN_DIR_ENV];
  if (binDir) candidates.push(p.join(binDir, exe));
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  for (const dir of pathVar.split(platform === "win32" ? ";" : ":")) {
    const clean = dir.trim().replace(/^"|"$/g, "");
    if (clean && p.isAbsolute(clean)) candidates.push(p.join(clean, exe));
  }
  for (const candidate of candidates) if (await isExecutable(candidate, platform)) return candidate;
  throw new NotFoundError(
    `${name} was not found. Install it with the platform installer, or set "${options.configKey}" to the full path of ${exe} in the configuration file.`,
  );
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    if (platform !== "win32") await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
