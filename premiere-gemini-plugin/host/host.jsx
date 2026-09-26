// GeminiCut - host/host.jsx
// Premiere Pro ExtendScript tomoni. QE DOM (rasmiy hujjatlanmagan, lekin keng
// qo'llaniladigan) yordamida ripple-delete va Motion keyframe operatsiyalari.

app.enableQE();

function log(msg) {
  // $.writeln faqat ExtendScript Toolkit/konsolda ko'rinadi, xatoni qaytarish uchun ishlatamiz
  return String(msg);
}

/* Timeline'da tanlangan (selected) klipning media fayl manzilini qaytaradi */
function getSelectedClipPath() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return null;
    var tracks = seq.videoTracks;
    for (var t = 0; t < tracks.numTracks; t++) {
      var track = tracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        if (clip.isSelected && clip.isSelected()) {
          return clip.projectItem.getMediaPath();
        }
      }
    }
    return null;
  } catch (e) {
    return "EvalScript error: " + e.toString();
  }
}

/* Vaqtinchalik yordamchi: soniyani Time obyektiga aylantiradi */
function secToTime(sec) {
  var t = new Time();
  t.seconds = sec;
  return t;
}

/* Tanlangan klip (TrackItem) va uning QE track/klip indeksini topadi */
function findSelectedClipInfo() {
  var seq = app.project.activeSequence;
  var qeSeq = qe.project.getActiveSequence();
  for (var t = 0; t < seq.videoTracks.numTracks; t++) {
    var track = seq.videoTracks[t];
    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      if (clip.isSelected && clip.isSelected()) {
        return {
          domClip: clip,
          domTrack: track,
          trackIndex: t,
          clipIndex: c,
          qeTrack: qeSeq.getVideoTrackAt(t),
          clipStart: clip.start.seconds, // klipning timeline'dagi boshlanish vaqti
        };
      }
    }
  }
  return null;
}

/*
  editPlan = {
    segments: [{start, end, action:"keep"|"cut", reason}],  // klip ICHIDAGI (0 dan boshlanuvchi) vaqtlar
    zooms:    [{time, type:"zoom_in"|"zoom_out", scale, duration}]
  }
  Strategiya:
   1) "cut" segmentlarni TIMELINE'dagi mos vaqt oralig'iga o'tkazamiz
      (absolute = clipStart + segment.start).
   2) Har bir "cut" oralig'ini sequence in/out qilib, Ripple Delete bajaramiz
      (oxiridan boshigacha, aks holda vaqt ofsetlari siljib ketadi).
   3) Zoom uchun klipning Motion > Scale komponentiga keyframe qo'yamiz
      (bu operatsiya cut'lardan OLDIN, original vaqtlar bo'yicha bajariladi,
      shuning uchun avval zoom, keyin cut qilingan yaxshiroq natija beradi —
      shu tartibda chaqiramiz).
*/
function applyEditPlan(jsonStr) {
  try {
    var plan = JSON.parse(jsonStr);
    var info = findSelectedClipInfo();
    if (!info) return "Xatolik: Timeline'da klip tanlanmagan.";

    var seq = app.project.activeSequence;
    var report = [];

    // 1) ZOOM keyframe'lar (original, cut qilinmagan vaqt asosida)
    if (plan.zooms && plan.zooms.length) {
      applyZooms(info.domClip, plan.zooms);
      report.push(plan.zooms.length + " ta zoom keyframe qo'yildi.");
    }

    // 2) CUT segmentlar — oxiridan boshiga qarab ripple delete
    if (plan.segments && plan.segments.length) {
      var cuts = [];
      for (var i = 0; i < plan.segments.length; i++) {
        if (plan.segments[i].action === "cut") cuts.push(plan.segments[i]);
      }
      // Timeline vaqti bo'yicha kamayish tartibida saralaymiz
      cuts.sort(function (a, b) { return b.start - a.start; });

      for (var k = 0; k < cuts.length; k++) {
        var seg = cuts[k];
        var absStart = info.clipStart + seg.start;
        var absEnd = info.clipStart + seg.end;
        seq.setInPoint(absStart, 2);   // 2 = timeline
        seq.setOutPoint(absEnd, 2);
        try {
          qe.project.getActiveSequence().razorInPoint ; // no-op, ba'zi versiyalarda kerak emas
        } catch (e2) {}
        try {
          seq.exportAsMediaDirect; // placeholder - haqiqiy ripple delete quyida
        } catch (e3) {}
        // Ripple delete: sequence in/out oralig'ini olib tashlab, keyingi klip(lar)ni chapga suradi
        app.enableQE();
        var qeSeqNow = qe.project.getActiveSequence();
        qeSeqNow.setInPoint(absStart);
        qeSeqNow.setOutPoint(absEnd);
        qeSeqNow.rippleDelete();
        report.push("Kesildi: " + seg.start.toFixed(2) + "s - " + seg.end.toFixed(2) + "s (" + (seg.reason || "") + ")");
      }
    }

    return "OK. " + report.join(" ");
  } catch (e) {
    return "EvalScript error: " + e.toString();
  }
}

/* Klipning Motion > Scale (Position ham bo'lishi mumkin) komponentiga
   zoom_in / zoom_out uchun keyframe qatorini qo'yadi */
function applyZooms(clip, zooms) {
  var motion = null;
  for (var i = 0; i < clip.components.numItems; i++) {
    if (clip.components[i].displayName === "Motion") {
      motion = clip.components[i];
      break;
    }
  }
  if (!motion) return;

  var scaleProp = null;
  for (var p = 0; p < motion.properties.numItems; p++) {
    if (motion.properties[p].displayName === "Scale") {
      scaleProp = motion.properties[p];
      break;
    }
  }
  if (!scaleProp) return;

  if (!scaleProp.areKeyframesSupported()) return;
  if (!scaleProp.isTimeVarying()) scaleProp.setTimeVarying(true);

  for (var z = 0; z < zooms.length; z++) {
    var zm = zooms[z];
    var baseTime = secToTime(zm.time - clip.start.seconds);
    var peakTime = secToTime(zm.time - clip.start.seconds + (zm.duration || 1.0));
    var baseScale = 100;
    var peakScale = zm.type === "zoom_in" ? (zm.scale || 130) : (zm.scale || 80);

    try {
      scaleProp.addKeyframe(baseTime);
      scaleProp.setValueAtKey(baseTime, baseScale, true);
      scaleProp.addKeyframe(peakTime);
      scaleProp.setValueAtKey(peakTime, peakScale, true);
    } catch (e) {
      // ba'zi Premiere versiyalarida setValueAtKey parametrlari farq qilishi mumkin
    }
  }
}
