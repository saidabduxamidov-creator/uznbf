/*
 * GeminiCut for DaVinci Resolve - host (Resolve skript API bilan ishlaydigan qism).
 *
 * Premiere versiyasidagi host.jsx bilan bir xil funksiyalar (gc_*) va bir xil javob
 * formati: panel kodi o'zgarishsiz ishlaydi. Barcha vaqtlar - timeline boshidan soniya,
 * treklar 0 dan (A1 = 0). Resolve API chaqiruvlari asinxron (await).
 *
 * Resolve API'da yo'q narsalar va yechimlar:
 *  - Keyframe: Fusion kompozitsiyasi (Transform + BrightnessContrast) Lua orqali.
 *  - Blade/ripple kesish: pauzalarsiz YANGI timeline yaratiladi, asl timeline saqlanadi.
 *  - Klip tanlash (selection): playhead ostidagi klip ishlatiladi.
 */
"use strict";

const VERSION = "4.1.0";
const BIN = "GeminiCut";

function pad(n) { return String(n).padStart(2, "0"); }

function tcToFrames(tc, fps) {
  const drop = /;/.test(tc);
  const [h, m, s, f] = String(tc).split(/[:;.]/).map(Number);
  const nominal = Math.round(fps);
  let frames = (h * 3600 + m * 60 + s) * nominal + f;
  if (drop) {
    const d = nominal >= 59 ? 4 : 2;
    const mins = h * 60 + m;
    frames -= d * (mins - Math.floor(mins / 10));
  }
  return frames;
}

function framesToTc(frames, fps, drop) {
  const nominal = Math.round(fps);
  frames = Math.max(0, Math.round(frames));
  if (drop) {
    const d = nominal >= 59 ? 4 : 2;
    const perMin = nominal * 60 - d, per10 = perMin * 10 + d;
    const tens = Math.floor(frames / per10), rem = frames % per10;
    frames += d * 9 * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0);
  }
  const f = frames % nominal, s = Math.floor(frames / nominal) % 60;
  const m = Math.floor(frames / (nominal * 60)) % 60, h = Math.floor(frames / (nominal * 3600));
  return `${pad(h)}:${pad(m)}:${pad(s)}${drop ? ";" : ":"}${pad(f)}`;
}

/* Fusion Lua uchun satr literali */
function luaStr(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'; }
function luaNum(n) { return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0"; }

/*
 * Klipning Fusion kompozitsiyasi uchun Lua skripti: MediaIn -> GCTransform -> GCFade -> MediaOut.
 * keys: { size: [[frame, v]], center: [[frame, x, y]], angle: [[frame, v]], gain: [[frame, v]] }
 * frame - klip boshidan (0), skript ichida kompozitsiya boshlanishiga qo'shiladi.
 */
function buildMotionLua(keys) {
  const L = [];
  L.push("local c = comp");
  L.push("c:Lock()");
  L.push('local mi = c:FindTool("MediaIn1")');
  L.push('local mo = c:FindTool("MediaOut1")');
  L.push('if not mi or not mo then c:Unlock() error("MediaIn1/MediaOut1 topilmadi") end');
  L.push("local s = c:GetAttrs().COMPN_RenderStart or 0");
  L.push("local function chain(name, kind)");
  L.push("  local t = c:FindTool(name)");
  L.push("  if t then return t end");
  L.push("  t = c:AddTool(kind, -32768, -32768)");
  L.push("  t:SetAttrs({ TOOLS_Name = name })");
  L.push("  local src = mo.Input:GetConnectedOutput() or mi.Output");
  L.push("  t.Input = src");
  L.push("  mo.Input = t.Output");
  L.push("  return t");
  L.push("end");
  const needT = keys.size || keys.center || keys.angle;
  if (needT) L.push('local tr = chain("GCTransform", "Transform")');
  if (keys.size) {
    L.push("tr.Size = c:BezierSpline({})");
    keys.size.forEach(([f, v]) => L.push(`tr.Size[s + ${luaNum(f)}] = ${luaNum(v)}`));
  }
  if (keys.center) {
    L.push("tr.Center = c:XYPath({})");
    keys.center.forEach(([f, x, y]) => L.push(`tr.Center[s + ${luaNum(f)}] = { ${luaNum(x)}, ${luaNum(y)} }`));
  }
  if (keys.angle) {
    L.push("tr.Angle = c:BezierSpline({})");
    keys.angle.forEach(([f, v]) => L.push(`tr.Angle[s + ${luaNum(f)}] = ${luaNum(v)}`));
  }
  if (keys.gain) {
    L.push('local fd = chain("GCFade", "BrightnessContrast")');
    L.push("fd.Gain = c:BezierSpline({})");
    keys.gain.forEach(([f, v]) => L.push(`fd.Gain[s + ${luaNum(f)}] = ${luaNum(v)}`));
  }
  L.push("c:Unlock()");
  return L.join("\n");
}

/* GeminiCut Fusion vositalarini olib tashlab, zanjirni tiklaydi */
function buildResetLua() {
  return [
    "local c = comp",
    "c:Lock()",
    'local mi = c:FindTool("MediaIn1")',
    'local mo = c:FindTool("MediaOut1")',
    'for _, name in ipairs({ "GCFade", "GCTransform" }) do',
    "  local t = c:FindTool(name)",
    "  if t then",
    "    local src = t.Input:GetConnectedOutput()",
    "    for _, inp in ipairs(t.Output:GetConnectedInputs()) do inp:ConnectTo(src) end",
    "    t:Delete()",
    "  end",
    "end",
    "if mo and mi and not mo.Input:GetConnectedOutput() then mo.Input = mi.Output end",
    "c:Unlock()",
  ].join("\n");
}

function createHost(resolve, deps) {
  const fs = deps.fs, path = deps.path;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const state = { pendingZooms: null };

  async function env() {
    const pm = await resolve.GetProjectManager();
    const project = pm && (await pm.GetCurrentProject());
    if (!project) throw new Error("Resolve'da loyiha ochilmagan.");
    const tl = await project.GetCurrentTimeline();
    if (!tl) throw new Error("Timeline ochilmagan. Edit sahifasida timeline'ni oching.");
    let fps = parseFloat(await tl.GetSetting("timelineFrameRate")) || parseFloat(await project.GetSetting("timelineFrameRate")) || 25;
    const start = await tl.GetStartFrame();
    const end = await tl.GetEndFrame();
    const startTc = String(await tl.GetStartTimecode() || "");
    const drop = /;/.test(startTc) || /DF/i.test(String(await tl.GetSetting("timelineDropFrameTimecode") || ""));
    return { pm, project, tl, fps, start, end, drop, mp: await project.GetMediaPool() };
  }

  const sec = (e, frame) => (frame - e.start) / e.fps;
  const frameAt = (e, s) => e.start + Math.round(s * e.fps);

  async function playheadFrame(e) {
    const tc = await e.tl.GetCurrentTimecode();
    return tc ? tcToFrames(tc, e.fps) : e.start;
  }

  async function items(e, type, index1) {
    return (await e.tl.GetItemListInTrack(type, index1)) || [];
  }

  async function itemInfo(it) {
    return { it, start: await it.GetStart(), end: await it.GetEnd(), name: await it.GetName() };
  }

  async function itemAt(e, type, index1, frame) {
    for (const it of await items(e, type, index1)) {
      const a = await it.GetStart(), b = await it.GetEnd();
      if (a <= frame && b > frame) return it;
    }
    return null;
  }

  async function itemPath(it) {
    try { const mpi = await it.GetMediaPoolItem(); return mpi ? String(await mpi.GetClipProperty("File Path") || "").toLowerCase() : ""; } catch (e) { return ""; }
  }

  async function sourceStart(it) {
    if (typeof it.GetSourceStartFrame === "function") { const v = await it.GetSourceStartFrame(); if (Number.isFinite(v)) return v; }
    return (await it.GetLeftOffset()) || 0;
  }

  /* GeminiCut papkasini (bin) topadi yoki yaratadi */
  async function bin(e, sub) {
    const root = await e.mp.GetRootFolder();
    const find = async (parent, name) => {
      for (const f of (await parent.GetSubFolderList()) || []) if ((await f.GetName()) === name) return f;
      return e.mp.AddSubFolder(parent, name);
    };
    let f = await find(root, BIN);
    if (sub) f = await find(f, sub);
    return f;
  }

  /* Faylni Media Pool'ga bir marta import qiladi */
  async function importOnce(e, file, sub) {
    if (!fs.existsSync(file)) throw new Error("Fayl topilmadi: " + file);
    const folder = await bin(e, sub);
    const target = path.resolve(file).toLowerCase();
    for (const clip of (await folder.GetClipList()) || []) {
      const p = String(await clip.GetClipProperty("File Path") || "");
      if (p && path.resolve(p).toLowerCase() === target) return clip;
    }
    await e.mp.SetCurrentFolder(folder);
    const list = await e.mp.ImportMedia([file]);
    if (!list || !list.length) throw new Error("Import qilinmadi: " + path.basename(file));
    return list[0];
  }

  async function clipFrames(e, mpi) {
    const n = parseInt(await mpi.GetClipProperty("Frames"), 10);
    if (Number.isFinite(n) && n > 0) return n;
    const d = await mpi.GetClipProperty("Duration");
    return d ? tcToFrames(d, e.fps) : Math.round(e.fps);
  }

  async function markRange(e) {
    try {
      const mk = await e.tl.GetMarkInOut();
      const v = mk && (mk.video || mk.audio);
      if (v && Number.isFinite(v.in) && Number.isFinite(v.out) && v.out > v.in) {
        const base = v.in < e.start ? e.start : 0;
        return { in: v.in + base, out: v.out + base };
      }
    } catch (err) { /* 19 dan eski versiya */ }
    return null;
  }

  /* ---------------- motion ---------------- */

  /* Host formatidagi ops -> Fusion kalitlari (klip boshidan kadrlarda) */
  function opsToFusionKeys(op, info, fps) {
    const out = {};
    const rel = op.mode === "rel";
    const toF = (t) => Math.round((t - info.startSec) * fps);
    if (op.prop === "scale") out.size = op.keys.map(([t, v]) => [toF(t), v / 100]);
    if (op.prop === "position") out.center = op.keys.map(([t, v]) => (rel ? [toF(t), 0.5 + v[0], 0.5 - v[1]] : [toF(t), v[0], 1 - v[1]]));
    if (op.prop === "rotation") out.angle = op.keys.map(([t, v]) => [toF(t), -v]); // Fusion: soat strelkasiga teskari
    if (op.prop === "opacity") out.gain = op.keys.map(([t, v]) => [toF(t), Math.max(0, Math.min(100, v)) / 100]);
    return out;
  }

  async function fusionComp(it) {
    const count = typeof it.GetFusionCompCount === "function" ? await it.GetFusionCompCount() : 0;
    const comp = count > 0 ? await it.GetFusionCompByIndex(1) : await it.AddFusionComp();
    if (!comp || typeof comp.Execute !== "function") throw new Error("Fusion kompozitsiyasi ochilmadi");
    return comp;
  }

  async function motionCore(ops) {
    const e = await env();
    const groups = new Map(), errors = [];
    for (const op of ops) {
      const vt = op.track + 1;
      const list = await items(e, "video", vt);
      const target = frameAt(e, op.start);
      let found = null;
      for (const it of list) { const a = await it.GetStart(); if (Math.abs(a - target) <= 1) { found = it; break; } }
      if (!found) found = await itemAt(e, "video", vt, target + 1);
      if (!found) { errors.push(`klip topilmadi (V${vt}, ${op.start.toFixed(2)}s)`); continue; }
      const key = (await found.GetUniqueId?.()) || `${vt}:${await found.GetStart()}`;
      if (!groups.has(key)) groups.set(key, { it: found, startSec: sec(e, await found.GetStart()), keys: {} });
      const g = groups.get(key);
      Object.assign(g.keys, opsToFusionKeys(op, g, e.fps));
    }
    let applied = 0, keys = 0;
    for (const g of groups.values()) {
      try {
        const comp = await fusionComp(g.it);
        await comp.Execute(buildMotionLua(g.keys));
        applied++;
        keys += Object.values(g.keys).reduce((a, k) => a + k.length, 0);
      } catch (err) { errors.push(err.message); }
    }
    return { applied, keys, errors };
  }

  /* ---------------- panel chaqiradigan funksiyalar ---------------- */

  const api = {
    async gc_ping() {
      let v = "";
      try { v = await resolve.GetVersionString(); } catch (e) { /* eski */ }
      return { version: VERSION, host: "DaVinci Resolve " + v };
    },

    async gc_setKeyBase() { return {}; },

    async gc_getSequenceInfo() {
      const e = await env();
      const duration = (e.end - e.start) / e.fps;
      const audio = [], sig = [];
      let clipCount = 0;
      const na = await e.tl.GetTrackCount("audio");
      for (let a = 1; a <= na; a++) {
        const list = await items(e, "audio", a);
        let covered = 0;
        for (const it of list) {
          const s = await it.GetStart(), t = await it.GetEnd();
          covered += (t - s) / e.fps;
          sig.push(`a${a}:${s}-${t}`);
        }
        clipCount += list.length;
        audio.push({ index: a - 1, name: (await e.tl.GetTrackName("audio", a)) || `Audio ${a}`, clips: list.length,
          muted: !(await e.tl.GetIsTrackEnabled("audio", a)), locked: !!(await e.tl.GetIsTrackLocked("audio", a)),
          coverage: duration > 0 ? covered / duration : 0 });
      }
      const nv = await e.tl.GetTrackCount("video");
      for (let v = 1; v <= nv; v++) {
        const list = await items(e, "video", v);
        clipCount += list.length;
        for (const it of list) sig.push(`v${v}:${await it.GetStart()}-${await it.GetEnd()}`);
      }
      const mk = await markRange(e);
      return {
        id: String((await e.tl.GetUniqueId?.()) || (await e.tl.GetName())), name: await e.tl.GetName(),
        duration, inPoint: mk ? sec(e, mk.in) : 0, outPoint: mk ? sec(e, mk.out) : duration, hasRange: !!mk,
        fps: e.fps, width: Number(await e.tl.GetSetting("timelineResolutionWidth")) || 1920,
        height: Number(await e.tl.GetSetting("timelineResolutionHeight")) || 1080,
        playhead: sec(e, await playheadFrame(e)), audioTracks: audio, videoTracks: nv, clipCount, signature: sig.join("|"),
      };
    },

    async gc_findAudioPreset() { return { path: "resolve-render", scanned: 0 }; },

    /* Timeline audiosini Resolve render'i orqali WAV qiladi (faqat tanlangan nutq treklari) */
    async gc_exportAudio(outPath, preset, tracks, useInOut) {
      const e = await env();
      const na = await e.tl.GetTrackCount("audio");
      const saved = [];
      const dir = path.dirname(outPath), base = path.basename(outPath).replace(/\.wav$/i, "");
      let page = null, job = null;
      try { page = await resolve.GetCurrentPage(); } catch (err) { /* e'tiborsiz */ }
      try {
        for (let a = 1; a <= na; a++) {
          saved.push(await e.tl.GetIsTrackEnabled("audio", a));
          await e.tl.SetTrackEnable("audio", a, tracks.includes(a - 1));
        }
        const codecs = (await e.project.GetRenderCodecs("wav")) || {};
        const names = Object.values(codecs);
        const codec = names.find((c) => /pcm/i.test(c)) || names[0] || "LinearPCM";
        if (!(await e.project.SetCurrentRenderFormatAndCodec("wav", codec))) throw new Error("WAV render formati o'rnatilmadi.");
        try { await e.project.SetCurrentRenderMode(1); } catch (err) { /* e'tiborsiz */ }
        const mk = useInOut ? await markRange(e) : null;
        const settings = { TargetDir: dir, CustomName: base, ExportVideo: false, ExportAudio: true, AudioSampleRate: 48000, AudioBitDepth: 16 };
        if (mk) Object.assign(settings, { SelectAllFrames: false, MarkIn: mk.in, MarkOut: mk.out - 1 });
        else settings.SelectAllFrames = true;
        if (!(await e.project.SetRenderSettings(settings))) throw new Error("Render sozlamalari qabul qilinmadi.");
        job = await e.project.AddRenderJob();
        if (!job) throw new Error("Render ishi yaratilmadi.");
        await e.project.StartRendering([job], false);
        const t0 = Date.now();
        while (await e.project.IsRenderingInProgress()) {
          if (Date.now() - t0 > 30 * 60000) throw new Error("Audio render juda uzoq davom etdi.");
          await sleep(400);
        }
        const st = (await e.project.GetRenderJobStatus(job)) || {};
        if (st.JobStatus && !/complete/i.test(st.JobStatus)) throw new Error("Audio render yakunlanmadi: " + st.JobStatus + (st.Error ? " - " + st.Error : ""));
        let file = path.join(dir, base + ".wav");
        if (!fs.existsSync(file)) {
          const cand = fs.readdirSync(dir).filter((n) => n.startsWith(base) && /\.wav$/i.test(n));
          if (!cand.length) throw new Error("Render qilingan WAV topilmadi.");
          file = path.join(dir, cand[0]);
        }
        return { path: file, offset: mk ? sec(e, mk.in) : 0, end: mk ? sec(e, mk.out) : (e.end - e.start) / e.fps };
      } finally {
        for (let a = 1; a <= saved.length; a++) { try { await e.tl.SetTrackEnable("audio", a, saved[a - 1]); } catch (err) { /* e'tiborsiz */ } }
        if (job) { try { await e.project.DeleteRenderJob(job); } catch (err) { /* e'tiborsiz */ } }
        if (page) { try { await resolve.OpenPage(page); } catch (err) { /* e'tiborsiz */ } }
      }
    },

    /* SRT: Media Pool'ga import va subtitr trekiga qo'yish */
    async gc_importSrt(srtPath) {
      const e = await env();
      const item = await importOnce(e, srtPath, "Subtitrlar");
      try {
        if ((await e.tl.GetTrackCount("subtitle")) < 1) await e.tl.AddTrack("subtitle");
        const n = await e.tl.GetTrackCount("subtitle");
        const placed = await e.mp.AppendToTimeline([{ mediaPoolItem: item, recordFrame: e.start, trackIndex: n }]);
        if (placed && placed.length) return { item: await item.GetName() };
      } catch (err) { /* quyidagi xabar */ }
      throw new Error("SRT Media Pool'ga qo'shildi (GeminiCut → Subtitrlar). Uni timeline boshiga sudrab qo'ying - Resolve subtitr trekini o'zi yaratadi.");
    },

    async gc_applyMotion(ops) {
      const r = await motionCore(ops);
      if (!r.applied && r.errors.length) throw new Error("Motion qo'llanmadi: " + r.errors.join("; "));
      return r;
    },

    async gc_resetMotion(targets) {
      const e = await env();
      let reset = 0;
      for (const [track, start] of targets) {
        const it = await itemAt(e, "video", track + 1, frameAt(e, start) + 1);
        if (!it) continue;
        const count = typeof it.GetFusionCompCount === "function" ? await it.GetFusionCompCount() : 0;
        if (count > 0) { const comp = await it.GetFusionCompByIndex(1); await comp.Execute(buildResetLua()); }
        reset++;
      }
      return { reset };
    },

    /* Playhead ostidagi eng yuqori video klip (Resolve API'da selection yo'q) */
    async gc_getEditContext() {
      const e = await env();
      const ph = await playheadFrame(e);
      const clips = [];
      const nv = await e.tl.GetTrackCount("video");
      for (let v = nv; v >= 1; v--) {
        if (await e.tl.GetIsTrackLocked("video", v)) continue;
        const it = await itemAt(e, "video", v, ph);
        if (!it) continue;
        const i = await itemInfo(it);
        clips.push({ track: v - 1, start: sec(e, i.start), end: sec(e, i.end), name: i.name, inPoint: (await sourceStart(it)) / e.fps,
          speed: 1, path: await itemPath(it), scale: 100, position: [0.5, 0.5], rotation: 0, opacity: 100 });
        break;
      }
      return { clips, source: clips.length ? "playhead" : "none", playhead: sec(e, ph), fps: e.fps,
        width: Number(await e.tl.GetSetting("timelineResolutionWidth")) || 1920, height: Number(await e.tl.GetSetting("timelineResolutionHeight")) || 1080,
        name: await e.tl.GetName(), id: String((await e.tl.GetUniqueId?.()) || "") };
    },

    /* AI zoom: gapirayotgan odamning klipiga Fusion punch-in */
    async gc_applyZooms(zooms, speech) {
      const e = await env();
      state.pendingZooms = { zooms: zooms.slice(), speech: speech.slice(), tl: await e.tl.GetName() };
      const ramp = 0.35, ops = [];
      let skipped = 0;
      const nv = await e.tl.GetTrackCount("video");
      for (const [t0, pct, holdRaw] of zooms.slice().sort((a, b) => a[0] - b[0])) {
        const f0 = frameAt(e, t0);
        let speaker = "";
        for (const s of speech) { const ai = await itemAt(e, "audio", s + 1, f0); if (ai) { speaker = await itemPath(ai); break; } }
        let target = null, tIndex = -1, fallback = null, fIndex = -1;
        for (let v = 1; v <= nv; v++) {
          if (await e.tl.GetIsTrackLocked("video", v)) continue;
          const it = await itemAt(e, "video", v, f0);
          if (!it) continue;
          if (!fallback) { fallback = it; fIndex = v - 1; }
          if (speaker && (await itemPath(it)) === speaker) { target = it; tIndex = v - 1; break; }
        }
        if (!target) { target = fallback; tIndex = fIndex; }
        if (!target) { skipped++; continue; }
        const endSec = sec(e, await target.GetEnd()) - 1 / e.fps;
        const hold = Math.max(0.5, Math.min(8, holdRaw)), p = Math.max(102, Math.min(160, pct));
        const t3 = Math.min(t0 + ramp + hold + ramp, endSec);
        if (t3 - t0 < 0.3) { skipped++; continue; }
        const r = Math.min(ramp, (t3 - t0) / 3);
        ops.push({ track: tIndex, start: sec(e, await target.GetStart()), prop: "scale", mode: "rel", keys: [[t0, 100], [t0 + r, p], [t3 - r, p], [t3, 100]] });
      }
      if (!ops.length) return { applied: 0, skipped };
      const res = await motionCore(ops);
      if (!res.applied && res.errors.length) throw new Error("Zoom qo'llanmadi: " + res.errors.join("; "));
      return { applied: res.applied, skipped: skipped + ops.length - res.applied, errors: res.errors };
    },

    /*
     * Kesish: Resolve API'da blade yo'q - shuning uchun oraliqlarsiz YANGI timeline yaratiladi
     * (V1 dagi klip bo'laklari manbadan qayta yig'iladi, video+audio birga). Asl timeline saqlanadi.
     */
    async gc_applyCuts(ranges, speech) {
      const e = await env();
      const cut = ranges.map(([a, b]) => [frameAt(e, a), frameAt(e, b)]).filter(([a, b]) => b - a >= 2).sort((x, y) => x[0] - y[0]);
      if (!cut.length) return { applied: 0, seconds: 0 };
      const main = await items(e, "video", 1);
      if (!main.length) throw new Error("V1 trekida klip yo'q.");
      const infos = [];
      for (const it of main) {
        const s = await it.GetStart(), t = await it.GetEnd();
        const mpi = await it.GetMediaPoolItem();
        if (!mpi) continue;
        let pieces = [[s, t]];
        for (const [a, b] of cut) {
          pieces = pieces.flatMap(([p, q]) => (b <= p || a >= q ? [[p, q]] : [[p, a], [b, q]].filter(([x, y]) => y - x >= 1)));
        }
        const src = await sourceStart(it);
        for (const [p, q] of pieces) infos.push({ mediaPoolItem: mpi, startFrame: src + (p - s), endFrame: src + (q - s) - 1, _tl: [p, q] });
      }
      const name = (await e.tl.GetName()) + " (GeminiCut)";
      const origName = await e.tl.GetName();
      const newTl = await e.mp.CreateEmptyTimeline(name);
      if (!newTl) throw new Error("Yangi timeline yaratilmadi (bu nom band bo'lishi mumkin: " + name + ").");
      await e.project.SetCurrentTimeline(newTl);
      const placed = await e.mp.AppendToTimeline(infos.map(({ _tl, ...ci }) => ci));
      if (!placed || !placed.length) throw new Error("Yangi timeline'ga klip qo'shilmadi.");
      const removed = cut.reduce((a, [x, y]) => a + (y - x), 0) / e.fps;

      // Oldin so'ralgan zoom'lar yangi timeline vaqtiga o'tkazilib qayta qo'llanadi
      let zoomed = 0;
      const pz = state.pendingZooms;
      state.pendingZooms = null;
      if (pz && pz.tl === origName) {
        const shift = (t) => {
          const f = frameAt(e, t);
          let before = 0;
          for (const [a, b] of cut) { if (f >= a && f < b) return null; if (b <= f) before += b - a; }
          return (f - before - e.start) / e.fps;
        };
        const moved = pz.zooms.map(([t, p, h]) => [shift(t), p, h]).filter(([t]) => t !== null);
        if (moved.length) { try { zoomed = (await api.gc_applyZooms(moved, pz.speech)).applied; } catch (err) { /* asosiy natija - timeline */ } }
      }
      return { applied: cut.length, seconds: removed, newTimeline: name, zoomed };
    },

    async gc_setPlayhead(s) {
      const e = await env();
      await e.tl.SetCurrentTimecode(framesToTc(frameAt(e, Math.max(0, s)), e.fps, e.drop));
      return {};
    },

    /* SFX: playhead joyiga, bo'sh (nutq bo'lmagan) audio trekka; bo'sh trek bo'lmasa yangisi */
    async gc_insertSound(file, trackIndex, at, avoid) {
      const e = await env();
      const mpi = await importOnce(e, file, "SFX");
      const frames = await clipFrames(e, mpi);
      const rec = at >= 0 ? frameAt(e, at) : await playheadFrame(e);
      const free = async (a) => {
        for (const it of await items(e, "audio", a)) { if ((await it.GetStart()) < rec + frames && (await it.GetEnd()) > rec) return false; }
        return true;
      };
      let idx = -1;
      const na = await e.tl.GetTrackCount("audio");
      if (trackIndex >= 0) {
        if (trackIndex >= na) throw new Error(`A${trackIndex + 1} audio trek mavjud emas.`);
        if (await e.tl.GetIsTrackLocked("audio", trackIndex + 1)) throw new Error(`A${trackIndex + 1} qulflangan.`);
        if (!(await free(trackIndex + 1))) throw new Error(`A${trackIndex + 1} da bu joy band. Avtomatik trekni tanlang.`);
        idx = trackIndex + 1;
      } else {
        for (let a = 1; a <= na; a++) {
          if ((avoid || []).includes(a - 1) || (await e.tl.GetIsTrackLocked("audio", a))) continue;
          if (await free(a)) { idx = a; break; }
        }
        if (idx < 0) {
          await e.tl.AddTrack("audio", "stereo");
          const n2 = await e.tl.GetTrackCount("audio");
          if (n2 <= na) throw new Error("Bo'sh audio trek yo'q va yangisi yaratilmadi.");
          idx = n2;
        }
      }
      const placed = await e.mp.AppendToTimeline([{ mediaPoolItem: mpi, startFrame: 0, endFrame: frames - 1, trackIndex: idx, recordFrame: rec, mediaType: 2 }]);
      if (!placed || !placed.length) throw new Error("Effekt timeline'ga qo'yilmadi.");
      return { name: await mpi.GetName(), track: idx - 1, at: sec(e, rec), duration: frames / e.fps };
    },

    /* Kadrlarni PNG qilib eksport (Claude vision uchun); playhead joyi tiklanadi */
    async gc_exportFrames(base, times) {
      const e = await env();
      const saved = await e.tl.GetCurrentTimecode();
      const files = [];
      try {
        for (let i = 0; i < times.length; i++) {
          await e.tl.SetCurrentTimecode(framesToTc(frameAt(e, times[i]), e.fps, e.drop));
          const f = `${base}_${i}.png`;
          if ((await e.project.ExportCurrentFrameAsStill(f)) && fs.existsSync(f)) files.push(f);
        }
      } finally {
        if (saved) { try { await e.tl.SetCurrentTimecode(saved); } catch (err) { /* e'tiborsiz */ } }
      }
      if (!files.length && times.length) throw new Error("Kadr eksport qilinmadi. Resolve'da Color yoki Edit sahifasida timeline ochiq bo'lsin.");
      return { files };
    },

    async gc_flowCapture(frameBase) {
      const e = await env();
      const ph = await playheadFrame(e);
      const frame = frameBase + ".png";
      if (!(await e.project.ExportCurrentFrameAsStill(frame)) || !fs.existsSync(frame)) throw new Error("Kadr eksport qilinmadi.");
      return { sequenceID: String((await e.tl.GetUniqueId?.()) || (await e.tl.GetName())), sequenceName: await e.tl.GetName(), projectPath: "",
        ticks: String(ph), seconds: sec(e, ph), frame, width: Number(await e.tl.GetSetting("timelineResolutionWidth")) || 1920,
        height: Number(await e.tl.GetSetting("timelineResolutionHeight")) || 1080 };
    },

    /* Tayyor MP4 - yangi video trekka (faqat video), kadr olingan joyga */
    async gc_flowImport(file, sequenceID, frameStr, projectPath, useCurrent) {
      const e = await env();
      const id = String((await e.tl.GetUniqueId?.()) || (await e.tl.GetName()));
      if (sequenceID && id !== String(sequenceID)) throw new Error("Kadr olingan timeline'ni qayta oching, so'ng importni qayta bosing.");
      const mpi = await importOnce(e, file, "AI Video");
      const frames = await clipFrames(e, mpi);
      const rec = useCurrent ? await playheadFrame(e) : Number(frameStr);
      if (!Number.isFinite(rec)) throw new Error("Timeline vaqti noto'g'ri.");
      const nv = await e.tl.GetTrackCount("video");
      await e.tl.AddTrack("video");
      const idx = await e.tl.GetTrackCount("video");
      if (idx <= nv) throw new Error("Yangi video trek yaratilmadi.");
      const placed = await e.mp.AppendToTimeline([{ mediaPoolItem: mpi, startFrame: 0, endFrame: frames - 1, trackIndex: idx, recordFrame: rec, mediaType: 1 }]);
      if (!placed || !placed.length) throw new Error("Video timeline'ga qo'yilmadi. MP4 Media Pool'da (GeminiCut → AI Video).");
      return { track: idx, seconds: sec(e, rec), name: path.basename(file) };
    },
  };

  /* Har bir funksiya {ok:true,...} yoki {ok:false,error} qaytaradi (Premiere versiyasi bilan bir xil) */
  const wrapped = {};
  for (const [name, fn] of Object.entries(api)) {
    wrapped[name] = async (...args) => {
      try { return Object.assign({ ok: true }, await fn(...args)); }
      catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
    };
  }
  return wrapped;
}

module.exports = { createHost, buildMotionLua, buildResetLua, tcToFrames, framesToTc, VERSION };
