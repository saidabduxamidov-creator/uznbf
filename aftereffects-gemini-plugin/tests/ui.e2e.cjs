'use strict';
/*
 * After Effects paneli: oxiridan-oxirigacha sinov.
 * Yig'ilgan panel (build/ae/aftereffects-gemini-plugin/client) Chromium'da ochiladi; evalScript
 * chaqiruvlari Node'dagi After Effects taqlidida ishlayotgan haqiqiy AE host.jsx'ga uzatiladi.
 *   ./tools/build-ae.sh && node aftereffects-gemini-plugin/tests/ui.e2e.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { makeAE, loadHost } = require('./ae-mock.cjs');

let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')).chromium; }

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = path.join(ROOT, 'build', 'ae', 'aftereffects-gemini-plugin', 'client', 'index.html');
if (!fs.existsSync(CLIENT)) { console.error('Avval ./tools/build-ae.sh ni ishga tushiring.'); process.exit(1); }
const SHOTS = path.join(__dirname, '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---- After Effects taqlidi: 1080x1920 Reels, ikki video qatlam, musiqa ----
const REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'gcae-e2e-'));
const ae = makeAE({ name: 'Reels', width: 1080, height: 1920, fps: 25, duration: 30 });
const vidA = ae.footage(path.join(REAL, 'D', 'A.mp4'), { duration: 30, hasAudio: true });
const vidB = ae.footage(path.join(REAL, 'D', 'B.mp4'), { duration: 30 });
const music = ae.footage(path.join(REAL, 'D', 'music.mp3'), { duration: 30, hasVideo: false, hasAudio: true });
const A = ae.comp.layers.add(vidA);
const B = ae.comp.layers.add(vidB); B.startTime = 6; B.outPoint = 13;
const M = ae.comp.layers.add(music); M.name = 'Musiqa';
ae.comp.time = 8;
const host = loadHost(ae);

const toReal = (p) => path.join(REAL, p.replace(/^([A-Za-z]):/, '$1'));
const fromReal = (s) => s.split(REAL.replace(/\\/g, '\\\\')).join('').replace(/"\/([A-Za-z])\//g, '"$1:/');

function runScript(script) {
  if (/^\$\.evalFile/.test(script)) return '';
  const paths = [];
  script = script.replace(/"([A-Za-z]:\/[^"]*)"/g, (m, p) => { paths.push(p); return JSON.stringify(toReal(p)); });
  paths.forEach((p) => fs.mkdirSync(path.dirname(toReal(p)), { recursive: true }));
  if (/^gc_(insertSound|importSrt|flowImport)/.test(script) && paths[0]) fs.writeFileSync(toReal(paths[0]), 'x');
  if (/^gc_importSrt/.test(script)) fs.writeFileSync(toReal(paths[0]), global.__lastSrt || '');
  const seqm = /^gc_importSequence\("[^"]*",(\d+),/.exec(script);
  if (seqm) { const d = path.dirname(toReal(paths[0])); for (let i = 0; i < Number(seqm[1]); i++) fs.writeFileSync(path.join(d, 'gc_' + String(i).padStart(4, '0') + '.png'), 'x'); }
  const names = Object.keys(host.api);
  try { return fromReal(new Function(...names, 'return ' + script)(...names.map((n) => host.api[n]))); }
  catch (e) { console.log('host xato:', e.message); return 'EvalScript error.'; }
}

const SHIM = fs.readFileSync(path.join(ROOT, 'premiere-gemini-plugin', 'tests', 'browser-shim.js'), 'utf8');
const AEFT = `window.__adobe_cep__.getHostEnvironment = () => JSON.stringify({ appName: "AEFT", appVersion: "25.2" });`;

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.exposeFunction('__hostEval', (script) => runScript(script));
  await page.exposeFunction('__setSrt', (t) => { global.__lastSrt = t; });
  await page.addInitScript(SHIM);
  await page.addInitScript(AEFT);
  await page.goto('file://' + CLIENT);
  await page.waitForTimeout(1500);
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) errors.push('CHECK: ' + m); };
  const tab = async (t) => { await page.click(`.tab[data-tab="${t}"]`); await page.waitForTimeout(250); };

  console.log('Ulanish');
  check(await page.$eval('#pillHost', (e) => e.classList.contains('ok')), 'After Effects bilan ulandi');
  check((await page.textContent('#seqName')) === 'Reels', 'kompozitsiya nomi');
  check(await page.$eval('body', (b) => b.classList.contains('ae')), 'AE rejimi (body.ae)');
  check(/AFTER EFFECTS/.test(await page.textContent('.brand-version')) && /After Effects/.test(await page.textContent('#pillHost')), 'matnlarda After Effects');
  // nutq treki: faqat A.mp4 (musiqa o'chiq)
  await page.evaluate(() => {
    document.querySelectorAll('#trackChips .chip').forEach((c) => { const on = c.classList.contains('on'); const want = /A\.mp4/.test(c.textContent); if (on !== want) c.click(); });
  });
  check(JSON.stringify(await page.evaluate(() => window.GCApplication.speechTracks())) === '[2]', 'nutq qatlami: A.mp4');
  await shot('ae01-subtitr');

  console.log('Montaj');
  await tab('edit');
  check(await page.isVisible('#view-edit [data-host="ae"]'), 'AE izohi ko\'rinadi');
  await page.click('[data-preset="zoom_in"]');
  await page.waitForTimeout(400);
  const sc = B.transform.map['ADBE Scale'];
  check(sc.numKeys >= 4 && sc.keyTime(1) === 6 && sc.keyValue(sc.numKeys)[0] === 115, `Zoom In vaqt ko'rsatkichi ostidagi qatlamga (${sc.numKeys} keyframe)`);
  await page.click('#btnResetMotion');
  await page.waitForTimeout(300);
  check(sc.numKeys === 0, 'animatsiya tozalandi');
  await page.evaluate(() => {
    window.GCAudio.decodeWav = async () => { const sr = 16000, s = new Float32Array(sr * 30); for (let i = 0; i < s.length; i++) { const t = i / sr; s[i] = (t > 0.5 && t < 4) || (t > 6 && t < 29.5) ? 0.3 * Math.sin(2 * Math.PI * 180 * t) : 0.001 * (Math.random() - 0.5); } return { sampleRate: sr, samples: s, duration: 30 }; };
  });
  await page.uncheck('#optRetakes', { force: true });
  await page.click('#btnEdit');
  await page.waitForSelector('#editResults:not([hidden])', { timeout: 15000 }).catch(async () => { console.log(await page.textContent('#log')); });
  const job = ae.app.project.rendered[0] || {};
  check(job.format === 'WAV' && JSON.stringify(job.audio) === JSON.stringify([['Musiqa', false], ['A.mp4', true]]), 'Render Queue: faqat nutq qatlami, WAV');
  await page.click('#btnApplyEdit');
  await page.waitForTimeout(800);
  check(ae.comp.duration < 30 && ae.comp._layers.filter((l) => l.name === 'A.mp4').length > 1, `pauzalar kesildi: kompozitsiya ${ae.comp.duration.toFixed(2)}s, A.mp4 ${ae.comp._layers.filter((l) => l.name === 'A.mp4').length} bo'lak`);
  await shot('ae02-montaj');

  console.log('Subtitr');
  await tab('subs');
  await page.evaluate(() => {
    window.GCApplication.settings().apiKey = 'AIza-test';
    window.GCGemini.generateJson = async () => ({ language: 'uz', segments: [{ start: 1, end: 3.5, type: 'speech', emphasis: false, text: 'Assalomu alaykum!' }, { start: 4, end: 6, type: 'speech', emphasis: false, text: 'Bugun yangi video.' }] });
    const fs = require('fs'); const orig = fs.writeFileSync;
    fs.writeFileSync = (p, d) => { if (/\.srt$/i.test(p)) window.__setSrt(String(d)); return orig(p, d); };
  });
  await page.click('#btnSubs');
  await page.waitForSelector('#subsResults:not([hidden])', { timeout: 15000 }).catch(async () => { console.log(await page.textContent('#log')); });
  await page.click('#btnApplySubs');
  await page.waitForTimeout(600);
  const subs = ae.comp._layers.filter((l) => /GeminiCut Subtitr/.test(l.name));
  check(subs.length === 2 && subs[0].textGroup.map['ADBE Text Document'].v.text === 'Assalomu alaykum!', `subtitrlar matn qatlamlari: ${subs.length} ta`);

  console.log('Effektlar');
  await tab('sounds');
  await page.waitForFunction(() => document.querySelectorAll('.sfx-card').length > 40, null, { timeout: 120000 }).catch(() => {});
  await page.click('.sfx-folder:has-text("Whoosh")');
  await page.waitForTimeout(400);
  await page.click('.sfx-card >> nth=0 >> .sfx-add');
  await page.waitForTimeout(500);
  check(ae.comp._layers.some((l) => /Swish|Whoosh/.test(l.name) && l.hasAudio), 'SFX qatlam bo\'lib qo\'yildi: ' + await page.textContent('#sfxStatus'));

  console.log('Matn');
  await tab('text');
  await page.waitForTimeout(800);
  await page.click('.tx-card[data-id="pop"]');
  await page.fill('#txText', 'SALOM');
  await page.evaluate(() => { const r = window.GCText.recipe(); r.duration = 1; window.GCText.setRecipe(r); });
  await page.click('#txInsert');
  await page.waitForFunction(() => /✓|XATO/i.test(document.getElementById('txStatus').textContent), null, { timeout: 120000 }).catch(() => {});
  const top = ae.comp.layer(1);
  check(top.source && /gc_0000\.png/.test(top.source.file.fsName) && Math.abs(top.outPoint - top.inPoint - 1) < 1e-6, 'animatsion matn eng yuqori qatlamga (1s): ' + await page.textContent('#txStatus'));
  await shot('ae03-matn');

  console.log('ChatGPT');
  await tab('chatgpt');
  check(!(await page.isVisible('#gpColorPane')) && await page.isVisible('#gpEditPane') && await page.isVisible('#view-chatgpt .note[data-host~="ae"]'), 'rang berish yashirin (Resolve), montaj ko\'rinadi');

  console.log('Sozlamalar');
  await tab('settings');
  check(!(await page.isVisible('#presetPath')) && !(await page.isVisible('#keyBase')), 'Premiere\'ga xos sozlamalar yashirilgan');
  await shot('ae04-sozlamalar');

  console.log(errors.length ? '\nXATOLAR:\n' + errors.join('\n') : '\nHammasi muvaffaqiyatli.');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
