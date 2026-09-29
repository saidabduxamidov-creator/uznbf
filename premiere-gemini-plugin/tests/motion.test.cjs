'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../client/js/motion.js');
const { makeEnv, makeItem, makeTrack, loadHost } = require('./premiere-mock.cjs');

function setup() {
  const v1 = makeTrack('V', 0), a1 = makeTrack('A', 0);
  v1.items.push(makeItem(v1, 0, 6, 12, 'D:/a.mp4'), makeItem(v1, 6, 14, 40, 'D:/a.mp4', { selected: true }));
  const env = makeEnv({ video: [v1], audio: [a1], duration: 14, playhead: 8 });
  return { v1, env, host: loadHost(env) };
}

test('easing: oraliq nuqtalar, boshi va oxiri aniq', () => {
  const s = M.sample([[0, 100], [1, 120]], 'ease_in_out');
  assert.strictEqual(s[0][1], 100); assert.strictEqual(s[s.length - 1][1], 120);
  assert.ok(s.length >= 4); assert.ok(s[1][1] < 102, 'boshida sekin');
  const lin = M.sample([[0, 1], [1, 2]], 'linear'); assert.strictEqual(lin.length, 2);
});

test('barcha presetlar host orqali xatosiz qo\'llanadi', () => {
  for (const name of Object.keys(M.PRESETS)) {
    const { host, v1 } = setup();
    const ctx = host.call('gc_getEditContext');
    const ops = M.buildPreset(name, ctx, 115);
    const r = host.call('gc_applyMotion', ops);
    assert.ok(r.ok, name + ': ' + r.error); assert.ok(r.keys >= 2, name);
    // barcha keyframe'lar tanlangan klipning media oralig'ida (40..48)
    const item = v1.items[1];
    for (const p of [...item.motion.props, ...item.opacity.props]) for (const k of p.keys) assert.ok(k.t >= 40 - 1e-6 && k.t <= 48 + 1e-6, name + ' ' + k.t);
  }
});

test('punch playhead joyidan boshlanadi', () => {
  const { host, v1 } = setup();
  const ctx = host.call('gc_getEditContext');
  host.call('gc_applyMotion', M.buildPreset('punch', ctx, 120));
  const keys = v1.items[1].motion.props[1].keys;
  assert.strictEqual(+keys[0].t.toFixed(3), 42); // inPoint 40 + (8 - 6)
  assert.ok(Math.max(...keys.map(k => k.v)) >= 124);
});

test('Claude rejasi -> ops: chegaralar, pozitsiya, noto\'g\'ri klip', () => {
  const ctx = { clips: [{ track: 0, start: 6, end: 14 }] };
  const plan = { motions: [
    { clip: 0, property: 'scale', mode: 'relative', easing: 'ease_out', keyframes: [{ time: 0, value: 100, x: 0, y: 0 }, { time: 2, value: 130, x: 0, y: 0 }] },
    { clip: 0, property: 'position', mode: 'relative', easing: 'linear', keyframes: [{ time: 99, value: 0, x: 0.1, y: -0.1 }] },
    { clip: 0, property: 'opacity', mode: 'absolute', easing: 'linear', keyframes: [{ time: 0, value: 150, x: 0, y: 0 }] },
    { clip: 3, property: 'scale', mode: 'relative', easing: 'linear', keyframes: [{ time: 0, value: 1, x: 0, y: 0 }] },
  ] };
  const { ops, problems } = M.planToOps(plan, ctx);
  assert.strictEqual(ops.length, 3); assert.strictEqual(problems.length, 1);
  assert.strictEqual(ops[0].keys[0][0], 6); assert.strictEqual(ops[0].mode, 'rel');
  assert.deepStrictEqual(ops[1].keys[0][1], [0.1, -0.1]); assert.ok(ops[1].keys[0][0] < 14);
  assert.strictEqual(ops[2].keys[0][1], 100);
});
