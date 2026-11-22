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
  lastTheme = effectiveTheme();
  document.body.className = 'theme-' + lastTheme + (document.body.classList.contains('focus') ? ' focus' : '');
  const t = $('#text');
  t.style.fontFamily = FONTS[s.font || 0];
  t.style.fontSize = (s.textSize || 19) + 'px';
  t.style.maxWidth = WIDTHS[s.margin ?? 1] + 'px';
  const pg = $('#pages');
  pg.style.fontFamily = FONTS[s.font || 0];
  pg.style.fontSize = (s.textSize || 19) + 'px';
  const bk = $('#book');
  bk.style.setProperty('--bookmax', [1500, 1280, 1040][s.margin ?? 1] + 'px');
  bk.style.setProperty('--bpad', [36, 56, 80][s.margin ?? 1] + 'px');
  if (S.view === 'reader' && bookMode() && BK.sec >= 0) {
    const anchor = S.playing ? curPara() : bkTopPara();
    requestAnimationFrame(() => { bkLayout(); bkGo(bkViewOfPara(anchor), { animate: false, quiet: true }); });
  }
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
      <div class="meta"><div class="t">${esc(b.title)}</div><div class="s">${b.percent ? b.percent + '% · ' : ''}${esc(b.author || 'Unknown author')}</div></div>
      <div class="lcols"><div class="lprog"><div style="width:${b.percent || 0}%"></div></div><span>${b.percent ? b.percent + '%' : 'Not started'}</span><span>${esc((b.format || '').toUpperCase())}</span><span>${b.opened ? 'Opened ' + agoDate(b.opened) : 'Never opened'}</span></div></div>`;
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
$('#statsBtn').onclick = showStats;
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
    (S.settings.queue || []).includes(b.id) ? ['Remove from Up next', () => queueToggle(b)] : ['Add to Up next', () => queueToggle(b)],
    ['About this book…', () => aboutBook(b)],
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
