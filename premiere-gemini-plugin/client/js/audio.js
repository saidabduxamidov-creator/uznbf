/*
 * GeminiCut - audio tahlil (hammasi shu kompyuterda, internetsiz).
 *  - Premiere eksport qilgan WAV'ni bo'laklab o'qiydi (katta fayl ham xotirani
 *    to'ldirmaydi, panel qotmaydi) va 16 kHz mono'ga o'tkazadi.
 *  - VAD: har 10 ms energiyasiga qarab nutq va sukut joylarini topadi.
 *  - Pauzalar kadrgacha aniq shu yerda topiladi - AI kerak emas.
 *  - Uzun audioni sukut joylaridan bo'laklarga bo'ladi (AI aniqroq eshitadi).
 *  - AI bergan vaqtlarni haqiqiy nutq boshlanishi/tugashiga "yopishtiradi".
 */
(function (root) {
  "use strict";

  const TARGET_SR = 16000;
  const FRAME = 0.01; // VAD kadri, soniya

  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  function readHeader(fs, fd, fileSize) {
    const head = Buffer.alloc(Math.min(fileSize, 1 << 16));
    fs.readSync(fd, head, 0, head.length, 0);
    const riff = head.toString("ascii", 0, 4);
    if (riff === "FORM") return readAiff(head, fileSize);
    if ((riff !== "RIFF" && riff !== "RF64") || head.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Eksport qilingan fayl WAV emas. Sozlamalarda WAV (Waveform Audio) presetini tanlang.");
    }
    let pos = 12, fmt = null, dataOffset = -1, dataSize = 0;
    while (pos + 8 <= head.length) {
      const id = head.toString("ascii", pos, pos + 4);
      const size = head.readUInt32LE(pos + 4);
      if (id === "fmt ") {
        let format = head.readUInt16LE(pos + 8);
        const channels = head.readUInt16LE(pos + 10);
        const sampleRate = head.readUInt32LE(pos + 12);
        const blockAlign = head.readUInt16LE(pos + 20);
        const bits = head.readUInt16LE(pos + 22);
        if (format === 0xfffe && size >= 40) format = head.readUInt16LE(pos + 32); // WAVE_FORMAT_EXTENSIBLE
        fmt = { format, channels, sampleRate, blockAlign, bits };
      } else if (id === "data") {
        dataOffset = pos + 8;
        dataSize = size === 0 || size === 0xffffffff || dataOffset + size > fileSize ? fileSize - dataOffset : size;
        break;
      }
      pos += 8 + size + (size & 1);
    }
    if (!fmt || dataOffset < 0) throw new Error("WAV fayl tuzilishi noto'g'ri.");
    if (!((fmt.format === 1 && [16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && fmt.bits === 32))) {
      throw new Error(`Bu WAV formati qo'llab-quvvatlanmaydi (format ${fmt.format}, ${fmt.bits}-bit). 16/24-bit PCM preset tanlang.`);
    }
    return { fmt, dataOffset, dataSize };
  }

  /* AIFF / AIFC (After Effects "AIFF 48kHz" shabloni): katta-endian PCM, SSND bo'lagi */
  function readAiff(head, fileSize) {
    const kind = head.toString("ascii", 8, 12);
    if (kind !== "AIFF" && kind !== "AIFC") throw new Error("Eksport qilingan fayl WAV/AIFF emas.");
    let pos = 12, fmt = null, dataOffset = -1, dataSize = 0;
    while (pos + 8 <= head.length) {
      const id = head.toString("ascii", pos, pos + 4);
      const size = head.readUInt32BE(pos + 4);
      if (id === "COMM") {
        const channels = head.readUInt16BE(pos + 8);
        const bits = head.readUInt16BE(pos + 14);
        const e = ((head[pos + 16] & 0x7f) << 8) | head[pos + 17];
        const mant = head.readUInt32BE(pos + 18) * Math.pow(2, -31) + head.readUInt32BE(pos + 22) * Math.pow(2, -63);
        const sampleRate = Math.round(mant * Math.pow(2, e - 16383));
        const comp = kind === "AIFC" && size >= 22 ? head.toString("ascii", pos + 26, pos + 30) : "NONE";
        if (comp !== "NONE" && comp !== "sowt") throw new Error("AIFF siqilgan (" + comp + ") - qo'llab-quvvatlanmaydi.");
        fmt = { format: 1, channels, sampleRate, blockAlign: channels * (bits / 8), bits, bigEndian: comp !== "sowt" };
      } else if (id === "SSND") {
        const off = head.readUInt32BE(pos + 8);
        dataOffset = pos + 16 + off;
        dataSize = Math.min(size - 8 - off, fileSize - dataOffset);
        break;
      }
      pos += 8 + size + (size & 1);
    }
    if (!fmt || dataOffset < 0) throw new Error("AIFF fayl tuzilishi noto'g'ri.");
    if (![16, 24, 32].includes(fmt.bits)) throw new Error(`Bu AIFF formati qo'llab-quvvatlanmaydi (${fmt.bits}-bit).`);
    return { fmt, dataOffset, dataSize };
  }

  /* WAV -> Float32Array (16 kHz, mono). onProgress(0..1) */
  async function decodeWav(path, onProgress) {
    const fs = require("fs");
    const fileSize = fs.statSync(path).size;
    const fd = fs.openSync(path, "r");
    try {
      const { fmt, dataOffset, dataSize } = readHeader(fs, fd, fileSize);
      const { channels, sampleRate, blockAlign, bits, format } = fmt;
      const bytesPerSample = bits / 8;
      const totalFrames = Math.floor(dataSize / blockAlign);
      const ratio = sampleRate / TARGET_SR;
      const out = new Float32Array(Math.ceil(totalFrames / ratio) + 1);

      const read = fmt.bigEndian
        ? (bits === 16 ? (b, o) => b.readInt16BE(o) / 32768 : bits === 24 ? (b, o) => b.readIntBE(o, 3) / 8388608 : (b, o) => b.readInt32BE(o) / 2147483648)
        : format === 3
        ? (b, o) => b.readFloatLE(o)
        : bits === 16 ? (b, o) => b.readInt16LE(o) / 32768
          : bits === 24 ? (b, o) => b.readIntLE(o, 3) / 8388608
            : (b, o) => b.readInt32LE(o) / 2147483648;

      const framesPerBlock = 1 << 16;
      const buf = Buffer.alloc(framesPerBlock * blockAlign);
      let frameIndex = 0, outIndex = 0, acc = 0, accN = 0;
      while (frameIndex < totalFrames) {
        const n = Math.min(framesPerBlock, totalFrames - frameIndex);
        fs.readSync(fd, buf, 0, n * blockAlign, dataOffset + frameIndex * blockAlign);
        for (let f = 0; f < n; f++) {
          let v = 0;
          const base = f * blockAlign;
          for (let c = 0; c < channels; c++) v += read(buf, base + c * bytesPerSample);
          v /= channels;
          // "box" filtr bilan pasaytirish: har bir chiqish namunasi - kiruvchilar o'rtachasi
          const target = Math.floor((frameIndex + f) / ratio);
          if (target !== outIndex && accN) { out[outIndex] = acc / accN; outIndex = target; acc = 0; accN = 0; }
          acc += v; accN++;
        }
        frameIndex += n;
        if (onProgress) onProgress(frameIndex / totalFrames);
        await yieldUI();
      }
      if (accN) out[outIndex++] = acc / accN;
      return { sampleRate: TARGET_SR, samples: out.subarray(0, outIndex), duration: outIndex / TARGET_SR };
    } finally {
      fs.closeSync(fd);
    }
  }

  /* Nutq joylarini topadi. Qaytaradi: { regions:[{start,end}], silences:[{start,end}], db, noise, threshold } */
  function detectSpeech(audio, opts) {
    const o = Object.assign({ minSpeech: 0.08, hangover: 0.18, sensitivity: 0 }, opts || {});
    const { samples, sampleRate } = audio;
    const hop = Math.round(sampleRate * FRAME);
    const frames = Math.floor(samples.length / hop);
    const db = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      const s = i * hop;
      for (let j = 0; j < hop; j++) { const v = samples[s + j]; sum += v * v; }
      db[i] = 10 * Math.log10(sum / hop + 1e-12);
    }
    // Moslashuvchan chegara: shovqin darajasi (10-persentil) va baland nutq (95-persentil) orasida
    const sorted = Array.from(db).filter((v) => v > -100).sort((a, b) => a - b);
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : -100);
    const noise = pct(0.1), loud = pct(0.95);
    let threshold = Math.max(noise + 8, Math.min(loud - 30, noise + 20), -55) - o.sensitivity;
    if (loud - noise < 10) threshold = noise + (loud - noise) / 2; // juda bir xil signal

    const voiced = new Uint8Array(frames);
    for (let i = 0; i < frames; i++) voiced[i] = db[i] > threshold ? 1 : 0;

    // Qisqa uzilishlarni yopish (so'zlar orasidagi mikropauzalar)
    const hang = Math.round(o.hangover / FRAME);
    let lastVoiced = -1e9;
    for (let i = 0; i < frames; i++) {
      if (voiced[i]) {
        if (i - lastVoiced > 1 && i - lastVoiced <= hang) for (let k = lastVoiced + 1; k < i; k++) voiced[k] = 1;
        lastVoiced = i;
      }
    }
    const regions = [];
    let start = -1;
    for (let i = 0; i <= frames; i++) {
      const v = i < frames && voiced[i];
      if (v && start < 0) start = i;
      if (!v && start >= 0) {
        if ((i - start) * FRAME >= o.minSpeech) regions.push({ start: start * FRAME, end: i * FRAME });
        start = -1;
      }
    }
    const silences = [];
    let prev = 0;
    for (const r of regions) {
      if (r.start - prev > 0.001) silences.push({ start: prev, end: r.start });
      prev = r.end;
    }
    if (audio.duration - prev > 0.001) silences.push({ start: prev, end: audio.duration });
    return { regions, silences, db, noise, threshold };
  }

  /* Audioni ~target soniyalik bo'laklarga, eng uzun sukut o'rtasidan bo'ladi */
  function planChunks(duration, silences, target, max) {
    target = target || 240; max = max || 300;
    const chunks = [];
    let pos = 0;
    while (duration - pos > max) {
      const lo = pos + target * 0.75, hi = pos + max;
      let best = null;
      for (const s of silences) {
        const a = Math.max(s.start, lo), b = Math.min(s.end, hi);
        if (b - a > 0 && (!best || b - a > best.b - best.a)) best = { a, b };
      }
      const cut = best ? (best.a + best.b) / 2 : hi;
      chunks.push({ start: pos, end: cut });
      pos = cut;
    }
    chunks.push({ start: pos, end: duration });
    return chunks;
  }

  /* Float32 bo'lakni 16-bit mono WAV Buffer'ga aylantiradi */
  function encodeWav(audio, start, end) {
    const sr = audio.sampleRate;
    const a = Math.max(0, Math.floor(start * sr)), b = Math.min(audio.samples.length, Math.ceil(end * sr));
    const n = Math.max(0, b - a);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
    // Yumshoq normallashtirish: past ovozli yozuvlarni AI yaxshiroq eshitishi uchun
    let peak = 0;
    for (let i = a; i < b; i++) { const v = Math.abs(audio.samples[i]); if (v > peak) peak = v; }
    const gain = peak > 0 ? Math.min(8, 0.9 / peak) : 1;
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, audio.samples[a + i] * gain));
      buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    return buf;
  }

  /*
   * AI vaqtlarini haqiqiy nutq chegaralariga moslaydi.
   * segs: [{start,end,...}] (audio vaqtida), regions: detectSpeech().regions
   */
  function snapToSpeech(segs, regions, opts) {
    const o = Object.assign({ reach: 0.45, lead: 0.04, tail: 0.12 }, opts || {});
    if (!regions.length) return segs;
    const findRegion = (t) => {
      let lo = 0, hi = regions.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (regions[mid].end < t) lo = mid + 1; else if (regions[mid].start > t) hi = mid - 1; else return mid;
      }
      return -(lo + 1); // t sukutda; lo = keyingi nutq indeksi
    };
    return segs.map((s) => {
      let start = s.start, end = s.end;
      const rs = findRegion(start);
      if (rs >= 0) {
        if (start - regions[rs].start <= o.reach) start = regions[rs].start;
      } else {
        const next = regions[-rs - 1];
        if (next && next.start - start <= o.reach && next.start < end) start = next.start;
      }
      const re = findRegion(end);
      if (re >= 0) {
        if (regions[re].end - end <= o.reach) end = regions[re].end;
      } else {
        const prev = regions[-re - 2];
        if (prev && end - prev.end <= o.reach && prev.end > start) end = prev.end;
      }
      return Object.assign({}, s, { start: Math.max(0, start - o.lead), end: end + o.tail });
    });
  }

  const api = { TARGET_SR, decodeWav, detectSpeech, planChunks, encodeWav, snapToSpeech };
  root.GCAudio = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
