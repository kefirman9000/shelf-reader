'use strict';
// Phone ↔ PC sync through one JSON file in a cloud-synced folder (Google Drive, OneDrive…).
// Each book's reading state carries an "updated" time; the newer side wins.
// Same format as the Android app (SyncFile.kt).

const fs = require('fs');
const path = require('path');

const FILE = 'ShelfReader-sync.json';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (b) => norm(b.title) + '|' + norm(b.author);

function readFile(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, FILE), 'utf8')); } catch (_) { return null; }
}

function mergeStats(a = {}, b = {}) {
  const days = { ...(a.days || {}) };
  for (const [k, v] of Object.entries(b.days || {})) {
    const cur = days[k] || {};
    days[k] = { read: Math.max(cur.read || 0, v.read || 0), listen: Math.max(cur.listen || 0, v.listen || 0) };
  }
  const seen = new Set(); const finished = [];
  for (const f of [...(a.finished || []), ...(b.finished || [])]) {
    const k = norm(f.title) + '|' + String(f.date || '').slice(0, 10);
    if (!seen.has(k)) { seen.add(k); finished.push(f); }
  }
  return { days, finished, goal: a.goal || b.goal || 30, goalUpdated: Math.max(a.goalUpdated || 0, b.goalUpdated || 0) };
}

/** Returns { pulled, pushed } — numbers of books updated from / written to the file. */
function syncNow(store, folder) {
  if (!folder) throw new Error('Sync isn’t set up');
  if (!fs.existsSync(folder)) throw new Error('The sync folder can’t be found (is Google Drive / OneDrive running?)');
  const remote = readFile(folder) || { books: [] };
  const remoteBooks = remote.books || [];
  const byId = new Map(remoteBooks.map((r) => [r.id, r]));
  const byKey = new Map(remoteBooks.map((r) => [keyOf(r), r]));
  let pulled = 0;
  const used = new Set();
  const out = [];
  for (const b of store.list()) {
    const L = store.state(b.id);
    const R = byId.get(b.id) || byKey.get(keyOf(b));
    if (R) used.add(R);
    if (R && (R.updated || 0) > (L.updated || 0)) {
      store.setState(b.id, {
        pos: R.pos || 0, off: R.off || 0, notes: R.notes || [], collections: R.collections || [], updated: R.updated
      });
      pulled++;
    }
    const S = store.state(b.id);
    out.push({
      id: b.id, title: b.title, author: b.author, pos: S.pos || 0, off: S.off || 0, len: S.len || 0,
      updated: S.updated || 0, notes: S.notes || [], collections: S.collections || []
    });
  }
  // keep books that only the other device has
  for (const r of remoteBooks) if (!used.has(r)) out.push(r);

  const settings = store.settings();
  const names = [...new Set([...(settings.collections || []), ...(remote.collectionNames || [])])];
  const fixes = [...(settings.fixes || [])];
  for (const f of remote.fixes || []) if (!fixes.some((x) => x.from.toLowerCase() === String(f.from).toLowerCase())) fixes.push(f);
  store.setSettings({ collections: names, fixes });
  const stats = mergeStats(store.stats(), remote.stats || {});
  if ((remote.stats || {}).goalUpdated > (store.stats().goalUpdated || 0)) stats.goal = remote.stats.goal;
  store.setStats(stats);

  const doc = { app: 'ShelfReader', version: 1, updated: Date.now(), books: out, collectionNames: names, fixes, stats };
  const target = path.join(folder, FILE);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, target);
  return { pulled, pushed: out.length };
}

module.exports = { syncNow, FILE };
