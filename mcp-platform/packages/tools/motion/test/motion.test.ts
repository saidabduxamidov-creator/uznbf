import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ValidationError, type ToolPackage } from "@lmp/core";
import { createToolHarness, type ToolHarness } from "@lmp/toolkit";
import motionPackage, { ease, kenBurns, planZooms, sampleKeys, shake } from "../src/index.js";

describe("easing and sampling", () => {
  it("easing curves start at 0 and end at 1", () => {
    for (const e of ["linear", "ease_in", "ease_out", "ease_in_out", "ease_out_back", "ease_out_elastic", "ease_out_bounce"] as const) {
      assert.ok(Math.abs(ease(e, 0)) < 1e-9, e);
      assert.ok(Math.abs(ease(e, 1) - 1) < 1e-9, e);
    }
    assert.ok(ease("ease_out_back", 0.7) > 1, "back overshoots");
    assert.equal(ease("ease_in_out", 0.5), 0.5);
  });

  it("samples monotonic times and exact end points", () => {
    const keys = sampleKeys(100, 130, 2, 1, "ease_out", 30);
    assert.deepEqual(keys[0], [2, 100]);
    assert.deepEqual(keys.at(-1), [3, 130]);
    for (let i = 1; i < keys.length; i++) assert.ok((keys[i]?.[0] ?? 0) > (keys[i - 1]?.[0] ?? 0));
    assert.ok(sampleKeys(0, 1, 0, 2, "ease_out_elastic", 30).length > sampleKeys(0, 1, 0, 2, "ease_out", 30).length);
    assert.equal(sampleKeys(0, 1, 0, 0.1, "ease_out_bounce", 30).length, 4, "never denser than the frame rate");
    assert.deepEqual(sampleKeys([0, 0], [0.1, -0.1], 0, 1, "linear", 25).at(-1), [1, [0.1, -0.1]]);
  });

  it("Ken Burns pans never reveal the edge", () => {
    const p = kenBurns(0, 5, "left", 20, "linear", 30);
    const maxTravel = (120 - 100) / 200;
    for (const [, v] of p.position) assert.ok(Math.abs((v as readonly number[])[0] ?? 0) <= maxTravel);
    assert.equal(kenBurns(0, 5, "in", 10, "ease_in_out", 30).scale.at(-1)?.[1], 110);
  });

  it("shake is deterministic, settles to zero and covers edges", () => {
    const a = shake(1, 0.5, 0.02, 20, 1, true, 3);
    assert.deepEqual(a, shake(1, 0.5, 0.02, 20, 1, true, 3));
    assert.notDeepEqual(a.position, shake(1, 0.5, 0.02, 20, 1, true, 4).position);
    assert.deepEqual(a.position.at(-1)?.[1], [0, 0]);
    assert.ok((a.scale[1]?.[1] as number) >= 104);
  });
});

describe("zoom planning", () => {
  const speech = [
    { start: 0, end: 2, text: "Assalomu alaykum." },
    { start: 2.2, end: 4, text: "Bugun montaj haqida." },
    { start: 4.2, end: 6, text: "Bu juda muhim!" },
    { start: 6.5, end: 9, text: "Birinchi qoida: ritm." },
    { start: 9.2, end: 12, text: "Ikkinchi qoida: kadr." },
    { start: 12.5, end: 15, text: "Obuna bo'ling?" },
    { start: 15.5, end: 18, text: "Rahmat." },
  ];
  const options = { everySec: 5, minGapSec: 2.5, scale: 115, emphasisScale: 125, holdSec: 2, keywords: ["qoida"], maxZooms: 50 };

  it("prefers emphasis and keywords and keeps gaps", () => {
    const zooms = planZooms(speech, options);
    const times = zooms.map((z) => z.time);
    assert.ok(times.includes(6.5) && times.includes(9.2), "keywords");
    assert.ok(times.includes(12.5), "emphatic line");
    assert.ok(!times.includes(4.2), "an emphatic line too close to a keyword line gives way");
    for (let i = 1; i < times.length; i++) assert.ok((times[i] ?? 0) - (times[i - 1] ?? 0) >= 2.5);
    for (const z of zooms) assert.ok(z.scale >= 102 && z.scale <= 160 && z.holdSec >= 0.5);
    assert.equal(zooms.find((z) => z.time === 12.5)?.scale, 125);
    assert.equal(zooms[0]?.time, 0, "rhythm fills the opening");
    assert.ok(zooms.every((z, i) => i === zooms.length - 1 || z.time + z.holdSec <= (zooms[i + 1]?.time ?? 0)), "zooms never overlap");
  });

  it("respects maxZooms and ignores empty lines", () => {
    assert.equal(planZooms(speech, { ...options, maxZooms: 2 }).length, 2);
    assert.deepEqual(planZooms([{ start: 0, end: 1, text: "  " }], options), []);
  });
});

describe("motion tools", () => {
  let h: ToolHarness;
  before(async () => (h = await createToolHarness(motionPackage as ToolPackage<unknown>)));
  after(() => h.close());

  it("returns ops ready for editor.apply_motion", async () => {
    const r = await h.run("motion.keyframes", { track: 0, start: 10, prop: "scale", from: 100, to: 120, atSec: 10, durationSec: 0.5, easing: "ease_out_back" });
    const op = (r.structured as { ops: { prop: string; mode: string; keys: unknown[] }[] }).ops[0];
    assert.equal(op?.prop, "scale");
    assert.equal(op?.mode, "rel");
    assert.ok((op?.keys.length ?? 0) >= 3);
    await assert.rejects(h.run("motion.keyframes", { track: 0, start: 0, prop: "position", from: 1, to: 2, atSec: 0, durationSec: 1 }), ValidationError);
    await assert.rejects(h.run("motion.keyframes", { track: 0, start: 0, prop: "scale", from: 1, to: [1, 2], atSec: 0, durationSec: 1 }), ValidationError);
    const kb = await h.run("motion.ken_burns", { track: 1, start: 0, atSec: 0, durationSec: 4, direction: "in_left" });
    assert.equal((kb.structured as { ops: unknown[] }).ops.length, 2);
    const sh = await h.run("motion.shake", { track: 0, start: 0, atSec: 1 });
    assert.equal((sh.structured as { ops: unknown[] }).ops.length, 3);
    const pz = await h.run("motion.plan_zooms", { segments: [{ start: 1, end: 3, text: "Wow!" }] });
    assert.deepEqual((pz.structured as { zooms: { time: number }[] }).zooms.map((z) => z.time), [1]);
    assert.deepEqual(h.capabilities("motion.shake", { track: 0, start: 0, atSec: 0 }), []);
  });
});
