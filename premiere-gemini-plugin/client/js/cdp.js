/*
 * GeminiCut - brauzerni boshqarish (Chrome DevTools Protocol).
 * Hech qanday kutubxona kerak emas: Premiere ichidagi Node'ning o'zi bilan ishlaydi
 * (Playwright, Node.js yoki npm o'rnatish shart emas).
 *  - Chrome yoki Edge'ni alohida, doimiy GeminiCut profili bilan ochadi
 *    (Google'ga bir marta kiriladi, keyin profil eslab qoladi)
 *  - Minimal WebSocket mijozi (RFC 6455) + CDP buyruqlari
 */
(function (root) {
  "use strict";

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const http = require("http");
  const crypto = require("crypto");
  const { spawn } = require("child_process");

  const PROFILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "GeminiCut", "BrowserProfile");

  function candidates(channel) {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const la = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const chrome = [path.join(pf, "Google", "Chrome", "Application", "chrome.exe"), path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(la, "Google", "Chrome", "Application", "chrome.exe"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
    const edge = [path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
    return channel === "msedge" ? edge : channel === "chrome" ? chrome : chrome.concat(edge);
  }

  function findBrowser(channel) {
    if (process.env.GEMINICUT_BROWSER && fs.existsSync(process.env.GEMINICUT_BROWSER)) return process.env.GEMINICUT_BROWSER;
    return candidates(channel).find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
  }

  function httpJson(port, p, timeout) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: p, timeout: timeout || 1500 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    });
  }

  function readPort(profile) {
    try {
      const [port, wsPath] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
      return port ? { port: Number(port), wsPath } : null;
    } catch (e) { return null; }
  }

  /* Ochiq GeminiCut brauzerini topadi yoki yangisini ishga tushiradi */
  async function launch({ channel, profile, url, extraArgs }) {
    profile = profile || PROFILE;
    let info = readPort(profile);
    if (info) {
      try {
        const v = await httpJson(info.port, "/json/version");
        return { port: info.port, ws: v.webSocketDebuggerUrl, reused: true };
      } catch (e) { info = null; }
    }
    const exe = findBrowser(channel);
    if (!exe) throw new Error("Google Chrome yoki Microsoft Edge topilmadi. Ulardan birini o'rnating.");
    fs.mkdirSync(profile, { recursive: true });
    try { fs.unlinkSync(path.join(profile, "DevToolsActivePort")); } catch (e) { /* yo'q */ }
    const args = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-allow-origins=*", "--no-first-run",
      "--no-default-browser-check", "--disable-features=Translate", "--start-maximized"];
    if (extraArgs) args.push(...extraArgs);
    if (url) args.push(url);
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => { /* quyida timeout bilan aniqlanadi */ });
    child.unref();
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 250));
      info = readPort(profile);
      if (!info) continue;
      try {
        const v = await httpJson(info.port, "/json/version");
        return { port: info.port, ws: v.webSocketDebuggerUrl, reused: false };
      } catch (e) { /* hali tayyor emas */ }
    }
    throw new Error("Brauzer ochildi, lekin ulanib bo'lmadi. Brauzerni yopib, qayta urinib ko'ring.");
  }

  /* ---------------- WebSocket (RFC 6455) ---------------- */

  class Socket {
    constructor(sock) {
      this.sock = sock; this.buf = Buffer.alloc(0); this.frags = []; this.onmessage = null; this.onclose = null; this.closed = false;
      sock.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
      sock.on("close", () => { this.closed = true; if (this.onclose) this.onclose(); });
      sock.on("error", () => { /* close bilan birga keladi */ });
    }
    static connect(wsUrl) {
      return new Promise((resolve, reject) => {
        const u = new URL(wsUrl);
        const key = crypto.randomBytes(16).toString("base64");
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: {
          Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" } });
        req.on("upgrade", (res, sock, head) => {
          const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          if (res.headers["sec-websocket-accept"] !== accept) { sock.destroy(); return reject(new Error("WebSocket handshake xato")); }
          const ws = new Socket(sock);
          if (head && head.length) { ws.buf = Buffer.concat([ws.buf, head]); ws.parse(); }
          resolve(ws);
        });
        req.on("response", (res) => reject(new Error("WebSocket rad etildi: " + res.statusCode)));
        req.on("error", reject);
        req.setTimeout(10000, () => req.destroy(new Error("WebSocket timeout")));
        req.end();
      });
    }
    send(text, opcode) {
      const payload = Buffer.from(text, "utf8");
      const len = payload.length;
      const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
      head[0] = 0x80 | (opcode || 1);
      if (len < 126) head[1] = 0x80 | len;
      else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
      else { head[1] = 0x80 | 127; head.writeUInt32BE(Math.floor(len / 4294967296), 2); head.writeUInt32BE(len >>> 0, 6); }
      const mask = crypto.randomBytes(4);
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.sock.write(Buffer.concat([head, mask, payload]));
    }
    parse() {
      for (;;) {
        const b = this.buf;
        if (b.length < 2) return;
        const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (b.length < 10) return; len = b.readUInt32BE(2) * 4294967296 + b.readUInt32BE(6); off = 10; }
        const mOff = off; if (masked) off += 4;
        if (b.length < off + len) return;
        let data = b.slice(off, off + len);
        if (masked) { data = Buffer.from(data); for (let i = 0; i < len; i++) data[i] ^= b[mOff + (i & 3)]; }
        this.buf = b.slice(off + len);
        if (op === 8) { this.sock.end(); return; }
        if (op === 9) { this.sendRaw(data, 10); continue; }
        if (op === 1 || op === 2 || op === 0) {
          this.frags.push(data);
          if (fin) { const msg = Buffer.concat(this.frags).toString("utf8"); this.frags = []; if (this.onmessage) this.onmessage(msg); }
        }
      }
    }
    sendRaw(data, opcode) {
      const mask = crypto.randomBytes(4), d = Buffer.from(data);
      for (let i = 0; i < d.length; i++) d[i] ^= mask[i & 3];
      this.sock.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | d.length]), mask, d]));
    }
    close() { try { this.sock.end(); } catch (e) { /* e'tiborsiz */ } }
  }

  /* ---------------- CDP ---------------- */

  class CDP {
    constructor(ws) {
      this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
      ws.onmessage = (text) => {
        let m; try { m = JSON.parse(text); } catch (e) { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
        } else if (m.method) {
          (this.handlers.get(m.method) || []).forEach((fn) => fn(m.params, m.sessionId));
        }
      };
      ws.onclose = () => { this.pending.forEach((p) => p.reject(new Error("Brauzer yopildi."))); this.pending.clear(); if (this.onclose) this.onclose(); };
    }
    static async connect(wsUrl) { return new CDP(await Socket.connect(wsUrl)); }
    send(method, params, sessionId, timeout) {
      return new Promise((resolve, reject) => {
        if (this.ws.closed) return reject(new Error("Brauzer bilan aloqa yo'q."));
        const id = ++this.id;
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ": javob kelmadi")); }, timeout || 20000);
        this.pending.set(id, { resolve, reject, timer });
        const msg = { id, method, params: params || {} };
        if (sessionId) msg.sessionId = sessionId;
        this.ws.send(JSON.stringify(msg));
      });
    }
    on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
    off(method, fn) { const a = this.handlers.get(method) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    close() { this.ws.close(); }
  }

  root.GCCdp = { PROFILE, findBrowser, launch, Socket, CDP };
})(typeof window !== "undefined" ? window : globalThis);
