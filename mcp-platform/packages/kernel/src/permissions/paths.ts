/**
 * Path safety. Targets are canonicalized (absolute, real path of the deepest existing ancestor plus
 * the remaining segments) before policy evaluation, so symlinks/junctions cannot escape allowed
 * roots. Windows device paths, UNC shares and alternate data streams are rejected outright.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { PermissionDeniedError, ValidationError } from "@lmp/core";

export interface PathRules {
  readonly platform: NodeJS.Platform;
}

export function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Throws for path forms that are never acceptable as tool targets. */
export function assertSafePathSyntax(input: string, rules: PathRules): void {
  if (input.length === 0 || input.length > 32_767) throw new ValidationError("Path is empty or too long.");
  if (input.includes("\u0000")) throw new ValidationError("Path contains a NUL character.");
  if (rules.platform !== "win32") return;
  const normalized = input.replace(/\//g, "\\");
  if (/^\\\\[?.]\\/.test(normalized)) throw new PermissionDeniedError("Windows device paths (\\\\?\\, \\\\.\\) are not allowed.");
  if (normalized.startsWith("\\\\")) throw new PermissionDeniedError("Network (UNC) paths are not allowed.");
  // A colon is only valid as the drive separator ("C:"); anything else is an alternate data stream.
  if (normalized.slice(2).includes(":")) throw new PermissionDeniedError("Alternate data streams are not allowed.");
  const reserved = /(^|\\)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.[^\\]*)?$/i;
  if (reserved.test(normalized)) throw new PermissionDeniedError("Reserved Windows device names are not allowed.");
}

/**
 * Absolute, symlink-resolved form of `input`. Works for paths that do not exist yet (files about to
 * be written): the deepest existing ancestor is resolved and the rest is appended.
 */
export async function canonicalizePath(input: string, rules: PathRules, resolveReal: (p: string) => Promise<string> = realpath): Promise<string> {
  assertSafePathSyntax(input, rules);
  const p = pathApi(rules.platform);
  if (!p.isAbsolute(input)) throw new ValidationError(`Path must be absolute: ${input}`);
  let current = p.normalize(input);
  const pending: string[] = [];
  for (;;) {
    try {
      const real = await resolveReal(current);
      const joined = pending.length ? p.join(real, ...pending.reverse()) : real;
      assertSafePathSyntax(joined, rules);
      return stripTrailingSeparator(joined, p);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        if (error instanceof ValidationError || error instanceof PermissionDeniedError) throw error;
        throw new PermissionDeniedError(`Path cannot be resolved: ${input}`, { cause: error });
      }
      const parent = p.dirname(current);
      if (parent === current) return stripTrailingSeparator(p.normalize(input), p);
      pending.push(p.basename(current));
      current = parent;
    }
  }
}

/** True when `target` equals `root` or lies inside it (case-insensitive on Windows and macOS). */
export function isWithin(root: string, target: string, platform: NodeJS.Platform): boolean {
  const p = pathApi(platform);
  const fold = platform === "win32" || platform === "darwin";
  const r = fold ? root.toLowerCase() : root;
  const t = fold ? target.toLowerCase() : target;
  if (t === r) return true;
  const rel = p.relative(r, t);
  return rel.length > 0 && !rel.startsWith("..") && !p.isAbsolute(rel);
}

function stripTrailingSeparator(value: string, p: path.PlatformPath): string {
  const root = p.parse(value).root;
  return value.length > root.length && /[\\/]$/.test(value) ? value.slice(0, -1) : value;
}

/** Simple wildcard matcher: "*" matches any run of characters; case-insensitive. */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value.toLowerCase());
}
