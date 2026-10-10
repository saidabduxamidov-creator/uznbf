import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ValidationError, type ToolPackage } from "@lmp/core";
import { clearBinaryCache, createToolHarness, locateFfmpeg, runProcess, type ToolHarness } from "@lmp/toolkit";
import ocrPackage, { WINDOWS_OCR_SCRIPT, parseTesseractTsv, tesseractLanguage } from "../src/index.js";

describe("OCR parsing", () => {
  it("groups Tesseract words into lines and keeps boxes and confidence", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "1\t1\t0\t0\t0\t0\t0\t0\t640\t360\t-1\t",
      "5\t1\t1\t1\t1\t1\t10\t20\t50\t18\t96.5\tSalom",
      "5\t1\t1\t1\t1\t2\t70\t20\t60\t18\t91.25\tdunyo",
      "5\t1\t1\t1\t2\t1\t10\t50\t40\t18\t88\tIkki",
      "5\t1\t1\t1\t2\t2\t60\t50\t40\t18\t-1\t ",
    ].join("\n");
    const lines = parseTesseractTsv(tsv);
    assert.deepEqual(lines.map((l) => l.text), ["Salom dunyo", "Ikki"]);
    assert.deepEqual(lines[0]?.words[1], { text: "dunyo", x: 70, y: 20, width: 60, height: 18, confidence: 91.3 });
  });

  it("maps ISO codes to Tesseract languages", () => {
    assert.equal(tesseractLanguage(undefined), "eng");
    assert.equal(tesseractLanguage("uz-Cyrl"), "uzb_cyrl");
    assert.equal(tesseractLanguage("en+ru"), "eng+rus");
  });

  it("Windows script uses only built-in WinRT OCR", () => {
    assert.match(WINDOWS_OCR_SCRIPT, /Windows\.Media\.Ocr\.OcrEngine/);
    assert.ok(!/Invoke-WebRequest|Net\.WebClient|Invoke-Expression/i.test(WINDOWS_OCR_SCRIPT));
  });
});

const hasFfmpeg = await locateFfmpeg({}, "t").then(() => true, () => false);
const hasTesseract = await runProcess("tesseract", ["--version"]).then(() => true, () => false);

describe("OCR tools", { skip: !(hasFfmpeg && hasTesseract) && "ffmpeg/tesseract not installed" }, () => {
  let h: ToolHarness;
  let image: string;
  let video: string;
  before(async () => {
    clearBinaryCache();
    h = await createToolHarness(ocrPackage as ToolPackage<unknown>, { engine: "tesseract" });
    const { ffmpeg } = await locateFfmpeg({}, "t");
    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    image = path.join(h.dir, "title.png");
    await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=white:s=800x300", "-frames:v", "1", "-vf",
      `drawtext=fontfile=${font}:text='HELLO WORLD':fontsize=64:fontcolor=black:x=60:y=40,drawtext=fontfile=${font}:text='Lower Third':fontsize=48:fontcolor=black:x=60:y=210`, image]);
    video = path.join(h.dir, "titles.mp4");
    await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=4:r=25", "-vf",
      `drawtext=fontfile=${font}:text='FIRST TITLE':fontsize=56:fontcolor=white:x=60:y=150:enable='lt(t,2)',drawtext=fontfile=${font}:text='SECOND TITLE':fontsize=56:fontcolor=white:x=60:y=150:enable='gte(t,2)'`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video]);
  });
  after(() => h.close());

  it("reads text in an image with word boxes", async () => {
    const r = await h.run("ocr.image", { path: image });
    const s = r.structured as { engine: string; text: string; lines: { words: { x: number }[] }[] };
    assert.equal(s.engine, "tesseract");
    assert.match(s.text, /HELLO WORLD/);
    assert.match(s.text, /Lower Third/);
    assert.ok((s.lines[0]?.words[0]?.x ?? 0) > 0);
  });

  it("reads only the requested region", async () => {
    const r = await h.run("ocr.image", { path: image, region: { x: 0, y: 0.6, width: 1, height: 0.4 } });
    const t = (r.structured as { text: string }).text;
    assert.match(t, /Lower Third/);
    assert.doesNotMatch(t, /HELLO/);
  });

  it("reads titles from video frames at given times", async () => {
    const r = await h.run("ocr.video_frame", { path: video, times: [0.5, 3] });
    const frames = (r.structured as { frames: { text: string }[] }).frames;
    assert.match(frames[0]?.text ?? "", /FIRST TITLE/);
    assert.match(frames[1]?.text ?? "", /SECOND TITLE/);
  });

  it("explains a missing language", async () => {
    await assert.rejects(h.run("ocr.image", { path: image, language: "uz" }), (e: unknown) => e instanceof ValidationError && /uzb/.test((e as Error).message));
    const langs = await h.run("ocr.languages", {});
    assert.ok(((langs.structured as { tesseract: string[] }).tesseract ?? []).includes("eng"));
  });
});

describe("Windows OCR engine", { skip: !(hasFfmpeg && hasTesseract) && "ffmpeg/tesseract not installed" }, () => {
  let dir: string;
  let h: ToolHarness;
  let image: string;
  before(async () => {
    clearBinaryCache();
    dir = await mkdtemp(path.join(os.tmpdir(), "lmp-ocr-win-"));
    // Stand-in for powershell.exe: checks the protocol and answers like the real script does,
    // including PowerShell's habit of collapsing one-element arrays into objects.
    const fake = path.join(dir, "powershell");
    await writeFile(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
if (!script.includes("OcrEngine")) process.exit(9);
const req = JSON.parse(Buffer.from(require("fs").readFileSync(0, "utf8").trim(), "base64").toString("utf8"));
const out = (o) => process.stdout.write(Buffer.from(JSON.stringify(o)).toString("base64"));
if (req.op === "languages") out({ languages: "en-US", maxDimension: 10000 });
else if (req.language === "uz") { process.stderr.write("NO_LANGUAGE"); process.exit(4); }
else out({ language: "en-US", lines: { text: "WINDOWS OCR", words: { text: "WINDOWS", x: 1, y: 2, width: 3, height: 4 } } });
`);
    await chmod(fake, 0o755);
    h = await createToolHarness(ocrPackage as ToolPackage<unknown>, { engine: "windows", powershellPath: fake });
    image = path.join(dir, "a.png");
    const { ffmpeg } = await locateFfmpeg({}, "t");
    await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=white:s=200x100", "-frames:v", "1", image]);
  });
  after(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("normalises PowerShell JSON and reports missing language packs", async () => {
    const r = await h.run("ocr.image", { path: image });
    assert.deepEqual((r.structured as { lines: unknown[] }).lines, [{ text: "WINDOWS OCR", words: [{ text: "WINDOWS", x: 1, y: 2, width: 3, height: 4, confidence: null }] }]);
    await assert.rejects(h.run("ocr.image", { path: image, language: "uz" }), /language pack/);
  });
});
