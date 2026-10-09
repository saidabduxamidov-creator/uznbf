/**
 * Local metrics: counters, gauges and fixed-bucket histograms plus process health (memory,
 * event-loop delay). Exposed only through local MCP resources/tools - never sent anywhere.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

type Labels = Readonly<Record<string, string>>;

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ""}`)
    .join(",");

export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const entry = this.values.get(key);
    if (entry) entry.value += by;
    else this.values.set(key, { labels: { ...labels }, value: by });
  }
  snapshot(): Array<{ labels: Labels; value: number }> {
    return [...this.values.values()].map((v) => ({ labels: v.labels, value: v.value }));
  }
}

export class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number; max: number }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: readonly number[]) {}
  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: { ...labels }, counts: new Array<number>(this.buckets.length + 1).fill(0), sum: 0, count: 0, max: 0 };
      this.series.set(key, s);
    }
    let i = this.buckets.findIndex((b) => value <= b);
    if (i < 0) i = this.buckets.length;
    s.counts[i] = (s.counts[i] ?? 0) + 1;
    s.sum += value;
    s.count++;
    if (value > s.max) s.max = value;
  }
  snapshot(): Array<{ labels: Labels; count: number; sum: number; max: number; p50: number; p95: number; p99: number }> {
    return [...this.series.values()].map((s) => ({
      labels: s.labels, count: s.count, sum: round(s.sum), max: round(s.max),
      p50: this.quantile(s.counts, s.count, 0.5), p95: this.quantile(s.counts, s.count, 0.95), p99: this.quantile(s.counts, s.count, 0.99),
    }));
  }
  /** Upper bound of the bucket containing the quantile (conservative estimate). */
  private quantile(counts: readonly number[], total: number, q: number): number {
    if (total === 0) return 0;
    const rank = Math.ceil(q * total);
    let seen = 0;
    for (let i = 0; i < counts.length; i++) {
      seen += counts[i] ?? 0;
      if (seen >= rank) return this.buckets[i] ?? Number.POSITIVE_INFINITY;
    }
    return Number.POSITIVE_INFINITY;
  }
}

export interface ProcessHealth {
  readonly uptimeSec: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
  readonly eventLoopDelayMs: { readonly mean: number; readonly p99: number; readonly max: number };
}

export const DURATION_BUCKETS_MS: readonly number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000];

export class MetricsRegistry {
  readonly toolCalls = new Counter("tool_calls_total", "Tool calls by tool and outcome");
  readonly toolDuration = new Histogram("tool_duration_ms", "Tool call duration", DURATION_BUCKETS_MS);
  readonly jobWait = new Histogram("job_wait_ms", "Time jobs spent queued", DURATION_BUCKETS_MS);
  readonly permissionDecisions = new Counter("permission_decisions_total", "Permission decisions by capability and effect");
  readonly cacheLookups = new Counter("cache_lookups_total", "Tool result cache lookups");
  private readonly loop: IntervalHistogram;
  private readonly startedAt = Date.now();

  constructor() {
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
  }

  health(): ProcessHealth {
    const mem = process.memoryUsage();
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      eventLoopDelayMs: { mean: round(this.loop.mean / 1e6), p99: round(this.loop.percentile(99) / 1e6), max: round(this.loop.max / 1e6) },
    };
  }

  snapshot(): Record<string, unknown> {
    return {
      toolCalls: this.toolCalls.snapshot(),
      toolDurationMs: this.toolDuration.snapshot(),
      jobWaitMs: this.jobWait.snapshot(),
      permissionDecisions: this.permissionDecisions.snapshot(),
      cacheLookups: this.cacheLookups.snapshot(),
      process: this.health(),
    };
  }

  dispose(): void {
    this.loop.disable();
  }
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
