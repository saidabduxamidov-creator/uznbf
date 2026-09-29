/*
 * GeminiCut - Bloknot (Notepad uslubida) + AI yozuvchi.
 *  - Bir nechta qayd: Documents\GeminiCut\Notes\*.txt, avtomatik saqlanadi
 *  - Holat qatori: so'zlar, belgilar, qator/ustun
 *  - AI: senariy yozish, davom ettirish, qisqartirish, imloni tuzatish,
 *    videodagi nutqni qo'shish, YouTube sarlavha/tavsif/teglar
 */
(function () {
  "use strict";

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const $ = (id) => document.getElementById(id);

  const DIR = path.join(os.homedir(), "Documents", "GeminiCut", "Notes");
  const OLD = path.join(os.homedir(), "Documents", "GeminiCut", "notes.txt");
  const LS = "geminicut.notes.v1";
  let current = null, saveTimer = null, busy = false, token = null;

  const status = (t, err) => { const el = $("noteStatus"); el.textContent = t; el.classList.toggle("error", !!err); };
  const safeName = (n) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 80) || "Qayd";

  function list() {
    try { return fs.readdirSync(DIR).filter((n) => /\.txt$/i.test(n)).map((n) => n.replace(/\.txt$/i, "")).sort((a, b) => a.localeCompare(b)); }
    catch (e) { return []; }
  }

  function fileOf(name) { return path.join(DIR, name + ".txt"); }

  function fillSelect() {
    const sel = $("noteSelect");
    sel.innerHTML = "";
    list().forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
    sel.value = current;
  }

  function open(name) {
    flush();
    current = name;
    $("noteText").value = fs.existsSync(fileOf(name)) ? fs.readFileSync(fileOf(name), "utf8") : "";
    try { localStorage.setItem(LS, JSON.stringify({ current, font: $("noteText").dataset.font || "mono", size: $("noteText").style.fontSize })); } catch (e) { /* e'tiborsiz */ }
    fillSelect();
    updateStats();
    status("Ochildi: " + name);
  }

  function flush() {
    if (!current || !saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    write();
  }

  function write() {
    try {
      fs.writeFileSync(fileOf(current), $("noteText").value, "utf8");
      status("Saqlandi · " + new Date().toLocaleTimeString());
    } catch (e) { status("Saqlanmadi: " + e.message, true); }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    status("O'zgartirildi…");
    saveTimer = setTimeout(() => { saveTimer = null; write(); }, 600);
  }

  function updateStats() {
    const ta = $("noteText"), v = ta.value;
    const words = (v.match(/\S+/g) || []).length;
    const before = v.slice(0, ta.selectionStart);
    const line = before.split("\n").length, col = before.length - before.lastIndexOf("\n");
    const mins = words / 130; // o'rtacha nutq tezligi ~130 so'z/daqiqa
    $("noteStats").textContent = `${words} so'z · ${v.length} belgi · ~${mins < 1 ? Math.round(mins * 60) + " s" : mins.toFixed(1) + " daq"} o'qish · Qator ${line}, ustun ${col}`;
  }

  function newNote(base) {
    let name = safeName(base || "Yangi qayd"), i = 2;
    while (fs.existsSync(fileOf(name))) name = safeName(base || "Yangi qayd") + " " + i++;
    fs.writeFileSync(fileOf(name), "", "utf8");
    open(name);
    $("noteText").focus();
  }

  function rename() {
    const box = $("noteRenameBox");
    box.hidden = !box.hidden;
    if (!box.hidden) { $("noteRenameInput").value = current; $("noteRenameInput").select(); }
  }

  function applyRename() {
    const n = $("noteRenameInput").value.trim();
    $("noteRenameBox").hidden = true;
    if (!n || n === current) return;
    const name = safeName(n);
    if (fs.existsSync(fileOf(name))) return status("Bunday nomli qayd bor.", true);
    flush();
    fs.renameSync(fileOf(current), fileOf(name));
    open(name);
  }

  function remove() {
    if (!confirm(`"${current}" qaydi o'chirilsinmi?`)) return;
    clearTimeout(saveTimer); saveTimer = null;
    try { fs.unlinkSync(fileOf(current)); } catch (e) { /* allaqachon yo'q */ }
    const rest = list();
    if (rest.length) open(rest[0]); else newNote("Qaydlar");
  }

  function insertText(text, replaceSelection) {
    const ta = $("noteText");
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (replaceSelection && s !== e) ta.setRangeText(text, s, e, "end");
    else {
      const pre = s > 0 && ta.value[s - 1] !== "\n" ? "\n\n" : "";
      ta.setRangeText(pre + text, e, e, "end");
    }
    ta.focus();
    scheduleSave();
    updateStats();
  }

  /* ---------------- AI ---------------- */

  const SYSTEM = [
    "You are a professional scriptwriter and editor for video creators (YouTube, Reels, TikTok).",
    "Write in the same language as the user's request or note (Uzbek Latin by default: use oʻ, gʻ and ʼ correctly).",
    "Return plain text only - no Markdown headings, no asterisks, no code blocks. Use short paragraphs and line breaks.",
  ].join("\n");

  function transcriptText() {
    const t = window.GCApplication && window.GCApplication.transcript();
    if (!t || !t.length) return "";
    return t.filter((s) => s.type === "speech").map((s) => s.text).join(" ");
  }

  const ACTIONS = {
    script: (sel, all, req) => `Write a complete, engaging video script${req ? ` about: ${req}` : " based on the note below"}.
Structure: hook (first 3 seconds), main points, call to action. Mark scenes with short labels like "[KADR 1]" and keep sentences speakable.
${all ? "\nNote:\n" + all : ""}`,
    continue: (sel, all, req) => `Continue this text naturally in the same style and language${req ? ` (${req})` : ""}. Return only the continuation.\n\nText:\n${all.slice(-6000)}`,
    shorten: (sel, all, req) => `Rewrite the text more concisely, keeping all key points${req ? ` (${req})` : ""}. Return only the result.\n\nText:\n${sel || all}`,
    fix: (sel, all) => `Correct spelling, grammar and punctuation. Do not change meaning or style. Return only the corrected text.\n\nText:\n${sel || all}`,
    youtube: (sel, all, req) => `Based on the content below, write for YouTube:
1) 5 title options (max 70 characters each)
2) a description (2 short paragraphs + key points)
3) 15 tags separated by commas
${req ? "Extra wishes: " + req + "\n" : ""}
Content:\n${sel || all || transcriptText()}`,
    free: (sel, all, req) => `${req}\n\n${sel ? "Selected text:\n" + sel : all ? "Note:\n" + all.slice(-8000) : ""}`,
  };

  async function runAI(kind) {
    if (busy) return;
    const ta = $("noteText");
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const all = ta.value.trim();
    const req = $("noteAsk").value.trim();
    if (kind === "free" && !req) return status("AI'ga nima yozishini ayting (pastdagi maydon).", true);
    if ((kind === "shorten" || kind === "fix" || kind === "continue") && !sel && !all) return status("Avval matn yozing yoki tanlang.", true);
    if (kind === "youtube" && !sel && !all && !transcriptText()) return status("Matn yo'q. Avval subtitr yarating yoki matn yozing.", true);
    busy = true;
    token = window.GCGemini.createCancelToken();
    setAIBusy(true, kind);
    try {
      const settings = window.GCApplication.settings();
      const text = await window.GCAI.text({ settings, system: SYSTEM, prompt: ACTIONS[kind](sel, all, req), token });
      insertText(text.replace(/\r/g, ""), kind === "shorten" || kind === "fix");
      status("AI matni qo'shildi · Ctrl+Z bilan qaytarish mumkin.");
    } catch (e) {
      status(e.code === "CANCELLED" ? "Bekor qilindi." : e.message, e.code !== "CANCELLED");
    } finally {
      busy = false;
      token = null;
      setAIBusy(false);
    }
  }

  function setAIBusy(on, kind) {
    document.querySelectorAll("[data-ai]").forEach((b) => { b.disabled = on; b.classList.toggle("loading", on && b.dataset.ai === kind); });
    $("noteAICancel").hidden = !on;
    if (on) status("AI yozmoqda…");
  }

  function insertTranscript() {
    const t = transcriptText();
    if (!t) return status("Nutq matni yo'q. Avval Subtitr bo'limida subtitr yarating.", true);
    insertText(t);
    status("Videodagi nutq matni qo'shildi.");
  }

  function exportTxt() {
    try {
      const r = window.cep.fs.showSaveDialogEx("Qaydni saqlash", "", ["txt"], current + ".txt");
      if (r && !r.err && r.data) { fs.writeFileSync(/\.txt$/i.test(r.data) ? r.data : r.data + ".txt", $("noteText").value, "utf8"); status("TXT saqlandi."); }
    } catch (e) { status(e.message, true); }
  }

  function importTxt() {
    const file = window.GCHost.openDialog("TXT ochish", ["txt"]);
    if (!file) return;
    try {
      const name = safeName(path.basename(file).replace(/\.txt$/i, ""));
      let n = name, i = 2;
      while (fs.existsSync(fileOf(n))) n = name + " " + i++;
      fs.writeFileSync(fileOf(n), fs.readFileSync(file, "utf8"), "utf8");
      open(n);
    } catch (e) { status(e.message, true); }
  }

  function setFont(delta, toggle) {
    const ta = $("noteText");
    const size = Math.max(11, Math.min(24, (parseFloat(ta.style.fontSize) || 14) + (delta || 0)));
    ta.style.fontSize = size + "px";
    if (toggle) ta.dataset.font = ta.dataset.font === "mono" ? "sans" : "mono";
    try { localStorage.setItem(LS, JSON.stringify({ current, font: ta.dataset.font, size: ta.style.fontSize })); } catch (e) { /* e'tiborsiz */ }
  }

  function init() {
    fs.mkdirSync(DIR, { recursive: true });
    // 3.2 dagi yagona notes.txt ni ko'chirib olamiz
    if (fs.existsSync(OLD) && !fs.existsSync(fileOf("Qaydlar"))) { try { fs.copyFileSync(OLD, fileOf("Qaydlar")); } catch (e) { /* e'tiborsiz */ } }
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS) || "{}"); } catch (e) { /* e'tiborsiz */ }
    const ta = $("noteText");
    ta.dataset.font = saved.font || "mono";
    if (saved.size) ta.style.fontSize = saved.size;
    const names = list();
    if (!names.length) { fs.writeFileSync(fileOf("Senariy"), "", "utf8"); }
    open(saved.current && list().includes(saved.current) ? saved.current : list()[0]);

    ta.addEventListener("input", () => { scheduleSave(); updateStats(); });
    ["click", "keyup", "select"].forEach((ev) => ta.addEventListener(ev, updateStats));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") { e.preventDefault(); ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end"); scheduleSave(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); flush(); write(); }
    });
    $("noteSelect").addEventListener("change", (e) => open(e.target.value));
    $("noteNew").addEventListener("click", () => newNote());
    $("noteRename").addEventListener("click", rename);
    $("noteRenameOk").addEventListener("click", applyRename);
    $("noteRenameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") applyRename(); if (e.key === "Escape") $("noteRenameBox").hidden = true; });
    $("noteDelete").addEventListener("click", remove);
    $("noteExport").addEventListener("click", exportTxt);
    $("noteImport").addEventListener("click", importTxt);
    $("noteTranscript").addEventListener("click", insertTranscript);
    $("noteSmaller").addEventListener("click", () => setFont(-1));
    $("noteBigger").addEventListener("click", () => setFont(1));
    $("noteFont").addEventListener("click", () => setFont(0, true));
    document.querySelectorAll("[data-ai]").forEach((b) => b.addEventListener("click", () => runAI(b.dataset.ai)));
    $("noteAsk").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAI("free"); } });
    $("noteAICancel").addEventListener("click", () => { if (token) token.cancel(); });
    window.addEventListener("beforeunload", flush);
  }

  window.GCNotes = { init, flush };
})();
