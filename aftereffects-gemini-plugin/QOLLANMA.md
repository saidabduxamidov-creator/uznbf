# GeminiCut 4.5 — After Effects uchun

After Effects 2022 – 2026 (**2025** ham), Windows. Qo'shimcha dastur (Node.js, npm, Python) o'rnatish **shart emas**.

## O'rnatish
1. After Effects'ni yoping.
2. `GeminiCut-AE-Setup.bat` ni ishga tushiring → **1** → `Y`.
   "Windows protected your PC" chiqsa: **More info → Run anyway** (fayl raqamli imzosiz).
3. After Effects'ni oching: **Window → Extensions → GeminiCut - AI Subtitr va Montaj**.
4. Sozlamalar: Gemini API kaliti (<https://aistudio.google.com/apikey>), ixtiyoriy ChatGPT (OpenAI) va Claude (Anthropic) kalitlari.

Premiere versiyasi bilan birga o'rnatsa bo'ladi — ular alohida (`com.uzstudio.geminicut.ae`).
`/S` — savolsiz o'rnatish, `/U` — o'chirish. Admin huquqi kerak emas.

## After Effects'da qanday ishlaydi
Interfeys Premiere versiyasi bilan bir xil, faqat After Effects tilida:

| Panelda | After Effects'da |
|---|---|
| Timeline / sequence | Faol kompozitsiya (Timeline paneli ochiq bo'lsin) |
| Playhead | Vaqt ko'rsatkichi (Current Time Indicator) |
| Treklar (A1, A2…) | Audio bor qatlamlar; nutq qatlamini tanlang, musiqani o'chiring |
| In → Out | Work Area |
| Klip tanlash | **Qatlamlarni tanlash ishlaydi**; hech narsa tanlanmasa — vaqt ko'rsatkichi ostidagi eng yuqori qatlam |
| Timeline audiosi | Render Queue orqali WAV (faqat audio, video o'chiq). WAV sozlanmasa — "AIFF 48kHz" shabloni |
| Subtitr | Har bir satr alohida **matn qatlami** ("GeminiCut Subtitr N") — shrift/rangni AE'da erkin o'zgartirasiz |
| Zoom / motion / Claude / ChatGPT | Scale, Position, Rotation, Opacity keyframe'lari (kompozitsiya vaqtida) |
| Pauzalarni kesish | Barcha qulflanmagan qatlamlar bo'laklarga bo'linadi, chapga suriladi, kompozitsiya qisqaradi |
| SFX | Audio qatlam, Project panelida "GeminiCut SFX" papkasi |
| Animatsion matn / Gym / fonli matn | **Tahrirlanadigan** rejimi (standart): AE'ning o'z **matn qatlami** + fon uchun **Shape qatlam** (matnga bog'langan, o'lchami matnga o'zi moslashadi) + oddiy keyframe animatsiya. **Kadrlar (PNG)** rejimi: PNG ketma-ketligi ("GeminiCut Matn" papkasi) |
| 3D logo | **Null** ("GeminiCut Logo: …", "Qalinlik" slayderi) + 12 ta 3D qatlam (asl PNG, orqadagilari qoraytirilgan); aylanish/o'lcham/joy — Null'ning Transform'ida |
| Rang berish (ChatGPT) | Faqat DaVinci Resolve versiyasida |

Har bir amal **bitta Undo** guruhi — `Ctrl+Z` bilan bir bosishda qaytadi.

## Muammolar
| Belgi | Yechim |
|---|---|
| "Kompozitsiya ochilmagan" | Kompozitsiyani oching va Timeline panelini bir marta bosing |
| Audio eksport sozlanmadi | Edit → Templates → Output Module: Format = WAV, Video Output o'chiq, nomi **GeminiCut WAV** |
| Kadr eksport qilinmadi | After Effects 2022 yoki yangisini ishlating (`saveFrameToPng`) |
| Panel menyuda yo'q | O'rnatuvchini qayta ishga tushiring, AE'ni to'liq yopib oching |

## Dasturchilar uchun
```
./tools/build-ae.sh                                   # GeminiCut-AE-Setup.bat
node --test aftereffects-gemini-plugin/tests/*.test.cjs
node aftereffects-gemini-plugin/tests/ui.e2e.cjs      # Chromium + AE taqlidi
```
Interfeys `premiere-gemini-plugin/client` dan olinadi; `cep.js` dastur nomini (PPRO/AEFT) aniqlab `body` ga `ppro`/`ae` klassini qo'yadi.

## After Effects'ning o'zida tahrirlash
- Matnni kompozitsiyada ikki marta bosib yozing; shrift, rang, o'lcham, kontur — **Character** paneli.
- Fon (Shape qatlam) matn uzunligi va shrift o'lchamiga ifoda orqali o'zi moslashadi.
- Animatsiya — oddiy keyframe'lar (Graph Editor'da tahrirlanadi); sanagich/taymer/yozuv — Source Text ifodasi.
- Panel orqali qayta tahrirlash: matn yoki logo qatlamini tanlang → **Tanlangan matnni tahrirlash** →
  o'zgartirib **Yangilash** (butun guruh o'sha vaqtda almashtiriladi).
- 3D suyuq matnlar (oltin, xrom, jele…) faqat kadrlar (PNG) bo'lib qo'yiladi.

## Claude Desktop va ChatGPT Desktop bilan ishlash (MCP)
Panel endi lokal MCP platformasi bilan ishlaydi: Claude Desktop yoki ChatGPT Desktop'da oddiy so'z bilan
yozasiz — "pauzalarni kes", "3-soniyaga zoom qo'sh", "shu yerga whoosh qo'y", "CHIMGAN logotipini qo'y" —
va ular timeline'ni shu panel orqali tahrirlaydi.
- **Sozlamalar → Claude Desktop / ChatGPT Desktop (MCP)**: ulanish yoqilgan bo'lsa, holat qatorida
  "Ulangan" yoki "Kutmoqda" ko'rinadi. Panel ochiq turishi kerak.
- Hammasi faqat shu kompyuter ichida (127.0.0.1), har safar yangi maxfiy kalit bilan. Internetga hech narsa
  chiqmaydi; Gemini bu ulanishda ishlatilmaydi.
- Bir vaqtda ham Claude, ham ChatGPT ulanishi mumkin; amallar navbat bilan bajariladi.
- O'chirish: shu sozlamadagi tugmani o'chiring.
