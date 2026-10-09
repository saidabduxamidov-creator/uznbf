/**
 * Ports: interfaces the application depends on. Implementations live in @lmp/kernel (or in tests).
 */
import type { CapabilityRequest } from "./capabilities.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  isLevelEnabled(level: LogLevel): boolean;
  child(bindings: LogFields): Logger;
}

export type Unsubscribe = () => void;

export interface EventBus<Events extends object> {
  on<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): Unsubscribe;
  once<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): Unsubscribe;
  emit<K extends keyof Events & string>(event: K, payload: Events[K]): void;
  listenerCount(event: keyof Events & string): number;
}

export interface Clock {
  now(): number;
}

export interface CacheSetOptions {
  /** Time to live in milliseconds; omitted = until evicted. */
  readonly ttlMs?: number;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
}

/** Key/value cache for JSON-serializable values. Keys are produced by `cacheKey()`. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  stats(): Promise<Readonly<Record<string, CacheStats>>>;
}

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionDecision {
  readonly request: CapabilityRequest;
  readonly effect: "allow" | "deny";
  /** Which rule decided (for audit and diagnostics). */
  readonly rule: string;
}

export interface ConsentPrompt {
  /** Asks the human (through the MCP client) to approve; resolves false when not possible. */
  (message: string, request: CapabilityRequest): Promise<boolean>;
}

export interface PermissionContext {
  readonly tool: string;
  readonly requestId: string;
  readonly client: string;
  readonly consent?: ConsentPrompt;
}

export interface PermissionGate {
  /** Resolves when every request is allowed; rejects with PermissionDeniedError otherwise. */
  authorize(requests: readonly CapabilityRequest[], context: PermissionContext): Promise<readonly PermissionDecision[]>;
}
