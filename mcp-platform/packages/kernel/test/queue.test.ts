import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CancelledError, ResourceExhaustedError, TimeoutError } from "@lmp/core";
import { JobQueue, type QueueLimits } from "../src/index.js";
import { deferred, sleep, testEvents, testLogger } from "./helpers.js";

const LIMITS: QueueLimits = { cpu: 2, io: 4, external: 1, host: 1, maxQueuedPerLane: 100, retentionMs: 60_000, maxRetained: 100 };

function makeQueue(limits: Partial<QueueLimits> = {}) {
  const { bus } = testEvents();
  const finished: string[] = [];
  bus.on("job.finished", (e) => finished.push(`${e.tool}:${e.state}`));
  const queue = new JobQueue({ ...LIMITS, ...limits }, { now: () => Date.now() }, bus, testLogger().logger);
  return { queue, finished };
}

const spec = (tool: string, run: (signal: AbortSignal) => Promise<unknown>, extra: Record<string, unknown> = {}) => ({
  tool, requestId: tool, client: "test", resourceClass: "cpu" as const, timeoutMs: 5000, run, ...extra,
});

describe("job queue", () => {
  it("respects lane concurrency and priority order", async () => {
    const { queue } = makeQueue({ cpu: 1 });
    const gate = deferred();
    const order: string[] = [];
    const first = queue.submit(spec("first", async () => { await gate.promise; order.push("first"); }));
    const low = queue.submit(spec("low", async () => { order.push("low"); }, { priority: 0 }));
    const high = queue.submit(spec("high", async () => { order.push("high"); }, { priority: 5 }));
    assert.equal(queue.get(low.id)?.state, "queued");
    assert.deepEqual(queue.stats()["cpu"], { running: 1, queued: 2, limit: 1 });
    gate.resolve();
    await Promise.all([first.result, low.result, high.result]);
    assert.deepEqual(order, ["first", "high", "low"]);
    await queue.shutdown();
  });

  it("host lanes are serialized per host, independent of each other", async () => {
    const { queue } = makeQueue();
    let active = 0;
    let max = 0;
    const work = async () => { active++; max = Math.max(max, active); await sleep(20); active--; };
    const host = (id: string) => ({ ...spec(id, work), resourceClass: `host:${id}` as const });
    await Promise.all([queue.submit(host("premiere")).result, queue.submit(host("premiere")).result, queue.submit(host("aftereffects")).result]);
    assert.equal(max, 2, "two different hosts in parallel, never two calls to the same host");
    await queue.shutdown();
  });

  it("cancels queued and running jobs and forwards abort to the work", async () => {
    const { queue, finished } = makeQueue({ cpu: 1 });
    let sawAbort = false;
    const running = queue.submit(spec("running", (signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { sawAbort = true; reject(signal.reason); });
    })));
    const queued = queue.submit(spec("queued", async () => "never"));
    await sleep(5);
    assert.ok(queued.cancel());
    await assert.rejects(queued.result, CancelledError);
    const client = new AbortController();
    const linked = queue.submit(spec("linked", async () => "x", { signal: client.signal }));
    client.abort();
    await assert.rejects(linked.result, CancelledError);
    assert.ok(running.cancel("stop"));
    await assert.rejects(running.result, /stop/);
    assert.ok(sawAbort);
    assert.equal(running.cancel(), false, "already final");
    assert.deepEqual(finished.sort(), ["linked:cancelled", "queued:cancelled", "running:cancelled"]);
    await queue.shutdown();
  });

  it("times out work that ignores its signal", async () => {
    const { queue } = makeQueue();
    const h = queue.submit(spec("slow", () => new Promise(() => undefined), { timeoutMs: 30 }));
    await assert.rejects(h.result, TimeoutError);
    assert.equal(queue.get(h.id)?.state, "failed");
    assert.equal(queue.get(h.id)?.error?.code, "TIMEOUT");
    await queue.shutdown();
  });

  it("rejects submissions beyond the lane backlog", async () => {
    const { queue } = makeQueue({ external: 1, maxQueuedPerLane: 1 });
    const block = deferred();
    const ext = (t: string) => ({ ...spec(t, () => block.promise), resourceClass: "external" as const });
    queue.submit(ext("a"));
    queue.submit(ext("b"));
    assert.throws(() => queue.submit(ext("c")), ResourceExhaustedError);
    block.resolve();
    await queue.shutdown();
  });

  it("retains bounded history and exposes results", async () => {
    const { queue } = makeQueue({ maxRetained: 10 });
    const handles = Array.from({ length: 15 }, (_, i) => queue.submit(spec(`t${i}`, async () => i)));
    await Promise.all(handles.map((h) => h.result));
    assert.equal(queue.list().length, 10);
    const last = handles.at(-1);
    assert.ok(last);
    assert.deepEqual(queue.resultOf(last.id), { state: "succeeded", value: 14 });
    assert.equal(await queue.wait(last.id), "succeeded");
    await queue.shutdown();
    assert.throws(() => queue.submit(spec("late", async () => 1)), CancelledError);
  });
});
