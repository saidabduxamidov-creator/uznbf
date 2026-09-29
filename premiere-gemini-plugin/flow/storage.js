'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { throw new Error('Mahalliy sozlama buzilgan: ' + path.basename(file)); }
}
function crypt(mode, buffer) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Sessiya himoyasi Windows DPAPI talab qiladi.'));
  return new Promise((resolve, reject) => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'vault.ps1'), '-Mode', mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let result = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Sessiya himoyasi javob bermadi.')); }, 15000);
    child.stdout.on('data', d => { result += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Windows sessiya himoyasi ishga tushmadi.')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.from(result.trim(), 'base64')) : reject(new Error('Sessiyani shu Windows akkauntida qayta saqlang.')); });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer.toString('base64'));
  });
}
async function saveSecret(file, data) {
  const protectedBytes = await crypt('protect', Buffer.from(JSON.stringify(data), 'utf8'));
  atomicJSON(file, { version: 1, dpapi: protectedBytes.toString('base64') });
}
async function readSecret(file) {
  const record = readJSON(file, null);
  if (!record) return null;
  return JSON.parse((await crypt('unprotect', Buffer.from(record.dpapi, 'base64'))).toString('utf8'));
}
function googleDomain(domain) {
  return /(^|\.)(google\.com|labs\.google)$/.test(String(domain).replace(/^\./, '').toLowerCase());
}
function normalizeCookies(input) {
  let value;
  try { value = typeof input === 'string' ? JSON.parse(input) : input; }
  catch (_) { throw new Error('Cookies JSON ro‘yxati bo‘lishi kerak.'); }
  const list = Array.isArray(value) ? value : value && value.cookies;
  if (!Array.isArray(list) || !list.length || list.length > 500) throw new Error('Cookies ro‘yxati bo‘sh yoki noto‘g‘ri.');
  return list.map(c => {
    if (!c || typeof c.name !== 'string' || !c.name || typeof c.value !== 'string' || !googleDomain(c.domain)) throw new Error('Faqat Google domeniga tegishli cookies qabul qilinadi.');
    const cookie = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly };
    const same = { strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None' }[String(c.sameSite).toLowerCase()];
    if (same) cookie.sameSite = same;
    const expires = Number(c.expires === undefined ? c.expirationDate : c.expires);
    if (Number.isFinite(expires) && expires > 0 && !c.session) cookie.expires = expires;
    return cookie;
  });
}
function validateFlowURL(value) {
  let url;
  try { url = new URL(value || 'https://labs.google/fx/tools/flow'); }
  catch (_) { throw new Error('Flow loyiha havolasi noto‘g‘ri.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'labs.google' || !/^\/fx\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?tools\/flow(?:\/|$)/.test(url.pathname) || url.username || url.password || url.port) throw new Error('https://labs.google/fx/tools/flow havolasini kiriting.');
  return url.href;
}
function validateProfile(value) {
  if (!value || !path.isAbsolute(value)) throw new Error('Brauzer profilining to‘liq yo‘lini kiriting.');
  const normalized = path.resolve(value);
  // Main Chrome profiles cannot be automated by current Chrome versions.
  if (/\\(?:Google\\Chrome|Microsoft\\Edge)\\User Data(?:\\|$)/i.test(normalized)) throw new Error('Kundalik Chrome/Edge profili o‘rniga alohida Flow profil papkasini tanlang.');
  return normalized;
}
module.exports = { atomicJSON, readJSON, saveSecret, readSecret, normalizeCookies, validateFlowURL, validateProfile };
