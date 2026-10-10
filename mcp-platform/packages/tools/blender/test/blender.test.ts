import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NotFoundError, ValidationError, type ToolPackage } from "@lmp/core";
import { clearBinaryCache, createToolHarness, runProcess, type ToolHarness } from "@lmp/toolkit";
import blenderPackage, { INSPECT_SCRIPT, TEXT3D_SCRIPT, frameProgress } from "../src/index.js";

const hasPython = await runProcess("python3", ["--version"]).then(() => true, () => false);

describe("Blender scripts", () => {
  it("compile as Python", { skip: !hasPython && "python3 not installed" }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lmp-py-"));
    try {
      for (const [name, src] of [["text3d.py", TEXT3D_SCRIPT], ["inspect.py", INSPECT_SCRIPT]] as const) {
        await writeFile(path.join(dir, name), src);
        await runProcess("python3", ["-m", "py_compile", path.join(dir, name)]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never embed user values in code", () => {
    assert.match(TEXT3D_SCRIPT, /os\.environ\["LMP_BLENDER_PARAMS"\]/);
    assert.ok(!/\$\{/.test(TEXT3D_SCRIPT));
  });

  it("parses render progress", () => {
    assert.equal(frameProgress("Fra:51 Mem:12.00M | Time:00:01.20 | Rendering 1 / 64 samples", 1, 100), 0.5);
    assert.equal(frameProgress("Saved: 'x.png'", 1, 10), null);
  });
});

describe("Blender tools", () => {
  let dir: string;
  let h: ToolHarness;
  let log: string;
  before(async () => {
    clearBinaryCache();
    dir = await mkdtemp(path.join(os.tmpdir(), "lmp-blender-"));
    log = path.join(dir, "calls.jsonl");
    // Stand-in for blender: records how it was called and produces the files Blender would.
    const fake = path.join(dir, "blender");
    await writeFile(fake, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, params: process.env.LMP_BLENDER_PARAMS || null }) + "\\n");
const expr = a.includes("--python-expr") ? a[a.indexOf("--python-expr") + 1] : "";
if (expr.includes("LMP_INFO")) { console.log('LMP_INFO {"version":"4.2.0","scene":"Scene","engine":"CYCLES","frameStart":1,"frameEnd":48,"fps":24,"width":1920,"height":1080,"camera":"Camera","scenes":["Scene"],"objects":3}'); process.exit(0); }
if (expr.includes("LMP_BLENDER_PARAMS")) {
  const p = JSON.parse(process.env.LMP_BLENDER_PARAMS);
  for (let f = 1; f <= p.frames; f++) { console.log("Fra:" + f + " Mem:1M"); fs.writeFileSync(path.join(p.outputDir, "title_" + String(f).padStart(4, "0") + ".png"), ""); }
  console.log("LMP_DONE {}"); process.exit(0);
}
const out = a[a.indexOf("-o") + 1];
const frames = a.includes("-f") ? [Number(a[a.indexOf("-f") + 1])] : (() => { const s = Number(a[a.indexOf("-s") + 1] || 1), e = Number(a[a.indexOf("-e") + 1] || 3); return Array.from({ length: e - s + 1 }, (_, i) => s + i); })();
for (const f of frames) { console.log("Fra:" + f + " Mem:1M"); const file = out.replace("####", String(f).padStart(4, "0")) + ".png"; fs.writeFileSync(file, ""); console.log("Saved: '" + file + "'"); }
`);
    await chmod(fake, 0o755);
    h = await createToolHarness(blenderPackage as ToolPackage<unknown>, { blenderPath: fake });
  });
  after(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; params: string | null });

  it("renders a 3D title with parameters passed as data", async () => {
    const progress: number[] = [];
    const out = path.join(dir, "title");
    const r = await h.run("blender.title_3d", { text: `Salom "dunyo"'); import os #`, outputDir: out, color: "#ff0000", durationSec: 1, fps: 12 }, { onProgress: (p) => progress.push(p.progress) });
    const s = r.structured as { frames: number; firstFrame: string };
    assert.equal(s.frames, 12);
    assert.equal(s.firstFrame, path.join(out, "title_0001.png"));
    const call = (await calls()).at(-1);
    assert.ok(call?.args.includes("--background") && call.args.includes("--disable-autoexec") && call.args.includes("--factory-startup"));
    const params = JSON.parse(call?.params ?? "{}") as { text: string; color: number[]; frames: number };
    assert.equal(params.text, `Salom "dunyo"'); import os #`, "text travels as data, verbatim");
    assert.deepEqual(params.color, [1, 0, 0]);
    assert.equal(progress.at(-1), 12);
    await assert.rejects(h.run("blender.title_3d", { text: "x", font: path.join(dir, "calls.jsonl") }), ValidationError);
  });

  it("renders a frame range of a .blend file", async () => {
    const blend = path.join(dir, "scene.blend");
    await writeFile(blend, "BLENDER");
    const out = path.join(dir, "frames");
    const r = await h.run("blender.render", { path: blend, outputDir: out, start: 5, end: 7, engine: "cycles" });
    assert.deepEqual((await readdir(out)).sort(), ["scene_0005.png", "scene_0006.png", "scene_0007.png"]);
    assert.equal((r.structured as { files: string[] }).files.length, 3);
    const call = (await calls()).at(-1);
    assert.deepEqual(call?.args.slice(call.args.indexOf("-E"), call.args.indexOf("-E") + 2), ["-E", "CYCLES"]);
    await assert.rejects(h.run("blender.render", { path: blend, outputDir: out, start: 9, end: 2 }), ValidationError);
    await assert.rejects(h.run("blender.render", { path: path.join(dir, "missing.blend"), outputDir: out }), NotFoundError);
  });

  it("inspects a scene", async () => {
    const blend = path.join(dir, "scene.blend");
    const r = await h.run("blender.inspect", { path: blend });
    assert.equal((r.structured as { frameEnd: number }).frameEnd, 48);
  });
});
