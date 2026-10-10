/**
 * OCR engines.
 * - Windows: the built-in Windows.Media.Ocr engine through Windows PowerShell 5.1 (WinRT). Nothing to
 *   install; languages are the OCR language packs installed in Windows settings.
 * - Tesseract: used on other systems, or on Windows for languages Windows OCR lacks (e.g. "uzb",
 *   "uzb_cyrl" traineddata).
 * Both return lines with word boxes in image pixels.
 */
import path from "node:path";
import { ValidationError } from "@lmp/core";
import { locateBinary, runProcess } from "@lmp/toolkit";

export interface OcrWord {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly confidence: number | null;
}

export interface OcrLine {
  readonly text: string;
  readonly words: readonly OcrWord[];
}

export interface OcrResult {
  readonly engine: "windows" | "tesseract";
  readonly language: string;
  readonly text: string;
  readonly lines: readonly OcrLine[];
}

export interface EngineSettings {
  readonly powershellPath?: string | undefined;
  readonly tesseractPath?: string | undefined;
  readonly tessdataDir?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Windows.Media.Ocr

export const WINDOWS_OCR_SCRIPT = `
$ErrorActionPreference = 'Stop'
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
function Out-Json($o) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Depth 6 -Compress)))) }
if ($req.op -eq 'languages') {
  Out-Json @{ languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }); maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension }
  exit 0
}
if ($req.language) {
  $lang = New-Object Windows.Globalization.Language($req.language)
  if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) { [Console]::Error.Write("NO_LANGUAGE"); exit 4 }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
} else {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) { [Console]::Error.Write("NO_LANGUAGE"); exit 4 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($req.path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} finally { $stream.Dispose() }
$lines = @($result.Lines | ForEach-Object {
  @{ text = $_.Text; words = @($_.Words | ForEach-Object { @{ text = $_.Text; x = [int]$_.BoundingRect.X; y = [int]$_.BoundingRect.Y; width = [int]$_.BoundingRect.Width; height = [int]$_.BoundingRect.Height } }) }
})
Out-Json @{ language = $engine.RecognizerLanguage.LanguageTag; lines = $lines }
`;

async function powershell(settings: EngineSettings): Promise<string> {
  const configKey = "tools.settings.ocr.powershellPath";
  if (settings.powershellPath) return locateBinary("powershell", { configured: settings.powershellPath, configKey, platform: "win32" });
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  return locateBinary("powershell", { configured: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), configKey, platform: "win32" });
}

export class LanguageUnavailableError extends ValidationError {}

async function windowsCall(settings: EngineSettings, request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const ps = await powershell(settings);
  const r = await runProcess(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_OCR_SCRIPT, "utf16le").toString("base64")], {
    label: "Windows OCR",
    signal,
    input: Buffer.from(JSON.stringify(request), "utf8").toString("base64"),
    okExitCodes: [0, 4],
    maxOutputBytes: 32 * 1024 * 1024,
  });
  if (r.exitCode === 4) throw new LanguageUnavailableError(`Windows OCR has no language pack for "${String(request["language"] ?? "your profile languages")}". Add it in Settings → Time & language → Language, or install Tesseract with that language.`);
  return JSON.parse(Buffer.from(r.stdout.trim(), "base64").toString("utf8")) as Record<string, unknown>;
}

/** PowerShell's ConvertTo-Json turns one-element arrays into objects; normalise. */
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v === null || v === undefined ? [] : [v as T]);

export async function windowsOcr(settings: EngineSettings, file: string, language: string | undefined, signal: AbortSignal): Promise<OcrResult> {
  const raw = await windowsCall(settings, { op: "recognize", path: file, ...(language ? { language } : {}) }, signal);
  const lines = arr<{ text: string; words: unknown }>(raw["lines"]).map((l) => ({
    text: l.text,
    words: arr<Omit<OcrWord, "confidence">>(l.words).map((w) => ({ ...w, confidence: null })),
  }));
  return { engine: "windows", language: String(raw["language"] ?? language ?? ""), text: lines.map((l) => l.text).join("\n"), lines };
}

export async function windowsLanguages(settings: EngineSettings, signal: AbortSignal): Promise<{ languages: string[]; maxDimension: number }> {
  const raw = await windowsCall(settings, { op: "languages" }, signal);
  return { languages: arr<string>(raw["languages"]), maxDimension: Number(raw["maxDimension"] ?? 0) };
}

// ---------------------------------------------------------------------------------------------
// Tesseract

const tesseractBin = (settings: EngineSettings) => locateBinary("tesseract", { configured: settings.tesseractPath, configKey: "tools.settings.ocr.tesseractPath" });

const tessEnv = (settings: EngineSettings): Record<string, string> => (settings.tessdataDir ? { TESSDATA_PREFIX: settings.tessdataDir } : {});

/** Parses `tesseract … tsv` output into lines of words. */
export function parseTesseractTsv(tsv: string): OcrLine[] {
  const rows = tsv.split(/\r?\n/).slice(1).map((l) => l.split("\t"));
  const lines = new Map<string, OcrWord[]>();
  for (const r of rows) {
    if (r.length < 12 || r[0] !== "5") continue;
    const word = (r[11] ?? "").trim();
    if (!word) continue;
    const key = `${r[2]}.${r[3]}.${r[4]}`;
    const conf = Number(r[10]);
    const list = lines.get(key) ?? [];
    list.push({ text: word, x: Number(r[6]), y: Number(r[7]), width: Number(r[8]), height: Number(r[9]), confidence: Number.isFinite(conf) && conf >= 0 ? Math.round(conf * 10) / 10 : null });
    lines.set(key, list);
  }
  return [...lines.values()].map((words) => ({ text: words.map((w) => w.text).join(" "), words }));
}

export async function tesseractLanguages(settings: EngineSettings, signal: AbortSignal): Promise<string[]> {
  const r = await runProcess(await tesseractBin(settings), ["--list-langs"], { signal, label: "tesseract", env: tessEnv(settings) });
  return (r.stdout + "\n" + r.stderr).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z_]+$/i.test(l) && l !== "osd");
}

/** Maps ISO-639-1 codes to Tesseract language names. */
export function tesseractLanguage(language: string | undefined): string {
  if (!language) return "eng";
  const map: Record<string, string> = { en: "eng", ru: "rus", uz: "uzb", "uz-latn": "uzb", "uz-cyrl": "uzb_cyrl", tr: "tur", kk: "kaz", ky: "kir", tg: "tgk", de: "deu", fr: "fra", es: "spa", it: "ita", ar: "ara", fa: "fas", zh: "chi_sim", ja: "jpn", ko: "kor" };
  return language.split("+").map((l) => map[l.toLowerCase()] ?? l).join("+");
}

export async function tesseractOcr(settings: EngineSettings, file: string, language: string | undefined, signal: AbortSignal): Promise<OcrResult> {
  const lang = tesseractLanguage(language);
  const installed = await tesseractLanguages(settings, signal);
  const missing = lang.split("+").filter((l) => !installed.includes(l));
  if (missing.length) throw new LanguageUnavailableError(`Tesseract has no "${missing.join(", ")}" language data. Installed: ${installed.join(", ") || "none"}.`);
  const r = await runProcess(await tesseractBin(settings), [file, "stdout", "-l", lang, "--psm", "3", "tsv"], { signal, label: "tesseract", env: tessEnv(settings), maxOutputBytes: 32 * 1024 * 1024 });
  const lines = parseTesseractTsv(r.stdout);
  return { engine: "tesseract", language: lang, text: lines.map((l) => l.text).join("\n"), lines };
}
