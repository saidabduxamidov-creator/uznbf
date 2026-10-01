#!/usr/bin/env bash
# DaVinci Resolve uchun bitta faylli GeminiCut-Resolve-Setup.bat yig'adi.
# Interfeys premiere-gemini-plugin/client dan olinadi (umumiy), Resolve'ga xos qism -
# davinci-gemini-plugin/ (main.js, host.js, bridge.js, manifest.xml).
#   ./tools/build-resolve.sh
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(sed -n 's/^const VERSION = "\([^"]*\)";/\1/p' davinci-gemini-plugin/host.js)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
dist="$tmp/GeminiCut"
mkdir -p "$dist"

if LC_ALL=C grep -nP '[^\x00-\x7F]' tools/header-resolve.bat; then
  echo "XATO: tools/header-resolve.bat ichida ASCII bo'lmagan belgilar bor" >&2
  exit 1
fi

# 1) Resolve qismi
for f in manifest.xml package.json main.js host.js; do
  sed "s/@VERSION@/$version/g" "davinci-gemini-plugin/$f" > "$dist/$f"
done

# 2) Umumiy interfeys: cep.js o'rniga bridge.js, matnlarda Premiere -> Resolve
cp -r premiere-gemini-plugin/client "$dist/client"
rm -f "$dist/client/js/cep.js"
cp davinci-gemini-plugin/bridge.js "$dist/client/js/bridge.js"
sed -i 's#js/cep.js#js/bridge.js#' "$dist/client/index.html"
find "$dist/client" -type f \( -name '*.html' -o -name '*.js' \) ! -name bridge.js -print0 | xargs -0 sed -i \
  -e 's/Premiere Pro 2022-202[0-9]/DaVinci Resolve Studio 20/g' \
  -e 's/Adobe Premiere Pro/DaVinci Resolve/g' \
  -e 's/Premiere Pro/DaVinci Resolve/g' \
  -e 's/Premiere/Resolve/g'
sed -i -e "s#<span id=\"ver\">[^<]*</span>#<span id=\"ver\">$version</span>#" \
  -e "s#<span class=\"brand-version\">[^<]*</span>#<span class=\"brand-version\">${version%.*} \\&middot; RESOLVE</span>#" "$dist/client/index.html"
if grep -rn "Premiere" "$dist/client" --include='*.js' --include='*.html' | grep -v "/bridge.js:"; then echo "XATO: interfeysda Premiere so'zi qolib ketdi" >&2; exit 1; fi

# 3) Arxiv va .bat
(cd "$tmp" && find GeminiCut -type f | LC_ALL=C sort | zip -qX -@ payload.zip)
sha=$(sha256sum "$tmp/payload.zip" | cut -d' ' -f1 | tr 'a-f' 'A-F')
size=$(stat -c %s "$tmp/payload.zip")
{
  sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$sha/g" tools/header-resolve.bat
  base64 -w 76 "$tmp/payload.zip"
} | sed 's/\r$//; s/$/\r/' > GeminiCut-Resolve-Setup.bat

# Sinovlar uchun yig'ilgan nusxa
rm -rf build/resolve && mkdir -p build/resolve && cp -r "$dist" build/resolve/
echo "GeminiCut-Resolve-Setup.bat $version tayyor: payload $size bayt, SHA-256 $sha"
