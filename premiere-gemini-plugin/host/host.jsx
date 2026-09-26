/*
 * GeminiCut 2.0 - Premiere Pro ExtendScript tomoni (host).
 *
 * Muhim: ExtendScript ES3 dvigatelida ishlaydi - JSON, Array.forEach,
 * let/const va arrow funksiyalar YO'Q. Panel bilan ma'lumot almashish
 * faqat raqamlar va fayl yo'llari orqali bo'ladi, javob esa gc_json()
 * yordamida qo'lda yig'ilgan JSON satr sifatida qaytariladi.
 *
 * Vaqtlar haqida:
 *   media vaqti    - video faylning o'zidagi soniya (Gemini shu vaqtni qaytaradi)
 *   timeline vaqti - sequence ichidagi soniya
 *   timeline = clip.start + (media - clip.inPoint)
 */

var GC_VERSION = "2.0.0";

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

/* Tanlangan video klipni va uning track indeksini topadi */
function gc_findSelected(seq) {
    var tracks = seq.videoTracks;
    for (var t = 0; t < tracks.numTracks; t++) {
        var track = tracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (clip.isSelected && clip.isSelected() && clip.projectItem) {
                return { clip: clip, trackIndex: t };
            }
        }
    }
    return null;
}

/* ---------------- panel chaqiradigan funksiyalar ---------------- */

function gc_ping() {
    return gc_ok({ version: GC_VERSION, host: app.version || "" });
}

/* Timeline'da tanlangan klip haqida ma'lumot */
function gc_getSelectedClip() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q. Avval sequence oching.");
        var found = gc_findSelected(seq);
        if (!found) return gc_fail("Timeline'da video klipni bosib tanlang.");
        var clip = found.clip;
        var path = clip.projectItem.getMediaPath();
        if (!path) return gc_fail("Bu klipning media fayli topilmadi (nested sequence yoki grafika bo'lishi mumkin).");
        return gc_ok({
            path: path,
            name: clip.name,
            start: clip.start.seconds,
            end: clip.end.seconds,
            inPoint: clip.inPoint.seconds,
            outPoint: clip.outPoint.seconds,
            trackIndex: found.trackIndex,
            fps: 1 / gc_frameDuration(seq),
            sequence: seq.name
        });
    } catch (e) {
        return gc_fail(e.toString());
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

/*
 * SRT faylni loyihaga import qiladi va faol sequence'ga subtitr treki
 * sifatida qo'shadi. SRT ichidagi vaqtlar allaqachon timeline vaqtida.
 */
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

/*
 * Zoom (punch-in) keyframe'lari.
 * zooms = [[mediaVaqt, masshtabFoiz, ushlabTurishSoniya], ...]
 * Masshtab klipning hozirgi Scale qiymatiga nisbatan foizda (masalan 115).
 */
function gc_applyZooms(zooms) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q.");
        var found = gc_findSelected(seq);
        if (!found) return gc_fail("Timeline'da klipni tanlang.");
        var clip = found.clip;
        var scale = gc_findScaleParam(clip);
        if (!scale) return gc_fail("Motion > Scale parametri topilmadi.");
        if (!scale.areKeyframesSupported()) return gc_fail("Scale uchun keyframe qo'llab-quvvatlanmaydi.");

        var base = 100;
        try { base = Number(scale.getValue()) || 100; } catch (e0) {}
        if (!scale.isTimeVarying()) scale.setTimeVarying(true);

        var inP = clip.inPoint.seconds, outP = clip.outPoint.seconds;
        var ramp = 0.35, applied = 0, lastEnd = -1;
        zooms.sort(function (a, b) { return a[0] - b[0]; });

        for (var i = 0; i < zooms.length; i++) {
            var t0 = zooms[i][0];
            var pct = Math.max(102, Math.min(160, zooms[i][1]));
            var hold = Math.max(0.5, Math.min(8, zooms[i][2]));
            var t3 = t0 + ramp + hold + ramp;
            if (t0 < inP || t3 > outP || t0 < lastEnd + 0.2) continue;
            var peak = base * pct / 100;
            gc_setKey(scale, t0, base);
            gc_setKey(scale, t0 + ramp, peak);
            gc_setKey(scale, t0 + ramp + hold, peak);
            gc_setKey(scale, t3, base);
            lastEnd = t3;
            applied++;
        }
        return gc_ok({ applied: applied });
    } catch (e) {
        return gc_fail(e.toString());
    }
}

/*
 * Keraksiz bo'laklarni (pauza, takror) kesib, ripple delete qiladi.
 * cuts = [[mediaBoshi, mediaOxiri], ...]
 * Faqat tanlangan klip va uning audiosi (shu media fayldan) joylashgan treklarda ishlaydi.
 */
function gc_applyCuts(cuts) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q.");
        var found = gc_findSelected(seq);
        if (!found) return gc_fail("Timeline'da klipni tanlang.");
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return gc_fail("QE sequence topilmadi.");

        var clip = found.clip;
        var fd = gc_frameDuration(seq);
        var settings = seq.getSettings();
        var clipStart = clip.start.seconds, clipEnd = clip.end.seconds, inP = clip.inPoint.seconds;

        // Shu klipning audiosi: bir xil media fayl va bir xil boshlanish vaqtidagi audio klip(lar)
        var vTracks = [found.trackIndex], aTracks = [];
        var mediaPath = gc_normPath(clip.projectItem.getMediaPath());
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            var aTrack = seq.audioTracks[at];
            for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
                var aItem = aTrack.clips[ac];
                try {
                    if (aItem.projectItem && gc_normPath(aItem.projectItem.getMediaPath()) === mediaPath &&
                        Math.abs(aItem.start.seconds - clipStart) < fd) {
                        aTracks.push(at);
                        break;
                    }
                } catch (eA) {}
            }
        }

        // Media vaqtdan timeline vaqtiga o'tkazish, kadrga moslash, chegaradan chiqmaslik
        var ranges = [];
        for (var i = 0; i < cuts.length; i++) {
            var rs = Math.max(gc_snap(clipStart + (cuts[i][0] - inP), fd), clipStart);
            var re = Math.min(gc_snap(clipStart + (cuts[i][1] - inP), fd), clipEnd);
            if (re - rs >= fd * 2) ranges.push([rs, re]);
        }
        ranges.sort(function (a, b) { return b[0] - a[0]; }); // oxiridan boshiga
        if (!ranges.length) return gc_ok({ applied: 0 });

        function razorAt(sec) {
            var tc = gc_time(sec).getFormatted(settings.videoFrameRate, settings.videoDisplayFormat);
            for (var v = 0; v < vTracks.length; v++) qeSeq.getVideoTrackAt(vTracks[v]).razor(tc);
            for (var a = 0; a < aTracks.length; a++) qeSeq.getAudioTrackAt(aTracks[a]).razor(tc);
        }

        function removeRange(tracks, idxs, s, e) {
            for (var n = 0; n < idxs.length; n++) {
                var track = tracks[idxs[n]];
                for (var c = track.clips.numItems - 1; c >= 0; c--) {
                    var it = track.clips[c];
                    if (it.start.seconds >= s - fd / 2 && it.end.seconds <= e + fd / 2) {
                        it.remove(true, true); // ripple = true
                    }
                }
            }
        }

        for (var r = 0; r < ranges.length; r++) {
            razorAt(ranges[r][1]);
            razorAt(ranges[r][0]);
        }
        for (var k = 0; k < ranges.length; k++) {
            removeRange(seq.videoTracks, vTracks, ranges[k][0], ranges[k][1]);
            removeRange(seq.audioTracks, aTracks, ranges[k][0], ranges[k][1]);
        }
        return gc_ok({ applied: ranges.length });
    } catch (e) {
        return gc_fail(e.toString());
    }
}

/* Timeline ko'rsatkichini (playhead) berilgan soniyaga o'tkazadi */
function gc_setPlayhead(sec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol sequence yo'q.");
        var ticks = Math.round(Math.max(0, sec) * 254016000000);
        seq.setPlayerPosition(String(ticks));
        return gc_ok({});
    } catch (e) {
        return gc_fail(e.toString());
    }
}
