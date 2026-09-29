(function () {
  'use strict';
  const fs = require('fs'), path = require('path'), os = require('os');
  const $ = id => document.getElementById(id);
  const root = path.join(os.homedir(), 'Documents', 'GeminiCut');
  const library = path.join(root, 'Sounds');
  const notePath = path.join(root, 'notes.txt');
  const extensions = /\.(wav|mp3|m4a|aac|aiff|aif|ogg|flac)$/i;
  let folder = 'Mening effektlarim', generation = 0;
  const status = text => { $('soundStatus').textContent = text; };
  const attempt = fn => async () => { try { await fn(); } catch (e) { status(e.message); } };
  function button(text, fn) {
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = text;
    b.onclick = attempt(fn); return b;
  }
  function folders() {
    $('soundFolders').textContent = '';
    fs.readdirSync(library).filter(n => fs.statSync(path.join(library, n)).isDirectory()).forEach(n => {
      const b = button('▸ ' + n, () => { folder = n; folders(); files(); });
      b.className += ' sound-folder' + (n === folder ? ' on' : ''); $('soundFolders').appendChild(b);
    });
  }
  async function waveform(file, canvas, current) {
    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = fs.readFileSync(file);
      const audio = await ctx.decodeAudioData(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
      if (current !== generation) return;
      const samples = audio.getChannelData(0), g = canvas.getContext('2d');
      g.fillStyle = '#48cfae';
      for (let x = 0; x < 240; x++) {
        let peak = 0;
        for (let j = Math.floor(x * samples.length / 240); j < (x + 1) * samples.length / 240; j += Math.max(1, Math.floor(samples.length / 24000))) peak = Math.max(peak, Math.abs(samples[j]));
        g.fillRect(x, 19 - peak * 18, 1, Math.max(1, peak * 36));
      }
      canvas.title = audio.duration.toFixed(2) + ' soniya';
    } catch (e) { canvas.title = 'Waveform ochilmadi; tinglash yoki Premiere importini sinang.'; }
    finally { if (ctx) ctx.close(); }
  }
  async function files() {
    const current = ++generation, list = $('soundList'); list.textContent = '';
    const names = fs.readdirSync(path.join(library, folder)).filter(n => extensions.test(n) && n.toLowerCase().includes($('soundSearch').value.toLowerCase()));
    status(names.length ? names.length + ' ta effekt · ' + folder : 'Papka bo‘sh. Audio fayllarni yuklang.');
    for (const n of names) {
      if (current !== generation) return;
      const file = path.join(library, folder, n), row = document.createElement('div'); row.className = 'sound-item';
      const title = document.createElement('strong'); title.textContent = n; row.appendChild(title);
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 38; row.appendChild(canvas);
      row.appendChild(button('▶ Tinglash', async () => { $('soundPlayer').src = require('url').pathToFileURL(file).href; await $('soundPlayer').play(); }));
      row.appendChild(button('+ Timeline', async () => {
        if (window.GCApplication && window.GCApplication.isBusy()) throw new Error('Joriy ish tugashini kuting.');
        const track = Number($('soundTrack').value);
        if (!Number.isInteger(track) || track < 1) throw new Error('Audio trek raqamini to‘g‘ri kiriting.');
        await GCHost.call('gc_insertSound', [file, track - 1]); status(n + ' timeline’ga qo‘shildi.');
      }));
      list.appendChild(row); await waveform(file, canvas, current);
    }
  }
  try {
    fs.mkdirSync(path.join(library, folder), { recursive: true });
    ['Transition', 'Impact & Hit', 'Foley', 'Typing'].forEach(n => fs.mkdirSync(path.join(library, n), { recursive: true }));
    folders(); files();
    $('newSoundFolder').onclick = attempt(() => {
      const n = $('soundFolderName').value.trim();
      if (!n || /[\\/:*?"<>|\x00-\x1f]/.test(n) || /[. ]$/.test(n) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(n)) throw new Error('Boshqa papka nomini kiriting.');
      fs.mkdirSync(path.join(library, n)); folder = n; $('soundFolderName').value = ''; folders(); files();
    });
    $('uploadSounds').onclick = attempt(() => {
      const r = window.cep.fs.showOpenDialogEx(true, false, 'Audio effektlarni tanlang', '', ['wav','mp3','m4a','aac','aiff','aif','ogg','flac']);
      if (!r || r.err || !r.data) return;
      r.data.forEach(file => {
        if (!extensions.test(file)) return;
        const ext = path.extname(file), base = path.basename(file, ext); let name = base + ext, i = 2;
        while (fs.existsSync(path.join(library, folder, name))) name = base + ' (' + i++ + ')' + ext;
        fs.copyFileSync(file, path.join(library, folder, name));
      }); files();
    });
    $('soundSearch').oninput = () => files();
    $('notesText').value = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : '';
    function save() {
      try { fs.writeFileSync(notePath, $('notesText').value, 'utf8'); $('notesStatus').textContent = 'Avtomatik saqlandi · ' + $('notesText').value.length + ' belgi'; }
      catch (e) { $('notesStatus').textContent = 'Saqlanmadi: ' + e.message; }
    }
    $('notesText').oninput = save;
    $('saveNotes').onclick = () => {
      try {
        const r = window.cep.fs.showSaveDialogEx('Qaydlarni saqlash', '', ['txt'], 'senariy.txt');
        if (r && !r.err && r.data) { fs.writeFileSync(r.data, $('notesText').value, 'utf8'); $('notesStatus').textContent = 'TXT saqlandi.'; }
      } catch (e) { $('notesStatus').textContent = e.message; }
    };
    $('loadNotes').onclick = () => {
      try {
        const file = GCHost.openDialog('TXT ochish', ['txt']); if (!file) return;
        const text = fs.readFileSync(file, 'utf8');
        $('notesText').value += ($('notesText').value ? '\n\n' : '') + text; save();
      } catch (e) { $('notesStatus').textContent = e.message; }
    };
  } catch (e) { status('Kutubxona ochilmadi: ' + e.message); }
})();
