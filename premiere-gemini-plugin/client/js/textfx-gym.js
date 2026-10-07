/*
 * GeminiCut - "Gym" shablonlari: sport va fitnes videolari uchun kuchli, tez animatsion matnlar.
 * Zarba (slam), qiyshiq qizil banner, sanagich, taymer, tezlik chiziqlari, yurak urishi,
 * energiya to'lishi, strob, trener lower third, motivatsiya, set/progress.
 * Hammasi Canvas 2D; standart rang - qizil/oq/qora (FitCity uslubi), o'zgartirsa bo'ladi.
 */
(function (root) {
  "use strict";

  const X = root.GCTextFX;
  const { E, clamp, mix, fontCss, glyph } = X.util;
  const TAU = Math.PI * 2;

  const hash = (i, k) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };
  function rgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "")); const v = m ? parseInt(m[1], 16) : 0xffffff; return [v >> 16 & 255, v >> 8 & 255, v & 255]; }
  const rgba = (h, a) => { const c = rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`; };

  /* Qiyshiq to'rtburchak (parallelogramm) - FitCity banner shakli */
  function slant(ctx, x, y, w, h, k) {
    const s = h * (k == null ? 0.42 : k);
    ctx.beginPath();
    ctx.moveTo(x + s, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w - s, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  }

  /* Butun matn qatorlari, ixtiyoriy siljish/qiyshayish bilan */
  function rows(ctx, L, R, o) {
    L.rows.forEach((row, i) => glyph(ctx, row.text, row.x, row.y, row.w, R, L, Object.assign({ scale: 1, alpha: 1 }, typeof o === "function" ? o(row, i) : o)));
  }

  /* Matn kursiv (sport) ko'rinishi uchun skew */
  function skewed(ctx, cx, cy, k, fn) { ctx.save(); ctx.translate(cx, cy); ctx.transform(1, 0, -k, 1, 0, 0); ctx.translate(-cx, -cy); fn(); ctx.restore(); }

  const D = {};

  /* 1. Zarba: matn yuqoridan katta bo'lib tushadi, kadr silkinadi, chang chiziqlari */
  D.gym_slam = function (ctx, L, R, P, W, H) {
    const k = P.inP(0, P.inD * 0.55), hit = P.inD * 0.55;
    const after = Math.max(0, P.t - hit);
    const shake = after < 0.45 ? Math.sin(after * 70) * Math.exp(-after * 9) * L.size * 0.16 : 0;
    const o = E.inCubic(P.out);
    const s = mix(2.6, 1, E.inCubic(k)) * (1 - o * 0.2);
    skewed(ctx, L.cx, L.cy, 0.12, () => {
      ctx.save(); ctx.translate(shake, shake * 0.6);
      rows(ctx, L, R, { scale: s, alpha: Math.min(1, k * 3) * (1 - o), blur: (1 - k) * L.size * 0.08 });
      ctx.restore();
    });
    if (after > 0 && after < 0.6) {
      const a = 1 - after / 0.6;
      ctx.save(); ctx.strokeStyle = rgba(R.accent, 0.9 * a); ctx.lineWidth = Math.max(2, L.size * 0.06); ctx.lineCap = "round";
      for (let i = 0; i < 14; i++) {
        const ang = (i / 14) * TAU + hash(i, 1) * 0.3;
        const r0 = Math.max(L.blockW, L.blockH) * 0.55 + after * L.size * 6, r1 = r0 + L.size * (0.6 + hash(i, 2));
        ctx.beginPath(); ctx.moveTo(L.cx + Math.cos(ang) * r0, L.cy + Math.sin(ang) * r0 * 0.55); ctx.lineTo(L.cx + Math.cos(ang) * r1, L.cy + Math.sin(ang) * r1 * 0.55); ctx.stroke();
      }
      ctx.restore();
    }
  };

  /* 2. Qiyshiq qizil banner (FitCity uslubi): banner chapdan uchib kiradi, harflar oraliq bilan */
  D.gym_banner = function (ctx, L, R, P, W) {
    const padX = L.size * 1.1 * (R.padX || 1), padY = L.size * 0.38 * (R.padY || 1);
    const w = L.blockW + padX * 2, h = L.blockH + padY * 2;
    const x = L.cx - w / 2, y = L.cy - h / 2;
    const k = E.outExpo(P.inP(0, P.inD * 0.8)), o = E.inCubic(P.out);
    const dx = (1 - k) * -(W * 0.6) + o * W * 0.6;
    ctx.save(); ctx.translate(dx, 0);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = L.size * 0.5; ctx.shadowOffsetY = L.size * 0.12;
    slant(ctx, x, y, w, h); ctx.fillStyle = R.accent; ctx.fill(); ctx.restore();
    // kichik bloklar (logo uslubidagi aksent)
    const bh = h * 0.42, bw = h * 0.9;
    ctx.fillStyle = R.accent;
    slant(ctx, x - bw * 1.25, y, bw, bh, 0.6); ctx.fill();
    slant(ctx, x - bw * 1.6, y + h - bh, bw * 0.6, bh, 0.6); ctx.fill();
    ctx.restore();
    const tk = E.outCubic(P.inP(P.inD * 0.35, P.inD * 0.6));
    ctx.save(); slant(ctx, x + dx, y, w, h); ctx.clip();
    rows(ctx, L, Object.assign({}, R, { shadow: 0 }), { alpha: tk * (1 - o), dx: dx + (1 - tk) * L.size * 1.2 });
    ctx.restore();
  };

  /* 3. Ustma-ust so'zlar: qatorlar navbat bilan to'la / kontur, yon tomondan kiradi */
  D.gym_stack = function (ctx, L, R, P, W) {
    const o = E.inCubic(P.out);
    L.rows.forEach((row, i) => {
      const k = E.outExpo(P.inP(i * P.inD * 0.25, P.inD * 0.7));
      const dir = i % 2 ? 1 : -1;
      const dx = dir * (1 - k) * W * 0.7 - dir * o * W * 0.7;
      skewed(ctx, row.x + row.w / 2, row.y, 0.14, () => {
        if (i % 2) {
          ctx.save(); ctx.font = L.font; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
          ctx.lineWidth = Math.max(2, L.size * 0.05); ctx.strokeStyle = R.accent; ctx.globalAlpha *= k > 0 ? 1 : 0;
          ctx.strokeText(row.text, row.x + dx, row.y);
          ctx.restore();
        } else {
          glyph(ctx, row.text, row.x, row.y, row.w, R, L, { scale: 1, alpha: k > 0 ? 1 : 0, dx });
        }
      });
    });
  };

  /* 4. Sanagich: matndagi raqamlar 0 dan qiymatigacha sanaladi (100 KG, 12 REP, 5000 KKAL) */
  D.gym_counter = function (ctx, L, R, P) {
    const k = E.outCubic(P.inP(0, Math.max(P.inD * 1.8, Math.min(2.2, P.D * 0.6))));
    const o = E.inCubic(P.out);
    const done = k >= 1, pulse = done ? 1 + 0.06 * Math.exp(-(P.t - P.inD * 1.8) * 6) : 1;
    L.rows.forEach((row) => {
      const txt = row.text.replace(/\d+(?:[.,]\d+)?/g, (m) => {
        const dec = (m.split(/[.,]/)[1] || "").length;
        const v = parseFloat(m.replace(",", ".")) * k;
        return dec ? v.toFixed(dec).replace(".", m.includes(",") ? "," : ".") : String(Math.round(v));
      });
      ctx.save(); ctx.font = L.font; const w = ctx.measureText(txt).width; ctx.restore();
      glyph(ctx, txt, L.cx - w / 2, row.y, w, Object.assign({}, R, { glow: done ? Math.max(R.glow, 0.5) : R.glow, color2: R.accent }), L,
        { scale: (0.85 + 0.15 * E.outBack(Math.min(1, P.t / 0.35))) * pulse, alpha: Math.min(1, P.t * 4) * (1 - o) });
    });
  };

  /* 5. Taymer: "30" yoki "1:30" dan nolgacha haqiqiy soniyalarda, atrofida halqa */
  D.gym_timer = function (ctx, L, R, P) {
    const src = String(R.text || "30").split(/\r?\n/)[0].trim();
    const m = /^(\d+):(\d{1,2})$/.exec(src);
    const total = m ? Number(m[1]) * 60 + Number(m[2]) : Math.max(0, parseFloat(src) || 30);
    const left = Math.max(0, total - P.t * (R.speed || 1));
    const mm = Math.floor(Math.ceil(left) / 60), ss = Math.ceil(left) % 60;
    const txt = m || total >= 60 ? `${mm}:${String(ss).padStart(2, "0")}` : String(Math.ceil(left));
    const k = E.outBack(P.inP(0, P.inD * 0.6)), o = E.inCubic(P.out);
    const r = Math.max(L.size * 1.4, L.blockW * 0.7);
    ctx.save(); ctx.globalAlpha *= Math.min(1, k * 2) * (1 - o);
    ctx.translate(L.cx, L.cy); ctx.scale(k, k);
    ctx.lineCap = "round";
    ctx.lineWidth = L.size * 0.16; ctx.strokeStyle = rgba(R.color2, 0.55);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = R.accent; ctx.shadowColor = R.accent; ctx.shadowBlur = L.size * 0.3;
    ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + TAU * (total ? left / total : 0)); ctx.stroke();
    ctx.shadowBlur = 0;
    const beat = left > 0 && left <= 3 ? 1 + 0.12 * Math.max(0, 1 - ((total - left) % 1) * 4) : 1;
    ctx.scale(beat, beat);
    ctx.font = L.font; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.fillStyle = left <= 3 ? R.accent : R.color; ctx.fillText(txt, 0, 0);
    ctx.restore();
  };

  /* 6. Tezlik chiziqlari: matn o'ngdan tez uchib kiradi, orqasida chiziqlar */
  D.gym_speed = function (ctx, L, R, P, W) {
    const k = E.outExpo(P.inP(0, P.inD * 0.7)), o = E.inCubic(P.out);
    const dx = (1 - k) * W * 0.8 - o * W * 0.8;
    const speed = Math.max(1 - k, o);
    ctx.save(); ctx.strokeStyle = rgba(R.accent, 0.85); ctx.lineCap = "round";
    for (let i = 0; i < 12; i++) {
      const y = L.cy + (hash(i, 1) - 0.5) * L.blockH * 1.5;
      const len = L.size * (2 + hash(i, 2) * 5) * (0.25 + speed * 1.5);
      const x0 = L.left + L.blockW * hash(i, 3) + dx - ((P.t * 9 + hash(i, 4)) % 1) * L.size * 2;
      ctx.globalAlpha = 0.25 + 0.6 * Math.max(speed, 0.15) * hash(i, 5);
      ctx.lineWidth = Math.max(1.5, L.size * (0.02 + 0.04 * hash(i, 6)));
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + len, y); ctx.stroke();
    }
    ctx.restore();
    skewed(ctx, L.cx, L.cy, 0.18, () => {
      for (let g = 3; g >= 1; g--) if (speed > 0.05) rows(ctx, L, Object.assign({}, R, { shadow: 0 }), { alpha: 0.18 * speed * (4 - g), dx: dx + g * L.size * 0.5 * speed });
      rows(ctx, L, R, { alpha: k > 0 ? 1 - o : 0, dx });
    });
  };

  /* 7. Yurak urishi: matn puls bilan, ostida EKG chizig'i */
  D.gym_pulse = function (ctx, L, R, P) {
    const o = E.inCubic(P.out), k = E.outCubic(P.inP(0, P.inD));
    const bpm = 120 * (R.speed || 1), ph = (P.t * bpm / 60) % 1;
    const beat = 1 + 0.08 * Math.exp(-ph * 9) + 0.04 * Math.exp(-Math.max(0, ph - 0.18) * 12) * (ph > 0.18 ? 1 : 0);
    ctx.save(); ctx.translate(L.cx, L.cy); ctx.scale(beat, beat); ctx.translate(-L.cx, -L.cy);
    rows(ctx, L, R, { alpha: k * (1 - o) });
    ctx.restore();
    const y = L.cy + L.blockH / 2 + L.size * 0.6, w = Math.max(L.blockW * 1.2, L.size * 5), x0 = L.cx - w / 2;
    const head = clamp(P.t / Math.max(0.5, P.D - P.outD), 0, 1) * w;
    ctx.save(); ctx.globalAlpha *= 1 - o; ctx.strokeStyle = R.accent; ctx.lineWidth = Math.max(2, L.size * 0.06); ctx.lineJoin = "round";
    ctx.shadowColor = R.accent; ctx.shadowBlur = L.size * 0.3;
    ctx.beginPath();
    for (let x = 0; x <= head; x += 2) {
      const u = (x / (L.size * 3)) % 1;
      const v = u < 0.35 ? 0 : u < 0.4 ? -0.2 : u < 0.45 ? 1 : u < 0.5 ? -0.6 : u < 0.55 ? 0.15 : 0;
      const yy = y - v * L.size * 0.7;
      if (x === 0) ctx.moveTo(x0 + x, yy); else ctx.lineTo(x0 + x, yy);
    }
    ctx.stroke();
    ctx.restore();
  };

  /* 8. Energiya to'lishi: kontur matn pastdan rang bilan to'ladi (to'lqinli chegara) */
  D.gym_fill = function (ctx, L, R, P, W, H) {
    const o = E.inCubic(P.out), k = E.inOutCubic(P.inP(P.inD * 0.3, Math.max(1, P.D * 0.5)));
    const a = Math.min(1, P.t * 4) * (1 - o);
    ctx.save(); ctx.globalAlpha *= a; ctx.font = L.font; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, L.size * 0.045); ctx.strokeStyle = R.color;
    L.rows.forEach((row) => ctx.strokeText(row.text, row.x, row.y));
    const top = L.cy - L.blockH / 2 - L.size * 0.1, bot = L.cy + L.blockH / 2 + L.size * 0.1;
    const level = mix(bot, top, k);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, level + Math.sin(x / (L.size * 0.6) + P.t * 6) * L.size * 0.06 * (k < 1 ? 1 : 0));
    ctx.lineTo(W, H); ctx.closePath(); ctx.clip();
    ctx.fillStyle = R.accent;
    L.rows.forEach((row) => ctx.fillText(row.text, row.x, row.y));
    ctx.restore();
    if (k >= 1) {
      const f = Math.exp(-(P.t - (P.inD * 0.3 + Math.max(1, P.D * 0.5))) * 5);
      if (f > 0.02) { ctx.globalAlpha *= f; ctx.fillStyle = "#ffffff"; L.rows.forEach((row) => ctx.fillText(row.text, row.x, row.y)); }
    }
    ctx.restore();
  };

  /* 9. Strob: oq/qizil miltillash, RGB siljish va silkinish (BEAST MODE) */
  D.gym_strobe = function (ctx, L, R, P) {
    const f = Math.floor(P.t * 20), o = E.inCubic(P.out);
    const intense = P.t < P.inD * 1.5 || P.out > 0;
    const flash = intense ? f % 2 : 0;
    const j = intense ? L.size * 0.05 : 0;
    const dx = (hash(f, 1) - 0.5) * j * 2, dy = (hash(f, 2) - 0.5) * j * 2;
    const a = (P.out > 0 && hash(f, 3) < P.out ? 0 : 1);
    skewed(ctx, L.cx, L.cy, 0.12, () => {
      if (intense) {
        ctx.save(); ctx.globalCompositeOperation = "lighter";
        rows(ctx, L, Object.assign({}, R, { shadow: 0 }), { alpha: 0.7 * a, dx: dx - j * 2, dy, fill: "#ff1030" });
        rows(ctx, L, Object.assign({}, R, { shadow: 0 }), { alpha: 0.7 * a, dx: dx + j * 2, dy, fill: "#10c8ff" });
        ctx.restore();
      }
      rows(ctx, L, R, { alpha: a * (1 - o * 0.3), dx, dy, fill: flash ? R.accent : R.color, scale: intense ? 1 + hash(f, 4) * 0.04 : 1 });
    });
  };

  /* 10. Trener lower third: qizil va qora qiyshiq bloklar, ism + lavozim */
  D.gym_lower = function (ctx, L, R, P, W, H) {
    const row = L.rows[0];
    ctx.font = L.font;
    const nameW = ctx.measureText(row.text).width;
    const subSize = L.size * 0.55;
    ctx.save(); ctx.font = fontCss(Object.assign({}, R, { weight: 700 }), subSize); const subW = R.sub ? ctx.measureText(R.sub.toLocaleUpperCase()).width + subSize * 1.2 : 0; ctx.restore();
    const h1 = L.size * 1.35, h2 = subSize * 1.5;
    const x = row.x - L.size * 0.5, y = row.y - h1 / 2;
    const k1 = E.outExpo(P.inP(0, P.inD * 0.7)), k2 = E.outExpo(P.inP(P.inD * 0.25, P.inD * 0.7)), o = E.inCubic(P.out);
    const w1 = (nameW + L.size * 1.6) * k1 * (1 - o), w2 = (subW + subSize * 1.6) * k2 * (1 - o);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = L.size * 0.4;
    if (w1 > 2) { slant(ctx, x, y, w1, h1, 0.3); ctx.fillStyle = R.accent; ctx.fill(); }
    if (w2 > 2 && R.sub) { slant(ctx, x + h1 * 0.25, y + h1, w2, h2, 0.3); ctx.fillStyle = R.color2; ctx.fill(); }
    ctx.restore();
    ctx.save(); slant(ctx, x, y, w1, h1, 0.3); ctx.clip();
    glyph(ctx, row.text, row.x, row.y, nameW, Object.assign({}, R, { shadow: 0 }), L, { scale: 1, alpha: 1, dx: (1 - k1) * -nameW * 0.4 });
    ctx.restore();
    if (R.sub && w2 > 2) {
      ctx.save(); slant(ctx, x + h1 * 0.25, y + h1, w2, h2, 0.3); ctx.clip();
      ctx.font = fontCss(Object.assign({}, R, { weight: 700 }), subSize); ctx.textBaseline = "middle"; ctx.fillStyle = R.color;
      let cx = x + h1 * 0.25 + subSize * 1.0;
      for (const ch of R.sub.toLocaleUpperCase()) { ctx.fillText(ch, cx, y + h1 + h2 / 2); cx += ctx.measureText(ch).width + subSize * 0.12; }
      ctx.restore();
    }
  };

  /* 11. Motivatsiya: birinchi qator kichik (oraliqli), qolgani katta zarba bilan */
  D.gym_motiv = function (ctx, L, R, P) {
    const o = E.inCubic(P.out);
    const first = L.rows[0], rest = L.rows.slice(1);
    const k1 = E.outCubic(P.inP(0, P.inD * 0.6));
    if (first) {
      const sz = L.size * 0.45;
      ctx.save(); ctx.globalAlpha *= k1 * (1 - o);
      ctx.font = fontCss(Object.assign({}, R, { weight: 700 }), sz); ctx.textBaseline = "middle"; ctx.fillStyle = R.accent;
      const sp = sz * (0.25 + (1 - k1) * 0.6);
      let w = 0; for (const ch of first.text) w += ctx.measureText(ch).width + sp; w -= sp;
      let cx = L.cx - w / 2; const y = rest.length ? L.cy - L.blockH / 2 + sz * 0.6 : L.cy;
      for (const ch of first.text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + sp; }
      ctx.restore();
    }
    rest.forEach((row, i) => {
      const k = P.inP(P.inD * (0.35 + i * 0.2), P.inD * 0.45);
      const beat = 1 + 0.05 * Math.exp(-((P.t * 2) % 1) * 8) * (k >= 1 ? 1 : 0);
      skewed(ctx, row.x + row.w / 2, row.y, 0.1, () => glyph(ctx, row.text, row.x, row.y + L.size * 0.15, row.w, R, L, { scale: mix(1.8, 1, E.outBack(k)) * beat, alpha: Math.min(1, k * 3) * (1 - o) }));
    });
  };

  /* 12. Set / progress: "SET 3/5" - segmentli progress chizig'i to'ladi */
  D.gym_set = function (ctx, L, R, P) {
    const src = L.rows[0] ? L.rows[0].text : "";
    const m = /(\d+)\s*\/\s*(\d+)/.exec(src);
    const cur = m ? Number(m[1]) : 3, tot = m ? Math.max(1, Math.min(20, Number(m[2]))) : 5;
    const o = E.inCubic(P.out), k = E.outCubic(P.inP(0, P.inD));
    rows(ctx, L, R, { alpha: k * (1 - o), dy: (1 - k) * L.size * 0.3 });
    const w = Math.max(L.blockW, L.size * 4), segW = (w - (tot - 1) * L.size * 0.15) / tot, h = L.size * 0.28;
    const x0 = L.cx - w / 2, y = L.cy + L.blockH / 2 + L.size * 0.35;
    for (let i = 0; i < tot; i++) {
      const sk = E.outBack(P.inP(P.inD * 0.4 + i * 0.12, 0.3));
      const filled = i < cur && P.t > P.inD * 0.6 + i * 0.18;
      ctx.save(); ctx.globalAlpha *= sk > 0 ? Math.min(1, sk) * (1 - o) : 0;
      slant(ctx, x0 + i * (segW + L.size * 0.15), y, segW, h * Math.min(1, sk), 0.5);
      ctx.fillStyle = filled ? R.accent : rgba(R.color, 0.25); ctx.fill();
      ctx.restore();
    }
  };

  const GYM = { font: "Impact", weight: 400, italic: false, upper: true, size: 0.085, color: "#ffffff", color2: "#111111", accent: "#e8001c", shadow: 0.55, stroke: 0, glow: 0, spacing: 0.02 };
  const T = (id, name, desc, set, extra) => Object.assign({ id, kind: "gym", name, desc, set: Object.assign({}, GYM, set || {}) }, extra || {});

  X.register([
    T("gym_slam", "Zarba (Slam)", "Matn yuqoridan tushib uriladi, kadr silkinadi", { text: "NO EXCUSES" }),
    T("gym_banner", "Qizil banner", "Qiyshiq qizil banner chapdan uchib kiradi (FitCity uslubi)", { text: "CHIMGAN", font: "Bahnschrift", weight: 700, spacing: 0.35, size: 0.06, shadow: 0 }),
    T("gym_stack", "Ustma-ust so'zlar", "Qatorlar navbat bilan: to'la va kontur", { text: "NO PAIN\nNO GAIN", size: 0.11 }, { manyLines: true }),
    T("gym_counter", "Sanagich", "Raqamlar 0 dan sanaladi: 100 KG, 12 REP, 5000 KKAL", { text: "100 KG", size: 0.13 }),
    T("gym_timer", "Taymer", "Haqiqiy vaqt bilan orqaga sanash (30 yoki 1:30) - davomiylikni shunga moslang", { text: "10", size: 0.12, duration: 11, upper: false }),
    T("gym_speed", "Tezlik chiziqlari", "Tez uchib kiradi, orqasida tezlik chiziqlari", { text: "FULL POWER" }),
    T("gym_pulse", "Yurak urishi", "Matn puls bilan, ostida EKG chizig'i", { text: "CARDIO", size: 0.1 }),
    T("gym_fill", "Energiya to'lishi", "Kontur matn pastdan rang bilan to'ladi", { text: "ENERGY", size: 0.12, duration: 3.5 }),
    T("gym_strobe", "Strob (Beast mode)", "Miltillash, RGB siljish, kuchli silkinish", { text: "BEAST MODE" }),
    T("gym_lower", "Trener lower third", "Ism + lavozim, qizil va qora qiyshiq bloklar", { text: "Aziz Karimov", sub: "Shaxsiy trener", upper: false, font: "Bahnschrift", weight: 700, size: 0.05, x: 0.1, y: 0.8, align: "left", shadow: 0 }, { sub: true, oneLine: true }),
    T("gym_motiv", "Motivatsiya", "Kichik sarlavha + katta zarbali so'z", { text: "BUGUN\nBOSHLA!", size: 0.12 }, { manyLines: true }),
    T("gym_set", "Set / progress", "SET 3/5 - segmentlar to'ladi", { text: "SET 3/5", size: 0.08 }),
  ], D);
})(typeof window !== "undefined" ? window : globalThis);
