# Mahalliy tekshiruvlar

Node.js 20+, Windows va Google Chrome kerak. Haqiqiy Google akkauntiga ulanilmaydi.

`node --test tests/flow.test.cjs` — 10 ta mantiqiy/DPAPI/host-mock sinovi.

`node tests/browser.cjs` va `node tests/ui.cjs` uchun avval `flow/Flow-Runtime-Setup.bat` ni ishga tushiring, so‘ng PowerShell’da:

```powershell
$env:NODE_PATH = "$env:LOCALAPPDATA\GeminiCut\FlowRuntime\node_modules"
node tests/browser.cjs
node tests/ui.cjs
```

Brauzer sinovi haqiqiy Chromium oynasida mahalliy taqlid qilingan Flow sahifasini ochadi; Google’ga generatsiya yubormaydi. UI sinovi disk va CEP o‘rniga test obyektlaridan foydalanadi. Ish fayllari tests/.scratch ichida qoladi.
