'use strict';
/* Shelf Reader desktop UI. Talks to the local server (server.js). */

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, opts = {}) => {
  const o = { method: opts.method || 'GET', headers: { 'X-Shelf': '1' } };
  if (opts.json !== undefined) { o.body = JSON.stringify(opts.json); o.headers['Content-Type'] = 'application/json'; }
  if (opts.body !== undefined) { o.body = opts.body; Object.assign(o.headers, opts.headers || {}); }
  const r = await fetch(path, o);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
  return data;
};
let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const PALETTE = ['#2E5E4E', '#5B3A5E', '#7A3B2E', '#2F4B6E', '#6B5B2E', '#3D3D3D', '#2E6B6B', '#6E2F45'];
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function genCover(b) {
  return `<div class="cover gen" style="background:${PALETTE[hash((b.title || '') + (b.author || '')) % PALETTE.length]}">
    <div class="gt">${esc(b.title || 'Untitled')}</div><div class="ga">${esc(b.author || '')}</div></div>`;
}
let coverBust = Date.now();
function coverHtml(b, extra = '') {
  return `<div class="cover" data-cover="${b.id}"><img loading="lazy" src="/api/cover/${b.id}?v=${coverBust}" alt="" onerror="this.closest('.cover').outerHTML=window.genCoverFor('${b.id}')">${extra}</div>`;
}
window.genCoverFor = (id) => { const b = S.books.find((x) => x.id === id) || { title: '', author: '' }; return genCover(b); };

// ---------- state ----------
const S = {
  settings: {}, books: [], info: {},
  view: 'library',
  // current book (reader + player)
  book: null, paras: [], chapters: [], segs: [], segIdx: 0, bookState: null,
  playing: false, token: 0, utter: null, sleepAt: 0, sleepChapter: false, sleepTimer: null,
  voices: [], results: [], searchGen: 0, lastSave: 0
};

// ---------- settings & theme ----------
const FONTS = ['Georgia, "Iowan Old Style", "Times New Roman", serif', '"Segoe UI", system-ui, sans-serif', 'Consolas, "Cascadia Mono", monospace'];
const WIDTHS = [900, 760, 620];
async function saveSettings(patch) { S.settings = await api('/api/settings', { method: 'PUT', json: patch }); applyAppearance(); }
function applyAppearance() {
  const s = S.settings;
  document.body.className = 'theme-' + (s.theme || 0);
  const t = $('#text');
  t.style.fontFamily = FONTS[s.font || 0];
  t.style.fontSize = (s.textSize || 19) + 'px';
  t.style.maxWidth = WIDTHS[s.margin ?? 1] + 'px';
}

// ---------- views ----------
function show(view) {
  S.view = view;
  for (const v of ['library', 'search', 'reader']) $('#' + v).hidden = v !== view;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'library') renderLibrary();
  if (view === 'search') setTimeout(() => $('#q').focus(), 0);
  closeDrawer();
}
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => show(b.dataset.view)));

// ---------- library ----------
const sortKey = (s) => (s || '').toLowerCase().replace(/^(the|a|an)\s+/, '');
async function loadLibrary() { S.books = await api('/api/library'); }
function bookById(id) { return S.books.find((b) => b.id === id); }

async function renderLibrary() {
  await loadLibrary();
  const s = S.settings;
  const names = ['Want to read', 'Finished', ...(s.collections || []).filter((n) => n !== 'Want to read' && n !== 'Finished')];
  const fs = $('#filterSel');
  fs.innerHTML = `<option value="">All books (${S.books.length})</option>` +
    names.map((n) => `<option value="${esc(n)}">${esc(n)} (${S.books.filter((b) => b.collections.includes(n)).length})</option>`).join('') +
    `<option value="__manage">Manage collections…</option>`;
  let filter = s.filter || '';
  if (filter && !names.includes(filter)) filter = '';
  fs.value = filter;
  $('#viewSel').value = String(s.view || 0);
  $('#sortSel').value = String(s.sort || 0);

  let list = filter ? S.books.filter((b) => b.collections.includes(filter)) : S.books.slice();
  const sort = s.sort || 0;
  if (sort === 1) list.sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)));
  else if (sort === 2) list.sort((a, b) => sortKey((a.author || '~').split(' ').pop()).localeCompare(sortKey((b.author || '~').split(' ').pop())) || sortKey(a.title).localeCompare(sortKey(b.title)));
  else if (sort === 3) list.sort((a, b) => b.percent - a.percent);
  else list.sort((a, b) => Math.max(b.opened, b.added) - Math.max(a.opened, a.added));

  const shelf = $('#shelf');
  shelf.className = ['shelf', 'grid', 'list'][s.view || 0];
  shelf.innerHTML = list.map((b) => {
    const playing = S.book && S.book.id === b.id && S.playing;
    const extra = (b.percent > 0 ? `<div class="prog" style="width:${b.percent}%"></div>` : '') + (playing ? '<div class="badge">▶</div>' : '');
    return `<div class="book" data-id="${b.id}" title="${esc(b.title)}${b.author ? ' — ' + esc(b.author) : ''}">${coverHtml(b, extra)}
      <div class="meta"><div class="t">${esc(b.title)}</div><div class="s">${b.percent ? b.percent + '% · ' : ''}${esc(b.author || 'Unknown author')}</div></div></div>`;
  }).join('');
  const empty = $('#libEmpty');
  empty.hidden = list.length > 0;
  empty.innerHTML = S.books.length
    ? `No books in “${esc(filter)}” yet. Right-click a book → Collections… to add it.`
    : `No books yet.<br><br>Use <b>Find books</b> to search six free libraries, or <b>Import</b> (or drag files onto this window) to add your own EPUB, PDF or TXT files.`;

  const last = s.lastBook && bookById(s.lastBook);
  $('#continue').hidden = !last;
  if (last) {
    $('#contCover').innerHTML = coverHtml(last);
    $('#contTitle').textContent = last.title;
    $('#contSub').textContent = `${last.author || 'Unknown author'} · ${last.percent}%`;
    $('#contOpen').onclick = () => openBook(last.id);
    $('#contPlay').onclick = async () => { await loadBook(last.id); play(); };
  }
}
$('#filterSel').onchange = (e) => {
  if (e.target.value === '__manage') { manageCollections(); return; }
  saveSettings({ filter: e.target.value }).then(renderLibrary);
};
$('#viewSel').onchange = (e) => saveSettings({ view: +e.target.value }).then(renderLibrary);
$('#sortSel').onchange = (e) => saveSettings({ sort: +e.target.value }).then(renderLibrary);
$('#shelf').onclick = (e) => { const el = e.target.closest('.book'); if (el) openBook(el.dataset.id); };
$('#shelf').oncontextmenu = (e) => {
  const el = e.target.closest('.book'); if (!el) return;
  e.preventDefault();
  bookMenu(bookById(el.dataset.id), e.clientX, e.clientY);
};

function bookMenu(b, x, y) {
  showMenu(x, y, [
    ['Open', () => openBook(b.id)],
    ['Listen now', async () => { await loadBook(b.id); play(); }],
    null,
    ['Collections…', () => editCollections(b)],
    ['Edit title & author…', () => editBook(b)],
    ['Change cover…', () => { S.coverFor = b.id; $('#coverInput').click(); }],
    ['Reset cover', async () => { await api('/api/cover/' + b.id, { method: 'DELETE' }); coverBust = Date.now(); renderLibrary(); }],
    null,
    ['Remove from library…', () => confirmRemove(b)]
  ]);
}
$('#coverInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !S.coverFor) return;
  await api('/api/cover/' + S.coverFor, { method: 'PUT', body: f, headers: { 'Content-Type': 'application/octet-stream' } });
  coverBust = Date.now(); renderLibrary();
};
function editBook(b) {
  modal(`<h2>Edit book</h2><div class="setrow"><label>Title</label><input id="eTitle" style="flex:1" value="${esc(b.title)}"></div>
    <div class="setrow"><label>Author</label><input id="eAuthor" style="flex:1" value="${esc(b.author)}"></div>`,
  [['Cancel'], ['Save', async () => {
    await api('/api/book/' + b.id, { method: 'PUT', json: { title: $('#eTitle').value, author: $('#eAuthor').value } });
    renderLibrary();
  }, true]]);
}
function confirmRemove(b) {
  modal(`<h2>Remove “${esc(b.title)}”?</h2><p>The book, its place, bookmarks and notes will be deleted from this computer.</p>`,
    [['Cancel'], ['Remove', async () => {
      if (S.book && S.book.id === b.id) { pause(); S.book = null; $('#player').hidden = true; }
      await api('/api/book/' + b.id, { method: 'DELETE' }); renderLibrary();
    }, true]]);
}

// ---------- collections ----------
function allCollections() { return ['Want to read', 'Finished', ...(S.settings.collections || []).filter((n) => n !== 'Want to read' && n !== 'Finished')]; }
function editCollections(b) {
  const names = allCollections();
  modal(`<h2>Collections</h2><div class="muted">${esc(b.title)}</div><div id="colList" style="margin-top:10px">${names.map((n, i) =>
    `<label class="check"><input type="checkbox" data-n="${esc(n)}" ${b.collections.includes(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>
    <div class="setrow"><input id="newCol" placeholder="New collection" style="flex:1"><button id="addCol">Add</button></div>`,
  [['Cancel'], ['Save', async () => {
    const chosen = [...document.querySelectorAll('#colList input:checked')].map((i) => i.dataset.n);
    await api('/api/state/' + b.id, { method: 'PUT', json: { collections: chosen } });
    renderLibrary();
  }, true]]);
  $('#addCol').onclick = async () => {
    const n = $('#newCol').value.trim(); if (!n) return;
    if (!allCollections().includes(n)) await saveSettings({ collections: [...(S.settings.collections || []), n] });
    $('#colList').insertAdjacentHTML('beforeend', `<label class="check"><input type="checkbox" data-n="${esc(n)}" checked> ${esc(n)}</label>`);
    $('#newCol').value = '';
  };
}
function manageCollections() {
  const custom = (S.settings.collections || []).filter((n) => n !== 'Want to read' && n !== 'Finished');
  modal(`<h2>Your collections</h2>${custom.length ? custom.map((n) =>
    `<div class="fix"><span style="flex:1">${esc(n)}</span><button class="danger" data-del="${esc(n)}">Delete</button></div>`).join('')
    : '<p class="muted">You haven’t made any yet. Right-click a book → Collections… to create one.</p>'}
    <p class="muted">Deleting a collection keeps its books in your library.</p>`, [['Done', () => renderLibrary(), true]]);
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const n = b.dataset.del;
    await saveSettings({ collections: (S.settings.collections || []).filter((x) => x !== n), filter: S.settings.filter === n ? '' : S.settings.filter });
    for (const bk of S.books.filter((x) => x.collections.includes(n))) {
      await api('/api/state/' + bk.id, { method: 'PUT', json: { collections: bk.collections.filter((x) => x !== n) } });
    }
    b.closest('.fix').remove();
  }));
}

// ---------- import (button + drag & drop) ----------
$('#importBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
async function importFiles(files) {
  let last = null;
  for (const f of files) {
    toast(`Adding “${f.name}”…`, 60000);
    try {
      last = await api('/api/import', { method: 'POST', body: f, headers: { 'X-Filename': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' } });
    } catch (err) { toast(`Couldn't add ${f.name}: ${err.message}`, 6000); }
  }
  if (last) { toast(files.length === 1 ? `Added “${last.title}”` : `Added ${files.length} books`); }
  if (S.view === 'library') renderLibrary(); else show('library');
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#dropHint').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
  const files = [...e.dataTransfer.files].filter((f) => /\.(epub|pdf|txt)$/i.test(f.name));
  const zips = [...e.dataTransfer.files].filter((f) => /\.zip$/i.test(f.name));
  if (zips.length) restoreBackup(zips[0]);
  if (files.length) importFiles(files);
});

// ---------- search ----------
const SOURCES = [['gutenberg', 'Gutenberg'], ['standardEbooks', 'Standard Ebooks'], ['archive', 'Internet Archive'], ['openLibrary', 'Open Library'], ['wikisource', 'Wikisource'], ['feedbooks', 'Feedbooks']];
$('#searchForm').onsubmit = (e) => { e.preventDefault(); runSearch($('#q').value.trim()); };
function runSearch(q) {
  if (!q) return;
  const gen = ++S.searchGen;
  S.results = []; renderResults();
  let pending = SOURCES.length; const failed = []; const seen = new Set();
  const status = () => {
    $('#searchStatus').textContent = `${pending ? 'Searching… ' : ''}${S.results.length} results` +
      (failed.length ? ` (couldn’t reach ${failed.join(', ')})` : '') + (S.results.length ? '. Click one for details.' : '');
  };
  status();
  for (const [key, name] of SOURCES) {
    api(`/api/search?source=${key}&q=${encodeURIComponent(q)}`).then((list) => {
      if (gen !== S.searchGen) return;
      for (const r of list) { const k = r.iaId || r.url || r.title; if (!seen.has(k)) { seen.add(k); S.results.push(r); } }
    }).catch(() => { if (gen === S.searchGen) failed.push(name); }).finally(() => {
      if (gen !== S.searchGen) return;
      pending--; renderResults(); status();
    });
  }
}
function renderResults() {
  $('#results').innerHTML = S.results.map((r, i) => `<div class="result" data-i="${i}">
    <div class="thumb">${r.cover ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(r.cover)}" onerror="this.remove()">` : ''}</div>
    <div><div class="t">${esc(r.title)}<span class="src">${esc(r.source)}</span></div>
    <div class="s">${esc(r.author || 'Unknown author')}${r.info ? ' · ' + esc(r.info) : ''}</div></div></div>`).join('');
}
$('#results').onclick = (e) => { const el = e.target.closest('.result'); if (el) showDetails(S.results[+el.dataset.i]); };
function showDetails(r) {
  modal(`<div class="detail">${r.cover ? `<div class="cv"><img src="/api/img?url=${encodeURIComponent(r.cover)}" onerror="this.parentNode.remove()"></div>` : ''}
    <div><h2>${esc(r.title)}</h2><div>${esc(r.author || 'Unknown author')}</div>
    <div class="muted" style="margin-top:6px">From ${esc(r.source)}${r.info ? '<br>' + esc(r.info) : ''}</div>
    <p>${esc(r.description || 'No description available.')}</p></div></div>`,
  [['Cancel'], ['Download for later', () => download(r, true)], ['Download & open', () => download(r, false), true]]);
}
async function download(r, later) {
  toast(`Downloading “${r.title}”…`, 120000);
  try {
    const b = await api('/api/download', { method: 'POST', json: { ...r, later } });
    toast(later ? `Added “${b.title}” to Want to read` : `Added “${b.title}”`);
    await loadLibrary();
    if (!later) openBook(b.id);
  } catch (e) { toast(`Couldn't get that book: ${e.message}`, 7000); }
}

// ---------- sentence segments & what to say (mirrors Speech.kt) ----------
const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e', 'no', 'vol', 'ch', 'prof', 'rev', 'gen', 'col', 'capt', 'lt', 'mt', 'ft', 'pp', 'fig', 'cf', 'hon', 'messrs', 'mme', 'mlle']);
const CLOSERS = '.!?"”’\')]';
function segments(paras) {
  const out = [];
  const add = (pi, p, s0, e) => {
    let a = s0; while (a < e && p[a] === ' ') a++;
    if (a >= e) return;
    while (e - a > 400) {
      const comma = p.lastIndexOf(', ', a + 300);
      let cut = comma > a + 80 ? comma + 1 : -1;
      if (cut < 0) { const sp = p.lastIndexOf(' ', a + 300); cut = sp > a + 80 ? sp : a + 300; }
      out.push([pi, a, cut]); a = cut; while (a < e && p[a] === ' ') a++;
    }
    if (a < e) out.push([pi, a, e]);
  };
  paras.forEach((p, pi) => {
    const n = p.length; let start = 0; let i = 0;
    while (i < n) {
      const c = p[i];
      if (c === '.' || c === '!' || c === '?' || c === '…') {
        let j = i + 1; while (j < n && CLOSERS.includes(p[j])) j++;
        if (j < n && p[j] === ' ') {
          let k = i; while (k > 0 && (/\p{L}/u.test(p[k - 1]) || p[k - 1] === '.')) k--;
          const word = p.slice(k, i).toLowerCase();
          const abbr = c === '.' && (ABBREV.has(word) || (word.length === 1 && /\p{L}/u.test(word)));
          if (!abbr) { add(pi, p, start, j); start = j + 1; }
        }
        i = j;
      } else i++;
    }
    if (start < n) add(pi, p, start, n);
  });
  return out;
}
const RE_FOOT = /\[(\d{1,3}|[a-zA-Z*†‡])\]|\{\d{1,3}\}|(?<=[.,;:”"])\d{1,3}(?=\s|$)/g;
const RE_URL = /https?:\/\/\S+|www\.\S+/g;
const RE_ILL = /\[(Illustration|Image|Picture|Sidenote)[^\]]*\]/gi;
const RE_PAGE = /^\[?(page|pg\.?|p\.)\s*\d+\]?$/i;
const RE_BOILER = /digitized by (the )?(internet archive|google|microsoft)|produced in epub format by the internet archive|^this (e-?book|book) is for the use of anyone anywhere/i;
let fixRules = [];
function buildFixRules() {
  fixRules = (S.settings.fixes || []).filter((f) => f.from).map((f) => [new RegExp('(?<![\\p{L}\\p{N}])' + f.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu'), f.to || '']);
}
function spoken(text) {
  let t = text;
  if (S.settings.skipClutter !== false) {
    if (RE_BOILER.test(t)) return null;
    if (/^\s*\[Footnote/i.test(t)) return null;
    t = t.replace(RE_FOOT, '').replace(RE_ILL, '').replace(RE_URL, '');
    const tr = t.trim();
    if (RE_PAGE.test(tr)) return null;
    const core = tr.replace(/[\s\p{P}\p{S}]/gu, '');
    if (!core || /^\d+$/.test(core)) return null;
  }
  for (const [re, to] of fixRules) t = t.replace(re, to);
  t = t.trim();
  return t || null;
}

// ---------- book loading / reader ----------
async function loadBook(id) {
  if (S.book && S.book.id === id) return;
  pause();
  const d = await api('/api/book/' + id);
  S.book = d.book; S.paras = d.paras; S.chapters = d.chapters; S.bookState = d.state;
  S.segs = segments(S.paras);
  S.segIdx = segFor(d.state.pos || 0, d.state.off || 0);
  S.settings.lastBook = id;
  S.renderedFor = null;
  setupPlayer();
}
async function openBook(id) {
  try { await loadBook(id); } catch (e) { toast("Couldn't open that book: " + e.message, 6000); return; }
  show('reader');
  renderReader();
}
function segFor(para, off = 0) {
  const segs = S.segs; if (!segs.length) return 0;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid][0] < para) lo = mid + 1; else hi = mid; }
  let k = lo;
  while (k + 1 < segs.length && segs[k][0] === para && segs[k + 1][0] === para && segs[k][2] <= off) k++;
  return k;
}
const curPara = () => (S.segs[S.segIdx] ? S.segs[S.segIdx][0] : 0);
function chapterIndex(para) { let r = -1; S.chapters.forEach((c, k) => { if (c.para <= para) r = k; }); return r; }
function chapterTitle(para) { const i = chapterIndex(para); return i >= 0 ? S.chapters[i].title : null; }

function renderReader() {
  if (!S.book) return;
  $('#rTitle').textContent = S.book.title;
  document.title = S.book.title + ' — Shelf Reader';
  if (S.renderedFor !== S.book.id) {
    const chapStarts = new Set(S.chapters.map((c) => c.para));
    const marks = noteMarks();
    $('#text').innerHTML = S.paras.map((p, i) =>
      `<p data-i="${i}"${chapStarts.has(i) ? ' class="chap"' : ''}><button class="go" title="Read from here">▶</button>${marks[i] || ''}<span class="tx">${esc(p)}</span></p>`).join('');
    S.renderedFor = S.book.id; S.hlPara = -1;
  }
  highlight(true);
}
function noteMarks() {
  const m = {};
  for (const n of S.bookState.notes || []) m[n.para] = `<span class="mk" title="${esc(n.text || 'Bookmark')}">${n.text ? '📝' : '🔖'}</span>`;
  return m;
}
function refreshMarks() { S.renderedFor = null; if (S.view === 'reader') { const y = $('#reader').scrollTop; renderReader(); $('#reader').scrollTop = y; } }
let lastUserScroll = 0;
$('#reader').addEventListener('wheel', () => (lastUserScroll = Date.now()), { passive: true });
$('#reader').addEventListener('keydown', () => (lastUserScroll = Date.now()));
function highlight(forceScroll = false) {
  if (S.view !== 'reader' || S.renderedFor !== (S.book && S.book.id)) return;
  const seg = S.segs[S.segIdx]; if (!seg) return;
  const [pi, a, b] = seg;
  if (S.hlPara >= 0 && S.hlPara !== pi) {
    const old = $(`#text p[data-i="${S.hlPara}"]`);
    if (old) { old.classList.remove('cur'); old.querySelector('.tx').textContent = S.paras[S.hlPara]; }
  }
  const el = $(`#text p[data-i="${pi}"]`); if (!el) return;
  el.classList.add('cur');
  const p = S.paras[pi];
  el.querySelector('.tx').innerHTML = esc(p.slice(0, a)) + '<mark>' + esc(p.slice(a, b)) + '</mark>' + esc(p.slice(b));
  const moved = S.hlPara !== pi; S.hlPara = pi;
  if (forceScroll || (moved && Date.now() - lastUserScroll > 6000)) {
    const r = el.getBoundingClientRect(); const box = $('#reader').getBoundingClientRect();
    if (forceScroll || r.top < box.top + 60 || r.bottom > box.bottom - 40) el.scrollIntoView({ block: 'center', behavior: forceScroll ? 'auto' : 'smooth' });
  }
  $('#rChap').textContent = chapterTitle(pi) || S.book.author || '';
}
$('#text').addEventListener('click', (e) => {
  const go = e.target.closest('.go');
  if (go) { const i = +go.parentNode.dataset.i; jumpTo(i, true); }
});
$('#text').addEventListener('contextmenu', (e) => {
  const p = e.target.closest('p[data-i]'); if (!p) return;
  e.preventDefault();
  const i = +p.dataset.i;
  const sel = String(window.getSelection() || '').trim();
  const items = [
    ['Read aloud from here', () => jumpTo(i, true)],
    ['Bookmark this paragraph', () => addNote(i, '')],
    ['Add a note…', () => promptNote(i)],
    ['Copy paragraph', () => navigator.clipboard.writeText(S.paras[i]).then(() => toast('Copied'))]
  ];
  if (sel && sel.split(/\s+/).length <= 3) items.push([`Define “${sel.slice(0, 30)}”`, () => define(sel)]);
  if ((S.bookState.notes || []).some((n) => n.para === i)) items.push(null, ['Remove bookmark / notes here', () => removeNotes(i)]);
  showMenu(e.clientX, e.clientY, items);
});
$('#backBtn').onclick = () => { document.title = 'Shelf Reader'; show('library'); };

// Define bubble on word selection
document.addEventListener('mouseup', (e) => {
  const bubble = $('#defineBubble');
  if (e.target === bubble) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const word = String(sel || '').trim();
    if (S.view !== 'reader' || !word || word.includes(' ') || word.length > 40 || !sel.anchorNode || !$('#text').contains(sel.anchorNode)) { bubble.hidden = true; return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    bubble.textContent = `Define “${word}”`;
    bubble.style.left = Math.max(8, r.left) + 'px'; bubble.style.top = Math.max(8, r.top - 34) + 'px';
    bubble.hidden = false;
    bubble.onclick = () => { bubble.hidden = true; define(word); };
  }, 10);
});
async function define(word) {
  modal(`<h2>${esc(word)}</h2><p class="muted">Looking it up…</p>`, [['Close', null, true]]);
  try {
    const d = await api('/api/define?w=' + encodeURIComponent(word));
    $('#modalBody').innerHTML = `<h2>${esc(d.word)} <span class="muted" style="font-weight:400">${esc(d.phonetic || '')}</span></h2>` +
      (d.text ? `<p>${esc(d.text)}</p>` : d.defs.map((x) => `<p><b>${esc(x.pos)}</b> ${esc(x.def)}${x.example ? `<br><i class="muted">e.g. “${esc(x.example)}”</i>` : ''}</p>`).join('')) +
      '<p class="muted" style="font-size:12px">From dictionaryapi.dev</p>';
  } catch (e) { $('#modalBody').innerHTML = `<h2>${esc(word)}</h2><p>Couldn’t look that up: ${esc(e.message)}</p>`; }
}

// ---------- notes ----------
async function saveState(patch) { S.bookState = await api('/api/state/' + S.book.id, { method: 'PUT', json: patch }); }
async function addNote(i, text) {
  const notes = [...(S.bookState.notes || []), { para: i, text, time: Date.now() }].sort((a, b) => a.para - b.para);
  await saveState({ notes }); refreshMarks(); toast(text ? 'Note saved' : 'Bookmarked');
}
function promptNote(i) {
  modal(`<h2>Note</h2><div class="muted" style="margin-bottom:8px">${esc(S.paras[i].slice(0, 160))}…</div><textarea id="noteText" rows="4" placeholder="Your note"></textarea>`,
    [['Cancel'], ['Save', () => { const t = $('#noteText').value.trim(); if (t) addNote(i, t); }, true]]);
  setTimeout(() => $('#noteText').focus(), 0);
}
async function removeNotes(i) { await saveState({ notes: (S.bookState.notes || []).filter((n) => n.para !== i) }); refreshMarks(); }

// ---------- drawer: chapters / bookmarks / search ----------
function openDrawer(title, html) { $('#drawerTitle').textContent = title; $('#drawerBody').innerHTML = html; $('#drawer').hidden = false; }
function closeDrawer() { $('#drawer').hidden = true; }
$('#drawerClose').onclick = closeDrawer;
function showChapters() {
  if (!S.book) return;
  if (!S.chapters.length) { toast('No chapters were found in this book.'); return; }
  const cur = chapterIndex(curPara());
  openDrawer('Chapters', S.chapters.map((c, k) => `<div class="ditem${k === cur ? ' cur' : ''}" data-p="${c.para}">${esc(c.title)}</div>`).join(''));
  const el = $('#drawerBody .cur'); if (el) el.scrollIntoView({ block: 'center' });
}
function showNotes() {
  if (!S.book) return;
  const notes = S.bookState.notes || [];
  openDrawer('Bookmarks & notes', notes.length ? notes.map((n, k) => `<div class="ditem" data-p="${n.para}"><div class="row"><div>
      <div class="s">${esc(chapterTitle(n.para) || 'Paragraph ' + (n.para + 1))}</div>
      ${n.text ? '📝 ' + esc(n.text) : '🔖 ' + esc(S.paras[n.para].slice(0, 90)) + '…'}</div>
      <button class="icon" data-del="${k}" title="Delete">✕</button></div></div>`).join('')
    : '<p class="muted" style="padding:10px">No bookmarks yet. Right-click a paragraph to add one, or press <kbd>B</kbd> while listening.</p>');
}
function showFind(q = '') {
  if (!S.book) return;
  openDrawer('Search in book', `<form class="dsearch" id="findForm"><input id="findQ" placeholder="Word or phrase" value="${esc(q)}"><button>Find</button></form><div id="findRes"></div>`);
  $('#findForm').onsubmit = (e) => { e.preventDefault(); findInBook($('#findQ').value.trim()); };
  setTimeout(() => $('#findQ').focus(), 0);
}
function findInBook(q) {
  if (q.length < 2) return;
  const ql = q.toLowerCase(); const hits = [];
  for (let i = 0; i < S.paras.length && hits.length < 300; i++) if (S.paras[i].toLowerCase().includes(ql)) hits.push(i);
  $('#findRes').innerHTML = `<div class="muted" style="padding:4px 10px">${hits.length}${hits.length >= 300 ? '+' : ''} matches</div>` + hits.map((i) => {
    const p = S.paras[i]; const at = p.toLowerCase().indexOf(ql); const from = Math.max(0, at - 40);
    return `<div class="ditem" data-p="${i}"><div class="s">${esc(chapterTitle(i) || 'Paragraph ' + (i + 1))}</div>${from ? '…' : ''}${esc(p.slice(from, at))}<b>${esc(p.slice(at, at + q.length))}</b>${esc(p.slice(at + q.length, at + q.length + 60))}…</div>`;
  }).join('');
}
$('#drawerBody').onclick = async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); const notes = (S.bookState.notes || []).slice(); notes.splice(+del.dataset.del, 1); await saveState({ notes }); refreshMarks(); showNotes(); return; }
  const it = e.target.closest('[data-p]'); if (!it) return;
  jumpTo(+it.dataset.p, false);
  if (S.view !== 'reader') { show('reader'); renderReader(); }
};
$('#chapBtn').onclick = showChapters;
$('#notesBtn').onclick = showNotes;
$('#findBtn').onclick = () => showFind();

// ---------- speech ----------
function loadVoices() {
  S.voices = speechSynthesis.getVoices();
  fillVoiceSelect();
}
speechSynthesis.onvoiceschanged = loadVoices;
// ---------- friendly voice names ----------
const COUNTRY = { US: 'US', GB: 'UK', AU: 'Australia', IN: 'India', CA: 'Canada', IE: 'Ireland', NZ: 'New Zealand', ZA: 'South Africa',
  SG: 'Singapore', PH: 'Philippines', HK: 'Hong Kong', KE: 'Kenya', NG: 'Nigeria', TZ: 'Tanzania', MX: 'Mexico', ES: 'Spain', FR: 'France', DE: 'Germany', BR: 'Brazil', PT: 'Portugal' };
let langNames = null;
function langLabel(tag) {
  const [l, c] = String(tag || '').split(/[-_]/);
  if (!langNames) { try { langNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (_) { langNames = { of: (x) => x }; } }
  let ln = l; try { ln = langNames.of(l) || l; } catch (_) {}
  return c ? `${ln} (${COUNTRY[c.toUpperCase()] || c.toUpperCase()})` : ln;
}
// Common Microsoft voice first names → gender (Windows and Edge "Natural" voices)
const MS_FEMALE = new Set(['aria', 'jenny', 'michelle', 'ana', 'ava', 'emma', 'sonia', 'libby', 'maisie', 'natasha', 'clara', 'neerja', 'emily', 'molly', 'leah', 'zira', 'hazel', 'susan', 'heera', 'linda', 'catherine', 'sara', 'nancy', 'jane', 'amber', 'ashley', 'cora', 'elizabeth', 'monica', 'luna', 'rosa', 'yan', 'sam', 'abbi', 'bella', 'hollie', 'olivia', 'annette', 'carly', 'elsie', 'freya', 'joanne', 'kim', 'tina', 'asilia', 'ezinne', 'imani', 'luna', 'mia', 'nova']);
const MS_MALE = new Set(['guy', 'christopher', 'eric', 'roger', 'steffan', 'andrew', 'brian', 'davis', 'ryan', 'william', 'liam', 'prabhat', 'connor', 'mitchell', 'luke', 'david', 'mark', 'george', 'ravi', 'richard', 'sean', 'james', 'jacob', 'jason', 'tony', 'brandon', 'alfie', 'elliot', 'ethan', 'noah', 'oliver', 'thomas', 'darren', 'duncan', 'ken', 'neil', 'tim', 'abeo', 'chilemba', 'elimu', 'wayne', 'kai']);
function voiceLabel(name, lang, extraGender) {
  const n = String(name || '');
  const where = langLabel(lang);
  const g = (x) => (x ? ' · ' + x : '');
  let m = /^Google\s+(.*?)(?:\s+(Female|Male))?$/i.exec(n);
  if (m) {
    // Chrome's voices: "Google US English" is a female voice; UK ones say so in the name
    const gender = m[2] || (/^en-US$/i.test(lang) ? 'Female' : '');
    return `Google · ${where}${g(gender)}`;
  }
  m = /^Microsoft\s+([A-Za-z]+)(?:Multilingual)?\b(.*)$/i.exec(n);
  if (m) {
    const first = m[1];
    const k = first.toLowerCase();
    const gender = extraGender || (MS_FEMALE.has(k) ? 'Female' : MS_MALE.has(k) ? 'Male' : '');
    const natural = /natural|online/i.test(m[2]);
    return `${first} · ${where}${g(gender)}${natural ? ' · Natural ★' : ''}`;
  }
  return `${n.replace(/\s*-\s*[^-]+$/, '')}${where ? ' · ' + where : ''}${g(extraGender)}`;
}
function voiceName(v) { return voiceLabel(v.name, v.lang); }
const isGreatVoice = (v) => /natural|^google/i.test(v.name);
function fillVoiceSelect() {
  const sel = $('#voiceSel'); if (!sel) return;
  const lang = (navigator.language || 'en').slice(0, 2);
  const vs = S.voices.filter((v) => v.lang.toLowerCase().startsWith(lang))
    .sort((a, b) => (isGreatVoice(b) - isGreatVoice(a)) || voiceName(a).localeCompare(voiceName(b)));
  const others = S.voices.filter((v) => !vs.includes(v));
  const cur = currentVoiceName();
  sel.innerHTML = `<option value="">Default voice</option>` +
    vs.map((v) => `<option value="${esc(v.name)}">${esc(voiceName(v))}</option>`).join('') +
    (others.length ? `<optgroup label="Other languages">${others.map((v) => `<option value="${esc(v.name)}">${esc(voiceName(v))}</option>`).join('')}</optgroup>` : '');
  sel.value = S.voices.some((v) => v.name === cur) ? cur : '';
}
const currentVoiceName = () => (S.bookState && S.bookState.voice !== undefined ? S.bookState.voice : S.settings.voice) || '';
const currentRate = () => (S.bookState && S.bookState.rate) || S.settings.rate || 1;
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
$('#rateSel').innerHTML = RATES.map((r) => `<option value="${r}">${r}×</option>`).join('');
$('#rateSel').onchange = async (e) => {
  const r = +e.target.value;
  await saveState({ rate: r }); saveSettings({ rate: r });
  if (S.playing) speakFrom(S.segIdx);
};
$('#voiceSel').onchange = async (e) => {
  const v = e.target.value || null;
  await saveState({ voice: v }); saveSettings({ voice: v });
  if (S.playing) speakFrom(S.segIdx);
  else previewVoice(v);
};
function previewVoice(name) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance('Hello! This is how I will sound reading your book.');
  const v = S.voices.find((x) => x.name === name);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = currentRate();
  speechSynthesis.speak(u);
}

function setupPlayer() {
  $('#player').hidden = false;
  $('#pTitle').textContent = S.book.title;
  $('#pCover').innerHTML = coverHtml(S.book);
  $('#rateSel').value = String(currentRate());
  fillVoiceSelect();
  updatePlayer();
  setMediaSession();
}
function updatePlayer() {
  if (!S.book) return;
  const p = curPara();
  const pct = S.paras.length ? Math.floor((p + 1) * 100 / S.paras.length) : 0;
  const parts = [S.playing ? 'Reading' : 'Paused'];
  const ch = chapterTitle(p); if (ch) parts.push(ch);
  parts.push(pct + '%');
  if (S.sleepChapter) parts.push('sleep at chapter end');
  else if (S.sleepAt) parts.push(`sleep in ${Math.max(1, Math.ceil((S.sleepAt - Date.now()) / 60000))} min`);
  $('#pStatus').textContent = parts.join(' · ');
  $('#pPlay').textContent = S.playing ? '❚❚' : '▶';
  if (!S.seeking) $('#seek').value = S.paras.length ? Math.round(p * 100 / Math.max(1, S.paras.length - 1)) : 0;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
}
function savePos(force) {
  const seg = S.segs[S.segIdx]; if (!seg || !S.book) return;
  const now = Date.now();
  if (!force && now - S.lastSave < 2500) return;
  S.lastSave = now;
  api('/api/state/' + S.book.id, { method: 'PUT', json: { pos: seg[0], off: seg[1] } }).then((st) => { S.bookState = st; }).catch(() => {});
}

function play() {
  if (!S.book || !S.segs.length) return;
  S.playing = true;
  keepAlive(true);
  speakFrom(S.segIdx);
  updatePlayer();
  if (S.view === 'library') renderLibrary();
}
function pause() {
  if (!S.playing) { updatePlayer(); return; }
  S.playing = false; S.token++;
  speechSynthesis.cancel();
  keepAlive(false);
  savePos(true);
  updatePlayer();
  if (S.view === 'library') renderLibrary();
}
function toggle() { S.playing ? pause() : play(); }
function speakFrom(i) {
  const token = ++S.token;
  speechSynthesis.cancel();
  S.segIdx = Math.max(0, Math.min(i, S.segs.length - 1));
  setTimeout(() => { if (token === S.token) speakNext(token); }, 60);
}
function speakNext(token) {
  if (token !== S.token || !S.playing) return;
  // skip pieces that shouldn't be read aloud
  let text = null;
  while (S.segIdx < S.segs.length) {
    const [pi, a, b] = S.segs[S.segIdx];
    text = spoken(S.paras[pi].slice(a, b));
    if (text) break;
    S.segIdx++;
  }
  if (!text) { finished(); return; }
  const u = new SpeechSynthesisUtterance(text);
  const v = S.voices.find((x) => x.name === currentVoiceName());
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = currentRate();
  u.onstart = () => { S.speechErrors = 0; };
  u.onend = () => {
    if (token !== S.token) return;
    const k = S.segIdx; const next = k + 1;
    if (S.sleepChapter && next < S.segs.length && chapterIndex(S.segs[next][0]) !== chapterIndex(S.segs[k][0])) {
      S.sleepChapter = false; S.segIdx = next; pause(); setSleep(0); return;
    }
    S.segIdx = next;
    if (S.segIdx >= S.segs.length) { finished(); return; }
    afterMove(); speakNext(token);
  };
  u.onerror = (ev) => {
    if (token !== S.token || ev.error === 'interrupted' || ev.error === 'canceled') return;
    S.speechErrors = (S.speechErrors || 0) + 1;
    if (S.speechErrors >= 3) {
      pause();
      toast('This voice isn’t working. Pick another voice from the menu at the bottom right' +
        (S.info.edge ? ', or use “Open in Edge”.' : '.'), 8000);
      return;
    }
    S.segIdx++; afterMove(); speakNext(token);
  };
  S.utter = u; // keep a reference so the browser doesn't drop the callbacks
  afterMove();
  speechSynthesis.speak(u);
}
function afterMove() { highlight(); updatePlayer(); savePos(false); }
async function finished() {
  S.playing = false; S.token++; keepAlive(false);
  S.segIdx = Math.max(0, S.segs.length - 1);
  savePos(true); updatePlayer();
  const cols = new Set(S.bookState.collections || []); cols.add('Finished'); cols.delete('Want to read');
  await saveState({ collections: [...cols] });
  toast(`Finished “${S.book.title}” 🎉`);
}
function jumpTo(para, startPlaying) {
  if (!S.book) return;
  S.segIdx = segFor(para);
  lastUserScroll = 0;
  savePos(true);
  if (startPlaying && !S.playing) play();
  else if (S.playing) speakFrom(S.segIdx);
  highlight(true); updatePlayer();
}
function stepPara(d) {
  if (!S.book) return;
  const seg = S.segs[S.segIdx];
  const target = d < 0 && S.segIdx > 0 && S.segs[S.segIdx - 1][0] === seg[0] ? seg[0] : Math.max(0, Math.min(S.paras.length - 1, seg[0] + d));
  jumpTo(target, false);
}
function stepChapter(d) {
  if (!S.book) return;
  if (!S.chapters.length) { stepPara(d * 10); return; }
  const ci = chapterIndex(curPara());
  let t;
  if (d < 0) { const start = ci >= 0 ? segFor(S.chapters[ci].para) : 0; t = ci >= 0 && S.segIdx - start > 3 ? ci : ci - 1; }
  else t = ci + 1;
  if (t >= S.chapters.length) return;
  jumpTo(t < 0 ? 0 : S.chapters[t].para, false);
}
$('#pPlay').onclick = toggle;
$('#pPrev').onclick = () => stepPara(-1);
$('#pNext').onclick = () => stepPara(1);
$('#pChapPrev').onclick = () => stepChapter(-1);
$('#pChapNext').onclick = () => stepChapter(1);
$('#pInfo').onclick = () => { if (S.book) { show('reader'); renderReader(); } };
$('#pCover').onclick = $('#pInfo').onclick;
$('#seek').oninput = () => { S.seeking = true; const p = Math.round(+$('#seek').value / 100 * (S.paras.length - 1)); $('#pStatus').textContent = (chapterTitle(p) || '') + ` · ${$('#seek').value}%`; };
$('#seek').onchange = () => { S.seeking = false; jumpTo(Math.round(+$('#seek').value / 100 * (S.paras.length - 1)), false); };

// sleep timer
function setSleep(min) {
  clearInterval(S.sleepTimer); S.sleepAt = 0; S.sleepChapter = false;
  if (min > 0) {
    S.sleepAt = Date.now() + min * 60000;
    S.sleepTimer = setInterval(() => {
      if (Date.now() >= S.sleepAt) { setSleep(0); pause(); toast('Sleep timer: paused'); } else updatePlayer();
    }, 15000);
  } else if (min < 0) S.sleepChapter = true;
  $('#sleepSel').value = String(min > 0 ? min : min < 0 ? -1 : 0);
  updatePlayer();
}
$('#sleepSel').onchange = (e) => setSleep(+e.target.value);

// Media keys + keeps Edge from putting the tab to sleep while reading
function silentWav() {
  const rate = 8000, n = rate; const buf = new ArrayBuffer(44 + n); const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
const keepAudio = $('#keepAlive');
keepAudio.src = silentWav(); keepAudio.volume = 0.01;
function keepAlive(on) { if (on) keepAudio.play().catch(() => {}); else keepAudio.pause(); }
function setMediaSession() {
  if (!('mediaSession' in navigator) || !S.book) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: S.book.title, artist: S.book.author || '', album: 'Shelf Reader', artwork: [{ src: `/api/cover/${S.book.id}`, sizes: '300x450', type: 'image/jpeg' }] });
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (_) {} };
  h('play', play); h('pause', pause); h('previoustrack', () => stepPara(-1)); h('nexttrack', () => stepPara(1));
  h('seekbackward', () => stepPara(-1)); h('seekforward', () => stepPara(1));
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === 'Escape') { $('#modal').hidden = true; $('#menu').hidden = true; closeDrawer(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.book && S.view === 'reader') { e.preventDefault(); showFind(); return; }
  if (typing || !$('#modal').hidden) return;
  if (e.key === ' ' && S.book) { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight' && S.book) { e.preventDefault(); e.shiftKey ? stepChapter(1) : stepPara(1); }
  else if (e.key === 'ArrowLeft' && S.book) { e.preventDefault(); e.shiftKey ? stepChapter(-1) : stepPara(-1); }
  else if (e.key.toLowerCase() === 'b' && S.book) addNote(curPara(), '');
  else if (e.key.toLowerCase() === 'c' && S.book && S.view === 'reader') showChapters();
});

// ---------- menus & modal ----------
function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => (it ? `<div data-i="${i}">${esc(it[0])}</div>` : '<hr>')).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.onclick = (e) => { const d = e.target.closest('[data-i]'); if (!d) return; m.hidden = true; items[+d.dataset.i][1](); };
}
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
function modal(html, actions) {
  $('#modalBody').innerHTML = html;
  $('#modalActions').innerHTML = '';
  for (const [label, fn, primary] of actions) {
    const b = document.createElement('button'); b.textContent = label; if (primary) b.className = 'primary';
    b.onclick = async () => { $('#modal').hidden = true; if (fn) await fn(); };
    $('#modalActions').appendChild(b);
  }
  $('#modal').hidden = false;
}
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

// ---------- settings ----------
$('#settingsBtn').onclick = openSettings;
function openSettings() {
  const s = S.settings;
  const opt = (arr, cur) => arr.map((n, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${n}</option>`).join('');
  modal(`<h2>Settings</h2>
    <h3>Appearance</h3>
    <div class="setrow"><label>Theme</label><select id="sTheme">${opt(['Dark', 'Light', 'Sepia', 'Black'], s.theme || 0)}</select></div>
    <div class="setrow"><label>Font</label><select id="sFont">${opt(['Serif', 'Sans-serif', 'Monospace'], s.font || 0)}</select></div>
    <div class="setrow"><label>Margins</label><select id="sMargin">${opt(['Narrow', 'Medium', 'Wide'], s.margin ?? 1)}</select></div>
    <div class="setrow"><label>Text size</label><input type="range" id="sSize" min="13" max="34" value="${s.textSize || 19}" style="flex:1"></div>
    <h3>Reading aloud</h3>
    <label class="check"><input type="checkbox" id="sClutter" ${s.skipClutter !== false ? 'checked' : ''}> Skip page numbers, footnote markers, links and scan notices</label>
    <p class="muted">Best voices: ${S.info.edge ? 'click <b>Better voices</b> at the top to open your library in Edge (Microsoft “Natural ★” voices) or Chrome (Google voices). ' : 'in Edge pick a voice marked “Natural ★”; in Chrome pick a “Google” voice. '}
      In this window, voices come from Windows (Settings → Time &amp; language → Speech → Add voices).</p>
    <h3>Pronunciation fixes</h3>
    <div id="fixList">${(s.fixes || []).map((f, i) => `<div class="fix"><span style="flex:1"><b>${esc(f.from)}</b> → ${esc(f.to || '(skip)')}</span><button class="danger" data-fx="${i}">Delete</button></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
    <div class="setrow"><input id="fxFrom" placeholder="Word as written" style="flex:1"><input id="fxTo" placeholder="Say it as" style="flex:1"><button id="fxAdd">Add</button></div>
    <h3>Backup &amp; restore</h3>
    <p class="muted">Bring your phone library here: on your phone use Menu → Back up library, copy the .zip to this PC, then restore it (or drop it on this window).</p>
    <div class="setrow"><button id="sRestore">Restore from backup…</button><a href="/api/backup" download><button>Download a backup</button></a></div>
    <h3>Updates</h3>
    <div class="setrow"><span class="muted">Version ${esc(S.info.version || '')}</span><button id="sUpdate">Check for updates</button></div>
    <h3>Keyboard</h3>
    <p class="muted"><kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> paragraph · <kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd> chapter · <kbd>B</kbd> bookmark · <kbd>C</kbd> chapters · <kbd>Ctrl</kbd>+<kbd>F</kbd> search in book · media keys work too</p>`,
  [['Done', null, true]]);
  $('#sTheme').onchange = (e) => saveSettings({ theme: +e.target.value });
  $('#sFont').onchange = (e) => saveSettings({ font: +e.target.value });
  $('#sMargin').onchange = (e) => saveSettings({ margin: +e.target.value });
  $('#sSize').oninput = (e) => { $('#text').style.fontSize = e.target.value + 'px'; };
  $('#sSize').onchange = (e) => saveSettings({ textSize: +e.target.value });
  $('#sClutter').onchange = (e) => saveSettings({ skipClutter: e.target.checked }).then(() => { if (S.playing) speakFrom(S.segIdx); });
  $('#fxAdd').onclick = async () => {
    const from = $('#fxFrom').value.trim(); if (!from) return;
    await saveSettings({ fixes: [...(S.settings.fixes || []), { from, to: $('#fxTo').value.trim() }] }); buildFixRules(); openSettings();
  };
  document.querySelectorAll('[data-fx]').forEach((b) => (b.onclick = async () => {
    const f = (S.settings.fixes || []).slice(); f.splice(+b.dataset.fx, 1); await saveSettings({ fixes: f }); buildFixRules(); openSettings();
  }));
  $('#sRestore').onclick = () => $('#restoreInput').click();
  $('#sUpdate').onclick = checkUpdates;
}
$('#restoreInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); };
async function restoreBackup(file) {
  toast('Restoring backup…', 60000);
  try {
    const r = await api('/api/restore', { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } });
    S.settings = await api('/api/settings'); buildFixRules();
    toast(`Restored: ${r.added} book${r.added === 1 ? '' : 's'} added, with places, notes and collections.`, 6000);
    show('library');
  } catch (e) { toast('Restore failed: ' + e.message, 7000); }
}
async function checkUpdates() {
  try {
    const u = await api('/api/update');
    if (u.newer) {
      modal(`<h2>Update available</h2><p>Build ${u.latest} is out (you have build ${u.current}). Download <b>ShelfReader-Setup.exe</b> from the release page and run it. Your library is kept.</p>`,
        [['Later'], ['Open release page', () => api('/api/open-url', { method: 'POST', json: { url: u.url } }), true]]);
    } else toast(`You're up to date (build ${u.current}).`);
  } catch (e) { toast(e.message, 6000); }
}

// ---------- Edge ----------
$('#edgeBtn').onclick = (e) => {
  const r = e.target.getBoundingClientRect();
  const open = async (which) => {
    if (S.playing) pause();
    try {
      await api('/api/open-' + which, { method: 'POST' });
      toast(which === 'edge'
        ? 'Opened in Edge. Pick a voice marked “Natural ★” in the voice menu. Keep this app open while you listen.'
        : 'Opened in Chrome. Pick a “Google” voice in the voice menu. Keep this app open while you listen.', 8000);
    } catch (err) { toast(err.message, 6000); }
  };
  showMenu(r.left, r.bottom + 4, [
    ['Open in Edge: Microsoft natural voices', () => open('edge')],
    ['Open in Chrome: Google voices', () => open('chrome')]
  ]);
};

// ---------- audio export (Windows app) ----------
$('#exportBtn').onclick = async () => {
  if (!S.book) return;
  let voices = [];
  try { voices = await api('/api/export/voices'); } catch (_) {}
  const cur = chapterIndex(curPara());
  const nCh = Math.max(1, S.chapters.length);
  modal(`<h2>Export as MP3</h2>
    <p class="muted">Saves audio files (one per chapter) to a folder you choose, for any music player or phone.
    Exports use the voices installed in Windows. Browsers don't allow recording the Edge or Google voices.</p>
    <div class="setrow"><label>What</label><select id="xWhat">
      ${S.chapters.length ? `<option value="cur">This chapter: ${esc(S.chapters[Math.max(0, cur)].title)}</option>` : ''}
      <option value="all">Whole book (${nCh} file${nCh === 1 ? '' : 's'})</option></select></div>
    <div class="setrow"><label>Voice</label><select id="xVoice">${voices.length
      ? voices.map((v) => `<option value="${esc(v.name)}">${esc(voiceLabel(v.name, v.lang, v.gender && v.gender !== 'NotSet' ? v.gender : ''))}</option>`).join('')
      : '<option value="">Windows default voice</option>'}</select></div>
    <div class="setrow"><label>Speed</label><select id="xRate">${RATES.map((r) => `<option value="${r}" ${r === currentRate() ? 'selected' : ''}>${r}×</option>`).join('')}</select></div>
    <p class="muted">More Windows voices: Settings → Time &amp; language → Speech → Add voices.</p>`,
  [['Cancel'], ['Choose folder & export', async () => {
    const what = $('#xWhat').value;
    const body = { bookId: S.book.id, voice: $('#xVoice').value || null, rate: +$('#xRate').value,
      from: what === 'cur' ? Math.max(0, cur) : 0, to: what === 'cur' ? Math.max(0, cur) : 9999 };
    try {
      const r = await api('/api/export', { method: 'POST', json: body });
      if (r.started) watchExport();
    } catch (e) { toast(e.message, 6000); }
  }, true]]);
};
function watchExport() {
  const tick = async () => {
    let j; try { j = await api('/api/export'); } catch (_) { return; }
    if (j.running) {
      $('#toast').hidden = false;
      $('#toast').innerHTML = `Exporting “${esc(j.title)}”: ${j.done}/${j.total || '?'} files${j.current ? ' · ' + esc(j.current) : ''} <button id="xCancel" style="margin-left:10px">Cancel</button>`;
      $('#xCancel').onclick = () => api('/api/export/cancel', { method: 'POST' });
      clearTimeout(toastTimer);
      setTimeout(tick, 1500);
    } else if (j.finished) {
      $('#toast').hidden = true;
      modal(`<h2>Export finished</h2><p>Saved ${j.total} MP3 file${j.total === 1 ? '' : 's'} to:<br><span class="muted">${esc(j.folder)}</span></p>`,
        [['Close'], ['Open folder', () => api('/api/export/open', { method: 'POST' }), true]]);
    } else {
      toast(j.error ? 'Export: ' + j.error : 'Export stopped.', 7000);
    }
  };
  tick();
}

// ---------- start ----------
(async function init() {
  S.info = await api('/api/info');
  S.settings = await api('/api/settings');
  buildFixRules();
  applyAppearance();
  // Only in the app window itself (not when already opened in Edge or Chrome)
  $('#edgeBtn').hidden = !S.info.edge || !/Electron/.test(navigator.userAgent);
  $('#exportBtn').hidden = !S.info.export;
  loadVoices();
  await renderLibrary();
  if (/Electron/.test(navigator.userAgent) && S.info.edge && !S.settings.seenTip) {
    saveSettings({ seenTip: true });
    toast('Tip: “Better voices” opens your library in Edge (Microsoft natural voices) or Chrome (Google voices).', 8000);
  }
  if (S.settings.lastBook && bookById(S.settings.lastBook)) {
    try { await loadBook(S.settings.lastBook); } catch (_) {}
  }
})();
window.addEventListener('beforeunload', () => savePos(true));
