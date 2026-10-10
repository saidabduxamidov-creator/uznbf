/**
 * Pure motion planning: easing curves, eased keyframe sampling, Ken Burns moves, camera shake and
 * speech-driven punch-in zoom plans. Output feeds editor.apply_motion / editor.apply_zooms.
 */
export type Easing =
  | "linear"
  | "ease_in"
  | "ease_out"
  | "ease_in_out"
  | "ease_out_back"
  | "ease_out_elastic"
  | "ease_out_bounce"
  | "hold";

export const EASINGS: readonly Easing[] = ["linear", "ease_in", "ease_out", "ease_in_out", "ease_out_back", "ease_out_elastic", "ease_out_bounce", "hold"];

function bounce(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

export function ease(kind: Easing, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (kind) {
    case "linear":
      return x;
    case "ease_in":
      return x * x * x;
    case "ease_out":
      return 1 - (1 - x) ** 3;
    case "ease_in_out":
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case "ease_out_back": {
      const c1 = 1.70158;
      return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2;
    }
    case "ease_out_elastic":
      return x === 0 || x === 1 ? x : 2 ** (-10 * x) * Math.sin(((x * 10 - 0.75) * 2 * Math.PI) / 3) + 1;
    case "ease_out_bounce":
      return bounce(x);
    case "hold":
      return x < 1 ? 0 : 1;
  }
}

export type Value = number | readonly [number, number];
export type Key = readonly [number, Value];

// `|| 0` folds -0 into 0 so plans compare and serialise cleanly.
const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits || 0;

function lerp(a: Value, b: Value, f: number): Value {
  if (typeof a === "number" && typeof b === "number") return round(a + (b - a) * f);
  if (Array.isArray(a) && Array.isArray(b)) return [round((a[0] as number) + ((b[0] as number) - (a[0] as number)) * f), round((a[1] as number) + ((b[1] as number) - (a[1] as number)) * f)];
  throw new TypeError("from and to must both be numbers or both be [x, y] pairs");
}

/**
 * Samples an eased move as keyframes. Smooth curves (in/out cubic) are reproduced exactly by the
 * editor's own Bezier interpolation from a handful of keys; overshooting curves need denser keys,
 * so the sample count follows the curve.
 */
export function sampleKeys(from: Value, to: Value, startSec: number, durationSec: number, easing: Easing, fps: number, maxKeys = 60): Key[] {
  if (durationSec <= 0) return [[round(startSec), to]];
  if (easing === "hold") return [[round(startSec), from], [round(startSec + durationSec), to]];
  const density = easing === "linear" ? 1 : easing === "ease_out_elastic" || easing === "ease_out_bounce" ? 24 : easing === "ease_out_back" ? 12 : 6;
  const frames = Math.max(1, Math.round(durationSec * fps));
  const steps = Math.max(1, Math.min(maxKeys - 1, frames, Math.ceil(durationSec * density)));
  const keys: Key[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    keys.push([round(startSec + durationSec * t), lerp(from, to, ease(easing, t))]);
  }
  return keys;
}

export type KenBurnsDirection = "in" | "out" | "left" | "right" | "up" | "down" | "in_left" | "in_right";

export interface KenBurnsPlan {
  readonly scale: Key[];
  readonly position: Key[];
}

/**
 * Ken Burns move for a clip. Scale is percent of the clip's current scale; position is an offset
 * as a fraction of the frame. Pans stay inside the zoomed image so no border is ever visible:
 * at scale s the image may move by (s - 100) / 200 of the frame in each direction.
 */
export function kenBurns(startSec: number, durationSec: number, direction: KenBurnsDirection, strength: number, easing: Easing, fps: number): KenBurnsPlan {
  const zoomed = 100 + strength;
  const travel = round(((zoomed - 100) / 200) * 0.9, 4);
  const end = startSec + durationSec;
  const scaleKeys = (a: number, b: number) => sampleKeys(a, b, startSec, durationSec, easing, fps, 12);
  const panKeys = (a: [number, number], b: [number, number]) => sampleKeys(a, b, startSec, durationSec, easing, fps, 12);
  switch (direction) {
    case "in":
      return { scale: scaleKeys(100, zoomed), position: [] };
    case "out":
      return { scale: scaleKeys(zoomed, 100), position: [] };
    case "left":
      return { scale: [[round(startSec), zoomed], [round(end), zoomed]], position: panKeys([travel, 0], [-travel, 0]) };
    case "right":
      return { scale: [[round(startSec), zoomed], [round(end), zoomed]], position: panKeys([-travel, 0], [travel, 0]) };
    case "up":
      return { scale: [[round(startSec), zoomed], [round(end), zoomed]], position: panKeys([0, travel], [0, -travel]) };
    case "down":
      return { scale: [[round(startSec), zoomed], [round(end), zoomed]], position: panKeys([0, -travel], [0, travel]) };
    case "in_left":
      return { scale: scaleKeys(100, zoomed), position: panKeys([0, 0], [-travel, 0]) };
    case "in_right":
      return { scale: scaleKeys(100, zoomed), position: panKeys([0, 0], [travel, 0]) };
  }
}

/** Deterministic pseudo-random generator (mulberry32) so the same seed gives the same shake. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ShakePlan {
  readonly position: Key[];
  readonly rotation: Key[];
  readonly scale: Key[];
}

/**
 * Camera shake: smoothed noise with a decay envelope. Amplitude is a fraction of the frame; the clip
 * is scaled up just enough to hide the edges while it moves.
 */
export function shake(startSec: number, durationSec: number, amplitude: number, frequencyHz: number, rotationDeg: number, decay: boolean, seed: number): ShakePlan {
  const random = rng(seed);
  const count = Math.max(2, Math.round(durationSec * frequencyHz));
  const position: Key[] = [];
  const rotation: Key[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const envelope = i === 0 || i === count ? 0 : decay ? (1 - t) ** 1.5 : 1;
    const time = round(startSec + durationSec * t);
    position.push([time, [round((random() * 2 - 1) * amplitude * envelope), round((random() * 2 - 1) * amplitude * envelope)]]);
    if (rotationDeg > 0) rotation.push([time, round((random() * 2 - 1) * rotationDeg * envelope, 3)]);
  }
  const cover = round(100 + amplitude * 200 * 1.1 + rotationDeg * 1.5, 2);
  return {
    position,
    rotation,
    scale: [[round(startSec), 100], [round(startSec + 0.001), cover], [round(startSec + durationSec - 0.001), cover], [round(startSec + durationSec), 100]],
  };
}

export interface SpeechSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface ZoomPlanOptions {
  /** Average seconds between punch-ins. */
  readonly everySec: number;
  /** Minimum seconds between two punch-ins. */
  readonly minGapSec: number;
  readonly scale: number;
  /** Extra scale for emphasised lines. */
  readonly emphasisScale: number;
  readonly holdSec: number;
  /** Words that always deserve a punch-in. */
  readonly keywords: readonly string[];
  readonly maxZooms: number;
}

export interface PlannedZoom {
  readonly time: number;
  readonly scale: number;
  readonly holdSec: number;
  readonly reason: string;
}

const norm = (s: string) => s.toLocaleLowerCase().normalize("NFKC").replace(/[ʻʼ‘’`']/g, "'");

/**
 * Picks punch-in moments from speech: lines with keywords or strong punctuation first, then
 * sentence starts to keep a steady rhythm. Zooms never overlap, alternate in size, and stay inside
 * the speech they emphasise.
 */
export function planZooms(segments: readonly SpeechSegment[], options: ZoomPlanOptions): PlannedZoom[] {
  const keywords = options.keywords.map(norm).filter(Boolean);
  const sorted = [...segments].filter((s) => s.end > s.start && s.text.trim()).sort((a, b) => a.start - b.start);
  const candidates = sorted.map((s, i) => {
    const t = norm(s.text);
    const hit = keywords.find((k) => t.includes(k));
    const strong = /[!?]\s*$/.test(s.text.trim());
    const startsSentence = i === 0 || /[.!?…]\s*$/.test(sorted[i - 1]?.text.trim() ?? "") || s.start - (sorted[i - 1]?.end ?? 0) > 0.6;
    const score = (hit ? 3 : 0) + (strong ? 2 : 0) + (startsSentence ? 1 : 0) + Math.min(1, (s.end - s.start) / 4);
    const reason = hit ? `keyword "${hit}"` : strong ? "emphatic line" : startsSentence ? "new sentence" : "rhythm";
    return { s, score, emphasis: Boolean(hit || strong), reason };
  });
  const chosen: { s: SpeechSegment; emphasis: boolean; reason: string }[] = [];
  const overlaps = (start: number) => chosen.some((c) => Math.abs(c.s.start - start) < options.minGapSec);
  // Emphasis first, then fill the rhythm wherever the gap since the last zoom exceeds everySec.
  for (const c of candidates.filter((x) => x.emphasis).sort((a, b) => b.score - a.score)) {
    if (chosen.length >= options.maxZooms) break;
    if (!overlaps(c.s.start)) chosen.push(c);
  }
  chosen.sort((a, b) => a.s.start - b.s.start);
  for (const c of candidates) {
    if (chosen.length >= options.maxZooms) break;
    if (overlaps(c.s.start)) continue;
    const before = [...chosen].reverse().find((x) => x.s.start < c.s.start);
    const after = chosen.find((x) => x.s.start > c.s.start);
    const gapBefore = before ? c.s.start - before.s.start : c.s.start + options.everySec;
    const gapAfter = after ? after.s.start - c.s.start : Number.POSITIVE_INFINITY;
    if (gapBefore >= options.everySec && gapAfter >= options.minGapSec) {
      chosen.push(c);
      chosen.sort((a, b) => a.s.start - b.s.start);
    }
  }
  let alternate = false;
  return chosen.map((c, i) => {
    const next = chosen[i + 1]?.s.start ?? Number.POSITIVE_INFINITY;
    const hold = Math.max(0.5, Math.min(options.holdSec, c.s.end - c.s.start + 0.3, next - c.s.start - 0.2));
    alternate = !alternate;
    const base = c.emphasis ? options.emphasisScale : alternate ? options.scale : Math.round(100 + (options.scale - 100) * 0.7);
    return { time: round(c.s.start, 3), scale: Math.max(102, Math.min(160, base)), holdSec: round(hold, 2), reason: c.reason };
  });
}
