/*
 * GeminiCut - subtitr dvigateli.
 * Gemini qaytargan xom segmentlarni professional subtitr standartiga keltiradi:
 *   - vaqtlarni tozalash, saralash, ustma-ust tushishlarni yo'qotish
 *   - juda uzun segmentlarni tabiiy joylardan (tinish belgilari) bo'lish
 *   - qatorlarga muvozanatli ajratish (max belgi / max qator)
 *   - minimal ko'rinish vaqti va o'qish tezligi (CPS) nazorati
 *   - SRT fayl yaratish
 * Tashqi kutubxonalarsiz, brauzerda ham Node'da ham ishlaydi.
 */
(function (root) {
  "use strict";

  const DEFAULTS = {
    maxChars: 42,      // bir qatordagi maksimal belgilar
    maxLines: 2,       // bir kadrdagi maksimal qatorlar
    maxDuration: 7,    // bitta subtitrning maksimal davomiyligi (s)
    minDuration: 0.8,  // minimal ko'rinish vaqti (s)
    maxCps: 17,        // o'qish tezligi: belgi / soniya
    gap: 0.08,         // ketma-ket subtitrlar orasidagi minimal bo'shliq (s)
    chainGap: 0.5,     // bundan kichik bo'shliqlar yopiladi (miltillamasligi uchun)
  };

  const STRONG = /[.!?…]["»”)]?$/;
  const MEDIUM = /[,;:—–-]["»”)]?$/;

  function cleanText(t) {
    return String(t == null ? "" : t)
      .replace(/[​-‍﻿]/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.!?;:…])/g, "$1")
      .trim();
  }

  /* O'zbek lotin yozuvidagi oʻ/gʻ va tutuq belgisini bir xil ko'rinishga keltiradi.
     style: "typographic" -> oʻ gʻ maʼno ;  "simple" -> o' g' ma'no */
  function normalizeUzbek(text, style) {
    const turned = style === "simple" ? "'" : "ʻ";   // ʻ
    const glottal = style === "simple" ? "'" : "ʼ";  // ʼ
    // Chet so'zdan keyingi qo'shimcha: "Pro'da", "YouTube'ga" -> tutuq belgisi (ʼ), oʻ/gʻ emas
    const SUFFIX = /^(da|dagi|dan|ga|ka|qa|ni|ning|lar|larni|larga|larda|dek|day|cha|chi|mi|siz|li|ning)(?![A-Za-z])/;
    // Bitta o'tishda: o/g dan keyingi belgi -> ʻ, boshqa harflar orasidagisi -> ʼ
    return text.replace(/([A-Za-zÀ-ɏ]+)['`‘’ʻʼ´](?=([A-Za-zÀ-ɏ]*))/g,
      (m, stem, rest) => {
        const letter = stem.slice(-1);
        const foreign = stem.length >= 3 && /^[A-Z]/.test(stem) && SUFFIX.test(rest);
        if (/[OoGg]/.test(letter) && !foreign) return stem + turned;
        return rest ? stem + glottal : m;
      });
  }

  /* Matnni maxLen dan oshmaydigan bo'laklarga, iloji boricha tinish
     belgilaridan keyin va teng uzunlikda bo'ladi. */
  function splitText(text, maxLen) {
    text = cleanText(text);
    if (text.length <= maxLen) return text ? [text] : [];
    const parts = Math.ceil(text.length / maxLen);
    const ideal = text.length / parts;
    let best = -1, bestScore = -Infinity;
    for (let i = 1; i < text.length - 1; i++) {
      if (text[i] !== " ") continue;
      if (i > maxLen) break;
      const left = text.slice(0, i);
      let score = -Math.abs(i - ideal) / ideal;
      if (STRONG.test(left)) score += 1.2;
      else if (MEDIUM.test(left)) score += 0.6;
      if (i < ideal * 0.45) score -= 0.8; // juda kalta bo'lak ("Eng muhimi:") yakka qolmasin
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) {
      // bo'sh joy yo'q (juda uzun so'z) - majburan kesamiz
      return [text.slice(0, maxLen)].concat(splitText(text.slice(maxLen), maxLen));
    }
    return [text.slice(0, best)].concat(splitText(text.slice(best + 1), maxLen));
  }

  /* Bitta subtitr matnini maxLines qatorga muvozanatli ajratadi */
  function wrapLines(text, maxChars, maxLines) {
    text = cleanText(text);
    if (text.length <= maxChars || maxLines < 2) return [text];
    let best = -1, bestScore = -Infinity;
    for (let i = 1; i < text.length - 1; i++) {
      if (text[i] !== " ") continue;
      const l1 = i, l2 = text.length - i - 1;
      if (l1 > maxChars || l2 > maxChars) continue;
      let score = -Math.abs(l1 - l2) / maxChars;
      if (l2 >= l1) score += 0.05; // pastki qator biroz uzunroq - klassik "piramida"
      const left = text.slice(0, i);
      if (STRONG.test(left)) score += 0.5;
      else if (MEDIUM.test(left)) score += 0.3;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) return [text.slice(0, best), text.slice(best + 1)];
    // Ikki qatorga sig'masa - ochko'z (greedy) usul
    const words = text.split(" "), lines = [];
    let cur = "";
    for (const w of words) {
      if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function toNumber(v) {
    if (typeof v === "number") return v;
    const s = String(v || "").trim();
    // "MM:SS.mmm" yoki "HH:MM:SS,mmm" ko'rinishlarini ham qabul qilamiz
    if (/^\d+(:\d+){1,2}([.,]\d+)?$/.test(s)) {
      return s.replace(",", ".").split(":").reduce((acc, p) => acc * 60 + parseFloat(p), 0);
    }
    return parseFloat(s);
  }

  /*
   * Asosiy funksiya: xom segmentlar -> tayyor subtitrlar.
   * raw: [{start, end, text}] ; range: {start, end} (ixtiyoriy, media vaqtida)
   */
  function buildCues(raw, options, range) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const limit = o.maxChars * Math.max(1, o.maxLines);
    const lo = range && isFinite(range.start) ? range.start : 0;
    const hi = range && isFinite(range.end) ? range.end : Infinity;

    // 1) tozalash va saralash
    let segs = (raw || [])
      .map((s) => ({ start: toNumber(s.start), end: toNumber(s.end), text: cleanText(s.text) }))
      .filter((s) => s.text && isFinite(s.start) && isFinite(s.end))
      .map((s) => (s.end < s.start ? { start: s.end, end: s.start, text: s.text } : s))
      .filter((s) => s.end > lo && s.start < hi)
      .map((s) => ({ start: Math.max(s.start, lo), end: Math.min(s.end, hi), text: s.text }))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    if (o.uzbekStyle) segs.forEach((s) => { s.text = normalizeUzbek(s.text, o.uzbekStyle); });

    // Bir xil matn ketma-ket takrorlansa (model xatosi) - birlashtiramiz
    const merged = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && last.text === s.text && s.start - last.end < 0.3) last.end = Math.max(last.end, s.end);
      else merged.push(s);
    }
    segs = merged;

    // 2) uzun segmentlarni bo'lish, vaqtni belgilar soniga mutanosib taqsimlash
    const cues = [];
    for (const s of segs) {
      let dur = Math.max(s.end - s.start, 0.01);
      let target = limit;
      if (dur > o.maxDuration && s.text.length > o.maxChars) {
        const n = Math.ceil(dur / o.maxDuration);
        target = Math.min(limit, Math.max(o.maxChars, Math.ceil(s.text.length / n) + 10));
      }
      const pieces = splitText(s.text, target);
      const total = pieces.reduce((a, p) => a + p.length, 0) || 1;
      let t = s.start, used = 0;
      pieces.forEach((p, idx) => {
        used += p.length;
        let end = idx === pieces.length - 1 ? s.end : s.start + (dur * used) / total;
        let nextStart = end;
        // Bo'linish nuqtasini haqiqiy pauzaga (waveform sukutiga) ko'chirish
        if (idx < pieces.length - 1 && o.silences) {
          let best = null;
          for (const sil of o.silences) {
            const mid = (sil.start + sil.end) / 2;
            if (mid <= t + 0.4 || mid >= s.end - 0.4 || Math.abs(mid - end) > 0.7) continue;
            if (!best || Math.abs(mid - end) < Math.abs((best.start + best.end) / 2 - end)) best = sil;
          }
          if (best) { end = Math.min(best.start + 0.12, best.end); nextStart = Math.max(end, best.end - 0.04); }
        }
        cues.push({ start: t, end: end, text: p });
        t = nextStart;
      });
    }

    // 3) ustma-ust tushishlarni tuzatish
    for (let i = 1; i < cues.length; i++) {
      const prev = cues[i - 1], cur = cues[i];
      if (cur.start < prev.end + o.gap) {
        prev.end = Math.max(prev.start + 0.3, cur.start - o.gap);
        if (cur.start < prev.end + o.gap) cur.start = prev.end + o.gap;
        if (cur.end < cur.start + 0.3) cur.end = cur.start + 0.3;
      }
    }

    // 4) minimal davomiylik, o'qish tezligi va kichik bo'shliqlarni yopish
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i], next = cues[i + 1];
      const ceiling = Math.min(next ? next.start - o.gap : hi, c.start + o.maxDuration);
      const want = Math.max(o.minDuration, c.text.length / o.maxCps);
      if (c.end - c.start < want) c.end = Math.max(c.end, Math.min(c.start + want, ceiling));
      if (next && next.start - c.end < o.chainGap && next.start - o.gap > c.end) {
        c.end = Math.min(next.start - o.gap, ceiling);
      }
      c.lines = wrapLines(c.text, o.maxChars, o.maxLines);
    }

    return cues.map((c, i) => ({
      index: i + 1,
      start: round3(c.start),
      end: round3(Math.max(c.end, c.start + 0.1)),
      text: c.lines.join("\n"),
    }));
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }

  function formatSrtTime(sec) {
    let ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    const p = (n, w) => String(n).padStart(w, "0");
    return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
  }

  function formatClock(sec) {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
  }

  /* cues -> SRT matni. offset: har bir vaqtga qo'shiladigan siljish (s) */
  function toSrt(cues, offset) {
    offset = offset || 0;
    return cues
      .filter((c) => cleanText(c.text))
      .map((c, i) => {
        const text = String(c.text).split("\n").map(cleanText).filter(Boolean).join("\r\n");
        return `${i + 1}\r\n${formatSrtTime(c.start + offset)} --> ${formatSrtTime(c.end + offset)}\r\n${text}\r\n`;
      })
      .join("\r\n");
  }

  const api = { DEFAULTS, buildCues, splitText, wrapLines, toSrt, formatSrtTime, formatClock, normalizeUzbek, cleanText, toNumber };
  root.GCSubs = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
