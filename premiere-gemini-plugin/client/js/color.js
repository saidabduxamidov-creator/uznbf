/*
 * GeminiCut - rang berish (color grading) yadrosi.
 *
 * Ish tartibi (professional kolorist kabi):
 *   1) Balans  - har bir klip kadri tahlil qilinadi (gistogramma, kulrang dunyo):
 *                oq balansi, ekspozitsiya, qora/oq nuqtalar avtomatik to'g'rilanadi.
 *   2) Ko'rinish (look) - tayyor uslub yoki ChatGPT tanlagan parametrlar:
 *                kontrast, lift/gamma/gain, split toning, to'yinganlik, fade, rolloff.
 *   3) Har bir klip uchun 33x33x33 .cube LUT yasaladi; Resolve uni klipning 1-node'iga qo'yadi.
 * Hammasi shu yerda, AI faqat parametrlarni tanlaydi ("miya"), piksellarni plagin hisoblaydi.
 */
(function (root) {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lin = (v) => Math.pow(v > 0 ? v : 0, 2.2);
  const enc = (v) => Math.pow(v > 0 ? v : 0, 1 / 2.2);
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mix = (a, b, k) => a + (b - a) * k;

  /* Neytral (hech narsa o'zgarmaydigan) parametrlar */
  const NEUTRAL = {
    balance: [1, 1, 1], black: 0, white: 1,
    exposure: 0, temperature: 0, tint: 0,
    contrast: 0, pivot: 0.43,
    lift: [0, 0, 0], gamma: [0, 0, 0], gain: [0, 0, 0],
    saturation: 1, vibrance: 0,
    shadowHue: 200, shadowAmt: 0, highHue: 35, highAmt: 0,
    fade: 0, rolloff: 0, mono: 0, intensity: 1,
  };

  /* Tayyor ko'rinishlar (look). Qiymatlar NEUTRAL ustiga qo'yiladi. */
  const PRESETS = {
    natural: { name: "Tabiiy", desc: "Faqat balans: toza oq rang, to'g'ri yorug'lik", look: { contrast: 0.08, vibrance: 0.1 } },
    cinema: { name: "Kino (Teal & Orange)", desc: "Soyalar moviy, teri iliq - Gollivud uslubi",
      look: { contrast: 0.22, saturation: 0.95, vibrance: 0.12, shadowHue: 195, shadowAmt: 0.55, highHue: 32, highAmt: 0.4, lift: [-0.01, 0.0, 0.015], rolloff: 0.35, fade: 0.015 } },
    warm: { name: "Iliq oltin", desc: "Quyosh botishi, iliq va yumshoq",
      look: { temperature: 0.28, tint: 0.04, contrast: 0.12, saturation: 1.08, highHue: 40, highAmt: 0.35, shadowHue: 20, shadowAmt: 0.12, rolloff: 0.3 } },
    cool: { name: "Sovuq ko'k", desc: "Toza, zamonaviy, texnologik",
      look: { temperature: -0.3, contrast: 0.16, saturation: 0.92, shadowHue: 215, shadowAmt: 0.35, highHue: 190, highAmt: 0.12, rolloff: 0.2 } },
    film: { name: "Film (Kodak)", desc: "Ko'tarilgan qoralar, yumshoq kontrast, iliq yorug'lik",
      look: { contrast: 0.1, fade: 0.05, saturation: 0.9, temperature: 0.08, shadowHue: 190, shadowAmt: 0.16, highHue: 40, highAmt: 0.25, rolloff: 0.55, gamma: [0.0, 0.01, -0.01] } },
    moody: { name: "Moody", desc: "Qorong'i, dramatik, past to'yinganlik",
      look: { exposure: -0.25, contrast: 0.3, saturation: 0.75, shadowHue: 205, shadowAmt: 0.4, highHue: 35, highAmt: 0.15, fade: 0.02, rolloff: 0.45, lift: [-0.015, -0.01, 0] } },
    vivid: { name: "Yorqin Reels", desc: "Jonli ranglar, aniq kontrast - ijtimoiy tarmoqlar uchun",
      look: { contrast: 0.2, saturation: 1.15, vibrance: 0.35, exposure: 0.08, rolloff: 0.25 } },
    vintage: { name: "Vintage", desc: "Eski plyonka: sarg'ish, xira, yumshoq",
      look: { contrast: -0.05, fade: 0.08, saturation: 0.72, temperature: 0.18, tint: -0.05, shadowHue: 185, shadowAmt: 0.14, highHue: 45, highAmt: 0.38, rolloff: 0.5 } },
    noir: { name: "Qora-oq", desc: "Klassik monoxrom, chuqur kontrast",
      look: { mono: 1, contrast: 0.28, rolloff: 0.35, fade: 0.01 } },
    neon: { name: "Neon tun", desc: "Kechki shahar: magenta va ko'k",
      look: { contrast: 0.25, saturation: 1.12, tint: 0.12, temperature: -0.12, shadowHue: 250, shadowAmt: 0.5, highHue: 320, highAmt: 0.35, vibrance: 0.2 } },
  };

  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const vec = (v, lo, hi) => [0, 1, 2].map((i) => clamp(num(Array.isArray(v) ? v[i] : 0, 0), lo, hi));

  /* Har qanday manbadan (preset, AI, slayder) kelgan qiymatlarni xavfsiz chegaraga keltiradi */
  function sanitize(p) {
    const s = Object.assign({}, NEUTRAL, p || {});
    return {
      balance: [0, 1, 2].map((i) => clamp(num(s.balance[i], 1), 0.6, 1.6)),
      black: clamp(num(s.black, 0), 0, 0.15), white: clamp(num(s.white, 1), 0.7, 1),
      exposure: clamp(num(s.exposure, 0), -2.5, 2.5),
      temperature: clamp(num(s.temperature, 0), -1, 1), tint: clamp(num(s.tint, 0), -1, 1),
      contrast: clamp(num(s.contrast, 0), -0.6, 0.8), pivot: clamp(num(s.pivot, 0.43), 0.2, 0.7),
      lift: vec(s.lift, -0.15, 0.15), gamma: vec(s.gamma, -0.4, 0.4), gain: vec(s.gain, -0.4, 0.4),
      saturation: clamp(num(s.saturation, 1), 0, 2), vibrance: clamp(num(s.vibrance, 0), -1, 1),
      shadowHue: ((num(s.shadowHue, 200) % 360) + 360) % 360, shadowAmt: clamp(num(s.shadowAmt, 0), 0, 1),
      highHue: ((num(s.highHue, 35) % 360) + 360) % 360, highAmt: clamp(num(s.highAmt, 0), 0, 1),
      fade: clamp(num(s.fade, 0), 0, 0.2), rolloff: clamp(num(s.rolloff, 0), 0, 1), mono: clamp(num(s.mono, 0), 0, 1),
      intensity: clamp(num(s.intensity, 1), 0, 1.5),
    };
  }

  /* Hue (gradus) -> to'yingan rang vektori, yorqinligi 0 ga keltirilgan (faqat "rang" yo'nalishi) */
  function hueVector(h) {
    const f = (n) => { const k = (n + h / 30) % 12; return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    const c = [f(0), f(8), f(4)];
    const l = luma(c[0], c[1], c[2]);
    return [c[0] - l, c[1] - l, c[2] - l];
  }

  /* Parametrlardan rang funksiyasi: (r,g,b 0..1) -> [r,g,b] */
  function gradeFn(params) {
    const p = sanitize(params);
    // oq balansi + harorat/tint - yorqinlikni saqlagan holda (chiziqli fazoda)
    const tt = [1 + 0.22 * p.temperature, 1 - 0.15 * p.tint, 1 - 0.22 * p.temperature];
    tt[0] *= 1 + 0.06 * p.tint; tt[2] *= 1 + 0.06 * p.tint;
    const g0 = [p.balance[0] * tt[0], p.balance[1] * tt[1], p.balance[2] * tt[2]];
    const norm = luma(g0[0], g0[1], g0[2]);
    const ex = Math.pow(2, p.exposure);
    const gains = g0.map((g) => (g / norm) * ex);
    const range = Math.max(0.05, p.white - p.black);
    const a = 1 + p.contrast * 0.9, pv = p.pivot;
    const knee = 1 - 0.45 * p.rolloff;
    const sv = hueVector(p.shadowHue), hv = hueVector(p.highHue);
    const lgg = [0, 1, 2].map((i) => ({ lift: p.lift[i], gain: 1 + p.gain[i], gamma: 1 / (1 + p.gamma[i]) }));

    return function (r, g, b) {
      const v = [r, g, b];
      for (let i = 0; i < 3; i++) {
        let x = (v[i] - p.black) / range;                      // qora/oq nuqtalar
        x = enc(lin(x) * gains[i]);                            // balans, harorat, ekspozitsiya
        if (p.rolloff > 0 && x > knee) x = knee + (1 - knee) * Math.tanh((x - knee) / (1 - knee)); // yumshoq oqlar
        x = clamp(x, 0, 1);
        x = x < pv ? pv * Math.pow(x / pv, a) : 1 - (1 - pv) * Math.pow((1 - x) / (1 - pv), a); // S-kontrast
        const c = lgg[i];
        x = c.gain * (x + c.lift * (1 - x));                   // lift / gain
        x = Math.pow(clamp(x, 0, 1), c.gamma);                 // gamma
        v[i] = x;
      }
      let L = luma(v[0], v[1], v[2]);
      // to'yinganlik + vibrance (kam to'yingan ranglar ko'proq kuchayadi)
      const sat = Math.max(v[0], v[1], v[2]) - Math.min(v[0], v[1], v[2]);
      const k = p.saturation * (1 + p.vibrance * (1 - clamp(sat * 1.6, 0, 1)));
      for (let i = 0; i < 3; i++) v[i] = L + (v[i] - L) * k;
      // split toning: soyalarga va yorug'larga rang
      const ws = (1 - L) * (1 - L) * p.shadowAmt * 0.22, wh = L * L * p.highAmt * 0.22;
      for (let i = 0; i < 3; i++) v[i] += sv[i] * ws + hv[i] * wh;
      if (p.mono > 0) { L = luma(v[0], v[1], v[2]); for (let i = 0; i < 3; i++) v[i] = mix(v[i], L, p.mono); }
      for (let i = 0; i < 3; i++) {
        let x = p.fade + clamp(v[i], 0, 1) * (1 - p.fade);    // fade (ko'tarilgan qoralar)
        x = mix([r, g, b][i], x, p.intensity);                  // umumiy kuch
        v[i] = clamp(x, 0, 1);
      }
      return v;
    };
  }

  /* 3D LUT jadvali (Float32Array, qizil eng tez o'zgaradi - .cube tartibi) */
  function buildLut(params, size) {
    const n = size || 33, f = gradeFn(params), out = new Float32Array(n * n * n * 3);
    let o = 0;
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const v = f(r / (n - 1), g / (n - 1), b / (n - 1));
      out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2];
    }
    return out;
  }

  function buildCube(params, size, title) {
    const n = size || 33, lut = buildLut(params, n);
    const lines = [`TITLE "${String(title || "GeminiCut").replace(/"/g, "'")}"`, "# GeminiCut AI color", `LUT_3D_SIZE ${n}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
    for (let i = 0; i < lut.length; i += 3) lines.push(lut[i].toFixed(6) + " " + lut[i + 1].toFixed(6) + " " + lut[i + 2].toFixed(6));
    return lines.join("\n") + "\n";
  }

  /* RGBA piksellarga LUT'ni trilinear qo'llaydi (oldindan ko'rish uchun) */
  function applyLut(lut, n, src, dst) {
    const m = n - 1;
    for (let p = 0; p < src.length; p += 4) {
      const fr = (src[p] / 255) * m, fg = (src[p + 1] / 255) * m, fb = (src[p + 2] / 255) * m;
      const r0 = Math.min(fr | 0, m - 1), g0 = Math.min(fg | 0, m - 1), b0 = Math.min(fb | 0, m - 1);
      const dr = fr - r0, dg = fg - g0, db = fb - b0;
      for (let c = 0; c < 3; c++) {
        const at = (r, g, b) => lut[((b * n + g) * n + r) * 3 + c];
        const c00 = mix(at(r0, g0, b0), at(r0 + 1, g0, b0), dr), c10 = mix(at(r0, g0 + 1, b0), at(r0 + 1, g0 + 1, b0), dr);
        const c01 = mix(at(r0, g0, b0 + 1), at(r0 + 1, g0, b0 + 1), dr), c11 = mix(at(r0, g0 + 1, b0 + 1), at(r0 + 1, g0 + 1, b0 + 1), dr);
        dst[p + c] = Math.round(mix(mix(c00, c10, dg), mix(c01, c11, dg), db) * 255);
      }
      dst[p + 3] = src[p + 3];
    }
    return dst;
  }

  /* Kadr statistikasi: yorqinlik persentillari, kulrang-dunyo o'rtachasi, to'yinganlik */
  function analyze(data) {
    const hist = new Uint32Array(256);
    let n = 0, mr = 0, mg = 0, mb = 0, cnt = 0, sat = 0;
    const step = Math.max(1, Math.floor(data.length / 4 / 60000)) * 4;
    for (let p = 0; p < data.length; p += step) {
      const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
      const L = luma(r, g, b);
      hist[Math.min(255, Math.round(L * 255))]++; n++;
      sat += Math.max(r, g, b) - Math.min(r, g, b);
      if (L > 0.08 && L < 0.92) { mr += lin(r); mg += lin(g); mb += lin(b); cnt++; }
    }
    const pct = (q) => { let acc = 0; const t = q * n; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= t) return i / 255; } return 1; };
    return {
      p01: pct(0.01), p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
      meanLin: cnt ? [mr / cnt, mg / cnt, mb / cnt] : [0.18, 0.18, 0.18],
      saturation: n ? sat / n : 0,
    };
  }

  /* Statistikadan avtomatik balans (strength 0..1). Kulrang dunyo faqat qisman - quyosh botishi kabi sahnalar saqlansin. */
  function autoBalance(st, strength) {
    const s = clamp(num(strength, 0.7), 0, 1);
    if (!st || s === 0) return { balance: [1, 1, 1], black: 0, white: 1, exposure: 0 };
    const [r, g, b] = st.meanLin.map((x) => Math.max(1e-4, x));
    const m = (r + g + b) / 3;
    const balance = [m / r, m / g, m / b].map((k) => 1 + (clamp(k, 0.75, 1.33) - 1) * s * 0.8);
    const black = clamp((st.p01 - 0.015) * s, 0, 0.08);
    const white = st.p99 < 0.93 ? clamp(1 - (1 - Math.min(1, st.p99 + 0.03)) * s, 0.8, 1) : 1;
    const mid = clamp((st.p50 - black) / (white - black), 0.02, 1);
    const exposure = clamp(Math.log2(lin(0.42) / lin(mid)) * s * 0.75, -1.5, 1.5);
    return { balance, black, white, exposure };
  }

  /*
   * Yakuniy parametrlar: balans (avto) + look (preset/AI) + klipga AI tuzatishi + foydalanuvchi slayderlari.
   * adj: { exposure, contrast, saturation (ko'paytuvchi), temperature, tint, fade, intensity }
   */
  function combine(auto, look, clipAdj, adj) {
    const L = Object.assign({}, NEUTRAL, look || {}), A = auto || {}, C = clipAdj || {}, U = adj || {};
    return sanitize(Object.assign({}, L, {
      balance: A.balance || [1, 1, 1], black: num(A.black, 0), white: num(A.white, 1),
      exposure: num(L.exposure, 0) + num(A.exposure, 0) + num(C.exposure, 0) + num(U.exposure, 0),
      temperature: num(L.temperature, 0) + num(C.temperature, 0) + num(U.temperature, 0),
      tint: num(L.tint, 0) + num(C.tint, 0) + num(U.tint, 0),
      contrast: num(L.contrast, 0) + num(C.contrast, 0) + num(U.contrast, 0),
      saturation: num(L.saturation, 1) * num(C.saturation, 1) * num(U.saturation, 1),
      fade: num(L.fade, 0) + num(U.fade, 0),
      intensity: num(U.intensity, 1),
    }));
  }

  /* LUT ishlamasa zaxira: ASC CDL ga yaqinlashtirish (Resolve SetCDL) */
  function toCDL(params) {
    const p = sanitize(params);
    const ex = Math.pow(2, p.exposure / 2.2);
    const tt = [1 + 0.1 * p.temperature, 1 - 0.07 * p.tint, 1 - 0.1 * p.temperature];
    const slope = [0, 1, 2].map((i) => (1 + p.gain[i]) * ex * tt[i] * Math.pow(p.balance[i], 1 / 2.2) / (p.white - p.black));
    const offset = [0, 1, 2].map((i) => p.lift[i] * 0.5 + p.fade - p.black * slope[i]);
    const power = [0, 1, 2].map((i) => (1 / (1 + p.gamma[i])) * (1 + p.contrast * 0.35));
    const f = (a) => a.map((x) => x.toFixed(4)).join(" ");
    return { Slope: f(slope), Offset: f(offset), Power: f(power), Saturation: (p.saturation * (1 - p.mono)).toFixed(4) };
  }

  /* ChatGPT javobi sxemasi */
  const AI_SCHEMA = {
    type: "object",
    properties: {
      summary: { type: "string", description: "What the grade does, 1-2 short sentences in Uzbek (Latin)." },
      look: {
        type: "object",
        properties: {
          exposure: { type: "number", description: "Stops, -1..1. Global brightness of the look (per-clip balance is separate)." },
          temperature: { type: "number", description: "-1 (blue) .. 1 (warm/orange). Typical 0..0.3." },
          tint: { type: "number", description: "-1 (green) .. 1 (magenta). Usually within +-0.15." },
          contrast: { type: "number", description: "-0.5 .. 0.8. S-curve strength; 0.1-0.3 is common." },
          saturation: { type: "number", description: "0..2, 1 = unchanged." },
          vibrance: { type: "number", description: "-1..1, boosts muted colours, protects skin. 0..0.35 typical." },
          lift: { type: "array", items: { type: "number" }, description: "[r,g,b] shadow offset, each -0.05..0.05." },
          gamma: { type: "array", items: { type: "number" }, description: "[r,g,b] midtone, each -0.15..0.15." },
          gain: { type: "array", items: { type: "number" }, description: "[r,g,b] highlight gain, each -0.15..0.15." },
          shadow_hue: { type: "number", description: "Split-tone hue for shadows in degrees (teal ~190, blue ~215, green ~150)." },
          shadow_amount: { type: "number", description: "0..1" },
          highlight_hue: { type: "number", description: "Split-tone hue for highlights in degrees (orange ~32, gold ~45, pink ~330)." },
          highlight_amount: { type: "number", description: "0..1" },
          fade: { type: "number", description: "Lifted blacks 0..0.1 (film look)." },
          highlight_rolloff: { type: "number", description: "0..1 soft highlight compression." },
          monochrome: { type: "number", description: "0..1, 1 = black and white." },
        },
      },
      clips: {
        type: "array",
        description: "Per-clip matching corrections applied on top of automatic balance, so all shots look like one scene.",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            exposure: { type: "number", description: "Stops, -1..1" },
            temperature: { type: "number", description: "-0.5..0.5" },
            tint: { type: "number", description: "-0.3..0.3" },
            note: { type: "string", description: "Short note in Uzbek (Latin)." },
          },
        },
      },
    },
  };

  const AI_SYSTEM = `You are a senior film colorist grading footage in DaVinci Resolve.
For every clip you get one frame (after the plugin's automatic white-balance/exposure normalisation is NOT yet applied) and measured statistics: luminance percentiles p01/p50/p99 (0..1, display-referred) and the grey-world mean in linear light. The plugin will automatically balance each clip (neutral white balance, median brightness ~0.42, black/white points); you choose:
1) "look": one creative grade for the whole timeline that fulfils the user's request (e.g. cinematic teal & orange, warm golden hour, moody, clean commercial, vintage film, black & white).
2) "clips": small per-clip corrections so all shots match each other after balancing (skin tones consistent, same mood). Use 0 when no extra correction is needed.
Rules: protect skin tones (never green or grey faces), avoid clipping, keep it tasteful and broadcast-safe unless the user wants a stylised look. Typical professional ranges: contrast 0.1-0.3, saturation 0.85-1.15, split-tone amounts 0.2-0.55.
Write "summary" and notes in Uzbek (Latin script).`;

  /* AI javobini look/klip tuzatishlariga aylantiradi */
  function fromAI(r) {
    const l = (r && r.look) || {};
    const look = sanitize({
      exposure: l.exposure, temperature: l.temperature, tint: l.tint, contrast: l.contrast, saturation: l.saturation, vibrance: l.vibrance,
      lift: l.lift, gamma: l.gamma, gain: l.gain, shadowHue: l.shadow_hue, shadowAmt: l.shadow_amount, highHue: l.highlight_hue,
      highAmt: l.highlight_amount, fade: l.fade, rolloff: l.highlight_rolloff, mono: l.monochrome,
    });
    delete look.balance; delete look.black; delete look.white; delete look.intensity;
    const clips = {};
    ((r && r.clips) || []).forEach((c) => {
      clips[c.index] = { exposure: clamp(num(c.exposure, 0), -1, 1), temperature: clamp(num(c.temperature, 0), -0.5, 0.5), tint: clamp(num(c.tint, 0), -0.3, 0.3), note: c.note || "" };
    });
    return { summary: (r && r.summary) || "", look, clips };
  }

  root.GCColor = { NEUTRAL, PRESETS, sanitize, gradeFn, buildLut, buildCube, applyLut, analyze, autoBalance, combine, toCDL, AI_SCHEMA, AI_SYSTEM, fromAI };
})(typeof window !== "undefined" ? window : globalThis);
