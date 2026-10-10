/**
 * Progress notifications for one request: monotonic (the protocol requires increasing progress),
 * rate-limited so chatty tools cannot flood the client, with the final update always delivered.
 */
import type { ProgressReport } from "@lmp/core";

export type ProgressSender = (params: { progressToken: string | number; progress: number; total?: number; message?: string }) => Promise<void>;

export class ProgressForwarder {
  private last = Number.NEGATIVE_INFINITY;
  private lastSentAt = 0;
  private pending: ProgressReport | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Notifications are sent in order; the result must not overtake them. */
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly token: string | number,
    private readonly send: ProgressSender,
    private readonly onError: (error: unknown) => void,
    private readonly minIntervalMs = 100,
  ) {}

  report(report: ProgressReport): void {
    if (this.closed || !Number.isFinite(report.progress) || report.progress <= this.last) return;
    const final = report.total !== undefined && report.progress >= report.total;
    const now = Date.now();
    if (final || now - this.lastSentAt >= this.minIntervalMs) {
      this.flushNow(report, now);
      return;
    }
    this.pending = report;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const p = this.pending;
        this.pending = undefined;
        if (p) this.flushNow(p, Date.now());
      }, this.minIntervalMs - (now - this.lastSentAt));
    }
  }

  /**
   * Sends a throttled pending update, waits (bounded) until every notification is written, then
   * closes. Call before returning the result so the final progress is not overtaken by it.
   */
  async drain(timeoutMs = 1000): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending && !this.closed) this.flushNow(pending, Date.now());
    this.closed = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.inflight, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    if (timer) clearTimeout(timer);
  }

  /** Stops forwarding immediately. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private flushNow(report: ProgressReport, now: number): void {
    if (report.progress <= this.last) return;
    this.last = report.progress;
    this.lastSentAt = now;
    this.pending = undefined;
    const params = {
      progressToken: this.token,
      progress: report.progress,
      ...(report.total !== undefined ? { total: report.total } : {}),
      ...(report.message !== undefined ? { message: report.message.slice(0, 500) } : {}),
    };
    this.inflight = this.inflight.then(() => this.send(params)).catch(this.onError);
  }
}
