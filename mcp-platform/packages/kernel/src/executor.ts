/**
 * Tool executor: the single pipeline every call goes through.
 *
 *   lookup → validate input → check declared capabilities → authorize → cache lookup →
 *   run (inline or queued, with timeout + cancellation) → validate output → cache store
 *
 * Long-running tools return a job reference when they exceed the synchronous wait window; the
 * work continues in the queue and the result is fetched with the jobs tools.
 */
import { randomUUID } from "node:crypto";
import {
  InternalError,
  NotFoundError,
  TimeoutError,
  ValidationError,
  toPlatformError,
  type Cache,
  type ClientIdentity,
  type ConsentPrompt,
  type EventBus,
  type Logger,
  type PermissionGate,
  type PlatformError,
  type ProgressReport,
  type ToolResult,
  type ToolRunContext,
} from "@lmp/core";
import type { z } from "zod";
import { cacheKey } from "./cache/key.js";
import type { PlatformEvents } from "./events.js";
import type { MetricsRegistry } from "./metrics.js";
import { raceAbort, type JobQueue } from "./queue.js";
import type { RegisteredTool, ToolRegistry } from "./registry.js";

export interface CallContext {
  readonly requestId?: string;
  readonly client: ClientIdentity;
  /** Client cancellation for this request. */
  readonly signal: AbortSignal;
  readonly onProgress?: (report: ProgressReport) => void;
  readonly consent?: ConsentPrompt;
}

export type ExecutionOutcome =
  | { readonly kind: "result"; readonly result: ToolResult; readonly cached: boolean }
  | { readonly kind: "job"; readonly jobId: string; readonly tool: string }
  | { readonly kind: "error"; readonly error: PlatformError };

export interface ExecutorOptions {
  readonly syncWaitMs: number;
  readonly defaultTimeoutMs: number;
}

export interface ExecutorDeps {
  readonly registry: ToolRegistry;
  readonly gate: PermissionGate;
  readonly queue: JobQueue;
  readonly cache: Cache;
  readonly metrics: MetricsRegistry;
  readonly events: EventBus<PlatformEvents>;
  readonly logger: Logger;
}

export class ToolExecutor {
  private options: ExecutorOptions;
  /** Aborted on shutdown; inline calls observe it as well as their own signal. */
  private readonly lifetime = new AbortController();

  constructor(private readonly deps: ExecutorDeps, options: ExecutorOptions) {
    this.options = options;
  }

  updateOptions(options: ExecutorOptions): void {
    this.options = options;
  }

  shutdown(): void {
    this.lifetime.abort(new InternalError("The server is shutting down."));
  }

  async execute(name: string, rawArgs: unknown, call: CallContext): Promise<ExecutionOutcome> {
    const requestId = call.requestId ?? randomUUID();
    const started = performance.now();
    const { events, metrics } = this.deps;
    events.emit("tool.started", { requestId, tool: name, client: call.client.kind });
    let outcome: ExecutionOutcome;
    try {
      outcome = await this.executeInner(name, rawArgs, call, requestId);
    } catch (error) {
      outcome = { kind: "error", error: toPlatformError(error) };
    }
    const durationMs = performance.now() - started;
    const label = outcome.kind === "error" ? (outcome.error.code === "CANCELLED" ? "cancelled" : "error") : outcome.kind === "job" ? "job" : "ok";
    metrics.toolCalls.inc({ tool: name, outcome: label });
    metrics.toolDuration.observe(durationMs, { tool: name });
    events.emit("tool.finished", {
      requestId,
      tool: name,
      client: call.client.kind,
      durationMs: Math.round(durationMs),
      outcome: label,
      cached: outcome.kind === "result" && outcome.cached,
      ...(outcome.kind === "error" ? { errorCode: outcome.error.code } : {}),
    });
    if (outcome.kind === "error") {
      const level = outcome.error.code === "INTERNAL" ? "error" : "info";
      this.deps.logger[level]("tool call failed", { tool: name, requestId, error: outcome.error });
    }
    return outcome;
  }

  private async executeInner(name: string, rawArgs: unknown, call: CallContext, requestId: string): Promise<ExecutionOutcome> {
    const tool = this.deps.registry.getTool(name);
    if (!tool) throw new NotFoundError(`Unknown tool "${name}".`);
    const { definition } = tool;

    const parsed = definition.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(input)", message: issue.message }));
      throw new ValidationError(`Invalid arguments for ${name}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, issues);
    }
    const input = parsed.data as z.output<typeof definition.input>;

    const requests = definition.capabilities(input);
    for (const request of requests) {
      if (!tool.allowedCapabilities.has(request.kind)) {
        throw new InternalError(`Tool ${name} requested capability "${request.kind}" that its package does not declare.`);
      }
    }
    if (requests.length > 0) {
      await this.deps.gate.authorize(requests, {
        tool: name,
        requestId,
        client: call.client.kind,
        ...(call.consent ? { consent: call.consent } : {}),
      });
    }

    let key: string | undefined;
    if (definition.cache) {
      const extra = definition.cache.key ? await definition.cache.key(input) : null;
      key = cacheKey("tool-result", name, tool.packageVersion, input, extra);
      const hit = await this.deps.cache.get<ToolResult>(key).catch((error: unknown) => {
        this.deps.logger.warn("cache read failed", { tool: name, error });
        return undefined;
      });
      this.deps.metrics.cacheLookups.inc({ tool: name, result: hit ? "hit" : "miss" });
      if (hit) return { kind: "result", result: hit, cached: true };
    }

    const logger = this.deps.logger.child({ tool: name, requestId });
    const timeoutMs = definition.execution.timeoutMs ?? this.options.defaultTimeoutMs;
    const runOnce = async (signal: AbortSignal, progress: (report: ProgressReport) => void): Promise<ToolResult> => {
      const context: ToolRunContext = { signal, logger, requestId, client: call.client, progress };
      const result = await definition.run(input, context);
      return this.checkOutput(tool, result);
    };

    if (definition.execution.resourceClass === "inline") {
      const result = await this.runInline(runOnce, call, timeoutMs, name);
      if (key) await this.store(key, result, tool);
      return { kind: "result", result, cached: false };
    }

    // Queued execution. A long-running job must survive the request after a job reference was
    // returned, so the client signal is linked only while this call is still waiting.
    const link = new AbortController();
    const onClientAbort = () => link.abort(call.signal.reason);
    if (call.signal.aborted) link.abort(call.signal.reason);
    else call.signal.addEventListener("abort", onClientAbort, { once: true });
    // Progress belongs to the MCP request; once a job reference is returned the request is over
    // and its progress token is no longer valid, so forwarding stops (the queue keeps tracking it).
    let requestOpen = true;
    const progress = (report: ProgressReport) => {
      if (requestOpen) call.onProgress?.(report);
    };
    let handle;
    try {
      handle = this.deps.queue.submit<ToolResult>({
        tool: name,
        requestId,
        client: call.client.kind,
        resourceClass: definition.execution.resourceClass,
        timeoutMs,
        signal: link.signal,
        ...(definition.execution.priority !== undefined ? { priority: definition.execution.priority } : {}),
        run: async (signal, report) => {
          const forward = (r: ProgressReport) => {
            report(r);
            progress(r);
          };
          const result = await runOnce(signal, forward);
          if (key) await this.store(key, result, tool);
          return result;
        },
      });
    } catch (error) {
      call.signal.removeEventListener("abort", onClientAbort);
      throw error;
    }

    if (!definition.execution.longRunning) {
      try {
        return { kind: "result", result: await handle.result, cached: false };
      } finally {
        requestOpen = false;
        call.signal.removeEventListener("abort", onClientAbort);
      }
    }

    let waitTimer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      handle.result.then((result) => ({ done: true as const, result })),
      new Promise<{ done: false }>((resolve) => {
        waitTimer = setTimeout(() => resolve({ done: false }), this.options.syncWaitMs);
      }),
    ]).finally(() => clearTimeout(waitTimer));
    requestOpen = false;
    call.signal.removeEventListener("abort", onClientAbort);
    if (waited.done) return { kind: "result", result: waited.result, cached: false };
    return { kind: "job", jobId: handle.id, tool: name };
  }

  private async runInline(
    runOnce: (signal: AbortSignal, progress: (report: ProgressReport) => void) => Promise<ToolResult>,
    call: CallContext,
    timeoutMs: number,
    name: string,
  ): Promise<ToolResult> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new TimeoutError(`${name} exceeded its time limit (${Math.round(timeoutMs / 1000)} s).`)), timeoutMs);
    const signal = AbortSignal.any([call.signal, timeout.signal, this.lifetime.signal]);
    try {
      return await raceAbort(runOnce(signal, (r) => call.onProgress?.(r)), signal);
    } catch (error) {
      throw toPlatformError(signal.aborted ? (signal.reason as unknown) : error);
    } finally {
      clearTimeout(timer);
    }
  }

  private checkOutput(tool: RegisteredTool, result: ToolResult): ToolResult {
    if (!result || !Array.isArray(result.content)) throw new InternalError(`Tool ${tool.definition.name} returned an invalid result.`);
    const schema = tool.definition.output;
    if (!schema) return result;
    const parsed = schema.safeParse(result.structured);
    if (!parsed.success) {
      throw new InternalError(`Tool ${tool.definition.name} produced output that does not match its schema.`, {
        details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      });
    }
    return { content: result.content, structured: parsed.data as Record<string, unknown> };
  }

  private async store(key: string, result: ToolResult, tool: RegisteredTool): Promise<void> {
    const ttlMs = tool.definition.cache?.ttlMs;
    try {
      await this.deps.cache.set(key, result, ttlMs === undefined ? {} : { ttlMs });
    } catch (error) {
      this.deps.logger.warn("cache write failed", { tool: tool.definition.name, error });
    }
  }
}
