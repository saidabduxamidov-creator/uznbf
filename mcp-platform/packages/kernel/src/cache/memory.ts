/**
 * Byte-bounded LRU cache with optional per-entry TTL. Map insertion order is the recency order.
 */
import type { CacheSetOptions, CacheStats, Clock } from "@lmp/core";

interface Entry {
  readonly value: unknown;
  readonly bytes: number;
  readonly expiresAt: number;
}

export class MemoryLruCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    readonly maxBytes: number,
    readonly maxEntryBytes: number,
    private readonly clock: Clock,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.clock.now()) {
      this.remove(key, entry);
      this.misses++;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.value as T;
  }

  /** Returns false when the value is too large for the memory tier. */
  set(key: string, value: unknown, bytes: number, options: CacheSetOptions = {}): boolean {
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return false;
    const expiresAt = options.ttlMs === undefined ? Number.POSITIVE_INFINITY : this.clock.now() + options.ttlMs;
    this.entries.set(key, { value, bytes, expiresAt });
    this.bytes += bytes;
    this.evict();
    return true;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size, bytes: this.bytes, maxBytes: this.maxBytes };
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.remove(key, entry);
    }
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}
