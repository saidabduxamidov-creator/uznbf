/* Faqat sinov uchun: CEP muhitidagi Node modullarining brauzerdagi soddalashtirilgan o'rnini bosuvchilari. */
(function () {
  "use strict";

  /* ---- Buffer (kerakli qismi) ---- */
  class Buf extends Uint8Array {
    static alloc(n) { return new Buf(n); }
    static from(v, enc) {
      if (typeof v === "string") {
        if (enc === "base64") { const s = atob(v); const b = new Buf(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
        if (enc === "hex") { const b = new Buf(v.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(v.substr(i * 2, 2), 16); return b; }
        const u = new TextEncoder().encode(v); const b = new Buf(u.length); b.set(u); return b;
      }
      const b = new Buf(v.length); b.set(v); return b;
    }
    static concat(list) { const n = list.reduce((a, b) => a + b.length, 0); const out = new Buf(n); let o = 0; list.forEach((b) => { out.set(b, o); o += b.length; }); return out; }
    get dv() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
    toString(enc, s, e) {
      const sub = this.subarray(s || 0, e == null ? this.length : e);
      if (enc === "base64") { let t = ""; for (let i = 0; i < sub.length; i++) t += String.fromCharCode(sub[i]); return btoa(t); }
      if (enc === "ascii" || enc === "latin1") { let t = ""; for (let i = 0; i < sub.length; i++) t += String.fromCharCode(sub[i]); return t; }
      return new TextDecoder().decode(sub);
    }
    write(str, off) { for (let i = 0; i < str.length; i++) this[(off || 0) + i] = str.charCodeAt(i); return str.length; }
    readUInt16LE(o) { return this.dv.getUint16(o, true); }
    readUInt32LE(o) { return this.dv.getUint32(o, true); }
    readUInt16BE(o) { return this.dv.getUint16(o, false); }
    readUInt32BE(o) { return this.dv.getUint32(o, false); }
    readInt16LE(o) { return this.dv.getInt16(o, true); }
    readInt32LE(o) { return this.dv.getInt32(o, true); }
    readFloatLE(o) { return this.dv.getFloat32(o, true); }
    readIntLE(o, n) { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + this[o + i]; const lim = Math.pow(2, 8 * n - 1); return v >= lim ? v - lim * 2 : v; }
    writeUInt16LE(v, o) { this.dv.setUint16(o, v, true); }
    writeUInt32LE(v, o) { this.dv.setUint32(o, v, true); }
    writeInt16LE(v, o) { this.dv.setInt16(o, v, true); }
    slice(s, e) { return this.subarray(s, e); }
  }
  window.Buffer = Buf;
  window.process = { env: {}, versions: { node: "17.7.1" } };

  /* ---- xotiradagi disk ---- */
  const files = new Map(), dirs = new Set(["/", "C:/Users/Ali", "C:/Temp"]);
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const parent = (p) => norm(p).split("/").slice(0, -1).join("/") || "/";
  const mtimes = new Map();
  const enoent = (p) => Object.assign(new Error("ENOENT: " + p), { code: "ENOENT" });
  let tmp = 0;
  const fsShim = {
    existsSync: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    mkdirSync: (p) => { let q = norm(p); const stack = []; while (q && !dirs.has(q)) { stack.push(q); q = parent(q); } stack.forEach((d) => dirs.add(d)); },
    mkdtempSync: (prefix) => { const d = norm(prefix) + (++tmp); fsShim.mkdirSync(d); return d; },
    writeFileSync: (p, d) => { fsShim.mkdirSync(parent(p)); files.set(norm(p), typeof d === "string" ? Buf.from(d) : Buf.from(d)); mtimes.set(norm(p), Date.now()); },
    readFileSync: (p, enc) => { const b = files.get(norm(p)); if (!b) throw enoent(p); return enc ? b.toString(enc === "utf8" ? undefined : enc) : b; },
    statSync: (p) => {
      const n = norm(p);
      if (dirs.has(n)) return { isDirectory: () => true, size: 0, mtimeMs: 1 };
      if (files.has(n)) return { isDirectory: () => false, size: files.get(n).length, mtimeMs: mtimes.get(n) || 1 };
      throw enoent(p);
    },
    readdirSync: (p) => {
      const n = norm(p); if (!dirs.has(n)) throw enoent(p);
      const out = new Set();
      [...files.keys(), ...dirs].forEach((k) => { if (k !== n && parent(k) === n) out.add(k.split("/").pop()); });
      return [...out];
    },
    unlinkSync: (p) => { files.delete(norm(p)); },
    unlink: (p, cb) => { files.delete(norm(p)); if (cb) cb(null); },
    renameSync: (a, b) => { files.set(norm(b), files.get(norm(a))); files.delete(norm(a)); },
    copyFileSync: (a, b) => { files.set(norm(b), files.get(norm(a))); },
    rmSync: (p) => { const n = norm(p); [...files.keys()].forEach((k) => { if (k.startsWith(n)) files.delete(k); }); dirs.delete(n); },
    rm: (p, o, cb) => { fsShim.rmSync(p); if (cb) cb(null); },
  };
  window.__vfs = { files, dirs };

  const pathShim = {
    join: (...a) => a.join("/").replace(/\\/g, "/").replace(/\/+/g, "/"),
    basename: (p, ext) => { const b = norm(p).split("/").pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    dirname: (p) => parent(p),
    extname: (p) => (norm(p).split("/").pop().match(/\.[^.]*$/) || [""])[0],
    relative: (from, to) => norm(to).slice(norm(from).length + 1),
  };
  // Node yo'llarini sinov diskidagi fayllarga bog'lash (kadr eksporti host tomonida Node fs'ga yoziladi)
  const urlShim = { pathToFileURL: (p) => ({ href: files.has(norm(p)) ? URL.createObjectURL(new Blob([files.get(norm(p))], { type: /\.png$/.test(p) ? "image/png" : "audio/wav" })) : "file://" + norm(p) }) };
  const osShim = { homedir: () => "C:/Users/Ali", tmpdir: () => "C:/Temp" };

  window.require = (m) => ({ fs: fsShim, path: pathShim, os: osShim, url: urlShim }[m] || {});
  window.cep = {
    util: { openURLInDefaultBrowser() {} },
    fs: { showSaveDialogEx: () => ({ err: 1 }), showOpenDialogEx: () => ({ err: 1 }) },
  };
  window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(el) { setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 0); } unobserve() {} };

  /* Premiere - Node tomonidagi host.jsx ga ko'prik; kadr eksporti bo'lsa PNG'ni virtual diskka qo'yamiz */
  window.__adobe_cep__ = {
    getSystemPath: () => "file:///C:/ext",
    evalScript(script, cb) {
      window.__hostEval(script).then((r) => {
        try {
          const j = JSON.parse(r);
          const pngs = (j && (j.files || (j.frame ? [j.frame] : []))) || [];
          pngs.forEach((p) => {
            const c = document.createElement("canvas"); c.width = 108; c.height = 192;
            const g = c.getContext("2d"); g.fillStyle = "#4a6"; g.fillRect(0, 0, 108, 192);
            const bin = atob(c.toDataURL("image/png").split(",")[1]); const b = new Buf(bin.length);
            for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
            fsShim.writeFileSync(p, b);
          });
        } catch (e) { /* JSON emas */ }
        cb(r);
      });
    },
  };
})();
