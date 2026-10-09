'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAE, loadHost } = require('./ae-mock.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcae-'));

/* Kompozitsiya: 1080x1920, 30s. Qatlamlar (yuqoridan): Musiqa (audio), Video B (6-13s), Video A (0-6s, nutq bilan) */
function setup(opts) {
  const ae = makeAE(Object.assign({ name: 'Reels', width: 1080, height: 1920, fps: 25, duration: 30 }, opts || {}));
  const dir = tmp();
  const vidA = ae.footage(path.join(dir, 'A.mp4'), { duration: 20, hasAudio: true });
  const vidB = ae.footage(path.join(dir, 'B.mp4'), { duration: 20, hasAudio: false });
  const music = ae.footage(path.join(dir, 'music.mp3'), { duration: 30, hasVideo: false, hasAudio: true });
  const A = ae.comp.layers.add(vidA); A.outPoint = 6;
  const B = ae.comp.layers.add(vidB); B.startTime = 6; B.outPoint = 13;
  const M = ae.comp.layers.add(music); M.name = 'Musiqa';
  ae.comp.time = 8;
  return Object.assign(ae, { host: loadHost(ae), A, B, M, dir });
}

test('kompozitsiya ma\'lumoti: audio qatlamlar "trek" sifatida, work area', () => {
  const { host, comp } = setup();
  comp.workAreaStart = 2; comp.workAreaDuration = 10;
  const s = host.call('gc_getSequenceInfo');
  assert.ok(s.ok, s.error);
  assert.strictEqual(s.name, 'Reels'); assert.strictEqual(s.fps, 25); assert.strictEqual(s.width, 1080); assert.strictEqual(s.playhead, 8);
  assert.deepStrictEqual(s.audioTracks.map((a) => [a.index, a.name]), [[0, 'Musiqa'], [2, 'A.mp4']]);
  assert.strictEqual(s.hasRange, true); assert.strictEqual(s.inPoint, 2); assert.strictEqual(s.outPoint, 12);
  assert.strictEqual(host.call('gc_findAudioPreset').path, 'ae-render');
});

test('audio eksport: faqat nutq qatlami yoqiladi, Render Queue tozalanadi, holat tiklanadi', () => {
  const env = setup();
  const { host, app, M, A } = env;
  const other = app.project.renderQueue.items.add(env.comp); // foydalanuvchining navbatdagi ishi
  const wav = path.join(env.dir, 'tl.wav');
  const r = host.call('gc_exportAudio', wav, 'ae-render', [2], false);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.path, wav); assert.ok(fs.existsSync(wav));
  const job = app.project.rendered[0];
  assert.strictEqual(app.project.rendered.length, 1, 'foydalanuvchi ishi render qilinmadi');
  assert.deepStrictEqual(job.audio, [['Musiqa', false], ['A.mp4', true]]);
  assert.strictEqual(job.format, 'WAV'); assert.deepStrictEqual(job.span, [0, 30]);
  assert.strictEqual(M.audioEnabled, true, 'musiqa qayta yoqildi'); assert.strictEqual(A.audioEnabled, true);
  assert.strictEqual(app.project.renderQueue.numItems, 1); assert.strictEqual(other.render, true, 'foydalanuvchi ishi joyida');
});

test('audio eksport: WAV bo\'lmasa AIFF 48kHz shabloni', () => {
  const env = setup({ noWav: true });
  const r = env.host.call('gc_exportAudio', path.join(env.dir, 'tl.wav'), 'ae-render', [2], true);
  assert.ok(r.ok, r.error);
  assert.match(r.path, /\.aif$/); assert.strictEqual(r.result, 'aiff');
});

test('subtitr: SRT -> alohida matn qatlamlari, vaqtlari to\'g\'ri', () => {
  const { host, comp, dir } = setup();
  const srt = path.join(dir, 'a.srt');
  fs.writeFileSync(srt, '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nAssalomu alaykum!\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,200\r\nIkkinchi\r\nqator\r\n');
  const r = host.call('gc_importSrt', srt);
  assert.ok(r.ok, r.error); assert.strictEqual(r.layers, 2);
  const subs = comp._layers.filter((l) => /Subtitr/.test(l.name));
  assert.deepStrictEqual(subs.map((l) => [l.name, l.inPoint, l.outPoint]), [['GeminiCut Subtitr 1', 1, 2.5], ['GeminiCut Subtitr 2', 3, 4.2]]);
  const doc = subs[1].textGroup.map['ADBE Text Document'].v;
  assert.strictEqual(doc.text, 'Ikkinchi\nqator'.replace('\n', '\r'));
  assert.strictEqual(doc.fontSize, Math.round(1920 * 0.036)); assert.strictEqual(doc.justification, 7413);
});

test('tahrir konteksti: AE tanlovi, bo\'lmasa vaqt ko\'rsatkichi ostidagi qatlam', () => {
  const { host, A, B } = setup();
  let c = host.call('gc_getEditContext');
  assert.strictEqual(c.source, 'playhead'); assert.strictEqual(c.clips[0].name, 'B.mp4'); assert.strictEqual(c.clips[0].start, 6);
  assert.deepStrictEqual(c.clips[0].position, [0.5, 0.5]);
  A._sel = true;
  c = host.call('gc_getEditContext');
  assert.strictEqual(c.source, 'selection'); assert.strictEqual(c.clips[0].name, 'A.mp4'); assert.strictEqual(c.clips[0].track, 2);
});

test('motion: nisbiy scale, kadr ulushidagi position -> piksel, rotation, tozalash', () => {
  const { host, B } = setup();
  const r = host.call('gc_applyMotion', [
    { track: 1, start: 6, prop: 'scale', mode: 'rel', keys: [[6, 100], [9, 120]] },
    { track: 1, start: 6, prop: 'position', mode: 'rel', keys: [[6, [0, 0]], [9, [0.1, -0.05]]] },
    { track: 1, start: 6, prop: 'rotation', mode: 'abs', keys: [[7, 3]] },
    { track: 1, start: 6, prop: 'opacity', mode: 'abs', keys: [[6, 0], [6.5, 100]] },
  ]);
  assert.ok(r.ok, r.error); assert.strictEqual(r.applied, 4); assert.strictEqual(r.keys, 7);
  const sc = B.transform.map['ADBE Scale'], pos = B.transform.map['ADBE Position'];
  assert.deepStrictEqual(sc.valueAtTime(9), [120, 120, 120]);
  assert.strictEqual(sc.keyTime(1), 6, 'keyframe vaqti kompozitsiya vaqtida');
  assert.deepStrictEqual(pos.valueAtTime(9), [540 + 108, 960 - 96, 0]);
  const z = host.call('gc_resetMotion', [[1, 6]]);
  assert.strictEqual(z.reset, 1);
  assert.strictEqual(sc.numKeys, 0); assert.deepStrictEqual(sc.value, [100, 100, 100]);
});

test('avto zoom: gapirayotgan qatlamga (nutq qatlami bilan bir xil fayl)', () => {
  const { host, A, B } = setup();
  const r = host.call('gc_applyZooms', [[2, 115, 1], [8, 115, 1]], [2]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.applied, 2);
  assert.ok(A.transform.map['ADBE Scale'].numKeys === 4, 'A (nutq) qatlami');
  assert.ok(B.transform.map['ADBE Scale'].numKeys === 4, '8s da faqat B ko\'rinadi');
});

test('kesish: qatlamlar bo\'linadi, chapga suriladi, keyframe\'lar birga, kompozitsiya qisqaradi', () => {
  const { host, comp, A, B, M } = setup();
  host.call('gc_applyMotion', [{ track: 1, start: 6, prop: 'scale', mode: 'abs', keys: [[11, 100], [12, 130]] }]);
  const r = host.call('gc_applyCuts', [[2, 3], [7, 8]], [2]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.applied, 2); assert.strictEqual(r.seconds, 2);
  assert.strictEqual(comp.duration, 28);
  const spans = (name) => comp._layers.filter((l) => l.name === name).map((l) => [+l.inPoint.toFixed(3), +l.outPoint.toFixed(3)]).sort((a, b) => a[0] - b[0]);
  assert.deepStrictEqual(spans('A.mp4'), [[0, 2], [2, 5]]);
  assert.deepStrictEqual(spans('B.mp4'), [[5, 6], [6, 11]]);
  assert.deepStrictEqual(spans('Musiqa'), [[0, 2], [2, 6], [6, 28]]);
  const last = comp._layers.filter((l) => l.name === 'B.mp4').sort((a, b) => b.inPoint - a.inPoint)[0];
  const sc = last.transform.map['ADBE Scale'];
  assert.deepStrictEqual([sc.keyTime(1), sc.keyTime(2)], [9, 10], 'zoom 11-12s -> 9-10s ga surildi');
  assert.ok(comp.frames.length === 0);
});

test('SFX va kadrlar', () => {
  const { host, comp, app, dir } = setup();
  const wav = path.join(dir, 'whoosh.wav'); fs.writeFileSync(wav, 'RIFF');
  let r = host.call('gc_insertSound', wav, -1, 4.5, [2]);
  assert.ok(r.ok, r.error);
  const sfx = comp._layers[comp._layers.length - 1];
  assert.strictEqual(sfx.name, 'whoosh.wav'); assert.strictEqual(sfx.inPoint, 4.5);
  r = host.call('gc_insertSound', wav, -1, -1, [2]);
  assert.strictEqual(r.at, 8, 'vaqt ko\'rsatkichi joyiga');
  assert.strictEqual(app.project.items.filter ? 1 : 1, 1);
  r = host.call('gc_exportFrames', path.join(dir, 'f'), [1, 6.5]);
  assert.strictEqual(r.files.length, 2); assert.deepStrictEqual(comp.frames, [1, 6.5]);
  assert.ok(!('gc_flowCapture' in host.api) && !('gc_flowImport' in host.api), 'Flow/Veo funksiyalari olib tashlangan');
});

test('animatsion matn: PNG ketma-ketligi eng yuqoriga, kadr tezligi, almashtirish', () => {
  const { host, comp, dir } = setup();
  const d = path.join(dir, 'GeminiCut', 'Matn', 'a'); fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < 75; i++) fs.writeFileSync(path.join(d, 'gc_' + String(i).padStart(4, '0') + '.png'), 'x');
  let r = host.call('gc_importSequence', path.join(d, 'gc_0000.png'), 75, 30, -1, null, 'Matn · Pop');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.track, 0); assert.strictEqual(comp.layer(1).inPoint, 8);
  assert.strictEqual(+(comp.layer(1).outPoint - comp.layer(1).inPoint).toFixed(3), 2.5, '75 kadr @ 30fps');
  assert.strictEqual(comp.layer(1).source.name, 'Matn · Pop');
  comp.time = 9;
  const at = host.call('gc_textAtPlayhead');
  assert.ok(at.ok, at.error); assert.strictEqual(at.track, 0);
  const n = comp.numLayers;
  r = host.call('gc_importSequence', path.join(d, 'gc_0000.png'), 75, 30, -1, { track: at.track, start: at.start }, 'Yangi');
  assert.ok(r.ok, r.error);
  assert.strictEqual(comp.numLayers, n, 'eskisi o\'rniga'); assert.strictEqual(comp.layer(1).source.name, 'Yangi'); assert.strictEqual(comp.layer(1).inPoint, 8);
  assert.strictEqual(host.call('gc_colorTargets', 'all').ok, false);
});

/* Panelning haqiqiy shablon -> native spec o'giruvchisi */
const CLIENT_JS = path.join(__dirname, '..', '..', 'premiere-gemini-plugin', 'client', 'js');
['textfx.js', 'textfx-plates.js', 'textfx-gym.js'].forEach((f) => require(path.join(CLIENT_JS, f)));
const FX = globalThis.GCTextFX;
const specFor = (id, extra) => { const R = Object.assign(FX.recipeFor(id), extra || {}); const s = FX.nativeSpec(R); s.recipe = R; return s; };
const expr = (p) => p.expression || '';

test('native matn: AE matn qatlami + matnga bog\'langan shape fon + keyframe animatsiya', () => {
  const { host, comp } = setup();
  const n0 = comp.numLayers;
  const r = host.call('gc_insertNative', specFor('gym_banner', { text: 'CHIMGAN', sub: '' }), -1, null);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.native, true); assert.strictEqual(r.track, 0); assert.strictEqual(comp.numLayers, n0 + 2);
  const T = comp.layer(1), S = comp.layer(2);
  assert.ok(T.textGroup, 'yuqorida matn qatlami');
  const doc = T.textGroup.map['ADBE Text Document'].v;
  assert.strictEqual(doc.text, 'CHIMGAN'); assert.strictEqual(doc.font, 'Bahnschrift-Bold');
  assert.strictEqual(doc.fontSize, Math.round(FX.recipeFor('gym_banner').size * 1920));
  assert.deepStrictEqual(doc.fillColor, [1, 1, 1]);
  assert.strictEqual(T.inPoint, 8); assert.ok(Math.abs(T.outPoint - 8 - FX.recipeFor('gym_banner').duration) < 1e-6);
  assert.ok(/^GeminiCut:\{/.test(T.comment) && JSON.parse(T.comment.slice(10)).template === 'gym_banner', 'retsept izohda');
  assert.ok(/sourceRectAtTime/.test(expr(T.transform.map['ADBE Anchor Point'])), 'tayanch nuqta matn markazida');
  const pos = T.transform.map['ADBE Position'];
  assert.ok(pos.numKeys === 4 && pos.keyValue(1)[0] < pos.keyValue(2)[0], 'slide: chapdan kiradi');
  assert.strictEqual(T.transform.map['ADBE Opacity'].numKeys, 4);
  // fon: shape qatlam, ota - matn, qiyshiq yo'l ifodasi
  assert.ok(S.contents && S.parent === T && S.name === 'GeminiCut fon');
  const vec = S.contents.property(1).property('ADBE Vectors Group');
  assert.ok(/createPath/.test(expr(vec.property('ADBE Vector Shape - Group').property('ADBE Vector Shape'))), 'qiyshiq fon');
  assert.deepStrictEqual(vec.property('ADBE Vector Graphic - Fill').property('ADBE Vector Fill Color').v, [232 / 255, 0, 28 / 255]);
  assert.strictEqual(expr(S.transform.map['ADBE Opacity']), 'thisLayer.parent.transform.opacity');
  assert.strictEqual(T.effects.children.some((e) => e.matchName === 'ADBE Drop Shadow'), FX.recipeFor('gym_banner').shadow > 0, 'soya faqat kerak bo\'lsa');
});

test('native matn: plashka (yumaloq), ost matn, sanagich/taymer/yozuv mashinkasi ifodalari', () => {
  const { host, comp } = setup();
  let r = host.call('gc_insertNative', specFor('plate_pill', { text: 'Obuna bo\'ling' }), 2, null);
  assert.ok(r.ok, r.error);
  const S = comp._layers.find((l) => l.name === 'GeminiCut fon');
  const rect = S.contents.property(1).property('ADBE Vectors Group').property('ADBE Vector Shape - Rect');
  assert.ok(/\[w,h\]/.test(expr(rect.property('ADBE Vector Rect Size'))) && /\*1;$/.test(expr(rect.property('ADBE Vector Rect Roundness'))), 'pill: to\'liq yumaloq');
  r = host.call('gc_insertNative', specFor('gym_lower', { text: 'Aziz', sub: 'Trener' }), 4, null);
  assert.ok(r.ok, r.error);
  const sub = comp._layers.find((l) => l.name === 'GeminiCut ost matn');
  assert.ok(sub && sub.parent === comp.layer(1) && sub.textGroup.map['ADBE Text Document'].v.text === 'Trener');
  assert.strictEqual(comp.layer(1).textGroup.map['ADBE Text Document'].v.justification, 7414, 'chapga tekislangan');
  for (const [id, re] of [['gym_counter', /replace/], ['gym_timer', /Math\.ceil/], ['typewriter', /substr/]]) {
    r = host.call('gc_insertNative', specFor(id), 6, null);
    assert.ok(r.ok, r.error);
    assert.ok(re.test(expr(comp.layer(1).textGroup.map['ADBE Text Document'])), id + ' ifodasi');
    if (id === 'typewriter') assert.ok(comp.layer(1).effects.children.some((e) => e.matchName === 'ADBE Drop Shadow'), 'soya effekti');
  }
  // ifodalar - ASCII va ES3 sintaksisi (AE ikkala ifoda dvigateli uchun)
  comp._layers.forEach((l) => [l.transform, l.textGroup].filter(Boolean).forEach((g) => Object.values(g.map).forEach((p) => {
    if (p.expression) assert.doesNotThrow(() => new Function('value', 'time', 'inPoint', 'outPoint', 'thisComp', 'thisLayer', 'sourceRectAtTime', 'linear', 'ease', 'add', 'mul', p.expression));
  })));
});

test('native 3D logo: Null boshqaruvchi + 3D nusxalar, qalinlik slayderi, almashtirish va tahrirlash', () => {
  const env = setup();
  const { host, comp } = env;
  const logo = path.join(env.dir, 'fitcity-malika.png');
  fs.writeFileSync(logo, 'PNG');
  const n0 = comp.numLayers;
  const r = host.call('gc_insertNative', specFor('logo_malika', { logo }), -1, null);
  assert.ok(r.ok, r.error);
  assert.strictEqual(comp.numLayers, n0 + 13);
  const N = comp.layer(1);
  assert.ok(N.isNull && N.threeDLayer && /Malika/.test(N.name));
  assert.strictEqual(N.effects.property(1).name, 'Qalinlik');
  assert.ok(N.effects.property(1).property('ADBE Slider Control-0001').v > 0);
  const copies = comp._layers.filter((l) => l.parent === N);
  assert.strictEqual(copies.length, 12);
  assert.ok(copies.every((l) => l.threeDLayer && /Qalinlik/.test(expr(l.transform.map['ADBE Position']))));
  assert.strictEqual(comp.layer(2).name, 'GeminiCut logo (old tomon)');
  assert.ok(N.transform.map['ADBE Rotate Y'].numKeys === 4 && /Math\.sin/.test(expr(N.transform.map['ADBE Rotate Y'])));
  // tanlangan logo qatlamidan tahrirlash -> retsept qaytadi
  comp._layers.forEach((l) => { l.selected = false; }); comp.layer(5).selected = true; comp.time = 0;
  const at = host.call('gc_textAtPlayhead');
  assert.ok(at.ok, at.error); assert.strictEqual(at.native, true); assert.strictEqual(JSON.parse(at.recipe).template, 'logo_malika');
  // almashtirish: butun guruh o'chadi, yangi matn o'sha vaqtda
  const r2 = host.call('gc_insertNative', specFor('pop', { text: 'YANGI' }), -1, { track: at.track, start: at.start });
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(comp.numLayers, n0 + 1); assert.strictEqual(comp.layer(1).inPoint, 8);
  assert.ok(!comp._layers.some((l) => /logo/i.test(l.name)));
  // native -> PNG ketma-ketligi bilan almashtirish ham ishlaydi
  const d = path.join(env.dir, 'Matn', 'x'); fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(d, 'gc_' + String(i).padStart(4, '0') + '.png'), 'x');
  const r3 = host.call('gc_importSequence', path.join(d, 'gc_0000.png'), 10, 25, -1, { track: 0, start: 8 }, 'PNG');
  assert.ok(r3.ok, r3.error);
  assert.strictEqual(comp.numLayers, n0 + 1); assert.strictEqual(comp.layer(1).source.name, 'PNG');
});
