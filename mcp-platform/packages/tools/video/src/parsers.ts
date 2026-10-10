/**
 * Parsers for ffmpeg filter diagnostics (silencedetect, showinfo, ebur128). Kept pure and separate
 * so they are unit-tested against real ffmpeg output samples.
 */
export interface Segment {
  readonly start: number;
  readonly end: number;
}

export class SilenceCollector {
  readonly silences: Segment[] = [];
  private openStart: number | null = null;

  line(line: string): void {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start?.[1]) {
      this.openStart = Math.max(0, Number(start[1]));
      return;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end?.[1] && this.openStart !== null) {
      this.silences.push({ start: this.openStart, end: Number(end[1]) });
      this.openStart = null;
    }
  }

  /** Closes a silence still open at end of stream. */
  finish(totalSec: number): Segment[] {
    if (this.openStart !== null && totalSec > this.openStart) this.silences.push({ start: this.openStart, end: totalSec });
    this.openStart = null;
    return this.silences;
  }
}

/** Speech (non-silent) segments: the complement of silences, shrunk/grown by padding, merged. */
export function speechSegments(silences: readonly Segment[], totalSec: number, padSec: number, minSpeechSec: number): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) out.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < totalSec) out.push({ start: cursor, end: totalSec });
  const padded = out.map((s) => ({ start: Math.max(0, s.start - padSec), end: Math.min(totalSec, s.end + padSec) }));
  const merged: Segment[] = [];
  for (const s of padded) {
    const last = merged.at(-1);
    if (last && s.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, s.end) };
    else merged.push(s);
  }
  return merged.filter((s) => s.end - s.start >= minSpeechSec).map((s) => ({ start: round3(s.start), end: round3(s.end) }));
}

/** pts_time values from the showinfo filter (scene detection). */
export function parseShowinfoTime(line: string): number | null {
  if (!line.includes("Parsed_showinfo")) return null;
  const m = /pts_time:\s*(-?[\d.]+)/.exec(line);
  return m?.[1] ? Number(m[1]) : null;
}

export interface LoudnessSummary {
  readonly integratedLufs: number | null;
  readonly loudnessRangeLu: number | null;
  readonly truePeakDbfs: number | null;
  readonly thresholdLufs: number | null;
}

/** Parses the "Summary:" block that ebur128 prints at the end. */
export function parseEbur128Summary(stderr: readonly string[]): LoudnessSummary {
  const at = stderr.findLastIndex((l) => /Summary:/.test(l));
  const block = at >= 0 ? stderr.slice(at) : [];
  const grab = (section: RegExp, field: RegExp): number | null => {
    const start = block.findIndex((l) => section.test(l));
    if (start < 0) return null;
    for (const line of block.slice(start + 1, start + 6)) {
      const m = field.exec(line);
      if (m?.[1]) return Number(m[1]);
    }
    return null;
  };
  return {
    integratedLufs: grab(/Integrated loudness:/, /^\s*I:\s*(-?[\d.]+)\s*LUFS/),
    thresholdLufs: grab(/Integrated loudness:/, /^\s*Threshold:\s*(-?[\d.]+)\s*LUFS/),
    loudnessRangeLu: grab(/Loudness range:/, /^\s*LRA:\s*(-?[\d.]+)\s*LU/),
    truePeakDbfs: grab(/True peak:/, /^\s*Peak:\s*(-?[\d.]+)\s*dBFS/),
  };
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
