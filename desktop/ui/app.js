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
const RE_FOOT = /\[(\d{1,3}|[a-zA-Z*†‡])\]|\{\d{1,3}\}|(?<=\p{L}[.,;:”"])\d{1,3}(?=\s|$)/gu;
const RE_URL = /https?:\/\/\S+|www\.\S+/g;
const RE_ILL = /\[(Illustration|Image|Picture|Sidenote)[^\]]*\]/gi;
const RE_PAGE = /^\[?(page|pg\.?|p\.)\s*\d+\]?$/i;
const RE_BOILER = /digitized by (the )?(internet archive|google|microsoft)|produced in epub format by the internet archive|^this (e-?book|book) is for the use of anyone anywhere/i;
let fixRules = [];
function buildFixRules() {
  fixRules = (S.settings.fixes || []).filter((f) => f.from).map((f) => [new RegExp('(?<![\\p{L}\\p{N}])' + f.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu'), f.to || '']);
}
function spoken(text, pi) {
  let t = text;
  if (S.settings.skipClutter !== false) {
    if (pi != null && (S.skipParas?.has(pi) || S.headers?.has(S.paras[pi]) || SpeechText.isPageNumber(S.paras[pi]))) return null;
    if (RE_BOILER.test(t)) return null;
    if (/^\s*\[Footnote/i.test(t)) return null;
    t = t.replace(RE_FOOT, '').replace(RE_ILL, '').replace(RE_URL, '');
    const tr = t.trim();
    if (RE_PAGE.test(tr)) return null;
    const core = tr.replace(/[\s\p{P}\p{S}]/gu, '');
    if (!core || /^\d+$/.test(core)) return null;
  }
  for (const [re, to] of fixRules) t = t.replace(re, to);
  if (S.settings.speakNumbers !== false) t = SpeechText.normalize(t);
  t = t.trim();
  return t || null;
}

// ---------- book loading / reader ----------
async function loadBook(id) {
  if (S.book && S.book.id === id) return;
  pause();
  const d = await api('/api/book/' + id);
  S.book = d.book; S.paras = d.paras; S.bookState = d.state;
  S.chapters = SpeechText.improveChapters(d.paras, d.chapters);
  S.headers = SpeechText.headerLines(d.paras, d.book.title, d.book.author);
  // a subtitle line merged into its chapter title ("CHAPTER IV" + "THE STORM") is read as part of the heading
  S.skipParas = new Set();
  for (const c of S.chapters) {
    const nx = (S.paras[c.para + 1] || '').trim();
    if (nx && nx.length < 70 && SpeechText.isHeadingOf(S.paras[c.para], c.title) && c.title.toLowerCase().endsWith(nx.toLowerCase().replace(/[.:]$/, ''))) S.skipParas.add(c.para + 1);
  }
  S.history = []; S.mediaCh = null;
  computeCont();
  S.prevOpened = d.prevOpened || 0;
  indexPictures(d.images);
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
  showRecap(S.prevOpened); S.prevOpened = 0;
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
  const book = bookMode();
  $('#reader').classList.toggle('bookmode', book);
  $('#bookWrap').hidden = !book;
  $('#layoutBtn').textContent = book ? 'Scroll view' : 'Book view';
  if (book) {
    S.renderedFor = null;
    $('#text').innerHTML = '';
    requestAnimationFrame(() => {
      bkShow();
      $('#pages').classList.toggle('listening', S.playing);
      if (!(BK.sections[BK.sec] || {}).front) highlight(true);
    });
    return;
  }
  if (S.renderedFor !== S.book.id) {
    const chapStarts = new Set(S.chapters.map((c) => c.para));
    const marks = noteMarks();
    $('#text').innerHTML = S.paras.map((p, i) =>
      `${picturesHTML(i)}<p data-i="${i}"${chapStarts.has(i) ? ' class="chap"' : S.cont && S.cont[i] ? ' class="cont"' : ''}><button class="go" title="Read from here">▶</button>${marks[i] || ''}<span class="tx">${paraHTML(i)}</span></p>`).join('');
    S.renderedFor = S.book.id; S.hlPara = -1;
  }
  highlight(true);
}
function noteMarks() {
  const m = {};
  for (const n of S.bookState.notes || []) {
    if (n.type === 'hl' && !n.text) continue;
    m[n.para] = `<span class="mk" title="${esc(n.text || 'Bookmark')}">${n.text ? '📝' : '🔖'}</span>`;
  }
  return m;
}
function refreshMarks() {
  if (S.view !== 'reader') return;
  if (bookMode() && BK.sec >= 0) { const v = BK.view; bkRenderSection(BK.sec, {}); bkGo(v, { animate: false, quiet: true }); highlight(); return; }
  S.renderedFor = null; const y = $('#reader').scrollTop; renderReader(); $('#reader').scrollTop = y;
}
let lastUserScroll = 0;
$('#reader').addEventListener('wheel', () => (lastUserScroll = Date.now()), { passive: true });
$('#reader').addEventListener('keydown', () => (lastUserScroll = Date.now()));
function highlight(forceScroll = false) {
  if (S.view !== 'reader' || !S.book) return;
  const book = bookMode();
  if (!book && S.renderedFor !== S.book.id) return;
  const seg = S.segs[S.segIdx]; if (!seg) return;
  const [pi, a, b] = seg;
  const box = book ? '#pages' : '#text';
  if (book) {
    if (BK.sec < 0) return;
    $('#pages').classList.toggle('listening', S.playing);
    const sec = BK.sections[BK.sec];
    if (pi < sec.start || pi >= sec.end) { if (forceScroll || Date.now() - BK.lastTurn > 8000) { bkRenderSection(bkSectionOf(pi), { para: pi }); } else return; }
  }
  if (S.hlPara >= 0 && S.hlPara !== pi) {
    const old = $(`${box} p[data-i="${S.hlPara}"]`);
    if (old) { old.classList.remove('cur'); old.querySelector('.tx').innerHTML = paraHTML(S.hlPara); }
  }
  const el = $(`${box} p[data-i="${pi}"]`); if (!el) return;
  el.classList.add('cur');
  const p = S.paras[pi];
  el.querySelector('.tx').innerHTML = paraHTML(pi, a, b);
  const moved = S.hlPara !== pi; S.hlPara = pi;
  if (book) { bkFollow(forceScroll); $('#rChap').textContent = chapterTitle(pi) || S.book.author || ''; return; }
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
const paraMenu = (e) => {
  const p = e.target.closest('p[data-i]'); if (!p) return;
  e.preventDefault();
  const i = +p.dataset.i;
  const sel = String(window.getSelection() || '').trim();
  const items = [
    ['Read aloud from here', () => jumpTo(i, true)],
    ['Bookmark this paragraph', () => addNote(i, '')],
    ['Add a note…', () => promptNote(i)],
    ['Bookmark with an audio clip', () => saveClip(i)],
    ['Copy paragraph', () => navigator.clipboard.writeText(S.paras[i]).then(() => toast('Copied'))]
  ];
  if (sel && sel.split(/\s+/).length <= 3) items.push([`Define “${sel.slice(0, 30)}”`, () => define(sel)]);
  if ((S.bookState.notes || []).some((n) => n.para === i)) items.push(null, ['Remove bookmark / notes here', () => removeNotes(i)]);
  showMenu(e.clientX, e.clientY, items);
};
$('#text').addEventListener('contextmenu', paraMenu);
$('#pages').addEventListener('contextmenu', paraMenu);
$('#backBtn').onclick = () => { document.title = 'Shelf Reader'; if (document.body.classList.contains('focus')) bkSetFocus(false); show('library'); };
$('#layoutBtn').onclick = async () => {
  const anchor = bookMode() ? (S.playing ? curPara() : bkTopPara()) : curPara();
  await saveSettings({ layout: bookMode() ? 'scroll' : 'book' });
  if (!S.playing) { S.segIdx = segFor(anchor); savePos(true); }
  renderReader();
};

// Highlighter / define bubble on text selection; footnote links
document.addEventListener('mouseup', (e) => {
  if (e.target.closest && (e.target.closest('#selBubble') || e.target.closest('#fnPop'))) return;
  setTimeout(showSelBubble, 10);
});
document.addEventListener('click', (e) => {
  const fn = e.target.closest && e.target.closest('a.fn');
  if (fn) { e.preventDefault(); e.stopPropagation(); showFootnote(fn); return; }
  if (!e.target.closest || !e.target.closest('#fnPop')) $('#fnPop').hidden = true;
}, true);
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
  openDrawer('Chapters', `<div class="dsearch"><button id="goPct">Go to a percentage… (G)</button></div>` +
    S.chapters.map((c, k) => `<div class="ditem${k === cur ? ' cur' : ''}${c.level === 0 && S.chapters.some((x) => x.level === 1) ? ' part' : ''}" data-p="${c.para}" style="${c.level === 1 ? 'padding-left:30px' : ''}">${esc(c.title)}</div>`).join(''));
  $('#goPct').onclick = (e) => { e.stopPropagation(); closeDrawer(); goToPercent(); };
  const el = $('#drawerBody .cur'); if (el) el.scrollIntoView({ block: 'center' });
}
function showNotes() {
  if (!S.book) return;
  const notes = S.bookState.notes || [];
  const body = (n) => {
    if (n.type === 'clip') return `🔊 “${esc((n.quote || '').slice(0, 140))}” <button class="icon" data-clip="${esc(n.file)}" data-rate="${n.rate || 1}" title="Play the clip">▶</button> <a href="/api/clip/${S.book.id}/${esc(n.file)}" download="${esc(S.book.title.slice(0, 40))} clip.${esc(n.file.split('.').pop())}" title="Save the audio file">Save</a>`;
    if (n.type === 'hl') return `<span class="swatch sw-${esc(n.color || 'yellow')}"></span>“${esc((n.quote || S.paras[n.para].slice(n.start, n.end)).slice(0, 140))}”${n.text ? '<br>📝 ' + esc(n.text) : ''}`;
    return n.text ? '📝 ' + esc(n.text) : '🔖 ' + esc(S.paras[n.para].slice(0, 90)) + '…';
  };
  openDrawer('Bookmarks, highlights & notes', (notes.length ? `<div class="dsearch"><button id="exportNotes">Export to a file…</button></div>` : '') + (notes.length ? notes.map((n, k) => `<div class="ditem" data-p="${n.para}"><div class="row"><div>
      <div class="s">${esc(chapterTitle(n.para) || 'Paragraph ' + (n.para + 1))}</div>${body(n)}</div>
      <button class="icon" data-del="${k}" title="Delete">✕</button></div></div>`).join('')
    : '<p class="muted" style="padding:10px">Nothing here yet. Select text to highlight it or add a note, right-click a paragraph to bookmark it, or press <kbd>B</kbd> while listening.</p>'));
  const ex = $('#exportNotes'); if (ex) ex.onclick = exportNotes;
  $('#drawerBody').querySelectorAll('[data-clip]').forEach((x) => { x.onclick = (e) => { e.stopPropagation(); playClip(x.dataset.clip, +x.dataset.rate); }; });
  $('#drawerBody').querySelectorAll('a[download]').forEach((x) => { x.onclick = (e) => e.stopPropagation(); });
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
  if (del && $('#drawerTitle').textContent.startsWith('Bookmarks')) { const n = (S.bookState.notes || [])[+del.dataset.del]; if (n && n.type === 'clip') api(`/api/clip/${S.book.id}/${n.file}`, { method: 'DELETE' }).catch(() => {}); }
  if (del) { e.stopPropagation(); const notes = (S.bookState.notes || []).slice(); notes.splice(+del.dataset.del, 1); await saveState({ notes }); refreshMarks(); showNotes(); return; }
  const it = e.target.closest('[data-p]'); if (!it) return;
  if ($('#drawerTitle').textContent !== 'Search in book' || bookMode()) closeDrawer();
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
  const extra = extraVoiceOptions();
  const extraHtml = extra.map(([label, items]) => `<optgroup label="${esc(label)}">${items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</optgroup>`).join('');
  sel.innerHTML = `<option value="">Default voice</option><option value="__more">＋ More natural &amp; premium voices…</option>` + extraHtml +
    `<optgroup label="${/Electron/.test(navigator.userAgent) ? 'Windows voices' : 'Browser voices'}">` +
    vs.map((v) => `<option value="${esc(v.name)}">${esc(voiceName(v))}</option>`).join('') +
    '</optgroup>' +
    (others.length ? `<optgroup label="Other languages">${others.map((v) => `<option value="${esc(v.name)}">${esc(voiceName(v))}</option>`).join('')}</optgroup>` : '');
  const known = [...sel.options].some((o) => o.value === cur);
  sel.value = known ? cur : '';
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
  if (e.target.value === '__more') { fillVoiceSelect(); openVoiceOptions(); return; }
  const v = e.target.value || null;
  await saveState({ voice: v }); saveSettings({ voice: v });
  if (S.playing) speakFrom(S.segIdx);
  else previewVoice(v);
};
const PREVIEW = new Audio();
async function previewVoice(name) {
  speechSynthesis.cancel(); PREVIEW.pause();
  if (engineOf(name) !== 'browser') {
    toast(engineReady(name) ? 'Playing a sample…' : 'Loading the voice for a sample…', 4000);
    try {
      const r = await genAudio(name, 'Hello! This is how I will sound reading your book.', currentRate());
      PREVIEW.src = URL.createObjectURL(r.blob); PREVIEW.preservesPitch = true; PREVIEW.playbackRate = r.extra || 1;
      await PREVIEW.play();
    } catch (e) { toast('Couldn’t play a sample: ' + e.message, 7000); }
    return;
  }
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
  setTimeout(updateLeft, 0);
  if (!S.book) return;
  const p = curPara();
  const pct = S.paras.length ? Math.floor((p + 1) * 100 / S.paras.length) : 0;
  const parts = [S.playing ? (S.loadingVoice ? 'Loading voice…' : 'Reading') : 'Paused'];
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
  $('#pages').classList.add('listening');
  speakFrom(S.segIdx);
  updatePlayer();
  if (S.view === 'library') renderLibrary();
}
function pause() {
  if (!S.playing) { updatePlayer(); return; }
  S.playing = false; S.token++;
  speechSynthesis.cancel();
  stopAudio();
  keepAlive(false);
  $('#pages').classList.remove('listening');
  savePos(true);
  updatePlayer();
  if (S.view === 'library') renderLibrary();
}
function toggle() { S.playing ? pause() : play(); }
function speakFrom(i) {
  const token = ++S.token;
  speechSynthesis.cancel();
  stopAudio();
  S.segIdx = Math.max(0, Math.min(i, S.segs.length - 1));
  setTimeout(() => { if (token === S.token) speakNext(token); }, 60);
}
function speakNext(token) {
  if (token !== S.token || !S.playing) return;
  // skip pieces that shouldn't be read aloud
  let items = null;
  while (S.segIdx < S.segs.length) {
    items = segItems(S.segIdx);
    if (items) break;
    S.segIdx++;
  }
  if (!items) { finished(); return; }
  S.items = items; S.segStartAt = Date.now();
  const vid = currentVoiceName();
  if (engineOf(vid) === 'browser') browserSpeak(token, items, 0);
  else audioSpeak(token, vid, items.map((x) => x.t).join(' '));
}
const natural = () => S.settings.naturalPauses !== false;
/** S.cont[i]: paragraph i is the rest of a sentence the book broke off at the end of paragraph i-1. */
function computeCont() {
  const on = S.settings.fixBrokenLines !== false;
  S.cont = S.paras.map((p, i) => on && i > 0 && SpeechText.continues(S.paras[i - 1], p));
}
const isClutterPara = (pi) => S.settings.skipClutter !== false && (S.skipParas?.has(pi) || S.headers?.has(S.paras[pi]) || SpeechText.isPageNumber(S.paras[pi]));
/** What to say for a sentence, split into pieces with the pause after each (see speechtext.js). */
function segItems(i) {
  const [pi, a, b] = S.segs[i];
  const ci = chapterIndex(pi); const ch = ci >= 0 ? S.chapters[ci] : null;
  if (ch && ch.para === pi && natural() && SpeechText.isHeadingOf(S.paras[pi], ch.title)) {
    // a chapter heading is announced like an audiobook: "Chapter Twelve." … "The Storm." …
    return a === 0 ? SpeechText.chapterOpening(ch.title) : null;
  }
  let t = spoken(S.paras[pi].slice(a, b), pi);
  if (!t) return null;
  // a sentence the book broke across lines is read as one
  S.segLastFor = S.segLastFor || {};
  let last = i;
  if (S.settings.fixBrokenLines !== false) {
    for (;;) {
      const cur = S.segs[last];
      if (cur[2] < S.paras[cur[0]].trimEnd().length) break;
      let j = last + 1;
      while (j < S.segs.length && S.segs[j][0] !== cur[0] && isClutterPara(S.segs[j][0])) j++;
      if (j >= S.segs.length || S.segs[j][1] !== 0 || S.segs[j][0] === cur[0]) break;
      if (!SpeechText.continues(S.paras[cur[0]], S.paras[S.segs[j][0]])) break;
      const more = spoken(S.paras[S.segs[j][0]].slice(S.segs[j][1], S.segs[j][2]), S.segs[j][0]);
      if (!more) break;
      t = SpeechText.joinText(t, more); last = j;
      if (t.length > 1500) break;
    }
  }
  S.segLastFor[i] = last;
  if (!natural()) return [{ t, gap: 0 }];
  return engineOf(currentVoiceName()) === 'browser' ? SpeechText.pieces(t) : [{ t, gap: SpeechText.endPause(t) }];
}
/** How long to wait after a sentence: by its punctuation, plus more at paragraph and chapter ends. */
function gapAfter(k) {
  if (!natural()) return 0;
  const it = S.items || [];
  let g = it.length ? it[it.length - 1].gap : 280;
  k = (S.segLastFor || {})[k] ?? k;
  const seg = S.segs[k], nx = S.segs[k + 1];
  if (seg && nx && nx[0] !== seg[0]) g += 260;
  if (seg && nx && chapterIndex(nx[0]) !== chapterIndex(seg[0])) g += 900;
  const browser = engineOf(currentVoiceName()) === 'browser';
  return SpeechText.vary(Math.max(0, g / currentRate() - (browser ? 140 : 40)));
}
/** A tiny, steady change of pace from paragraph to paragraph (±2%), so long listening doesn't sound mechanical. */
const paceFor = (pi) => (natural() ? 1 + (((pi * 7919) % 41) - 20) / 1000 : 1);

/** Called when a sentence finishes, whatever voice engine read it. */
function segDone(token) {
  if (token !== S.token) return;
  const wait = gapAfter(S.segIdx);
  if (wait > 0) setTimeout(() => segAdvance(token), wait); else segAdvance(token);
}
function segAdvance(token) {
  if (token !== S.token || !S.playing) return;
  const k = S.segIdx; const next = ((S.segLastFor || {})[k] ?? k) + 1;
  if (S.sleepChapter && next < S.segs.length && chapterIndex(S.segs[next][0]) !== chapterIndex(S.segs[k][0])) {
    S.sleepChapter = false; S.segIdx = next; pause(); setSleep(0); return;
  }
  S.segIdx = next;
  if (S.segIdx >= S.segs.length) { finished(); return; }
  afterMove(); speakNext(token);
}
function speechFailed(token, message) {
  S.speechErrors = (S.speechErrors || 0) + 1;
  if (S.speechErrors >= 3) {
    pause();
    toast((message ? message + ' ' : 'This voice isn’t working. ') + 'Try another voice from the menu at the bottom right.', 9000);
    return;
  }
  S.segIdx++; afterMove(); speakNext(token);
}

function browserSpeak(token, items, k) {
  const u = new SpeechSynthesisUtterance(items[k].t);
  const v = S.voices.find((x) => x.name === currentVoiceName());
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = currentRate() * paceFor(S.segs[S.segIdx][0]);
  u.onstart = () => { S.speechErrors = 0; };
  u.onend = () => {
    if (token !== S.token) return;
    if (k + 1 < items.length) {
      const wait = SpeechText.vary(Math.max(0, items[k].gap / currentRate() - 140));
      setTimeout(() => { if (token === S.token && S.playing) browserSpeak(token, items, k + 1); }, wait);
    } else segDone(token);
  };
  u.onerror = (ev) => {
    if (token !== S.token || ev.error === 'interrupted' || ev.error === 'canceled') return;
    speechFailed(token);
  };
  S.utter = u; // keep a reference so the browser doesn't drop the callbacks
  if (k === 0) afterMove();
  speechSynthesis.speak(u);
}

// Kokoro / Piper / cloud: generate audio for each sentence, a couple of sentences ahead.
const AUD = { el: new Audio(), cache: new Map() };
function segSpoken(i) { const it = segItems(i); return it ? it.map((x) => x.t).join(' ') : null; }
function audioFor(i, vid, rate, text) {
  const key = `${i}|${vid}|${rate}`;
  let p = AUD.cache.get(key);
  if (!p) { p = genAudio(vid, text, rate); p.catch(() => {}); AUD.cache.set(key, p); }
  return p;
}
async function audioSpeak(token, vid, text) {
  const rate = currentRate(); const i = S.segIdx;
  afterMove();
  const p = audioFor(i, vid, rate, text);
  let j = i + 1; let n = 0;
  while (j < S.segs.length && n < 2) { const t = segSpoken(j); if (t) { audioFor(j, vid, rate, t); n++; } j++; }
  for (const key of [...AUD.cache.keys()]) { const idx = +key.split('|')[0]; if (idx < i || idx > j) AUD.cache.delete(key); }
  if (!engineReady(vid)) { S.loadingVoice = true; updatePlayer(); }
  let r;
  try { r = await p; } catch (e) {
    S.loadingVoice = false; updatePlayer();
    if (token !== S.token || e.message === 'dropped') return;
    speechFailed(token, e.message.length < 160 ? e.message + '.' : '');
    return;
  }
  S.loadingVoice = false;
  if (token !== S.token) return;
  S.speechErrors = 0;
  const url = URL.createObjectURL(r.blob);
  const a = AUD.el;
  a.src = url; a.preservesPitch = true; a.playbackRate = Math.max(0.25, Math.min(4, r.extra || 1));
  a.onended = () => { URL.revokeObjectURL(url); segDone(token); };
  a.onerror = () => { URL.revokeObjectURL(url); if (token === S.token) speechFailed(token); };
  updatePlayer();
  a.play().catch((err) => { if (token === S.token) { pause(); toast('Couldn’t play audio: ' + err.message, 6000); } });
}
function stopAudio() {
  AUD.el.onended = null; AUD.el.onerror = null; AUD.el.pause();
  AUD.cache.clear();
  flushEngines();
  S.loadingVoice = false;
}
function afterMove() {
  highlight(); updatePlayer(); savePos(false);
  const ci = chapterIndex(curPara());
  if (ci !== S.mediaCh) { S.mediaCh = ci; setMediaSession(); }
}
async function finished() {
  S.playing = false; S.token++; keepAlive(false); stopAudio();
  S.segIdx = Math.max(0, S.segs.length - 1);
  savePos(true); updatePlayer();
  const cols = new Set(S.bookState.collections || []); cols.add('Finished'); cols.delete('Want to read');
  await saveState({ collections: [...cols] });
  api('/api/stats/finished', { method: 'POST', json: { id: S.book.id, title: S.book.title, author: S.book.author } }).catch(() => {});
  toast(`Finished “${S.book.title}” 🎉`);
  const q = (S.settings.queue || []).filter((id) => id !== S.book.id && bookById(id));
  if (q.length) {
    const next = bookById(q[0]);
    await saveSettings({ queue: q.slice(1) });
    let cancelled = false;
    toastAction(`Finished “${S.book.title}”. Up next: “${next.title}”…`, 'Cancel', () => { cancelled = true; }, 6000);
    setTimeout(async () => { if (cancelled || S.playing) return; await loadBook(next.id); if (S.view === 'reader') renderReader(); play(); }, 6000);
  }
}

// ---------- Up next ----------
async function queueToggle(b) {
  const q = (S.settings.queue || []).slice();
  const i = q.indexOf(b.id);
  if (i >= 0) q.splice(i, 1); else q.push(b.id);
  await saveSettings({ queue: q });
  toast(i >= 0 ? `Removed “${b.title}” from Up next` : `“${b.title}” will play after the books before it in Up next`);
  renderQueueBtn();
}
function renderQueueBtn() {
  const n = (S.settings.queue || []).filter((id) => bookById(id)).length;
  const btn = $('#queueBtn'); if (btn) btn.textContent = `⏭ Up next${n ? ' (' + n + ')' : ''}`;
}
function showQueue() {
  const q = (S.settings.queue || []).filter((id) => bookById(id));
  const html = q.length
    ? q.map((id, k) => { const b = bookById(id); return `<div class="ditem" data-qopen="${id}"><div class="row"><div><b>${k + 1}.</b> ${esc(b.title)}<div class="s">${esc(b.author || '')}</div></div>
        <div>${k ? `<button class="icon" data-qup="${k}" title="Move up">▲</button>` : ''}<button class="icon" data-qdel="${k}" title="Remove">✕</button></div></div></div>`; }).join('')
    : '<p class="muted" style="padding:10px">Nothing queued. Right-click a book and choose <b>Add to Up next</b>; when a book finishes, the next one starts by itself.</p>';
  openDrawer('Up next', html);
  $('#drawerBody').querySelectorAll('[data-qdel]').forEach((x) => { x.onclick = async (e) => { e.stopPropagation(); q.splice(+x.dataset.qdel, 1); await saveSettings({ queue: q }); renderQueueBtn(); showQueue(); }; });
  $('#drawerBody').querySelectorAll('[data-qup]').forEach((x) => { x.onclick = async (e) => { e.stopPropagation(); const k = +x.dataset.qup; [q[k - 1], q[k]] = [q[k], q[k - 1]]; await saveSettings({ queue: q }); showQueue(); }; });
  $('#drawerBody').querySelectorAll('[data-qopen]').forEach((x) => { x.onclick = (e) => { e.stopPropagation(); closeDrawer(); openBook(x.dataset.qopen); }; });
}

// ---------- search inside every book ----------
function searchBooks(q0) {
  openDrawer('Search inside your books', `<form class="dsearch" id="sbForm"><input id="sbQ" placeholder="Word or phrase in any book" value="${esc(q0 || '')}"><button>Search</button></form><div id="sbRes"></div>`);
  const run = async () => {
    const q = $('#sbQ').value.trim(); if (q.length < 2) return;
    $('#sbRes').innerHTML = '<p class="muted" style="padding:10px">Searching…</p>';
    let hits = [];
    try { hits = await api('/api/search-books?q=' + encodeURIComponent(q)); } catch (e) { $('#sbRes').innerHTML = `<p class="muted" style="padding:10px">${esc(e.message)}</p>`; return; }
    if (!hits.length) { $('#sbRes').innerHTML = '<p class="muted" style="padding:10px">Not found in any book.</p>'; return; }
    $('#sbRes').innerHTML = `<p class="muted" style="padding:6px 10px">${hits.length}${hits.length >= 200 ? '+' : ''} places · click to read aloud from there</p>` + hits.map((h, k) => `<div class="ditem" data-sb="${k}">
      <div class="s"><b>${esc(h.title)}</b> · ${esc(h.chapter || '')} · ${h.pct}%</div>${esc(h.snippet.slice(0, h.at))}<b>${esc(h.snippet.slice(h.at, h.at + h.len))}</b>${esc(h.snippet.slice(h.at + h.len))}</div>`).join('');
    $('#sbRes').querySelectorAll('[data-sb]').forEach((x) => { x.onclick = async (e) => {
      e.stopPropagation(); const h = hits[+x.dataset.sb]; closeDrawer();
      await openBook(h.id); jumpTo(h.para, true);
    }; });
  };
  $('#sbForm').onsubmit = (e) => { e.preventDefault(); run(); };
  setTimeout(() => $('#sbQ').focus(), 0);
  if (q0) run();
}

// ---------- about a book: description, subjects, more free books ----------
async function aboutBook(b) {
  modal(`<div class="detail"><div class="cv">${coverHtml(b)}</div><div><h2>${esc(b.title)}</h2><div>${esc(b.author || 'Unknown author')}</div><div id="abBody"><p class="muted">Looking it up on Open Library…</p></div></div></div><div id="abMore"></div>`, [['Close']]);
  const author = (b.author || '').split(/,| and /)[0].trim();
  let subjects = [];
  try {
    const q = new URLSearchParams({ title: b.title, fields: 'key,title,author_name,first_publish_year,subject,number_of_pages_median,edition_count', limit: '1' });
    if (author) q.set('author', author);
    const j = await (await fetch('https://openlibrary.org/search.json?' + q)).json();
    const d = (j.docs || [])[0];
    let desc = '';
    if (d && d.key) {
      try { const w = await (await fetch('https://openlibrary.org' + d.key + '.json')).json(); desc = typeof w.description === 'string' ? w.description : (w.description && w.description.value) || ''; } catch (_) {}
    }
    desc = desc.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/-{3,}[\s\S]*$/, '').trim();
    subjects = ((d && d.subject) || []).filter((x) => x.length < 40 && !/accessible|protected|in library|lending|overdrive|large type|nyt:/i.test(x)).slice(0, 12);
    const facts = [d && d.first_publish_year ? `First published ${d.first_publish_year}` : '', d && d.number_of_pages_median ? `about ${d.number_of_pages_median} pages` : '', d && d.edition_count ? `${d.edition_count} editions` : ''].filter(Boolean).join(' · ');
    $('#abBody').innerHTML = (facts ? `<div class="muted" style="margin-top:6px">${esc(facts)}</div>` : '') +
      `<p>${esc(desc ? (desc.length > 1100 ? desc.slice(0, 1100) + '…' : desc) : 'No description found.')}</p>` +
      (subjects.length ? `<div class="chips">${subjects.map((x) => `<button class="chip" data-subj="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : '') +
      (d && d.key ? `<p class="muted small">From <a href="https://openlibrary.org${esc(d.key)}" target="_blank">Open Library</a></p>` : '');
    $('#abBody').querySelectorAll('[data-subj]').forEach((x) => { x.onclick = () => { $('#modal').hidden = true; show('search'); $('#q').value = x.dataset.subj; runSearch(x.dataset.subj); }; });
  } catch (_) { if ($('#abBody')) $('#abBody').innerHTML = '<p class="muted">Couldn\'t look this book up right now.</p>'; }
  // more free books by the author, and on its main subject
  const lists = [];
  if (author) lists.push(['More by ' + author, author]);
  if (subjects[0]) lists.push(['Free books about ' + subjects[0].toLowerCase(), subjects[0]]);
  for (const [label, q] of lists) {
    let r = [];
    try { r = (await api(`/api/search?source=gutenberg&q=${encodeURIComponent(q)}`)).filter((x) => x.title.toLowerCase() !== b.title.toLowerCase()).slice(0, 8); } catch (_) {}
    if (!r.length || !$('#abMore')) continue;
    const box = document.createElement('div');
    box.innerHTML = `<h3>${esc(label)}</h3><div class="ab-list">${r.map((x, k) => `<div class="result" data-k="${k}"><div class="thumb">${x.cover ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(x.cover)}" onerror="this.remove()">` : ''}</div><div><div class="t">${esc(x.title)}</div><div class="s">${esc(x.author || '')}</div></div></div>`).join('')}</div>`;
    box.querySelectorAll('[data-k]').forEach((el) => { el.onclick = () => showDetails(r[+el.dataset.k]); });
    $('#abMore').appendChild(box);
  }
}

// ---------- audio clips with bookmarks ----------
async function saveClip(i) {
  if (!S.book) return;
  let vid = currentVoiceName();
  if (engineOf(vid) === 'browser') {
    const g = extraVoiceOptions();
    if (!g.length) { toast('Audio clips need a Kokoro, Piper or premium voice. Set one up in Voice options.', 7000); return; }
    vid = g[0][1][0][0];
  }
  let k = S.segs[S.segIdx] && S.segs[S.segIdx][0] === i ? S.segIdx : segFor(i);
  const [pi, a] = S.segs[k];
  let b = S.segs[k][2];
  if (b - a < 60 && S.segs[k + 1] && S.segs[k + 1][0] === pi) b = S.segs[k + 1][2];
  const quote = S.paras[pi].slice(a, b).trim();
  toast('Making the clip…', 60000);
  try {
    const r = await genAudio(vid, spoken(quote, pi) || quote, currentRate());
    const ext = /mpeg|mp3/.test(r.blob.type) ? 'mp3' : 'wav';
    const file = `clip-${Date.now()}.${ext}`;
    await api(`/api/clip/${S.book.id}/${file}`, { method: 'PUT', body: r.blob, headers: { 'Content-Type': 'application/octet-stream' } });
    const notes = (S.bookState.notes || []).slice();
    notes.push({ type: 'clip', para: pi, start: a, end: b, quote, file, rate: r.extra || 1, text: '', time: Date.now() });
    await saveState({ notes }); refreshMarks();
    toastAction('Saved the clip with a bookmark.', '▶ Play', () => playClip(file, r.extra || 1));
  } catch (e) { toast('Couldn\'t make the clip: ' + e.message, 7000); }
}
function playClip(file, rate) {
  const a = new Audio(`/api/clip/${S.book.id}/${file}`);
  a.preservesPitch = true; a.playbackRate = rate || 1;
  if (S.playing) pause();
  a.play().catch(() => {});
}
function jumpTo(para, startPlaying) {
  if (!S.book) return;
  recordJump(para);
  S.segIdx = segFor(para);
  lastUserScroll = 0;
  savePos(true);
  if (startPlaying && !S.playing) play();
  else if (S.playing) speakFrom(S.segIdx);
  highlight(true); updatePlayer();
}
// ---------- getting around: 15/30 seconds, repeat, places you jumped from, go to % ----------
function goSeg(i) {
  if (!S.book || !S.segs.length) return;
  S.segIdx = Math.max(0, Math.min(S.segs.length - 1, i));
  lastUserScroll = 0;
  savePos(true);
  if (S.playing) speakFrom(S.segIdx);
  highlight(true); updatePlayer();
}
/** Moves by about this many seconds of listening (estimated from the text at the current speed). */
function skipTime(sec) {
  if (!S.book) return;
  const cps = 14.5 * currentRate();
  let need = Math.abs(sec) * cps; let i = S.segIdx;
  const len = (k) => S.segs[k][2] - S.segs[k][1];
  if (sec < 0) { while (i > 0 && need > 0) { i--; need -= len(i); } }
  else { while (i < S.segs.length - 1 && need > 0) { need -= len(i); i++; } }
  goSeg(i);
}
/** Again: the sentence being read (or the one before, if it only just started). */
function repeatSentence() {
  if (!S.book) return;
  const justStarted = S.playing && Date.now() - (S.segStartAt || 0) < 1500;
  goSeg(S.playing && !justStarted ? S.segIdx : S.segIdx - 1);
}
function recordJump(toPara) {
  if (!S.book || !S.segs.length) return;
  const from = curPara();
  if (Math.abs(toPara - from) < 4) return;
  S.history = (S.history || []).filter((h) => Math.abs(h.para - from) > 2);
  S.history.unshift({ seg: S.segIdx, para: from, at: Date.now() });
  S.history.length = Math.min(S.history.length, 12);
  toastAction('Jumped to a new place.', '↶ Go back', () => goBackTo(0));
}
function goBackTo(k) {
  const h = (S.history || [])[k]; if (!h) return;
  const here = { seg: S.segIdx, para: curPara(), at: Date.now() };
  S.history.splice(k, 1);
  if (Math.abs(here.para - h.para) > 2) S.history.unshift(here);
  goSeg(h.seg);
}
function placeLabel(para) {
  const pct = Math.floor((para + 1) * 100 / Math.max(1, S.paras.length));
  return `${chapterTitle(para) || 'Beginning'} · ${pct}%`;
}
function ago(t) { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; }
function showHistory(x, y) {
  if (!S.book) return;
  const h = S.history || [];
  if (!h.length) { toast('No jumps yet. When you jump to another place, the place you left is kept here.'); return; }
  showMenu(x, y, h.map((e, k) => [`↶ ${placeLabel(e.para)} (${ago(e.at)})`, () => goBackTo(k)]));
}
function goToPercent() {
  if (!S.book) return;
  const cur = Math.floor((curPara() + 1) * 100 / Math.max(1, S.paras.length));
  modal(`<h2>Go to a place in the book</h2><div class="setrow"><label>Percent</label><input id="gPct" type="number" min="0" max="100" value="${cur}" style="width:90px"> %</div><p class="muted" id="gWhere"></p>`,
    [['Cancel'], ['Go', () => { const v = Math.max(0, Math.min(100, +$('#gPct').value || 0)); jumpTo(Math.round(v / 100 * (S.paras.length - 1)), false); }, true]]);
  const upd = () => { const v = Math.max(0, Math.min(100, +$('#gPct').value || 0)); $('#gWhere').textContent = chapterTitle(Math.round(v / 100 * (S.paras.length - 1))) || ''; };
  $('#gPct').oninput = upd; upd(); setTimeout(() => $('#gPct').select(), 0);
  $('#gPct').onkeydown = (e) => { if (e.key === 'Enter') { $('#modal').hidden = true; const v = Math.max(0, Math.min(100, +$('#gPct').value || 0)); jumpTo(Math.round(v / 100 * (S.paras.length - 1)), false); } };
}
function toastAction(msg, label, fn, ms = 6000) {
  const t = $('#toast'); t.innerHTML = `${esc(msg)} <button class="link" id="toastAct">${esc(label)}</button>`; t.hidden = false;
  $('#toastAct').onclick = () => { t.hidden = true; fn(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
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
$('#pPrev').onclick = () => skipTime(-15);
$('#pPrev').ondblclick = (e) => { e.preventDefault(); repeatSentence(); };
$('#pNext').onclick = () => skipTime(30);
$('#histBtn').onclick = (e) => { const r = e.target.getBoundingClientRect(); showHistory(r.left, r.top - 8 - 34 * Math.min(12, (S.history || []).length || 1)); };
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
  const ch = chapterTitle(curPara());
  // Windows' media overlay and headsets show the chapter, with the book underneath
  navigator.mediaSession.metadata = new MediaMetadata({ title: ch || S.book.title, artist: ch ? S.book.title : (S.book.author || ''), album: S.book.author || 'Shelf Reader', artwork: [{ src: `/api/cover/${S.book.id}`, sizes: '300x450', type: 'image/jpeg' }] });
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (_) {} };
  h('play', play); h('pause', pause); h('previoustrack', () => stepChapter(-1)); h('nexttrack', () => stepChapter(1));
  h('seekbackward', () => skipTime(-15)); h('seekforward', () => skipTime(30));
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === 'Escape') { $('#modal').hidden = true; $('#menu').hidden = true; closeDrawer(); if (document.body.classList.contains('focus')) bkSetFocus(false); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.book && S.view === 'reader') { e.preventDefault(); showFind(); return; }
  if (typing || !$('#modal').hidden) return;
  const pagesShown = S.view === 'reader' && bookMode() && S.book;
  if (e.key === ' ' && S.book) { e.preventDefault(); toggle(); }
  else if (pagesShown && !e.shiftKey && (e.key === 'ArrowRight' || e.key === 'PageDown')) { e.preventDefault(); bkNext(); }
  else if (pagesShown && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'PageUp')) { e.preventDefault(); bkPrev(); }
  else if (e.key.toLowerCase() === 'f' && S.view === 'reader' && !e.ctrlKey) { bkSetFocus(!document.body.classList.contains('focus')); }
  else if (e.key === 'ArrowRight' && S.book) { e.preventDefault(); e.shiftKey ? stepChapter(1) : e.altKey ? stepPara(1) : skipTime(30); }
  else if (e.key === 'ArrowLeft' && S.book) { e.preventDefault(); e.shiftKey ? stepChapter(-1) : e.altKey ? stepPara(-1) : skipTime(-15); }
  else if (e.key.toLowerCase() === 'r' && S.book && !e.ctrlKey) repeatSentence();
  else if (e.key.toLowerCase() === 'g' && S.book && !e.ctrlKey) goToPercent();
  else if (e.key.toLowerCase() === 'h' && S.book && !e.ctrlKey) { const r = $('#histBtn').getBoundingClientRect(); showHistory(r.left, r.top - 8 - 34 * Math.min(12, (S.history || []).length || 1)); }
  else if (e.key.toLowerCase() === 'b' && S.book) addNote(curPara(), '');
  else if (e.key.toLowerCase() === 'c' && S.book && S.view === 'reader') showChapters();
});

// ---------- menus & modal ----------
function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => (it ? `<div data-i="${i}">${esc(it[0])}</div>` : '<hr>')).join('');
  m.hidden = false;
  m.openedAt = performance.now();   // the click that opened the menu must not close it again
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.onclick = (e) => { const d = e.target.closest('[data-i]'); if (!d) return; m.hidden = true; items[+d.dataset.i][1](); };
}
document.addEventListener('click', (e) => { const m = $('#menu'); if (performance.now() - (m.openedAt || 0) < 80) return; if (!e.target.closest('#menu')) m.hidden = true; });
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
    <div class="setrow"><label>Page turn</label><select id="sTurn"><option value="slide">Slide</option><option value="flip" ${s.pageTurn === 'flip' ? 'selected' : ''}>Flip</option></select></div>
    <label class="check"><input type="checkbox" id="sNight" ${s.night && s.night.on ? 'checked' : ''}> Night mode on a schedule</label>
    <div class="setrow"><label>Night mode</label>from <input type="time" id="sNightFrom" value="${esc((s.night && s.night.from) || '21:00')}"> to <input type="time" id="sNightTo" value="${esc((s.night && s.night.to) || '07:00')}">
      <select id="sNightTheme">${opt(['Dark', 'Light', 'Sepia', 'Black'], (s.night && s.night.theme) ?? 3)}</select></div>
    <h3>Reading aloud</h3>
    <div class="setrow"><button id="sVoices" class="primary">Voice options: natural &amp; premium voices…</button></div>
    <label class="check"><input type="checkbox" id="sClutter" ${s.skipClutter !== false ? 'checked' : ''}> Skip page numbers, running headers, footnote markers, links and scan notices</label>
    <label class="check"><input type="checkbox" id="sFixLines" ${s.fixBrokenLines !== false ? 'checked' : ''}> Fix broken lines: join sentences a book split across lines (scanned books and PDFs) before reading them aloud</label>
    <label class="check"><input type="checkbox" id="sNatural" ${s.naturalPauses !== false ? 'checked' : ''}> Natural pauses: by punctuation, longer between paragraphs and chapters, and chapter headings announced like an audiobook</label>
    <label class="check"><input type="checkbox" id="sNumbers" ${s.speakNumbers !== false ? 'checked' : ''}> Say numbers properly: “Chapter XII” → “Chapter Twelve”, Henry VIII, 1850s, $4.50, 3:30 pm, Dr. and St.</label>
    <p class="muted">Best voices: ${S.info.edge ? 'click <b>Better voices</b> at the top to open your library in Edge (Microsoft “Natural ★” voices) or Chrome (Google voices). ' : 'in Edge pick a voice marked “Natural ★”; in Chrome pick a “Google” voice. '}
      In this window, the built-in voices come from Windows.</p>
    <h3>Pronunciation fixes</h3>
    <div id="fixList">${(s.fixes || []).map((f, i) => `<div class="fix"><span style="flex:1"><b>${esc(f.from)}</b> → ${esc(f.to || '(skip)')}</span><button class="danger" data-fx="${i}">Delete</button></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
    <div class="setrow"><input id="fxFrom" placeholder="Word as written" style="flex:1"><input id="fxTo" placeholder="Say it as" style="flex:1"><button id="fxAdd">Add</button></div>
    <h3>Sync with your phone</h3>
    <div id="syncBox" class="muted">Loading…</div>
    <h3>Backup &amp; restore</h3>
    <p class="muted">Bring your phone library here: on your phone use Menu → Back up library, copy the .zip to this PC, then restore it (or drop it on this window).</p>
    <div class="setrow"><button id="sRestore">Restore from backup…</button><a href="/api/backup" download><button>Download a backup</button></a></div>
    <h3>Updates</h3>
    <div id="updBox"><div class="setrow"><span class="muted">Version ${esc(S.info.version || '')}</span><button id="sUpdate">Check for updates</button></div></div>
    <h3>Keyboard</h3>
    <p class="muted"><kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> turn page (Book view) or paragraph (Scroll view) · <kbd>F</kbd> full screen · <kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd> chapter · <kbd>B</kbd> bookmark · <kbd>C</kbd> chapters · <kbd>Ctrl</kbd>+<kbd>F</kbd> search in book · media keys work too</p>`,
  [['Done', null, true]]);
  $('#sTheme').onchange = (e) => saveSettings({ theme: +e.target.value });
  $('#sTurn').onchange = (e) => saveSettings({ pageTurn: e.target.value });
  const saveNight = () => saveSettings({ night: { on: $('#sNight').checked, from: $('#sNightFrom').value || '21:00', to: $('#sNightTo').value || '07:00', theme: +$('#sNightTheme').value } });
  ['#sNight', '#sNightFrom', '#sNightTo', '#sNightTheme'].forEach((id) => { $(id).onchange = saveNight; });
  syncSettingsHTML().then((html) => { const box = $('#syncBox'); if (box) { box.classList.remove('muted'); box.innerHTML = html; bindSyncSettings(openSettings); } });
  $('#sFont').onchange = (e) => saveSettings({ font: +e.target.value });
  $('#sMargin').onchange = (e) => saveSettings({ margin: +e.target.value });
  $('#sSize').oninput = (e) => { $('#text').style.fontSize = e.target.value + 'px'; };
  $('#sSize').onchange = (e) => saveSettings({ textSize: +e.target.value });
  $('#sClutter').onchange = (e) => saveSettings({ skipClutter: e.target.checked }).then(() => { if (S.playing) speakFrom(S.segIdx); });
  $('#sFixLines').onchange = (e) => saveSettings({ fixBrokenLines: e.target.checked }).then(() => { computeCont(); if (S.view === 'reader') renderReader(); if (S.playing) speakFrom(S.segIdx); });
  $('#sNatural').onchange = (e) => saveSettings({ naturalPauses: e.target.checked }).then(() => { if (S.playing) speakFrom(S.segIdx); });
  $('#sNumbers').onchange = (e) => saveSettings({ speakNumbers: e.target.checked }).then(() => { if (S.playing) speakFrom(S.segIdx); });
  $('#fxAdd').onclick = async () => {
    const from = $('#fxFrom').value.trim(); if (!from) return;
    await saveSettings({ fixes: [...(S.settings.fixes || []), { from, to: $('#fxTo').value.trim() }] }); buildFixRules(); openSettings();
  };
  document.querySelectorAll('[data-fx]').forEach((b) => (b.onclick = async () => {
    const f = (S.settings.fixes || []).slice(); f.splice(+b.dataset.fx, 1); await saveSettings({ fixes: f }); buildFixRules(); openSettings();
  }));
  $('#sRestore').onclick = () => $('#restoreInput').click();
  $('#sVoices').onclick = () => openVoiceOptions();
  $('#sUpdate').onclick = checkUpdates;
  renderUpdateBox();
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
// ---------- automatic updates (installed app) ----------
const UPD_TEXT = {
  idle: 'Updates are checked automatically.', checking: 'Checking for updates…', uptodate: 'You have the newest version.',
  available: 'An update is available.', downloading: 'Downloading the update…', ready: 'An update is ready. It installs when you restart.',
  error: '', portable: 'You\'re running the zip version, which can\'t update itself. Install once with ShelfReader-Setup.exe (your library is kept) and updates will then arrive automatically.',
  dev: 'Updates are turned off while developing.'
};
async function renderUpdateBox() {
  const box = $('#updBox'); if (!box) return;
  let u; try { u = await api('/api/update'); } catch (_) { return; }
  if (!u.auto) return;   // running outside the app: the simple check stays
  const msg = u.status === 'error' ? `<span style="color:#e06c6c">${esc(u.error)}</span>` : u.status === 'downloading' ? `${UPD_TEXT.downloading} ${u.progress || 0}%` : UPD_TEXT[u.status] || '';
  box.innerHTML = `
    <div class="setrow"><span>Version <b>${esc(u.current)}</b>${u.latest && u.latest !== u.current ? ` · newest ${esc(u.latest)}` : ''}</span></div>
    <p class="muted">${msg}${u.checkedAt ? ` <span class="muted">(checked ${new Date(u.checkedAt).toLocaleTimeString()})</span>` : ''}</p>
    <div class="setrow">
      ${u.status === 'ready' ? '<button id="uInstall" class="primary">Restart and update</button>' : ''}
      ${u.status === 'available' ? '<button id="uDownload" class="primary">Download the update</button>' : ''}
      ${u.status === 'portable' ? '<button id="uRelease">Open the download page</button>' : '<button id="uCheck">Check now</button>'}
    </div>
    ${u.status !== 'portable' && u.status !== 'dev' ? `<label class="check"><input type="checkbox" id="uAuto" ${S.settings.autoUpdate !== false ? 'checked' : ''}> Download updates automatically (they install the next time you restart Shelf Reader)</label>
    <details ${u.status === 'error' && !u.hasToken ? 'open' : ''}><summary>Private repository? Add a GitHub token</summary>
      <p class="muted">While the GitHub repository is private, GitHub only shares updates with your account. Make a read-only token: on GitHub open <b>Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token</b>, choose <b>Only select repositories → shelf-reader</b>, set <b>Contents</b> to <b>Read-only</b>, and paste it here. It stays on this PC. (If you make the repository public, no token is needed.)</p>
      <div class="setrow"><input id="uToken" type="password" placeholder="${u.hasToken ? 'A token is saved. Paste a new one to replace it' : 'github_pat_…'}" style="flex:1"><button id="uTokenSave">Save</button>${u.hasToken ? '<button id="uTokenDel" class="danger">Remove</button>' : ''}</div>
    </details>` : ''}`;
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('#uCheck', async () => { $('#uCheck').disabled = true; await api('/api/update/check', { method: 'POST' }).catch(() => {}); pollUpdates(); renderUpdateBox(); });
  on('#uDownload', async () => { api('/api/update/download', { method: 'POST' }).catch(() => {}); setTimeout(renderUpdateBox, 800); });
  on('#uInstall', installUpdate);
  on('#uRelease', () => api('/api/open-url', { method: 'POST', json: { url: 'https://github.com/kefirman9000/shelf-reader/releases/latest' } }));
  on('#uTokenSave', async () => {
    try { await api('/api/update/token', { method: 'POST', json: { token: $('#uToken').value } }); toast('Token saved. Checking for updates…'); pollUpdates(); renderUpdateBox(); }
    catch (e) { toast(e.message, 7000); }
  });
  on('#uTokenDel', async () => { await api('/api/update/token', { method: 'POST', json: { token: '' } }).catch(() => {}); renderUpdateBox(); });
  const a = $('#uAuto'); if (a) a.onchange = () => saveSettings({ autoUpdate: a.checked });
  if (u.status === 'checking' || u.status === 'downloading') setTimeout(renderUpdateBox, 1500);
}
async function installUpdate() {
  if (S.playing) { try { pause(); } catch (_) {} }
  toast('Restarting to update…', 10000);
  await api('/api/update/install', { method: 'POST' }).catch(() => {});
}
/** Shows a small "Update ready" button in the top bar when an update has downloaded. */
async function pollUpdates() {
  clearTimeout(pollUpdates.t);
  let u; try { u = await api('/api/update'); } catch (_) { return; }
  if (!u.auto) return;
  const b = $('#updBtn');
  b.hidden = u.status !== 'ready';
  if (u.status === 'ready') { b.textContent = `Update ready (${u.latest}) · Restart`; b.onclick = installUpdate; }
  pollUpdates.t = setTimeout(pollUpdates, u.status === 'checking' || u.status === 'downloading' ? 4000 : 10 * 60 * 1000);
}
async function checkUpdates() {
  try { const u = await api('/api/update'); if (u.auto) { await api('/api/update/check', { method: 'POST' }); renderUpdateBox(); pollUpdates(); return; } } catch (_) {}
  try {
    const u = await api('/api/update');
    if (u.newer) {
      modal(`<h2>Update available</h2><p>Build ${u.latest} is out (you have build ${u.current}). Download <b>ShelfReader-Setup.exe</b> from the release page and run it. Your library is kept.</p>`,
        [['Later'], ['Open release page', () => api('/api/open-url', { method: 'POST', json: { url: u.url } }), true]]);
    } else toast(`You're up to date (build ${u.current}).`);
  } catch (e) { toast(e.message, 6000); }
}

// ---------- Edge ----------
$('#makerBtn').onclick = () => window.open('maker.html', '_blank', 'width=1100,height=900');
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
    ['Natural & premium voices for this app…', () => openVoiceOptions()],
    null,
    ['Open in Edge: Microsoft natural voices', () => open('edge')],
    ['Open in Chrome: Google voices', () => open('chrome')]
  ]);
};

// ---------- audio export (Windows app) ----------
$('#exportBtn').onclick = () => {
  if (!S.book) return;
  const groups = extraVoiceOptions();
  if (!groups.length) {
    modal(`<h2>Export as MP3</h2><p>Exporting needs a natural voice. Install the free <b>Kokoro</b> voices (a one-time download) or a <b>Piper</b> voice, or add a premium voice key, then come back here.</p>`,
      [['Cancel'], ['Open Voice options', () => openVoiceOptions(), true]]);
    return;
  }
  const cur = chapterIndex(curPara());
  const nCh = Math.max(1, S.chapters.length);
  const curVid = currentVoiceName();
  modal(`<h2>Export as MP3</h2>
    <p class="muted">Saves audio files (one per chapter) to a folder you choose, for any music player or phone.</p>
    <div class="setrow"><label>What</label><select id="xWhat">
      ${S.chapters.length ? `<option value="cur">This chapter: ${esc(S.chapters[Math.max(0, cur)].title)}</option>` : ''}
      <option value="all">Whole book (${nCh} file${nCh === 1 ? '' : 's'})</option></select></div>
    <div class="setrow"><label>Voice</label><select id="xVoice">
      ${groups.map(([label, items]) => `<optgroup label="${esc(label)}">${items.map(([v, l]) => `<option value="${esc(v)}" ${v === curVid ? 'selected' : ''}>${esc(l)}</option>`).join('')}</optgroup>`).join('')}
    </select></div>
    <div class="setrow"><label>Speed</label><select id="xRate">${RATES.map((r) => `<option value="${r}" ${r === currentRate() ? 'selected' : ''}>${r}×</option>`).join('')}</select></div>
    <p class="muted">Premium voices are billed by your provider. Browser and Windows voices can't be recorded, so they aren't listed.</p>`,
  [['Cancel'], ['Choose folder & export', () => {
    const what = $('#xWhat').value;
    if (S.playing) pause();
    browserExport({
      from: what === 'cur' ? Math.max(0, cur) : 0, to: what === 'cur' ? Math.max(0, cur) : 9999,
      vid: $('#xVoice').value, rate: +$('#xRate').value
    });
  }, true]]);
};

// ---------- start ----------
bkInit();
(async function init() {
  S.info = await api('/api/info');
  S.settings = await api('/api/settings');
  buildFixRules();
  applyAppearance();
  // Only in the app window itself (not when already opened in Edge or Chrome)
  $('#edgeBtn').hidden = false;
  if (!S.info.edge || !/Electron/.test(navigator.userAgent)) $('#edgeBtn').onclick = () => openVoiceOptions();
  $('#exportBtn').hidden = !S.info.export;
  loadVoices();
  await renderLibrary();
  // Natural & premium voice lists (quietly, in the background)
  Promise.all([piperCatalog().then(piperRefreshStored).catch(() => {}), cloudRefresh().catch(() => {})]).then(() => fillVoiceSelect());
  if (/Electron/.test(navigator.userAgent) && S.info.edge && !S.settings.seenTip) {
    saveSettings({ seenTip: true });
    toast('Tip: “Better voices” opens your library in Edge (Microsoft natural voices) or Chrome (Google voices).', 8000);
  }
  setTimeout(pollUpdates, 15000);
  if (S.settings.lastBook && bookById(S.settings.lastBook)) {
    try { await loadBook(S.settings.lastBook); } catch (_) {}
  }
})();
window.addEventListener('beforeunload', () => savePos(true));

$('#queueBtn').onclick = showQueue;
$('#searchAllBtn').onclick = () => searchBooks('');
setTimeout(renderQueueBtn, 1500);


// ---------- time left in the chapter (player) ----------
function updateLeft() {
  const el = $('#pLeft'); if (!el || !S.book || !S.paras.length) return;
  const p = curPara(); const ci = chapterIndex(p);
  const end = ci + 1 < S.chapters.length ? S.chapters[ci + 1].para : S.paras.length;
  let chars = 0; for (let i = p; i < end; i++) chars += S.paras[i].length;
  const mins = Math.round(chars / (14.5 * 60 * currentRate()));
  el.textContent = (mins < 1 ? 'under a minute' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`) + ' left in this chapter';
}

// ---------- text size: A− / A+, Ctrl + / −, Ctrl + mouse wheel, touchpad pinch ----------
let zoomTimer = 0;
function zoomText(d) {
  const size = Math.max(13, Math.min(40, (S.settings.textSize || 19) + d));
  if (size === (S.settings.textSize || 19)) return;
  S.settings.textSize = size;
  const t = $('#text'); if (t) t.style.fontSize = size + 'px';
  const pg = $('#pages'); if (pg) pg.style.fontSize = size + 'px';
  toast(`Text size ${size}`, 900);
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => { saveSettings({ textSize: size }); if (S.view === 'reader') { try { applyAppearance(); } catch (_) {} } }, 400);
}
$('#zoomIn').onclick = () => zoomText(2);
$('#zoomOut').onclick = () => zoomText(-2);
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || S.view !== 'reader') return;   // touchpad pinch arrives as Ctrl + wheel
  e.preventDefault();
  zoomText(e.deltaY < 0 ? 1 : -1);
}, { passive: false });
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || S.view !== 'reader') return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomText(2); }
  else if (e.key === '-') { e.preventDefault(); zoomText(-2); }
});
