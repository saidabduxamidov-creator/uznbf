/*
 * GeminiCut - kadrdan video: Veo (rasmiy Gemini API) va Google Flow (brauzer).
 * Hech narsa o'rnatish shart emas.
 *  Veo:  kadr + prompt -> Gemini API (predictLongRunning) -> MP4 -> timeline. To'liq avtomatik.
 *  Flow: GeminiCut brauzer profili (bir marta Google'ga kiriladi) -> kadr yuklanadi, prompt yoziladi ->
 *        siz Flow'da Generate/Download bosasiz -> plagin MP4'ni ushlab, timeline'ga qo'yadi.
 */
(function () {
  "use strict";

  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const $ = (id) => document.getElementById(id);

  const OUT = path.join(os.homedir(), "Documents", "GeminiCut", "AI Video");
  const LS = "geminicut.flow.v4";
  const FLOW_URL = "https://flow.google.com";
  // flow.google.com ichkarida labs.google/fx/... ga yo'naltirishi mumkin - ikkalasi ham Flow sahifasi
  const FLOW_PAGE = /(^https:\/\/flow\.google\.com)|labs\.google\/fx/i;
  const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=" + encodeURIComponent(FLOW_URL);

  let busy = false, token = null, last = null, browser = null;

  /* Foydalanuvchi so'ragan to'liq "consistency" ko'rsatmasi (o'zgartirilmagan) */
  function buildPrompt(action, keep) {
    if (!keep) return action.trim();
    return `Maintain absolute character and environmental consistency based strictly on the reference image provided.
Action to perform: ${action.trim()}

CRITICAL RESTRICTIONS:
1. FACIAL & BODY IDENTITY: Preserve the exact facial features, bone structure, expression base, skin tone, hair texture, and body proportions of the person in the reference image. Do NOT alter, stylize, or re-imagine their identity.
2. APPAREL & BRANDING: Keep all clothing items, colors, fabrics, and patterns identical. All branding elements, corporate logos, text graphics, and labels must remain completely sharp, unaltered, and intact. Do NOT distort, smudge, or redesign any logos.
3. ENVIRONMENT & BACKGROUND: Maintain the exact spatial geometry, background elements, lighting conditions, and ambient objects from the reference image. Only animate what is explicitly requested in the prompt.
4. GENERATION STYLE: Execute the motion seamlessly using the reference as the absolute first frame (Image-to-Video). The generation must look like a natural continuation of the source media, preventing any visual flickering, warping, or unexpected transformations.`;
  }

  /* ---------------- holat va UI ---------------- */

  function message(text, error) { const el = $("flowStatus"); el.textContent = text; el.classList.toggle("error", !!error); }

  function steps(i) {
    document.querySelectorAll("#flowSteps li").forEach((li, k) => { li.classList.toggle("done", k < i); li.classList.toggle("now", k === i); });
  }

  function save() { try { localStorage.setItem(LS, JSON.stringify({ last, engine: engine(), model: $("veoModel").value, channel: $("flowChannel").value })); } catch (e) { /* e'tiborsiz */ } }

  const engine = () => { const on = document.querySelector("#flowEngine .on"); return on ? on.dataset.v : "veo"; };

  function syncEngine() {
    const e = engine();
    $("veoBox").hidden = e !== "veo";
    $("flowBox").hidden = e !== "flow";
    $("flowGenerate").querySelector("span").textContent = e === "veo" ? "Veo bilan yaratish" : "Flow'ga yuborish";
    save();
  }

  function setBusy(on) {
    busy = on;
    document.querySelectorAll("[data-flow-idle]").forEach((el) => { el.disabled = on; });
    $("flowCancel").disabled = !on;
    if (window.GCApplication) window.GCApplication.lockFlow(on);
  }

  function showResult() {
    $("flowResult").hidden = !(last && last.video);
    if (last && last.video) {
      $("flowResultPath").textContent = last.video;
      $("flowImport").disabled = !!last.imported || busy;
    }
  }

  async function action(fn) {
    if (busy) return;
    if (window.GCApplication && window.GCApplication.isBusy()) return message("Joriy ish yakunlanishini kuting.", true);
    token = window.GCGemini.createCancelToken();
    setBusy(true);
    try { await fn(); } catch (e) { message(e.code === "CANCELLED" ? "To'xtatildi. Google tomonida boshlangan generatsiya davom etishi mumkin." : e.message, e.code !== "CANCELLED"); }
    finally { token = null; setBusy(false); showResult(); save(); }
  }

  async function capture() {
    fs.mkdirSync(OUT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-flow-"));
    const cap = await window.GCHost.call("gc_flowCapture", [path.join(dir, "frame")], 60000);
    $("flowCaptureInfo").textContent = `${cap.sequenceName} · ${cap.seconds.toFixed(2)} s · ${cap.width}×${cap.height}`;
    return cap;
  }

  async function importVideo(file) {
    const cap = last && last.capture;
    if (!cap) throw new Error("Avval generatsiya orqali timeline joyini belgilang.");
    const r = await window.GCHost.call("gc_flowImport", [file, cap.sequenceID, cap.ticks, cap.projectPath, $("flowPosition").value === "current"], 120000);
    if (file === last.video) last.imported = true;
    steps(5);
    message(r.alreadyPlaced ? "Bu video timeline'da allaqachon bor." : (window.GCHost.app === "ae" ? `✓ Video yangi qatlam bo'lib qo'yildi (${r.seconds.toFixed(2)} s).` : `✓ Video yangi V${r.track} trekka qo'yildi (${r.seconds.toFixed(2)} s).`));
    window.GCApplication.timelineChanged();
  }

  function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

  /* ---------------- Veo (rasmiy API) ---------------- */

  async function loadVeoModels() {
    const s = window.GCApplication.settings();
    if (!s.apiKey) { $("veoHint").textContent = "Sozlamalarda Gemini API kalitini kiriting."; return; }
    try {
      const models = (await window.GCGemini.testKey(s.apiKey)).filter((m) => /veo/i.test(m));
      const sel = $("veoModel"), cur = sel.value || (JSON.parse(localStorage.getItem(LS) || "{}").model);
      if (!models.length) { $("veoHint").textContent = "Bu API kalitda Veo modellari yo'q (Google AI Studio'da billing yoqilgan bo'lishi kerak). Google Flow usulidan foydalaning."; return; }
      sel.innerHTML = "";
      models.sort((a, b) => b.localeCompare(a)).forEach((m) => { const o = document.createElement("option"); o.value = o.textContent = m; sel.appendChild(o); });
      sel.value = models.includes(cur) ? cur : models.find((m) => /veo-3/.test(m) && !/fast/.test(m)) || models[0];
      $("veoHint").textContent = `${models.length} ta Veo modeli mavjud. Generatsiya Google hisobingizdan to'lanadi.`;
    } catch (e) { $("veoHint").textContent = e.message; }
  }

  async function runVeo(prompt) {
    const s = window.GCApplication.settings();
    if (!s.apiKey) throw new Error("Sozlamalarda Gemini API kalitini kiriting.");
    const model = $("veoModel").value;
    if (!model) throw new Error("Veo modeli tanlanmagan. ↻ tugmasini bosing.");
    steps(0); message("Kadr olinmoqda…");
    const cap = await capture();
    last = { capture: cap, video: null, imported: false, engine: "veo" };
    steps(1); message("Veo'ga yuborilmoqda…");
    const image = fs.readFileSync(cap.frame).toString("base64");
    const op = await window.GCGemini.veoStart({ apiKey: s.apiKey, model, prompt, imageBase64: image, mimeType: "image/png",
      aspectRatio: cap.height > cap.width ? "9:16" : "16:9", token });
    steps(2);
    const t0 = Date.now();
    let res = null;
    while (Date.now() - t0 < 15 * 60000) {
      message(`Veo video yaratmoqda… ${Math.round((Date.now() - t0) / 1000)} s (odatda 1-4 daqiqa)`);
      await window.GCGemini.sleep(8000, token);
      res = await window.GCGemini.veoPoll(op, s.apiKey, token);
      if (res.done) break;
    }
    if (!res || !res.done) throw new Error("Veo 15 daqiqada tugatmadi. Keyinroq Google AI Studio'da tekshiring.");
    if (res.error) throw new Error("Veo xatosi: " + (res.error.message || JSON.stringify(res.error)));
    const uri = window.GCGemini.veoVideoUri(res);
    if (!uri) throw new Error("Veo video qaytarmadi (xavfsizlik filtri bo'lishi mumkin). Promptni o'zgartiring.");
    steps(3); message("MP4 yuklab olinmoqda…");
    const file = path.join(OUT, `Veo_${stamp()}.mp4`);
    await window.GCGemini.download(uri, s.apiKey, file, token, (got, total) => message(`MP4 yuklab olinmoqda… ${total ? Math.round((got / total) * 100) + "%" : (got / 1048576).toFixed(1) + " MB"}`));
    last.video = file;
    fs.unlink(cap.frame, () => {});
    if ($("flowAutoImport").checked) { steps(4); await importVideo(file); } else { steps(4); message("✓ Video tayyor: " + file); }
  }

  /* ---------------- Google Flow (brauzer) ---------------- */

  async function connectBrowser(openUrl) {
    const C = window.GCCdp;
    if (browser && !browser.cdp.ws.closed) return browser;
    const channel = $("flowChannel").value;
    const info = await C.launch({ channel, url: openUrl || FLOW_URL });
    const cdp = await C.CDP.connect(info.ws);
    fs.mkdirSync(OUT, { recursive: true });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: OUT, eventsEnabled: true });
    browser = { cdp, downloads: {} };
    cdp.on("Browser.downloadWillBegin", (p) => { browser.downloads[p.guid] = p; });
    cdp.onclose = () => { browser = null; accountState(null); };
    return browser;
  }

  async function flowPage(b) {
    const { targetInfos } = await b.cdp.send("Target.getTargets");
    let t = targetInfos.find((x) => x.type === "page" && FLOW_PAGE.test(x.url))
      || targetInfos.find((x) => x.type === "page" && /accounts\.google\.com/.test(x.url));
    if (!t) { const { targetId } = await b.cdp.send("Target.createTarget", { url: FLOW_URL }); t = { targetId }; }
    await b.cdp.send("Target.activateTarget", { targetId: t.targetId });
    const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await b.cdp.send("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async function isLoggedIn(b) {
    const { cookies } = await b.cdp.send("Storage.getCookies", {});
    return cookies.some((c) => /(^|\.)google\.com$/.test(c.domain) && /^(SID|__Secure-1PSID|__Secure-3PSID)$/.test(c.name));
  }

  function accountState(ok) {
    const el = $("flowAccountState");
    el.textContent = ok === true ? "✓ Google akkaunt ulangan" : ok === false ? "Kirilmagan - ochilgan oynada Google'ga kiring" : "Brauzer yopiq";
    el.className = "status-label " + (ok === true ? "ok" : ok === false ? "warn" : "");
  }

  /*
   * flow.google.com ni ochadi va akkauntni ulaydi: kirilmagan bo'lsa Google kirish sahifasi
   * ochiladi, foydalanuvchi kirishi kutiladi (10 daqiqagacha), so'ng Flow'ga qaytiladi.
   * Parol plaginga kiritilmaydi - faqat Google'ning o'z oynasida.
   */
  async function openFlow() {
    message("flow.google.com ochilmoqda…");
    const b = await connectBrowser();
    const sid = await flowPage(b);
    if (await isLoggedIn(b)) {
      accountState(true);
      await b.cdp.send("Page.navigate", { url: FLOW_URL }, sid).catch(() => {});
      message("✓ Akkaunt ulangan. Flow'da loyihani oching va “Frames to Video” rejimini tanlang.");
      return;
    }
    accountState(false);
    await b.cdp.send("Page.navigate", { url: LOGIN_URL }, sid);
    message("Ochilgan oynada Google akkauntingizga kiring (bir marta) - plagin kutyapti…");
    const t0 = Date.now();
    while (Date.now() - t0 < 10 * 60000) {
      await window.GCGemini.sleep(2500, token);
      if (await isLoggedIn(b)) {
        accountState(true);
        await b.cdp.send("Page.navigate", { url: FLOW_URL }, sid).catch(() => {});
        message("✓ Akkaunt ulandi, flow.google.com ochildi. Profil eslab qoladi - keyingi safar qayta kirish shart emas.");
        return;
      }
    }
    throw new Error("10 daqiqa ichida Google'ga kirilmadi. “flow.google.com ni ochish” ni qayta bosing.");
  }


  const DEEP = `(function(sel){const out=[];const walk=(r)=>{r.querySelectorAll(sel).forEach(e=>out.push(e));r.querySelectorAll('*').forEach(e=>{if(e.shadowRoot)walk(e.shadowRoot)})};walk(document);return out;})`;

  async function findObject(sessionId, b, expr) {
    const r = await b.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: false }, sessionId);
    return r.result && r.result.objectId && r.result.subtype !== "null" ? r.result.objectId : null;
  }

  async function runFlow(prompt) {
    steps(0); message("Kadr olinmoqda…");
    const cap = await capture();
    last = { capture: cap, video: null, imported: false, engine: "flow" };
    steps(1); message("Flow brauzeri ochilmoqda…");
    const b = await connectBrowser();
    const sid = await flowPage(b);
    if (!(await isLoggedIn(b))) { accountState(false); throw new Error("Avval “flow.google.com ni ochish / akkauntni ulash” tugmasi orqali Google'ga kiring."); }
    const here = (await b.cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sid)).result.value || "";
    if (!FLOW_PAGE.test(here)) {
      await b.cdp.send("Page.navigate", { url: FLOW_URL }, sid);
      await new Promise((r) => setTimeout(r, 4000));
    }
    accountState(true);

    // 1) kadrni yuklash: fayl maydoni paydo bo'lishini kutamiz
    const t0 = Date.now();
    let input = null;
    while (!input && Date.now() - t0 < 120000) {
      token.check();
      input = await findObject(sid, b, `${DEEP}('input[type=file]').filter(e=>!e.accept||/image/.test(e.accept)).pop()||null`);
      if (!input) { message("Flow'da “Frames to Video” rejimida birinchi kadr (+) tugmasini bosing - plagin rasmni o'zi yuklaydi…"); await new Promise((r) => setTimeout(r, 1200)); }
    }
    if (!input) throw new Error("Flow'da rasm yuklash maydoni topilmadi. “Frames to Video” ni tanlab qayta urinib ko'ring.");
    await b.cdp.send("DOM.setFileInputFiles", { files: [cap.frame], objectId: input }, sid);
    message("Kadr yuklandi. Prompt yozilmoqda…");
    await new Promise((r) => setTimeout(r, 1500));

    // 2) promptni yozish
    const box = await findObject(sid, b, `${DEEP}('textarea,[contenteditable="true"],[role="textbox"]').filter(e=>e.offsetParent!==null).sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0]||null`);
    if (box) {
      await b.cdp.send("Runtime.callFunctionOn", { objectId: box, functionDeclaration: "function(){this.focus();if(this.select)this.select();else document.execCommand('selectAll');}" }, sid);
      await b.cdp.send("Input.insertText", { text: prompt }, sid);
    } else {
      message("Prompt maydoni topilmadi - promptni qo'lda joylang (nusxalandi).", true);
      window.GCApplication.copyText(prompt);
    }

    // 3) Generate - ixtiyoriy avtomatik bosish
    if ($("flowAutoClick").checked) {
      const btn = await findObject(sid, b, `${DEEP}('button').filter(e=>!e.disabled&&e.offsetParent!==null&&/^(generate|create)$|arrow_forward/i.test((e.getAttribute('aria-label')||e.innerText||'').trim())).pop()||null`);
      if (btn) await b.cdp.send("Runtime.callFunctionOn", { objectId: btn, functionDeclaration: "function(){this.click();}" }, sid);
      message(btn ? "Generate bosildi. Video tayyor bo'lgach Flow'da Download ni bosing." : "Generate tugmasi topilmadi - Flow'da o'zingiz bosing.", !btn);
    } else {
      message("Flow'da promptni tekshirib, Generate ni bosing. Video tayyor bo'lgach Download ni bosing - plagin uni timeline'ga qo'yadi.");
    }
    steps(2);

    // 4) yuklab olishni kutamiz
    const file = await new Promise((resolve, reject) => {
      const onProgress = (p) => {
        if (p.state === "inProgress" && p.totalBytes) { steps(3); message(`MP4 yuklanmoqda… ${Math.round((p.receivedBytes / p.totalBytes) * 100)}%`); }
        if (p.state === "canceled") { cleanup(); reject(new Error("Yuklab olish bekor qilindi.")); }
        if (p.state !== "completed") return;
        cleanup();
        const info = b.downloads[p.guid] || {};
        const src = path.join(OUT, p.guid);
        const ext = (path.extname(info.suggestedFilename || "") || ".mp4").toLowerCase();
        const dest = path.join(OUT, `Flow_${stamp()}${ext}`);
        try { fs.renameSync(src, dest); } catch (e) { return reject(new Error("Yuklangan faylni saqlab bo'lmadi: " + e.message)); }
        resolve(dest);
      };
      const timer = setInterval(() => { if (token && token.cancelled) { cleanup(); reject(Object.assign(new Error("Bekor qilindi."), { code: "CANCELLED" })); } }, 500);
      const giveUp = setTimeout(() => { cleanup(); reject(new Error("30 daqiqa ichida yuklab olinmadi. Tayyor MP4'ni “MP4 tanlash” orqali qo'shing.")); }, 30 * 60000);
      const cleanup = () => { clearInterval(timer); clearTimeout(giveUp); b.cdp.off("Browser.downloadProgress", onProgress); };
      b.cdp.on("Browser.downloadProgress", onProgress);
    });
    last.video = file;
    fs.unlink(cap.frame, () => {});
    if (!/\.mp4$/i.test(file)) { message("Yuklangan fayl MP4 emas: " + file, true); return; }
    steps(4);
    if ($("flowAutoImport").checked) await importVideo(file); else message("✓ Video saqlandi: " + file);
  }

  /* ---------------- ishga tushirish ---------------- */

  function init() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS) || "{}"); } catch (e) { /* e'tiborsiz */ }
    last = saved.last || null;
    document.querySelectorAll("#flowEngine button").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset.v === (saved.engine || "veo"));
      btn.addEventListener("click", () => { document.querySelectorAll("#flowEngine button").forEach((x) => x.classList.toggle("on", x === btn)); syncEngine(); });
    });
    if (saved.channel) $("flowChannel").value = saved.channel;
    const found = window.GCCdp.findBrowser($("flowChannel").value);
    $("flowBrowserInfo").textContent = found ? "Topildi: " + found : "Chrome yoki Edge topilmadi";
    $("flowChannel").addEventListener("change", () => { const f = window.GCCdp.findBrowser($("flowChannel").value); $("flowBrowserInfo").textContent = f ? "Topildi: " + f : "Bu brauzer topilmadi"; save(); });
    $("veoRefresh").addEventListener("click", loadVeoModels);
    $("veoModel").addEventListener("change", save);
    $("flowOpen").addEventListener("click", () => action(openFlow));
    $("flowLogout").addEventListener("click", () => action(async () => {
      if (browser) { try { await browser.cdp.send("Browser.close"); } catch (e) { /* yopilgan */ } browser = null; }
      await new Promise((r) => setTimeout(r, 1500));
      fs.rmSync(window.GCCdp.PROFILE, { recursive: true, force: true });
      accountState(null);
      message("GeminiCut brauzer profili o'chirildi (Google'dan chiqildi). Asosiy Chrome profilingizga tegilmadi.");
    }));
    $("flowGenerate").addEventListener("click", () => action(async () => {
      const text = $("flowPrompt").value.trim();
      if (!text) throw new Error("Kadrda qanday harakat bo'lishini yozing.");
      const prompt = buildPrompt(text, $("flowKeep").checked);
      if (engine() === "veo") await runVeo(prompt); else await runFlow(prompt);
    }));
    $("flowCancel").addEventListener("click", () => { if (token) token.cancel(); });
    $("flowImport").addEventListener("click", () => action(async () => { if (!last || !last.video) throw new Error("Tayyor video yo'q."); await importVideo(last.video); }));
    $("flowManual").addEventListener("click", () => action(async () => {
      const file = window.GCHost.openDialog("Tayyor MP4 ni tanlang", ["mp4"]);
      if (!file) return;
      if (!last || !last.capture) last = { capture: await capture(), video: null };
      await importVideo(file);
    }));
    $("flowOpenFolder").addEventListener("click", () => {
      fs.mkdirSync(OUT, { recursive: true });
      try { require("child_process").spawn("explorer.exe", [OUT], { detached: true, stdio: "ignore" }).unref(); } catch (e) { message(OUT); }
    });
    $("flowPromptPreview").textContent = buildPrompt("<sizning promptingiz>", true);
    document.querySelector('[data-tab="flow"]').addEventListener("click", () => { if (engine() === "veo" && !$("veoModel").options.length) loadVeoModels(); });
    syncEngine();
    showResult();
    accountState(null);
  }

  window.GCFlow = { init, buildPrompt };
})();
