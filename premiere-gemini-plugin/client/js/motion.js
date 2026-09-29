/*
 * GeminiCut - motion yordamchilari.
 *  - Easing (silliq harakat): keyframe'lar orasiga oraliq nuqtalar qo'shiladi,
 *    shuning uchun Premiere'da chiziqli interpolatsiya ham silliq ko'rinadi.
 *  - Tezkor presetlar: Zoom In/Out, Punch, Ken Burns, Silkinish, Fade In/Out, Qiyshayish
 *  - Claude rejasini host gc_applyMotion formatiga o'tkazish
 * Host formati: {track, start, prop, mode: "rel"|"abs", keys: [[timelineSoniya, qiymat], ...]}
 */
(function (root) {
  "use strict";

  const EASE = {
    linear: (x) => x,
    ease_in: (x) => x * x * x,
    ease_out: (x) => 1 - Math.pow(1 - x, 3),
    ease_in_out: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    overshoot: (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
  };

  const lerp = (a, b, f) => (Array.isArray(a) ? [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] : a + (b - a) * f);
  const round = (v) => (Array.isArray(v) ? v.map((x) => Math.round(x * 10000) / 10000) : Math.round(v * 1000) / 1000);

  /*
   * points: [[t, v], ...] (t - timeline soniya). Har segmentga easing bo'yicha
   * oraliq nuqtalar qo'shadi (har ~1/12 s, segmentga 3..16 ta).
   */
  function sample(points, easing) {
    const e = EASE[easing] || EASE.ease_in_out;
    if (easing === "linear" || points.length < 2) return points.map(([t, v]) => [t, round(v)]);
    const out = [[points[0][0], round(points[0][1])]];
    for (let i = 1; i < points.length; i++) {
      const [t0, v0] = points[i - 1], [t1, v1] = points[i];
      const dt = t1 - t0;
      const same = JSON.stringify(v0) === JSON.stringify(v1);
      const n = same || dt <= 0 ? 1 : Math.max(3, Math.min(16, Math.round(dt * 12)));
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        out.push([t0 + dt * f, round(lerp(v0, v1, e(f)))]);
      }
    }
    return out;
  }

  /* ---------------- tezkor presetlar ---------------- */

  function clamp(t, clip) { return Math.max(clip.start, Math.min(clip.end - 1 / 30, t)); }

  /* at - playhead (klip ichida bo'lsa ishlatiladi), aks holda klip boshi */
  const PRESETS = {
    zoom_in: { label: "Zoom In", build: (c, o) => [op(c, "scale", "rel", sample([[c.start, 100], [c.end, o.strength]], "ease_in_out"))] },
    zoom_out: { label: "Zoom Out", build: (c, o) => [op(c, "scale", "rel", sample([[c.start, o.strength], [c.end, 100]], "ease_in_out"))] },
    punch: {
      label: "Punch-in", build: (c, o) => {
        const t = o.at;
        const pts = [[t, 100], [clamp(t + 0.12, c), o.strength + 5], [clamp(t + 0.2, c), o.strength], [clamp(t + 1.1, c), o.strength], [clamp(t + 1.4, c), 100]];
        return [op(c, "scale", "rel", sample(pts, "ease_out"))];
      },
    },
    ken_burns: {
      label: "Ken Burns", build: (c, o) => [
        op(c, "scale", "rel", sample([[c.start, 104], [c.end, o.strength + 3]], "linear")),
        op(c, "position", "rel", sample([[c.start, [-0.015, 0.005]], [c.end, [0.015, -0.01]]], "linear")),
      ],
    },
    shake: {
      label: "Silkinish", build: (c, o) => {
        const pts = [], rot = [];
        const amp = (o.strength - 100) / 1000 + 0.004;
        const end = clamp(o.at + 0.45, c);
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
        for (let t = o.at, k = 0; t <= end + 1e-6; t += 1 / 24, k++) {
          const d = 1 - (t - o.at) / (end - o.at + 1e-6);
          pts.push([t, [rnd() * amp * 2 * d, rnd() * amp * 2 * d]]);
          rot.push([t, rnd() * 2.5 * d]);
        }
        pts.push([clamp(end + 1 / 24, c), [0, 0]]);
        rot.push([clamp(end + 1 / 24, c), 0]);
        return [op(c, "position", "rel", pts.map(([t, v]) => [t, round(v)])), op(c, "rotation", "rel", rot.map(([t, v]) => [t, round(v)])),
          op(c, "scale", "rel", sample([[o.at, 100], [o.at + 0.05, 104], [end, 104], [clamp(end + 0.2, c), 100]], "ease_out"))];
      },
    },
    fade_in: { label: "Fade In", build: (c) => [op(c, "opacity", "abs", sample([[c.start, 0], [Math.min(c.end, c.start + 0.5), 100]], "ease_out"))] },
    fade_out: { label: "Fade Out", build: (c) => [op(c, "opacity", "abs", sample([[Math.max(c.start, c.end - 0.5), 100], [c.end - 1 / 30, 0]], "ease_in"))] },
    tilt: {
      label: "Qiyshayish", build: (c, o) => [op(c, "rotation", "rel", sample([[o.at, 0], [clamp(o.at + 0.35, c), -3], [clamp(o.at + 1.2, c), -3], [clamp(o.at + 1.5, c), 0]], "ease_in_out")),
        op(c, "scale", "rel", sample([[o.at, 100], [clamp(o.at + 0.35, c), 108], [clamp(o.at + 1.2, c), 108], [clamp(o.at + 1.5, c), 100]], "ease_in_out"))],
    },
  };

  function op(clip, prop, mode, keys) {
    return { track: clip.track, start: clip.start, prop, mode, keys };
  }

  /* ctx - gc_getEditContext natijasi. strength - masshtab foizi (108..130) */
  function buildPreset(name, ctx, strength) {
    const p = PRESETS[name];
    if (!p) throw new Error("Noma'lum preset: " + name);
    if (!ctx.clips.length) throw new Error("Timeline'da klipni tanlang yoki playhead'ni klip ustiga qo'ying.");
    const ops = [];
    for (const c of ctx.clips) {
      const at = ctx.playhead >= c.start && ctx.playhead < c.end - 0.2 ? ctx.playhead : c.start;
      ops.push(...p.build(c, { at, strength: strength || 115 }));
    }
    return ops;
  }

  /* ---------------- Claude rejasi -> host ---------------- */

  const LIMITS = { scale: [10, 400], rotation: [-720, 720], opacity: [0, 100] };

  function planToOps(plan, ctx) {
    const ops = [], problems = [];
    (plan.motions || []).forEach((m, i) => {
      const clip = ctx.clips[m.clip];
      if (!clip) { problems.push(`#${i + 1}: klip ${m.clip} yo'q`); return; }
      const dur = clip.end - clip.start;
      const pts = (m.keyframes || [])
        .map((k) => {
          const t = clip.start + Math.max(0, Math.min(dur - 1 / 30, Number(k.time) || 0));
          let v;
          if (m.property === "position") v = [Number(k.x) || 0, Number(k.y) || 0];
          else {
            v = Number(k.value);
            const lim = LIMITS[m.property];
            if (!isFinite(v)) return null;
            if (lim && !(m.property === "rotation" || m.mode === "relative" && m.property === "scale")) v = Math.max(lim[0], Math.min(lim[1], v));
          }
          return [t, v];
        })
        .filter(Boolean)
        .sort((a, b) => a[0] - b[0]);
      if (!pts.length) { problems.push(`#${i + 1}: keyframe yo'q`); return; }
      const mode = m.mode === "absolute" ? "abs" : "rel";
      // Position absolyut qiymatlari kadr ulushida (0..1)
      ops.push({ track: clip.track, start: clip.start, prop: m.property, mode, keys: sample(pts, m.easing), label: m.reason || "" });
    });
    return { ops, problems };
  }

  root.GCMotion = { EASE, sample, PRESETS, buildPreset, planToOps };
  if (typeof module === "object" && module && module.exports) module.exports = root.GCMotion;
})(typeof window !== "undefined" ? window : globalThis);
