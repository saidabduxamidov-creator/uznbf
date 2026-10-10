/**
 * Full stack with the built-in tool packages: SDK client → stdio server → executor → permission
 * gate → fs/ffmpeg/video tools → local FFmpeg.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { locateFfmpeg, makeTestClip } from "@lmp/toolkit";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const ffmpeg = await locateFfmpeg({}, "test").then((b) => b.ffmpeg, () => undefined);
const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

describe("built-in tools through the MCP server", { skip: !ffmpeg && "ffmpeg not installed" }, () => {
  let root: string;
  let media: string;
  let client: Client;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lmp-tools-e2e-"));
    media = path.join(root, "media");
    await mkdir(media, { recursive: true });
    await makeTestClip(ffmpeg as string, path.join(media, "clip.mp4"));
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(
      path.join(root, "config", "config.json"),
      JSON.stringify({
        logging: { stderrLevel: "error" },
        queue: { syncWaitMs: 15_000 },
        permissions: {
          rules: [
            { capability: "fs.read", effect: "allow", targets: [media], description: "test media" },
            { capability: "fs.write", effect: "allow", targets: [path.join(media, "out")] },
          ],
        },
      }),
    );
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "--data-root", root], stderr: "pipe" });
    client = new Client({ name: "claude-ai", version: "1.0.0" });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("exposes fs, ffmpeg and video tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["fs.list_directory", "fs.write_text", "ffmpeg.probe", "ffmpeg.transcode", "video.detect_silence", "video.contact_sheet"]) assert.ok(names.includes(n), n);
  });

  it("allows configured folders and denies everything else", async () => {
    const listed = (await client.callTool({ name: "fs.list_directory", arguments: { path: media } })) as CallToolResult;
    assert.match(textOf(listed), /clip\.mp4/);
    const outside = (await client.callTool({ name: "fs.read_text", arguments: { path: path.join(root, "config", "config.json") } })) as CallToolResult;
    assert.equal(outside.isError, true);
    assert.match(textOf(outside), /Permission denied/);
    const write = (await client.callTool({ name: "fs.write_text", arguments: { path: path.join(media, "out", "plan.txt"), content: "cut at 1.5", createDirectories: true } })) as CallToolResult;
    assert.equal(write.isError, undefined, textOf(write));
    const writeElsewhere = (await client.callTool({ name: "fs.write_text", arguments: { path: path.join(media, "plan.txt"), content: "x" } })) as CallToolResult;
    assert.equal(writeElsewhere.isError, true, "read-only area");
  });

  it("probes (cached on repeat) and analyses media end to end", async () => {
    const args = { name: "ffmpeg.probe", arguments: { path: path.join(media, "clip.mp4") } };
    const first = (await client.callTool(args)) as CallToolResult;
    assert.equal((first.structuredContent as { hasAudio: boolean }).hasAudio, true);
    const t0 = performance.now();
    await client.callTool(args);
    assert.ok(performance.now() - t0 < 200, "second probe served from cache");
    const silence = (await client.callTool({ name: "video.detect_silence", arguments: { path: path.join(media, "clip.mp4") } })) as CallToolResult;
    assert.match(textOf(silence), /1 pauses/);
    const sheet = (await client.callTool({ name: "video.contact_sheet", arguments: { path: path.join(media, "clip.mp4"), columns: 2, rows: 2 } })) as CallToolResult;
    assert.equal(sheet.content[0]?.type, "image");
  });

  it("streams transcode progress and writes only inside the allowed output folder", async () => {
    const seen: number[] = [];
    const ok = (await client.callTool(
      { name: "ffmpeg.transcode", arguments: { path: path.join(media, "clip.mp4"), output: path.join(media, "out", "proxy.mp4"), preset: "proxy_720p" } },
      undefined,
      { onprogress: (p) => seen.push(p.progress) },
    )) as CallToolResult;
    assert.equal(ok.isError, undefined, textOf(ok));
    assert.ok(seen.length >= 1);
    const denied = (await client.callTool({ name: "ffmpeg.transcode", arguments: { path: path.join(media, "clip.mp4"), output: path.join(root, "evil.mp4"), preset: "proxy_720p" } })) as CallToolResult;
    assert.equal(denied.isError, true);
  });
});
