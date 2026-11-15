'use strict';
// Electron entry point: starts the local library server and shows it in a window.

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { startServer } = require('./server');

let win = null;
let port = null;

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
      openExternal: (url) => shell.openExternal(url),
      openEdge: (url) => shell.openExternal('microsoft-edge:' + url).catch(() => shell.openExternal(url))
    });
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
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
  win.removeMenu();
  win.loadURL(`http://127.0.0.1:${port}/`);
  // Links that leave the app open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(`http://127.0.0.1:${port}`)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); }
  });
  // Allow the backup download link to save normally.
  win.webContents.session.on('will-download', () => {});
}
