/*
 * GeminiCut - qo'shimcha matn shablonlari:
 *   "plate"   - matn orqasiga avtomatik fon qo'yiladigan shablonlar (shaffof shisha, 3D chat pufagi,
 *               kapsula, lenta, 3D karta, neon ramka, stiker, chat xabarlari, obuna tugmasi, iqtibos...).
 *               "Matnsiz" rejimida faqat fonning o'zi (shaffof PNG) chiziladi.
 * Hammasi Canvas 2D bilan chiziladi; yorug'lik, qalinlik va soyalar bilan 3D ko'rinish beriladi.
 */
(function (root) {
  "use strict";

  const X = root.GCTextFX;
  const { E, clamp, mix, fontCss, paint, glyph } = X.util;
  const TAU = Math.PI * 2;

  /* ---------------- yordamchilar ---------------- */

  function rgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "")); const v = m ? parseInt(m[1], 16) : 0xffffff; return [v >> 16 & 255, v >> 8 & 255, v & 255]; }
  const rgba = (h, a) => { const c = rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`; };
  const shade = (h, k) => { const c = rgb(h).map((v) => Math.round(clamp(k >= 1 ? v + (255 - v) * (k - 1) : v * k, 0, 255))); return `rgb(${c.join(",")})`; };
  const hash = (i, k) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };

  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Matn bloki atrofidagi fon to'rtburchagi (padX/padY - foydalanuvchi slayderlari) */
  function box(L, R, px, py) {
    const ax = L.size * px * (R.padX || 1), ay = L.size * py * (R.padY || 1);
    const top = L.cy - L.blockH / 2;
    return { x: L.left - ax, y: top - ay, w: L.blockW + ax * 2, h: L.blockH + ay * 2, cx: L.left + L.blockW / 2, cy: L.cy };
  }

  /* Umumiy matn animatsiyasi: so'zlar pastdan chiqib keladi */
  function words(ctx, L, R, P, start, extra) {
    if (R.noText) return;
    const n = L.words.length;
    L.words.forEach((w, i) => {
      const k = E.outCubic(P.inP(start + P.stag(i, n, 0.45), P.each));
      const o = E.inCubic(P.out);
      glyph(ctx, w.text, w.x, w.y, w.w, R, L, Object.assign({ scale: 1, alpha: k * (1 - o), dy: (1 - k) * L.size * 0.35 }, extra || {}));
    });
  }

  function withAlpha(ctx, a, fn) { if (a <= 0.001) return; ctx.save(); ctx.globalAlpha *= a; fn(); ctx.restore(); }

  /* Kirish: masshtab + shaffoflik, markaz atrofida */
  function popTransform(ctx, cx, cy, s, rot) { ctx.translate(cx, cy); if (rot) ctx.rotate(rot); ctx.scale(s, s); ctx.translate(-cx, -cy); }

  /* Pastki kichik qator (sub) - nafis, harflari oraliqli */
  function subLine(ctx, R, L, x, y, a, opts) {
    if (!R.sub || R.noText || a <= 0) return;
    const o = opts || {};
    const sz = L.size * (o.scale || 0.32);
    const rs = Object.assign({}, R, { font: o.font || "Georgia", weight: o.weight || 400, italic: !!o.italic, glow: 0, stroke: 0, shadow: o.shadow == null ? R.shadow * 0.6 : o.shadow });
    ctx.save(); ctx.globalAlpha *= a;
    ctx.font = fontCss(rs, sz); ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const text = o.upper === false ? R.sub : R.sub.toLocaleUpperCase();
    const sp = o.spacing == null ? sz * 0.28 : sz * o.spacing;
    let w = 0; for (const ch of text) w += ctx.measureText(ch).width + sp; w -= sp;
    let cx = o.align === "left" ? x : x - w / 2;
    const fill = o.fill || R.accent;
    for (const ch of text) { paint(ctx, ch, cx, y, rs, { size: sz }, fill); cx += ctx.measureText(ch).width + sp; }
    ctx.restore();
  }

  /* ================= FONLI MATNLAR ================= */

  const DRAW = {};

  /* Shaffof (frosted) shisha plashka */
  DRAW.plate_glass = function (ctx, L, R, P) {
    const b = box(L, R, 0.6, 0.3);
    const k = E.outCubic(P.inP(0, P.inD * 0.9)), o = E.inCubic(P.out);
    const a = k * (1 - o);
    const r = Math.min(b.h / 2, L.size * 0.42);
    withAlpha(ctx, a, () => {
      ctx.save();
      popTransform(ctx, b.cx, b.cy, (0.86 + 0.14 * k) * (1 - o * 0.06));
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = L.size * 0.7; ctx.shadowOffsetY = L.size * 0.14;
      rr(ctx, b.x, b.y, b.w, b.h, r); ctx.fillStyle = rgba(R.accent, 0.16); ctx.fill();
      ctx.restore();
      const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      g.addColorStop(0, rgba(R.accent, 0.42)); g.addColorStop(0.5, rgba(R.accent, 0.24)); g.addColorStop(1, rgba(R.accent, 0.16));
      rr(ctx, b.x, b.y, b.w, b.h, r); ctx.fillStyle = g; ctx.fill();
      ctx.save(); rr(ctx, b.x, b.y, b.w, b.h, r); ctx.clip();
      const hg = ctx.createLinearGradient(0, b.y, 0, b.y + b.h * 0.55);
      hg.addColorStop(0, "rgba(255,255,255,0.32)"); hg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = hg; ctx.fillRect(b.x, b.y, b.w, b.h * 0.55);
      // yaltirash
      const sx = b.x - b.w * 0.3 + (b.w * 1.6) * (((P.t - P.inD) / 2.2) % 1.6);
      const sg = ctx.createLinearGradient(sx - b.h, b.y, sx + b.h, b.y + b.h);
      sg.addColorStop(0, "rgba(255,255,255,0)"); sg.addColorStop(0.5, "rgba(255,255,255,0.18)"); sg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sg; ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.restore();
      const bg = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
      bg.addColorStop(0, "rgba(255,255,255,0.9)"); bg.addColorStop(1, "rgba(255,255,255,0.25)");
      rr(ctx, b.x, b.y, b.w, b.h, r); ctx.lineWidth = Math.max(1.2, L.size * 0.035); ctx.strokeStyle = bg; ctx.stroke();
      ctx.restore();
    });
    words(ctx, L, R, P, P.inD * 0.3);
  };

  /* 3D chat pufagi (gil/plastilin uslubi) + qisqich */
  function bubblePath(ctx, x, y, w, h, r, tail) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.lineTo(x + r * 1.35 + tail, y + h);
    ctx.quadraticCurveTo(x + r * 0.9, y + h + tail * 0.35, x + r * 0.15, y + h + tail * 0.9);
    ctx.quadraticCurveTo(x + r * 0.55, y + h + tail * 0.2, x + r * 0.55, y + h - r * 0.05);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function paperclip(ctx, x, y, s, rot) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(0, s * 0.62);
      ctx.lineTo(0, s * 0.16); ctx.arc(s * 0.1, s * 0.16, s * 0.1, Math.PI, 0); ctx.lineTo(s * 0.2, s * 0.86);
      ctx.arc(s * 0.07, s * 0.86, s * 0.13, 0, Math.PI); ctx.lineTo(-s * 0.06, s * 0.08);
      ctx.arc(s * 0.1, s * 0.08, s * 0.16, Math.PI, 0); ctx.lineTo(s * 0.26, s * 0.58);
    };
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = s * 0.12; ctx.shadowOffsetX = s * 0.04; ctx.shadowOffsetY = s * 0.06;
    path(); ctx.lineWidth = s * 0.055; ctx.strokeStyle = "#7d8597"; ctx.stroke(); ctx.restore();
    const g = ctx.createLinearGradient(-s * 0.1, 0, s * 0.3, s);
    g.addColorStop(0, "#f4f6fa"); g.addColorStop(0.45, "#a9b1c2"); g.addColorStop(0.7, "#e9edf3"); g.addColorStop(1, "#8e97a8");
    path(); ctx.lineWidth = s * 0.04; ctx.strokeStyle = g; ctx.stroke();
    path(); ctx.lineWidth = s * 0.012; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.stroke();
    ctx.restore();
  }

  DRAW.plate_bubble3d = function (ctx, L, R, P) {
    const b = box(L, R, 0.8, 0.62);
    const k = P.inP(0, P.inD * 1.1), o = E.inCubic(P.out);
    const s = (0.25 + 0.75 * E.outBack(k)) * (1 - o);
    if (s <= 0.01) return;
    const rot = (1 - E.outCubic(k)) * -0.16 + Math.sin(P.t * 1.7) * 0.012;
    const r = Math.min(b.h * 0.34, b.w * 0.22), tail = b.h * 0.3, depth = b.h * 0.085;
    ctx.save();
    ctx.globalAlpha *= Math.min(1, k * 3) * (1 - o);
    popTransform(ctx, b.x + r * 0.2, b.y + b.h + tail, s, rot);
    // yerga tushgan soya
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.32)"; ctx.shadowBlur = L.size * 0.9; ctx.shadowOffsetX = depth * 0.8; ctx.shadowOffsetY = depth * 2.2;
    bubblePath(ctx, b.x, b.y, b.w, b.h, r, tail); ctx.fillStyle = shade(R.color2, 0.9); ctx.fill(); ctx.restore();
    // qalinlik (ekstruziya)
    for (let i = 6; i >= 1; i--) {
      ctx.save(); ctx.translate(depth * 0.25 * i / 6, depth * i / 6);
      bubblePath(ctx, b.x, b.y, b.w, b.h, r, tail); ctx.fillStyle = shade(R.color2, 0.78 + 0.12 * (1 - i / 6)); ctx.fill(); ctx.restore();
    }
    // yuqori yuza
    const g = ctx.createRadialGradient(b.x + b.w * 0.3, b.y + b.h * 0.2, b.h * 0.1, b.x + b.w * 0.5, b.y + b.h * 0.6, b.w * 0.75);
    g.addColorStop(0, shade(R.accent, 1.06)); g.addColorStop(0.6, R.accent); g.addColorStop(1, shade(R.accent, 0.9));
    bubblePath(ctx, b.x, b.y, b.w, b.h, r, tail); ctx.fillStyle = g; ctx.fill();
    // ichki qirra (bevel): yuqori-chap yorug', past-o'ng soya
    ctx.save(); bubblePath(ctx, b.x, b.y, b.w, b.h, r, tail); ctx.clip();
    const bv = ctx.createLinearGradient(b.x, b.y, b.x + b.w * 0.4, b.y + b.h * 1.2);
    bv.addColorStop(0, "rgba(255,255,255,0.95)"); bv.addColorStop(0.5, "rgba(255,255,255,0)"); bv.addColorStop(1, "rgba(0,0,0,0.16)");
    bubblePath(ctx, b.x, b.y, b.w, b.h, r, tail); ctx.lineWidth = depth * 1.2; ctx.strokeStyle = bv; ctx.stroke();
    const spec = ctx.createRadialGradient(b.x + b.w * 0.25, b.y + b.h * 0.18, 0, b.x + b.w * 0.25, b.y + b.h * 0.18, b.w * 0.35);
    spec.addColorStop(0, "rgba(255,255,255,0.55)"); spec.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = spec; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.restore();
    // qisqich (yuqoridan tushib keladi)
    const ck = E.outBack(P.inP(P.inD * 0.45, P.inD * 0.6));
    if (ck > 0) paperclip(ctx, b.x + b.w - r * 0.95, b.y - b.h * 0.28 - (1 - ck) * b.h * 0.6, b.h * 0.62, 0.16);
    ctx.restore();
    if (!R.noText) {
      ctx.save(); popTransform(ctx, b.x + r * 0.2, b.y + b.h + tail, s, rot);
      words(ctx, L, Object.assign({}, R, { shadow: 0 }), P, P.inD * 0.4);
      ctx.restore();
    }
  };

  /* Gradient kapsula */
  DRAW.plate_pill = function (ctx, L, R, P) {
    const b = box(L, R, 0.75, 0.32);
    const k = E.outExpo(P.inP(0, P.inD)), o = E.inCubic(P.out);
    const w = mix(b.h, b.w, k) * (1 - o * 0.3), x = b.cx - w / 2;
    withAlpha(ctx, Math.min(1, P.inP(0, P.inD * 0.3) * 1.5) * (1 - o), () => {
      ctx.save(); ctx.shadowColor = rgba(R.accent, 0.45); ctx.shadowBlur = L.size * 0.6; ctx.shadowOffsetY = L.size * 0.12;
      const g = ctx.createLinearGradient(x, 0, x + w, 0); g.addColorStop(0, R.accent); g.addColorStop(1, R.color2);
      rr(ctx, x, b.y, w, b.h, b.h / 2); ctx.fillStyle = g; ctx.fill(); ctx.restore();
      ctx.save(); rr(ctx, x, b.y, w, b.h, b.h / 2); ctx.clip();
      const hg = ctx.createLinearGradient(0, b.y, 0, b.y + b.h * 0.5); hg.addColorStop(0, "rgba(255,255,255,0.38)"); hg.addColorStop(1, "rgba(255,255,255,0.04)");
      ctx.fillStyle = hg; rr(ctx, x + b.h * 0.15, b.y + b.h * 0.06, w - b.h * 0.3, b.h * 0.45, b.h * 0.22); ctx.fill();
      words(ctx, L, Object.assign({}, R, { shadow: 0.3 }), P, P.inD * 0.4);
      ctx.restore();
    });
  };

  /* Lenta (banner), uchlari bukilgan */
  DRAW.plate_ribbon = function (ctx, L, R, P) {
    const b = box(L, R, 0.7, 0.3);
    const k = E.outCubic(P.inP(0, P.inD)), o = E.inCubic(P.out);
    const reveal = b.w * k * (1 - o);
    if (reveal <= 1) return;
    const tw = b.h * 0.9, drop = b.h * 0.28;
    ctx.save();
    ctx.beginPath(); ctx.rect(b.cx - reveal / 2 - tw * 1.2, 0, reveal + tw * 2.4, ctx.canvas.height); ctx.clip();
    ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = L.size * 0.4; ctx.shadowOffsetY = L.size * 0.1;
    // uchlari (orqada)
    ctx.fillStyle = shade(R.accent, 0.72);
    [[b.x, -1], [b.x + b.w, 1]].forEach(([ex, d]) => {
      ctx.beginPath();
      ctx.moveTo(ex - d * tw * 0.25, b.y + drop); ctx.lineTo(ex + d * tw, b.y + drop); ctx.lineTo(ex + d * tw * 0.65, b.y + drop + b.h / 2);
      ctx.lineTo(ex + d * tw, b.y + drop + b.h); ctx.lineTo(ex - d * tw * 0.25, b.y + drop + b.h); ctx.closePath(); ctx.fill();
    });
    ctx.shadowColor = "transparent";
    ctx.fillStyle = R.color2;
    [[b.x, -1], [b.x + b.w, 1]].forEach(([ex, d]) => {
      ctx.beginPath(); ctx.moveTo(ex, b.y + b.h); ctx.lineTo(ex - d * tw * 0.25, b.y + b.h + drop); ctx.lineTo(ex, b.y + b.h + drop); ctx.closePath(); ctx.fill();
    });
    const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    g.addColorStop(0, shade(R.accent, 1.12)); g.addColorStop(0.5, R.accent); g.addColorStop(1, shade(R.accent, 0.82));
    ctx.fillStyle = g; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(b.x, b.y + b.h * 0.08, b.w, Math.max(1, b.h * 0.05));
    ctx.restore();
    words(ctx, L, Object.assign({}, R, { shadow: 0.25 }), P, P.inD * 0.35);
  };

  /* 3D karta: qalinlik, egilib kirish, yaltirash */
  DRAW.plate_card3d = function (ctx, L, R, P) {
    const b = box(L, R, 0.7, 0.45);
    const k = P.inP(0, P.inD * 1.1), o = E.inCubic(P.out);
    const sy = E.outBack(k) * (1 - o), skew = (1 - E.outCubic(k)) * -0.35 + Math.sin(P.t * 1.3) * 0.02;
    if (sy <= 0.01) return;
    const r = L.size * 0.35, depth = L.size * 0.22, fl = Math.sin(P.t * 2) * L.size * 0.03;
    ctx.save();
    ctx.globalAlpha *= Math.min(1, k * 3) * (1 - o);
    ctx.translate(b.cx, b.cy + fl); ctx.transform(1, 0, skew, 1, 0, 0); ctx.scale(1, sy); ctx.translate(-b.cx, -b.cy);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = L.size; ctx.shadowOffsetY = depth * 1.5;
    rr(ctx, b.x + depth, b.y + depth, b.w, b.h, r); ctx.fillStyle = shade(R.color2, 0.55); ctx.fill(); ctx.restore();
    for (let i = 5; i >= 1; i--) { rr(ctx, b.x + depth * i / 5, b.y + depth * i / 5, b.w, b.h, r); ctx.fillStyle = shade(R.color2, 0.6 + 0.06 * (5 - i)); ctx.fill(); }
    const g = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h); g.addColorStop(0, R.accent); g.addColorStop(1, R.color2);
    rr(ctx, b.x, b.y, b.w, b.h, r); ctx.fillStyle = g; ctx.fill();
    ctx.save(); rr(ctx, b.x, b.y, b.w, b.h, r); ctx.clip();
    const sx = b.x - b.w * 0.5 + b.w * 2 * (((P.t - P.inD * 0.5) / 2) % 1.4);
    const sg = ctx.createLinearGradient(sx - b.h * 0.6, b.y, sx + b.h * 0.6, b.y + b.h);
    sg.addColorStop(0, "rgba(255,255,255,0)"); sg.addColorStop(0.5, "rgba(255,255,255,0.28)"); sg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sg; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.lineWidth = L.size * 0.05; ctx.strokeStyle = "rgba(255,255,255,0.35)"; rr(ctx, b.x, b.y, b.w, b.h, r); ctx.stroke();
    ctx.restore();
    words(ctx, L, R, P, P.inD * 0.45);
    ctx.restore();
  };

  /* Neon ramka */
  DRAW.plate_neon = function (ctx, L, R, P) {
    const b = box(L, R, 0.7, 0.45);
    const f = Math.floor(P.t * 24);
    const on = P.t > P.inD ? 1 : hash(f, 9) < P.t / P.inD ? 1 : 0.12;
    const o = P.out > 0 && hash(f, 8) < P.out ? 0 : 1;
    const a = on * o;
    if (a <= 0) return;
    const r = L.size * 0.3, lw = Math.max(2, L.size * 0.06);
    ctx.save(); ctx.globalAlpha *= a;
    ctx.shadowColor = R.color2; ctx.shadowBlur = L.size * 0.7;
    rr(ctx, b.x, b.y, b.w, b.h, r); ctx.lineWidth = lw * 1.6; ctx.strokeStyle = R.color2; ctx.stroke(); ctx.stroke();
    ctx.shadowBlur = L.size * 0.15; rr(ctx, b.x, b.y, b.w, b.h, r); ctx.lineWidth = lw * 0.5; ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.stroke();
    ctx.restore();
    if (!R.noText) {
      const k = P.inP(P.inD * 0.4, P.inD * 0.6);
      withAlpha(ctx, (k > 0 ? 1 : 0) * o * (hash(f, 7) < 0.92 || k >= 1 ? 1 : 0.3), () => L.rows.forEach((row) => glyph(ctx, row.text, row.x, row.y, row.w, Object.assign({}, R, { glow: Math.max(0.6, R.glow), shadow: 0 }), L, { scale: 1, alpha: 1 })));
    }
  };

  /* Stiker: qalin oq kontur, yopishtirilgandek */
  DRAW.plate_sticker = function (ctx, L, R, P) {
    const k = P.inP(0, P.inD * 0.8), o = E.inCubic(P.out);
    const s = (1.7 - 0.7 * E.outBack(k)) * (1 - o * 0.4);
    const a = Math.min(1, k * 4) * (1 - o);
    const rot = -0.07 + o * 0.25;
    ctx.save(); ctx.globalAlpha *= a;
    popTransform(ctx, L.cx, L.cy, s, rot);
    ctx.font = L.font; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.25 + 0.2 * (1 - k)})`; ctx.shadowBlur = L.size * (0.25 + (1 - k) * 0.8); ctx.shadowOffsetY = L.size * (0.06 + (1 - k) * 0.3);
    ctx.strokeStyle = R.accent; ctx.lineWidth = L.size * 0.42 * (R.padX || 1);
    L.rows.forEach((row) => ctx.strokeText(row.text, row.x, row.y));
    ctx.restore();
    if (!R.noText) {
      ctx.lineWidth = L.size * 0.06; ctx.strokeStyle = shade(R.color, 0.55);
      L.rows.forEach((row) => { ctx.strokeText(row.text, row.x, row.y); ctx.fillStyle = R.color; ctx.fillText(row.text, row.x, row.y); });
    }
    ctx.restore();
  };

  /* Chat xabarlari: har bir qator alohida pufak, "yozmoqda..." nuqtalari bilan */
  DRAW.plate_chat = function (ctx, L, R, P) {
    const lines = L.rows.map((r) => r.text);
    const n = lines.length;
    const fs = L.size, padX = fs * 0.7, h = fs * 1.75, gap = fs * 0.45;
    ctx.font = L.font;
    const widths = lines.map((t) => ctx.measureText(t).width + padX * 2);
    const maxW = Math.max(...widths);
    const total = n * h + (n - 1) * gap;
    const slot = Math.min(1.1, (P.D - P.outD - 0.3) / Math.max(1, n));
    const o = E.inCubic(P.out);
    lines.forEach((t, i) => {
      const sent = i % 2 === 0;
      const y = L.cy - total / 2 + i * (h + gap);
      const w = widths[i];
      const x = sent ? L.cx + maxW / 2 - w : L.cx - maxW / 2;
      const t0 = i * slot, typing = Math.min(0.45, slot * 0.45);
      const k = E.outBack(clamp((P.t - t0 - typing) / 0.3, 0, 1));
      const col = sent ? R.accent : R.color2, txt = sent ? R.color : "#1c1c1e";
      ctx.save(); ctx.globalAlpha *= 1 - o;
      if (P.t >= t0 && P.t < t0 + typing) {
        const tw = fs * 2.2, tx = sent ? L.cx + maxW / 2 - tw : L.cx - maxW / 2;
        rr(ctx, tx, y, tw, h, h / 2); ctx.fillStyle = col; ctx.fill();
        for (let d = 0; d < 3; d++) {
          const bob = Math.sin(P.t * 12 - d * 0.9) * fs * 0.12;
          ctx.beginPath(); ctx.arc(tx + tw * (0.3 + d * 0.2), y + h / 2 + bob, fs * 0.13, 0, TAU); ctx.fillStyle = sent ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.45)"; ctx.fill();
        }
      } else if (k > 0) {
        const ox = sent ? x + w : x;
        popTransform(ctx, ox, y + h, k);
        ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = fs * 0.4; ctx.shadowOffsetY = fs * 0.08;
        rr(ctx, x, y, w, h, h * 0.48); ctx.fillStyle = col; ctx.fill(); ctx.restore();
        ctx.beginPath();
        if (sent) { ctx.moveTo(x + w - h * 0.3, y + h * 0.7); ctx.quadraticCurveTo(x + w + h * 0.05, y + h * 1.02, x + w + h * 0.18, y + h); ctx.quadraticCurveTo(x + w - h * 0.05, y + h * 0.95, x + w - h * 0.1, y + h * 0.75); }
        else { ctx.moveTo(x + h * 0.3, y + h * 0.7); ctx.quadraticCurveTo(x - h * 0.05, y + h * 1.02, x - h * 0.18, y + h); ctx.quadraticCurveTo(x + h * 0.05, y + h * 0.95, x + h * 0.1, y + h * 0.75); }
        ctx.fillStyle = col; ctx.fill();
        if (!R.noText) { ctx.fillStyle = txt; ctx.font = L.font; ctx.textBaseline = "middle"; ctx.fillText(t, x + padX, y + h / 2); }
      }
      ctx.restore();
    });
  };

  /* Obuna tugmasi: kursor bosadi, tugma "obuna bo'lindi"ga aylanadi, qo'ng'iroqcha chayqaladi */
  DRAW.plate_subscribe = function (ctx, L, R, P) {
    const fs = L.size, h = fs * 2.2;
    const label1 = (R.text || "").split(/\r?\n/)[0] || "OBUNA BO'LING";
    const label2 = R.sub || "OBUNA BO'LINDI";
    ctx.font = L.font;
    const w = Math.max(ctx.measureText(label1).width, ctx.measureText(label2).width) + fs * 2.4;
    const x = L.cx - w / 2, y = L.cy - h / 2;
    const k = E.outBack(P.inP(0, P.inD * 0.8)), o = E.inCubic(P.out);
    const tClick = P.inD + 0.9;
    const clicked = P.t >= tClick;
    const press = P.t >= tClick - 0.08 && P.t < tClick + 0.12 ? 0.92 : 1;
    ctx.save(); ctx.globalAlpha *= Math.min(1, k * 2) * (1 - o);
    popTransform(ctx, L.cx, L.cy, k * press);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = fs * 0.6; ctx.shadowOffsetY = fs * 0.15;
    rr(ctx, x, y, w, h, h * 0.22); ctx.fillStyle = clicked ? R.color2 : R.accent; ctx.fill(); ctx.restore();
    const gl = ctx.createLinearGradient(0, y, 0, y + h); gl.addColorStop(0, "rgba(255,255,255,0.22)"); gl.addColorStop(0.5, "rgba(255,255,255,0)");
    rr(ctx, x, y, w, h, h * 0.22); ctx.fillStyle = gl; ctx.fill();
    if (!R.noText) {
      ctx.fillStyle = R.color; ctx.font = L.font; ctx.textBaseline = "middle"; ctx.textAlign = "center";
      ctx.fillText(clicked ? label2 : label1, L.cx, L.cy); ctx.textAlign = "left";
    }
    // qo'ng'iroqcha
    const bx = x + w + h * 0.75, by = L.cy;
    const ring = clicked ? Math.sin((P.t - tClick) * 28) * Math.exp(-(P.t - tClick) * 2.5) * 0.5 : 0;
    ctx.save(); ctx.translate(bx, by - h * 0.25); ctx.rotate(ring);
    ctx.fillStyle = clicked ? "#ffffff" : "rgba(255,255,255,0.85)"; ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = fs * 0.3;
    const s = h * 0.32;
    ctx.beginPath(); ctx.moveTo(-s, s * 1.2); ctx.quadraticCurveTo(-s * 0.85, s * 0.9, -s * 0.8, 0.2 * s); ctx.quadraticCurveTo(-s * 0.75, -s * 0.9, 0, -s * 0.95);
    ctx.quadraticCurveTo(s * 0.75, -s * 0.9, s * 0.8, 0.2 * s); ctx.quadraticCurveTo(s * 0.85, s * 0.9, s, s * 1.2); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, s * 1.38, s * 0.24, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.restore();
    // kursor
    const ck = clamp((P.t - P.inD * 0.6) / 0.9, 0, 1);
    if (ck > 0 && P.out < 0.5) {
      const e = E.inOutCubic(ck);
      const cx = mix(L.cx + w * 0.9, L.cx + w * 0.15, e), cy = mix(L.cy + h * 2.2, L.cy + h * 0.15, e);
      const cs = fs * 1.1 * (press < 1 ? 0.9 : 1);
      ctx.save(); ctx.globalAlpha *= 1 - P.out * 2; ctx.translate(cx, cy);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, cs); ctx.lineTo(cs * 0.27, cs * 0.75); ctx.lineTo(cs * 0.45, cs * 1.12); ctx.lineTo(cs * 0.6, cs * 1.05);
      ctx.lineTo(cs * 0.42, cs * 0.7); ctx.lineTo(cs * 0.75, cs * 0.7); ctx.closePath();
      ctx.fillStyle = "#ffffff"; ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = fs * 0.25; ctx.fill();
      ctx.lineWidth = Math.max(1, cs * 0.05); ctx.strokeStyle = "#111"; ctx.stroke();
      ctx.restore();
    }
  };

  /* Iqtibos kartasi */
  DRAW.plate_quote = function (ctx, L, R, P) {
    const b = box(L, R, 1.0, R.sub ? 0.95 : 0.6);
    const k = E.outCubic(P.inP(0, P.inD)), o = E.inCubic(P.out);
    withAlpha(ctx, k * (1 - o), () => {
      ctx.save(); popTransform(ctx, b.cx, b.cy, 0.94 + 0.06 * k);
      ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = L.size * 0.8; ctx.shadowOffsetY = L.size * 0.15;
      rr(ctx, b.x, b.y, b.w, b.h, L.size * 0.3); ctx.fillStyle = "rgba(14,15,20,0.62)"; ctx.fill(); ctx.restore();
      rr(ctx, b.x, b.y, b.w, b.h, L.size * 0.3); ctx.lineWidth = Math.max(1, L.size * 0.03); ctx.strokeStyle = rgba(R.accent, 0.55); ctx.stroke();
      ctx.font = `700 ${(L.size * 2.4).toFixed(1)}px Georgia, serif`; ctx.fillStyle = R.accent; ctx.textBaseline = "middle";
      ctx.fillText("“", b.x + L.size * 0.25, b.y + L.size * 0.35);
      ctx.restore();
    });
    words(ctx, L, R, P, P.inD * 0.3, { dy: 0 });
    subLine(ctx, R, L, b.cx, b.y + b.h - L.size * 0.55, E.outCubic(P.inP(P.inD * 0.8, P.inD)) * (1 - o), { italic: true, upper: false, spacing: 0.05, scale: 0.45, fill: R.color2 });
  };

  /* Shisha lower third: ism + lavozim */
  DRAW.plate_lowerglass = function (ctx, L, R, P, W, H) {
    const row = L.rows[0];
    ctx.font = L.font;
    const nameW = ctx.measureText(row.text).width;
    ctx.save(); ctx.font = fontCss(Object.assign({}, R, { weight: 400 }), L.size * 0.6); const subW = R.sub ? ctx.measureText(R.sub).width : 0; ctx.restore();
    const padX = L.size * 0.6 * (R.padX || 1), padY = L.size * 0.35 * (R.padY || 1);
    const w = Math.max(nameW, subW) + padX * 2.4, h = L.lh * (R.sub ? 1.75 : 1) + padY * 2;
    const x = row.x - padX * 1.4, y = row.y - L.lh * 0.5 - padY;
    const k = E.outExpo(P.inP(0, P.inD)), o = E.inCubic(P.out);
    const ww = w * k * (1 - o);
    if (ww <= 1) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(x - L.size, y - L.size, ww + L.size, h + L.size * 2); ctx.clip();
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = L.size * 0.6; ctx.shadowOffsetY = L.size * 0.1;
    rr(ctx, x, y, w, h, L.size * 0.25); ctx.fillStyle = "rgba(255,255,255,0.2)"; ctx.fill(); ctx.restore();
    const g = ctx.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, "rgba(255,255,255,0.3)"); g.addColorStop(1, "rgba(255,255,255,0.1)");
    rr(ctx, x, y, w, h, L.size * 0.25); ctx.fillStyle = g; ctx.fill();
    rr(ctx, x, y, w, h, L.size * 0.25); ctx.lineWidth = Math.max(1, L.size * 0.03); ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.stroke();
    ctx.fillStyle = R.accent; rr(ctx, x + L.size * 0.22, y + h * 0.18, L.size * 0.12, h * 0.64, L.size * 0.06); ctx.fill();
    ctx.restore();
    if (R.noText) return;
    const tk = E.outCubic(P.inP(P.inD * 0.35, P.inD * 0.7));
    glyph(ctx, row.text, row.x, row.y, nameW, R, L, { scale: 1, alpha: tk * (1 - o), dx: (1 - tk) * -L.size * 0.6 });
    subLine(ctx, R, L, row.x, row.y + L.lh * 0.85, E.outCubic(P.inP(P.inD * 0.55, P.inD * 0.7)) * (1 - o), { align: "left", upper: false, spacing: 0.02, scale: 0.6, font: R.font, fill: R.color2, shadow: 0.3 });
  };

  /* ================= PROMO: 3D bloklar ustida xrom matn ================= *
   * Har bir qator o'z blokida: yaltiroq rangli plashka, karbon plashka yoki mo'yqalam chizig'i.
   * Matn - qalinligi bor xrom/oltin harflar, bloklar navbat bilan "urilib" tushadi, ustidan nur o'tadi.
   */
  const METAL = {
    silver: [[0, "#ffffff"], [0.3, "#e3e7ec"], [0.49, "#8f959e"], [0.55, "#f6f8fa"], [0.78, "#c2c7ce"], [1, "#6c717a"]],
    gold: [[0, "#fff8d2"], [0.3, "#f7d46c"], [0.49, "#a3701b"], [0.55, "#ffe9a4"], [0.8, "#d39c33"], [1, "#77510f"]],
  };

  let carbonTile = null;
  function carbonFill(ctx, cell) {
    try {
      if (!carbonTile) {
        const c = root.document.createElement("canvas"); c.width = c.height = 16;
        const g = c.getContext("2d");
        g.fillStyle = "#070708"; g.fillRect(0, 0, 16, 16);
        [[0, 0, 1], [8, 0, 0], [0, 8, 0], [8, 8, 1]].forEach(([x, y, hz]) => {
          const gr = hz ? g.createLinearGradient(x, y, x, y + 8) : g.createLinearGradient(x, y, x + 8, y);
          gr.addColorStop(0, "#34363b"); gr.addColorStop(0.5, "#17181b"); gr.addColorStop(1, "#050506");
          g.fillStyle = gr; g.fillRect(x + 0.5, y + 0.5, 7, 7);
        });
        carbonTile = c;
      }
      const pt = ctx.createPattern(carbonTile, "repeat");
      if (pt && pt.setTransform && root.DOMMatrix) pt.setTransform(new root.DOMMatrix().rotateSelf(0, 0, 45).scaleSelf(Math.max(0.2, cell / 16)));
      return pt || "#111";
    } catch (e) { return "#111"; }
  }

  function glossPlate(ctx, x, y, w, h, col) {
    const r = h * 0.3, d = h * 0.09;
    rr(ctx, x, y + d, w, h, r); ctx.fillStyle = shade(col, 0.3); ctx.fill();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, shade(col, 1.4)); g.addColorStop(0.42, col); g.addColorStop(1, shade(col, 0.5));
    rr(ctx, x, y, w, h, r); ctx.fillStyle = g; ctx.fill();
    const gg = ctx.createLinearGradient(0, y, 0, y + h * 0.5);
    gg.addColorStop(0, "rgba(255,255,255,0.55)"); gg.addColorStop(1, "rgba(255,255,255,0)");
    rr(ctx, x + h * 0.09, y + h * 0.07, w - h * 0.18, h * 0.4, r * 0.75); ctx.fillStyle = gg; ctx.fill();
    rr(ctx, x, y, w, h, r); ctx.lineWidth = Math.max(1, h * 0.055); ctx.strokeStyle = shade(col, 1.65); ctx.stroke();
    rr(ctx, x + h * 0.06, y + h * 0.06, w - h * 0.12, h * 0.88, r * 0.82); ctx.lineWidth = Math.max(1, h * 0.022); ctx.strokeStyle = shade(col, 0.42); ctx.stroke();
  }

  function carbonPlate(ctx, x, y, w, h, edge) {
    const r = h * 0.3, d = h * 0.09;
    rr(ctx, x, y + d, w, h, r); ctx.fillStyle = "#040405"; ctx.fill();
    rr(ctx, x, y, w, h, r); ctx.fillStyle = carbonFill(ctx, h * 0.09); ctx.fill();
    const sh = ctx.createLinearGradient(0, y, 0, y + h);
    sh.addColorStop(0, "rgba(255,255,255,0.22)"); sh.addColorStop(0.45, "rgba(255,255,255,0.03)"); sh.addColorStop(1, "rgba(0,0,0,0.45)");
    rr(ctx, x, y, w, h, r); ctx.fillStyle = sh; ctx.fill();
    const rim = ctx.createLinearGradient(0, y, 0, y + h);
    METAL.silver.forEach(([o, c]) => rim.addColorStop(o, c));
    rr(ctx, x, y, w, h, r); ctx.lineWidth = Math.max(1.5, h * 0.07); ctx.strokeStyle = rim; ctx.stroke();
    rr(ctx, x - h * 0.04, y - h * 0.04, w + h * 0.08, h * 1.08, r * 1.1); ctx.lineWidth = Math.max(1, h * 0.025); ctx.strokeStyle = edge; ctx.stroke();
  }

  function brushPlate(ctx, x, y, w, h, col, seed) {
    const n = 22, path = () => {
      ctx.beginPath();
      ctx.moveTo(x + w * 0.05, y + h * 0.1);
      for (let i = 1; i <= n; i++) ctx.lineTo(x + w * (0.05 + 0.9 * i / n), y + h * (0.03 + 0.12 * hash(seed, i)));
      for (let i = 0; i <= 16; i++) { const len = w * (0.015 + 0.075 * hash(seed + 1, i)); ctx.lineTo(x + w * 0.95 + (i % 2 ? len : len * 0.25), y + h * (0.08 + 0.84 * i / 16)); }
      for (let i = n; i >= 0; i--) ctx.lineTo(x + w * (0.05 + 0.9 * i / n), y + h * (0.88 + 0.1 * hash(seed + 2, i)));
      for (let i = 16; i >= 0; i--) { const len = w * (0.015 + 0.09 * hash(seed + 3, i)); ctx.lineTo(x + w * 0.05 - (i % 2 ? len : len * 0.25), y + h * (0.08 + 0.84 * i / 16)); }
      ctx.closePath();
    };
    ctx.save(); ctx.translate(0, h * 0.08); path(); ctx.fillStyle = shade(col, 0.3); ctx.fill(); ctx.restore();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, shade(col, 1.25)); g.addColorStop(0.5, col); g.addColorStop(1, shade(col, 0.6));
    path(); ctx.fillStyle = g; ctx.fill();
    ctx.save(); path(); ctx.clip(); // mo'yqalam izlari
    for (let i = 0; i < 26; i++) {
      const yy = y + h * hash(seed + 4, i), a = 0.08 + 0.18 * hash(seed + 5, i);
      ctx.fillStyle = i % 3 ? `rgba(0,0,0,${a.toFixed(3)})` : `rgba(255,255,255,${(a * 0.8).toFixed(3)})`;
      ctx.fillRect(x - w * 0.1 + w * 0.3 * hash(seed + 6, i), yy, w * (0.5 + 0.7 * hash(seed + 7, i)), Math.max(1, h * 0.012));
    }
    ctx.restore();
  }

  function metalText(ctx, s, cx, cy, fs, R, metal, edge) {
    ctx.save();
    ctx.font = fontCss(R, fs); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    try { if ("letterSpacing" in ctx) ctx.letterSpacing = (R.spacing * fs).toFixed(1) + "px"; } catch (e) { /* eski Chromium */ }
    const d = fs * 0.075, steps = 8; // qalinlik
    for (let i = steps; i >= 1; i--) { ctx.fillStyle = i === steps ? "rgba(0,0,0,0.4)" : shade(edge, 0.18 + 0.2 * i / steps); ctx.fillText(s, cx + d * 0.3 * i / steps, cy + d * i / steps); }
    ctx.lineWidth = fs * 0.1; ctx.strokeStyle = shade(edge, 0.5); ctx.strokeText(s, cx, cy);
    ctx.lineWidth = fs * 0.04; ctx.strokeStyle = shade(edge, 1.15); ctx.strokeText(s, cx, cy);
    const g = ctx.createLinearGradient(0, cy - fs * 0.4, 0, cy + fs * 0.4);
    METAL[metal].forEach(([o, c]) => g.addColorStop(o, c));
    ctx.fillStyle = g; ctx.fillText(s, cx, cy);
    ctx.restore();
  }

  /* Harflar ustidan o'tadigan yorug'lik chizig'i (faqat harflar ichida) */
  function shineText(ctx, s, cx, cy, fs, R, bx) {
    ctx.save();
    ctx.font = fontCss(R, fs); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    try { if ("letterSpacing" in ctx) ctx.letterSpacing = (R.spacing * fs).toFixed(1) + "px"; } catch (e) { /* eski Chromium */ }
    const g = ctx.createLinearGradient(bx - fs * 0.7, cy - fs * 0.5, bx + fs * 0.7, cy + fs * 0.5);
    g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.85)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillText(s, cx, cy);
    ctx.restore();
  }

  function flare(ctx, x, y, s, a) {
    if (a <= 0.01) return;
    ctx.save(); ctx.globalAlpha *= a; ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(x, y, 0, x, y, s);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.18, "rgba(255,225,225,0.6)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, s, 0, TAU); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(x - s * 1.7, y - s * 0.025, s * 3.4, s * 0.05); ctx.fillRect(x - s * 0.025, y - s * 0.9, s * 0.05, s * 1.8);
    ctx.restore();
  }

  const PRIORITY = { brush: 0, gloss: 1, carbon: 2 };
  function promo(cfg) {
    return function (ctx, L, R, P, W, H) {
      const rows = L.rows.map((r) => r.text);
      const n = rows.length;
      const style = (i) => cfg.styles[i % cfg.styles.length];
      const scl = rows.map((_, i) => (n === 1 ? 1 : cfg.scales[i % cfg.scales.length]));
      const padX = 0.32 * (R.padX || 1), padY = R.padY || 1;
      let base = L.size;
      const widths = (b) => rows.map((s, i) => {
        const fs = b * scl[i];
        ctx.font = fontCss(R, fs);
        const tw = ctx.measureText(s).width + Math.max(0, s.length - 1) * R.spacing * fs;
        return { fs, tw, pw: tw + fs * padX * 2 + (style(i) === "brush" ? fs * 0.8 : 0), ph: fs * (0.84 + 0.28 * padY) };
      });
      let M = widths(base);
      const maxW = Math.max(...M.map((m) => m.pw));
      if (maxW > W * 0.94) { base *= (W * 0.94) / maxW; M = widths(base); }
      const gap = -base * 0.06;
      const total = M.reduce((a, m) => a + m.ph, 0) + gap * (n - 1);
      const cx = R.x * W, cy = R.y * H;
      let yy = cy - total / 2;
      M.forEach((m) => { m.y = yy; yy += m.ph + gap; });
      const o = E.inCubic(P.out);
      ctx.save();
      popTransform(ctx, cx, cy, 1 - 0.15 * o, cfg.tilt);
      ctx.globalAlpha *= 1 - o;
      const order = rows.map((_, i) => i).sort((a, b) => PRIORITY[style(a)] - PRIORITY[style(b)] || a - b);
      order.forEach((i) => {
        const m = M[i], delay = i * P.inD * 0.3;
        const k = P.inP(delay, P.inD * 0.55);
        if (k <= 0) return;
        const s = mix(2.1, 1, E.outBack(k)), a = Math.min(1, k * 3);
        const fy = Math.sin(P.t * 2.2 + i * 1.3) * m.fs * 0.018;
        const pcx = cx, pcy = m.y + m.ph / 2 + fy;
        const x = pcx - m.pw / 2, y = pcy - m.ph / 2;
        ctx.save();
        ctx.globalAlpha *= a;
        popTransform(ctx, pcx, pcy, s, (1 - E.outCubic(k)) * (i % 2 ? 0.12 : -0.12));
        if (R.shadow > 0) {
          ctx.save(); ctx.shadowColor = `rgba(0,0,0,${(0.3 + 0.35 * R.shadow).toFixed(2)})`; ctx.shadowBlur = m.fs * 0.6; ctx.shadowOffsetY = m.fs * 0.18;
          rr(ctx, x + m.fs * 0.1, y + m.ph * 0.15, m.pw - m.fs * 0.2, m.ph * 0.8, m.ph * 0.3); ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fill(); ctx.restore();
        }
        if (style(i) === "gloss") glossPlate(ctx, x, y, m.pw, m.ph, R.accent);
        else if (style(i) === "carbon") carbonPlate(ctx, x, y, m.pw, m.ph, R.accent);
        else brushPlate(ctx, x, y, m.pw, m.ph, R.accent, 7 + i * 13);
        if (!R.noText) {
          const tk = E.outBack(P.inP(delay + P.inD * 0.15, P.inD * 0.5));
          ctx.save(); ctx.globalAlpha *= Math.min(1, tk * 2); popTransform(ctx, pcx, pcy, mix(0.55, 1, tk));
          const ty = pcy + m.fs * 0.02 - m.fs * 0.035;
          metalText(ctx, rows[i], pcx, ty, m.fs, R, cfg.metal, cfg.edge || R.accent);
          const u = ((P.t - P.inD) * 0.65 - i * 0.12) % 1.7;
          if (P.t > P.inD && u >= 0 && u < 1) shineText(ctx, rows[i], pcx, ty, m.fs, R, x - m.fs + (m.pw + m.fs * 2) * u);
          ctx.restore();
        }
        const fa = E.outCubic(P.inP(delay + P.inD * 0.4, P.inD * 0.4)) * (0.55 + 0.45 * Math.sin(P.t * 3.1 + i * 2));
        flare(ctx, x + m.pw - m.ph * 0.35, y + m.ph * 0.12, m.fs * 0.32, fa);
        if (i === 0) flare(ctx, x + m.ph * 0.4, y + m.ph * 0.9, m.fs * 0.22, fa * 0.8);
        ctx.restore();
      });
      ctx.restore();
    };
  }

  DRAW.promo_stack = promo({ styles: ["gloss", "carbon", "brush"], scales: [1, 1.2, 0.8], metal: "silver", tilt: -0.06 });
  DRAW.promo_gold = promo({ styles: ["carbon", "gloss", "brush"], scales: [0.85, 1.2, 0.78], metal: "gold", edge: "#4a2b00", tilt: -0.05 });
  DRAW.promo_blue = promo({ styles: ["gloss", "carbon", "brush"], scales: [0.9, 1.2, 0.8], metal: "silver", tilt: 0.05 });
  DRAW.promo_brush = promo({ styles: ["brush"], scales: [1, 0.8], metal: "silver", tilt: -0.04 });
  DRAW.promo_badge = promo({ styles: ["gloss"], scales: [1, 0.8], metal: "silver", tilt: -0.05 });
  DRAW.promo_carbon = promo({ styles: ["carbon"], scales: [1, 0.8], metal: "gold", edge: "#4a2b00", tilt: 0 });

  /* ================= katalog ================= */

  const PLATE = { font: "Segoe UI", weight: 800, upper: false, size: 0.055, shadow: 0.35, stroke: 0, glow: 0 };
  const PROMO = { font: "Arial Black", weight: 900, italic: true, upper: false, size: 0.13, spacing: 0, shadow: 0.6, stroke: 0, glow: 0,
    color: "#ffffff", color2: "#111111", accent: "#e10600", duration: 3.5 };
  const T = (id, kind, name, desc, set, extra) => Object.assign({ id, kind, name, desc, set }, extra || {});

  const LIST = [
    T("plate_glass", "plate", "Shaffof shisha", "Matn orqasida yarim shaffof (frosted) shisha fon", Object.assign({}, PLATE, { text: "Shaffof text background", color: "#ffffff", accent: "#ffffff" })),
    T("plate_bubble3d", "plate", "3D chat pufagi", "Oq 3D pufak, qisqich bilan, sakrab chiqadi", Object.assign({}, PLATE, { text: "Muhim eslatma!", color: "#2b2f3a", accent: "#ffffff", color2: "#c7ccd8", weight: 700, shadow: 0 })),
    T("plate_pill", "plate", "Gradient kapsula", "Yaltiroq gradient kapsula ichida matn", Object.assign({}, PLATE, { text: "YANGI VIDEO", upper: true, color: "#ffffff", accent: "#7b5cff", color2: "#00c6ff", size: 0.05 })),
    T("plate_ribbon", "plate", "Lenta", "Uchlari bukilgan banner lenta", Object.assign({}, PLATE, { text: "MAXSUS TAKLIF", font: "Arial Black", upper: true, color: "#ffffff", accent: "#e63946", color2: "#8e1b25", size: 0.05 })),
    T("plate_card3d", "plate", "3D karta", "Qalinligi bor karta, egilib kiradi", Object.assign({}, PLATE, { text: "TOP 5 MASLAHAT", font: "Segoe UI Black", weight: 900, upper: true, color: "#ffffff", accent: "#ff6a3d", color2: "#ff2d75" })),
    T("plate_neon", "plate", "Neon ramka", "Yonib turgan neon ramka ichida matn", Object.assign({}, PLATE, { text: "OPEN", weight: 600, upper: true, color: "#ffffff", color2: "#00e5ff", accent: "#00e5ff", glow: 0.9, shadow: 0, size: 0.07 })),
    T("plate_sticker", "plate", "Stiker", "Qalin oq konturli stiker, yopishib tushadi", Object.assign({}, PLATE, { text: "WOW!", font: "Arial Black", upper: true, color: "#ff3d6e", accent: "#ffffff", size: 0.09 })),
    T("plate_chat", "plate", "Chat xabarlar", "Har bir qator - alohida xabar, \"yozmoqda...\" bilan",
      Object.assign({}, PLATE, { text: "Salom! Qalaysiz?\nZo'r, rahmat 😊\nYangi videoni ko'rdingizmi?", weight: 500, color: "#ffffff", accent: "#2f7bff", color2: "#e9e9eb", size: 0.04, shadow: 0, duration: 4.5 }), { manyLines: true }),
    T("plate_subscribe", "plate", "Obuna tugmasi", "Kursor bosadi, qo'ng'iroqcha chayqaladi",
      Object.assign({}, PLATE, { text: "OBUNA BO'LING", sub: "OBUNA BO'LINDI", upper: true, color: "#ffffff", accent: "#ff0033", color2: "#606060", size: 0.045, y: 0.78, shadow: 0, duration: 3.5 }), { sub: true, oneLine: true }),
    T("plate_quote", "plate", "Iqtibos", "To'q karta, katta qo'shtirnoq, muallif",
      Object.assign({}, PLATE, { text: "Orzular amalga oshadi", sub: "— Muallif", font: "Georgia", weight: 700, color: "#ffffff", accent: "#ffd34d", color2: "#d0d3db" }), { sub: true }),
    T("plate_lowerglass", "plate", "Shisha lower third", "Ism va lavozim shisha plashkada",
      Object.assign({}, PLATE, { text: "Dilshod Rahimov", sub: "Bosh muharrir", weight: 700, color: "#ffffff", color2: "#e2e6ee", accent: "#7b6cff", size: 0.045, x: 0.1, y: 0.8, align: "left" }), { sub: true, oneLine: true }),
    // 3D promo bloklar (rasmdagi kabi: rangli plashka, karbon plashka, mo'yqalam chizig'i)
    T("promo_stack", "plate", "Promo 3D bloklar", "Har qator o'z 3D blokida: qizil, karbon, mo'yqalam; xrom harflar", Object.assign({}, PROMO, { text: "2000 kv\nZALNI\n20 SONIYADA" }), { manyLines: true }),
    T("promo_gold", "plate", "Oltin promo", "Oltin harflar, karbon va qizil bloklar", Object.assign({}, PROMO, { text: "CHEGIRMA\n-50%\nFAQAT BUGUN", accent: "#c8102e" }), { manyLines: true }),
    T("promo_blue", "plate", "Ko'k promo", "Ko'k yaltiroq blok, karbon, mo'yqalam", Object.assign({}, PROMO, { text: "YANGI\nMAVSUM\nBOSHLANDI", accent: "#1667ff" }), { manyLines: true }),
    T("promo_brush", "plate", "Mo'yqalam chizig'i", "Xrom matn qizil mo'yqalam chizig'i ustida", Object.assign({}, PROMO, { text: "20 SONIYADA", size: 0.11 }), { manyLines: true }),
    T("promo_badge", "plate", "3D yaltiroq yorliq", "Qalin xrom matn yaltiroq 3D plashkada", Object.assign({}, PROMO, { text: "MEGA AKSIYA", accent: "#ff7a00", size: 0.11 }), { manyLines: true }),
    T("promo_carbon", "plate", "Karbon premium", "Karbon plashka, xrom ramka, oltin harflar", Object.assign({}, PROMO, { text: "PREMIUM", size: 0.12 }), { manyLines: true }),
  ];

  X.register(LIST, DRAW);
})(typeof window !== "undefined" ? window : globalThis);
