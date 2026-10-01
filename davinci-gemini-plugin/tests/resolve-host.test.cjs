'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeResolve, TimelineItem, MediaPoolItem, FPS, START } = require('./resolve-mock.cjs');
const { createHost, tcToFrames, framesToTc } = require('../host.js');
const M = require('../../premiere-gemini-plugin/client/js/motion.js');

/* Timeline: V1 da bitta manbadan 3 bo'lak (katta source offset), A1 nutq, A2 musiqa */
function setup() {
  const r = makeResolve();
  const src = new MediaPoolItem('D:/C9966.MP4', 5000);
  const music = new MediaPoolItem('D:/music.mp3', 750);
  r.tl.tracks.audio.push([]); r.tl.enabled.audio.push(true); r.tl.locked.audio.push(false);
  [[0, 6, 250], [6, 13, 750], [13, 21, 1300]].forEach(([s, e, off]) => {
    r.tl.tracks.video[0].push(new TimelineItem(START + s * FPS, START + e * FPS, src, off));
    r.tl.tracks.audio[0].push(new TimelineItem(START + s * FPS, START + e * FPS, src, off));
  });
  r.tl.tracks.audio[1].push(new TimelineItem(START, START + 21 * FPS, music, 0));
  r.tl.ph = START + 8 * FPS;
  const host = createHost(r.resolve, { fs, path, sleep: () => Promise.resolve() });
  return Object.assign(r, { host, src });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-'));

test('timecode: oddiy va drop-frame ikki tomonlama', () => {
  assert.strictEqual(tcToFrames('01:00:00:00', 25), 90000);
  assert.strictEqual(framesToTc(90012, 25, false), '01:00:00:12');
  for (const f of [0, 1799, 1800, 17982, 107892, 215784]) assert.strictEqual(tcToFrames(framesToTc(f, 29.97, true), 29.97), f);
  assert.strictEqual(framesToTc(1800, 29.97, true), '00:01:00;02');
});

test('sequence ma\'lumoti: uzunlik, treklar, playhead', async () => {
  const { host } = setup();
  const s = await host.gc_getSequenceInfo();
  assert.ok(s.ok, s.error);
  assert.strictEqual(s.fps, 25); assert.strictEqual(s.width, 1080); assert.strictEqual(s.playhead, 8);
  assert.strictEqual(s.audioTracks.length, 2); assert.strictEqual(s.audioTracks[1].clips, 1);
  assert.ok(s.duration >= 21);
});

test('audio eksport: faqat nutq treki yoqiladi, keyin holat tiklanadi', async () => {
  const { host, project, tl } = setup();
  tl.enabled.audio[1] = true;
  const dir = tmp();
  const r = await host.gc_exportAudio(path.join(dir, 'tl.wav'), 'resolve-render', [0], false);
  assert.ok(r.ok, r.error); assert.ok(fs.existsSync(r.path));
  assert.deepStrictEqual(project.render[0].enabled, [true, false], 'render paytida musiqa o\'chirilgan');
  assert.deepStrictEqual(tl.enabled.audio, [true, true], 'keyin tiklangan');
  assert.strictEqual(project.renderSettings.ExportVideo, false);
});

test('SFX: nutq va band treklardan qochadi, kerak bo\'lsa yangi trek, playhead joyida', async () => {
  const { host, tl } = setup();
  const dir = tmp(); const f = path.join(dir, 'whoosh.wav'); fs.writeFileSync(f, 'x');
  let r = await host.gc_insertSound(f, -1, -1, [0]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.track, 2, 'A1 nutq, A2 musiqa band -> yangi A3');
  assert.strictEqual(tl.tracks.audio[2][0].start, START + 8 * FPS);
  r = await host.gc_insertSound(f, -1, 12, [0]);
  assert.strictEqual(r.track, 2, 'A3 da 12s bo\'sh');
  r = await host.gc_insertSound(f, 1, 3, [0]);
  assert.strictEqual(r.ok, false); assert.match(r.error, /band/);
});

test('zoom: Fusion Lua to\'g\'ri klipga va klip boshiga nisbatan kadrlarda', async () => {
  const { host, tl } = setup();
  const r = await host.gc_applyZooms([[9, 115, 2]], [0]);
  assert.ok(r.ok, r.error); assert.strictEqual(r.applied, 1);
  const item = tl.tracks.video[0][1];
  const lua = item.comps[0].scripts[0];
  assert.match(lua, /tr\.Size\[s \+ 75\] = 1\n/, '9s - 6s = 3s = 75 kadr');
  assert.match(lua, /tr\.Size\[s \+ 84\] = 1\.15/);
  assert.match(lua, /chain\("GCTransform", "Transform"\)/);
});

test('motion presetlari (motion.js) -> Fusion: scale, position (Y teskari), rotation (teskari), fade', async () => {
  const { host, tl } = setup();
  const ctx = await host.gc_getEditContext();
  assert.strictEqual(ctx.source, 'playhead'); assert.strictEqual(ctx.clips[0].start, 6);
  for (const name of Object.keys(M.PRESETS)) {
    const r = await host.gc_applyMotion(M.buildPreset(name, ctx, 115));
    assert.ok(r.ok, name + ': ' + r.error);
  }
  const scripts = tl.tracks.video[0][1].comps[0].scripts.join('\n');
  assert.match(scripts, /tr\.Center\[s \+ \d+\] = \{ 0\.485, 0\.495 \}/, 'Ken Burns: dx=-0.015 -> 0.485, dy=+0.005 -> 0.495');
  assert.match(scripts, /tr\.Angle\[s \+ \d+\] = 3\b/, 'tilt -3 -> Fusion +3');
  assert.match(scripts, /fd\.Gain\[s \+ 0\] = 0\b/, 'fade in qoradan');
  const reset = await host.gc_resetMotion([[0, 6]]);
  assert.strictEqual(reset.reset, 1);
});

test('kesish: pauzalarsiz yangi timeline, manba kadrlari to\'g\'ri, zoom qayta qo\'llanadi', async () => {
  const { host, project } = setup();
  await host.gc_applyZooms([[15, 115, 1]], [0]);
  const r = await host.gc_applyCuts([[2, 3], [7, 8]], [0]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.applied, 2); assert.strictEqual(r.seconds, 2); assert.strictEqual(r.newTimeline, 'C9966 (GeminiCut)');
  const nt = project.current;
  assert.notStrictEqual(nt, project.timelines[0], 'asl timeline saqlandi');
  const v = nt.tracks.video[0].map((it) => [it.src, it.end - it.start]);
  assert.deepStrictEqual(v, [[250, 50], [325, 75], [750, 25], [800, 125], [1300, 200]]);
  assert.strictEqual(r.zoomed, 1, 'zoom yangi timeline\'ga o\'tkazildi');
  const zoomed = nt.tracks.video[0].find((it) => it.comps.length);
  assert.strictEqual(zoomed.src, 1300);
  assert.strictEqual((zoomed.start - START) / FPS, 11, 'oldingi bo\'laklar: 2+3+1+5 = 11s');
  assert.match(zoomed.comps[0].scripts[0], /tr\.Size\[s \+ 50\] = 1\n/, '15s -> yangi 13s, klip boshidan 2s = 50 kadr');
});

test('SRT, kadr eksporti va AI video importi', async () => {
  const { host, tl, project } = setup();
  const dir = tmp();
  const srt = path.join(dir, 'a.srt'); fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nSalom\n');
  let r = await host.gc_importSrt(srt);
  assert.ok(r.ok, r.error); assert.strictEqual(tl.tracks.subtitle[0].length, 1);
  r = await host.gc_exportFrames(path.join(dir, 'f'), [1, 10]);
  assert.strictEqual(r.files.length, 2); assert.strictEqual(tl.ph, START + 8 * FPS, 'playhead tiklandi');
  assert.deepStrictEqual(project.stills.map((s) => s.frame), [START + 25, START + 250]);
  const cap = await host.gc_flowCapture(path.join(dir, 'frame'));
  assert.ok(cap.ok, cap.error); assert.strictEqual(cap.seconds, 8);
  const mp4 = path.join(dir, 'Veo.mp4'); fs.writeFileSync(mp4, 'x');
  r = await host.gc_flowImport(mp4, cap.sequenceID, cap.ticks, '', false);
  assert.ok(r.ok, r.error); assert.strictEqual(r.track, 2); assert.strictEqual(tl.tracks.video[1][0].start, START + 8 * FPS);
  r = await host.gc_flowImport(mp4, 'boshqa', cap.ticks, '', false);
  assert.strictEqual(r.ok, false);
});

test('rang: kliplar, LUT alohida versiyada, qayta qo\'llash va asl holga qaytarish', async () => {
  const r = setup();
  const lutDir = tmp();
  const host = createHost(r.resolve, { fs, path, sleep: () => Promise.resolve(), lutDir });
  let t = await host.gc_colorTargets('playhead');
  assert.ok(t.ok, t.error);
  assert.strictEqual(t.clips.length, 1); assert.strictEqual(t.clips[0].start, 6);
  t = await host.gc_colorTargets('all');
  assert.strictEqual(t.clips.length, 3, 'faqat V1 dagi 3 ta video klip');
  require('../../premiere-gemini-plugin/client/js/color.js');
  const G = globalThis.GCColor;
  const cube = G.buildCube(G.PRESETS.cinema.look, 9, 'test');
  const item = r.tl.tracks.video[0][1];
  let a = await host.gc_applyGrade({ id: item.id, name: 'C9966.MP4', cube, cdl: G.toCDL({}) }, { version: true });
  assert.ok(a.ok, a.error);
  assert.strictEqual(a.mode, 'lut'); assert.strictEqual(a.versioned, true);
  assert.strictEqual(item.cur, 'GeminiCut AI');
  assert.ok(fs.existsSync(item.luts['GeminiCut AI']) && item.luts['GeminiCut AI'].startsWith(lutDir));
  assert.ok(!item.luts['Version 1'], 'asl versiyaga tegilmadi');
  // qayta tahlil: AI versiyasidan asl versiyaga qaytib kadr olinadi, keyin qayta qo'llash
  t = await host.gc_colorTargets('playhead');
  assert.strictEqual(item.cur, 'Version 1');
  a = await host.gc_applyGrade({ id: item.id, name: 'C9966.MP4', cube }, {});
  assert.strictEqual(item.cur, 'GeminiCut AI'); assert.strictEqual(item.versions.length, 2);
  const rv = await host.gc_revertGrade([item.id]);
  assert.strictEqual(rv.reverted, 1);
  assert.strictEqual(item.cur, 'Version 1'); assert.deepStrictEqual(item.versions, ['Version 1']);
  // LUT papkasiga yozib bo'lmasa - CDL zaxirasi
  const blocker = path.join(tmp(), 'fayl'); fs.writeFileSync(blocker, 'x'); // papka o'rnida fayl -> yozib bo'lmaydi
  const host2 = createHost(r.resolve, { fs, path, sleep: () => Promise.resolve(), lutDir: path.join(blocker, 'LUT') });
  a = await host2.gc_applyGrade({ id: item.id, name: 'x', cube, cdl: G.toCDL({ exposure: 0.5 }) }, {});
  assert.ok(a.ok, a.error); assert.strictEqual(a.mode, 'cdl'); assert.strictEqual(item.cdl.NodeIndex, '1');
});

test('animatsion matn: PNG ketma-ketligi yuqori trekka, tahrir uchun topiladi va almashtiriladi', async () => {
  const { host, tl } = setup();
  const dir = path.join(tmp(), 'GeminiCut', 'Matn', 'a');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, 'gc_' + String(i).padStart(4, '0') + '.png'), 'x');
  let r = await host.gc_importSequence(path.join(dir, 'gc_0000.png'), 50, 25, -1, null, 'Matn');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.track, 1, 'V1 band -> V2 (yangi trek)');
  assert.strictEqual(tl.tracks.video[1][0].start, START + 8 * FPS);
  assert.strictEqual(tl.tracks.video[1][0].end - tl.tracks.video[1][0].start, 50);
  // ikkinchi matn ham o'sha vaqtga: V2 band -> V3
  r = await host.gc_importSequence(path.join(dir, 'gc_0000.png'), 50, 25, 8, null, 'Matn 2');
  assert.strictEqual(r.track, 2);
  // playhead ostidagi matn - eng yuqoridagisi
  const at = await host.gc_textAtPlayhead();
  assert.ok(at.ok, at.error); assert.strictEqual(at.track, 2); assert.match(at.path, /Matn/);
  // almashtirish: eski o'chadi, yangisi o'sha joyda
  r = await host.gc_importSequence(path.join(dir, 'gc_0000.png'), 40, 25, -1, { track: at.track, start: at.start }, 'Yangi');
  assert.ok(r.ok, r.error);
  assert.strictEqual(tl.tracks.video[2].length, 1); assert.strictEqual(tl.tracks.video[2][0].end - tl.tracks.video[2][0].start, 40);
  // matnlar rang berishga kirmaydi
  const t = await host.gc_colorTargets('all');
  assert.strictEqual(t.clips.length, 3);
});
