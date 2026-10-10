/**
 * System clipboard backends. Each one drives the operating system's own clipboard program without
 * a shell; data crosses process boundaries as base64 or raw bytes, so no text encoding or quoting
 * can corrupt it.
 *
 * - Windows: Windows PowerShell 5.1 (always present) in STA mode with System.Windows.Forms.
 * - macOS: pbcopy/pbpaste for text, osascript for images.
 * - Linux: xclip (X11).
 */
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnsupportedError, ValidationError } from "@lmp/core";
import { locateBinary, runProcess } from "@lmp/toolkit";

export type ImageMime = "image/png" | "image/jpeg";

export interface ClipboardBackend {
  readonly name: string;
  readText(signal: AbortSignal): Promise<string>;
  writeText(value: string, signal: AbortSignal): Promise<void>;
  /** PNG bytes, or null when the clipboard holds no image. */
  readImage(signal: AbortSignal): Promise<Buffer | null>;
  writeImage(file: string, mime: ImageMime, signal: AbortSignal): Promise<void>;
  readFiles(signal: AbortSignal): Promise<string[]>;
  writeFiles(files: readonly string[], signal: AbortSignal): Promise<void>;
}

export interface BackendSettings {
  readonly powershellPath?: string | undefined;
  readonly xclipPath?: string | undefined;
}

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Windows

/**
 * Every script reads its argument as base64 UTF-8 from stdin and writes base64 to stdout. The
 * clipboard can be held open briefly by another application, so operations retry for ~2 s.
 */
const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function In-Text { $b = [Console]::In.ReadToEnd().Trim(); if ($b.Length -eq 0) { return '' }; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
function Out-B64([byte[]]$bytes) { [Console]::Out.Write([Convert]::ToBase64String($bytes)) }
function Retry([scriptblock]$op) {
  for ($i = 0; $i -lt 20; $i++) { try { return & $op } catch [System.Runtime.InteropServices.ExternalException] { Start-Sleep -Milliseconds 100 } }
  [Console]::Error.Write('The clipboard is in use by another application.'); exit 3
}
`;

export const WINDOWS_SCRIPTS = {
  readText: `${PS_PRELUDE}
$t = Retry { [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText) }
if ($null -eq $t) { $t = '' }
Out-B64 ([Text.Encoding]::UTF8.GetBytes($t))`,
  writeText: `${PS_PRELUDE}
$t = In-Text
Retry { if ($t.Length -eq 0) { [Windows.Forms.Clipboard]::Clear() } else { [Windows.Forms.Clipboard]::SetText($t, [Windows.Forms.TextDataFormat]::UnicodeText) } } | Out-Null`,
  readImage: `${PS_PRELUDE}
$img = Retry { [Windows.Forms.Clipboard]::GetImage() }
if ($null -eq $img) { exit 0 }
$ms = New-Object IO.MemoryStream
$img.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
Out-B64 $ms.ToArray()`,
  writeImage: `${PS_PRELUDE}
$p = In-Text
$bytes = [IO.File]::ReadAllBytes($p)
$ms = New-Object IO.MemoryStream(,$bytes)
$img = [Drawing.Image]::FromStream($ms)
Retry { [Windows.Forms.Clipboard]::SetImage($img) } | Out-Null
$img.Dispose()`,
  readFiles: `${PS_PRELUDE}
$list = Retry { [Windows.Forms.Clipboard]::GetFileDropList() }
$joined = ''
if ($null -ne $list) { $joined = [string]::Join([char]10, [string[]]@($list)) }
Out-B64 ([Text.Encoding]::UTF8.GetBytes($joined))`,
  writeFiles: `${PS_PRELUDE}
$sc = New-Object Collections.Specialized.StringCollection
foreach ($p in (In-Text).Split([char]10)) { if ($p.Length -gt 0) { [void]$sc.Add($p) } }
Retry { [Windows.Forms.Clipboard]::SetFileDropList($sc) } | Out-Null`,
} as const;

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function windowsPowerShell(settings: BackendSettings): Promise<string> {
  if (settings.powershellPath) return locateBinary("powershell", { configured: settings.powershellPath, configKey: "tools.settings.clipboard.powershellPath", platform: "win32" });
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  const builtin = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return locateBinary("powershell", { configured: builtin, configKey: "tools.settings.clipboard.powershellPath", platform: "win32" }).catch(() =>
    locateBinary("powershell", { configKey: "tools.settings.clipboard.powershellPath", platform: "win32" }),
  );
}

export function windowsBackend(settings: BackendSettings): ClipboardBackend {
  const run = async (script: keyof typeof WINDOWS_SCRIPTS, signal: AbortSignal, input = "") => {
    const ps = await windowsPowerShell(settings);
    const result = await runProcess(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(WINDOWS_SCRIPTS[script])], {
      label: "PowerShell clipboard",
      signal,
      input: Buffer.from(input, "utf8").toString("base64"),
      maxOutputBytes: Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16,
    });
    if (result.stdoutTruncated) throw new ValidationError("The clipboard content is too large.");
    return Buffer.from(result.stdout.trim(), "base64");
  };
  return {
    name: "windows",
    readText: async (signal) => (await run("readText", signal)).toString("utf8"),
    writeText: async (value, signal) => void (await run("writeText", signal, value)),
    readImage: async (signal) => {
      const bytes = await run("readImage", signal);
      return bytes.length ? bytes : null;
    },
    writeImage: async (file, _mime, signal) => void (await run("writeImage", signal, file)),
    readFiles: async (signal) => (await run("readFiles", signal)).toString("utf8").split("\n").filter(Boolean),
    writeFiles: async (files, signal) => void (await run("writeFiles", signal, files.join("\n"))),
  };
}

// ---------------------------------------------------------------------------------------------
// Linux (X11)

export function linuxBackend(settings: BackendSettings): ClipboardBackend {
  const xclip = () => locateBinary("xclip", { configured: settings.xclipPath, configKey: "tools.settings.clipboard.xclipPath" });
  const targets = async (signal: AbortSignal) => {
    const r = await runProcess(await xclip(), ["-selection", "clipboard", "-o", "-t", "TARGETS"], { signal, okExitCodes: [0, 1], label: "xclip" });
    return r.exitCode === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()) : [];
  };
  const read = async (target: string, signal: AbortSignal) => {
    if (!(await targets(signal)).includes(target)) return null;
    const r = await runProcess(await xclip(), ["-selection", "clipboard", "-o", "-t", target], { signal, maxOutputBytes: MAX_IMAGE_BYTES, label: "xclip" });
    return r.stdoutBytes;
  };
  // xclip forks a child that owns the selection until something else is copied; it keeps any
  // inherited pipe open, so its output is not connected.
  const write = async (target: string, data: Buffer, signal: AbortSignal) => {
    await runProcess(await xclip(), ["-selection", "clipboard", "-i", "-t", target], { signal, input: data, ignoreOutput: true, label: "xclip" });
  };
  return {
    name: "x11",
    readText: async (signal) => (await read("UTF8_STRING", signal))?.toString("utf8") ?? "",
    writeText: (value, signal) => write("UTF8_STRING", Buffer.from(value, "utf8"), signal),
    readImage: (signal) => read("image/png", signal),
    writeImage: async (file, mime, signal) => write(mime, await readFile(file), signal),
    readFiles: async (signal) => {
      const raw = (await read("text/uri-list", signal))?.toString("utf8") ?? "";
      return raw.split(/\r?\n/).filter((l) => l.startsWith("file://")).map((u) => decodeURIComponent(new URL(u).pathname));
    },
    writeFiles: (files, signal) => write("text/uri-list", Buffer.from(files.map((f) => new URL(`file://${f.split("/").map(encodeURIComponent).join("/")}`).href).join("\r\n"), "utf8"), signal),
  };
}

// ---------------------------------------------------------------------------------------------
// macOS

const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function macBackend(): ClipboardBackend {
  const osascript = (lines: readonly string[], signal: AbortSignal) => runProcess("/usr/bin/osascript", lines.flatMap((l) => ["-e", l]), { signal, label: "osascript" });
  return {
    name: "macos",
    readText: async (signal) => (await runProcess("/usr/bin/pbpaste", ["-Prefer", "txt"], { signal, label: "pbpaste", env: { LANG: "en_US.UTF-8" } })).stdout,
    writeText: async (value, signal) => void (await runProcess("/usr/bin/pbcopy", [], { signal, input: value, label: "pbcopy", env: { LANG: "en_US.UTF-8" } })),
    readImage: async (signal) => {
      const file = path.join(os.tmpdir(), `lmp-clip-${process.pid}-${Date.now()}.png`);
      try {
        const r = await runProcess(
          "/usr/bin/osascript",
          ["-e", "try", "-e", "set d to (the clipboard as «class PNGf»)", "-e", "on error", "-e", 'return "none"', "-e", "end try",
            "-e", `set f to open for access (POSIX file ${appleString(file)}) with write permission`, "-e", "write d to f", "-e", "close access f", "-e", 'return "ok"'],
          { signal, label: "osascript" },
        );
        return r.stdout.trim() === "ok" ? await readFile(file) : null;
      } finally {
        await rm(file, { force: true });
      }
    },
    writeImage: async (file, mime, signal) =>
      void (await osascript([`set the clipboard to (read (POSIX file ${appleString(file)}) as ${mime === "image/png" ? "«class PNGf»" : "JPEG picture"})`], signal)),
    readFiles: () => Promise.reject(new UnsupportedError("Reading copied files is not supported on macOS yet.")),
    writeFiles: () => Promise.reject(new UnsupportedError("Copying files to the clipboard is not supported on macOS yet.")),
  };
}

export function systemBackend(settings: BackendSettings, platform: NodeJS.Platform = process.platform): ClipboardBackend {
  if (platform === "win32") return windowsBackend(settings);
  if (platform === "darwin") return macBackend();
  if (platform === "linux") return linuxBackend(settings);
  throw new UnsupportedError(`No clipboard support for ${platform}.`);
}
