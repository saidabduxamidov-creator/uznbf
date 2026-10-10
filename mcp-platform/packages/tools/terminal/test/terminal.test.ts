import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CancelledError, PermissionDeniedError, ValidationError, type ToolPackage } from "@lmp/core";
import { clearBinaryCache, createToolHarness, type ToolHarness } from "@lmp/toolkit";
import terminalPackage, { assertRunnable } from "../src/index.js";

describe("program safety", () => {
  it("refuses interpreters and script files on every platform", () => {
    for (const f of ["C:\\Windows\\System32\\cmd.exe", "C:\\x\\run.bat", "C:\\x\\a.CMD", "C:\\x\\s.ps1", "/bin/bash", "/usr/bin/env", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "/usr/bin/python3", "C:\\a\\b.vbs"]) {
      assert.throws(() => assertRunnable(f), PermissionDeniedError, f);
    }
    for (const f of ["C:\\Program Files\\Git\\cmd\\git.exe", "/usr/bin/ffmpeg", "C:\\tools\\exiftool.exe"]) assert.doesNotThrow(() => assertRunnable(f), f);
  });
});

describe("terminal tools", () => {
  let h: ToolHarness;
  let tool: string;
  let dir: string;
  before(async () => {
    clearBinaryCache();
    // Outside the repository: its package.json would make the script an ES module.
    dir = await mkdtemp(path.join(os.tmpdir(), "lmp-term-bin-"));
    // A tiny program that echoes its arguments, its stdin and its working directory as JSON.
    tool = path.join(dir, "echoargs");
    await writeFile(
      tool,
      `#!/usr/bin/env node\nconst input = require("fs").readFileSync(0, "utf8");\nif (process.argv[2] === "sleep") setTimeout(() => {}, 60000);\nelse { console.log(JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() })); process.stderr.write("warn"); process.exit(process.argv[2] === "fail" ? 3 : 0); }\n`,
    );
    await chmod(tool, 0o755);
    h = await createToolHarness(terminalPackage as ToolPackage<unknown>, { programs: { echoargs: { path: tool }, bash: { path: "/bin/bash" } } });
  });
  after(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("passes arguments literally, without a shell", async () => {
    const args = ["$(whoami)", "a b", "; rm -rf /", "*", "|", "Oʻzbek"];
    const r = await h.run("terminal.run", { program: "echoargs", args, stdin: "kirish", cwd: h.dir });
    const s = r.structured as { exitCode: number; stdout: string; stderr: string };
    assert.equal(s.exitCode, 0);
    assert.deepEqual(JSON.parse(s.stdout), { args, input: "kirish", cwd: h.dir });
    assert.equal(s.stderr, "warn");
  });

  it("reports non-zero exit codes as results", async () => {
    const r = await h.run("terminal.run", { program: "echoargs", args: ["fail"] });
    assert.equal((r.structured as { exitCode: number }).exitCode, 3);
  });

  it("refuses unlisted programs and interpreters even when configured", async () => {
    await assert.rejects(h.run("terminal.run", { program: "curl" }), ValidationError);
    await assert.rejects(h.run("terminal.run", { program: "bash", args: ["-c", "id"] }), PermissionDeniedError);
    const programs = await h.run("terminal.programs", {});
    assert.match((programs.content[0] as { text: string }).text, /bash: unavailable/);
  });

  it("times out and cancels by killing the process", async () => {
    const started = Date.now();
    await assert.rejects(h.run("terminal.run", { program: "echoargs", args: ["sleep"], timeoutSec: 1 }));
    assert.ok(Date.now() - started < 5000);
    const ac = new AbortController();
    const run = h.run("terminal.run", { program: "echoargs", args: ["sleep"] }, { signal: ac.signal });
    setTimeout(() => ac.abort(new CancelledError()), 200);
    await assert.rejects(run, CancelledError);
  });

  it("asks for terminal.exec per program", () => {
    assert.deepEqual((h.capabilities("terminal.run", { program: "Git", args: ["status"], cwd: "/p" }) as { kind: string; target: string }[]).map((c) => [c.kind, c.target]), [["terminal.exec", "git"], ["fs.read", "/p"]]);
  });
});
