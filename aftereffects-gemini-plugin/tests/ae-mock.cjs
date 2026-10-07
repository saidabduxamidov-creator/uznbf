/* After Effects ExtendScript DOM'ining soddalashtirilgan taqlidi (faqat GeminiCut ishlatadigan qismlari). */
'use strict';
const fs = require('fs');
const path = require('path');

let uid = 1;

class Property {
  constructor(layer, value, name) { this.layer = layer; this.v = value; this.keys = []; this.dimensionsSeparated = false; this.expression = ''; this.name = this.matchName = name || ''; }
  get value() { return this.v; }
  get numKeys() { return this.keys.length; }
  keyTime(k) { return this.keys[k - 1].t + this.layer.startTime; }
  keyValue(k) { return this.keys[k - 1].v; }
  removeKey(k) { this.keys.splice(k - 1, 1); }
  setValue(v) { if (this.keys.length) throw new Error('keyframe bor - setValue ishlamaydi'); this.v = v; }
  setValueAtTime(t, v) {
    const lt = t - this.layer.startTime;
    const i = this.keys.findIndex((k) => Math.abs(k.t - lt) < 1e-6);
    if (i >= 0) this.keys[i].v = v; else { this.keys.push({ t: lt, v }); this.keys.sort((a, b) => a.t - b.t); }
  }
  valueAtTime(t) {
    if (!this.keys.length) return this.v;
    const lt = t - this.layer.startTime, K = this.keys;
    if (lt <= K[0].t) return K[0].v;
    if (lt >= K[K.length - 1].t) return K[K.length - 1].v;
    for (let i = 1; i < K.length; i++) if (lt <= K[i].t) {
      const f = (lt - K[i - 1].t) / (K[i].t - K[i - 1].t), a = K[i - 1].v, b = K[i].v;
      return Array.isArray(a) ? a.map((x, j) => x + (b[j] - x) * f) : a + (b - a) * f;
    }
    return this.v;
  }
  property() { return null; }
}

class Group {
  constructor(map) { this.map = map; }
  property(name) { return this.map[name] || null; }
}

/* Effektlar / shape kontentlari: addProperty() bilan o'sadigan guruh; noma'lum xossa so'ralsa yaratiladi */
class DynGroup {
  constructor(layer, matchName) { this.layer = layer; this.matchName = this.name = matchName; this.children = []; }
  get numProperties() { return this.children.length; }
  addProperty(mn) { const g = new DynGroup(this.layer, mn); if (mn === 'ADBE Vector Group') g.children.push(new DynGroup(this.layer, 'ADBE Vectors Group')); this.children.push(g); return g; }
  property(k) {
    if (typeof k === 'number') return this.children[k - 1] || null;
    let c = this.children.find((x) => x.matchName === k || x.name === k);
    if (!c) { c = new Property(this.layer, 0, k); this.children.push(c); }
    return c;
  }
}

class TextDocument { constructor(text) { this.text = text; this.fontSize = 36; this.fillColor = [1, 1, 1]; } }

class Layer {
  constructor(comp, source, opts = {}) {
    this.comp = comp; this.source = source || null; this.name = opts.name || (source ? source.name : 'Layer');
    this.startTime = opts.start || 0; this._in = this.startTime; this._out = this.startTime + (opts.duration != null ? opts.duration : (source ? source.duration : comp.duration));
    this.stretch = 100; this.locked = false; this.audioEnabled = true; this.enabled = true;
    this.hasVideo = opts.hasVideo != null ? opts.hasVideo : !!(source && source.hasVideo);
    this.hasAudio = opts.hasAudio != null ? opts.hasAudio : !!(source && source.hasAudio);
    this.id = uid++; this.comment = ''; this.parent = null; this.threeDLayer = false;
    this.effects = new DynGroup(this, 'ADBE Effect Parade');
    const W = comp.width, H = comp.height;
    this.transform = new Group({
      'ADBE Scale': new Property(this, [100, 100, 100]),
      'ADBE Position': new Property(this, [W / 2, H / 2, 0]),
      'ADBE Rotate Z': new Property(this, 0),
      'ADBE Rotate Y': new Property(this, 0),
      'ADBE Rotate X': new Property(this, 0),
      'ADBE Opacity': new Property(this, 100),
      'ADBE Anchor Point': new Property(this, [W / 2, H / 2, 0]),
    });
  }
  get index() { return this.comp._layers.indexOf(this) + 1; }
  get inPoint() { return this._in; }
  set inPoint(v) { this._in = v; }
  get outPoint() { return this._out; }
  set outPoint(v) { this._out = v; }
  property(name) { return name === 'ADBE Transform Group' ? this.transform : name === 'ADBE Effect Parade' ? this.effects : null; }
  setParentWithJump(p) { this.parent = p; }
  get selected() { return !!this._sel; }
  set selected(v) { this._sel = !!v; }
  remove() { this.comp._layers.splice(this.comp._layers.indexOf(this), 1); }
  duplicate() {
    const d = Object.create(Object.getPrototypeOf(this));
    Object.assign(d, this, { id: uid++ });
    const copyGroup = (g) => new Group(Object.fromEntries(Object.entries(g.map).map(([k, p]) => { const q = new Property(d, JSON.parse(JSON.stringify(p.v))); q.keys = JSON.parse(JSON.stringify(p.keys)); return [k, q]; })));
    d.transform = copyGroup(this.transform);
    if (this.textGroup) { d.textGroup = new Group({ 'ADBE Text Document': new Property(d, Object.assign(new TextDocument(''), this.textGroup.map['ADBE Text Document'].v)) }); }
    this.comp._layers.splice(this.comp._layers.indexOf(this), 0, d); // AE: nusxa asl qatlamdan yuqorida
    return d;
  }
  moveBefore(L) { this.remove(); this.comp._layers.splice(this.comp._layers.indexOf(L), 0, this); }
  moveAfter(L) { this.remove(); this.comp._layers.splice(this.comp._layers.indexOf(L) + 1, 0, this); }
  moveToEnd() { this.remove(); this.comp._layers.push(this); }
  set startTime(v) { const d = v - (this._st || 0); this._st = v; if (this._in != null) { this._in += d; this._out += d; } }
  get startTime() { return this._st || 0; }
}
class AVLayer extends Layer {}
class TextLayer extends AVLayer {
  constructor(comp, text) {
    super(comp, null, { name: text, hasVideo: true, hasAudio: false, duration: comp.duration });
    this.textGroup = new Group({ 'ADBE Text Document': new Property(this, new TextDocument(text)) });
  }
  property(name) { return name === 'ADBE Text Properties' ? this.textGroup : super.property(name); }
}
class ShapeLayer extends AVLayer {
  constructor(comp) { super(comp, null, { name: 'Shape Layer', hasVideo: true, hasAudio: false, duration: comp.duration }); this.contents = new DynGroup(this, 'ADBE Root Vectors Group'); }
  property(name) { return name === 'ADBE Root Vectors Group' ? this.contents : super.property(name); }
}

class FolderItem { constructor(name) { this.name = name; this.id = uid++; this.parentFolder = null; } }
class FootageItem {
  constructor(file, opts = {}) {
    this.file = file; this.name = path.basename(file.fsName); this.id = uid++; this.parentFolder = null;
    this.duration = opts.duration != null ? opts.duration : 5; this.hasVideo = opts.hasVideo !== false; this.hasAudio = !!opts.hasAudio;
    this.mainSource = { conformFrameRate: 0, alphaMode: 0 };
    this.frames = opts.frames || 0; this.width = opts.width || 1400; this.height = opts.height || 700;
  }
}

class CompItem {
  constructor(name, opts = {}) {
    this.name = name; this.id = uid++; this.width = opts.width || 1920; this.height = opts.height || 1080;
    this.frameRate = opts.fps || 25; this.duration = opts.duration || 30; this.time = 0;
    this.workAreaStart = 0; this.workAreaDuration = this.duration; this._layers = []; this.frames = [];
    const comp = this;
    this.layers = {
      add(item) { const L = new AVLayer(comp, item); comp._layers.unshift(L); return L; },
      addText(text) { const L = new TextLayer(comp, text); comp._layers.unshift(L); return L; },
      addShape() { const L = new ShapeLayer(comp); comp._layers.unshift(L); return L; },
      addNull(d) { const L = new AVLayer(comp, null, { name: 'Null', hasVideo: false, hasAudio: false, duration: d || comp.duration }); L.isNull = true; comp._layers.unshift(L); return L; },
    };
  }
  get frameDuration() { return 1 / this.frameRate; }
  get numLayers() { return this._layers.length; }
  layer(i) { return this._layers[i - 1]; }
  get selectedLayers() { return this._layers.filter((l) => l._sel); }
  saveFrameToPng(t, file) { fs.writeFileSync(file.fsName, 'PNG'); this.frames.push(t); }
}

function makeAE(opts = {}) {
  function File(p) {
    this.fsName = path.resolve(String(p)); this.name = path.basename(this.fsName); this.encoding = 'UTF-8';
    Object.defineProperty(this, 'exists', { get: () => fs.existsSync(this.fsName) && fs.statSync(this.fsName).isFile() });
    this.open = () => fs.existsSync(this.fsName); this.read = () => fs.readFileSync(this.fsName, 'utf8'); this.close = () => true;
    this.remove = () => { fs.rmSync(this.fsName, { force: true }); return true; };
    this.parent = { exists: fs.existsSync(path.dirname(this.fsName)) };
  }
  function Folder(p) { this.fsName = path.resolve(String(p)); }
  function ImportOptions(file) { this.file = file; this.sequence = false; this.forceAlphabetical = false; }

  const items = [];
  const rqItems = [];
  const project = {
    activeItem: null, file: null, rendered: [],
    get numItems() { return items.length; },
    item(i) { return items[i - 1]; },
    itemByID(id) { return items.find((x) => x.id === id) || null; },
    items: { addFolder(name) { const f = new FolderItem(name); items.push(f); return f; } },
    importFile(io) {
      const f = io.file;
      if (!f.exists) throw new Error('topilmadi');
      let it;
      if (io.sequence) {
        const dir = path.dirname(f.fsName);
        const n = fs.readdirSync(dir).filter((x) => /^gc_\d+\.png$/.test(x)).length;
        it = new FootageItem(f, { duration: n / 25, frames: n });
        Object.defineProperty(it.mainSource, 'conformFrameRate', { set(v) { this._fr = v; it.duration = it.frames / v; }, get() { return this._fr || 0; } });
      } else {
        const audio = /\.(wav|mp3|aif)$/i.test(f.fsName);
        it = new FootageItem(f, { duration: audio ? 0.8 : 5, hasVideo: !audio, hasAudio: audio || /\.mp4$/i.test(f.fsName) });
      }
      items.push(it);
      return it;
    },
    renderQueue: {
      get numItems() { return rqItems.length; },
      item(i) { return rqItems[i - 1]; },
      items: {
        add(comp) {
          const om = {
            settings: null, file: null, template: null,
            setSettings(s) { if (opts.noWav && s.Format === 'WAV') throw new Error('WAV yo\'q'); this.settings = Object.assign({}, this.settings || {}, s); },
            applyTemplate(t) { if (t !== 'AIFF 48kHz') throw new Error('shablon yo\'q'); this.template = t; },
          };
          const it = { comp, render: true, timeSpanStart: comp.workAreaStart, timeSpanDuration: comp.workAreaDuration, outputModule: () => om, remove() { rqItems.splice(rqItems.indexOf(it), 1); }, om };
          rqItems.push(it);
          return it;
        },
      },
      render() {
        for (const it of rqItems) {
          if (!it.render) continue;
          const c = it.comp;
          project.rendered.push({ audio: c._layers.filter((l) => l.hasAudio).map((l) => [l.name, l.audioEnabled]), span: [it.timeSpanStart, it.timeSpanDuration],
            format: it.om.settings ? it.om.settings.Format : it.om.template, file: it.om.file && it.om.file.fsName });
          if (it.om.file) fs.writeFileSync(it.om.file.fsName, it.om.template ? 'FORM' : 'RIFF');
        }
      },
    },
  };
  const app = { version: '25.2', project, undo: [], beginUndoGroup(n) { this.undo.push(n); }, endUndoGroup() {} };
  const $ = { sleep() {} };
  const comp = new CompItem(opts.name || 'Comp 1', opts);
  items.push(comp);
  project.activeItem = comp;
  return { app, $, comp, File, Folder, ImportOptions, CompItem, FootageItem, FolderItem, AVLayer, TextLayer, ShapeLayer, TextDocument, items,
    footage: (p, o) => { const it = new FootageItem(new File(p), o); items.push(it); return it; } };
}

function loadHost(env) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.jsx'), 'utf8');
  const names = [...src.matchAll(/^function (gc_\w+)/gm)].map((m) => m[1]);
  const globals = ['app', '$', 'File', 'Folder', 'ImportOptions', 'CompItem', 'FootageItem', 'FolderItem', 'AVLayer', 'TextLayer', 'ShapeLayer', 'ParagraphJustification', 'AlphaMode'];
  const fn = new Function(...globals, src + '\nreturn {' + names.join(',') + '};');
  const api = fn(env.app, env.$, env.File, env.Folder, env.ImportOptions, env.CompItem, env.FootageItem, env.FolderItem, env.AVLayer, env.TextLayer, env.ShapeLayer,
    { CENTER_JUSTIFY: 7413, LEFT_JUSTIFY: 7414, RIGHT_JUSTIFY: 7415 }, { STRAIGHT: 1 });
  const call = (name, ...args) => JSON.parse(api[name](...JSON.parse(JSON.stringify(args))));
  return { api, call };
}

module.exports = { makeAE, loadHost };
