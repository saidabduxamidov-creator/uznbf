import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConflictError, ValidationError, type ToolPackage } from "@lmp/core";
import { clearBinaryCache, createToolHarness, locateFfmpeg, makeTestClip, probeMedia, runProcess, type ToolHarness } from "@lmp/toolkit";
import timelinePackage, { buildEdl, buildXmeml, framesAt, pathUrl, rateOf } from "../src/index.js";

const clip = (over: Partial<Parameters<typeof buildXmeml>[1][number]> = {}) => ({
  path: "C:\\Footage\\Interview A&B.mp4",
  name: "Interview A&B.mp4",
  inSec: 1,
  outSec: 3,
  mediaDurationSec: 10,
  hasVideo: true,
  hasAudio: true,
  audioChannels: 2,
  width: 1920,
  height: 1080,
  ...over,
});

describe("timeline formats", () => {
  it("handles NTSC and integer rates", () => {
    assert.deepEqual(rateOf(29.97), { timebase: 30, ntsc: true });
    assert.deepEqual(rateOf(25), { timebase: 25, ntsc: false });
    assert.equal(framesAt(2, 25), 50);
    assert.equal(framesAt(10, 29.97), 300 - 0, "10 s at 29.97 ≈ 300 frames");
  });

  it("encodes Windows paths as file URLs", () => {
    assert.equal(pathUrl("C:\\Footage\\My clip #1.mp4"), "file://localhost/C%3a/Footage/My%20clip%20%231.mp4");
    assert.equal(pathUrl("/home/u/a.mp4"), "file://localhost/home/u/a.mp4");
  });

  it("builds linked xmeml with reused file ids and escaped names", () => {
    const xml = buildXmeml({ name: "Cut <1>", fps: 25, width: 1920, height: 1080 }, [clip(), clip({ inSec: 5, outSec: 6 }), clip({ path: "C:\\b.wav", name: "b.wav", hasVideo: false, audioChannels: 1 })]);
    assert.match(xml, /<name>Cut &lt;1&gt;<\/name>/);
    assert.match(xml, /<duration>125<\/duration>/, "2 s + 1 s + 2 s at 25 fps");
    assert.equal(xml.match(/<file id="file-1">/g)?.length, 1, "file defined once");
    assert.ok((xml.match(/<file id="file-1"\/>/g)?.length ?? 0) >= 1, "then referenced");
    assert.match(xml, /Interview A&amp;B/);
    assert.equal(xml.match(/<clipitem id="clipitem-v/g)?.length, 2, "audio-only clip has no video item");
    assert.match(xml, /<start>50<\/start>\s*<end>75<\/end>\s*<in>125<\/in>\s*<out>150<\/out>/);
    assert.match(xml, /<linkclipref>clipitem-a1-2<\/linkclipref>/);
  });

  it("builds a CMX3600 EDL", () => {
    const edl = buildEdl({ name: "Cut", fps: 25, width: 1920, height: 1080 }, [clip(), clip({ hasVideo: false, audioChannels: 1, inSec: 0, outSec: 1 })]);
    const lines = edl.split("\r\n");
    assert.equal(lines[0], "TITLE: Cut");
    assert.match(edl, /001 {2}AX {7}V {5}C {8}00:00:01:00 00:00:03:00 00:00:00:00 00:00:02:00/);
    assert.match(edl, /002 {2}AX {7}AA {4}C/);
    assert.match(edl, /003 {2}AX {7}A {5}C {8}00:00:00:00 00:00:01:00 00:00:02:00 00:00:03:00/);
    assert.match(edl, /\* SOURCE FILE: C:\\Footage/);
  });
});

const hasFfmpeg = await locateFfmpeg({}, "t").then(() => true, () => false);

describe("timeline tools", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  let h: ToolHarness;
  let video: string;
  let tone: string;
  before(async () => {
    clearBinaryCache();
    h = await createToolHarness(timelinePackage as ToolPackage<unknown>);
    const { ffmpeg } = await locateFfmpeg({}, "t");
    video = path.join(h.dir, "clip.mp4");
    tone = path.join(h.dir, "tone.wav");
    await makeTestClip(ffmpeg, video);
    await runProcess(ffmpeg, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=f=330:d=3", "-ac", "1", tone]);
  });
  after(() => h.close());

  it("declares capabilities per distinct file", () => {
    const caps = h.capabilities("timeline.build_edit", { clips: [{ path: video }, { path: video, inSec: 1 }], output: "/x/a.xml" }) as { kind: string }[];
    assert.deepEqual(caps.map((c) => c.kind), ["fs.read", "fs.write", "process.spawn"]);
  });

  it("writes an XML timeline from media facts", async () => {
    const out = path.join(h.dir, "cut.xml");
    const r = await h.run("timeline.build_edit", { clips: [{ path: video, inSec: 0, outSec: 2 }, { path: video, inSec: 4 }, { path: tone }], output: out });
    const s = r.structured as { durationSec: number; sequence: { fps: number; width: number } };
    assert.equal(s.sequence.fps, 25);
    assert.equal(s.sequence.width, 320);
    assert.ok(Math.abs(s.durationSec - 7) < 0.1, String(s.durationSec));
    const xml = await readFile(out, "utf8");
    assert.match(xml, /<xmeml version="4">/);
    assert.match(xml, /<width>320<\/width>/);
    await assert.rejects(h.run("timeline.build_edit", { clips: [{ path: video }], output: out }), ConflictError);
    await assert.rejects(h.run("timeline.build_edit", { clips: [{ path: video, inSec: 9 }], output: path.join(h.dir, "bad.xml") }), ValidationError);
    await assert.rejects(h.run("timeline.build_edit", { clips: [{ path: video }], output: path.join(h.dir, "a.txt") }), ValidationError);
    await h.run("timeline.build_edit", { clips: [{ path: video, outSec: 1 }], output: path.join(h.dir, "cut.edl") });
    assert.match(await readFile(path.join(h.dir, "cut.edl"), "utf8"), /^TITLE: Rough cut/);
  });

  it("renders a rough cut including a clip without video", async () => {
    const progress: number[] = [];
    const r = await h.run(
      "timeline.render_rough_cut",
      { clips: [{ path: video, inSec: 0, outSec: 1.5 }, { path: tone, outSec: 1 }, { path: video, inSec: 4, outSec: 5 }], width: 320, height: 180, fps: 25 },
      { onProgress: (p) => progress.push(p.progress) },
    );
    const s = r.structured as { output: string; durationSec: number };
    const { ffprobe } = await locateFfmpeg({}, "t");
    const info = await probeMedia(ffprobe, s.output);
    assert.ok(info.hasVideo && info.hasAudio);
    assert.ok(Math.abs((info.durationSec ?? 0) - 3.5) < 0.2, String(info.durationSec));
    assert.equal(info.streams.find((x) => x.type === "video")?.width, 320);
    assert.equal(progress.at(-1), 100);
    for (let i = 1; i < progress.length; i++) assert.ok((progress[i] ?? 0) >= (progress[i - 1] ?? 0));
  });

  it("cancels a render and leaves no partial file", async () => {
    const ac = new AbortController();
    const out = path.join(h.dir, "cancel.mp4");
    const run = h.run("timeline.render_rough_cut", { clips: Array.from({ length: 20 }, () => ({ path: video })), output: out, width: 1920, height: 1080, quality: "review" }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(run);
    await assert.rejects(readFile(out));
    await assert.rejects(readFile(`${out}.part.mp4`));
  });
});
