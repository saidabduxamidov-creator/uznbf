/**
 * Subtitle cues: parsing and writing SRT/WebVTT, and turning raw speech segments into readable
 * captions (line length, line count, duration limits, balanced line breaks).
 */
export interface Cue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface ReadabilityOptions {
  readonly maxChars: number;
  readonly maxLines: number;
  readonly maxDurationSec: number;
  readonly minDurationSec: number;
}

export const DEFAULT_READABILITY: ReadabilityOptions = { maxChars: 42, maxLines: 2, maxDurationSec: 6, minDurationSec: 0.8 };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatTimestamp(seconds: number, format: "srt" | "vtt"): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${format === "srt" ? "," : "."}${pad(ms % 1000, 3)}`;
}

export function parseTimestamp(value: string): number {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*$/.exec(value);
  if (!m) return Number.NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? "0").padEnd(3, "0")) / 1000;
}

/** Parses SRT or WebVTT (BOM, CRLF, missing indexes, cue settings and styling tags tolerated). */
export function parseSubtitles(content: string): Cue[] {
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [from, rest] = (lines[at] as string).split("-->");
    const to = (rest ?? "").trim().split(/\s+/)[0] ?? "";
    const start = parseTimestamp(from ?? "");
    const end = parseTimestamp(to);
    const body = lines.slice(at + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function toSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.start, "srt")} --> ${formatTimestamp(c.end, "srt")}\n${c.text}\n`).join("\n");
}

export function toVtt(cues: readonly Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${formatTimestamp(c.start, "vtt")} --> ${formatTimestamp(c.end, "vtt")}\n${c.text}\n`).join("\n")}`;
}

/** Breaks text into at most `maxLines` lines of about equal length (never splitting words). */
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const total = words.join(" ").length;
  if (total <= maxChars) return [words.join(" ")];
  for (let lines = 2; lines <= maxLines; lines++) {
    const target = Math.ceil(total / lines);
    const out: string[] = [];
    let current = "";
    for (const w of words) {
      const next = current ? `${current} ${w}` : w;
      if (current && next.length > target && out.length < lines - 1) {
        out.push(current);
        current = w;
      } else {
        current = next;
      }
    }
    out.push(current);
    if (out.every((l) => l.length <= maxChars)) return out;
  }
  return null;
}

/**
 * Splits timed segments into readable cues. Long segments are split at word boundaries; time is
 * distributed in proportion to characters, which tracks speech closely enough for captions.
 */
export function buildCues(segments: readonly Cue[], options: ReadabilityOptions = DEFAULT_READABILITY): Cue[] {
  const out: Cue[] = [];
  const capacity = options.maxChars * options.maxLines;
  for (const seg of segments) {
    const words = seg.text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!words.length || seg.end <= seg.start) continue;
    const chunks: string[][] = [];
    let current: string[] = [];
    for (const w of words) {
      const candidate = [...current, w].join(" ");
      if (current.length && (candidate.length > capacity || !wrapLines(candidate, options.maxChars, options.maxLines))) {
        chunks.push(current);
        current = [w];
      } else {
        current.push(w);
      }
    }
    if (current.length) chunks.push(current);
    // Respect the maximum duration by splitting further when a chunk would stay on screen too long.
    const totalChars = words.join(" ").length;
    const perChar = (seg.end - seg.start) / Math.max(1, totalChars);
    const refined: string[][] = [];
    for (const chunk of chunks) {
      const dur = chunk.join(" ").length * perChar;
      if (dur > options.maxDurationSec && chunk.length > 1) {
        const parts = Math.ceil(dur / options.maxDurationSec);
        const size = Math.ceil(chunk.length / parts);
        for (let i = 0; i < chunk.length; i += size) refined.push(chunk.slice(i, i + size));
      } else {
        refined.push(chunk);
      }
    }
    let t = seg.start;
    for (const [i, chunk] of refined.entries()) {
      const textValue = chunk.join(" ");
      const end = i === refined.length - 1 ? seg.end : Math.min(seg.end, t + (textValue.length + 1) * perChar);
      const lines = wrapLines(textValue, options.maxChars, options.maxLines) ?? [textValue];
      out.push({ start: round(t), end: round(end), text: lines.join("\n") });
      t = end;
    }
  }
  // Enforce minimum duration without overlapping the next cue.
  return out.map((c, i) => {
    const next = out[i + 1];
    const wanted = Math.max(c.end, c.start + options.minDurationSec);
    return { ...c, end: round(next ? Math.min(wanted, next.start) : wanted) };
  });
}

export type CaseStyle = "none" | "upper" | "lower" | "sentence";

export function applyCase(text: string, style: CaseStyle, locale = "uz"): string {
  if (style === "upper") return text.toLocaleUpperCase(locale);
  if (style === "lower") return text.toLocaleLowerCase(locale);
  if (style === "sentence") {
    const lower = text.toLocaleLowerCase(locale);
    return lower.replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toLocaleUpperCase(locale));
  }
  return text;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
