/* GeminiCut 2.0 - panel logikasi */
(function () {
  "use strict";

  const fs = require("fs");
  const os = require("os");
  const pathMod = require("path");
  const { GCHost, GCSubs, GCGemini } = window;

  const $ = (id) => document.getElementById(id);
  const LS_SETTINGS = "geminicut.settings.v2";
  const LS_FILES = "geminicut.files.v2";
  const FILE_TTL_MS = 44 * 3600 * 1000; // Gemini fayllarni 48 soat saqlaydi

  const LANG_NAMES = {
    uz: "Uzbek (Latin script)", "uz-cyrl": "Uzbek (Cyrillic script)", ru: "Russian", en: "English",
    tr: "Turkish", kk: "Kazakh", tg: "Tajik",
  };

  const state = {
    clip: null,
    raw: null,          // Gemini'dan kelgan xom segmentlar (media vaqtida)
    rawRange: null,
    cues: [],
    plan: null,
    busy: false,
    token: null,
    settings: loadSettings(),
  };

  /* ================= yordamchilar ================= */

  function loadSettings() {
    const def = { apiKey: "", model: "gemini-2.5-flash", customModel: "", uzStyle: "typographic",
      srcLang: "auto", outLang: "same", maxChars: 42, maxLines: 2, onlyRange: true,
      cuts: true, pause: 0.8, zoom: false, zoomPower: 115 };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}")); } catch (e) { return def; }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) { /* e'tiborsiz */ }
  }
  function modelName() {
    const s = state.settings;
    return s.model === "custom" ? (s.customModel || "gemini-2.5-flash").trim() : s.model;
  }

  function log(msg) {
    const el = $("log");
    const t = new Date().toLocaleTimeString();
    el.textContent += `[${t}] ${msg}\n`;
    if (el.textContent.length > 40000) el.textContent = el.textContent.slice(-30000);
    el.scrollTop = el.scrollHeight;
  }

  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "ok");
    el.innerHTML = `<svg><use href="#i-${kind === "err" ? "x" : "check"}"/></svg><div></div>`;
    el.lastChild.textContent = msg;
    const box = $("toasts");
    while (box.children.length >= 2) box.firstChild.remove();
    box.appendChild(el);
    const ttl = kind === "err" ? 7000 : 3500;
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ttl);
    el.addEventListener("click", () => el.remove());
    log((kind === "err" ? "XATO: " : "") + msg);
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function fmtMB(bytes) { return (bytes / 1048576).toFixed(bytes > 1e9 ? 0 : 1) + " MB"; }

  function setPill(id, ok) {
    const el = $(id);
    el.classList.toggle("ok", ok === true);
    el.classList.toggle("err", ok === false);
  }

  function autoSize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }

  /* ================= progress ================= */

  function progress(boxId) {
    const box = $(boxId);
    const bar = box.querySelector(".bar");
    const label = box.querySelector(".prog-label");
    const order = ["upload", "process", "ai", "done"];
    return {
      show() { box.hidden = false; this.step("upload", "Tayyorlanmoqda...", 0); },
      hide() { box.hidden = true; },
      step(name, text, pct) {
        const idx = order.indexOf(name);
        box.querySelectorAll(".steps li").forEach((li, i) => {
          li.classList.toggle("done", i < idx || name === "done");
          li.classList.toggle("now", i === idx && name !== "done");
        });
        label.textContent = text;
        this.pct(pct);
      },
      pct(p) {
        bar.classList.toggle("indeterminate", p == null);
        if (p != null) bar.querySelector("i").style.width = Math.max(0, Math.min(100, p)) + "%";
      },
      text(t) { label.textContent = t; },
    };
  }

  function setBusy(on) {
    state.busy = on;
    ["btnSubs", "btnEdit", "btnApplySubs", "btnApplyEdit", "refreshClip"].forEach((id) => { $(id).disabled = on; });
  }

  /* ================= Premiere klip ================= */

  async function refreshClip(silent) {
    const btn = $("refreshClip");
    btn.classList.add("spin");
    try {
      const c = await GCHost.call("gc_getSelectedClip", [], 15000);
      let size = 0;
      try { size = fs.statSync(c.path).size; } catch (e) { throw new Error("Media fayl diskda topilmadi: " + c.path); }
      state.clip = Object.assign(c, { size });
      $("clipName").textContent = c.name;
      $("clipMeta").textContent = `${fmtDur(c.outPoint - c.inPoint)} · ${pathMod.extname(c.path).slice(1).toUpperCase()} · ${fmtMB(size)} · ${c.sequence}`;
      $("clipCard").classList.add("active");
      if (!silent) log("Klip: " + c.path);
      return state.clip;
    } catch (e) {
      state.clip = null;
      $("clipName").textContent = "Klip tanlanmagan";
      $("clipMeta").textContent = e.message;
      $("clipCard").classList.remove("active");
      if (!silent) toast(e.message, "err");
      return null;
    } finally {
      btn.classList.remove("spin");
    }
  }

  /* ================= Gemini fayl (kesh bilan) ================= */

  function fileCacheKey(clip) {
    const st = fs.statSync(clip.path);
    return [clip.path, st.size, st.mtimeMs].join("|");
  }
  function readFileCache() { try { return JSON.parse(localStorage.getItem(LS_FILES) || "{}"); } catch (e) { return {}; } }
  function writeFileCache(c) { try { localStorage.setItem(LS_FILES, JSON.stringify(c)); } catch (e) { /* e'tiborsiz */ } }

  async function getGeminiFile(clip, prog, token) {
    const apiKey = state.settings.apiKey;
    const key = fileCacheKey(clip);
    const cache = readFileCache();
    const hit = cache[key];

    if (hit && Date.now() - hit.savedAt < FILE_TTL_MS) {
      prog.step("process", "Oldin yuklangan fayl tekshirilmoqda...", null);
      const f = await GCGemini.getFile(hit.name, apiKey, token).catch(() => null);
      if (f && f.state === "ACTIVE") { log("Keshdan: " + f.name); return f; }
    }

    prog.step("upload", "Video yuklanmoqda...", 0);
    const started = Date.now();
    const file = await GCGemini.uploadFile(clip.path, apiKey, {
      token,
      onProgress: (sent, total) => {
        const pct = (sent / total) * 100;
        const secs = (Date.now() - started) / 1000;
        const speed = sent / Math.max(secs, 0.1);
        const eta = speed > 0 ? (total - sent) / speed : 0;
        prog.pct(pct);
        prog.text(`Yuklanmoqda ${pct.toFixed(0)}% · ${fmtMB(sent)} / ${fmtMB(total)} · ~${fmtDur(eta)}`);
      },
    });
    log("Yuklandi: " + file.name);

    prog.step("process", "Gemini videoni qayta ishlamoqda...", null);
    const active = await GCGemini.waitUntilActive(file, apiKey, {
      token, onTick: (s) => prog.text(`Gemini videoni qayta ishlamoqda... ${s}s`),
    });

    Object.keys(cache).forEach((k) => { if (Date.now() - cache[k].savedAt > FILE_TTL_MS) delete cache[k]; });
    cache[key] = { name: active.name, savedAt: Date.now() };
    writeFileCache(cache);
    return active;
  }

  function requireReady() {
    if (!GCHost.available) throw new Error("Panel Premiere Pro ichida ochilishi kerak.");
    if (!state.settings.apiKey) { switchTab("settings"); $("apiKey").focus(); throw new Error("Avval Sozlamalarda Gemini API kalitni kiriting."); }
  }

  async function runJob(progId, job) {
    if (state.busy) return;
    const prog = progress(progId);
    const token = GCGemini.createCancelToken();
    state.token = token;
    setBusy(true);
    prog.show();
    try {
      requireReady();
      const clip = await refreshClip(true);
      if (!clip) throw new Error("Timeline'da video klipni tanlang va qayta urinib ko'ring.");
      await job(clip, prog, token);
      prog.step("done", "Tayyor", 100);
      setTimeout(() => prog.hide(), 900);
    } catch (e) {
      prog.hide();
      if (e.code === "CANCELLED") toast("Bekor qilindi.", "ok");
      else toast(e.message || String(e), "err");
    } finally {
      state.token = null;
      setBusy(false);
    }
  }

  /* ================= SUBTITR ================= */

  const TRANSCRIPT_SCHEMA = {
    type: "OBJECT",
    properties: {
      language: { type: "STRING" },
      segments: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, text: { type: "STRING" } },
          required: ["start", "end", "text"],
          propertyOrdering: ["start", "end", "text"],
        },
      },
    },
    required: ["segments"],
    propertyOrdering: ["language", "segments"],
  };

  function transcriptPrompt(s, clip) {
    const limit = s.maxChars * s.maxLines;
    const src = s.srcLang === "auto"
      ? "Detect the spoken language automatically."
      : `The speech is mainly in ${LANG_NAMES[s.srcLang]}.`;
    const out = s.outLang === "same"
      ? "Write every segment in the ORIGINAL spoken language. Do NOT translate."
      : `Translate every segment into ${LANG_NAMES[s.outLang]} - natural, fluent, idiomatic subtitles that keep the exact meaning. Timings must still follow the original speech.`;
    const range = s.onlyRange
      ? `Only the part from ${clip.inPoint.toFixed(2)}s to ${clip.outPoint.toFixed(2)}s is used in the edit; transcribe at least that part completely.`
      : "Transcribe the whole file.";
    return [
      "You are a professional subtitle editor and transcriptionist working on broadcast-quality subtitles.",
      "Transcribe ALL speech in the audio track of this media file.",
      src, out, range,
      "",
      "TIMING (most important):",
      "- \"start\" and \"end\" are seconds from the very beginning of the file, as decimal numbers with millisecond precision (e.g. 12.345).",
      "- A segment starts exactly when its first word begins and ends exactly when its last word ends. Listen carefully - never guess or space times evenly.",
      "- Segments must be in chronological order and must not overlap.",
      "",
      "SEGMENTATION:",
      `- One segment = one short phrase or sentence, ideally 1-6 seconds and at most ${limit} characters.`,
      "- Split at natural pauses and punctuation. Never split in the middle of a name or a tight phrase.",
      "- When the speaker changes, start a new segment.",
      "",
      "TEXT QUALITY:",
      "- Perfect spelling, grammar, capitalization and punctuation for the output language.",
      "- Uzbek Latin: use the official alphabet with oʻ, gʻ, sh, ch, ng and the ʼ sign (e.g. \"oʻzbek\", \"maʼno\").",
      "- Uzbek Cyrillic: use ў, қ, ғ, ҳ correctly. Russian: correct Cyrillic spelling, use ё where needed.",
      "- Keep the speaker's words (verbatim meaning) but remove filler sounds (eee, mmm, uh, um, ну-у) and stutters/false starts.",
      "- Write proper names, brands and technical terms in their correct, commonly used form.",
      "- Do NOT add speaker names, sound descriptions like [music], emojis, or quotes around segments.",
      "- Silence, music or noise without speech produces NO segments. Never invent text that was not spoken.",
      "",
      "Return JSON only: {\"language\": \"<detected language code>\", \"segments\": [{\"start\": 1.234, \"end\": 3.456, \"text\": \"...\"}]}",
    ].join("\n");
  }

  function subsOptions() {
    const s = state.settings;
    const spoken = s.srcLang === "auto" ? String(state.detectedLang || "") : s.srcLang;
    const uz = s.outLang === "uz" || (s.outLang === "same" && /^uz(?!-cyrl)/i.test(spoken));
    return { maxChars: s.maxChars, maxLines: s.maxLines, uzbekStyle: uz ? s.uzStyle : null };
  }

  function rebuildCues() {
    if (!state.raw) return;
    state.cues = GCSubs.buildCues(state.raw, subsOptions(), state.rawRange);
    renderCues();
  }

  function renderCues() {
    const list = $("cueList");
    list.innerHTML = "";
    const s = state.settings;
    const frag = document.createDocumentFragment();
    state.cues.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "cue";
      const time = document.createElement("button");
      time.className = "cue-time";
      time.title = "Timeline'da shu joyga o'tish";
      time.innerHTML = `${GCSubs.formatClock(c.start)}<span>${GCSubs.formatClock(c.end)}</span>`;
      time.addEventListener("click", () => {
        if (!state.clip) return;
        GCHost.call("gc_setPlayhead", [state.clip.start + (c.start - state.clip.inPoint)]).catch((e) => toast(e.message, "err"));
      });
      const ta = document.createElement("textarea");
      ta.rows = 1;
      ta.value = c.text;
      ta.spellcheck = false;
      const badge = document.createElement("div");
      badge.className = "cue-badge";
      const check = () => {
        const lines = ta.value.split("\n");
        const long = lines.some((l) => l.trim().length > s.maxChars);
        const cps = ta.value.replace(/\s+/g, "").length / Math.max(0.1, c.end - c.start);
        const warns = [];
        if (long) warns.push(`qator ${s.maxChars} belgidan uzun`);
        if (lines.length > s.maxLines) warns.push(`${lines.length} qator`);
        if (cps > 21) warns.push("o'qish uchun tez");
        badge.textContent = warns.length ? "⚠ " + warns.join(" · ") : "";
        badge.hidden = !warns.length;
        row.classList.toggle("warn", warns.length > 0);
      };
      ta.addEventListener("input", () => { state.cues[i].text = ta.value; autoSize(ta); check(); });
      row.append(time, ta, badge);
      frag.appendChild(row);
      check();
      requestAnimationFrame(() => autoSize(ta));
    });
    list.appendChild(frag);
    const total = state.cues.length ? state.cues[state.cues.length - 1].end - state.cues[0].start : 0;
    $("subsTitle").textContent = `${state.cues.length} ta subtitr`;
    $("subsSub").textContent = state.cues.length ? `${fmtDur(total)} · ${s.maxChars} belgi · ${s.maxLines} qator` : "Nutq topilmadi";
    $("subsResults").hidden = false;
  }

  /* Tahrirlangan matnlarni oxirgi marta tekshirib, timeline vaqtidagi SRT yaratadi */
  function finalSrt() {
    const s = state.settings;
    const cues = state.cues
      .map((c) => {
        const lines = c.text.split("\n").map(GCSubs.cleanText).filter(Boolean);
        const fits = lines.length <= s.maxLines && lines.every((l) => l.length <= s.maxChars);
        const text = fits ? lines.join("\n") : GCSubs.wrapLines(lines.join(" "), s.maxChars, s.maxLines).join("\n");
        return { start: c.start, end: c.end, text };
      })
      .filter((c) => c.text);
    if (!cues.length) throw new Error("Subtitrlar ro'yxati bo'sh.");
    const offset = state.clip ? state.clip.start - state.clip.inPoint : 0;
    return "﻿" + GCSubs.toSrt(cues, offset);
  }

  function srtBaseName() {
    const base = state.clip ? pathMod.basename(state.clip.path, pathMod.extname(state.clip.path)) : "subtitr";
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
    return `${base.replace(/[\\/:*?"<>|]/g, "_")}_${stamp}.srt`;
  }

  function outputDir() {
    const dir = pathMod.join(os.homedir(), "Documents", "GeminiCut");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function onGenerateSubs() {
    await runJob("progSubs", async (clip, prog, token) => {
      const s = state.settings;
      const file = await getGeminiFile(clip, prog, token);
      prog.step("ai", `${modelName()} nutqni yozmoqda... (bir necha daqiqa olishi mumkin)`, null);
      const t0 = Date.now();
      const tick = setInterval(() => prog.text(`${modelName()} nutqni yozmoqda... ${fmtDur((Date.now() - t0) / 1000)}`), 1000);
      let result;
      try {
        result = await GCGemini.generateJson({
          apiKey: s.apiKey, model: modelName(), file, token,
          prompt: transcriptPrompt(s, clip), schema: TRANSCRIPT_SCHEMA,
          onRetry: (e, sec) => prog.text(`${e.message} ${sec}s dan keyin qayta urinish...`),
        });
      } finally { clearInterval(tick); }

      setPill("pillKey", true);
      state.detectedLang = result.language || "";
      state.raw = Array.isArray(result.segments) ? result.segments : [];
      state.rawRange = s.onlyRange ? { start: clip.inPoint, end: clip.outPoint } : null;
      rebuildCues();
      log(`Transkripsiya: ${state.raw.length} segment, til: ${result.language || "?"}`);
      if (!state.cues.length) throw new Error("Bu qismda nutq topilmadi.");
      toast(`${state.cues.length} ta subtitr tayyor. Tekshirib, "Timeline'ga qo'shish" ni bosing.`);
    });
  }

  async function onApplySubs() {
    if (state.busy) return;
    try {
      if (!state.clip) throw new Error("Avval klipni tanlang.");
      const srt = finalSrt();
      const file = pathMod.join(outputDir(), srtBaseName());
      fs.writeFileSync(file, srt, "utf8");
      log("SRT yozildi: " + file);
      setBusy(true);
      await GCHost.call("gc_importSrt", [file], 120000);
      toast("Subtitrlar timeline'ga qo'shildi.");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  function onSaveSrt() {
    try {
      const srt = finalSrt();
      const name = srtBaseName();
      const target = GCHost.saveDialog("SRT faylini saqlash", name) || pathMod.join(outputDir(), name);
      const finalPath = /\.srt$/i.test(target) ? target : target + ".srt";
      fs.writeFileSync(finalPath, srt, "utf8");
      toast("Saqlandi: " + finalPath);
    } catch (e) {
      toast(e.message, "err");
    }
  }

  function onCopySrt() {
    try {
      const ta = document.createElement("textarea");
      ta.value = finalSrt().replace(/^﻿/, "");
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("SRT matni nusxalandi.");
    } catch (e) {
      toast(e.message, "err");
    }
  }

  /* ================= MONTAJ ================= */

  const PLAN_SCHEMA = {
    type: "OBJECT",
    properties: {
      summary: { type: "STRING" },
      cuts: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, reason: { type: "STRING" } },
          required: ["start", "end", "reason"],
          propertyOrdering: ["start", "end", "reason"],
        },
      },
      zooms: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { time: { type: "NUMBER" }, hold: { type: "NUMBER" }, reason: { type: "STRING" } },
          required: ["time", "hold", "reason"],
          propertyOrdering: ["time", "hold", "reason"],
        },
      },
    },
    required: ["summary", "cuts", "zooms"],
    propertyOrdering: ["summary", "cuts", "zooms"],
  };

  function editPrompt(s, clip) {
    return [
      "You are a senior video editor preparing a clean talking-head edit.",
      `Only analyse the range ${clip.inPoint.toFixed(2)}s - ${clip.outPoint.toFixed(2)}s of this file. All times are seconds from the start of the file, with millisecond precision.`,
      "",
      s.cuts ? [
        "CUTS - find parts to REMOVE:",
        `- silences / dead air longer than ${s.pause} seconds (cut the silence, but leave about 0.15s of natural breath on each side of speech);`,
        "- false starts and repeated takes (keep only the last complete, clean take);",
        "- filler sounds (eee, mmm, uh, um, ну-у) that stand alone.",
        "- NEVER cut inside a word or a sentence that is kept. Be precise and conservative.",
      ].join("\n") : "CUTS: return an empty array.",
      "",
      s.zoom ? [
        "ZOOMS - suggest punch-in zoom moments on key, emphatic statements:",
        "- at most one every 10 seconds; \"time\" = the moment the emphasis starts; \"hold\" = 1.5 to 4 seconds.",
      ].join("\n") : "ZOOMS: return an empty array.",
      "",
      "Write every \"reason\" and the \"summary\" in Uzbek (Latin script), very short (max 8 words).",
      "Return JSON only: {\"summary\": \"...\", \"cuts\": [{\"start\": 1.2, \"end\": 2.4, \"reason\": \"...\"}], \"zooms\": [{\"time\": 5.0, \"hold\": 2.0, \"reason\": \"...\"}]}",
    ].join("\n");
  }

  function normalizePlan(plan, clip) {
    const lo = clip.inPoint, hi = clip.outPoint;
    const cuts = (plan.cuts || [])
      .map((c) => ({ start: GCSubs.toNumber(c.start) + 0.04, end: GCSubs.toNumber(c.end) - 0.04, reason: GCSubs.cleanText(c.reason) }))
      .filter((c) => isFinite(c.start) && isFinite(c.end))
      .map((c) => ({ start: Math.max(lo, c.start), end: Math.min(hi, c.end), reason: c.reason }))
      .filter((c) => c.end - c.start >= 0.25)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const c of cuts) {
      const last = merged[merged.length - 1];
      if (last && c.start <= last.end + 0.05) { last.end = Math.max(last.end, c.end); last.reason = last.reason || c.reason; }
      else merged.push(c);
    }
    const zooms = (plan.zooms || [])
      .map((z) => ({ time: GCSubs.toNumber(z.time), hold: Math.max(1, Math.min(5, GCSubs.toNumber(z.hold) || 2)), reason: GCSubs.cleanText(z.reason) }))
      .filter((z) => isFinite(z.time) && z.time >= lo && z.time + z.hold + 0.8 <= hi)
      // kesiladigan joyga tushgan zoomlar keraksiz
      .filter((z) => !merged.some((c) => z.time < c.end && z.time + z.hold > c.start))
      .sort((a, b) => a.time - b.time);
    return {
      summary: GCSubs.cleanText(plan.summary),
      items: merged.map((c) => ({ kind: "cut", on: true, ...c })).concat(zooms.map((z) => ({ kind: "zoom", on: true, ...z }))),
    };
  }

  function renderPlan() {
    const list = $("planList");
    list.innerHTML = "";
    const items = state.plan.items.slice().sort((a, b) => (a.start || a.time) - (b.start || b.time));
    items.forEach((it) => {
      const row = document.createElement("label");
      row.className = "cue plan-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = it.on;
      cb.addEventListener("change", () => { it.on = cb.checked; updatePlanSummary(); });
      const body = document.createElement("div");
      const kind = document.createElement("div");
      kind.className = "kind " + it.kind;
      kind.textContent = it.kind === "cut"
        ? `✂ ${GCSubs.formatClock(it.start)} - ${GCSubs.formatClock(it.end)} (${(it.end - it.start).toFixed(1)}s)`
        : `⤢ ZOOM ${GCSubs.formatClock(it.time)} · ${it.hold.toFixed(1)}s`;
      const reason = document.createElement("div");
      reason.className = "reason";
      reason.textContent = it.reason || "";
      body.append(kind, reason);
      row.append(cb, body);
      list.appendChild(row);
    });
    updatePlanSummary();
    $("editResults").hidden = false;
  }

  function updatePlanSummary() {
    const on = state.plan.items.filter((i) => i.on);
    const cuts = on.filter((i) => i.kind === "cut");
    const saved = cuts.reduce((a, c) => a + (c.end - c.start), 0);
    $("editTitle").textContent = `${cuts.length} ta kesish · ${on.length - cuts.length} ta zoom`;
    $("editSub").textContent = (state.plan.summary ? state.plan.summary + " · " : "") + `${saved.toFixed(1)}s qisqaradi`;
  }

  async function onAnalyze() {
    if (!state.settings.cuts && !state.settings.zoom) return toast("Kamida bitta amalni yoqing (kesish yoki zoom).", "err");
    await runJob("progEdit", async (clip, prog, token) => {
      const s = state.settings;
      const file = await getGeminiFile(clip, prog, token);
      prog.step("ai", `${modelName()} videoni tahlil qilmoqda...`, null);
      const plan = await GCGemini.generateJson({
        apiKey: s.apiKey, model: modelName(), file, token,
        prompt: editPrompt(s, clip), schema: PLAN_SCHEMA,
        onRetry: (e, sec) => prog.text(`${e.message} ${sec}s dan keyin qayta urinish...`),
      });
      setPill("pillKey", true);
      state.plan = normalizePlan(plan, clip);
      state.planClip = clip.path;
      renderPlan();
      if (!state.plan.items.length) toast("Kesish yoki zoom uchun joy topilmadi - video toza.");
      else toast("Reja tayyor. Keraksizlarini olib tashlab, qo'llang.");
    });
  }

  async function onApplyEdit() {
    if (state.busy || !state.plan) return;
    setBusy(true);
    try {
      const clip = await refreshClip(true);
      if (!clip || clip.path !== state.planClip) throw new Error("Tahlil qilingan klipni timeline'da qayta tanlang.");
      const on = state.plan.items.filter((i) => i.on);
      const zooms = on.filter((i) => i.kind === "zoom").map((z) => [z.time, state.settings.zoomPower, z.hold]);
      const cuts = on.filter((i) => i.kind === "cut").map((c) => [c.start, c.end]);
      if (!zooms.length && !cuts.length) throw new Error("Hech narsa belgilanmagan.");
      const report = [];
      // Avval zoom (asl vaqtlar bo'yicha), keyin kesish
      if (zooms.length) report.push((await GCHost.call("gc_applyZooms", [zooms], 120000)).applied + " ta zoom");
      if (cuts.length) report.push((await GCHost.call("gc_applyCuts", [cuts], 300000)).applied + " ta kesish");
      state.plan = null;
      $("editResults").hidden = true;
      toast("Qo'llandi: " + report.join(", ") + ".");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  /* ================= Sozlamalar ================= */

  async function onTestKey() {
    const btn = $("btnTestKey");
    const key = state.settings.apiKey;
    if (!key) return toast("Kalitni kiriting.", "err");
    btn.disabled = true;
    btn.textContent = "Tekshirilmoqda...";
    try {
      const models = await GCGemini.testKey(key);
      setPill("pillKey", true);
      const m = modelName();
      const has = models.some((x) => x === m);
      toast(has ? `Kalit ishlayapti. ${m} mavjud.` : `Kalit ishlayapti, lekin "${m}" modeli ro'yxatda yo'q - boshqa model tanlang.`, has ? "ok" : "err");
    } catch (e) {
      setPill("pillKey", false);
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Kalitni tekshirish";
    }
  }

  /* ================= UI ulash ================= */

  function switchTab(name) {
    const tabs = Array.from(document.querySelectorAll(".tab"));
    tabs.forEach((t, i) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      if (on) document.querySelector(".tab-glider").style.transform = `translateX(${i * 100}%)`;
    });
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  }

  function bindSegmented(id, key, cast, onChange) {
    const el = $(id);
    const buttons = Array.from(el.querySelectorAll("button"));
    const sync = () => buttons.forEach((b) => b.classList.toggle("on", cast(b.dataset.v) === state.settings[key]));
    buttons.forEach((b) => b.addEventListener("click", () => {
      state.settings[key] = cast(b.dataset.v);
      saveSettings();
      sync();
      if (onChange) onChange();
    }));
    sync();
  }

  function bindInput(id, key, opts) {
    const el = $(id);
    const o = opts || {};
    const prop = el.type === "checkbox" ? "checked" : "value";
    el[prop] = state.settings[key];
    el.addEventListener(o.event || "change", () => {
      state.settings[key] = o.cast ? o.cast(el[prop]) : el[prop];
      saveSettings();
      if (o.onChange) o.onChange();
    });
  }

  function init() {
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

    bindInput("srcLang", "srcLang");
    bindInput("outLang", "outLang");
    bindInput("onlyRange", "onlyRange");
    bindInput("maxChars", "maxChars", {
      event: "input", cast: Number,
      onChange: () => { $("maxCharsVal").textContent = state.settings.maxChars; },
    });
    $("maxCharsVal").textContent = state.settings.maxChars;
    // Uslub o'zgarsa - AI'ni qayta chaqirmasdan subtitrlarni qayta hisoblaymiz
    $("maxChars").addEventListener("change", rebuildCues);
    bindSegmented("maxLines", "maxLines", Number, rebuildCues);

    bindInput("optCuts", "cuts");
    bindInput("optZoom", "zoom");
    bindSegmented("pause", "pause", Number);
    bindSegmented("zoomPower", "zoomPower", Number);

    bindInput("apiKey", "apiKey", {
      event: "input", cast: (v) => v.trim(),
      onChange: () => setPill("pillKey", state.settings.apiKey ? null : false),
    });
    bindInput("model", "model", { onChange: () => { $("customModelWrap").hidden = state.settings.model !== "custom"; } });
    $("customModelWrap").hidden = state.settings.model !== "custom";
    bindInput("customModel", "customModel", { event: "input", cast: (v) => v.trim() });
    bindInput("uzStyle", "uzStyle", { onChange: rebuildCues });

    $("toggleKey").addEventListener("click", () => { const k = $("apiKey"); k.type = k.type === "password" ? "text" : "password"; });
    $("getKey").addEventListener("click", (e) => { e.preventDefault(); GCHost.openUrl("https://aistudio.google.com/apikey"); });
    $("btnTestKey").addEventListener("click", onTestKey);
    $("btnClearCache").addEventListener("click", () => { writeFileCache({}); toast("Kesh tozalandi."); });

    $("refreshClip").addEventListener("click", () => refreshClip(false));
    $("btnSubs").addEventListener("click", onGenerateSubs);
    $("btnApplySubs").addEventListener("click", onApplySubs);
    $("btnSaveSrt").addEventListener("click", onSaveSrt);
    $("btnCopySrt").addEventListener("click", onCopySrt);
    $("btnEdit").addEventListener("click", onAnalyze);
    $("btnApplyEdit").addEventListener("click", onApplyEdit);
    document.querySelectorAll(".cancel").forEach((b) => b.addEventListener("click", () => {
      if (state.token) state.token.cancel();
    }));

    // Xatolar panelni hech qachon "o'ldirmasin"
    window.addEventListener("error", (e) => log("JS xato: " + e.message));
    window.addEventListener("unhandledrejection", (e) => log("Promise xato: " + (e.reason && e.reason.message || e.reason)));

    setPill("pillKey", state.settings.apiKey ? null : false);

    if (!GCHost.available) {
      const b = $("banner");
      b.textContent = "Bu panel Premiere Pro ichida ishlaydi: Window → Extensions → GeminiCut.";
      b.hidden = false;
      setPill("pillHost", false);
      return;
    }
    GCHost.ensureHost()
      .then((r) => { setPill("pillHost", true); log(`Premiere ${r.host} bilan ulandi. Host v${r.version}`); refreshClip(true); })
      .catch((e) => { setPill("pillHost", false); toast("Premiere bilan aloqa yo'q: " + e.message, "err"); });
  }

  init();
})();
