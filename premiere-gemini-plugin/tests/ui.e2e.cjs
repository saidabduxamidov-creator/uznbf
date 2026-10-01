'use strict';
/*
 * UI + host oxiridan-oxirigacha sinov.
 * Panel kodi haqiqiy Chromium'da ishlaydi; __adobe_cep__.evalScript chaqiruvlari Node'dagi
 * Premiere taqlidida ishlayotgan haqiqiy host.jsx'ga uzatiladi. fs - xotiradagi virtual disk.
 * AI javoblari taqlid qilinadi (internetga chiqilmaydi). Skrinshotlar: tests/.shots/
 *   node tests/ui.e2e.cjs
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { makeEnv, makeItem, makeTrack, loadHost } = require('./premiere-mock.cjs');

let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')).chromium; }

const SHOTS = path.join(__dirname, '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---- Premiere taqlidi: sizning timeline'ingizga o'xshash (ko'p kesilgan klip + musiqa) ----
const v1 = makeTrack('V', 0), v2 = makeTrack('V', 1), a1 = makeTrack('A', 0), a2 = makeTrack('A', 1), a3 = makeTrack('A', 2, { name: 'Musiqa' });
[[0, 6, 10], [6, 13, 30], [13, 21, 52], [21, 30, 70]].forEach(([s, e, i], k) => {
  v1.items.push(makeItem(v1, s, e, i, 'D:/C9966.MP4', { selected: k === 1 })); a1.items.push(makeItem(a1, s, e, i, 'D:/C9966.MP4'));
});
a3.items.push(makeItem(a3, 0, 30, 0, 'D:/music.mp3'));
const env = makeEnv({ video: [v1, v2], audio: [a1, a2, a3], duration: 30, playhead: 8, width: 1080, height: 1920 });
env.seq.name = 'C9966';
const host = loadHost(env);

// Panel "C:/..." yo'llaridan foydalanadi (virtual disk); host esa Node'ning haqiqiy diskida ishlaydi.
const REAL = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gc-e2e-'));
const toReal = (p) => path.join(REAL, p.replace(/^([A-Za-z]):/, '$1'));
const fromReal = (s) => s.split(REAL.replace(/\\/g, '\\\\')).join('').replace(/"\/([A-Za-z])\//g, '"$1:/');

function runScript(script) {
  if (/^\$\.evalFile/.test(script)) return '';
  const paths = [];
  script = script.replace(/"([A-Za-z]:\/[^"]*)"/g, (m, p) => { paths.push(p); return JSON.stringify(toReal(p)); });
  // Import qilinadigan fayllar haqiqiy diskda ham bo'lishi kerak
  if (/^gc_(insertSound|importSrt|flowImport)/.test(script) && paths[0]) { fs.mkdirSync(path.dirname(toReal(paths[0])), { recursive: true }); fs.writeFileSync(toReal(paths[0]), 'x'); }
  paths.forEach((p) => fs.mkdirSync(path.dirname(toReal(p)), { recursive: true }));
  // Matn: PNG ketma-ketligi haqiqiy diskda ham bo'lsin (host kadrlar sonini papkadan oladi)
  const seqm = /^gc_importSequence\("[^"]*",(\d+),/.exec(script);
  if (seqm && paths[0]) { const d = path.dirname(toReal(paths[0])); fs.readdirSync(d).filter((n) => /^gc_\d+\.png$/.test(n)).forEach((n) => fs.unlinkSync(path.join(d, n))); for (let i = 0; i < Number(seqm[1]); i++) fs.writeFileSync(path.join(d, 'gc_' + String(i).padStart(4, '0') + '.png'), 'x'); }
  paths.filter((p) => /\.epr$/i.test(p)).forEach((p) => fs.writeFileSync(toReal(p), 'x'));
  const names = Object.keys(host.api);
  try { return fromReal(new Function(...names, 'return ' + script)(...names.map((n) => host.api[n]))); }
  catch (e) { return 'EvalScript error.'; }
}

// ---- brauzer ichidagi Node shimlari (Buffer, fs, path, os, url) ----
const SHIM = fs.readFileSync(path.join(__dirname, 'browser-shim.js'), 'utf8');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.exposeFunction('__hostEval', (script) => runScript(script));
  await page.addInitScript(SHIM);
  await page.goto('file://' + path.join(__dirname, '..', 'client', 'index.html'));
  await page.waitForTimeout(1500);

  const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  const check = (cond, msg) => { if (!cond) { errors.push('CHECK: ' + msg); console.log('  \u2717 ' + msg); } else console.log('  \u2713 ' + msg); };
  const tab = async (t) => { await page.click(`.tab[data-tab="${t}"]`); await page.waitForTimeout(250); };

  console.log('Boshlang\'ich holat');
  check(await page.$eval('#pillHost', (e) => e.classList.contains('ok')), 'Premiere bilan ulandi');
  check((await page.textContent('#seqName')) === 'C9966', 'sequence nomi');
  await shot('01-subtitr');

  console.log('Montaj: tezkor motion');
  await tab('edit');
  await page.click('[data-preset="zoom_in"]');
  await page.waitForTimeout(400);
  const sc = v1.items[1].motion.props[1].keys;
  check(sc.length >= 4 && Math.abs(sc[0].t - 30) < 1e-6 && Math.abs(sc[sc.length - 1].v - 115) < 1e-6, `Zoom In tanlangan klipga qo'yildi (${sc.length} keyframe)`);
  await page.click('[data-preset="punch"]');
  await page.waitForTimeout(400);
  check(Math.max(...v1.items[1].motion.props[1].keys.map((k) => k.v)) >= 119, 'Punch-in qo\'yildi');
  await shot('02-montaj');
  await page.click('#btnResetMotion');
  await page.waitForTimeout(300);
  check(!v1.items[1].motion.props[1].isTimeVarying(), 'Animatsiya tozalandi');

  console.log('Effektlar');
  await tab('sounds');
  await page.waitForTimeout(2500);
  const cards = await page.$$eval('.sfx-card', (e) => e.length);
  check(cards >= 40, `bazaviy to'plam yaratildi va ko'rsatildi (${cards} ta)`);
  await shot('03-effektlar');
  await page.click('.sfx-folder:has-text("Whoosh")');
  await page.waitForTimeout(500);
  await page.click('.sfx-card >> nth=0 >> .sfx-add');
  await page.waitForTimeout(500);
  check(a2.items.length === 1 && Math.abs(a2.items[0].start.seconds - 8) < 1e-3, 'Whoosh A2 ga playhead (8s) joyiga qo\'yildi: ' + await page.textContent('#sfxStatus'));
  await page.click('.sfx-card >> nth=0 >> .sfx-star');
  await page.click('#sfxAddFolder');
  await page.fill('#sfxFolderName', 'Mening Whooshlarim');
  await page.click('#sfxCreateFolder');
  await page.waitForTimeout(300);
  check(await page.$eval('.sfx-folder.on span', (e) => e.textContent) === 'Mening Whooshlarim', 'yangi papka yaratildi va tanlandi');
  await page.click('.sfx-folder.special >> nth=1');
  await page.waitForTimeout(300);
  check((await page.$$eval('.sfx-card', (e) => e.length)) === 1, 'Sevimlilar papkasi ishlaydi');
  await shot('04-effektlar-papka');

  console.log('Claude');
  await tab('claude');
  await page.waitForTimeout(400);
  check((await page.textContent('#clClips')).includes('V1'), 'tanlangan klip ko\'rsatildi');
  await page.evaluate(() => {
    window.GCApplication.settings().claudeKey = 'sk-ant-test';
    window.GCAI.claude = async ({ content }) => {
      window.__claudeContent = content;
      await new Promise((r) => setTimeout(r, 200));
      return { summary: "Yuzga sekin zoom va urg'uda whoosh qo'yiladi.",
        motions: [{ clip: 0, property: 'scale', mode: 'relative', easing: 'ease_in_out', keyframes: [{ time: 0, value: 100, x: 0, y: 0 }, { time: 3, value: 118, x: 0, y: 0 }], reason: 'Sekin yaqinlashish' },
                  { clip: 0, property: 'position', mode: 'relative', easing: 'ease_in_out', keyframes: [{ time: 0, value: 0, x: 0, y: 0 }, { time: 3, value: 0, x: -0.03, y: 0.02 }], reason: 'Yuzga yo\'naltirish' }],
        sfx: [{ sound_id: 'Whoosh/Whoosh Tez.wav', time: 6.4, reason: 'Harakat boshida' }, { sound_id: 'Yoq/Bunday.wav', time: 7, reason: '' }],
        cuts: [] };
    };
  });
  await page.fill('#clPrompt', "Yuziga sekin zoom qil va boshida whoosh qo'y");
  await page.click('#clRun');
  await page.waitForSelector('#clPlan:not([hidden])', { timeout: 10000 }).catch(async () => { console.log('clStatus:', await page.textContent('#clStatus')); throw new Error('reja chiqmadi'); });
  const content = await page.evaluate(() => window.__claudeContent);
  check(content.filter((b) => b.type === 'image').length === 3, 'Claude\'ga 3 ta kadr (vision) yuborildi');
  const ctxText = content[content.length - 1].text;
  check(/sound_library/.test(ctxText) && /Whoosh\/Whoosh Tez\.wav/.test(ctxText), 'SFX kutubxonasi kontekstga qo\'shildi');
  await shot('05-claude-reja');
  await page.click('#clApply');
  await page.waitForTimeout(600);
  const pos = v1.items[1].motion.props[0].keys;
  check(v1.items[1].motion.props[1].keys.length > 4 && pos.length > 2, 'Claude motion (scale + position) qo\'llandi');
  check(a2.items.length === 2, 'Claude SFX qo\'shildi (noma\'lum SFX o\'tkazib yuborildi)');
  await shot('06-claude-qollandi');

  console.log('Matn');
  await tab('text');
  await page.waitForTimeout(800);
  check((await page.$$eval('#txGrid .tx-card', (e) => e.length)) === 12, '12 ta 2D shablon');
  const thumbInk = await page.$eval('#txGrid .tx-card canvas', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  check(thumbInk > 100, 'shablon kartalarida jonli namunalar chizildi');
  await page.click('.tx-card[data-id="pop"]');
  await page.fill('#txText', 'SALOM\nDUNYO');
  await page.evaluate(() => { const r = window.GCText.recipe(); r.duration = 1; window.GCText.setRecipe(r); });
  await page.waitForTimeout(400);
  const ink = async () => page.$eval('#txPreview', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  check((await ink()) > 200, 'oldindan ko\'rish jonli chizilmoqda');
  await shot('07-matn-2d');
  await page.click('#txInsert');
  await page.waitForFunction(() => /✓|XATO|topilmadi|qo'yilmadi/i.test(document.getElementById('txStatus').textContent), null, { timeout: 120000 }).catch(() => {});
  const txSt = await page.textContent('#txStatus');
  check(/✓/.test(txSt) && v2.items.length === 1 && Math.abs(v2.items[0].start.seconds - 8) < 1e-3 && Math.abs(v2.items[0].end.seconds - 9) < 1e-3, 'matn V2 ga 8s dan 1s (25 kadr): ' + txSt);
  const recipeSaved = await page.evaluate(() => { const fs = require('fs'); const root = 'C:/Users/Ali/Documents/GeminiCut/Matn'; const d = fs.readdirSync(root)[0]; return JSON.parse(fs.readFileSync(root + '/' + d + '/recipe.json', 'utf8')); });
  check(recipeSaved.template === 'pop' && recipeSaved.frames === 25 && recipeSaved.width === 1080, 'recipe.json saqlandi (keyin tahrirlash uchun)');
  // tahrirlash: playhead matn ustida -> sozlamalar yuklanadi, almashtiriladi
  await page.fill('#txText', 'BOSHQA');
  await page.click('#txEdit');
  await page.waitForTimeout(400);
  check((await page.$eval('#txText', (e) => e.value)) === 'SALOM\nDUNYO' && /Yangilash/.test(await page.textContent('#txInsert')), 'playhead\'dagi matn tahrirga yuklandi');
  await page.fill('#txText', 'YANGI MATN');
  await page.click('#txInsert');
  await page.waitForFunction(() => /✓|XATO/i.test(document.getElementById('txStatus').textContent) && /yangilandi|XATO/i.test(document.getElementById('txStatus').textContent), null, { timeout: 120000 }).catch(() => {});
  check(v2.items.length === 1 && /yangilandi/.test(await page.textContent('#txStatus')), 'matn o\'rnida yangilandi: ' + await page.textContent('#txStatus'));
  await page.click('#txKind [data-v="3d"]');
  await page.waitForTimeout(1500);
  check((await page.$$eval('#txGrid .tx-card', (e) => e.length)) === 7, '7 ta 3D Liquid shablon');
  await page.click('.tx-card[data-id="liquid_gold"]');
  await page.fill('#txText', 'GOLD');
  await page.waitForTimeout(1500);
  check((await ink()) > 200, '3D suyuq oltin oldindan ko\'rishda chizildi (WebGL)');
  await shot('08-matn-3d');

  console.log('ChatGPT');
  await tab('chatgpt');
  await page.waitForTimeout(400);
  check(!(await page.isVisible('#gpColorPane')) && await page.isVisible('#gpEditPane'), 'Premiere: rang berish yashirin, montaj ko\'rinadi');
  await page.evaluate(() => {
    window.GCApplication.settings().openaiKey = 'sk-test';
    window.GCAI.openai = async ({ content, schema }) => {
      window.__gptContent = content;
      return { summary: 'ChatGPT: sekin zoom.', motions: [{ clip: 0, property: 'scale', mode: 'relative', easing: 'ease_out', keyframes: [{ time: 0, value: 100, x: 0, y: 0 }, { time: 2, value: 112, x: 0, y: 0 }], reason: 'Zoom' }], sfx: [], cuts: [] };
    };
  });
  await page.fill('#gpPrompt', 'Sekin zoom');
  await page.click('#gpRun');
  await page.waitForSelector('#gpPlan:not([hidden])', { timeout: 10000 }).catch(async () => { console.log('gpStatus:', await page.textContent('#gpStatus')); });
  check((await page.evaluate(() => (window.__gptContent || []).filter((b) => b.type === 'image').length)) >= 1, 'ChatGPT\'ga kadrlar yuborildi');
  await shot('09-chatgpt');
  await page.click('#gpApply');
  await page.waitForTimeout(500);
  check(/Qo'llandi/.test(await page.textContent('#gpStatus')), 'ChatGPT rejasi qo\'llandi: ' + await page.textContent('#gpStatus'));

  console.log('Subtitr uslubi');
  await tab('subs');
  await page.evaluate(() => {
    // subtitrlarni to'g'ridan-to'g'ri yaratamiz (AI taqlidi)
    window.GCAudio.decodeWav = async () => { const sr = 16000, s = new Float32Array(sr * 30); for (let i = 0; i < s.length; i++) { const t = i / sr; s[i] = (t > 1 && t < 4) || (t > 5 && t < 9) ? 0.3 * Math.sin(2 * Math.PI * 180 * t) : 0.001 * (Math.random() - 0.5); } return { sampleRate: sr, samples: s, duration: 30 }; };
    window.GCAudio.encodeWav = () => ({ toString: () => '' });
    window.GCApplication.settings().apiKey = 'AIza-test';
    require('fs').writeFileSync('C:/Presets/Waveform Audio.epr', '<ExporterFileType>1463899717</ExporterFileType>');
    window.GCApplication.settings().presetPath = 'C:/Presets/Waveform Audio.epr';
    window.GCGemini.generateJson = async ({ schema }) => {
      if (schema.properties && schema.properties.fixes) return { fixes: [{ i: 1, text: "Bugun sizlarga Premiere Pro'da ishlashni ko'rsataman." }] };
      return { language: 'uz', segments: [
        { start: 1, end: 4, type: 'speech', emphasis: false, text: "Assalomu alaykum, aziz do'stlar!" },
        { start: 5, end: 9, type: 'speech', emphasis: true, text: "Bugun sizlarga premier pro'da ishlashni korsataman." }] };
    };
    window.GCApplication.settings().textAI = 'gemini';
  });
  await page.click('#btnSubs');
  await page.waitForSelector('#subsResults:not([hidden])', { timeout: 10000 }).catch(async () => { console.log('log:', await page.textContent('#log')); throw new Error('subtitr chiqmadi'); });
  await page.click('#caseBar [data-v="upper"]');
  await page.click('#punctBar [data-k="comma"]');
  await page.click('#punctBar [data-k="excl"]');
  await page.waitForTimeout(200);
  const first = await page.$eval('#cueList textarea', (e) => e.value);
  check(first === 'ASSALOMU ALAYKUM DOʻSTLAR' || first === 'ASSALOMU ALAYKUM AZIZ DOʻSTLAR', `katta harf + vergul/undov olib tashlandi: "${first}"`);
  await page.click('#btnProofread');
  await page.waitForTimeout(500);
  check(await page.$eval('#cueList .cue:nth-child(2)', (e) => e.classList.contains('fixed')), 'AI imlo tekshiruvi tuzatishni belgiladi');
  await shot('10-subtitr-uslub');

  console.log('Bloknot');
  await tab('notes');
  await page.fill('#noteText', 'Birinchi qator\nIkkinchi qator');
  await page.waitForTimeout(800);
  check(/4 so'z/.test(await page.textContent('#noteStats')), 'so\'z hisoblagichi');
  await page.evaluate(() => { window.GCGemini.generateText = async () => "[KADR 1]\nSalom! Bugun 60 soniyada..."; });
  await page.fill('#noteAsk', '60 soniyalik reels senariysi');
  await page.click('[data-ai="free"]');
  await page.waitForTimeout(500);
  check((await page.$eval('#noteText', (e) => e.value)).includes('[KADR 1]'), 'AI matni qo\'shildi');
  await shot('11-bloknot');

  console.log('Video AI');
  await tab('flow');
  await page.waitForTimeout(300);
  await shot('12-video-ai');
  await page.click('#flowEngine [data-v="flow"]');
  await page.waitForTimeout(200);
  await shot('13-flow');

  console.log('Sozlamalar');
  await tab('settings');
  await shot('14-sozlamalar');

  await page.setViewportSize({ width: 900, height: 900 });
  await tab('sounds');
  await page.waitForTimeout(500);
  await shot('15-keng-effektlar');

  console.log(errors.length ? '\nXATOLAR:\n' + errors.join('\n') : '\nHammasi muvaffaqiyatli.');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
