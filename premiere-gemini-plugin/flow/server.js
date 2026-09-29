'use strict';
// Local worker: newline-delimited JSON on stdin/stdout, no listening network port.
// CEP's older Node delegates browser work to a separate Node 20+ process.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { atomicJSON, readJSON, saveSecret, readSecret, normalizeCookies, validateFlowURL, validateProfile } = require('./storage');
const { FlowBrowser, delay, validateMP4 } = require('./browser');
const { buildPrompt } = require('./prompt');

class Worker {
  constructor(options = {}) {
    this.root = options.root || path.join(process.env.LOCALAPPDATA || os.homedir(), 'GeminiCut', 'Flow');
    this.temp = options.temp || path.join(os.tmpdir(), 'GeminiCut-Flow');
    this.downloads = options.downloads || path.join(os.homedir(), 'Downloads', 'GeminiCut-Flow');
    this.emit = options.emit || (() => {});
    this.makeBrowser = options.makeBrowser || ((...args) => new FlowBrowser(...args));
    this.protect = options.protect || saveSecret;
    this.unprotect = options.unprotect || readSecret;
    this.browser = null; this.active = null; this.prepared = new Map();
    this.configFile = path.join(this.root, 'config.json');
    this.secretFile = path.join(this.root, 'session.dpapi.json');
    this.jobFile = path.join(this.root, 'last-job.json');
    fs.mkdirSync(this.root, { recursive: true });
    this.config = readJSON(this.configFile, { mode: 'profile', profilePath: path.join(this.root, 'BrowserProfile'), channel: 'chrome', projectURL: 'https://labs.google/fx/tools/flow' });
    const adapterPath = path.join(this.root, 'adapter.json');
    if (!fs.existsSync(adapterPath)) atomicJSON(adapterPath, {});
    this.last = readJSON(this.jobFile, null);
    if (this.last && ['preparing', 'upload', 'polling', 'download'].includes(this.last.stage)) {
      this.last.stage = 'interrupted'; this.last.message = 'Oldingi ish uzilgan. Flow loyihasini tekshiring; generatsiya avtomatik qayta yuborilmaydi.';
      atomicJSON(this.jobFile, this.last);
    }
  }
  status() {
    return { config: this.config, saved: fs.existsSync(this.configFile), hasSession: fs.existsSync(this.secretFile), busy: !!this.active, last: this.last, adapterPath: path.join(this.root, 'adapter.json'), downloads: this.downloads };
  }
  assertIdle() { if (this.active) throw new Error('Flow ishi davom etmoqda. Avval uni yakunlang yoki bekor qiling.'); }
  async save(input) {
    this.assertIdle();
    const mode = input.mode === 'cookies' ? 'cookies' : 'profile';
    const config = { mode, channel: input.channel === 'msedge' ? 'msedge' : 'chrome', projectURL: validateFlowURL(input.projectURL), profilePath: validateProfile(input.profilePath || path.join(this.root, 'BrowserProfile')) };
    let secret = null;
    if (mode === 'cookies' && input.cookies && input.cookies.trim()) secret = { cookies: normalizeCookies(input.cookies), origins: [] };
    if (mode === 'cookies' && !secret && !fs.existsSync(this.secretFile)) throw new Error('Cookie JSON kiriting yoki profil rejimini tanlang.');
    await this.closeBrowser();
    if (secret) await this.protect(this.secretFile, secret);
    atomicJSON(this.configFile, config); this.config = config;
    return this.status();
  }
  async getBrowser() {
    if (!this.browser) {
      let state = null;
      if (this.config.mode === 'cookies') state = await this.unprotect(this.secretFile);
      this.browser = this.makeBrowser(this.config, state, readJSON(path.join(this.root, 'adapter.json'), {}), (stage, message) => this.progress(stage, message));
    }
    await this.browser.open(); return this.browser;
  }
  async open() { this.assertIdle(); atomicJSON(this.configFile, this.config); await this.getBrowser(); return { opened: true }; }
  async check() {
    this.assertIdle(); const browser = await this.getBrowser(); await browser.checkLogin();
    if (this.config.mode === 'cookies') await this.protect(this.secretFile, await browser.context.storageState());
    return { connected: true };
  }
  async closeBrowser() { if (this.browser) await this.browser.close(); this.browser = null; }
  async disconnect() {
    this.assertIdle(); await this.closeBrowser();
    if (fs.existsSync(this.secretFile)) fs.unlinkSync(this.secretFile);
    if (fs.existsSync(this.configFile)) fs.unlinkSync(this.configFile);
    // Never delete a user-supplied browser profile; disconnection forgets its path.
    this.config = { mode: 'profile', channel: 'chrome', projectURL: 'https://labs.google/fx/tools/flow', profilePath: path.join(this.root, 'BrowserProfile-' + Date.now()) };
    return this.status();
  }
  prepare() {
    this.assertIdle();
    if (this.last && this.last.stage === 'downloaded' && !this.last.imported) throw new Error('Oldingi video tayyor. Avval uni timeline’ga qo‘shing yoki “Natijani yopish”ni bosing.');
    const id = crypto.randomUUID(); const dir = path.join(this.temp, id);
    fs.mkdirSync(dir, { recursive: true });
    const job = { id, frameBase: path.join(dir, 'first-frame'), frame: path.join(dir, 'first-frame.png'), stage: 'preparing', submitted: false };
    this.prepared.clear(); this.prepared.set(id, job);
    return job;
  }
  progress(stage, message) {
    if (!this.last) return;
    this.last.stage = stage; this.last.message = message; this.last.updatedAt = new Date().toISOString();
    atomicJSON(this.jobFile, this.last); this.emit({ type: 'progress', job: this.last });
  }
  async waitPNG(file, signal) {
    for (let i = 0; i < 120; i++) {
      if (signal.aborted) throw new Error('Bekor qilindi.');
      if (fs.existsSync(file)) {
        const buffer = fs.readFileSync(file);
        if (buffer.length > 32 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && buffer.subarray(-8,-4).toString('ascii') === 'IEND') return;
      }
      await delay(500, signal);
    }
    throw new Error('Premiere PNG eksportini yakunlamadi. Kadrni qayta oling.');
  }
  async run(input) {
    this.assertIdle();
    const job = this.prepared.get(input.id);
    if (!job) throw new Error('Kadr eskirgan. “Generatsiya”ni qayta bosing.');
    const prompt = buildPrompt(input.prompt);
    if (!input.capture || typeof input.capture.sequenceID !== 'string' || !/^\d+$/.test(String(input.capture.ticks)) || !Number.isFinite(input.capture.seconds) || input.capture.seconds < 0) throw new Error('Timeline manzili noto‘g‘ri.');
    job.capture = input.capture; this.last = job; this.prepared.delete(input.id);
    const controller = new AbortController(); this.active = controller;
    let partial;
    try {
      this.progress('preparing', 'Premiere’dan PNG kadr olinmoqda…');
      await this.waitPNG(job.frame, controller.signal);
      const browser = await this.getBrowser();
      const result = await browser.generate(job.frame, prompt, controller.signal, () => { job.submitted = true; atomicJSON(this.jobFile, job); });
      this.progress('download', 'Tayyor MP4 yuklanmoqda…');
      fs.mkdirSync(this.downloads, { recursive: true });
      const final = path.join(this.downloads, 'Flow-' + job.id + '.mp4'); partial = final + '.part';
      await browser.download(result, partial, controller.signal);
      validateMP4(partial); fs.renameSync(partial, final); partial = null;
      job.video = final;
      this.progress('downloaded', 'Video saqlandi. Timeline’ga qo‘shishga tayyor.');
      if (this.config.mode === 'cookies') {
        try { await this.protect(this.secretFile, await browser.context.storageState()); }
        catch (_) { this.emit({ type: 'notice', message: 'Video saqlandi, lekin yangilangan sessiya saqlanmadi. Keyingi safar akkauntni qayta ulash kerak bo‘lishi mumkin.' }); }
      }
      return { job };
    } catch (e) {
      const cancelled = controller.signal.aborted;
      this.progress(cancelled ? 'cancelled' : 'failed', cancelled ? 'Kutish bekor qilindi. Flow’da yuborilgan generatsiya davom etishi mumkin.' : e.message);
      // Browser errors may contain URLs/tokens, so don't forward raw error stacks.
      throw new Error(this.last.message);
    } finally {
      this.active = null;
      if (partial && fs.existsSync(partial)) fs.unlinkSync(partial);
      if (fs.existsSync(job.frame)) fs.unlinkSync(job.frame);
    }
  }
  async cancel() {
    if (this.active) { this.active.abort(); await this.closeBrowser(); }
    return { cancelled: true };
  }
  imported(input) {
    if (!this.last || this.last.id !== input.id || this.last.stage !== 'downloaded') throw new Error('Tayyor video topilmadi.');
    this.last.imported = true; this.progress('imported', 'Video timeline’ga qo‘shildi.'); return this.status();
  }
  dismiss() { this.assertIdle(); this.last = null; if (fs.existsSync(this.jobFile)) fs.unlinkSync(this.jobFile); return this.status(); }
}

if (require.main === module) {
  const send = data => process.stdout.write(JSON.stringify(data) + '\n');
  if (Number(process.versions.node.split('.')[0]) < 20) {
    send({ type: 'notice', message: 'Flow uchun Node.js 20 yoki undan yangi versiyasi kerak.' });
    process.exit(1);
  }
  const worker = new Worker({ emit: send });
  const allowed = new Set(['status','save','open','check','disconnect','prepare','run','cancel','imported','dismiss']);
  let commandBusy = false;
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', async line => {
    let request;
    try {
      if (line.length > 1024 * 1024) throw new Error('So‘rov juda katta.');
      request = JSON.parse(line);
      if (!allowed.has(request.command)) throw new Error('Noma’lum buyruq.');
      const concurrent = request.command === 'cancel' || request.command === 'status';
      if (commandBusy && !concurrent) throw new Error('Yordamchi band.');
      if (!concurrent) commandBusy = true;
      try {
        const result = await worker[request.command](request.data || {});
        send({ id: request.id, ok: true, result });
      } finally { if (!concurrent) commandBusy = false; }
    } catch (e) {
      const safe = String(e.message || 'Flow xatosi.').split('\n')[0].replace(/https?:\/\/\S+/g, '[havola]');
      send({ id: request && request.id, ok: false, error: safe });
    }
  });
  lines.on('close', async () => { await worker.cancel(); await worker.closeBrowser(); process.exit(0); });
  process.on('uncaughtException', () => { send({ type: 'notice', message: 'Flow yordamchisi kutilmagan xato bilan to‘xtadi.' }); process.exit(1); });
}
module.exports = { Worker };
