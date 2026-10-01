/*
 * GeminiCut - AI montajchi (Claude va ChatGPT bo'limlari): prompt orqali motion, SFX va montaj.
 *  1) Premiere'dan tanlangan klip(lar) konteksti va bir nechta kadr (vision)
 *  2) AI (Claude Opus 5.5 yoki ChatGPT) reja tuzadi (JSON sxema bo'yicha): motion keyframe'lar,
 *     kutubxonadagi SFX'lar, ixtiyoriy kesishlar
 *  3) Reja ro'yxatda ko'rsatiladi, tanlanganlari Premiere'ga qo'llanadi (Ctrl+Z bilan qaytadi)
 * Bir xil mantiq ikki bo'limda ishlaydi: createPlanner({ prefix: "cl" | "gp", ... }).
 */
(function () {
  "use strict";

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const url = require("url");
  const $ = (id) => document.getElementById(id);

  const PLAN_SCHEMA = {
    type: "object",
    properties: {
      summary: { type: "string", description: "What you will do, 1-3 short sentences in Uzbek (Latin)." },
      motions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            clip: { type: "integer", description: "Index into the clips list." },
            property: { type: "string", enum: ["scale", "position", "rotation", "opacity"] },
            mode: { type: "string", enum: ["relative", "absolute"] },
            easing: { type: "string", enum: ["linear", "ease_in", "ease_out", "ease_in_out", "overshoot"] },
            keyframes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  time: { type: "number", description: "Seconds from the start of the clip on the timeline." },
                  value: { type: "number", description: "scale %, rotation degrees or opacity 0-100. Use 0 for position." },
                  x: { type: "number", description: "Position only: horizontal, fraction of frame width. Otherwise 0." },
                  y: { type: "number", description: "Position only: vertical, fraction of frame height (down is positive). Otherwise 0." },
                },
              },
            },
            reason: { type: "string", description: "Short reason in Uzbek (Latin)." },
          },
        },
      },
      sfx: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sound_id: { type: "string", description: "Exact id from the sound library list." },
            time: { type: "number", description: "Timeline seconds where the sound starts." },
            reason: { type: "string" },
          },
        },
      },
      cuts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Timeline seconds." },
            end: { type: "number", description: "Timeline seconds." },
            reason: { type: "string" },
          },
        },
      },
    },
  };

  const SYSTEM = `You are a senior motion designer and video editor working inside Adobe Premiere Pro.
You receive: the selected timeline clips (with index, timeline start/end, duration and current Motion values), frames from those clips, optionally the speech transcript with timeline times, and the user's sound-effects library. The user describes the edit they want. Produce an edit plan that the plugin applies with keyframes.

How the plan is applied:
- motions: keyframes on a clip's Motion/Opacity. "time" is seconds from the start of that clip (0 .. duration). Between your keyframes the plugin adds smooth in-between points using "easing".
  - scale: mode "relative" = percent of the clip's current scale (100 = unchanged, 115 = 15% closer); "absolute" = Premiere scale value.
  - position: use x/y. mode "relative" = offset from the current position as a fraction of the frame (x 0.05 = 5% of frame width to the right, y 0.05 = 5% of frame height down). "absolute" = frame fraction where [0.5, 0.5] is the centre. Remember: to move the camera toward a point that is to the right, move the image LEFT (negative x) while zooming.
  - rotation: degrees; "relative" adds to the current rotation.
  - opacity: always "absolute", 0..100.
  - Start and end every animation at the neutral value (relative scale 100, position 0/0, rotation 0) unless the user wants the effect to stay. Keep keyframe times inside the clip.
- sfx: sound_id MUST be an exact id from the library list; time is timeline seconds. Put whooshes slightly before the visual move (about 0.1-0.2 s earlier), impacts exactly on the hit.
- cuts: only when the user explicitly asks to remove parts; timeline seconds.

Taste: professional and purposeful, never random. Prefer subtle values (scale 105-125, rotation within +-5 degrees) unless asked otherwise. Match emphasis in the speech when a transcript is given. Use the frames to aim zooms at faces or the subject.
Write "summary" and every "reason" in Uzbek (Latin script). Return empty arrays for things the user did not ask for.`;

  /* Har bir AI provayderi: nomi, kalit maydoni va chaqiruvi */
  const PROVIDERS = {
    claude: { name: "Claude", keyField: "claudeKey", keyMsg: "Sozlamalarda Claude (Anthropic) API kalitini kiriting.",
      call: (s, o) => window.GCAI.claude(Object.assign({ apiKey: s.claudeKey }, o)) },
    openai: { name: "ChatGPT", keyField: "openaiKey", keyMsg: "Sozlamalarda ChatGPT (OpenAI) API kalitini kiriting.",
      call: (s, o) => window.GCAI.openai(Object.assign({ apiKey: s.openaiKey, model: s.openaiModel }, o)) },
  };

  /* PNG kadrni kichraytirib JPEG base64 ga aylantiradi (AI vision uchun) */
  function toJpeg(file, max) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.82).split(",")[1]);
      };
      img.onerror = () => reject(new Error("Kadrni o'qib bo'lmadi."));
      const href = url.pathToFileURL(file).href;
      img.src = /^file:/.test(href) ? href + "?t=" + Date.now() : href; // kesh chetlab o'tiladi
    });
  }

  function createPlanner(opts) {
    const P = opts.prefix, AI = PROVIDERS[opts.provider], VIEW = document.getElementById(opts.view);
    let ctx = null, plan = null, busy = false, token = null;

    const status = (t, err) => { const el = $(P + "Status"); el.textContent = t; el.classList.toggle("error", !!err); };

    function clipLabel(c, i) {
      const f = (s) => window.GCSubs.formatClock(s);
      return `#${i} · V${c.track + 1} · ${f(c.start)}–${f(c.end)} · ${c.name}`;
    }

    async function refresh() {
      try {
        ctx = await window.GCHost.call("gc_getEditContext", [], 15000);
        const box = $(P + "Clips");
        box.innerHTML = "";
        if (!ctx.clips.length) { box.textContent = "Klip tanlanmagan. Timeline'da klipni tanlang yoki playhead'ni klip ustiga qo'ying."; return ctx; }
        ctx.clips.forEach((c, i) => { const d = document.createElement("div"); d.className = "cl-clip"; d.textContent = clipLabel(c, i); box.appendChild(d); });
        const note = document.createElement("div");
        note.className = "cl-src";
        note.textContent = ctx.source === "selection" ? `${ctx.clips.length} ta tanlangan klip` : "Playhead ostidagi klip (hech narsa tanlanmagan)";
        box.appendChild(note);
        return ctx;
      } catch (e) { status(e.message, true); return null; }
    }

    async function captureFrames(clips) {
      const times = [];
      const perClip = clips.length > 2 ? 1 : clips.length === 2 ? 2 : 3;
      clips.slice(0, 6).forEach((c, i) => {
        const d = c.end - c.start;
        const picks = perClip === 1 ? [0.5] : perClip === 2 ? [0.15, 0.75] : [0.08, 0.5, 0.92];
        picks.forEach((p) => times.push({ clip: i, t: c.start + d * p }));
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-frames-"));
      try {
        const r = await window.GCHost.call("gc_exportFrames", [path.join(dir, "f"), times.map((x) => x.t)], 120000);
        const out = [];
        for (let i = 0; i < r.files.length; i++) {
          out.push({ clip: times[i].clip, t: times[i].t, data: await toJpeg(r.files[i], 768) });
        }
        return out;
      } finally {
        fs.rm(dir, { recursive: true, force: true }, () => {});
      }
    }

    function transcriptFor(clips) {
      const t = window.GCApplication.transcript();
      if (!t || !t.length) return [];
      const lo = Math.min(...clips.map((c) => c.start)), hi = Math.max(...clips.map((c) => c.end));
      return t.filter((s) => s.type === "speech" && s.end > lo && s.start < hi)
        .map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), text: s.text, emphasis: !!s.emphasis }));
    }

    async function makePlan() {
      if (busy) return;
      const prompt = $(P + "Prompt").value.trim();
      if (!prompt) return status("Nima qilish kerakligini yozing.", true);
      const settings = window.GCApplication.settings();
      if (!settings[AI.keyField]) { window.GCApplication.openSettings(AI.keyField); return status(AI.keyMsg, true); }
      busy = true;
      token = window.GCGemini.createCancelToken();
      setBusy(true);
      try {
        status("Timeline konteksti olinmoqda…");
        const c = await refresh();
        if (!c || !c.clips.length) throw new Error("Timeline'da klipni tanlang.");
        const clips = c.clips.slice(0, 12);
        const content = [];
        if ($(P + "Frames").checked) {
          status("Kadrlar olinmoqda…");
          const frames = await captureFrames(clips);
          frames.forEach((f) => {
            content.push({ type: "text", text: `Frame of clip #${f.clip} at timeline ${f.t.toFixed(2)}s:` });
            content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
          });
        }
        const sounds = $(P + "Sfx").checked ? (await window.GCLibrary.index()).map(({ id, folder, name, duration }) => ({ id, folder, name, duration })) : [];
        const transcript = $(P + "Transcript").checked ? transcriptFor(clips) : [];
        const info = {
          sequence: { name: c.name, width: c.width, height: c.height, fps: Math.round(c.fps * 100) / 100, playhead: +c.playhead.toFixed(2) },
          clips: clips.map((x, i) => ({ index: i, track: "V" + (x.track + 1), name: x.name, start: +x.start.toFixed(3), end: +x.end.toFixed(3),
            duration: +(x.end - x.start).toFixed(3), scale: x.scale, position: x.position, rotation: x.rotation, opacity: x.opacity,
            already_animated: !!(x.scaleAnimated || x.positionAnimated) })),
          transcript,
          sound_library: sounds,
          allowed: { sfx: $(P + "Sfx").checked, cuts: $(P + "Cuts").checked },
        };
        content.push({ type: "text", text: "Context:\n" + JSON.stringify(info) + "\n\nUser request:\n" + prompt });

        status(`${AI.name} reja tuzmoqda… (bir necha soniya - 1 daqiqa)`);
        const t0 = Date.now();
        const tick = setInterval(() => status(`${AI.name} reja tuzmoqda… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
        let result;
        try {
          result = await AI.call(settings, { system: SYSTEM, content, schema: PLAN_SCHEMA, effort: "high", token,
            onRetry: (e, s) => status(`${e.message} ${s}s dan keyin qayta urinish…`) });
        } finally { clearInterval(tick); }
        if (!$(P + "Sfx").checked) result.sfx = [];
        if (!$(P + "Cuts").checked) result.cuts = [];
        plan = { ctx: c, clips, result, sounds };
        renderPlan();
        status("Reja tayyor. Tekshirib, “Qo'llash” ni bosing.");
      } catch (e) {
        status(e.code === "CANCELLED" ? "Bekor qilindi." : e.message, e.code !== "CANCELLED");
      } finally {
        busy = false;
        token = null;
        setBusy(false);
      }
    }

    function renderPlan() {
      const r = plan.result, box = $(P + "PlanList");
      box.innerHTML = "";
      $(P + "Summary").textContent = r.summary || "";
      const soundIds = new Set(plan.sounds.map((s) => s.id));
      const items = [];
      (r.motions || []).forEach((m, i) => items.push({ kind: "motion", i, on: !!plan.clips[m.clip],
        label: `⤴ ${m.property} · klip #${m.clip} · ${m.keyframes.length} nuqta · ${m.easing}`, reason: m.reason }));
      (r.sfx || []).forEach((s, i) => items.push({ kind: "sfx", i, on: soundIds.has(s.sound_id),
        label: `♫ ${s.sound_id.split("/").pop().replace(/\.[^.]+$/, "")} · ${window.GCSubs.formatClock(s.time)}`, reason: soundIds.has(s.sound_id) ? s.reason : "Kutubxonada topilmadi" }));
      (r.cuts || []).forEach((c, i) => items.push({ kind: "cut", i, on: c.end > c.start,
        label: `✂ ${window.GCSubs.formatClock(c.start)}–${window.GCSubs.formatClock(c.end)}`, reason: c.reason }));
      plan.items = items;
      if (!items.length) box.innerHTML = `<div class="sfx-empty">${AI.name} hech qanday o'zgarish taklif qilmadi. Promptni aniqroq yozing.</div>`;
      items.forEach((it) => {
        const row = document.createElement("label");
        row.className = "cue plan-item";
        row.innerHTML = `<input type="checkbox"><div><div class="kind ${it.kind}"></div><div class="reason"></div></div>`;
        const cb = row.querySelector("input");
        cb.checked = it.on;
        cb.disabled = it.kind === "sfx" && it.reason === "Kutubxonada topilmadi";
        cb.addEventListener("change", () => { it.on = cb.checked; });
        row.querySelector(".kind").textContent = it.label;
        row.querySelector(".reason").textContent = it.reason || "";
        box.appendChild(row);
      });
      $(P + "Plan").hidden = false;
    }

    async function applyPlan() {
      if (!plan || busy) return;
      busy = true;
      setBusy(true);
      const report = [];
      try {
        const r = plan.result, on = (kind) => plan.items.filter((x) => x.kind === kind && x.on).map((x) => x.i);
        // 1) motion
        const motions = { motions: on("motion").map((i) => r.motions[i]) };
        const { ops, problems } = window.GCMotion.planToOps(motions, plan.ctx);
        if (ops.length) {
          const res = await window.GCHost.call("gc_applyMotion", [ops.map(({ label, ...o }) => o)], 120000);
          report.push(`${res.applied} ta motion (${res.keys} keyframe)`);
          if (res.errors && res.errors.length) problems.push(...res.errors);
        }
        // 2) SFX
        const speech = window.GCApplication.speechTracks();
        const sfxTracks = [];
        for (const i of on("sfx")) {
          const s = r.sfx[i];
          const res = await window.GCHost.call("gc_insertSound", [window.GCLibrary.fileById(s.sound_id), -1, Math.max(0, s.time), speech], 60000)
            .catch((e) => { problems.push(e.message); return null; });
          if (res) { sfxTracks.push(res.track); }
        }
        if (on("sfx").length) report.push(`${sfxTracks.length} ta SFX`);
        // 3) kesishlar - oxirida; SFX treklari ham birga suriladi
        const cuts = on("cut").map((i) => [r.cuts[i].start, r.cuts[i].end]).filter(([a, b]) => b > a);
        if (cuts.length) {
          const tracks = Array.from(new Set(speech.concat(sfxTracks)));
          const res = await window.GCHost.call("gc_applyCuts", [cuts, tracks], 300000);
          report.push(`${res.applied} ta kesish`);
        }
        status((report.length ? "✓ Qo'llandi: " + report.join(", ") + "." : "Hech narsa belgilanmagan.") +
          (problems.length ? " Diqqat: " + problems.join("; ") : ""), !report.length && problems.length > 0);
        if (report.length) { plan = null; $(P + "Plan").hidden = true; window.GCApplication.timelineChanged(); }
      } catch (e) {
        status(e.message, true);
      } finally {
        busy = false;
        setBusy(false);
      }
    }

    function setBusy(on) {
      ["Run", "Apply", "Refresh"].forEach((id) => { $(P + id).disabled = on; });
      $(P + "Cancel").hidden = !on || !token;
      $(P + "Spinner").hidden = !on;
    }

    function init() {
      $(P + "Run").addEventListener("click", makePlan);
      $(P + "Apply").addEventListener("click", applyPlan);
      $(P + "Refresh").addEventListener("click", refresh);
      $(P + "Cancel").addEventListener("click", () => { if (token) token.cancel(); });
      $(P + "Discard").addEventListener("click", () => { plan = null; $(P + "Plan").hidden = true; status(""); });
      $(P + "Prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) makePlan(); });
      VIEW.querySelectorAll(".cl-example").forEach((b) => b.addEventListener("click", () => { $(P + "Prompt").value = b.dataset.text; $(P + "Prompt").focus(); }));
      document.querySelector(`[data-tab="${opts.tab}"]`).addEventListener("click", () => { if (window.GCHost.available) refresh(); });
    }

    return { init, refresh };
  }

  const claude = createPlanner({ prefix: "cl", provider: "claude", view: "view-claude", tab: "claude" });
  window.GCClaude = { init: claude.init, refresh: claude.refresh, SYSTEM, PLAN_SCHEMA, toJpeg, createPlanner };
})();
