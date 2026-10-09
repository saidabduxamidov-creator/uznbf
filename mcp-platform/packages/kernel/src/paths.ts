/**
 * Per-user directories. Windows is the v1 target; macOS and Linux follow their platform
 * conventions so adding them later needs no changes outside this module.
 */
import os from "node:os";
import path from "node:path";
import { PRODUCT } from "@lmp/core";

export interface PlatformPaths {
  /** User-editable configuration (config.json). */
  readonly configDir: string;
  /** Durable state: database, package data. */
  readonly dataDir: string;
  /** Evictable derived data. */
  readonly cacheDir: string;
  readonly logsDir: string;
}

export interface PathEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
}

export function currentPathEnvironment(): PathEnvironment {
  return { platform: process.platform, env: process.env, homeDir: os.homedir() };
}

/**
 * @param rootOverride when set, every directory lives under this root (portable/test mode).
 */
export function resolvePlatformPaths(environment: PathEnvironment, rootOverride?: string): PlatformPaths {
  const name = PRODUCT.directoryName;
  if (rootOverride) {
    const root = path.resolve(rootOverride);
    return { configDir: path.join(root, "config"), dataDir: path.join(root, "data"), cacheDir: path.join(root, "cache"), logsDir: path.join(root, "logs") };
  }
  const { platform, env, homeDir } = environment;
  if (platform === "win32") {
    const p = path.win32;
    const roaming = env["APPDATA"] || p.join(homeDir, "AppData", "Roaming");
    const local = env["LOCALAPPDATA"] || p.join(homeDir, "AppData", "Local");
    return {
      configDir: p.join(roaming, name),
      dataDir: p.join(local, name),
      cacheDir: p.join(local, name, "Cache"),
      logsDir: p.join(local, name, "Logs"),
    };
  }
  const p = path.posix;
  if (platform === "darwin") {
    const support = p.join(homeDir, "Library", "Application Support", name);
    return {
      configDir: support,
      dataDir: support,
      cacheDir: p.join(homeDir, "Library", "Caches", name),
      logsDir: p.join(homeDir, "Library", "Logs", name),
    };
  }
  const configHome = env["XDG_CONFIG_HOME"] || p.join(homeDir, ".config");
  const dataHome = env["XDG_DATA_HOME"] || p.join(homeDir, ".local", "share");
  const cacheHome = env["XDG_CACHE_HOME"] || p.join(homeDir, ".cache");
  const stateHome = env["XDG_STATE_HOME"] || p.join(homeDir, ".local", "state");
  const lower = name.toLowerCase();
  return {
    configDir: p.join(configHome, lower),
    dataDir: p.join(dataHome, lower),
    cacheDir: p.join(cacheHome, lower),
    logsDir: p.join(stateHome, lower, "logs"),
  };
}
