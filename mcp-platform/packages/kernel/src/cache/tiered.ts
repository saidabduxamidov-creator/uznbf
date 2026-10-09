/**
 * Cache facade: memory LRU in front of the disk tier. Values are JSON-serialized once; small values
 * live in both tiers, large values on disk only. `namespaced()` gives each tool package an
 * isolated key space over the same storage.
 */
import { createHash } from "node:crypto";
import type { Cache, CacheSetOptions, CacheStats, Clock, ScopedCache } from "@lmp/core";
import type { DiskCache } from "./disk.js";
import type { MemoryLruCache } from "./memory.js";

export class TieredCache implements Cache {
  constructor(
    private readonly memory: MemoryLruCache,
    private readonly disk: DiskCache,
    private readonly defaultTtlMs: number,
    private readonly clock: Clock,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const hot = this.memory.get<T>(key);
    if (hot !== undefined) return hot;
    const cold = await this.disk.getEntry<T>(key);
    if (cold === undefined) return undefined;
    const remaining = cold.expiresAt === null ? undefined : cold.expiresAt - this.clock.now();
    if (remaining === undefined || remaining > 0) {
      this.memory.set(key, cold.value, Buffer.byteLength(JSON.stringify(cold.value)), remaining === undefined ? {} : { ttlMs: remaining });
    }
    return cold.value;
  }

  async set(key: string, value: unknown, options: CacheSetOptions = {}): Promise<void> {
    const ttl: CacheSetOptions = { ttlMs: options.ttlMs ?? this.defaultTtlMs };
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Cache values must be JSON-serializable");
    // Store a parsed copy so later mutation of `value` by the caller cannot corrupt the cache.
    this.memory.set(key, JSON.parse(serialized) as unknown, Buffer.byteLength(serialized), ttl);
    await this.disk.set(key, undefined, serialized, ttl);
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(key);
    await this.disk.delete(key);
  }

  async clear(): Promise<void> {
    this.memory.clear();
    await this.disk.clear();
  }

  async stats(): Promise<Readonly<Record<string, CacheStats>>> {
    return { memory: this.memory.stats(), disk: this.disk.stats() };
  }

  /** Isolated key space for one package over the same storage. */
  namespaced(namespace: string): ScopedCache {
    const scope = (key: string) => createHash("sha256").update(`${namespace}\u0000${key}`).digest("hex");
    return {
      get: <T>(key: string) => this.get<T>(scope(key)),
      set: (key, value, options) => this.set(scope(key), value, options),
      delete: (key) => this.delete(scope(key)),
    };
  }
}
