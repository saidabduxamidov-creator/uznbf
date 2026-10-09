import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { defineTool, defineToolPackage, text, type ClientIdentity, type ToolPackage } from "@lmp/core";
import {
  DiskCache,
  JobQueue,
  MemoryLruCache,
  MetricsRegistry,
  PackageManager,
  PolicyPermissionGate,
  TieredCache,
  ToolExecutor,
  ToolRegistry,
  parseConfig,
  type PlatformConfigInput,
} from "../src/index.js";
import { deferred, sleep, tempDir, testEvents, testLogger } from "./helpers.js";

const CLIENT: ClientIdentity = { kind: "claude", name: "claude-ai", version: "1" };

async function world(configInput: PlatformConfigInput = {}) {
  const { dir, cleanup } = await tempDir();
  const config = parseConfig(configInput, "test");
  const { logger, sink } = testLogger();
  const { bus } = testEvents();
  const clock = { now: () => Date.now() };
  const registry = new ToolRegistry();
  const cache = new TieredCache(new MemoryLruCache(1 << 22, 1 << 20, clock), new DiskCache(path.join(dir, "cache"), 1 << 24, clock, logger), 60_000, clock);
  const kvStore = new Map<string, unknown>();
  const packages = new PackageManager({
    registry, config, logger, events: bus,
    cacheFor: (id) => cache.namespaced(id),
    kvFor: (id) => ({
      get: async <T>(k: string) => kvStore.get(`${id}/${k}`) as T | undefined,
      set: async (k, v) => { kvStore.set(`${id}/${k}`, v); },
      delete: async (k) => kvStore.delete(`${id}/${k}`),
      keys: async () => [...kvStore.keys()],
    }),
    dataRoot: path.join(dir, "data"), artifactsRoot: path.join(dir, "artifacts"), platform: process.platform,
  });
  const queue = new JobQueue({ cpu: 2, io: 2, external: 1, host: 1, maxQueuedPerLane: 50, retentionMs: 60_000, maxRetained: 100 }, clock, bus, logger);
  const gate = new PolicyPermissionGate(config.permissions, process.platform, { record: () => undefined }, bus, logger, "config.json");
  const metrics = new MetricsRegistry();
  const executor = new ToolExecutor({ registry, gate, queue, cache, metrics, events: bus, logger }, { syncWaitMs: config.queue.syncWaitMs, defaultTimeoutMs: config.queue.defaultTimeoutMs });
  const close = async () => { await queue.shutdown(100); metrics.dispose(); await cleanup(); };
  return { dir, registry, packages, executor, queue, metrics, sink, close };
}

const call = (signal = new AbortController().signal, extra = {}) => ({ client: CLIENT, signal, ...extra });

function demoPackage(runs: { count: number }, gateRun = deferred()): ToolPackage<{ greeting: string }> {
  return defineToolPackage({
    manifest: { id: "demo", version: "1.2.3", displayName: "Demo", description: "Test package", platforms: ["win32", "darwin", "linux"], capabilities: ["fs.read"] },
    configSchema: z.object({ greeting: z.string().default("hi") }).strict(),
    register: ({ config }) => ({
      tools: [
        defineTool({
          name: "demo.greet", title: "Greet", description: "Greets",
          input: z.object({ name: z.string().min(1).max(20) }).strict(),
          output: z.object({ message: z.string() }),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          cache: { ttlMs: 60_000 },
          capabilities: () => [],
          run: async (input) => { runs.count++; const message = `${config.greeting}, ${input.name}`; return { content: [text(message)], structured: { message } }; },
        }),
        defineTool({
          name: "demo.read", title: "Read", description: "Needs fs.read",
          input: z.object({ path: z.string() }),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "io" },
          capabilities: (input) => [{ kind: "fs.read", target: input.path }],
          run: async (input) => ({ content: [text(`read ${input.path}`)] }),
        }),
        defineTool({
          name: "demo.sneaky", title: "Sneaky", description: "Requests an undeclared capability",
          input: z.object({}),
          annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
          execution: { resourceClass: "inline" },
          capabilities: () => [{ kind: "terminal.exec", target: "cmd.exe" }],
          run: async () => ({ content: [text("should not run")] }),
        }),
        defineTool({
          name: "demo.render", title: "Render", description: "Long job with progress",
          input: z.object({ steps: z.number().int().min(1).max(10) }),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "cpu", longRunning: true },
          capabilities: () => [],
          run: async (input, ctx) => {
            for (let i = 1; i <= input.steps; i++) {
              ctx.progress({ progress: i, total: input.steps, message: `step ${i}` });
              await gateRun.promise;
            }
            return { content: [text("rendered")] };
          },
        }),
        defineTool({
          name: "demo.badoutput", title: "Bad", description: "Violates its output schema",
          input: z.object({}),
          output: z.object({ n: z.number() }),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async () => ({ content: [text("x")], structured: { n: "not a number" } as unknown as { n: number } }),
        }),
      ],
    }),
  });
}

describe("registry + executor", () => {
  it("validates, caches, enforces declared capabilities and output schemas", async () => {
    const w = await world({ tools: { settings: { demo: { greeting: "Salom" } } } });
    try {
      const runs = { count: 0 };
      assert.ok(await w.packages.registerBuiltin(demoPackage(runs) as ToolPackage<unknown>));
      const greet = w.registry.getTool("demo.greet");
      assert.deepEqual(greet?.inputJsonSchema["required"], ["name"]);
      assert.equal(greet?.inputJsonSchema["additionalProperties"], false);

      const first = await w.executor.execute("demo.greet", { name: "Ali" }, call());
      assert.equal(first.kind, "result");
      assert.deepEqual(first.kind === "result" && first.result.structured, { message: "Salom, Ali" });
      const second = await w.executor.execute("demo.greet", { name: "Ali" }, call());
      assert.ok(second.kind === "result" && second.cached);
      assert.equal(runs.count, 1);

      const invalid = await w.executor.execute("demo.greet", { name: "" , extra: 1 }, call());
      assert.ok(invalid.kind === "error" && invalid.error.code === "VALIDATION");
      assert.match(invalid.kind === "error" ? invalid.error.message : "", /name/);

      const unknown = await w.executor.execute("demo.nope", {}, call());
      assert.ok(unknown.kind === "error" && unknown.error.code === "NOT_FOUND");

      const sneaky = await w.executor.execute("demo.sneaky", {}, call());
      assert.ok(sneaky.kind === "error" && sneaky.error.code === "INTERNAL");

      const denied = await w.executor.execute("demo.read", { path: path.join(w.dir, "x.txt") }, call());
      assert.ok(denied.kind === "error" && denied.error.code === "PERMISSION_DENIED");
      const consented = await w.executor.execute("demo.read", { path: path.join(w.dir, "x.txt") }, call(undefined, { consent: async () => true }));
      assert.equal(consented.kind, "result");

      const bad = await w.executor.execute("demo.badoutput", {}, call());
      assert.ok(bad.kind === "error" && bad.error.code === "INTERNAL");
      assert.equal(bad.kind === "error" && bad.error.message.includes("schema"), true);
      const calls = w.metrics.toolCalls.snapshot();
      assert.ok(calls.some((c) => c.labels["tool"] === "demo.greet" && c.labels["outcome"] === "ok" && c.value === 2));
    } finally {
      await w.close();
    }
  });

  it("long-running tools return a job reference, stream progress, and finish in the background", async () => {
    const w = await world({ queue: { syncWaitMs: 50 } });
    try {
      const gate = deferred();
      await w.packages.registerBuiltin(demoPackage({ count: 0 }, gate) as ToolPackage<unknown>);
      const progress: string[] = [];
      const client = new AbortController();
      const outcome = await w.executor.execute("demo.render", { steps: 3 }, call(client.signal, { onProgress: (r: { message?: string }) => progress.push(r.message ?? "") }));
      assert.equal(outcome.kind, "job");
      const jobId = outcome.kind === "job" ? outcome.jobId : "";
      client.abort();
      assert.equal(w.queue.get(jobId)?.state, "running", "returning a job reference unlinks the request signal");
      gate.resolve();
      assert.equal(await w.queue.wait(jobId), "succeeded");
      assert.deepEqual((w.queue.resultOf(jobId)?.value as { content: unknown }).content, [{ type: "text", text: "rendered" }]);
      assert.deepEqual(progress, ["step 1"]);
    } finally {
      await w.close();
    }
  });

  it("client cancellation aborts a waiting queued call", async () => {
    const w = await world();
    try {
      await w.packages.registerBuiltin(demoPackage({ count: 0 }) as ToolPackage<unknown>);
      const client = new AbortController();
      const pending = w.executor.execute("demo.render", { steps: 2 }, call(client.signal));
      await sleep(20);
      client.abort();
      const outcome = await pending;
      assert.ok(outcome.kind === "error" && outcome.error.code === "CANCELLED");
    } finally {
      await w.close();
    }
  });
});

describe("package discovery", () => {
  async function writePackage(root: string, folder: string, id: string, body: string) {
    const dir = path.join(root, folder);
    await mkdir(path.join(dir, "dist"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: `x-${id}`, type: "module", lmpTool: { id, entry: "dist/index.js" } }));
    await writeFile(path.join(dir, "dist", "index.js"), body);
    return createHash("sha256").update(await readFile(path.join(dir, "dist", "index.js"))).digest("hex");
  }
  const pkgSource = (id: string, toolName = `${id}.ping`, extra = "") => `
    const tool = { name: ${JSON.stringify(toolName)}, title: "Ping", description: "Ping",
      input: (await import(${JSON.stringify(import.meta.resolve("zod"))})).z.object({}),
      annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      execution: { resourceClass: "inline" }, capabilities: () => [],
      run: async () => ({ content: [{ type: "text", text: "pong" }] }) };
    ${extra}
    export default { manifest: { id: ${JSON.stringify(id)}, version: "1.0.0", displayName: "P", description: "P", platforms: ["win32", "darwin", "linux"], capabilities: [] },
      register: () => ({ tools: [tool] }) };`;

  it("loads trusted packages, skips untrusted/disabled ones, and isolates failures", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const builtin = path.join(dir, "builtin");
      const user = path.join(dir, "user");
      await writePackage(builtin, "alpha", "alpha", pkgSource("alpha"));
      await writePackage(builtin, "broken", "broken", "throw new Error('kaboom');");
      await writePackage(builtin, "clash", "clash", pkgSource("clash", "alpha.ping"));
      await writePackage(builtin, "off", "off", pkgSource("off"));
      const goodHash = await writePackage(user, "beta", "beta", pkgSource("beta"));
      await writePackage(user, "gamma", "gamma", pkgSource("gamma"));
      await writePackage(user, "delta", "delta", pkgSource("delta"));
      await mkdir(path.join(user, "not-a-package"));
      const w = await world({ tools: { trusted: { beta: goodHash, delta: "0".repeat(64) }, disabled: ["off"] } });
      try {
        await w.packages.discover([{ directory: builtin, builtin: true }, { directory: user, builtin: false }, { directory: path.join(dir, "missing"), builtin: false }]);
        const report = w.packages.report();
        assert.deepEqual(report.loaded.map((p) => p.id).sort(), ["alpha", "beta"]);
        assert.deepEqual(report.skipped.map((p) => p.id).sort(), ["delta", "gamma", "off"]);
        assert.match(report.skipped.find((p) => p.id === "gamma")?.reason ?? "", /not trusted; to enable add/);
        assert.match(report.skipped.find((p) => p.id === "delta")?.reason ?? "", /hash mismatch/);
        assert.deepEqual(report.failed.map((p) => p.id).sort(), ["broken", "clash"]);
        assert.ok(!w.registry.getTool("clash.ping"));
        const pong = await w.executor.execute("beta.ping", {}, call());
        assert.deepEqual(pong.kind === "result" && pong.result.content, [{ type: "text", text: "pong" }]);
      } finally {
        await w.close();
      }
    } finally {
      await cleanup();
    }
  });
});
