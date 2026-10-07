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

var GC_VERSION = "4.5.0";
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

function gc_flowCapture(frameBase) {
    try {
        var comp = gc_comp();
        var f = gc_savePng(comp, comp.time, frameBase + ".png");
        if (!f) return gc_fail("Kadr saqlanmadi.");
        return gc_ok({ sequenceID: String(comp.id), sequenceName: comp.name, projectPath: app.project.file ? app.project.file.fsName : "",
            ticks: String(comp.time), seconds: comp.time, frame: f, width: comp.width, height: comp.height });
    } catch (e) { return gc_fail("Kadr eksporti: " + (e.message || e.toString())); }
}

function gc_flowImport(filePath, sequenceID, ticks, projectPath, useCurrent) {
    try {
        var comp = null;
        try { comp = app.project.itemByID(Number(sequenceID)); } catch (eC) {}
        if (!comp || !(comp instanceof CompItem)) return gc_fail("Kadr olingan kompozitsiya topilmadi. Video Project panelida saqlandi.");
        GC_LAST_COMP_ID = comp.id;
        return gc_undo("GeminiCut: AI video", function () {
            var item = gc_importOnce(filePath, "GeminiCut AI Video");
            var L = comp.layers.add(item);
            L.startTime = useCurrent ? comp.time : Number(ticks) || 0;
            try { if (L.hasAudio) L.audioEnabled = false; } catch (eA) {}
            return gc_ok({ track: L.index - 1, seconds: L.startTime, name: item.name });
        });
    } catch (e) { return gc_fail("Import: " + (e.message || e.toString())); }
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
            var time = at >= 0 ? at : comp.time, old = null;
            if (replace && replace.track >= 0 && replace.track < comp.numLayers) {
                old = gc_layerByStart(comp, replace.track, replace.start) || comp.layer(replace.track + 1);
                if (old && !gc_isTextPath(gc_layerPath(old))) old = null;
                if (old) time = old.inPoint;
            }
            var L = comp.layers.add(item);
            L.startTime = time;
            if (old) { try { L.moveBefore(old); } catch (eB) {} old.remove(); }
            return gc_ok({ track: L.index - 1, seconds: time, duration: count / fps });
        });
    } catch (e) {
        return gc_fail("Matn: " + (e.message || e.toString()));
    }
}

function gc_textAtPlayhead() {
    try {
        var comp = gc_comp();
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            var p = gc_layerPath(L);
            if (p && gc_isTextPath(p) && L.inPoint <= comp.time + 1e-4 && L.outPoint > comp.time + 1e-4) {
                return gc_ok({ track: i - 1, start: L.inPoint, end: L.outPoint, path: p });
            }
        }
        return gc_fail("Vaqt ko'rsatkichi ostida GeminiCut matni yo'q. Uni matn qatlami ustiga qo'ying.");
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* Rang berish (LUT) - DaVinci Resolve versiyasida */
function gc_colorTargets() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
function gc_applyGrade() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
function gc_revertGrade() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
