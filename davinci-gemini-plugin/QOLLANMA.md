# GeminiCut — DaVinci Resolve Studio uchun

## O'rnatish
1. DaVinci Resolve'ni yoping.
2. `GeminiCut-Resolve-Setup.bat` ni ishga tushiring → ochilgan oynada **Ha / Yes** (administrator ruxsati) → `1` → `Y`.
3. Resolve'ni oching → loyiha va timeline → **Workspace > Workflow Integrations > GeminiCut**.
4. Sozlamalar: Gemini API kaliti (https://aistudio.google.com/apikey), ChatGPT uchun OpenAI kaliti
   (https://platform.openai.com/api-keys), Claude uchun Anthropic kaliti.

Talablar: **DaVinci Resolve Studio 20+** (bepul versiyada Workflow Integration yo'q). Node.js, npm, Python kerak emas —
o'rnatuvchi Resolve bilan keladigan `WorkflowIntegration.node` modulini ishlatadi.

## Premiere versiyasidan farqlari
| Funksiya | Resolve'da qanday ishlaydi |
|---|---|
| Klip tanlash | Resolve API tanlovni bermaydi — **playhead ostidagi** eng yuqori klip ishlatiladi |
| Zoom / motion / Claude motion | Klipga Fusion kompozitsiyasi qo'shiladi: `GCTransform` (Size, Center, Angle) va `GCFade` (Gain) kalit kadrlari |
| Motionni tozalash | `GCTransform`/`GCFade` kalit kadrlari o'chiriladi |
| Pauza/qayta olishlarni kesish | Asl timeline o'zgarmaydi — **"<nom> (GeminiCut)"** degan yangi timeline yig'iladi |
| Timeline ovozi | Faqat nutq treklari yoqilgan holda WAV render qilinadi, keyin treklar holati tiklanadi |
| SFX | Media Pool > GeminiCut > SFX ga import, bo'sh audio trekka qo'yiladi (kerak bo'lsa yangi trek) |
| Subtitr | SRT Media Pool > GeminiCut > Subtitrlar ga import va subtitr trekiga qo'yiladi. Resolve rad etsa — SRT'ni Media Pool'dan timeline'ga sudrab qo'ying |
| Claude / ChatGPT kadrlari | `ExportCurrentFrameAsStill` orqali |
| Rang berish (ChatGPT) | Faqat Resolve'da: LUT alohida rang versiyasida |
| Animatsion matn | PNG ketma-ketligi (`ImportMedia` + `AppendToTimeline`) |

## ChatGPT bilan rang berish (color grading)
1. **ChatGPT → Rang berish** → kliplarni tanlang: *Playhead klipi* / *Shu trek* / *Hammasi* → **Kadrlarni olish va tahlil**.
2. Tayyor uslubni tanlang (Tabiiy, Kino Teal & Orange, Iliq oltin, Sovuq ko'k, Film, Moody, Yorqin Reels,
   Vintage, Qora-oq, Neon tun) **yoki** ChatGPT'ga yozing: *"kinematik, teri ranglari tabiiy, hamma kadrlar bir xil"*.
   ChatGPT har bir klip kadrini va o'lchangan statistikasini ko'rib, umumiy ko'rinishni va kliplarni
   bir-biriga moslashtirish tuzatishlarini tanlaydi.
3. **Oldin/Keyin** slayderi bilan solishtiring, kerak bo'lsa: Kuch, Ekspozitsiya, Kontrast, To'yinganlik,
   Harorat, Tint, Film fade, Avto balans.
4. **Rangni qo'llash** — har bir klipga alohida 33³ LUT, klipning **"GeminiCut AI"** rang versiyasida
   (asl grade'ingiz saqlanadi; Color sahifasida Versions orqali almashtirish mumkin).
   **Asl rangga qaytarish** — AI versiyasini o'chiradi.

**Qo'llash usuli** (Sozlash kartasida):
- *Avto* — Color sahifasida, klipning 1-node'iga LUT; plagin LUT haqiqatan qo'yilganini tekshiradi.
  Qo'yilmasa avtomatik **Fusion LUT** ga o'tadi.
- *Fusion LUT* — klipga Fusion `FileLUT` vositasi (GCGrade) qo'shiladi, **Edit sahifasida darhol ko'rinadi**.
  Rang timeline'da ko'rinmasa shu usulni tanlang.
- *Faqat Color sahifasi* — faqat node LUT.

Natijada qaysi usul ishlatilgani yoziladi. LUT fayllari: `%ProgramData%\Blackmagic Design\DaVinci Resolve\Support\LUT\GeminiCut`
(yozib bo'lmasa `Documents\GeminiCut\LUT`). Hech biri ishlamasa — CDL bilan qo'llanadi.
Kadr olinmasa ham tayyor uslublar qo'llanadi (avto balanssiz).

## Matn animatsiyalari va 3D Liquid
Premiere versiyasidagi bilan bir xil: 12 ta 2D shablon, 17 ta fonli matn (shaffof shisha, 3D chat pufagi, rasmdagi kabi 3D promo bloklar va
boshqalar, matnsiz rejim bilan), 12 ta Gym shabloni va 3D bo'limi: FitCity logolari (asl rang va shaklda 3D),
o'z logongizni yuklash va 11 ta 3D matn.

### Resolve'ning o'zida tahrirlash (Fusion)
**Tahrirlanadigan** rejimida (standart) matn va logolar Fusion vositalari bilan quriladi:
- Klipni tanlang → **Fusion** sahifasi. Tugunlar: **GCMatn** (Text+ — matn, shrift, rang, o'lcham, kontur,
  soya), **GCOstMatn** (ikkinchi qator), **GCPlashka / GCPlashkaShakl** (fon va uning o'lchami, burchak
  yumaloqligi), **GCHarakat** (animatsiya keyframe'lari), **GCKorinish** (paydo bo'lish/yo'qolish — Blend).
- 3D logo: **GCLogoRasm** (asl PNG), **GCLogoQatlam0…11** (qalinlik qatlamlari), **GCLogo3D** (aylanish,
  o'lcham, joy — Transform 3D), **GCLogoRender**.
- Edit sahifasidagi Inspector (Zoom, Position, Opacity, keyframe'lar) ham ishlaydi.
- Kadrlar zaxira sifatida **MediaIn1** da turadi: Fusion biror sababga ko'ra qurilmasa, panel buni aytadi
  va klip PNG bo'lib qoladi. **Kadrlar (PNG)** rejimi — natija aynan oldindan ko'rishdagidek.
- Sanagich, taymer, yozuv mashinkasi va 3D suyuq matnlar Resolve'da doim kadrlar (PNG) bo'lib qo'yiladi.
- Panel orqali qayta tahrirlash: playhead'ni matn ustiga qo'yib **Tanlangan matnni tahrirlash**.

## Boshqa kompyuterga berish
- Faqat `GeminiCut-Resolve-Setup.bat` faylini yuboring. Kerak: **DaVinci Resolve Studio 20+** (bepul
  versiyada Workflow Integration menyusi yo'q — bu Blackmagic cheklovi).
- "Windows protected your PC" → **More info → Run anyway**. Administrator so'rovida **Ha**.
- GitHub'dan: **Download raw file**. Qator oxirlari buzilgan bo'lsa ham o'rnatuvchi o'zini tuzatadi.

## O'chirish
`GeminiCut-Resolve-Setup.bat` → `2`, yoki `GeminiCut-Resolve-Setup.bat /U`.

## Ishlab chiquvchilar uchun
```
./tools/build-resolve.sh
node --test davinci-gemini-plugin/tests/*.test.cjs
node davinci-gemini-plugin/tests/ui.e2e.cjs
python3 davinci-gemini-plugin/tests/fusion_lua_check.py   # pip install lupa
```

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
