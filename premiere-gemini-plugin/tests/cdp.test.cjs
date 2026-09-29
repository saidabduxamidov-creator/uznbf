'use strict';
/* cdp.js ni haqiqiy Chromium'da sinaydi (Flow sahifasi taqlidi, internetsiz). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../client/js/cdp.js');
const C = globalThis.GCCdp;

const CHROME = process.env.CHROME || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(fs.existsSync);

test('CDP: kadr yuklash, prompt yozish, Generate, yuklab olishni ushlash', { skip: !CHROME && 'Chromium topilmadi' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cdp-'));
  const page = path.join(dir, 'flow.html');
  fs.writeFileSync(page, `<!doctype html><body>
    <div id="host"></div><div id="prompt" contenteditable="true" style="width:400px;height:80px;border:1px solid"></div>
    <button aria-label="Generate" id="gen">→</button><p id="log"></p>
    <script>
      const sr = document.getElementById('host').attachShadow({mode:'open'});
      sr.innerHTML = '<input type="file" accept="image/*" style="display:none">';
      sr.querySelector('input').addEventListener('change', e => { document.getElementById('log').textContent += 'file:' + e.target.files[0].name + ';'; });
      document.getElementById('gen').onclick = () => {
        document.getElementById('log').textContent += 'gen:' + document.getElementById('prompt').innerText + ';';
        const bytes = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]);
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], {type:'video/mp4'})); a.download = 'flow_result.mp4'; document.body.appendChild(a); a.click();
      };
    </script></body>`);
  const png = path.join(dir, 'frame.png'); fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const out = path.join(dir, 'out'); fs.mkdirSync(out);
  process.env.GEMINICUT_BROWSER = CHROME;
  const profile = path.join(dir, 'profile');
  const info = await C.launch({ profile, url: 'file://' + page, extraArgs: ['--headless=new', '--no-sandbox'] });
  const cdp = await C.CDP.connect(info.ws);
  try {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: out, eventsEnabled: true });
    const { targetInfos } = await cdp.send('Target.getTargets');
    const t = targetInfos.find(x => x.type === 'page' && /flow\.html/.test(x.url));
    assert.ok(t, 'sahifa topildi');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    const DEEP = `(function(sel){const out=[];const walk=(r)=>{r.querySelectorAll(sel).forEach(e=>out.push(e));r.querySelectorAll('*').forEach(e=>{if(e.shadowRoot)walk(e.shadowRoot)})};walk(document);return out;})`;
    const obj = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr }, sessionId)).result.objectId;
    const input = await obj(`${DEEP}('input[type=file]').filter(e=>!e.accept||/image/.test(e.accept)).pop()||null`);
    assert.ok(input, 'shadow DOM ichidagi fayl maydoni topildi');
    await cdp.send('DOM.setFileInputFiles', { files: [png], objectId: input }, sessionId);
    const box = await obj(`${DEEP}('textarea,[contenteditable="true"],[role="textbox"]').filter(e=>e.offsetParent!==null)[0]||null`);
    await cdp.send('Runtime.callFunctionOn', { objectId: box, functionDeclaration: "function(){this.focus();}" }, sessionId);
    const longPrompt = 'Kamera sekin yaqinlashsin. ' + 'x'.repeat(70000); // katta freym (>64KB) ham to'g'ri ketishi kerak
    await cdp.send('Input.insertText', { text: longPrompt }, sessionId);
    const done = new Promise(res => cdp.on('Browser.downloadProgress', p => { if (p.state === 'completed') res(p); }));
    const btn = await obj(`${DEEP}('button').filter(e=>/^(generate|create)$/i.test((e.getAttribute('aria-label')||'').trim())).pop()||null`);
    await cdp.send('Runtime.callFunctionOn', { objectId: btn, functionDeclaration: "function(){this.click();}" }, sessionId);
    const p = await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('download timeout')), 10000))]);
    const file = path.join(out, p.guid);
    assert.strictEqual(fs.readFileSync(file).toString('ascii', 4, 8), 'ftyp');
    const log = (await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("log").textContent', returnByValue: true }, sessionId)).result.value;
    assert.match(log, /file:frame\.png;/); assert.match(log, /gen:Kamera sekin yaqinlashsin\. x{100}/);
    const again = await C.launch({ profile }); // ochiq brauzer qayta ishlatiladi
    assert.strictEqual(again.reused, true);
  } finally {
    try { await cdp.send('Browser.close'); } catch (e) { /* yopildi */ }
    cdp.close();
  }
});
