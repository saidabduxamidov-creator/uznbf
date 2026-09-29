/* GeminiCut Flow: ES3-compatible Premiere host commands.
 * Uses Adobe's QE PNG export pattern. QE is version-dependent; every outcome
 * is checked, and failure leaves the downloaded MP4 available for manual use.
 */
function gc_flowCapture(frameBase) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol timeline yo‘q.");
        if (!frameBase || /[\r\n]/.test(frameBase)) return gc_fail("PNG yo‘li noto‘g‘ri.");
        var target = new File(frameBase + ".png");
        if (!target.parent.exists) return gc_fail("Vaqtinchalik papka topilmadi.");
        if (target.exists) return gc_fail("PNG nomi avval ishlatilgan. Kadrni qayta oling.");
        var position = seq.getPlayerPosition();
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        if (!qseq || !qseq.exportFramePNG) return gc_fail("Bu Premiere versiyasida PNG eksporti mavjud emas.");
        var timecode = qseq.CTI.timecode;
        // QE adds .png itself; do not change the sequence In/Out points.
        qseq.exportFramePNG(timecode, new File(frameBase).fsName);
        return gc_ok({
            sequenceID: String(seq.sequenceID), sequenceName: seq.name,
            projectPath: String(app.project.path || ""), ticks: String(position.ticks),
            seconds: Number(position.seconds), frame: target.fsName
        });
    } catch (e) { return gc_fail("Kadr eksporti: " + e.toString()); }
}

function gc_flowAlreadyPlaced(seq, sourcePath) {
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
        var clips = seq.videoTracks[v].clips;
        for (var c = 0; c < clips.numItems; c++) {
            if (gc_normPath(gc_itemPath(clips[c])) === gc_normPath(sourcePath)) return true;
        }
    }
    return false;
}

function gc_flowImport(filePath, sequenceID, ticks, projectPath, useCurrent) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return gc_fail("Faol timeline yo‘q. Video Downloads/GeminiCut-Flow papkasida saqlandi.");
        // Never silently place a delayed result into a different sequence/project.
        if (String(seq.sequenceID) !== String(sequenceID)) return gc_fail("Kadr olingan timeline’ni qayta oching, so‘ng importni qayta bosing.");
        if (projectPath && String(app.project.path || "") !== projectPath) return gc_fail("Kadr olingan loyiha o‘zgargan. Asl loyihani oching.");
        var file = new File(filePath);
        if (!file.exists || !/\.mp4$/i.test(file.name)) return gc_fail("MP4 fayl topilmadi.");
        if (gc_flowAlreadyPlaced(seq, file.fsName)) return gc_ok({ alreadyPlaced: true });
        var at = useCurrent ? seq.getPlayerPosition() : new Time();
        if (!useCurrent) {
            if (!/^\d+$/.test(String(ticks))) return gc_fail("Timeline vaqti noto‘g‘ri.");
            at.ticks = String(ticks);
        }
        var found = {};
        gc_findItemByPath(app.project.rootItem, gc_normPath(file.fsName), found);
        if (!found.item) {
            if (!app.project.importFiles([file.fsName], true, app.project.getInsertionBin(), false)) return gc_fail("MP4 loyihaga import qilinmadi.");
            gc_findItemByPath(app.project.rootItem, gc_normPath(file.fsName), found);
        }
        if (!found.item) return gc_fail("Import qilingan video Project Bin’da topilmadi.");
        // Video-only subclip prevents generated audio from overwriting speech/music.
        var inTime = found.item.getInPoint(1), outTime = found.item.getOutPoint(1);
        if (!outTime || outTime.seconds <= inTime.seconds) return gc_fail("Video davomiyligi aniqlanmadi. MP4 Project Bin’da saqlandi.");
        var videoOnly = found.item.createSubClip("Flow · " + file.name, String(inTime.ticks), String(outTime.ticks), 1, 1, 0);
        if (!videoOnly) return gc_fail("Video-only klip yaratilmagan. MP4 Project Bin’da saqlandi.");
        var count = seq.videoTracks.numTracks;
        app.enableQE();
        var qseq = qe.project.getActiveSequence();
        if (!qseq || !qseq.addTracks) return gc_fail("Yangi video trek avtomatik yaratilmadi. MP4 Project Bin’da saqlandi.");
        // QE addTracks(videoCount, insertAfterIndex, audioCount).
        qseq.addTracks(1, count, 0);
        if (seq.videoTracks.numTracks !== count + 1) return gc_fail("Yangi trek tasdiqlanmadi. MP4 Project Bin’da saqlandi.");
        var track = seq.videoTracks[count];
        if (gc_isLocked(track) || track.clips.numItems !== 0) return gc_fail("Yangi yuqori trek bo‘sh emas. Video Project Bin’da saqlandi.");
        track.overwriteClip(videoOnly, at.seconds);
        if (track.clips.numItems !== 1) return gc_fail("Timeline importi tasdiqlanmadi. MP4 Project Bin’da saqlandi.");
        var placed = track.clips[0];
        if (Math.abs(placed.start.seconds - at.seconds) > gc_frameDuration(seq) || gc_normPath(gc_itemPath(placed)) !== gc_normPath(file.fsName)) return gc_fail("Klip joylashuvi tasdiqlanmadi. Timeline’ni tekshiring.");
        return gc_ok({ track: count + 1, seconds: placed.start.seconds, name: file.name });
    } catch (e) { return gc_fail("Flow importi: " + e.toString() + ". Yuklangan MP4 saqlangan."); }
}
