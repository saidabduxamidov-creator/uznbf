# GeminiCut 4.0 — Premiere Pro uchun AI ish maydoni

Premiere Pro 2022, 2023, 2024 va **2025** (Windows). Qo'shimcha dastur (Node.js, npm,
Playwright va hokazo) o'rnatish **shart emas** — hammasi bitta `GeminiCut-Setup.bat` ichida.

## O'rnatish

1. `GeminiCut-Setup.bat` ni ishga tushiring → menyuda **1** → `Y`.
   Windows "Windows protected your PC" desa: **More info → Run anyway** (fayl imzolanmagan).
2. Premiere Pro'ni qayta oching: **Window → Extensions → GeminiCut - AI Subtitr va Montaj**.
3. **Sozlamalar**: Gemini API kaliti (bepul, <https://aistudio.google.com/apikey>) va
   ixtiyoriy ravishda Claude (Anthropic) API kaliti.

`/S` — savolsiz o'rnatish, `/U` — o'chirish. Admin huquqi kerak emas.

## Bo'limlar

### Subtitr
Timeline audiosi (faqat nutq treklari) Premiere'ning o'zi orqali eksport qilinadi, Gemini tinglaydi,
vaqtlar to'lqin shakli bo'yicha aniqlashtiriladi. **Matn uslubi** kartasi:
- **Harflar:** Asl · AB (katta) · ab (kichik) · Ab. (gap boshi katta)
- **Tinish belgilari:** har birini alohida yoqish/o'chirish — `,` `.` `! ?` `: ;` `" «»` `'` `—` `…`.
  So'z ichidagi oʻ, gʻ, maʼno va 3.5 kabi sonlar hech qachon buzilmaydi.
- **Imlo** tugmasi — AI imlo va grammatikani tekshiradi, vaqtlarga tegmaydi, tuzatilganlar sariq bo'ladi.

### Montaj
- **Tezkor motion:** Zoom In/Out, Punch-in, Ken Burns, Silkinish, Qiyshayish, Fade In/Out —
  tanlangan klip(lar)ga yoki playhead ostidagi klipga, silliq (easing) keyframe'lar bilan.
  **Animatsiyani tozalash** — Scale/Position/Rotation/Opacity'ni standartga qaytaradi.
- **Avto montaj:** pauzalar (waveform, AI'siz), takror/xato gaplar va urg'uli joylarga zoom (AI).

### Effektlar (Animation Composer uslubida)
- Papkalar daraxti, to'lqin shaklli kartalar, qidiruv, ★ sevimlilar.
- Kartani bosing — tinglaysiz; **+** yoki ikki marta bosish — playhead joyiga qo'yiladi.
  **Avto** trek: nutq treklaridan tashqaridagi bo'sh audio trek, bo'lmasa yangi trek yaratiladi.
- **+** tugmasi — yangi papka; **⬆** — kompyuterdan yuklash (WAV, MP3, M4A, AIFF, OGG, FLAC).
- 47 ta bazaviy effekt (whoosh, riser, impact, glitch, UI, pop, typing, magic va boshqalar) birinchi
  ochilishda shu kompyuterda sintez qilinadi — mualliflik huquqi muammosi yo'q.
- Fayllar: `Documents\GeminiCut\Sounds\<papka>`. O'chirish: kartada sichqonchaning o'ng tugmasi.

### Claude (Opus 5.5)
Timeline'da klipni tanlang va oddiy so'z bilan yozing, masalan: *"yuziga sekin zoom qil,
'eng muhimi' degan joyda punch-in va whoosh qo'y, oxirida fade out"*. Claude:
- klip kadrlarini ko'radi (vision), nutq matni va effektlar kutubxonangizni biladi;
- motion keyframe'lar, SFX joylashuvi va (ruxsat bersangiz) kesishlarni rejalashtiradi;
- reja ro'yxatda ko'rsatiladi — keraksizini olib tashlab, **Qo'llash**. Hammasi Ctrl+Z bilan qaytadi.

### Video AI (kadrdan video)
- **Veo · avtomatik** — rasmiy Gemini API orqali: kadr + prompt → MP4 → yangi video trek.
  Gemini kalitingiz ishlatiladi (Veo pullik, AI Studio'da billing kerak).
- **Google Flow · brauzer** (<https://flow.google.com>) — o'zingizning Flow akkauntingiz/kreditlaringiz:
  1. **flow.google.com ni ochish / akkauntni ulash** — alohida GeminiCut brauzer oynasida
     flow.google.com ochiladi. Kirilmagan bo'lsa Google kirish sahifasi chiqadi: bir marta kirasiz,
     plagin buni o'zi sezadi va Flow'ga qaytaradi. Profil eslab qoladi (asosiy Chrome profilingizga
     tegilmaydi, parol plaginga kiritilmaydi).
  2. Flow'da "Frames to Video" ni tanlang, playhead'ni kadrga qo'ying, promptni yozing, **Flow'ga yuborish**.
  3. Plagin kadrni yuklaydi va promptni yozadi; Generate'ni siz bosasiz (yoki avtomatik bosish yoqiladi).
  4. Video tayyor bo'lgach Flow'da **Download** — plagin MP4'ni ushlab timeline'ga qo'yadi.

### Bloknot
Bir nechta qayd (`Documents\GeminiCut\Notes`), avtomatik saqlash, so'z/o'qish vaqti hisoblagichi.
**AI yozuvchi:** senariy yozish, davom ettirish, qisqartirish, imloni tuzatish, YouTube sarlavha/tavsif/teglar,
erkin topshiriq. **Videodagi nutq** — subtitr matnini qaydga qo'shadi.

## Muammolar

| Belgi | Yechim |
|---|---|
| Zoom/motion ko'rinmayapti | Sozlamalar → **Keyframe vaqti** → "Klip boshidan" ni tanlab qayta sinang |
| "WAV eksport preseti topilmadi" | Export → Format: Waveform Audio → Save Preset → Sozlamalarda tanlang |
| Flow: "Chrome yoki Edge topilmadi" | Google Chrome yoki Microsoft Edge o'rnating |
| Flow: rasm yuklash maydoni topilmadi | Flow'da "Frames to Video" rejimini tanlab, birinchi kadr (+) tugmasini bosing |
| Veo modellari yo'q | AI Studio'da billing yoqing yoki Google Flow usulidan foydalaning |
| Claude: kalit noto'g'ri / kredit yo'q | console.anthropic.com da kalit va balansni tekshiring |

Batafsil: **Sozlamalar → Jurnal**.

## Dasturchilar uchun

```
client/js/  cep.js (Premiere aloqa) · audio.js (VAD) · subtitles.js · gemini.js (Gemini + Veo)
            ai.js (Claude HTTPS + umumiy matn AI) · motion.js (easing, presetlar) · sfxgen.js
            library.js (effektlar) · notes.js · claude.js · cdp.js (Chrome DevTools) · flow.js · main.js
host/host.jsx  ExtendScript (faqat ASCII): audio/kadr eksporti, motion, SFX, kesish, SRT, import
tests/      node --test tests/*.test.cjs  ·     node tests/ui.e2e.cjs  (Chromium + Premiere taqlidi)
```

O'rnatuvchini yig'ish: `./tools/build-installer.sh`.
