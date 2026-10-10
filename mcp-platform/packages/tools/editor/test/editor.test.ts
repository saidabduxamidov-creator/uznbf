/**
 * Bridge end to end without any editor installed: the real panel agent (mcp-bridge.js) runs in
 * Node against the existing Premiere Pro and After Effects scripting mocks, which execute the real
 * host.jsx files. The editor tools talk to it over the real TCP protocol.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CancelledError, HostUnavailableError, ValidationError, type ToolPackage } from "@lmp/core";
import { createToolHarness, type ToolHarness } from "@lmp/toolkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import editorPackage from "../src/index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");
const requireCjs = createRequire(import.meta.url);

type Mock = { call: (name: string, ...args: unknown[]) => { ok: boolean; error?: string } & Record<string, unknown> };

interface Agent {
  readonly bridge: { init(): void; stop(): void; status(): { listening: boolean; clients: number; calls: number } };
  readonly delay: { ms: number };
}

/** Loads a fresh agent instance with a browser-like global for the given host mock. */
function startAgent(app: "ppro" | "ae", host: Mock, bridgesDir: string, soundsDir: string): Agent {
  const delay = { ms: 0 };
  const storage = new Map<string, string>();
  const listeners: Record<string, Array<() => void>> = {};
  const win = {
    __lmpBridgesDir: bridgesDir,
    addEventListener: (event: string, fn: () => void) => { (listeners[event] ??= []).push(fn); },
    GCHost: {
      available: true,
      app,
      call: async (fn: string, args: unknown[]) => {
        if (delay.ms) await new Promise((r) => setTimeout(r, delay.ms));
        const r = host.call(fn, ...args);
        if (!r.ok) throw new Error(r.error ?? "host error");
        return r;
      },
    },
    GCApplication: { speechTracks: () => [0], sequence: () => null, timelineChanged: () => undefined },
    GCMotion: requireCjs(path.join(REPO, "premiere-gemini-plugin", "client", "js", "motion.js")),
    GCLibrary: {
      index: async () => [{ id: "Whoosh/Swish.wav", folder: "Whoosh", name: "Swish", duration: 0.6, file: path.join(soundsDir, "Whoosh", "Swish.wav") }],
      fileById: (id: string) => path.join(soundsDir, id),
    },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g["window"] = win;
  g["document"] = { getElementById: (id: string) => (id === "ver" ? { textContent: "4.8.0" } : null), body: { classList: { contains: () => false } } };
  g["localStorage"] = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) };
  const file = path.join(REPO, "premiere-gemini-plugin", "client", "js", "mcp-bridge.js");
  delete requireCjs.cache[requireCjs.resolve(file)];
  requireCjs(file);
  const bridge = (win as unknown as { GCBridge: Agent["bridge"] }).GCBridge;
  bridge.init();
  return { bridge, delay };
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("editor tools through the real panel agent (Premiere mock)", () => {
  let root: string;
  let h: ToolHarness;
  let agent: Agent;
  let env: { seq: { videoTracks: Array<{ items: Array<{ start: { seconds: number }; end: { seconds: number } }> }> } };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lmp-editor-"));
    const bridges = path.join(root, "bridges");
    await writeFile(path.join(root, "placeholder"), "");
    const sounds = path.join(root, "sounds");
    await (await import("node:fs/promises")).mkdir(path.join(sounds, "Whoosh"), { recursive: true });
    await writeFile(path.join(sounds, "Whoosh", "Swish.wav"), "RIFF");
    const { makeEnv, makeItem, makeTrack, loadHost } = requireCjs(path.join(REPO, "premiere-gemini-plugin", "tests", "premiere-mock.cjs"));
    const v1 = makeTrack("V", 0), v2 = makeTrack("V", 1), a1 = makeTrack("A", 0), a2 = makeTrack("A", 1), a3 = makeTrack("A", 2, { name: "Musiqa" });
    for (const [s, e, i] of [[0, 8, 30], [8, 15, 52], [15, 25, 70]] as const) {
      v1.items.push(makeItem(v1, s, e, i, "D:/C9966.MP4"));
      a1.items.push(makeItem(a1, s, e, i, "D:/C9966.MP4"));
    }
    a3.items.push(makeItem(a3, 0, 25, 0, "D:/music.mp3"));
    env = makeEnv({ video: [v1, v2], audio: [a1, a2, a3], duration: 25, playhead: 10 });
    agent = startAgent("ppro", loadHost(env), bridges, sounds);
    await waitFor(async () => (await readdir(bridges).catch(() => [] as string[])).includes("premiere.json"), "discovery file");
    h = await createToolHarness(editorPackage as ToolPackage<unknown>, {}, { platformDataDir: root });
  });

  after(async () => {
    agent?.bridge.stop();
    await h?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("publishes a private discovery file and lists the connected host", async () => {
    const info = JSON.parse(await readFile(path.join(root, "bridges", "premiere.json"), "utf8")) as { port: number; token: string; protocol: number };
    assert.equal(info.protocol, 1);
    assert.match(info.token, /^[a-f0-9]{64}$/);
    const r = await h.run("editor.list_hosts", {});
    assert.match((r.content[0] as { text: string }).text, /Premiere Pro: connected, panel 4\.8\.0/);
  });

  it("reads timeline and selection, picking the only host automatically", async () => {
    const t = await h.run("editor.get_timeline", {});
    const s = t.structured as { host: string; duration: number; audioTracks: unknown[] };
    assert.equal(s.host, "premiere");
    assert.equal(s.duration, 25);
    assert.equal(s.audioTracks.length, 3);
    const sel = await h.run("editor.get_selection", {});
    assert.equal((sel.structured as { source: string }).source, "playhead");
  });

  it("applies zooms, motion presets and cuts through the real host script", async () => {
    const z = await h.run("editor.apply_zooms", { zooms: [{ time: 9, scale: 115, holdSec: 2 }] });
    assert.equal((z.structured as { applied: number }).applied, 1);
    const presets = await h.run("editor.motion_presets", {});
    assert.ok((presets.structured as { presets: Array<{ id: string }> }).presets.some((p) => p.id === "zoom_in"));
    const m = await h.run("editor.apply_motion_preset", { preset: "zoom_in", strength: 120 });
    assert.equal((m.structured as { applied: number }).applied, 1);
    const cut = await h.run("editor.apply_cuts", { ranges: [{ start: 12, end: 13.5 }, { start: 5, end: 6 }] });
    assert.equal((cut.structured as { applied: number }).applied, 2);
    const v1 = env.seq.videoTracks[0]?.items ?? [];
    assert.ok(Math.abs(Math.max(...v1.map((i) => i.end.seconds)) - 22.5) <= 0.05, `2.5 s removed (frame-snapped), gap closed: ${v1.map((i) => `${i.start.seconds}-${i.end.seconds}`).join(" ")}`);
    await assert.rejects(h.run("editor.apply_cuts", { ranges: [{ start: 3, end: 2 }] }), ValidationError);
  });

  it("inserts library sounds", async () => {
    const lib = await h.run("editor.sound_library", {});
    assert.deepEqual((lib.structured as { folders: string[] }).folders, ["Whoosh"]);
    const ins = await h.run("editor.insert_sound", { id: "Whoosh/Swish.wav", at: 4 });
    assert.match((ins.content[0] as { text: string }).text, /placed at 0:04/);
  });

  it("rejects wrong tokens and methods outside the allowlist", async () => {
    const info = JSON.parse(await readFile(path.join(root, "bridges", "premiere.json"), "utf8")) as { port: number; token: string };
    const talk = (lines: object[]) =>
      new Promise<string[]>((resolve) => {
        const out: string[] = [];
        const s = net.connect({ host: "127.0.0.1", port: info.port }, () => s.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
        s.setEncoding("utf8");
        s.on("data", (d: string) => out.push(...d.trim().split("\n")));
        s.on("close", () => resolve(out));
        setTimeout(() => s.destroy(), 300);
      });
    const bad = await talk([{ type: "hello", token: "0".repeat(64) }, { type: "call", id: 1, method: "gc_getSequenceInfo", args: [] }]);
    assert.match(bad[0] ?? "", /Authentication failed/);
    assert.equal(bad.length, 1, "no call executed after a failed hello");
    const good = await talk([
      { type: "hello", token: info.token },
      { type: "call", id: 1, method: "eval", args: ["process.exit()"] },
      { type: "call", id: 2, method: "gc_applyGrade", args: [{}, {}] },
    ]);
    assert.match(good[1] ?? "", /"code":"NOT_ALLOWED"/);
    assert.match(good[2] ?? "", /panel\.applyColor/);
  });

  it("cancels a waiting call and survives a panel restart", async () => {
    agent.delay.ms = 300;
    const ac = new AbortController();
    const slow = h.run("editor.get_timeline", {});
    const queued = h.run("editor.get_selection", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(queued, CancelledError);
    await slow;
    agent.delay.ms = 0;
    agent.bridge.stop();
    await assert.rejects(h.run("editor.get_timeline", {}), HostUnavailableError);
    agent.bridge.init();
    await waitFor(async () => (await readdir(path.join(root, "bridges"))).includes("premiere.json"), "new discovery file");
    const again = await h.run("editor.get_timeline", {});
    assert.equal((again.structured as { host: string }).host, "premiere", "reconnects to the restarted panel");
  });
});

describe("editor tools with After Effects", () => {
  it("works against the AE host through the same agent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lmp-editor-ae-"));
    const { makeAE, loadHost } = requireCjs(path.join(REPO, "aftereffects-gemini-plugin", "tests", "ae-mock.cjs"));
    const ae = makeAE({ name: "Reels", width: 1080, height: 1920, fps: 25, duration: 30 });
    const clip = ae.footage(path.join(root, "A.mp4"), { duration: 30, hasAudio: true });
    ae.comp.layers.add(clip);
    const host = loadHost(ae);
    const agent = startAgent("ae", { call: (name, ...args) => host.call(name, ...args) }, path.join(root, "bridges"), root);
    try {
      await waitFor(async () => (await readdir(path.join(root, "bridges")).catch(() => [] as string[])).includes("aftereffects.json"), "AE discovery");
      const h = await createToolHarness(editorPackage as ToolPackage<unknown>, {}, { platformDataDir: root });
      try {
        const t = await h.run("editor.get_timeline", { host: "aftereffects" });
        assert.equal((t.structured as { name: string; width: number }).name, "Reels");
        await assert.rejects(h.run("editor.get_timeline", { host: "premiere" }), /Premiere Pro is not connected/);
        await h.run("editor.set_playhead", { seconds: 4 });
        assert.equal(ae.comp.time, 4);
      } finally {
        await h.close();
      }
    } finally {
      agent.bridge.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("full stack: MCP client → stdio server → bridge → panel agent → host script", () => {
  it("edits the Premiere timeline from an MCP client", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lmp-fullstack-"));
    const { makeEnv, makeItem, makeTrack, loadHost } = requireCjs(path.join(REPO, "premiere-gemini-plugin", "tests", "premiere-mock.cjs"));
    const v1 = makeTrack("V", 0), a1 = makeTrack("A", 0);
    v1.items.push(makeItem(v1, 0, 20, 0, "D:/talk.mp4"));
    a1.items.push(makeItem(a1, 0, 20, 0, "D:/talk.mp4"));
    const env = makeEnv({ video: [v1], audio: [a1], duration: 20, playhead: 3 });
    // The server's data directory is <data-root>/data; the panel publishes into <data>/bridges.
    const agent = startAgent("ppro", loadHost(env), path.join(root, "data", "bridges"), root);
    const cli = path.join(REPO, "mcp-platform", "packages", "server", "dist", "src", "cli.js");
    const client = new Client({ name: "claude-ai", version: "1.0.0" });
    try {
      await waitFor(async () => (await readdir(path.join(root, "data", "bridges")).catch(() => [] as string[])).includes("premiere.json"), "discovery");
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "--data-root", root], stderr: "pipe" }));
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("editor.apply_cuts") && names.includes("editor.insert_text"));
      const t = (await client.callTool({ name: "editor.get_timeline", arguments: {} })) as CallToolResult;
      assert.equal(t.isError, undefined, JSON.stringify(t.content));
      assert.equal((t.structuredContent as { duration: number }).duration, 20);
      const cut = (await client.callTool({ name: "editor.apply_cuts", arguments: { ranges: [{ start: 2, end: 4 }] } })) as CallToolResult;
      assert.equal(cut.isError, undefined, JSON.stringify(cut.content));
      assert.ok(Math.abs(Math.max(...v1.items.map((i: { end: { seconds: number } }) => i.end.seconds)) - 18) <= 0.05);
      agent.bridge.stop();
      const gone = (await client.callTool({ name: "editor.get_timeline", arguments: {} })) as CallToolResult;
      assert.equal(gone.isError, true);
      assert.match((gone.content[0] as { text: string }).text, /No editing application is connected|not connected|closed/);
    } finally {
      await client.close();
      agent.bridge.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
