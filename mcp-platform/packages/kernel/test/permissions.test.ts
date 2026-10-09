import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PermissionDeniedError, ValidationError } from "@lmp/core";
import { PolicyPermissionGate, assertSafePathSyntax, canonicalizePath, isWithin, parseConfig, wildcardMatch, type AuditSink } from "../src/index.js";
import { tempDir, testEvents, testLogger } from "./helpers.js";

describe("path rules", () => {
  it("rejects dangerous Windows path forms", () => {
    const win = { platform: "win32" as const };
    for (const bad of ["\\\\?\\C:\\x", "\\\\.\\PhysicalDrive0", "\\\\server\\share\\f", "C:\\a\\file.txt:secret", "C:\\a\\CON", "C:\\a\\nul.txt", "C:\\a\u0000b"]) {
      assert.throws(() => assertSafePathSyntax(bad, win), (e: unknown) => e instanceof PermissionDeniedError || e instanceof ValidationError, bad);
    }
    assert.doesNotThrow(() => assertSafePathSyntax("C:\\Users\\a\\Videos\\clip.mp4", win));
    assert.doesNotThrow(() => assertSafePathSyntax("C:/Users/a/console.log", win));
  });

  it("containment is separator-safe and case-insensitive on Windows", () => {
    assert.ok(isWithin("C:\\Videos", "c:\\videos\\a\\b.mp4", "win32"));
    assert.ok(!isWithin("C:\\Videos", "C:\\Videos2\\a.mp4", "win32"));
    assert.ok(!isWithin("C:\\Videos", "C:\\Videos\\..\\Secret", "win32"));
    assert.ok(!isWithin("/data", "/Data/x", "linux"));
  });

  it("canonicalizes non-existing paths through their deepest existing ancestor", async () => {
    const real = async (p: string) => {
      if (p === "C:\\Link") return "D:\\Target";
      if (p === "C:\\" || p === "D:\\Target") return p;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    assert.equal(await canonicalizePath("C:\\Link\\new\\file.txt", { platform: "win32" }, real), "D:\\Target\\new\\file.txt");
    await assert.rejects(canonicalizePath("relative\\x", { platform: "win32" }, real), ValidationError);
  });

  it("wildcards", () => {
    assert.ok(wildcardMatch("*.example.com", "api.example.com"));
    assert.ok(!wildcardMatch("*.example.com", "example.org"));
    assert.ok(wildcardMatch("ffmpeg*", "FFMPEG.exe"));
  });
});

describe("permission gate", () => {
  async function setup(policy: unknown) {
    const records: Parameters<AuditSink["record"]>[0][] = [];
    const { bus } = testEvents();
    const config = parseConfig({ permissions: policy }, "test");
    const gate = new PolicyPermissionGate(config.permissions, process.platform, { record: (e) => records.push(e) }, bus, testLogger().logger, "config.json");
    return { gate, records };
  }
  const ctx = { tool: "fs.read_file", requestId: "r1", client: "claude" };

  it("allows inside configured roots and blocks symlink escapes", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const allowed = path.join(dir, "allowed");
      const secret = path.join(dir, "secret");
      await mkdir(allowed);
      await mkdir(secret);
      await writeFile(path.join(secret, "key.txt"), "x");
      await symlink(secret, path.join(allowed, "escape"), "dir");
      const { gate, records } = await setup({ rules: [{ capability: "fs.read", effect: "allow", targets: [allowed] }] });
      const ok = await gate.authorize([{ kind: "fs.read", target: path.join(allowed, "clip.mp4") }], ctx);
      assert.equal(ok[0]?.effect, "allow");
      await assert.rejects(gate.authorize([{ kind: "fs.read", target: path.join(allowed, "escape", "key.txt") }], ctx), PermissionDeniedError);
      assert.deepEqual(records.map((r) => r.effect), ["allow", "deny"]);
      assert.equal(records[1]?.target, path.join(secret, "key.txt"), "audited with the canonical target");
    } finally {
      await cleanup();
    }
  });

  it("first matching rule wins; tool-scoped rules; defaults deny terminal", async () => {
    const { gate } = await setup({
      rules: [
        { capability: "network", effect: "deny", targets: ["evil.example.com"] },
        { capability: "network", effect: "allow", targets: ["*.example.com"], tools: ["browser.open"] },
      ],
    });
    await assert.rejects(gate.authorize([{ kind: "network", target: "evil.example.com" }], { ...ctx, tool: "browser.open" }), PermissionDeniedError);
    await gate.authorize([{ kind: "network", target: "docs.example.com" }], { ...ctx, tool: "browser.open" });
    await assert.rejects(gate.authorize([{ kind: "network", target: "docs.example.com" }], { ...ctx, tool: "other.tool" }), PermissionDeniedError);
    await assert.rejects(gate.authorize([{ kind: "terminal.exec", target: "cmd.exe" }], ctx), /Blocked by the local permission policy/);
  });

  it("ask uses consent, remembers approvals, and denies when the client cannot ask", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const { gate } = await setup({});
      const target = path.join(dir, "a.txt");
      await assert.rejects(gate.authorize([{ kind: "fs.read", target }], ctx), /Approval is required/);
      let asked = 0;
      const consent = async () => { asked++; return true; };
      await gate.authorize([{ kind: "fs.read", target }], { ...ctx, consent });
      const again = await gate.authorize([{ kind: "fs.read", target }], { ...ctx, consent });
      assert.equal(asked, 1);
      assert.match(again[0]?.rule ?? "", /remembered/);
      await assert.rejects(gate.authorize([{ kind: "fs.write", target }], { ...ctx, consent: async () => false }), PermissionDeniedError);
      await gate.update(parseConfig({}, "t").permissions);
      await assert.rejects(gate.authorize([{ kind: "fs.read", target }], ctx), PermissionDeniedError, "approvals reset on policy change");
    } finally {
      await cleanup();
    }
  });
});
