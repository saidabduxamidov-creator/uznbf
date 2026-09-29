'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeEnv, makeItem, makeTrack, loadHost } = require('./premiere-mock.cjs');

function timeline() {
  const v1 = makeTrack('V', 0), v2 = makeTrack('V', 1), a1 = makeTrack('A', 0), a2 = makeTrack('A', 1), a3 = makeTrack('A', 2, { name: 'Musiqa' });
  // Bitta manbadan kesilgan uchta klip (katta inPoint bilan), musiqa A3 da
  [[0, 8, 30], [8, 15, 52], [15, 25, 70]].forEach(([s, e, i]) => {
    v1.items.push(makeItem(v1, s, e, i, 'D:/C9966.MP4')); a1.items.push(makeItem(a1, s, e, i, 'D:/C9966.MP4'));
  });
  a3.items.push(makeItem(a3, 0, 25, 0, 'D:/music.mp3'));
  const env = makeEnv({ video: [v1, v2], audio: [a1, a2, a3], duration: 25, playhead: 10 });
  return { env, v1, v2, a1, a2, a3, host: loadHost(env) };
}
const scaleOf = (item) => item.motion.props[1];

test('zoom: media vaqtida keyframe, nisbiy masshtab', () => {
  const { v1, host } = timeline();
  const r = host.call('gc_applyZooms', [[9, 115, 2]], [0]);
  assert.ok(r.ok, r.error); assert.strictEqual(r.applied, 1);
  const keys = scaleOf(v1.items[1]).keys;
  assert.deepStrictEqual(keys.map(k => +k.t.toFixed(2)), [53, 53.35, 55.35, 55.7]); // inPoint 52 + (9-8)
  assert.deepStrictEqual(keys.map(k => +k.v.toFixed(1)), [100, 115, 115, 100]);
});

test('zoom: oldingi urinishdan qolgan "animatsiya yoqilgan, keyframe yo\'q" holati', () => {
  const { v1, host } = timeline();
  const p = scaleOf(v1.items[1]); p.tv = true; p.value = 120; // 3.0 dagi xatodan qolgan holat
  const r = host.call('gc_applyZooms', [[9, 110, 1]], [0]);
  assert.ok(r.ok, r.error); assert.strictEqual(r.applied, 1);
  assert.strictEqual(p.keys.length, 4);
  assert.strictEqual(+p.keys[1].v.toFixed(1), 132); // 120 * 1.10
});

test('zoom: mavjud animatsiya bor klipda eski keyframe\'lar oraliqda almashtiriladi', () => {
  const { v1, host } = timeline();
  const p = scaleOf(v1.items[1]); p.tv = true; p.keys = [{ t: 52, v: 100 }, { t: 53.5, v: 140 }, { t: 58, v: 100 }];
  host.call('gc_applyZooms', [[9, 115, 2]], [0]);
  assert.ok(!p.keys.some(k => Math.abs(k.t - 53.5) < 1e-6), 'eski keyframe olib tashlanishi kerak');
  assert.ok(p.keys.some(k => Math.abs(k.t - 58) < 1e-6), 'oraliqdan tashqaridagisi qolishi kerak');
});

test('zoom: tezlik (speed) hisobga olinadi va klip chegarasidan chiqmaydi', () => {
  const { v1, host } = timeline();
  v1.items[0].speed = 2;
  const r = host.call('gc_applyZooms', [[7, 115, 4]], [0]); // 7s + 4.7s > klip oxiri (8s)
  assert.ok(r.ok, r.error);
  const k = scaleOf(v1.items[0]).keys;
  assert.strictEqual(+k[0].t.toFixed(2), 30 + 7 * 2);
  assert.ok(k[k.length - 1].t <= 30 + (8 - 0.04) * 2 + 1e-6);
});

test('motion: position/rotation/opacity abs va rel, klip boshidan rejim', () => {
  const { v1, host } = timeline();
  let r = host.call('gc_applyMotion', [
    { track: 0, start: 15, prop: 'position', mode: 'rel', keys: [[15, [0, 0]], [17, [0.1, -0.05]]] },
    { track: 0, start: 15, prop: 'rotation', mode: 'abs', keys: [[15, 0], [16, 8]] },
    { track: 0, start: 15, prop: 'opacity', mode: 'abs', keys: [[15, 0], [15.5, 100]] },
  ]);
  assert.ok(r.ok, r.error); assert.strictEqual(r.applied, 3); assert.strictEqual(r.keys, 6);
  const it = v1.items[2];
  assert.deepStrictEqual(it.motion.props[0].keys[1].v.map(x => +x.toFixed(2)), [0.6, 0.45]);
  assert.strictEqual(it.motion.props[0].keys[0].t, 70);
  host.call('gc_setKeyBase', 'clip');
  r = host.call('gc_applyMotion', [{ track: 0, start: 0, prop: 'scale', mode: 'abs', keys: [[1, 100], [2, 150]] }]);
  assert.ok(r.ok);
  assert.deepStrictEqual(scaleOf(v1.items[0]).keys.map(k => k.t), [1, 2]);
});

test('motion: xato klip aniq xabar bilan rad etiladi', () => {
  const { host } = timeline();
  const r = host.call('gc_applyMotion', [{ track: 1, start: 3, prop: 'scale', mode: 'abs', keys: [[3, 120]] }]);
  assert.strictEqual(r.ok, false); assert.match(r.error, /klip topilmadi/);
});

test('reset va tahrir konteksti', () => {
  const { v1, host } = timeline();
  host.call('gc_applyZooms', [[9, 115, 2]], [0]);
  let ctx = host.call('gc_getEditContext');
  assert.strictEqual(ctx.source, 'playhead'); assert.strictEqual(ctx.clips[0].start, 8); assert.strictEqual(ctx.width, 1080);
  v1.items[2].selected = true;
  ctx = host.call('gc_getEditContext');
  assert.strictEqual(ctx.source, 'selection'); assert.strictEqual(ctx.clips[0].start, 15);
  const r = host.call('gc_resetMotion', [[0, 8]]);
  assert.strictEqual(r.reset, 1); assert.strictEqual(scaleOf(v1.items[1]).isTimeVarying(), false);
});

test('SFX: avtomatik bo\'sh trek (nutq treklari chetlab o\'tiladi), band bo\'lsa yangi trek', () => {
  const { a2, a3, env, host } = timeline();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-')); const f = path.join(dir, 'whoosh.wav'); fs.writeFileSync(f, 'x');
  let r = host.call('gc_insertSound', f, -1, 3, [0]);
  assert.ok(r.ok, r.error); assert.strictEqual(r.track, 1); assert.strictEqual(a2.items.length, 1);
  r = host.call('gc_insertSound', f, -1, 3.2, [0]); // A2 band, A3 musiqa band -> yangi trek
  assert.ok(r.ok, r.error); assert.strictEqual(r.track, 3); assert.strictEqual(env.seq.audioTracks.numTracks, 4);
  r = host.call('gc_insertSound', f, 2, 5, [0]);
  assert.strictEqual(r.ok, false); assert.match(r.error, /band/);
});

test('kadr eksporti playhead joyini tiklaydi', () => {
  const { env, host } = timeline();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
  const r = host.call('gc_exportFrames', path.join(dir, 'f'), [1, 9, 20]);
  assert.ok(r.ok, r.error); assert.strictEqual(r.files.length, 3); assert.strictEqual(env.seq._ph, 10);
});

test('kesish: video va nutq treklari sinxron, musiqa tegilmaydi', () => {
  const { v1, a1, a3, host } = timeline();
  const r = host.call('gc_applyCuts', [[5, 6], [12, 13.5]], [0]);
  assert.ok(r.ok, r.error); assert.strictEqual(r.applied, 2);
  const fmt = t => t.items.map(x => x.start.seconds.toFixed(2) + '-' + x.end.seconds.toFixed(2)).join(' ');
  assert.strictEqual(fmt(v1), fmt(a1)); assert.strictEqual(fmt(a3), '0.00-25.00');
});
