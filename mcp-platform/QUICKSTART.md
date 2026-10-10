# Quick Start — Local MCP Platform

Get the Local MCP Platform running with 81+ tools for video editing, media processing, and system automation in 2 minutes.

## Installation (Windows, macOS, Linux)

### Windows (PowerShell)

```powershell
# Open PowerShell as Administrator, then:
cd path\to\mcp-platform
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

The installer will:
- Verify Node.js 22.12.0+ is installed
- Extract the bundled server to `%ProgramFiles%\LocalMCPPlatform`
- Validate the SHA-256 hash
- Update Claude Desktop config

**Restart Claude Desktop** — the MCP server will load on next connection.

### macOS / Linux (bash)

```bash
cd path/to/mcp-platform
bash scripts/install.sh
```

Default installation:
- Server: `~/.local/share/local-mcp-platform` (Linux) or `~/.local/share/local-mcp-platform` (macOS)
- Data: `~/.config/local-mcp-platform`

On macOS, the installer updates Claude Desktop config automatically.
On Linux, manually add the server to your MCP client config (see INSTALL.md).

## Verification

Test that the server works directly:

```bash
# Windows (with run.bat wrapper)
"%ProgramFiles%\LocalMCPPlatform\run.bat"

# macOS / Linux (with run.sh wrapper)
~/.local/share/local-mcp-platform/run.sh
```

Or run directly:

```bash
# Windows (PowerShell)
node "$env:ProgramFiles\LocalMCPPlatform\server.mjs" --data-root "$env:APPDATA\LocalMCPPlatform" --log-level debug

# macOS / Linux
node ~/.local/share/local-mcp-platform/server.mjs --data-root ~/.config/local-mcp-platform --log-level debug
```

Expected output:
```
platform/info listening on stdio
platform/info registered 81 tools
```

## Available Tools

The bundled server provides **81 tools** across **14 tool packages**:

### Media & Video
- **motion** (12 tools): keyframe planning, Ken Burns, camera shake, zoom planning, easing curves
- **video** (4 tools): silence detection, color cut detection, loudness analysis, contact sheets
- **timeline** (4 tools): FCP7 XML export, EDL (CMX3600) export, rough cuts, metadata
- **subtitles** (3 tools): offline transcription (Whisper.cpp), caption generation, reformatting
- **ffmpeg** (3 tools): fast transcoding, format conversion, preset-based encoding
- **editor** (5 tools): placeholder text, color grades, transitions, effects, export

### System & Files
- **fs** (6 tools): list, read, write, move, hash, stat (with permission gate)
- **terminal** (3 tools): run programs (allow-listed only, no shell), cancellation, timeout
- **clipboard** (3 tools): copy/paste text, images, audio (Windows/macOS/X11)
- **database** (4 tools): SQLite queries, key-value store, audit logging, soft deletes

### AI & Advanced
- **ocr** (4 tools): text recognition in images/video frames, language detection, region selection
- **browser** (2 tools): webpage screenshots, DOM inspection (Chrome DevTools Protocol)
- **blender** (3 tools): scene inspection, render, 3D asset preview
- **photoshop** (6 tools): template fill, layer listing, batch operations (Windows only)

### Example: Transcribing a Video

```typescript
// In Claude or ChatGPT using this MCP server:
const result = await subtitles.transcribe({
  videoPath: "/path/to/video.mp4",
  model: "base",  // tiny, base, small, medium, large
  language: "en"
});
// Returns: { text: "...", segments: [...], duration: 123.45 }
```

### Example: Building a Timeline

```typescript
const timeline = await timeline.from_media({
  clips: [
    { file: "/path/a.mp4", start: 0, duration: 5 },
    { file: "/path/b.mp4", start: 5, duration: 3.5 },
  ],
  fps: 30,
  audioGain: { a: 0, b: -3 }  // dB
});
// Returns: FCP7 XML ready to paste into Final Cut Pro
```

### Example: OCR on an Image

```typescript
const result = await ocr.image({
  imagePath: "/path/to/screenshot.png",
  language: "en",
  region: { top: 100, left: 50, width: 500, height: 200 }  // optional
});
// Returns: { text: "...", lines: [...], confidence: 0.95 }
```

### Example: Terminal Command

```typescript
const result = await terminal.exec({
  program: "ffprobe",  // allow-listed program
  args: ["-show_format", "-show_streams", "video.mp4"],
  timeout: 10000
});
// Returns: { stdout: "...", stderr: "", exitCode: 0 }
```

## Configuration

The MCP server is registered in Claude Desktop config:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
```json
{
  "mcpServers": {
    "local-platform": {
      "command": "node",
      "args": [
        "%ProgramFiles%\\LocalMCPPlatform\\server.mjs",
        "--data-root",
        "%APPDATA%\\LocalMCPPlatform",
        "--log-level",
        "info"
      ]
    }
  }
}
```

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
```json
{
  "mcpServers": {
    "local-platform": {
      "command": "node",
      "args": [
        "/path/to/server.mjs",
        "--data-root",
        "~/.config/local-mcp-platform",
        "--log-level",
        "info"
      ]
    }
  }
}
```

### Startup Flags

- `--data-root <path>`: Directory for databases, logs, and temporary files (default: OS-specific)
- `--log-level <level>`: debug, info, warn, error, fatal (default: info)
- `--no-audit`: Disable audit logging (not recommended)
- `--dyno-shell`: Enable dynamic shell mode for terminal tool (custom programs allowed; **security risk**)

## Performance

- **First startup**: ~500 ms (loads 14 tool packages, 81 tools)
- **First tool call**: ~100 ms
- **Subsequent calls**: <15 ms average
- **Memory**: ~80 MB resident, <12 MB growth over 4000 concurrent calls
- **Network isolation**: Bundle scanned for network APIs; only loopback 127.0.0.1 allowed

## Logs & Debugging

Enable debug logging to see tool calls and errors:

```bash
node server.mjs --data-root ./data --log-level debug 2>&1 | tee server.log
```

Logs include:
- Each tool call with arguments (redacted for sensitive data)
- Permission gate decisions (grant/deny reasons)
- Error codes and stack traces
- Performance metrics (startup time, memory usage)

## Troubleshooting

### MCP Server doesn't appear in Claude Desktop

1. **Verify installation:**
   ```bash
   ls "%ProgramFiles%\LocalMCPPlatform\server.mjs"  # Windows
   ls ~/.local/share/local-mcp-platform/server.mjs   # macOS/Linux
   ```

2. **Verify config:**
   ```bash
   type "%APPDATA%\Claude\claude_desktop_config.json" | findstr local-platform
   ```

3. **Test directly:**
   ```bash
   node "server-path" --data-root "data-path" --log-level debug
   ```

4. **Restart Claude Desktop** completely (not just refresh).

### Permission denied on terminal.exec

Some programs require pre-approval. Use:
```typescript
const result = await terminal.exec({
  program: "powershell",
  args: ["-Command", "Get-Date"],
  // If denied, Claude will show permission prompt. Accept to allow this program.
});
```

### Slow first startup

Normal — the server loads 14 packages on first connection. Subsequent calls are cached.
If startup is >6 seconds, check:
- Node.js version: `node --version` should be 22.12.0+
- Disk I/O: `--log-level debug` shows timing for each package
- Antivirus: May slow module loading

## Uninstallation

### Windows
```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1
```

### macOS / Linux
```bash
bash scripts/uninstall.sh
```

This removes the server but preserves your data directory. To delete data:
```bash
rm -rf ~/.config/local-mcp-platform    # macOS/Linux
rmdir /s %APPDATA%\LocalMCPPlatform     # Windows
```

## Development

Build and test from source:

```bash
cd mcp-platform
npm run build              # Compile TypeScript → JavaScript
npm test                   # Run all 165 unit tests
npm run check              # Format, lint, type-check, test, verify bundle
node scripts/bundle.mjs    # Create single-file server.mjs (1.6 MB)
node scripts/verify-bundle.mjs  # Test the bundle end-to-end
```

## Architecture

**Single-file bundle** (server.mjs, 1.6 MB):
- **@lmp/core** – error classes, types, interfaces
- **@lmp/toolkit** – tool harness, permission gate, helpers
- **@lmp/kernel** – MCP adapter, tool registry, stdio transport
- **14 tool packages** – motion, video, fs, etc.
- **Dependencies** – @modelcontextprotocol/sdk, zod, ajv (single copy, no duplication)

**No network access** (except loopback for panel bridge):
- All APIs scanned for fetch(), WebSocket, tls.connect(), etc.
- Only verified network call: loopback 127.0.0.1 (internal use)

**Secure by default**:
- Permission gate with audit logging
- Interpreter and script blocking on terminal.exec
- Soft deletes in database (recovery possible)
- SQLite WAL mode (concurrent reads/writes)

## Support

For issues, logs, and contributions:
- See INSTALL.md for detailed installation and troubleshooting
- Run `npm run check` to verify bundle integrity
- Report bugs with `--log-level debug` output and `node --version`

Happy automating! 🎬✨
