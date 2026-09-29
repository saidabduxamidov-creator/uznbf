/* DaVinci Resolve skript API'ining soddalashtirilgan taqlidi (barcha chaqiruvlar asinxron). */
'use strict';
const fs = require('fs');
const path = require('path');

const FPS = 25, START = 90000; // 01:00:00:00 @ 25 fps
let uid = 0;

class MediaPoolItem {
  constructor(file, frames) { this.file = file; this.frames = frames; this.name = path.basename(file); }
  async GetClipProperty(k) { return k === 'File Path' ? this.file : k === 'Frames' ? String(this.frames) : k === 'Duration' ? '00:00:05:00' : ''; }
  async GetName() { return this.name; }
}

class Comp { constructor() { this.scripts = []; } async Execute(s) { this.scripts.push(s); return true; } }

class TimelineItem {
  constructor(start, end, mpi, sourceStart) { this.start = start; this.end = end; this.mpi = mpi; this.src = sourceStart || 0; this.comps = []; this.id = 'ti' + (uid++); }
  async GetStart() { return this.start; }
  async GetEnd() { return this.end; }
  async GetName() { return this.mpi ? this.mpi.name : 'item'; }
  async GetMediaPoolItem() { return this.mpi; }
  async GetLeftOffset() { return this.src; }
  async GetSourceStartFrame() { return this.src; }
  async GetUniqueId() { return this.id; }
  async GetFusionCompCount() { return this.comps.length; }
  async GetFusionCompByIndex(i) { return this.comps[i - 1]; }
  async AddFusionComp() { const c = new Comp(); this.comps.push(c); return c; }
}

class Timeline {
  constructor(name) {
    this.name = name; this.id = 'tl' + (uid++); this.ph = START;
    this.tracks = { video: [[]], audio: [[]], subtitle: [] }; this.enabled = { video: [true], audio: [true] }; this.locked = { video: [false], audio: [false] };
  }
  async GetName() { return this.name; }
  async GetUniqueId() { return this.id; }
  async GetSetting(k) { return { timelineFrameRate: String(FPS), timelineResolutionWidth: '1080', timelineResolutionHeight: '1920' }[k] || ''; }
  async GetStartFrame() { return START; }
  async GetEndFrame() { let e = START + 30 * FPS; Object.values(this.tracks).flat(2).forEach((it) => { if (it.end > e) e = it.end; }); return e; }
  async GetStartTimecode() { return '01:00:00:00'; }
  async GetTrackCount(t) { return this.tracks[t].length; }
  async GetTrackName(t, i) { return `${t === 'audio' ? 'Audio' : 'Video'} ${i}`; }
  async GetItemListInTrack(t, i) { return (this.tracks[t][i - 1] || []).slice().sort((a, b) => a.start - b.start); }
  async GetIsTrackEnabled(t, i) { return this.enabled[t][i - 1] !== false; }
  async SetTrackEnable(t, i, v) { this.enabled[t][i - 1] = !!v; return true; }
  async GetIsTrackLocked(t, i) { return !!this.locked[t][i - 1]; }
  async AddTrack(t) { this.tracks[t].push([]); if (this.enabled[t]) { this.enabled[t].push(true); this.locked[t].push(false); } return true; }
  async GetCurrentTimecode() { return tc(this.ph); }
  async SetCurrentTimecode(s) { const [h, m, sec, f] = s.split(/[:;]/).map(Number); this.ph = ((h * 60 + m) * 60 + sec) * FPS + f; return true; }
  async GetMarkInOut() { return {}; }
}
function tc(fr) { const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(fr / (FPS * 3600)))}:${p(Math.floor(fr / (FPS * 60)) % 60)}:${p(Math.floor(fr / FPS) % 60)}:${p(fr % FPS)}`; }

class Folder {
  constructor(name) { this.name = name; this.subs = []; this.clips = []; }
  async GetName() { return this.name; }
  async GetSubFolderList() { return this.subs; }
  async GetClipList() { return this.clips; }
}

function makeResolve() {
  const root = new Folder('Master');
  const tl = new Timeline('C9966');
  const project = { timelines: [tl], current: tl, render: [], renderSettings: null, stills: [] };
  let current = root;
  const mediaPool = {
    async GetRootFolder() { return root; },
    async AddSubFolder(parent, name) { const f = new Folder(name); parent.subs.push(f); return f; },
    async SetCurrentFolder(f) { current = f; return true; },
    async ImportMedia(paths) {
      return paths.map((p) => { const m = new MediaPoolItem(p, /\.mp4$/i.test(p) ? 125 : /\.srt$/i.test(p) ? 250 : 20); current.clips.push(m); return m; });
    },
    async CreateEmptyTimeline(name) { if (project.timelines.some((t) => t.name === name)) return null; const t = new Timeline(name); project.timelines.push(t); return t; },
    async AppendToTimeline(infos) {
      const t = project.current, out = [];
      for (const ci of infos) {
        const len = ci.endFrame != null ? ci.endFrame - ci.startFrame + 1 : 250;
        if (/\.srt$/i.test(ci.mediaPoolItem.file)) { const it = new TimelineItem(ci.recordFrame, ci.recordFrame + len, ci.mediaPoolItem); t.tracks.subtitle[(ci.trackIndex || 1) - 1].push(it); out.push(it); continue; }
        const types = ci.mediaType === 1 ? ['video'] : ci.mediaType === 2 ? ['audio'] : ['video', 'audio'];
        for (const ty of types) {
          const ti = (ci.trackIndex || 1) - 1;
          let rec = ci.recordFrame;
          if (rec == null) { rec = START; t.tracks[ty][ti].forEach((it) => { if (it.end > rec) rec = it.end; }); }
          const it = new TimelineItem(rec, rec + len, ci.mediaPoolItem, ci.startFrame);
          t.tracks[ty][ti].push(it); out.push(it);
        }
      }
      return out;
    },
  };
  const proj = {
    async GetCurrentTimeline() { return project.current; },
    async SetCurrentTimeline(t) { project.current = t; return true; },
    async GetMediaPool() { return mediaPool; },
    async GetSetting() { return String(FPS); },
    async GetRenderCodecs() { return { 'Linear PCM': 'LinearPCM' }; },
    async SetCurrentRenderFormatAndCodec(f, c) { project.format = [f, c]; return f === 'wav' && c === 'LinearPCM'; },
    async SetCurrentRenderMode() { return true; },
    async SetRenderSettings(s) { project.renderSettings = s; return true; },
    async AddRenderJob() { return 'job1'; },
    async StartRendering() {
      const s = project.renderSettings;
      project.render.push({ enabled: project.current.enabled.audio.slice(), settings: s });
      fs.writeFileSync(path.join(s.TargetDir, s.CustomName + '.wav'), 'RIFF');
      return true;
    },
    async IsRenderingInProgress() { return false; },
    async GetRenderJobStatus() { return { JobStatus: 'Complete' }; },
    async DeleteRenderJob() { return true; },
    async ExportCurrentFrameAsStill(p) { project.stills.push({ path: p, frame: project.current.ph }); fs.writeFileSync(p, 'PNG'); return true; },
  };
  const resolve = {
    async GetProjectManager() { return { async GetCurrentProject() { return proj; } }; },
    async GetVersionString() { return '20.1'; },
    async GetCurrentPage() { return 'edit'; },
    async OpenPage() { return true; },
  };
  return { resolve, project, tl, root, TimelineItem, MediaPoolItem, FPS, START };
}

module.exports = { makeResolve, TimelineItem, MediaPoolItem, FPS, START };
