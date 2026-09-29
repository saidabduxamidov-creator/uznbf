# GeminiCut — DaVinci Resolve Studio uchun

## O'rnatish
1. DaVinci Resolve'ni yoping.
2. `GeminiCut-Resolve-Setup.bat` ni ishga tushiring (administrator ruxsati so'raladi) → `1` → `Y`.
3. Resolve'ni oching → loyiha va timeline → **Workspace > Workflow Integrations > GeminiCut**.
4. Sozlamalar: Gemini API kaliti (https://aistudio.google.com/apikey), Claude uchun Anthropic kaliti.

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

## O'chirish
`GeminiCut-Resolve-Setup.bat` → `2`, yoki `GeminiCut-Resolve-Setup.bat /U`.

## Ishlab chiquvchilar uchun
```
./tools/build-resolve.sh
node --test davinci-gemini-plugin/tests/*.test.cjs
node davinci-gemini-plugin/tests/ui.e2e.cjs
python3 davinci-gemini-plugin/tests/fusion_lua_check.py   # pip install lupa
```
