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

  const api = { PACK_VERSION: 1, SR, list: () => PACK.map(([folder, name]) => ({ folder, name })), render: (index) => toWav(PACK[index][2]()) };
  root.GCSfxGen = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
