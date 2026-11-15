'use strict';
// Local server shared by the app window and Edge. Listens on 127.0.0.1 only.
// Run standalone for development: `node server.js` then open http://127.0.0.1:47321

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const { SOURCES, resolveArchive, getBuffer, getJson, define } = require('./lib/sources');
const { epubInfo } = require('./lib/extract');
const exporter = require('./lib/export');

const UI_DIR = path.join(__dirname, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const REPO = 'kefirman9000/shelf-reader';

function startServer(opts = {}) {
  const store = new Store(opts.dataDir || path.join(__dirname, 'testdata'));
  const version = opts.version || '1.0.0';
  let port = opts.port || 47321;

  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
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

  async function api(req, res, url) {
    const p = url.pathname;
    const m = (re) => re.exec(p);
    let mm;

    if (p === '/api/info') {
      return send(res, 200, {
        version, edge: !!opts.openEdge, chrome: !!(opts.findChrome && opts.findChrome()),
        desktop: !!opts.openExternal, export: exporter.supported() && !!opts.pickFolder
      });
    }

    // ---------- audio export (Windows voices → MP3) ----------
    if (p === '/api/export/voices') {
      try { return send(res, 200, await exporter.windowsVoices()); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (p === '/api/export' && req.method === 'GET') {
      const { child, ...view } = job;
      return send(res, 200, view);
    }
    if (p === '/api/export/cancel' && req.method === 'POST') {
      job.cancelled = true;
      try { if (job.child) job.child.kill(); } catch (_) {}
      return send(res, 200, { ok: true });
    }
    if (p === '/api/export/open' && req.method === 'POST') {
      if (job.folder && opts.openPath) opts.openPath(job.folder);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/export' && req.method === 'POST') {
      if (!exporter.supported() || !opts.pickFolder) return send(res, 400, { error: 'Audio export works in the Windows app.' });
      if (job.running) return send(res, 409, { error: 'An export is already running.' });
      const r = await json(req);
      const b = store.get(r.bookId);
      if (!b) return send(res, 404, { error: 'not found' });
      const folder = await opts.pickFolder();
      if (!folder) return send(res, 200, { cancelled: true });
      const doc = await store.doc(b);
      Object.keys(job).forEach((k) => delete job[k]);
      Object.assign(job, { running: true, title: b.title, done: 0, total: 0, current: '', error: null, finished: false });
      exporter.runExport(job, { book: b, doc, settings: store.settings(), from: r.from || 0, to: r.to ?? 9999, voice: r.voice || null, rate: r.rate || 1, folder })
        .then(() => { job.finished = true; })
        .catch((e) => { job.error = job.cancelled ? 'Export cancelled.' : e.message; })
        .finally(() => { job.running = false; job.child = null; });
      return send(res, 200, { started: true });
    }
    if (p === '/api/library') return send(res, 200, store.list().map(bookView));
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, store.settings());
    if (p === '/api/settings' && req.method === 'PUT') return send(res, 200, store.setSettings(await json(req)));

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
        store.setState(b.id, { opened: Date.now() });
        store.setSettings({ lastBook: b.id });
        return send(res, 200, { book: bookView(b), ...d, state: store.state(b.id) });
      } catch (e) { return send(res, 500, { error: e.message }); }
    }

    if ((mm = m(/^\/api\/state\/([\w-]+)$/)) && req.method === 'PUT') {
      if (!store.get(mm[1])) return send(res, 404, { error: 'not found' });
      return send(res, 200, store.setState(mm[1], await json(req)));
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

    if (p === '/api/backup') {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="ShelfReader-desktop-backup-${new Date().toISOString().slice(0, 10)}.zip"` });
      return res.end(store.backup());
    }
    if (p === '/api/restore' && req.method === 'POST') {
      try { return send(res, 200, { added: store.restore(await readBody(req)) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
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
