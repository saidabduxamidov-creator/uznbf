/* GeminiCut - Premiere Pro CEP panel logic
   Node.js (fs) mavjud, chunki manifestda --enable-nodejs va --mixed-context yoqilgan. */
const fs = require("fs");
const csInterface = new CSInterface();

const $ = (id) => document.getElementById("id" === id ? id : id) || document.getElementById(id);
const logEl = document.getElementById("log");
const analyzeBtn = document.getElementById("analyzeBtn");
const applyBtn = document.getElementById("applyBtn");
const pickBtn = document.getElementById("pickBtn");
const clipPathInput = document.getElementById("clipPath");

let lastPlan = null; // Gemini javobidan olingan edit-plan (JSON)

function log(msg) {
  logEl.textContent += "\n" + msg;
  logEl.scrollTop = logEl.scrollHeight;
}

/* ---------- 1. Premiere'dan faol klip yo'lini olish ---------- */
pickBtn.addEventListener("click", () => {
  csInterface.evalScript("getSelectedClipPath()", (result) => {
    if (!result || result === "null" || result.indexOf("EvalScript error") === 0) {
      log("Xatolik: avval Timeline'da bitta klipni tanlang.");
      return;
    }
    clipPathInput.value = result;
    log("Tanlangan fayl: " + result);
  });
});

/* ---------- 2. Faylni Gemini Files API'ga yuklash ---------- */
async function uploadToGemini(filePath, apiKey) {
  const stats = fs.statSync(filePath);
  const mimeType = guessMime(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  // Resumable upload boshlash
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(stats.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: filePath.split(/[\\/]/).pop() } }),
    }
  );
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Upload URL olinmadi. API kalitni tekshiring.");

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(stats.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: fileBuffer,
  });
  const uploadJson = await uploadRes.json();
  return uploadJson.file; // { uri, mimeType, name, state, ... }
}

async function waitUntilActive(fileName, apiKey) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
    );
    const j = await r.json();
    if (j.state === "ACTIVE") return j;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("Fayl Gemini tomonidan qayta ishlanmadi (timeout).");
}

function guessMime(p) {
  const ext = p.split(".").pop().toLowerCase();
  return { mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo" }[ext] || "video/mp4";
}

/* ---------- 3. Gemini'dan kesish/zoom rejasini so'rash ---------- */
async function askGeminiForEditPlan(fileUri, mimeType, apiKey, opts) {
  const prompt = `
Sen professional video montajchisan. Senga o'zbek tilidagi (yoki ${opts.lang}) nutqli video beriladi.
Vazifang:
1. Videoni tinglab/ko'rib chiqib, nutqdagi uzoq pauzalarni, tutilib qolgan (stutter),
   gapni boshlab keyin qaytadan boshqattan aytgan joylarni (false start / retake) top.
2. Faqat ${opts.cuts ? "kerakli" : "hech qanday"} kesishlarni taklif qil: har bir segment uchun
   {"start": sekund, "end": sekund, "action": "keep" yoki "cut", "reason": "qisqa izoh"}.
   "cut" - bu olib tashlanadigan (pauza/tutilish/qayta boshlash) segment.
3. ${opts.zoom ? "Muhim/urg'uli lahzalarda kamera zoom in/out qilish uchun ham taklif ber: " +
   '{"time": sekund, "type": "zoom_in" yoki "zoom_out", "scale": 100-160, "duration": sekund}.' : "Zoom takliflarini bo'sh massiv qilib qoldir."}
4. Javobni FAQAT quyidagi JSON formatda qaytar, boshqa hech qanday matn, izoh yoki markdown belgisisiz:

{
  "segments": [ {"start":0,"end":3.2,"action":"keep","reason":""}, ... ],
  "zooms": [ {"time":12.4,"type":"zoom_in","scale":130,"duration":1.5}, ... ],
  "summary": "video haqida 1-2 jumlali qisqacha tavsif"
}
`.trim();

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { file_data: { file_uri: fileUri, mime_type: mimeType } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    }
  );
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const text = json.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

/* ---------- Tugma: Tahlil qilish ---------- */
analyzeBtn.addEventListener("click", async () => {
  const apiKey = document.getElementById("apiKey").value.trim();
  const filePath = clipPathInput.value.trim();
  const lang = document.getElementById("lang").value;
  const cuts = document.getElementById("optCuts").checked;
  const zoom = document.getElementById("optZoom").checked;

  if (!apiKey) return log("Avval Gemini API kalitni kiriting.");
  if (!filePath) return log("Avval klipni tanlang.");

  try {
    analyzeBtn.disabled = true;
    log("Fayl Gemini'ga yuklanmoqda...");
    const file = await uploadToGemini(filePath, apiKey);
    log("Yuklandi, qayta ishlanishi kutilmoqda...");
    const active = await waitUntilActive(file.name, apiKey);
    log("Tahlil qilinmoqda (bu bir necha daqiqa vaqt olishi mumkin)...");
    const plan = await askGeminiForEditPlan(active.uri, active.mimeType, apiKey, { lang, cuts, zoom });
    lastPlan = plan;
    log("Tayyor! " + (plan.summary || ""));
    log(`Segmentlar: ${plan.segments.length}, Zoom takliflari: ${plan.zooms.length}`);
    applyBtn.disabled = false;
  } catch (e) {
    log("XATOLIK: " + e.message);
  } finally {
    analyzeBtn.disabled = false;
  }
});

/* ---------- Tugma: Timeline'ga qo'llash ---------- */
applyBtn.addEventListener("click", () => {
  if (!lastPlan) return;
  const payload = JSON.stringify(lastPlan).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  csInterface.evalScript(`applyEditPlan("${payload}")`, (result) => {
    log("Premiere javobi: " + result);
  });
});
