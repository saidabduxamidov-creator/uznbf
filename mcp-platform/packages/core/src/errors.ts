/**
 * Error taxonomy. Every failure that crosses a module boundary is a PlatformError with a stable
 * machine code. `message` is safe to show to the AI client and the user; `details` stay in logs.
 */
export type ErrorCode =
  | "VALIDATION"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "HOST_UNAVAILABLE"
  | "EXTERNAL_PROCESS"
  | "TIMEOUT"
  | "CANCELLED"
  | "UNSUPPORTED"
  | "RESOURCE_EXHAUSTED"
  | "INTERNAL";

export interface PlatformErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** True when retrying the same call may succeed (transient conditions). */
  readonly retryable?: boolean;
}

export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: PlatformErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class ValidationError extends PlatformError {
  readonly issues: readonly ValidationIssue[];
  constructor(message: string, issues: readonly ValidationIssue[] = [], options: PlatformErrorOptions = {}) {
    super("VALIDATION", message, { ...options, details: { ...(options.details ?? {}), issues } });
    this.issues = Object.freeze([...issues]);
  }
}

export class PermissionDeniedError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("PERMISSION_DENIED", message, options);
  }
}

export class NotFoundError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("NOT_FOUND", message, options);
  }
}

export class ConflictError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("CONFLICT", message, options);
  }
}

export class HostUnavailableError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("HOST_UNAVAILABLE", message, { retryable: true, ...options });
  }
}

export class ExternalProcessError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("EXTERNAL_PROCESS", message, options);
  }
}

export class TimeoutError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("TIMEOUT", message, { retryable: true, ...options });
  }
}

export class CancelledError extends PlatformError {
  constructor(message = "The operation was cancelled.", options: PlatformErrorOptions = {}) {
    super("CANCELLED", message, options);
  }
}

export class UnsupportedError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("UNSUPPORTED", message, options);
  }
}

export class ResourceExhaustedError extends PlatformError {
  constructor(message: string, options: PlatformErrorOptions = {}) {
    super("RESOURCE_EXHAUSTED", message, { retryable: true, ...options });
  }
}

export class InternalError extends PlatformError {
  constructor(message = "Internal error.", options: PlatformErrorOptions = {}) {
    super("INTERNAL", message, options);
  }
}

/** Normalizes anything thrown into a PlatformError without leaking internal messages. */
export function toPlatformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  if (isAbortError(error)) return new CancelledError(undefined, { cause: error });
  return new InternalError("Internal error.", { cause: error });
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: unknown }).name === "AbortError" || (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

/** Throws CancelledError when the signal is aborted; call at safe points inside long work. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof PlatformError) throw reason;
  throw new CancelledError(undefined, { cause: reason });
}
