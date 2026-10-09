import assert from "node:assert/strict";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { DiskCache, MemoryLruCache, TieredCache, cacheKey, canonicalJson } from "../src/index.js";
import { FakeClock, tempDir, testLogger } from "./helpers.js";

describe("cache keys", () => {
  it("are stable across property order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 0 }] } }), '{"a":{"c":[3,{"x":0,"y":1}],"d":2},"b":1}');
    assert.equal(cacheKey({ a: 1, b: 2 }), cacheKey({ b: 2, a: 1 }));
    assert.notEqual(cacheKey({ a: 1 }), cacheKey({ a: "1" }));
    assert.match(cacheKey("x"), /^[a-f0-9]{64}$/);
  });
});

describe("memory LRU", () => {
  it("evicts least recently used by bytes and honours TTL", () => {
    const clock = new FakeClock();
    const c = new MemoryLruCache(100, 60, clock);
    c.set("a", 1, 40);
    c.set("b", 2, 40);
    c.get("a");
    c.set("c", 3, 40);
    assert.equal(c.get("b"), undefined, "b was least recently used");
    assert.equal(c.get("a"), 1);
    assert.equal(c.set("big", 0, 61), false, "too large for memory tier");
    c.set("t", 9, 10, { ttlMs: 1000 });
    clock.advance(1001);
    assert.equal(c.get("t"), undefined);
    assert.ok(c.stats().bytes <= 100);
  });
});

describe("disk + tiered cache", () => {
  it("persists across instances, expires, and evicts by size", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const clock = new FakeClock();
      const { logger } = testLogger();
      const disk = new DiskCache(dir, 2000, clock, logger);
      const tiered = new TieredCache(new MemoryLruCache(1 << 20, 1 << 16, clock), disk, 60_000, clock);
      const k1 = cacheKey(1);
      await tiered.set(k1, { hello: "world" });
      const fresh = new TieredCache(new MemoryLruCache(1 << 20, 1 << 16, clock), new DiskCache(dir, 2000, clock, logger), 60_000, clock);
      assert.deepEqual(await fresh.get(k1), { hello: "world" }, "read back from disk by a new instance");
      clock.advance(60_001);
      assert.equal(await fresh.get(k1), undefined, "expired");
      for (let i = 0; i < 10; i++) {
        clock.advance(10);
        await disk.set(cacheKey("e", i), { blob: "z".repeat(300) }, undefined, {});
      }
      assert.ok(disk.stats().bytes <= 2000);
      assert.equal(await disk.get(cacheKey("e", 0)), undefined, "oldest evicted");
      assert.deepEqual(await disk.get(cacheKey("e", 9)), { blob: "z".repeat(300) });
      await tiered.clear();
      assert.equal(disk.stats().entries, 0);
    } finally {
      await cleanup();
    }
  });

  it("removes stale temp files and ignores corrupt entries", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const key = cacheKey("corrupt");
      await mkdir(path.join(dir, key.slice(0, 2)), { recursive: true });
      await writeFile(path.join(dir, key.slice(0, 2), `${key}.json`), "{broken");
      await writeFile(path.join(dir, key.slice(0, 2), `${key}.json.abc.tmp`), "partial");
      const disk = new DiskCache(dir, 1 << 20, new FakeClock(), testLogger().logger);
      assert.equal(await disk.get(key), undefined);
      assert.deepEqual(await readdir(path.join(dir, key.slice(0, 2))), []);
    } finally {
      await cleanup();
    }
  });

  it("namespaces isolate packages and copies protect stored values", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const clock = new FakeClock();
      const tiered = new TieredCache(new MemoryLruCache(1 << 20, 1 << 16, clock), new DiskCache(dir, 1 << 20, clock, testLogger().logger), 60_000, clock);
      const a = tiered.namespaced("a");
      const b = tiered.namespaced("b");
      const value = { list: [1] };
      await a.set("k", value);
      value.list.push(2);
      assert.deepEqual(await a.get("k"), { list: [1] });
      assert.equal(await b.get("k"), undefined);
    } finally {
      await cleanup();
    }
  });
});
