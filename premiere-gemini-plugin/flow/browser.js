'use strict';
const fs = require('fs');
const path = require('path');
const { validateFlowURL } = require('./storage');

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new Error('Bekor qilindi.'));
  const stop = () => { clearTimeout(timer); reject(new Error('Bekor qilindi.')); };
  const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', stop); resolve(); }, ms);
  if (signal) signal.addEventListener('abort', stop, { once: true });
});
function loadChromium() {
  const runtime = path.join(process.env.LOCALAPPDATA || '', 'GeminiCut', 'FlowRuntime', 'node_modules', 'playwright-core');
  try { return require(runtime).chromium; }
  catch (_) {
    try { return require('playwright-core').chromium; }
    catch (_) { throw new Error('Flow yordamchisi o‘rnatilmagan. Flow-Runtime-Setup.bat faylini bir marta ishga tushiring.'); }
  }
}

// Public UI only. No private Google API, CAPTCHA bypass or hidden authentication.
// Optional CSS selectors in adapter.json override accessible English labels.
class FlowBrowser {
  constructor(config, state, selectors, emit, chromium) {
    this.config = config; this.state = state; this.selectors = selectors || {};
    this.emit = emit; this.chromium = chromium; this.context = null; this.browser = null;
  }
  async open() {
    if (this.context && this.page && !this.page.isClosed()) return this.page;
    if (this.context || this.browser) await this.close();
    const chromium = this.chromium || loadChromium();
    const options = { channel: this.config.channel || 'chrome', headless: false, acceptDownloads: true, viewport: { width: 1440, height: 960 } };
    try {
      if (this.config.mode === 'profile') {
        this.context = await chromium.launchPersistentContext(this.config.profilePath, options);
      } else {
        this.browser = await chromium.launch(options);
        this.context = await this.browser.newContext({ acceptDownloads: true, viewport: options.viewport, storageState: this.state || undefined });
      }
    } catch (_) { throw new Error('Brauzer ochilmadi. Chrome/Edge o‘rnatilganini va Flow profili boshqa oynada ishlatilmayotganini tekshiring.'); }
    this.context.setDefaultTimeout(12000);
    this.page = await this.context.newPage();
    await this.page.goto(validateFlowURL(this.config.projectURL), { waitUntil: 'domcontentloaded', timeout: 60000 });
    return this.page;
  }
  async close() {
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.context = null; this.browser = null;
  }
  locator(key, fallback) { return this.selectors[key] ? this.page.locator(this.selectors[key]) : fallback; }
  async one(key, fallback, optional) {
    const all = this.locator(key, fallback);
    const count = await all.count(); let found = null;
    for (let i = 0; i < count; i++) {
      const item = all.nth(i);
      if (!(await item.isVisible())) continue;
      if (found) throw new Error('Flow interfeysida bir nechta “' + key + '” topildi. Adapter sozlamasini aniqlashtiring.');
      found = item;
    }
    if (!found && !optional) throw new Error('Flow: “' + key + '” topilmadi. Brauzerda loyiha va Video → Frames rejimini oching yoki adapter.json ni moslang.');
    return found;
  }
  promptLocator() { return this.page.locator('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-slate-editor="true"]'); }
  async checkLogin() {
    await this.open();
    if (new URL(this.page.url()).hostname === 'accounts.google.com') throw new Error('Brauzerda Google akkauntingizga kiring, so‘ng “Ulanishni tekshirish”ni bosing.');
    validateFlowURL(this.page.url());
    const editor = await this.one('prompt', this.promptLocator(), true);
    const create = await this.one('newProject', this.page.getByRole('button', { name: /^(New project|Create project|Yangi loyiha)$/i }), true);
    if (!editor && !create) throw new Error('Flow loyihasi ochilmagan. Kirishni yakunlang va loyiha oching.');
    return true;
  }
  async prepareEditor(signal) {
    await this.checkLogin();
    const editor = await this.one('prompt', this.promptLocator(), true);
    if (!editor) {
      await (await this.one('newProject', this.page.getByRole('button', { name: /^(New project|Create project|Yangi loyiha)$/i }))).click();
      await this.locator('prompt', this.promptLocator()).first().waitFor({ state: 'visible', timeout: 30000 });
    }
    // An already configured Frames composer needs no mode transition.
    let start = await this.one('startFrame', this.page.getByRole('button', { name: /^(\+\s*)?(Add start frame|Start frame|First frame)$/i }), true);
    if (!start) {
      const mode = await this.one('modeMenu', this.page.getByRole('button', { name: /^(Text to Video|Frames to Video|Ingredients to Video|Nano Banana Pro|Video)$/i }), true);
      if (mode) await mode.click();
      const frames = await this.one('framesMode', this.page.getByText(/^(Frames to Video|Frames)$/i, { exact: true }), true);
      if (frames) await frames.click();
      await delay(400, signal);
      start = await this.one('startFrame', this.page.getByRole('button', { name: /^(\+\s*)?(Add start frame|Start frame|First frame)$/i }));
    }
    return start;
  }
  async uploadFrame(frame, signal) {
    const start = await this.prepareEditor(signal);
    const imagesBefore = await this.page.locator('img').evaluateAll(imgs => imgs.map(i => i.src));
    let chooser = null;
    const listen = fc => { chooser = fc; };
    this.page.on('filechooser', listen);
    try {
      await start.click();
      await delay(400, signal);
      if (!chooser) {
        const upload = await this.one('upload', this.page.getByRole('button', { name: /^(Upload|Upload image|Upload file|Upload files)$/i }), true);
        if (upload) { await upload.click(); await delay(300, signal); }
      }
      if (chooser) await chooser.setFiles(frame);
      else {
        const inputs = this.locator('fileInput', this.page.locator('input[type="file"]'));
        if (await inputs.count() !== 1) throw new Error('Start Frame yuklash maydoni aniqlanmadi. adapter.json dagi fileInput ni moslang.');
        await inputs.setInputFiles(frame);
      }
      const deadline = Date.now() + 60000;
      let confirmed = false;
      while (Date.now() < deadline) {
        await delay(500, signal);
        const crop = await this.one('confirmUpload', this.page.getByRole('button', { name: /^(Crop and save|Crop & save|Save crop|Use image|Add to prompt)$/i }), true);
        if (crop) { await crop.click(); continue; }
        if (this.selectors.frameReady) {
          if (await this.page.locator(this.selectors.frameReady).isVisible()) { confirmed = true; break; }
        } else {
          const changed = await this.page.locator('img').evaluateAll((imgs, old) => imgs.some(i => i.complete && i.naturalWidth > 0 && i.src && !old.includes(i.src)), imagesBefore);
          const dialogs = await this.page.getByRole('dialog').count();
          if (changed && !dialogs) { confirmed = true; break; }
        }
      }
      if (!confirmed) throw new Error('Birinchi kadr biriktirilgani tasdiqlanmadi. Generatsiya boshlanmadi. Flow’da kadrni tekshiring.');
    } finally { this.page.removeListener('filechooser', listen); }
  }
  async videoSources() {
    return this.page.locator(this.selectors.resultVideo || 'video').evaluateAll(videos => videos.map(v => ({ src: v.currentSrc || v.src, ready: v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0, duration: v.duration, baseline: v.dataset.gcFlowBaseline })).filter(v => v.src));
  }
  async generate(frame, prompt, signal, onSubmit) {
    await this.open();
    this.emit('upload', 'Birinchi kadr Flow’ga yuklanmoqda…');
    await this.uploadFrame(frame, signal);
    const editor = await this.one('prompt', this.promptLocator());
    await editor.fill(prompt);
    const actual = await editor.evaluate(el => 'value' in el ? el.value : el.innerText);
    if (actual.trim() !== prompt.trim()) throw new Error('Prompt to‘liq kiritilmadi. Generatsiya boshlanmadi.');
    const before = new Set((await this.videoSources()).map(v => v.src));
    const runMarker = String(Date.now());
    await this.page.locator(this.selectors.resultVideo || 'video').evaluateAll((videos, marker) => videos.forEach(v => { v.dataset.gcFlowBaseline = marker; }), runMarker);
    const button = await this.one('generate', this.page.getByRole('button', { name: /^(Generate|Generate video|Generate image|Create)$/i }));
    if (!(await button.isEnabled())) throw new Error('Flow generatsiya tugmasi faol emas. Model, kadr va kreditlarni tekshiring.');
    if (signal.aborted) throw new Error('Bekor qilindi.');
    // Mark uncertain submission BEFORE click. A timeout must never double-charge.
    onSubmit();
    await button.click();
    this.emit('polling', 'Flow video tayyorlamoqda. Holat har 5 soniyada tekshiriladi.');
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      await delay(5000, signal);
      if (this.page.isClosed()) throw new Error('Flow brauzeri yopildi. Natijani Flow loyihangizdan tekshiring.');
      if (new URL(this.page.url()).hostname === 'accounts.google.com') throw new Error('Google sessiyasi tugadi. Qayta ulang; yuborilgan generatsiyani Flow’da tekshiring.');
      const error = await this.one('generationError', this.page.getByRole('alert').filter({ hasText: /failed|unable|not enough credits|try again|blocked/i }), true);
      if (error) throw new Error('Flow generatsiyani yakunlamadi. Brauzerda xato va kredit holatini tekshiring.');
      const fresh = (await this.videoSources()).filter(v => v.ready && v.baseline !== runMarker && !before.has(v.src));
      const unique = [...new Map(fresh.map(v => [v.src, v])).values()];
      if (unique.length > 1) throw new Error('Bir nechta yangi video topildi. Keraklisini Flow’dan MP4 yuklab, paneldagi “Tayyor MP4” orqali import qiling.');
      if (unique.length === 1) return unique[0];
      this.emit('polling', 'Video kutilmoqda…');
    }
    throw new Error('20 daqiqalik kutish tugadi. Generatsiya qayta yuborilmadi; natijani Flow’da tekshiring.');
  }
  async download(result, target, signal) {
    if (signal.aborted) throw new Error('Bekor qilindi.');
    // Download an observed Google-hosted media URL in the same authenticated
    // context. Blob URLs and interfaces without direct media fall back to UI.
    let mediaURL;
    try { mediaURL = new URL(result.src); } catch (_) {}
    if (mediaURL && mediaURL.protocol === 'https:' && /(^|\.)(googleusercontent\.com|googleapis\.com|labs\.google|google\.com)$/.test(mediaURL.hostname)) {
      const response = await this.context.request.get(mediaURL.href, { timeout: 120000, failOnStatusCode: false });
      try {
        if (response.ok()) {
          const data = await response.body();
          if (signal.aborted) throw new Error('Bekor qilindi.');
          if (data.length > 512 * 1024 * 1024) throw new Error('Video 512 MB chegarasidan katta. Flow’dan qo‘lda yuklab oling.');
          fs.writeFileSync(target, data); validateMP4(target); return;
        }
      } finally { await response.dispose(); }
    }
    const videos = this.page.locator(this.selectors.resultVideo || 'video');
    let video;
    for (let i = 0; i < await videos.count(); i++) {
      if (await videos.nth(i).evaluate(v => v.currentSrc || v.src) === result.src) { video = videos.nth(i); break; }
    }
    if (!video) throw new Error('Tayyor video kartasi topilmadi. MP4 ni Flow’dan yuklab oling.');
    // Use that video's own download, never a global first download button.
    let scope;
    if (this.selectors.resultCard) {
      scope = this.page.locator(this.selectors.resultCard).filter({ has: video });
      if (await scope.count() !== 1) throw new Error('Natija kartasi noaniq. resultCard sozlamasini tekshiring.');
    } else {
      scope = video.locator('xpath=..');
      for (let i = 0; i < 5; i++) {
        if (await scope.getByRole('button', { name: /download/i }).count() === 1) break;
        scope = scope.locator('xpath=..');
      }
    }
    await video.hover().catch(() => {});
    const download = this.selectors.download ? scope.locator(this.selectors.download) : scope.getByRole('button', { name: /download/i });
    if (await download.count() !== 1) throw new Error('Shu videoning Download tugmasi aniqlanmadi. MP4 ni qo‘lda yuklab import qiling.');
    const event = this.page.waitForEvent('download', { timeout: 60000 });
    event.catch(() => {});
    await download.click();
    const resolution = await this.one('downloadQuality', this.page.getByRole('menuitem', { name: /720p|original/i }), true);
    if (resolution) await resolution.click();
    const file = await event;
    const abort = () => { file.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await file.saveAs(target);
      if (signal.aborted) throw new Error('Bekor qilindi.');
      if (await file.failure()) throw new Error('MP4 yuklash yakunlanmadi.');
      validateMP4(target);
    } finally { signal.removeEventListener('abort', abort); }
  }
}
function validateMP4(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 24) throw new Error('MP4 bo‘sh yoki to‘liq yuklanmagan.');
  const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(64);
  try { fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
  if (!head.includes(Buffer.from('ftyp'))) throw new Error('Yuklangan fayl MP4 emas.');
}
module.exports = { FlowBrowser, delay, validateMP4 };
