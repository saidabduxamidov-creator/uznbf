# Local MCP Platform

A local-only Model Context Protocol server that gives **Claude Desktop** and **ChatGPT Desktop** access
to tools on this computer: files, media processing, and the Premiere Pro / After Effects /
DaVinci Resolve integrations.

- **One server, many tools.** Both clients launch the same server over stdio.
- **No AI calls.** The server performs no AI calls and contains no AI provider SDK; the client model
  does the reasoning.
- **Local only.** No cloud, no remote MCP, no telemetry.
- **Gemini is outside this platform.** It stays in the editing panels and works through its official
  API there.

The name is temporary; it is defined only in `packages/core/src/product.ts`.

Architecture, decisions and implementation status: [`../docs/mcp-platform/ARCHITECTURE.md`](../docs/mcp-platform/ARCHITECTURE.md).

## Layout

| Package | Role |
|---|---|
| `packages/core` | Domain contracts: tools, packages, errors, capabilities, ports. No infrastructure. |
| `packages/toolkit` | Shared building blocks for tool packages: process runner without a shell (kills the whole process tree on cancel), binary discovery (configured path, then `LMP_BIN_DIR`, then PATH), path safety, atomic writes, FFmpeg helpers, test harness. |
| `packages/kernel` | Infrastructure behind the ports: DI, config, logging, events, cache, queue, permissions, SQLite, metrics, registry, package discovery, executor. |
| `packages/server` | MCP adapter (the only SDK user), built-in `platform` package, composition root, CLI. |
| `packages/tools/*` | Tool packages. They are discovered at startup; adding one never changes existing code. |

Built-in tool packages:

| Package | Tools |
|---|---|
| `fs` | `list_directory`, `stat`, `read_text`, `read_image`, `write_text`, `make_directory`, `move`, `find`, `hash` |
| `ffmpeg` | `probe`, `extract_frames`, `extract_audio`, `transcode` |
| `video` | `detect_silence`, `detect_scenes`, `loudness`, `contact_sheet` |

The `fs` package checks every path against the local permission policy. `ffmpeg.extract_frames` and
`video.contact_sheet` return images that the assistant looks at itself. `ffmpeg.transcode` accepts
only named presets, never raw arguments.
| `scripts/guard.mjs` | Build guard. Fails on AI-provider SDKs or endpoints, any Google AI/Flow/Veo reference, unapproved network code, and dependencies with install scripts. |

## Requirements

Node.js 22.12 or newer. The end-user installer bundles its own Node runtime (Phase 8).

## Build and test

```
npm ci            # install scripts are disabled by .npmrc
npm run build     # tsc -b (strict, project references)
npm run guard
node --test "packages/*/dist/test/**/*.test.js"
```

The test suite includes an end-to-end run. It starts the real server process over stdio and drives
it with the official MCP SDK client, covering:

- tool listing;
- structured results;
- progress;
- cancellation;
- background jobs;
- consent via elicitation;
- clean shutdown.

## Running

```
node packages/server/dist/src/cli.js                 # stdio MCP server
node packages/server/dist/src/cli.js --check         # load config + packages, print a JSON report
node packages/server/dist/src/cli.js --print-paths   # show config/data/cache/log directories
```

Options:

| Option | Meaning |
|---|---|
| `--config <file>` | Use this config file |
| `--data-root <dir>` | Portable mode: everything under one directory |
| `--tools-dir <dir>` | Built-in tool packages directory (repeatable) |
| `--log-level <level>` | Log level |

Per-user locations on Windows:

| What | Location |
|---|---|
| Configuration | `%APPDATA%\LocalMcpPlatform\config.json` |
| Database, package data | `%LOCALAPPDATA%\LocalMcpPlatform\` |
| Logs | `%LOCALAPPDATA%\LocalMcpPlatform\Logs\server.log` (JSON lines, rotated) |
| Cache | `%LOCALAPPDATA%\LocalMcpPlatform\Cache\` |

## Registering with the desktop clients

The Phase 8 installer does this automatically, and backs up the existing client configuration first.

**Claude Desktop.** Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "local-mcp-platform": {
      "command": "C:\\Program Files\\LocalMcpPlatform\\node\\node.exe",
      "args": ["C:\\Program Files\\LocalMcpPlatform\\server\\cli.js"]
    }
  }
}
```

**ChatGPT Desktop.** Go to Settings → MCP servers → Add server → **STDIO**. Use the same command and
arguments. ChatGPT Web is not supported: it accepts only remote servers.

## Configuration (excerpt)

```json
{
  "permissions": {
    "defaults": { "fs.read": "ask", "fs.write": "ask", "terminal.exec": "deny", "network": "deny" },
    "rules": [
      { "capability": "fs.read", "effect": "allow", "targets": ["D:\\Video"], "description": "footage" },
      { "capability": "fs.write", "effect": "allow", "targets": ["D:\\Video\\Exports"] }
    ]
  },
  "queue": { "syncWaitMs": 20000 },
  "tools": { "directories": [], "trusted": {}, "settings": {} }
}
```

How the policy and the file behave:

- **Rules:** the first matching rule wins.
- **`ask`:** the server asks you through the client. Claude Desktop supports this through MCP
  elicitation. A client that cannot ask gets a clear denial that names the config key to change.
- **Live reload:** permission and queue changes apply without a restart. An invalid edit is rejected
  and the previous configuration stays active.
- **Third-party tool packages:** they load only when `tools.trusted.<id>` holds the sha-256 of their
  entry file. `--check` prints the exact value to add.

## Writing a tool package

```ts
import { defineTool, defineToolPackage, text } from "@lmp/core";
import { z } from "zod";

export default defineToolPackage({
  manifest: {
    id: "example",
    version: "1.0.0",
    displayName: "Example",
    description: "…",
    platforms: ["win32"],
    capabilities: ["fs.read"],
  },
  register: ({ services, logger }) => ({
    tools: [
      defineTool({
        name: "example.size",
        title: "File size",
        description: "Size of a file in bytes",
        input: z.object({ path: z.string() }).strict(),
        output: z.object({ bytes: z.number() }),
        annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
        execution: { resourceClass: "io" },
        capabilities: (input) => [{ kind: "fs.read", target: input.path }],
        run: async (input, ctx) => {
          /* honour ctx.signal, report ctx.progress */
          return { content: [text("…")], structured: { bytes: 0 } };
        },
      }),
    ],
  }),
});
```

Add it to the tool package's `package.json` as `"lmpTool": { "id": "example", "entry": "dist/index.js" }`.
