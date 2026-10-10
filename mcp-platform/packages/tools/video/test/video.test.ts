import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolPackage } from "@lmp/core";
import { createToolHarness, locateFfmpeg, makeTestClip, type ToolHarness } from "@lmp/toolkit";
import videoPackage from "../src/index.js";
import { SilenceCollector, parseEbur128Summary, parseShowinfoTime, speechSegments } from "../src/parsers.js";

describe("video parsers", () => {
  it("collects silences and derives padded, merged speech segments", () => {
    const c = new SilenceCollector();
    c.line("[silencedetect @ 0x1] silence_start: 1.5");
    c.line("[silencedetect @ 0x1] silence_end: 3 | silence_duration: 1.5");
    c.line("[silencedetect @ 0x1] silence_start: 5.8");
    const silences = c.finish(6);
    assert.deepEqual(silences, [{ start: 1.5, end: 3 }, { start: 5.8, end: 6 }]);
    assert.deepEqual(speechSegments(silences, 6, 0.1, 0.2), [{ start: 0, end: 1.6 }, { start: 2.9, end: 5.9 }]);
    assert.deepEqual(speechSegments([{ start: 1, end: 1.1 }], 3, 0.1, 0), [{ start: 0, end: 3 }], "tiny gap merged by padding");
  });
  it("parses showinfo and ebur128 output", () => {
    assert.equal(parseShowinfoTime("[Parsed_showinfo_2 @ 0x5] n:   0 pts:  50 pts_time:2.04 duration: 1"), 2.04);
    assert.equal(parseShowinfoTime("frame= 10"), null);
    const summary = parseEbur128Summary([
      "[Parsed_ebur128_0 @ 0x1] Summary:", "", "  Integrated loudness:", "    I:         -19.6 LUFS", "    Threshold: -30.0 LUFS", "",
      "  Loudness range:", "    LRA:         0.4 LU", "    Threshold: -40.0 LUFS", "", "  True peak:", "    Peak:       -6.0 dBFS",
    ]);
    assert.deepEqual(summary, { integratedLufs: -19.6, thresholdLufs: -30, loudnessRangeLu: 0.4, truePeakDbfs: -6 });
  });
});

const available = await locateFfmpeg({}, "test").then(() => true, () => false);

describe("video tool package", { skip: !available && "ffmpeg not installed" }, () => {
  let h: ToolHarness;
  let clip: string;
  before(async () => {
    h = await createToolHarness(videoPackage as ToolPackage<unknown>);
    clip = path.join(h.dir, "clip.mp4");
    await makeTestClip((await locateFfmpeg({}, "test")).ffmpeg, clip);
  });
  after(() => h.close());

  it("finds the silent gap and the speech around it", async () => {
    const r = await h.run("video.detect_silence", { path: clip, padSec: 0 });
    const s = r.structured as { silences: Array<{ start: number; end: number }>; speech: Array<{ start: number; end: number }> };
    assert.equal(s.silences.length, 1);
    assert.ok(Math.abs((s.silences[0]?.start ?? 0) - 1.5) < 0.1 && Math.abs((s.silences[0]?.end ?? 0) - 3) < 0.1, JSON.stringify(s.silences));
    assert.equal(s.speech.length, 2);
  });

  it("detects the two colour cuts", async () => {
    const r = await h.run("video.detect_scenes", { path: clip });
    const cuts = (r.structured as { cuts: number[] }).cuts;
    assert.equal(cuts.length, 2, JSON.stringify(cuts));
    assert.ok(Math.abs((cuts[0] ?? 0) - 2) < 0.1 && Math.abs((cuts[1] ?? 0) - 4) < 0.1);
  });

  it("measures loudness and suggests gains", async () => {
    const r = await h.run("video.loudness", { path: clip });
    const m = r.structured as { integratedLufs: number; truePeakDbfs: number; gainDb: { social: number } };
    assert.ok(m.integratedLufs < -5 && m.integratedLufs > -30, String(m.integratedLufs));
    assert.ok(Math.abs(m.gainDb.social - (-14 - m.integratedLufs)) < 0.11);
  });

  it("builds a contact sheet image", async () => {
    const r = await h.run("video.contact_sheet", { path: clip, columns: 3, rows: 2, tileWidth: 160 });
    assert.equal(r.content[0]?.type, "image");
    assert.equal((r.structured as { approxTimes: number[] }).approxTimes.length, 6);
  });
});
