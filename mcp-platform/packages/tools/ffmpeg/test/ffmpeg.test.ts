import assert from "node:assert/strict";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CancelledError, ConflictError, ValidationError, type ToolPackage } from "@lmp/core";
import { createToolHarness, locateFfmpeg, makeTestClip, type ToolHarness } from "@lmp/toolkit";
import ffmpegPackage from "../src/index.js";

const available = await locateFfmpeg({}, "test").then(() => true, () => false);

describe("ffmpeg tool package", { skip: !available && "ffmpeg not installed" }, () => {
  let h: ToolHarness;
  let clip: string;
  before(async () => {
    h = await createToolHarness(ffmpegPackage as ToolPackage<unknown>);
    clip = path.join(h.dir, "clip.mp4");
    await makeTestClip((await locateFfmpeg({}, "test")).ffmpeg, clip);
  });
  after(() => h.close());

  it("probes streams", async () => {
    const r = await h.run("ffmpeg.probe", { path: clip });
    const info = r.structured as { durationSec: number; hasVideo: boolean; hasAudio: boolean; streams: Array<{ type: string; width?: number; sampleRate?: number }> };
    assert.ok(Math.abs(info.durationSec - 6) < 0.2);
    assert.ok(info.hasVideo && info.hasAudio);
    assert.equal(info.streams.find((s) => s.type === "video")?.width, 320);
    assert.equal(info.streams.find((s) => s.type === "audio")?.sampleRate, 48000);
  });

  it("returns frames as images the assistant can see", async () => {
    const progress: number[] = [];
    const r = await h.run("ffmpeg.extract_frames", { path: clip, count: 3, width: 160 }, { onProgress: (p) => progress.push(p.progress) });
    const images = r.content.filter((c) => c.type === "image");
    assert.equal(images.length, 3);
    assert.deepEqual(progress, [1, 2, 3]);
    await assert.rejects(h.run("ffmpeg.extract_frames", { path: clip }), ValidationError);
  });

  it("extracts audio to the artifacts folder or a given path", async () => {
    const r = await h.run("ffmpeg.extract_audio", { path: clip, sampleRate: 16000, channels: 1, startSec: 1, durationSec: 2 });
    const out = (r.structured as { output: string }).output;
    assert.ok(out.startsWith(path.join(h.dir, "artifacts")));
    assert.ok((await stat(out)).size > 60_000, "about 2 s of 16 kHz mono PCM");
    const target = path.join(h.dir, "voice.wav");
    await h.run("ffmpeg.extract_audio", { path: clip, output: target });
    await assert.rejects(h.run("ffmpeg.extract_audio", { path: clip, output: target }), ConflictError);
  });

  it("transcodes with presets only, validates extensions, and leaves no partial file on cancel", async () => {
    const out = path.join(h.dir, "proxy.mp4");
    const progress: number[] = [];
    await h.run("ffmpeg.transcode", { path: clip, output: out, preset: "proxy_720p" }, { onProgress: (p) => progress.push(p.progress) });
    assert.ok((await stat(out)).size > 1000);
    assert.equal(progress.at(-1), 100);
    await assert.rejects(h.run("ffmpeg.transcode", { path: clip, output: path.join(h.dir, "x.mp3"), preset: "proxy_720p" }), /writes \.mp4\/\.mov/);
    await assert.rejects(h.run("ffmpeg.transcode", { path: clip, output: out, preset: "h264_web" }), ConflictError);
    await assert.rejects(h.run("ffmpeg.transcode", { path: clip, output: out, preset: "-y -i x" }), ValidationError);
    await writeFile(path.join(h.dir, "marker"), "");
    const ac = new AbortController();
    const slow = h.run("ffmpeg.transcode", { path: clip, output: path.join(h.dir, "pro.mov"), preset: "prores_proxy" }, { signal: ac.signal });
    ac.abort();
    await assert.rejects(slow, CancelledError);
    assert.ok(!(await readdir(h.dir)).some((f) => f.includes("partial") || f === "pro.mov"), "no partial output");
  });
});
