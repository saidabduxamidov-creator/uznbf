/**
 * End-to-end: the real server process over stdio, driven by the official MCP SDK client - the same
 * way Claude Desktop and ChatGPT Desktop launch it.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const ZOD = import.meta.resolve("zod");

const FIXTURE = `
import { z } from ${JSON.stringify(ZOD)};
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
const RO = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
const text = (t) => ({ type: "text", text: t });
export default {
  manifest: { id: "fixture", version: "1.0.0", displayName: "Fixture", description: "E2E fixture", platforms: ["win32", "darwin", "linux"], capabilities: ["fs.read"] },
  register: () => ({
    tools: [
      { name: "fixture.slow", title: "Slow", description: "Steps with progress", annotations: RO,
        input: z.object({ steps: z.number().int().min(1).max(100), delayMs: z.number().int().min(1).max(1000) }).strict(),
        execution: { resourceClass: "cpu" }, capabilities: () => [],
        run: async (input, ctx) => {
          console.log("stray stdout noise from a tool");
          for (let i = 1; i <= input.steps; i++) { await sleep(input.delayMs, ctx.signal); ctx.progress({ progress: i, total: input.steps, message: "step " + i }); }
          return { content: [text("done " + input.steps)] };
        } },
      { name: "fixture.long", title: "Long", description: "Long-running", annotations: RO,
        input: z.object({ ms: z.number().int().min(1).max(10000) }).strict(),
        execution: { resourceClass: "cpu", longRunning: true }, capabilities: () => [],
        run: async (input, ctx) => { await sleep(input.ms, ctx.signal); return { content: [text("long done")], structured: { ms: input.ms } }; } },
      { name: "fixture.read", title: "Read", description: "Needs approval", annotations: RO,
        input: z.object({ path: z.string() }).strict(),
        execution: { resourceClass: "io" }, capabilities: (input) => [{ kind: "fs.read", target: input.path, reason: "e2e" }],
        run: async (input) => ({ content: [text("read ok")] }) },
      { name: "fixture.fail", title: "Fail", description: "Throws", annotations: RO,
        input: z.object({}).strict(), execution: { resourceClass: "inline" }, capabilities: () => [],
        run: async () => { throw new Error("secret internal detail"); } },
    ],
  }),
};`;

interface Session {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stderr: string[];
}

async function connect(root: string, toolsDir: string, name: string, approve: boolean | undefined): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "--data-root", root, "--tools-dir", toolsDir],
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const client = new Client({ name, version: "1.0.0" }, approve === undefined ? {} : { capabilities: { elicitation: { form: {} } } });
  if (approve !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async () => (approve ? { action: "accept", content: { approve: true } } : { action: "decline" }));
  }
  await client.connect(transport);
  return { client, transport, stderr };
}

const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

describe("stdio server end-to-end", () => {
  let root: string;
  let toolsDir: string;
  let claude: Session;
  let chatgpt: Session;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lmp-e2e-"));
    toolsDir = path.join(root, "tools");
    await mkdir(path.join(toolsDir, "fixture", "dist"), { recursive: true });
    await writeFile(path.join(toolsDir, "fixture", "package.json"), JSON.stringify({ name: "fixture", type: "module", lmpTool: { id: "fixture", entry: "dist/index.js" } }));
    await writeFile(path.join(toolsDir, "fixture", "dist", "index.js"), FIXTURE);
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(path.join(root, "config", "config.json"), JSON.stringify({ queue: { syncWaitMs: 300 }, logging: { stderrLevel: "error" } }));
    claude = await connect(root, toolsDir, "claude-ai", true);
    chatgpt = await connect(root, toolsDir, "chatgpt-desktop", undefined);
  });

  after(async () => {
    await claude?.client.close();
    await chatgpt?.client.close();
    await rm(root, { recursive: true, force: true });
  });

  it("identifies itself and lists namespaced tools with schemas and annotations", async () => {
    assert.equal(claude.client.getServerVersion()?.name, "local-mcp-platform");
    assert.match(claude.client.getInstructions() ?? "", /local/i);
    const { tools } = await claude.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["platform.health", "platform.jobs.result", "fixture.slow", "fixture.long"]) assert.ok(names.includes(n), n);
    const slow = tools.find((t) => t.name === "fixture.slow");
    assert.deepEqual(slow?.inputSchema.required, ["steps", "delayMs"]);
    assert.equal(slow?.annotations?.readOnlyHint, true);
    const health = tools.find((t) => t.name === "platform.health");
    assert.equal(health?.outputSchema?.type, "object");
  });

  it("returns structured health and serves resources", async () => {
    const r = (await claude.client.callTool({ name: "platform.health", arguments: {} })) as CallToolResult;
    assert.equal(r.isError, undefined);
    assert.equal((r.structuredContent as { status: string }).status, "ok");
    const res = await claude.client.readResource({ uri: "platform://health" });
    const first = res.contents[0];
    assert.ok(first && "text" in first && JSON.parse(first.text).version === "0.1.0");
    await assert.rejects(claude.client.readResource({ uri: "platform://missing" }), /not found/i);
  });

  it("streams monotonic progress and keeps stdout clean despite console.log in a tool", async () => {
    const seen: number[] = [];
    const r = (await claude.client.callTool({ name: "fixture.slow", arguments: { steps: 6, delayMs: 40 } }, undefined, {
      onprogress: (p) => seen.push(p.progress),
    })) as CallToolResult;
    assert.equal(textOf(r), "done 6");
    assert.ok(seen.length >= 2, `progress notifications: ${seen.join(",")}`);
    assert.deepEqual([...seen].sort((a, b) => a - b), seen, "monotonic");
    assert.equal(seen.at(-1), 6, "final progress always delivered");
  });

  it("cancels a running call when the client aborts", async () => {
    const controller = new AbortController();
    const pending = claude.client.callTool({ name: "fixture.slow", arguments: { steps: 100, delayMs: 50 } }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort("user pressed stop"), 200);
    await assert.rejects(pending);
    let cancelled = false;
    for (let i = 0; i < 40 && !cancelled; i++) {
      const list = (await claude.client.callTool({ name: "platform.jobs.list", arguments: { states: ["cancelled"] } })) as CallToolResult;
      cancelled = (list.structuredContent as { jobs: Array<{ tool: string }> }).jobs.some((j) => j.tool === "fixture.slow");
      if (!cancelled) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(cancelled, "job recorded as cancelled");
  });

  it("long-running calls return a job reference and the result is fetched later", async () => {
    const r = (await chatgpt.client.callTool({ name: "fixture.long", arguments: { ms: 900 } })) as CallToolResult;
    assert.match(textOf(r), /background job/);
    const jobId = (r._meta?.["lmp/job"] as { jobId: string }).jobId;
    const result = (await chatgpt.client.callTool({ name: "platform.jobs.result", arguments: { jobId, waitMs: 5000 } })) as CallToolResult;
    assert.equal(textOf(result), "long done");
    assert.deepEqual(result.structuredContent, { ms: 900 });
    const status = (await chatgpt.client.callTool({ name: "platform.jobs.status", arguments: { jobId } })) as CallToolResult;
    assert.equal((status.structuredContent as { state: string }).state, "succeeded");
  });

  it("reports validation errors and hides internal error details", async () => {
    const bad = (await claude.client.callTool({ name: "fixture.slow", arguments: { steps: -1, delayMs: 1 } })) as CallToolResult;
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /steps/);
    const fail = (await claude.client.callTool({ name: "fixture.fail", arguments: {} })) as CallToolResult;
    assert.equal(fail.isError, true);
    assert.equal(textOf(fail), "Internal error.");
    const unknown = (await claude.client.callTool({ name: "nope.tool", arguments: {} })) as CallToolResult;
    assert.equal(unknown.isError, true);
  });

  it("asks for consent via elicitation when the client supports it, denies otherwise", async () => {
    const target = path.join(root, "secret.txt");
    const approved = (await claude.client.callTool({ name: "fixture.read", arguments: { path: target } })) as CallToolResult;
    assert.equal(textOf(approved), "read ok");
    const denied = (await chatgpt.client.callTool({ name: "fixture.read", arguments: { path: target } })) as CallToolResult;
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /Approval is required/);
    const audit = (await claude.client.callTool({ name: "platform.audit.recent", arguments: { limit: 10 } })) as CallToolResult;
    const entries = (audit.structuredContent as { entries: Array<{ client: string; effect: string }> }).entries;
    assert.ok(entries.some((e) => e.client === "claude" && e.effect === "allow"));
    assert.ok(entries.some((e) => e.client === "chatgpt" && e.effect === "deny"), "shared audit log across both server processes");
  });

  it("exits cleanly when the client disconnects", async () => {
    const session = await connect(root, toolsDir, "claude-ai", undefined);
    const pid = session.transport.pid;
    assert.ok(pid);
    await session.client.close();
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "server process exited");
    assert.equal(session.stderr.join("").includes("Error"), false, session.stderr.join(""));
  });
});
