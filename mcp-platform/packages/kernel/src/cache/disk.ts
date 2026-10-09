/**
 * Disk cache tier. One JSON file per entry, sharded by the first two hex characters of the key.
 * Writes are atomic (temp file + rename). An in-memory index (built by an asynchronous scan at
 * startup) tracks sizes and access times for size-bounded LRU eviction.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CacheSetOptions, CacheStats, Clock, Logger } from "@lmp/core";

interface IndexEntry {
  size: number;
  lastAccess: number;
}

interface StoredEntry {
  readonly v: 1;
  readonly expiresAt: number | null;
  readonly value: unknown;
}

const KEY_PATTERN = /^[a-f0-9]{64}$/;

export class DiskCache {
  private readonly index = new Map<string, IndexEntry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private ready: Promise<void> | undefined;
  private evicting: Promise<void> | undefined;

  constructor(
    private readonly directory: string,
    readonly maxBytes: number,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Builds the index. Safe to call more than once; other methods await it. */
  init(): Promise<void> {
    this.ready ??= this.scan().catch((error: unknown) => {
      this.logger.warn("disk cache scan failed; starting empty", { error, directory: this.directory });
    });
    return this.ready;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.getEntry<T>(key))?.value;
  }

  /** Value plus absolute expiry (null = no expiry). */
  async getEntry<T>(key: string): Promise<{ readonly value: T; readonly expiresAt: number | null } | undefined> {
    await this.init();
    if (!KEY_PATTERN.test(key) || !this.index.has(key)) {
      this.misses++;
      return undefined;
    }
    const file = this.fileFor(key);
    let stored: StoredEntry;
    try {
      stored = JSON.parse(await readFile(file, "utf8")) as StoredEntry;
    } catch {
      this.forget(key);
      await rm(file, { force: true });
      this.misses++;
      return undefined;
    }
    if (stored.v !== 1 || (stored.expiresAt !== null && stored.expiresAt <= this.clock.now())) {
      await this.delete(key);
      this.misses++;
      return undefined;
    }
    const entry = this.index.get(key);
    const now = this.clock.now();
    if (entry) entry.lastAccess = now;
    // Persist recency so eviction order survives restarts; best effort.
    utimes(file, new Date(now), new Date(now)).catch(() => undefined);
    this.hits++;
    return { value: stored.value as T, expiresAt: stored.expiresAt };
  }

  async set(key: string, value: unknown, serialized: string | undefined, options: CacheSetOptions = {}): Promise<void> {
    await this.init();
    if (!KEY_PATTERN.test(key)) throw new TypeError("Disk cache keys must be sha-256 hex digests");
    const expiresAt = options.ttlMs === undefined ? null : this.clock.now() + options.ttlMs;
    const payload = serialized === undefined
      ? JSON.stringify({ v: 1, expiresAt, value } satisfies StoredEntry)
      : `{"v":1,"expiresAt":${expiresAt === null ? "null" : expiresAt},"value":${serialized}}`;
    const size = Buffer.byteLength(payload);
    if (size > this.maxBytes) return;
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, payload, "utf8");
    try {
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    this.forget(key);
    this.index.set(key, { size, lastAccess: this.clock.now() });
    this.bytes += size;
    if (this.bytes > this.maxBytes) await this.evict();
  }

  async delete(key: string): Promise<void> {
    await this.init();
    if (!KEY_PATTERN.test(key)) return;
    this.forget(key);
    await rm(this.fileFor(key), { force: true });
  }

  async clear(): Promise<void> {
    await this.init();
    this.index.clear();
    this.bytes = 0;
    const shards = await readdir(this.directory).catch(() => [] as string[]);
    await Promise.all(shards.filter((s) => /^[a-f0-9]{2}$/.test(s)).map((s) => rm(path.join(this.directory, s), { recursive: true, force: true })));
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.index.size, bytes: this.bytes, maxBytes: this.maxBytes };
  }

  private fileFor(key: string): string {
    return path.join(this.directory, key.slice(0, 2), `${key}.json`);
  }

  private forget(key: string): void {
    const entry = this.index.get(key);
    if (!entry) return;
    this.bytes -= entry.size;
    this.index.delete(key);
  }

  private evict(): Promise<void> {
    this.evicting ??= (async () => {
      try {
        const target = Math.floor(this.maxBytes * 0.9);
        const ordered = [...this.index.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        for (const [key] of ordered) {
          if (this.bytes <= target) break;
          this.forget(key);
          await rm(this.fileFor(key), { force: true });
        }
      } finally {
        this.evicting = undefined;
      }
    })();
    return this.evicting;
  }

  private async scan(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const shards = await readdir(this.directory);
    for (const shard of shards) {
      if (!/^[a-f0-9]{2}$/.test(shard)) continue;
      const dir = path.join(this.directory, shard);
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const name of files) {
        const full = path.join(dir, name);
        if (name.endsWith(".tmp")) {
          await rm(full, { force: true });
          continue;
        }
        const key = name.slice(0, -".json".length);
        if (!name.endsWith(".json") || !KEY_PATTERN.test(key)) continue;
        try {
          const s = await stat(full);
          this.index.set(key, { size: s.size, lastAccess: s.mtimeMs });
          this.bytes += s.size;
        } catch {
          /* removed concurrently */
        }
      }
    }
    if (this.bytes > this.maxBytes) await this.evict();
  }
}
