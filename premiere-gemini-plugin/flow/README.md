# Google Flow integratsiyasi — GeminiCut 3.2

## Ishga tushirish

1. `GeminiCut-Setup-3.2.0.bat` bilan panelni yangilang. Premiere yopiq bo‘lsin.
2. Node.js 20+ va Chrome yoki Edge kerak. Bir marta `Flow-Runtime-Setup.bat` ni ishga tushiring. U npm orqali aniq `playwright-core@1.58.2` versiyasini `%LOCALAPPDATA%/GeminiCut/FlowRuntime` papkasiga o‘rnatadi. Boshqa brauzer yuklanmaydi.
3. Paneldagi **Google Flow → Ulanishni saqlash → Brauzerni ochish** tugmalarini bosing. Profil yo‘lini bo‘sh qoldirsangiz alohida, qayta foydalaniladigan Flow profili yaratiladi. Google so‘rasa shu oynada kiring. Asosiy Chrome User Data papkasidan foydalanmang.
4. Muqobil usul: **Session cookies** ni tanlang, o‘zingiz eksport qilgan Google cookies JSON ro‘yxatini kiriting va saqlang. `Cookie: a=b` header satri emas, domen va boshqa atributlari bor JSON kerak. Cookie chatga yuborilmaydi. Google qo‘shimcha kirish tekshiruvini talab qilsa, brauzerda bajaring.
5. Flow’ni ingliz tilida oching, loyiha yarating/oching, **Video → Frames** rejimi va model, davomiylik, formatni tanlang. Bitta natija tanlang. Loyihaning havolasini panelga saqlash mumkin. **Ulanishni tekshirish** tugmasini bosing.
6. Premiere’da playhead’ni kerakli kadr ustiga qo‘ying, harakatni yozing va **Generatsiya**ni bosing. Shu bosish kadrni Google Flow’ga yuborish va akkauntingizdagi generatsiya kreditidan foydalanish amali hisoblanadi.
7. PNG eksport qilinadi, to‘liq consistency prompt qo‘shiladi, birinchi kadr sifatida yuklanadi, Generate bir marta bosiladi. Natija har 5 soniyada tekshiriladi. MP4 `Downloads/GeminiCut-Flow` papkasiga saqlanadi va standart holatda yangi video trekka qo‘shiladi.

## Kod tuzilmasi

- `client/index.html`: olti bo‘limli interfeys, Flow akkaunti, prompt, jarayon va import sozlamalari.
- `client/js/main.js`: mavjud subtitr/montaj logikasi, tablar va umumiy bandlik holati.
- `client/js/flow.js`: interfeys bilan Node worker o‘rtasidagi yopiq stdin/stdout aloqa; kadr olish, ishga tushirish va host importi.
- `flow/server.js`: sessiya, ish holati, PNG kutish, bekor qilish, yuklash, tiklanish. HTTP port ochmaydi.
- `flow/browser.js`: Playwright orqali haqiqiy brauzer interfeysi; faqat ko‘rinadigan boshqaruv elementlari va natijadagi media URL ishlatiladi.
- `flow/prompt.js`: foydalanuvchi bergan to‘liq prompt aynan saqlanadi.
- `flow/storage.js`, `flow/vault.ps1`: atomik config yozish va Windows DPAPI shifrlashi.
- `host/hostscript.jsx`: active frame PNG eksporti va video-only yangi trek importi.
- `client/css/studio.css`: barcha bo‘limlar uchun moslashuvchan dizayn.

## Sessiya va fayllar

`%LOCALAPPDATA%/GeminiCut/Flow/config.json` faqat profil yo‘li, brauzer va loyiha URL’ini saqlaydi. Cookie rejimida to‘liq browser storage state `session.dpapi.json` ichida DPAPI CurrentUser bilan shifrlanadi; ochiq cookie qiymatlari config, LocalStorage yoki logga yozilmaydi. Profil rejimida brauzer o‘z profil saqlash mexanizmidan foydalanadi. **Ulanishni unutish** saqlangan ulanish va cookie vault’ini unutadi, foydalanuvchining profil papkasini o‘chirmaydi.

Sessiya Google tomonidan bekor qilinsa/muddati tugasa qayta kirish talab qilinadi. “Hech qachon login so‘ramaydi” kafolati yo‘q.

PNG `%TEMP%/GeminiCut-Flow/<job-id>` ichida vaqtincha saqlanadi va ish tugaganda o‘chiriladi. MP4 fayli `.part` dan yakuniy nomga faqat to‘liq yuklash va MP4 header tekshiruvidan keyin o‘tadi. MP4’lar avtomatik o‘chirilmaydi. `last-job.json` oxirgi ish, sequence ID va import holatini saqlaydi; prompt yoki cookie emas.

## Flow interfeysi o‘zgarsa

Bu Google’ning rasmiy Flow API integratsiyasi emas. Hujjatdagi inglizcha accessible nomlarga asoslangan brauzer adapteridir; haqiqiy akkaunt bilan end-to-end moslik hali tasdiqlanmagan. Login, kredit, model yoki mamlakat cheklovi kod bilan chetlab o‘tilmaydi. “First Frame” va “Ingredient” bir xil boshqaruv emas: kod aynan **Start Frame** joyini ishlatadi.

Panelda ko‘rsatilgan `%LOCALAPPDATA%/GeminiCut/Flow/adapter.json` fayli boshida `{}` bo‘ladi. Kerakli CSS selektorlar kuzatilgan Flow interfeysiga moslab kiritiladi. Selektor noaniq bo‘lsa generatsiya yuborilmaydi. **Ulanishni saqlash** brauzer adapterini yangidan yuklaydi. Cookie qayta kiritilishi shart emas.

Ixtiyoriy kalitlar:

| Kalit | Vazifasi |
|---|---|
| `newProject` | Yangi loyiha tugmasi |
| `prompt` | Bitta textarea yoki contenteditable matn maydoni |
| `modeMenu`, `framesMode` | Frames rejimini tanlash |
| `startFrame` | Aynan birinchi kadr yuklash tugmasi |
| `upload`, `fileInput` | Yuklash oynasidagi tugma va input[type=file] |
| `confirmUpload` | Crop/save yoki rasmni tasdiqlash tugmasi |
| `frameReady` | Composer’da birinchi kadr yuklangach ko‘rinadigan element |
| `generate` | Bitta generatsiya yuborish tugmasi |
| `generationError` | Faqat joriy generatsiya xatosida ko‘rinadigan element |
| `resultVideo` | Generatsiya natijasidagi video elementlar (namunaviy videolar emas) |
| `resultCard` | Har bir video kartasining konteyneri |
| `download` | Shu karta ichidagi Download tugmasi |
| `downloadQuality` | MP4 sifatini tanlash menyusi |

Selectorlar namunasi ataylab uydirib to‘ldirilmagan. Flow’ning turli hisoblarda ko‘rinishi farq qilishi mumkin. Panel aniq bo‘lmagan natijani import qilmaydi; bir nechta yangi video chiqsa **Tayyor MP4 ni tanlash** orqali keraklisini tanlang. Ish paytida Flow oynasida boshqa generatsiya boshlamang yoki eski video kartalarini ochmang.

## Import va xatolar

- Kadr olingan sequence ID va loyiha tekshiriladi. Boshqa sequence ochilgan bo‘lsa video diskda qoladi; asl sequence’ni ochib **Timeline’ga qo‘shish**ni qayta bosing.
- Joyni **Kadr olingan joyga** yoki **Import paytidagi playhead joyiga** deb tanlash mumkin.
- Yangi yuqori video trek yaratiladi. Generated audio mavjud nutq/musiqa treklarini yozib ketmasligi uchun video-only subclip qo‘shiladi; asl MP4 Project Bin’da qoladi.
- PNG va yangi trek uchun QE metodlari ishlatiladi. Adobe versiyasiga qarab mavjud bo‘lmasligi mumkin; bunday holatda xato chiqadi va MP4 saqlanadi.
- Generate bosish noaniq natija bersa avtomatik qayta yuborilmaydi. **Bekor qilish** mahalliy kutishni to‘xtatadi; Google serveridagi oldin yuborilgan generatsiya/kredit sarfini bekor qilishni kafolatlamaydi.
- Kutish 20 daqiqadan keyin tugaydi. Natijani Flow’da tekshiring va MP4’ni qo‘lda tanlash orqali davom eting.
- Prompt yuz, kiyim, fon va logotipni saqlashni talab qiladi, lekin generativ modelning mutlaq aniqligini kafolatlamaydi.

## Tekshiruv doirasi

Mahalliy tekshiruvlar: JS sintaksisi; DPAPI round-trip; cookie/domain validatsiyasi; prompt; ish holati, bekor qilish va uzilish; .part tozalash; duplicate import va sequence himoyasi; test sahifasida haqiqiy Chrome orqali rasm upload → prompt → bitta submit → polling → MP4 download; 340, 420, 800, 1100 px da oltita bo‘lim ko‘rinishi va asosiy UI amallari.

Sinov sahifasidagi provider natijalari taqlid qilingan, haqiqiy video generatsiyasi emas. Premiere host tekshiruvlari mock obyektlarda bajarilgan. Haqiqiy Premiere/Google Flow akkaunti bilan yakuniy sinov bajarilmagan.

## Asos bo‘lgan hujjatlar

- [Google Flow: video va start/end frame](https://support.google.com/flow/answer/16353334?hl=en)
- [Adobe CEP: QE PNG eksport namunasi](https://github.com/Adobe-CEP/Samples/blob/master/TypeScript/PProPanel-vscode/dom_app/src/Premiere.jsx)
- [Adobe: ProjectItem, createSubClip va Track turlari](https://github.com/Adobe-CEP/Samples/blob/master/PProPanel/jsx/PremierePro.23.0.d.ts)
- [Playwright: persistent context va alohida profil](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
- [Playwright: download saqlash](https://playwright.dev/docs/api/class-download)
- [Microsoft: DPAPI ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata.protect)
