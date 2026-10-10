/**
 * Built-in "platform" package: health, diagnostics, background jobs, cache and audit.
 * It is registered like any other package, but receives platform internals through its factory.
 */
import {
  NotFoundError,
  PRODUCT,
  defineTool,
  defineToolPackage,
  text,
  type ToolPackage,
  type ToolResult,
} from "@lmp/core";
import type { AuditRepository, JobQueue, JobRepository, MetricsRegistry, PackageManager, TieredCache, ToolRegistry } from "@lmp/kernel";
import { z } from "zod";

export interface PlatformPackageDeps {
  readonly queue: JobQueue;
  readonly jobs: JobRepository;
  readonly audit: AuditRepository;
  readonly cache: TieredCache;
  readonly metrics: MetricsRegistry;
  readonly registry: ToolRegistry;
  readonly packages: () => PackageManager;
  readonly paths: Readonly<Record<string, string>>;
  readonly configFile: string;
}

const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const json = (value: unknown) => text(JSON.stringify(value, null, 2));
const JOB_ID = z.string().uuid().describe("Job id returned by a long-running tool call");

const JobSnapshotSchema = z.object({
  id: z.string(),
  tool: z.string(),
  state: z.string(),
  resourceClass: z.string(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  progress: z.object({ progress: z.number(), total: z.number().optional(), message: z.string().optional() }).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export function createPlatformPackage(deps: PlatformPackageDeps): ToolPackage<unknown> {
  const health = () => {
    const report = deps.packages().report();
    const queue = deps.queue.stats();
    return {
      status: (report.failed.length === 0 ? "ok" : "degraded") as "ok" | "degraded",
      version: PRODUCT.version,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      tools: deps.registry.listTools().length,
      packages: { loaded: report.loaded.length, skipped: report.skipped.length, failed: report.failed.length },
      queue,
      process: { ...deps.metrics.health() } as Record<string, unknown>,
    };
  };

  return defineToolPackage({
    manifest: {
      id: "platform",
      version: PRODUCT.version,
      displayName: "Platform",
      description: "Health, diagnostics, background jobs, cache and permission audit of the local MCP platform.",
      platforms: ["win32", "darwin", "linux"],
      capabilities: [],
    },
    register: () => ({
      tools: [
        defineTool({
          name: "platform.health",
          title: "Platform health",
          description: "Server status: version, loaded tool packages, queue load and memory. Use first when a tool behaves unexpectedly.",
          input: z.object({}).strict(),
          output: z.object({
            status: z.enum(["ok", "degraded"]),
            version: z.string(),
            pid: z.number(),
            node: z.string(),
            platform: z.string(),
            tools: z.number(),
            packages: z.object({ loaded: z.number(), skipped: z.number(), failed: z.number() }),
            queue: z.record(z.string(), z.object({ running: z.number(), queued: z.number(), limit: z.number() })),
            process: z.record(z.string(), z.unknown()),
          }),
          annotations: READ_ONLY,
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async () => {
            const h = health();
            return { content: [json(h)], structured: h };
          },
        }),
        defineTool({
          name: "platform.diagnostics",
          title: "Platform diagnostics",
          description: "Detailed report: package load results (with reasons for skipped/failed packages), metrics, local paths and the config file location.",
          input: z.object({}).strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async () => {
            const report = { packages: deps.packages().report(), metrics: deps.metrics.snapshot(), cache: await deps.cache.stats(), paths: deps.paths, configFile: deps.configFile };
            return { content: [json(report)], structured: report as unknown as Record<string, unknown> };
          },
        }),
        defineTool({
          name: "platform.jobs.list",
          title: "List background jobs",
          description: "Jobs of this server process (most recent first). Set includeHistory to add persisted jobs from earlier sessions.",
          input: z.object({
            states: z.array(z.enum(["queued", "running", "succeeded", "failed", "cancelled"])).max(5).optional(),
            includeHistory: z.boolean().default(false),
            limit: z.number().int().min(1).max(200).default(50),
          }).strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async (input) => {
            const live = deps.queue.list(input.states ? { states: input.states } : {}).slice(0, input.limit);
            const history = input.includeHistory ? deps.jobs.recent(input.limit) : [];
            const result = { jobs: live, history };
            return { content: [json(result)], structured: result as unknown as Record<string, unknown> };
          },
        }),
        defineTool({
          name: "platform.jobs.status",
          title: "Job status",
          description: "State and latest progress of a background job.",
          input: z.object({ jobId: JOB_ID }).strict(),
          output: JobSnapshotSchema,
          annotations: READ_ONLY,
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async (input) => {
            const job = deps.queue.get(input.jobId);
            if (!job) throw new NotFoundError(`No job ${input.jobId} in this server session.`);
            return { content: [json(job)], structured: job as z.output<typeof JobSnapshotSchema> };
          },
        }),
        defineTool({
          name: "platform.jobs.result",
          title: "Job result",
          description: "Result of a background job. Waits up to waitMs (max 60000) for it to finish; returns the status if still running.",
          input: z.object({ jobId: JOB_ID, waitMs: z.number().int().min(0).max(60_000).default(0) }).strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "inline", timeoutMs: 70_000 },
          capabilities: () => [],
          run: async (input, ctx): Promise<ToolResult> => {
            if (!deps.queue.get(input.jobId)) throw new NotFoundError(`No job ${input.jobId} in this server session.`);
            if (input.waitMs > 0) {
              const waitSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(input.waitMs)]);
              await deps.queue.wait(input.jobId, waitSignal);
            }
            const outcome = deps.queue.resultOf(input.jobId);
            if (!outcome) throw new NotFoundError(`Job ${input.jobId} expired from the result history.`);
            if (outcome.state === "succeeded") return outcome.value as ToolResult;
            if (outcome.error) throw outcome.error;
            const status = deps.queue.get(input.jobId);
            return { content: [text(`Job ${input.jobId} is ${outcome.state}${status?.progress?.message ? ` (${status.progress.message})` : ""}. Call again to wait longer.`)] };
          },
        }),
        defineTool({
          name: "platform.jobs.cancel",
          title: "Cancel job",
          description: "Cancels a queued or running background job.",
          input: z.object({ jobId: JOB_ID }).strict(),
          output: z.object({ cancelled: z.boolean(), state: z.string() }),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async (input) => {
            if (!deps.queue.get(input.jobId)) throw new NotFoundError(`No job ${input.jobId} in this server session.`);
            const cancelled = deps.queue.cancel(input.jobId, "Cancelled via platform.jobs.cancel.");
            const state = deps.queue.get(input.jobId)?.state ?? "unknown";
            return { content: [text(cancelled ? `Job ${input.jobId} cancelled.` : `Job ${input.jobId} was already ${state}.`)], structured: { cancelled, state } };
          },
        }),
        defineTool({
          name: "platform.cache.stats",
          title: "Cache statistics",
          description: "Hit/miss counts and sizes of the memory and disk result caches.",
          input: z.object({}).strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async () => {
            const stats = await deps.cache.stats();
            return { content: [json(stats)], structured: stats as unknown as Record<string, unknown> };
          },
        }),
        defineTool({
          name: "platform.cache.clear",
          title: "Clear cache",
          description: "Deletes all cached tool results (memory and disk). Results are recomputed on the next call.",
          input: z.object({}).strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "io" },
          capabilities: () => [],
          run: async () => {
            await deps.cache.clear();
            return { content: [text("Cache cleared.")] };
          },
        }),
        defineTool({
          name: "platform.audit.recent",
          title: "Recent permission decisions",
          description: "Latest permission decisions (allowed and denied capability requests) from the local audit log.",
          input: z.object({ limit: z.number().int().min(1).max(500).default(50) }).strict(),
          annotations: READ_ONLY,
          execution: { resourceClass: "inline" },
          capabilities: () => [],
          run: async (input) => {
            const entries = deps.audit.recent(input.limit);
            return { content: [json(entries)], structured: { entries } };
          },
        }),
      ],
      resources: [
        {
          uri: "platform://health",
          name: "health",
          title: "Platform health",
          description: "Current server health (JSON).",
          mimeType: "application/json",
          read: async () => ({ text: JSON.stringify(health(), null, 2) }),
        },
        {
          uri: "platform://metrics",
          name: "metrics",
          title: "Platform metrics",
          description: "Tool call counts and latencies, queue, cache and process metrics (JSON). Local only.",
          mimeType: "application/json",
          read: async () => ({ text: JSON.stringify({ ...deps.metrics.snapshot(), cache: await deps.cache.stats() }, null, 2) }),
        },
      ],
    }),
  });
}
