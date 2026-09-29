/* CEP UI / modern Node worker bridge. Secrets only travel over private stdin. */
(function () {
  'use strict';
  const fs = require('fs'), path = require('path'), childProcess = require('child_process');
  const $ = id => document.getElementById(id);
  let worker = null, counter = 0, pending = {}, busy = false, lastJob = null, hostReady = false;
  let statusTimer;
  function message(text, error) {
    $('flowStatus').textContent = text; $('flowStatus').classList.toggle('error', !!error);
  }
  function extensionRoot() {
    const raw = window.__adobe_cep__.getSystemPath('extension');
    return decodeURI(raw.replace(/^file:\/{2,3}/, ''));
  }
  function setBusy(on) {
    busy = on;
    document.querySelectorAll('[data-flow-idle]').forEach(el => { el.disabled = on; });
    $('flowCancel').disabled = !on;
    if (window.GCApplication) window.GCApplication.lockFlow(on);
  }
  function shutdown(error) {
    Object.keys(pending).forEach(id => { clearTimeout(pending[id].timer); pending[id].reject(new Error(error)); });
    pending = {}; worker = null; setBusy(false);
  }
  function ensureWorker() {
    if (worker) return worker;
    if (!window.GCHost.available) throw new Error('Flow bo‘limini Premiere Pro ichida oching.');
    const executable = $('flowNode').value.trim() || 'node';
    localStorage.setItem('geminicut.flow.node', executable);
    const root = extensionRoot();
    const child = childProcess.spawn(executable, [path.join(root, 'flow', 'server.js')], { cwd: path.join(root, 'flow'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    worker = child; let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let data; try { data = JSON.parse(line); } catch (_) { continue; }
        if (data.type === 'progress') { lastJob = data.job; renderJob(data.job); continue; }
        if (data.type === 'notice') { message(data.message, true); continue; }
        const task = pending[data.id];
        if (!task) continue;
        delete pending[data.id]; clearTimeout(task.timer);
        data.ok ? task.resolve(data.result) : task.reject(new Error(data.error));
      }
    });
    // stderr may contain Google session URLs; do not log it into the panel.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => shutdown('Flow yordamchisi ochilmadi. Node.js 20+ va Flow Runtime’ni o‘rnating.'));
    child.on('exit', () => { if (worker === child) shutdown('Flow yordamchisi yopildi. Saqlangan videoni qayta ochganda import qilish mumkin.'); });
    return child;
  }
  function call(command, data, timeout) {
    return new Promise((resolve, reject) => {
      let process; try { process = ensureWorker(); } catch (e) { reject(e); return; }
      const id = ++counter;
      const timer = setTimeout(() => { delete pending[id]; reject(new Error('Yordamchi javob bermadi. Generatsiyani qayta yuborishdan oldin Flow holatini tekshiring.')); }, timeout || 90000);
      pending[id] = { resolve, reject, timer };
      process.stdin.write(JSON.stringify({ id, command, data: data || {} }) + '\n');
    });
  }
  function renderJob(job) {
    if (!job) return;
    message(job.message || 'Tayyorlanmoqda…', /failed|interrupted/.test(job.stage));
    const stages = ['preparing','upload','polling','download','downloaded','imported'];
    const idx = stages.indexOf(job.stage);
    document.querySelectorAll('#flowSteps li').forEach((el, i) => { el.classList.toggle('done', idx > i || job.stage === 'imported'); el.classList.toggle('now', idx === i); });
    $('flowResult').hidden = !job.video;
    $('flowResultPath').textContent = job.video || '';
    $('flowImport').disabled = !!job.imported || busy;
    if (job.capture) $('flowCaptureInfo').textContent = job.capture.sequenceName + ' · ' + job.capture.seconds.toFixed(2) + ' s';
  }
  function fillStatus(data) {
    $('flowMode').value = data.config.mode; $('flowChannel').value = data.config.channel;
    $('flowProfile').value = data.config.profilePath || ''; $('flowProject').value = data.config.projectURL;
    $('flowAccountState').textContent = data.saved ? 'Saqlangan · tekshirish kerak' : 'Ulanmagan';
    $('flowAdapterPath').textContent = data.adapterPath;
    lastJob = data.last; $('flowResult').hidden = !lastJob || !lastJob.video;
    if (lastJob) renderJob(lastJob); syncMode();
  }
  function syncMode() { $('flowCookiesWrap').hidden = $('flowMode').value !== 'cookies'; $('flowProfileWrap').hidden = $('flowMode').value !== 'profile'; }
  async function host() {
    if (hostReady) return;
    await GCHost.ensureHost();
    await GCHost.evalScript('$.evalFile(' + JSON.stringify(path.join(extensionRoot(), 'host', 'hostscript.jsx')).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ')');
    hostReady = true;
  }
  async function importJob(job, file) {
    await host();
    const capture = job.capture;
    const result = await GCHost.call('gc_flowImport', [file || job.video, capture.sequenceID, capture.ticks, capture.projectPath, $('flowPosition').value === 'current'], 120000);
    if (!file) { await call('imported', { id: job.id }); job.imported = true; }
    message(result.alreadyPlaced ? 'Bu video timeline’da allaqachon mavjud.' : 'Video yangi V' + result.track + ' trekka qo‘shildi.');
    $('flowImport').disabled = true;
  }
  async function action(fn) {
    if (busy) return;
    if (window.GCApplication && window.GCApplication.isBusy()) { message('Subtitr yoki montaj ishi yakunlanishini kuting.', true); return; }
    setBusy(true);
    try { await fn(); } catch (e) { message(e.message, true); }
    finally { setBusy(false); if (lastJob && lastJob.imported) $('flowImport').disabled = true; }
  }
  function init() {
    $('flowNode').value = localStorage.getItem('geminicut.flow.node') || 'node';
    $('flowMode').onchange = syncMode;
    $('flowSave').onclick = () => action(async () => {
      const data = await call('save', { mode: $('flowMode').value, profilePath: $('flowProfile').value.trim(), channel: $('flowChannel').value, projectURL: $('flowProject').value.trim(), cookies: $('flowCookies').value });
      $('flowCookies').value = ''; fillStatus(data); message('Akkaunt sozlamalari saqlandi. Brauzerni ochib ulanishni tekshiring.');
    });
    $('flowOpen').onclick = () => action(async () => { await call('open'); message('Flow brauzeri ochildi. Kerak bo‘lsa Google’ga kiring va loyiha oching.'); });
    $('flowCheck').onclick = () => action(async () => { await call('check'); $('flowAccountState').textContent = 'Ulangan'; message('Flow sessiyasi ishlayapti.'); });
    $('flowDisconnect').onclick = () => action(async () => { fillStatus(await call('disconnect')); message('Ulanish unutildi. Sizning brauzer profilingiz o‘chirilmagan.'); });
    $('flowGenerate').onclick = () => action(async () => {
      const prompt = $('flowPrompt').value.trim(); if (!prompt) throw new Error('Kadrda qanday harakat bo‘lishini yozing.');
      await host(); const job = await call('prepare');
      const capture = await GCHost.call('gc_flowCapture', [job.frameBase], 60000);
      lastJob = Object.assign(job, { capture }); $('flowCaptureInfo').textContent = capture.sequenceName + ' · ' + capture.seconds.toFixed(2) + ' s';
      const result = await call('run', { id: job.id, prompt, capture }, 25 * 60 * 1000);
      lastJob = result.job; renderJob(lastJob);
      if ($('flowAutoImport').checked) { await importJob(lastJob); lastJob.imported = true; }
    });
    $('flowCancel').onclick = async () => { try { await call('cancel'); message('Kutish to‘xtatildi. Flow’da yuborilgan generatsiya davom etishi mumkin.'); } catch (e) { message(e.message, true); } };
    $('flowImport').onclick = () => action(async () => { if (!lastJob || !lastJob.video) throw new Error('Tayyor video yo‘q.'); await importJob(lastJob); lastJob.imported = true; });
    $('flowDismiss').onclick = () => action(async () => { fillStatus(await call('dismiss')); message('Natija yopildi. Yuklangan MP4 saqlanadi.'); });
    $('flowManual').onclick = () => action(async () => {
      const file = GCHost.openDialog('Flow’dan yuklangan MP4 ni tanlang', ['mp4']); if (!file) return;
      if (!lastJob || !lastJob.capture) throw new Error('Avval “Generatsiya” orqali timeline manzilini belgilang.');
      await importJob(lastJob, file);
    });
    $('flowRuntime').onclick = () => {
      try { const process = childProcess.spawn('explorer.exe', [path.join(extensionRoot(), 'flow')], { windowsHide: true, stdio: 'ignore', detached: true }); process.on('error', () => message('Paketdagi Flow-Runtime-Setup.bat faylini oching.')); process.unref(); }
      catch (_) { message('O‘rnatuvchi bilan berilgan Flow-Runtime-Setup.bat faylini oching.'); }
    };
    $('flowSystemPrompt').textContent = 'Yuz va tana, kiyim va logotiplar, fon va yorug‘likni saqlash bo‘yicha siz bergan to‘liq ko‘rsatma promptga avtomatik qo‘shiladi.';
    syncMode();
    // Lazy launch avoids an extra process for users working only with subtitles.
    const tab = document.querySelector('[data-tab="flow"]');
    tab.addEventListener('click', () => { if (!worker && GCHost.available) call('status').then(fillStatus).catch(e => message(e.message, true)); });
    window.addEventListener('beforeunload', () => { clearInterval(statusTimer); if (worker) worker.stdin.end(); });
  }
  window.GCFlow = { init };
})();
