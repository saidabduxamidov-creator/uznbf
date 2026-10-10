/**
 * Motion planning package. Pure computation, no files and no host access: it turns intent
 * ("punch in on the important lines", "slow Ken Burns to the left") into exact keyframes that
 * editor.apply_zooms and editor.apply_motion apply in Premiere Pro, After Effects or Resolve.
 */
import { ValidationError, defineTool, defineToolPackage, text } from "@lmp/core";
import { z } from "zod";
import { EASINGS, kenBurns, planZooms, sampleKeys, shake, type Easing, type Key } from "./planner.js";

const SECONDS = z.number().min(0).max(24 * 3600);
const EASING = z.enum(EASINGS as unknown as [Easing, ...Easing[]]).default("ease_in_out");
const FPS = z.number().min(1).max(240).default(30);
const PURE = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const TARGET = { track: z.number().int().min(0).max(99).describe("0 = V1"), start: SECONDS.describe("Clip start on the timeline (s)") };

type Op = { track: number; start: number; prop: "scale" | "position" | "rotation" | "opacity" | "anchor"; mode: "rel" | "abs"; keys: Key[] };

const summary = (ops: readonly Op[]) =>
  `${ops.length} op(s), ${ops.reduce((n, o) => n + o.keys.length, 0)} keyframes. Pass "ops" to editor.apply_motion.`;

export default defineToolPackage({
  manifest: {
    id: "motion",
    version: "0.1.0",
    displayName: "Motion planning",
    description: "Plans punch-in zooms from speech and computes eased keyframes, Ken Burns moves and camera shake.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: [],
  },
  register: () => ({
    tools: [
      defineTool({
        name: "motion.plan_zooms",
        title: "Plan punch-in zooms",
        description:
          "Chooses punch-in zoom moments from timed speech (e.g. subtitles.read or subtitles.transcribe cues): emphasised lines and keywords first, then a steady rhythm. Pass the result's zooms to editor.apply_zooms.",
        input: z
          .object({
            segments: z.array(z.object({ start: SECONDS, end: SECONDS, text: z.string().max(1000) })).min(1).max(20_000),
            everySec: z.number().min(1).max(60).default(6),
            minGapSec: z.number().min(0.5).max(30).default(2.5),
            scale: z.number().min(102).max(160).default(115),
            emphasisScale: z.number().min(102).max(160).default(125),
            holdSec: z.number().min(0.5).max(8).default(2),
            keywords: z.array(z.string().min(1).max(60)).max(200).default([]),
            maxZooms: z.number().int().min(1).max(500).default(200),
          })
          .strict(),
        output: z.object({
          zooms: z.array(z.object({ time: z.number(), scale: z.number(), holdSec: z.number(), reason: z.string() })),
        }),
        annotations: PURE,
        execution: { resourceClass: "inline" },
        capabilities: () => [],
        run: async (input) => {
          if (input.minGapSec > input.everySec) throw new ValidationError("minGapSec must not exceed everySec");
          const zooms = planZooms(input.segments, input);
          const lines = zooms.slice(0, 60).map((z) => `${z.time.toFixed(2)} s → ${z.scale}% for ${z.holdSec} s (${z.reason})`);
          return {
            content: [text(`${zooms.length} punch-in(s):\n${lines.join("\n")}${zooms.length > 60 ? `\n… ${zooms.length - 60} more` : ""}`)],
            structured: { zooms },
          };
        },
      }),

      defineTool({
        name: "motion.keyframes",
        title: "Eased keyframes",
        description:
          "Computes keyframes for one property moving from one value to another with an easing curve (linear, ease_in, ease_out, ease_in_out, ease_out_back, ease_out_elastic, ease_out_bounce, hold). Returns an op for editor.apply_motion.",
        input: z
          .object({
            ...TARGET,
            prop: z.enum(["scale", "position", "rotation", "opacity", "anchor"]),
            mode: z.enum(["rel", "abs"]).default("rel"),
            from: z.union([z.number(), z.tuple([z.number(), z.number()])]),
            to: z.union([z.number(), z.tuple([z.number(), z.number()])]),
            atSec: SECONDS.describe("Timeline time where the move starts"),
            durationSec: z.number().min(0).max(600),
            easing: EASING,
            fps: FPS,
          })
          .strict(),
        annotations: PURE,
        execution: { resourceClass: "inline" },
        capabilities: () => [],
        run: async (input) => {
          if (typeof input.from !== typeof input.to) throw new ValidationError("from and to must both be numbers or both be [x, y] pairs");
          if ((input.prop === "position" || input.prop === "anchor") !== Array.isArray(input.from)) {
            throw new ValidationError(`${input.prop} takes ${input.prop === "position" || input.prop === "anchor" ? "[x, y] pairs" : "numbers"}`);
          }
          const op: Op = { track: input.track, start: input.start, prop: input.prop, mode: input.mode, keys: sampleKeys(input.from, input.to, input.atSec, input.durationSec, input.easing, input.fps) };
          return { content: [text(summary([op]))], structured: { ops: [op] } };
        },
      }),

      defineTool({
        name: "motion.ken_burns",
        title: "Ken Burns move",
        description:
          "Slow zoom and/or pan across a clip (directions: in, out, left, right, up, down, in_left, in_right) that never reveals the frame edge. Returns ops for editor.apply_motion.",
        input: z
          .object({
            ...TARGET,
            atSec: SECONDS.describe("Timeline time where the move starts (usually the clip start)"),
            durationSec: z.number().min(0.2).max(600),
            direction: z.enum(["in", "out", "left", "right", "up", "down", "in_left", "in_right"]).default("in"),
            strength: z.number().min(2).max(60).default(12).describe("Zoom in percent"),
            easing: EASING,
            fps: FPS,
          })
          .strict(),
        annotations: PURE,
        execution: { resourceClass: "inline" },
        capabilities: () => [],
        run: async (input) => {
          const plan = kenBurns(input.atSec, input.durationSec, input.direction, input.strength, input.easing, input.fps);
          const ops: Op[] = [{ track: input.track, start: input.start, prop: "scale", mode: "rel", keys: plan.scale }];
          if (plan.position.length) ops.push({ track: input.track, start: input.start, prop: "position", mode: "rel", keys: plan.position });
          return { content: [text(summary(ops))], structured: { ops } };
        },
      }),

      defineTool({
        name: "motion.shake",
        title: "Camera shake",
        description:
          "Camera shake (impact, handheld, earthquake) with a decay envelope; the clip is scaled up just enough to hide the edges. Same seed = same shake. Returns ops for editor.apply_motion.",
        input: z
          .object({
            ...TARGET,
            atSec: SECONDS,
            durationSec: z.number().min(0.1).max(120).default(0.6),
            amplitude: z.number().min(0.001).max(0.1).default(0.015).describe("Fraction of the frame"),
            frequencyHz: z.number().min(1).max(30).default(18),
            rotationDeg: z.number().min(0).max(10).default(0.8),
            decay: z.boolean().default(true),
            seed: z.number().int().min(0).max(2 ** 31).default(7),
          })
          .strict(),
        annotations: PURE,
        execution: { resourceClass: "inline" },
        capabilities: () => [],
        run: async (input) => {
          const plan = shake(input.atSec, input.durationSec, input.amplitude, input.frequencyHz, input.rotationDeg, input.decay, input.seed);
          const ops: Op[] = [
            { track: input.track, start: input.start, prop: "scale", mode: "rel", keys: plan.scale },
            { track: input.track, start: input.start, prop: "position", mode: "rel", keys: plan.position },
          ];
          if (plan.rotation.length) ops.push({ track: input.track, start: input.start, prop: "rotation", mode: "rel", keys: plan.rotation });
          return { content: [text(summary(ops))], structured: { ops } };
        },
      }),
    ],
  }),
});

export { ease, kenBurns, planZooms, sampleKeys, shake } from "./planner.js";
