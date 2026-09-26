# GeminiCut 2.0 — Premiere Pro uchun AI subtitr va montaj paneli

Premiere Pro 2022, 2023, 2024 va **2025** (Windows) uchun.

## O'rnatish (boshqa kompyuterda ham)

1. `GeminiCut-Setup.bat` faylini ishga tushiring.
   - Windows "Windows protected your PC" oynasini ko'rsatsa: **More info → Run anyway**
     (fayl imzolanmagani uchun chiqadi).
2. Menyuda **1 — O'rnatish** ni tanlang va `Y` ni bosing.
   - Premiere ochiq bo'lsa, o'rnatuvchi uni yopishni so'raydi.
3. Premiere Pro'ni oching: **Window → Extensions → GeminiCut - AI Subtitr va Montaj**.
4. **Sozlamalar** bo'limiga Gemini API kalitini kiriting
   (bepul: <https://aistudio.google.com/apikey>) va **Kalitni tekshirish** ni bosing.

Admin huquqi kerak emas. O'rnatuvchi faqat quyidagilarni bajaradi:

| Nima | Qayerda |
|---|---|
| Plagin fayllari | `%APPDATA%\Adobe\CEP\extensions\com.uzstudio.geminicut` |
| Imzosiz panelga ruxsat | `HKCU\Software\Adobe\CSXS.9…12` → `PlayerDebugMode = 1` |
| Jurnal | `%TEMP%\GeminiCut-install.log` |

Buyruq qatori: `GeminiCut-Setup.bat /S` — savolsiz o'rnatish, `/U` — o'chirish.

## Subtitr yaratish

1. Timeline'da video klipni bosib tanlang, paneldagi ↻ tugmasini bosing.
2. **Nutq tili** (yoki "Avtomatik") va **Subtitr tili**ni tanlang — boshqa tilga tarjima ham mumkin.
3. Qator uzunligi (standart 42 belgi) va qatorlar sonini (1 yoki 2) belgilang.
4. **Subtitr yaratish** ni bosing. Jarayon: yuklash → Gemini qayta ishlashi → transkripsiya.
5. Natijani ro'yxatda tekshiring:
   - matnni to'g'ridan-to'g'ri tahrirlash mumkin;
   - vaqtni bossangiz, timeline o'sha joyga o'tadi;
   - ⚠ belgisi — qator juda uzun yoki o'qish uchun tez.
6. **Timeline'ga qo'shish** — subtitrlar alohida Subtitle treki sifatida qo'shiladi.
   SRT fayl `Documents\GeminiCut` papkasida saqlanadi. ⬇ tugmasi bilan SRT'ni boshqa joyga saqlash mumkin.

Subtitr dvigateli avtomatik ravishda: ustma-ust tushgan vaqtlarni tuzatadi, uzun gaplarni
tinish belgilaridan bo'ladi, qatorlarni muvozanatli ajratadi, minimal ko'rinish vaqti va
o'qish tezligini (17 belgi/soniya) nazorat qiladi, o'zbekcha `oʻ`, `gʻ`, `ʼ` belgilarini
bir xil ko'rinishga keltiradi.

## Montaj (pauzalarni kesish, zoom)

1. **Montaj** bo'limida kerakli amallarni yoqing va **Tahlil qilish** ni bosing.
2. Reja ro'yxatidan keraksiz bandlarni olib tashlang.
3. **Belgilanganlarni qo'llash** — pauzalar ripple delete qilinadi (video va uning audiosi
   birga), zoom esa Motion → Scale keyframe'lari orqali qo'yiladi. Boshqa treklar (musiqa, B-roll)
   o'zgartirilmaydi. Hammasi **Ctrl+Z** bilan bekor qilinadi.

## Bilish kerak bo'lganlar

- Video Gemini'ga yuklanadi (Google serveri). Bir marta yuklangan fayl 44 soat davomida
  qayta yuklanmaydi — subtitr va montaj uchun bitta yuklash yetadi.
- Qo'llab-quvvatlanadigan formatlar: MP4, MOV, AVI, WEBM, WMV, MPG, MP3, WAV va boshqalar.
  MXF, R3D kabi kamera formatlari uchun avval MP4 proksi eksport qiling. Maksimal hajm — 2 GB.
- AI transkripsiyasi juda aniq, lekin 100% emas: ismlar, atamalar va shovqinli joylarni
  ro'yxatda tekshirib chiqing.
- Juda uzun videolarda (1 soatdan ortiq) klipni bo'laklarga bo'lib ishlash tavsiya etiladi.

## Muammolar

| Belgi | Yechim |
|---|---|
| Panel menyuda yo'q | Premiere'ni to'liq yopib qayta oching; o'rnatuvchini qayta ishga tushiring |
| "Premiere" belgisi qizil | Panelni yopib qayta oching |
| "API kalit noto'g'ri" | Sozlamalarda kalitni qayta kiriting va tekshiring |
| "hududingizda ishlamayapti" | VPN yoki boshqa tarmoq orqali ulaning |
| 429 / limit | Bir oz kuting yoki boshqa modelni tanlang |

Batafsil xatolar: **Sozlamalar → Jurnal (diagnostika)**.

## Dasturchilar uchun

```
premiere-gemini-plugin/
├── CSXS/manifest.xml        CEP manifest (PPRO 22+)
├── client/
│   ├── index.html, css/style.css
│   └── js/
│       ├── cep.js           Premiere bilan aloqa (CSInterface.js kerak emas)
│       ├── gemini.js        Gemini API: oqimli yuklash, retry, bekor qilish
│       ├── subtitles.js     subtitr dvigateli va SRT
│       └── main.js          panel logikasi
└── host/host.jsx            ExtendScript: klip, SRT import, kesish, zoom
```

O'rnatuvchini qayta yig'ish: `./tools/build-installer.sh` (Linux/macOS/WSL).
