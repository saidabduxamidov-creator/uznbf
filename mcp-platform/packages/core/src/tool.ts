/**
 * Tool contract. A tool is a typed, validated, permission-checked unit of work. Tools never touch
 * the MCP SDK; the server adapts them to the protocol.
 */
import type { z } from "zod";
import type { CapabilityRequest } from "./capabilities.js";
import type { ContentPart } from "./content.js";
import type { Logger } from "./ports.js";

/**
 * Where a call executes in the job queue. Each class has its own concurrency limit.
 * - inline: cheap, runs immediately without queueing (still cancellable and timed).
 * - cpu: CPU-bound; limited to the number of cores.
 * - io: disk/network bound.
 * - external: drives an external executable (ffmpeg, whisper, blender).
 * - host:<id>: drives a host application whose scripting engine is single-threaded.
 */
export type ResourceClass = "inline" | "cpu" | "io" | "external" | `host:${string}`;

export interface ToolAnnotations {
  /** The tool does not modify anything. */
  readonly readOnly: boolean;
  /** The tool may irreversibly change user data (only meaningful when readOnly is false). */
  readonly destructive: boolean;
  /** Repeating the same call has no additional effect. */
  readonly idempotent: boolean;
  /** The tool interacts with an open world (network, other applications' arbitrary state). */
  readonly openWorld: boolean;
}

export interface ProgressReport {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface ClientIdentity {
  /** Normalized client family. */
  readonly kind: "claude" | "chatgpt" | "unknown";
  readonly name: string;
  readonly version: string;
}

export interface ToolRunContext {
  /** Aborted when the client cancels, the call times out, or the server shuts down. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly requestId: string;
  readonly client: ClientIdentity;
  /** Reports progress; throttled and forwarded to the client when it asked for progress. */
  progress(report: ProgressReport): void;
}

export interface ToolResult<S extends Record<string, unknown> = Record<string, unknown>> {
  readonly content: readonly ContentPart[];
  /** Machine-readable result; must match the tool's output schema when one is declared. */
  readonly structured?: S;
}

export interface ToolCachePolicy<I> {
  readonly ttlMs: number;
  /**
   * Extra key material beyond the validated input (e.g. file fingerprints). The final cache key
   * always includes tool name and version.
   */
  readonly key?: (input: I) => unknown | Promise<unknown>;
}

export interface ToolExecutionPolicy {
  readonly resourceClass: ResourceClass;
  /** Hard limit for one call; defaults to the platform default. */
  readonly timeoutMs?: number;
  /**
   * Long-running calls return a job reference when they do not finish within the synchronous wait
   * window; the client fetches the result with the jobs.* tools.
   */
  readonly longRunning?: boolean;
  /** Higher runs first within the same resource class. Default 0. */
  readonly priority?: number;
}

export interface ToolDefinition<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject | undefined = z.ZodObject | undefined,
> {
  /** Namespaced name: "<package>.<action>", lowercase, e.g. "ffmpeg.probe". */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  readonly output?: O;
  readonly annotations: ToolAnnotations;
  readonly execution: ToolExecutionPolicy;
  readonly cache?: ToolCachePolicy<z.output<I>>;
  /** Capabilities needed for this particular call. */
  readonly capabilities: (input: z.output<I>) => readonly CapabilityRequest[];
  readonly run: (
    input: z.output<I>,
    context: ToolRunContext,
  ) => Promise<ToolResult<O extends z.ZodObject ? z.output<O> : Record<string, unknown>>>;
}

/** Type-erased tool definition used by registries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<z.ZodObject<any>, z.ZodObject<any> | undefined>;

/** Identity helper that keeps full type inference for input/output at the definition site. */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject | undefined = undefined>(
  definition: ToolDefinition<I, O>,
): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,47}){1,2}$/;

export const NO_CAPABILITIES = (): readonly CapabilityRequest[] => [];
