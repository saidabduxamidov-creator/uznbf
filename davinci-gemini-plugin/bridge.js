/*
 * GeminiCut - DaVinci Resolve bilan aloqa (Premiere'dagi cep.js o'rnini bosadi).
 * Panel kodi GCHost.call("gc_...") ni chaqiradi - bu yerda Electron IPC orqali
 * asosiy jarayondagi Resolve host'iga (host.js) uzatiladi. window.cep dialoglari ham shu yerda.
 */
(function (root) {
  "use strict";

  const { ipcRenderer } = require("electron");
  document.body.classList.add("resolve");

  function withTimeout(p, ms, msg) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(msg)), ms || 60000);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  async function call(fn, args, timeoutMs) {
    const res = await withTimeout(ipcRenderer.invoke("gc", fn, args || []), timeoutMs || 60000, "Resolve javob bermadi (timeout).");
    if (!res || !res.ok) throw new Error((res && res.error) || "Noma'lum xato");
    return res;
  }

  const ensureHost = () => call("gc_ping", [], 20000);
  const openUrl = (url) => ipcRenderer.send("gc-open-url", url);
  const saveDialog = (title, name, types) => ipcRenderer.sendSync("gc-dialog", "save", { title, name, types: types || ["srt"] }) || null;
  const openDialog = (title, types, multi) => { const r = ipcRenderer.sendSync("gc-dialog", "open", { title, types, multi }); return multi ? r : r[0] || null; };

  // CEP bilan mos interfeys: panel modullari window.cep.fs / window.cep.util dan foydalanadi
  root.cep = {
    util: { openURLInDefaultBrowser: openUrl },
    fs: {
      showOpenDialogEx(multi, dirs, title, initial, types) {
        const r = openDialog(title, types, multi);
        const list = multi ? r : r ? [r] : [];
        return { err: 0, data: list };
      },
      showSaveDialogEx(title, initial, types, name) {
        const p = saveDialog(title, name, types);
        return p ? { err: 0, data: p } : { err: 1 };
      },
    },
  };

  root.GCHost = { available: true, app: "resolve", evalScript: () => Promise.resolve(""), call, ensureHost, openUrl, saveDialog, openDialog };
})(window);
