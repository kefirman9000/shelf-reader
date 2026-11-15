'use strict';
// Local server shared by the app window and Edge. Listens on 127.0.0.1 only.
// Run standalone for development: `node server.js` then open http://127.0.0.1:47321

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const { SOURCES, resolveArchive, getBuffer, getJson, define } = require('./lib/sources');
const { epubInfo } = require('./lib/extract');
const cloud = require('./lib/cloud');
const sync = require('./lib/sync');

const UI_DIR = path.join(__dirname, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const REPO = 'kefirman9000/shelf-reader';

function startServer(opts = {}) {
  const store = new Store(opts.dataDir || path.join(__dirname, 'testdata'));
  const updates = opts.updates || null;
  if (updates) { updates.setToken(store.settings().updateToken || ''); updates.setAuto(store.settings().autoUpdate !== false); }
  const version = opts.version || '1.0.0';
  let port = opts.port || 47321;

  // Cross-origin isolation lets the natural-voice engine use several CPU threads.
  const ISOLATE = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...ISOLATE });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req, limit = 600 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const json = async (req) => { const b = await readBody(req, 5 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

  const bookView = (b) => {
    const st = store.state(b.id);
    return { ...b, percent: store.percent(b.id), opened: st.opened || 0, collections: st.collections || [] };
  };

  function checkFile(buf, format) {
    if (format === 'epub' && !(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error('the site sent a web page instead of the book file');
    if (format === 'pdf' && buf.slice(0, 4).toString('latin1') !== '%PDF') throw new Error('the site sent a web page instead of the book file');
  }

  async function addBook(buf, format, title, author, extra = {}) {
    checkFile(buf, format);
    const id = store.newId();
    const file = `${id}.${format}`;
    fs.writeFileSync(store.filePath(file), buf);
    if (format === 'epub' && (!title || !author)) {
      const info = epubInfo(buf);
      title = title || info.title || 'Untitled';
      author = author || info.author || '';
    }
    const b = { id, title: title || 'Untitled', author: author || '', file, format, added: Date.now() };
    try {
      await store.doc(b);
    } catch (e) {
      try { fs.unlinkSync(store.filePath(file)); } catch (_) {}
      throw e;
    }
    if (extra.cover) {
      try {
        const img = await getBuffer(extra.cover, 30000);
        if (img.length > 500 && (img[0] === 0xff || img[0] === 0x89)) store.setCover(id, img);
      } catch (_) {}
    }
    store.add(b);
    if (extra.later) store.setState(id, { collections: ['Want to read'] });
    return b;
  }

  const job = { running: false };

  // ---------- phone ↔ PC sync: on start, every few minutes, and shortly after changes ----------
  const syncState = { last: 0, error: null, timer: null };
  const runSync = () => {
    const folder = store.settings().syncFolder;
    if (!folder) return null;
    try { const r = sync.syncNow(store, folder); syncState.last = Date.now(); syncState.error = null; return r; }
    catch (e) { syncState.error = e.message; throw e; }
  };
  store.onChange = () => {
    if (!store.settings().syncFolder) return;
    clearTimeout(syncState.timer);
    syncState.timer = setTimeout(() => { try { runSync(); } catch (_) {} }, 15000);
  };
  setTimeout(() => { try { runSync(); } catch (_) {} }, 1500);
  setInterval(() => { try { runSync(); } catch (_) {} }, 3 * 60 * 1000);

  async function api(req, res, url) {
    const p = url.pathname;
    const m = (re) => re.exec(p);
    let mm;

    if (p === '/api/info') {
      return send(res, 200, {
        version, edge: !!opts.openEdge, chrome: !!(opts.findChrome && opts.findChrome()),
        desktop: !!opts.openExternal, export: !!opts.pickFolder
      });
    }

    // ---------- audio export (natural / premium voices; MP3s are made on screen) ----------
    if (p === '/api/export/begin' && req.method === 'POST') {
      if (!opts.pickFolder) return send(res, 400, { error: 'Audio export works in the Windows app.' });
      if (job.running) return send(res, 409, { error: 'An export is already running.' });
      const r = await json(req);
      const folder = await opts.pickFolder();
      if (!folder) return send(res, 200, { cancelled: true });
      const safe = (x) => String(x || 'Untitled').replace(/[\\/:*?"<>|\n\t]/g, '_').trim().slice(0, 80) || 'Untitled';
      job.folder = path.join(folder, safe(r.title));
      fs.mkdirSync(job.folder, { recursive: true });
      return send(res, 200, { folder: job.folder });
    }
    if (p === '/api/export/file' && req.method === 'POST') {
      if (!job.folder) return send(res, 400, { error: 'no export folder' });
      const name = path.basename(decodeURIComponent(req.headers['x-filename'] || 'audio.mp3')).replace(/[\\/:*?"<>|]/g, '_');
      if (!/\.mp3$/i.test(name)) return send(res, 400, { error: 'bad name' });
      fs.writeFileSync(path.join(job.folder, name), await readBody(req, 500 * 1024 * 1024));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/export/open' && req.method === 'POST') {
      if (job.folder && opts.openPath) opts.openPath(job.folder);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/library') return send(res, 200, store.list().map(bookView));
    const pub = (st) => { const { cloud: _c, updateToken: _t, ...rest } = st; return { ...rest, cloud: cloud.publicView(st), hasUpdateToken: !!_t }; };
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, pub(store.settings()));
    if (p === '/api/settings' && req.method === 'PUT') {
      const patch = await json(req);
      delete patch.cloud; delete patch.updateToken;
      if (updates && 'autoUpdate' in patch) updates.setAuto(patch.autoUpdate !== false);
      return send(res, 200, pub(store.setSettings(patch)));
    }

    // ---------- premium cloud voices (user's own API keys) ----------
    if (p === '/api/cloud/config' && req.method === 'PUT') {
      const r = await json(req); // { provider, key?, region?, model?, clear? }
      if (!cloud.PROVIDERS[r.provider]) return send(res, 400, { error: 'unknown provider' });
      const all = store.settings().cloud || {};
      const cur = r.clear ? {} : { ...(all[r.provider] || {}) };
      for (const k of ['key', 'region', 'model']) if (!r.clear && typeof r[k] === 'string' && r[k].trim()) cur[k] = r[k].trim();
      store.setSettings({ cloud: { ...all, [r.provider]: cur } });
      return send(res, 200, cloud.publicView(store.settings()));
    }
    if (p === '/api/cloud/voices') {
      try { return send(res, 200, await cloud.voices(store.settings(), url.searchParams.get('provider'))); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/cloud/speak' && req.method === 'POST') {
      const r = await json(req);
      try {
        const out = await cloud.speak(store.settings(), r.provider, r.voice, String(r.text || '').slice(0, 5000), +r.speed || 1);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Speed-Applied': out.applied ? '1' : '0', 'Cache-Control': 'no-store', ...ISOLATE });
        return res.end(out.audio);
      } catch (e) { return send(res, 502, { error: e.message }); }
    }

    if (p === '/api/search') {
      const fn = SOURCES[url.searchParams.get('source')];
      if (!fn) return send(res, 400, { error: 'unknown source' });
      try { return send(res, 200, await fn(url.searchParams.get('q') || '')); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }

    if (p === '/api/download' && req.method === 'POST') {
      const r = await json(req);
      try {
        let src = r.url; let format = r.format;
        if (!src) ({ url: src, format } = await resolveArchive(r.iaId));
        const buf = await getBuffer(src);
        const b = await addBook(buf, format, r.title, r.author, { cover: r.cover, later: r.later });
        return send(res, 200, bookView(b));
      } catch (e) { return send(res, 502, { error: e.message }); }
    }

    if (p === '/api/import' && req.method === 'POST') {
      const name = decodeURIComponent(req.headers['x-filename'] || 'book');
      const ext = (path.extname(name).slice(1) || '').toLowerCase();
      const format = ext === 'epub' ? 'epub' : ext === 'pdf' ? 'pdf' : ext === 'txt' ? 'txt' : null;
      if (!format) return send(res, 400, { error: 'Only EPUB, PDF and TXT files are supported.' });
      try {
        const b = await addBook(await readBody(req), format, format === 'epub' ? null : path.basename(name, path.extname(name)), null);
        return send(res, 200, bookView(b));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if ((mm = m(/^\/api\/book\/([\w-]+)$/))) {
      const b = store.get(mm[1]);
      if (!b) return send(res, 404, { error: 'not found' });
      if (req.method === 'DELETE') { store.remove(b.id); return send(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        const r = await json(req);
        const nb = { ...b, title: (r.title || b.title).trim(), author: (r.author ?? b.author).trim() };
        store.update(nb);
        return send(res, 200, bookView(nb));
      }
      try {
        const d = await store.doc(b);
        const before = store.state(b.id);
        store.setState(b.id, { opened: Date.now() });
        store.setSettings({ lastBook: b.id });
        return send(res, 200, { book: bookView(b), ...d, state: { ...store.state(b.id) }, prevOpened: before.opened || 0 });
      } catch (e) { return send(res, 500, { error: e.message }); }
    }

    if ((mm = m(/^\/api\/state\/([\w-]+)$/)) && req.method === 'GET') {
      if (!store.get(mm[1])) return send(res, 404, { error: 'not found' });
      return send(res, 200, store.state(mm[1]));
    }
    if ((mm = m(/^\/api\/state\/([\w-]+)$/)) && req.method === 'PUT') {
      if (!store.get(mm[1])) return send(res, 404, { error: 'not found' });
      return send(res, 200, store.setState(mm[1], await json(req)));
    }

    if ((mm = m(/^\/api\/picture\/([\w-]+)$/))) {
      const b = store.get(mm[1]);
      const data = b && store.picture(b, url.searchParams.get('src') || '');
      if (!data) return send(res, 404, 'no picture', 'text/plain');
      const ext = (url.searchParams.get('src') || '').split('.').pop().toLowerCase();
      const type = { png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400', ...ISOLATE });
      return res.end(data);
    }

    // ---------- search inside every book ----------
    if (p === '/api/search-books') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (q.length < 2) return send(res, 200, []);
      const out = [];
      for (const b of store.list()) {
        let d; try { d = await store.doc(b); } catch (_) { continue; }
        let n = 0;
        for (let i = 0; i < d.paras.length && n < 6; i++) {
          const t = d.paras[i]; const k = t.toLowerCase().indexOf(q);
          if (k < 0) continue;
          const a = Math.max(0, k - 70), e = Math.min(t.length, k + q.length + 90);
          let ch = null; for (const c of d.chapters) { if (c.para <= i) ch = c.title; else break; }
          out.push({ id: b.id, title: b.title, author: b.author, para: i, chapter: ch, pct: Math.round((i + 1) * 100 / d.paras.length),
            snippet: (a > 0 ? '…' : '') + t.slice(a, e) + (e < t.length ? '…' : ''), at: k - a + (a > 0 ? 1 : 0), len: q.length });
          n++;
        }
        if (out.length >= 200) break;
      }
      return send(res, 200, out);
    }

    // ---------- audio clips saved with bookmarks ----------
    if ((mm = m(/^\/api\/clip\/([\w-]+)\/([\w.-]+)$/))) {
      const dir = path.join(store.dir, 'clips', mm[1]);
      const f = path.join(dir, path.basename(mm[2]));
      if (req.method === 'PUT') { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, await readBody(req, 30 * 1024 * 1024)); return send(res, 200, { ok: true, file: path.basename(f) }); }
      if (req.method === 'DELETE') { try { fs.unlinkSync(f); } catch (_) {} return send(res, 200, { ok: true }); }
      if (!fs.existsSync(f)) return send(res, 404, 'no clip', 'text/plain');
      return send(res, 200, fs.readFileSync(f), f.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
    }

    if ((mm = m(/^\/api\/cover\/([\w-]+)$/))) {
      const b = store.get(mm[1]);
      if (!b) return send(res, 404, 'no');
      if (req.method === 'PUT') { store.setCover(b.id, await readBody(req, 20 * 1024 * 1024)); return send(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { store.resetCover(b.id); return send(res, 200, { ok: true }); }
      const c = store.cover(b);
      if (!c) return send(res, 404, 'no cover', 'text/plain');
      return send(res, 200, c.data, c.type);
    }

    if (p === '/api/img') {
      try {
        const buf = await getBuffer(url.searchParams.get('url'), 20000);
        return send(res, 200, buf, buf[0] === 0x89 ? 'image/png' : 'image/jpeg');
      } catch (e) { return send(res, 404, 'no'); }
    }

    if (p === '/api/define') {
      try { return send(res, 200, await define(url.searchParams.get('w') || '')); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }

    // ---------- reading stats ----------
    if (p === '/api/stats' && req.method === 'GET') return send(res, 200, store.stats());
    if (p === '/api/stats/add' && req.method === 'POST') {
      const r = await json(req); const st = store.stats();
      const day = /^\d{4}-\d{2}-\d{2}$/.test(r.day || '') ? r.day : new Date().toISOString().slice(0, 10);
      const cur = (st.days || (st.days = {}))[day] || {};
      st.days[day] = { read: (cur.read || 0) + Math.min(60, +r.read || 0), listen: (cur.listen || 0) + Math.min(60, +r.listen || 0) };
      return send(res, 200, store.setStats(st));
    }
    if (p === '/api/stats/finished' && req.method === 'POST') {
      const r = await json(req); const st = store.stats();
      st.finished = st.finished || [];
      const date = new Date().toISOString();
      if (!st.finished.some((f) => f.id === r.id && String(f.date).slice(0, 10) === date.slice(0, 10))) st.finished.push({ id: r.id, title: r.title, author: r.author || '', date });
      store.setStats(st); store.onChange && store.onChange();
      return send(res, 200, st);
    }
    if (p === '/api/stats/goal' && req.method === 'PUT') {
      const r = await json(req); const st = store.stats();
      st.goal = Math.max(5, Math.min(600, +r.goal || 30)); st.goalUpdated = Date.now();
      store.setStats(st); store.onChange && store.onChange();
      return send(res, 200, st);
    }

    // ---------- sync ----------
    if (p === '/api/sync' && req.method === 'GET') return send(res, 200, { folder: store.settings().syncFolder || null, last: syncState.last, error: syncState.error });
    if (p === '/api/sync/setup' && req.method === 'POST') {
      if (!opts.pickFolder) return send(res, 400, { error: 'Sync setup works in the Windows app.' });
      const folder = await opts.pickFolder('Choose a folder inside Google Drive or OneDrive for syncing');
      if (!folder) return send(res, 200, { cancelled: true });
      store.setSettings({ syncFolder: folder });
      try { const r = runSync(); return send(res, 200, { folder, ...r }); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (p === '/api/sync/now' && req.method === 'POST') {
      try { return send(res, 200, runSync() || { error: 'Sync isn’t set up' }); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (p === '/api/sync/off' && req.method === 'POST') { store.setSettings({ syncFolder: null }); return send(res, 200, { ok: true }); }

    if (p === '/api/backup') {
      res.writeHead(200, { ...ISOLATE, 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="ShelfReader-desktop-backup-${new Date().toISOString().slice(0, 10)}.zip"` });
      return res.end(store.backup());
    }
    if (p === '/api/restore' && req.method === 'POST') {
      try { return send(res, 200, { added: store.restore(await readBody(req)) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // ---------- automatic updates (installed app) ----------
    if (updates && p === '/api/update' && req.method === 'GET') return send(res, 200, { auto: true, ...updates.status() });
    if (updates && p === '/api/update/check' && req.method === 'POST') return send(res, 200, { auto: true, ...(await updates.check()) });
    if (updates && p === '/api/update/download' && req.method === 'POST') return send(res, 200, { auto: true, ...(await updates.download()) });
    if (updates && p === '/api/update/install' && req.method === 'POST') return send(res, 200, { ok: updates.install() });
    if (updates && p === '/api/update/token' && req.method === 'POST') {
      const { token } = await json(req);
      const t = String(token || '').trim();
      if (t && !/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t)) return send(res, 400, { error: 'That doesn\'t look like a GitHub token. It should start with github_pat_ or ghp_.' });
      store.setSettings({ updateToken: t || undefined });
      updates.setToken(t);
      return send(res, 200, { auto: true, ...(await updates.check()) });
    }
    if (p === '/api/update') {
      try {
        const j = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
        const latest = parseInt(String(j.tag_name || '').replace('build-', ''), 10) || 0;
        const current = parseInt(String(version).split('.').pop(), 10) || 0;
        return send(res, 200, { latest, current, url: j.html_url, newer: latest > current });
      } catch (e) { return send(res, 502, { error: 'Couldn’t reach GitHub releases (the repo must be public for update checks).' }); }
    }

    if (p === '/api/open-edge' && req.method === 'POST') {
      if (!opts.openEdge) return send(res, 400, { error: 'Only available in the desktop app.' });
      opts.openEdge(`http://127.0.0.1:${port}/`);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/open-chrome' && req.method === 'POST') {
      if (!opts.openChrome) return send(res, 400, { error: 'Only available in the desktop app.' });
      if (!opts.openChrome(`http://127.0.0.1:${port}/`)) return send(res, 404, { error: 'Google Chrome isn’t installed on this PC.' });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/open-url' && req.method === 'POST') {
      const r = await json(req);
      if (opts.openExternal && /^https:\/\//.test(r.url || '')) opts.openExternal(r.url);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
      const host = (req.headers.host || '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, 'forbidden', 'text/plain');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api/')) {
        // Changes require a custom header, which other websites can't send to us.
        if (req.method !== 'GET' && req.headers['x-shelf'] !== '1') return send(res, 403, { error: 'forbidden' });
        return await api(req, res, url);
      }
      let file = url.pathname === '/' ? '/index.html' : url.pathname;
      file = path.normalize(path.join(UI_DIR, file));
      if (!file.startsWith(UI_DIR) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    } catch (e) {
      try { send(res, 500, { error: e.message }); } catch (_) {}
    }
  });

  return new Promise((resolve, reject) => {
    const tryListen = (attempt) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempt < 20) { port += 1; tryListen(attempt + 1); } else reject(e);
      });
      server.listen(port, '127.0.0.1', () => resolve(port));
    };
    tryListen(0);
  });
}

module.exports = { startServer };

if (require.main === module) {
  startServer({ port: parseInt(process.env.PORT || '47321', 10) }).then((p) => console.log(`Shelf Reader on http://127.0.0.1:${p}`));
}
