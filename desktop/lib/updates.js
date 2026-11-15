'use strict';
// Automatic updates from this project's GitHub releases (electron-updater).
// The installed app checks quietly, downloads in the background, and installs when you restart or quit.
// Public repository: no setup. Private repository: paste a read-only GitHub token in Settings → Updates.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const OWNER = 'kefirman9000';
const REPO = 'shelf-reader';

function createUpdater() {
  const state = {
    status: 'idle',          // idle | checking | downloading | ready | uptodate | error | portable | dev
    current: app.getVersion(),
    latest: null,
    progress: 0,
    error: '',
    checkedAt: 0,
    installed: false,
    hasToken: false,
    auto: true
  };
  let updater = null;
  let token = '';
  let timer = null;

  // Installed with ShelfReader-Setup.exe? (the zip version has no uninstaller and can't update itself)
  const exeDir = path.dirname(app.getPath('exe'));
  state.installed = app.isPackaged && fs.readdirSync(exeDir).some((f) => /^Uninstall .*\.exe$/i.test(f));
  if (!app.isPackaged) state.status = 'dev';
  else if (!state.installed) state.status = 'portable';

  function get() {
    if (updater) return updater;
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    updater.autoDownload = state.auto;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    // The app isn't code-signed, so there's no publisher to check (this also avoids running PowerShell).
    updater.verifyUpdateCodeSignature = async () => null;
    updater.logger = null;
    updater.on('checking-for-update', () => { state.status = 'checking'; state.error = ''; });
    updater.on('update-available', (i) => { state.latest = i.version; state.status = state.auto ? 'downloading' : 'available'; state.progress = 0; });
    updater.on('update-not-available', (i) => { state.latest = i.version; state.status = 'uptodate'; state.checkedAt = Date.now(); });
    updater.on('download-progress', (p) => { state.status = 'downloading'; state.progress = Math.round(p.percent || 0); });
    updater.on('update-downloaded', (i) => { state.latest = i.version; state.status = 'ready'; state.progress = 100; state.checkedAt = Date.now(); });
    updater.on('error', (e) => { state.status = 'error'; state.error = friendly(e); state.checkedAt = Date.now(); });
    configure();
    return updater;
  }

  function configure() {
    if (!updater) return;
    const feed = { provider: 'github', owner: OWNER, repo: REPO };
    if (token) Object.assign(feed, { private: true, token });
    updater.setFeedURL(feed);
  }

  function friendly(e) {
    const m = String((e && e.message) || e || '');
    if (/404|Not Found|Cannot find latest|No published versions/i.test(m)) {
      return token
        ? 'GitHub didn\'t find any updates with this token. Check that it can read the shelf-reader repository (Contents: Read-only).'
        : 'GitHub didn\'t share the updates. The repository is private: make it public, or add a read-only GitHub token below.';
    }
    if (/401|403|Bad credentials/i.test(m)) return 'GitHub rejected the token. Make a new one with read access to the shelf-reader repository.';
    if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::|EAI_AGAIN/i.test(m)) return 'Couldn\'t reach GitHub. Check your internet connection.';
    if (/latest\.yml/i.test(m)) return 'The newest release doesn\'t have update information yet. It will on the next build.';
    return m.split('\n')[0].slice(0, 200);
  }

  async function check() {
    if (state.status === 'dev') return state;
    if (!state.installed) { state.status = 'portable'; return state; }
    if (state.status === 'downloading' || state.status === 'ready') return state;
    try { await get().checkForUpdates(); } catch (e) { state.status = 'error'; state.error = friendly(e); }
    return state;
  }

  return {
    status: () => ({ ...state, hasToken: !!token }),
    setToken(t) { token = String(t || '').trim(); state.hasToken = !!token; configure(); },
    setAuto(on) { state.auto = on !== false; if (updater) updater.autoDownload = state.auto; },
    check,
    async download() { if (state.status === 'available') { state.status = 'downloading'; try { await get().downloadUpdate(); } catch (e) { state.status = 'error'; state.error = friendly(e); } } return state; },
    install() { if (state.status === 'ready') setImmediate(() => get().quitAndInstall(false, true)); return state.status === 'ready'; },
    start() {
      if (!state.installed) return;
      setTimeout(() => check(), 12 * 1000);
      timer = setInterval(() => check(), 4 * 60 * 60 * 1000);
    },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createUpdater, OWNER, REPO };
