/**
 * whisper.cpp integration (fully offline). Runs whisper-cli on 16 kHz mono WAV and parses its JSON
 * output (-oj). Progress comes from -pp ("progress = NN%") on stderr.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENV_PREFIX, ExternalProcessError, NotFoundError } from "@lmp/core";
import { BIN_DIR_ENV, locateBinary, runProcess } from "@lmp/toolkit";
import type { Cue } from "./cues.js";

export const MODELS_DIR_ENV = `${ENV_PREFIX}MODELS_DIR`;

export interface WhisperSettings {
  readonly whisperPath?: string | undefined;
  readonly modelsDir?: string | undefined;
  readonly defaultModel: string;
  readonly threads?: number | undefined;
}

export function modelsDirectory(settings: WhisperSettings, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  if (settings.modelsDir) return settings.modelsDir;
  if (env[MODELS_DIR_ENV]) return env[MODELS_DIR_ENV];
  const bin = env[BIN_DIR_ENV];
  return bin ? path.join(path.dirname(bin), "models") : undefined;
}

export interface ModelInfo {
  readonly name: string;
  readonly file: string;
  readonly bytes: number;
}

export async function listModels(dir: string | undefined): Promise<ModelInfo[]> {
  if (!dir) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: ModelInfo[] = [];
  for (const n of names) {
    const m = /^ggml-(.+)\.bin$/.exec(n);
    if (!m?.[1]) continue;
    const file = path.join(dir, n);
    const s = await stat(file).catch(() => undefined);
    if (s?.isFile()) out.push({ name: m[1], file, bytes: s.size });
  }
  return out.sort((a, b) => a.bytes - b.bytes);
}

export async function resolveModel(settings: WhisperSettings, requested: string | undefined): Promise<ModelInfo> {
  const dir = modelsDirectory(settings);
  const models = await listModels(dir);
  const wanted = requested ?? settings.defaultModel;
  const found = models.find((m) => m.name === wanted) ?? (requested ? undefined : models.find((m) => !m.name.startsWith("for-tests")) ?? models[0]);
  if (!found) {
    throw new NotFoundError(
      `Speech model "${wanted}" is not installed${dir ? ` in ${dir}` : ""}. Install models with the platform installer or set tools.settings.subtitles.modelsDir. Available: ${models.map((m) => m.name).join(", ") || "none"}.`,
    );
  }
  return found;
}

export interface TranscribeOptions {
  readonly wav: string;
  readonly model: string;
  readonly language: string;
  readonly translate: boolean;
  readonly prompt?: string | undefined;
  readonly outBase: string;
  readonly threads: number;
  readonly signal: AbortSignal;
  readonly onProgress: (percent: number) => void;
}

export interface Transcript {
  readonly language: string | null;
  readonly segments: Cue[];
}

export async function runWhisper(executable: string, options: TranscribeOptions): Promise<Transcript> {
  const args = [
    "-m", options.model, "-f", options.wav, "-l", options.language, "-t", String(options.threads),
    "-oj", "-of", options.outBase, "-pp", "-np",
    ...(options.translate ? ["-tr"] : []),
    ...(options.prompt ? ["--prompt", options.prompt] : []),
  ];
  await runProcess(executable, args, {
    label: "whisper",
    signal: options.signal,
    maxOutputBytes: 2 * 1024 * 1024,
    onStderrLine: (line) => {
      const m = /progress\s*=\s*(\d+)%/.exec(line);
      if (m?.[1]) options.onProgress(Math.min(100, Number(m[1]))); // whisper can report > 100 %
    },
  });
  let json: unknown;
  try {
    json = JSON.parse(await readFile(`${options.outBase}.json`, "utf8"));
  } catch (error) {
    throw new ExternalProcessError("whisper did not produce a readable transcript.", { cause: error });
  }
  return parseWhisperJson(json);
}

export function parseWhisperJson(json: unknown): Transcript {
  const root = (json ?? {}) as { result?: { language?: unknown }; transcription?: unknown };
  const items = Array.isArray(root.transcription) ? (root.transcription as Array<Record<string, unknown>>) : [];
  const segments: Cue[] = [];
  for (const item of items) {
    const offsets = (item["offsets"] ?? {}) as { from?: unknown; to?: unknown };
    const text = typeof item["text"] === "string" ? item["text"].replace(/\[(BLANK_AUDIO|MUSIC|Music|music)\]|\(.*?\)/g, "").trim() : "";
    const from = Number(offsets.from) / 1000;
    const to = Number(offsets.to) / 1000;
    if (text && Number.isFinite(from) && Number.isFinite(to) && to > from) segments.push({ start: from, end: to, text });
  }
  return { language: typeof root.result?.language === "string" ? root.result.language : null, segments };
}

export function defaultThreads(): number {
  return Math.max(1, Math.min(8, os.availableParallelism() - 1));
}

export function locateWhisper(settings: WhisperSettings): Promise<string> {
  return locateBinary("whisper-cli", { configured: settings.whisperPath, configKey: "tools.settings.subtitles.whisperPath" });
}
