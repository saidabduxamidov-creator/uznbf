/**
 * Phase 6 checks: startup time with every built-in tool package, and a soak run through the real
 * MCP adapter (in-memory transport) to show memory stays bounded across thousands of calls,
 * including failures, permission denials and concurrent bursts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createPlatform, type Platform } from "../src/index.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((r) => setImmediate(r));
  }
};

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const EXPECTED_PACKAGES = ["platform", "fs", "ffmpeg", "video", "editor", "subtitles", "timeline", "motion", "clipboard", "database", "terminal", "ocr", "browser", "blender"];

describe("startup", () => {
  let root: string;
  before(async () => (root = await mkdtemp(path.join(os.tmpdir(), "lmp-startup-"))));
  after(() => rm(root, { recursive: true, force: true }));

  it("loads every built-in package quickly in-process", async () => {
    const started = performance.now();
    const platform = await createPlatform({ dataRoot: root, configOverrides: { logging: { stderrLevel: "fatal", file: false } } });
    const ms = performance.now() - started;
    try {
      const loaded = platform.packages.report().loaded.map((p) => p.id);
      for (const id of EXPECTED_PACKAGES) assert.ok(loaded.includes(id), `${id} loaded`);
      assert.ok(platform.registry.listTools().length >= 80, `${platform.registry.listTools().length} tools`);
      assert.ok(ms < 4000, `startup took ${Math.round(ms)} ms`);
    } finally {
      await platform.shutdown("test");
    }
  });

  it("answers initialize and tools/list over stdio within seconds", async () => {
    const started = performance.now();
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "--data-root", root, "--log-level", "error"], stderr: "pipe" });
    const client = new Client({ name: "startup-probe", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const ms = performance.now() - started;
    await client.close();
    assert.ok(tools.length >= 80);
    assert.ok(ms < 6000, `first tools/list after ${Math.round(ms)} ms`);
  });
});

describe("soak", () => {
  let root: string;
  let platform: Platform;
  let client: Client;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lmp-soak-"));
    platform = await createPlatform({ dataRoot: root, configOverrides: { logging: { stderrLevel: "fatal", file: true } } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await platform.adapter.connect(serverSide);
    client = new Client({ name: "soak", version: "1.0.0" });
    await client.connect(clientSide);
  });
  after(async () => {
    await client.close();
    await platform.shutdown("test");
    await rm(root, { recursive: true, force: true });
  });

  let n = 0;
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  /** One round of varied traffic: pure tools, SQLite writes/reads, errors and a permission denial. */
  const round = async () => {
    const i = n++;
    const results = await Promise.all([
      call("motion.keyframes", { track: 0, start: i % 50, prop: "scale", from: 100, to: 100 + (i % 40), atSec: i % 50, durationSec: 0.6, easing: "ease_out_back" }),
      call("database.note_save", { key: `soak/${i % 64}`, text: `note ${i} `.repeat(20) }),
      call("database.note_get", { key: `soak/${i % 64}` }),
      call("motion.plan_zooms", { segments: [{ start: 0, end: 2, text: "Salom!" }, { start: 3, end: 6, text: `Gap ${i}.` }] }),
      call("platform.health", {}),
      call("motion.keyframes", { track: 0, start: 0, prop: "position", from: 1, to: 2, atSec: 0, durationSec: 1 }), // validation error
      call("fs.stat", { path: path.join(root, `x${i}`) }), // "ask" without elicitation → denied
      call("no.such_tool", {}),
    ]);
    assert.equal(results[0]?.isError ?? false, false);
    assert.equal(results[5]?.isError, true);
    assert.equal(results[6]?.isError, true);
    assert.equal(results[7]?.isError, true);
  };

  it("keeps memory bounded over thousands of calls", async () => {
    for (let i = 0; i < 150; i++) await round();
    await settle();
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    for (let i = 0; i < 500; i++) await round();
    const perCallMs = (performance.now() - started) / (500 * 8);
    await settle();
    const growthMb = (process.memoryUsage().heapUsed - before) / 1_048_576;
    assert.ok(growthMb < 12, `heap grew ${growthMb.toFixed(1)} MB over 4000 calls`);
    assert.ok(perCallMs < 15, `${perCallMs.toFixed(2)} ms per call`);
  });

  it("handles concurrent bursts without losing responses", async () => {
    const burst = await Promise.all(Array.from({ length: 200 }, (_, i) => call("motion.shake", { track: 0, start: 0, atSec: i / 10, seed: i })));
    assert.equal(burst.filter((r) => !r.isError).length, 200);
    const health = (await call("platform.health", {})).structuredContent as { queue?: unknown };
    assert.ok(health);
  });
});
