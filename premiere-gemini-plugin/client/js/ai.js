/*
 * GeminiCut - umumiy AI mijozlari.
 *  - Claude (Anthropic Messages API): claude-opus-5-5, adaptive thinking,
 *    structured output (output_config.format), rasm (vision), refusal fallback.
 *    Premiere ichidagi Node eski bo'lishi va foydalanuvchi hech narsa o'rnatmasligi
 *    uchun rasmiy SDK o'rniga to'g'ridan-to'g'ri HTTPS ishlatiladi.
 *  - Matn yozish/tekshirish uchun umumiy interfeys: Claude yoki Gemini.
 */
(function (root) {
  "use strict";

  const https = require("https");
  const CLAUDE_MODEL = "claude-opus-5-5";

  class AIError extends Error {
    constructor(message, code) { super(message); this.code = code || "ERROR"; }
  }

  function post(url, headers, body, token, timeout) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const data = Buffer.from(JSON.stringify(body));
      const req = https.request({ method: "POST", hostname: u.hostname, path: u.pathname + u.search,
        headers: Object.assign({ "Content-Type": "application/json", "Content-Length": data.length }, headers) }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
      if (token) token.track(req);
      req.setTimeout(timeout || 600000, () => req.destroy(new AIError("AI javob bermadi (timeout).", "TIMEOUT")));
      req.on("error", (e) => reject(e instanceof AIError ? e : e.code === "CANCELLED" ? e
        : new AIError(/ENOTFOUND|EAI_AGAIN/.test(e.code) ? "Internetga ulanib bo'lmadi." : "Tarmoq xatosi: " + e.message, "NETWORK")));
      req.end(data);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* JSON sxemani Claude structured output talablariga keltiradi: har bir obyektda
     additionalProperties:false va barcha maydonlar required */
  function strictSchema(s) {
    if (!s || typeof s !== "object") return s;
    const out = Array.isArray(s) ? s.map(strictSchema) : {};
    if (Array.isArray(s)) return out;
    for (const k of Object.keys(s)) out[k] = k === "properties" ? Object.fromEntries(Object.entries(s.properties).map(([n, v]) => [n, strictSchema(v)])) : strictSchema(s[k]);
    if (s.type === "object") { out.additionalProperties = false; out.required = Object.keys(s.properties || {}); }
    return out;
  }

  /* Xuddi shu sxemani Gemini responseSchema ko'rinishiga o'tkazadi */
  function geminiSchema(s) {
    if (!s || typeof s !== "object") return s;
    const out = {};
    if (s.type) out.type = String(s.type).toUpperCase();
    if (s.description) out.description = s.description;
    if (s.enum) out.enum = s.enum;
    if (s.items) out.items = geminiSchema(s.items);
    if (s.properties) {
      out.properties = Object.fromEntries(Object.entries(s.properties).map(([n, v]) => [n, geminiSchema(v)]));
      out.required = Object.keys(s.properties);
      out.propertyOrdering = Object.keys(s.properties);
    }
    return out;
  }

  function claudeError(res) {
    let j = null;
    try { j = JSON.parse(res.text); } catch (e) { /* matn */ }
    const msg = (j && j.error && j.error.message) || res.text.slice(0, 300);
    if (res.status === 401) return new AIError("Claude API kalit noto'g'ri. Sozlamalarda tekshiring.", "AUTH");
    if (res.status === 403) return new AIError("Claude: ruxsat yo'q (" + msg + ")", "AUTH");
    if (res.status === 429) return new AIError("Claude limiti tugadi (429). Bir oz kutib qayta urinib ko'ring.", "RATE");
    if (res.status === 529 || res.status >= 500) return new AIError("Claude serveri band (" + res.status + ").", "SERVER");
    if (res.status === 400 && /credit|balance/i.test(msg)) return new AIError("Anthropic hisobida kredit yetarli emas.", "BILLING");
    return new AIError("Claude xatosi (" + res.status + "): " + msg, "API");
  }

  /*
   * Claude chaqiruvi.
   *  content: [{type:"text"|"image", ...}] - foydalanuvchi xabari bloklari
   *  schema:  JSON sxema (bo'lsa javob JSON obyekt qaytadi), aks holda matn
   */
  async function claude({ apiKey, system, content, schema, effort, maxTokens, token, onRetry, model }) {
    if (!apiKey) throw new AIError("Sozlamalarda Claude (Anthropic) API kalitini kiriting.", "AUTH");
    const body = {
      model: model || CLAUDE_MODEL,
      max_tokens: maxTokens || 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: effort || "high" },
      fallbacks: "default",
      system,
      messages: [{ role: "user", content }],
    };
    if (schema) body.output_config.format = { type: "json_schema", schema: strictSchema(schema) };
    const headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" };

    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (token) token.check();
      res = await post("https://api.anthropic.com/v1/messages", headers, body, token);
      // Fallback parametri qabul qilinmasa - usiz qayta yuboramiz
      if (res.status === 400 && /fallback/i.test(res.text) && body.fallbacks) {
        delete body.fallbacks; delete headers["anthropic-beta"]; attempt--; continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = Number(res.headers["retry-after"]) * 1000 || 2000 * Math.pow(2, attempt);
        if (onRetry) onRetry(claudeError(res), Math.round(wait / 1000));
        await sleep(Math.min(wait, 30000));
        continue;
      }
      break;
    }
    if (res.status !== 200) throw claudeError(res);
    const msg = JSON.parse(res.text);
    if (msg.stop_reason === "refusal") throw new AIError("Claude bu so'rovni bajarishdan bosh tortdi. Promptni o'zgartirib ko'ring.", "REFUSAL");
    if (msg.stop_reason === "max_tokens") throw new AIError("Claude javobi juda uzun bo'lib ketdi. So'rovni qisqartiring.", "TOO_LONG");
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (!schema) return text.trim();
    try { return JSON.parse(text); } catch (e) { throw new AIError("Claude javobini o'qib bo'lmadi.", "PARSE"); }
  }

  async function testClaude(apiKey) {
    const text = await claude({ apiKey, effort: "low", maxTokens: 2000, content: [{ type: "text", text: "Reply with exactly: OK" }] });
    return text;
  }

  /*
   * Matn AI: settings.textAI = "claude" | "gemini" (kalit bo'lmasa - bori ishlatiladi).
   * schema berilsa JSON obyekt, aks holda matn qaytadi.
   */
  function pickProvider(s) {
    if (s.textAI === "claude" && s.claudeKey) return "claude";
    if (s.textAI === "gemini" && s.apiKey) return "gemini";
    if (s.claudeKey) return "claude";
    if (s.apiKey) return "gemini";
    throw new AIError("Sozlamalarda Gemini yoki Claude API kalitini kiriting.", "AUTH");
  }

  async function text({ settings, system, prompt, schema, token, effort }) {
    const provider = pickProvider(settings);
    if (provider === "claude") {
      return claude({ apiKey: settings.claudeKey, system, content: [{ type: "text", text: prompt }], schema, effort: effort || "medium", token });
    }
    const model = settings.model === "custom" ? (settings.customModel || "gemini-2.5-flash") : settings.model;
    const full = (system ? system + "\n\n" : "") + prompt;
    if (schema) {
      return root.GCGemini.generateJson({ apiKey: settings.apiKey, model, prompt: full, schema: geminiSchema(schema), token, temperature: 0.3 });
    }
    return root.GCGemini.generateText({ apiKey: settings.apiKey, model, prompt: full, token });
  }

  root.GCAI = { CLAUDE_MODEL, AIError, claude, testClaude, text, strictSchema, geminiSchema, pickProvider };
})(typeof window !== "undefined" ? window : globalThis);
