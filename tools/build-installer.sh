#!/usr/bin/env bash
# premiere-gemini-plugin/ papkasidan bitta faylli GeminiCut-Setup.bat yig'adi.
#   ./tools/build-installer.sh
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' premiere-gemini-plugin/CSXS/manifest.xml)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Faqat ASCII bo'lishi shart (cmd.exe kodlash muammolari bo'lmasligi uchun)
if LC_ALL=C grep -nP '[^\x00-\x7F]' tools/header.bat; then
  echo "XATO: tools/header.bat ichida ASCII bo'lmagan belgilar bor" >&2
  exit 1
fi

# host.jsx ExtendScript tomonidan tizim kodlashida o'qilishi mumkin - faqat ASCII (\uXXXX)
if LC_ALL=C grep -nP '[^\x00-\x7F]' premiere-gemini-plugin/host/host.jsx; then
  echo "XATO: host.jsx ichida ASCII bo'lmagan belgilar bor - \\uXXXX ko'rinishida yozing" >&2
  exit 1
fi

# Barqaror arxiv: fayllar tartiblangan, qo'shimcha atributlarsiz
# tests/ (sinovlar, skrinshotlar) foydalanuvchi paketiga kirmaydi
(find premiere-gemini-plugin -type f -not -path 'premiere-gemini-plugin/tests/*' | LC_ALL=C sort | zip -qX -@ "$tmp/payload.zip")
sha=$(sha256sum "$tmp/payload.zip" | cut -d' ' -f1 | tr 'a-f' 'A-F')
size=$(stat -c %s "$tmp/payload.zip")

{
  sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$sha/g" tools/header.bat
  base64 -w 76 "$tmp/payload.zip"
} | sed 's/\r$//; s/$/\r/' > GeminiCut-Setup.bat

echo "GeminiCut-Setup.bat $version tayyor: payload $size bayt, SHA-256 $sha"
