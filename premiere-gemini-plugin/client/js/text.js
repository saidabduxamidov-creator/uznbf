/*
 * GeminiCut - "Matn" bo'limi: shablon tanlash, jonli oldindan ko'rish, oddiy sozlamalar,
 * timeline'ga qo'yish va keyin playhead'dagi matnni qayta tahrirlash.
 */
(function () {
  "use strict";

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const url = require("url");
  const $ = (id) => document.getElementById(id);
  const T = () => window.GCTextFX;
  const LS = "geminicut.text.v1";
  const LS_MODE = "geminicut.text.mode";

  let R = null, kind = "2d", editing = null, busy = false, token = null, mode = "native";
  let drawer = null, drawerKey = "", bgImage = null, playing = true, t0 = performance.now(), thumbsDone = {};

  const ROOT = () => { const d = path.join(os.homedir(), "Documents", "GeminiCut", "Matn"); fs.mkdirSync(d, { recursive: true }); return d; };
  const status = (t, err) => { const el = $("txStatus"); el.textContent = t; el.classList.toggle("error", !!err); };

  function load() {
    try { R = Object.assign({}, T().DEFAULT, JSON.parse(localStorage.getItem(LS) || "null") || {}); } catch (e) { R = Object.assign({}, T().DEFAULT); }
    if (!T().TEMPLATES.some((t) => t.id === R.template)) R = T().recipeFor("pop", { text: R.text }); // olib tashlangan shablon
    kind = T().byId(R.template).kind;
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(R)); } catch (e) { /* e'tiborsiz */ } }

  function frameSize() {
    const s = window.GCApplication.sequence() || {};
    return { W: s.width || 1920, H: s.height || 1080, fps: s.fps || 25 };
  }

  /* ---------------- shablonlar to'ri ---------------- */

  function renderGrid() {
    const box = $("txGrid");
    box.innerHTML = "";
    T().TEMPLATES.filter((t) => t.kind === kind).sort((a, b) => (b.logo ? 1 : 0) - (a.logo ? 1 : 0)).forEach((tp) => { // logolar birinchi
      const b = document.createElement("button");
      b.className = "tx-card" + (R.template === tp.id ? " on" : "");
      b.dataset.id = tp.id;
      b.title = tp.desc;
      const c = document.createElement("canvas");
      c.width = 192; c.height = 108;
      const n = document.createElement("span");
      n.textContent = tp.name;
      b.append(c, n);
      b.addEventListener("click", () => pickTemplate(tp.id));
      box.appendChild(b);
    });
    requestAnimationFrame(drawThumbs);
  }

  let thumb3d = null;
  function drawThumbs() {
    document.querySelectorAll("#txGrid .tx-card").forEach((b) => {
      const id = b.dataset.id, c = b.querySelector("canvas");
      if (thumbsDone[id]) { c.getContext("2d").drawImage(thumbsDone[id], 0, 0); return; }
      const tp = T().byId(id);
      const sample = { "3d": "3D", plate: "MATN" }[tp.kind];
      const lower = tp.oneLine && tp.sub && tp.id !== "plate_subscribe";
      const base = { duration: 3, x: lower ? 0.1 : 0.5, y: lower ? 0.55 : 0.5 };
      if (sample != null) base.text = sample;
      if (tp.kind === "2d") Object.assign(base, { text: lower ? "Ism Familiya" : "MATN", sub: "Lavozim", size: lower ? 0.12 : 0.24 });
      if (tp.kind === "3d") base.size = 0.42;
      if (tp.kind === "plate") Object.assign(base, { text: tp.id === "plate_chat" ? "Salom!\nQalaysiz?" : tp.id === "plate_subscribe" ? "OBUNA" : "MATN", size: tp.id === "plate_chat" ? 0.12 : 0.16, sub: tp.id === "plate_subscribe" ? "TAYYOR" : "Lavozim" });
      const rec = T().recipeFor(id, base);
      if (tp.kind === "plate") { rec.text = base.text; rec.size = base.size; } // qisqa namuna - kartada katta ko'rinsin
      if (tp.kind === "3d" && !tp.logo) rec.size = 0.42;
      if (tp.kind === "gym") { rec.size = Math.min(0.32, (tp.set.size || 0.08) * 2.6); if (lower) rec.size = 0.13; }
      if (tp.logo) {
        rec.size = 0.26;
        if (tp.custom) { rec.logo = customLogo(); if (!rec.logo) { rec.text = "LOGO"; rec.material = "chrome"; } }
        if (rec.logo && !T().logoReady(rec.logo)) { T().loadLogo(rec.logo).then(() => requestAnimationFrame(drawThumbs)).catch(() => {}); return; }
      }
      if (tp.kind === "plate" && !/chat|subscribe/.test(id)) rec.size = 0.26;
      const off = document.createElement("canvas"); off.width = 192; off.height = 108;
      try {
        if (tp.kind === "3d") {
          if (!thumb3d) { const cv = document.createElement("canvas"); cv.width = 192; cv.height = 108; thumb3d = { cv, r: new (T().Renderer3D)(cv) }; }
          thumb3d.r.draw(rec, 1.6);
          off.getContext("2d").drawImage(thumb3d.cv, 0, 0);
        } else {
          T().draw2D(off, rec, id === "kinetic" ? 2.2 : id === "plate_subscribe" ? 2.2 : tp.kind === "bg" ? 2.4 : 1.6);
        }
      } catch (e) { /* WebGL yo'q - bo'sh karta */ }
      thumbsDone[id] = off;
      c.getContext("2d").drawImage(off, 0, 0);
    });
  }

  const LS_LOGO = "geminicut.text.customLogo";
  function customLogo() { try { return localStorage.getItem(LS_LOGO) || ""; } catch (e) { return ""; } }

  function pickTemplate(id) {
    const prev = R, tp = T().byId(id);
    R = T().recipeFor(id, { duration: prev.duration, speed: prev.speed });
    if (tp.custom) R.logo = customLogo();
    if (tp.logo) { R.duration = Math.max(prev.duration, 3); }
    // foydalanuvchi yozgan matn saqlanadi (shablonning namuna matni faqat standart matn o'rniga)
    if (prev.text && (prev.text !== T().DEFAULT.text || !(tp.set && tp.set.text))) R.text = prev.text;
    if (prev.sub) R.sub = prev.sub;
    save();
    syncControls();
    document.querySelectorAll("#txGrid .tx-card").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    t0 = performance.now();
  }

  function setKind(k) {
    kind = k;
    document.querySelectorAll("#txKind button").forEach((b) => b.classList.toggle("on", b.dataset.v === k));
    document.querySelectorAll("#view-text [data-kind]").forEach((el) => { el.hidden = !el.dataset.kind.split(" ").includes(k); });
    if (T().byId(R.template).kind !== k) pickTemplate((T().TEMPLATES.find((t) => t.kind === k && t.logo && !t.custom) || T().TEMPLATES.find((t) => t.kind === k)).id);
    syncControls();
    renderGrid();
  }

  /* ---------------- sozlamalar ---------------- */

  const BIND = [
    ["txText", "text", "value"], ["txSub", "sub", "value"], ["txFont", "font", "value"], ["txUpper", "upper", "checked"],
    ["txColor", "color", "value"], ["txColor2", "color2", "value"], ["txAccent", "accent", "value"],
    ["txSize", "size", "num"], ["txSpacing", "spacing", "num"], ["txShadow", "shadow", "num"], ["txStroke", "stroke", "num"], ["txGlow", "glow", "num"],
    ["txMaterial", "material", "value"], ["txLiquid", "liquid", "num"], ["txFlow", "flow", "num"], ["txDepth", "depth", "num"], ["txRot", "rot", "num"],
    ["txBevel", "bevel", "num"], ["txDrops", "drops", "checked"], ["txX", "x", "num"], ["txY", "y", "num"], ["txDur", "duration", "num"], ["txSpeed", "speed", "num"],
    ["txNoText", "noText", "checked"], ["txPadX", "padX", "num"], ["txPadY", "padY", "num"],
  ];

  function syncControls() {
    BIND.forEach(([id, key, prop]) => { const el = $(id); if (!el) return; if (prop === "checked") el.checked = !!R[key]; else el.value = R[key]; });
    document.querySelectorAll("#txWeight button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === Number(R.weight) || (Number(b.dataset.v) === 700 && R.weight >= 600 && R.weight < 850) || (Number(b.dataset.v) === 900 && R.weight >= 850)));
    updateModeHint();
    const tp = T().byId(R.template);
    $("txSubWrap").hidden = !tp.sub;
    // logo shablonlari: matn va rang kerak emas, faqat 3D sozlamalari
    if (tp.noText) $("txTextCard").hidden = true; else if (tp.kind === kind) $("txTextCard").hidden = false;
    document.querySelectorAll("#view-text .tx-nologo").forEach((el) => { el.hidden = !!tp.logo; });
    $("txLogoRow").hidden = !tp.custom;
    $("txLogoPath").value = tp.custom ? R.logo || "" : "";
    $("txSizeVal").textContent = Math.round(R.size * 1000) / 10 + "%";
    $("txDurVal").textContent = Number(R.duration).toFixed(1) + "s";
    document.querySelectorAll("#txPos button").forEach((b) => b.classList.toggle("on", Math.abs(Number(b.dataset.x) - R.x) < 0.02 && Math.abs(Number(b.dataset.y) - R.y) < 0.02));
  }

  function onControl(id, key, prop) {
    const el = $(id);
    el.addEventListener(prop === "checked" || el.tagName === "SELECT" ? "change" : "input", () => {
      R[key] = prop === "checked" ? el.checked : prop === "num" ? Number(el.value) : el.value;
      if (key === "material") R.drops = R.drops; // material o'zgarsa ham shablon qoladi
      save(); syncControls();
    });
  }

  /* ---------------- oldindan ko'rish ---------------- */

  function ensureDrawer() {
    const { W, H } = frameSize();
    const k = Math.min(1, 560 / Math.max(W, H));
    const w = Math.max(16, Math.round(W * k)), h = Math.max(16, Math.round(H * k));
    const key = [w, h, T().is3D(R)].join("|");
    if (drawer && drawerKey === key) return drawer;
    try { drawer = T().makeDrawer(w, h, R); drawerKey = key; } catch (e) { drawer = null; drawerKey = ""; status(e.message, true); }
    const cv = $("txPreview");
    cv.width = w; cv.height = h;
    return drawer;
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!$("view-text").classList.contains("active")) return;
    const d = ensureDrawer();
    if (!d) return;
    const D = Math.max(0.5, R.duration);
    let t;
    if (playing) { t = ((performance.now() - t0) / 1000) % (D + 0.6); if (t > D) t = D; $("txScrub").value = Math.round((t / D) * 1000); }
    else t = (Number($("txScrub").value) / 1000) * D;
    $("txTime").textContent = t.toFixed(1) + "s";
    try { d.draw(R, t); } catch (e) { return; }
    const cv = $("txPreview"), ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (bgImage) ctx.drawImage(bgImage, 0, 0, cv.width, cv.height);
    ctx.drawImage(d.canvas, 0, 0);
  }

  async function grabBackground() {
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-txbg-"));
      const seq = window.GCApplication.sequence() || {};
      const r = await window.GCHost.call("gc_exportFrames", [path.join(dir, "bg"), [seq.playhead || 0]], 60000);
      if (!r.files.length) throw new Error("Kadr olinmadi");
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("Kadr o'qilmadi")); const href = url.pathToFileURL(r.files[0]).href; img.src = /^file:/.test(href) ? href + "?t=" + Date.now() : href; });
      bgImage = img;
      status("Fon: playhead'dagi kadr.");
    } catch (e) { status("Fon kadri olinmadi: " + e.message, true); }
  }

  /* ---------------- timeline'ga qo'yish / tahrirlash ---------------- */

  function slug(s) { return String(s || "matn").toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 24) || "matn"; }
  function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

  const hostApp = () => window.GCHost.app || (document.body.classList.contains("resolve") ? "resolve" : "ppro");
  /* AE va Resolve: shablon muharrirning o'z qatlamlari / Fusion vositalari bilan quriladi */
  const useNative = (rec = R, insertMode = mode) => (hostApp() === "ae" || hostApp() === "resolve") && insertMode === "native" && T().nativeSupported(rec, hostApp());

  function pngSize(file) {
    try {
      const b = fs.readFileSync(file);
      if (b.length > 24 && b.readUInt32BE(12) === 0x49484452) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    } catch (e) { /* o'qilmadi */ }
    return null;
  }

  function nativeSpecFor(W, H, rec = R) {
    const spec = T().nativeSpec(rec);
    spec.W = W; spec.H = H; spec.recipe = Object.assign({}, rec);
    if (spec.logo) {
      spec.logo = T().assetPath(spec.logo);
      spec.img = pngSize(spec.logo);
    } else {
      const m = T().nativeMeasure(rec, W, H);
      if (m) { spec.size = m.size; spec.box = m.box; }
    }
    return spec;
  }

  function updateModeHint() {
    const el = $("txModeHint");
    if (!el) return;
    document.querySelectorAll("#txMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === mode));
    const app = hostApp(), logo = !!T().byId(R.template).logo;
    let t = "";
    if (mode === "png") t = "Kadrlar (PNG): natija oldindan ko'rishdagidek. Matnni o'zgartirish - panelda (klipni tanlab “Tahrirlash”).";
    else if (!T().nativeSupported(R, app)) t = app === "resolve" && T().NATIVE[R.template]
      ? "Bu animatsiya (sanagich/taymer/yozuv) Resolve'da kadrlar (PNG) bo'lib qo'yiladi."
      : T().byId(R.template).kind === "3d" ? "3D suyuq matn faqat kadrlar (PNG) bo'lib qo'yiladi. Tahrirlanadigan 3D - logolar."
        : "Bu shablon (3D bloklar, xrom harflar) kadrlar (PNG) bo'lib qo'yiladi - natija aynan oldindan ko'rishdagidek.";
    else if (app === "ae") t = logo
      ? "AE qatlamlari: Null + 3D nusxalar. Null'dagi “Qalinlik” slayderi - chuqurlik; aylanish, o'lcham, joy - Null'ning Transform'ida."
      : "AE qatlamlari: matnni kompozitsiyada ikki marta bosib o'zgartiring; shrift/rang - Character paneli; fon matn o'lchamiga o'zi moslashadi; animatsiya - oddiy keyframe'lar.";
    else t = logo
      ? "Resolve Fusion: klipni tanlab Fusion sahifasini oching - GCLogo3D (aylanish/o'lcham), GCLogoQatlam (qalinlik), GCLogoRasm (rasm) Inspector'da."
      : "Resolve Fusion: klipni tanlab Fusion sahifasini oching - GCMatn (Text+) Inspector'da matn, shrift, rang, o'lcham; GCPlashka - fon; GCHarakat - animatsiya.";
    el.textContent = t;
  }

  /*
   * Puts a recipe on the timeline (used by the panel button and by the local MCP bridge).
   * opts: { editing, insertMode: "native" | "png", token, onProgress(i, total), onStatus(text) }
   * Returns { track, seconds, mode: "native" | "png", layers?, frames?, reason?, message }.
   */
  async function place(rec, opts = {}) {
    const tpl = T().byId(rec.template);
    if (tpl.custom && !rec.logo) throw new Error("Avval logo PNG faylini yuklang.");
    if (!tpl.noText && !String(rec.text || "").trim()) throw new Error("Matnni yozing.");
    if (!window.GCHost.available) throw new Error("Panel muharrir ichida ochilishi kerak.");
    const say = opts.onStatus || (() => undefined);
    const editingTarget = opts.editing || null;
    let seq = window.GCApplication.sequence();
    if (!seq || !seq.width) seq = await window.GCHost.call("gc_getSequenceInfo", [], 20000);
    const W = seq.width || 1920, H = seq.height || 1080, fps = seq.fps || 25;
    const ae = hostApp() === "ae", native = useNative(rec, opts.insertMode || mode);
    const where = (r) => `${ae ? "qatlam #" + (r.track + 1) : "V" + (r.track + 1)}, ${window.GCSubs.formatClock(r.seconds)}`;
    const what = tpl.logo ? "Logo" : "Matn", done = editingTarget ? what + " yangilandi" : what + " qo'yildi";
    if (native && ae) { // AE: render kerak emas - qatlamlar to'g'ridan-to'g'ri
      say("After Effects qatlamlari yaratilmoqda…");
      const r = await window.GCHost.call("gc_insertNative", [nativeSpecFor(W, H, rec), -1, editingTarget], 120000);
      return { track: r.track, seconds: r.seconds, mode: "native", layers: r.layers,
        message: `✓ ${done}: ${where(r)} - ${r.layers} ta qatlam. Endi uni After Effects'ning o'zida tahrirlash mumkin.` };
    }
    const dir = path.join(ROOT(), `${stamp()}_${rec.template}_${slug(rec.text)}`);
    const n = Math.max(1, Math.round(rec.duration * fps));
    say(`Kadrlar chizilmoqda… 0/${n}`);
    const out = await T().render(rec, dir, { width: W, height: H, fps, token: opts.token,
      onProgress: (i, total) => { if (opts.onProgress) opts.onProgress(i, total); say(`Kadrlar chizilmoqda… ${i}/${total}`); } });
    say("Timeline'ga qo'yilmoqda…");
    const name = tpl.logo ? `Logo 3D · ${tpl.custom ? path.basename(rec.logo) : tpl.name}` : `Matn · ${tpl.name} · ${String(rec.text).split(/\n/)[0].slice(0, 24)}`;
    if (native) { // Resolve: PNG zaxira klipi + Fusion (Text+ / 3D)
      const r = await window.GCHost.call("gc_insertNative", [nativeSpecFor(W, H, rec), out.first, out.count, fps, -1, editingTarget, name], 180000);
      return { track: r.track, seconds: r.seconds, mode: r.mode, frames: out.count, ...(r.reason ? { reason: r.reason } : {}),
        message: r.mode === "native"
          ? `✓ ${done}: ${where(r)}. Fusion sahifasida tahrirlanadi (${tpl.logo ? "GCLogo3D" : "GCMatn"}).`
          : `✓ ${done} (kadrlar): ${where(r)}. Fusion qurilmadi: ${r.reason}` };
    }
    const r = await window.GCHost.call("gc_importSequence", [out.first, out.count, fps, -1, editingTarget, name], 180000);
    return { track: r.track, seconds: r.seconds, mode: "png", frames: out.count, message: `✓ ${done}: ${where(r)} (${out.count} kadr).` };
  }

  async function insert() {
    if (busy) return;
    busy = true; token = window.GCGemini.createCancelToken();
    setBusy(true);
    try {
      const r = await place(R, {
        editing, insertMode: mode, token, onStatus: (t) => status(t),
        onProgress: (i, total) => { $("txBar").style.width = Math.round((i / total) * 100) + "%"; $("txProgLabel").textContent = `${i}/${total}`; },
      });
      status(r.message, r.mode === "png" && !!r.reason);
      stopEditing();
      window.GCApplication.timelineChanged();
    } catch (e) {
      status(e.code === "CANCELLED" ? "Bekor qilindi." : e.message, e.code !== "CANCELLED");
    } finally {
      busy = false; token = null; setBusy(false);
    }
  }

  async function editAtPlayhead() {
    try {
      const r = await window.GCHost.call("gc_textAtPlayhead", [], 20000);
      let rec;
      if (r.native && r.recipe) rec = JSON.parse(r.recipe); // AE qatlamlari: retsept bosh qatlam izohida
      else {
        const file = path.join(path.dirname(r.path), "recipe.json");
        if (!fs.existsSync(file)) throw new Error("Bu matnning sozlamalari (recipe.json) topilmadi.");
        rec = JSON.parse(fs.readFileSync(file, "utf8"));
      }
      ["width", "height", "fps", "frames"].forEach((k) => delete rec[k]);
      R = Object.assign({}, T().DEFAULT, rec);
      save();
      editing = { track: r.track, start: r.start };
      setKind(T().byId(R.template).kind);
      syncControls();
      $("txInsert").querySelector("span").textContent = "Yangilash (almashtirish)";
      $("txStopEdit").hidden = false;
      status(`Tahrirlanmoqda: ${window.GCHost.app === "ae" ? "qatlam #" + (r.track + 1) : "V" + (r.track + 1)}, ${window.GCSubs.formatClock(r.start)}. O'zgartiring va “Yangilash” ni bosing.`);
    } catch (e) { status(e.message, true); }
  }

  function stopEditing() {
    editing = null;
    $("txInsert").querySelector("span").textContent = "Timeline'ga qo'yish";
    $("txStopEdit").hidden = true;
  }

  function setBusy(on) {
    ["txInsert", "txEdit", "txAI"].forEach((id) => { $(id).disabled = on; });
    $("txProgress").hidden = !on;
    if (!on) $("txBar").style.width = "0%";
  }

  /* ---------------- AI yordamchi ---------------- */

  async function askAI() {
    const q = $("txAsk").value.trim();
    if (!q) return status("AI uchun topshiriq yozing.", true);
    const btn = $("txAI");
    btn.disabled = true;
    status("AI matn va uslubni tanlamoqda…");
    try {
      const ids = T().TEMPLATES.filter((t) => !t.logo).map((t) => t.id);
      const tr = (window.GCApplication.transcript() || []).filter((s) => s.type === "speech").map((s) => s.text).join(" ").slice(0, 1500);
      const r = await window.GCAI.text({
        settings: window.GCApplication.settings(),
        system: "You design animated titles for short videos. Pick one template id and write the on-screen text (max 6 words per line, max 2 lines) in the user's language. Colours as #rrggbb with strong contrast for video.",
        prompt: `Templates: ${T().TEMPLATES.filter((t) => !t.logo).map((t) => `${t.id} (${t.kind}, ${t.desc})`).join("; ")}\n` + (tr ? `Video speech: ${tr}\n` : "") + `Request: ${q}`,
        schema: { type: "object", properties: {
          template: { type: "string", enum: ids }, text: { type: "string" }, sub: { type: "string", description: "Second line for lowerthird, else empty." },
          color: { type: "string" }, color2: { type: "string" }, accent: { type: "string" } } },
        effort: "low",
      });
      const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || "") ? v : d);
      R = T().recipeFor(r.template, { text: r.text, sub: r.sub || "", duration: R.duration, speed: R.speed });
      R.color = hex(r.color, R.color); R.color2 = hex(r.color2, R.color2); R.accent = hex(r.accent, R.accent);
      save();
      setKind(T().byId(R.template).kind);
      syncControls();
      t0 = performance.now();
      status("AI tanladi: " + T().byId(R.template).name + ". Kerak bo'lsa sozlang va timeline'ga qo'ying.");
    } catch (e) { status(e.message, true); } finally { btn.disabled = false; }
  }

  /* ---------------- ishga tushirish ---------------- */

  function init() {
    load();
    const fonts = $("txFont");
    T().FONTS.forEach((f) => { const o = document.createElement("option"); o.value = f; o.textContent = f; o.style.fontFamily = f; fonts.appendChild(o); });
    if (!T().FONTS.includes(R.font)) { const o = document.createElement("option"); o.value = R.font; o.textContent = R.font; fonts.appendChild(o); }
    BIND.forEach(([id, key, prop]) => { if ($(id)) onControl(id, key, prop); });
    document.querySelectorAll("#txWeight button").forEach((b) => b.addEventListener("click", () => { R.weight = Number(b.dataset.v); save(); syncControls(); }));
    document.querySelectorAll("#txPos button").forEach((b) => b.addEventListener("click", () => {
      R.x = Number(b.dataset.x); R.y = Number(b.dataset.y);
      R.align = R.template === "lowerthird" ? "left" : "center";
      save(); syncControls();
    }));
    document.querySelectorAll("#txKind button").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.v)));
    try { mode = localStorage.getItem(LS_MODE) === "png" ? "png" : "native"; } catch (e) { /* standart */ }
    document.querySelectorAll("#txMode button").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.v;
      try { localStorage.setItem(LS_MODE, mode); } catch (e) { /* e'tiborsiz */ }
      updateModeHint();
    }));
    $("txPlay").addEventListener("click", () => { playing = !playing; $("txPlay").textContent = playing ? "❚❚" : "▶"; if (playing) t0 = performance.now() - (Number($("txScrub").value) / 1000) * R.duration * 1000; });
    $("txScrub").addEventListener("input", () => { playing = false; $("txPlay").textContent = "▶"; });
    $("txBg").addEventListener("click", () => { if (bgImage) { bgImage = null; status("Fon o'chirildi."); } else grabBackground(); });
    $("txInsert").addEventListener("click", insert);
    $("txEdit").addEventListener("click", editAtPlayhead);
    $("txStopEdit").addEventListener("click", () => { stopEditing(); status(""); });
    $("txCancel").addEventListener("click", () => { if (token) token.cancel(); });
    $("txAI").addEventListener("click", askAI);
    $("txLogoPick").addEventListener("click", () => {
      const p = window.GCHost.openDialog("Logo (shaffof PNG)", ["png"]);
      if (!p) return;
      try { localStorage.setItem(LS_LOGO, p); } catch (e) { /* e'tiborsiz */ }
      R.logo = p; save(); syncControls();
      delete thumbsDone.logo_custom;
      T().loadLogo(p).then(() => { status("Logo yuklandi: " + path.basename(p)); renderGrid(); }).catch((e) => status(e.message, true));
    });
    $("txFolder").addEventListener("click", () => {
      const d = ROOT();
      try { require("child_process").spawn(process.platform === "win32" ? "explorer.exe" : "open", [d], { detached: true, stdio: "ignore" }).unref(); } catch (e) { status(d); }
    });
    setKind(kind);
    syncControls();
    requestAnimationFrame(tick);
  }

  window.GCText = {
    init, recipe: () => R, setRecipe: (r) => { R = Object.assign({}, T().DEFAULT, r); syncControls(); }, insert, editAtPlayhead, setKind,
    /* Used by the local MCP bridge: full recipe from a template id + overrides, then place it. */
    recipeFor: (template, overrides) => Object.assign(T().recipeFor(template), overrides || {}),
    place,
    templates: () => T().TEMPLATES.map((t) => ({ id: t.id, kind: t.kind, name: t.name, description: t.desc, logo: !!t.logo, noText: !!t.noText })),
  };
})();
