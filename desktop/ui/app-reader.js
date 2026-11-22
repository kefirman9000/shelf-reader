'use strict';
// Shelf Reader PC app, part 2 of 5 (split from app.js to keep files a readable size).
// The parts share one scope and load in order (see the <script> tags); start-up code is in the last part.

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
  let t = SpeechText.clean(text);
  if (!SpeechText.hasWords(t)) return null;   // "* * *", "———": nothing to say (some voices then never answer)
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
      `${picturesHTML(i)}<p data-i="${i}"${paraClass(i, chapStarts)}><button class="go" title="Read from here">▶</button>${marks[i] || ''}<span class="tx">${paraHTML(i)}</span></p>`).join('');
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
function openDrawer(title, html) { if (typeof Ambience !== 'undefined') Ambience.closed(); $('#drawerTitle').textContent = title; $('#drawerBody').innerHTML = html; $('#drawer').hidden = false; }
function closeDrawer() { $('#drawer').hidden = true; if (typeof Ambience !== 'undefined') Ambience.closed(); }
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
