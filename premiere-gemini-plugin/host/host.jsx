/*
 * GeminiCut 4.0 - Premiere Pro ExtendScript tomoni (host).
 *
 * Ish tamoyili: asl video fayllar hech qayerga yuborilmaydi. Premiere o'zi
 * timeline audiosini/kadrlarini eksport qiladi, panel tahlil qiladi, natija
 * shu yerdagi funksiyalar orqali timeline'ga qo'llanadi.
 *
 * Muhim: ExtendScript ES3 - JSON, forEach, let/const yo'q. Javoblar gc_json()
 * bilan qo'lda yig'iladi. Panel faqat raqam, satr, massiv va oddiy obyekt
 * literallarini yuboradi. Fayl faqat ASCII (boshqa belgilar \\uXXXX) - Windows
 * tizim kodlashi qanday bo'lmasin to'g'ri o'qiladi.
 * Barcha vaqtlar - sequence (timeline) soniyalarida, aks holda aytiladi.
 */

var GC_VERSION = "4.4.0";
var GC_TICKS = 254016000000;

/* ======================= yordamchi funksiyalar ======================= */

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

function gc_time(sec) {
    var t = new Time();
    t.seconds = sec;
    return t;
}

function gc_frameDuration(seq) {
    try {
        var fr = seq.getSettings().videoFrameRate;
        if (fr && fr.seconds > 0) return fr.seconds;
    } catch (e) {}
    return 1 / 25;
}

function gc_snap(sec, fd) {
    return Math.round(sec / fd) * fd;
}

function gc_normPath(p) {
    return String(p).replace(/\\/g, "/").toLowerCase();
}

function gc_inArray(arr, v) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true;
    return false;
}

function gc_isLocked(track) {
    try { return !!track.isLocked(); } catch (e) { return false; }
}

function gc_isMuted(track) {
    try { return !!track.isMuted(); } catch (e) { return false; }
}

function gc_itemPath(item) {
    try { return item.projectItem ? gc_normPath(item.projectItem.getMediaPath()) : ""; } catch (e) { return ""; }
}

function gc_seq() {
    var seq = app.project.activeSequence;
    if (!seq) throw new Error("Faol sequence yo'q. Timeline'ni oching.");
    return seq;
}

/* Sequence In/Out va umumiy uzunlik (soniyada) */
function gc_seqRange(seq) {
    var end = parseFloat(seq.end) / GC_TICKS;
    var inS = 0, outS = end;
    try { inS = seq.getInPointAsTime().seconds; } catch (e1) { inS = parseFloat(seq.getInPoint()) || 0; }
    try { outS = seq.getOutPointAsTime().seconds; } catch (e2) { outS = parseFloat(seq.getOutPoint()) || end; }
    if (!(outS > inS) || outS > end) outS = end;
    if (inS < 0 || inS >= outS) inS = 0;
    return { start: inS, end: outS, duration: end };
}

function gc_playhead(seq) {
    try { return seq.getPlayerPosition().seconds; } catch (e) { return 0; }
}

/* Berilgan vaqtda turgan klip (track item) */
function gc_itemAt(track, sec) {
    for (var c = 0; c < track.clips.numItems; c++) {
        var it = track.clips[c];
        if (it.start.seconds <= sec + 1e-4 && it.end.seconds > sec + 1e-4) return it;
    }
    return null;
}

/* Trekdagi klipni boshlanish vaqti bo'yicha topadi (kadr aniqligida) */
function gc_itemByStart(track, start, fd) {
    for (var c = 0; c < track.clips.numItems; c++) {
        var it = track.clips[c];
        if (Math.abs(it.start.seconds - start) <= fd / 2 + 1e-4) return it;
    }
    return gc_itemAt(track, start + fd / 2);
}

function gc_speed(item) {
    var s = 1;
    try { s = Math.abs(item.getSpeed()) || 1; } catch (e) {}
    return s;
}

/* Loyiha ichidan media yo'li bo'yicha elementni qidiradi (oxirgi mosini qaytaradi) */
function gc_findItemByPath(root, target, result) {
    for (var i = 0; i < root.children.numItems; i++) {
        var item = root.children[i];
        if (item.type === ProjectItemType.BIN) {
            gc_findItemByPath(item, target, result);
        } else {
            try {
                if (gc_normPath(item.getMediaPath()) === target) result.item = item;
            } catch (e) {}
        }
    }
}

function gc_importOnce(path) {
    var file = new File(path);
    if (!file.exists) throw new Error("Fayl topilmadi: " + path);
    var found = {};
    gc_findItemByPath(app.project.rootItem, gc_normPath(file.fsName), found);
    if (!found.item) {
        if (!app.project.importFiles([file.fsName], true, app.project.getInsertionBin(), false)) throw new Error("Import qilinmadi: " + file.name);
        gc_findItemByPath(app.project.rootItem, gc_normPath(file.fsName), found);
    }
    if (!found.item) throw new Error("Import qilingan fayl loyihada topilmadi.");
    return found.item;
}

/* ======================= sequence ma'lumoti ======================= */

function gc_ping() {
    return gc_ok({ version: GC_VERSION, host: app.version || "" });
}

function gc_getSequenceInfo() {
    try {
        var seq = gc_seq();
        var r = gc_seqRange(seq);
        var audio = [], sig = [], clipCount = 0;
        for (var a = 0; a < seq.audioTracks.numTracks; a++) {
            var at = seq.audioTracks[a];
            var n = at.clips.numItems;
            clipCount += n;
            var covered = 0;
            for (var c = 0; c < n; c++) {
                var it = at.clips[c];
                covered += it.end.seconds - it.start.seconds;
                sig.push("a" + a + ":" + it.start.seconds.toFixed(3) + "-" + it.end.seconds.toFixed(3));
            }
            audio.push({ index: a, name: at.name || ("Audio " + (a + 1)), clips: n, muted: gc_isMuted(at),
                locked: gc_isLocked(at), coverage: r.duration > 0 ? covered / r.duration : 0 });
        }
        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            var vt = seq.videoTracks[v];
            clipCount += vt.clips.numItems;
            for (var vc = 0; vc < vt.clips.numItems; vc++) {
                sig.push("v" + v + ":" + vt.clips[vc].start.seconds.toFixed(3) + "-" + vt.clips[vc].end.seconds.toFixed(3));
            }
        }
        var w = 1920, h = 1080;
        try { w = seq.frameSizeHorizontal || w; h = seq.frameSizeVertical || h; } catch (eF) {}
        return gc_ok({
            id: String(seq.sequenceID || seq.name),
            name: seq.name,
            duration: r.duration,
            inPoint: r.start,
            outPoint: r.end,
            hasRange: r.start > 0.01 || r.end < r.duration - 0.05,
            fps: 1 / gc_frameDuration(seq),
            width: w,
            height: h,
            playhead: gc_playhead(seq),
            audioTracks: audio,
            videoTracks: seq.videoTracks.numTracks,
            clipCount: clipCount,
            signature: sig.join("|")
        });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= audio eksport ======================= */

function gc_collectEpr(folder, depth, out) {
    if (!folder || !folder.exists || depth < 0) return;
    var items = folder.getFiles();
    for (var i = 0; i < items.length; i++) {
        var f = items[i];
        if (f instanceof Folder) gc_collectEpr(f, depth - 1, out);
        else if (/\.epr$/i.test(f.name)) out.push(f);
    }
}

function gc_findAudioPreset() {
    try {
        var roots = [];
        var appFolder = new Folder(app.path);
        roots.push(new Folder(appFolder.fsName + "/MediaIO/systempresets"));
        roots.push(new Folder(appFolder.fsName + "/Settings"));
        try {
            var ames = appFolder.parent.getFiles("Adobe Media Encoder*");
            for (var m = 0; m < ames.length; m++) roots.push(new Folder(ames[m].fsName + "/MediaIO/systempresets"));
        } catch (eA) {}

        var best = null, bestScore = 0, files = [];
        for (var r = 0; r < roots.length; r++) gc_collectEpr(roots[r], 4, files);
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var name = decodeURI(f.name);
            var parent = f.parent ? decodeURI(f.parent.name) : "";
            var score = 0;
            if (/^57415645/i.test(parent)) score += 10;            // "WAVE" formati papkasi
            if (/waveform|\bwav\b/i.test(name)) score += 8;
            if (score === 0) continue;
            if (/48\s*k/i.test(name)) score += 2;
            if (/16[\s-]*bit/i.test(name)) score += 1;
            if (score > bestScore) { bestScore = score; best = f; }
        }
        return gc_ok({ path: best ? best.fsName : "", scanned: files.length });
    } catch (e) {
        return gc_fail(e.toString());
    }
}

/*
 * Timeline audiosini WAV qilib eksport qiladi. tracks - eksportga kiradigan
 * audio treklar (qolganlari vaqtincha o'chiriladi va keyin qaytariladi).
 */
function gc_exportAudio(outPath, presetPath, tracks, useInOut) {
    var seq = app.project.activeSequence;
    if (!seq) return gc_fail("Faol sequence yo'q.");
    var preset = new File(presetPath);
    if (!preset.exists) return gc_fail("Audio eksport preseti topilmadi: " + presetPath);

    var saved = [];
    try {
        for (var a = 0; a < seq.audioTracks.numTracks; a++) {
            var t = seq.audioTracks[a];
            saved.push(gc_isMuted(t));
            try { t.setMute(gc_inArray(tracks, a) ? 0 : 1); } catch (eM) {}
        }
        var r = gc_seqRange(seq);
        var result = seq.exportAsMediaDirect(outPath, preset.fsName, useInOut ? 1 : 0);
        var out = new File(outPath);
        if (!out.exists) return gc_fail("Premiere audioni eksport qilmadi. " + (result || ""));
        return gc_ok({ path: out.fsName, offset: useInOut ? r.start : 0, end: useInOut ? r.end : r.duration, result: String(result || "") });
    } catch (e) {
        return gc_fail("Eksport xatosi: " + e.toString());
    } finally {
        for (var s = 0; s < saved.length; s++) {
            try { seq.audioTracks[s].setMute(saved[s] ? 1 : 0); } catch (eR) {}
        }
    }
}

/* ======================= subtitr ======================= */

function gc_importSrt(srtPath) {
    try {
        var seq = gc_seq();
        var item = gc_importOnce(srtPath);
        var fmt = (typeof Sequence !== "undefined" && Sequence.CAPTION_FORMAT_SUBTITLE !== undefined)
            ? Sequence.CAPTION_FORMAT_SUBTITLE : undefined;
        var created = (fmt !== undefined) ? seq.createCaptionTrack(item, 0, fmt) : seq.createCaptionTrack(item, 0);
        if (created === false) {
            return gc_fail("Subtitr treki yaratilmadi. SRT loyihaga qo'shildi - uni timeline'ga qo'lda tortib qo'yishingiz mumkin.");
        }
        return gc_ok({ item: item.name });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= MOTION DVIGATELI ======================= */
/*
 * Keyframe vaqti klipning MEDIA vaqtida beriladi (manba faylning boshidan):
 *   media = inPoint + (timeline - start) * tezlik
 * GC_KEY_BASE = "clip" bo'lsa - klip boshidan hisoblanadi (Sozlamalar -> Keyframe rejimi).
 */
var GC_KEY_BASE = "media";

function gc_setKeyBase(mode) {
    GC_KEY_BASE = mode === "clip" ? "clip" : "media";
    return gc_ok({ mode: GC_KEY_BASE });
}

function gc_toKeyTime(item, timelineSec) {
    var local = (timelineSec - item.start.seconds) * gc_speed(item);
    return GC_KEY_BASE === "clip" ? local : item.inPoint.seconds + local;
}

function gc_component(item, matchName, displayNames) {
    for (var i = 0; i < item.components.numItems; i++) {
        var comp = item.components[i];
        if (comp.matchName === matchName) return comp;
        for (var d = 0; d < displayNames.length; d++) if (comp.displayName === displayNames[d]) return comp;
    }
    return null;
}

/*
 * Parametrni nomi bo'yicha topadi. Motion: Position(0) Scale(1) ScaleWidth(2)
 * UniformScale(3) Rotation(4) AnchorPoint(5). Opacity: Opacity(0).
 */
function gc_param(item, prop) {
    if (prop === "opacity") {
        var op = gc_component(item, "AE.ADBE Opacity", ["Opacity", "\u041D\u0435\u043F\u0440\u043E\u0437\u0440\u0430\u0447\u043D\u043E\u0441\u0442\u044C", "Deckkraft", "Opacit\u00E9"]);
        return op && op.properties.numItems ? op.properties[0] : null;
    }
    var motion = gc_component(item, "AE.ADBE Motion", ["Motion", "\u0414\u0432\u0438\u0436\u0435\u043D\u0438\u0435", "Bewegung", "Trajectoire", "Movimiento"]);
    if (!motion) return null;
    var idx = { position: 0, scale: 1, rotation: 4, anchor: 5 }[prop];
    if (idx === undefined || motion.properties.numItems <= idx) return null;
    return motion.properties[idx];
}

function gc_readValue(param, keyTime) {
    try {
        if (param.isTimeVarying()) {
            var keys = param.getKeys();
            if (keys && keys.length) return param.getValueAtTime(gc_time(keyTime));
        }
    } catch (e) {}
    return param.getValue();
}

function gc_setKey(param, sec, value) {
    var t = gc_time(sec);
    try {
        param.addKey(t);
        param.setValueAtKey(t, value, true);
    } catch (e) {
        param.addKey(sec);
        param.setValueAtKey(sec, value, true);
    }
}

/* Oraliqdagi eski keyframe'larni olib tashlaydi (yangi animatsiya ustma-ust tushmasin) */
function gc_clearKeys(param, from, to) {
    try {
        if (!param.isTimeVarying()) return;
        var keys = param.getKeys();
        if (!keys || !keys.length) {
            // Animatsiya yoqilgan, lekin keyframe yo'q - statik qiymatga qaytaramiz
            param.setTimeVarying(false);
            return;
        }
        try { param.removeKeyRange(gc_time(from - 0.0005), gc_time(to + 0.0005), false); return; } catch (eR) {}
        for (var i = keys.length - 1; i >= 0; i--) {
            var ks = keys[i].seconds !== undefined ? keys[i].seconds : Number(keys[i]);
            if (ks >= from - 0.0005 && ks <= to + 0.0005) { try { param.removeKey(keys[i], false); } catch (eK) {} }
        }
    } catch (e) {}
}

function gc_combine(prop, base, v, mode) {
    if (mode !== "rel") return v;
    if (prop === "position" || prop === "anchor") return [base[0] + v[0], base[1] + v[1]];
    if (prop === "rotation") return Number(base) + v;
    return Number(base) * v / 100; // scale, opacity - foizda
}

/*
 * Umumiy motion funksiyasi.
 * ops = [{track: videoTrekIndeksi, start: klipBoshi, prop: "scale"|"position"|"rotation"|"opacity"|"anchor",
 *         mode: "rel"|"abs", keys: [[timelineSoniya, qiymat], ...]}]
 * rel: scale/opacity - hozirgi qiymatga nisbatan foiz; rotation - graduslar qo'shiladi;
 *      position/anchor - [dx, dy] kadr ulushida (0.1 = kadr enining 10%).
 * abs: to'g'ridan-to'g'ri qiymat (position - [x, y] kadr ulushida, markaz [0.5, 0.5]).
 */
function gc_motionCore(ops) {
    var seq = gc_seq();
    var fd = gc_frameDuration(seq);
    var applied = 0, keysSet = 0, errors = [];
    for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        try {
            if (op.track < 0 || op.track >= seq.videoTracks.numTracks) throw new Error("V" + (op.track + 1) + " trek yo'q");
            var track = seq.videoTracks[op.track];
            if (gc_isLocked(track)) throw new Error("V" + (op.track + 1) + " qulflangan");
            var item = gc_itemByStart(track, op.start, fd);
            if (!item) throw new Error("klip topilmadi (V" + (op.track + 1) + ", " + op.start.toFixed(2) + "s)");
            var param = gc_param(item, op.prop);
            if (!param) throw new Error(op.prop + " parametri topilmadi");
            if (param.areKeyframesSupported && !param.areKeyframesSupported()) throw new Error(op.prop + " uchun keyframe yo'q");

            var keys = op.keys.slice(0).sort(function (a, b) { return a[0] - b[0]; });
            var lo = item.start.seconds, hi = item.end.seconds - fd / 2;
            var list = [];
            for (var k = 0; k < keys.length; k++) {
                var tt = Math.max(lo, Math.min(hi, keys[k][0]));
                list.push([gc_toKeyTime(item, tt), keys[k][1]]);
            }
            if (!list.length) continue;
            var base = gc_readValue(param, list[0][0]);
            if (base instanceof Array) base = [Number(base[0]), Number(base[1])];
            gc_clearKeys(param, list[0][0], list[list.length - 1][0]);
            if (!param.isTimeVarying()) param.setTimeVarying(true);
            for (var q = 0; q < list.length; q++) {
                gc_setKey(param, list[q][0], gc_combine(op.prop, base, list[q][1], op.mode));
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
        var r = gc_motionCore(ops);
        if (!r.applied && r.errors.length) return gc_fail("Motion qo'llanmadi: " + r.errors.join("; "));
        return gc_ok(r);
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* Klip(lar)ning motion animatsiyasini tozalaydi va standart qiymatlarga qaytaradi */
function gc_resetMotion(targets) {
    try {
        var seq = gc_seq();
        var fd = gc_frameDuration(seq), done = 0;
        var defaults = { scale: 100, rotation: 0, opacity: 100, position: [0.5, 0.5] };
        for (var i = 0; i < targets.length; i++) {
            var item = gc_itemByStart(seq.videoTracks[targets[i][0]], targets[i][1], fd);
            if (!item) continue;
            var props = ["scale", "position", "rotation", "opacity"];
            for (var p = 0; p < props.length; p++) {
                var param = gc_param(item, props[p]);
                if (!param) continue;
                try { if (param.isTimeVarying()) param.setTimeVarying(false); } catch (eT) {}
                try { param.setValue(defaults[props[p]], true); } catch (eV) {}
            }
            done++;
        }
        return gc_ok({ reset: done });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/*
 * Tahrir konteksti: tanlangan video klip(lar) yoki playhead ostidagi eng yuqori klip,
 * ularning hozirgi motion qiymatlari. Claude va tezkor harakatlar shundan foydalanadi.
 */
function gc_clipInfo(item, trackIndex) {
    var info = { track: trackIndex, start: item.start.seconds, end: item.end.seconds, name: item.name,
        inPoint: item.inPoint.seconds, speed: gc_speed(item), path: "" };
    try { info.path = item.projectItem ? item.projectItem.getMediaPath() : ""; } catch (eP) {}
    var props = ["scale", "position", "rotation", "opacity"];
    for (var p = 0; p < props.length; p++) {
        try {
            var param = gc_param(item, props[p]);
            if (!param) continue;
            var v = gc_readValue(param, gc_toKeyTime(item, item.start.seconds));
            info[props[p]] = v instanceof Array ? [Number(v[0]), Number(v[1])] : Number(v);
            info[props[p] + "Animated"] = !!param.isTimeVarying();
        } catch (eV) {}
    }
    return info;
}

function gc_getEditContext() {
    try {
        var seq = gc_seq();
        var clips = [];
        for (var v = seq.videoTracks.numTracks - 1; v >= 0; v--) {
            var track = seq.videoTracks[v];
            for (var c = 0; c < track.clips.numItems; c++) {
                var it = track.clips[c];
                if (it.isSelected && it.isSelected()) clips.push(gc_clipInfo(it, v));
            }
        }
        var ph = gc_playhead(seq), source = "selection";
        if (!clips.length) {
            for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
                if (gc_isLocked(seq.videoTracks[t])) continue;
                var at = gc_itemAt(seq.videoTracks[t], ph);
                if (at) { clips.push(gc_clipInfo(at, t)); source = "playhead"; break; }
            }
        }
        clips.sort(function (a, b) { return a.start - b.start; });
        var w = 1920, h = 1080;
        try { w = seq.frameSizeHorizontal || w; h = seq.frameSizeVertical || h; } catch (eF) {}
        return gc_ok({ clips: clips, source: clips.length ? source : "none", playhead: ph,
            fps: 1 / gc_frameDuration(seq), width: w, height: h, name: seq.name, id: String(seq.sequenceID || seq.name) });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/*
 * Montaj bo'limidagi AI zoom (urg'uli gaplar).
 * zooms = [[timelineVaqt, masshtabFoiz, ushlabTurishSoniya], ...], speech = nutq audio treklari
 */
function gc_applyZooms(zooms, speech) {
    try {
        var seq = gc_seq();
        var fd = gc_frameDuration(seq);
        var ramp = 0.35, ops = [], skipped = 0;
        zooms.sort(function (a, b) { return a[0] - b[0]; });
        for (var i = 0; i < zooms.length; i++) {
            var t0 = zooms[i][0];
            var pct = Math.max(102, Math.min(160, zooms[i][1]));
            var hold = Math.max(0.5, Math.min(8, zooms[i][2]));

            // Shu vaqtda gapirayotgan odamning fayli - o'sha fayldagi videoni zoom qilamiz
            var speakerPath = "";
            for (var s = 0; s < speech.length && !speakerPath; s++) {
                if (speech[s] >= seq.audioTracks.numTracks) continue;
                var ai = gc_itemAt(seq.audioTracks[speech[s]], t0);
                if (ai) speakerPath = gc_itemPath(ai);
            }
            var target = null, fallback = null, tIndex = -1, fIndex = -1;
            for (var v = 0; v < seq.videoTracks.numTracks; v++) {
                var vt = seq.videoTracks[v];
                if (gc_isLocked(vt)) continue;
                var vi = gc_itemAt(vt, t0);
                if (!vi) continue;
                if (!fallback) { fallback = vi; fIndex = v; }
                if (speakerPath && gc_itemPath(vi) === speakerPath) { target = vi; tIndex = v; break; }
            }
            if (!target) { target = fallback; tIndex = fIndex; }
            if (!target) { skipped++; continue; }
            var t3 = Math.min(t0 + ramp + hold + ramp, target.end.seconds - fd);
            if (t3 - t0 < 0.3) { skipped++; continue; }
            var r = Math.min(ramp, (t3 - t0) / 3);
            ops.push({ track: tIndex, start: target.start.seconds, prop: "scale", mode: "rel",
                keys: [[t0, 100], [t0 + r, pct], [t3 - r, pct], [t3, 100]] });
        }
        if (!ops.length) return gc_ok({ applied: 0, skipped: skipped });
        var res = gc_motionCore(ops);
        if (!res.applied && res.errors.length) return gc_fail("Zoom qo'llanmadi: " + res.errors.join("; "));
        return gc_ok({ applied: res.applied, skipped: skipped + (ops.length - res.applied), errors: res.errors });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= kesish (ripple delete) ======================= */

function gc_applyCuts(ranges, speech) {
    try {
        var seq = gc_seq();
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return gc_fail("QE sequence topilmadi.");

        var fd = gc_frameDuration(seq);
        var settings = seq.getSettings();
        var vTracks = [], aTracks = [];
        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            if (!gc_isLocked(seq.videoTracks[v]) && seq.videoTracks[v].clips.numItems > 0) vTracks.push(v);
        }
        for (var s = 0; s < speech.length; s++) {
            var ai = speech[s];
            if (ai < seq.audioTracks.numTracks && !gc_isLocked(seq.audioTracks[ai])) aTracks.push(ai);
        }
        if (!aTracks.length && !vTracks.length) return gc_fail("Kesish uchun ochiq trek yo'q (hammasi qulflangan).");

        var list = [];
        for (var i = 0; i < ranges.length; i++) {
            var rs = gc_snap(ranges[i][0], fd), re = gc_snap(ranges[i][1], fd);
            if (re - rs >= fd * 2) list.push([rs, re]);
        }
        list.sort(function (a, b) { return b[0] - a[0]; }); // oxiridan boshiga
        if (!list.length) return gc_ok({ applied: 0 });

        function razorAt(sec) {
            var tc = gc_time(sec).getFormatted(settings.videoFrameRate, settings.videoDisplayFormat);
            for (var x = 0; x < vTracks.length; x++) qeSeq.getVideoTrackAt(vTracks[x]).razor(tc);
            for (var y = 0; y < aTracks.length; y++) qeSeq.getAudioTrackAt(aTracks[y]).razor(tc);
        }

        function removeRange(tracks, idxs, s0, e0) {
            for (var n = 0; n < idxs.length; n++) {
                var track = tracks[idxs[n]];
                for (var c = track.clips.numItems - 1; c >= 0; c--) {
                    var it = track.clips[c];
                    if (it.start.seconds >= s0 - fd / 2 && it.end.seconds <= e0 + fd / 2) it.remove(true, true);
                }
            }
        }

        for (var r = 0; r < list.length; r++) {
            razorAt(list[r][1]);
            razorAt(list[r][0]);
        }
        var removed = 0;
        for (var k = 0; k < list.length; k++) {
            removeRange(seq.videoTracks, vTracks, list[k][0], list[k][1]);
            removeRange(seq.audioTracks, aTracks, list[k][0], list[k][1]);
            removed += list[k][1] - list[k][0];
        }
        return gc_ok({ applied: list.length, seconds: removed });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= playhead ======================= */

function gc_setPlayhead(sec) {
    try {
        var seq = gc_seq();
        seq.setPlayerPosition(String(Math.round(Math.max(0, sec) * GC_TICKS)));
        return gc_ok({});
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= sound effektlar ======================= */

function gc_trackFree(track, from, to) {
    for (var i = 0; i < track.clips.numItems; i++) {
        var c = track.clips[i];
        if (c.start.seconds < to - 1e-3 && c.end.seconds > from + 1e-3) return false;
    }
    return true;
}

/* Yangi audio trek qo'shadi (QE). Muvaffaqiyatli bo'lsa indeksini qaytaradi, aks holda -1 */
function gc_addAudioTrack(seq) {
    var before = seq.audioTracks.numTracks;
    try {
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        // addTracks(videoSoni, videoJoyi, audioSoni, audioTuri(1=stereo), audioJoyi)
        qseq.addTracks(0, seq.videoTracks.numTracks, 1, 1, before);
    } catch (e) {}
    return seq.audioTracks.numTracks > before ? seq.audioTracks.numTracks - 1 : -1;
}

/*
 * Audio effektni timeline'ga qo'yadi.
 * trackIndex = -1 -> avtomatik: nutq treklaridan tashqaridagi birinchi bo'sh audio trek,
 *                    bo'lmasa yangi trek yaratiladi. at < 0 -> playhead joyi.
 */
function gc_insertSound(filePath, trackIndex, at, avoid) {
    try {
        var seq = gc_seq();
        var item = gc_importOnce(filePath);
        var time = at >= 0 ? at : gc_playhead(seq);
        var duration = 0;
        try { duration = item.getOutPoint().seconds - item.getInPoint().seconds; } catch (eD) {}
        if (!(duration > 0)) { try { duration = item.getOutPoint(2).seconds - item.getInPoint(2).seconds; } catch (eD2) {} }
        if (!(duration > 0)) duration = 1;
        avoid = avoid || [];

        var idx = -1;
        if (trackIndex >= 0) {
            if (trackIndex >= seq.audioTracks.numTracks) return gc_fail("A" + (trackIndex + 1) + " audio trek mavjud emas.");
            var chosen = seq.audioTracks[trackIndex];
            if (gc_isLocked(chosen)) return gc_fail("A" + (trackIndex + 1) + " qulflangan.");
            if (!gc_trackFree(chosen, time, time + duration)) return gc_fail("A" + (trackIndex + 1) + " da bu joy band. Avtomatik trekni tanlang.");
            idx = trackIndex;
        } else {
            for (var a = 0; a < seq.audioTracks.numTracks; a++) {
                var tr = seq.audioTracks[a];
                if (gc_inArray(avoid, a) || gc_isLocked(tr)) continue;
                if (gc_trackFree(tr, time, time + duration)) { idx = a; break; }
            }
            if (idx < 0) idx = gc_addAudioTrack(seq);
            if (idx < 0) return gc_fail("Bo'sh audio trek yo'q. Premiere'da yangi audio trek qo'shing.");
        }
        var track = seq.audioTracks[idx];
        var before = track.clips.numItems;
        track.overwriteClip(item, String(Math.round(time * GC_TICKS)));
        if (track.clips.numItems <= before) return gc_fail("Effekt joylashtirilgani tasdiqlanmadi.");
        return gc_ok({ name: item.name, track: idx, at: time, duration: duration });
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* ======================= kadr eksporti (Claude, Flow) ======================= */

/*
 * Berilgan timeline vaqtlaridagi kadrlarni PNG qilib eksport qiladi.
 * base - fayl nomi boshi (".png" QE tomonidan qo'shiladi). Playhead joyi tiklanadi.
 */
function gc_exportFrames(base, times) {
    var seq = app.project.activeSequence;
    if (!seq) return gc_fail("Faol sequence yo'q.");
    var saved = null;
    try { saved = seq.getPlayerPosition(); } catch (eS) {}
    var files = [];
    try {
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        if (!qseq || !qseq.exportFramePNG) return gc_fail("Bu Premiere versiyasida kadr eksporti mavjud emas.");
        for (var i = 0; i < times.length; i++) {
            seq.setPlayerPosition(String(Math.round(Math.max(0, times[i]) * GC_TICKS)));
            var name = base + "_" + i;
            qseq.exportFramePNG(qseq.CTI.timecode, new File(name).fsName);
            var f = new File(name + ".png");
            if (f.exists) files.push(f.fsName);
        }
        return gc_ok({ files: files });
    } catch (e) {
        return gc_fail("Kadr eksporti: " + (e.message || e.toString()));
    } finally {
        try { if (saved) seq.setPlayerPosition(String(saved.ticks)); } catch (eR) {}
    }
}

/* Flow / Veo uchun joriy playhead kadri */
function gc_flowCapture(frameBase) {
    try {
        var seq = gc_seq();
        if (!frameBase || /[\r\n]/.test(frameBase)) return gc_fail("PNG yo'li noto'g'ri.");
        var target = new File(frameBase + ".png");
        if (!target.parent.exists) return gc_fail("Vaqtinchalik papka topilmadi.");
        var position = seq.getPlayerPosition();
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        if (!qseq || !qseq.exportFramePNG) return gc_fail("Bu Premiere versiyasida PNG eksporti mavjud emas.");
        qseq.exportFramePNG(qseq.CTI.timecode, new File(frameBase).fsName);
        if (!target.exists) return gc_fail("Kadr saqlanmadi.");
        var w = 1920, h = 1080;
        try { w = seq.frameSizeHorizontal || w; h = seq.frameSizeVertical || h; } catch (eF) {}
        return gc_ok({
            sequenceID: String(seq.sequenceID), sequenceName: seq.name,
            projectPath: String(app.project.path || ""), ticks: String(position.ticks),
            seconds: Number(position.seconds), frame: target.fsName, width: w, height: h
        });
    } catch (e) { return gc_fail("Kadr eksporti: " + (e.message || e.toString())); }
}

function gc_flowAlreadyPlaced(seq, sourcePath) {
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
        var clips = seq.videoTracks[v].clips;
        for (var c = 0; c < clips.numItems; c++) {
            if (gc_itemPath(clips[c]) === gc_normPath(sourcePath)) return true;
        }
    }
    return false;
}

/*
 * Tayyor MP4'ni yangi yuqori video trekka (faqat video, audiosiz) qo'yadi.
 * Kadr olingan sequence/loyiha tekshiriladi - boshqa joyga jimgina qo'yilmaydi.
 */
function gc_flowImport(filePath, sequenceID, ticks, projectPath, useCurrent) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol timeline yo'q. Video diskda saqlangan.");
        if (sequenceID && String(seq.sequenceID) !== String(sequenceID)) return gc_fail("Kadr olingan timeline'ni qayta oching, so'ng importni qayta bosing.");
        if (projectPath && String(app.project.path || "") !== projectPath) return gc_fail("Kadr olingan loyiha o'zgargan. Asl loyihani oching.");
        var file = new File(filePath);
        if (!file.exists || !/\.mp4$/i.test(file.name)) return gc_fail("MP4 fayl topilmadi.");
        if (gc_flowAlreadyPlaced(seq, file.fsName)) return gc_ok({ alreadyPlaced: true });
        var at = useCurrent ? seq.getPlayerPosition() : new Time();
        if (!useCurrent) {
            if (!/^\d+$/.test(String(ticks))) return gc_fail("Timeline vaqti noto'g'ri.");
            at.ticks = String(ticks);
        }
        var item = gc_importOnce(file.fsName);
        // Faqat video subklip - generatsiya audiosi nutq/musiqani bosib ketmasin
        var inTime = item.getInPoint(1), outTime = item.getOutPoint(1);
        if (!outTime || outTime.seconds <= inTime.seconds) return gc_fail("Video davomiyligi aniqlanmadi. MP4 Project'da saqlandi.");
        var videoOnly = item.createSubClip("AI \u00B7 " + file.name, String(inTime.ticks), String(outTime.ticks), 1, 1, 0) || item;
        var count = seq.videoTracks.numTracks;
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        if (!qseq || !qseq.addTracks) return gc_fail("Yangi video trek yaratilmadi. MP4 Project'da saqlandi.");
        qseq.addTracks(1, count, 0);
        if (seq.videoTracks.numTracks !== count + 1) return gc_fail("Yangi trek tasdiqlanmadi. MP4 Project'da saqlandi.");
        var track = seq.videoTracks[count];
        track.overwriteClip(videoOnly, String(at.ticks));
        if (track.clips.numItems !== 1) return gc_fail("Timeline importi tasdiqlanmadi. MP4 Project'da saqlandi.");
        return gc_ok({ track: count + 1, seconds: track.clips[0].start.seconds, name: file.name });
    } catch (e) { return gc_fail("Import: " + (e.message || e.toString()) + ". Yuklangan MP4 saqlangan."); }
}

/* ======================= animatsion matn (PNG ketma-ketligi) ======================= */

function gc_isTextPath(p) {
    return /geminicut\/+matn\//.test(gc_normPath(p));
}

/* "GeminiCut Matn" bin'ini topadi yoki yaratadi */
function gc_textBin() {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var c = root.children[i];
        if (c.type === ProjectItemType.BIN && c.name === "GeminiCut Matn") return c;
    }
    var b = root.createBin("GeminiCut Matn");
    return b || root;
}

/* Matn uchun video trek: o'sha vaqtdagi kliplardan yuqorida, bo'sh; bo'lmasa yangi trek (QE) */
function gc_overlayTrack(seq, from, to) {
    var top = -1, v;
    for (v = 0; v < seq.videoTracks.numTracks; v++) {
        if (!gc_trackFree(seq.videoTracks[v], from, to)) top = v;
    }
    for (v = top + 1; v < seq.videoTracks.numTracks; v++) {
        if (!gc_isLocked(seq.videoTracks[v]) && gc_trackFree(seq.videoTracks[v], from, to)) return v;
    }
    var count = seq.videoTracks.numTracks;
    try {
        app.enableQE();
        qe.project.getActiveSequence().addTracks(1, count, 0);
    } catch (e) {}
    return seq.videoTracks.numTracks > count ? count : -1;
}

/*
 * gc_0000.png ... ketma-ketligini bitta klip qilib import qiladi va timeline'ga qo'yadi.
 * at < 0 -> playhead. replace = { track, start } (yoki null) - eski matn o'rniga.
 */
function gc_importSequence(first, count, fps, at, replace, name) {
    try {
        var seq = gc_seq();
        var file = new File(first);
        if (!file.exists) return gc_fail("Kadrlar topilmadi: " + first);
        var bin = gc_textBin();
        if (!app.project.importFiles([file.fsName], true, bin, true)) return gc_fail("PNG ketma-ketligi import qilinmadi.");
        var found = {};
        gc_findItemByPath(bin, gc_normPath(file.fsName), found);
        if (!found.item) gc_findItemByPath(app.project.rootItem, gc_normPath(file.fsName), found);
        if (!found.item) return gc_fail("Import qilingan matn loyihada topilmadi.");
        var item = found.item;
        try { item.setOverrideFrameRate(fps); } catch (eF) {}
        try { if (name) item.name = name; } catch (eN) {}
        var dur = count / fps;
        var time = at >= 0 ? at : gc_playhead(seq);
        var idx = -1;
        if (replace && replace.track >= 0 && replace.track < seq.videoTracks.numTracks) {
            idx = replace.track;
            var old = gc_itemByStart(seq.videoTracks[idx], replace.start, gc_frameDuration(seq));
            if (old) {
                time = old.start.seconds;
                old.remove(false, false);
            }
        } else {
            idx = gc_overlayTrack(seq, time, time + dur);
        }
        if (idx < 0) return gc_fail("Bo'sh video trek yo'q. Premiere'da yangi video trek qo'shing.");
        var track = seq.videoTracks[idx];
        var before = track.clips.numItems;
        track.overwriteClip(item, String(Math.round(time * GC_TICKS)));
        if (track.clips.numItems < before || track.clips.numItems === 0) return gc_fail("Matn joylashtirilgani tasdiqlanmadi. U Project'da (GeminiCut Matn).");
        return gc_ok({ track: idx, seconds: time, duration: dur });
    } catch (e) {
        return gc_fail("Matn: " + (e.message || e.toString()));
    }
}

/* Playhead ostidagi GeminiCut matni (tahrirlash uchun) */
function gc_textAtPlayhead() {
    try {
        var seq = gc_seq();
        var ph = gc_playhead(seq);
        for (var v = seq.videoTracks.numTracks - 1; v >= 0; v--) {
            var it = gc_itemAt(seq.videoTracks[v], ph);
            if (!it || !it.projectItem) continue;
            var p = "";
            try { p = it.projectItem.getMediaPath(); } catch (eP) {}
            if (p && gc_isTextPath(p)) return gc_ok({ track: v, start: it.start.seconds, end: it.end.seconds, path: p });
        }
        return gc_fail("Playhead ostida GeminiCut matni yo'q. Playhead'ni matn ustiga qo'ying.");
    } catch (e) {
        return gc_fail(e.message || e.toString());
    }
}

/* Rang berish (LUT) hozircha faqat DaVinci Resolve versiyasida */
function gc_colorTargets() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
function gc_applyGrade() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
function gc_revertGrade() { return gc_fail("Rang berish DaVinci Resolve versiyasida ishlaydi."); }
