import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionDeniedError, TimeoutError, image, resourceLink, text } from "@lmp/core";
import { ProgressForwarder, identifyClient, toCallToolResult } from "../src/index.js";

describe("client identity", () => {
  it("maps Claude and ChatGPT desktop clients", () => {
    assert.equal(identifyClient({ name: "claude-ai", version: "1" }).kind, "claude");
    assert.equal(identifyClient({ name: "Claude Code" }).kind, "claude");
    assert.equal(identifyClient({ name: "chatgpt-desktop" }).kind, "chatgpt");
    assert.equal(identifyClient({ name: "codex-mcp-client" }).kind, "chatgpt");
    assert.equal(identifyClient(undefined).kind, "unknown");
  });
});

describe("tool result mapping", () => {
  it("maps content parts, structured output, jobs and errors", () => {
    const ok = toCallToolResult({ kind: "result", cached: false, result: { content: [text("a"), image("AAA", "image/png"), resourceLink("platform://x", "x", { mimeType: "text/plain" })], structured: { n: 1 } } });
    assert.deepEqual(ok.content, [
      { type: "text", text: "a" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "resource_link", uri: "platform://x", name: "x", mimeType: "text/plain" },
    ]);
    assert.deepEqual(ok.structuredContent, { n: 1 });
    const job = toCallToolResult({ kind: "job", jobId: "j", tool: "t.x" });
    assert.match((job.content[0] as { text: string }).text, /platform\.jobs\.result/);
    const denied = toCallToolResult({ kind: "error", error: new PermissionDeniedError("no") });
    assert.equal(denied.isError, true);
    assert.deepEqual(denied._meta, { "lmp/error": { code: "PERMISSION_DENIED", retryable: false } });
    const timeout = toCallToolResult({ kind: "error", error: new TimeoutError("slow") });
    assert.match((timeout.content[0] as { text: string }).text, /retrying may succeed/);
  });
});

describe("progress forwarder", () => {
  it("drops non-increasing updates, throttles, and always delivers the final one", async () => {
    const sent: number[] = [];
    const f = new ProgressForwarder("tok", async (p) => { sent.push(p.progress); }, () => undefined, 50);
    f.report({ progress: 1, total: 10 });
    f.report({ progress: 1, total: 10 });
    f.report({ progress: 0.5, total: 10 });
    for (let i = 2; i <= 9; i++) f.report({ progress: i, total: 10 });
    f.report({ progress: 10, total: 10 });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [1, 10], "intermediate updates throttled, final immediate");
    f.report({ progress: 11 });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(sent, [1, 10, 11], "pending update flushed after the interval");
    f.close();
    f.report({ progress: 12 });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(sent, [1, 10, 11], "closed forwarder sends nothing");
  });

  it("drain delivers the throttled last update and waits for in-flight sends", async () => {
    const sent: number[] = [];
    const f = new ProgressForwarder("tok", async (p) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push(p.progress);
    }, () => undefined, 1000);
    f.report({ progress: 1 });
    f.report({ progress: 2 });
    await f.drain();
    assert.deepEqual(sent, [1, 2], "pending update sent and awaited before the result");
  });
});
