/*
 * GeminiCut - Gemini API mijozi (Node.js https orqali).
 *  - Asosiy usul: faqat nutq audiosi (16 kHz mono WAV) so'rov ichida yuboriladi.
 *  - Files API (oqimli yuklash) ham saqlangan - kerak bo'lsa.
 *  - Har bir so'rovda timeout, bekor qilish (cancel) va qayta urinish bor.
 *  - API kalit URL'da emas, sarlavhada (x-goog-api-key) yuboriladi.
 */
(function (root) {
  "use strict";

  const https = require("https");
  const fs = require("fs");
  const pathMod = require("path");
  const HOST = "generativelanguage.googleapis.com";

  const MIME = {
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
    webm: "video/webm", wmv: "video/x-ms-wmv", mpg: "video/mpeg", mpeg: "video/mpeg",
    flv: "video/x-flv", "3gp": "video/3gpp", mkv: "video/x-matroska",
    mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", m4a: "audio/aac",
    flac: "audio/flac", ogg: "audio/ogg", aif: "audio/aiff", aiff: "audio/aiff",
  };

  class GeminiError extends Error {
    constructor(message, code) { super(message); this.code = code || "ERROR"; }
  }

  function createCancelToken() {
    const reqs = new Set();
    return {
      cancelled: false,
      track(req) { reqs.add(req); req.on("close", () => reqs.delete(req)); },
      cancel() { this.cancelled = true; reqs.forEach((r) => r.destroy(new GeminiError("Bekor qilindi.", "CANCELLED"))); },
      check() { if (this.cancelled) throw new GeminiError("Bekor qilindi.", "CANCELLED"); },
    };
  }

  function sleep(ms, token) {
    return new Promise((resolve, reject) => {
      const step = 200;
      let left = ms;
      const timer = setInterval(() => {
        if (token && token.cancelled) { clearInterval(timer); reject(new GeminiError("Bekor qilindi.", "CANCELLED")); }
        left -= step;
        if (left <= 0) { clearInterval(timer); resolve(); }
      }, step);
    });
  }

  function friendlyNetworkError(err) {
    const code = err && err.code;
    if (code === "CANCELLED") return err;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new GeminiError("Internetga ulanib bo'lmadi. Tarmoqni tekshiring.", "NETWORK");
    if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE") return new GeminiError("Server bilan aloqa uzildi. Qayta urinib ko'ring.", "NETWORK");
    if (code === "TIMEOUT") return err;
    return new GeminiError("Tarmoq xatosi: " + (err && err.message ? err.message : err), "NETWORK");
  }

  /* Umumiy HTTPS so'rov. stream berilsa - fayl oqim bilan yuboriladi. */
  function request(opts) {
    const { method, url, headers, body, filePath, fileSize, onProgress, token } = opts;
    const idleTimeout = opts.timeout || 120000;
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        method, hostname: u.hostname, path: u.pathname + u.search, headers: headers || {},
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => reject(friendlyNetworkError(e)));
      });
      if (token) token.track(req);
      req.setTimeout(idleTimeout, () => req.destroy(new GeminiError("Server javob bermadi (timeout). Qayta urinib ko'ring.", "TIMEOUT")));
      req.on("error", (e) => reject(e instanceof GeminiError ? e : friendlyNetworkError(e)));

      if (filePath) {
        let sent = 0;
        const rs = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
        rs.on("data", (chunk) => { sent += chunk.length; if (onProgress) onProgress(sent, fileSize); });
        rs.on("error", (e) => req.destroy(new GeminiError("Faylni o'qib bo'lmadi: " + e.message, "FILE")));
        rs.pipe(req);
      } else {
        if (body) req.write(body);
        req.end();
      }
    });
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function apiError(res) {
    const j = parseJson(res.text);
    const msg = j && j.error ? j.error.message : res.text.slice(0, 300);
    const reason = j && j.error && j.error.details ? JSON.stringify(j.error.details) : "";
    if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(msg + reason)) return new GeminiError("API kalit noto'g'ri. Sozlamalarda tekshiring.", "AUTH");
    if (res.status === 401 || res.status === 403) {
      if (/location|region|country/i.test(msg)) return new GeminiError("Gemini API sizning hududingizda ishlamayapti. VPN yoki boshqa tarmoq orqali urinib ko'ring.", "REGION");
      return new GeminiError("Ruxsat yo'q: API kalitni tekshiring. (" + msg + ")", "AUTH");
    }
    if (res.status === 404) return new GeminiError("Model yoki fayl topilmadi: " + msg, "NOT_FOUND");
    if (res.status === 429) return new GeminiError("Gemini limiti tugadi (429). Bir oz kutib qayta urinib ko'ring yoki boshqa modelni tanlang.", "RATE");
    if (res.status >= 500) return new GeminiError("Gemini serverida vaqtinchalik xato (" + res.status + ").", "SERVER");
    return new GeminiError("Gemini xatosi (" + res.status + "): " + msg, "API");
  }

  function isRetryable(err) {
    return err && (err.code === "RATE" || err.code === "SERVER" || err.code === "NETWORK" || err.code === "TIMEOUT");
  }

  async function withRetry(fn, token, onRetry, attempts) {
    attempts = attempts || 4;
    let last;
    for (let i = 0; i < attempts; i++) {
      if (token) token.check();
      try { return await fn(); } catch (e) {
        last = e;
        if (!isRetryable(e) || i === attempts - 1) throw e;
        const wait = Math.min(30000, 2000 * Math.pow(2, i));
        if (onRetry) onRetry(e, Math.round(wait / 1000));
        await sleep(wait, token);
      }
    }
    throw last;
  }

  function mimeFor(filePath) {
    const ext = pathMod.extname(filePath).slice(1).toLowerCase();
    return MIME[ext] || null;
  }

  async function testKey(apiKey) {
    const res = await request({
      method: "GET", url: `https://${HOST}/v1beta/models?pageSize=50`,
      headers: { "x-goog-api-key": apiKey }, timeout: 20000,
    });
    if (res.status !== 200) throw apiError(res);
    const j = parseJson(res.text) || {};
    return (j.models || []).map((m) => m.name.replace(/^models\//, ""));
  }

  /* Faylni Gemini Files API'ga resumable usulda oqim bilan yuklaydi */
  async function uploadFile(filePath, apiKey, { onProgress, token } = {}) {
    const stat = fs.statSync(filePath);
    const mime = mimeFor(filePath);
    if (!mime) throw new GeminiError("Bu fayl formati Gemini tomonidan qo'llab-quvvatlanmaydi: " + pathMod.extname(filePath) + ". MP4 yoki MOV formatiga eksport qiling.", "FORMAT");
    if (stat.size > 2 * 1024 * 1024 * 1024) throw new GeminiError("Fayl 2 GB dan katta. Videoni kichikroq hajmda (masalan 1080p H.264) eksport qiling.", "SIZE");

    const start = await withRetry(async () => {
      const res = await request({
        method: "POST", url: `https://${HOST}/upload/v1beta/files`, token, timeout: 60000,
        headers: {
          "x-goog-api-key": apiKey,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(stat.size),
          "X-Goog-Upload-Header-Content-Type": mime,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: pathMod.basename(filePath).slice(0, 120) } }),
      });
      if (res.status !== 200) throw apiError(res);
      return res;
    }, token);

    const uploadUrl = start.headers["x-goog-upload-url"];
    if (!uploadUrl) throw new GeminiError("Yuklash manzili olinmadi. API kalitni tekshiring.", "API");

    const res = await request({
      method: "POST", url: uploadUrl, token, timeout: 180000,
      filePath, fileSize: stat.size, onProgress,
      headers: {
        "Content-Length": String(stat.size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
    });
    if (res.status !== 200) throw apiError(res);
    const j = parseJson(res.text);
    if (!j || !j.file) throw new GeminiError("Yuklash javobi noto'g'ri.", "API");
    return j.file;
  }

  async function getFile(name, apiKey, token) {
    const res = await request({ method: "GET", url: `https://${HOST}/v1beta/${name}`, headers: { "x-goog-api-key": apiKey }, token, timeout: 30000 });
    if (res.status === 404 || res.status === 403) return null;
    if (res.status !== 200) throw apiError(res);
    return parseJson(res.text);
  }

  async function waitUntilActive(file, apiKey, { token, onTick } = {}) {
    const started = Date.now();
    let f = file;
    while (f.state !== "ACTIVE") {
      if (f.state === "FAILED") throw new GeminiError("Gemini videoni qayta ishlay olmadi. Boshqa formatda (MP4 H.264) eksport qilib ko'ring.", "FILE_FAILED");
      if (Date.now() - started > 15 * 60 * 1000) throw new GeminiError("Video qayta ishlanishi juda uzoq cho'zildi.", "TIMEOUT");
      await sleep(2500, token);
      if (onTick) onTick(Math.round((Date.now() - started) / 1000));
      f = await withRetry(() => getFile(f.name, apiKey, token), token) || f;
    }
    return f;
  }

  async function deleteFile(name, apiKey) {
    try {
      await request({ method: "DELETE", url: `https://${HOST}/v1beta/${name}`, headers: { "x-goog-api-key": apiKey }, timeout: 20000 });
    } catch (e) { /* muhim emas */ }
  }

  function extractText(j) {
    if (j.promptFeedback && j.promptFeedback.blockReason) {
      throw new GeminiError("Gemini so'rovni rad etdi: " + j.promptFeedback.blockReason, "BLOCKED");
    }
    const cand = j.candidates && j.candidates[0];
    if (!cand) throw new GeminiError("Gemini bo'sh javob qaytardi.", "EMPTY");
    const text = ((cand.content && cand.content.parts) || [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    if (cand.finishReason === "MAX_TOKENS") {
      throw new GeminiError("Video juda uzun - javob sig'madi. Timeline'da klipni qisqaroq bo'laklarga bo'lib, har birini alohida ishlang.", "TOO_LONG");
    }
    if (!text) throw new GeminiError("Gemini javobida matn yo'q (" + (cand.finishReason || "?") + ").", "EMPTY");
    return text;
  }

  function parseModelJson(text) {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const j = parseJson(cleaned);
    if (j) return j;
    const m = cleaned.match(/\{[\s\S]*\}/);
    const inner = m && parseJson(m[0]);
    if (inner) return inner;
    throw new GeminiError("Gemini javobini o'qib bo'lmadi (JSON xato). Qayta urinib ko'ring.", "PARSE");
  }

  /*
   * generateContent -> JSON.
   * audio: Buffer (WAV) - so'rov ichida yuboriladi (inline, 20 MB gacha)
   * file:  Files API fayli (ixtiyoriy);  ikkalasi bo'lmasa - faqat matnli so'rov
   */
  async function generateJson({ apiKey, model, file, audio, prompt, schema, token, onRetry, temperature }) {
    const parts = [];
    if (audio) parts.push({ inline_data: { mime_type: "audio/wav", data: audio.toString("base64") } });
    if (file) parts.push({ file_data: { file_uri: file.uri, mime_type: file.mimeType } });
    parts.push({ text: prompt });
    const payload = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: temperature == null ? 0.1 : temperature,
        maxOutputTokens: 65536,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    };
    return withRetry(async () => {
      const res = await request({
        method: "POST", url: `https://${HOST}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload), token, timeout: 600000,
      });
      if (res.status !== 200) throw apiError(res);
      const j = parseJson(res.text);
      if (!j) throw new GeminiError("Gemini javobi noto'g'ri formatda.", "SERVER");
      return parseModelJson(extractText(j));
    }, token, onRetry, 3);
  }

  root.GCGemini = { GeminiError, createCancelToken, testKey, uploadFile, getFile, waitUntilActive, deleteFile, generateJson, mimeFor };
})(typeof window !== "undefined" ? window : globalThis);
