# Installation Guide — Local MCP Platform

The Local MCP Platform is distributed as a single-file Node.js bundle (1.6 MB) that runs as an MCP server over stdio, providing 81+ tools for video editing, media processing, and system tasks.

## Prerequisites

### Required
- **Windows 7 SP1 or later** (or any OS that can run Node.js)
- **Node.js 22.12.0 or later** from https://nodejs.org/
- Administrator access (for %ProgramFiles% install; optional if installing elsewhere)

### Optional (for specific tool packages)
- **Photoshop 2022 or later** (Windows only) — for Photoshop automation
- **Blender 3.0+** — for 3D rendering and scene inspection
- **FFmpeg** (in PATH) — for fast video transcoding
- **Tesseract-OCR** or Windows WinRT — for optical character recognition
- **Chrome/Chromium** — for browser automation with DevTools Protocol
- **Whisper.cpp** — for faster-than-OpenAI offline transcription (optional; falls back to fallback)

Most tools work offline and require no additional setup.

## Installation Methods

### Option 1: PowerShell Installer (Recommended)

The easiest method for end users: extracts the bundle, validates integrity, and registers with Claude Desktop.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

**This will:**
1. Verify Node.js 22.12.0+ is installed
2. Extract the bundled server to `%ProgramFiles%\LocalMCPPlatform` (or custom `-InstallDir`)
3. Validate SHA-256 hash of `server.mjs` against `manifest.json`
4. Update `%APPDATA%\Claude\claude_desktop_config.json` to register the MCP server
5. Create a `run.bat` wrapper in the install directory

**After installation:**
- Restart Claude Desktop (or ChatGPT Desktop) to load the new MCP server
- The server will start on first connection and remain idle between requests
- Logs are written to `%APPDATA%\LocalMCPPlatform\server.log` (if logging enabled)

**Custom paths:**
```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 `
  -InstallDir "C:\MyApps\MCP" `
  -DataDir "C:\MyData\MCP"
```

### Option 2: Manual Installation

For development or custom setup:

1. Build the bundle:
   ```bash
   npm run build
   node scripts/bundle.mjs
   ```

2. Verify the bundle (optional but recommended):
   ```bash
   node scripts/verify-bundle.mjs
   ```

3. Create install directory:
   ```bash
   mkdir -p "%ProgramFiles%\LocalMCPPlatform"
   copy release\payload\server\server.mjs "%ProgramFiles%\LocalMCPPlatform\"
   copy release\payload\server\manifest.json "%ProgramFiles%\LocalMCPPlatform\"
   copy release\payload\server\THIRD_PARTY_NOTICES.txt "%ProgramFiles%\LocalMCPPlatform\"
   ```

4. Update Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`):
   ```json
   {
     "mcpServers": {
       "local-platform": {
         "command": "node",
         "args": [
           "%ProgramFiles%\\LocalMCPPlatform\\server.mjs",
           "--data-root", "%APPDATA%\\LocalMCPPlatform",
           "--log-level", "info"
         ],
         "disabled": false
       }
     }
   }
   ```

5. Restart Claude Desktop.

### Option 3: Development Mode (In-Process)

For testing and development without building a bundle:

```bash
npm run build
node packages/server/dist/src/cli.js --data-root ./data --log-level debug
```

This runs the server directly with all built-in tool packages loaded, no extraction or registry needed.

## Verification

### After Installation
Test the server directly to ensure it's working:

```bash
node "%ProgramFiles%\LocalMCPPlatform\server.mjs" --data-root "%APPDATA%\LocalMCPPlatform" --log-level debug
```

Expected output:
```
platform/info listening on stdio
platform/info registered 81 tools (motion, video, fs, database, etc.)
```

### Bundle Contents

The `server.mjs` bundle includes:
- **Core platform**: permission gate, audit logging, tool registry, async adapter
- **14 tool packages**: 81+ individual tools covering:
  - Video: motion planning, timeline (FCP7/EDL), subtitles (Whisper.cpp), ffmpeg transcoding
  - Editing: editor tasks, clipboard (multi-OS), keyboard input
  - System: file operations, terminal (allow-listed programs), browser automation (CDP)
  - AI/Media: OCR (Windows/Tesseract), Blender scene inspection, Photoshop automation
  - Database: SQLite with concurrent write support, soft deletions
- **Third-party deps**: @modelcontextprotocol/sdk, zod, ajv, json-schema libraries

### Manifest
See `release/payload/server/manifest.json`:
```json
{
  "product": "local-mcp-platform",
  "version": "0.1.0",
  "node": ">=22.12.0",
  "tools": ["blender", "browser", "clipboard", "database", "editor", "ffmpeg", "fs", "motion", "ocr", "photoshop", "subtitles", "terminal", "timeline", "video"],
  "serverSha256": "d02439707d93cc51e869c3d5285e919685c32dc1155a04020e326d6c700b8a43",
  "bytes": 1655011
}
```

## Uninstallation

To remove the MCP server:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1
```

Or manually:
1. Delete the install directory (default: `%ProgramFiles%\LocalMCPPlatform`)
2. Remove the `local-platform` entry from `%APPDATA%\Claude\claude_desktop_config.json`
3. Restart Claude Desktop

Note: The data directory (`%APPDATA%\LocalMCPPlatform`) is not removed; it contains user databases and logs.

## Troubleshooting

### "Node.js is not installed or not in PATH"
- Install Node.js 22.12.0+ from https://nodejs.org/
- Restart PowerShell or cmd after installation
- Verify: `node --version`

### "SHA-256 mismatch"
- The bundle was corrupted during download or extraction
- Rebuild: `npm run build && node scripts/bundle.mjs`
- Re-run the installer

### "Administrator privileges required"
- Right-click PowerShell and select "Run as administrator"
- Or use `-InstallDir` to specify a non-admin location

### "Bundle not found at release/payload/server/server.mjs"
- Build the bundle first: `npm run build && node scripts/bundle.mjs`
- Verify the build succeeded: `ls release/payload/server/`

### MCP server doesn't appear in Claude Desktop
1. Verify config was updated: `type %APPDATA%\Claude\claude_desktop_config.json | findstr local-platform`
2. Restart Claude Desktop completely (not just refresh)
3. Check if running manually works: `node "[install-dir]\server.mjs" --data-root "[data-dir]" --log-level debug`
4. If manual run fails, see error logs above

### Slow startup (>6 seconds)
The server loads 14 tool packages on first connection. This is normal. Subsequent calls are cached:
- First `tools/list`: ~0.5 seconds
- First tool call: ~0.1 seconds
- Memory usage: ~80 MB resident, <12 MB growth over 4000 calls

## Development

### Building from Source
```bash
npm run build                          # TypeScript → JavaScript
npm run check                          # Format, lint, type-check, test
node scripts/bundle.mjs                # Create release/payload/server.mjs
node scripts/verify-bundle.mjs         # Test the bundle end-to-end
```

### For Contributors
- Each tool package is independently testable: `npm test -w packages/tools/<tool>`
- The bundler discovers packages automatically from `package.json` `lmpTool` field
- Network isolation verified: bundle scanned for fetch(), WebSocket, tls.connect(), etc.
- Single shared copy of @lmp/core, zod, and SDK — no duplication across tools

## Architecture

The platform consists of:

1. **@lmp/core** — error classes, tool interface, type definitions
2. **@lmp/toolkit** — tool harness, permission gate, helpers
3. **@lmp/kernel** — MCP adapter, stdio transport, tool registry
4. **@lmp/server** — CLI, bootstrap, bundling entry point
5. **Tool packages** (14×) — motion, video, fs, etc., each self-contained

The bundler (`scripts/bundle.mjs`):
- Reads `packages/tools/*/package.json` for `lmpTool.id` and `lmpTool.entry`
- Generates an entry point that imports and registers each tool
- Bundles with esbuild into a single `server.mjs` file
- Generates `manifest.json` with SHA-256 for integrity verification
- Collects third-party license notices into `THIRD_PARTY_NOTICES.txt`

## Support

For issues, see the project README or report a bug with logs:
```bash
node "[install-dir]\server.mjs" --data-root "[data-dir]" --log-level debug 2>&1 | tee server.log
```

Include `server.log` and the output of `node --version` in the bug report.
