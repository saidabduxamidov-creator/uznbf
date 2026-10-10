import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConflictError, NotFoundError, type ToolPackage } from "@lmp/core";
import { clearBinaryCache, createToolHarness, locateFfmpeg, runProcess, type ToolHarness } from "@lmp/toolkit";
import subtitlesPackage, { applyCase, buildCues, parseSubtitles, parseWhisperJson, toSrt, toVtt, wrapLines } from "../src/index.js";

describe("caption logic", () => {
  it("wraps into balanced lines and never splits words", () => {
    assert.deepEqual(wrapLines("Assalomu alaykum hurmatli tomoshabinlar bugun yangi video", 42, 2), ["Assalomu alaykum hurmatli", "tomoshabinlar bugun yangi video"]);
    assert.deepEqual(wrapLines("Salom", 42, 2), ["Salom"]);
    assert.equal(wrapLines("a".repeat(50), 42, 2), null);
  });

  it("splits long segments into readable timed cues", () => {
    const text = "Bugun biz montajning eng muhim qoidalari haqida gaplashamiz va har bir qoidani misollar bilan ko'rib chiqamiz";
    const cues = buildCues([{ start: 10, end: 20, text }], { maxChars: 32, maxLines: 2, maxDurationSec: 6, minDurationSec: 0.8 });
    assert.ok(cues.length >= 2);
    assert.equal(cues[0]?.start, 10);
    assert.equal(cues.at(-1)?.end, 20);
    for (const c of cues) {
      assert.ok(c.text.split("\n").length <= 2 && c.text.split("\n").every((l) => l.length <= 32), c.text);
      assert.ok(c.end - c.start <= 6.01);
    }
    assert.equal(cues.map((c) => c.text.replace(/\n/g, " ")).join(" "), text, "no words lost");
    for (let i = 1; i < cues.length; i++) assert.ok((cues[i]?.start ?? 0) >= (cues[i - 1]?.end ?? 0), "no overlap");
  });

  it("round-trips SRT and VTT and tolerates messy input", () => {
    const cues = [{ start: 1.5, end: 3.25, text: "Salom\ndunyo" }, { start: 3600 + 2, end: 3600 + 4.004, text: "Oʻzbekiston" }];
    assert.deepEqual(parseSubtitles(toSrt(cues)), cues);
    assert.deepEqual(parseSubtitles(toVtt(cues)), cues);
    const messy = "﻿1\r\n00:00:01,000 --> 00:00:02,500 X:10%\r\n<i>Hello</i>\r\n\r\n\r\n00:00:03.000 --> 00:00:04.000\r\nNo index\r\n";
    assert.deepEqual(parseSubtitles(messy).map((c) => c.text), ["Hello", "No index"]);
  });

  it("applies letter case for Uzbek text", () => {
    assert.equal(applyCase("salom dunyo. qalaysiz?", "sentence"), "Salom dunyo. Qalaysiz?");
    assert.equal(applyCase("istanbul", "upper", "uz"), "ISTANBUL");
  });

  it("parses whisper.cpp JSON and drops non-speech markers", () => {
    const t = parseWhisperJson({
      result: { language: "uz" },
      transcription: [
        { offsets: { from: 0, to: 2500 }, text: " Assalomu alaykum." },
        { offsets: { from: 2500, to: 4000 }, text: " [BLANK_AUDIO]" },
        { offsets: { from: 4000, to: 7000 }, text: " Bugun yangi video." },
      ],
    });
    assert.equal(t.language, "uz");
    assert.deepEqual(t.segments, [{ start: 0, end: 2.5, text: "Assalomu alaykum." }, { start: 4, end: 7, text: "Bugun yangi video." }]);
  });
});

const WHISPER_SRC = process.env["LMP_TEST_WHISPER_SRC"] ?? path.join(os.tmpdir(), "whisper.cpp");
const whisperBin = path.join(WHISPER_SRC, "build", "bin", "whisper-cli");
const hasWhisper = await runProcess(whisperBin, ["--help"]).then(() => true, () => false);
const hasFfmpeg = await locateFfmpeg({}, "t").then(() => true, () => false);

describe("subtitles tools", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  let h: ToolHarness;
  let models: string;
  before(async () => {
    clearBinaryCache();
    models = path.join(os.tmpdir(), `lmp-models-${process.pid}`);
    await mkdir(models, { recursive: true });
    h = await createToolHarness(subtitlesPackage as ToolPackage<unknown>, { modelsDir: models, defaultModel: "tiny", ...(hasWhisper ? { whisperPath: whisperBin } : {}) });
  });
  after(() => h.close());

  it("reports missing models clearly", async () => {
    const r = await h.run("subtitles.models", {});
    assert.match((r.content[0] as { text: string }).text, /No speech models/);
  });

  it("writes, reads and reformats subtitle files", async () => {
    const out = path.join(h.dir, "a.srt");
    await h.run("subtitles.write", { output: out, cues: [{ start: 0, end: 4, text: "assalomu alaykum hurmatli tomoshabinlar bugun biz yangi mavzuni boshlaymiz" }] });
    const raw = await readFile(out);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for editors");
    assert.ok(raw.includes("\r\n"), "Windows line endings");
    await assert.rejects(h.run("subtitles.write", { output: out, cues: [{ start: 0, end: 1, text: "x" }] }), ConflictError);
    const read = await h.run("subtitles.read", { path: out });
    assert.equal((read.structured as { cues: unknown[] }).cues.length, 1);
    const re = await h.run("subtitles.reformat", { path: out, output: path.join(h.dir, "b.vtt"), maxChars: 24, case: "sentence" });
    assert.ok((re.structured as { after: number }).after >= 2);
    assert.match(await readFile(path.join(h.dir, "b.vtt"), "utf8"), /^﻿WEBVTT/);
  });

  it("transcribes offline with whisper.cpp", { skip: !hasWhisper && "whisper.cpp test build not available" }, async () => {
    await assert.rejects(h.run("subtitles.transcribe", { path: path.join(WHISPER_SRC, "samples", "jfk.wav") }), NotFoundError);
    await copyFile(path.join(WHISPER_SRC, "models", "for-tests-ggml-tiny.bin"), path.join(models, "ggml-tiny.bin"));
    const progress: number[] = [];
    const r = await h.run("subtitles.transcribe", { path: path.join(WHISPER_SRC, "samples", "jfk.wav"), language: "en" }, { onProgress: (p) => progress.push(p.progress) });
    const s = r.structured as { output: string; model: string; cues: unknown[] };
    assert.equal(s.model, "tiny");
    assert.match(await readFile(s.output, "utf8"), /^﻿/);
    assert.ok(progress.every((p) => p <= 100) && progress.at(-1) === 100);
    await writeFile(path.join(h.dir, "noise.txt"), "");
  });
});
