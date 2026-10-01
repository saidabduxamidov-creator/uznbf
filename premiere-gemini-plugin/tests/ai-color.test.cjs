'use strict';
/* ChatGPT (OpenAI) mijozi va rang berish yadrosi: tarmoqsiz sinovlar (https.request taqlid qilinadi) */
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { EventEmitter } = require('events');

require('../client/js/ai.js');
require('../client/js/color.js');
const AI = globalThis.GCAI, C = globalThis.GCColor;

/* https.request o'rniga: handler(req) -> { status, body } */
function fakeHttps(handler) {
  const calls = [];
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = (data) => {
      const call = { method: opts.method, path: opts.path, headers: opts.headers, body: data ? JSON.parse(String(data)) : null };
      calls.push(call);
      const r = handler(call, calls.length);
      const res = new EventEmitter();
      res.statusCode = r.status || 200; res.headers = r.headers || {};
      setImmediate(() => { cb(res); res.emit('data', Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))); res.emit('end'); });
    };
    return req;
  };
  return { calls, restore: () => { https.request = orig; } };
}

const MODELS = { data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }, { id: 'gpt-5' }, { id: 'gpt-5.2' }, { id: 'gpt-5-mini' }, { id: 'dall-e-3' }] };
const answer = (content) => ({ choices: [{ finish_reason: 'stop', message: { content } }] });

test('ChatGPT: eng yangi GPT avtomatik, rasm + strict JSON sxema', async () => {
  const f = fakeHttps((c) => (c.path === '/v1/models' ? { body: MODELS } : { body: answer('{"summary":"ok","n":3}') }));
  try {
    const r = await AI.openai({ apiKey: 'sk-test', system: 'sys', schema: { type: 'object', properties: { summary: { type: 'string' }, n: { type: 'integer' } } },
      content: [{ type: 'text', text: 'salom' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] });
    assert.deepStrictEqual(r, { summary: 'ok', n: 3 });
    const body = f.calls[1].body;
    assert.strictEqual(f.calls[0].method, 'GET');
    assert.strictEqual(f.calls[1].headers.Authorization, 'Bearer sk-test');
    assert.strictEqual(body.model, 'gpt-5.2');
    assert.strictEqual(body.reasoning_effort, 'medium');
    assert.strictEqual(body.messages[0].role, 'system');
    assert.deepStrictEqual(body.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA', detail: 'auto' } });
    const fmt = body.response_format;
    assert.strictEqual(fmt.type, 'json_schema'); assert.strictEqual(fmt.json_schema.strict, true);
    assert.deepStrictEqual(fmt.json_schema.schema.required, ['summary', 'n']);
    assert.strictEqual(fmt.json_schema.schema.additionalProperties, false);
  } finally { f.restore(); }
});

test('ChatGPT: eski model parametrlarni bilmasa - ularsiz qayta yuboradi', async () => {
  const f = fakeHttps((c) => {
    const b = c.body;
    if (b.reasoning_effort) return { status: 400, body: { error: { message: "Unrecognized request argument supplied: reasoning_effort" } } };
    if (b.response_format && b.response_format.type === 'json_schema') return { status: 400, body: { error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." } } };
    return { body: answer('```json\n{"a":1}\n```') };
  });
  try {
    const r = await AI.openai({ apiKey: 'k', model: 'gpt-5-custom', content: [{ type: 'text', text: 'x' }], schema: { type: 'object', properties: { a: { type: 'integer' } } } });
    assert.deepStrictEqual(r, { a: 1 });
    const last = f.calls[f.calls.length - 1].body;
    assert.strictEqual(last.response_format.type, 'json_object');
    assert.ok(!('reasoning_effort' in last));
    assert.match(last.messages[0].content, /JSON schema/);
  } finally { f.restore(); }
});

test('ChatGPT: xatolar tushunarli o\'zbekcha', async () => {
  let f = fakeHttps(() => ({ status: 401, body: { error: { message: 'Incorrect API key' } } }));
  await assert.rejects(AI.openai({ apiKey: 'k', model: 'gpt-4o', content: [{ type: 'text', text: 'x' }] }), /kalit noto'g'ri/);
  f.restore();
  f = fakeHttps(() => ({ status: 429, body: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } }));
  await assert.rejects(AI.openai({ apiKey: 'k', model: 'gpt-4o', content: [{ type: 'text', text: 'x' }] }), /mablag'/);
  assert.strictEqual(f.calls.length, 1, 'quota xatosida qayta urinilmaydi');
  f.restore();
  await assert.rejects(AI.openai({ apiKey: '', content: [] }), /kalitini kiriting/);
});

test('matn AI: ChatGPT tanlansa - OpenAI ishlatiladi', async () => {
  assert.strictEqual(AI.pickProvider({ textAI: 'openai', openaiKey: 'k', claudeKey: 'c' }), 'openai');
  assert.strictEqual(AI.pickProvider({ textAI: 'auto', openaiKey: 'k' }), 'openai');
  assert.strictEqual(AI.pickProvider({ textAI: 'auto', claudeKey: 'c', openaiKey: 'k' }), 'claude');
  const f = fakeHttps(() => ({ body: answer('Salom!') }));
  try {
    const t = await AI.text({ settings: { textAI: 'openai', openaiKey: 'k', openaiModel: 'gpt-4.1' }, prompt: 'yoz' });
    assert.strictEqual(t, 'Salom!'); assert.strictEqual(f.calls[0].body.model, 'gpt-4.1');
  } finally { f.restore(); }
});

test('rang: neytral LUT o\'zgartirmaydi, .cube formati to\'g\'ri', () => {
  const cube = C.buildCube({}, 5, 'x').trim().split('\n');
  assert.strictEqual(cube.filter((l) => /^LUT_3D_SIZE 5$/.test(l)).length, 1);
  const rows = cube.filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l));
  assert.strictEqual(rows.length, 125);
  assert.strictEqual(rows[1], '0.250000 0.000000 0.000000', 'qizil eng tez o\'zgaradi');
  assert.strictEqual(rows[124], '1.000000 1.000000 1.000000');
});

test('rang: uslublar xavfsiz (0..1, kulrang tartibi saqlanadi), avto balans rang og\'ishini kamaytiradi', () => {
  for (const [k, p] of Object.entries(C.PRESETS)) {
    const f = C.gradeFn(p.look);
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const o = f(v, v, v);
      o.forEach((x) => assert.ok(x >= 0 && x <= 1, k));
      const L = 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2];
      assert.ok(L >= prev - 1e-6, k + ': yorqinlik monoton'); prev = L;
    }
  }
  // ko'k og'ishli kadr
  const px = new Uint8ClampedArray(4 * 4096);
  for (let i = 0; i < 4096; i++) { const l = (i % 64) / 64; px[i * 4] = l * 170; px[i * 4 + 1] = l * 200; px[i * 4 + 2] = Math.min(255, l * 260); px[i * 4 + 3] = 255; }
  const st = C.analyze(px);
  const g = C.gradeFn(C.combine(C.autoBalance(st, 1), {}, null, null));
  const before = [170 / 255 * 0.5, 200 / 255 * 0.5, 0.51], after = g(...before);
  const cast = (c) => c[2] - c[0];
  assert.ok(cast(after) < cast(before) * 0.75, 'ko\'k og\'ish kamaydi');
});

test('rang: ChatGPT javobi chegaralanadi, klip tuzatishlari ajratiladi', () => {
  const g = C.fromAI({ summary: 'Kino', look: { exposure: 9, contrast: 0.2, saturation: 5, lift: [1, 0, 0], shadow_hue: 400, shadow_amount: 0.5, highlight_hue: 30, highlight_amount: 0.3, fade: 1, highlight_rolloff: 0.4, monochrome: 0, temperature: 0.1, tint: 0, vibrance: 0.1, gamma: [0, 0, 0], gain: [0, 0, 0] },
    clips: [{ index: 2, exposure: 3, temperature: -0.1, tint: 0, note: 'qorong\'i' }] });
  assert.strictEqual(g.look.exposure, 2.5); assert.strictEqual(g.look.saturation, 2); assert.strictEqual(g.look.lift[0], 0.15);
  assert.strictEqual(g.look.shadowHue, 40); assert.strictEqual(g.look.fade, 0.2);
  assert.deepStrictEqual(g.clips[2], { exposure: 1, temperature: -0.1, tint: 0, note: 'qorong\'i' });
  const p = C.combine({ exposure: 0.2 }, g.look, g.clips[2], { exposure: -0.1, saturation: 0.5 });
  assert.ok(Math.abs(p.exposure - 2.5) < 1e-9, 'yig\'indi ham chegarada');
  assert.strictEqual(p.saturation, 1);
  const cdl = C.toCDL(p);
  assert.match(cdl.Slope, /^[\d.]+ [\d.]+ [\d.]+$/);
});
