/*
 * Local MCP bridge agent (runs inside the Premiere Pro / After Effects / DaVinci Resolve panel).
 *
 * The local MCP server (started by Claude Desktop or ChatGPT Desktop) cannot script the editing
 * application directly; it talks to this agent instead:
 *   - TCP on 127.0.0.1 only, random port, newline-delimited JSON (protocol 1).
 *   - The first message must be {"type":"hello","token":...}; the 256-bit token is published, with
 *     the port, in a per-user discovery file and compared in constant time.
 *   - Only the methods listed below can be called. Calls run one at a time (host scripting engines
 *     are single-threaded) and reuse the panel's existing host functions and modules, so there is
 *     exactly one implementation of every editing operation.
 * Gemini is not involved: this bridge only exposes local editing operations.
 */
(function () {
  "use strict";

  const net = require("net");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const crypto = require("crypto");

  const PROTOCOL = 1;
  const DIRECTORY = "LocalMcpPlatform";
  const MAX_LINE = 16 * 1024 * 1024;
  const MAX_CONNECTIONS = 8;
  const HELLO_TIMEOUT_MS = 5000;
  const MAX_CALL_MS = 60 * 60 * 1000;
  const LS_ENABLED = "lmp.bridge.enabled";

  const HOST_IDS = { ppro: "premiere", ae: "aftereffects", resolve: "resolve" };

  /* Host functions callable through the bridge (arguments are passed unchanged). */
  const HOST_METHODS = new Set([
    "gc_ping", "gc_getSequenceInfo", "gc_getEditContext", "gc_setPlayhead", "gc_exportFrames",
    "gc_applyMotion", "gc_resetMotion", "gc_applyZooms", "gc_applyCuts", "gc_insertSound", "gc_importSrt",
    "gc_findAudioPreset", "gc_exportAudio", "gc_textAtPlayhead", "gc_colorTargets", "gc_revertGrade",
  ]);

  let server = null;
  let token = null;
  let discoveryFile = null;
  const sockets = new Set();
  const queue = [];
  let running = null;
  const state = { clients: 0, lastClient: "", calls: 0, error: "" };
  const listeners = new Set();

  const hostId = () => HOST_IDS[(window.GCHost && window.GCHost.app) || (document.body.classList.contains("resolve") ? "resolve" : "ppro")] || "premiere";

  /* Must match the platform's data directory (see @lmp/kernel paths). */
  function bridgesDir() {
    if (window.__lmpBridgesDir) return window.__lmpBridgesDir;
    const home = os.homedir();
    if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), DIRECTORY, "bridges");
    if (process.platform === "darwin") return path.join(home, "Library", "Application Support", DIRECTORY, "bridges");
    return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), DIRECTORY.toLowerCase(), "bridges");
  }

  function panelVersion() {
    const el = document.getElementById("ver");
    return el ? el.textContent.trim() : "";
  }

  /* ---------------- panel-level operations (reuse panel modules) ---------------- */

  function speechTracks() {
    try { return window.GCApplication.speechTracks(); } catch (e) { return []; }
  }

  const PANEL_METHODS = {
    "panel.info": async () => ({
      host: hostId(), panelVersion: panelVersion(), protocol: PROTOCOL,
      sequence: window.GCApplication && window.GCApplication.sequence ? window.GCApplication.sequence() : null,
    }),
    "panel.speechTracks": async () => speechTracks(),
    "panel.motionPresets": async () => Object.entries(window.GCMotion.PRESETS).map(([id, p]) => ({ id, name: p.label || p.name || id, description: p.desc || p.description || "" })),
    "panel.applyMotionPreset": async (args) => {
      const ctx = await window.GCHost.call("gc_getEditContext", [], 20000);
      const ops = window.GCMotion.buildPreset(args.preset, ctx, args.strength);
      const r = await window.GCHost.call("gc_applyMotion", [ops], 120000);
      return { clips: ctx.clips.length, source: ctx.source, applied: r.applied, keys: r.keys, errors: r.errors || [] };
    },
    "panel.sounds": async () => (await window.GCLibrary.index()).map(({ id, folder, name, duration }) => ({ id, folder, name, duration })),
    "panel.insertSound": async (args) => {
      const file = window.GCLibrary.fileById(args.id);
      if (!fs.existsSync(file)) throw new Error("Sound not found in the library: " + args.id);
      return window.GCHost.call("gc_insertSound", [file, args.track == null ? -1 : args.track, args.at == null ? -1 : args.at, speechTracks()], 60000);
    },
    "panel.exportAudio": async (args) => {
      if (!args.output || !path.isAbsolute(args.output)) throw new Error("output must be an absolute .wav path.");
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      const preset = await window.GCApplication.audioPreset();
      const tracks = Array.isArray(args.tracks) && args.tracks.length ? args.tracks : speechTracks();
      if (!tracks.length) throw new Error("No speech audio tracks selected. Pass tracks (0 = A1) or select them in the panel.");
      return window.GCHost.call("gc_exportAudio", [args.output, preset, tracks, !!args.useInOut], 30 * 60000);
    },
    "panel.textTemplates": async () => window.GCText.templates(),
    "panel.insertText": async (args) => {
      const rec = window.GCText.recipeFor(args.template, args.overrides || {});
      const r = await window.GCText.place(rec, { insertMode: args.insertMode || "native" });
      if (window.GCApplication.timelineChanged) window.GCApplication.timelineChanged();
      return r;
    },
    "panel.colorPresets": async () => Object.entries(window.GCColor.PRESETS).map(([id, p]) => ({ id, name: p.name, description: p.desc })),
    "panel.applyColor": async (args) => {
      if (hostId() !== "resolve") throw new Error("Colour grading is available in DaVinci Resolve.");
      const C = window.GCColor;
      const look = args.look ? C.fromAI({ look: args.look }).look : (C.PRESETS[args.preset || "natural"] || C.PRESETS.natural).look;
      const { targets, shots, frameError } = await window.GCChatGPT.collectTargets(args.scope || "playhead");
      if (!targets.length) throw new Error("No clips to grade for scope " + (args.scope || "playhead") + ".");
      const options = { auto: args.autoBalance !== false, autoStrength: args.autoStrength == null ? 0.8 : args.autoStrength };
      const result = await window.GCChatGPT.applyGrades(targets, (i) => window.GCChatGPT.gradeParams(shots, i, look, options), args.method || "auto");
      return { clips: targets.length, graded: result.done.length, modes: result.modes, errors: result.errors, notes: result.notes, analysedFrames: shots.length, frameError };
    },
  };

  /* ---------------- protocol ---------------- */

  function send(socket, message) {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
  }

  function fail(socket, id, error, code) {
    send(socket, { type: "result", id, ok: false, error: String((error && error.message) || error || "Failed"), code: code || "HOST_ERROR" });
  }

  function enqueue(job) {
    queue.push(job);
    pump();
  }

  async function pump() {
    if (running || !queue.length) return;
    const job = queue.shift();
    running = job;
    state.calls++;
    notify();
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("The editing application did not answer in time."), { code: "TIMEOUT" })), job.timeoutMs); });
      const data = await Promise.race([execute(job.method, job.args, job.timeoutMs), timeout]);
      if (!job.cancelled) send(job.socket, { type: "result", id: job.id, ok: true, data: stripOk(data) });
    } catch (e) {
      const code = e && (e.code === "TIMEOUT" || e.code === "NOT_ALLOWED") ? e.code : "HOST_ERROR";
      if (!job.cancelled) fail(job.socket, job.id, e, code);
    } finally {
      clearTimeout(timer);
      running = null;
      notify();
      pump();
    }
  }

  function stripOk(data) {
    if (data && typeof data === "object" && !Array.isArray(data) && "ok" in data) {
      const copy = Object.assign({}, data);
      delete copy.ok;
      return copy;
    }
    return data;
  }

  async function execute(method, args, timeoutMs) {
    if (HOST_METHODS.has(method)) return window.GCHost.call(method, Array.isArray(args) ? args : [], timeoutMs);
    if (method === "gc_applyGrade") throw new Error("Use panel.applyColor for colour grading.");
    const handler = PANEL_METHODS[method];
    if (!handler) throw Object.assign(new Error("Method not allowed: " + method), { code: "NOT_ALLOWED" });
    return handler(args && typeof args === "object" ? args : {});
  }

  function onMessage(socket, conn, message) {
    if (!conn.authenticated) {
      const given = Buffer.from(String(message.token || ""), "utf8");
      const expected = Buffer.from(token, "utf8");
      const ok = message.type === "hello" && given.length === expected.length && crypto.timingSafeEqual(given, expected);
      if (!ok) {
        send(socket, { type: "error", error: "Authentication failed." });
        socket.destroy();
        return;
      }
      conn.authenticated = true;
      clearTimeout(conn.helloTimer);
      state.lastClient = String(message.client || "mcp");
      send(socket, {
        type: "welcome", protocol: PROTOCOL, host: hostId(), panelVersion: panelVersion(),
        methods: Array.from(HOST_METHODS).concat(Object.keys(PANEL_METHODS)),
      });
      notify();
      return;
    }
    if (message.type === "ping") return send(socket, { type: "pong", id: message.id });
    if (message.type === "cancel") {
      const i = queue.findIndex((j) => j.socket === socket && j.id === message.id);
      if (i >= 0) {
        const [job] = queue.splice(i, 1);
        fail(socket, job.id, "Cancelled before it started.", "CANCELLED");
      } else if (running && running.socket === socket && running.id === message.id) {
        // Host scripts cannot be interrupted; the result is discarded when it arrives.
        running.cancelled = true;
        fail(socket, message.id, "Cancelled; the editing application finishes the current step.", "CANCELLED");
      }
      return;
    }
    if (message.type === "call") {
      const timeoutMs = Math.max(1000, Math.min(MAX_CALL_MS, Number(message.timeoutMs) || 120000));
      if (typeof message.id !== "number" || typeof message.method !== "string") return send(socket, { type: "error", error: "Malformed call." });
      enqueue({ socket, id: message.id, method: message.method, args: message.args, timeoutMs, cancelled: false });
      return;
    }
    send(socket, { type: "error", error: "Unknown message type." });
  }

  function onConnection(socket) {
    if (sockets.size >= MAX_CONNECTIONS || socket.remoteAddress && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    state.clients = sockets.size;
    notify();
    const conn = { authenticated: false, helloTimer: setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS) };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) { socket.destroy(); return; }
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch (e) { send(socket, { type: "error", error: "Invalid JSON." }); continue; }
        try { onMessage(socket, conn, message); } catch (e) { send(socket, { type: "error", error: e.message }); }
      }
    });
    const cleanup = () => {
      clearTimeout(conn.helloTimer);
      sockets.delete(socket);
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].socket === socket) queue.splice(i, 1);
      if (running && running.socket === socket) running.cancelled = true;
      state.clients = sockets.size;
      notify();
    };
    socket.on("close", cleanup);
    socket.on("error", () => socket.destroy());
  }

  /* ---------------- lifecycle ---------------- */

  function writeDiscovery(port) {
    const dir = bridgesDir();
    fs.mkdirSync(dir, { recursive: true });
    discoveryFile = path.join(dir, hostId() + ".json");
    const temp = discoveryFile + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    const info = { protocol: PROTOCOL, host: hostId(), port, token, pid: process.pid, panelVersion: panelVersion(), startedAt: Date.now() };
    fs.writeFileSync(temp, JSON.stringify(info), { mode: 0o600 });
    fs.renameSync(temp, discoveryFile);
  }

  function removeDiscovery() {
    if (!discoveryFile) return;
    try {
      const current = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
      if (current.token === token) fs.unlinkSync(discoveryFile);
    } catch (e) { /* already gone or replaced by another panel */ }
    discoveryFile = null;
  }

  function start() {
    if (server || !enabled() || !window.GCHost || !window.GCHost.available) { notify(); return; }
    if (typeof net.createServer !== "function") {
      state.error = "Node.js tarmoq moduli bu muhitda mavjud emas";
      notify();
      return;
    }
    token = crypto.randomBytes(32).toString("hex");
    server = net.createServer(onConnection);
    server.on("error", (e) => { state.error = e.message; notify(); });
    server.listen(0, "127.0.0.1", () => {
      try {
        writeDiscovery(server.address().port);
        state.error = "";
      } catch (e) { state.error = e.message; }
      notify();
    });
  }

  function stop() {
    removeDiscovery();
    for (const s of sockets) s.destroy();
    sockets.clear();
    queue.length = 0;
    if (server) { try { server.close(); } catch (e) { /* closed */ } }
    server = null;
    state.clients = 0;
    notify();
  }

  function enabled() {
    try { return localStorage.getItem(LS_ENABLED) !== "0"; } catch (e) { return true; }
  }

  function setEnabled(on) {
    try { localStorage.setItem(LS_ENABLED, on ? "1" : "0"); } catch (e) { /* ignore */ }
    if (on) start(); else stop();
  }

  function status() {
    return {
      enabled: enabled(), listening: !!(server && server.listening), port: server && server.listening ? server.address().port : null,
      clients: state.clients, lastClient: state.lastClient, calls: state.calls, busy: !!running, queued: queue.length, error: state.error,
    };
  }

  function notify() {
    const s = status();
    listeners.forEach((fn) => { try { fn(s); } catch (e) { /* UI listener errors are not fatal */ } });
    renderStatus(s);
  }

  function renderStatus(s) {
    const el = document.getElementById("mcpStatus");
    if (!el) return;
    el.textContent = !s.enabled ? "O'chirilgan"
      : s.error ? "Xato: " + s.error
      : !s.listening ? "Ishga tushmoqda…"
      : s.clients ? `Ulangan (${s.clients}) · ${s.calls} ta amal${s.busy ? " · bajarilmoqda" : ""}`
      : "Kutmoqda: Claude Desktop yoki ChatGPT Desktop'ni oching";
    el.classList.toggle("ok", s.enabled && s.listening && s.clients > 0);
    const toggle = document.getElementById("mcpEnabled");
    if (toggle) toggle.checked = s.enabled;
  }

  function init() {
    const toggle = document.getElementById("mcpEnabled");
    if (toggle) toggle.addEventListener("change", () => setEnabled(toggle.checked));
    window.addEventListener("beforeunload", stop);
    process.on("exit", removeDiscovery);
    start();
  }

  window.GCBridge = { init, start, stop, status, setEnabled, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, PROTOCOL };
})();
