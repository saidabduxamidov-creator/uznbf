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
| Claude kadrlari / Video AI kadri | `ExportCurrentFrameAsStill` orqali |
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

LUT fayllari: `%ProgramData%\Blackmagic Design\DaVinci Resolve\Support\LUT\GeminiCut`
(o'rnatuvchi papkani yaratib, yozish ruxsatini beradi). LUT qabul qilinmasa — CDL bilan qo'llanadi.

## Matn animatsiyalari va 3D Liquid
Premiere versiyasidagi bilan bir xil: 12 ta 2D shablon va 7 ta 3D suyuq matn (oltin, xrom, jele, shisha,
tomchilar, lava, candy). Plagin kadrlarni shaffof PNG qilib chizadi, Media Pool → GeminiCut → Matn ga
import qiladi va videodan yuqoridagi bo'sh trekka qo'yadi. **Playhead'dagi matnni tahrirlash** →
o'zgartiring → **Yangilash**.

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
