import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { AuditRepository, JobRepository, KeyValueRepository, PLATFORM_MIGRATIONS, SqliteDatabase } from "../src/index.js";
import { FakeClock, tempDir } from "./helpers.js";

describe("sqlite repositories", () => {
  it("migrates once, shares the file between connections, and supports kv/audit/jobs", async () => {
    const { dir, cleanup } = await tempDir();
    const file = path.join(dir, "platform.db");
    const a = await SqliteDatabase.open(file);
    const b = await SqliteDatabase.open(file);
    try {
      assert.equal(a.migrate(PLATFORM_MIGRATIONS), 1);
      assert.equal(b.migrate(PLATFORM_MIGRATIONS), 0, "second process sees the applied migration");
      const clock = new FakeClock();
      const kvA = new KeyValueRepository(a, clock).scope("ffmpeg");
      const kvB = new KeyValueRepository(b, clock).scope("ffmpeg");
      await kvA.set("path", { exe: "C:\\ffmpeg.exe" });
      assert.deepEqual(await kvB.get("path"), { exe: "C:\\ffmpeg.exe" });
      await kvA.set("p_1", 1);
      await kvA.set("p%2", 2);
      assert.deepEqual(await kvA.keys("p_"), ["p_1"], "LIKE wildcards are escaped");
      assert.equal(await new KeyValueRepository(a, clock).scope("other").get("path"), undefined);
      assert.ok(await kvA.delete("path"));
      await assert.rejects(kvA.set("x", "y".repeat(1024 * 1024 + 1)), RangeError);

      const audit = new AuditRepository(a, clock);
      audit.record({ tool: "fs.read_file", requestId: "r", client: "claude", kind: "fs.read", target: "C:\\a", effect: "allow", rule: "rule #1" });
      clock.advance(10);
      audit.record({ tool: "fs.read_file", requestId: "r2", client: "chatgpt", kind: "fs.read", target: null, effect: "deny", rule: "default" });
      assert.deepEqual(audit.recent(5).map((r) => r.requestId), ["r2", "r"]);
      assert.equal(audit.pruneOlderThan(clock.now() - 5), 1);

      const jobs = new JobRepository(a);
      jobs.save({ id: "j1", tool: "ffmpeg.probe", requestId: "r", client: "claude", resourceClass: "external", state: "running", createdAt: 1, startedAt: 2 });
      jobs.save({ id: "j1", tool: "ffmpeg.probe", requestId: "r", client: "claude", resourceClass: "external", state: "running", createdAt: 1, startedAt: 2 });
      assert.equal(jobs.markOrphansInterrupted(() => false, 100), 1);
      assert.equal(jobs.recent(1)[0]?.state, "interrupted");
      assert.throws(() => a.transaction(() => { a.run("INSERT INTO kv (namespace, key, value, updated_at) VALUES ('t','k','1',1)"); throw new Error("rollback"); }), /rollback/);
      assert.equal(a.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE namespace = 't'")?.n, 0, "rolled back");
    } finally {
      a.close();
      b.close();
      await cleanup();
    }
  });
});
