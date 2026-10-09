/**
 * Typed in-process event bus. Listener failures are isolated and reported through `onListenerError`
 * so one faulty subscriber never breaks the emitter or other subscribers.
 */
import type { ErrorCode, EventBus, ProgressReport, Unsubscribe } from "@lmp/core";

export interface PlatformEvents {
  "tool.started": { readonly requestId: string; readonly tool: string; readonly client: string };
  "tool.finished": {
    readonly requestId: string;
    readonly tool: string;
    readonly client: string;
    readonly durationMs: number;
    readonly outcome: "ok" | "error" | "cancelled" | "job";
    readonly cached: boolean;
    readonly errorCode?: ErrorCode;
  };
  "job.queued": { readonly jobId: string; readonly tool: string; readonly resourceClass: string };
  "job.started": { readonly jobId: string; readonly tool: string; readonly waitedMs: number };
  "job.progress": { readonly jobId: string; readonly tool: string; readonly report: ProgressReport };
  "job.finished": {
    readonly jobId: string;
    readonly tool: string;
    readonly state: "succeeded" | "failed" | "cancelled";
    readonly durationMs: number;
    readonly errorCode?: ErrorCode;
  };
  "permission.decided": {
    readonly tool: string;
    readonly requestId: string;
    readonly kind: string;
    readonly target?: string;
    readonly effect: "allow" | "deny";
    readonly rule: string;
  };
  "config.reloaded": { readonly changed: readonly string[] };
  "config.reloadFailed": { readonly message: string };
  "package.loaded": { readonly id: string; readonly version: string; readonly tools: number };
  "package.failed": { readonly location: string; readonly reason: string };
}

type AnyListener = (payload: never) => void;

export class TypedEventBus<Events extends object> implements EventBus<Events> {
  private readonly listeners = new Map<string, Set<AnyListener>>();

  constructor(
    private readonly onListenerError: (event: string, error: unknown) => void,
    private readonly maxListenersPerEvent = 100,
  ) {}

  on<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    if (set.size >= this.maxListenersPerEvent) {
      this.onListenerError(event, new Error(`Listener limit (${this.maxListenersPerEvent}) reached for "${event}" - possible leak`));
    }
    set.add(listener as AnyListener);
    return () => this.off(event, listener as AnyListener);
  }

  once<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  emit<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        (listener as (p: Events[K]) => void)(payload);
      } catch (error) {
        this.onListenerError(event, error);
      }
    }
  }

  listenerCount(event: keyof Events & string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }

  private off(event: string, listener: AnyListener): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(event);
  }
}
