# GeminiCut 4.5 — Premiere Pro uchun AI ish maydoni

Premiere Pro 2022, 2023, 2024, **2025** va 2026 (Windows). Qo'shimcha dastur (Node.js, npm,
Playwright va hokazo) o'rnatish **shart emas** — hammasi bitta `GeminiCut-Setup.bat` ichida.

## O'rnatish

1. `GeminiCut-Setup.bat` ni ishga tushiring → menyuda **1** → `Y`.
   Windows "Windows protected your PC" desa: **More info → Run anyway** (fayl imzolanmagan).
2. Premiere Pro'ni qayta oching: **Window → Extensions → GeminiCut - AI Subtitr va Montaj**.
3. **Sozlamalar**: Gemini API kaliti (bepul, <https://aistudio.google.com/apikey>), ixtiyoriy ravishda
   Claude (Anthropic) va ChatGPT (OpenAI, <https://platform.openai.com/api-keys>) kalitlari.

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
- 98 ta bazaviy effekt: whoosh, riser, impact, glitch, UI, pop, typing, magic, **Cinematic** (braam, trailer hit,
  reverse cymbal, drone), **Ijtimoiy tarmoq**,
  **O'yin (8-bit)**, **Kulgili** (ba-dum-tss, trombon, plastinka), **Baraban**, **Tabiat** (shamol, yomg'ir,
  momaqaldiroq, olov), **Foley**, **Gym** (shtanga tushishi, gantel, trener hushtagi, boks qo'ng'irog'i,
  taymer 3-2-1, musht zarbasi, 808 bass, kuch yig'ish). Birinchi
  ochilishda shu kompyuterda sintez qilinadi — mualliflik huquqi muammosi yo'q.
- Fayllar: `Documents\GeminiCut\Sounds\<papka>`. O'chirish: kartada sichqonchaning o'ng tugmasi.

### Claude (Opus 5.5)
Timeline'da klipni tanlang va oddiy so'z bilan yozing, masalan: *"yuziga sekin zoom qil,
'eng muhimi' degan joyda punch-in va whoosh qo'y, oxirida fade out"*. Claude:
- klip kadrlarini ko'radi (vision), nutq matni va effektlar kutubxonangizni biladi;
- motion keyframe'lar, SFX joylashuvi va (ruxsat bersangiz) kesishlarni rejalashtiradi;
- reja ro'yxatda ko'rsatiladi — keraksizini olib tashlab, **Qo'llash**. Hammasi Ctrl+Z bilan qaytadi.

### Matn (animatsion matnlar va 3D Liquid)
- **2D shablonlar (12 ta):** Pop, Pastdan chiqish, Yozuv mashinkasi, Blur, Kinetik zoom (Reels), To'lqin,
  Marker, Neon, Glitch, Yaltiroq gradient, Ikkiga ochilish, Lower third (ism + lavozim).
- **Fonli matnlar (17 ta)** — matn orqasiga fon o'zi qo'yiladi: Shaffof shisha (frosted), 3D chat pufagi
  (qisqich bilan), Gradient kapsula, Lenta, 3D karta, Neon ramka, Stiker, Chat xabarlar, Obuna tugmasi,
  Iqtibos, Shisha lower third. **Matnsiz - faqat fon** tugmasi bilan faqat shaffof fonning o'zi chiqadi;
  fon kengligi/balandligi slayderlar bilan sozlanadi.
- **3D promo bloklar (6 ta)** — har bir qator o'z 3D blokida, xrom yoki oltin qalin harflar bilan:
  Promo 3D bloklar (qizil yaltiroq + karbon + mo'yqalam), Oltin promo, Ko'k promo, Mo'yqalam chizig'i,
  3D yaltiroq yorliq, Karbon premium. Matnni qatorlarga bo'lib yozing (Enter) — har qator alohida blok;
  blok rangi - **Aksent** rangi. Bloklar navbat bilan urilib tushadi, harflar ustidan nur o'tadi.
- **Gym (12 ta)** — sport/fitnes videolari uchun: Zarba (slam), Qizil banner (FitCity uslubi), Ustma-ust
  so'zlar (NO PAIN / NO GAIN), Sanagich (100 KG, 12 REP), Taymer (haqiqiy vaqtda orqaga sanash), Tezlik
  chiziqlari, Yurak urishi (EKG), Energiya to'lishi, Strob (Beast mode), Trener lower third, Motivatsiya, Set/progress.
- **3D · Logo:** FitCity Chimgan, Jurjoniy, Malika, Parlament logolari — **rasm o'zgarmaydi**, aynan o'sha ranglar
  bilan 3D hajm, yorug'lik, burilib kirish va yaltirash qo'shiladi. **O'z logongiz** — istalgan shaffof PNG logoni
  yuklab, xuddi shunday 3D qilish mumkin. Chuqurlik, burilish, qirra va o'lcham sozlanadi.
- **3D matn (11 ta):** Suyuq oltin, Suyuq xrom, Jele, Suyuq shisha, Tomchilardan yig'ilish, Lava, 3D Candy,
  3D Neon, Marmar, Rose gold, Muz.
- **Oson sozlash:** matn, shrift, qalinlik, 3 ta rang, o'lcham, soya/kontur/nur; 3D uchun material,
  suyuqlik, oqim tezligi, chuqurlik, burilish, tomchilar; joy (tayyor nuqtalar yoki slayder), davomiylik,
  tezlik. Hammasi jonli oldindan ko'rishda darhol ko'rinadi (**Kadr foni** — videongiz ustida ko'rish).
- **Timeline'ga qo'yish** — plagin har bir kadrni shaffof PNG qilib chizadi va playhead joyiga,
  videodan yuqoridagi bo'sh trekka qo'yadi (`Documents\GeminiCut\Matn`).
- **Tanlangan matnni tahrirlash** — matn klipini timeline'da tanlang (yoki playhead'ni ustiga qo'ying):
  sozlamalari panelga qaytadi, o'zgartirib **Yangilash** — o'sha joyda almashadi.
- **Premiere'ning o'zida:** qo'yilgan matn/logo oddiy klip — joy, o'lcham, aylanish, shaffoflik va ularning
  keyframe'lari **Effect Controls → Motion / Opacity** da; kesish, cho'zish, ko'chirish — timeline'da.
  Matn so'zini, shriftini, shablonni Premiere o'zgartira olmaydi (Adobe skript API'si maxsus grafikani
  yaratishga ruxsat bermaydi) — buni panel qiladi. After Effects va Resolve versiyalarida matn to'liq
  muharrirning o'z qatlamlari bo'lib qo'yiladi.
- **AI yordamchi** — "videoga mos sarlavha" kabi topshiriq: AI matn, shablon va ranglarni tanlaydi.

### ChatGPT
Claude bo'limi kabi: klipni tanlang va so'z bilan yozing — ChatGPT kadrlarni ko'rib motion, SFX va
kesishlarni rejalashtiradi. Model avtomatik (kalitingizga ochiq eng yangi GPT) yoki Sozlamalarda tanlanadi.
Rang berish (color grading) — DaVinci Resolve versiyasida.

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
| ChatGPT: "mablag' yo'q (insufficient_quota)" | platform.openai.com → Billing da hisobni to'ldiring |
| 3D matn: "WebGL ishlamayapti" | Videokarta drayverini yangilang; 2D shablonlar baribir ishlaydi |

## Boshqa kompyuterga berish

- Faqat **`GeminiCut-Setup.bat`** faylini yuboring (Telegram, Google Drive, fleshka). Boshqa hech narsa kerak emas.
- Windows **"Windows protected your PC"** desa: **More info → Run anyway**. Brauzer "xavfli bo'lishi mumkin"
  desa: **Keep / Сохранить**. Sabab — fayl raqamli imzoga ega emas, ichida virus yo'q.
- GitHub'dan yuklansa: **Raw → Download** (yoki "Download raw file"). Sahifadan nusxalab Notepad'ga qo'ymang.
- Fayl buzilgan bo'lsa o'rnatuvchi o'zi aytadi (SHA-256 tekshiruvi). Qator oxirlari buzilgan bo'lsa ham
  (masalan GitHub "Copy"), o'rnatuvchi o'zini avtomatik tuzatib ishga tushadi.
- Har bir foydalanuvchi o'z API kalitini kiritadi (kalitlar faqat o'z kompyuterida saqlanadi).

Batafsil: **Sozlamalar → Jurnal**.

## Dasturchilar uchun

```
client/js/  cep.js (Premiere aloqa) · audio.js (VAD) · subtitles.js · gemini.js (Gemini + Veo)
            ai.js (Claude HTTPS + umumiy matn AI) · motion.js (easing, presetlar) · sfxgen.js
            library.js (effektlar) · notes.js · claude.js (Claude/ChatGPT montajchi) · chatgpt.js
            color.js (LUT, kadr tahlili) · textfx.js (2D/3D matn renderi) · text.js · cdp.js · flow.js · main.js
host/host.jsx  ExtendScript (faqat ASCII): audio/kadr eksporti, motion, SFX, kesish, SRT, import
tests/      node --test tests/*.test.cjs  ·     node tests/ui.e2e.cjs  (Chromium + Premiere taqlidi)
```

O'rnatuvchini yig'ish: `./tools/build-installer.sh`.
