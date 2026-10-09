/*
 * GeminiCut - After Effects ExtendScript tomoni (host).
 *
 * Panel (client/) Premiere versiyasi bilan bir xil; bu fayl bir xil gc_* funksiyalarni
 * After Effects tilida bajaradi:
 *   "timeline"  -> faol kompozitsiya (CompItem), "playhead" -> comp.time
 *   "trek"      -> qatlam (layer); trek indeksi = layer.index - 1
 *   "In/Out"    -> Work Area
 *   audio       -> Render Queue (WAV, faqat audio), kadrlar -> comp.saveFrameToPng
 *   subtitr     -> har bir satr alohida matn qatlami
 * Fayl faqat ASCII (boshqa belgilar \uXXXX) - Windows tizim kodlashi qanday bo'lmasin o'qiladi.
 * Barcha vaqtlar - kompozitsiya soniyalarida.
 */

var GC_VERSION = "4.7.0";
var GC_LAST_COMP_ID = 0;

/* ======================= yordamchilar ======================= */

function gc_quote(s) {
    s = String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        var code = s.charCodeAt(i);
        if (ch === "\\") out += "\\\\";
        else if (ch === "\"") out += "\\\"";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (code < 32) out += " ";
        else out += ch;
    }
    return "\"" + out + "\"";
}

function gc_json(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return gc_quote(v);
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(gc_json(v[i]));
        return "[" + a.join(",") + "]";
    }
    var parts = [];
    for (var k in v) {
        if (v.hasOwnProperty(k)) parts.push(gc_quote(k) + ":" + gc_json(v[k]));
    }
    return "{" + parts.join(",") + "}";
}

function gc_ok(data) {
    data = data || {};
    data.ok = true;
    return gc_json(data);
}

function gc_fail(msg) {
    return gc_json({ ok: false, error: String(msg) });
}

function gc_normPath(p) {
    return String(p).replace(/\\/g, "/").toLowerCase();
}

function gc_inArray(arr, v) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true;
    return false;
}

/* Faol kompozitsiya; Project paneli tanlangan bo'lsa - oxirgi ishlatilgan kompozitsiya */
function gc_comp() {
    var it = app.project.activeItem;
    if (it && it instanceof CompItem) { GC_LAST_COMP_ID = it.id; return it; }
    if (GC_LAST_COMP_ID) {
        try {
            var last = app.project.itemByID(GC_LAST_COMP_ID);
            if (last && last instanceof CompItem) return last;
        } catch (e) {}
    }
    throw new Error("Kompozitsiya ochilmagan. After Effects'da kompozitsiyani oching (Timeline paneli).");
}

function gc_fd(comp) { return comp.frameDuration || 1 / (comp.frameRate || 25); }

function gc_snap(sec, fd) { return Math.round(sec / fd) * fd; }

function gc_layerPath(layer) {
    try { if (layer.source && layer.source.file) return layer.source.file.fsName; } catch (e) {}
    return "";
}

function gc_isAV(layer) {
    try { return layer instanceof AVLayer || layer instanceof TextLayer || layer instanceof ShapeLayer; } catch (e) { return false; }
}

function gc_hasVideo(layer) {
    try { return gc_isAV(layer) && layer.hasVideo; } catch (e) { return false; }
}

function gc_hasAudio(layer) {
    try { return layer instanceof AVLayer && layer.hasAudio; } catch (e) { return false; }
}

/* Vaqtda faol (ko'rinadigan) eng yuqori video qatlam */
function gc_layerAt(comp, sec, filter) {
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (!gc_hasVideo(L)) continue;
        if (L.inPoint <= sec + 1e-4 && L.outPoint > sec + 1e-4 && (!filter || filter(L))) return L;
    }
    return null;
}

/* Qatlamni "trek" indeksi va boshlanish vaqti bo'yicha topadi */
function gc_layerByStart(comp, track, start) {
    var fd = gc_fd(comp);
    if (track >= 0 && track < comp.numLayers) {
        var L = comp.layer(track + 1);
        if (Math.abs(L.inPoint - start) <= fd / 2 + 1e-4) return L;
    }
    for (var i = 1; i <= comp.numLayers; i++) {
        var M = comp.layer(i);
        if (gc_hasVideo(M) && Math.abs(M.inPoint - start) <= fd / 2 + 1e-4) return M;
    }
    return null;
}

/* GeminiCut papkasi (Project panelida) */
function gc_folder(name) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof FolderItem && it.name === name) return it;
    }
    return app.project.items.addFolder(name);
}

function gc_findFootage(path) {
    var target = gc_normPath(new File(path).fsName);
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        try { if (it instanceof FootageItem && it.file && gc_normPath(it.file.fsName) === target) return it; } catch (e) {}
    }
    return null;
}

function gc_importOnce(path, folderName) {
    var f = new File(path);
    if (!f.exists) throw new Error("Fayl topilmadi: " + path);
    var item = gc_findFootage(path);
    if (!item) {
        item = app.project.importFile(new ImportOptions(f));
        if (!item) throw new Error("Import qilinmadi: " + f.name);
        if (folderName) { try { item.parentFolder = gc_folder(folderName); } catch (e) {} }
    }
    return item;
}

function gc_undo(name, fn) {
    app.beginUndoGroup(name);
    try { return fn(); } finally { app.endUndoGroup(); }
}

/* ======================= kompozitsiya ma'lumoti ======================= */

function gc_ping() {
    return gc_ok({ version: GC_VERSION, host: "After Effects " + (app.version || "") });
}

function gc_getSequenceInfo() {
    try {
        var comp = gc_comp();
        var audio = [], sig = [], clips = 0, videoLayers = 0;
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            sig.push(i + ":" + L.name + ":" + L.inPoint.toFixed(3) + "-" + L.outPoint.toFixed(3));
            if (gc_hasVideo(L)) videoLayers++;
            if (gc_hasAudio(L)) {
                clips++;
                audio.push({ index: i - 1, name: L.name, clips: 1, muted: !L.audioEnabled, locked: !!L.locked,
                    coverage: comp.duration > 0 ? Math.max(0, Math.min(L.outPoint, comp.duration) - Math.max(L.inPoint, 0)) / comp.duration : 0 });
            } else if (gc_hasVideo(L)) clips++;
        }
        var ws = comp.workAreaStart, we = comp.workAreaStart + comp.workAreaDuration;
        return gc_ok({
            id: String(comp.id), name: comp.name, duration: comp.duration,
            inPoint: ws, outPoint: we, hasRange: ws > 0.01 || we < comp.duration - 0.05,
            fps: comp.frameRate, width: comp.width, height: comp.height, playhead: comp.time,
            audioTracks: audio, videoTracks: videoLayers, clipCount: clips, signature: sig.join("|")
        });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

function gc_setKeyBase(mode) { return gc_ok({ mode: "comp" }); }

function gc_setPlayhead(sec) {
    try { var comp = gc_comp(); comp.time = Math.max(0, Math.min(comp.duration, sec)); return gc_ok({}); }
    catch (e) { return gc_fail(e.message || e.toString()); }
}

/* ======================= audio eksport (Render Queue) ======================= */

function gc_findAudioPreset() {
    return gc_ok({ path: "ae-render", scanned: 0 });
}

/* Chiqish modulini audio-faylga sozlaydi: avval WAV, bo'lmasa "AIFF 48kHz" shabloni */
function gc_setupAudioOM(om, outPath) {
    var tries = [
        function () { om.setSettings({ "Format": "WAV", "Video Output": false, "Output Audio": "On", "Audio Sample Rate": 48000, "Audio Bit Depth": "16 Bit", "Audio Channels": "Stereo" }); return "wav"; },
        function () { om.setSettings({ "Format": "WAV" }); return "wav"; },
        function () { om.applyTemplate("AIFF 48kHz"); return "aiff"; },
        function () { om.applyTemplate("GeminiCut WAV"); return "wav"; }
    ];
    for (var i = 0; i < tries.length; i++) {
        try {
            var kind = tries[i]();
            om.file = new File(outPath.replace(/\.[^.\/\\]+$/, "") + (kind === "aiff" ? ".aif" : ".wav"));
            return kind;
        } catch (e) {}
    }
    return "";
}

function gc_exportAudio(outPath, presetPath, tracks, useInOut) {
    var comp;
    try { comp = gc_comp(); } catch (e0) { return gc_fail(e0.message); }
    var rq = app.project.renderQueue;
    var savedAudio = [], savedRender = [], rqi = null;
    try {
        // faqat tanlangan nutq qatlamlari eshitilsin
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (!gc_hasAudio(L)) continue;
            savedAudio.push([i, L.audioEnabled]);
            try { L.audioEnabled = gc_inArray(tracks, i - 1); } catch (eA) {}
        }
        // navbatdagi boshqa ishlar render qilinmasin
        for (var q = 1; q <= rq.numItems; q++) {
            try { if (rq.item(q).render) { savedRender.push(q); rq.item(q).render = false; } } catch (eR) {}
        }
        rqi = rq.items.add(comp);
        var start = useInOut ? comp.workAreaStart : 0;
        var dur = useInOut ? comp.workAreaDuration : comp.duration;
        try { rqi.timeSpanStart = start; rqi.timeSpanDuration = dur; } catch (eT) {}
        var om = rqi.outputModule(1);
        var kind = gc_setupAudioOM(om, outPath);
        if (!kind) return gc_fail("Audio eksport sozlanmadi. After Effects'da Output Module shabloni yarating: Format = WAV, Video Output o'chiq, nomi \"GeminiCut WAV\".");
        var target = om.file;
        rq.render();
        if (!target.exists) return gc_fail("After Effects audioni render qilmadi (" + target.fsName + ").");
        return gc_ok({ path: target.fsName, offset: start, end: start + dur, result: kind });
    } catch (e) {
        return gc_fail("Audio eksport xatosi: " + (e.message || e.toString()));
    } finally {
        try { if (rqi) rqi.remove(); } catch (eX) {}
        for (var s = 0; s < savedRender.length; s++) { try { rq.item(savedRender[s]).render = true; } catch (eS) {} }
        for (var a = 0; a < savedAudio.length; a++) { try { comp.layer(savedAudio[a][0]).audioEnabled = savedAudio[a][1]; } catch (eB) {} }
    }
}

/* ======================= subtitr: matn qatlamlari ======================= */

function gc_readText(path) {
    var f = new File(path);
    f.encoding = "UTF-8";
    if (!f.open("r")) throw new Error("Fayl ochilmadi: " + path);
    var t = f.read();
    f.close();
    if (t.charCodeAt(0) === 0xFEFF) t = t.substring(1);
    return t;
}

function gc_srtTime(s) {
    var m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
    if (!m) return NaN;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / Math.pow(10, m[4].length);
}

function gc_parseSrt(text) {
    var blocks = text.replace(/\r/g, "").split(/\n\s*\n/), cues = [];
    for (var b = 0; b < blocks.length; b++) {
        var lines = blocks[b].split("\n"), k = 0;
        while (k < lines.length && !/-->/.test(lines[k])) k++;
        if (k >= lines.length) continue;
        var parts = lines[k].split("-->");
        var st = gc_srtTime(parts[0]), en = gc_srtTime(parts[1]);
        var body = lines.slice(k + 1).join("\r").replace(/^\s+|\s+$/g, "");
        if (!isNaN(st) && !isNaN(en) && en > st && body) cues.push([st, en, body]);
    }
    return cues;
}

function gc_importSrt(srtPath) {
    try {
        var comp = gc_comp();
        var cues = gc_parseSrt(gc_readText(srtPath));
        if (!cues.length) return gc_fail("SRT faylda subtitr topilmadi.");
        return gc_undo("GeminiCut: subtitrlar", function () {
            var size = Math.round(comp.height * (comp.height > comp.width ? 0.036 : 0.05));
            var made = 0, first = null;
            for (var i = 0; i < cues.length; i++) {
                var L = comp.layers.addText(cues[i][2]);
                var prop = L.property("ADBE Text Properties").property("ADBE Text Document");
                var doc = prop.value;
                try { doc.fontSize = size; } catch (e1) {}
                try { doc.fillColor = [1, 1, 1]; doc.applyFill = true; } catch (e2) {}
                try { doc.strokeColor = [0, 0, 0]; doc.strokeWidth = Math.max(2, Math.round(size * 0.12)); doc.applyStroke = true; doc.strokeOverFill = false; } catch (e3) {}
                try { doc.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (e4) {}
                prop.setValue(doc);
                L.name = "GeminiCut Subtitr " + (i + 1);
                L.startTime = 0;
                L.inPoint = cues[i][0];
                L.outPoint = cues[i][1];
                try { L.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height * 0.86]); } catch (e5) {}
                if (first) { try { L.moveAfter(first); } catch (e6) {} }
                first = L;
                made++;
            }
            return gc_ok({ item: made + " ta matn qatlami", layers: made });
        });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= MOTION ======================= */

function gc_tprop(layer, name) {
    var tg = layer.property("ADBE Transform Group");
    if (name === "scale") return tg.property("ADBE Scale");
    if (name === "position") {
        var p = tg.property("ADBE Position");
        try { if (p.dimensionsSeparated) p.dimensionsSeparated = false; } catch (e) {}
        return p;
    }
    if (name === "rotation") return tg.property("ADBE Rotate Z");
    if (name === "opacity") return tg.property("ADBE Opacity");
    if (name === "anchor") return tg.property("ADBE Anchor Point");
    return null;
}

function gc_clearKeysIn(prop, from, to) {
    for (var k = prop.numKeys; k >= 1; k--) {
        var t = prop.keyTime(k);
        if (t >= from - 0.0005 && t <= to + 0.0005) prop.removeKey(k);
    }
}

/* Panel qiymati -> AE qiymati. Position kadr ulushida keladi (0.5 = markaz), AE'da piksel */
function gc_aeValue(comp, name, base, v, mode) {
    var W = comp.width, H = comp.height;
    if (name === "scale") {
        if (mode === "rel") { var out = []; for (var i = 0; i < base.length; i++) out.push(base[i] * v / 100); return out; }
        return base.length === 3 ? [v, v, base[2]] : [v, v];
    }
    if (name === "position" || name === "anchor") {
        var p = mode === "rel" ? [base[0] + v[0] * W, base[1] + v[1] * H] : [v[0] * W, v[1] * H];
        if (base.length === 3) p.push(base[2]);
        return p;
    }
    if (name === "rotation") return mode === "rel" ? Number(base) + v : v;
    return mode === "rel" ? Number(base) * v / 100 : v; // opacity
}

/*
 * ops = [{track, start, prop, mode: "rel"|"abs", keys: [[kompSoniya, qiymat], ...]}] - Premiere bilan bir xil format.
 */
function gc_motionCore(ops) {
    var comp = gc_comp();
    var fd = gc_fd(comp);
    var applied = 0, keysSet = 0, errors = [];
    for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        try {
            var L = gc_layerByStart(comp, op.track, op.start);
            if (!L) throw new Error("qatlam topilmadi (" + (op.track + 1) + ", " + op.start.toFixed(2) + "s)");
            if (L.locked) throw new Error(L.name + " qulflangan");
            var prop = gc_tprop(L, op.prop);
            if (!prop) throw new Error(op.prop + " xossasi topilmadi");
            var keys = op.keys.slice(0).sort(function (a, b) { return a[0] - b[0]; });
            var lo = L.inPoint, hi = L.outPoint - fd / 2, list = [];
            for (var k = 0; k < keys.length; k++) list.push([Math.max(lo, Math.min(hi, keys[k][0])), keys[k][1]]);
            if (!list.length) continue;
            var base = prop.valueAtTime(list[0][0], false);
            gc_clearKeysIn(prop, list[0][0], list[list.length - 1][0]);
            for (var q = 0; q < list.length; q++) {
                prop.setValueAtTime(list[q][0], gc_aeValue(comp, op.prop, base, list[q][1], op.mode));
                keysSet++;
            }
            applied++;
        } catch (eOp) {
            errors.push(eOp.message || eOp.toString());
        }
    }
    return { applied: applied, keys: keysSet, errors: errors };
}

function gc_applyMotion(ops) {
    try {
        var r = gc_undo("GeminiCut: motion", function () { return gc_motionCore(ops); });
        if (!r.applied && r.errors.length) return gc_fail("Motion qo'llanmadi: " + r.errors.join("; "));
        return gc_ok(r);
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

function gc_resetMotion(targets) {
    try {
        var comp = gc_comp();
        return gc_undo("GeminiCut: animatsiyani tozalash", function () {
            var done = 0;
            for (var i = 0; i < targets.length; i++) {
                var L = gc_layerByStart(comp, targets[i][0], targets[i][1]);
                if (!L || L.locked) continue;
                var names = ["scale", "position", "rotation", "opacity"];
                for (var n = 0; n < names.length; n++) {
                    var p = gc_tprop(L, names[n]);
                    if (!p) continue;
                    while (p.numKeys > 0) p.removeKey(p.numKeys);
                    var v = p.value;
                    if (names[n] === "scale") p.setValue(v.length === 3 ? [100, 100, 100] : [100, 100]);
                    else if (names[n] === "position") p.setValue(v.length === 3 ? [comp.width / 2, comp.height / 2, v[2]] : [comp.width / 2, comp.height / 2]);
                    else if (names[n] === "rotation") p.setValue(0);
                    else p.setValue(100);
                }
                done++;
            }
            return gc_ok({ reset: done });
        });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

function gc_clipInfo(comp, L) {
    var info = { track: L.index - 1, start: L.inPoint, end: L.outPoint, name: L.name,
        inPoint: L.inPoint - L.startTime, speed: Math.abs(L.stretch || 100) / 100, path: gc_layerPath(L) };
    try {
        var s = gc_tprop(L, "scale"), p = gc_tprop(L, "position"), r = gc_tprop(L, "rotation"), o = gc_tprop(L, "opacity");
        var t = L.inPoint;
        info.scale = Number(s.valueAtTime(t, false)[0]);
        var pv = p.valueAtTime(t, false);
        info.position = [pv[0] / comp.width, pv[1] / comp.height];
        info.rotation = Number(r.valueAtTime(t, false));
        info.opacity = Number(o.valueAtTime(t, false));
        info.scaleAnimated = s.numKeys > 0; info.positionAnimated = p.numKeys > 0;
    } catch (e) {}
    return info;
}

/* Tanlangan qatlamlar (After Effects'da tanlov bor), bo'lmasa vaqt ko'rsatkichi ostidagi qatlam */
function gc_getEditContext() {
    try {
        var comp = gc_comp();
        var clips = [], source = "selection";
        var sel = comp.selectedLayers;
        for (var i = 0; i < sel.length; i++) if (gc_hasVideo(sel[i])) clips.push(gc_clipInfo(comp, sel[i]));
        if (!clips.length) {
            var L = gc_layerAt(comp, comp.time, function (x) { return !x.locked && !/geminicut[\/\\]+matn[\/\\]/i.test(gc_layerPath(x)); });
            if (L) { clips.push(gc_clipInfo(comp, L)); source = "playhead"; }
        }
        clips.sort(function (a, b) { return a.start - b.start; });
        return gc_ok({ clips: clips, source: clips.length ? source : "none", playhead: comp.time,
            fps: comp.frameRate, width: comp.width, height: comp.height, name: comp.name, id: String(comp.id) });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* Avto montaj zoom'lari: gapirayotgan odamning qatlamiga punch-in */
function gc_applyZooms(zooms, speech) {
    try {
        var comp = gc_comp();
        var fd = gc_fd(comp);
        var ramp = 0.35, ops = [], skipped = 0;
        zooms.sort(function (a, b) { return a[0] - b[0]; });
        for (var i = 0; i < zooms.length; i++) {
            var t0 = zooms[i][0];
            var pct = Math.max(102, Math.min(160, zooms[i][1]));
            var hold = Math.max(0.5, Math.min(8, zooms[i][2]));
            var speakerPath = "";
            for (var s = 0; s < speech.length && !speakerPath; s++) {
                if (speech[s] < 0 || speech[s] >= comp.numLayers) continue;
                var A = comp.layer(speech[s] + 1);
                if (A.inPoint <= t0 && A.outPoint > t0) speakerPath = gc_normPath(gc_layerPath(A));
            }
            var target = gc_layerAt(comp, t0, function (x) { return !x.locked && speakerPath && gc_normPath(gc_layerPath(x)) === speakerPath; })
                || gc_layerAt(comp, t0, function (x) { return !x.locked && !(x instanceof TextLayer) && !/geminicut[\/\\]+matn[\/\\]/i.test(gc_layerPath(x)); });
            if (!target) { skipped++; continue; }
            var t3 = Math.min(t0 + ramp + hold + ramp, target.outPoint - fd);
            if (t3 - t0 < 0.3) { skipped++; continue; }
            var r = Math.min(ramp, (t3 - t0) / 3);
            ops.push({ track: target.index - 1, start: target.inPoint, prop: "scale", mode: "rel",
                keys: [[t0, 100], [t0 + r, pct], [t3 - r, pct], [t3, 100]] });
        }
        if (!ops.length) return gc_ok({ applied: 0, skipped: skipped });
        var res = gc_undo("GeminiCut: zoom", function () { return gc_motionCore(ops); });
        if (!res.applied && res.errors.length) return gc_fail("Zoom qo'llanmadi: " + res.errors.join("; "));
        return gc_ok({ applied: res.applied, skipped: skipped + (ops.length - res.applied), errors: res.errors });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= kesish (ripple) ======================= */

/*
 * ranges - olib tashlanadigan oraliqlar (komp soniyasi). Har bir qulflanmagan qatlam bo'laklarga
 * ajratiladi (duplicate + inPoint/outPoint), bo'laklar chapga suriladi, kompozitsiya qisqaradi.
 */
function gc_applyCuts(ranges, speech) {
    try {
        var comp = gc_comp();
        var fd = gc_fd(comp);
        var list = [];
        for (var i = 0; i < ranges.length; i++) {
            var rs = gc_snap(ranges[i][0], fd), re = gc_snap(ranges[i][1], fd);
            if (re - rs >= fd * 2) list.push([rs, re]);
        }
        list.sort(function (a, b) { return a[0] - b[0]; });
        var merged = [];
        for (var m = 0; m < list.length; m++) {
            if (merged.length && list[m][0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], list[m][1]);
            else merged.push([list[m][0], list[m][1]]);
        }
        if (!merged.length) return gc_ok({ applied: 0, seconds: 0 });

        function removedBefore(t) {
            var sum = 0;
            for (var k = 0; k < merged.length; k++) if (merged[k][1] <= t + 1e-6) sum += merged[k][1] - merged[k][0];
            return sum;
        }
        function pieces(a, b) {
            var out = [], cur = a;
            for (var k = 0; k < merged.length; k++) {
                var s = merged[k][0], e = merged[k][1];
                if (e <= cur || s >= b) continue;
                if (s > cur) out.push([cur, s]);
                cur = Math.max(cur, e);
            }
            if (cur < b) out.push([cur, b]);
            var res = [];
            for (var r = 0; r < out.length; r++) if (out[r][1] - out[r][0] >= fd / 2) res.push(out[r]);
            return res;
        }

        return gc_undo("GeminiCut: pauzalarni kesish", function () {
            var layers = [];
            for (var n = 1; n <= comp.numLayers; n++) layers.push(comp.layer(n));
            for (var j = 0; j < layers.length; j++) {
                var L = layers[j];
                if (L.locked) continue;
                var segs = pieces(L.inPoint, L.outPoint);
                if (!segs.length) { L.remove(); continue; }
                var objs = [L];
                for (var d = 1; d < segs.length; d++) objs.push(L.duplicate());
                for (var p = 0; p < segs.length; p++) {
                    var Q = objs[p], shift = removedBefore(segs[p][0]);
                    Q.startTime = Q.startTime - shift;
                    Q.inPoint = segs[p][0] - shift;
                    Q.outPoint = segs[p][1] - shift;
                }
            }
            var total = 0;
            for (var t = 0; t < merged.length; t++) total += Math.max(0, Math.min(merged[t][1], comp.duration) - merged[t][0]);
            comp.duration = Math.max(fd * 2, comp.duration - total);
            return gc_ok({ applied: merged.length, seconds: total });
        });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= sound effektlar ======================= */

function gc_insertSound(filePath, trackIndex, at, avoid) {
    try {
        var comp = gc_comp();
        return gc_undo("GeminiCut: SFX", function () {
            var item = gc_importOnce(filePath, "GeminiCut SFX");
            var time = at >= 0 ? at : comp.time;
            var L = comp.layers.add(item);
            L.startTime = time;
            try { L.moveToEnd(); } catch (e) {}
            return gc_ok({ name: item.name, track: L.index - 1, at: time, duration: item.duration || 0 });
        });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= kadr eksporti ======================= */

/* saveFrameToPng asinxron yozadi - fayl paydo bo'lguncha kutamiz */
function gc_savePng(comp, sec, path) {
    var f = new File(path);
    try { if (f.exists) f.remove(); } catch (e) {}
    comp.saveFrameToPng(sec, f);
    for (var w = 0; w < 150 && !f.exists; w++) $.sleep(100);
    return f.exists ? f.fsName : "";
}

function gc_exportFrames(base, times) {
    try {
        var comp = gc_comp();
        if (typeof comp.saveFrameToPng !== "function") return gc_fail("Bu After Effects versiyasida kadr eksporti yo'q.");
        var files = [];
        for (var i = 0; i < times.length; i++) {
            var f = gc_savePng(comp, Math.max(0, Math.min(comp.duration - gc_fd(comp), times[i])), base + "_" + i + ".png");
            if (f) files.push(f);
        }
        if (!files.length && times.length) return gc_fail("Kadr eksport qilinmadi.");
        return gc_ok({ files: files });
    } catch (e) {
        return gc_fail("Kadr eksporti: " + (e.message || e.toString()));
    }
}

/* ======================= animatsion matn (PNG ketma-ketligi) ======================= */

function gc_isTextPath(p) { return /geminicut\/+matn\//.test(gc_normPath(p)); }

function gc_importSequence(first, count, fps, at, replace, name) {
    try {
        var comp = gc_comp();
        var f = new File(first);
        if (!f.exists) return gc_fail("Kadrlar topilmadi: " + first);
        return gc_undo("GeminiCut: matn", function () {
            var io = new ImportOptions(f);
            io.sequence = true;
            try { io.forceAlphabetical = true; } catch (eF) {}
            var item = app.project.importFile(io);
            if (!item) return gc_fail("PNG ketma-ketligi import qilinmadi.");
            try { item.mainSource.conformFrameRate = fps; } catch (eR) {}
            try { item.mainSource.alphaMode = AlphaMode.STRAIGHT; } catch (eM) {}
            try { if (name) item.name = name; } catch (eN) {}
            try { item.parentFolder = gc_folder("GeminiCut Matn"); } catch (eP) {}
            var time = at >= 0 ? at : comp.time;
            var old = gc_replaceTarget(comp, replace);
            if (old) time = old.inPoint;
            var L = comp.layers.add(item);
            L.startTime = time;
            if (old) { try { L.moveBefore(old); } catch (eB) {} gc_removeTextGroup(comp, old); }
            return gc_ok({ track: L.index - 1, seconds: time, duration: count / fps });
        });
    } catch (e) {
        return gc_fail("Matn: " + (e.message || e.toString()));
    }
}

/* Tahrirlash uchun matn: avval tanlangan qatlam(lar), so'ng vaqt ko'rsatkichi ostidagisi */
function gc_textInfo(comp, H) {
    var info = { track: H.index - 1, start: H.inPoint, end: H.outPoint };
    if (gc_isNativeHead(H)) { info.native = true; info.recipe = String(H.comment).substr(GC_NATIVE_TAG.length); }
    else info.path = gc_layerPath(H);
    return gc_ok(info);
}

function gc_textAtPlayhead() {
    try {
        var comp = gc_comp(), i, H;
        var sel = comp.selectedLayers || [];
        for (i = 0; i < sel.length; i++) { H = gc_textHead(sel[i]); if (H) return gc_textInfo(comp, H); }
        for (i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (!(L.inPoint <= comp.time + 1e-4 && L.outPoint > comp.time + 1e-4)) continue;
            H = gc_textHead(L);
            if (H) return gc_textInfo(comp, H);
        }
        return gc_fail("GeminiCut matni topilmadi. Matn qatlamini tanlang yoki vaqt ko'rsatkichini uning ustiga qo'ying.");
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= tahrirlanadigan (native) matn va 3D logolar =======================
 * Panel shablonni AE'ning o'z qatlamlari bilan quradi: matn - oddiy Text qatlam (Character
 * panelida shrift/rang/o'lcham, kompozitsiyada ikki marta bosib matnni o'zgartirish mumkin),
 * fon - matnga bog'langan Shape qatlam (o'lchami ifoda orqali matnga moslashadi), animatsiya -
 * oddiy keyframe'lar. 3D logo - Null (boshqaruv) + chuqurlik bo'yicha terilgan 3D nusxalar.
 * Bosh qatlam izohida (Comment) panel retsepti saqlanadi - "Tahrirlash" uni qayta o'qiydi.
 */

var GC_NATIVE_TAG = "GeminiCut:";

function gc_rgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return [1, 1, 1];
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

var GC_PS_FONTS = {
    "Arial Black": ["Arial-Black", "Arial-Black"], "Impact": ["Impact", "Impact"],
    "Segoe UI": ["SegoeUI", "SegoeUI-Bold"], "Segoe UI Black": ["SegoeUI-Black", "SegoeUI-Black"],
    "Bahnschrift": ["Bahnschrift", "Bahnschrift-Bold"], "Arial": ["ArialMT", "Arial-BoldMT"],
    "Montserrat": ["Montserrat-Regular", "Montserrat-Bold"], "Calibri": ["Calibri", "Calibri-Bold"],
    "Trebuchet MS": ["TrebuchetMS", "TrebuchetMS-Bold"], "Verdana": ["Verdana", "Verdana-Bold"],
    "Georgia": ["Georgia", "Georgia-Bold"], "Times New Roman": ["TimesNewRomanPSMT", "TimesNewRomanPS-BoldMT"],
    "Cambria": ["Cambria", "Cambria-Bold"], "Franklin Gothic Medium": ["FranklinGothic-Medium", "FranklinGothic-Medium"],
    "Century Gothic": ["CenturyGothic", "CenturyGothic-Bold"], "Comic Sans MS": ["ComicSansMS", "ComicSansMS-Bold"],
    "Consolas": ["Consolas", "Consolas-Bold"], "Gabriola": ["Gabriola", "Gabriola"],
    "Segoe Script": ["SegoeScript", "SegoeScript-Bold"], "Monotype Corsiva": ["MonotypeCorsiva", "MonotypeCorsiva"],
    "Edwardian Script ITC": ["EdwardianScriptITC", "EdwardianScriptITC"], "Lucida Handwriting": ["LucidaHandwriting-Italic", "LucidaHandwriting-Italic"],
    "Palatino Linotype": ["PalatinoLinotype-Roman", "PalatinoLinotype-Bold"], "Book Antiqua": ["BookAntiqua", "BookAntiqua-Bold"],
    "Segoe UI Emoji": ["SegoeUIEmoji", "SegoeUIEmoji"]
};

/* Shrift oilasi -> PostScript nomi (AE 2024+ da app.fonts orqali aniq; aks holda jadval) */
function gc_psFont(family, weight, italic) {
    family = String(family || "Arial");
    var bold = Number(weight) >= 600;
    try {
        if (app.fonts && app.fonts.getFontsByFamilyNameAndStyleName) {
            var styles = bold ? (italic ? ["Bold Italic", "Black Italic", "Bold", "Black", "Regular"] : ["Bold", "Black", "Semibold", "Regular"])
                : (italic ? ["Italic", "Regular"] : ["Regular", "Roman", "Book", "Medium"]);
            for (var i = 0; i < styles.length; i++) {
                var arr = app.fonts.getFontsByFamilyNameAndStyleName(family, styles[i]);
                if (arr && arr.length && arr[0].postScriptName) return arr[0].postScriptName;
            }
        }
    } catch (e) {}
    var m = GC_PS_FONTS[family];
    if (m) return m[bold ? 1 : 0];
    return family.replace(/\s+/g, "");
}

function gc_effects(L) { return L.property("ADBE Effect Parade"); }

/* Effekt qo'shadi va (havolalar eskirmasligi uchun) uni qayta topib qaytaradi */
function gc_addEffect(L, matchName, name) {
    var fx = gc_effects(L);
    var e = fx.addProperty(matchName);
    try { if (name) e.name = name; } catch (eN) {}
    return fx.property(fx.numProperties);
}

function gc_setp(group, matchName, v) {
    try { group.property(matchName).setValue(v); return true; } catch (e) { return false; }
}

function gc_keys(prop, list) {
    for (var i = 0; i < list.length; i++) prop.setValueAtTime(list[i][0], list[i][1]);
    try {
        var dim = list[0][1] instanceof Array ? list[0][1].length : 1;
        var ein = [], eout = [];
        for (var d = 0; d < dim; d++) { ein.push(new KeyframeEase(0, 70)); eout.push(new KeyframeEase(0, 70)); }
        for (var k = 1; k <= prop.numKeys; k++) prop.setTemporalEaseAtKey(k, ein, eout);
    } catch (e) {}
}

function gc_parent(child, parent) {
    try { if (child.setParentWithJump) { child.setParentWithJump(parent); return; } } catch (e) {}
    child.parent = parent;
}

function gc_span(L, t0, D) {
    L.startTime = t0;
    L.inPoint = t0;
    L.outPoint = t0 + D;
}

function gc_fontSizeOf(spec, comp) { return Math.max(4, Math.round(spec.size * comp.height)); }

function gc_textLayer(comp, spec, txt, size, color) {
    var L = comp.layers.addText(String(txt).replace(/\r?\n/g, "\r"));
    var prop = L.property("ADBE Text Properties").property("ADBE Text Document");
    var doc = prop.value;
    try { doc.font = gc_psFont(spec.font, spec.weight, spec.italic); } catch (e1) {}
    try { doc.fontSize = size; } catch (e2) {}
    try { doc.applyFill = true; doc.fillColor = gc_rgb(color); } catch (e3) {}
    try { doc.tracking = Math.round((spec.spacing || 0) * 1000); } catch (e4) {}
    try { doc.autoLeading = false; doc.leading = Math.round(size * 1.14); } catch (e5) {}
    try {
        if (spec.sticker) { doc.applyStroke = true; doc.strokeColor = [1, 1, 1]; doc.strokeWidth = Math.max(2, Math.round(size * 0.22)); doc.strokeOverFill = false; }
        else if (spec.stroke > 0) { doc.applyStroke = true; doc.strokeColor = [0.04, 0.04, 0.055]; doc.strokeWidth = Math.max(1, Math.round(size * 0.12 * spec.stroke)); doc.strokeOverFill = false; }
        else doc.applyStroke = false;
    } catch (e6) {}
    try {
        doc.justification = spec.align === "left" ? ParagraphJustification.LEFT_JUSTIFY
            : spec.align === "right" ? ParagraphJustification.RIGHT_JUSTIFY : ParagraphJustification.CENTER_JUSTIFY;
    } catch (e7) {}
    prop.setValue(doc);
    return L;
}

/* Ifodalar uchun umumiy boshlanish: ota matn qatlamining to'rtburchagi va shrift o'lchami */
function gc_rectExpr(size) {
    return "var p=thisLayer.parent,r=p.sourceRectAtTime(time,false),f=" + size + ";" +
        "try{f=p.text.sourceText.style.fontSize;}catch(e){}";
}

function gc_bgLayer(comp, spec, T, size) {
    var bg = spec.bg;
    var S = comp.layers.addShape();
    S.name = "GeminiCut fon";
    var px = bg.padX, py = bg.padY;
    var dims = "var w=r.width+2*" + px + "*f,h=r.height+2*" + py + "*f,cx=r.left+r.width/2,cy=r.top+r.height/2;";
    var root = S.property("ADBE Root Vectors Group");
    root.addProperty("ADBE Vector Group");
    var vecs = function () { return S.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group"); };
    if (bg.shape === "slant") {
        vecs().addProperty("ADBE Vector Shape - Group");
        vecs().property("ADBE Vector Shape - Group").property("ADBE Vector Shape").expression =
            gc_rectExpr(size) + dims + "var k=h*0.28;createPath([[cx-w/2+k,cy-h/2],[cx+w/2+k,cy-h/2],[cx+w/2-k,cy+h/2],[cx-w/2-k,cy+h/2]],[],[],true);";
    } else {
        vecs().addProperty("ADBE Vector Shape - Rect");
        var rect = vecs().property("ADBE Vector Shape - Rect");
        if (bg.shape === "bar") {
            rect.property("ADBE Vector Rect Size").expression = gc_rectExpr(size) + dims + "[0.14*f,h];";
            rect.property("ADBE Vector Rect Position").expression = gc_rectExpr(size) + dims + "[r.left-" + px + "*f,cy];";
        } else {
            rect.property("ADBE Vector Rect Size").expression = gc_rectExpr(size) + dims + "[w,h];";
            rect.property("ADBE Vector Rect Position").expression = gc_rectExpr(size) + dims + "[cx,cy];";
            vecs().property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Roundness").expression =
                gc_rectExpr(size) + dims + "Math.min(w,h)/2*" + (bg.radius || 0) + ";";
        }
    }
    if (bg.fill) {
        vecs().addProperty("ADBE Vector Graphic - Fill");
        var fill = vecs().property("ADBE Vector Graphic - Fill");
        gc_setp(fill, "ADBE Vector Fill Color", gc_rgb(bg.fill));
        gc_setp(fill, "ADBE Vector Fill Opacity", bg.opacity || 100);
    }
    if (bg.stroke) {
        vecs().addProperty("ADBE Vector Graphic - Stroke");
        var st = vecs().property("ADBE Vector Graphic - Stroke");
        gc_setp(st, "ADBE Vector Stroke Color", gc_rgb(bg.stroke));
        gc_setp(st, "ADBE Vector Stroke Width", Math.max(2, Math.round(size * (bg.fill ? 0.035 : 0.07))));
        if (bg.fill) gc_setp(st, "ADBE Vector Stroke Opacity", 60);
    }
    return S;
}

/* Bola qatlamni ota (matn) koordinatalariga joylaydi: ota bilan birga harakatlanadi/kattalashadi */
function gc_attach(child, parent, below) {
    gc_parent(child, parent);
    var tg = child.property("ADBE Transform Group");
    gc_setp(tg, "ADBE Anchor Point", [0, 0]);
    gc_setp(tg, "ADBE Position", [0, 0]);
    gc_setp(tg, "ADBE Scale", [100, 100]);
    try { tg.property("ADBE Opacity").expression = "thisLayer.parent.transform.opacity"; } catch (e) {}
    if (below) { try { child.moveAfter(parent); } catch (e2) {} }
}

function gc_shadow(L, spec, size) {
    if (spec.shadow > 0) {
        var ds = gc_addEffect(L, "ADBE Drop Shadow", "GeminiCut soya");
        var op = Math.min(1, 0.35 + spec.shadow * 0.5);
        if (!gc_setp(ds, "ADBE Drop Shadow-0002", op * 255)) gc_setp(ds, "ADBE Drop Shadow-0002", op * 100);
        gc_setp(ds, "ADBE Drop Shadow-0004", Math.round(size * 0.05));
        gc_setp(ds, "ADBE Drop Shadow-0005", Math.round(size * 0.18));
    }
    if (spec.glow > 0) {
        var gl = gc_addEffect(L, "ADBE Drop Shadow", "GeminiCut nur");
        gc_setp(gl, "ADBE Drop Shadow-0001", gc_rgb(spec.color2 || spec.accent));
        if (!gc_setp(gl, "ADBE Drop Shadow-0002", 255)) gc_setp(gl, "ADBE Drop Shadow-0002", 100);
        gc_setp(gl, "ADBE Drop Shadow-0004", 0);
        gc_setp(gl, "ADBE Drop Shadow-0005", Math.round(size * (0.3 + spec.glow * 0.6)));
    }
}

/* Kirish/chiqish animatsiyasi - matn qatlamining o'z keyframe'lari */
function gc_animate(comp, T, spec, t0) {
    var D = spec.duration, i = Math.max(0.1, spec.inDur), o = Math.max(0.1, spec.outDur), t1 = t0 + D;
    var W = comp.width, H = comp.height, P = [spec.x * W, spec.y * H], size = gc_fontSizeOf(spec, comp);
    var sp = Math.max(0.25, Math.min(4, spec.speed || 1));
    var fdt = gc_fd(comp);
    t1 -= fdt;
    var tg = T.property("ADBE Transform Group");
    var pos = tg.property("ADBE Position"), sc = tg.property("ADBE Scale"), op = tg.property("ADBE Opacity");
    var a = spec.anim;
    var fadeIn = a === "pop" || a === "counter" || a === "timer" || a === "pulse" ? i * 0.4 : a === "slam" || a === "strobe" ? i * 0.2 : i;
    gc_keys(op, [[t0, 0], [t0 + fadeIn, 100], [t1 - o, 100], [t1, 0]]);
    if (a === "pop" || a === "counter" || a === "timer" || a === "pulse") {
        gc_keys(sc, [[t0, [0, 0]], [t0 + i * 0.7, [112, 112]], [t0 + i, [100, 100]], [t1 - o, [100, 100]], [t1, [80, 80]]]);
    } else if (a === "slam" || a === "strobe") {
        gc_keys(sc, [[t0, [260, 260]], [t0 + i * 0.5, [100, 100]], [t1 - o, [100, 100]], [t1, [120, 120]]]);
        pos.expression = "var t=time-inPoint-" + (i * 0.5).toFixed(3) + ";(t>0&&t<0.4)?add(value,[Math.sin(t*95)*(0.4-t)*" + Math.round(size * 0.3) +
            ",Math.cos(t*83)*(0.4-t)*" + Math.round(size * 0.25) + "]):value";
    } else if (a === "rise") {
        gc_keys(pos, [[t0, [P[0], P[1] + H * 0.06]], [t0 + i, P], [t1 - o, P], [t1, [P[0], P[1] - H * 0.03]]]);
    } else if (a === "slide") {
        var dx = spec.align === "right" ? W * 0.5 : -W * 0.5;
        gc_keys(pos, [[t0, [P[0] + dx, P[1]]], [t0 + i, P], [t1 - o, P], [t1, [P[0] - dx * 0.4, P[1]]]]);
    } else if (a === "blur") {
        var bl = gc_addEffect(T, "ADBE Gaussian Blur 2", "GeminiCut xira");
        try { gc_keys(bl.property("ADBE Gaussian Blur 2-0001"), [[t0, Math.round(size * 0.6)], [t0 + i, 0], [t1 - o, 0], [t1, Math.round(size * 0.4)]]); } catch (eB) {}
        gc_keys(sc, [[t0, [125, 125]], [t0 + i, [100, 100]]]);
    }
    var st = tg.property("ADBE Scale");
    if (a === "pulse") st.expression = "var t=time-inPoint;mul(value,1+0.08*Math.pow(Math.abs(Math.sin(t*Math.PI*" + (1.3 * sp).toFixed(3) + ")),12))";
    if (a === "strobe") op.expression = "var t=time-inPoint;(t<" + (i * 1.6).toFixed(3) + "&&Math.floor(t*20)%2==1)?0:value";
    var src = T.property("ADBE Text Properties").property("ADBE Text Document");
    if (a === "typewriter") {
        var len = String(spec.text || "").length;
        var td = Math.min(D * 0.6, Math.max(i, 0.05 * len / sp));
        src.expression = "var s=\"\"+value;s.substr(0,Math.floor(linear(time-inPoint,0," + td.toFixed(3) + ",0,s.length+1)))";
    } else if (a === "counter") {
        var cd = Math.max(i * 1.8, Math.min(2.2, D * 0.6));
        src.expression = "var k=ease(time-inPoint,0," + cd.toFixed(3) + ",0,1);(\"\"+value).replace(/\\d+(?:[.,]\\d+)?/g,function(m){" +
            "var dec=(m.split(/[.,]/)[1]||\"\").length,v=parseFloat(m.replace(\",\",\".\"))*k;return dec?v.toFixed(dec).replace(\".\",m.indexOf(\",\")>=0?\",\":\".\"):String(Math.round(v));})";
    } else if (a === "timer") {
        src.expression = "var s=(\"\"+value).split(\"\\r\")[0].replace(/^\\s+|\\s+$/g,\"\"),m=s.match(/^(\\d+):(\\d{1,2})$/)," +
            "tot=m?Number(m[1])*60+Number(m[2]):Math.max(0,parseFloat(s)||30),c=Math.ceil(Math.max(0,tot-(time-inPoint)*" + sp + "))," +
            "mm=Math.floor(c/60),ss=c%60;(m||tot>=60)?mm+\":\"+(ss<10?\"0\":\"\")+ss:String(c)";
    }
}

function gc_nativeText(comp, spec, t0) {
    var size = gc_fontSizeOf(spec, comp), made = [];
    var T = gc_textLayer(comp, spec, spec.noText ? " " : spec.text, size, spec.color);
    gc_span(T, t0, spec.duration);
    made.push(T);
    var tg = T.property("ADBE Transform Group");
    /* tayanch nuqta - matn blokining vertikal markazi (gorizontal tekislash nuqtasi x=0) */
    tg.property("ADBE Anchor Point").expression = "var r=sourceRectAtTime(Math.max(inPoint,outPoint-thisComp.frameDuration),false);[0,r.top+r.height/2]";
    gc_setp(tg, "ADBE Position", [spec.x * comp.width, spec.y * comp.height]);
    if (spec.sub) {
        var sub = gc_textLayer(comp, { font: spec.font, weight: 500, italic: spec.italic, spacing: 0, align: spec.align, stroke: spec.stroke },
            spec.sub, Math.round(size * 0.55), spec.color);
        sub.name = "GeminiCut ost matn";
        gc_span(sub, t0, spec.duration);
        gc_attach(sub, T, true);
        var stg = sub.property("ADBE Transform Group");
        stg.property("ADBE Anchor Point").expression = "var r=sourceRectAtTime(time,false);[0,r.top]";
        stg.property("ADBE Position").expression = gc_rectExpr(size) + "[0,r.top+r.height+0.3*f]";
        made.push(sub);
    }
    if (spec.bg) {
        var S = gc_bgLayer(comp, spec, T, size);
        gc_span(S, t0, spec.duration);
        gc_attach(S, T, false);
        try { S.moveAfter(made[made.length - 1]); } catch (eM) {}
        made.push(S);
    }
    gc_shadow(T, spec, size);
    gc_animate(comp, T, spec, t0);
    return { head: T, layers: made };
}

/* 3D logo: Null boshqaruvchi + chuqurlik bo'yicha terilgan nusxalar (orqadagilari qoraytirilgan) */
function gc_nativeLogo(comp, spec, t0) {
    var item = gc_importOnce(spec.logo, "GeminiCut Logo");
    var W = comp.width, H = comp.height, D = spec.duration, made = [];
    var ih = item.height || 1000, iw = item.width || 1000;
    var hPx = 0.72 * spec.size * H;
    if (hPx * iw / ih > 0.9 * W) hPx = 0.9 * W * ih / iw;
    var sc = hPx / ih * 100;
    var N = comp.layers.addNull(D);
    N.name = "GeminiCut Logo: " + spec.name;
    N.threeDLayer = true;
    gc_span(N, t0, D);
    var ntg = N.property("ADBE Transform Group");
    gc_setp(ntg, "ADBE Anchor Point", [0, 0, 0]);
    gc_setp(ntg, "ADBE Position", [spec.x * W, spec.y * H, 0]);
    var sl = gc_addEffect(N, "ADBE Slider Control", "Qalinlik");
    gc_setp(sl, "ADBE Slider Control-0001", Math.max(2, Math.round((spec.depth || 0.16) * hPx)));
    made.push(N);
    var K = 12, front = null;
    for (var k = K - 1; k >= 0; k--) {
        var L = comp.layers.add(item);
        L.name = k ? "GeminiCut logo qalinlik " + k : "GeminiCut logo (old tomon)";
        L.threeDLayer = true;
        gc_span(L, t0, D);
        gc_parent(L, N);
        var tg = L.property("ADBE Transform Group");
        gc_setp(tg, "ADBE Anchor Point", [iw / 2, ih / 2, 0]);
        gc_setp(tg, "ADBE Position", [0, 0, 0]);
        gc_setp(tg, "ADBE Scale", [sc, sc, sc]);
        tg.property("ADBE Position").expression = "var d=thisLayer.parent.effect(\"Qalinlik\")(1);[value[0],value[1],d*" + (k / (K - 1)).toFixed(4) + "]";
        tg.property("ADBE Opacity").expression = "thisLayer.parent.transform.opacity";
        if (k > 0) {
            var bc = gc_addEffect(L, "ADBE Brightness & Contrast 2", "GeminiCut yon");
            gc_setp(bc, "ADBE Brightness & Contrast 2-0001", -70);
        } else front = L;
        made.push(L);
    }
    try {
        var sw = gc_addEffect(front, "CC Light Sweep", "GeminiCut yaltirash");
        gc_keys(sw.property(1), [[t0 + spec.inDur, [-iw * 0.3, ih / 2]], [t0 + Math.min(D - spec.outDur, spec.inDur + 1.4), [iw * 1.3, ih / 2]]]);
    } catch (eS) {}
    var rot = spec.rot || 32, i = Math.max(0.1, spec.inDur), o = Math.max(0.1, spec.outDur), t1 = t0 + D - gc_fd(comp);
    var ry = ntg.property("ADBE Rotate Y");
    gc_keys(ry, [[t0, rot * 1.8], [t0 + i, 0], [t1 - o, 0], [t1, rot * 1.2]]);
    ry.expression = "value+Math.sin((time-inPoint)*1.1)*" + (rot * 0.3).toFixed(2);
    try { ntg.property("ADBE Rotate X").expression = "value+Math.sin((time-inPoint)*0.8+1)*" + (rot * 0.1).toFixed(2); } catch (eX) {}
    gc_keys(ntg.property("ADBE Scale"), [[t0, [55, 55, 55]], [t0 + i, [100, 100, 100]], [t1 - o, [100, 100, 100]], [t1, [115, 115, 115]]]);
    gc_keys(ntg.property("ADBE Opacity"), [[t0, 0], [t0 + i * 0.25, 100], [t1 - o, 100], [t1, 0]]);
    try { N.moveBefore(front); } catch (eN) {}
    return { head: N, layers: made };
}

function gc_isNativeHead(L) {
    try { return String(L.comment || "").indexOf(GC_NATIVE_TAG) === 0; } catch (e) { return false; }
}

/* Qatlamning GeminiCut matn guruhi boshini topadi (o'zi, yoki ota-qatlamlari orasidan) */
function gc_textHead(L) {
    var cur = L, guard = 0;
    while (cur && guard++ < 8) {
        if (gc_isNativeHead(cur)) return cur;
        if (gc_isTextPath(gc_layerPath(cur))) return cur;
        try { cur = cur.parent; } catch (e) { cur = null; }
    }
    return null;
}

/* Bosh qatlam va unga bog'langan barcha qatlamlarni o'chiradi */
function gc_removeTextGroup(comp, head) {
    var kids = [];
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i), p = null;
        try { p = L.parent; } catch (e) {}
        var guard = 0;
        while (p && guard++ < 8) { if (p === head) { kids.push(L); break; } try { p = p.parent; } catch (e2) { p = null; } }
    }
    for (var k = 0; k < kids.length; k++) kids[k].remove();
    head.remove();
}

function gc_replaceTarget(comp, replace) {
    if (!replace || !(replace.track >= 0) || replace.track >= comp.numLayers) return null;
    var L = gc_layerByStart(comp, replace.track, replace.start) || comp.layer(replace.track + 1);
    return L ? gc_textHead(L) : null;
}

/* spec - panelning GCTextFX.nativeSpec() natijasi; spec.recipe - qayta tahrirlash uchun */
function gc_insertNative(spec, at, replace) {
    try {
        var comp = gc_comp();
        if (spec.logo && !new File(spec.logo).exists) return gc_fail("Logo fayli topilmadi: " + spec.logo);
        return gc_undo("GeminiCut: matn", function () {
            var t0 = at >= 0 ? at : comp.time;
            var old = gc_replaceTarget(comp, replace);
            if (old) { t0 = old.inPoint; gc_removeTextGroup(comp, old); }
            var r = spec.logo ? gc_nativeLogo(comp, spec, t0) : gc_nativeText(comp, spec, t0);
            try { r.head.comment = GC_NATIVE_TAG + gc_json(spec.recipe || {}); } catch (eC) {}
            try { for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false; r.head.selected = true; } catch (eS) {}
            return gc_ok({ track: r.head.index - 1, seconds: t0, duration: spec.duration, native: true, layers: r.layers.length });
        });
    } catch (e) {
        return gc_fail("Matn: " + (e.message || e.toString()));
    }
}

/* Rang berish (LUT) - DaVinci Resolve versiyasida */
function gc_colorTargets() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
function gc_applyGrade() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
function gc_revertGrade() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
