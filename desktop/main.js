'use strict';
// Electron entry point: starts the local library server and shows it in a window.

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { startServer } = require('./server');
const { createUpdater } = require('./lib/updates');
const updates = createUpdater();

let win = null;
let port = null;

// crash log: kept in the app's data folder and added to problem reports
const crashLog = () => path.join(app.getPath('userData'), 'crash.log');
function logCrash(what) {
  try {
    const f = crashLog();
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(-15000) : '';
    fs.writeFileSync(f, old + `\n[${new Date().toISOString()}] v${app.getVersion()} ${what}\n`);
  } catch (_) {}
}
process.on('uncaughtException', (e) => logCrash('main process: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => logCrash('main process (promise): ' + (e && e.stack || e)));
app.on('render-process-gone', (_e, _wc, d) => logCrash(`window closed unexpectedly: ${d.reason} (exit code ${d.exitCode})`));
app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') logCrash(`${d.type} process gone: ${d.reason} (exit code ${d.exitCode})`); });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    port = await startServer({
      dataDir: path.join(app.getPath('userData'), 'library'),
      port: 47321,
      version: app.getVersion(),
      crashLog: crashLog(),
      updates,
      openExternal: (url) => shell.openExternal(url),
      openEdge: (url) => shell.openExternal('microsoft-edge:' + url).catch(() => shell.openExternal(url)),
      findChrome,
      openChrome: (url) => {
        const exe = findChrome();
        if (!exe) return false;
        spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref();
        return true;
      },
      openPath: (p) => shell.openPath(p),
      pickFolder: async (title) => {
        const r = await dialog.showOpenDialog(win, {
          title: title || 'Choose where to save the audio files',
          defaultPath: app.getPath('music'),
          properties: ['openDirectory', 'createDirectory']
        });
        return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
      }
    });
    createWindow();
    updates.start();
  });

  app.on('window-all-closed', () => app.quit());
}

/** Locates Google Chrome on Windows (Google's voices only exist inside Chrome). */
function findChrome() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'Shelf Reader',
    backgroundColor: '#161616',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep reading aloud when minimized
      spellcheck: false
    }
  });
  // if the page itself crashes, bring it back instead of leaving a blank window
  win.webContents.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit' && win && !win.isDestroyed()) setTimeout(() => { try { win.reload(); } catch (_) {} }, 800); });
  win.removeMenu();
  win.loadURL(`http://127.0.0.1:${port}/`);
  // Links that leave the app open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${port}/maker.html`)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 900, autoHideMenuBar: true, backgroundColor: '#141414', title: 'Audiobook maker' } };
    }
    if (/^https?:\/\//.test(url) && !url.startsWith(`http://127.0.0.1:${port}`)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The audiobook maker window: outside links open in the browser, and it may ask for a save folder.
  win.webContents.on('did-create-window', (child) => {
    child.removeMenu();
    child.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); }
  });
  // Allow the backup download link to save normally.
  win.webContents.session.on('will-download', () => {});
}
