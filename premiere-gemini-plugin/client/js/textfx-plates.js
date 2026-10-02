/*
 * GeminiCut - qo'shimcha matn shablonlari:
 *   "plate"   - matn orqasiga avtomatik fon qo'yiladigan shablonlar (shaffof shisha, 3D chat pufagi,
 *               kapsula, lenta, 3D karta, neon ramka, stiker, chat xabarlari, obuna tugmasi, iqtibos...).
 *               "Matnsiz" rejimida faqat fonning o'zi (shaffof PNG) chiziladi.
 *   "wedding" - to'y / zal videolari uchun nafis oltin shablonlar.
 *   "bg"      - matnsiz shaffof fonlar va overlay'lar (bokeh, oltin zarrachalar, yurakchalar, gulbarglar...).
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

  /* 4 nurli yulduzcha (uchqun) */
  function star(ctx, x, y, r, color, a) {
    if (a <= 0.01 || r <= 0.2) return;
    ctx.save(); ctx.globalAlpha *= a; ctx.translate(x, y);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.25, color); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a2 = i * Math.PI / 4, rad = i % 2 ? r * 0.18 : r; ctx.lineTo(Math.cos(a2) * rad, Math.sin(a2) * rad); }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function heart(ctx, x, y, s, rot) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot || 0); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, 0.35);
    ctx.bezierCurveTo(-0.05, 0.3, -0.5, 0.05, -0.5, -0.2);
    ctx.bezierCurveTo(-0.5, -0.45, -0.15, -0.55, 0, -0.28);
    ctx.bezierCurveTo(0.15, -0.55, 0.5, -0.45, 0.5, -0.2);
    ctx.bezierCurveTo(0.5, 0.05, 0.05, 0.3, 0, 0.35);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* Oltin gradient: to'q -> och -> yorqin -> to'q */
  function goldFill(ctx, y0, y1, R) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, R.color2); g.addColorStop(0.42, R.color); g.addColorStop(0.55, R.accent); g.addColorStop(1, R.color2);
    return g;
  }

  /* Matn qatorlari ustidan yaltirash chizig'i (faqat harflar ustida) */
  function shimmer(ctx, L, R, P, alpha, font) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const sweep = ((P.t - P.inD * 0.8) / 1.6) % 2.4;
    if (sweep <= 0 || sweep >= 1 || alpha <= 0) return;
    const off = document.createElement("canvas"); off.width = W; off.height = H;
    const o = off.getContext("2d"); o.font = font || L.font; o.textBaseline = "middle";
    L.rows.forEach((row) => { o.fillStyle = "#fff"; o.fillText(row.text, row.x, row.y); });
    o.globalCompositeOperation = "source-in";
    const sx = L.left - L.size + (L.blockW + L.size * 2) * sweep;
    const g = o.createLinearGradient(sx - L.size * 0.6, 0, sx + L.size * 0.6, 0);
    g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.9)"); g.addColorStop(1, "rgba(255,255,255,0)");
    o.fillStyle = g; o.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha *= alpha; ctx.drawImage(off, 0, 0); ctx.restore();
  }

  /* Uchqunlar matn atrofida, kadrga bog'liq (har safar bir xil) */
  function sparkles(ctx, b, P, n, color, size) {
    for (let i = 0; i < n; i++) {
      const x = b.x + hash(i, 1) * b.w, y = b.y + hash(i, 2) * b.h;
      const ph = hash(i, 3) * TAU, sp = 2 + hash(i, 4) * 3;
      const a = Math.pow(Math.max(0, Math.sin(P.t * sp + ph)), 6) * Math.min(1, P.t / P.inD) * (1 - P.out);
      star(ctx, x, y, size * (0.5 + hash(i, 5)), color, a);
    }
  }

  /* Bezier jingalak (burchak naqshi) - 0,0 burchakdan, o'qlar bo'ylab */
  function flourish(ctx, s) {
    ctx.beginPath();
    ctx.moveTo(0, s * 1.6); ctx.lineTo(0, s * 0.35);
    ctx.bezierCurveTo(0, s * 0.1, s * 0.1, 0, s * 0.35, 0); ctx.lineTo(s * 1.6, 0);
    ctx.moveTo(s * 0.18, s * 1.1); ctx.bezierCurveTo(s * 0.18, s * 0.45, s * 0.45, s * 0.18, s * 1.1, s * 0.18);
    ctx.moveTo(s * 0.55, s * 0.55);
    ctx.bezierCurveTo(s * 0.9, s * 0.35, s * 0.95, s * 0.8, s * 0.7, s * 0.8);
    ctx.bezierCurveTo(s * 0.5, s * 0.8, s * 0.55, s * 0.6, s * 0.68, s * 0.62);
    ctx.moveTo(s * 0.55, s * 0.55);
    ctx.bezierCurveTo(s * 0.35, s * 0.9, s * 0.8, s * 0.95, s * 0.8, s * 0.7);
  }

  /* Oltin ramka: ikki chiziq + to'rt burchakda jingalak; k - chizilish darajasi (0..1) */
  function goldFrame(ctx, x, y, w, h, R, k, lw) {
    ctx.save();
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, R.color2); g.addColorStop(0.35, R.color); g.addColorStop(0.5, R.accent); g.addColorStop(0.65, R.color); g.addColorStop(1, R.color2);
    ctx.strokeStyle = g; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = lw * 3; ctx.shadowOffsetY = lw;
    const per = 2 * (w + h);
    ctx.setLineDash([per * k, per]);
    ctx.lineWidth = lw; ctx.strokeRect(x, y, w, h);
    const i = lw * 5;
    ctx.lineWidth = lw * 0.5; ctx.setLineDash([(per - 8 * i) * k, per]); ctx.strokeRect(x + i, y + i, w - 2 * i, h - 2 * i);
    ctx.setLineDash([]);
    const s = Math.min(w, h) * 0.12;
    const fk = clamp((k - 0.3) / 0.7, 0, 1);
    if (fk > 0) {
      ctx.globalAlpha *= fk;
      ctx.lineWidth = lw * 0.8;
      [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, sx, sy]) => {
        ctx.save(); ctx.translate(cx + sx * i * 0.5, cy + sy * i * 0.5); ctx.scale(sx, sy); flourish(ctx, s); ctx.stroke(); ctx.restore();
      });
    }
    ctx.restore();
  }

  /* Gorizontal oltin chiziq, markazida romb */
  function ornamentLine(ctx, cx, y, half, R, k, lw) {
    if (k <= 0) return;
    ctx.save();
    const g = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
    g.addColorStop(0, rgba(R.color, 0)); g.addColorStop(0.3, R.color); g.addColorStop(0.5, R.accent); g.addColorStop(0.7, R.color); g.addColorStop(1, rgba(R.color, 0));
    ctx.strokeStyle = g; ctx.fillStyle = R.color; ctx.lineWidth = lw;
    const hk = half * E.outCubic(k);
    ctx.beginPath(); ctx.moveTo(cx - hk, y); ctx.lineTo(cx - lw * 6, y); ctx.moveTo(cx + lw * 6, y); ctx.lineTo(cx + hk, y); ctx.stroke();
    const d = lw * 3.5 * E.outBack(clamp(k * 1.5, 0, 1));
    ctx.beginPath(); ctx.moveTo(cx, y - d); ctx.lineTo(cx + d, y); ctx.lineTo(cx, y + d); ctx.lineTo(cx - d, y); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

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

  /* ================= TO'Y / ZAL ================= */

  function goldText(ctx, L, R, P, alpha, extra) {
    if (R.noText || alpha <= 0) return;
    const fill = goldFill(ctx, L.cy - L.blockH / 2, L.cy + L.blockH / 2, R);
    L.rows.forEach((row) => glyph(ctx, row.text, row.x, row.y, row.w, R, L, Object.assign({ scale: 1, alpha, fill }, extra || {})));
    shimmer(ctx, L, R, P, alpha * 0.8);
  }

  DRAW.w_names = function (ctx, L, R, P) {
    const k = E.outCubic(P.inP(0, P.inD * 1.4)), o = E.inCubic(P.out);
    const a = k * (1 - o);
    goldText(ctx, L, R, P, a, { blur: (1 - k) * L.size * 0.12, scale: 1.06 - 0.06 * k });
    const half = Math.max(L.blockW * 0.55, L.size * 2.2);
    const yl = L.cy + L.blockH / 2 + L.size * 0.15;
    ornamentLine(ctx, L.cx, yl, half, R, P.inP(P.inD * 0.5, P.inD) * (1 - o), Math.max(1.2, L.size * 0.025));
    subLine(ctx, R, L, L.cx, yl + L.size * 0.45, E.outCubic(P.inP(P.inD * 0.8, P.inD)) * (1 - o));
    const b = { x: L.left - L.size, y: L.cy - L.blockH / 2 - L.size * 0.5, w: L.blockW + L.size * 2, h: L.blockH + L.size * 1.6 };
    sparkles(ctx, b, P, Math.round(10 + 14 * (R.density || 0.5)), R.accent, L.size * 0.22);
  };

  DRAW.w_frame = function (ctx, L, R, P, W, H) {
    const o = E.inCubic(P.out);
    const fw = Math.min(W * 0.84, Math.max(L.blockW + L.size * 3, W * 0.55)), fh = Math.min(H * 0.6, L.blockH + L.size * 3.6);
    const fx = L.cx - fw / 2, fy = L.cy - fh / 2 + (R.sub ? L.size * 0.3 : 0);
    withAlpha(ctx, 1 - o, () => goldFrame(ctx, fx, fy, fw, fh, R, E.inOutCubic(P.inP(0, P.inD * 1.6)), Math.max(1.5, L.size * 0.035)));
    const tk = E.outCubic(P.inP(P.inD * 0.7, P.inD));
    goldText(ctx, L, R, P, tk * (1 - o), { dy: (1 - tk) * L.size * 0.2 });
    subLine(ctx, R, L, L.cx, L.cy + L.blockH / 2 + L.size * 0.5, E.outCubic(P.inP(P.inD, P.inD)) * (1 - o));
  };

  DRAW.w_monogram = function (ctx, L, R, P) {
    const o = E.inCubic(P.out);
    const rad = Math.max(L.blockW, L.blockH) * 0.75 + L.size * 0.4;
    const k = E.inOutCubic(P.inP(0, P.inD * 1.6));
    const n = 44;
    ctx.save(); ctx.globalAlpha *= 1 - o;
    const g = goldFill(ctx, L.cy - rad, L.cy + rad, R);
    ctx.fillStyle = g; ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(1, L.size * 0.025);
    ctx.beginPath(); ctx.arc(L.cx, L.cy, rad * 0.86, -Math.PI / 2, -Math.PI / 2 + TAU * k); ctx.stroke();
    for (let i = 0; i < n * k; i++) {
      const ang = -Math.PI / 2 + (i / n) * TAU;
      const side = i % 2 ? 1 : -1;
      const lx = L.cx + Math.cos(ang) * rad, ly = L.cy + Math.sin(ang) * rad;
      ctx.save(); ctx.translate(lx, ly); ctx.rotate(ang + Math.PI / 2 + side * 0.6);
      ctx.beginPath(); ctx.ellipse(0, -L.size * 0.12 * side, L.size * 0.07, L.size * 0.18, 0, 0, TAU); ctx.fill();
      ctx.restore();
      if (i % 6 === 3) { ctx.beginPath(); ctx.arc(L.cx + Math.cos(ang) * rad * 1.08, L.cy + Math.sin(ang) * rad * 1.08, L.size * 0.045, 0, TAU); ctx.fill(); }
    }
    ctx.restore();
    const tk = E.outCubic(P.inP(P.inD * 0.6, P.inD));
    goldText(ctx, L, R, P, tk * (1 - o), { scale: 0.9 + 0.1 * tk });
    subLine(ctx, R, L, L.cx, L.cy + rad + L.size * 0.6, E.outCubic(P.inP(P.inD, P.inD)) * (1 - o));
  };

  DRAW.w_hearts = function (ctx, L, R, P, W, H) {
    const o = E.inCubic(P.out);
    const n = Math.round(10 + 30 * (R.density || 0.5));
    for (let i = 0; i < n; i++) {
      const sp = 0.08 + hash(i, 1) * 0.12;
      const yy = 1.1 - ((hash(i, 2) + P.t * sp) % 1.25);
      const x = (hash(i, 3) + Math.sin(P.t * (0.6 + hash(i, 4)) + i) * 0.03) * W;
      const s = L.size * (0.35 + hash(i, 5) * 0.6);
      ctx.save(); ctx.globalAlpha *= (0.35 + 0.5 * hash(i, 6)) * Math.min(1, P.t * 1.5) * (1 - o);
      ctx.fillStyle = i % 3 ? R.color2 : R.accent; ctx.shadowColor = rgba(R.color2, 0.6); ctx.shadowBlur = s * 0.4;
      heart(ctx, x, yy * H, s, Math.sin(P.t + i) * 0.3);
      ctx.restore();
    }
    const k = E.outCubic(P.inP(P.inD * 0.3, P.inD));
    L.rows.forEach((row) => !R.noText && glyph(ctx, row.text, row.x, row.y, row.w, Object.assign({}, R, { glow: 0.6 }), L, { scale: 0.95 + 0.05 * E.outBack(k), alpha: k * (1 - o) }));
    subLine(ctx, R, L, L.cx, L.cy + L.blockH / 2 + L.size * 0.4, E.outCubic(P.inP(P.inD * 0.8, P.inD)) * (1 - o), { fill: R.color });
  };

  DRAW.w_welcome = function (ctx, L, R, P, W, H) {
    const o = E.inCubic(P.out);
    const n = Math.round(6 + 14 * (R.density || 0.5));
    for (let i = 0; i < n; i++) {
      const x = L.cx + (hash(i, 1) - 0.5) * Math.max(L.blockW * 1.6, W * 0.6) + Math.sin(P.t * 0.5 + i) * L.size * 0.3;
      const y = L.cy + (hash(i, 2) - 0.5) * L.blockH * 3;
      const r = L.size * (0.4 + hash(i, 3) * 1.1);
      const a = (0.15 + 0.3 * hash(i, 4)) * (0.6 + 0.4 * Math.sin(P.t * (1 + hash(i, 5)) + i)) * Math.min(1, P.t / P.inD) * (1 - o);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(R.accent, a)); g.addColorStop(0.8, rgba(R.accent, a * 0.6)); g.addColorStop(1, rgba(R.accent, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
    const k = E.outCubic(P.inP(0, P.inD * 1.3));
    goldText(ctx, L, Object.assign({}, R, { glow: 0.5 }), P, k * (1 - o), { blur: (1 - k) * L.size * 0.15 });
    subLine(ctx, R, L, L.cx, L.cy + L.blockH / 2 + L.size * 0.45, E.outCubic(P.inP(P.inD * 0.8, P.inD)) * (1 - o), { upper: false, italic: true, spacing: 0.06, scale: 0.42, fill: R.color });
  };

  DRAW.w_date = function (ctx, L, R, P) {
    const b = box(L, R, 1.4, R.sub ? 1.5 : 1.0);
    const k = E.outCubic(P.inP(0, P.inD)), o = E.inCubic(P.out);
    withAlpha(ctx, k * (1 - o), () => {
      ctx.save(); popTransform(ctx, b.cx, b.cy, 0.95 + 0.05 * k);
      ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = L.size * 0.9; ctx.shadowOffsetY = L.size * 0.2;
      rr(ctx, b.x, b.y, b.w, b.h, L.size * 0.15); ctx.fillStyle = "rgba(255,250,240,0.16)"; ctx.fill(); ctx.restore();
      const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h); g.addColorStop(0, "rgba(255,250,240,0.26)"); g.addColorStop(1, "rgba(255,250,240,0.1)");
      rr(ctx, b.x, b.y, b.w, b.h, L.size * 0.15); ctx.fillStyle = g; ctx.fill();
      ctx.restore();
      goldFrame(ctx, b.x + L.size * 0.25, b.y + L.size * 0.25, b.w - L.size * 0.5, b.h - L.size * 0.5, R, E.inOutCubic(P.inP(P.inD * 0.2, P.inD * 1.2)), Math.max(1, L.size * 0.022));
    });
    goldText(ctx, L, R, P, E.outCubic(P.inP(P.inD * 0.5, P.inD)) * (1 - o));
    subLine(ctx, R, L, b.cx, L.cy + L.blockH / 2 + L.size * 0.5, E.outCubic(P.inP(P.inD * 0.9, P.inD)) * (1 - o));
  };

  /* ================= MATNSIZ FONLAR (overlay) ================= */

  const fadeIO = (P) => Math.min(1, P.t / 0.6) * (1 - E.inCubic(P.out));
  const count = (R, lo, hi) => Math.round(lo + (hi - lo) * clamp(R.density == null ? 0.5 : R.density, 0, 1));

  DRAW.bg_bokeh = function (ctx, L, R, P, W, H) {
    const n = count(R, 10, 50), base = Math.min(W, H);
    for (let i = 0; i < n; i++) {
      const x = ((hash(i, 1) + P.t * (hash(i, 2) - 0.5) * 0.03) % 1 + 1) % 1 * W;
      const y = ((hash(i, 3) + P.t * (hash(i, 4) - 0.6) * 0.02) % 1 + 1) % 1 * H;
      const r = base * (0.02 + hash(i, 5) * 0.07);
      const a = (0.18 + 0.35 * hash(i, 6)) * (0.55 + 0.45 * Math.sin(P.t * (0.8 + hash(i, 7)) + i * 2)) * fadeIO(P);
      const c = i % 2 ? R.color : R.color2;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(c, a * 0.55)); g.addColorStop(0.82, rgba(c, a * 0.75)); g.addColorStop(0.92, rgba(c, a)); g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
  };

  DRAW.bg_golddust = function (ctx, L, R, P, W, H) {
    const n = count(R, 40, 220), base = Math.min(W, H);
    for (let i = 0; i < n; i++) {
      const sp = 0.02 + hash(i, 1) * 0.05;
      const x = (hash(i, 2) + Math.sin(P.t * 0.7 + i) * 0.01) * W;
      const y = ((hash(i, 3) + P.t * sp) % 1) * H;
      const tw = Math.pow(Math.max(0, Math.sin(P.t * (2 + hash(i, 4) * 4) + i)), 3);
      const a = (0.35 + 0.65 * tw) * fadeIO(P);
      if (hash(i, 5) < 0.12) star(ctx, x, y, base * (0.008 + 0.014 * tw), R.color2, a);
      else { ctx.fillStyle = rgba(i % 3 ? R.color : R.color2, a); ctx.beginPath(); ctx.arc(x, y, base * (0.0015 + hash(i, 6) * 0.003), 0, TAU); ctx.fill(); }
    }
  };

  DRAW.bg_hearts = function (ctx, L, R, P, W, H) {
    const n = count(R, 8, 45), base = Math.min(W, H);
    for (let i = 0; i < n; i++) {
      const sp = 0.06 + hash(i, 1) * 0.1;
      const yy = 1.15 - ((hash(i, 2) + P.t * sp) % 1.3);
      const x = (hash(i, 3) + Math.sin(P.t * (0.6 + hash(i, 4)) + i) * 0.03) * W;
      const s = base * (0.025 + hash(i, 5) * 0.05);
      ctx.save(); ctx.globalAlpha *= (0.4 + 0.5 * hash(i, 6)) * fadeIO(P);
      ctx.fillStyle = i % 3 ? R.color : R.color2;
      heart(ctx, x, yy * H, s, Math.sin(P.t + i) * 0.35);
      ctx.restore();
    }
  };

  DRAW.bg_petals = function (ctx, L, R, P, W, H) {
    const n = count(R, 10, 60), base = Math.min(W, H);
    for (let i = 0; i < n; i++) {
      const sp = 0.05 + hash(i, 1) * 0.08;
      const yy = ((hash(i, 2) + P.t * sp) % 1.2) - 0.1;
      const x = (hash(i, 3) + Math.sin(P.t * (0.8 + hash(i, 4)) + i * 3) * 0.05) * W;
      const s = base * (0.012 + hash(i, 5) * 0.022);
      const rot = P.t * (1 + hash(i, 6) * 2) + i;
      ctx.save(); ctx.globalAlpha *= 0.9 * fadeIO(P); ctx.translate(x, yy * H); ctx.rotate(rot); ctx.scale(1, 0.55 + 0.45 * Math.cos(rot * 1.3));
      const g = ctx.createLinearGradient(-s, 0, s, 0); g.addColorStop(0, R.color); g.addColorStop(1, R.color2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, -s); ctx.bezierCurveTo(s * 1.1, -s * 0.8, s * 0.9, s * 0.9, 0, s); ctx.bezierCurveTo(-s * 0.9, s * 0.9, -s * 1.1, -s * 0.8, -s * 0.15, -s * 0.85);
      ctx.lineTo(0, -s * 0.6); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  };

  DRAW.bg_confetti = function (ctx, L, R, P, W, H) {
    const n = count(R, 30, 160), base = Math.min(W, H), cols = [R.color, R.color2, R.accent, "#ffffff"];
    for (let i = 0; i < n; i++) {
      const delay = hash(i, 1) * 1.5, tt = Math.max(0, P.t - delay);
      const x = (hash(i, 2) + Math.sin(tt * 2 + i) * 0.02) * W;
      const y = (-0.05 + tt * (0.12 + hash(i, 3) * 0.15)) % 1.1 * H;
      if (P.t < delay) continue;
      const s = base * (0.006 + hash(i, 4) * 0.008), spin = tt * (4 + hash(i, 5) * 6) + i;
      ctx.save(); ctx.globalAlpha *= fadeIO(P); ctx.translate(x, y); ctx.rotate(spin * 0.4); ctx.scale(Math.cos(spin), 1);
      ctx.fillStyle = cols[i % cols.length];
      if (i % 4 === 0) { ctx.beginPath(); ctx.arc(0, 0, s * 0.7, 0, TAU); ctx.fill(); } else ctx.fillRect(-s, -s * 0.45, s * 2, s * 0.9);
      ctx.restore();
    }
  };

  DRAW.bg_lightleak = function (ctx, L, R, P, W, H) {
    const a0 = (0.35 + 0.35 * clamp(R.density, 0, 1)) * fadeIO(P);
    [[R.color, 0, 0.2], [R.color2, 1, 0.75], [R.color, 0.85, 0.05]].forEach(([c, sx, sy], i) => {
      const x = (sx + Math.sin(P.t * 0.35 + i * 2) * 0.18) * W, y = (sy + Math.cos(P.t * 0.28 + i) * 0.15) * H;
      const r = Math.max(W, H) * (0.45 + 0.1 * Math.sin(P.t * 0.5 + i));
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(c, a0)); g.addColorStop(0.45, rgba(c, a0 * 0.45)); g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    });
  };

  DRAW.bg_framegold = function (ctx, L, R, P, W, H) {
    const m = Math.min(W, H) * 0.045;
    withAlpha(ctx, 1 - E.inCubic(P.out), () => goldFrame(ctx, m, m, W - 2 * m, H - 2 * m, R, E.inOutCubic(P.inP(0, P.inD * 2)), Math.max(1.5, Math.min(W, H) * 0.004)));
    sparkles(ctx, { x: m, y: m, w: W - 2 * m, h: H - 2 * m }, P, count(R, 6, 24), R.accent, Math.min(W, H) * 0.015);
  };

  DRAW.bg_vignette = function (ctx, L, R, P, W, H) {
    const a = (0.35 + 0.55 * clamp(R.density, 0, 1)) * Math.min(1, P.t / 0.4) * (1 - E.inCubic(P.out));
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.58);
    g.addColorStop(0, rgba(R.color, 0)); g.addColorStop(1, rgba(R.color, a));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  };

  DRAW.bg_snow = function (ctx, L, R, P, W, H) {
    const n = count(R, 40, 260), base = Math.min(W, H);
    for (let i = 0; i < n; i++) {
      const sp = 0.04 + hash(i, 1) * 0.08;
      const y = ((hash(i, 2) + P.t * sp) % 1) * H;
      const x = (hash(i, 3) + Math.sin(P.t * (0.5 + hash(i, 4)) + i) * 0.02) * W;
      const r = base * (0.002 + hash(i, 5) * 0.005);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(R.color, 0.95 * fadeIO(P))); g.addColorStop(1, rgba(R.color, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
  };

  DRAW.bg_sparkles = function (ctx, L, R, P, W, H) {
    const n = count(R, 20, 90), base = Math.min(W, H);
    const cx = R.x * W, cy = R.y * H;
    for (let i = 0; i < n; i++) {
      const delay = hash(i, 1) * Math.max(0.2, P.D - 1.2);
      const tt = P.t - delay;
      if (tt < 0 || tt > 1.2) continue;
      const ang = hash(i, 2) * TAU, dist = base * (0.05 + hash(i, 3) * 0.35) * E.outCubic(tt / 1.2);
      const a = (1 - tt / 1.2) * (1 - E.inCubic(P.out));
      star(ctx, cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist - tt * base * 0.05, base * (0.01 + hash(i, 4) * 0.018), i % 2 ? R.color : R.color2, a);
    }
  };

  /* ================= katalog ================= */

  const PLATE = { font: "Segoe UI", weight: 800, upper: false, size: 0.055, shadow: 0.35, stroke: 0, glow: 0 };
  const WED = { font: "Gabriola", weight: 400, upper: false, size: 0.11, shadow: 0.8, stroke: 0, glow: 0, color: "#f6d98b", color2: "#b8862f", accent: "#fff1c4", density: 0.5 };
  const BG = { text: "", duration: 6, x: 0.5, y: 0.5 };
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

    T("w_names", "wedding", "Oltin ismlar", "Kelin-kuyov ismlari, oltin chiziq va uchqunlar", Object.assign({}, WED, { text: "Aziz & Madina", sub: "NIKOH TO'YI · 2026" }), { sub: true }),
    T("w_frame", "wedding", "Oltin ramka", "Naqshli oltin ramka chizilib, ichida ismlar", Object.assign({}, WED, { text: "Aziz & Madina", sub: "12 · 09 · 2026" }), { sub: true }),
    T("w_monogram", "wedding", "Monogramma", "Barglardan gulchambar, ichida bosh harflar", Object.assign({}, WED, { text: "A & M", sub: "12 · 09 · 2026", size: 0.1 }), { sub: true }),
    T("w_hearts", "wedding", "Yurakchalar", "Uchib yuradigan yurakchalar va nafis matn", Object.assign({}, WED, { text: "Sevgi bilan", sub: "", color: "#ffffff", color2: "#ff5c8a", accent: "#ffd1dc" }), { sub: true }),
    T("w_welcome", "wedding", "Xush kelibsiz", "Bokeh nurlar fonida katta nafis sarlavha", Object.assign({}, WED, { text: "Xush kelibsiz", sub: "Bizning baxtli kunimizga", color: "#fff4dc", color2: "#c99a4a", accent: "#ffd9a0" }), { sub: true }),
    T("w_date", "wedding", "Sana kartasi", "Shaffof karta, oltin ramka, ismlar va sana", Object.assign({}, WED, { text: "Aziz & Madina", sub: "12 SENTYABR 2026", size: 0.09 }), { sub: true }),

    T("bg_bokeh", "bg", "Bokeh nurlar", "Yumshoq yorug' doiralar", Object.assign({}, BG, { color: "#ffd27a", color2: "#ff9ec4" })),
    T("bg_golddust", "bg", "Oltin zarrachalar", "Yaltirab tushayotgan oltin chang", Object.assign({}, BG, { color: "#ffd27a", color2: "#fff3c4", density: 0.6 })),
    T("bg_hearts", "bg", "Yurakchalar", "Ko'tarilayotgan yurakchalar", Object.assign({}, BG, { color: "#ff4d7d", color2: "#ffd1dc" })),
    T("bg_petals", "bg", "Gulbarglar", "Tushayotgan atirgul barglari", Object.assign({}, BG, { color: "#e8364f", color2: "#ff8fa3" })),
    T("bg_confetti", "bg", "Konfetti", "Rang-barang konfetti yomg'iri", Object.assign({}, BG, { color: "#ffcc00", color2: "#ff3d7f", accent: "#3ad1ff", density: 0.6 })),
    T("bg_lightleak", "bg", "Light leak", "Iliq nur dog'lari chetlardan", Object.assign({}, BG, { color: "#ff8a3d", color2: "#ff3d8a" })),
    T("bg_framegold", "bg", "Oltin ramka (zal)", "Kadr chetida naqshli oltin ramka", Object.assign({}, BG, { color: "#f6d98b", color2: "#b8862f", accent: "#fff1c4" })),
    T("bg_vignette", "bg", "Vinyetka", "Chetlari qorong'i - kinematik", Object.assign({}, BG, { color: "#000000", density: 0.6 })),
    T("bg_snow", "bg", "Qor", "Sekin yog'ayotgan qor", Object.assign({}, BG, { color: "#ffffff" })),
    T("bg_sparkles", "bg", "Sehrli uchqunlar", "Markazdan sochilayotgan uchqunlar", Object.assign({}, BG, { color: "#ffe9a8", color2: "#ffffff" })),
  ];

  X.register(LIST, DRAW);
})(typeof window !== "undefined" ? window : globalThis);
