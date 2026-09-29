/*
 * GeminiCut for DaVinci Resolve Studio - Workflow Integration plugin (Electron asosiy jarayoni).
 * Resolve: Workspace -> Workflow Integrations -> GeminiCut
 *
 * WorkflowIntegration.node - Resolve Studio bilan birga keladigan modul; o'rnatuvchi uni
 * Resolve'ning Developer papkasidan shu yerga nusxalaydi.
 */
"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { createHost } = require("./host.js");

const PLUGIN_ID = "com.uzstudio.geminicut";
let WorkflowIntegration = null;
let host = null;
let win = null;

async function initResolve() {
  try {
    WorkflowIntegration = require("./WorkflowIntegration.node");
  } catch (e) {
    throw new Error("WorkflowIntegration.node topilmadi. GeminiCut-Resolve-Setup.bat ni qayta ishga tushiring.");
  }
  const ok = await WorkflowIntegration.Initialize(PLUGIN_ID);
  if (!ok) throw new Error("Resolve bilan bog'lanib bo'lmadi. Workflow Integration faqat DaVinci Resolve Studio'da ishlaydi.");
  const resolve = await WorkflowIntegration.GetResolve();
  if (!resolve) throw new Error("Resolve obyekti olinmadi.");
  host = createHost(resolve, { fs, path });
}

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 860,
    minWidth: 360,
    minHeight: 520,
    title: "GeminiCut",
    backgroundColor: "#101216",
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "client", "index.html"));
  // Tashqi havolalar standart brauzerda ochilsin
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

let initError = null;
const ready = initResolve().catch((e) => { initError = e; });

ipcMain.handle("gc", async (event, fn, args) => {
  await ready;
  if (initError) return { ok: false, error: initError.message };
  if (!host || typeof host[fn] !== "function") return { ok: false, error: "Noma'lum buyruq: " + fn };
  return host[fn](...(args || []));
});

ipcMain.on("gc-dialog", (event, kind, opts) => {
  try {
    if (kind === "open") {
      const r = dialog.showOpenDialogSync(win, { title: opts.title, filters: opts.types && opts.types.length ? [{ name: opts.types.join(", "), extensions: opts.types }] : [],
        properties: ["openFile"].concat(opts.multi ? ["multiSelections"] : []) });
      event.returnValue = r || [];
    } else {
      const r = dialog.showSaveDialogSync(win, { title: opts.title, defaultPath: opts.name, filters: opts.types && opts.types.length ? [{ name: opts.types.join(", "), extensions: opts.types }] : [] });
      event.returnValue = r || "";
    }
  } catch (e) { event.returnValue = kind === "open" ? [] : ""; }
});

ipcMain.on("gc-open-url", (event, url) => { shell.openExternal(url); });

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  try { if (WorkflowIntegration) WorkflowIntegration.CleanUp(); } catch (e) { /* e'tiborsiz */ }
  app.quit();
});
