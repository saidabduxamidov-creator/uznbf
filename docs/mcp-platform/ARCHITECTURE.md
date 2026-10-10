# Local MCP Platform — Architecture (Phases 1–4)

Status: **approved; Phase 5 in progress** (see §7 for what is implemented).

Scope:
- The MCP platform serves **exactly two MCP clients — Claude Desktop and ChatGPT Desktop** — over
  stdio, and runs **only on the user's computer**. ChatGPT Web is not supported.
- The MCP platform performs **no AI calls** and contains **no AI provider SDKs**.
- **Google Gemini stays in the editing panels**, through its official API only. It is independent of
  the MCP platform and is never routed through it.
- Google Flow and Veo are removed from the product.

Supported AI providers of the product:
| Provider | How it is used |
|---|---|
| Claude | Through MCP (Claude Desktop) |
| ChatGPT | Through MCP (ChatGPT Desktop) |
| Gemini | Official API, inside the panels |

---

## 1. Phase 1 — Analysis of the current project

### 1.1 What exists today

| Part | Location | Size | Role |
|---|---|---|---|
| Premiere Pro panel (CEP) | `premiere-gemini-plugin/client` | ~7.3k lines JS in 19 modules | UI + AI calls + rendering + host calls, all in the panel |
| Premiere host | `premiere-gemini-plugin/host/host.jsx` | 940 lines ExtendScript (ES3) | `gc_*` functions: sequence info, audio export, motion keys, cuts, SRT, PNG sequences, frames |
| After Effects host | `aftereffects-gemini-plugin/host/host.jsx` | 1083 lines | Same `gc_*` contract for AE, plus native text/shape/3D-logo layers |
| DaVinci Resolve host | `davinci-gemini-plugin/host.js` | 1178 lines Node | Same contract via Workflow Integration; Fusion Lua generation |
| Installers | `GeminiCut-*-Setup.bat`, `tools/build-*.sh` | — | Self-extracting, no Node/npm needed by the end user |
| Tests | `*/tests` | unit + mock hosts + Playwright e2e + Lua checks | Good coverage of host contracts |

AI access today is **API-first, inside the panel**:

- `ai.js` — HTTP clients for OpenAI (Chat Completions, model auto-pick) and Anthropic (Messages).
- `claude.js` / `chatgpt.js` — one "planner" (`createPlanner`) used twice: sends frames + timeline context
  to the model, receives a JSON edit/motion/SFX plan, applies it through `gc_*` host functions.
- `color.js` — pure LUT/CDL math; the AI only proposes grade parameters.
- `gemini.js`, `flow.js` — **Google Gemini** (transcription, `generateJson`, `generateText`, key test)
  and **Google Veo / Google Flow** (video generation via API and a browser profile).
- API keys live in panel `localStorage`.

### 1.2 Strengths worth keeping

1. **A stable host contract.** The three hosts expose the same `gc_*` functions with the same JSON
   result shape (`{ok, …}` / `{ok:false, error}`). Mock-backed tests already exist for that contract.
2. **Pure, reusable domain code:** `motion.js` (presets → keyframes), `color.js` (LUT math),
   `audio.js` (WAV/AIFF decode, silence detection), `sfxgen.js` (procedural SFX), SRT helpers,
   `textfx*.js` (Canvas/WebGL text rendering).
3. **Proven delivery model:** single-file installers that need no runtime on the user's machine.

### 1.3 Problems an MCP-first design must solve

| # | Problem | Consequence |
|---|---|---|
| P1 | UI, AI orchestration, rendering and host I/O are mixed in browser modules | Logic cannot be reused by an external AI client |
| P2 | AI reasoning is done by **our code calling vendor APIs** | Keys stored in the panel, duplicated prompt/plan logic per vendor, network calls from the plugin |
| P3 | ExtendScript is reachable **only from inside Premiere / AE** (CEP `evalScript`) | An external MCP process cannot drive Premiere directly — a bridge is mandatory |
| P4 | Google dependencies (`gemini.js`, `flow.js`, transcription, Veo, product name "GeminiCut", folder/ID names) | Forbidden in the new platform; transcription must be replaced |
| P5 | Text templates render with Canvas2D/WebGL in Chromium | Node has no DOM/WebGL; rendering must stay in a browser context |
| P6 | Long jobs (render, export, ffmpeg) block the panel; cancellation is ad-hoc | Needs a real queue with progress + cancellation |

### 1.4 Google Flow / Veo removal (done in panels 4.7.0)

- **Removed:**
  - `flow.js` (Google Flow browser workflow) and `cdp.js` (its Chrome DevTools driver);
  - the "Video AI" tab and Flow/Veo settings and styles;
  - Veo calls and video download in `gemini.js`;
  - the `gc_flowCapture` / `gc_flowImport` host functions in Premiere, After Effects and Resolve;
  - their tests and documentation.
- **Kept:** Gemini through its official API (`gemini.js`: text/JSON generation, file upload) for
  subtitles and editing inside the panels. All other host functions are unchanged.
- **Product rename:** postponed (decision D2). The platform uses a neutral temporary name defined in
  one place (`@lmp/core` `PRODUCT`).

---

## 2. Phase 2 — Architecture

### 2.1 Verified platform facts that shape the design

| Client | Local MCP support | Consequence |
|---|---|---|
| Claude Desktop / Claude Code | Launches local **stdio** servers from its config | Primary transport: stdio |
| ChatGPT **desktop app** | Settings → MCP servers → Add server → **STDIO** (config shared with Codex CLI / IDE extension) | Same stdio server works unchanged |
| ChatGPT **web / chat "Developer mode" connectors** | Remote MCP only (public HTTPS or OpenAI's tunnel) | **Out of scope** — it would violate "no remote MCP / no external server" |

So the only design that satisfies both "ChatGPT + Claude" and "local only" is: **one stdio MCP
server, launched by the ChatGPT desktop app and/or Claude Desktop.** These client features change
quickly; the installer will detect both clients and the docs will say which app versions were verified.

### 2.2 Core principle: the server never calls an AI model

In MCP-first, **the client is the brain and the server is the hands**. ChatGPT or Claude reasons;
our server exposes tools that *observe* (timeline state, frames, waveform, transcripts) and *act*
(apply cuts, keyframes, text, renders). Results that need vision come back as MCP image content,
so the client model looks at the frames itself.

This removes P2 completely: **no API keys, no vendor SDKs, no outbound AI traffic, and no
per-vendor code paths.** It is also what makes "one server, no duplicated logic" literally true —
nothing in the server knows which of the two clients is calling, except for capability detection
(below).

The only client-specific code is a **capability profile** chosen from `initialize.clientInfo` and the
declared client capabilities (e.g. whether elicitation, progress or resource subscriptions are
supported). It changes *behaviour toggles*, never business logic.

### 2.3 System context

```
┌─────────────────┐   stdio (JSON-RPC)   ┌────────────────────────────────────────────────┐
│ ChatGPT desktop │ ───────────────────▶ │  MCP server process (Node.js, TypeScript)      │
└─────────────────┘                      │  ┌──────────────┐  ┌────────────────────────┐  │
┌─────────────────┐   stdio (JSON-RPC)   │  │ MCP adapter  │─▶│ Application: executor, │  │
│ Claude Desktop  │ ───────────────────▶ │  │ (official    │  │ queue, permissions     │  │
└─────────────────┘   (own process)      │  │  SDK)        │  └──────────┬─────────────┘  │
                                         │  └──────────────┘             │                │
                                         │      Tool plugins (fs, ffmpeg, video, subtitles,│
                                         │      timeline, premiere, ae, resolve, blender, …)│
                                         └───────┬──────────────┬──────────────┬──────────┘
                     127.0.0.1 WebSocket + token │   child procs│    SQLite +   │ cache dir
                                                 ▼              ▼    files      ▼
                         ┌──────────────────────────────┐  ffmpeg, whisper.cpp, blender,
                         │ Host bridge agents (existing │  PowerShell (OCR, clipboard,
                         │ panels): Premiere, AE, Resolve│  Photoshop COM), Edge/Chrome
                         │ → gc_* host functions         │
                         └──────────────────────────────┘
```

### 2.4 Layering (Clean Architecture)

Dependencies point **inward only**:

```
interface (mcp adapter, cli)  →  application (use cases)  →  core (domain contracts)
infrastructure (sqlite, cache, logger, processes, bridge client)  →  core (implements ports)
tool plugins  →  core (contracts) only; they receive infrastructure through the ToolContext
```

- **core** — pure TypeScript: `ToolDefinition`, `ToolContext`, `Capability`, error hierarchy,
  `Result`, and *ports* (interfaces) such as `Cache`, `JobQueue`, `ProcessRunner`, `HostBridge`,
  `Repository<T>`, `PermissionGate`, `EventBus`, `Clock`. No Node APIs, no SDK imports.
- **application** — `ToolExecutor` (validate → authorize → schedule → run → map result),
  `JobService`, `DiscoveryService`. Depends only on core ports.
- **infrastructure** — concrete adapters: SQLite repositories, two-tier cache, pino-based logger,
  process runner, WebSocket host-bridge client, config loader, metrics.
- **interface/mcp** — the *only* place that imports the MCP SDK. It uses the SDK's low-level
  `Server`, so the platform owns tool listing (JSON Schemas precomputed from zod), validation,
  error mapping, progress and cancellation. The SDK provides transport and JSON-RPC.

Trade-off: more packages and interfaces than a single-file server. In return, the MCP SDK (which is
still evolving) can be upgraded by touching one package, and every tool is testable without MCP.

### 2.5 Tool plugin model — "add a tool without changing existing code"

Each tool is an **independent package** with a manifest and a factory:

```
packages/tools/ffmpeg/
  package.json        "mcp-tool": { "id": "ffmpeg", "entry": "dist/index.js" }
  src/index.ts        export default defineToolPackage({ manifest, register(ctx) { … } })
```

- `manifest`: id, version, description, required capabilities (`fs.read`, `fs.write`,
  `process.spawn:ffmpeg`, `host:premiere`, `network`…), supported OS, resource class (cpu, io,
  host-serial), and configuration schema.
- `register(ctx)` returns tool/resource/prompt definitions with **zod** input/output schemas.
- **Discovery:** at startup the loader scans the built-in tools directory plus user-configured
  plugin directories, validates each manifest, checks the trust list (§2.11), and registers what it
  finds. Adding a tool = adding a folder (or a config entry). No switch statements, no central list.
- **Hot discovery (optional):** watching plugin directories and sending `tools/list_changed`.
  Off by default because not every client refreshes its tool list mid-session.

Trade-off: dynamic `import()` of plugins means third-party code runs in our process. Mitigation:
only trusted directories, sha-256 pinning of third-party plugins, and capability-scoped context
objects (a tool without `fs.write` never receives a writable file service).

### 2.6 Host bridge (Premiere, After Effects, Resolve)

Premiere can only be scripted from inside Premiere (P3). The existing panels therefore become
**bridge agents**:

1. When a panel opens, its agent (`client/js/mcp-bridge.js`, shared by all three panels) listens
   on **127.0.0.1 only**, on a random port, with a random 256-bit token. It writes
   `{protocol, host, port, token, pid, panelVersion}` atomically to
   `<platform data dir>\bridges\<host>.json` (`%LOCALAPPDATA%\LocalMcpPlatform\bridges` on Windows).
   It removes the file when the panel closes; stale files are ignored by a pid check.
2. **Protocol 1 is newline-delimited JSON over TCP.** WebSocket was replaced because the CEP and
   Resolve panels then need no third-party code: Node's `net` module is built into all three hosts.
   - The first message is `hello` with the token, compared in constant time. Anything else closes
     the connection.
   - Each `call {id, method, args, timeoutMs}` gets one `result {id, ok, data | error, code}`.
     `cancel {id}` drops a queued call; for a running call, the result is discarded.
3. **Allowlist.** Two kinds of methods can be called:
   - the existing `gc_*` host functions, passed through unchanged;
   - a few `panel.*` operations implemented with the panel's own modules: motion presets, sound
     library, text/logo templates (`GCText.place`), audio export with the panel's preset logic, and
     colour grading (`GCChatGPT.collectTargets/applyGrades`).

   Those panel functions were extracted from the UI code, so the panel buttons and MCP run the same
   code.
4. **One call at a time.** Several clients may connect simultaneously (Claude and ChatGPT each start
   their own server process). The agent runs calls one at a time, because host scripting is
   single-threaded.
5. **Server side** (`editor` tool package):
   - Connections are pooled per host and authenticated.
   - A panel restart is handled transparently: a call that was never sent is retried once. An edit
     that may already have run is never repeated.
   - Client cancellation sends `cancel`.
   - The guard script allows exactly one loopback `net.connect` in the codebase.

Why the panel listens instead of the server: the panel's lifetime defines when the host is usable,
two independent server processes can share one bridge, and no long-lived daemon is needed.
Trade-off: the panel must be open; a closed panel becomes a clear `HostUnavailable` error that tells
the model to ask the user to open the panel. For After Effects there is also a headless fallback
(`AfterFX.exe -s`) for read-only queries; Premiere has none.

All three hosts keep their single implementation (`host.jsx` / `host.js`) — **no logic is duplicated
into the server**. The server-side tool packages are thin, typed facades over the bridge contract.

### 2.7 Execution model: queue, streaming, cancellation

- **ToolExecutor pipeline:** `parse (zod) → authorize (PermissionGate) → cache lookup →
  enqueue → run with AbortSignal → validate output → map to MCP content`.
- **JobQueue:** in-process priority queue with **per-resource-class concurrency**:
  - `host-serial` = 1 per host;
  - `cpu` = cores − 1, run on a `worker_threads` pool for pure computation (silence detection, LUT
    building, waveform analysis);
  - `io` = bounded;
  - `external` = one per binary (ffmpeg, whisper, blender) by default.

  Nothing CPU-heavy runs on the event loop, so the stdio channel never freezes.
- **Streaming:** progress via MCP `notifications/progress` when the client sent a `progressToken`;
  log lines via MCP logging notifications. Large outputs (frames, transcripts) are returned as
  **resource links** (`resource_link`) to `platform://artifacts/...` instead of huge inline payloads.
- **Long jobs:** a tool returns quickly with a job id when the work exceeds a threshold, plus
  `jobs.status` / `jobs.result` / `jobs.cancel` tools. This polling path is the portable baseline,
  because support for the newer protocol-level task primitives differs between the two clients.
- **Cancellation:** MCP `notifications/cancelled` → the SDK abort signal → `AbortSignal` passed down to
  child processes (kill tree on Windows), workers and bridge calls (cancel message to the agent).
- **Timeouts** per tool from the manifest, overridable in config.

### 2.8 Cache and incremental processing

- **Content-addressed keys:** `sha256(toolId, toolVersion, normalized input, input file
  fingerprints)`. A file fingerprint is `(realpath, size, mtimeMs)`, with an optional full hash for
  small files.
- **Two tiers:**
  - memory LRU (bounded by bytes) for small JSON results;
  - disk cache (`%LOCALAPPDATA%\<product>\cache`) for derived media: extracted WAV, frames,
    proxies, transcripts, waveform peaks.
- **Incremental:** media analysis is segmented (e.g. 30-second windows). A changed timeline
  re-analyses only the dirty segments.
- **Eviction** by size and age, plus a `cache.clear` tool. Cached items never leave the machine.

### 2.9 Persistence (Repository Pattern)

- **SQLite** through Node's built-in `node:sqlite` on the bundled Node LTS, so no native build step.
  WAL mode lets two server processes share it safely.
- **Repositories:**
  - `JobRepository`;
  - `AuditRepository` (permission decisions, tool calls);
  - `ArtifactRepository`;
  - `KvRepository` (tool state);
  - `ProjectMemoryRepository` (per-project notes the model may read and write).
- **Migrations:** versioned SQL files, applied at startup inside a transaction.
- Trade-off: `node:sqlite` is newer than `better-sqlite3`; it is hidden behind the repository
  interface, so swapping it is a one-adapter change.

### 2.10 Configuration

Layered and validated with zod:

```
built-in defaults  <  %APPDATA%\<product>\config.json  <  environment variables  <  CLI flags
```

- Each tool package contributes its own config schema under `tools.<id>`.
- Invalid config fails fast at startup, with the exact path of the bad key.
- Permission policy reloads live when the file changes.

### 2.11 Permissions and security

Everything is **deny by default**:

| Capability | Policy |
|---|---|
| `fs.read` / `fs.write` | Allowed roots only. Paths are resolved with `realpath`, symlink/junction escapes are rejected, and UNC/device paths are denied. |
| `process.spawn` | Only binaries registered by tools (ffmpeg, whisper, blender), never a shell. Arguments are passed as arrays. |
| `terminal.exec` | Off by default. When enabled: an allowlist of executables and argument patterns, a working-directory root, a timeout and output limit, and every call audited. |
| `network` | Off. Only the browser tool can be granted it, with a domain allowlist. |
| `host:*` | Per host. Destructive operations (ripple delete, replace) are marked `destructiveHint`. |

- **Ask mode:** when a policy says `ask` and the client supports elicitation, the server asks the
  user through the client. Otherwise it refuses with a message explaining how to allow it in config.
- **Input validation:** zod on every input. Hard limits on string length, array size and number
  ranges.
- **Safe execution:**
  - output size caps;
  - no `eval` / `new Function` on model input;
  - generated ExtendScript arguments are JSON-encoded, never concatenated.
- **No telemetry, analytics or update checks.**
- **CI guard** (`scripts/guard.mjs`): the build fails when platform sources or the lockfile:
  - reference Google AI (Gemini/Vertex/AI Studio) or Flow/Veo, since Gemini lives only in the panels;
  - import any AI provider SDK or endpoint;
  - open network connections outside an explicit module allowlist;
  - depend on packages with install scripts.
- **Supply chain:**
  - a pinned lockfile;
  - `npm ci --ignore-scripts`;
  - a small dependency set (MCP SDK, zod, ws, pino, playwright-core);
  - a license and advisory audit in CI.

### 2.12 Observability — local only

- **Logger:** pino writes JSON lines to a rotating file in `%LOCALAPPDATA%\<product>\logs`. **stdout
  is reserved for the JSON-RPC stream**; nothing else ever writes there. Secrets and tokens are
  redacted.
- **Event bus:** a typed in-process emitter (`tool.*`, `job.*`, `bridge.*`, `cache.*`). Logger,
  metrics and MCP notifications are subscribers, so tools never import them directly.
- **Metrics:** counters and latency histograms per tool, queue depth, cache hit ratio, heap/RSS and
  event-loop delay. They are exposed as MCP resources `platform://health` and `platform://metrics`
  and through a `platform.diagnostics` tool.
- **Error handler:** typed errors (`ValidationError`, `PermissionDenied`, `NotFound`,
  `HostUnavailable`, `ExternalProcessError`, `Timeout`, `Cancelled`, `Internal`).
  - Tool failures map to results with `isError: true` and an actionable message for the model.
  - Protocol errors are reserved for malformed requests.
  - Stack traces go to the log only.

### 2.13 Language, runtime, packaging

- **Language and runtime:** TypeScript (strict), Node.js LTS bundled with the installer (the user
  installs nothing), ES modules, the official MCP TypeScript SDK pinned to an exact version.
- **Dependency injection:** a small typed container with an explicit composition root. No
  decorators or reflect-metadata: plain constructors are easier to test and avoid runtime reflection.
- **Build and test:** `tsc -b` (project references) for builds and type checks. Tests use Node's
  built-in `node:test` on the compiled output: zero extra test dependencies and the same runtime
  that ships. Bundling is part of Phase 8.

---

## 3. Phase 3 — Folder structure

```
mcp-platform/
├─ package.json                 npm workspaces, scripts (build, test, lint, guard, package)
├─ tsconfig.base.json           strict TS settings shared by all packages
├─ vitest.workspace.ts
├─ eslint.config.js
├─ policy/
│  ├─ banned-identifiers.json   CI guard list (Gemini/Vertex/AI Studio/other providers, hosts)
│  └─ default-permissions.json  deny-by-default policy shipped with the installer
├─ prompts/                     MCP prompt templates (markdown + front-matter, versioned)
│  ├─ edit-remove-pauses.md
│  ├─ subtitle-proofread.md
│  └─ color-grade-look.md
├─ packages/
│  ├─ core/                     domain contracts, errors, ports — zero runtime deps
│  │  └─ src/{tool,context,errors,result,capabilities,ports/*}.ts
│  ├─ kernel/                   infrastructure implementations of core ports
│  │  └─ src/{di,config,logger,events,cache,queue,workers,permissions,security,
│  │           metrics,process,db/{sqlite,migrations,repositories}}/…
│  ├─ bridge-protocol/          message schemas shared by server and panel agents
│  ├─ bridge-client/            server-side WebSocket client, discovery, reconnection
│  ├─ server/                   MCP adapter + composition root + CLI entry (bin/mcp-server)
│  │  └─ src/{mcp/{tools,resources,prompts,progress,capability-profile},bootstrap,cli}.ts
│  └─ tools/                    one independent package per tool
│     ├─ fs/              ├─ terminal/        ├─ clipboard/      ├─ database/
│     ├─ ffmpeg/          ├─ video-analysis/  ├─ subtitles/      ├─ motion/
│     ├─ timeline/        ├─ premiere/        ├─ aftereffects/   ├─ resolve/
│     ├─ blender/         ├─ photoshop/       ├─ ocr/            └─ browser/
├─ agents/                      host bridge agents (added to the existing panels)
│  ├─ cep-agent/                Premiere + AE: WebSocket listener inside the CEP panel
│  └─ resolve-agent/            Resolve Workflow Integration listener
├─ scripts/                     build, bundle, guard, installer payload, client registration
└─ test/                        cross-package integration tests, MCP conformance, e2e with mock hosts
```

Existing folders (`premiere-gemini-plugin`, …) stay untouched until the panel migration step;
then they are renamed and their API tabs are removed (decision D3).

---

## 4. Phase 4 — Module responsibilities

### 4.1 Platform modules

| Module | Responsibility | Key decisions |
|---|---|---|
| **MCP Server** (`server/mcp`) | Owns the SDK `McpServer`, stdio transport (optional Streamable HTTP bound to 127.0.0.1 with a token, off by default), capability profile per client | The only SDK importer; translates errors, progress, cancellation |
| **Tool Registry** (`kernel/registry`) | Stores validated tool definitions; unique, namespaced ids (`premiere.apply_cuts`); annotations (read-only / destructive / idempotent / open-world) | Immutable after startup unless hot discovery is enabled |
| **Tool Discovery** (`kernel/packages`) | Scans tool directories, validates manifests, checks trust (sha-256 before import) and OS support, registers each package in isolation | Eager loading: `tools/list` needs every schema, so packages load at startup; a failing package is skipped, never fatal |
| **Resource Manager** | `platform://` resources: health, metrics, jobs, artifacts (frames, transcripts, EDLs), host state snapshots; subscriptions where the client supports them | Large binary data is served as resources, not inline |
| **Prompt Manager** | Loads `prompts/*.md`, validates declared arguments, exposes MCP prompts (workflows such as "remove pauses", "grade this clip") | Prompts are data, versioned, no code change to add one |
| **Cache** | Two-tier content-addressed cache (§2.8) | Size-bounded, crash-safe atomic writes |
| **Event Bus** | Typed pub/sub decoupling tools from logging, metrics and notifications | Synchronous dispatch for in-process listeners, errors isolated per listener |
| **Logger** | pino → rotating file, redaction, per-request child loggers with correlation id | Never writes to stdout |
| **Error Handler** | Error taxonomy, mapping to MCP results, last-resort handlers for unhandled rejections | Fail the request, not the process |
| **Configuration** | Layered, zod-validated, per-tool schemas, live reload of policy | Fail fast on invalid config |
| **Permissions** | `PermissionGate.check(capability, resource)`; policy evaluation; ask mode via elicitation; audit trail | Deny by default |
| **Security** | Path sandboxing, argument encoding, output caps, process tree kill, CI guard, dependency policy | Defence in depth; no shell anywhere |
| **Monitoring** | Metrics registry, health checks (bridges, binaries, disk, DB), diagnostics tool | Local resources only, no network |

### 4.2 Tool packages

| Tool | What it does | Implementation |
|---|---|---|
| **fs** | List, read, write, search and stat inside allowed roots | `fs/promises`, streaming reads, size caps |
| **terminal** | Run allowlisted executables | `spawn` without shell, policy-checked, audited |
| **clipboard** | Read and write text and images | PowerShell `Get-/Set-Clipboard` (Windows), `pbcopy`/`pbpaste` (macOS) |
| **database** | Local SQLite query/exec on allowed DB files; project memory | Read-only by default; parameterized statements |
| **ffmpeg** | Probe, extract audio/frames, transcode, concat, proxies | Bundled ffmpeg/ffprobe, progress parsed from `-progress pipe:1` |
| **video-analysis** | Scenes, silences, loudness, keyframes, contact sheets returned as images to the model | ffmpeg filters + worker pool; reuses `audio.js` logic ported to TS |
| **subtitles** | Transcribe locally, segment, format SRT/VTT, import to the host | Local ASR engine (decision D4); the model proofreads via the returned text |
| **motion** | Motion presets and keyframe planning | Port of `motion.js` (pure TypeScript) |
| **timeline** | Host-agnostic timeline model; diff/apply; export EDL/FCPXML/OTIO | Adapters per host through the bridge |
| **premiere / aftereffects / resolve** | Typed facades over the `gc_*` bridge contract | Existing host files remain the single implementation |
| **blender** | Run scripted renders and scene operations | `blender -b --python` subprocess, generated script from a typed spec |
| **photoshop** | Open, apply actions, export layers | Windows COM `DoJavaScript` via PowerShell; UXP agent later |
| **ocr** | Text from images and frames | Windows built-in OCR (`Windows.Media.Ocr`) by default; optional bundled Tesseract with local language data |
| **browser** | Navigate, screenshot, extract from allowed domains | `playwright-core` driving the installed Edge/Chrome; no browser download; network capability required |

---

## 5. Phase plan after approval

5. **Implementation**, in this order, each step tested before the next:
   1. core + kernel;
   2. server with `platform.*` tools;
   3. fs, ffmpeg, video-analysis;
   4. bridge protocol + CEP/Resolve agents + host facades;
   5. motion, timeline, subtitles;
   6. clipboard, database, terminal;
   7. ocr, browser, blender, photoshop.
6. **Optimize:** profiling, startup time, memory soak test, cache tuning.
7. **Test:**
   - unit tests per package;
   - contract tests against the existing mock hosts;
   - MCP conformance (MCP Inspector + an SDK client);
   - end-to-end with both clients' configs.
8. **Deploy:**
   - a self-contained installer (bundled Node + ffmpeg);
   - automatic registration in the ChatGPT desktop and Claude Desktop MCP configs (with backup);
   - uninstall that removes all files and registrations.

---

## 6. Decisions (final)

| # | Decision |
|---|---|
| D1 | MCP clients: **Claude Desktop and ChatGPT Desktop**, local stdio only. ChatGPT Web is not supported. |
| D2 | Neutral temporary name ("Local MCP Platform", ids `lmp`). Renaming touches only `packages/core/src/product.ts`. |
| D3 | **Gemini stays** in the panels through its official API, outside MCP. **Google Flow and Veo are removed** (done). Claude and ChatGPT reach local tools through MCP. |
| D4 | Speech recognition: **whisper.cpp, fully offline**. No cloud transcription. |
| D5 | **Windows only for v1**. Platform-specific code is isolated (`kernel/paths`, permission path rules, tool adapters) so macOS is an addition, not a refactor. |

## 7. Implementation status

| Step | Content | State |
|---|---|---|
| 5.1 | `@lmp/core`: contracts, errors, capabilities, ports, tool and package API | Done, tested |
| 5.1 | `@lmp/kernel`: paths, DI, events, logging, config, cache, queue, permissions, SQLite repositories, metrics, registry, package discovery, executor | Done, tested |
| 5.2 | `@lmp/server`: MCP adapter (stdio), built-in `platform` package, composition root, CLI | Done; end-to-end tested with the official SDK client |
| 5.3 | `@lmp/toolkit` (safe process runner with tree kill, binary discovery, path safety, atomic writes, FFmpeg helpers, test harness) and the fs (9 tools), ffmpeg (4 tools, preset-only transcoding) and video (4 tools) packages | Done; tested against real FFmpeg, including the full MCP stack |
| 5.4 | Panel bridge agent (one file for all three panels, settings toggle and status) and the `editor` package (21 tools: timeline, selection, frames, cuts, zooms, keyframes, motion presets, sound effects, audio import/export, subtitles, text/3D logo templates, Resolve colour grading) | Done; tested with the real agent and real `host.jsx` on the Premiere/AE mocks, plus the full MCP client → server → panel chain |
| 5.5 | `subtitles` (5 tools: offline whisper.cpp transcription, readable caption layout, SRT/VTT read/write/reformat), `timeline` (FCP7 XML / CMX3600 EDL timelines for Premiere and Resolve, FFmpeg rough-cut render), `motion` (speech-driven punch-in plans, eased keyframes, Ken Burns, camera shake) | Done; transcription tested with a real whisper.cpp build, timelines and renders against real FFmpeg |
| 5.6 | clipboard, database, terminal | Next |
| 5.7 | ocr, browser, blender, photoshop | Planned |
