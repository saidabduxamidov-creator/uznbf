/**
 * Content-addressed cache keys: sha-256 over a canonical JSON encoding (object keys sorted), so
 * semantically equal inputs produce the same key regardless of property order.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet()));
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    if (value === undefined) return null;
    return value;
  }
  if (seen.has(value)) throw new TypeError("Cannot build a cache key from a circular structure");
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => normalize(v, seen));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = normalize(v, seen);
  }
  return out;
}

export function cacheKey(...parts: readonly unknown[]): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

/** Cheap file identity for cache keys: real path, size and modification time. */
export async function fileFingerprint(filePath: string): Promise<{ path: string; size: number; mtimeMs: number }> {
  const s = await stat(filePath);
  return { path: path.resolve(filePath), size: s.size, mtimeMs: Math.trunc(s.mtimeMs) };
}
