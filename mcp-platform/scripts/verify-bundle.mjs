#!/usr/bin/env node
/**
 * Verifies the bundled server before it is packaged:
 *  1. the bundle opens no network connection except the loopback panel bridge;
 *  2. copied alone into an empty folder (as the installer does), it starts over stdio, lists every
 *     tool, runs tools (pure, SQLite-backed, failing) through the official MCP SDK client, and
 *     reports structured errors from the single shared error classes.
 *
 *   node scripts/verify-bundle.mjs [--payload <dir>]
 */
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv.indexOf("--payload");
const payload = path.resolve(arg > 0 ? process.argv[arg + 1] : path.join(root, "release", "payload"));
const bundle = path.join(payload, "server", "server.mjs");

const code = await readFile(bundle, "utf8");
const manifest = JSON.parse(await readFile(path.join(payload, "server", "manifest.json"), "utf8"));
const { createHash } = await import("node:crypto");
assert.equal(createHash("sha256").update(code).digest("hex"), manifest.serverSha256, "manifest hash matches the bundle");

const NETWORK = /fetch\(|https?\.request\(|https?\.get\(|tls\.connect\(|new WebSocket\(|dgram\.|from "node:(?:http|https|tls|dgram)"|require\("(?:node:)?(?:http|https|tls|dgram)"\)/g;
const hits = code.match(NETWORK) ?? [];
assert.deepEqual(hits, [], `network APIs in bundle: ${hits.join(", ")}`);
const connects = code.match(/net\.connect\(/g) ?? [];
assert.equal(connects.length, 1, "exactly one socket connection site");
assert.match(code, /net\.connect\(\{ host: "127\.0\.0\.1", port \}\)/, "and it is the loopback panel bridge");

const dir = await mkdtemp(path.join(os.tmpdir(), "lmp-verify-"));
try {
  await copyFile(bundle, path.join(dir, "server.mjs"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(dir, "server.mjs"), "--data-root", path.join(dir, "data"), "--log-level", "error"],
    cwd: dir,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c) => (stderr += c));
  const client = new Client({ name: "bundle-verify", version: "1.0.0" });
  const started = performance.now();
  await client.connect(transport);
  const { tools } = await client.listTools();
  const startupMs = Math.round(performance.now() - started);
  const names = new Set(tools.map((t) => t.name));
  for (const id of manifest.tools.filter((t) => t !== "photoshop" || process.platform === "win32")) {
    assert.ok([...names].some((n) => n.startsWith(`${id}.`)), `tools of ${id} listed`);
  }
  const kf = await client.callTool({ name: "motion.keyframes", arguments: { track: 0, start: 0, prop: "scale", from: 100, to: 120, atSec: 0, durationSec: 0.5 } });
  assert.ok(!kf.isError && kf.structuredContent?.ops?.length === 1, "pure tool works");
  await client.callTool({ name: "database.note_save", arguments: { key: "verify", text: "ok" } });
  const note = await client.callTool({ name: "database.note_get", arguments: { key: "verify" } });
  assert.equal(note.content[0]?.text, "ok", "SQLite-backed tool works");
  const bad = await client.callTool({ name: "motion.keyframes", arguments: { track: 0, start: 0, prop: "position", from: 1, to: 2, atSec: 0, durationSec: 1 } });
  assert.equal(bad.isError, true);
  assert.equal(bad._meta?.["lmp/error"]?.code, "VALIDATION", "tool errors keep their code across packages");
  const missing = await client.callTool({ name: "database.note_get", arguments: { key: "nope" } });
  assert.equal(missing._meta?.["lmp/error"]?.code, "NOT_FOUND");
  const health = await client.callTool({ name: "platform.health", arguments: {} });
  assert.ok(!health.isError);
  await client.close();
  assert.ok(!/error|fatal/i.test(stderr), `server stderr: ${stderr}`);
  console.log(`verify-bundle: ok (${tools.length} tools, first tools/list after ${startupMs} ms, no network APIs except the loopback bridge)`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
