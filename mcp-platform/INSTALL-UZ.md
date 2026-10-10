# O'rnatish - Local MCP Platform (Uzbek)

## Tez O'rnatish (1 Daqiqa)

### Windows - Standalone Installer

Eng oson usuli - bu faylni yuklab olib ishga tushiring:

```
LocalMCPPlatform-installer.bat
```

**Steps:**
1. `LocalMCPPlatform-installer.bat` faylni yuklab oling
2. Right-click qilip "Run as Administrator" tugmasini bosing
3. Hammasih avtomatik o'rnatiladi
4. Claude Desktop ni restart qiling

**Sokin o'rnatish (prompts yo'q):**
```bash
LocalMCPPlatform-installer.bat 1
```

### macOS / Linux

```bash
bash scripts/install.sh
```

## Nima O'rnatiladi?

- **Server:** 1.6 MB bundled Node.js MCP server
- **81 Tools:** 14 tool packages (motion, video, fs, database, terminal, ocr, browser, photoshop, blender va boshqalar)
- **Config:** Claude Desktop automatik configurationi o'zgaradi
- **Data:** SQLite database uchun folder tayyorlanadi

## Qiymatlari

- **Node.js ≥22.12.0** - shart (https://nodejs.org/ dan o'rnatish)
- **Windows 7 SP1+** yoki macOS/Linux
- **Administrator huquqlari** (Windows %ProgramFiles% o'rnatish uchun)

## O'rnatish Varyantlari

### Variant 1: Standalone Installer (TAVSIYA QILINADI)

Eng oson - hammasi o'ziga embedded:

```bash
LocalMCPPlatform-installer.bat
```

### Variant 2: PowerShell Installer

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

### Variant 3: Batch Installer

```bash
scripts/install.bat
```

### Variant 4: Manual O'rnatish

```bash
npm run build
node scripts/bundle.mjs
# Fayllarni manual ko'chiring:
# release/payload/server/server.mjs -> %ProgramFiles%\LocalMCPPlatform\
# release/payload/server/manifest.json -> %ProgramFiles%\LocalMCPPlatform\
# release/payload/server/THIRD_PARTY_NOTICES.txt -> %ProgramFiles%\LocalMCPPlatform\
```

## Test Qilish

O'rnatishdan keyin, test qiling:

```bash
# Windows
"%ProgramFiles%\LocalMCPPlatform\run.bat"

# macOS/Linux
~/.local/share/local-mcp-platform/run.sh
```

Yoki to'g'ridan-to'g'ri:

```bash
# Windows (PowerShell)
node "$env:ProgramFiles\LocalMCPPlatform\server.mjs" --data-root "$env:APPDATA\LocalMCPPlatform" --log-level debug

# macOS/Linux
node ~/.local/share/local-mcp-platform/server.mjs --data-root ~/.config/local-mcp-platform --log-level debug
```

Kutiluvchi output:
```
platform/info listening on stdio
platform/info registered 81 tools
```

## Mavjud Tools (81ta)

### Video & Media
- **motion** (12): keyframe, Ken Burns, camera shake, zoom planning
- **video** (4): silence detection, color cut, loudness, contact sheet
- **timeline** (4): FCP7 XML, EDL export, rough cuts
- **subtitles** (3): Whisper.cpp transcription, captions
- **ffmpeg** (3): fast encoding, format conversion
- **editor** (5): text, color, transitions, effects

### System
- **fs** (6): list, read, write, move, hash, stat
- **terminal** (3): programs (allow-listed, no shell)
- **clipboard** (3): copy/paste text, images, audio
- **database** (4): SQLite queries, key-value store

### AI & Advanced
- **ocr** (4): text recognition, language detection
- **browser** (2): screenshots, DOM inspection
- **blender** (3): scene inspection, render
- **photoshop** (6): template fill, layers (Windows only)

## Xatoliklar va Yechimlar

### Node.js o'rnatilmagan
```
ERROR: Node.js o'rnatilmagan!
https://nodejs.org/ dan Node.js 22.12.0+ o'rnating
```

**Yechim:** https://nodejs.org/ dan o'rnating va PowerShell ni restart qiling

### Administrator huquqlari kerak
```
ERROR: Administrator huquqlari shart!
```

**Yechim:** 
- Right-click qilip "Run as Administrator" tugmasini bosing
- Yoki `-InstallDir` bilan boshqa joyga o'rnating

### SHA-256 mismatch
```
ERROR: Bundle SHA-256 mismatch
```

**Yechim:** Bundle rebuild qiling:
```bash
npm run build
node scripts/bundle.mjs
node scripts/verify-bundle.mjs
```

### Claude Desktop da ko'rinmaydi
1. Config tekshiring: `%APPDATA%\Claude\claude_desktop_config.json`
2. Claude Desktop ni to'liq restart qiling
3. Direct test qiling: `node "server.mjs" --log-level debug`

## Uninstall

### Windows
```bash
scripts/uninstall.bat
```

Yoki PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1
```

### macOS/Linux
```bash
bash scripts/uninstall.sh
```

## Qo'shimcha Shaxsiy Papkalar

O'rnatishdan keyin qo'llanmasini ko'ring:
- **INSTALL.md** - Detailed o'rnatish qo'llanmasi
- **QUICKSTART.md** - 2-daqiqalik start guide
- **release/payload/server/THIRD_PARTY_NOTICES.txt** - License ma'lumotlari

## Development

Sourcedan build qiling:

```bash
npm run build              # TypeScript → JavaScript
npm test                   # 165 ta tests
npm run check              # Format, lint, type, verify bundle
node scripts/bundle.mjs    # server.mjs yaratish (1.6 MB)
```

## Performance

- **Startup:** ~500 ms (birinchi marta)
- **Tool call:** ~100 ms (birinchi) / <15 ms (keyingi)
- **Memory:** ~80 MB resident, <12 MB growth over 4000 calls
- **Network:** Zero external APIs (loopback only)

## Qo'shimcha Bilgi

- Bundle verified: SHA-256, network APIs scanned, E2E tested
- 165 unit tests passing (99.5% coverage)
- Windows/macOS/Linux compatible
- Offline-first: no external API requirements
- Permission gate: user approval for sensitive operations
- Audit logging: all tool calls logged

**Savol yoki muammo bo'lsa, logs bilan report qiling:**
```bash
node server.mjs --log-level debug 2>&1 | tee server.log
```

Hammasini o'rnating va xursand bo'ling! 🎬✨
