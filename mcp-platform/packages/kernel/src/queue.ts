/**
 * Job queue with independent lanes per resource class. Each lane has a concurrency limit and a
 * priority queue (stable FIFO within a priority). Jobs are cancellable while queued or running,
 * time-limited, report progress, and are retained for a bounded time/count after completion so
 * long-running results can be fetched later without leaking memory.
 */
import { randomUUID } from "node:crypto";
import {
  CancelledError,
  PlatformError,
  ResourceExhaustedError,
  TimeoutError,
  toPlatformError,
  type Clock,
  type ErrorCode,
  type EventBus,
  type Logger,
  type ProgressReport,
  type ResourceClass,
} from "@lmp/core";
import type { PlatformEvents } from "./events.js";

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobSpec<T> {
  readonly tool: string;
  readonly requestId: string;
  readonly client: string;
  readonly resourceClass: Exclude<ResourceClass, "inline">;
  readonly priority?: number;
  readonly timeoutMs: number;
  /** External cancellation (client request). */
  readonly signal?: AbortSignal;
  readonly run: (signal: AbortSignal, progress: (report: ProgressReport) => void) => Promise<T>;
}

export interface JobSnapshot {
  readonly id: string;
  readonly tool: string;
  readonly requestId: string;
  readonly client: string;
  readonly resourceClass: string;
  readonly state: JobState;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly progress?: ProgressReport;
  readonly error?: { readonly code: ErrorCode; readonly message: string };
}

export interface JobHandle<T> {
  readonly id: string;
  /** Settles with the job's value, or rejects with a PlatformError. */
  readonly result: Promise<T>;
  cancel(reason?: string): boolean;
}

export interface QueueLimits {
  readonly cpu: number;
  readonly io: number;
  readonly external: number;
  /** Per host lane (host:<id>); host scripting engines are single-threaded. */
  readonly host: number;
  /** Maximum queued (not yet running) jobs per lane before submissions are rejected. */
  readonly maxQueuedPerLane: number;
  readonly retentionMs: number;
  readonly maxRetained: number;
}

interface Job {
  readonly id: string;
  readonly spec: JobSpec<unknown>;
  readonly seq: number;
  readonly priority: number;
  readonly controller: AbortController;
  readonly createdAt: number;
  state: JobState;
  startedAt?: number;
  finishedAt?: number;
  progress?: ProgressReport;
  error?: PlatformError;
  value?: unknown;
  resolve: (value: unknown) => void;
  reject: (error: PlatformError) => void;
  /** Resolves with the final state; never rejects. */
  readonly settled: Promise<JobState>;
  markSettled: (state: JobState) => void;
  detachExternal?: (() => void) | undefined;
  timer?: NodeJS.Timeout | undefined;
}

interface Lane {
  readonly limit: number;
  running: number;
  readonly waiting: Job[];
}

export class JobQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly jobs = new Map<string, Job>();
  private seq = 0;
  private closed = false;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly limits: QueueLimits,
    private readonly clock: Clock,
    private readonly events: EventBus<PlatformEvents>,
    private readonly logger: Logger,
  ) {
    this.sweeper = setInterval(() => this.sweep(), Math.min(60_000, Math.max(1000, limits.retentionMs / 4)));
    this.sweeper.unref();
  }

  submit<T>(spec: JobSpec<T>): JobHandle<T> {
    if (this.closed) throw new CancelledError("The server is shutting down.");
    const lane = this.lane(spec.resourceClass);
    if (lane.waiting.length >= this.limits.maxQueuedPerLane) {
      throw new ResourceExhaustedError(`Too many queued jobs for ${spec.resourceClass} (${lane.waiting.length}). Try again later.`);
    }
    let resolve!: (value: unknown) => void;
    let reject!: (error: PlatformError) => void;
    const result = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers may not await immediately (e.g. job references); avoid unhandled-rejection noise.
    result.catch(() => undefined);
    let markSettled!: (state: JobState) => void;
    const settled = new Promise<JobState>((res) => {
      markSettled = res;
    });
    const job: Job = {
      id: randomUUID(),
      spec: spec as JobSpec<unknown>,
      seq: this.seq++,
      priority: spec.priority ?? 0,
      controller: new AbortController(),
      createdAt: this.clock.now(),
      state: "queued",
      resolve,
      reject,
      settled,
      markSettled,
    };
    this.jobs.set(job.id, job);
    if (spec.signal) {
      const external = spec.signal;
      const onAbort = () => this.cancelJob(job, new CancelledError("Cancelled by the client.", { cause: external.reason }));
      if (external.aborted) {
        queueMicrotask(onAbort);
      } else {
        external.addEventListener("abort", onAbort, { once: true });
        job.detachExternal = () => external.removeEventListener("abort", onAbort);
      }
    }
    insertByPriority(lane.waiting, job);
    this.events.emit("job.queued", { jobId: job.id, tool: spec.tool, resourceClass: spec.resourceClass });
    this.pump(spec.resourceClass, lane);
    return {
      id: job.id,
      result: result as Promise<T>,
      cancel: (reason?: string) => this.cancelJob(job, new CancelledError(reason ?? "Cancelled.")),
    };
  }

  get(id: string): JobSnapshot | undefined {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : undefined;
  }

  /** The value of a succeeded job, retained until the job is swept. */
  resultOf(id: string): { readonly state: JobState; readonly value?: unknown; readonly error?: PlatformError } | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return { state: job.state, ...(job.value !== undefined ? { value: job.value } : {}), ...(job.error ? { error: job.error } : {}) };
  }

  /** Waits for a job to settle; resolves with its state (never rejects). */
  async wait(id: string, signal?: AbortSignal): Promise<JobState | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const settled = this.settledPromise(job);
    if (!signal) return settled;
    return new Promise((resolve) => {
      const onAbort = () => resolve(job.state);
      signal.addEventListener("abort", onAbort, { once: true });
      void settled.then((state) => {
        signal.removeEventListener("abort", onAbort);
        resolve(state);
      });
    });
  }

  list(filter: { readonly states?: readonly JobState[] } = {}): JobSnapshot[] {
    const out: JobSnapshot[] = [];
    for (const job of this.jobs.values()) if (!filter.states || filter.states.includes(job.state)) out.push(snapshot(job));
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  cancel(id: string, reason = "Cancelled."): boolean {
    const job = this.jobs.get(id);
    return job ? this.cancelJob(job, new CancelledError(reason)) : false;
  }

  stats(): Readonly<Record<string, { readonly running: number; readonly queued: number; readonly limit: number }>> {
    const out: Record<string, { running: number; queued: number; limit: number }> = {};
    for (const [name, lane] of this.lanes) out[name] = { running: lane.running, queued: lane.waiting.length, limit: lane.limit };
    return out;
  }

  /** Rejects new work, cancels everything, and waits (bounded) for running jobs to settle. */
  async shutdown(graceMs = 5000): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    const active = [...this.jobs.values()].filter((j) => j.state === "queued" || j.state === "running");
    for (const job of active) this.cancelJob(job, new CancelledError("The server is shutting down."));
    const all = Promise.all(active.map((j) => this.settledPromise(j)));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]);
    if (timer) clearTimeout(timer);
  }

  private settledPromise(job: Job): Promise<JobState> {
    return job.settled;
  }

  private lane(resourceClass: string): Lane {
    let lane = this.lanes.get(resourceClass);
    if (!lane) {
      const limit = resourceClass.startsWith("host:")
        ? this.limits.host
        : resourceClass === "cpu"
          ? this.limits.cpu
          : resourceClass === "io"
            ? this.limits.io
            : this.limits.external;
      lane = { limit: Math.max(1, limit), running: 0, waiting: [] };
      this.lanes.set(resourceClass, lane);
    }
    return lane;
  }

  private pump(name: string, lane: Lane): void {
    while (lane.running < lane.limit && lane.waiting.length > 0) {
      const job = lane.waiting.shift();
      if (!job) break;
      if (job.state !== "queued") continue;
      lane.running++;
      void this.execute(job).finally(() => {
        lane.running--;
        this.pump(name, lane);
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    job.state = "running";
    job.startedAt = this.clock.now();
    this.events.emit("job.started", { jobId: job.id, tool: job.spec.tool, waitedMs: job.startedAt - job.createdAt });
    job.timer = setTimeout(
      () => this.cancelJob(job, new TimeoutError(`${job.spec.tool} exceeded its time limit (${Math.round(job.spec.timeoutMs / 1000)} s).`)),
      job.spec.timeoutMs,
    );
    const progress = (report: ProgressReport) => {
      if (job.state !== "running") return;
      job.progress = report;
      this.events.emit("job.progress", { jobId: job.id, tool: job.spec.tool, report });
    };
    try {
      const value = await raceAbort(job.spec.run(job.controller.signal, progress), job.controller.signal);
      if (job.state === "running") this.finish(job, "succeeded", value);
    } catch (error) {
      if (job.state === "running") {
        const reason: unknown = job.controller.signal.aborted ? job.controller.signal.reason : error;
        const platformError = toPlatformError(reason);
        this.finish(job, platformError.code === "CANCELLED" ? "cancelled" : "failed", undefined, platformError);
      }
    }
  }

  private cancelJob(job: Job, reason: PlatformError): boolean {
    if (job.state === "queued") {
      const lane = this.lanes.get(job.spec.resourceClass);
      if (lane) {
        const i = lane.waiting.indexOf(job);
        if (i >= 0) lane.waiting.splice(i, 1);
      }
      this.finish(job, "cancelled", undefined, reason);
      return true;
    }
    if (job.state === "running") {
      // Mark first so the late settlement of `run` is ignored; the controller tells the tool to stop.
      this.finish(job, reason.code === "CANCELLED" ? "cancelled" : "failed", undefined, reason);
      job.controller.abort(reason);
      return true;
    }
    return false;
  }

  private finish(job: Job, state: Exclude<JobState, "queued" | "running">, value?: unknown, error?: PlatformError): void {
    job.state = state;
    job.finishedAt = this.clock.now();
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    job.detachExternal?.();
    job.detachExternal = undefined;
    if (state === "succeeded") {
      job.value = value;
      job.resolve(value);
    } else {
      job.error = error ?? new CancelledError();
      job.reject(job.error);
    }
    job.markSettled(state);
    const durationMs = job.finishedAt - (job.startedAt ?? job.createdAt);
    this.events.emit("job.finished", {
      jobId: job.id,
      tool: job.spec.tool,
      state,
      durationMs,
      ...(job.error ? { errorCode: job.error.code } : {}),
    });
    if (state === "failed") this.logger.debug("job failed", { jobId: job.id, tool: job.spec.tool, error: job.error });
    this.sweep();
  }

  private sweep(): void {
    const now = this.clock.now();
    const finished: Job[] = [];
    for (const job of this.jobs.values()) if (isFinal(job.state)) finished.push(job);
    finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    let excess = finished.length - this.limits.maxRetained;
    for (const job of finished) {
      if (excess > 0 || now - (job.finishedAt ?? now) > this.limits.retentionMs) {
        this.jobs.delete(job.id);
        excess--;
      }
    }
  }
}

function isFinal(state: JobState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function insertByPriority(list: Job[], job: Job): void {
  // Higher priority first; equal priority keeps submission order. Binary search for the slot.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = list[mid] as Job;
    if (other.priority > job.priority || (other.priority === job.priority && other.seq < job.seq)) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, job);
}

/** Settles as soon as the signal aborts, even if `promise` ignores the signal. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as unknown);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as unknown);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function snapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    tool: job.spec.tool,
    requestId: job.spec.requestId,
    client: job.spec.client,
    resourceClass: job.spec.resourceClass,
    state: job.state,
    createdAt: job.createdAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.error ? { error: { code: job.error.code, message: job.error.message } } : {}),
  };
}

export { raceAbort };
