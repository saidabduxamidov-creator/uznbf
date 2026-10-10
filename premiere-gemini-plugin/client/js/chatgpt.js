/*
 * GeminiCut - ChatGPT bo'limi.
 *  - Rang berish (DaVinci Resolve): kliplar kadrlari tahlil qilinadi, ChatGPT kolorist sifatida
 *    ko'rinish va kliplarni bir-biriga moslashtirishni tanlaydi, plagin har bir klipga LUT yasaydi.
 *    Oldindan ko'rish (oldin/keyin), tayyor uslublar va oddiy slayderlar bilan sozlanadi.
 *  - Montaj · motion · SFX: Claude bo'limidagi bilan bir xil, lekin ChatGPT bilan.
 */
(function () {
  "use strict";

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const url = require("url");
  const $ = (id) => document.getElementById(id);
  const C = () => window.GCColor;

  const S = {
    scope: "playhead", targets: [], shots: [], preview: 0,
    look: null, lookKey: "natural", aiClips: {}, applied: [], busy: false, token: null,
    adj: { intensity: 1, exposure: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0, fade: 0 },
    auto: true, autoStrength: 0.7, compare: 50,
  };

  const SLIDERS = [
    ["intensity", "Kuch", 0, 1.5, 0.05, (v) => Math.round(v * 100) + "%"],
    ["exposure", "Ekspozitsiya", -1.5, 1.5, 0.05, (v) => (v > 0 ? "+" : "") + v.toFixed(2)],
    ["contrast", "Kontrast", -0.5, 0.6, 0.02, (v) => (v > 0 ? "+" : "") + Math.round(v * 100)],
    ["saturation", "To'yinganlik", 0, 2, 0.05, (v) => Math.round(v * 100) + "%"],
    ["temperature", "Harorat", -0.8, 0.8, 0.02, (v) => (v > 0 ? "iliq +" : v < 0 ? "sovuq " : "") + Math.round(v * 100)],
    ["tint", "Tint", -0.5, 0.5, 0.02, (v) => (v > 0 ? "magenta +" : v < 0 ? "yashil " : "") + Math.round(v * 100)],
    ["fade", "Film fade", 0, 0.15, 0.005, (v) => Math.round(v * 100)],
  ];

  const status = (t, err) => { const el = $("gcStatus"); el.textContent = t; el.classList.toggle("error", !!err); };

  /* ---------------- kadrlar va tahlil ---------------- */

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Kadrni o'qib bo'lmadi."));
      const href = url.pathToFileURL(file).href;
      img.src = /^file:/.test(href) ? href + "?t=" + Date.now() : href; // kesh chetlab o'tiladi
    });
  }

  function toCanvas(img, max) {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /*
   * Clips to grade plus per-clip frame statistics (used by the panel and the local MCP bridge).
   * scope: "playhead" | "track" | "all". Frames are optional: without them grading still works,
   * only per-clip auto balance is skipped.
   */
  async function collectTargets(scope) {
    const r = await window.GCHost.call("gc_colorTargets", [scope], 30000);
    const targets = r.clips;
    const limit = 40;
    const times = targets.slice(0, limit).map((c) => (scope === "playhead" ? Math.min(Math.max(r.playhead, c.start), c.end - 0.04) : c.start + (c.end - c.start) * 0.5));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-color-"));
    const shots = [];
    let frameError = "";
    try {
      const ex = await window.GCHost.call("gc_exportFrames", [path.join(dir, "c"), times], 180000);
      for (let i = 0; i < ex.files.length; i++) {
        try {
          const img = await loadImage(ex.files[i]);
          const small = toCanvas(img, 320);
          shots.push({ i, img, stats: C().analyze(small.getContext("2d").getImageData(0, 0, small.width, small.height).data) });
        } catch (e) { frameError = e.message; }
      }
    } catch (e) {
      frameError = e.message; // kadrsiz ham rang berish mumkin (avto balanssiz)
    } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
    return { targets, shots, frameError };
  }

  /* Grades every target with paramsAt(i); returns per-mode counts and errors (no UI). */
  async function applyGrades(targets, paramsAt, method, onStatus) {
    const done = [], errors = [], modes = { node: 0, fusion: 0, cdl: 0 }, notes = new Set();
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (onStatus) onStatus(`Rang qo'llanmoqda: ${i + 1}/${targets.length} · ${t.name}`, i, targets.length);
      const p = paramsAt(i);
      const item = { id: t.id, name: t.name, cube: C().buildCube(p, 33, "GeminiCut " + t.name), cdl: C().toCDL(p) };
      try {
        const r = await window.GCHost.call("gc_applyGrade", [item, { version: true, method }], 60000);
        done.push(t.id);
        modes[r.mode] = (modes[r.mode] || 0) + 1;
        (r.steps || []).forEach((x) => notes.add(x));
      } catch (e) { errors.push(`${t.name}: ${e.message}`); }
    }
    return { done, errors, modes, notes: Array.from(notes) };
  }

  /* Per-clip parameters: auto balance from that clip's frame (nearest analysed frame) + look. */
  function gradeParams(shots, i, look, options) {
    const shot = shots.length ? shots[i] || shots[Math.min(i, shots.length - 1)] : null;
    const auto = options.auto && shot ? C().autoBalance(shot.stats, options.autoStrength) : null;
    return C().combine(auto, look, options.clipAdjust ? options.clipAdjust[i] : undefined, options.adjust);
  }

  async function capture() {
    if (S.busy) return;
    setBusy(true);
    try {
      status("Kliplar aniqlanmoqda…");
      const res = await collectTargets(S.scope);
      S.targets = res.targets;
      S.shots = res.shots.map((s) => ({ i: s.i, stats: s.stats, view: toCanvas(s.img, 640), jpeg: toCanvas(s.img, 512).toDataURL("image/jpeg", 0.8).split(",")[1] }));
      S.preview = 0;
      renderClips();
      updatePreview();
      status(S.shots.length
        ? `${S.targets.length} ta klip tayyor. Uslub tanlang yoki ChatGPT'ga yozing.`
        : `${S.targets.length} ta klip tanlandi, lekin kadr olinmadi (${res.frameError}). Uslubni baribir qo'llash mumkin - avto balanssiz.`, !S.shots.length);
    } catch (e) {
      status(e.message, true);
    } finally { setBusy(false); }
  }

  /* Klip uchun yakuniy parametrlar (tahlil bo'lmagan klip - eng yaqin kadr statistikasi) */
  function paramsFor(i) {
    return gradeParams(S.shots, i, S.look || C().PRESETS[S.lookKey].look, { auto: S.auto, autoStrength: S.autoStrength, clipAdjust: S.aiClips, adjust: S.adj });
  }

  /* ---------------- oldindan ko'rish ---------------- */

  let previewTimer = 0;
  function updatePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(drawPreview, 16);
  }

  function drawPreview() {
    const cv = $("gcPreview"), shot = S.shots[S.preview];
    const wrap = $("gcStage");
    wrap.classList.toggle("empty", !shot);
    if (!shot) return;
    const src = shot.view;
    cv.width = src.width; cv.height = src.height;
    const ctx = cv.getContext("2d");
    const before = src.getContext("2d").getImageData(0, 0, src.width, src.height);
    const after = ctx.createImageData(src.width, src.height);
    const lut = C().buildLut(paramsFor(S.preview), 25);
    C().applyLut(lut, 25, before.data, after.data);
    ctx.putImageData(after, 0, 0);
    const split = Math.round(cv.width * S.compare / 100);
    if (split > 0) ctx.putImageData(before, 0, 0, 0, 0, split, cv.height);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(split - 1, 0, 2, cv.height);
    const t = S.targets[S.preview];
    $("gcPreviewLabel").textContent = t ? `#${S.preview + 1} · ${t.name}` : "";
  }

  function renderClips() {
    const box = $("gcClips");
    box.innerHTML = "";
    if (!S.targets.length) { box.textContent = "Kadrlarni olish tugmasini bosing."; return; }
    S.targets.slice(0, 40).forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "gc-clip" + (i === S.preview ? " on" : "");
      b.textContent = `#${i + 1} V${t.track + 1} · ${window.GCSubs.formatClock(t.start)} · ${t.name}`;
      const note = S.aiClips[i] && S.aiClips[i].note;
      if (note) b.title = note;
      b.addEventListener("click", () => { S.preview = i; renderClips(); updatePreview(); });
      box.appendChild(b);
    });
    if (S.targets.length > 40) { const m = document.createElement("div"); m.className = "cl-src"; m.textContent = `+${S.targets.length - 40} ta klip (yaqin kadr tahlili bilan)`; box.appendChild(m); }
  }

  /* ---------------- uslublar va slayderlar ---------------- */

  function renderPresets() {
    const box = $("gcPresets");
    box.innerHTML = "";
    const items = Object.entries(C().PRESETS).map(([k, p]) => [k, p.name, p.desc]);
    items.push(["ai", "ChatGPT", "ChatGPT tanlagan ko'rinish"]);
    items.forEach(([k, name, desc]) => {
      const b = document.createElement("button");
      b.className = "gc-preset" + (S.lookKey === k ? " on" : "");
      b.dataset.k = k;
      b.title = desc;
      b.disabled = k === "ai" && !S.aiLook;
      const sw = document.createElement("i");
      const look = k === "ai" ? S.aiLook : C().PRESETS[k].look;
      if (look) {
        const f = C().gradeFn(look);
        const cols = [[0.85, 0.6, 0.45], [0.35, 0.45, 0.55], [0.15, 0.15, 0.17], [0.9, 0.88, 0.85]].map((c) => f(c[0], c[1], c[2]).map((v) => Math.round(v * 255)));
        sw.style.background = `linear-gradient(90deg, ${cols.map((c, j) => `rgb(${c.join(",")}) ${j * 33}%`).join(",")})`;
      }
      const sp = document.createElement("span"); sp.textContent = name;
      b.append(sw, sp);
      b.addEventListener("click", () => selectLook(k));
      box.appendChild(b);
    });
  }

  function selectLook(k) {
    S.lookKey = k;
    S.look = k === "ai" ? S.aiLook : null;
    if (k !== "ai") S.aiClips = {};
    renderPresets(); renderClips(); updatePreview();
  }

  function renderSliders() {
    const box = $("gcSliders");
    box.innerHTML = "";
    SLIDERS.forEach(([key, label, min, max, step, fmt]) => {
      const f = document.createElement("div");
      f.className = "field gc-slider";
      f.innerHTML = `<span></span><input type="range">`;
      const sp = f.querySelector("span"), inp = f.querySelector("input");
      Object.assign(inp, { min, max, step, value: S.adj[key] });
      inp.id = "gcAdj_" + key;
      const sync = () => { sp.innerHTML = ""; sp.append(label + " "); const b = document.createElement("b"); b.textContent = fmt(S.adj[key]); sp.appendChild(b); };
      inp.addEventListener("input", () => { S.adj[key] = Number(inp.value); sync(); updatePreview(); });
      inp.addEventListener("dblclick", () => { S.adj[key] = key === "intensity" || key === "saturation" ? 1 : 0; inp.value = S.adj[key]; sync(); updatePreview(); });
      sync();
      box.appendChild(f);
    });
  }

  /* ---------------- ChatGPT kolorist ---------------- */

  async function askAI() {
    if (S.busy) return;
    const settings = window.GCApplication.settings();
    if (!settings.openaiKey) { window.GCApplication.openSettings("openaiKey"); return status("Sozlamalarda ChatGPT (OpenAI) API kalitini kiriting.", true); }
    const prompt = $("gcPrompt").value.trim() || "Professional, cinematic, natural skin tones. Make all shots match.";
    if (!S.targets.length) await capture();
    if (!S.shots.length) return status("ChatGPT kadrlarni ko'rishi kerak, lekin kadr olinmadi. Tayyor uslublardan foydalaning yoki Color sahifasini ochib qayta urinib ko'ring.", true);
    setBusy(true, true);
    try {
      const content = [];
      S.shots.slice(0, 10).forEach((s, i) => {
        const t = S.targets[i];
        const st = s.stats;
        content.push({ type: "text", text: `Clip #${i} "${t.name}" (V${t.track + 1}, ${t.start.toFixed(1)}-${t.end.toFixed(1)}s). Stats: p01=${st.p01.toFixed(3)} p50=${st.p50.toFixed(3)} p99=${st.p99.toFixed(3)} greyWorldLinearRGB=${st.meanLin.map((v) => v.toFixed(3)).join(",")} saturation=${st.saturation.toFixed(3)}` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.jpeg } });
      });
      content.push({ type: "text", text: `There are ${S.targets.length} clips in total (only the first ${Math.min(10, S.shots.length)} are shown). User request:\n${prompt}` });
      const t0 = Date.now();
      const tick = setInterval(() => status(`ChatGPT kadrlarni ko'rib, rang tanlamoqda… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
      let r;
      try {
        r = await window.GCAI.openai({ apiKey: settings.openaiKey, model: settings.openaiModel, system: C().AI_SYSTEM, content, schema: C().AI_SCHEMA, effort: "medium", token: S.token,
          onRetry: (e, s) => status(`${e.message} ${s}s dan keyin qayta urinish…`) });
      } finally { clearInterval(tick); }
      const g = C().fromAI(r);
      S.aiLook = g.look; S.aiClips = g.clips;
      S.lookKey = "ai"; S.look = g.look;
      $("gcSummary").textContent = g.summary;
      $("gcSummary").hidden = !g.summary;
      renderPresets(); renderClips(); updatePreview();
      status("ChatGPT ko'rinishni tanladi. Oldin/keyin solishtiring va “Qo'llash” ni bosing.");
    } catch (e) {
      status(e.code === "CANCELLED" ? "Bekor qilindi." : e.message, e.code !== "CANCELLED");
    } finally { setBusy(false); }
  }

  /* ---------------- Resolve'ga qo'llash ---------------- */

  async function apply() {
    if (S.busy) return;
    if (!S.targets.length) { await capture(); if (!S.targets.length) return; }
    setBusy(true);
    const method = $("gcMethod").value;
    try {
      const { done, errors, modes, notes } = await applyGrades(S.targets, paramsFor, method, (t) => status(t));
      S.applied = done;
      const how = [modes.node && `${modes.node} ta Color sahifasida ("GeminiCut AI" versiyasi)`, modes.fusion && `${modes.fusion} ta Fusion LUT orqali (Edit sahifasida ko'rinadi)`, modes.cdl && `${modes.cdl} ta CDL`].filter(Boolean).join(", ");
      window.GCApplication.log && window.GCApplication.log("Rang: " + how + (notes.length ? " | " + notes.join("; ") : ""));
      status(done.length
        ? `✓ ${done.length} ta klipga rang berildi: ${how}.` + (errors.length ? " Xatolar: " + errors.join("; ") : "") + (modes.node ? " Timeline'da ko'rinmasa: Usul → Fusion." : "")
        : "Rang qo'llanmadi: " + errors.join("; "), !done.length);
    } finally { setBusy(false); }
  }

  async function revert() {
    if (S.busy) return;
    const ids = S.applied.length ? S.applied : S.targets.map((t) => t.id);
    if (!ids.length) return status("Avval kliplarni tanlang.", true);
    setBusy(true);
    try {
      const r = await window.GCHost.call("gc_revertGrade", [ids], 60000);
      S.applied = [];
      status(`↺ ${r.reverted} ta klip asl rangiga qaytarildi.`);
    } catch (e) { status(e.message, true); } finally { setBusy(false); }
  }

  function setBusy(on, cancellable) {
    S.busy = on;
    S.token = on && cancellable ? window.GCGemini.createCancelToken() : on ? S.token : null;
    ["gcCapture", "gcAsk", "gcApply", "gcRevert"].forEach((id) => { $(id).disabled = on; });
    $("gcCancel").hidden = !(on && S.token);
    $("gcSpinner").hidden = !on;
  }

  /* ---------------- bo'lim ---------------- */

  function setMode(m) {
    const resolve = document.body.classList.contains("resolve");
    const mode = resolve ? m : "edit";
    document.querySelectorAll("#gpMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === mode));
    $("gpColorPane").hidden = mode !== "color";
    $("gpEditPane").hidden = mode !== "edit";
  }

  let planner = null;
  function init() {
    planner = window.GCClaude.createPlanner({ prefix: "gp", provider: "openai", view: "gpEditPane", tab: "chatgpt" });
    planner.init();
    document.querySelectorAll("#gpMode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.v)));
    setMode("color");
    document.querySelectorAll("#gcScope button").forEach((b) => b.addEventListener("click", () => {
      S.scope = b.dataset.v;
      document.querySelectorAll("#gcScope button").forEach((x) => x.classList.toggle("on", x === b));
    }));
    $("gcCapture").addEventListener("click", capture);
    $("gcAsk").addEventListener("click", askAI);
    $("gcApply").addEventListener("click", apply);
    $("gcRevert").addEventListener("click", revert);
    $("gcCancel").addEventListener("click", () => { if (S.token) S.token.cancel(); });
    $("gcCompare").addEventListener("input", (e) => { S.compare = Number(e.target.value); updatePreview(); });
    $("gcAuto").addEventListener("change", (e) => { S.auto = e.target.checked; updatePreview(); });
    $("gcAutoStrength").addEventListener("input", (e) => { S.autoStrength = Number(e.target.value); updatePreview(); });
    const settings = window.GCApplication.settings();
    $("gcMethod").value = settings.colorMethod || "auto";
    $("gcMethod").addEventListener("change", () => { settings.colorMethod = $("gcMethod").value; window.GCApplication.saveSettings && window.GCApplication.saveSettings(); });
    $("gcResetAdj").addEventListener("click", () => {
      S.adj = { intensity: 1, exposure: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0, fade: 0 };
      renderSliders(); updatePreview();
    });
    document.querySelectorAll(".gc-example").forEach((b) => b.addEventListener("click", () => { $("gcPrompt").value = b.dataset.text; $("gcPrompt").focus(); }));
    renderPresets();
    renderSliders();
    renderClips();
    const m = window.GCApplication.settings().openaiModel;
    $("gpModelChip").textContent = m || "GPT · avto";
  }

  window.GCChatGPT = { init, capture, apply, revert, state: S, setMode, collectTargets, applyGrades, gradeParams };
})();
