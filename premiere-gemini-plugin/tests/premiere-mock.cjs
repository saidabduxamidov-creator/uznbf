/* Premiere Pro ExtendScript DOM'ining soddalashtirilgan taqlidi - host.jsx'ni Node'da sinash uchun. */
'use strict';
const fs = require('fs');
const path = require('path');

const TICKS = 254016000000;
function Time() { this._s = 0; }
Object.defineProperty(Time.prototype, 'seconds', { get() { return this._s; }, set(v) { this._s = v; } });
Object.defineProperty(Time.prototype, 'ticks', { get() { return String(Math.round(this._s * TICKS)); }, set(v) { this._s = Number(v) / TICKS; } });
Time.prototype.getFormatted = function () { return 'TC' + this._s.toFixed(4); };
const T = (s) => { const t = new Time(); t.seconds = s; return t; };
const secOf = (t) => (t instanceof Time ? t.seconds : Number(t));

class Param {
  constructor(name, value) { this.displayName = name; this.value = value; this.tv = false; this.keys = []; this.log = []; }
  areKeyframesSupported() { return true; }
  isTimeVarying() { return this.tv; }
  setTimeVarying(v) { this.tv = !!v; if (!v) this.keys = []; }
  getValue() { return this.value; }
  setValue(v) { this.value = v; }
  getKeys() { return this.keys.length ? this.keys.map(k => T(k.t)) : null; }
  addKey(t) { if (!(t instanceof Time)) throw new Error('addKey expects Time'); if (!this.tv) throw new Error('not time varying'); if (!this.keys.some(k => Math.abs(k.t - t.seconds) < 1e-6)) this.keys.push({ t: t.seconds, v: this.value }); this.keys.sort((a, b) => a.t - b.t); }
  setValueAtKey(t, v) { const k = this.keys.find(k => Math.abs(k.t - secOf(t)) < 1e-6); if (!k) throw new Error('no key at ' + secOf(t)); k.v = v; }
  removeKeyRange(a, b) { this.keys = this.keys.filter(k => k.t < secOf(a) || k.t > secOf(b)); }
  getValueAtTime(t) {
    const s = secOf(t), k = this.keys;
    if (!k.length) return this.value;
    if (s <= k[0].t) return k[0].v; if (s >= k[k.length - 1].t) return k[k.length - 1].v;
    for (let i = 1; i < k.length; i++) if (s <= k[i].t) { const f = (s - k[i - 1].t) / (k[i].t - k[i - 1].t); const a = k[i - 1].v, b = k[i].v; return Array.isArray(a) ? [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] : a + (b - a) * f; }
  }
}

let uid = 0;
function makeItem(track, start, end, inPoint, mediaPath, opts = {}) {
  const motion = { matchName: 'AE.ADBE Motion', displayName: 'Motion', props: [new Param('Position', [0.5, 0.5]), new Param('Scale', opts.scale || 100), new Param('Scale Width', 100), new Param('Uniform Scale', true), new Param('Rotation', 0), new Param('Anchor Point', [0.5, 0.5])] };
  const opacity = { matchName: 'AE.ADBE Opacity', displayName: 'Opacity', props: [new Param('Opacity', 100)] };
  const comp = (c) => ({ matchName: c.matchName, displayName: c.displayName, properties: Object.assign([], c.props, { numItems: c.props.length }) });
  const item = {
    nodeId: 'n' + (uid++), name: path.basename(mediaPath), start: T(start), end: T(end), inPoint: T(inPoint), outPoint: T(inPoint + end - start),
    selected: !!opts.selected, speed: opts.speed || 1,
    isSelected() { return this.selected; }, getSpeed() { return this.speed; },
    projectItem: { getMediaPath: () => mediaPath, name: path.basename(mediaPath) },
    components: Object.assign([comp(opacity), comp(motion)], { numItems: 2 }),
    motion, opacity,
    remove(ripple) {
      track.items.splice(track.items.indexOf(this), 1);
      if (ripple) { const d = this.end.seconds - this.start.seconds; track.items.forEach(x => { if (x.start.seconds >= this.end.seconds - 1e-6) { x.start = T(x.start.seconds - d); x.end = T(x.end.seconds - d); } }); }
    },
  };
  return item;
}

function makeTrack(kind, index, opts = {}) {
  const tr = { kind, index, name: opts.name || (kind === 'V' ? 'Video ' : 'Audio ') + (index + 1), items: [], muted: 0, locked: !!opts.locked,
    isMuted() { return this.muted; }, setMute(m) { this.muted = m; }, isLocked() { return this.locked; },
    overwriteClip(projectItem, ticks) { const s = Number(ticks) / TICKS; tr.items.push(makeItem(tr, s, s + (projectItem.duration || 1), 0, projectItem.getMediaPath())); tr.items.sort((a, b) => a.start.seconds - b.start.seconds); } };
  tr.clips = new Proxy({}, { get: (o, k) => (k === 'numItems' ? tr.items.length : tr.items[k]) });
  return tr;
}

function collection(arr) { return new Proxy(arr, { get: (o, k) => (k === 'numTracks' ? o.length : o[k]) }); }

function makeEnv({ video, audio, duration, fps = 25, width = 1080, height = 1920, playhead = 0, appPath = '/tmp' }) {
  const project = { root: [], path: '/proj/test.prproj' };
  const findOrMake = (p) => {
    let it = project.root.find(x => x.getMediaPath() === p);
    if (!it) { it = { name: path.basename(p), type: 1, duration: /sfx|\.wav$/i.test(p) ? 0.8 : 5, getMediaPath: () => p,
      getInPoint: () => T(0), getOutPoint() { return T(this.duration); }, createSubClip() { return this; } }; project.root.push(it); }
    return it;
  };
  const seq = {
    name: 'Seq', sequenceID: 'seq-1', end: String(duration * TICKS), frameSizeHorizontal: width, frameSizeVertical: height,
    videoTracks: collection(video), audioTracks: collection(audio), _ph: playhead,
    getSettings: () => ({ videoFrameRate: T(1 / fps), videoDisplayFormat: 1 }),
    getInPointAsTime: () => T(0), getOutPointAsTime: () => T(duration),
    getPlayerPosition() { return T(this._ph); }, setPlayerPosition(t) { this._ph = Number(t) / TICKS; },
    createCaptionTrack: () => true,
    exportAsMediaDirect(p) { fs.writeFileSync(p, 'RIFF'); return 'No Error'; },
  };
  const qeSeq = {
    CTI: { get timecode() { return 'TC' + seq._ph.toFixed(4); } },
    exportFramePNG(tc, p) { fs.writeFileSync(p + '.png', 'PNG'); },
    addTracks(v, vi, a) { for (let i = 0; i < (a || 0); i++) audio.push(makeTrack('A', audio.length)); for (let i = 0; i < (v || 0); i++) video.push(makeTrack('V', video.length)); },
    getVideoTrackAt: (i) => razor(video[i]), getAudioTrackAt: (i) => razor(audio[i]),
  };
  function razor(tr) { return { razor(tc) { const s = parseFloat(tc.slice(2)); const it = tr.items.find(x => x.start.seconds < s - 1e-6 && x.end.seconds > s + 1e-6); if (!it) return;
    const b = makeItem(tr, s, it.end.seconds, it.inPoint.seconds + (s - it.start.seconds), it.projectItem.getMediaPath()); it.end = T(s); tr.items.splice(tr.items.indexOf(it) + 1, 0, b); } }; }
  const rootItem = { get children() { return Object.assign(project.root.slice(), { numItems: project.root.length }); } };
  const app = { version: '25.1.0', path: appPath, enableQE() {}, project: { activeSequence: seq, rootItem, path: project.path, getInsertionBin: () => rootItem,
    importFiles(paths) { paths.forEach(findOrMake); return true; } } };
  const qe = { project: { getActiveSequence: () => qeSeq } };
  function File(p) { this.fsName = p; this.name = encodeURI(path.basename(p)); Object.defineProperty(this, 'exists', { get: () => fs.existsSync(p) }); this.parent = new Folder(path.dirname(p)); }
  function Folder(p) { this.fsName = p; this.name = encodeURI(path.basename(p)); Object.defineProperty(this, 'exists', { get: () => fs.existsSync(p) && fs.statSync(p).isDirectory() }); }
  Folder.prototype.getFiles = function (mask) { if (!this.exists) return []; return fs.readdirSync(this.fsName).filter(n => !mask || new RegExp('^' + mask.replace('*', '.*') + '$').test(n)).map(n => { const p = path.join(this.fsName, n); return fs.statSync(p).isDirectory() ? new Folder(p) : new File(p); }); };
  Object.defineProperty(Folder.prototype, 'parent', { get() { return new Folder(path.dirname(this.fsName)); } });
  return { app, qe, seq, Time, File, Folder, Sequence: { CAPTION_FORMAT_SUBTITLE: 6 }, ProjectItemType: { BIN: 2 } };
}

function loadHost(env) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.jsx'), 'utf8');
  const names = [...src.matchAll(/^function (gc_\w+)/gm)].map(m => m[1]);
  const fn = new Function('app', 'qe', 'Time', 'File', 'Folder', 'Sequence', 'ProjectItemType', src + '\nreturn {' + names.join(',') + '};');
  const api = fn(env.app, env.qe, env.Time, env.File, env.Folder, env.Sequence, env.ProjectItemType);
  const call = (name, ...args) => JSON.parse(api[name](...JSON.parse(JSON.stringify(args))));
  return { api, call };
}

module.exports = { makeEnv, makeItem, makeTrack, loadHost, T, TICKS };
