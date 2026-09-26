# GeminiCut — Premiere Pro 2024 uchun AI plagin (Gemini AI integratsiyasi)

## Avval muhim izoh: ".apk" haqida
`.apk` — bu Android ilovalari formati, Premiere Pro plaginlariga aloqasi yo'q.
Premiere Pro plaginlari **CEP extension** (`.zxp` fayl) yoki UXP formatida
tarqatiladi. Quyida sizga CEP extension tayyorlab berdim — uni ham to'g'ridan-to'g'ri
papka sifatida (dasturchi rejimida), ham `.zxp` fayl sifatida o'rnatishni ko'rsataman.

## Plagin nima qiladi
1. Timeline'da tanlangan klipni Gemini AI'ga (video+audio) yuboradi.
2. Gemini o'zbekcha (yoki ruscha/inglizcha) nutqni tinglab:
   - uzoq pauzalarni, tutilib qolgan va qayta boshlangan gaplarni topadi,
   - ularni "cut" (kesish) sifatida belgilaydi,
   - muhim lahzalarda zoom in/out taklif qiladi.
3. Siz "Timeline'ga qo'llash" tugmasini bosasiz — plagin ExtendScript orqali
   avtomatik ravishda: pauzalarni ripple-delete qiladi va Motion→Scale
   keyframe'lari orqali zoom effektini qo'yadi.

## Loyiha tuzilishi
```
premiere-gemini-plugin/
├── CSXS/manifest.xml       ← extension manifesti (Premiere 2024 uchun sozlangan)
├── client/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── CSInterface.js  ← O'ZINGIZ QO'SHISHINGIZ KERAK (pastga qarang)
│       └── main.js         ← panel logikasi + Gemini API chaqiruvlari
└── host/
    └── host.jsx            ← Premiere ichida ishlaydigan ExtendScript kod
```

## 1-qadam: CSInterface.js faylini yuklab olish
Adobe bu faylni CEP ilovalari uchun rasmiy, bepul SDK sifatida taqdim etadi.
Uni loyihangizga o'zingiz qo'shishingiz kerak (litsenziya sabablari uchun bu
faylni men avtomatik yaratmadim):

1. https://github.com/Adobe-CEP/CEP-Resources manziliga o'ting
2. `CEP_11.x/CSInterface.js` (yoki eng yangi versiya) faylini toping
3. Uni `premiere-gemini-plugin/client/js/CSInterface.js` sifatida saqlang

## 2-qadam: Gemini API kalitini olish
1. https://aistudio.google.com/apikey ga kiring
2. "Create API key" tugmasini bosing, kalitni nusxalab oling
3. Plagin panelidagi "Gemini API kalit" maydoniga shu kalitni kiritasiz
   (kalit hech qayerga yuborilmaydi, faqat to'g'ridan-to'g'ri Google serveriga ketadi)

## 3-qadam: Dasturchi (debug) rejimini yoqish
Imzosiz (`.zxp`siz) extensionni ishga tushirish uchun Premiere'ga "ishonch"
bildirish kerak:

**Windows (Registry Editor — `regedit`):**
```
HKEY_CURRENT_USER\Software\Adobe\CSXS.11
    PlayerDebugMode = 1   (String qiymat)
```
(Premiere 2024 uchun CSXS versiyasi 9, 10 yoki 11 bo'lishi mumkin — agar 11
ishlamasa, `CSXS.9` va `CSXS.10` kalitlarini ham xuddi shunday qo'shib ko'ring)

**macOS (Terminal):**
```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.10 PlayerDebugMode 1
defaults write com.adobe.CSXS.9 PlayerDebugMode 1
```

## 4-qadam: Extensionni o'rnatish
Loyiha papkasini quyidagi manzilga ko'chiring (papka nomini o'zgartirmang):

**Windows:**
```
C:\Users\<FOYDALANUVCHI>\AppData\Roaming\Adobe\CEP\extensions\premiere-gemini-plugin
```

**macOS:**
```
~/Library/Application Support/Adobe/CEP/extensions/premiere-gemini-plugin
```

Agar `CEP\extensions` papkasi mavjud bo'lmasa — o'zingiz shu nom bilan yarating.

## 5-qadam: Premiere Pro'da ishga tushirish
1. Premiere Pro 2024'ni to'liq yoping va qayta oching
2. Yuqori menyu: **Window → Extensions → GeminiCut — AI Video Editor**
3. Panel ochiladi

## 6-qadam: Foydalanish
1. Timeline'da tahrirlamoqchi bo'lgan klipni bosib tanlang (select qiling)
2. Panelda **"Tanlash"** tugmasini bosing — fayl yo'li avtomatik yuklanadi
3. Gemini API kalitni kiriting, tilni tanlang
4. **"1) Gemini bilan tahlil qilish"** tugmasini bosing va kuting
   (video uzunligiga qarab 30 soniya — bir necha daqiqa)
5. Natijani log oynasida ko'rasiz (topilgan segmentlar/zoom takliflari soni)
6. **"2) Timeline'ga qo'llash"** tugmasini bosing — plagin avtomatik pauzalarni
   kesadi va zoom keyframe'larini qo'yadi

> Maslahat: har doim originalni nusxalab oling. Avtomatik ripple-delete
> qaytarib bo'lmaydigan amal emas (Ctrl+Z bilan bekor qilinadi), lekin uzun
> videoda ehtiyot bo'lish foydali.

## (Ixtiyoriy) .zxp fayl sifatida yig'ish
Boshqa kompyuterlarga tarqatmoqchi bo'lsangiz, ZXPSignCmd bilan imzolab
`.zxp` fayl yasashingiz mumkin:

1. https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD dan
   o'z platformangizga mos `ZXPSignCmd` ni yuklab oling
2. Sertifikat yarating:
   ```bash
   ZXPSignCmd -selfSignedCert US NY "GeminiCut" "UzStudio" parol123 cert.p12
   ```
3. Paketlang:
   ```bash
   ZXPSignCmd -sign premiere-gemini-plugin geminicut.zxp cert.p12 parol123
   ```
4. Hosil bo'lgan `geminicut.zxp` faylni **ExManCmd** yoki **Anastasiy Extension
   Manager** (bepul, uchinchi tomon) orqali o'rnatasiz.

## Bilish kerak bo'lgan cheklovlar
- `host/host.jsx` ichidagi ripple-delete va keyframe operatsiyalari qisman
  hujjatlanmagan **QE DOM** (`app.enableQE()`) dan foydalanadi — bu Adobe
  tomonidan rasmiy qo'llab-quvvatlanmaydi va Premiere versiyasiga qarab
  ba'zi metod nomlari farq qilishi mumkin. Agar xatolik chiqsa, log oynasidagi
  xabarni ko'rib, `host.jsx`dagi mos qatorni moslashtiring.
- Gemini'ning o'zbek tilidagi nutqni tushunish sifati aksent, fon shovqini va
  video sifatiga bog'liq — murakkab audio uchun natijani tekshirib chiqing.
- Uzun videolarda (>20-30 daqiqa) Gemini so'rovi vaqti va narxi oshadi;
  kerak bo'lsa videoni bo'laklarga bo'lib yuborish yaxshiroq.
