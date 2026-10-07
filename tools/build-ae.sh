#!/usr/bin/env bash
# After Effects uchun bitta faylli GeminiCut-AE-Setup.bat yig'adi.
# Interfeys premiere-gemini-plugin/client dan olinadi (umumiy), After Effects'ga xos qism -
# aftereffects-gemini-plugin/ (CSXS/manifest.xml, host/host.jsx).
# O'rnatuvchi sarlavhasi tools/header.bat dan avtomatik moslashtiriladi (tuzatishlar ikkalasiga ham o'tadi).
#   ./tools/build-ae.sh
set -euo pipefail
cd "$(dirname "$0")/.."

src=aftereffects-gemini-plugin
version=$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$src/CSXS/manifest.xml")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
dist="$tmp/aftereffects-gemini-plugin"
mkdir -p "$dist"

if LC_ALL=C grep -nP '[^\x00-\x7F]' "$src/host/host.jsx"; then
  echo "XATO: AE host.jsx ichida ASCII bo'lmagan belgilar bor - \\uXXXX ko'rinishida yozing" >&2
  exit 1
fi

# 1) After Effects qismi
cp -r "$src/CSXS" "$src/host" "$dist/"

# 2) Umumiy interfeys, matnlarda Premiere -> After Effects
cp -r premiere-gemini-plugin/client "$dist/client"
find "$dist/client" -type f \( -name '*.html' -o -name '*.js' \) -print0 | xargs -0 sed -i \
  -e 's/Premiere Pro 2022-202[0-9]/After Effects 2022-2026/g' \
  -e 's/Adobe Premiere Pro/Adobe After Effects/g' \
  -e 's/Premiere Pro/After Effects/g' \
  -e 's/Premiere/After Effects/g' \
  -e 's/Sequence ochilmagan/Kompozitsiya ochilmagan/g' \
  -e "s/timeline'ni oching/kompozitsiyani oching/g"
sed -i -e "s#<span id=\"ver\">[^<]*</span>#<span id=\"ver\">$version</span>#" \
  -e "s#<span class=\"brand-version\">[^<]*</span>#<span class=\"brand-version\">${version%.*} \\&middot; AFTER EFFECTS</span>#" "$dist/client/index.html"
if grep -rn "Premiere" "$dist/client" --include='*.html' | grep -v 'data-host'; then echo "XATO: interfeysda Premiere so'zi qolib ketdi" >&2; exit 1; fi

# 3) O'rnatuvchi sarlavhasi: header.bat -> After Effects
sed -e 's/findPremiere/findAE/g; s/listPremiere/listAE/g; s/waitPremiereClosed/waitAEClosed/g' \
  -e 's#%%~fD\\Adobe Premiere Pro\.exe#%%~fD\\Support Files\\AfterFX.exe#g' \
  -e 's/Adobe Premiere Pro\.exe/AfterFX.exe/g' \
  -e 's#Adobe\\Adobe Premiere Pro\*#Adobe\\Adobe After Effects*#g' \
  -e 's/premiere-gemini-plugin/aftereffects-gemini-plugin/g' \
  -e 's/set "GC_ID=com.uzstudio.geminicut"/set "GC_ID=com.uzstudio.geminicut.ae"/' \
  -e 's/GeminiCut-Setup-fixed\.bat/GeminiCut-AE-Setup-fixed.bat/g' \
  -e 's/GeminiCut-install\.log/GeminiCut-AE-install.log/g' \
  -e 's/GeminiCut-Setup\.bat/GeminiCut-AE-Setup.bat/g' \
  -e 's/Premiere Pro/After Effects/g; s/Premiere/After Effects/g' \
  tools/header.bat > "$tmp/header-ae.bat"
if LC_ALL=C grep -nP '[^\x00-\x7F]' "$tmp/header-ae.bat"; then echo "XATO: AE sarlavhasida ASCII bo'lmagan belgi" >&2; exit 1; fi
if grep -n "Premiere\|premiere" "$tmp/header-ae.bat"; then echo "XATO: AE sarlavhasida Premiere qoldi" >&2; exit 1; fi

# 4) Arxiv va .bat
(cd "$tmp" && find aftereffects-gemini-plugin -type f | LC_ALL=C sort | zip -qX -@ payload.zip)
sha=$(sha256sum "$tmp/payload.zip" | cut -d' ' -f1 | tr 'a-f' 'A-F')
size=$(stat -c %s "$tmp/payload.zip")
{
  sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$sha/g" "$tmp/header-ae.bat"
  base64 -w 76 "$tmp/payload.zip"
} | sed 's/\r$//; s/$/\r/' > GeminiCut-AE-Setup.bat

# Sinovlar uchun yig'ilgan nusxa
rm -rf build/ae && mkdir -p build/ae && cp -r "$dist" build/ae/
echo "GeminiCut-AE-Setup.bat $version tayyor: payload $size bayt, SHA-256 $sha"
