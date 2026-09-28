# GeminiCut 3.0 — Premiere Pro uchun AI subtitr va montaj paneli

Premiere Pro 2022, 2023, 2024 va **2025** (Windows) uchun.

## Qanday ishlaydi

Plagin **video fayllarni hech qayerga yubormaydi**. Hammasi timeline'ning o'zidan olinadi:

1. **Premiere** timeline audiosini eshitilganidek eksport qiladi — barcha kesishlar,
   In/Out oralig'i va faqat siz tanlagan **nutq treklari** bilan (musiqa treki vaqtincha o'chiriladi).
2. **Shu kompyuterda** audio 16 kHz mono'ga o'tkaziladi va to'lqin shakli (waveform)
   bo'yicha nutq va sukut joylari 10 ms aniqlikda topiladi. Pauzalar shu yerda aniqlanadi —
   buning uchun internet ham kerak emas.
3. **Gemini — faqat "miya"**: unga faqat nutq audiosi bo'laklarga (≈4 daqiqadan, sukut joyidan)
   bo'lib yuboriladi. U matnni yozadi, takror/xato gaplarni va urg'uli joylarni belgilaydi.
4. Gemini bergan vaqtlar waveform bo'yicha haqiqiy nutq boshlanishi va tugashiga moslashtiriladi,
   so'ng natija Premiere'ga qo'llanadi.

## O'rnatish (boshqa kompyuterda ham)

1. `GeminiCut-Setup.bat` faylini ishga tushiring.
   - Windows "Windows protected your PC" oynasini ko'rsatsa: **More info → Run anyway**
     (fayl imzolanmagani uchun chiqadi).
2. Menyuda **1 — O'rnatish** ni tanlang va `Y` ni bosing.
3. Premiere Pro'ni oching: **Window → Extensions → GeminiCut - AI Subtitr va Montaj**.
4. **Sozlamalar** bo'limiga Gemini API kalitini kiriting
   (bepul: <https://aistudio.google.com/apikey>) va **Kalitni tekshirish** ni bosing.

Admin huquqi kerak emas. `GeminiCut-Setup.bat /S` — savolsiz o'rnatish, `/U` — o'chirish.

## Ishlatish

**Nutq treklari** (panel tepasida): A1, A2... — qaysi audio treklarda gapirilayotganini belgilang.
Fon musiqasi treki avtomatik ravishda o'chirilgan bo'ladi; kerak bo'lsa bosib o'zgartiring.

### Montaj (avval shuni qiling)
- **Pauzalarni kesish** — waveform bo'yicha, AI'siz, kadrgacha aniq. Chegara: 0.5 / 0.8 / 1.2 s.
- **Takror va xato gaplar (AI)** — qayta aytilgan gaplar, chala jumlalar, "eee/mmm".
- **Avto zoom (AI)** — urg'uli gaplarda gapirayotgan odamning klipiga yengil zoom.

**Tahlil qilish** → ro'yxatni tekshiring (vaqtni bossangiz timeline o'sha joyga o'tadi) →
**Belgilanganlarni qo'llash**. Video treklar va tanlangan nutq treklari birga kesiladi (sinxron
buzilmaydi), musiqa treki tegilmaydi. Hammasi **Ctrl+Z** bilan qaytariladi.

### Subtitr
1. Nutq tili, subtitr tili (tarjima ham mumkin), qator uzunligi va soni, oraliq (Butun yoki In → Out).
2. **Ismlar va atamalar** maydoniga videodagi ismlar va maxsus so'zlarni yozing — aniqlik oshadi.
3. **Subtitr yaratish** → ro'yxatda tekshirib, kerak bo'lsa tahrirlang → **Timeline'ga qo'shish**.

Subtitrlar professional qoidalar bo'yicha tayyorlanadi: vaqtlar waveform'ga moslanadi, uzun gaplar
tinish belgilari va haqiqiy pauzalardan bo'linadi, qatorlar muvozanatli, minimal ko'rinish vaqti va
o'qish tezligi nazorat qilinadi, o'zbekcha `oʻ`, `gʻ`, `ʼ` bir xil ko'rinishga keltiriladi.
SRT fayllar `Documents\GeminiCut` papkasida saqlanadi.

## Audio eksport preseti

Plagin Premiere'ning o'z **Waveform Audio** presetini avtomatik topadi. Topilmasa:
Premiere'da **File → Export → Media**, Format: **Waveform Audio** → **Save Preset** (.epr),
so'ng panelda **Sozlamalar → Audio eksport preseti** → 📁 orqali shu faylni tanlang.

## Muammolar

| Belgi | Yechim |
|---|---|
| Panel menyuda yo'q | Premiere'ni to'liq yopib qayta oching; o'rnatuvchini qayta ishga tushiring |
| "WAV eksport preseti topilmadi" | Yuqoridagi "Audio eksport preseti" bo'limiga qarang |
| "Tanlangan treklarda nutq eshitilmadi" | Nutq treklarini (A1, A2...) to'g'ri belgilang |
| "API kalit noto'g'ri" | Sozlamalarda kalitni qayta kiriting va tekshiring |
| "hududingizda ishlamayapti" | VPN yoki boshqa tarmoq orqali ulaning |
| 429 / limit | Bir oz kuting yoki boshqa modelni tanlang |

Batafsil: **Sozlamalar → Jurnal (diagnostika)**.

## Bilish kerak bo'lganlar
- AI transkripsiyasi juda aniq, lekin 100% emas — ismlar va shovqinli joylarni tekshiring.
- Tezligi o'zgartirilgan (speed/duration) kliplarda zoom vaqti biroz siljishi mumkin.
- Kesishdan keyin timeline o'zgaradi — subtitrni montajdan **keyin** yarating.

## Dasturchilar uchun

```
premiere-gemini-plugin/
├── CSXS/manifest.xml        CEP manifest (PPRO 22+)
├── client/js/
│   ├── cep.js               Premiere bilan aloqa (CSInterface.js kerak emas)
│   ├── audio.js             WAV o'qish, VAD, bo'laklash, vaqtni moslash
│   ├── gemini.js            Gemini API: retry, bekor qilish
│   ├── subtitles.js         subtitr dvigateli va SRT
│   └── main.js              panel logikasi
└── host/host.jsx            ExtendScript: audio eksport, SRT import, kesish, zoom
```

O'rnatuvchini qayta yig'ish: `./tools/build-installer.sh`.
