/*
 * GeminiCut - umumiy AI mijozlari.
 *  - Claude (Anthropic Messages API): claude-opus-5-5, adaptive thinking,
 *    structured output (output_config.format), rasm (vision), refusal fallback.
 *    Premiere ichidagi Node eski bo'lishi va foydalanuvchi hech narsa o'rnatmasligi
 *    uchun rasmiy SDK o'rniga to'g'ridan-to'g'ri HTTPS ishlatiladi.
 *  - ChatGPT (OpenAI Chat Completions API): model avtomatik tanlanadi (kalitga ochiq
 *    eng yangi GPT), rasm (vision), strict JSON sxema.
 *  - Matn yozish/tekshirish uchun umumiy interfeys: Claude, ChatGPT yoki Gemini.
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
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = https.request({ method: data ? "POST" : "GET", hostname: u.hostname, path: u.pathname + u.search,
        headers: Object.assign(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}, headers) }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
      if (token) token.track(req);
      req.setTimeout(timeout || 600000, () => req.destroy(new AIError("AI javob bermadi (timeout).", "TIMEOUT")));
      req.on("error", (e) => reject(e instanceof AIError ? e : e.code === "CANCELLED" ? e
        : new AIError(/ENOTFOUND|EAI_AGAIN/.test(e.code) ? "Internetga ulanib bo'lmadi." : "Tarmoq xatosi: " + e.message, "NETWORK")));
      req.end(data || undefined);
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

  /* ================= ChatGPT (OpenAI) ================= */

  function openaiError(res) {
    let j = null;
    try { j = JSON.parse(res.text); } catch (e) { /* matn */ }
    const err = (j && j.error) || {};
    const msg = err.message || res.text.slice(0, 300);
    if (res.status === 401) return new AIError("ChatGPT (OpenAI) API kalit noto'g'ri. Sozlamalarda tekshiring.", "AUTH");
    if (res.status === 429 && /quota|billing/i.test(err.code + " " + msg)) return new AIError("OpenAI hisobida mablag' yo'q (insufficient_quota). platform.openai.com > Billing da to'ldiring.", "BILLING");
    if (res.status === 429) return new AIError("ChatGPT limiti (429). Bir oz kutib qayta urinib ko'ring.", "RATE");
    if (res.status === 403) return new AIError("ChatGPT: ruxsat yo'q - " + msg, "AUTH");
    if (res.status === 404) return new AIError("ChatGPT modeli topilmadi: " + msg, "MODEL");
    if (res.status >= 500) return new AIError("OpenAI serveri band (" + res.status + ").", "SERVER");
    return new AIError("ChatGPT xatosi (" + res.status + "): " + msg, "API");
  }

  /* Kalitga ochiq modellar ichidan eng yangi umumiy GPT modelini tanlaydi (gpt-5.x > gpt-5 > gpt-4.1 > gpt-4o) */
  function bestOpenAIModel(ids) {
    const ver = (id) => { const m = /^gpt-(\d+)(?:\.(\d+))?$/.exec(id); return m ? Number(m[1]) + Number(m[2] || 0) / 100 : 0; };
    const top = ids.filter((id) => ver(id) >= 4.01).sort((a, b) => ver(b) - ver(a))[0];
    return top || ["gpt-4o", "gpt-4o-mini"].find((m) => ids.includes(m)) || ids.find((id) => /^gpt-/.test(id)) || "gpt-4o";
  }

  let openaiModels = null; // { key, ids, best }
  async function listOpenAIModels(apiKey, token) {
    if (openaiModels && openaiModels.key === apiKey) return openaiModels;
    const res = await post("https://api.openai.com/v1/models", { Authorization: "Bearer " + apiKey }, undefined, token, 30000);
    if (res.status !== 200) throw openaiError(res);
    const ids = (JSON.parse(res.text).data || []).map((m) => m.id).sort();
    openaiModels = { key: apiKey, ids, best: bestOpenAIModel(ids) };
    return openaiModels;
  }

  /* Claude uslubidagi content bloklarini OpenAI formatiga o'tkazadi */
  function openaiContent(content) {
    return (content || []).map((b) => b.type === "image"
      ? { type: "image_url", image_url: { url: "data:" + b.source.media_type + ";base64," + b.source.data, detail: "auto" } }
      : { type: "text", text: b.text });
  }

  /*
   * ChatGPT chaqiruvi - claude() bilan bir xil interfeys.
   *  model bo'sh bo'lsa - kalitga ochiq eng yangi GPT avtomatik tanlanadi.
   */
  async function openai({ apiKey, model, system, content, schema, effort, maxTokens, token, onRetry }) {
    if (!apiKey) throw new AIError("Sozlamalarda ChatGPT (OpenAI) API kalitini kiriting.", "AUTH");
    const name = model || (await listOpenAIModels(apiKey, token)).best;
    const body = {
      model: name,
      messages: (system ? [{ role: "system", content: system }] : []).concat([{ role: "user", content: openaiContent(content) }]),
      max_completion_tokens: maxTokens || 16000,
    };
    if (/^(gpt-5|o\d)/.test(name) && !/chat/.test(name)) body.reasoning_effort = effort === "high" ? "high" : effort === "low" ? "low" : "medium";
    if (schema) body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: strictSchema(schema) } };
    const headers = { Authorization: "Bearer " + apiKey };

    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (token) token.check();
      res = await post("https://api.openai.com/v1/chat/completions", headers, body, token);
      // Eski modellar ba'zi parametrlarni bilmaydi - ularsiz qayta yuboramiz
      if (res.status === 400) {
        const t = res.text;
        if (body.reasoning_effort && /reasoning_effort/.test(t)) { delete body.reasoning_effort; attempt--; continue; }
        if (body.max_completion_tokens && /max_completion_tokens/.test(t)) { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; attempt--; continue; }
        if (body.response_format && body.response_format.type === "json_schema" && /response_format|json_schema/.test(t)) {
          body.response_format = { type: "json_object" };
          body.messages.unshift({ role: "system", content: "Reply with one JSON object that follows this JSON schema exactly:\n" + JSON.stringify(schema) });
          attempt--; continue;
        }
      }
      if ((res.status === 429 && !/quota/i.test(res.text) || res.status >= 500) && attempt < 3) {
        const wait = Number(res.headers["retry-after"]) * 1000 || 2000 * Math.pow(2, attempt);
        if (onRetry) onRetry(openaiError(res), Math.round(wait / 1000));
        await sleep(Math.min(wait, 30000));
        continue;
      }
      break;
    }
    if (res.status !== 200) throw openaiError(res);
    const msg = JSON.parse(res.text);
    const choice = (msg.choices || [])[0] || {};
    const m = choice.message || {};
    if (m.refusal) throw new AIError("ChatGPT bu so'rovni bajarmadi: " + m.refusal, "REFUSAL");
    if (choice.finish_reason === "length") throw new AIError("ChatGPT javobi juda uzun bo'lib ketdi. So'rovni qisqartiring.", "TOO_LONG");
    const text = typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text || "").join("");
    if (!schema) return text.trim();
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch (e) { throw new AIError("ChatGPT javobini o'qib bo'lmadi.", "PARSE"); }
  }

  async function testOpenAI(apiKey) {
    openaiModels = null;
    const m = await listOpenAIModels(apiKey);
    await openai({ apiKey, model: m.best, effort: "low", maxTokens: 2000, content: [{ type: "text", text: "Reply with exactly: OK" }] });
    return m;
  }

  /*
   * Matn AI: settings.textAI = "claude" | "openai" | "gemini" (kalit bo'lmasa - bori ishlatiladi).
   * schema berilsa JSON obyekt, aks holda matn qaytadi.
   */
  function pickProvider(s) {
    if (s.textAI === "claude" && s.claudeKey) return "claude";
    if (s.textAI === "openai" && s.openaiKey) return "openai";
    if (s.textAI === "gemini" && s.apiKey) return "gemini";
    if (s.claudeKey) return "claude";
    if (s.openaiKey) return "openai";
    if (s.apiKey) return "gemini";
    throw new AIError("Sozlamalarda Gemini, ChatGPT yoki Claude API kalitini kiriting.", "AUTH");
  }

  async function text({ settings, system, prompt, schema, token, effort }) {
    const provider = pickProvider(settings);
    if (provider === "claude") {
      return claude({ apiKey: settings.claudeKey, system, content: [{ type: "text", text: prompt }], schema, effort: effort || "medium", token });
    }
    if (provider === "openai") {
      return openai({ apiKey: settings.openaiKey, model: settings.openaiModel, system, content: [{ type: "text", text: prompt }], schema, effort: effort || "medium", token });
    }
    const model = settings.model === "custom" ? (settings.customModel || "gemini-2.5-flash") : settings.model;
    const full = (system ? system + "\n\n" : "") + prompt;
    if (schema) {
      return root.GCGemini.generateJson({ apiKey: settings.apiKey, model, prompt: full, schema: geminiSchema(schema), token, temperature: 0.3 });
    }
    return root.GCGemini.generateText({ apiKey: settings.apiKey, model, prompt: full, token });
  }

  root.GCAI = { CLAUDE_MODEL, AIError, claude, testClaude, openai, testOpenAI, listOpenAIModels, bestOpenAIModel, text, strictSchema, geminiSchema, pickProvider };
})(typeof window !== "undefined" ? window : globalThis);
