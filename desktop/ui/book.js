'use strict';
/* Book view: the text laid out as pages you turn, a two-page spread on wide windows.
   Only one chapter (or a 250-paragraph slice of a long one) is laid out at a time, so even
   huge books stay quick. Loaded before app.js; uses its globals when called. */

const BK = { sections: [], sec: -1, view: 0, views: 1, step: 1, cols: 1, lastTurn: 0, bookId: null, busy: false };
const bookMode = () => (S.settings.layout || 'book') === 'book';

function bkBuildSections() {
  const ch = S.chapters.length ? S.chapters : [{ title: S.book.title, para: 0 }];
  const secs = [];
  ch.forEach((c, k) => {
    const start = k === 0 ? 0 : c.para;
    const end = k + 1 < ch.length ? ch[k + 1].para : S.paras.length;
    for (let a = start; a < end; a += 250) secs.push({ start: a, end: Math.min(end, a + 250), title: c.title, first: a === start });
  });
  if (!secs.length) secs.push({ start: 0, end: S.paras.length, title: S.book.title, first: true });
  secs.unshift({ front: true, start: 0, end: 0, title: 'Contents', first: true });
  BK.sections = secs; BK.sec = -1; BK.bookId = S.book.id;
}
function bkSectionOf(para) {
  let r = 0;
  for (let i = 0; i < BK.sections.length; i++) { if (BK.sections[i].front) continue; if (BK.sections[i].start <= para) r = i; else break; }
  return r || 1;
}

function bkRenderSection(si, opts = {}) {
  const sec = BK.sections[si];
  BK.sec = si;
  const chapStarts = new Set(S.chapters.map((c) => c.para));
  const marks = noteMarks();
  let html = '';
  if (sec.front) {
    const toc = S.chapters.length ? S.chapters : [{ title: S.book.title, para: 0 }];
    html = `<div class="titlepage"><div class="tp-cover">${coverHtml(S.book)}</div><h1>${esc(S.book.title)}</h1><div class="tp-author">${esc(S.book.author || '')}</div></div>
      <div class="toc"><h2>Contents</h2>${toc.map((c) => `<div class="toc-item" data-p="${c.para}">${esc(c.title)}</div>`).join('')}</div>`;
  }
  for (let i = sec.start; i < sec.end; i++) {
    html += `${picturesHTML(i)}<p data-i="${i}"${chapStarts.has(i) ? ' class="chap"' : S.cont && S.cont[i] ? ' class="cont"' : ''}>${marks[i] || ''}<span class="tx">${paraHTML(i)}</span></p>`;
  }
  const pg = $('#pages');
  pg.innerHTML = html;
  S.hlPara = -1;
  bkLayout();
  let v = 0;
  if (opts.toEnd) v = BK.views - 1;
  else if (opts.para != null) v = bkViewOfPara(opts.para);
  bkGo(v, { animate: false, quiet: true });
}

function bkLayout() {
  const frame = $('#pageFrame'); const pg = $('#pages');
  const W = frame.clientWidth; const H = frame.clientHeight;
  const spread = W >= 860;
  $('#book').classList.toggle('spread', spread);
  const cols = spread ? 2 : 1;
  const gap = spread ? Math.round(W * 0.09) : 48;
  const colW = (W - gap * (cols - 1)) / cols;
  pg.style.width = W + 'px'; pg.style.height = H + 'px';
  pg.style.setProperty('--pageh', H + 'px');
  pg.style.columnWidth = colW + 'px'; pg.style.columnGap = gap + 'px'; pg.style.columnCount = 'auto';
  BK.cols = cols; BK.step = W + gap; BK.colStep = colW + gap;
  const n = Math.max(1, Math.round((pg.scrollWidth + gap) / BK.colStep));
  BK.views = Math.max(1, Math.ceil(n / cols));
}

/** x position of an element inside the (untransformed) page strip */
function bkX(el) {
  const r = el.getClientRects()[0] || el.getBoundingClientRect();
  return r.left - $('#pages').getBoundingClientRect().left;
}
function bkViewOfPara(i) {
  const el = $(`#pages p[data-i="${i}"]`);
  return el ? Math.max(0, Math.min(BK.views - 1, Math.floor((bkX(el) + 2) / BK.step))) : 0;
}
/** Paragraph at the top of the current page */
function bkTopPara() {
  const start = BK.view * BK.step;
  let res = BK.sections[BK.sec] ? BK.sections[BK.sec].start : 0;
  if (BK.sections[BK.sec] && BK.sections[BK.sec].front) return 0;
  for (const p of $('#pages').querySelectorAll('p[data-i]')) {
    const rects = p.getClientRects(); if (!rects.length) continue;
    const pgLeft = $('#pages').getBoundingClientRect().left;
    // the paragraph is on this page if any of its pieces starts on it
    let on = false; let before = false;
    for (const r of rects) { const x = r.left - pgLeft; if (x >= start - 2 && x < start + BK.step - 2) on = true; if (x < start - 2) before = true; }
    if (before && on) return +p.dataset.i;   // continues from the previous page
    if (on) return +p.dataset.i;
  }
  return res;
}

function bkGo(v, { animate = true, quiet = false } = {}) {
  const target = Math.max(0, Math.min(BK.views - 1, v));
  if (animate && S.settings.pageTurn === 'flip' && target !== BK.view) {
    const dir = target > BK.view ? 1 : -1;
    BK.view = target;
    flipFrame(dir, () => bkGo(target, { animate: false, quiet }));
    return;
  }
  BK.view = target;
  const pg = $('#pages');
  pg.style.transition = animate ? '' : 'none';
  pg.style.transform = `translateX(${-BK.view * BK.step}px)`;
  if (!animate) { void pg.offsetWidth; pg.style.transition = ''; }
  bkLabels();
  if (!quiet && !S.playing) {
    // like a real e-reader: your place is the page you're on
    const p = bkTopPara();
    S.segIdx = segFor(p);
    savePos(true); updatePlayer();
  }
}

function bkLabels() {
  const sec = BK.sections[BK.sec]; if (!sec) return;
  if (sec.front) {
    $('#bkHeadL').textContent = ''; $('#bkHeadR').textContent = '';
    $('#bkFootL').textContent = BK.view === 0 ? 'Title page' : 'Contents';
    $('#bkFootR').textContent = 'Turn the page to begin →';
    return;
  }
  const ch = sec.title || '';
  $('#bkHeadL').textContent = BK.cols === 2 ? S.book.title : ch;
  $('#bkHeadR').textContent = BK.cols === 2 ? ch : '';
  // page numbers within this chapter (counting earlier slices of a long chapter)
  let before = 0;
  for (let i = BK.sec - 1; i >= 0 && !BK.sections[i + 1].first; i--) before += BK.sections[i].pages || 0;
  sec.pages = BK.views;
  const left = before + BK.view + 1;
  const pageNo = BK.cols === 2 ? `Pages ${left * 2 - 1}–${left * 2}` : `Page ${left}`;
  const rest = sec.first && BK.sections[BK.sec + 1] && !BK.sections[BK.sec + 1].first ? '' : ` of ${before + BK.views}`;
  $('#bkFootL').textContent = pageNo + (BK.cols === 2 ? (rest ? ` of ${(before + BK.views) * 2}` : '') : rest);
  // time left in this chapter at the current speed (~15 characters a second at 1×)
  const top = bkTopParaFast();
  let chars = 0; const chEnd = bkChapterEnd(BK.sec);
  for (let i = top; i < chEnd; i++) chars += S.paras[i].length;
  const mins = Math.max(1, Math.round(chars / (15 * currentRate()) / 60));
  const pct = S.paras.length ? Math.floor((top + 1) * 100 / S.paras.length) : 0;
  $('#bkFootR').textContent = `${pct}% · ${mins} min left in chapter`;
}
function bkTopParaFast() { try { return bkTopPara(); } catch (_) { return BK.sections[BK.sec].start; } }
function bkChapterEnd(si) { let i = si; while (i + 1 < BK.sections.length && !BK.sections[i + 1].first) i++; return BK.sections[i].end; }

function bkNext() {
  BK.lastTurn = Date.now();
  if (BK.view < BK.views - 1) return bkGo(BK.view + 1);
  if (BK.sec < BK.sections.length - 1) return bkTurnSection(BK.sec + 1, {});
}
function bkPrev() {
  BK.lastTurn = Date.now();
  if (BK.view > 0) return bkGo(BK.view - 1);
  if (BK.sec > 0) return bkTurnSection(BK.sec - 1, { toEnd: true });
}
function bkTurnSection(si, opts) {
  const pg = $('#pages');
  if (S.settings.pageTurn === 'flip') {
    flipFrame(si > BK.sec ? 1 : -1, () => {
      bkRenderSection(si, opts);
      if (!S.playing) { S.segIdx = segFor(bkTopPara()); savePos(true); updatePlayer(); }
    });
    return;
  }
  pg.classList.add('fade');
  setTimeout(() => {
    bkRenderSection(si, opts);
    pg.classList.remove('fade');
    if (!S.playing) { S.segIdx = segFor(bkTopPara()); savePos(true); updatePlayer(); }
  }, 160);
}

/** Show the book view for the current book, at the reading position. */
function bkShow() {
  if (BK.bookId !== S.book.id || !BK.sections.length) bkBuildSections();
  const p = curPara();
  if (p === 0 && S.segIdx === 0 && !S.playing) { bkRenderSection(0, {}); return; }
  bkRenderSection(bkSectionOf(p), { para: p });
  bkFollow(true);
}

/** Keep the sentence being read on screen (called after each highlight). */
function bkFollow(force) {
  const seg = S.segs[S.segIdx]; if (!seg) return;
  const pi = seg[0];
  const sec = BK.sections[BK.sec];
  if (!sec || sec.front || pi < sec.start || pi >= sec.end) {
    if (!force && !(sec && sec.front) && Date.now() - BK.lastTurn < 8000) return;
    bkRenderSection(bkSectionOf(pi), { para: pi });
  }
  const el = $('#pages mark') || $(`#pages p[data-i="${pi}"]`);
  if (!el) return;
  const v = Math.max(0, Math.min(BK.views - 1, Math.floor((bkX(el) + 2) / BK.step)));
  if (v !== BK.view && (force || Date.now() - BK.lastTurn > 8000)) bkGo(v, { quiet: true });
  else bkLabels();
}

// ---------- page-turn controls ----------
function bkInit() {
  $('#turnNext').onclick = bkNext;
  $('#turnPrev').onclick = bkPrev;
  $('#bkListen').onclick = () => jumpTo(bkTopPara(), true);
  $('#pages').addEventListener('click', (e) => {
    const t = e.target.closest('.toc-item'); if (!t) return;
    e.stopPropagation(); BK.lastTurn = 0; jumpTo(+t.dataset.p, false);
  });
  $('#pageFrame').addEventListener('click', (e) => {
    if (String(window.getSelection() || '').trim()) return;
    const r = $('#pageFrame').getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x > 0.88) bkNext(); else if (x < 0.12) bkPrev();
  });
  let wheelAcc = 0; let wheelLock = 0;
  $('#bookWrap').addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Date.now() < wheelLock) return;
    wheelAcc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(wheelAcc) > 60) { wheelAcc > 0 ? bkNext() : bkPrev(); wheelAcc = 0; wheelLock = Date.now() + 350; }
  }, { passive: false });
  let resizeT = null;
  window.addEventListener('resize', () => {
    if (!bookMode() || S.view !== 'reader' || BK.sec < 0) return;
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const anchor = S.playing ? curPara() : bkTopPara();
      bkLayout(); bkGo(bkViewOfPara(anchor), { animate: false, quiet: true });
      if (S.playing) bkFollow(true);
    }, 150);
  });
  // full screen / focus
  const setFocus = (on) => {
    document.body.classList.toggle('focus', on); $('#focusExit').hidden = !on;
    if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
  };
  $('#focusBtn').onclick = () => setFocus(true);
  $('#focusExit').onclick = () => setFocus(false);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('focus')) setFocus(false); });
  window.bkSetFocus = setFocus;
}
