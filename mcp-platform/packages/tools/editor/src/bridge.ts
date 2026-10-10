/**
 * Client for the panel bridge agents (protocol 1: newline-delimited JSON over 127.0.0.1 TCP).
 *
 * Discovery files (<platform data>/bridges/<host>.json) hold port and token. Connections are
 * pooled per host, authenticated with the token, and re-established transparently when a panel
 * restarts. Cancellation sends a cancel message; the panel finishes the current host step but its
 * result is discarded.
 */
import { readFile, readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  CancelledError,
  ExternalProcessError,
  HostUnavailableError,
  InternalError,
  PlatformError,
  TimeoutError,
  ValidationError,
} from "@lmp/core";

export const BRIDGE_PROTOCOL = 1;

/** The call was never written to the socket, so retrying cannot duplicate an edit. */
export class NotSentError extends HostUnavailableError {}
export const HOST_IDS = ["premiere", "aftereffects", "resolve"] as const;
export type HostId = (typeof HOST_IDS)[number];

export const HOST_NAMES: Readonly<Record<HostId, string>> = {
  premiere: "Premiere Pro",
  aftereffects: "After Effects",
  resolve: "DaVinci Resolve",
};

const MAX_LINE = 64 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 3000;

export interface Discovery {
  readonly protocol: number;
  readonly host: HostId;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly panelVersion?: string;
  readonly startedAt?: number;
}

export interface Welcome {
  readonly host: HostId;
  readonly panelVersion: string;
  readonly methods: readonly string[];
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: PlatformError) => void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readDiscovery(dir: string, host: HostId): Promise<Discovery | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, `${host}.json`), "utf8");
  } catch {
    return undefined;
  }
  try {
    const d = JSON.parse(raw) as Partial<Discovery>;
    if (d.protocol !== BRIDGE_PROTOCOL || d.host !== host || typeof d.port !== "number" || typeof d.token !== "string" || typeof d.pid !== "number") return undefined;
    if (!isAlive(d.pid)) return undefined;
    return d as Discovery;
  } catch {
    return undefined;
  }
}

/** One authenticated connection to one panel. */
export class BridgeConnection {
  private socket: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError: PlatformError | undefined;
  welcome: Welcome | undefined;

  constructor(readonly discovery: Discovery) {}

  get alive(): boolean {
    return !!this.socket && !this.socket.destroyed && !this.closedError;
  }

  async open(): Promise<Welcome> {
    const { port, token, host } = this.discovery;
    const socket = net.connect({ host: "127.0.0.1", port });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    return new Promise<Welcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HostUnavailableError(`${HOST_NAMES[host]} panel did not answer.`));
      }, CONNECT_TIMEOUT_MS);
      let greeted = false;
      socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", token, client: "lmp-server", protocol: BRIDGE_PROTOCOL })}\n`));
      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        if (this.buffer.length > MAX_LINE) {
          socket.destroy(new Error("message too large"));
          return;
        }
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (!greeted) {
            if (msg["type"] === "welcome") {
              greeted = true;
              clearTimeout(timer);
              this.welcome = { host, panelVersion: String(msg["panelVersion"] ?? ""), methods: (msg["methods"] as string[]) ?? [] };
              resolve(this.welcome);
            } else {
              clearTimeout(timer);
              socket.destroy();
              reject(new HostUnavailableError(`${HOST_NAMES[host]} panel refused the connection (${String(msg["error"] ?? "unexpected reply")}).`));
            }
            continue;
          }
          this.onMessage(msg);
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        if (!greeted) reject(new HostUnavailableError(`Cannot reach the ${HOST_NAMES[host]} panel: ${error.message}`, { cause: error }));
      });
      socket.on("close", () => {
        clearTimeout(timer);
        this.fail(new HostUnavailableError(`The ${HOST_NAMES[host]} panel connection closed. Keep the panel open in ${HOST_NAMES[host]}.`));
      });
    });
  }

  call(method: string, args: unknown, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<unknown> {
    if (!this.alive || !this.socket) return Promise.reject(new NotSentError(this.closedError?.message ?? "Panel connection is not open."));
    if (options.signal?.aborted) return Promise.reject(new CancelledError());
    const id = this.nextId++;
    const socket = this.socket;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        cleanup();
        socket.write(`${JSON.stringify({ type: "cancel", id })}\n`);
        reject(new TimeoutError(`${HOST_NAMES[this.discovery.host]} did not finish "${method}" in time.`));
      }, options.timeoutMs + 2000);
      const onAbort = () => {
        cleanup();
        socket.write(`${JSON.stringify({ type: "cancel", id })}\n`);
        reject(new CancelledError());
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      socket.write(`${JSON.stringify({ type: "call", id, method, args, timeoutMs: options.timeoutMs })}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (msg["type"] !== "result" || typeof msg["id"] !== "number") return;
    const pending = this.pending.get(msg["id"]);
    if (!pending) return;
    if (msg["ok"] === true) {
      pending.resolve(msg["data"]);
      return;
    }
    const message = String(msg["error"] ?? "The editing application reported an error.");
    const code = msg["code"];
    pending.reject(
      code === "CANCELLED" ? new CancelledError(message)
        : code === "TIMEOUT" ? new TimeoutError(message)
          : code === "NOT_ALLOWED" ? new InternalError(`Bridge refused the call: ${message}`)
            : new ExternalProcessError(message),
    );
  }

  private fail(error: PlatformError): void {
    this.closedError ??= error;
    for (const p of [...this.pending.values()]) p.reject(error);
    this.pending.clear();
  }
}

/** Pool of panel connections, one per host, re-created when a panel restarts. */
export class BridgeClient {
  private readonly connections = new Map<HostId, BridgeConnection>();
  private readonly opening = new Map<HostId, Promise<BridgeConnection>>();

  constructor(private readonly bridgesDir: string) {}

  async available(): Promise<Discovery[]> {
    const names = await readdir(this.bridgesDir).catch(() => [] as string[]);
    const out: Discovery[] = [];
    for (const host of HOST_IDS) {
      if (!names.includes(`${host}.json`)) continue;
      const d = await readDiscovery(this.bridgesDir, host);
      if (d) out.push(d);
    }
    return out;
  }

  /** Picks the requested host, or the only running one. */
  async resolveHost(requested: HostId | undefined): Promise<HostId> {
    if (requested) return requested;
    const running = (await this.available()).map((d) => d.host);
    if (running.length === 1 && running[0]) return running[0];
    if (running.length === 0) {
      throw new HostUnavailableError("No editing application is connected. Open Premiere Pro, After Effects or DaVinci Resolve and its panel (with the MCP option enabled in Settings).");
    }
    throw new ValidationError(`Several editors are open (${running.map((h) => HOST_NAMES[h]).join(", ")}); specify "host".`);
  }

  async connection(host: HostId): Promise<BridgeConnection> {
    const existing = this.connections.get(host);
    if (existing?.alive) return existing;
    let pending = this.opening.get(host);
    if (!pending) {
      pending = (async () => {
        const discovery = await readDiscovery(this.bridgesDir, host);
        if (!discovery) {
          throw new HostUnavailableError(`${HOST_NAMES[host]} is not connected. Open ${HOST_NAMES[host]} with the panel and keep it open.`);
        }
        const conn = new BridgeConnection(discovery);
        await conn.open();
        this.connections.set(host, conn);
        return conn;
      })().finally(() => this.opening.delete(host));
      this.opening.set(host, pending);
    }
    return pending;
  }

  async call<T>(host: HostId, method: string, args: unknown, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<T> {
    let conn = await this.connection(host);
    try {
      return (await conn.call(method, args, options)) as T;
    } catch (error) {
      // A panel reload drops the socket. Retry once on a fresh connection, but only when the call was
      // never sent: an edit that may already have run is never repeated.
      if (error instanceof NotSentError) {
        this.connections.delete(host);
        conn = await this.connection(host);
        return (await conn.call(method, args, options)) as T;
      }
      throw error;
    }
  }

  close(): void {
    for (const c of this.connections.values()) c.close();
    this.connections.clear();
  }
}
