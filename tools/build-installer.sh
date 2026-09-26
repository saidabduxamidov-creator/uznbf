#!/usr/bin/env bash
# premiere-gemini-plugin/ papkasidan GeminiCut-Setup.bat ni qayta yig'adi.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(zip -qrX "$tmp/payload.zip" premiere-gemini-plugin)
size=$(stat -c %s "$tmp/payload.zip")
{
  sed "s/@SIZE@/$size/" tools/header.bat
  base64 -w 64 "$tmp/payload.zip"
} | sed 's/\r$//; s/$/\r/' > GeminiCut-Setup.bat
echo "GeminiCut-Setup.bat yaratildi (payload: $size bayt)"
