/*
 * GeminiCut - animatsion matn: 2D shablonlar va 3D suyuq (liquid) matnlar.
 *
 * Plagin animatsiyani o'zi chizadi (Canvas 2D va WebGL), har bir kadrni shaffof PNG qilib
 * yozadi va ketma-ketlikni timeline'ga qo'yadi (Premiere ham, Resolve ham bir xil).
 * Hech qanday tashqi dastur yoki shrift paketi kerak emas - Windows shriftlari ishlatiladi.
 *
 * Retsept (recipe) - matnning barcha sozlamalari; kadrlar papkasida recipe.json saqlanadi,
 * shuning uchun keyin "Tahrirlash" bilan o'zgartirib, qayta yaratish mumkin.
 */
(function (root) {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mix = (a, b, k) => a + (b - a) * k;
  const E = {
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inCubic: (t) => t * t * t,
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
    outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    spring: (t) => (t >= 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(11 * t)),
  };

  /* Windows'da bor shriftlar (yo'q bo'lsa brauzer o'xshashini oladi) */
  const FONTS = ["Arial Black", "Impact", "Segoe UI", "Segoe UI Black", "Bahnschrift", "Arial", "Montserrat", "Calibri",
    "Trebuchet MS", "Verdana", "Georgia", "Times New Roman", "Cambria", "Franklin Gothic Medium", "Century Gothic", "Comic Sans MS", "Consolas"];

  const DEFAULT = {
    v: 1, template: "pop", text: "GEMINICUT\nSTUDIO", sub: "", font: "Arial Black", weight: 800, italic: false, upper: true,
    size: 0.075, spacing: 0, color: "#ffffff", color2: "#ffd34d", accent: "#7b6cff",
    stroke: 0, shadow: 0.6, glow: 0, x: 0.5, y: 0.5, align: "center", duration: 3, speed: 1,
    // 3D
    material: "gold", depth: 0.35, bevel: 0.06, rot: 35, liquid: 0.6, flow: 1, drops: false,
  };

  /* ============== shablonlar katalogi ============== */
  const TEMPLATES = [
    { id: "pop", kind: "2d", name: "Pop", desc: "So'zlar sakrab chiqadi" },
    { id: "rise", kind: "2d", name: "Pastdan chiqish", desc: "Maska ichidan silliq ko'tariladi" },
    { id: "typewriter", kind: "2d", name: "Yozuv mashinkasi", desc: "Harfma-harf, kursor bilan", set: { font: "Consolas", weight: 700, upper: false } },
    { id: "blur", kind: "2d", name: "Blur kirish", desc: "Harflar xiralikdan chiqadi", set: { font: "Segoe UI", weight: 300, upper: false, spacing: 0.08 } },
    { id: "kinetic", kind: "2d", name: "Kinetik zoom", desc: "So'zlar navbatma-navbat, katta zarba bilan (Reels)", set: { size: 0.11 } },
    { id: "wave", kind: "2d", name: "To'lqin", desc: "Harflar to'lqin bo'lib sakraydi" },
    { id: "highlight", kind: "2d", name: "Marker", desc: "Orqasidan rangli marker o'tadi", set: { color: "#111111", accent: "#ffd34d", shadow: 0 } },
    { id: "neon", kind: "2d", name: "Neon", desc: "Yonib-o'chib yonadigan neon", set: { color: "#ffffff", color2: "#ff2bd6", glow: 1, shadow: 0, font: "Segoe UI", weight: 600 } },
    { id: "glitch", kind: "2d", name: "Glitch", desc: "RGB siljish va raqamli shovqin", set: { font: "Bahnschrift", weight: 700 } },
    { id: "shine", kind: "2d", name: "Yaltiroq gradient", desc: "Gradient va yaltirash chizig'i", set: { color: "#ffe08a", color2: "#ff7a18" } },
    { id: "split", kind: "2d", name: "Ikkiga ochilish", desc: "Markazdan yuqoriga-pastga ochiladi", set: { accent: "#ffffff" } },
    { id: "lowerthird", kind: "2d", name: "Lower third", desc: "Ism va lavozim, rangli chiziq bilan",
      set: { text: "Dilshod Rahimov", sub: "Bosh muharrir", upper: false, font: "Segoe UI", weight: 700, size: 0.045, x: 0.08, y: 0.8, align: "left", accent: "#7b6cff" } },
    { id: "liquid_gold", kind: "3d", name: "Suyuq oltin", desc: "Erigan oltin, oqib turadigan sirt", set: { size: 0.13, material: "gold", color: "#ffc94a", color2: "#ff8a00", liquid: 0.65 } },
    { id: "liquid_chrome", kind: "3d", name: "Suyuq xrom", desc: "Simob kabi oynali metall", set: { size: 0.13, material: "chrome", color: "#dfe6f0", color2: "#8aa0ff", liquid: 0.55 } },
    { id: "jelly", kind: "3d", name: "Jele", desc: "Yumshoq, chayqaladigan rangli jele", set: { size: 0.13, material: "jelly", color: "#ff3d7f", color2: "#ffd0e0", liquid: 0.9, bevel: 0.12 } },
    { id: "glass", kind: "3d", name: "Suyuq shisha", desc: "Shaffof shisha, nur sinishi", set: { size: 0.13, material: "glass", color: "#7fd4ff", color2: "#ffffff", liquid: 0.35 } },
    { id: "drops", kind: "3d", name: "Tomchilardan yig'ilish", desc: "Suyuq tomchilar qo'shilib matnga aylanadi", set: { size: 0.13, material: "water", color: "#2f9bff", color2: "#b8f0ff", liquid: 0.7, drops: true } },
    { id: "lava", kind: "3d", name: "Lava", desc: "Qizigan, yorug'lik chiqaradigan lava", set: { size: 0.13, material: "lava", color: "#ff5a1f", color2: "#ffd36b", liquid: 0.75 } },
    { id: "candy", kind: "3d", name: "3D Candy", desc: "Yaltiroq plastik, gradient rang", set: { size: 0.13, material: "candy", color: "#7b5cff", color2: "#00d5ff", liquid: 0.2, bevel: 0.1 } },
  ];
  const byId = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];

  function recipeFor(id, base) {
    const t = byId(id);
    return Object.assign({}, DEFAULT, base || {}, t.set || {}, { template: t.id });
  }

  /* ============== umumiy: o'lchash va joylash ============== */

  function fontCss(R, px) {
    const fam = String(R.font || "Arial").replace(/["\\]/g, "");
    return `${R.italic ? "italic " : ""}${R.weight || 700} ${Math.max(1, px).toFixed(1)}px "${fam}", "Segoe UI", Arial, sans-serif`;
  }

  /* Matnni qatorlar, so'zlar va harflarga bo'lib, har birining joyini hisoblaydi */
  function layout(ctx, R, W, H) {
    const raw = R.upper ? String(R.text || "").toLocaleUpperCase() : String(R.text || "");
    const lines = raw.split(/\r?\n/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!lines.length) lines.push(" ");
    let size = R.size * H;
    const measure = (s, sp) => { let w = 0; for (const ch of s) w += ctx.measureText(ch).width + sp; return w - sp; };
    ctx.font = fontCss(R, size);
    let sp = R.spacing * size;
    const widest = Math.max(...lines.map((l) => measure(l, sp)));
    const maxW = W * (R.align === "center" ? 0.92 : 0.86);
    if (widest > maxW) { size *= maxW / widest; ctx.font = fontCss(R, size); sp = R.spacing * size; }
    const lh = size * 1.14;
    const cx = R.x * W, cy = R.y * H, blockH = lh * lines.length;
    const letters = [], words = [], rows = [];
    let li = 0, gi = 0, wi = 0;
    for (const line of lines) {
      const w = measure(line, sp);
      const x0 = R.align === "left" ? cx : R.align === "right" ? cx - w : cx - w / 2;
      const y = cy - blockH / 2 + lh * (li + 0.5);
      rows.push({ text: line, x: x0, y, w, li });
      let x = x0, word = null;
      for (const ch of line) {
        const cw = ctx.measureText(ch).width;
        if (ch === " ") { if (word) { words.push(word); word = null; wi++; } }
        else {
          if (!word) word = { text: "", x, y, w: 0, li, wi, first: gi };
          word.text += ch; word.w = x + cw - word.x;
          letters.push({ ch, x, y, w: cw, li, wi, i: gi++ });
        }
        x += cw + sp;
      }
      if (word) { words.push(word); wi++; }
      li++;
    }
    return { size, font: fontCss(R, size), lh, rows, words, letters, cx, cy, blockH, spacing: sp,
      blockW: Math.max(...rows.map((r) => r.w)), left: Math.min(...rows.map((r) => r.x)) };
  }

  /* Bir xil uslubda matn chizish: soya, kontur, glow, to'ldirish */
  function paint(ctx, s, x, y, R, L, fill) {
    const sz = L.size;
    ctx.lineJoin = "round";
    if (R.glow > 0) {
      ctx.save();
      ctx.shadowColor = R.color2; ctx.shadowBlur = sz * 0.45 * R.glow;
      ctx.fillStyle = R.color2; ctx.globalAlpha *= 0.85;
      ctx.fillText(s, x, y); ctx.fillText(s, x, y);
      ctx.restore();
    }
    if (R.shadow > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${(0.55 * R.shadow).toFixed(3)})`;
      ctx.shadowBlur = sz * 0.14; ctx.shadowOffsetY = sz * 0.05;
      ctx.fillStyle = fill || R.color; ctx.fillText(s, x, y);
      ctx.restore();
    }
    if (R.stroke > 0) { ctx.lineWidth = sz * 0.12 * R.stroke; ctx.strokeStyle = "rgba(10,10,14,0.95)"; ctx.strokeText(s, x, y); }
    ctx.fillStyle = fill || R.color;
    ctx.fillText(s, x, y);
  }

  /* Bitta harf/so'zni transformatsiya bilan chizish */
  function glyph(ctx, s, x, y, w, R, L, o) {
    if (o.alpha <= 0.001 || o.scale <= 0.001) return;
    ctx.save();
    ctx.globalAlpha *= clamp(o.alpha, 0, 1);
    ctx.translate(x + w / 2 + (o.dx || 0), y + (o.dy || 0));
    if (o.rot) ctx.rotate(o.rot);
    if (o.scale !== 1 || o.sy) ctx.scale(o.scale, o.scale * (o.sy || 1));
    if (o.blur > 0.3) ctx.filter = `blur(${o.blur.toFixed(1)}px)`;
    paint(ctx, s, -w / 2, 0, R, L, o.fill);
    ctx.restore();
  }

  /* Kirish/chiqish fazalari: kirish ~0.7s, chiqish ~0.45s (tezlik bilan) */
  function phases(R, t) {
    const sp = clamp(R.speed || 1, 0.25, 4);
    const D = Math.max(0.5, R.duration);
    const inD = Math.min(0.75 / sp, D * 0.45), outD = Math.min(0.45 / sp, D * 0.3);
    const outStart = D - outD;
    return {
      D, inD, outD, t,
      inP: (delay, dur) => clamp((t - delay) / Math.max(1e-3, dur), 0, 1),
      out: clamp((t - outStart) / outD, 0, 1),
      stag: (i, n, part) => (n > 1 ? (i / (n - 1)) * inD * (part || 0.55) : 0),
      each: inD * 0.5,
    };
  }

  /* ============== 2D shablonlar ============== */
  const DRAW2D = {
    pop(ctx, L, R, P) {
      const n = L.words.length;
      L.words.forEach((w, i) => {
        const k = P.inP(P.stag(i, n, 0.6), P.each);
        const s = E.outBack(k) * (1 - E.inCubic(P.out) * 0.6);
        glyph(ctx, w.text, w.x, w.y, w.w, R, L, { scale: s, alpha: Math.min(1, k * 3) * (1 - P.out), dy: (1 - k) * L.size * 0.2 });
      });
    },
    rise(ctx, L, R, P) {
      L.rows.forEach((row) => {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, row.y - L.lh * 0.62, ctx.canvas.width, L.lh * 1.24); ctx.clip();
        L.words.filter((w) => w.li === row.li).forEach((w, j) => {
          const k = E.outExpo(P.inP(P.stag(w.wi, L.words.length, 0.5), P.each * 1.2));
          const o = E.inCubic(P.out);
          glyph(ctx, w.text, w.x, w.y, w.w, R, L, { scale: 1, alpha: 1, dy: (1 - k) * L.lh * 1.1 - o * L.lh * 1.1 });
        });
        ctx.restore();
      });
    },
    typewriter(ctx, L, R, P) {
      const n = L.letters.length;
      const typeDur = Math.min(P.D * 0.55, n * 0.06 / (R.speed || 1));
      const shown = Math.floor(clamp(P.t / Math.max(1e-3, typeDur), 0, 1) * n + 1e-6);
      const a = 1 - P.out;
      L.letters.forEach((g) => { if (g.i < shown) glyph(ctx, g.ch, g.x, g.y, g.w, R, L, { scale: 1, alpha: a }); });
      const last = L.letters[Math.max(0, shown - 1)];
      const blink = shown >= n ? (Math.floor(P.t * 2.2) % 2 === 0) : true;
      if (last && blink && a > 0) {
        ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = R.color2;
        const x = shown ? last.x + last.w + L.size * 0.06 : L.letters[0].x;
        ctx.fillRect(x, last.y - L.size * 0.45, Math.max(2, L.size * 0.08), L.size * 0.9);
        ctx.restore();
      }
    },
    blur(ctx, L, R, P) {
      const n = L.letters.length;
      L.letters.forEach((g) => {
        const k = E.outCubic(P.inP(P.stag(g.i, n, 0.7), P.each * 1.3));
        const o = E.inCubic(clamp(P.out * 1.4 - (g.i / n) * 0.4, 0, 1));
        glyph(ctx, g.ch, g.x, g.y, g.w, R, L, { scale: 1 + (1 - k) * 0.25, alpha: k * (1 - o), blur: (1 - k) * L.size * 0.18 + o * L.size * 0.15 });
      });
    },
    kinetic(ctx, L, R, P) {
      // So'zlar markazda birin-ketin; oxirida hammasi birga
      const n = L.words.length;
      const slot = (P.D - P.outD) / (n + 1);
      const idx = Math.min(n, Math.floor(P.t / slot));
      if (idx < n) {
        const w = L.words[idx];
        const k = clamp((P.t - idx * slot) / Math.min(slot, 0.35), 0, 1);
        ctx.save(); ctx.font = fontCss(R, L.size * 1.35);
        const ww = ctx.measureText(w.text).width;
        glyph(ctx, w.text, L.cx - ww / 2, L.cy, ww, R, Object.assign({}, L, { size: L.size * 1.35 }), { scale: 1.6 - 0.6 * E.outBack(k), alpha: Math.min(1, k * 4), rot: (1 - k) * (idx % 2 ? 0.08 : -0.08) });
        ctx.restore();
      } else {
        const k = clamp((P.t - n * slot) / 0.3, 0, 1);
        L.words.forEach((w) => glyph(ctx, w.text, w.x, w.y, w.w, R, L, { scale: (0.7 + 0.3 * E.outBack(k)) * (1 - P.out * 0.3), alpha: k * (1 - P.out) }));
      }
    },
    wave(ctx, L, R, P) {
      const n = L.letters.length;
      L.letters.forEach((g) => {
        const k = E.outBack(P.inP(P.stag(g.i, n, 0.7), P.each));
        const wv = Math.sin(P.t * 5 - g.i * 0.45) * L.size * 0.08 * Math.min(1, P.t / P.inD);
        glyph(ctx, g.ch, g.x, g.y, g.w, R, L, { scale: k, alpha: Math.min(1, k * 2) * (1 - P.out), dy: wv - P.out * L.size * 0.6 * (g.i % 2 ? 1 : -1) * 0.3 });
      });
    },
    highlight(ctx, L, R, P) {
      L.rows.forEach((row, i) => {
        const k = E.inOutCubic(P.inP(i * 0.12, P.inD * 0.9));
        const o = E.inCubic(P.out);
        const pad = L.size * 0.18;
        ctx.save(); ctx.fillStyle = R.accent;
        const x0 = row.x - pad, w = (row.w + pad * 2);
        const from = o > 0 ? x0 + w * o : x0, to = x0 + w * k;
        if (to > from) ctx.fillRect(from, row.y - L.size * 0.58, to - from, L.size * 1.16);
        ctx.restore();
        const tk = clamp((k - 0.35) / 0.65, 0, 1);
        L.words.filter((w2) => w2.li === row.li).forEach((w2) => glyph(ctx, w2.text, w2.x, w2.y, w2.w, R, L, { scale: 1, alpha: tk * (1 - o), dy: (1 - E.outCubic(tk)) * L.size * 0.15 }));
      });
    },
    neon(ctx, L, R, P) {
      // Yonish: tasodifiy (lekin kadrga bog'liq - har safar bir xil) miltillash
      const n = L.letters.length;
      L.letters.forEach((g) => {
        const st = P.stag(g.i, n, 0.8);
        const k = P.inP(st, P.each);
        const seed = Math.sin(g.i * 91.7 + Math.floor(P.t * 24) * 13.1) * 43758.5;
        const fl = k >= 1 ? 1 : (seed - Math.floor(seed)) < k ? 1 : 0.15;
        const o = P.out > 0 ? ((Math.sin(g.i * 31.3 + Math.floor(P.t * 24) * 7.7) * 43758.5) % 1 + 1) % 1 > P.out ? 1 : 0 : 1;
        glyph(ctx, g.ch, g.x, g.y, g.w, Object.assign({}, R, { glow: R.glow * fl }), L, { scale: 1, alpha: fl * o * (k > 0 ? 1 : 0) });
      });
    },
    glitch(ctx, L, R, P) {
      const k = E.outCubic(P.inP(0, P.inD));
      const f = Math.floor(P.t * 24);
      const rnd = (s) => { const v = Math.sin(f * 12.9898 + s * 78.233) * 43758.5453; return v - Math.floor(v); };
      const active = k < 1 || P.out > 0 || rnd(1) > 0.9;
      const amp = active ? L.size * 0.08 * (1 - k * 0.7 + P.out * 2) : 0;
      const alpha = Math.min(1, k * 2) * (1 - P.out);
      const draw = (dx, dy, fill, comp) => {
        ctx.save(); ctx.globalCompositeOperation = comp || "source-over";
        L.rows.forEach((row) => { ctx.font = L.font; ctx.textBaseline = "middle"; glyph(ctx, row.text, row.x, row.y, row.w, Object.assign({}, R, { shadow: 0 }), L, { scale: 1, alpha, dx, dy, fill }); });
        ctx.restore();
      };
      if (amp > 0) { draw(-amp * (0.5 + rnd(2)), 0, "#ff2050", "lighter"); draw(amp * (0.5 + rnd(3)), 0, "#20e0ff", "lighter"); }
      draw(0, 0);
      if (amp > 0) {
        // gorizontal kesiklar siljiydi
        for (let s = 0; s < 4; s++) {
          if (rnd(10 + s) < 0.5) continue;
          const y = L.cy - L.blockH / 2 + rnd(20 + s) * L.blockH, hh = L.size * (0.05 + rnd(30 + s) * 0.15);
          const sx = (rnd(40 + s) - 0.5) * amp * 6;
          ctx.save(); ctx.beginPath(); ctx.rect(0, y, ctx.canvas.width, hh); ctx.clip();
          ctx.clearRect(0, y, ctx.canvas.width, hh);
          ctx.translate(sx, 0); draw(0, 0); ctx.restore();
        }
      }
    },
    shine(ctx, L, R, P) {
      const k = E.outCubic(P.inP(0, P.inD));
      const top = L.cy - L.blockH / 2, bot = L.cy + L.blockH / 2;
      const g = ctx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0, R.color); g.addColorStop(1, R.color2);
      const alpha = k * (1 - P.out);
      L.rows.forEach((row) => glyph(ctx, row.text, row.x, row.y, row.w, R, L, { scale: 1, alpha, fill: g, dx: (1 - k) * -L.size * 0.6 }));
      // yaltirash chizig'i (faqat matn ustida)
      const sweep = ((P.t - P.inD * 0.6) / 1.1) % 1.8;
      if (sweep > 0 && sweep < 1 && alpha > 0) {
        const off = document.createElement("canvas"); off.width = ctx.canvas.width; off.height = ctx.canvas.height;
        const o = off.getContext("2d"); o.font = L.font; o.textBaseline = "middle";
        L.rows.forEach((row) => { o.fillStyle = "#fff"; o.fillText(row.text, row.x + (1 - k) * -L.size * 0.6, row.y); });
        o.globalCompositeOperation = "source-in";
        const sx = L.left - L.size + (L.blockW + L.size * 2) * sweep;
        const sg = o.createLinearGradient(sx - L.size * 0.5, top, sx + L.size * 0.5, bot);
        sg.addColorStop(0, "rgba(255,255,255,0)"); sg.addColorStop(0.5, "rgba(255,255,255,0.85)"); sg.addColorStop(1, "rgba(255,255,255,0)");
        o.fillStyle = sg; o.fillRect(0, 0, off.width, off.height);
        ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(off, 0, 0); ctx.restore();
      }
    },
    split(ctx, L, R, P) {
      const k = E.inOutCubic(P.inP(0, P.inD * 1.1));
      const o = E.inOutCubic(P.out);
      const open = k * (1 - o);
      const half = L.blockH / 2 + L.size * 0.2;
      // chiziq
      ctx.save(); ctx.fillStyle = R.accent; ctx.globalAlpha = clamp(k * 3, 0, 1) * (1 - o);
      const lw = (L.blockW + L.size) * E.outCubic(clamp(k * 1.6, 0, 1));
      ctx.fillRect(L.cx - lw / 2, L.cy - Math.max(1, L.size * 0.025) + (open * half) * 0, lw, Math.max(2, L.size * 0.05)); ctx.restore();
      // yuqori va pastki yarmi
      [[-1, L.cy - half, L.cy], [1, L.cy, L.cy + half]].forEach(([dir, a, b]) => {
        ctx.save(); ctx.beginPath(); ctx.rect(0, a, ctx.canvas.width, b - a); ctx.clip();
        L.rows.forEach((row) => glyph(ctx, row.text, row.x, row.y, row.w, R, L, { scale: 1, alpha: 1, dy: -dir * (1 - open) * half }));
        ctx.restore();
      });
    },
    lowerthird(ctx, L, R, P, W, H) {
      const k1 = E.outExpo(P.inP(0, P.inD * 0.8));
      const k2 = E.outCubic(P.inP(P.inD * 0.25, P.inD * 0.8));
      const k3 = E.outCubic(P.inP(P.inD * 0.5, P.inD * 0.8));
      const o = E.inCubic(P.out);
      const bx = R.x * W, by = R.y * H;
      const barH = L.lh * (R.sub ? 1.9 : 1.1);
      ctx.save(); ctx.fillStyle = R.accent; ctx.globalAlpha = 1 - o;
      ctx.fillRect(bx - L.size * 0.4, by - L.lh * 0.6, L.size * 0.14, barH * k1 * (1 - o)); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(bx - L.size * 0.2, 0, W, H); ctx.clip();
      ctx.font = L.font; ctx.textBaseline = "middle";
      const nameW = ctx.measureText(L.rows[0].text).width;
      glyph(ctx, L.rows[0].text, bx, by, nameW, R, L, { scale: 1, alpha: 1 - o, dx: (1 - k2) * -nameW * 0.6 - o * nameW * 0.3 });
      if (R.sub) {
        const subR = Object.assign({}, R, { color: R.color2, weight: 400 });
        const subSize = L.size * 0.62;
        ctx.font = fontCss(subR, subSize);
        const sw = ctx.measureText(R.sub).width;
        glyph(ctx, R.sub, bx, by + L.lh * 0.95, sw, subR, Object.assign({}, L, { size: subSize }), { scale: 1, alpha: k3 * (1 - o), dx: (1 - k3) * -sw * 0.3 });
      }
      ctx.restore();
    },
  };

  /* 2D kadrni chizadi (canvas tozalanadi) */
  function draw2D(canvas, R, t) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const Rr = Object.assign({}, R);
    if (Rr.template === "lowerthird") Rr.text = String(R.text || "").split(/\r?\n/)[0];
    const L = layout(ctx, Rr, W, H);
    ctx.font = L.font;
    ctx.textBaseline = "middle";
    const P = phases(Rr, t);
    (DRAW2D[Rr.template] || DRAW2D.pop)(ctx, L, Rr, P, W, H);
  }

  /* ============== 3D: matn SDF + WebGL raymarching ============== */

  /* Felzenszwalb masofa transformatsiyasi (1D) */
  function edt1d(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1; q < n; q++) {
      let s;
      do { const r = v[k]; s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r); } while (s <= z[k] && --k >= 0);
      k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + f[r]; }
  }
  function edt2d(grid, w, h) {
    const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]);
    }
    return grid;
  }

  /* Matn maskasidan imzoli masofa maydoni: S - shrift o'lchami (px), spread - px */
  function textSdf(R) {
    const S = 160;
    const c = document.createElement("canvas");
    const m = c.getContext("2d");
    const probe = Object.assign({}, R, { size: 1, spacing: R.spacing, x: 0, y: 0, align: "center" });
    // o'lchash uchun: H = S bo'lganda size=1 -> shrift S px
    m.font = fontCss(probe, S);
    const tmp = layout(m, Object.assign({}, probe, { x: 0.5, y: 0.5 }), 1e6, S);
    const pad = Math.round(S * 0.45);
    const sc = tmp.size / S; // uzun matn kichraytirilgan bo'lsa
    let w = Math.ceil(tmp.blockW + pad * 2), h = Math.ceil(tmp.blockH + pad * 2);
    const k = Math.min(1, 1100 / w);
    w = Math.max(8, Math.round(w * k)); h = Math.max(8, Math.round(h * k));
    c.width = w; c.height = h;
    m.setTransform(k, 0, 0, k, 0, 0);
    m.fillStyle = "#000"; m.fillRect(0, 0, w / k, h / k);
    m.fillStyle = "#fff"; m.font = tmp.font; m.textBaseline = "middle";
    const ox = pad - tmp.left, oy = pad - (tmp.cy - tmp.blockH / 2);
    tmp.letters.forEach((g) => m.fillText(g.ch, g.x + ox, g.y + oy));
    const img = m.getImageData(0, 0, w, h).data;
    const n = w * h, inside = new Float64Array(n), outside = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = img[i * 4] / 255;
      outside[i] = a > 0.5 ? 0 : 1e20; inside[i] = a > 0.5 ? 1e20 : 0;
    }
    edt2d(outside, w, h); edt2d(inside, w, h);
    const spread = pad * k;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const dpx = outside[i] - inside[i] + (outside[i] > 0 ? -0.5 : 0.5);
      out[i] = clamp(Math.round(128 + (dpx / spread) * 127), 0, 255);
    }
    // dunyo birliklari: 1 birlik = S px (qator balandligi taxminan 1.14)
    const unit = S * k * sc;
    return { data: out, w, h, hx: w / unit / 2, hy: h / unit / 2, spreadW: spread / unit };
  }

  const VS = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
  const FS = `
precision highp float;
uniform vec2 uRes; uniform vec2 uCenter; uniform float uPx; uniform sampler2D uSdf;
uniform vec2 uHalf; uniform float uSpread; uniform float uDepth; uniform float uBevel;
uniform mat3 uRot; uniform float uScale; uniform vec3 uOff; uniform float uTime; uniform float uLiquid;
uniform float uFlow; uniform float uDrops; uniform float uAlpha; uniform int uMat; uniform vec3 uCol; uniform vec3 uCol2;
const float F = 4.5;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z) * 2.0 - 1.0; }
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdText(vec2 p){
  vec2 uv = vec2(p.x / (2.0 * uHalf.x) + 0.5, 0.5 - p.y / (2.0 * uHalf.y));
  float d = (texture2D(uSdf, clamp(uv, 0.0, 1.0)).r - 0.5) * 2.0 * uSpread;
  vec2 q = abs(p) - uHalf;
  return d + length(max(q, 0.0));
}
float map(vec3 p){
  vec3 w = p;
  float lq = uLiquid;
  w.xy += lq * 0.06 * vec2(sin(p.y * 3.1 + uTime * 2.3 * uFlow), sin(p.x * 2.3 - uTime * 1.7 * uFlow));
  float d2 = sdText(w.xy);
  float hz = uDepth * 0.5;
  float b = min(uBevel, hz * 0.9);
  vec2 v = vec2(d2 + b, abs(p.z) - hz + b);
  float d = min(max(v.x, v.y), 0.0) + length(max(v, 0.0)) - b;
  d -= lq * 0.018 * noise(p * 5.0 + vec3(0.0, -uTime * uFlow * 1.4, uTime * 0.6));
  if (uDrops > 0.02) {
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      vec3 home = vec3((fract(sin(fi * 12.9) * 43758.5) - 0.5) * 2.0 * uHalf.x * 0.8, (fract(sin(fi * 78.2) * 12345.6) - 0.5) * uHalf.y, 0.0);
      vec3 far = home + vec3(sin(fi * 2.1) * 1.8, cos(fi * 1.7) * 1.4 + 0.6, sin(fi * 3.3) * 0.8);
      vec3 c = mix(home, far, uDrops) + 0.05 * vec3(sin(uTime * 3.0 + fi), cos(uTime * 2.0 + fi), 0.0);
      float r = (0.28 + 0.08 * sin(fi)) * uDrops;
      d = smin(d, length(p - c) - r, 0.25 * uDrops + 0.001);
    }
  }
  return d;
}
vec3 normalAt(vec3 p){ const vec2 k = vec2(1.0, -1.0); float e = 0.0025;
  return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) + k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e)); }
vec3 env(vec3 r){
  vec3 c = mix(vec3(0.03, 0.035, 0.045), vec3(0.55, 0.6, 0.68), smoothstep(-0.25, 0.9, r.y));
  c += vec3(1.0, 0.97, 0.92) * 3.2 * smoothstep(0.86, 0.985, dot(r, normalize(vec3(-0.55, 0.55, 0.65))));
  c += vec3(0.85, 0.9, 1.0) * 1.6 * smoothstep(0.9, 0.995, dot(r, normalize(vec3(0.75, 0.15, 0.6))));
  c += vec3(1.0) * 0.9 * smoothstep(0.06, 0.0, abs(r.y - 0.05)) * smoothstep(-0.2, 0.4, r.z);
  return c;
}
vec3 tone(vec3 c){ c = c * (2.51 * c + 0.03) / (c * (2.43 * c + 0.59) + 0.14); return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
void main(){
  vec2 q = (gl_FragCoord.xy - vec2(uCenter.x, uRes.y - uCenter.y)) / uPx;
  vec3 ro = vec3(0.0, 0.0, F);
  vec3 rd = normalize(vec3(q, -F));
  // obyekt fazosiga
  vec3 o = uRot * ((ro - uOff) / uScale);
  vec3 dir = normalize(uRot * rd);
  float R = length(vec3(uHalf, uDepth * 0.5)) + 0.35 + uDrops * 2.2 + uLiquid * 0.1;
  float bq = dot(o, dir), cq = dot(o, o) - R * R, disc = bq * bq - cq;
  if (disc < 0.0) { gl_FragColor = vec4(0.0); return; }
  float t = max(0.0, -bq - sqrt(disc)), tEnd = -bq + sqrt(disc);
  float eps = 1.0 / uPx; // obyekt fazosida 1 piksel = t / (F * uPx)
  float best = 1e9, bestT = t; bool hit = false;
  for (int i = 0; i < 140; i++) {
    vec3 p = o + dir * t;
    float d = map(p);
    float pe = eps * (t + 0.001) / F;
    if (d < best) { best = d; bestT = t; }
    if (d < pe * 0.5) { hit = true; bestT = t; best = d; break; }
    t += d * 0.72;
    if (t > tEnd) break;
  }
  float pix = eps * (bestT + 0.001) / F;
  float cover = hit ? 1.0 : 1.0 - smoothstep(0.0, pix * 1.5, best);
  if (cover <= 0.001) { gl_FragColor = vec4(0.0); return; }
  vec3 p = o + dir * bestT;
  vec3 n = normalAt(p);
  // suyuq sirt: normalni oqib turgan shovqin bilan buzish
  n = normalize(n + uLiquid * 0.18 * vec3(noise(p * 7.0 + vec3(0.0, uTime * uFlow, 0.0)), noise(p * 7.0 + vec3(5.2, uTime * uFlow, 1.3)), 0.0));
  vec3 wn = n * uRot; vec3 wd = dir * uRot; // dunyo fazosiga (uRot ortogonal: transpozitsiya)
  vec3 rf = reflect(wd, wn);
  float fres = pow(1.0 - max(dot(-wd, wn), 0.0), 5.0);
  vec3 L1 = normalize(vec3(-0.5, 0.6, 0.7));
  float dif = max(dot(wn, L1), 0.0), wrap = max(dot(wn, L1) * 0.5 + 0.5, 0.0);
  float spec = pow(max(dot(rf, L1), 0.0), 60.0);
  float gy = clamp(p.y / (uHalf.y * 2.0) + 0.5, 0.0, 1.0);
  vec3 base = mix(uCol2, uCol, gy);
  vec3 col; float a = 1.0;
  if (uMat == 0) { // oltin
    col = env(rf) * uCol * (0.55 + 0.45 * fres) + uCol2 * 0.08 + spec * 1.2 * vec3(1.0, 0.95, 0.8);
  } else if (uMat == 1) { // xrom
    col = env(rf) * mix(vec3(0.75), uCol, 0.35) * (0.6 + 0.4 * fres) + spec * 1.5;
  } else if (uMat == 2) { // jele
    col = base * (0.25 + 0.75 * wrap) + spec * 0.9 + env(rf) * 0.25 * (0.3 + fres) + uCol2 * 0.35 * fres;
    a = 0.94;
  } else if (uMat == 3) { // shisha
    vec3 rr = refract(wd, wn, 0.66);
    col = mix(env(rr) * uCol * 1.25 + uCol * 0.18, env(rf) * 1.2, 0.2 + 0.8 * fres) + spec * 1.6 + uCol2 * 0.12 * fres;
    a = clamp(0.64 + 0.36 * fres + spec, 0.0, 1.0);
  } else if (uMat == 4) { // suv
    vec3 rr = refract(wd, wn, 0.75);
    col = mix(env(rr) * uCol * 1.1 + uCol * 0.15, env(rf), 0.2 + 0.8 * fres) + spec * 1.8;
    a = clamp(0.62 + 0.38 * fres + spec, 0.0, 1.0);
  } else if (uMat == 5) { // lava
    float hot = smoothstep(-0.2, 0.6, noise(p * 3.0 + vec3(0.0, -uTime * uFlow * 0.8, uTime * 0.3)) + 0.25 * noise(p * 9.0 + uTime));
    vec3 crust = vec3(0.08, 0.05, 0.045) * (0.3 + dif) + env(rf) * 0.06;
    col = mix(crust, mix(uCol, uCol2, hot) * 2.2, hot);
  } else { // candy
    col = base * (0.3 + 0.7 * dif) + spec * 1.3 + env(rf) * 0.35 * (0.2 + fres);
  }
  gl_FragColor = vec4(tone(col), a * cover * uAlpha);
}`;

  const MATS = { gold: 0, chrome: 1, jelly: 2, glass: 3, water: 4, lava: 5, candy: 6 };
  const hex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "")); const v = m ? parseInt(m[1], 16) : 0xffffff; return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; };
  const toLin = (c) => c.map((x) => Math.pow(x, 2.2));

  function rotMat(ax, ay, az) {
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    // R = Rz * Ry * Rx ; shader'ga teskarisi (transpozitsiya) beriladi: obyekt fazosiga o'tish
    const m = [
      cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz,
      cy * sz, cx * cz + sx * sy * sz, cx * sy * sz - cz * sx,
      -sy, cy * sx, cx * cy,
    ];
    // transpozitsiya, ustunlar bo'yicha (WebGL column-major): M^T column-major = M row-major
    return new Float32Array(m);
  }

  class Renderer3D {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true, antialias: false });
      if (!gl) throw new Error("WebGL ishlamayapti - 3D matn uchun videokarta drayverini yangilang.");
      this.gl = gl;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Shader: " + gl.getShaderInfoLog(s)); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error("Shader: " + gl.getProgramInfoLog(pr));
      this.pr = pr;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      this.tex = gl.createTexture();
      this.u = {};
      ["uRes", "uCenter", "uPx", "uSdf", "uHalf", "uSpread", "uDepth", "uBevel", "uRot", "uScale", "uOff", "uTime", "uLiquid", "uFlow", "uDrops", "uAlpha", "uMat", "uCol", "uCol2"]
        .forEach((n) => { this.u[n] = gl.getUniformLocation(pr, n); });
      this.sdfKey = "";
    }

    setText(R) {
      const key = [R.text, R.font, R.weight, R.italic, R.upper, R.spacing].join("|");
      if (key === this.sdfKey) return;
      const s = textSdf(R);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, s.w, s.h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, s.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.sdf = s; this.sdfKey = key;
    }

    /* t soniyadagi kadr */
    draw(R, t) {
      const gl = this.gl, c = this.canvas, W = c.width, H = c.height, u = this.u;
      this.setText(R);
      const P = phases(R, t);
      const kin = P.inP(0, P.inD * 1.6);
      const sp = E.spring(kin);
      const rot = (R.rot || 0) * Math.PI / 180;
      const idleY = Math.sin(t * 0.9) * rot * 0.22, idleX = Math.sin(t * 0.7 + 1) * rot * 0.08;
      const ry = mix(rot * 1.8, 0, E.outCubic(kin)) + idleY + P.out * rot * 1.2;
      const rx = mix(-rot * 0.4, 0, E.outCubic(kin)) + idleX;
      const scale = (0.55 + 0.45 * sp) * (1 + P.out * 0.15);
      const drops = R.drops ? 1 - E.inOutCubic(P.inP(0, Math.max(P.inD * 2.2, 1.2))) : 0;
      const liquid = (R.liquid || 0) * (0.45 + 0.9 * (1 - E.outCubic(kin)) + 1.5 * P.out);
      // ekranda: qator balandligi R.size*H px, markaz R.x/R.y; uzun matn kadrga sig'sin
      let px = R.size * H * 0.88;
      const maxW = W * 0.9;
      if (this.sdf.hx * 2 * px * 0.82 > maxW) px = maxW / (this.sdf.hx * 2 * 0.82);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.pr);
      const loc = gl.getAttribLocation(this.pr, "p");
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(u.uSdf, 0);
      gl.uniform2f(u.uRes, W, H);
      gl.uniform2f(u.uCenter, R.x * W, R.y * H);
      gl.uniform1f(u.uPx, px);
      gl.uniform2f(u.uHalf, this.sdf.hx, this.sdf.hy);
      gl.uniform1f(u.uSpread, this.sdf.spreadW);
      gl.uniform1f(u.uDepth, clamp(R.depth, 0.02, 1.5));
      gl.uniform1f(u.uBevel, clamp(R.bevel, 0, 0.3));
      gl.uniformMatrix3fv(u.uRot, false, rotMat(rx, ry, 0));
      gl.uniform1f(u.uScale, scale);
      gl.uniform3f(u.uOff, 0, (1 - sp) * -0.25, 0);
      gl.uniform1f(u.uTime, t);
      gl.uniform1f(u.uLiquid, clamp(liquid, 0, 2.5));
      gl.uniform1f(u.uFlow, clamp(R.flow || 1, 0, 4));
      gl.uniform1f(u.uDrops, drops);
      gl.uniform1f(u.uAlpha, clamp(Math.min(1, kin * 4) * (1 - E.inCubic(P.out)), 0, 1));
      gl.uniform1i(u.uMat, MATS[R.material] != null ? MATS[R.material] : 0);
      gl.uniform3fv(u.uCol, toLin(hex(R.color)));
      gl.uniform3fv(u.uCol2, toLin(hex(R.color2)));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /* ============== kadrlarni yaratish ============== */

  const is3D = (R) => byId(R.template).kind === "3d";

  /* Bitta kadrni berilgan canvas'ga chizadi (2D yoki 3D) */
  function makeDrawer(W, H, R) {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    if (is3D(R)) { const r = new Renderer3D(c); return { canvas: c, draw: (rec, t) => r.draw(rec, t) }; }
    return { canvas: c, draw: (rec, t) => draw2D(c, rec, t) };
  }

  const toBlob = (c) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("PNG yaratilmadi"))), "image/png"));

  /*
   * Barcha kadrlarni PNG qilib yozadi: dir/gc_0000.png ... + recipe.json
   * opts: { width, height, fps, onProgress(i, n), token }
   */
  async function render(R, dir, opts) {
    const fs = require("fs"), path = require("path");
    const W = Math.round(opts.width), H = Math.round(opts.height), fps = opts.fps || 25;
    const n = Math.max(1, Math.round(R.duration * fps));
    fs.mkdirSync(dir, { recursive: true });
    const d = makeDrawer(W, H, R);
    const files = [];
    for (let i = 0; i < n; i++) {
      if (opts.token) opts.token.check();
      d.draw(R, i / fps);
      const buf = Buffer.from(await (await toBlob(d.canvas)).arrayBuffer());
      const f = path.join(dir, "gc_" + String(i).padStart(4, "0") + ".png");
      fs.writeFileSync(f, buf);
      files.push(f);
      if (opts.onProgress) opts.onProgress(i + 1, n);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // UI qotmasin
    }
    fs.writeFileSync(path.join(dir, "recipe.json"), JSON.stringify(Object.assign({}, R, { width: W, height: H, fps, frames: n }), null, 2));
    return { first: files[0], count: n, files };
  }

  root.GCTextFX = { TEMPLATES, FONTS, DEFAULT, byId, recipeFor, layout, draw2D, Renderer3D, textSdf, makeDrawer, render, is3D, phases };
})(typeof window !== "undefined" ? window : globalThis);
