/*
 * GeminiCut - Sound effektlar kutubxonasi (Animation Composer uslubida).
 *  - Papkalar daraxti: Sevimlilar, bazaviy to'plam va o'z papkalaringiz
 *  - Kartalar: to'lqin shakli, nom, davomiylik, yulduzcha
 *  - Bosish = tinglash, "+" yoki ikki marta bosish = playhead joyiga qo'yish
 *  - Yangi papka va kompyuterdan yuklash
 * Fayllar: Documents\GeminiCut\Sounds\<papka>\<fayl>
 */
(function () {
  "use strict";

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const $ = (id) => document.getElementById(id);

  const ROOT = path.join(os.homedir(), "Documents", "GeminiCut", "Sounds");
  const META = path.join(ROOT, ".geminicut.json");
  const EXT = /\.(wav|mp3|m4a|aac|aiff|aif|ogg|flac)$/i;
  const FAV = "★ Sevimlilar";
  const ALL = "Barchasi";

  const state = { folder: ALL, query: "", favOnly: false, meta: { favorites: [], builtin: [], pack: 0, deleted: [] }, peaks: {}, playing: null, items: [], cardSize: 2 };

  /* ---------------- fayl tizimi ---------------- */

  function loadMeta() {
    try { Object.assign(state.meta, JSON.parse(fs.readFileSync(META, "utf8"))); } catch (e) { /* birinchi ishga tushirish */ }
  }
  function saveMeta() {
    try { fs.writeFileSync(META, JSON.stringify(state.meta)); } catch (e) { /* e'tiborsiz */ }
  }
  const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");

  function folders() {
    try {
      return fs.readdirSync(ROOT).filter((n) => !n.startsWith(".") && fs.statSync(path.join(ROOT, n)).isDirectory())
        .sort((a, b) => a.localeCompare(b));
    } catch (e) { return []; }
  }

  function filesIn(folder) {
    try {
      return fs.readdirSync(path.join(ROOT, folder)).filter((n) => EXT.test(n)).sort((a, b) => a.localeCompare(b))
        .map((n) => ({ folder, name: n.replace(EXT, ""), file: path.join(ROOT, folder, n) }));
    } catch (e) { return []; }
  }

  function allItems() {
    return folders().reduce((acc, f) => acc.concat(filesIn(f)), []);
  }

  /* Bazaviy to'plamni bir marta yaratadi (o'chirilganlari qayta yaratilmaydi) */
  async function ensurePack(onProgress) {
    fs.mkdirSync(ROOT, { recursive: true });
    loadMeta();
    const gen = window.GCSfxGen;
    if (!gen || state.meta.pack >= gen.PACK_VERSION) return 0;
    const list = gen.list();
    let made = 0;
    for (let i = 0; i < list.length; i++) {
      const { folder, name } = list[i];
      const file = path.join(ROOT, folder, name + ".wav");
      const id = rel(file);
      if (!state.meta.builtin.includes(id)) state.meta.builtin.push(id);
      if (fs.existsSync(file) || state.meta.deleted.includes(id)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, gen.render(i));
      made++;
      if (onProgress) onProgress(i + 1, list.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    // To'plamdan olib tashlangan bazaviy effektlar (faqat plagin yaratganlari) diskdan ham o'chiriladi
    const current = new Set(list.map(({ folder, name }) => rel(path.join(ROOT, folder, name + ".wav"))));
    state.meta.builtin = state.meta.builtin.filter((id) => {
      if (current.has(id)) return true;
      const f = path.join(ROOT, id);
      try { if (fs.existsSync(f)) fs.unlinkSync(f); const d = path.dirname(f); if (d !== ROOT && !fs.readdirSync(d).length) fs.rmdirSync(d); } catch (e) { /* e'tiborsiz */ }
      return false;
    });
    fs.mkdirSync(path.join(ROOT, "Mening effektlarim"), { recursive: true });
    state.meta.pack = gen.PACK_VERSION;
    saveMeta();
    return made;
  }

  /* ---------------- to'lqin shakli ---------------- */

  function wavPeaks(file, n) {
    const buf = fs.readFileSync(file);
    if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
    let pos = 12, fmt = null;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
      if (id === "fmt ") fmt = { ch: buf.readUInt16LE(pos + 10), sr: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22), fmt: buf.readUInt16LE(pos + 8) };
      if (id === "data" && fmt && fmt.fmt === 1 && fmt.bits === 16) {
        const start = pos + 8, frames = Math.floor(Math.min(size, buf.length - start) / (2 * fmt.ch));
        const peaks = new Array(n).fill(0);
        const step = Math.max(1, Math.floor(frames / (n * 64)));
        for (let f = 0; f < frames; f += step) {
          const v = Math.abs(buf.readInt16LE(start + f * 2 * fmt.ch)) / 32768;
          const k = Math.floor((f / frames) * n);
          if (v > peaks[k]) peaks[k] = v;
        }
        return { peaks, duration: frames / fmt.sr };
      }
      pos += 8 + size + (size & 1);
    }
    return null;
  }

  async function decodedPeaks(file, n) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const b = fs.readFileSync(file);
      const audio = await ctx.decodeAudioData(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      const d = audio.getChannelData(0), peaks = new Array(n).fill(0);
      const step = Math.max(1, Math.floor(d.length / (n * 64)));
      for (let i = 0; i < d.length; i += step) { const k = Math.floor((i / d.length) * n); peaks[k] = Math.max(peaks[k], Math.abs(d[i])); }
      return { peaks, duration: audio.duration };
    } finally { ctx.close(); }
  }

  async function peaksFor(item) {
    const key = item.file + "|" + fs.statSync(item.file).mtimeMs;
    if (state.peaks[key]) return state.peaks[key];
    let p = null;
    try { p = wavPeaks(item.file, 80); } catch (e) { /* boshqa format */ }
    if (!p) { try { p = await decodedPeaks(item.file, 80); } catch (e) { p = { peaks: new Array(80).fill(0.05), duration: 0 }; } }
    const max = Math.max(0.01, ...p.peaks);
    p.peaks = p.peaks.map((v) => v / max);
    state.peaks[key] = p;
    return p;
  }

  function drawWave(canvas, peaks, progress) {
    const g = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
    g.clearRect(0, 0, w, h);
    const bw = w / peaks.length;
    peaks.forEach((v, i) => {
      const bh = Math.max(1.5, v * (h - 4));
      g.fillStyle = progress != null && i / peaks.length <= progress ? "#8ea2ff" : "#e7ecf6";
      g.fillRect(i * bw + 0.5, (h - bh) / 2, Math.max(1, bw - 1), bh);
    });
  }

  /* ---------------- UI ---------------- */

  function status(text, error) {
    const el = $("sfxStatus");
    el.textContent = text;
    el.classList.toggle("error", !!error);
  }

  function renderFolders() {
    const box = $("sfxFolders");
    box.innerHTML = "";
    const fav = state.meta.favorites.length;
    const entries = [[ALL, allItems().length], [FAV, fav]].concat(folders().map((f) => [f, filesIn(f).length]));
    entries.forEach(([name, count], i) => {
      const b = document.createElement("button");
      b.className = "sfx-folder" + (state.folder === name ? " on" : "") + (i < 2 ? " special" : "");
      b.innerHTML = `<svg><use href="#i-folder"/></svg><span></span><em>${count}</em>`;
      b.querySelector("span").textContent = name;
      b.title = name;
      b.addEventListener("click", () => { state.folder = name; renderFolders(); renderGrid(); });
      box.appendChild(b);
      if (i === 1) { const d = document.createElement("div"); d.className = "sfx-sep"; box.appendChild(d); }
    });
  }

  function visibleItems() {
    let items = state.folder === ALL ? allItems() : state.folder === FAV ? allItems().filter((it) => state.meta.favorites.includes(rel(it.file))) : filesIn(state.folder);
    const q = state.query.trim().toLowerCase();
    if (q) items = items.filter((it) => (it.name + " " + it.folder).toLowerCase().includes(q));
    return items;
  }

  function stopPreview() {
    const p = $("sfxPlayer");
    p.pause();
    if (state.playing) state.playing.card.classList.remove("playing");
    state.playing = null;
  }

  function preview(item, card, canvas, peaks) {
    const p = $("sfxPlayer");
    if (state.playing && state.playing.card === card) { stopPreview(); drawWave(canvas, peaks); return; }
    stopPreview();
    p.src = require("url").pathToFileURL(item.file).href;
    p.volume = Number($("sfxVolume").value);
    p.currentTime = 0;
    p.play().catch((e) => status("Tinglab bo'lmadi: " + e.message, true));
    card.classList.add("playing");
    state.playing = { card, canvas, peaks };
    const tick = () => {
      if (!state.playing || state.playing.card !== card) { drawWave(canvas, peaks); return; }
      drawWave(canvas, peaks, p.duration ? p.currentTime / p.duration : 0);
      if (!p.paused) requestAnimationFrame(tick); else { card.classList.remove("playing"); drawWave(canvas, peaks); state.playing = null; }
    };
    requestAnimationFrame(tick);
  }

  async function insert(item, at) {
    if (window.GCApplication && window.GCApplication.isBusy()) throw new Error("Joriy ish tugashini kuting.");
    const track = Number($("sfxTrack").value);
    const avoid = window.GCApplication ? window.GCApplication.speechTracks() : [];
    const r = await GCHost.call("gc_insertSound", [item.file, track, at == null ? -1 : at, avoid], 60000);
    return r;
  }

  function toggleFav(item, star) {
    const id = rel(item.file), f = state.meta.favorites;
    const i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1); else f.push(id);
    saveMeta();
    star.classList.toggle("on", i < 0);
    renderFolders();
  }

  let gridGen = 0;
  async function renderGrid() {
    const gen = ++gridGen;
    const grid = $("sfxGrid");
    grid.innerHTML = "";
    grid.dataset.size = state.cardSize;
    const items = visibleItems();
    state.items = items;
    if (!items.length) {
      grid.innerHTML = `<div class="sfx-empty">${state.folder === FAV ? "Sevimlilar bo'sh. Kartadagi ★ ni bosing." : "Bu papkada effekt yo'q. “Yuklash” orqali qo'shing."}</div>`;
      status("");
      return;
    }
    status(`${items.length} ta effekt · bosing - tinglash, "+" - playhead joyiga qo'yish`);
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { observer.unobserve(e.target); e.target._load(); } });
    }, { root: $("sfxGrid") });

    for (const item of items) {
      if (gen !== gridGen) return;
      const card = document.createElement("div");
      card.className = "sfx-card";
      card.title = item.folder + " / " + item.name + "\nIkki marta bosing - timeline'ga qo'yish";
      card.innerHTML = `<canvas width="240" height="54"></canvas>
        <div class="sfx-meta"><svg class="sfx-ico"><use href="#i-wave"/></svg><span class="sfx-name"></span>
        <button class="sfx-star" title="Sevimlilar">★</button><button class="sfx-add" title="Playhead joyiga qo'yish">+</button></div>
        <span class="sfx-dur"></span>`;
      card.querySelector(".sfx-name").textContent = item.name;
      const canvas = card.querySelector("canvas");
      const star = card.querySelector(".sfx-star");
      star.classList.toggle("on", state.meta.favorites.includes(rel(item.file)));
      let peaks = null;
      card._load = async () => {
        const p = await peaksFor(item);
        peaks = p.peaks;
        item.duration = p.duration;
        drawWave(canvas, peaks);
        card.querySelector(".sfx-dur").textContent = p.duration ? p.duration.toFixed(1) + "s" : "";
      };
      card.addEventListener("click", (e) => {
        if (e.target.closest(".sfx-star, .sfx-add")) return;
        if (peaks) preview(item, card, canvas, peaks);
      });
      const doInsert = async () => {
        card.classList.add("busy");
        try {
          const r = await insert(item);
          status(window.GCHost.app === "ae" ? `✓ "${item.name}" qatlam bo'lib ${r.at.toFixed(2)}s da qo'yildi.` : `✓ "${item.name}" A${r.track + 1} trekka ${r.at.toFixed(2)}s da qo'yildi.`);
        } catch (err) { status(err.message, true); }
        finally { card.classList.remove("busy"); }
      };
      card.addEventListener("dblclick", doInsert);
      card.querySelector(".sfx-add").addEventListener("click", doInsert);
      star.addEventListener("click", () => toggleFav(item, star));
      card.addEventListener("contextmenu", (e) => { e.preventDefault(); removeItem(item); });
      grid.appendChild(card);
      observer.observe(card);
    }
  }

  function removeItem(item) {
    if (!confirm(`"${item.name}" o'chirilsinmi?\n${item.file}`)) return;
    try {
      fs.unlinkSync(item.file);
      const id = rel(item.file);
      if (state.meta.builtin.includes(id) && !state.meta.deleted.includes(id)) state.meta.deleted.push(id);
      state.meta.favorites = state.meta.favorites.filter((f) => f !== id);
      saveMeta();
      renderFolders();
      renderGrid();
      status(`"${item.name}" o'chirildi.`);
    } catch (e) { status(e.message, true); }
  }

  function validFolderName(n) {
    return n && !/[\\/:*?"<>|\x00-\x1f]/.test(n) && !/[. ]$/.test(n) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(n) && n !== ALL && n !== FAV;
  }

  function newFolder() {
    const box = $("sfxNewFolder");
    box.hidden = !box.hidden;
    if (!box.hidden) $("sfxFolderName").focus();
  }

  function createFolder() {
    const n = $("sfxFolderName").value.trim();
    if (!validFolderName(n)) return status("Papka nomida \\ / : * ? \" < > | belgilari bo'lmasin.", true);
    const dir = path.join(ROOT, n);
    if (fs.existsSync(dir)) return status("Bunday papka bor.", true);
    fs.mkdirSync(dir, { recursive: true });
    $("sfxFolderName").value = "";
    $("sfxNewFolder").hidden = true;
    state.folder = n;
    renderFolders();
    renderGrid();
    status(`"${n}" papkasi yaratildi. Endi "Yuklash" orqali effekt qo'shing.`);
  }

  function importFiles() {
    let target = state.folder;
    if (target === ALL || target === FAV) target = "Mening effektlarim";
    let r;
    try { r = window.cep.fs.showOpenDialogEx(true, false, `Effektlarni tanlang → "${target}"`, "", ["wav", "mp3", "m4a", "aac", "aiff", "aif", "ogg", "flac"]); }
    catch (e) { return status("Fayl oynasi ochilmadi: " + e.message, true); }
    if (!r || r.err || !r.data || !r.data.length) return;
    fs.mkdirSync(path.join(ROOT, target), { recursive: true });
    let n = 0;
    r.data.forEach((file) => {
      if (!EXT.test(file)) return;
      const ext = path.extname(file), base = path.basename(file, ext);
      let name = base + ext, i = 2;
      while (fs.existsSync(path.join(ROOT, target, name))) name = `${base} (${i++})${ext}`;
      fs.copyFileSync(file, path.join(ROOT, target, name));
      n++;
    });
    state.folder = target;
    renderFolders();
    renderGrid();
    status(`${n} ta effekt "${target}" papkasiga qo'shildi.`);
  }

  function fillTracks() {
    const sel = $("sfxTrack");
    const cur = sel.value;
    const seq = window.GCApplication ? window.GCApplication.sequence() : null;
    sel.innerHTML = '<option value="-1">Avto (bo\'sh trek)</option>';
    (seq ? seq.audioTracks : []).forEach((t) => {
      const o = document.createElement("option");
      o.value = t.index;
      o.textContent = `A${t.index + 1} · ${t.name}`;
      sel.appendChild(o);
    });
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "-1";
  }

  async function init() {
    $("sfxSearch").addEventListener("input", (e) => { state.query = e.target.value; renderGrid(); });
    $("sfxAddFolder").addEventListener("click", newFolder);
    $("sfxCreateFolder").addEventListener("click", createFolder);
    $("sfxFolderName").addEventListener("keydown", (e) => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") $("sfxNewFolder").hidden = true; });
    $("sfxImport").addEventListener("click", importFiles);
    $("sfxOpenFolder").addEventListener("click", () => {
      try { require("child_process").spawn("explorer.exe", [ROOT], { detached: true, stdio: "ignore" }).unref(); } catch (e) { status(ROOT); }
    });
    $("sfxSize").addEventListener("input", (e) => { state.cardSize = Number(e.target.value); $("sfxGrid").dataset.size = state.cardSize; });
    $("sfxVolume").addEventListener("input", (e) => { $("sfxPlayer").volume = Number(e.target.value); });
    document.querySelector('[data-tab="sounds"]').addEventListener("click", () => { fillTracks(); });
    try {
      const made = await ensurePack((i, n) => status(`Bazaviy effektlar to'plami tayyorlanmoqda… ${i}/${n}`));
      if (made) status(`${made} ta bazaviy effekt tayyorlandi.`);
      renderFolders();
      renderGrid();
    } catch (e) {
      status("Kutubxona ochilmadi: " + e.message, true);
    }
  }

  window.GCLibrary = {
    init,
    root: ROOT,
    /* Claude uchun ro'yxat: id, papka, nom, davomiylik */
    async index() {
      const items = allItems();
      for (const it of items) { try { it.duration = (await peaksFor(it)).duration; } catch (e) { it.duration = 0; } }
      return items.map((it) => ({ id: rel(it.file), folder: it.folder, name: it.name, duration: Math.round((it.duration || 0) * 100) / 100, file: it.file }));
    },
    fileById: (id) => path.join(ROOT, id),
    refreshTracks: fillTracks,
  };
})();
