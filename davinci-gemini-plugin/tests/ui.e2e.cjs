'use strict';
/*
 * DaVinci Resolve paneli: oxiridan-oxirigacha sinov.
 * Yig'ilgan panel (build/resolve/GeminiCut/client) Chromium'da ochiladi; require('electron').ipcRenderer
 * Node'dagi haqiqiy host.js + Resolve API taqlidiga ulanadi. AI javoblari taqlid qilinadi.
 *   ./tools/build-resolve.sh && node davinci-gemini-plugin/tests/ui.e2e.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { makeResolve, TimelineItem, MediaPoolItem, FPS, START } = require('./resolve-mock.cjs');
const { createHost } = require('../host.js');

let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')).chromium; }

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = path.join(ROOT, 'build', 'resolve', 'GeminiCut', 'client', 'index.html');
if (!fs.existsSync(CLIENT)) { console.error('Avval ./tools/build-resolve.sh ni ishga tushiring.'); process.exit(1); }
const SHOTS = path.join(__dirname, '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---- Resolve taqlidi: V1 da 4 bo'lak, A1 nutq, A2 musiqa ----
const r = makeResolve();
const src = new MediaPoolItem('D:/C9966.MP4', 5000);
r.tl.tracks.audio.push([]); r.tl.enabled.audio.push(true); r.tl.locked.audio.push(false);
[[0, 6, 250], [6, 13, 750], [13, 21, 1300], [21, 30, 1800]].forEach(([s, e, off]) => {
  r.tl.tracks.video[0].push(new TimelineItem(START + s * FPS, START + e * FPS, src, off));
  r.tl.tracks.audio[0].push(new TimelineItem(START + s * FPS, START + e * FPS, src, off));
});
r.tl.tracks.audio[1].push(new TimelineItem(START, START + 30 * FPS, new MediaPoolItem('D:/music.mp3', 750), 0));
r.tl.ph = START + 8 * FPS;

// Panel "C:/..." (virtual disk) yo'llari <-> haqiqiy disk
const REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-e2e-'));
const toReal = (p) => path.join(REAL, String(p).replace(/^([A-Za-z]):/, '$1'));
const fromReal = (v) => JSON.parse(JSON.stringify(v).split(JSON.stringify(REAL).slice(1, -1)).join('').replace(/"\/([A-Za-z])\//g, '"$1:/'));
const host = createHost(r.resolve, { fs, path, sleep: () => Promise.resolve() });

async function hostCall(fn, args) {
  const mapped = JSON.parse(JSON.stringify(args || []), (k, v) => (typeof v === 'string' && /^[A-Za-z]:\//.test(v) ? toReal(v) : v));
  const walk = (v) => (Array.isArray(v) ? v.forEach(walk) : typeof v === 'string' && v.startsWith(REAL) && fs.mkdirSync(path.dirname(v), { recursive: true }));
  walk(mapped);
  if (/^gc_(insertSound|importSrt|flowImport)$/.test(fn)) fs.writeFileSync(mapped[0], 'x');
  return fromReal(await host[fn](...mapped));
}

const SHIM = fs.readFileSync(path.join(ROOT, 'premiere-gemini-plugin', 'tests', 'browser-shim.js'), 'utf8');
const ELECTRON = `(function () {
  delete window.__adobe_cep__;
  const base = window.require;
  const png = (p) => { const c = document.createElement('canvas'); c.width = 108; c.height = 192; const g = c.getContext('2d'); g.fillStyle = '#3a6'; g.fillRect(0, 0, 108, 192);
    const bin = atob(c.toDataURL('image/png').split(',')[1]); const b = window.Buffer.alloc(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); base('fs').writeFileSync(p, b); };
  const electron = { ipcRenderer: {
    invoke: async (ch, fn, args) => { const r = await window.__gc(fn, args); (r.files || (r.frame ? [r.frame] : [])).forEach(png); return r; },
    send() {}, sendSync: (ch, kind) => (kind === 'open' ? [] : ''),
  } };
  window.require = (m) => (m === 'electron' ? electron : base(m));
})();`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.exposeFunction('__gc', hostCall);
  await page.addInitScript(SHIM);
  await page.addInitScript(ELECTRON);
  await page.goto('file://' + CLIENT);
  await page.waitForTimeout(1500);
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const check = (c, m) => { console.log((c ? '  \u2713 ' : '  \u2717 ') + m); if (!c) errors.push('CHECK: ' + m); };
  const tab = async (t) => { await page.click(`.tab[data-tab="${t}"]`); await page.waitForTimeout(250); };

  console.log('Ulanish');
  check(await page.$eval('#pillHost', (e) => e.classList.contains('ok')), 'Resolve bilan ulandi');
  check((await page.textContent('#seqName')) === 'C9966', 'timeline nomi');
  check((await page.textContent('#pillHost')).includes('Resolve'), 'matnlarda Premiere -> Resolve');
  check(await page.$eval('body', (b) => b.classList.contains('resolve')), 'Resolve rejimi yoqildi');
  await shot('r01-subtitr');

  console.log('Montaj');
  await tab('edit');
  check(await page.isVisible('[data-host="resolve"]'), 'Resolve izohi ko\'rinadi');
  await page.click('[data-preset="zoom_in"]');
  await page.waitForTimeout(400);
  const item = r.tl.tracks.video[0][1];
  check(item.comps.length === 1 && /tr\.Size\[s \+ 0\] = 1\n/.test(item.comps[0].scripts[0]), 'Zoom In -> playhead ostidagi klipga Fusion Lua');
  await shot('r02-montaj');
  // Pauzalarni kesish (AI'siz): yangi timeline
  await page.evaluate(() => {
    window.GCAudio.decodeWav = async () => { const sr = 16000, s = new Float32Array(sr * 30); for (let i = 0; i < s.length; i++) { const t = i / sr; s[i] = (t > 0.5 && t < 4) || (t > 6 && t < 29.5) ? 0.3 * Math.sin(2 * Math.PI * 180 * t) : 0.001 * (Math.random() - 0.5); } return { sampleRate: sr, samples: s, duration: 30 }; };
  });
  await page.uncheck('#optRetakes', { force: true });
  await page.click('#btnEdit');
  await page.waitForSelector('#editResults:not([hidden])', { timeout: 10000 }).catch(async () => { console.log(await page.textContent('#log')); });
  check(r.project.render.length === 1 && r.project.render[0].enabled.join() === 'true,false', 'audio render: faqat nutq treki (musiqa o\'chirildi)');
  await page.click('#btnApplyEdit');
  await page.waitForTimeout(600);
  const nt = r.project.current;
  check(nt.name === 'C9966 (GeminiCut)' && nt.tracks.video[0].length > 4, `pauzalarsiz yangi timeline: ${nt.name}, ${nt.tracks.video[0].length} bo'lak`);
  check(r.project.timelines[0].tracks.video[0].length === 4, 'asl timeline o\'zgarmadi');
  await page.waitForTimeout(300);
  check((await page.textContent('#seqName')) === 'C9966 (GeminiCut)', 'panel yangi timeline\'ga o\'tdi');
  await shot('r03-montaj-kesildi');

  console.log('Effektlar');
  await tab('sounds');
  await page.waitForTimeout(2500);
  await page.click('.sfx-folder:has-text("Whoosh")');
  await page.waitForTimeout(400);
  await page.click('.sfx-card >> nth=0 >> .sfx-add');
  await page.waitForTimeout(500);
  const sfxAt = nt.tracks.audio.flat().find((it) => /Swish/.test(it.mpi.name));
  check(!!sfxAt, 'SFX yangi timeline\'ga qo\'yildi: ' + (await page.textContent('#sfxStatus')));
  await shot('r04-effektlar');

  console.log('Claude');
  await tab('claude');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.GCApplication.settings().claudeKey = 'sk-ant-test';
    window.GCAI.claude = async ({ content }) => { window.__content = content; return { summary: 'Sekin zoom va whoosh.',
      motions: [{ clip: 0, property: 'scale', mode: 'relative', easing: 'ease_out', keyframes: [{ time: 0, value: 100, x: 0, y: 0 }, { time: 2, value: 120, x: 0, y: 0 }], reason: 'Zoom' }],
      sfx: [{ sound_id: 'Whoosh/Whoosh Tez.wav', time: 3, reason: 'Boshida' }], cuts: [] }; };
  });
  await page.fill('#clPrompt', 'Sekin zoom va whoosh');
  await page.click('#clRun');
  await page.waitForSelector('#clPlan:not([hidden])', { timeout: 10000 }).catch(async () => { console.log('clStatus:', await page.textContent('#clStatus')); });
  const imgs = await page.evaluate(() => (window.__content || []).filter((b) => b.type === 'image').length);
  check(imgs === 3, `Claude'ga ${imgs} ta kadr yuborildi (ExportCurrentFrameAsStill)`);
  await page.click('#clApply');
  await page.waitForTimeout(600);
  const withComp = nt.tracks.video[0].filter((it) => it.comps.length).length;
  check(withComp >= 1, 'Claude motion Fusion orqali qo\'llandi');
  await shot('r05-claude');

  console.log('Subtitr');
  await tab('subs');
  await page.evaluate(() => {
    window.GCApplication.settings().apiKey = 'AIza-test';
    window.GCGemini.generateJson = async () => ({ language: 'uz', segments: [{ start: 1, end: 3.5, type: 'speech', emphasis: false, text: 'Assalomu alaykum!' }] });
  });
  await page.click('#btnSubs');
  await page.waitForSelector('#subsResults:not([hidden])', { timeout: 10000 }).catch(async () => { console.log(await page.textContent('#log')); });
  await page.click('#btnApplySubs');
  await page.waitForTimeout(500);
  check(nt.tracks.subtitle.length === 1 && nt.tracks.subtitle[0].length === 1, 'SRT subtitr trekiga qo\'yildi');

  console.log('Sozlamalar');
  await tab('settings');
  check(!(await page.isVisible('#presetPath')) && !(await page.isVisible('#keyBase')), 'Premiere\'ga xos sozlamalar yashirilgan');
  await shot('r06-sozlamalar');

  console.log(errors.length ? '\nXATOLAR:\n' + errors.join('\n') : '\nHammasi muvaffaqiyatli.');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
