'use strict';
/* Shelf Reader · Audiobook maker
   Drop a book → pick a voice (Kokoro / Piper in the browser, or a premium voice with your own key) → export
   MP3 (ID3 chapters), M4B (AAC + chapters) or WAV, as one file or one per chapter, downloaded or saved to a folder. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RATE = 24000;
const WPM = 155;

const M = {
  book: null,               // { title, author, cover: {mime, data, url}, chapters: [{title, paras, on}] }
  eng: 'kokoro',
  voice: null,              // { eng, id, label, ... }
  making: false,
  cancel: false,
  samples: new Map(),
  piper: { catalog: null, stored: [] },
  cloudVoices: {}
};

// ---------- settings ----------
const PREF_KEY = 'shelf-maker';
let PREF = {};
try { PREF = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (_) {}
function savePref() { try { localStorage.setItem(PREF_KEY, JSON.stringify(PREF)); } catch (_) {} }

function toast(msg, ms = 4500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${sec} s`;
};
const fmtMB = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const safeName = (s) => String(s || 'Audiobook').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Audiobook';

// =====================================================================
// 1. Reading books
// =====================================================================
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dt,dd,figcaption,td,th';
const HEADING_RE = /^(chapter|book|part|prologue|epilogue|introduction|preface|foreword|afterword|appendix|interlude)\b[^\n]{0,70}$/i;
const ROMAN_RE = /^(?=[IVXLC])[IVXLC]{1,7}\.?$/;
const clean = (s) => s.replace(/­/g, '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();

function blockParas(root) {
  root.querySelectorAll('script,style,noscript,svg,math').forEach((e) => e.remove());
  // footnote reference links: drop them (they'd be read as stray numbers)
  root.querySelectorAll('a[epub\\:type~="noteref"],a[role="doc-noteref"],sup > a[href*="#"]').forEach((a) => {
    const s = a.closest('sup') || a; s.remove();
  });
  root.querySelectorAll('sup').forEach((s) => { if (/^\s*\[?(\d{1,3}|[*†‡])\]?\s*$/.test(s.textContent)) s.remove(); });
  const out = [];
  const els = [...root.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
  if (!els.length) {
    for (const line of (root.textContent || '').split(/\n\s*\n|\r\n\s*\r\n/)) { const t = clean(line); if (t) out.push({ t, h: false }); }
    return out;
  }
  for (const el of els) {
    const t = clean(el.textContent || '');
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ t, h: /^H[1-3]$/.test(el.tagName) });
  }
  return out;
}

const parseXML = (s) => new DOMParser().parseFromString(s, 'application/xml');
const parseHTML = (s) => new DOMParser().parseFromString(s, 'text/html');
const resolve = (base, href) => {
  const parts = (base ? base + '/' : '').concat(href.split('#')[0]).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
};
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const byLocal = (doc, name) => [...doc.getElementsByTagName('*')].filter((e) => e.localName === name);

async function fromEpub(buf) {
  const z = Formats.readZip(buf);
  const container = await z.text('META-INF/container.xml');
  const opfPath = container && /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error('This EPUB is missing its package file.');
  const opf = parseXML(await z.text(opfPath));
  const base = dirOf(opfPath);
  const title = byLocal(opf, 'title')[0]?.textContent.trim() || '';
  const author = byLocal(opf, 'creator').map((e) => e.textContent.trim()).filter(Boolean).join(', ');
  const manifest = new Map();
  for (const it of byLocal(opf, 'item')) manifest.set(it.getAttribute('id'), { href: resolve(base, it.getAttribute('href') || ''), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
  // cover
  let coverItem = [...manifest.values()].find((m) => /cover-image/.test(m.props));
  if (!coverItem) { const id = byLocal(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content'); if (id) coverItem = manifest.get(id); }
  if (!coverItem) coverItem = [...manifest.values()].find((m) => /^image\/(jpeg|png)/.test(m.type) && /cover/i.test(m.href));
  let cover = null;
  if (coverItem && /^image\/(jpeg|png)/.test(coverItem.type)) {
    const data = await z.get(coverItem.href);
    if (data) cover = { mime: coverItem.type, data: new Uint8Array(data) };
  }
  // table of contents → titles per file
  const tocTitles = new Map();
  const nav = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  if (nav) {
    const doc = parseHTML(await z.text(nav.href) || '');
    const tocNav = [...doc.querySelectorAll('nav')].find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttribute('role') || '')) || doc.querySelector('nav');
    for (const a of tocNav ? tocNav.querySelectorAll('a[href]') : []) {
      const f = resolve(dirOf(nav.href), a.getAttribute('href'));
      const t = clean(a.textContent || '');
      if (t && !tocTitles.has(f)) tocTitles.set(f, t);
    }
  }
  if (!tocTitles.size) {
    const tocId = byLocal(opf, 'spine')[0]?.getAttribute('toc');
    const ncx = (tocId && manifest.get(tocId)) || [...manifest.values()].find((m) => /ncx/.test(m.type));
    if (ncx) {
      const doc = parseXML(await z.text(ncx.href) || '<x/>');
      for (const np of byLocal(doc, 'navPoint')) {
        const label = byLocal(np, 'text')[0]?.textContent; const src = byLocal(np, 'content')[0]?.getAttribute('src');
        if (label && src) { const f = resolve(dirOf(ncx.href), src); if (!tocTitles.has(f)) tocTitles.set(f, clean(label)); }
      }
    }
  }
  const chapters = [];
  for (const ref of byLocal(opf, 'itemref')) {
    const m = manifest.get(ref.getAttribute('idref'));
    if (!m || !/html|xml/.test(m.type)) continue;
    if (/\bnav\b/.test(m.props)) continue;
    const html = await z.text(m.href);
    if (!html) continue;
    const doc = parseHTML(html);
    const paras = blockParas(doc.body || doc.documentElement);
    if (!paras.length) continue;
    const tocT = tocTitles.get(m.href);
    const head = paras.find((p) => p.h)?.t;
    if (!tocT && !head && chapters.length && tocTitles.size) { chapters[chapters.length - 1].paras.push(...paras.map((p) => p.t)); continue; }
    chapters.push({ title: tocT || head || `Part ${chapters.length + 1}`, paras: paras.map((p) => p.t) });
  }
  return { title, author, cover, chapters };
}

async function fromDocx(buf) {
  const z = Formats.readZip(buf);
  const xml = await z.text('word/document.xml');
  if (!xml) throw new Error("This Word file doesn't have any text in it.");
  const doc = parseXML(xml);
  const chapters = []; let cur = null;
  for (const p of byLocal(doc, 'p')) {
    let t = '';
    for (const n of p.getElementsByTagName('*')) {
      if (n.localName === 't') t += n.textContent; else if (n.localName === 'tab' || n.localName === 'br') t += ' ';
    }
    t = clean(t); if (!t) continue;
    const style = byLocal(p, 'pStyle')[0]?.getAttribute('w:val') || '';
    const isHead = /^(heading ?1|title|heading ?2)$/i.test(style) || (HEADING_RE.test(t) && t.length < 80);
    if (isHead || !cur) { cur = { title: isHead ? t : 'Beginning', paras: [] }; chapters.push(cur); }
    cur.paras.push(t);
  }
  const core = await z.text('docProps/core.xml');
  const cd = core ? parseXML(core) : null;
  return { title: cd ? byLocal(cd, 'title')[0]?.textContent || '' : '', author: cd ? byLocal(cd, 'creator')[0]?.textContent || '' : '', cover: null, chapters };
}

function fromText(text, markdown) {
  text = text.replace(/\r\n?/g, '\n');
  if (markdown) {
    text = text.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^>\s?/gm, '').replace(/[*_`~]{1,3}([^*_`~\n]+)[*_`~]{1,3}/g, '$1').replace(/^\s*[-*+]\s+/gm, '').replace(/^-{3,}$/gm, '');
  }
  const blank = (text.match(/\n\s*\n/g) || []).length;
  const lines = text.split('\n').length;
  const blocks = (blank > lines / 40 ? text.split(/\n\s*\n/) : text.split('\n')).map((b) => b.trim()).filter(Boolean);
  const chapters = []; let cur = null; let title = '';
  // a short first line with no sentence ending is usually the title
  if (!markdown && blocks.length > 2 && blocks[0].length < 70 && !blocks[0].includes('\n') && !/[.!?,;:]$/.test(blocks[0]) && !HEADING_RE.test(blocks[0])) title = clean(blocks.shift());
  for (const b0 of blocks) {
    let b = b0; let isHead = false;
    const md = markdown && /^(#{1,2})\s+(.+)$/m.exec(b);
    if (md && b.split('\n').length === 1) { b = md[2]; isHead = true; if (md[1] === '#' && !title && !chapters.length) { title = b; continue; } }
    else if (markdown && /^#{3,6}\s+/.test(b)) b = b.replace(/^#+\s+/, '');
    else if (!b.includes('\n') && b.length < 80 && (HEADING_RE.test(b) || ROMAN_RE.test(b))) isHead = true;
    b = clean(b);
    if (isHead) { cur = { title: b, paras: [b] }; chapters.push(cur); continue; }
    if (!cur) { cur = { title: 'Beginning', paras: [] }; chapters.push(cur); }
    cur.paras.push(b);
  }
  return { title, author: '', cover: null, chapters: chapters.filter((c) => c.paras.length) };
}

function fromHtml(text) {
  const doc = parseHTML(text);
  const title = clean(doc.querySelector('title')?.textContent || doc.querySelector('h1')?.textContent || '');
  const chapters = []; let cur = null;
  const root = doc.querySelector('article, main') || doc.body;
  for (const p of blockParas(root)) {
    if (p.h || !cur) { cur = { title: p.h ? p.t : 'Beginning', paras: [] }; chapters.push(cur); }
    cur.paras.push(p.t);
  }
  return { title, author: clean(doc.querySelector('meta[name=author]')?.getAttribute('content') || ''), cover: null, chapters };
}

async function fromPdf(buf) {
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const meta = await pdf.getMetadata().catch(() => ({}));
  const pageParas = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const lines = []; let line = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform[5]; const h = Math.abs(it.transform[3]) || 10;
      if (!line || Math.abs(y - line.y) > h * 0.5) { line = { y, h, t: '' }; lines.push(line); }
      line.t += it.str + (it.hasEOL ? '' : '');
    }
    const gaps = []; for (let i = 1; i < lines.length; i++) { const g = lines[i - 1].y - lines[i].y; if (g > 0) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    const typical = gaps[Math.floor(gaps.length / 2)] || 14;
    const paras = []; let cur = '';
    lines.forEach((l, i) => {
      const t = l.t.trim(); if (!t) return;
      const gap = i ? lines[i - 1].y - l.y : 0;
      if (cur && (gap > typical * 1.45 || gap < 0)) { paras.push(cur); cur = ''; }
      cur = cur ? (cur.endsWith('-') ? cur.slice(0, -1) + t : cur + ' ' + t) : t;
    });
    if (cur) paras.push(cur);
    pageParas.push(paras.map(clean).filter((p) => p && !/^\d{1,4}$/.test(p)));
    page.cleanup();
  }
  // chapters: from the outline if there is one
  let starts = [];
  try {
    const outline = await pdf.getOutline();
    for (const o of outline || []) {
      let dest = o.dest; if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (Array.isArray(dest)) { const idx = await pdf.getPageIndex(dest[0]); starts.push({ page: idx, title: clean(o.title) }); }
    }
  } catch (_) { starts = []; }
  starts = starts.filter((s, i, a) => s.title && (i === 0 || s.page > a[i - 1].page));
  if (starts.length >= 2) {
    const chapters = [];
    if (starts[0].page > 0) starts.unshift({ page: 0, title: 'Beginning' });
    starts.forEach((s, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].page : pageParas.length;
      chapters.push({ title: s.title, paras: pageParas.slice(s.page, end).flat() });
    });
    return { title: clean(meta?.info?.Title || ''), author: clean(meta?.info?.Author || ''), cover: null, chapters: chapters.filter((c) => c.paras.length) };
  }
  const r = fromText(pageParas.map((p) => p.join('\n\n')).join('\n\n'), false);
  if (r.chapters.length <= 1 && pageParas.length > 30) {
    r.chapters = [];
    for (let i = 0; i < pageParas.length; i += 20) r.chapters.push({ title: `Pages ${i + 1}–${Math.min(pageParas.length, i + 20)}`, paras: pageParas.slice(i, i + 20).flat() });
  }
  return { title: clean(meta?.info?.Title || ''), author: clean(meta?.info?.Author || ''), cover: null, chapters: r.chapters.filter((c) => c.paras.length) };
}

async function openFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  toast(`Reading “${file.name}”…`, 60000);
  try {
    const buf = await file.arrayBuffer();
    let b;
    if (ext === 'epub') b = await fromEpub(buf);
    else if (ext === 'docx') b = await fromDocx(buf);
    else if (ext === 'pdf') b = await fromPdf(buf);
    else if (/^(html?|xhtml)$/.test(ext)) b = fromHtml(new TextDecoder().decode(buf));
    else if (/^(md|markdown)$/.test(ext)) b = fromText(new TextDecoder().decode(buf), true);
    else if (ext === 'txt' || file.type.startsWith('text/')) b = fromText(new TextDecoder().decode(buf), false);
    else throw new Error('That file type isn\'t supported. Try EPUB, PDF, DOCX, TXT, Markdown or HTML.');
    if (!b.chapters.length) throw new Error(ext === 'pdf' ? 'No text was found. This PDF might be scanned pictures of pages.' : 'No text was found in this file.');
    if (!b.title) b.title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    setBook(b);
    toast(`Loaded “${b.title}”: ${b.chapters.length} chapter${b.chapters.length === 1 ? '' : 's'}.`);
  } catch (e) {
    console.error(e);
    toast('Couldn\'t read that file: ' + e.message, 8000);
  }
}

/** Books with no real chapter list get one from their headings (Roman numerals, PART ONE, …). */
function improveBookChapters(b) {
  const flat = []; const starts = [];
  for (const c of b.chapters) { starts.push({ para: flat.length, title: c.title }); flat.push(...c.paras); }
  const better = SpeechText.improveChapters(flat, starts);
  const changed = better.length !== starts.length || better.some((c, i) => c.para !== starts[i].para);
  if (!changed || better.length < 2) { b.chapters.forEach((c, i) => { c.title = (better[i] && better[i].para === starts[i].para ? better[i].title : SpeechText.titleCase(c.title)); }); return; }
  const out = [];
  if (better[0].para > 0) out.push({ title: 'Beginning', paras: flat.slice(0, better[0].para) });
  better.forEach((c, i) => out.push({ title: c.title, level: c.level, paras: flat.slice(c.para, i + 1 < better.length ? better[i + 1].para : flat.length) }));
  b.chapters = out.filter((c) => c.paras.length);
}
function setBook(b) {
  // lines broken mid-sentence (scanned books, PDFs) become whole paragraphs before anything is read
  if (!$('#fixLines') || $('#fixLines').checked) for (const c of b.chapters) c.paras = SpeechText.mendParagraphs(c.paras);
  improveBookChapters(b);
  M.headers = SpeechText.headerLines(b.chapters.flatMap((c) => c.paras), b.title, b.author);
  for (const c of b.chapters) { c.on = true; c.chars = c.paras.reduce((a, p) => a + p.length + 1, 0); }
  if (b.cover?.data) b.cover.url = URL.createObjectURL(new Blob([b.cover.data], { type: b.cover.mime }));
  M.book = b;
  $('#bTitle').value = b.title; $('#bAuthor').value = b.author || '';
  $('#bookInfo').hidden = false; $('#drop').hidden = true; $('.or').hidden = true; $('#pasteBox').hidden = true;
  drawCover(); drawChapters();
  const first = b.chapters.flatMap((c) => c.paras).find((p) => p.length > 80) || b.chapters[0].paras[0] || '';
  const sentences = first.match(/[^.!?…]+[.!?…]+["”’)]*\s*/g) || [first];
  let s = ''; for (const x of sentences) { if ((s + x).length > 260 && s) break; s += x; }
  $('#sampleText').value = s.trim().slice(0, 400);
  M.samples.clear();
  analyzeBook();
  renderCast();
  updateSummary();
}

function drawCover() {
  $('#coverCredit').textContent = M.book.cover?.credit ? 'Cover art: ' + M.book.cover.credit : '';
  const el = $('#cover');
  if (M.book.cover?.url) { el.style.backgroundImage = `url("${M.book.cover.url}")`; el.textContent = ''; }
  else { el.style.backgroundImage = ''; el.textContent = M.book.title; }
}

function drawChapters() {
  const list = $('#chapters');
  list.innerHTML = M.book.chapters.map((c, i) => `
    <li data-i="${i}" class="${c.on ? '' : 'off'}">
      <input type="checkbox" ${c.on ? 'checked' : ''} aria-label="Include">
      <span class="st" title=""></span>
      <input type="text" value="${esc(c.title)}" aria-label="Chapter title">
      <span class="len">${fmtDur(c.chars / 5 / WPM * 60 / effSpeed())}</span>
    </li>`).join('');
  list.querySelectorAll('li').forEach((li) => {
    const c = M.book.chapters[+li.dataset.i];
    li.querySelector('input[type=checkbox]').onchange = (e) => { c.on = e.target.checked; li.classList.toggle('off', !c.on); updateSummary(); };
    li.querySelector('input[type=text]').onchange = (e) => { c.title = e.target.value.trim() || c.title; };
  });
  const words = M.book.chapters.reduce((a, c) => a + c.chars, 0) / 5;
  $('#chCount').textContent = `${M.book.chapters.length} · about ${Math.round(words).toLocaleString()} words`;
}

function chapterStatus(i, mark, title) {
  const li = $(`#chapters li[data-i="${i}"] .st`); if (li) { li.textContent = mark; li.title = title || ''; }
}

// drag & drop anywhere on the page
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
addEventListener('dragover', (e) => { e.preventDefault(); });
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0]; if (!f) return;
  if (/^image\/(jpeg|png)$/.test(f.type) && M.book) { setCoverFile(f); return; }
  if (M.making) { toast('Wait until this audiobook is finished, or press Stop.'); return; }
  openFile(f);
});
$('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); };
$('#drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } };
$('#pasteBtn').onclick = () => { $('#pasteBox').hidden = false; $('#pasteText').focus(); };
$('#pasteCancel').onclick = () => { $('#pasteBox').hidden = true; };
$('#pasteUse').onclick = () => {
  const t = $('#pasteText').value.trim(); if (!t) return;
  const b = fromText(t, false); if (!b.chapters.length) return;
  b.title = b.title || 'My audiobook'; setBook(b);
};
$('#otherBook').onclick = () => { if (M.making) return; $('#bookInfo').hidden = true; $('#drop').hidden = false; $('.or').hidden = false; M.book = null; $('#results').innerHTML = ''; updateSummary(); };
$('#coverBtn').onclick = () => $('#coverFile').click();
$('#coverFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) setCoverFile(f); };
async function setCoverFile(f) {
  if (typeof cvFromFile === 'function') return cvFromFile(f);
  M.book.cover = { mime: f.type === 'image/png' ? 'image/png' : 'image/jpeg', data: new Uint8Array(await f.arrayBuffer()) };
  M.book.cover.url = URL.createObjectURL(f); drawCover();
}
$('#bTitle').oninput = (e) => { if (M.book) { M.book.title = e.target.value; if (!M.book.cover?.url) drawCover(); } };
$('#bAuthor').oninput = (e) => { if (M.book) M.book.author = e.target.value; };
$('#chAll').onclick = () => { M.book?.chapters.forEach((c) => { c.on = true; }); if (M.book) { drawChapters(); updateSummary(); } };
$('#chNone').onclick = () => { M.book?.chapters.forEach((c) => { c.on = false; }); if (M.book) { drawChapters(); updateSummary(); } };
