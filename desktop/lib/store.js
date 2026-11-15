'use strict';
// On-disk library: books, per-book state (place, notes, collections, speed), settings.
// Uses the same file names as the Android app so phone backups can be restored here.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { documentFrom, epubCover, epubEntry } = require('./extract');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.books = path.join(dir, 'books');
    this.stateDir = path.join(dir, 'state');
    fs.mkdirSync(this.books, { recursive: true });
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.docCache = new Map();
  }

  // ---------- library ----------
  libFile() { return path.join(this.dir, 'library.json'); }
  list() {
    try { return JSON.parse(fs.readFileSync(this.libFile(), 'utf8')); } catch (_) { return []; }
  }
  saveList(list) {
    const tmp = this.libFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, this.libFile());
  }
  get(id) { return this.list().find((b) => b.id === id) || null; }
  add(b) { const l = this.list(); l.push(b); this.saveList(l); }
  update(b) { this.saveList(this.list().map((x) => (x.id === b.id ? b : x))); }
  remove(id) {
    const b = this.get(id);
    this.saveList(this.list().filter((x) => x.id !== id));
    this.docCache.delete(id);
    if (!b) return;
    for (const f of [b.file, `${id}.paras`, `${id}.v2.paras`, `${id}.v2.chap`, `${id}.v2.imgs`, `${id}.notes.json`, `${id}.cover.jpg`]) {
      try { fs.unlinkSync(path.join(this.books, f)); } catch (_) {}
    }
    try { fs.unlinkSync(this.statePath(id)); } catch (_) {}
  }
  newId() { return 'b' + Date.now(); }
  filePath(name) { return path.join(this.books, name); }

  // ---------- text ----------
  async doc(b) {
    if (this.docCache.has(b.id)) return this.docCache.get(b.id);
    const pf = this.filePath(`${b.id}.v2.paras`);
    const cf = this.filePath(`${b.id}.v2.chap`);
    let d = null;
    if (fs.existsSync(pf) && fs.existsSync(cf)) {
      const paras = fs.readFileSync(pf, 'utf8').split('\n').filter(Boolean);
      if (paras.length) {
        const chapters = fs.readFileSync(cf, 'utf8').split('\n').filter(Boolean).map((l) => {
          const t = l.indexOf('\t');
          return t > 0 ? { para: parseInt(l.slice(0, t), 10), title: l.slice(t + 1) } : null;
        }).filter((c) => c && !isNaN(c.para));
        d = { paras, chapters };
      }
    }
    const imf = this.filePath(`${b.id}.v2.imgs`);
    if (!d) {
      d = await documentFrom(fs.readFileSync(this.filePath(b.file)), b.format);
      fs.writeFileSync(pf, d.paras.join('\n'));
      fs.writeFileSync(cf, d.chapters.map((c) => `${c.para}\t${c.title.replace(/[\t\n]/g, ' ')}`).join('\n'));
      fs.writeFileSync(imf, (d.images || []).map((x) => `${x.para}\t${x.src}`).join('\n'));
    } else if (fs.existsSync(imf)) {
      d.images = fs.readFileSync(imf, 'utf8').split('\n').filter(Boolean).map((l) => {
        const t = l.indexOf('\t'); return { para: parseInt(l.slice(0, t), 10), src: l.slice(t + 1) };
      });
    } else {
      // books added before pictures were supported: find their pictures once, if the text lines up
      d.images = [];
      if (b.format === 'epub') {
        try {
          const fresh = await documentFrom(fs.readFileSync(this.filePath(b.file)), b.format);
          if (fresh.paras.length === d.paras.length) d.images = fresh.images;
        } catch (_) {}
      }
      fs.writeFileSync(imf, d.images.map((x) => `${x.para}\t${x.src}`).join('\n'));
    }
    this.docCache.set(b.id, d);
    if (this.docCache.size > 6) this.docCache.delete(this.docCache.keys().next().value);
    const st = this.state(b.id);
    if (st.len !== d.paras.length) this.setState(b.id, { len: d.paras.length });
    return d;
  }

  /** A picture from inside a book's EPUB */
  picture(b, src) {
    if (b.format !== 'epub') return null;
    return epubEntry(fs.readFileSync(this.filePath(b.file)), src);
  }

  // ---------- covers ----------
  coverPath(id) { return this.filePath(`${id}.cover.jpg`); }
  cover(b) {
    const p = this.coverPath(b.id);
    if (fs.existsSync(p)) return { data: fs.readFileSync(p), type: 'image/jpeg' };
    const none = this.filePath(`${b.id}.nocover`);
    if (fs.existsSync(none)) return null;
    if (b.format === 'epub') {
      const c = epubCover(fs.readFileSync(this.filePath(b.file)));
      if (c) { fs.writeFileSync(p, c.data); return { data: c.data, type: c.type }; }
    }
    fs.writeFileSync(none, '');
    return null;
  }
  setCover(id, data) {
    fs.writeFileSync(this.coverPath(id), data);
    try { fs.unlinkSync(this.filePath(`${id}.nocover`)); } catch (_) {}
  }
  resetCover(id) {
    for (const f of [`${id}.cover.jpg`, `${id}.nocover`]) { try { fs.unlinkSync(this.filePath(f)); } catch (_) {} }
  }

  // ---------- per-book state ----------
  statePath(id) { return path.join(this.stateDir, `${id}.json`); }
  state(id) {
    try { return JSON.parse(fs.readFileSync(this.statePath(id), 'utf8')); } catch (_) { return { pos: 0, off: 0, notes: [], collections: [] }; }
  }
  setState(id, patch) {
    // reading-state changes get a timestamp so phone ↔ PC sync knows which is newer
    if (!('updated' in patch) && ['pos', 'off', 'notes', 'collections'].some((k) => k in patch)) patch = { ...patch, updated: Date.now() };
    const s = Object.assign(this.state(id), patch);
    fs.writeFileSync(this.statePath(id), JSON.stringify(s));
    if (this.onChange && ('updated' in patch)) this.onChange();
    return s;
  }

  // ---------- reading stats ----------
  statsPath() { return path.join(this.dir, 'stats.json'); }
  stats() { try { return JSON.parse(fs.readFileSync(this.statsPath(), 'utf8')); } catch (_) { return { days: {}, finished: [], goal: 30 }; } }
  setStats(s) { fs.writeFileSync(this.statsPath(), JSON.stringify(s)); return s; }
  percent(id) {
    const s = this.state(id);
    return s.len ? Math.min(100, Math.floor(((s.pos || 0) + 1) * 100 / s.len)) : 0;
  }

  // ---------- settings ----------
  settingsPath() { return path.join(this.dir, 'settings.json'); }
  settings() {
    const d = {
      theme: 0, font: 0, margin: 1, textSize: 19, rate: 1, voice: null, skipClutter: true, fixes: [],
      view: 0, sort: 0, filter: '', collections: [], lastBook: null
    };
    try { return Object.assign(d, JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8'))); } catch (_) { return d; }
  }
  setSettings(patch) {
    const s = Object.assign(this.settings(), patch);
    fs.writeFileSync(this.settingsPath(), JSON.stringify(s));
    return s;
  }

  // ---------- backups ----------
  /** Desktop backup (same layout as the phone's, plus desktop state). */
  backup() {
    const z = new AdmZip();
    if (fs.existsSync(this.libFile())) z.addLocalFile(this.libFile());
    for (const f of fs.readdirSync(this.books)) z.addLocalFile(path.join(this.books, f), 'books');
    for (const f of fs.readdirSync(this.stateDir)) z.addLocalFile(path.join(this.stateDir, f), 'state');
    if (fs.existsSync(this.settingsPath())) {
      // keys and tokens stay on this PC
      const { cloud: _c, updateToken: _t, ...safe } = this.settings();
      z.addFile('desktop/' + path.basename(this.settingsPath()), Buffer.from(JSON.stringify(safe)));
    }
    if (fs.existsSync(this.statsPath())) z.addLocalFile(this.statsPath(), 'desktop');
    return z.toBuffer();
  }

  /** Restores a backup from the Android app or from this desktop app. Returns books added. */
  restore(buf) {
    const z = new AdmZip(buf);
    const entries = z.getEntries();
    const libEntry = entries.find((e) => e.entryName === 'library.json');
    if (!libEntry) throw new Error("that file isn't a Shelf Reader backup");
    const incoming = JSON.parse(libEntry.getData().toString('utf8'));
    for (const e of entries) {
      const n = e.entryName;
      const m = /^(books|state)\/([^/]+)$/.exec(n);
      if (!m || m[2].includes('..') || e.isDirectory) continue;
      const target = path.join(m[1] === 'books' ? this.books : this.stateDir, m[2]);
      if (m[1] === 'state' && fs.existsSync(target)) continue;
      fs.writeFileSync(target, e.getData());
    }
    // Android prefs → desktop state
    const pref = (name) => {
      const e = entries.find((x) => x.entryName === `prefs/${name}.json`);
      if (!e) return {};
      try { return JSON.parse(e.getData().toString('utf8')); } catch (_) { return {}; }
    };
    const pos = pref('positions'); const cols = pref('collections'); const set = pref('settings');
    const val = (o, k) => (o[k] ? o[k].v : undefined);
    const list = this.list();
    const have = new Set(list.map((b) => b.id));
    let added = 0;
    for (const b of incoming) {
      if (have.has(b.id) || !fs.existsSync(this.filePath(b.file))) continue;
      list.push(b); added++;
      if (!fs.existsSync(this.statePath(b.id))) {
        let notes = [];
        try {
          notes = JSON.parse(fs.readFileSync(this.filePath(`${b.id}.notes.json`), 'utf8'))
            .map((n) => ({ para: n.p, text: n.t || '', time: n.time || 0 }));
        } catch (_) {}
        let collections = [];
        try { collections = JSON.parse(val(cols, b.id) || '[]'); } catch (_) {}
        this.setState(b.id, {
          pos: val(pos, `pos_${b.id}`) || 0, off: val(pos, `off_${b.id}`) || 0, len: val(pos, `len_${b.id}`) || 0,
          opened: val(pos, `opened_${b.id}`) || 0, notes, collections,
          rate: val(set, `rate_${b.id}`) || undefined
        });
      }
    }
    this.saveList(list);
    // collection names from the phone
    try {
      const names = JSON.parse(val(cols, '_names') || '[]');
      const s = this.settings();
      this.setSettings({ collections: [...new Set([...(s.collections || []), ...names])] });
    } catch (_) {}
    const fixes = val(set, 'fixes');
    if (fixes) {
      try {
        const f = JSON.parse(fixes).map((x) => ({ from: x.f, to: x.t }));
        const s = this.settings();
        const known = new Set(s.fixes.map((x) => x.from.toLowerCase()));
        this.setSettings({ fixes: [...s.fixes, ...f.filter((x) => !known.has(x.from.toLowerCase()))] });
      } catch (_) {}
    }
    return added;
  }
}

module.exports = { Store };
