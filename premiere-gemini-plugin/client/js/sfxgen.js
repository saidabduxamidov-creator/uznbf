/*
 * GeminiCut - bazaviy sound effektlar to'plami (sintezator).
 * Barcha tovushlar shu kompyuterning o'zida matematik usulda yaratiladi -
 * hech qanday litsenziyali namuna ishlatilmaydi, mualliflik huquqi muammosi yo'q.
 * Natija: 48 kHz, 16-bit, stereo WAV.
 */
(function (root) {
  "use strict";

  const SR = 48000;
  const TAU = Math.PI * 2;

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* RBJ biquad filtri; parametrlar har 16 namunada yangilanadi */
  class Biquad {
    constructor(type) { this.type = type; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(1000, 0.707); }
    set(freq, q) {
      const f = Math.max(20, Math.min(SR * 0.45, freq));
      const w = TAU * f / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
      let b0, b1, b2;
      if (this.type === "lp") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
      else if (this.type === "hp") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
      else { b0 = al; b1 = 0; b2 = -al; } // bandpass, 0 dB cho'qqi
      const a0 = 1 + al;
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * cw / a0; this.a2 = (1 - al) / a0;
    }
    run(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  /* Yengil stereo reverb (Schroeder: 4 comb + 2 allpass) */
  function reverb(L, R, mix, size) {
    const make = (offset) => {
      const combs = [1116, 1188, 1277, 1356].map((d) => ({ buf: new Float32Array(Math.round((d + offset) * size * SR / 44100)), i: 0, f: 0 }));
      const aps = [556, 441].map((d) => ({ buf: new Float32Array(Math.round((d + offset) * SR / 44100)), i: 0 }));
      return (x) => {
        let out = 0;
        for (const c of combs) {
          const y = c.buf[c.i];
          c.f = y * 0.8 + c.f * 0.2;
          c.buf[c.i] = x + c.f * 0.84;
          c.i = (c.i + 1) % c.buf.length;
          out += y;
        }
        out *= 0.25;
        for (const a of aps) {
          const b = a.buf[a.i];
          const y = -out + b;
          a.buf[a.i] = out + b * 0.5;
          a.i = (a.i + 1) % a.buf.length;
          out = y;
        }
        return out;
      };
    };
    const rl = make(0), rr = make(23);
    for (let i = 0; i < L.length; i++) {
      const dry = (L[i] + R[i]) * 0.5;
      L[i] = L[i] * (1 - mix * 0.5) + rl(dry) * mix;
      R[i] = R[i] * (1 - mix * 0.5) + rr(dry) * mix;
    }
  }

  function buffers(sec) { const n = Math.round(sec * SR); return [new Float32Array(n), new Float32Array(n)]; }
  const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d)); // chiziqli hujum + eksponensial so'nish
  const bell = (x) => Math.sin(Math.PI * Math.max(0, Math.min(1, x))) ** 2; // 0..1 da silliq "qo'ng'iroq"

  /* Sozlanadigan "whoosh": shovqin + surilayotgan band-pass + L->R harakat */
  function whoosh(seed, sec, f0, f1, f2, q, peakAt, pan) {
    const r = rng(seed), [L, R] = buffers(sec);
    const bp = new Biquad("bp"), bp2 = new Biquad("bp");
    for (let i = 0; i < L.length; i++) {
      const x = i / L.length;
      if (i % 16 === 0) {
        const f = x < peakAt ? f0 * Math.pow(f1 / f0, x / peakAt) : f1 * Math.pow(f2 / f1, (x - peakAt) / (1 - peakAt));
        bp.set(f, q); bp2.set(f * 1.6, q * 1.3);
      }
      const n = r() * 2 - 1;
      const a = x < peakAt ? Math.pow(x / peakAt, 2.2) : Math.pow(1 - (x - peakAt) / (1 - peakAt), 1.6);
      const s = (bp.run(n) * 1.4 + bp2.run(n) * 0.5) * a;
      const p = pan ? 0.5 + 0.45 * Math.sin((x - 0.5) * Math.PI) : 0.5;
      L[i] = s * Math.cos(p * Math.PI / 2) * 1.41;
      R[i] = s * Math.sin(p * Math.PI / 2) * 1.41;
    }
    return [L, R];
  }

  function impact(seed, sec, f0, f1, decay, noiseAmt, drive, rev) {
    const r = rng(seed), [L, R] = buffers(sec);
    const hp = new Biquad("hp"); hp.set(900, 0.7);
    const lp = new Biquad("lp"); lp.set(5000, 0.7);
    let ph = 0;
    for (let i = 0; i < L.length; i++) {
      const t = i / SR;
      const f = f1 + (f0 - f1) * Math.exp(-t / 0.08);
      ph += TAU * f / SR;
      const body = Math.sin(ph) * env(t, 0.002, decay);
      const click = lp.run(hp.run(r() * 2 - 1)) * env(t, 0.0005, 0.03) * noiseAmt;
      const s = Math.tanh((body + click) * drive) / Math.tanh(drive);
      L[i] = R[i] = s;
    }
    if (rev) reverb(L, R, rev, 1.3);
    return [L, R];
  }

  function tone(sec, fn) {
    const [L, R] = buffers(sec);
    for (let i = 0; i < L.length; i++) { const v = fn(i / SR, i); L[i] = R[i] = v; }
    return [L, R];
  }

  function bellTone(sec, freqs, decay, rev) {
    const [L, R] = tone(sec, (t) => {
      let v = 0;
      freqs.forEach(([f, a, start], k) => {
        const tt = t - (start || 0);
        if (tt < 0) return;
        v += a * Math.sin(TAU * f * tt) * env(tt, 0.003, decay / (1 + k * 0.35));
        v += a * 0.25 * Math.sin(TAU * f * 2.76 * tt) * env(tt, 0.002, decay * 0.25);
      });
      return v;
    });
    if (rev) reverb(L, R, rev, 1);
    return [L, R];
  }

  function clicks(seed, sec, times, freq, dur, level) {
    const r = rng(seed), [L, R] = buffers(sec);
    const bp = new Biquad("bp"); bp.set(freq, 1.2);
    let next = 0, t0 = -1, pan = 0.5, amp = 1;
    for (let i = 0; i < L.length; i++) {
      const t = i / SR;
      if (next < times.length && t >= times[next]) { t0 = t; pan = 0.35 + r() * 0.3; amp = 0.6 + r() * 0.4; next++; }
      const e = t0 >= 0 ? env(t - t0, 0.0004, dur) : 0;
      const s = bp.run(r() * 2 - 1) * e * amp * (level || 1);
      L[i] = s * (1 - pan) * 1.4; R[i] = s * pan * 1.4;
    }
    return [L, R];
  }

  function reverseBuf([L, R]) { L.reverse(); R.reverse(); return [L, R]; }

  function mix(a, b, gb) {
    const n = Math.max(a[0].length, b[0].length);
    const out = [new Float32Array(n), new Float32Array(n)];
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) out[c][i] = (a[c][i] || 0) + (b[c][i] || 0) * (gb == null ? 1 : gb);
    return out;
  }

  function delayed(buf, sec) {
    const off = Math.round(sec * SR);
    const out = [new Float32Array(buf[0].length + off), new Float32Array(buf[0].length + off)];
    out[0].set(buf[0], off); out[1].set(buf[1], off);
    return out;
  }


  /* ----------------------- 2-to'plam uchun bloklar ----------------------- */

  /* Karplus-Strong tor (arfa, gitara, pizzicato) */
  function pluck(seed, freq, sec, decay, bright) {
    const r = rng(seed), [L, R] = buffers(sec);
    const n = Math.max(2, Math.round(SR / freq)), buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = r() * 2 - 1;
    let idx = 0, last = 0;
    const fb = Math.pow(0.001, 1 / (decay * freq));
    for (let i = 0; i < L.length; i++) {
      const cur = buf[idx];
      const nxt = (cur * (bright || 0.5) + last * (1 - (bright || 0.5)));
      last = cur;
      buf[idx] = nxt * fb;
      idx = (idx + 1) % n;
      L[i] = R[i] = cur;
    }
    return [L, R];
  }

  /* Bir nechta tovushni vaqt bo'yicha joylashtirish: [[buf, vaqt, gain, pan], ...] */
  function seqMix(sec, parts) {
    const [L, R] = buffers(sec);
    parts.forEach(([b, at, g, pan]) => {
      const off = Math.round(at * SR), gg = g == null ? 1 : g, p = pan == null ? 0.5 : pan;
      const gl = Math.cos(p * Math.PI / 2) * 1.41, gr = Math.sin(p * Math.PI / 2) * 1.41;
      for (let i = 0; i < b[0].length && off + i < L.length; i++) { L[off + i] += b[0][i] * gg * gl; R[off + i] += b[1][i] * gg * gr; }
    });
    return [L, R];
  }

  /* Filtrlangan shovqin: fn(t, x) -> [freq, q, amp]; type - lp/hp/bp */
  function noise(seed, sec, type, fn, stereo) {
    const r = rng(seed), r2 = rng(seed + 999), [L, R] = buffers(sec);
    const fl = new Biquad(type), fr = new Biquad(type);
    let amp = 0;
    for (let i = 0; i < L.length; i++) {
      const t = i / SR;
      if (i % 16 === 0) { const [f, q, a] = fn(t, i / L.length); fl.set(f, q); fr.set(f * (stereo ? 1.03 : 1), q); amp = a; }
      const nl = r() * 2 - 1, nr = stereo ? r2() * 2 - 1 : nl;
      L[i] = fl.run(nl) * amp; R[i] = fr.run(nr) * amp;
    }
    return [L, R];
  }

  function kick(seed) {
    return tone(0.6, (t) => Math.tanh(1.8 * Math.sin(TAU * (45 * t + 105 * (1 - Math.exp(-t / 0.035)) * 0.035)) * env(t, 0.001, 0.22)) + (t < 0.004 ? (rng(seed)() * 2 - 1) * 0.4 : 0));
  }
  function snare(seed, dec) {
    const n = noise(seed, 0.5, "bp", (t) => [4200, 0.6, env(t, 0.001, dec || 0.12)]);
    const b = tone(0.5, (t) => 0.5 * Math.sin(TAU * 185 * t) * env(t, 0.001, 0.06));
    return mix(n, b, 1);
  }
  function clap(seed) {
    const b = seqMix(0.6, [0, 0.011, 0.023, 0.036].map((at, k) => [noise(seed + k, 0.25, "bp", (t) => [1250, 1.1, env(t, 0.0005, k === 3 ? 0.09 : 0.012)]), at, 1]));
    reverb(b[0], b[1], 0.25, 0.8);
    return b;
  }
  function hat(seed, open) { return noise(seed, open ? 0.6 : 0.12, "hp", (t) => [8000, 0.7, env(t, 0.0005, open ? 0.22 : 0.03)], true); }
  function crash(seed, sec) {
    const n = noise(seed, sec || 3, "hp", (t) => [5200 - 1500 * Math.min(1, t), 0.5, env(t, 0.002, 0.9)], true);
    const m = bellTone(sec || 3, [[3510, 0.08], [4730, 0.06], [6020, 0.05]], 0.8, 0);
    return mix(n, m, 1);
  }
  function tom(freq) { return tone(0.6, (t) => Math.sin(TAU * (freq * t + freq * 0.6 * (1 - Math.exp(-t / 0.05)) * 0.05)) * env(t, 0.002, 0.18)); }

  /* 8-bit (kvadrat to'lqin) nota ketma-ketligi: [[freq, dur], ...] */
  function chip(notes, duty) {
    const sec = notes.reduce((a, n) => a + n[1], 0) + 0.05;
    let acc = 0;
    const plan = notes.map(([f, d]) => { const s0 = acc; acc += d; return [f, s0, d]; });
    return tone(sec, (t) => {
      const n = plan.find(([, s0, d]) => t >= s0 && t < s0 + d);
      if (!n || !n[0]) return 0;
      const ph = ((t - n[1]) * n[0]) % 1;
      return (ph < (duty || 0.5) ? 0.35 : -0.35) * Math.min(1, (n[1] + n[2] - t) / 0.01);
    });
  }

  /* Pianino tovushi (qo'shimcha garmonikalar, bolg'acha zarbasi) */
  function piano(freqs, sec, spread) {
    return tone(sec, (t) => {
      let v = 0;
      freqs.forEach((f, k) => {
        const tt = t - (spread || 0) * k;
        if (tt < 0) return;
        for (let h = 1; h <= 6; h++) v += (0.28 / h) * Math.sin(TAU * f * h * (1 + 0.0004 * h * h) * tt) * env(tt, 0.002, 1.6 / (1 + h * 0.5));
      });
      return v * 0.5;
    });
  }

  /* Cherkov / to'y qo'ng'irog'i: noharmonik partiallar */
  function churchBell(f, sec) {
    return bellTone(sec, [[f * 0.5, 0.35], [f, 0.4], [f * 1.19, 0.25], [f * 1.5, 0.2], [f * 2.0, 0.18], [f * 2.52, 0.12], [f * 3.0, 0.08]], 2.4, 0);
  }

  function saw(ph) { return (ph % 1) * 2 - 1; }

  /* ----------------------------- to'plam ----------------------------- */

  const PACK = [
    // Whoosh
    ["Whoosh", "Whoosh Tez", () => whoosh(11, 0.55, 400, 3200, 900, 1.6, 0.45, true)],
    ["Whoosh", "Whoosh Uzun", () => whoosh(12, 1.4, 250, 2600, 500, 1.3, 0.55, true)],
    ["Whoosh", "Whoosh Chuqur", () => whoosh(13, 1.0, 120, 900, 200, 1.1, 0.5, true)],
    ["Whoosh", "Whoosh Havo", () => whoosh(14, 0.9, 1200, 7000, 2500, 0.9, 0.5, true)],
    ["Whoosh", "Swish Qisqa", () => whoosh(15, 0.28, 1500, 6000, 3000, 1.2, 0.35, false)],
    // Transition
    ["Transition", "Swoosh Hit", () => mix(whoosh(21, 0.7, 300, 2500, 2500, 1.4, 0.95, true), delayed(impact(22, 1.2, 150, 45, 0.35, 0.8, 2.2, 0.25), 0.62), 0.9)],
    ["Transition", "Reverse Suck", () => { const b = reverseBuf(impact(23, 1.6, 900, 200, 0.5, 1.2, 1.5, 0.5)); return mix(b, whoosh(24, 1.6, 200, 5000, 5000, 1, 0.98, false), 0.6); }],
    ["Transition", "Swipe", () => whoosh(25, 0.35, 800, 9000, 9000, 0.8, 0.95, true)],
    ["Transition", "Zoom Transition", () => mix(whoosh(26, 0.8, 200, 4000, 600, 1.5, 0.6, false), tone(0.8, (t) => 0.25 * Math.sin(TAU * (120 * t + 600 * t * t)) * bell(t / 0.8)), 0.7)],
    // Impact & Hit
    ["Impact & Hit", "Cinematic Boom", () => impact(31, 3.5, 120, 32, 1.3, 1, 2.5, 0.45)],
    ["Impact & Hit", "Punch Hit", () => impact(32, 0.5, 220, 70, 0.12, 1.4, 3, 0.1)],
    ["Impact & Hit", "Sub Drop", () => tone(2.2, (t) => Math.sin(TAU * (70 * t - 9 * t * t)) * env(t, 0.01, 0.9) * 0.9)],
    ["Impact & Hit", "Metal Hit", () => mix(impact(34, 1.8, 400, 180, 0.2, 1.6, 1.8, 0.3), bellTone(1.8, [[523, 0.3], [1307, 0.2], [2210, 0.12]], 0.7, 0.2), 0.8)],
    ["Impact & Hit", "Yumshoq Zarba", () => impact(35, 0.6, 140, 60, 0.15, 0.3, 1.2, 0.05)],
    // Riser
    ["Riser", "Riser 2s", () => riser(41, 2)],
    ["Riser", "Riser 4s", () => riser(42, 4)],
    ["Riser", "Tension Riser", () => { const b = riser(43, 3.5); return mix(b, tone(3.5, (t) => 0.18 * Math.sin(TAU * 55 * Math.pow(2, t / 1.75) * t) * (t / 3.5)), 1); }],
    // Glitch
    ["Glitch", "Glitch 1", () => glitch(51, 0.6)],
    ["Glitch", "Glitch Stutter", () => glitch(52, 1.0)],
    ["Glitch", "Data Bleeps", () => { const r = rng(53); const notes = Array.from({ length: 14 }, () => 800 + Math.floor(r() * 12) * 180); return tone(0.9, (t) => { const k = Math.floor(t / 0.06); const f = notes[k % notes.length]; return 0.35 * Math.sign(Math.sin(TAU * f * t)) * ((t % 0.06) < 0.045 ? 1 : 0); }); }],
    ["Glitch", "Bitcrush Burst", () => { const b = glitch(54, 0.45); crush(b, 6, 8); return b; }],
    // UI & Click
    ["UI & Click", "Click", () => clicks(61, 0.12, [0.005], 3200, 0.006)],
    ["UI & Click", "Yumshoq Tap", () => clicks(62, 0.15, [0.005], 1400, 0.012)],
    ["UI & Click", "Tick", () => tone(0.08, (t) => Math.sin(TAU * 4200 * t) * env(t, 0.0003, 0.008))],
    ["UI & Click", "Toggle", () => mix(clicks(64, 0.2, [0.005], 2600, 0.006), delayed(clicks(65, 0.1, [0.005], 1800, 0.006), 0.06), 1)],
    ["UI & Click", "Mouse Double Click", () => clicks(66, 0.3, [0.005, 0.11], 3600, 0.005)],
    // Pop
    ["Pop", "Pop", () => tone(0.25, (t) => Math.sin(TAU * (900 * t - 1400 * t * t)) * env(t, 0.001, 0.04) * 0.9)],
    ["Pop", "Bubble Pop", () => tone(0.3, (t) => Math.sin(TAU * (300 * t + 3000 * t * t)) * env(t, 0.001, 0.05) * 0.9)],
    ["Pop", "Pop Baland", () => tone(0.2, (t) => Math.sin(TAU * (1600 * t - 3000 * t * t)) * env(t, 0.0008, 0.025) * 0.9)],
    // Notification
    ["Notification", "Ding", () => bellTone(1.6, [[1318.5, 0.6]], 0.6, 0.15)],
    ["Notification", "Chime", () => bellTone(2, [[784, 0.4, 0], [988, 0.4, 0.12], [1175, 0.4, 0.24], [1568, 0.35, 0.36]], 0.7, 0.3)],
    ["Notification", "Success", () => bellTone(1.4, [[659, 0.45, 0], [988, 0.45, 0.13]], 0.45, 0.2)],
    ["Notification", "Error Beep", () => tone(0.55, (t) => 0.4 * Math.sign(Math.sin(TAU * 196 * t)) * ((t < 0.2 || (t > 0.28 && t < 0.5)) ? 1 : 0) * 0.6)],
    // Typing
    ["Typing", "Klaviatura Terish", () => { const r = rng(71); const times = []; let t = 0.02; while (t < 2.3) { times.push(t); t += 0.06 + r() * 0.12 + (r() < 0.1 ? 0.25 : 0); } return clicks(72, 2.5, times, 2400, 0.018, 0.9); }],
    ["Typing", "Bitta Tugma", () => mix(clicks(73, 0.15, [0.005], 2400, 0.012), delayed(clicks(74, 0.1, [0.002], 900, 0.01, 0.5), 0.03), 1)],
    ["Typing", "Yozuv Mashinkasi", () => { const r = rng(75); const times = []; let t = 0.02; while (t < 1.6) { times.push(t); t += 0.1 + r() * 0.1; } return mix(clicks(76, 2.4, times, 1700, 0.03, 1.2), delayed(bellTone(0.7, [[2093, 0.3]], 0.35, 0), 1.7), 1); }],
    // Fun
    ["Fun & Cartoon", "Boing", () => tone(0.9, (t) => Math.sin(TAU * (180 * t + 40 * Math.sin(TAU * 9 * t) / (TAU * 9))) * env(t, 0.005, 0.3) * 0.8)],
    ["Fun & Cartoon", "Laser", () => tone(0.4, (t) => 0.6 * Math.sin(TAU * (2400 * t - 2600 * t * t)) * env(t, 0.002, 0.15))],
    ["Fun & Cartoon", "Slide Up", () => tone(1.0, (t) => 0.5 * Math.sin(TAU * (400 * t + 500 * t * t)) * bell(t))],
    ["Fun & Cartoon", "Tape Stop", () => { let ph = 0; return tone(1.2, (t) => { const f = 220 * Math.max(0, 1 - t / 1.1); ph += TAU * f / SR; return 0.5 * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph)) * (t < 1.1 ? 1 : 0); }); }],
    // Power
    ["Power Down & Up", "Power Up", () => { let ph = 0; const b = tone(1.5, (t) => { ph += TAU * (80 * Math.pow(12, t / 1.5)) / SR; return 0.4 * (Math.sin(ph) + 0.3 * Math.sin(ph * 2.01)) * Math.min(1, t * 3) * (t < 1.45 ? 1 : 0); }); reverb(b[0], b[1], 0.2, 1); return b; }],
    ["Power Down & Up", "Power Down", () => { let ph = 0; const b = tone(1.6, (t) => { ph += TAU * (900 * Math.pow(1 / 14, t / 1.5)) / SR; return 0.45 * (Math.sin(ph) + 0.3 * Math.sin(ph * 2.01)) * (1 - t / 1.6); }); reverb(b[0], b[1], 0.2, 1); return b; }],
    // Foley
    ["Foley", "Kamera Shutter", () => mix(clicks(81, 0.3, [0.005], 2000, 0.02, 1.2), delayed(clicks(82, 0.2, [0.002], 1300, 0.03, 1), 0.07), 1)],
    ["Foley", "Yurak Urishi", () => { const beat = impact(83, 0.35, 90, 45, 0.08, 0.1, 1.5, 0); return mix(mix(beat, delayed(beat, 0.28), 0.7), delayed(mix(beat, delayed(beat, 0.28), 0.7), 0.95), 1); }],
    ["Foley", "Ka-ching", () => mix(clicks(84, 0.3, [0.005, 0.05], 1500, 0.02, 1), delayed(bellTone(1.5, [[2637, 0.3], [3520, 0.25, 0.06]], 0.5, 0.2), 0.08), 1)],
    // Magic
    ["Magic", "Sparkle", () => { const r = rng(91); const notes = Array.from({ length: 12 }, (_, k) => [1500 + r() * 3500, 0.12, k * 0.07]); return bellTone(2.2, notes, 0.25, 0.45); }],
    ["Magic", "Shimmer", () => { const b = whoosh(92, 2, 3000, 9000, 6000, 3, 0.5, true); const s = bellTone(2, [[2093, 0.15, 0.2], [2637, 0.15, 0.45], [3136, 0.15, 0.7]], 0.5, 0.5); return mix(b, s, 1); }],

    // ======================= 2-to'plam =======================
    ["Cinematic", "Braam", () => { const ph = [0, 0, 0, 0]; const lp = new Biquad("lp"), lp2 = new Biquad("lp"); const b = tone(4, (t, i) => { if (i % 16 === 0) { const f = 250 + 2600 * Math.sin(Math.PI * Math.min(1, t / 3.6)) ** 2; lp.set(f, 1.4); lp2.set(f, 1.4); } let v = 0; [55, 55.4, 54.6, 110.3].forEach((f, k) => { ph[k] += f / SR; v += saw(ph[k]) * (k === 3 ? 0.4 : 1); }); return Math.tanh(lp2.run(lp.run(v)) * 1.6) * env(t, 0.05, 1.6); }); reverb(b[0], b[1], 0.45, 1.6); return b; }],
    ["Cinematic", "Trailer Hit", () => { const b = mix(mix(impact(201, 3.5, 160, 38, 1.1, 1.2, 2.6, 0), crash(202, 3.5), 0.45), tone(3.5, (t) => 0.8 * Math.sin(TAU * (38 * t)) * env(t, 0.005, 0.9)), 0.8); reverb(b[0], b[1], 0.4, 1.6); return b; }],
    ["Cinematic", "Whoosh Boom", () => mix(whoosh(203, 1.2, 200, 2600, 300, 1.2, 0.92, true), delayed(impact(204, 2.6, 130, 35, 0.9, 1, 2.4, 0.4), 1.08), 1)],
    ["Cinematic", "Reverse Cymbal", () => { const b = reverseBuf(crash(205, 2.2)); return b; }],
    ["Cinematic", "Riser + Hit", () => mix(riser(206, 2.5), delayed(impact(207, 2.5, 150, 40, 0.8, 1.2, 2.4, 0.4), 2.48), 1)],
    ["Cinematic", "Deep Drone", () => { const ph = [0, 0, 0]; const b = tone(6, (t) => { let v = 0; [41.2, 61.7, 82.4].forEach((f, k) => { ph[k] += f * (1 + 0.003 * Math.sin(TAU * 0.2 * t + k)) / SR; v += Math.sin(TAU * ph[k]) * (0.5 / (k + 1)); }); return v * bell(t / 6) * 1.2; }); reverb(b[0], b[1], 0.35, 1.6); return b; }],
    ["Cinematic", "Sub Boom Uzun", () => tone(3.5, (t) => Math.sin(TAU * (32 * t + 50 * (1 - Math.exp(-t / 0.2)) * 0.2)) * env(t, 0.004, 1.2))],

    ["Transition", "Spin Whoosh", () => { const b = whoosh(211, 1.1, 300, 4000, 800, 1.3, 0.55, false); for (let i = 0; i < b[0].length; i++) { const p = 0.5 + 0.5 * Math.sin(TAU * 5 * i / SR); b[0][i] *= 1.4 * Math.cos(p * Math.PI / 2); b[1][i] *= 1.4 * Math.sin(p * Math.PI / 2); } return b; }],
    ["Transition", "Fast Swipe", () => whoosh(212, 0.22, 2000, 10000, 6000, 0.9, 0.6, true)],
    ["Transition", "Flash Whoosh", () => mix(whoosh(213, 0.7, 600, 8000, 3000, 1, 0.55, true), delayed(bellTone(1.2, [[2637, 0.12], [3951, 0.1, 0.02]], 0.4, 0.4), 0.38), 1)],
    ["Transition", "Glitch Transition", () => mix(glitch(214, 0.7), whoosh(215, 0.7, 300, 5000, 1000, 1.2, 0.5, true), 0.8)],

    ["Ijtimoiy tarmoq", "Like Pop", () => seqMix(0.4, [[tone(0.2, (t) => Math.sin(TAU * (700 * t + 1500 * t * t)) * env(t, 0.001, 0.04)), 0], [tone(0.2, (t) => Math.sin(TAU * (1050 * t + 1800 * t * t)) * env(t, 0.001, 0.05)), 0.07]])],
    ["Ijtimoiy tarmoq", "Xabar Yuborildi", () => mix(whoosh(221, 0.35, 900, 5000, 5000, 1.1, 0.8, false), delayed(tone(0.2, (t) => Math.sin(TAU * 1568 * t) * env(t, 0.001, 0.05)), 0.28), 0.8)],
    ["Ijtimoiy tarmoq", "Bildirishnoma 2", () => { const b = seqMix(0.8, [[bellTone(0.6, [[1046.5, 0.5]], 0.25, 0), 0], [bellTone(0.6, [[1568, 0.5]], 0.3, 0), 0.11]]); reverb(b[0], b[1], 0.2, 0.8); return b; }],
    ["Ijtimoiy tarmoq", "Obuna Ding", () => mix(bellTone(1.8, [[1318.5, 0.5], [1975.5, 0.35, 0.08]], 0.7, 0.3), delayed(bellTone(1.5, [[3136, 0.12, 0.05], [3951, 0.1, 0.12], [4699, 0.08, 0.2]], 0.3, 0.4), 0.12), 1)],
    ["Ijtimoiy tarmoq", "Kamera Flash", () => mix(clicks(222, 0.4, [0.005], 2400, 0.015, 1), delayed(noise(223, 0.6, "hp", (t) => [3000 + 6000 * t, 0.7, env(t, 0.002, 0.15) * 0.6]), 0.03), 1)],

    ["O'yin (8-bit)", "Tanga", () => chip([[988, 0.08], [1319, 0.3]], 0.5)],
    ["O'yin (8-bit)", "Level Up", () => chip([[523, 0.07], [659, 0.07], [784, 0.07], [1047, 0.07], [784, 0.07], [1047, 0.25]], 0.25)],
    ["O'yin (8-bit)", "Sakrash", () => tone(0.3, (t) => ((t * (300 + 1400 * t)) % 1 < 0.5 ? 0.35 : -0.35) * env(t, 0.002, 0.12))],
    ["O'yin (8-bit)", "Game Over", () => chip([[784, 0.15], [740, 0.15], [698, 0.15], [659, 0.5]], 0.5)],
    ["O'yin (8-bit)", "Power Up 8-bit", () => tone(0.7, (t) => { const f = 200 * Math.pow(2, Math.floor(t * 24) / 6); return ((t * f) % 1 < 0.5 ? 0.3 : -0.3) * Math.min(1, (0.7 - t) / 0.05); })],

    ["Kulgili", "Ba-dum-tss", () => seqMix(1.8, [[tom(220), 0, 0.8], [tom(160), 0.17, 0.8], [kick(231), 0.17, 0.7], [crash(232, 1.6), 0.36, 0.5]])],
    ["Kulgili", "Muvaffaqiyatsiz (Trombon)", () => { let ph = 0; const lp = new Biquad("lp"); const notes = [[311, 0, 0.45], [293.7, 0.5, 0.45], [277.2, 1.0, 0.45], [261.6, 1.5, 1.2]]; return tone(2.8, (t, i) => { const n = notes.filter(([, s0]) => t >= s0).pop(); const tt = t - n[1]; const vib = tt > 0.3 && n[1] >= 1.5 ? 1 + 0.02 * Math.sin(TAU * 6 * tt) : 1; ph += n[0] * vib / SR; if (i % 16 === 0) lp.set(400 + 2200 * Math.min(1, tt / 0.12) * Math.exp(-tt / 0.5), 2); return Math.tanh(lp.run(saw(ph)) * 1.5) * (tt < n[2] ? Math.min(1, tt / 0.03) : 0) * 0.6; }); }],
    ["Kulgili", "Plastinka Tirnalishi", () => { const r = rng(233); const lp = new Biquad("bp"); return tone(0.7, (t, i) => { const m = Math.sin(TAU * 3.2 * t); if (i % 16 === 0) lp.set(800 + 2400 * Math.abs(m), 2.5); return lp.run(r() * 2 - 1) * Math.abs(m) * 1.6 * env(t, 0.005, 0.4); }); }],
    ["Kulgili", "Hushtak Yuqoriga", () => tone(1.0, (t) => 0.5 * Math.sin(TAU * (600 * t + 900 * t * t)) * (1 + 0.02 * Math.sin(TAU * 7 * t)) * bell(t))],
    ["Kulgili", "Hushtak Pastga", () => tone(1.0, (t) => 0.5 * Math.sin(TAU * (1500 * t - 800 * t * t)) * (1 + 0.02 * Math.sin(TAU * 7 * t)) * bell(t))],
    ["Kulgili", "Bonk", () => mix(impact(234, 0.4, 900, 450, 0.05, 1, 2, 0), delayed(tone(0.7, (t) => Math.sin(TAU * (260 * t + 30 * Math.sin(TAU * 10 * t) / (TAU * 10))) * env(t, 0.004, 0.25) * 0.6), 0.04), 1)],
    ["Kulgili", "Chigirtkalar (jimlik)", () => { const r = rng(235); const starts = []; let t = 0.1; while (t < 3.6) { starts.push(t); t += 0.55 + r() * 0.3; } return tone(4, (tt) => { let v = 0; starts.forEach((s0) => { const d = tt - s0; if (d >= 0 && d < 0.18) v += Math.sin(TAU * 4400 * d) * (Math.sin(TAU * 32 * d) > 0 ? 1 : 0) * Math.sin(Math.PI * d / 0.18); }); return v * 0.25; }); }],

    ["Baraban", "Kick", () => kick(241)],
    ["Baraban", "Snare", () => { const b = snare(242); reverb(b[0], b[1], 0.15, 0.8); return b; }],
    ["Baraban", "Clap", () => clap(243)],
    ["Baraban", "Hi-Hat", () => hat(244, false)],
    ["Baraban", "Crash", () => crash(245, 3)],
    ["Baraban", "Baraban Drobi", () => { const parts = []; let t = 0; let k = 0; while (t < 1.9) { parts.push([snare(250 + k, 0.05), t, 0.25 + 0.75 * (t / 1.9)]); t += 0.055 - 0.02 * (t / 1.9); k++; } parts.push([crash(299, 2), 1.95, 0.8]); return seqMix(4, parts); }],

    ["To'y", "To'y Qo'ng'iroqlari", () => { const b = seqMix(6, [[churchBell(523, 3.5), 0, 0.8], [churchBell(659, 3.5), 0.5, 0.7], [churchBell(784, 3.5), 1.0, 0.7], [churchBell(1047, 3.5), 1.5, 0.6], [churchBell(784, 3.5), 2.0, 0.6], [churchBell(523, 3.5), 2.5, 0.7]]); reverb(b[0], b[1], 0.45, 1.6); return b; }],
    ["To'y", "Arfa Glissando", () => { const f = [262, 294, 330, 392, 440, 523, 587, 659, 784, 880, 1047, 1175, 1319, 1568]; const b = seqMix(3.2, f.map((x, k) => [pluck(260 + k, x, 2, 1.6, 0.55), k * 0.075, 0.35, 0.2 + 0.6 * k / f.length])); reverb(b[0], b[1], 0.4, 1.4); return b; }],
    ["To'y", "Qarsaklar", () => { const r = rng(270); const parts = []; for (let k = 0; k < 260; k++) { const t = r() * 3.6; parts.push([noise(271 + k, 0.08, "bp", (tt) => [900 + r() * 1600, 1.4, env(tt, 0.0005, 0.012)]), t, 0.25 + r() * 0.3, r()]); } const b = seqMix(4.2, parts); const bed = noise(272, 4.2, "bp", (t) => [1500, 0.5, 0.12 * bell(t / 4.2)], true); return mix(b, bed, 1); }],
    ["To'y", "Sehrli Chime", () => { const r = rng(273); const notes = [1568, 1760, 2093, 2349, 2637, 3136, 3520]; return bellTone(3, notes.map((f, k) => [f, 0.2, k * 0.09 + r() * 0.02]), 0.9, 0.55); }],
    ["To'y", "Romantik Piano", () => { const b = mix(piano([261.6, 329.6, 392, 523.3], 4, 0.06), delayed(piano([349.2, 440, 523.3, 698.5], 3.5, 0.06), 1.6), 0.9); reverb(b[0], b[1], 0.4, 1.4); return b; }],
    ["To'y", "Musiqa Qutisi", () => { const mel = [1047, 1319, 1568, 1319, 1175, 1397, 1760, 1568, 1319, 1047]; const b = seqMix(4.2, mel.map((f, k) => [bellTone(1.5, [[f, 0.4], [f * 2, 0.12]], 0.45, 0), k * 0.32, 0.6, 0.35 + 0.3 * (k % 2)])); reverb(b[0], b[1], 0.3, 1.2); return b; }],

    ["Tabiat", "Shamol", () => noise(280, 5, "bp", (t) => [500 + 450 * Math.sin(TAU * 0.23 * t) + 200 * Math.sin(TAU * 0.71 * t), 0.8, (0.6 + 0.4 * Math.sin(TAU * 0.17 * t + 1)) * bell(t / 5) * 1.2], true)],
    ["Tabiat", "Yomg'ir", () => { const r = rng(281); const bed = noise(282, 5, "hp", (t) => [2500, 0.5, 0.25 * Math.min(1, t * 2) * Math.min(1, (5 - t) * 2)], true); const parts = []; for (let k = 0; k < 400; k++) parts.push([tone(0.03, (t) => Math.sin(TAU * (2500 + 3000 * r()) * t) * env(t, 0.0005, 0.006)), r() * 4.9, 0.15 + r() * 0.2, r()]); return mix(bed, seqMix(5, parts), 1); }],
    ["Tabiat", "Momaqaldiroq", () => { const rum = noise(283, 6, "lp", (t) => [120 + 300 * Math.exp(-t / 0.4), 0.7, env(t, 0.02, 1.6) * (1 + 0.5 * Math.sin(TAU * 1.3 * t))], true); const crack = noise(284, 1, "hp", (t) => [1500, 0.6, env(t, 0.001, 0.15)], true); const b = mix(rum, crack, 0.7); reverb(b[0], b[1], 0.35, 1.6); return b; }],
    ["Tabiat", "Olov", () => { const r = rng(285); const bed = noise(286, 5, "lp", (t) => [700, 0.6, 0.35 * bell(t / 5) ** 0.3], true); const times = []; for (let k = 0; k < 140; k++) times.push(r() * 4.9); times.sort((a, b) => a - b); return mix(bed, clicks(287, 5, times, 3000, 0.004, 1.2), 1); }],
    ["Tabiat", "Suv Tomchisi", () => { const b = tone(0.5, (t) => Math.sin(TAU * (600 * t + 2200 * t * t)) * env(t, 0.001, 0.06)); reverb(b[0], b[1], 0.35, 0.9); return b; }],

    ["Foley", "Eshik Taqillatish", () => { const knock = mix(impact(290, 0.25, 220, 120, 0.04, 0.6, 1.5, 0), noise(291, 0.2, "lp", (t) => [900, 0.7, env(t, 0.001, 0.02)]), 0.8); return seqMix(1.2, [[knock, 0], [knock, 0.22], [knock, 0.44]]); }],
    ["Foley", "Qadam Tovushlari", () => { const step = (k) => mix(noise(292 + k, 0.25, "lp", (t) => [600, 0.8, env(t, 0.002, 0.04)]), delayed(noise(300 + k, 0.2, "bp", (t) => [2200, 1, env(t, 0.001, 0.02) * 0.5]), 0.05), 1); const parts = []; for (let k = 0; k < 6; k++) parts.push([step(k), k * 0.48, 0.8, k % 2 ? 0.6 : 0.4]); return seqMix(3.2, parts); }],
    ["Foley", "Qog'oz Shitirlashi", () => { const r = rng(310); let a = 0; return noise(311, 1.4, "bp", (t, x) => { if (r() < 0.08) a = r(); return [3000 + 2500 * r(), 0.8, a * bell(x)]; }, true); }],
    ["Foley", "Shisha Jiringlashi", () => bellTone(1.8, [[2794, 0.4], [4190, 0.3], [5587, 0.2, 0.01], [3520, 0.2, 0.012]], 0.6, 0.25)],
  ];

  function riser(seed, sec) {
    const r = rng(seed), [L, R] = buffers(sec);
    const lp = new Biquad("lp"), hp = new Biquad("hp"); hp.set(150, 0.7);
    const ph = [0, 0, 0];
    for (let i = 0; i < L.length; i++) {
      const x = i / L.length;
      if (i % 16 === 0) lp.set(300 + 12000 * x * x, 1.2);
      const f = 110 * Math.pow(8, x);
      let saw = 0;
      [1, 1.005, 0.995].forEach((d, k) => { ph[k] = (ph[k] + f * d / SR) % 1; saw += ph[k] * 2 - 1; });
      const s = hp.run(lp.run(saw * 0.25 + (r() * 2 - 1) * 0.5));
      const a = Math.pow(x, 1.8) * (x > 0.985 ? (1 - x) / 0.015 : 1);
      L[i] = s * a * (0.9 + 0.1 * Math.sin(TAU * 3 * x));
      R[i] = s * a * (0.9 - 0.1 * Math.sin(TAU * 3 * x));
    }
    return [L, R];
  }

  function glitch(seed, sec) {
    const r = rng(seed), [L, R] = buffers(sec);
    let seg = 0, f = 0, kind = 0, amp = 0, panL = 1, panR = 1;
    for (let i = 0; i < L.length; i++) {
      if (i >= seg) {
        seg = i + Math.round(SR * (0.012 + r() * 0.05));
        f = 80 + r() * 2400; kind = Math.floor(r() * 3); amp = r() < 0.2 ? 0 : 0.35 + r() * 0.45;
        panL = r() < 0.3 ? 0.3 : 1; panR = r() < 0.3 ? 0.3 : 1;
      }
      const t = i / SR;
      let v = kind === 0 ? Math.sign(Math.sin(TAU * f * t)) : kind === 1 ? r() * 2 - 1 : ((f * t) % 1) * 2 - 1;
      v = Math.round(v * 4) / 4 * amp;
      L[i] = v * panL; R[i] = v * panR;
    }
    return [L, R];
  }

  function crush(buf, bits, hold) {
    const q = Math.pow(2, bits);
    for (const ch of buf) { let last = 0; for (let i = 0; i < ch.length; i++) { if (i % hold === 0) last = Math.round(ch[i] * q) / q; ch[i] = last; } }
  }

  /* Normallashtirish (-1 dBFS), qirralarni yumshatish, 16-bit stereo WAV */
  function toWav([L, R]) {
    let peak = 1e-9;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const g = 0.89 / peak, n = L.length, fade = Math.min(n >> 2, Math.round(SR * 0.004));
    const buf = Buffer.alloc(44 + n * 4);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) {
      const f = i >= n - fade ? (n - i) / fade : 1;
      const l = Math.max(-1, Math.min(1, L[i] * g * f)), r = Math.max(-1, Math.min(1, R[i] * g * f));
      buf.writeInt16LE(Math.round((isFinite(l) ? l : 0) * 32767), 44 + i * 4);
      buf.writeInt16LE(Math.round((isFinite(r) ? r : 0) * 32767), 46 + i * 4);
    }
    return buf;
  }

  const api = { PACK_VERSION: 2, SR, list: () => PACK.map(([folder, name]) => ({ folder, name })), render: (index) => toWav(PACK[index][2]()) };
  root.GCSfxGen = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
