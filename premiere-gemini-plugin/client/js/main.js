/*
 * GeminiCut 4.0 - panel logikasi (subtitr, montaj, umumiy holat).
 *
 * Oqim:  Premiere timeline audiosini eksport qiladi (video yuborilmaydi)
 *        -> shu kompyuterda: 16 kHz mono, nutq/sukut xaritasi (VAD)
 *        -> Gemini faqat nutqni tinglaydi ("miya"): matn, takror/xato gaplar, urg'u
 *        -> vaqtlar waveform bo'yicha aniqlashtiriladi -> Premiere'ga qo'llanadi
 */
(function () {
  "use strict";

  const fs = require("fs");
  const os = require("os");
  const pathMod = require("path");
  const { GCHost, GCSubs, GCGemini, GCAudio } = window;

  const $ = (id) => document.getElementById(id);
  const LS_SETTINGS = "geminicut.settings.v3";
  const LS_TRACKS = "geminicut.tracks.v3";

  const LANG_NAMES = {
    uz: "Uzbek (Latin script)", "uz-cyrl": "Uzbek (Cyrillic script)", ru: "Russian", en: "English",
    tr: "Turkish", kk: "Kazakh", tg: "Tajik",
  };

  const state = {
    seq: null,
    tracks: [],         // nutq audio treklari (indekslar)
    cache: null,        // { key, audio, vad, offset, end, transcript, tkey }
    cues: [],
    plan: null,
    busy: false,
    token: null,
    settings: loadSettings(),
  };

  /* ================= yordamchilar ================= */

  function loadSettings() {
    const def = { apiKey: "", model: "gemini-2.5-flash", customModel: "", uzStyle: "typographic",
      srcLang: "auto", outLang: "same", maxChars: 42, maxLines: 2, range: "all", glossary: "",
      letterCase: "original", punctuation: "keep", autoCaption: false, pauses: true, pause: 0.8, retakes: true, zoom: false, zoomPower: 115, presetPath: "",
      punct: { comma: true, period: true, excl: true, colon: true, quotes: true, apos: true, dash: true, ellipsis: true },
      claudeKey: "", textAI: "auto", keyBase: "media", motionStrength: 115 };
    let s = def;
    try { s = Object.assign(def, JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}")); } catch (e) { /* standart */ }
    // 3.2 dagi "punctuation: remove" -> yangi format
    if (s.punctuation === "remove") { Object.keys(s.punct).forEach((k) => { s.punct[k] = false; }); s.punctuation = "keep"; }
    return s;
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
    el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
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
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, kind === "err" ? 8000 : 3500);
    el.addEventListener("click", () => el.remove());
    log((kind === "err" ? "XATO: " : "") + msg);
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }

  function setPill(id, ok) {
    const el = $(id);
    el.classList.toggle("ok", ok === true);
    el.classList.toggle("err", ok === false);
  }

  function autoSize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }

  async function pool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
    });
    await Promise.all(workers);
    return results;
  }

  /* ================= progress ================= */

  function progress(boxId) {
    const box = $(boxId);
    const bar = box.querySelector(".bar");
    const label = box.querySelector(".prog-label");
    const order = ["export", "prepare", "ai", "done"];
    return {
      show() { box.hidden = false; this.step("export", "Tayyorlanmoqda...", null); },
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
    const flow = document.getElementById("flowGenerate"); if (flow) flow.disabled = on;
    ["btnSubs", "btnEdit", "btnApplySubs", "btnApplyEdit", "refreshSeq"].forEach((id) => { $(id).disabled = on; });
    document.querySelectorAll(".chip").forEach((c) => { c.disabled = on; });
  }

  /* ================= Sequence va treklar ================= */

  function loadTrackChoice(seq) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_TRACKS) || "{}");
      const saved = all[seq.id];
      if (Array.isArray(saved)) return saved.filter((i) => i < seq.audioTracks.length);
    } catch (e) { /* e'tiborsiz */ }
    // Standart: klipi bor va o'chirilmagan treklar. Butun timeline bo'ylab bitta uzun
    // klipdan iborat trek (fon musiqasi bo'lishi ehtimoli katta) boshqa nutq treki bo'lsa tanlanmaydi.
    const used = seq.audioTracks.filter((t) => t.clips > 0 && !t.muted);
    const musicLike = (t) => t.clips <= 2 && t.coverage > 0.7;
    const speechy = used.filter((t) => !musicLike(t));
    return (speechy.length ? speechy : used).map((t) => t.index);
  }

  function saveTrackChoice() {
    try {
      const all = JSON.parse(localStorage.getItem(LS_TRACKS) || "{}");
      all[state.seq.id] = state.tracks;
      localStorage.setItem(LS_TRACKS, JSON.stringify(all));
    } catch (e) { /* e'tiborsiz */ }
  }

  function renderSeq() {
    const s = state.seq;
    if (!s) {
      $("seqName").textContent = "Sequence ochilmagan";
      $("seqCard").classList.remove("active");
      $("trackRow").hidden = true;
      return;
    }
    $("seqName").textContent = s.name;
    const range = s.hasRange ? `In ${GCSubs.formatClock(s.inPoint)} → Out ${GCSubs.formatClock(s.outPoint)}` : "In/Out yo'q";
    $("seqMeta").textContent = `${fmtDur(s.duration)} · ${Math.round(s.fps * 100) / 100} fps · ${range}`;
    $("seqCard").classList.add("active");

    const row = $("trackChips");
    row.innerHTML = "";
    s.audioTracks.forEach((t) => {
      const b = document.createElement("button");
      b.className = "chip" + (state.tracks.includes(t.index) ? " on" : "") + (t.clips ? "" : " empty");
      b.title = `${t.name} - ${t.clips} ta klip${t.locked ? " (qulflangan)" : ""}`;
      b.innerHTML = `<b>A${t.index + 1}</b><span></span>`;
      b.lastChild.textContent = t.name;
      b.disabled = !t.clips || state.busy;
      b.addEventListener("click", () => {
        state.tracks = state.tracks.includes(t.index) ? state.tracks.filter((i) => i !== t.index) : state.tracks.concat(t.index).sort((x, y) => x - y);
        saveTrackChoice();
        renderSeq();
      });
      row.appendChild(b);
    });
    $("trackRow").hidden = !s.audioTracks.length;
    $("rangeInOut").disabled = !s.hasRange;
    syncRange();
  }

  function syncRange() {
    const useInOut = state.settings.range === "inout" && state.seq && state.seq.hasRange;
    document.querySelectorAll("#range button").forEach((b) => b.classList.toggle("on", (b.dataset.v === "inout") === useInOut));
  }

  async function refreshSeq(silent) {
    const btn = $("refreshSeq");
    btn.classList.add("spin");
    try {
      const s = await GCHost.call("gc_getSequenceInfo", [], 15000);
      const changed = !state.seq || state.seq.id !== s.id;
      state.seq = s;
      if (changed) state.tracks = loadTrackChoice(s);
      renderSeq();
      return s;
    } catch (e) {
      state.seq = null;
      renderSeq();
      $("seqMeta").textContent = e.message;
      if (!silent) toast(e.message, "err");
      return null;
    } finally {
      btn.classList.remove("spin");
    }
  }

  /* ================= Audio eksport va tahlil (lokal) ================= */

  function isWavPreset(p) {
    try {
      const txt = fs.readFileSync(p, "utf8");
      return /1463899717/.test(txt) || /waveform|\bwav\b/i.test(pathMod.basename(p));
    } catch (e) { return false; }
  }

  /* Foydalanuvchi saqlagan presetlar: Documents\Adobe\Adobe Media Encoder\<ver>\Presets */
  function findUserPreset() {
    const base = pathMod.join(os.homedir(), "Documents", "Adobe", "Adobe Media Encoder");
    try {
      for (const ver of fs.readdirSync(base).sort().reverse()) {
        const dir = pathMod.join(base, ver, "Presets");
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          const p = pathMod.join(dir, f);
          if (/\.epr$/i.test(f) && isWavPreset(p)) return p;
        }
      }
    } catch (e) { /* papka yo'q */ }
    return "";
  }

  async function resolvePreset() {
    const s = state.settings;
    if (s.presetPath && fs.existsSync(s.presetPath)) return s.presetPath;
    const found = await GCHost.call("gc_findAudioPreset", [], 60000);
    log(`Preset qidiruvi: ${found.scanned} ta .epr ko'rildi, topildi: ${found.path || "-"}`);
    const p = found.path || findUserPreset();
    if (!p) {
      throw new Error("WAV eksport preseti topilmadi. Premiere'da File → Export → Media: Format = Waveform Audio → " +
        "Save Preset qiling, so'ng Sozlamalar → Audio preset'da shu .epr faylni tanlang.");
    }
    s.presetPath = p;
    saveSettings();
    $("presetPath").value = p;
    return p;
  }

  function analysisKey(seq) {
    const useInOut = state.settings.range === "inout" && seq.hasRange;
    return [seq.id, seq.signature, useInOut ? `${seq.inPoint}-${seq.outPoint}` : "all", state.tracks.join(",")].join("#");
  }

  async function prepareAudio(prog, token) {
    const seq = await refreshSeq(true);
    if (!seq) throw new Error("Timeline (sequence) ochilmagan.");
    if (!seq.clipCount) throw new Error("Timeline bo'sh.");
    if (!state.tracks.length) throw new Error("Kamida bitta nutq audio trekini tanlang (A1, A2...).");

    const key = analysisKey(seq);
    if (state.cache && state.cache.key === key) { log("Audio tahlil keshdan olindi."); return state.cache; }

    const useInOut = state.settings.range === "inout" && seq.hasRange;
    const preset = await resolvePreset();
    const dir = pathMod.join(os.tmpdir(), "GeminiCut");
    fs.mkdirSync(dir, { recursive: true });
    const wav = pathMod.join(dir, `timeline_${Date.now()}.wav`);

    prog.step("export", "Premiere timeline audiosini chiqarmoqda...", null);
    token.check();
    const ex = await GCHost.call("gc_exportAudio", [wav, preset, state.tracks, useInOut], 30 * 60000);
    token.check();
    log(`Eksport: ${ex.path} (offset ${ex.offset.toFixed(2)}s)`);

    try {
      prog.step("prepare", "Audio tahlil qilinmoqda (shu kompyuterda)...", 0);
      const audio = await GCAudio.decodeWav(ex.path, (p) => prog.pct(p * 100));
      const vad = GCAudio.detectSpeech(audio);
      log(`Audio: ${audio.duration.toFixed(1)}s, nutq bo'laklari: ${vad.regions.length}, shovqin ${vad.noise.toFixed(0)} dB, chegara ${vad.threshold.toFixed(0)} dB`);
      if (!vad.regions.length) throw new Error("Tanlangan treklarda nutq eshitilmadi. Nutq treklarini (A1, A2...) tekshiring.");
      state.cache = { key, audio, vad, offset: ex.offset, end: ex.offset + audio.duration };
      return state.cache;
    } finally {
      fs.unlink(ex.path, () => {});
    }
  }

  /* ================= Gemini: tinglash (transkripsiya) ================= */

  const TRANSCRIPT_SCHEMA = {
    type: "OBJECT",
    properties: {
      language: { type: "STRING" },
      segments: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            start: { type: "NUMBER" },
            end: { type: "NUMBER" },
            type: { type: "STRING", enum: ["speech", "retake", "filler"] },
            emphasis: { type: "BOOLEAN" },
            text: { type: "STRING" },
          },
          required: ["start", "end", "type", "text"],
          propertyOrdering: ["start", "end", "type", "emphasis", "text"],
        },
      },
    },
    required: ["segments"],
    propertyOrdering: ["language", "segments"],
  };

  function transcriptPrompt(chunk, index, total) {
    const s = state.settings;
    const limit = s.maxChars * s.maxLines;
    const src = s.srcLang === "auto" ? "Detect the spoken language automatically." : `The speech is mainly in ${LANG_NAMES[s.srcLang]}.`;
    const out = s.outLang === "same"
      ? "Write \"speech\" segments in the ORIGINAL spoken language. Do NOT translate."
      : `Translate every "speech" segment into ${LANG_NAMES[s.outLang]} - natural, fluent subtitles with the exact meaning. Timings still follow the original speech.`;
    const glossary = s.glossary.trim()
      ? `Names and terms that occur in this video - spell them exactly like this: ${s.glossary.trim()}`
      : "";
    return [
      "You are an expert transcriptionist and broadcast subtitle editor.",
      `You receive an audio excerpt (part ${index + 1} of ${total}, ${(chunk.end - chunk.start).toFixed(1)} seconds) exported from a video editing timeline. There is no video - only listen to the speech.`,
      src, out, glossary,
      "",
      "TIMING (most important):",
      "- \"start\"/\"end\" are seconds from the beginning of THIS audio excerpt, decimal with millisecond precision.",
      "- A segment starts exactly when its first word begins and ends exactly when its last word ends. Never guess or space times evenly.",
      "- Chronological order, no overlaps. Cover all speech in the excerpt.",
      "",
      "SEGMENTATION:",
      `- One segment = one short phrase or sentence, ideally 1-6 seconds and at most ${limit} characters.`,
      "- Split at natural pauses and punctuation; start a new segment when the speaker changes.",
      "",
      "TYPES:",
      "- \"speech\": normal content. Clean text: no filler sounds, no stutters.",
      "- \"retake\": a false start, an abandoned/broken sentence, or an earlier attempt that the speaker immediately says again better. Only the earlier, worse attempt is \"retake\"; the final good version is \"speech\". Text = what was said.",
      "- \"filler\": a standalone hesitation or filler between sentences (eee, mmm, uh, um, ну, это самое). Text = the sound.",
      "- \"emphasis\": true only for the few most important, emphatic or punchline statements (about one per 20-30 seconds); otherwise false.",
      "",
      "TEXT QUALITY:",
      "- Perfect spelling, grammar, capitalization and punctuation for the output language.",
      "- Uzbek Latin: official alphabet with oʻ, gʻ, sh, ch, ng and ʼ (e.g. \"oʻzbek\", \"maʼno\"). Uzbek Cyrillic: ў, қ, ғ, ҳ. Russian: correct spelling, ё where needed.",
      "- Proper names, brands and technical terms in their correct, commonly used form.",
      "- No speaker names, no [music]/[noise] tags, no emojis. Music, noise or silence without speech produce NO segments. Never invent words.",
      "",
      "Return JSON only.",
    ].filter((l) => l !== "").join("\n");
  }

  function transcriptKey(cache) {
    const s = state.settings;
    return [cache.key, s.srcLang, s.outLang, s.glossary.trim(), modelName(), s.maxChars * s.maxLines].join("#");
  }

  async function transcribe(cache, prog, token) {
    const tkey = transcriptKey(cache);
    if (cache.transcript && cache.tkey === tkey) { log("Transkripsiya keshdan olindi."); return cache.transcript; }
    const s = state.settings;
    const { audio, vad } = cache;
    const chunks = GCAudio.planChunks(audio.duration, vad.silences, 240, 300)
      .filter((c) => vad.regions.some((r) => r.end > c.start && r.start < c.end));
    let done = 0;
    prog.step("ai", `Gemini tinglamoqda: 0/${chunks.length} bo'lak`, 0);
    const parts = await pool(chunks, 2, async (chunk, i) => {
      token.check();
      const wav = GCAudio.encodeWav(audio, chunk.start, chunk.end);
      const res = await GCGemini.generateJson({
        apiKey: s.apiKey, model: modelName(), audio: wav, token,
        prompt: transcriptPrompt(chunk, i, chunks.length), schema: TRANSCRIPT_SCHEMA,
        onRetry: (e, sec) => prog.text(`${e.message} ${sec}s dan keyin qayta urinish...`),
      });
      done++;
      prog.pct((done / chunks.length) * 100);
      prog.text(`Gemini tinglamoqda: ${done}/${chunks.length} bo'lak`);
      if (i === 0) state.detectedLang = res.language || "";
      const len = chunk.end - chunk.start;
      return (res.segments || [])
        .map((seg) => ({
          start: GCSubs.toNumber(seg.start), end: GCSubs.toNumber(seg.end),
          type: seg.type || "speech", emphasis: !!seg.emphasis, text: GCSubs.cleanText(seg.text),
        }))
        .filter((seg) => isFinite(seg.start) && isFinite(seg.end) && seg.text && seg.start < len + 0.5)
        .map((seg) => Object.assign(seg, { start: chunk.start + Math.max(0, seg.start), end: chunk.start + Math.min(len, Math.max(seg.end, seg.start)) }));
    });
    const all = [].concat(...parts).sort((a, b) => a.start - b.start);
    // Vaqtlarni haqiqiy nutq chegaralariga yopishtirish, so'ng timeline vaqtiga o'tkazish
    const snapped = GCAudio.snapToSpeech(all, vad.regions).map((seg) =>
      Object.assign(seg, { start: seg.start + cache.offset, end: seg.end + cache.offset }));
    log(`Transkripsiya: ${snapped.length} segment (${snapped.filter((x) => x.type !== "speech").length} ta takror/parazit), til: ${state.detectedLang || "?"}`);
    setPill("pillKey", true);
    cache.transcript = snapped;
    cache.tkey = tkey;
    return snapped;
  }

  function requireKey() {
    if (!state.settings.apiKey) {
      switchTab("settings");
      $("apiKey").focus();
      throw new Error("Avval Sozlamalarda Gemini API kalitni kiriting.");
    }
  }

  async function runJob(progId, job) {
    if (state.busy) return;
    const prog = progress(progId);
    const token = GCGemini.createCancelToken();
    state.token = token;
    setBusy(true);
    prog.show();
    try {
      if (!GCHost.available) throw new Error("Panel Premiere Pro ichida ochilishi kerak.");
      await job(prog, token);
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

  function subsOptions() {
    const s = state.settings;
    const spoken = s.srcLang === "auto" ? String(state.detectedLang || "") : s.srcLang;
    const uz = s.outLang === "uz" || (s.outLang === "same" && /^uz(?!-cyrl)/i.test(spoken));
    return { maxChars: s.maxChars, maxLines: s.maxLines, letterCase: s.letterCase, punctuation: s.punctuation, uzbekStyle: uz ? s.uzStyle : null };
  }

  function rebuildCues() {
    const c = state.cache;
    if (!c || !c.transcript) return;
    const speech = c.transcript.filter((x) => x.type === "speech");
    const silences = c.vad.silences.map((x) => ({ start: x.start + c.offset, end: x.end + c.offset }));
    state.cues = GCSubs.buildCues(speech, Object.assign(subsOptions(), { silences, letterCase: "original", punctuation: "keep" }), { start: c.offset, end: c.end });
    state.cues.forEach(c => { c.styleSource = c.text; c.text = GCSubs.styleText(c.text, state.settings); });
    renderCues();
  }

  /* Harf/tinish uslubini barcha subtitrlarga qayta qo'llaydi (AI'ni qayta chaqirmasdan) */
  function restyle() {
    state.cues.forEach((c) => {
      if (c.styleSource === undefined) c.styleSource = c.text;
      c.text = GCSubs.styleText(c.styleSource, state.settings);
    });
    if (state.cues.length) renderCues();
  }

  function syncStyleBar() {
    document.querySelectorAll("#caseBar button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.settings.letterCase));
    document.querySelectorAll("#punctBar .pchip").forEach((b) => b.classList.toggle("on", state.settings.punct[b.dataset.k] !== false));
  }

  /* AI imlo tekshiruvi: vaqtlar o'zgarmaydi, faqat matn tuzatiladi */
  async function onProofread() {
    if (state.busy || !state.cues.length) return;
    const btn = $("btnProofread");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const s = state.settings;
      const lang = s.outLang !== "same" ? LANG_NAMES[s.outLang] : s.srcLang !== "auto" ? LANG_NAMES[s.srcLang] : (state.detectedLang || "the original language");
      const lines = state.cues.map((c, i) => `${i}\t${(c.styleSource !== undefined ? c.styleSource : c.text).replace(/\n/g, " / ")}`).join("\n");
      const schema = { type: "object", properties: { fixes: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, text: { type: "string" } } } } } };
      const prompt = `These are video subtitles in ${lang}, one per line as "index<TAB>text" (" / " marks a line break).
Fix only real mistakes: spelling, grammar, punctuation, capitalization, wrongly heard words and proper names${s.glossary ? ` (names/terms: ${s.glossary})` : ""}.
For Uzbek Latin use oʻ, gʻ and ʼ correctly. Do not paraphrase, do not merge or split lines, keep the meaning and length.
Return only the lines you changed, with their index. Keep " / " line breaks where they are.

${lines}`;
      const r = await window.GCAI.text({ settings: s, prompt, schema, effort: "medium" });
      let n = 0;
      (r.fixes || []).forEach((f) => {
        const c = state.cues[f.i];
        if (!c || typeof f.text !== "string" || !f.text.trim()) return;
        let fixed = f.text.replace(/\s*\/\s*/g, "\n").trim();
        if (fixed.split("\n").some((l) => l.length > s.maxChars)) fixed = GCSubs.wrapLines(fixed.replace(/\n/g, " "), s.maxChars, s.maxLines).join("\n");
        const before = c.styleSource !== undefined ? c.styleSource : c.text;
        if (fixed === before) return;
        c.fixedFrom = before;
        c.styleSource = fixed;
        n++;
      });
      restyle();
      toast(n ? `AI ${n} ta subtitrni tuzatdi (sariq belgilangan).` : "AI xato topmadi - matn toza.");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }

  function renderCues() {
    const list = $("cueList");
    list.innerHTML = "";
    const s = state.settings;
    const frag = document.createDocumentFragment();
    state.cues.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "cue" + (c.fixedFrom ? " fixed" : "");
      if (c.fixedFrom) row.title = "AI tuzatdi. Oldin: " + c.fixedFrom;
      const time = document.createElement("button");
      time.className = "cue-time";
      time.title = "Timeline'da shu joyga o'tish";
      time.innerHTML = `${GCSubs.formatClock(c.start)}<span>${GCSubs.formatClock(c.end)}</span>`;
      time.addEventListener("click", () => GCHost.call("gc_setPlayhead", [c.start]).catch((e) => toast(e.message, "err")));
      const ta = document.createElement("textarea");
      ta.rows = 1;
      ta.value = c.text;
      ta.spellcheck = false;
      const badge = document.createElement("div");
      badge.className = "cue-badge";
      const check = () => {
        const lines = ta.value.split("\n");
        const warns = [];
        if (lines.some((l) => l.trim().length > s.maxChars)) warns.push(`qator ${s.maxChars} belgidan uzun`);
        if (lines.length > s.maxLines) warns.push(`${lines.length} qator`);
        if (ta.value.replace(/\s+/g, "").length / Math.max(0.1, c.end - c.start) > 21) warns.push("o'qish uchun tez");
        badge.textContent = warns.length ? "⚠ " + warns.join(" · ") : "";
        badge.hidden = !warns.length;
        row.classList.toggle("warn", warns.length > 0);
      };
      ta.addEventListener("input", () => { state.cues[i].text = ta.value; state.cues[i].styleSource = ta.value; autoSize(ta); check(); });
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

  function finalSrt() {
    const s = state.settings;
    const cues = state.cues
      .map((c) => {
        const lines = GCSubs.styleText(c.text, s).split("\n").map(GCSubs.cleanText).filter(Boolean);
        const fits = lines.length <= s.maxLines && lines.every((l) => l.length <= s.maxChars);
        const text = fits ? lines.join("\n") : GCSubs.wrapLines(lines.join(" "), s.maxChars, s.maxLines).join("\n");
        return { start: c.start, end: c.end, text };
      })
      .filter((c) => c.text);
    if (!cues.length) throw new Error("Subtitrlar ro'yxati bo'sh.");
    return "\uFEFF" + GCSubs.toSrt(cues, 0); // vaqtlar allaqachon timeline vaqtida
  }

  function srtBaseName() {
    const base = state.seq ? state.seq.name : "subtitr";
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${base.replace(/[\\/:*?"<>|]/g, "_")}_${stamp}.srt`;
  }

  function outputDir() {
    const dir = pathMod.join(os.homedir(), "Documents", "GeminiCut");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function onGenerateSubs() {
    await runJob("progSubs", async (prog, token) => {
      requireKey();
      const cache = await prepareAudio(prog, token);
      await transcribe(cache, prog, token);
      rebuildCues();
      if (!state.cues.length) throw new Error("Nutq topilmadi.");
      if (state.settings.autoCaption) {
        const file = pathMod.join(outputDir(), srtBaseName());
        fs.writeFileSync(file, finalSrt(), "utf8");
        await GCHost.call("gc_importSrt", [file], 120000);
        toast("Subtitrlar timeline’ga qo‘shildi.");
        return;
      }
      toast(`${state.cues.length} ta subtitr tayyor. Tekshirib, "Timeline'ga qo'shish" ni bosing.`);
    });
  }

  async function onApplySubs() {
    if (state.busy) return;
    try {
      const file = pathMod.join(outputDir(), srtBaseName());
      fs.writeFileSync(file, finalSrt(), "utf8");
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
      ta.value = finalSrt().replace(/^\uFEFF/, "");
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

  const KEEP = 0.15; // kesishda nutq atrofida qoldiriladigan "nafas" (s)

  function buildPlan(cache) {
    const s = state.settings;
    const off = cache.offset;
    const speech = (cache.transcript || []).filter((x) => x.type === "speech");
    const cuts = [];

    if (s.pauses) {
      for (const sil of cache.vad.silences) {
        const len = sil.end - sil.start;
        if (len < s.pause) continue;
        cuts.push({ start: off + sil.start + KEEP, end: off + sil.end - KEEP, reason: `Pauza ${len.toFixed(1)}s`, src: "pause" });
      }
    }
    if (s.retakes && cache.transcript) {
      for (const seg of cache.transcript) {
        if (seg.type === "speech") continue;
        // Kesish qo'shni toza gaplarga tegmasin
        const prev = speech.filter((x) => x.end <= seg.start + 0.3).pop();
        const next = speech.find((x) => x.start >= seg.end - 0.3);
        const start = Math.max(seg.start, prev ? prev.end + 0.02 : -Infinity);
        const end = Math.min(seg.end, next ? next.start - 0.02 : Infinity);
        if (end - start < 0.15) continue;
        const label = seg.type === "retake" ? "Takror / xato gap" : "Parazit tovush";
        cuts.push({ start, end, reason: `${label}: «${seg.text.slice(0, 40)}»`, src: "ai" });
      }
    }
    cuts.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const c of cuts) {
      if (c.end - c.start < 0.12) continue;
      const last = merged[merged.length - 1];
      if (last && c.start <= last.end + 0.1) {
        last.end = Math.max(last.end, c.end);
        if (c.src === "ai") last.reason = c.reason;
      } else merged.push(Object.assign({}, c));
    }

    const zooms = [];
    if (s.zoom && cache.transcript) {
      let lastT = -Infinity;
      for (const seg of speech) {
        if (!seg.emphasis || seg.start - lastT < 10) continue;
        const hold = Math.max(1.2, Math.min(4, seg.end - seg.start - 0.7));
        if (merged.some((c) => seg.start < c.end && seg.start + hold + 0.7 > c.start)) continue;
        zooms.push({ time: seg.start, hold, reason: `Urg'u: «${seg.text.slice(0, 40)}»` });
        lastT = seg.start;
      }
    }
    return merged.map((c) => ({ kind: "cut", on: true, start: c.start, end: c.end, reason: c.reason }))
      .concat(zooms.map((z) => ({ kind: "zoom", on: true, time: z.time, hold: z.hold, reason: z.reason })));
  }

  function renderPlan() {
    const list = $("planList");
    list.innerHTML = "";
    const items = state.plan.items.slice().sort((a, b) => (a.start != null ? a.start : a.time) - (b.start != null ? b.start : b.time));
    items.forEach((it) => {
      const row = document.createElement("label");
      row.className = "cue plan-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = it.on;
      cb.addEventListener("change", () => { it.on = cb.checked; updatePlanSummary(); });
      const body = document.createElement("div");
      const kind = document.createElement("button");
      kind.type = "button";
      kind.className = "kind " + it.kind;
      kind.title = "Timeline'da ko'rish";
      kind.textContent = it.kind === "cut"
        ? `✂ ${GCSubs.formatClock(it.start)} - ${GCSubs.formatClock(it.end)} (${(it.end - it.start).toFixed(1)}s)`
        : `⤢ ZOOM ${GCSubs.formatClock(it.time)} · ${it.hold.toFixed(1)}s`;
      kind.addEventListener("click", (e) => {
        e.preventDefault();
        GCHost.call("gc_setPlayhead", [it.kind === "cut" ? it.start : it.time]).catch((er) => toast(er.message, "err"));
      });
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
    $("editSub").textContent = `Video ${saved.toFixed(1)}s qisqaradi`;
  }

  async function onAnalyze() {
    const s = state.settings;
    if (!s.pauses && !s.retakes && !s.zoom) return toast("Kamida bitta amalni yoqing.", "err");
    await runJob("progEdit", async (prog, token) => {
      const needAI = s.retakes || s.zoom;
      if (needAI) requireKey();
      const cache = await prepareAudio(prog, token);
      if (needAI) await transcribe(cache, prog, token);
      state.plan = { key: cache.key, items: buildPlan(cache) };
      renderPlan();
      if (!state.plan.items.length) toast("Kesish yoki zoom uchun joy topilmadi - timeline toza.");
      else toast("Reja tayyor. Ro'yxatni tekshirib, qo'llang.");
    });
  }

  async function onApplyEdit() {
    if (state.busy || !state.plan) return;
    setBusy(true);
    try {
      const seq = await refreshSeq(true);
      if (!seq || analysisKey(seq) !== state.plan.key) {
        throw new Error("Timeline tahlildan keyin o'zgargan. Qaytadan \"Tahlil qilish\" ni bosing.");
      }
      const on = state.plan.items.filter((i) => i.on);
      const zooms = on.filter((i) => i.kind === "zoom").map((z) => [z.time, state.settings.zoomPower, z.hold]);
      const cuts = on.filter((i) => i.kind === "cut").map((c) => [c.start, c.end]);
      if (!zooms.length && !cuts.length) throw new Error("Hech narsa belgilanmagan.");
      const report = [];
      // Avval zoom (keyframe'lar klip ichida qoladi), keyin kesish
      if (zooms.length) { const z = await GCHost.call("gc_applyZooms", [zooms, state.tracks], 120000); report.push(z.applied + " ta zoom, " + z.skipped + " ta o‘tkazib yuborildi"); if (!z.applied && !cuts.length) throw new Error("Zoom qo‘llanmadi: video trek qulfini, klip davomiyligini va mavjud Scale animatsiyasini tekshiring."); }
      if (cuts.length) {
        const r = await GCHost.call("gc_applyCuts", [cuts, state.tracks], 600000);
        report.push(`${r.applied} ta kesish (${(r.seconds || 0).toFixed(1)}s)`);
      }
      // Timeline o'zgardi - eski tahlil va subtitrlar endi mos emas
      state.plan = null;
      state.cache = null;
      state.cues = [];
      $("editResults").hidden = true;
      $("subsResults").hidden = true;
      await refreshSeq(true);
      toast("Qo'llandi: " + report.join(", ") + ". Endi Subtitr bo'limida subtitr yarating.");
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

  async function onTestClaude() {
    const btn = $("btnTestClaude");
    if (!state.settings.claudeKey) return toast("Claude kalitini kiriting.", "err");
    btn.disabled = true;
    btn.textContent = "Tekshirilmoqda...";
    try {
      await window.GCAI.testClaude(state.settings.claudeKey);
      toast(`Claude kaliti ishlayapti (${window.GCAI.CLAUDE_MODEL}).`);
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Claude kalitini tekshirish";
    }
  }

  /* Tezkor motion presetlari - tanlangan klip(lar) yoki playhead ostidagi klip */
  async function onPreset(name, btn) {
    if (state.busy) return;
    btn.classList.add("loading");
    try {
      const ctx = await GCHost.call("gc_getEditContext", [], 15000);
      const ops = window.GCMotion.buildPreset(name, ctx, state.settings.motionStrength);
      const r = await GCHost.call("gc_applyMotion", [ops], 120000);
      const where = ctx.source === "selection" ? `${ctx.clips.length} ta tanlangan klip` : "playhead ostidagi klip";
      toast(`${window.GCMotion.PRESETS[name].label}: ${where} (${r.keys} keyframe).` + (r.errors && r.errors.length ? " Diqqat: " + r.errors.join("; ") : ""));
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.classList.remove("loading");
    }
  }

  async function onResetMotion() {
    try {
      const ctx = await GCHost.call("gc_getEditContext", [], 15000);
      if (!ctx.clips.length) throw new Error("Klipni tanlang yoki playhead'ni klip ustiga qo'ying.");
      const r = await GCHost.call("gc_resetMotion", [ctx.clips.map((c) => [c.track, c.start])]);
      toast(`${r.reset} ta klipning animatsiyasi tozalandi (Scale 100, markaz, burchak 0, shaffoflik 100).`);
    } catch (e) {
      toast(e.message, "err");
    }
  }

  function onPickPreset() {
    const p = GCHost.openDialog("WAV eksport presetini tanlang (.epr)", ["epr"]);
    if (!p) return;
    if (!isWavPreset(p)) toast("Diqqat: bu preset WAV (Waveform Audio) emasga o'xshaydi.", "err");
    state.settings.presetPath = p;
    saveSettings();
    $("presetPath").value = p;
    state.cache = null;
  }

  /* ================= UI ulash ================= */

  function switchTab(name) {
    const tabs = Array.from(document.querySelectorAll(".tab"));
    tabs.forEach((t, i) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  }

  function bindSegmented(id, key, cast, onChange) {
    const buttons = Array.from($(id).querySelectorAll("button"));
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

    document.querySelectorAll("#caseBar button").forEach((b) => b.addEventListener("click", () => {
      state.settings.letterCase = b.dataset.v; saveSettings(); syncStyleBar(); restyle();
    }));
    document.querySelectorAll("#punctBar .pchip").forEach((b) => b.addEventListener("click", () => {
      state.settings.punct[b.dataset.k] = state.settings.punct[b.dataset.k] === false; saveSettings(); syncStyleBar(); restyle();
    }));
    $("punctAll").addEventListener("click", () => {
      const anyOff = Object.values(state.settings.punct).some((v) => v === false);
      Object.keys(state.settings.punct).forEach((k) => { state.settings.punct[k] = anyOff; });
      saveSettings(); syncStyleBar(); restyle();
    });
    $("btnProofread").addEventListener("click", onProofread);
    syncStyleBar();
    bindInput("autoCaption", "autoCaption");
    bindInput("srcLang", "srcLang");
    bindInput("outLang", "outLang");
    bindInput("glossary", "glossary");
    bindInput("maxChars", "maxChars", { event: "input", cast: Number, onChange: () => { $("maxCharsVal").textContent = state.settings.maxChars; } });
    $("maxCharsVal").textContent = state.settings.maxChars;
    $("maxChars").addEventListener("change", rebuildCues); // AI'ni qayta chaqirmasdan qayta hisoblaymiz
    bindSegmented("maxLines", "maxLines", Number, rebuildCues);
    document.querySelectorAll("#range button").forEach((b) => b.addEventListener("click", () => {
      if (b.disabled) return;
      state.settings.range = b.dataset.v;
      saveSettings();
      syncRange();
    }));
    syncRange();

    bindInput("optPauses", "pauses");
    bindInput("optRetakes", "retakes");
    bindInput("optZoom", "zoom");
    bindSegmented("pause", "pause", Number);
    bindSegmented("zoomPower", "zoomPower", Number);

    bindInput("apiKey", "apiKey", { event: "input", cast: (v) => v.trim(), onChange: () => setPill("pillKey", state.settings.apiKey ? null : false) });
    bindInput("model", "model", { onChange: () => { $("customModelWrap").hidden = state.settings.model !== "custom"; } });
    $("customModelWrap").hidden = state.settings.model !== "custom";
    bindInput("customModel", "customModel", { event: "input", cast: (v) => v.trim() });
    bindInput("uzStyle", "uzStyle", { onChange: rebuildCues });
    $("presetPath").value = state.settings.presetPath || "";
    $("btnPreset").addEventListener("click", onPickPreset);
    $("btnPresetAuto").addEventListener("click", () => { state.settings.presetPath = ""; saveSettings(); $("presetPath").value = ""; toast("Preset avtomatik qidiriladi."); });

    bindInput("claudeKey", "claudeKey", { event: "input", cast: (v) => v.trim() });
    bindInput("textAI", "textAI");
    bindInput("keyBase", "keyBase", { onChange: () => GCHost.call("gc_setKeyBase", [state.settings.keyBase]).catch(() => {}) });
    $("toggleClaudeKey").addEventListener("click", () => { const k = $("claudeKey"); k.type = k.type === "password" ? "text" : "password"; });
    $("getClaudeKey").addEventListener("click", (e) => { e.preventDefault(); GCHost.openUrl("https://console.anthropic.com/settings/keys"); });
    $("btnTestClaude").addEventListener("click", onTestClaude);
    bindSegmented("motionStrength", "motionStrength", Number);
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => onPreset(b.dataset.preset, b)));
    $("btnResetMotion").addEventListener("click", onResetMotion);
    $("toggleKey").addEventListener("click", () => { const k = $("apiKey"); k.type = k.type === "password" ? "text" : "password"; });
    $("getKey").addEventListener("click", (e) => { e.preventDefault(); GCHost.openUrl("https://aistudio.google.com/apikey"); });
    $("btnTestKey").addEventListener("click", onTestKey);
    $("btnClearCache").addEventListener("click", () => { state.cache = null; toast("Tahlil keshi tozalandi."); });

    $("refreshSeq").addEventListener("click", () => refreshSeq(false));
    $("btnSubs").addEventListener("click", onGenerateSubs);
    $("btnApplySubs").addEventListener("click", onApplySubs);
    $("btnSaveSrt").addEventListener("click", onSaveSrt);
    $("btnCopySrt").addEventListener("click", onCopySrt);
    $("btnEdit").addEventListener("click", onAnalyze);
    $("btnApplyEdit").addEventListener("click", onApplyEdit);
    document.querySelectorAll(".cancel").forEach((b) => b.addEventListener("click", () => { if (state.token) state.token.cancel(); }));

    window.addEventListener("error", (e) => log("JS xato: " + e.message));
    window.addEventListener("unhandledrejection", (e) => log("Promise xato: " + ((e.reason && e.reason.message) || e.reason)));
    // Panelga qaytganda timeline ma'lumotini yangilash
    window.addEventListener("focus", () => { if (!state.busy && GCHost.available) refreshSeq(true); });

    setPill("pillKey", state.settings.apiKey ? null : false);

    if (!GCHost.available) {
      const b = $("banner");
      b.textContent = "Bu panel Premiere Pro ichida ishlaydi: Window → Extensions → GeminiCut.";
      b.hidden = false;
      setPill("pillHost", false);
      return;
    }
    GCHost.ensureHost()
      .then((r) => {
        setPill("pillHost", true);
        log(`Premiere ${r.host} bilan ulandi. Host v${r.version}`);
        GCHost.call("gc_setKeyBase", [state.settings.keyBase]).catch(() => {});
        return refreshSeq(true);
      })
      .catch((e) => { setPill("pillHost", false); toast("Premiere bilan aloqa yo'q: " + e.message, "err"); });
  }

  function copyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  /* Boshqa modullar (Effektlar, Claude, Flow, Bloknot) uchun umumiy interfeys */
  window.GCApplication = {
    isBusy: () => state.busy,
    lockFlow: (on) => { setBusy(on); },
    settings: () => state.settings,
    sequence: () => state.seq,
    speechTracks: () => state.tracks.slice(),
    transcript: () => (state.cache && state.cache.transcript) || null,
    openSettings: (field) => { switchTab("settings"); if (field && $(field)) $(field).focus(); },
    timelineChanged: () => { state.cache = null; state.plan = null; refreshSeq(true); },
    toast,
    copyText,
  };
  init();
  ["GCLibrary", "GCNotes", "GCClaude", "GCFlow"].forEach((m) => {
    try { if (window[m]) window[m].init(); } catch (e) { log(m + " ishga tushmadi: " + e.message); }
  });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('keydown', e => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const i = tabs.indexOf(t);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  }));
})();
