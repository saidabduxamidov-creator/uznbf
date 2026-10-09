import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { InternalError, PermissionDeniedError } from "@lmp/core";
import { Container, RotatingFileSink, StructuredLogger, createToken, resolvePlatformPaths, sanitizeForLog } from "../src/index.js";
import { tempDir, testEvents } from "./helpers.js";

describe("platform paths", () => {
  it("uses APPDATA/LOCALAPPDATA on Windows", () => {
    const p = resolvePlatformPaths({ platform: "win32", homeDir: "C:\\Users\\a", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } });
    assert.equal(p.configDir, "C:\\Users\\a\\AppData\\Roaming\\LocalMcpPlatform");
    assert.equal(p.dataDir, "C:\\Users\\a\\AppData\\Local\\LocalMcpPlatform");
    assert.equal(p.logsDir, "C:\\Users\\a\\AppData\\Local\\LocalMcpPlatform\\Logs");
  });
  it("follows macOS and XDG conventions", () => {
    const mac = resolvePlatformPaths({ platform: "darwin", homeDir: "/Users/a", env: {} });
    assert.equal(mac.cacheDir, "/Users/a/Library/Caches/LocalMcpPlatform");
    const linux = resolvePlatformPaths({ platform: "linux", homeDir: "/home/a", env: { XDG_CONFIG_HOME: "/cfg" } });
    assert.equal(linux.configDir, "/cfg/localmcpplatform");
  });
  it("puts everything under an override root", () => {
    const p = resolvePlatformPaths({ platform: "win32", homeDir: "x", env: {} }, "/tmp/root");
    assert.equal(p.dataDir, path.resolve("/tmp/root", "data"));
  });
});

describe("container", () => {
  it("resolves singletons lazily and disposes in reverse order", async () => {
    const order: string[] = [];
    const A = createToken<{ name: string }>("A");
    const B = createToken<{ a: { name: string } }>("B");
    const c = new Container();
    c.register(A, () => ({ name: "a" }), () => { order.push("A"); });
    c.register(B, (k) => ({ a: k.resolve(A) }), () => { order.push("B"); });
    const b = c.resolve(B);
    assert.equal(b.a, c.resolve(A));
    assert.deepEqual(await c.dispose(), []);
    assert.deepEqual(order, ["B", "A"]);
    assert.throws(() => c.resolve(A), InternalError);
  });
  it("detects cycles and duplicates", () => {
    const X = createToken<unknown>("X");
    const Y = createToken<unknown>("Y");
    const c = new Container();
    c.register(X, (k) => k.resolve(Y));
    c.register(Y, (k) => k.resolve(X));
    assert.throws(() => c.resolve(X), /cycle/);
    assert.throws(() => c.register(X, () => 1), /Duplicate/);
  });
  it("collects dispose errors instead of stopping", async () => {
    const T1 = createToken<object>("T1");
    const T2 = createToken<object>("T2");
    const c = new Container();
    let disposed = false;
    c.register(T1, () => ({ dispose: () => { disposed = true; } }));
    c.register(T2, () => ({ dispose: () => { throw new Error("boom"); } }));
    c.resolve(T1);
    c.resolve(T2);
    const errors = await c.dispose();
    assert.equal(errors.length, 1);
    assert.ok(disposed);
  });
});

describe("event bus", () => {
  it("isolates failing listeners and unsubscribes", () => {
    const { bus, errors } = testEvents();
    const seen: string[] = [];
    bus.on("config.reloaded", () => { throw new Error("listener bug"); });
    const off = bus.on("config.reloaded", (e) => seen.push(e.changed.join(",")));
    bus.once("config.reloaded", () => seen.push("once"));
    bus.emit("config.reloaded", { changed: ["logging"] });
    bus.emit("config.reloaded", { changed: ["cache"] });
    off();
    bus.emit("config.reloaded", { changed: ["queue"] });
    assert.deepEqual(seen, ["logging", "once", "cache"]);
    assert.equal(errors.length, 3);
    assert.equal(bus.listenerCount("config.reloaded"), 1);
  });
});

describe("logging", () => {
  it("redacts secrets, truncates and survives cycles", () => {
    const value: Record<string, unknown> = { apiKey: "sk-123", nested: { Authorization: "Bearer x", ok: 1 }, long: "x".repeat(5000) };
    value["self"] = value;
    const out = sanitizeForLog(value) as Record<string, unknown>;
    assert.equal(out["apiKey"], "[REDACTED]");
    assert.deepEqual(out["nested"], { Authorization: "[REDACTED]", ok: 1 });
    assert.match(out["long"] as string, /…\(\+1000\)$/);
    assert.equal(out["self"], "[Circular]");
    const err = sanitizeForLog(new PermissionDeniedError("no", { details: { token: "t" } })) as Record<string, unknown>;
    assert.equal(err["code"], "PERMISSION_DENIED");
    assert.deepEqual(err["details"], { token: "[REDACTED]" });
  });

  it("writes JSON lines, filters levels and rotates by size", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const sink = new RotatingFileSink({ directory: dir, fileName: "server.log", maxFileBytes: 2048, maxFiles: 2 });
      const logger = new StructuredLogger(sink, "info").child({ component: "test" });
      logger.debug("hidden");
      for (let i = 0; i < 60; i++) logger.info("line", { i, pad: "y".repeat(40) });
      await sink.close();
      const files = (await readdir(dir)).sort();
      assert.deepEqual(files, ["server.log", "server.log.1", "server.log.2"]);
      const last = (await readFile(path.join(dir, "server.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(last.at(-1)?.["i"], 59);
      assert.equal(last.at(-1)?.["component"], "test");
      assert.ok(last.every((r) => r["level"] === "info"));
    } finally {
      await cleanup();
    }
  });
});
