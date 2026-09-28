/*
 * GeminiCut - Premiere (CEP) bilan aloqa.
 * CSInterface.js kerak emas: CEP'ning ichki window.__adobe_cep__ obyektidan
 * to'g'ridan-to'g'ri foydalanamiz, shuning uchun qo'shimcha fayl yuklash shart emas.
 */
(function (root) {
  "use strict";

  const native = root.__adobe_cep__ || null;

  /* JS qiymatni ExtendScript (ES3) uchun xavfsiz literalga aylantiradi */
  function literal(v) {
    return JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }

  function evalScript(script, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!native) return reject(new Error("Panel Premiere Pro ichida ochilmagan."));
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; reject(new Error("Premiere javob bermadi (timeout).")); }
      }, timeoutMs || 60000);
      native.evalScript(script, (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  function extensionPath() {
    try { return native.getSystemPath("extension").replace(/^file:\/{2,3}/, ""); } catch (e) { return ""; }
  }

  /* host.jsx dagi funksiyani chaqiradi va JSON javobni qaytaradi */
  async function call(fn, args, timeoutMs) {
    const script = fn + "(" + (args || []).map(literal).join(",") + ")";
    const raw = await evalScript(script, timeoutMs);
    if (raw === "EvalScript error.") throw new Error("Premiere skript xatosi (" + fn + ").");
    let res;
    try { res = JSON.parse(raw); } catch (e) { throw new Error("Premiere javobi noto'g'ri: " + String(raw).slice(0, 200)); }
    if (!res.ok) throw new Error(res.error || "Noma'lum xato");
    return res;
  }

  /* host.jsx yuklanganini tekshiradi, kerak bo'lsa qayta yuklaydi */
  async function ensureHost() {
    try { return await call("gc_ping", [], 8000); } catch (e) { /* qayta yuklaymiz */ }
    const p = extensionPath();
    if (!p) throw new Error("Kengaytma papkasi aniqlanmadi.");
    await evalScript("$.evalFile(" + literal(decodeURI(p) + "/host/host.jsx") + ")", 15000);
    return call("gc_ping", [], 8000);
  }

  function openUrl(url) {
    try { root.cep.util.openURLInDefaultBrowser(url); } catch (e) { root.open(url, "_blank"); }
  }

  function saveDialog(title, defaultName) {
    try {
      const r = root.cep.fs.showSaveDialogEx(title, "", ["srt"], defaultName);
      if (r && r.err === 0 && r.data) return r.data;
    } catch (e) { /* dialog mavjud emas */ }
    return null;
  }

  function openDialog(title, types) {
    try {
      const r = root.cep.fs.showOpenDialogEx(false, false, title, "", types || []);
      if (r && r.err === 0 && r.data && r.data.length) return r.data[0];
    } catch (e) { /* dialog mavjud emas */ }
    return null;
  }

  root.GCHost = { available: !!native, evalScript, call, ensureHost, openUrl, saveDialog, openDialog };
})(window);
