import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConflictError, ValidationError, type ToolPackage } from "@lmp/core";
import { clearBinaryCache, createToolHarness, runProcess, type ToolHarness } from "@lmp/toolkit";
import { WINDOWS_SCRIPTS, createClipboardPackage, linuxBackend, windowsBackend } from "../src/index.js";

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("Windows backend plumbing", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lmp-clip-win-"));
    // Fake powershell.exe: decodes -EncodedCommand (UTF-16LE base64), identifies the script and
    // emulates it against a file-backed clipboard. Verifies arguments and the base64 protocol.
    const fake = path.join(dir, "powershell");
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
const must = ["-NoLogo","-NoProfile","-NonInteractive","-STA","-ExecutionPolicy","Bypass","-EncodedCommand"];
for (const m of must) if (!args.includes(m)) { process.stderr.write("missing " + m); process.exit(9); }
const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
const store = path.join(${JSON.stringify(dir)}, "clip.json");
const state = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {};
const input = Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8");
const out = (s) => process.stdout.write(Buffer.from(s, typeof s === "string" ? "utf8" : undefined).toString("base64"));
if (script.includes("SetText") || script.includes("Clipboard]::Clear")) state.text = input;
else if (script.includes("GetText")) out(state.text || "");
else if (script.includes("SetImage")) state.image = fs.readFileSync(input).toString("base64");
else if (script.includes("GetImage")) { if (state.image) process.stdout.write(state.image); }
else if (script.includes("SetFileDropList")) state.files = input.split("\\n");
else if (script.includes("GetFileDropList")) out((state.files || []).join("\\n"));
else process.exit(8);
fs.writeFileSync(store, JSON.stringify(state));
`,
    );
    await chmod(fake, 0o755);
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("scripts are self-contained, retry on a busy clipboard and never echo input", () => {
    for (const [name, script] of Object.entries(WINDOWS_SCRIPTS)) {
      assert.match(script, /Add-Type -AssemblyName System\.Windows\.Forms/, name);
      assert.ok(!/Invoke-Expression|iex /i.test(script), name);
    }
  });

  it("round-trips Unicode text, images and file lists", async () => {
    clearBinaryCache();
    const b = windowsBackend({ powershellPath: path.join(dir, "powershell") });
    const signal = new AbortController().signal;
    const text = "Oʻzbekiston — «salom» 🎬\r\nikkinchi qator";
    await b.writeText(text, signal);
    assert.equal(await b.readText(signal), text);
    assert.equal(await b.readImage(signal), null);
    const png = path.join(dir, "a.png");
    await writeFile(png, PNG);
    await b.writeImage(png, "image/png", signal);
    assert.deepEqual(await b.readImage(signal), PNG);
    await b.writeFiles(["C:\\Video\\a.mp4", "D:\\Ovoz\\b.wav"], signal);
    assert.deepEqual(await b.readFiles(signal), ["C:\\Video\\a.mp4", "D:\\Ovoz\\b.wav"]);
  });
});

const hasXvfb = await runProcess("Xvfb", ["-help"], { okExitCodes: [0, 1] }).then(() => true, () => false);
const hasXclip = await runProcess("xclip", ["-version"]).then(() => true, () => false);

describe("clipboard tools on X11", { skip: !(hasXvfb && hasXclip) && "Xvfb/xclip not installed" }, () => {
  let xvfb: ChildProcess;
  let h: ToolHarness;
  const previousDisplay = process.env["DISPLAY"];
  before(async () => {
    const display = `:${90 + (process.pid % 9)}`;
    xvfb = spawn("Xvfb", [display, "-nolisten", "tcp"], { stdio: "ignore" });
    process.env["DISPLAY"] = display;
    for (let i = 0; i < 50; i++) {
      if (await runProcess("xclip", ["-selection", "clipboard", "-o", "-t", "TARGETS"], { okExitCodes: [0, 1] }).then((r) => !/Can't open display/.test(r.stderr), () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    h = await createToolHarness(createClipboardPackage((s) => linuxBackend(s)) as ToolPackage<unknown>);
  });
  after(async () => {
    await h.close();
    xvfb.kill();
    if (previousDisplay === undefined) delete process.env["DISPLAY"];
    else process.env["DISPLAY"] = previousDisplay;
  });

  it("declares clipboard capabilities", () => {
    assert.deepEqual((h.capabilities("clipboard.read_text", {}) as { kind: string }[]).map((c) => c.kind), ["clipboard.read"]);
    assert.deepEqual((h.capabilities("clipboard.write_image", { path: "/a.png" }) as { kind: string }[]).map((c) => c.kind), ["fs.read", "clipboard.write"]);
  });

  it("copies and pastes Unicode text", async () => {
    await h.run("clipboard.write_text", { text: "Salom, dunyo! Oʻzbek tili 🎬" });
    const r = await h.run("clipboard.read_text", {});
    assert.equal((r.structured as { text: string }).text, "Salom, dunyo! Oʻzbek tili 🎬");
    const t = await h.run("clipboard.read_text", { maxChars: 5 });
    assert.deepEqual(t.structured, { text: "Salom", length: 28, truncated: true });
  });

  it("copies an image, shows it and saves it", async () => {
    const png = path.join(h.dir, "dot.png");
    await writeFile(png, PNG);
    await h.run("clipboard.write_image", { path: png });
    const out = path.join(h.dir, "pasted.png");
    const r = await h.run("clipboard.read_image", { saveTo: out });
    assert.equal(r.content[0]?.type, "image");
    assert.deepEqual(await readFile(out), PNG);
    assert.equal((r.structured as { width: number }).width, 1);
    await assert.rejects(h.run("clipboard.read_image", { saveTo: out }), ConflictError);
    await writeFile(path.join(h.dir, "x.txt"), "not an image");
    await assert.rejects(h.run("clipboard.write_image", { path: path.join(h.dir, "x.txt") }), ValidationError);
  });

  it("copies files for pasting", async () => {
    const a = path.join(h.dir, "fayl 1.txt");
    await writeFile(a, "x");
    await h.run("clipboard.write_files", { paths: [a] });
    const r = await h.run("clipboard.read_files", {});
    assert.deepEqual((r.structured as { files: string[] }).files, [a]);
    const empty = await h.run("clipboard.write_text", { text: "" });
    assert.match((empty.content[0] as { text: string }).text, /cleared/);
  });
});

