import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import vm from "node:vm";
import { ConflictError, UnsupportedError, ValidationError, type ToolPackage } from "@lmp/core";
import { clearBinaryCache, createToolHarness, type ToolHarness } from "@lmp/toolkit";
import photoshopPackage, { ES_OPERATIONS, PS_HOST, esJson } from "../src/index.js";

/**
 * Minimal Photoshop DOM: enough of the scripting API for the operations to run for real in a VM,
 * so the ExtendScript logic itself is tested, not just the plumbing. Documents are JSON files:
 * { width, height, layers: [{ name, kind, text?, visible?, layers? }] }.
 */
const MOCK_DOM = String.raw`
const fs = require("fs");
function UnitValue(v, u) { return { value: v, as: () => v }; }
function File(p) { this.fsName = p; this.exists = fs.existsSync(p); }
function PNGSaveOptions() {} function JPEGSaveOptions() {}
const LayerKind = { TEXT: "LayerKind.TEXT", NORMAL: "LayerKind.NORMAL" };
function wrapLayers(list) { return list.map((l) => { const o = { name: l.name, visible: l.visible !== false, typename: l.layers ? "LayerSet" : "ArtLayer", kind: l.kind === "text" ? LayerKind.TEXT : LayerKind.NORMAL }; if (l.layers) o.layers = wrapLayers(l.layers); if (l.kind === "text") o.textItem = { contents: l.text }; return o; }); }
function plain(list) { return list.map((l) => ({ name: l.name, visible: l.visible, ...(l.layers ? { layers: plain(l.layers) } : {}), ...(l.textItem ? { text: l.textItem.contents } : {}) })); }
function Doc(src, data) {
  this.name = src.split("/").pop(); this.fullName = { fsName: src }; this.resolution = 72;
  let w = data.width, h = data.height;
  this.width = { as: () => w }; this.height = { as: () => h };
  this.layers = wrapLayers(data.layers); this.mode = "RGB";
  this.duplicate = () => { const d = new Doc(src, { width: w, height: h, layers: [] }); d.layers = this.layers; return d; };
  this.resizeImage = (nw, nh) => { w = nw.value; h = nh.value; };
  this.flatten = () => {}; this.changeMode = () => {};
  this.saveAs = (f, opts) => fs.writeFileSync(f.fsName, JSON.stringify({ width: w, height: h, type: opts instanceof PNGSaveOptions ? "png" : "jpg", quality: opts.quality, layers: plain(this.layers) }));
  this.close = () => { state.closed++; };
}
const state = { closed: 0, actions: [] };
const app = {
  version: "25.0.0", documents: [], displayDialogs: 0,
  open: (f) => { if (/\.(psd|png|jpg)$/i.test(f.fsName) === false) throw new Error("bad"); const d = new Doc(f.fsName, JSON.parse(fs.readFileSync(f.fsName, "utf8"))); app.activeDocument = d; return d; },
  doAction: (a, s) => state.actions.push(s + "/" + a),
};
const ctx = { app, File, UnitValue, PNGSaveOptions, JPEGSaveOptions, LayerKind, DialogModes: { NO: 0 }, SaveOptions: { DONOTSAVECHANGES: 2 }, DocumentMode: { RGB: "RGB" }, ChangeMode: { RGB: 1 }, Extension: { LOWERCASE: 1 }, ResampleMethod: { BICUBICSHARPER: 1 } };
`;

const hostScript = (dir: string) => `#!/usr/bin/env node
const vm = require("vm");
const args = process.argv.slice(2);
const host = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
if (!host.includes("Photoshop.Application") || !host.includes("DoJavaScript")) process.exit(9);
if (require("fs").existsSync(${JSON.stringify(path.join(dir, "not-installed"))})) { process.stderr.write("Photoshop is not installed"); process.exit(5); }
const req = JSON.parse(Buffer.from(require("fs").readFileSync(0, "utf8").trim(), "base64").toString("utf8"));
${MOCK_DOM}
try {
  const context = vm.createContext({ ...ctx, arguments: [req.params] });
  const result = vm.runInContext(req.code, context);
  require("fs").appendFileSync(${JSON.stringify(path.join(dir, "state.jsonl"))}, JSON.stringify(state) + "\\n");
  process.stdout.write(Buffer.from(String(result)).toString("base64"));
} catch (e) { process.stderr.write("Photoshop: " + e.message); process.exit(6); }
`;

describe("ExtendScript plumbing", () => {
  it("encodes parameters as inert data", () => {
    const evil = { t: `"); app.quit(); ("\u2028x` };
    const json = esJson(evil);
    assert.ok(!json.includes("\u2028"));
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(`(${json})`))), evil, "evaluates back to the same data");
  });

  it("host script only drives Photoshop's COM object", () => {
    assert.match(PS_HOST, /New-Object -ComObject Photoshop\.Application/);
    assert.ok(!/Invoke-Expression|DownloadString|Start-Process/i.test(PS_HOST));
    for (const code of Object.values(ES_OPERATIONS)) assert.match(code, /app\.displayDialogs = DialogModes\.NO/);
  });
});

describe("Photoshop tools", () => {
  let dir: string;
  let h: ToolHarness;
  let template: string;
  before(async () => {
    clearBinaryCache();
    dir = await mkdtemp(path.join(os.tmpdir(), "lmp-ps-"));
    const fake = path.join(dir, "powershell");
    await writeFile(fake, hostScript(dir));
    await chmod(fake, 0o755);
    template = path.join(dir, "thumb.psd");
    await writeFile(template, JSON.stringify({
      width: 1920,
      height: 1080,
      layers: [
        { name: "Title", kind: "text", text: "OLD" },
        { name: "Badges", layers: [{ name: "NEW badge", kind: "pixel", visible: false }, { name: "Price", kind: "text", text: "$0" }] },
        { name: "Photo", kind: "pixel" },
      ],
    }));
    h = await createToolHarness(photoshopPackage as ToolPackage<unknown>, { powershellPath: fake });
  });
  after(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists layers including nested groups", async () => {
    const r = await h.run("photoshop.layers", { path: template });
    const layers = (r.structured as { layers: { path: string; kind: string; text: string | null }[] }).layers;
    assert.deepEqual(layers.map((l) => l.path), ["Title", "Badges", "Badges/NEW badge", "Badges/Price", "Photo"]);
    assert.equal(layers.find((l) => l.path === "Badges/Price")?.text, "$0");
  });

  it("fills a thumbnail template and exports without touching the template", async () => {
    const out = path.join(dir, "out", "thumb.png");
    const title = `Toʻy "2025"\nEng zoʻr kunlar \\ ${"\u2028"}`;
    const r = await h.run("photoshop.fill_template", { template, output: out, texts: { Title: title, Price: "99 000 soʻm", Missing: "x" }, visibility: { "NEW badge": true }, longSide: 1280 });
    const s = r.structured as { replaced: string[]; missing: string[]; width: number; height: number };
    assert.deepEqual(s.replaced, ["Title", "Price"]);
    assert.deepEqual(s.missing, ["Missing"]);
    assert.deepEqual([s.width, s.height], [1280, 720]);
    const exported = JSON.parse(await readFile(out, "utf8")) as { type: string; layers: { name: string; text?: string; visible: boolean; layers?: { name: string; visible: boolean; text?: string }[] }[] };
    assert.equal(exported.type, "png");
    assert.equal(exported.layers[0]?.text, title.replace(/\n/g, "\r"), "text arrives verbatim, newlines become Photoshop paragraph breaks");
    assert.equal(exported.layers[1]?.layers?.[0]?.visible, true);
    assert.match(await readFile(template, "utf8"), /"OLD"/, "template unchanged");
    await assert.rejects(h.run("photoshop.fill_template", { template, output: out, texts: { Title: "x" } }), ConflictError);
    await assert.rejects(h.run("photoshop.fill_template", { template, output: path.join(dir, "a.png") }), ValidationError);
    await assert.rejects(h.run("photoshop.fill_template", { template, output: path.join(dir, "a.png"), format: "jpg", texts: { Title: "x" } }), ValidationError);
  });

  it("runs an action over files with progress", async () => {
    const a = path.join(dir, "a.psd");
    const b = path.join(dir, "b.psd");
    for (const f of [a, b]) await writeFile(f, JSON.stringify({ width: 800, height: 600, layers: [] }));
    const progress: number[] = [];
    const r = await h.run("photoshop.run_action", { files: [a, b], set: "Default Actions", action: "Vignette", outputDir: path.join(dir, "act"), format: "jpg" }, { onProgress: (p) => progress.push(p.progress) });
    assert.equal((r.structured as { files: unknown[] }).files.length, 2);
    assert.deepEqual((await readdir(path.join(dir, "act"))).sort(), ["a_edit.jpg", "b_edit.jpg"]);
    assert.deepEqual(progress, [0, 1, 2]);
    const states = (await readFile(path.join(dir, "state.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { actions: string[]; closed: number });
    assert.deepEqual(states.at(-1)?.actions, ["Default Actions/Vignette"]);
    assert.equal(states.at(-1)?.closed, 2, "the copy and the source document are both closed");
  });

  it("reports when Photoshop is not installed", async () => {
    await writeFile(path.join(dir, "not-installed"), "");
    await assert.rejects(h.run("photoshop.status", {}), UnsupportedError);
    await rm(path.join(dir, "not-installed"));
    const s = await h.run("photoshop.status", {});
    assert.equal((s.structured as { version: string }).version, "25.0.0");
  });
});
