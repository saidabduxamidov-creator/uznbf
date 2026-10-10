/**
 * Headless Chrome/Edge driven over the DevTools protocol on a pipe (--remote-debugging-pipe):
 * no debugging port is opened, so no other program can attach to the browser.
 *
 * Every launch uses a fresh temporary profile (no cookies, logins or history of the user's own
 * browser) and the browser's background services (updates, sync, telemetry, safe-browsing pings)
 * are disabled. All requests of every page, frame and worker pass through Fetch interception and
 * only the hosts the caller allowed are reached; everything else fails as blocked.
 *
 * Underneath that, the browser's own resolver maps every host outside the allowed sites to
 * "not found", so the browser's internal services (search preconnect, push messaging, update
 * checks) cannot reach the network either. This only holds for direct connections, which is why
 * the system proxy is bypassed unless the user opts in.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { CancelledError, ExternalProcessError, NotFoundError, TimeoutError } from "@lmp/core";
import { killTree, locateBinary } from "@lmp/toolkit";

type Json = Record<string, unknown>;

interface Pending {
  resolve(value: Json): void;
  reject(error: Error): void;
}

/** Browser flags. Exported so tests and the build guard can verify the privacy posture. */
export const BROWSER_FLAGS = [
  "--headless=new",
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-extensions",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-client-side-phishing-detection",
  "--disable-breakpad",
  "--metrics-recording-only",
  "--no-pings",
  "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions",
  "--mute-audio",
  "--hide-scrollbars",
  "--disable-gpu",
  "--password-store=basic",
  "--use-mock-keychain",
];

export async function locateBrowser(configured: string | undefined): Promise<string> {
  const configKey = "tools.settings.browser.browserPath";
  if (configured) return locateBinary(path.basename(configured), { configured, configKey });
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    candidates.push(
      path.win32.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      ...(local ? [path.win32.join(local, "Google", "Chrome", "Application", "chrome.exe")] : []),
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  for (const c of candidates) {
    const found = await locateBinary(path.basename(c), { configured: c, configKey }).catch(() => null);
    if (found) return found;
  }
  for (const name of ["msedge", "chrome", "google-chrome", "chromium"]) {
    const found = await locateBinary(name, { configKey }).catch(() => null);
    if (found) return found;
  }
  throw new NotFoundError(`Microsoft Edge or Google Chrome was not found. Install one, or set "${configKey}".`);
}

/** "www.kun.uz" → "kun.uz"; "bbc.co.uk" stays; IP addresses and single labels stay as they are. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const second = labels[labels.length - 2] ?? "";
  const take = second.length <= 3 && ["co", "com", "net", "org", "gov", "edu", "ac"].includes(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

export function hostAllowed(url: string, allowedSites: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "about:") return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return allowedSites.has(siteOf(parsed.hostname));
}

export interface BrowserSession {
  /** Sends a command to the page. */
  send(method: string, params?: Json): Promise<Json>;
  /** Resolves on the next page event with this name. */
  waitFor(event: string, timeoutMs: number): Promise<Json>;
  readonly blocked: readonly string[];
  close(): Promise<void>;
}

export interface LaunchOptions {
  readonly executable: string;
  readonly allowedSites: ReadonlySet<string>;
  readonly width: number;
  readonly height: number;
  readonly signal: AbortSignal;
  /** Use the system proxy (internal browser traffic is then filtered only by the proxy). */
  readonly useSystemProxy?: boolean;
}

/** Resolver rules that leave only the allowed sites (and their subdomains) resolvable. */
export function resolverRules(allowedSites: ReadonlySet<string>): string {
  const excludes = [...allowedSites].filter((s) => /^[a-z0-9.-]+$/i.test(s)).flatMap((s) => [`EXCLUDE ${s}`, `EXCLUDE *.${s}`]);
  return ["MAP * ~NOTFOUND", ...excludes].join(", ");
}

/** Launches a browser and opens one locked-down page. Always call close(). */
export async function openBrowser(options: LaunchOptions): Promise<BrowserSession> {
  const profile = await mkdtemp(path.join(os.tmpdir(), "lmp-browser-"));
  const noSandbox = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  let child: ChildProcess;
  try {
    const network = [`--host-resolver-rules=${resolverRules(options.allowedSites)}`, ...(options.useSystemProxy ? [] : ["--no-proxy-server"])];
    child = spawn(options.executable, [...BROWSER_FLAGS, ...network, ...noSandbox, `--user-data-dir=${profile}`, `--window-size=${options.width},${options.height}`, "about:blank"], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
    });
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw new ExternalProcessError(`The browser could not be started: ${(error as Error).message}`, { cause: error });
  }
  const toBrowser = child.stdio[3] as Writable;
  const fromBrowser = child.stdio[4] as Readable;
  let stderrTail = "";
  child.stderr?.on("data", (c: Buffer) => (stderrTail = (stderrTail + c.toString("utf8")).slice(-2000)));

  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(method: string, params: Json, sessionId: string | undefined) => void>();
  let closedError: Error | null = null;
  let buffer = Buffer.alloc(0);

  const failAll = (error: Error) => {
    closedError ??= error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  fromBrowser.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end: number;
    while ((end = buffer.indexOf(0)) >= 0) {
      const raw = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      let msg: Json;
      try {
        msg = JSON.parse(raw) as Json;
      } catch {
        continue;
      }
      if (typeof msg["id"] === "number") {
        const p = pending.get(msg["id"]);
        pending.delete(msg["id"]);
        const err = msg["error"] as { message?: string } | undefined;
        if (err) p?.reject(new ExternalProcessError(`Browser: ${err.message ?? "command failed"}`));
        else p?.resolve((msg["result"] ?? {}) as Json);
      } else if (typeof msg["method"] === "string") {
        for (const l of listeners) l(msg["method"], (msg["params"] ?? {}) as Json, msg["sessionId"] as string | undefined);
      }
    }
  });
  child.on("exit", () => failAll(new ExternalProcessError(`The browser exited unexpectedly. ${stderrTail.split("\n").slice(-3).join(" ")}`.trim())));
  child.on("error", (e) => failAll(new ExternalProcessError(`The browser could not be started: ${e.message}`)));
  toBrowser.on("error", () => undefined);

  const send = (method: string, params: Json = {}, sessionId?: string): Promise<Json> => {
    if (closedError) return Promise.reject(closedError);
    const id = nextId++;
    return new Promise<Json>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      toBrowser.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  };

  const blocked: string[] = [];
  let pageSession: string | undefined;
  let pageTarget: string | undefined;
  const onAbort = () => failAll(options.signal.reason instanceof Error ? options.signal.reason : new CancelledError());
  options.signal.addEventListener("abort", onAbort, { once: true });

  const close = async () => {
    options.signal.removeEventListener("abort", onAbort);
    failAll(new CancelledError("The browser was closed."));
    await Promise.race([
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        try {
          toBrowser.write(JSON.stringify({ id: nextId++, method: "Browser.close", params: {} }) + "\0");
        } catch {
          /* pipe already closed */
        }
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    killTree(child);
    // The profile can stay locked for a moment after exit on Windows.
    for (let i = 0; i < 10; i++) {
      try {
        await rm(profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  try {
    // Every new target (our page, frames in other processes, workers, popups) is attached paused,
    // gets request interception, and only then runs. Popups are closed.
    listeners.add((method, params, sessionId) => {
      if (method === "Target.attachedToTarget") {
        const info = params["targetInfo"] as { type: string; targetId: string };
        const child = params["sessionId"] as string;
        // Pages attached at browser level other than ours: the startup tab and any popup.
        const isPopup = info.type === "page" && sessionId === undefined && info.targetId !== pageTarget;
        if (isPopup) {
          void send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
          return;
        }
        if (sessionId === undefined && info.targetId === pageTarget) return; // our page is set up below
        void (async () => {
          await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, child).catch(() => undefined);
          await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child).catch(() => undefined);
          await send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => undefined);
        })();
      } else if (method === "Fetch.requestPaused" && sessionId) {
        const request = params["request"] as { url: string };
        const requestId = params["requestId"] as string;
        if (hostAllowed(request.url, options.allowedSites)) {
          void send("Fetch.continueRequest", { requestId }, sessionId).catch(() => undefined);
        } else {
          if (blocked.length < 200) blocked.push(request.url.slice(0, 300));
          void send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => undefined);
        }
      }
    });
    await send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
    await send("Target.setDiscoverTargets", { discover: false }).catch(() => undefined);
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    pageTarget = targetId;
    const attached = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    pageSession = attached.sessionId;
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, pageSession);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSession);
    await send("Page.enable", {}, pageSession);
    await send("Runtime.enable", {}, pageSession);
    await send("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false }, pageSession);
    // Browser-wide: service/shared workers and popups are caught too, paused until intercepted.
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (error) {
    await close();
    throw error;
  }

  const session = pageSession;
  return {
    blocked,
    send: (method, params) => send(method, params, session),
    waitFor: (event, timeoutMs) =>
      new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new TimeoutError(`The page did not finish loading within ${Math.round(timeoutMs / 1000)} s.`));
        }, timeoutMs);
        const listener = (method: string, params: Json, sessionId: string | undefined) => {
          if (method === event && sessionId === session) {
            clearTimeout(timer);
            listeners.delete(listener);
            resolve(params);
          }
        };
        listeners.add(listener);
      }),
    close,
  };
}
