/*
 * GeminiCut 3.0 - Premiere Pro ExtendScript tomoni (host).
 *
 * Ish tamoyili: plagin asl video fayllarni hech qayerga yubormaydi.
 * Premiere o'zi timeline'ning audiosini (eshitilganidek: kesishlar, In/Out,
 * faqat tanlangan nutq treklari) WAV qilib eksport qiladi; panel shu audioni
 * tahlil qiladi va natijani timeline vaqtida qaytaradi.
 *
 * Muhim: ExtendScript ES3 - JSON, forEach, let/const yo'q. Javoblar gc_json()
 * bilan qo'lda yig'iladi; panel faqat raqam, satr va massiv yuboradi.
 * Barcha vaqtlar - sequence (timeline) soniyalarida.
 */

var GC_VERSION = "3.0.0";
var GC_TICKS = 254016000000;

/* ---------------- yordamchi funksiyalar ---------------- */

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

/* ---------------- panel chaqiradigan funksiyalar ---------------- */

function gc_ping() {
    return gc_ok({ version: GC_VERSION, host: app.version || "" });
}

/* Faol sequence haqida: nom, uzunlik, In/Out, audio treklar, timeline "imzosi" */
function gc_getSequenceInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q. Timeline'ni oching.");
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
        return gc_ok({
            id: seq.sequenceID || seq.name,
            name: seq.name,
            duration: r.duration,
            inPoint: r.start,
            outPoint: r.end,
            hasRange: r.start > 0.01 || r.end < r.duration - 0.05,
            fps: 1 / gc_frameDuration(seq),
            audioTracks: audio,
            videoTracks: seq.videoTracks.numTracks,
            clipCount: clipCount,
            signature: sig.join("|")
        });
    } catch (e) {
        return gc_fail(e.toString());
    }
}

/* Premiere/AME ichidan audio (WAV) eksport presetini qidiradi */
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
 * Timeline audiosini WAV qilib eksport qiladi.
 * tracks  - eksportga kiradigan audio trek indekslari (qolganlari vaqtincha o'chiriladi)
 * useInOut - true bo'lsa faqat In..Out oralig'i
 * Trek holatlari (mute) har qanday holatda asl holiga qaytariladi.
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

/* SRT (timeline vaqtida) faylni import qilib, sequence'ga subtitr treki qo'shadi */
function gc_importSrt(srtPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q.");
        var f = new File(srtPath);
        if (!f.exists) return gc_fail("SRT fayl topilmadi: " + srtPath);

        var ok = app.project.importFiles([f.fsName], true, app.project.getInsertionBin(), false);
        if (!ok) return gc_fail("SRT faylni import qilib bo'lmadi.");

        var res = {};
        gc_findItemByPath(app.project.rootItem, gc_normPath(f.fsName), res);
        if (!res.item) return gc_fail("Import qilingan SRT loyihadan topilmadi.");

        var fmt = (typeof Sequence !== "undefined" && Sequence.CAPTION_FORMAT_SUBTITLE !== undefined)
            ? Sequence.CAPTION_FORMAT_SUBTITLE : undefined;
        var created = (fmt !== undefined)
            ? seq.createCaptionTrack(res.item, 0, fmt)
            : seq.createCaptionTrack(res.item, 0);
        if (created === false) {
            return gc_fail("Subtitr treki yaratilmadi. SRT loyihaga qo'shildi - uni timeline'ga qo'lda tortib qo'yishingiz mumkin.");
        }
        return gc_ok({ item: res.item.name });
    } catch (e) {
        return gc_fail(e.toString());
    }
}

/* Motion > Scale parametrini topadi (lokalizatsiyadan qat'i nazar) */
function gc_findScaleParam(clip) {
    var motion = null;
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i];
        if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "Motion") {
            motion = comp;
            break;
        }
    }
    if (!motion) return null;
    var names = { "Scale": 1, "\u041C\u0430\u0441\u0448\u0442\u0430\u0431": 1, "Skalierung": 1, "\u00C9chelle": 1, "Escala": 1, "Scala": 1 };
    for (var p = 0; p < motion.properties.numItems; p++) {
        if (names[motion.properties[p].displayName]) return motion.properties[p];
    }
    // Standart tartib: Position(0), Scale(1)
    return motion.properties.numItems > 1 ? motion.properties[1] : null;
}

function gc_setKey(param, sec, value) {
    var t = gc_time(sec);
    try {
        param.addKeyframe(t);
        param.setValueAtKey(t, value, true);
    } catch (e) {
        param.addKeyframe(sec);
        param.setValueAtKey(sec, value, true);
    }
}

/* Berilgan vaqtda turgan klip (track item) */
function gc_itemAt(track, sec) {
    for (var c = 0; c < track.clips.numItems; c++) {
        var it = track.clips[c];
        if (it.start.seconds <= sec + 1e-4 && it.end.seconds > sec + 1e-4) return it;
    }
    return null;
}

/*
 * Zoom (punch-in) keyframe'lari.
 * zooms  = [[timelineVaqt, masshtabFoiz, ushlabTurishSoniya], ...]
 * speech = nutq audio treklari - gapirayotgan odamning videosini topish uchun
 */
function gc_applyZooms(zooms, speech) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q.");
        var ramp = 0.35, applied = 0, skipped = 0, bases = {};
        zooms.sort(function (a, b) { return a[0] - b[0]; });

        for (var i = 0; i < zooms.length; i++) {
            var t0 = zooms[i][0];
            var pct = Math.max(102, Math.min(160, zooms[i][1]));
            var hold = Math.max(0.5, Math.min(8, zooms[i][2]));
            var t3 = t0 + ramp + hold + ramp;

            // Shu vaqtda gapirayotgan audio qaysi fayldan - o'sha fayldagi videoni zoom qilamiz
            var speakerPath = "";
            for (var s = 0; s < speech.length && !speakerPath; s++) {
                if (speech[s] >= seq.audioTracks.numTracks) continue;
                var ai = gc_itemAt(seq.audioTracks[speech[s]], t0);
                if (ai) speakerPath = gc_itemPath(ai);
            }
            var target = null, fallback = null;
            for (var v = 0; v < seq.videoTracks.numTracks; v++) {
                var vt = seq.videoTracks[v];
                if (gc_isLocked(vt)) continue;
                var vi = gc_itemAt(vt, t0);
                if (!vi) continue;
                if (!fallback) fallback = vi;
                if (speakerPath && gc_itemPath(vi) === speakerPath) { target = vi; break; }
            }
            target = target || fallback;
            if (!target || t3 > target.end.seconds) { skipped++; continue; }

            var scale = gc_findScaleParam(target);
            if (!scale || !scale.areKeyframesSupported()) { skipped++; continue; }
            var key = target.nodeId || (target.start.seconds + ":" + target.end.seconds);
            if (bases[key] === undefined) {
                var b = 100;
                try { b = Number(scale.getValue()) || 100; } catch (eV) {}
                bases[key] = b;
                if (!scale.isTimeVarying()) scale.setTimeVarying(true);
            }
            var base = bases[key];
            var peak = base * pct / 100;
            // Keyframe vaqti - klipning media vaqtida
            var m0 = target.inPoint.seconds + (t0 - target.start.seconds);
            gc_setKey(scale, m0, base);
            gc_setKey(scale, m0 + ramp, peak);
            gc_setKey(scale, m0 + ramp + hold, peak);
            gc_setKey(scale, m0 + ramp + hold + ramp, base);
            applied++;
        }
        return gc_ok({ applied: applied, skipped: skipped });
    } catch (e) {
        return gc_fail(e.toString());
    }
}

/*
 * Timeline'dagi oraliqlarni kesib, ripple delete qiladi.
 * ranges = [[boshi, oxiri], ...] - timeline soniyalarida
 * speech = nutq audio treklari. Barcha qulflanmagan video treklar va shu audio
 * treklar birga kesiladi (sinxron saqlanadi). Qolgan treklar (musiqa) tegilmaydi.
 */
function gc_applyCuts(ranges, speech) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q.");
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
        return gc_fail(e.toString());
    }
}

/* Timeline ko'rsatkichini (playhead) berilgan soniyaga o'tkazadi */
function gc_setPlayhead(sec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q.");
        seq.setPlayerPosition(String(Math.round(Math.max(0, sec) * GC_TICKS)));
        return gc_ok({});
    } catch (e) {
        return gc_fail(e.toString());
    }
}
