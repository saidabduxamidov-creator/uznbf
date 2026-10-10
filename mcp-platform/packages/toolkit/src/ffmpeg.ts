/**
 * FFmpeg/ffprobe helpers shared by media tool packages: binary discovery, probing with a typed
 * result, and running ffmpeg with machine-readable progress (-progress pipe:1).
 */
import { ExternalProcessError } from "@lmp/core";
import { locateBinary } from "./binaries.js";
import { runProcess, type ProcessResult } from "./process.js";

export interface FfmpegBinaries {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export interface FfmpegSettings {
  readonly ffmpegPath?: string | undefined;
  readonly ffprobePath?: string | undefined;
}

export async function locateFfmpeg(settings: FfmpegSettings, configPrefix: string): Promise<FfmpegBinaries> {
  const [ffmpeg, ffprobe] = await Promise.all([
    locateBinary("ffmpeg", { configured: settings.ffmpegPath, configKey: `${configPrefix}.ffmpegPath` }),
    locateBinary("ffprobe", { configured: settings.ffprobePath, configKey: `${configPrefix}.ffprobePath` }),
  ]);
  return { ffmpeg, ffprobe };
}

export interface MediaStream {
  readonly index: number;
  readonly type: "video" | "audio" | "subtitle" | "data" | "attachment" | "unknown";
  readonly codec: string | null;
  readonly durationSec: number | null;
  readonly bitRate: number | null;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number | null;
  readonly pixelFormat?: string | null;
  readonly rotation?: number;
  readonly sampleRate?: number | null;
  readonly channels?: number | null;
  readonly channelLayout?: string | null;
  readonly language?: string | null;
}

export interface MediaInfo {
  readonly path: string;
  readonly formatName: string | null;
  readonly durationSec: number | null;
  readonly sizeBytes: number | null;
  readonly bitRate: number | null;
  readonly streams: readonly MediaStream[];
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Parses "30000/1001" style rates. */
export function parseRate(rate: unknown): number | null {
  if (typeof rate !== "string") return null;
  const [a, b] = rate.split("/").map(Number);
  if (a === undefined || !Number.isFinite(a)) return null;
  if (b === undefined) return a;
  if (!Number.isFinite(b) || b === 0) return null;
  return Math.round((a / b) * 1000) / 1000;
}

export function parseProbeJson(json: unknown, filePath: string): MediaInfo {
  const root = (json ?? {}) as Json;
  const format = (root["format"] ?? {}) as Json;
  const rawStreams = Array.isArray(root["streams"]) ? (root["streams"] as Json[]) : [];
  const streams: MediaStream[] = rawStreams.map((s) => {
    const kind = str(s["codec_type"]);
    const type: MediaStream["type"] =
      kind === "video" || kind === "audio" || kind === "subtitle" || kind === "data" || kind === "attachment" ? kind : "unknown";
    const tags = (s["tags"] ?? {}) as Json;
    const base = {
      index: num(s["index"]) ?? 0,
      type,
      codec: str(s["codec_name"]),
      durationSec: num(s["duration"]),
      bitRate: num(s["bit_rate"]),
      language: str(tags["language"]),
    };
    if (type === "video") {
      const sideData = Array.isArray(s["side_data_list"]) ? (s["side_data_list"] as Json[]) : [];
      const rotation = num(tags["rotate"]) ?? num(sideData.find((d) => d["rotation"] !== undefined)?.["rotation"]) ?? 0;
      return {
        ...base,
        width: num(s["width"]) ?? 0,
        height: num(s["height"]) ?? 0,
        fps: parseRate(s["avg_frame_rate"]) || parseRate(s["r_frame_rate"]),
        pixelFormat: str(s["pix_fmt"]),
        rotation,
      };
    }
    if (type === "audio") {
      return { ...base, sampleRate: num(s["sample_rate"]), channels: num(s["channels"]), channelLayout: str(s["channel_layout"]) };
    }
    return base;
  });
  // Attached cover art is reported as a video stream; it is not real video.
  const realVideo = rawStreams.some((s) => s["codec_type"] === "video" && ((s["disposition"] ?? {}) as Json)["attached_pic"] !== 1);
  return {
    path: filePath,
    formatName: str(format["format_name"]),
    durationSec: num(format["duration"]) ?? streams.reduce<number | null>((m, s) => (s.durationSec !== null && (m === null || s.durationSec > m) ? s.durationSec : m), null),
    sizeBytes: num(format["size"]),
    bitRate: num(format["bit_rate"]),
    streams,
    hasVideo: realVideo,
    hasAudio: streams.some((s) => s.type === "audio"),
  };
}

export async function probeMedia(ffprobe: string, filePath: string, signal?: AbortSignal): Promise<MediaInfo> {
  const result = await runProcess(
    ffprobe,
    ["-v", "error", "-hide_banner", "-print_format", "json", "-show_format", "-show_streams", "--", filePath],
    { label: "ffprobe", ...(signal ? { signal } : {}), maxOutputBytes: 8 * 1024 * 1024 },
  );
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch (error) {
    throw new ExternalProcessError("ffprobe returned unreadable output.", { cause: error });
  }
  return parseProbeJson(json, filePath);
}

export interface FfmpegRunOptions {
  readonly signal?: AbortSignal;
  /** Total duration of the processed range, for progress fractions. */
  readonly durationSec?: number | null;
  /** Receives 0..1 progress (monotonic). */
  readonly onProgress?: (fraction: number, processedSec: number) => void;
  readonly onStderrLine?: (line: string) => void;
  readonly maxOutputBytes?: number;
}

/**
 * Runs ffmpeg with -nostdin and machine-readable progress. Callers pass input/filter/output args;
 * this adds "-hide_banner -nostdin -nostats -progress pipe:1" in front.
 */
export function runFfmpeg(ffmpeg: string, args: readonly string[], options: FfmpegRunOptions = {}): Promise<ProcessResult> {
  let last = -1;
  const total = options.durationSec ?? null;
  const report = (seconds: number) => {
    if (!options.onProgress || total === null || total <= 0) return;
    const fraction = Math.max(0, Math.min(1, seconds / total));
    if (fraction > last) {
      last = fraction;
      options.onProgress(fraction, seconds);
    }
  };
  return runProcess(ffmpeg, ["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1", ...args], {
    label: "ffmpeg",
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
    onStdoutLine: (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
      if (m?.[1]) report(Number(m[1]) / 1_000_000);
      else if (line === "progress=end" && total) report(total);
    },
  });
}
