import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ValidationError } from "@lmp/core";
import { ConfigWatcher, changedSections, loadConfig, parseConfig } from "../src/index.js";
import { sleep, tempDir, testLogger } from "./helpers.js";

describe("configuration", () => {
  it("fills defaults for every section", () => {
    const c = parseConfig({}, "test");
    assert.equal(c.logging.level, "info");
    assert.equal(c.permissions.defaults["terminal.exec"], "deny");
    assert.equal(c.permissions.defaults["fs.read"], "ask");
    assert.equal(c.queue.syncWaitMs, 20_000);
    assert.deepEqual(c.tools.trusted, {});
  });

  it("merges file < environment < overrides and reports exact bad keys", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await writeFile(path.join(dir, "config.json"), "\uFEFF" + JSON.stringify({ logging: { level: "debug" }, queue: { io: 3 }, permissions: { defaults: { network: "ask" } } }));
      const { config, fileExists } = await loadConfig({ configDir: dir, env: { LMP_QUEUE_IO: "5", LMP_LOG_FILE: "false" }, overrides: { logging: { level: "warn" } } });
      assert.ok(fileExists);
      assert.equal(config.logging.level, "warn");
      assert.equal(config.logging.file, false);
      assert.equal(config.queue.io, 5);
      assert.equal(config.permissions.defaults.network, "ask");
      assert.equal(config.permissions.defaults["fs.write"], "ask");
      await writeFile(path.join(dir, "config.json"), JSON.stringify({ queue: { io: 0 }, unknownSection: {} }));
      await assert.rejects(loadConfig({ configDir: dir, env: {} }), (e: unknown) => {
        assert.ok(e instanceof ValidationError);
        assert.match(e.message, /queue\.io/);
        assert.match(e.message, /unknownSection|Unrecognized/);
        return true;
      });
      await writeFile(path.join(dir, "config.json"), "{ not json");
      await assert.rejects(loadConfig({ configDir: dir, env: {} }), /not valid JSON/);
    } finally {
      await cleanup();
    }
  });

  it("watcher keeps the old config on invalid edits and publishes valid ones", async () => {
    const { dir, cleanup } = await tempDir();
    const file = path.join(dir, "config.json");
    try {
      await writeFile(file, JSON.stringify({ logging: { level: "info" } }));
      const initial = (await loadConfig({ configDir: dir, env: {} })).config;
      const changes: string[][] = [];
      const errors: unknown[] = [];
      const watcher = new ConfigWatcher({ configDir: dir, env: {}, file }, initial, (n, p) => changes.push(changedSections(p, n)), (e) => errors.push(e), testLogger().logger, 50);
      await writeFile(file, JSON.stringify({ queue: { io: -1 } }));
      await watcher.reload();
      assert.equal(errors.length, 1);
      assert.equal(watcher.config, initial);
      await writeFile(file, JSON.stringify({ logging: { level: "debug" } }));
      await watcher.reload();
      assert.deepEqual(changes, [["logging"]]);
      watcher.start();
      await writeFile(file, JSON.stringify({ logging: { level: "trace" } }));
      for (let i = 0; i < 40 && changes.length < 2; i++) await sleep(50);
      watcher.stop();
      assert.equal(watcher.config.logging.level, "trace");
    } finally {
      await cleanup();
    }
  });
});
