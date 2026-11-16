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

// =====================================================================
// 2. Voices
// =====================================================================
const KOKORO_VOICES = [
  ['af_heart', 'Heart', 'American', 'Female', 1], ['af_bella', 'Bella', 'American', 'Female', 1], ['af_nicole', 'Nicole', 'American', 'Female · soft', 1],
  ['am_michael', 'Michael', 'American', 'Male', 1], ['am_fenrir', 'Fenrir', 'American', 'Male', 0], ['am_puck', 'Puck', 'American', 'Male', 0],
  ['bf_emma', 'Emma', 'British', 'Female', 1], ['bm_george', 'George', 'British', 'Male', 1], ['bm_fable', 'Fable', 'British', 'Male', 0],
  ['af_aoede', 'Aoede', 'American', 'Female', 0], ['af_kore', 'Kore', 'American', 'Female', 0], ['af_sarah', 'Sarah', 'American', 'Female', 0],
  ['af_nova', 'Nova', 'American', 'Female', 0], ['af_alloy', 'Alloy', 'American', 'Female', 0], ['af_sky', 'Sky', 'American', 'Female', 0],
  ['am_echo', 'Echo', 'American', 'Male', 0], ['am_eric', 'Eric', 'American', 'Male', 0], ['am_liam', 'Liam', 'American', 'Male', 0],
  ['bf_isabella', 'Isabella', 'British', 'Female', 0], ['bf_alice', 'Alice', 'British', 'Female', 0], ['bf_lily', 'Lily', 'British', 'Female', 0],
  ['bm_lewis', 'Lewis', 'British', 'Male', 0], ['bm_daniel', 'Daniel', 'British', 'Male', 0]
];
const PIPER_GENDER = {
  amy: 'Female', lessac: 'Female', ryan: 'Male', joe: 'Male', kristin: 'Female', kathleen: 'Female', danny: 'Male', ljspeech: 'Female',
  hfc_female: 'Female', hfc_male: 'Male', kusal: 'Male', alan: 'Male', alba: 'Female', cori: 'Female', jenny_dioco: 'Female',
  northern_english_male: 'Male', southern_english_female: 'Female', norman: 'Male', john: 'Male', bryce: 'Male', sam: 'Male'
};
const OPENAI_VOICES = [['marin', 'Female', 1], ['cedar', 'Male', 1], ['alloy', 'Neutral'], ['ash', 'Male'], ['ballad', 'Male'], ['coral', 'Female'], ['echo', 'Male'],
  ['fable', 'Male · British'], ['nova', 'Female'], ['onyx', 'Male · deep'], ['sage', 'Female'], ['shimmer', 'Female'], ['verse', 'Male']];
const CLOUD = {
  openai: { name: 'OpenAI', link: 'https://platform.openai.com/api-keys', max: 3500 },
  elevenlabs: { name: 'ElevenLabs', link: 'https://elevenlabs.io/app/settings/api-keys', max: 2500 },
  azure: { name: 'Microsoft Azure', link: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices', max: 3000 },
  google: { name: 'Google Cloud', link: 'https://console.cloud.google.com/apis/library/texttospeech.googleapis.com', max: 3000 }
};
const ENG_NOTES = {
  kokoro: 'The most natural free voices, in English. They run on this device: the first time, the voice model downloads once. ★ marks the best voices.',
  piper: 'Clear, fast voices in more than 30 languages. They also run on this device, and each voice downloads once (20–110 MB).',
  cloud: 'Studio-quality voices from OpenAI, ElevenLabs, Microsoft or Google, using your own account. They need an internet connection and are billed by the service.'
};

const speed = () => +$('#speed').value;

/** Narrator style presets: pace, pauses, and how premium voices perform. */
const STYLES = {
  natural: { name: 'Natural', note: 'Clear, warm storytelling.', speed: 1, para: 1, chap: 1, scene: 1, dlg: 1,
    openai: 'Read like a skilled audiobook narrator: natural, warm and clear, with gentle variation in pace and tone.', el: { stability: 0.5, style: 0.15 }, azure: 'narration-professional', pitch: 0 },
  bedtime: { name: 'Cozy bedtime', note: 'Slower and softer, with relaxed pauses.', speed: 0.92, para: 1.35, chap: 1.4, scene: 1.3, dlg: 1.15,
    openai: 'Read softly and soothingly, like a bedtime story: unhurried, warm and gentle, with relaxed pauses.', el: { stability: 0.75, style: 0.05 }, azure: 'narration-relaxed', pitch: -1.5 },
  thriller: { name: 'Suspense / thriller', note: 'Tighter pace, tense delivery, quick dialogue, long pauses at scene breaks.', speed: 1.04, para: 0.85, chap: 1.1, scene: 1.6, dlg: 0.7,
    openai: 'Read with quiet intensity and suspense: tight pacing, tension in the voice, and a dramatic beat before reveals.', el: { stability: 0.35, style: 0.45 }, azure: 'narration-professional', pitch: -0.5 },
  nonfiction: { name: 'Nonfiction / lecture', note: 'Even, confident and articulate.', speed: 1, para: 1.1, chap: 1.25, scene: 1, dlg: 1,
    openai: 'Read like a clear, confident nonfiction narrator: measured and articulate, engaged, lightly emphasizing key ideas.', el: { stability: 0.65, style: 0.1 }, azure: 'narration-professional', pitch: 0 },
  children: { name: "Children's story", note: 'Bright and expressive, a little slower.', speed: 0.94, para: 1.2, chap: 1.3, scene: 1.2, dlg: 1,
    openai: "Read like a lively children's storyteller: bright, expressive and playful, with clear words and fun character voices.", el: { stability: 0.3, style: 0.6 }, azure: 'cheerful', pitch: 1 },
  dramatic: { name: 'Dramatic / epic', note: 'Rich and theatrical, with weighty pauses.', speed: 0.97, para: 1.2, chap: 1.5, scene: 1.8, dlg: 1,
    openai: 'Read like a dramatic narrator of an epic tale: rich and resonant, with bold emotion and weighty pauses.', el: { stability: 0.3, style: 0.55 }, azure: 'narration-professional', pitch: -1 }
};
const style = () => STYLES[$('#readStyle')?.value] || STYLES.natural;
/** The speed actually sent to the voice: your setting × the style's pace. */
const effSpeed = () => speed() * style().speed;

// ----- Kokoro worker -----
const K = { worker: null, ready: false, loading: null, pending: new Map(), next: 1, gen: 0 };
function kokoroLoad() {
  if (K.ready) return Promise.resolve();
  if (K.loading) return K.loading;
  const mode = $('#kokoroMode').value;
  const [dtype, device] = mode.split('-');
  K.worker = new Worker('tts-worker.js', { type: 'module' });
  K.loading = new Promise((res, rej) => {
    const files = {};
    K.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        if (m.p.file && m.p.total) { files[m.p.file] = [m.p.loaded || 0, m.p.total]; }
        const t = Object.values(files).reduce((a, [l, tt]) => [a[0] + l, a[1] + tt], [0, 0]);
        if (t[1] > 1e6) $('#kokoroStatus').textContent = `Downloading the voice model… ${fmtMB(t[0])} of ${fmtMB(t[1])}`;
      } else if (m.type === 'ready') { K.ready = true; $('#kokoroStatus').textContent = 'Voice model ready ✓'; res(); }
      else if (m.type === 'loaderror') { rej(new Error(m.error)); }
      else if (m.type === 'audio') {
        const p = K.pending.get(m.id); if (!p) return; K.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
      }
    };
  });
  $('#kokoroStatus').textContent = 'Starting the voice model…';
  K.worker.postMessage({ type: 'load', dtype, device });
  K.loading.catch((e) => {
    K.loading = null; K.worker?.terminate(); K.worker = null;
    if (device === 'webgpu') { $('#kokoroMode').value = 'q8-wasm'; $('#kokoroStatus').textContent = 'Your graphics card couldn\'t be used, so the compatible engine is selected. Try again.'; }
    else $('#kokoroStatus').textContent = 'The voice model failed to load: ' + e.message;
  });
  return K.loading;
}
$('#kokoroMode').onchange = () => {
  PREF.kokoroMode = $('#kokoroMode').value; savePref();
  if (K.worker) { K.worker.terminate(); K.worker = null; K.ready = false; K.loading = null; $('#kokoroStatus').textContent = ''; }
};
async function kokoroSynth(voice, text, sp) {
  await kokoroLoad();
  const id = K.next++;
  const r = await new Promise((resolve, reject) => { K.pending.set(id, { resolve, reject }); K.worker.postMessage({ type: 'gen', id, gen: K.gen, text, voice, speed: sp }); });
  return r.rate === RATE ? r.data : resample(r.data, r.rate, RATE);
}

// ----- Piper worker -----
const P = { worker: null, pending: new Map(), next: 1, onProgress: null };
function piperCall(msg) {
  if (!P.worker) {
    P.worker = new Worker('piper-worker.js', { type: 'module' });
    P.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { if (P.onProgress) P.onProgress(m.voiceId, m.p); return; }
      const p = P.pending.get(m.id); if (!p) return; P.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
    };
  }
  const id = P.next++;
  return new Promise((resolve, reject) => { P.pending.set(id, { resolve, reject }); P.worker.postMessage({ ...msg, id }); });
}
async function piperCatalog() {
  if (!M.piper.catalog) {
    const mod = await import('./vendor/piper.web.js');
    M.piper.catalog = Object.values(mod.VOICES).filter((v) => v.num_speakers === 1);
    try { M.piper.stored = (await piperCall({ type: 'stored' })).list || []; } catch (_) { M.piper.stored = []; }
  }
  return M.piper.catalog;
}
const piperSize = (v) => Object.entries(v.files || {}).filter(([k]) => k.endsWith('.onnx')).reduce((a, [, f]) => a + (f.size_bytes || 0), 0);
async function piperSynth(voiceId, text) {
  if (!M.piper.stored.includes(voiceId)) {
    P.onProgress = (vid, p) => { if (vid === voiceId && p.total) setVoiceBusyText(`Downloading voice… ${Math.round((p.loaded / p.total) * 100)}%`); };
    await piperCall({ type: 'download', voiceId });
    M.piper.stored.push(voiceId);
  }
  const r = await piperCall({ type: 'gen', gen: 0, voiceId, text });
  return decodeTo(r.wav);
}

// ----- premium cloud voices (straight from the browser to the provider) -----
function cloudCfg(p) { return (PREF.cloud && PREF.cloud[p]) || M.cloudSession?.[p] || {}; }
async function req(url, opts = {}) {
  let r;
  try { r = await fetch(url, opts); } catch (e) { throw new Error('Couldn\'t reach the service. Check your connection.'); }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || (j.detail && (j.detail.message || j.detail)) || j.message || msg; if (typeof msg !== 'string') msg = JSON.stringify(msg).slice(0, 200); } catch (_) {}
    if (r.status === 401 || r.status === 403) msg = 'The API key was rejected: ' + msg;
    if (r.status === 429) msg = 'The service says you\'ve hit a rate or quota limit: ' + msg;
    throw new Error(msg);
  }
  return r;
}
async function cloudVoices(p) {
  const c = cloudCfg(p);
  if (p === 'openai') return OPENAI_VOICES.map(([id, g, best]) => ({ id, name: id[0].toUpperCase() + id.slice(1), tags: g, best }));
  if (p === 'elevenlabs') {
    const j = await (await req('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': c.key } })).json();
    return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, tags: [v.labels?.gender, v.labels?.accent, v.labels?.description || v.labels?.descriptive].filter(Boolean).join(' · '), sample: v.preview_url }));
  }
  if (p === 'azure') {
    const j = await (await req(`https://${c.region || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': c.key } })).json();
    const lang = (navigator.language || 'en').split('-')[0];
    return j.filter((v) => v.Locale.startsWith(lang + '-') || v.Locale.startsWith('en-')).sort((a, b) => (/Dragon|HD/.test(b.ShortName) - /Dragon|HD/.test(a.ShortName)) || a.ShortName.localeCompare(b.ShortName))
      .map((v) => ({ id: v.ShortName, name: v.DisplayName || v.LocalName, tags: `${v.LocaleName || v.Locale} · ${v.Gender}`, best: /Dragon|HD/.test(v.ShortName) }));
  }
  if (p === 'google') {
    const j = await (await req('https://texttospeech.googleapis.com/v1/voices?key=' + encodeURIComponent(c.key))).json();
    const rank = (n) => (/Chirp3-HD/.test(n) ? 0 : /Studio/.test(n) ? 1 : /Neural2/.test(n) ? 2 : /Wavenet/.test(n) ? 3 : 4);
    const lang = (navigator.language || 'en').split('-')[0];
    return (j.voices || []).filter((v) => rank(v.name) < 4 && (v.languageCodes || []).some((l) => l.startsWith(lang) || l.startsWith('en')))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
      .map((v) => ({ id: v.name, name: v.name.split('-').slice(2).join(' '), tags: `${(v.languageCodes || [])[0]} · ${(v.ssmlGender || '').toLowerCase()}`, best: rank(v.name) === 0 }));
  }
  return [];
}
const xmlEsc = (s) => s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
async function cloudSynth(p, voice, text, sp, ctx = {}) {
  const c = cloudCfg(p);
  if (!c.key) throw new Error(`Add your ${CLOUD[p].name} key first.`);
  let buf;
  if (p === 'openai') {
    const body = { model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3', speed: Math.max(0.25, Math.min(4, sp)) };
    body.instructions = openaiInstructions(ctx);
    buf = await (await req('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).arrayBuffer();
  } else if (p === 'elevenlabs') {
    buf = await (await req(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': c.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text, model_id: 'eleven_multilingual_v2',
        // the text just before and after helps the voice carry on in the same tone
        ...(ctx.prev ? { previous_text: ctx.prev } : {}), ...(ctx.next ? { next_text: ctx.next } : {}),
        voice_settings: { stability: style().el.stability, similarity_boost: 0.75, style: style().el.style, use_speaker_boost: true, speed: Math.max(0.7, Math.min(1.2, sp)) }
      })
    })).arrayBuffer();
  } else if (p === 'azure') {
    const lang = voice.split('-').slice(0, 2).join('-'); const pct = Math.round((sp - 1) * 100);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${xmlEsc(voice)}"><mstts:express-as style="${style().azure}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${xmlEsc(text)}</prosody></mstts:express-as></voice></speak>`;
    buf = await (await req(`https://${c.region || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': c.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3' }, body: ssml
    })).arrayBuffer();
  } else if (p === 'google') {
    const lang = voice.split('-').slice(0, 2).join('-');
    const j = await (await req('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(c.key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: lang, name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: Math.max(0.25, Math.min(2, sp)), sampleRateHertz: RATE, ...(/Chirp/.test(voice) ? {} : { pitch: style().pitch }) } })
    })).json();
    buf = Uint8Array.from(atob(j.audioContent || ''), (ch) => ch.charCodeAt(0)).buffer;
  }
  return decodeTo(buf);
}

/** OpenAI voices take acting directions: the style, who is speaking, and how the book says the line is delivered. */
function openaiInstructions(ctx) {
  const extra = $('#openaiStyle').value.trim();
  let t = extra || style().openai;
  if (ctx.who && ctx.who !== '*') {
    const desc = (M.cast.desc || {})[ctx.who];
    t += ` This line is dialogue spoken by the character ${ctx.who}${desc ? ` (${desc})` : ''}; perform it in character.`;
  } else if (ctx.who === '*') t += ' This line is dialogue; perform it as a character, not as the narrator.';
  if (ctx.around) t += ` The book describes how it is said: "${ctx.around.slice(0, 140)}". Match that delivery.`;
  if (ctx.prev && !ctx.who) t += ` (For context only, the previous line was: "${ctx.prev.slice(-160)}")`;
  return t;
}

// ----- audio helpers -----
async function decodeTo(buf) {
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const ab = await ctx.decodeAudioData(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (ab.numberOfChannels === 1) return ab.getChannelData(0).slice();
  const a = ab.getChannelData(0), b = ab.getChannelData(1); const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}
function resample(data, from, to) {
  if (from === to) return data;
  const n = Math.round(data.length * to / from); const out = new Float32Array(n); const r = from / to;
  for (let i = 0; i < n; i++) { const x = i * r; const j = Math.floor(x); const f = x - j; out[i] = (data[j] || 0) * (1 - f) + (data[j + 1] ?? data[j] ?? 0) * f; }
  return out;
}
/** Trims long silence at the ends of a clip so pauses stay even. */
function trim(pcm) {
  const th = 0.004; let a = 0, b = pcm.length;
  while (a < b && Math.abs(pcm[a]) < th) a++;
  while (b > a && Math.abs(pcm[b - 1]) < th) b--;
  a = Math.max(0, a - 480); b = Math.min(pcm.length, b + 960);
  return pcm.subarray(a, b);
}

/** One entry point: text → Float32 mono samples at RATE */
async function synth(v, text, sp, ctx) {
  if (v.eng === 'kokoro') return kokoroSynth(v.id, text, Math.max(0.5, Math.min(2, sp)));
  if (v.eng === 'piper') return piperSynth(v.id, text);
  if (v.eng === 'cloud') return cloudSynth(v.provider, v.id, text, sp, ctx || {});
  throw new Error('Pick a voice first.');
}
const speedSupported = (v) => v && v.eng !== 'piper';

// ----- voice list UI -----
function setEngine(eng) {
  M.eng = eng; PREF.eng = eng; savePref();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.eng === eng));
  $('#kokoroOpts').hidden = eng !== 'kokoro'; $('#piperOpts').hidden = eng !== 'piper'; $('#cloudOpts').hidden = eng !== 'cloud';
  $('#engNote').textContent = ENG_NOTES[eng];
  drawVoices();
}
$$('.tab').forEach((t) => { t.onclick = () => setEngine(t.dataset.eng); });

const gOf = (t) => (/\bfemale\b|\bwoman\b|^f$/i.test(t || '') ? 'f' : /\bmale\b|\bman\b|^m$/i.test(t || '') ? 'm' : '');
/** The voices of one engine, as objects { eng, id, name, tags, best, gender, provider? }. Piper: the given language. */
async function voiceList(eng, lang, bestOnly = true) {
  if (eng === 'kokoro') return KOKORO_VOICES.map(([id, name, accent, g, best]) => ({ eng: 'kokoro', id, name, tags: `${accent} · ${g}`, best: !!best, gender: gOf(g.split(' ')[0]) }));
  if (eng === 'piper') {
    const cat = await piperCatalog();
    const order = { high: 0, medium: 1, low: 2, x_low: 3 };
    let vs = cat.filter((v) => v.language.code === lang);
    if (bestOnly) {
      const best = new Map();
      for (const v of vs) { const b = best.get(v.name); if (!b || order[v.quality] < order[b.quality]) best.set(v.name, v); }
      vs = [...best.values()];
    }
    vs.sort((a, b) => order[a.quality] - order[b.quality] || a.name.localeCompare(b.name));
    return vs.map((v) => ({
      eng: 'piper', id: v.key, name: v.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      tags: [PIPER_GENDER[v.name], { x_low: 'basic', low: 'good', medium: 'better', high: 'best' }[v.quality], M.piper.stored.includes(v.key) ? 'downloaded ✓' : fmtMB(piperSize(v))].filter(Boolean).join(' · '),
      best: v.quality === 'high', gender: gOf(PIPER_GENDER[v.name])
    }));
  }
  if (eng.startsWith('cloud:')) {
    const p = eng.slice(6);
    return (M.cloudVoices[p] || []).map((v) => ({ eng: 'cloud', provider: p, id: v.id, name: v.name, tags: v.tags, best: v.best, preview: v.sample, gender: gOf(String(v.tags || '').split(' · ').find((x) => /male|female/i.test(x)) || '') }));
  }
  return [];
}
const engKey = (v) => (v.eng === 'cloud' ? 'cloud:' + v.provider : v.eng);
const piperLangOf = (v) => (v && v.eng === 'piper' ? v.id.split('-')[0] : $('#piperLang').value);

async function drawVoices() {
  const box = $('#voices');
  let list = [];
  if (M.eng === 'piper') {
    box.innerHTML = '<div class="empty">Loading the voice list…</div>';
    let cat;
    try { cat = await piperCatalog(); } catch (e) { box.innerHTML = `<div class="empty">Couldn't load Piper voices: ${esc(e.message)}</div>`; return; }
    const langs = new Map();
    for (const v of cat) langs.set(v.language.code, `${v.language.name_english} (${v.language.country_english})`);
    const sel = $('#piperLang');
    if (!sel.options.length) {
      sel.innerHTML = [...langs.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('');
      const want = PREF.piperLang || (navigator.language || 'en-US').replace('-', '_');
      sel.value = langs.has(want) ? want : [...langs.keys()].find((k) => k.startsWith(want.split('_')[0])) || 'en_US';
    }
    list = await voiceList('piper', sel.value, $('#piperBestOnly').checked);
  } else if (M.eng === 'cloud') {
    const p = $('#cloudProv').value;
    if (!M.cloudVoices[p]) { box.innerHTML = `<div class="empty">Paste your ${esc(CLOUD[p].name)} API key above and press <b>Load voices</b>.</div>`; return; }
    list = await voiceList('cloud:' + p);
  } else list = await voiceList('kokoro');
  if (!list.length) { box.innerHTML = '<div class="empty">No voices here.</div>'; return; }
  box.innerHTML = list.map((v, i) => `
    <div class="voice ${M.voice && M.voice.eng === v.eng && M.voice.id === v.id ? 'sel' : ''}" data-i="${i}" role="button" tabindex="0">
      <button class="play" title="Hear a sample" aria-label="Play sample">▶</button>
      <div class="vi"><div class="vn">${esc(v.name)}${v.best ? ' <span class="star">★</span>' : ''}</div><div class="vt">${esc(v.tags || '')}</div></div>
    </div>`).join('');
  box.querySelectorAll('.voice').forEach((el) => {
    const v = list[+el.dataset.i];
    el.onclick = (e) => { if (e.target.closest('.play')) return; chooseVoice(v); };
    el.onkeydown = (e) => { if (e.key === 'Enter') chooseVoice(v); };
    el.querySelector('.play').onclick = () => playSample(v, el.querySelector('.play'));
  });
}
$('#piperLang').onchange = () => { PREF.piperLang = $('#piperLang').value; savePref(); drawVoices(); };
$('#piperBestOnly').onchange = () => drawVoices();

function chooseVoice(v) {
  M.voice = v; PREF.voice = v; savePref();
  $$('.voice').forEach((el) => el.classList.remove('sel'));
  const box = $('#voices');
  const idx = [...box.querySelectorAll('.voice')].findIndex((el) => el.querySelector('.vn').textContent.replace(' ★', '') === v.name);
  if (idx >= 0) box.querySelectorAll('.voice')[idx].classList.add('sel');
  showChosen(); updateSummary();
  if (M.book && dlgMode() !== 'one') renderCast();
}
function showChosen() {
  const v = M.voice;
  const eng = v ? (v.eng === 'cloud' ? CLOUD[v.provider].name : v.eng === 'kokoro' ? 'Kokoro' : 'Piper') : '';
  $('#voiceChosen').innerHTML = v ? `Voice: <b>${esc(v.name)}</b> · ${esc(eng)}${!speedSupported(v) && speed() !== 1 ? ' · Piper voices read at their own pace, so the speed setting doesn\'t apply.' : ''}` : 'Tap a voice to choose it. Use ▶ to hear it first.';
}

let busyBtn = null;
function setVoiceBusyText(t) { if (busyBtn) busyBtn.title = t; $('#voiceChosen').textContent = t; }
async function playSample(v, btn) {
  const player = $('#player');
  if (btn.classList.contains('on')) { player.pause(); return; }
  const text = ($('#sampleText').value.trim() || 'Hello! This is how I would sound reading your book.').slice(0, 500);
  const key = [v.eng, v.provider, v.id, text, effSpeed(), $('#readStyle').value].join('|');
  $$('.voice .play').forEach((b) => b.classList.remove('on'));
  let url = M.samples.get(key);
  if (!url) {
    if (v.eng === 'cloud' && v.preview && !$('#sampleText').value.trim()) url = v.preview;
    else {
      btn.classList.add('busy'); btn.textContent = '…'; busyBtn = btn;
      if (v.eng === 'kokoro' && !K.ready) setVoiceBusyText('Getting Kokoro ready. The first time, it downloads once…');
      try {
        const pcm = await synth(v, text, effSpeed());
        url = URL.createObjectURL(new Blob([Formats.wav(pcm, RATE)], { type: 'audio/wav' }));
        M.samples.set(key, url);
      } catch (e) {
        toast('Couldn\'t make a sample: ' + e.message, 8000);
        return;
      } finally {
        btn.classList.remove('busy'); btn.textContent = '▶'; busyBtn = null; showChosen();
        if (v.eng === 'piper') drawVoicesSoon();
      }
    }
  }
  player.src = url;
  player.onended = player.onpause = () => { btn.classList.remove('on'); btn.textContent = '▶'; };
  try { await player.play(); btn.classList.add('on'); btn.textContent = '❚❚'; } catch (_) {}
  if (!M.voice) chooseVoice(v);
}
let redrawT = 0;
function drawVoicesSoon() { clearTimeout(redrawT); redrawT = setTimeout(drawVoices, 50); }

$('#speed').oninput = () => {
  $('#speedVal').textContent = speed().toFixed(2).replace(/0$/, '') + '×';
  PREF.speed = speed(); savePref(); showChosen();
  if (M.book) { drawChapters(); updateSummary(); }
};

// cloud settings
function cloudUI() {
  const p = $('#cloudProv').value; const c = cloudCfg(p);
  $('#cloudKey').value = c.key || ''; $('#cloudRegion').value = c.region || '';
  $('#azureRegionF').hidden = p !== 'azure';
  $('#openaiStyleF').hidden = p !== 'openai';
  $('#cloudGetKey').href = CLOUD[p].link; $('#cloudGetKey').textContent = `Get a ${CLOUD[p].name} key`;
  $('#cloudRemember').checked = !!(PREF.cloud && PREF.cloud[p]);
  drawVoices();
}
$('#cloudProv').onchange = () => { PREF.cloudProv = $('#cloudProv').value; savePref(); cloudUI(); };
function storeCloud() {
  const p = $('#cloudProv').value;
  const c = { key: $('#cloudKey').value.trim(), region: $('#cloudRegion').value.trim() };
  M.cloudSession = M.cloudSession || {}; M.cloudSession[p] = c;
  PREF.cloud = PREF.cloud || {};
  if ($('#cloudRemember').checked) PREF.cloud[p] = c; else delete PREF.cloud[p];
  savePref();
}
$('#cloudRemember').onchange = storeCloud;
$('#cloudLoad').onclick = async () => {
  storeCloud();
  const p = $('#cloudProv').value;
  if (!cloudCfg(p).key) { toast('Paste your API key first.'); return; }
  $('#voices').innerHTML = '<div class="empty">Loading voices…</div>';
  try { M.cloudVoices[p] = await cloudVoices(p); }
  catch (e) { $('#voices').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  drawVoices();
};
$('#openaiStyle').onchange = () => { PREF.openaiStyle = $('#openaiStyle').value; savePref(); M.samples.clear(); };

// ---------- dialogue: a voice for quotes, or one per character ----------
M.dlg = null;                       // result of Dialogue.analyzeDialogue
M.cast = { quote: null, chars: {}, gender: {} };   // voice objects; 'narr' = the narrator's voice
let castShowAll = false;
const dlgMode = () => $('#dlgMode').value;
const castKey = () => 'cast:' + (M.book ? M.book.title : '');

function analyzeBook() {
  try { M.dlg = Dialogue.analyzeDialogue(M.book); } catch (e) { console.error(e); M.dlg = null; }
  const saved = (PREF.casts || {})[castKey()];
  M.cast = saved ? { quote: saved.quote || null, chars: saved.chars || {}, gender: saved.gender || {}, desc: saved.desc || {} } : { quote: null, chars: {}, gender: {}, desc: {} };
  castShowAll = false;
}
function saveCast() {
  PREF.casts = PREF.casts || {};
  PREF.casts[castKey()] = M.cast;
  const keys = Object.keys(PREF.casts); if (keys.length > 20) delete PREF.casts[keys[0]];
  savePref();
}
const shownCharacters = () => {
  if (!M.dlg) return [];
  const all = M.dlg.characters;
  const main = all.filter((c) => c.lines >= 2 || all.length <= 6).slice(0, 16);
  return castShowAll ? all.slice(0, 60) : main;
};
const sameVoice = (a, b) => a && b && a !== 'narr' && b !== 'narr' && a.eng === b.eng && a.id === b.id && a.provider === b.provider;

/** Picks voices: different from the narrator, matching each character's likely gender, best voices first. */
async function autoCast(force) {
  const n = M.voice; if (!n) return;
  let pool;
  try { pool = (await voiceList(engKey(n), piperLangOf(n))).filter((v) => !sameVoice(v, n)); } catch (_) { pool = []; }
  if (!pool.length) return;
  pool.sort((a, b) => (b.best ? 1 : 0) - (a.best ? 1 : 0));
  const valid = (v) => v === 'narr' || pool.some((p) => sameVoice(p, v)) || (v && v.eng === n.eng);
  const used = [];
  const take = (g) => {
    const opts = pool.filter((v) => (!g || v.gender === g) && !used.some((u) => sameVoice(u, v)));
    const v = opts[0] || pool.filter((x) => !g || x.gender === g)[used.length % Math.max(1, pool.filter((x) => !g || x.gender === g).length)] || pool[used.length % pool.length];
    used.push(v); return v;
  };
  if (force || !M.cast.quote || !valid(M.cast.quote)) {
    const other = n.gender === 'm' ? 'f' : n.gender === 'f' ? 'm' : '';
    M.cast.quote = take(other);
  } else used.push(M.cast.quote);
  for (const c of (M.dlg ? M.dlg.characters.slice(0, 60) : [])) {
    const cur = M.cast.chars[c.name];
    if (!force && cur && valid(cur)) { if (cur !== 'narr') used.push(cur); continue; }
    M.cast.chars[c.name] = take(M.cast.gender[c.name] ?? c.gender);
  }
  saveCast();
}

async function renderCast() {
  const mode = dlgMode();
  PREF.dlgMode = mode; savePref();
  const info = $('#dlgInfo');
  if (!M.book) { info.textContent = 'Add a book to find its characters.'; $('#castPanel').hidden = true; return; }
  const d = M.dlg;
  if (!d || !d.quotes) { info.textContent = 'No quoted speech was found in this book.'; $('#castPanel').hidden = true; return; }
  const named = d.characters.length;
  info.textContent = `${d.quotes.toLocaleString()} quoted lines · ${named} character${named === 1 ? '' : 's'} found · ${Math.round((d.attributed / Math.max(1, d.quotes)) * 100)}% of lines matched to a speaker`;
  if (mode === 'one') { $('#castPanel').hidden = true; updateSummary(); return; }
  $('#castPanel').hidden = false;
  if (!M.voice) { $('#castRows').innerHTML = '<div class="empty">Choose the narrator\'s voice above first.</div>'; return; }
  await autoCast(false);
  let pool = [];
  try { pool = await voiceList(engKey(M.voice), piperLangOf(M.voice)); } catch (_) {}
  const opt = (sel) => `<option value="narr" ${sel === 'narr' ? 'selected' : ''}>Narrator's voice</option>` +
    pool.map((v, i) => `<option value="${i}" ${sel && sel !== 'narr' && sameVoice(sel, v) ? 'selected' : ''}>${esc(v.name)}${v.best ? ' ★' : ''} · ${esc(v.tags || '')}</option>`).join('');
  const gSel = (name, g) => `<select class="cg" data-n="${esc(name)}" title="Man or woman (used when picking voices)"><option value="" ${!g ? 'selected' : ''}>?</option><option value="f" ${g === 'f' ? 'selected' : ''}>♀</option><option value="m" ${g === 'm' ? 'selected' : ''}>♂</option></select>`;
  const rows = [];
  const openaiCast = M.voice.eng === 'cloud' && M.voice.provider === 'openai';
  rows.push(`<div class="crow fixed"><div class="cn">Narrator<span>everything outside quotes</span></div><div></div><div class="small">${esc(M.voice.name)}</div><button class="play" data-k="__narr">▶</button></div>`);
  if (mode === 'quotes') {
    rows.push(`<div class="crow"><div class="cn">Quoted speech<span>${d.quotes.toLocaleString()} lines</span></div><div></div><select class="cv" data-k="__quote">${opt(M.cast.quote)}</select><button class="play" data-k="__quote">▶</button></div>`);
  } else {
    for (const c of shownCharacters()) {
      const g = M.cast.gender[c.name] ?? c.gender;
      const desc = openaiCast ? `<input class="cdesc" data-n="${esc(c.name)}" value="${esc((M.cast.desc || {})[c.name] || '')}" placeholder="Describe ${esc(c.name)} for the voice actor, e.g. gruff old fisherman, nervous teenager">` : '';
      rows.push(`<div class="crow"><div class="cn" title="${esc(c.name)}">${esc(c.name)}<span>${c.lines} line${c.lines === 1 ? '' : 's'}</span></div>${gSel(c.name, g)}<select class="cv" data-k="${esc(c.name)}">${opt(M.cast.chars[c.name])}</select><button class="play" data-k="${esc(c.name)}">▶</button>${desc}</div>`);
    }
    const hidden = d.characters.length - shownCharacters().length;
    const others = d.unknown + d.characters.filter((c) => !shownCharacters().includes(c)).reduce((a, c) => a + c.lines, 0);
    if (others > 0) rows.push(`<div class="crow"><div class="cn">Everyone else<span>${others.toLocaleString()} lines (unknown or minor speakers)</span></div><div></div><select class="cv" data-k="__quote">${opt(M.cast.quote)}</select><button class="play" data-k="__quote">▶</button></div>`);
    $('#castMore').hidden = hidden <= 0 && !castShowAll;
    $('#castMore').textContent = castShowAll ? 'Show main characters only' : `Show ${hidden} more minor character${hidden === 1 ? '' : 's'}`;
  }
  if (mode === 'quotes') $('#castMore').hidden = true;
  $('#castRows').innerHTML = rows.join('');
  $('#castNote').textContent = mode === 'cast'
    ? 'Speakers are found from lines like “…,” said Mara and from who is talking back and forth, so a few lines may go to the wrong person. Lines nobody could be matched to use the “Everyone else” voice.' + (M.voice.eng === 'piper' ? ' Piper loads each voice separately, so books with many voices take a bit longer.' : '')
    : 'Everything inside quotation marks is read by this voice. The narrator reads the rest, including “she said”.';
  $('#castRows').querySelectorAll('select.cv').forEach((sel) => {
    sel.onchange = () => {
      const k = sel.dataset.k; const val = sel.value === 'narr' ? 'narr' : pool[+sel.value];
      if (k === '__quote') M.cast.quote = val; else M.cast.chars[k] = val;
      saveCast(); updateSummary();
    };
  });
  $('#castRows').querySelectorAll('input.cdesc').forEach((inp) => { inp.onchange = () => { M.cast.desc = M.cast.desc || {}; M.cast.desc[inp.dataset.n] = inp.value.trim(); saveCast(); }; });
  $('#castRows').querySelectorAll('select.cg').forEach((sel) => { sel.onchange = () => { M.cast.gender[sel.dataset.n] = sel.value; saveCast(); }; });
  $('#castRows').querySelectorAll('button.play').forEach((b) => { b.onclick = () => playCastSample(b.dataset.k, b); });
  updateSummary();
}
$('#dlgMode').onchange = () => renderCast();
$('#castAuto').onclick = async () => { await autoCast(true); renderCast(); };
$('#castMore').onclick = () => { castShowAll = !castShowAll; renderCast(); };

/** The voice for a chunk's speaker key: null = narrator, '*' = other speech, or a character's name. */
function voiceFor(who) {
  const n = M.voice; const mode = dlgMode();
  if (who === null || mode === 'one' || !M.dlg) return n;
  const pick = (v) => (!v || v === 'narr' ? n : v);
  if (mode === 'quotes') return pick(M.cast.quote);
  const shown = shownCharacters();
  if (who !== '*' && shown.some((c) => c.name === who)) return pick(M.cast.chars[who]);
  return pick(M.cast.quote);
}
function castVoiceCount() {
  if (!M.voice || dlgMode() === 'one' || !M.dlg || !M.dlg.quotes) return 1;
  const set = new Set([JSON.stringify([M.voice.eng, M.voice.id])]);
  const add = (v) => set.add(JSON.stringify(v && v !== 'narr' ? [v.eng, v.id] : [M.voice.eng, M.voice.id]));
  const others = M.dlg.unknown + M.dlg.characters.filter((c) => !shownCharacters().includes(c)).reduce((a, c) => a + c.lines, 0);
  if (dlgMode() === 'quotes' || others > 0) add(M.cast.quote);
  if (dlgMode() === 'cast') for (const c of shownCharacters()) add(M.cast.chars[c.name]);
  return set.size;
}

async function playCastSample(k, btn) {
  const player = $('#player');
  let v, text;
  if (k === '__narr') { v = M.voice; text = $('#sampleText').value.trim(); }
  else if (k === '__quote') { v = voiceFor('*'); text = M.dlg.unknownSample || M.dlg.characters[0]?.sample; }
  else { v = voiceFor(k); text = M.dlg.characters.find((c) => c.name === k)?.sample; }
  text = (text || 'Hello there. This is how I would sound.').trim();
  btn.classList.add('busy'); btn.textContent = '…';
  try {
    const pcm = await synth(v, text, effSpeed(), { who: k === "__narr" ? null : k === "__quote" ? "*" : k });
    player.src = URL.createObjectURL(new Blob([Formats.wav(polish(pcm), RATE)], { type: 'audio/wav' }));
    await player.play();
  } catch (e) { toast('Couldn\'t play that: ' + e.message, 7000); }
  finally { btn.classList.remove('busy'); btn.textContent = '▶'; }
}

/** The stretch of the book with the most back-and-forth, for "Hear a conversation". */
function liveliestScene() {
  let best = null;
  M.book.chapters.forEach((c, ci) => {
    if (!c.segs) return;
    for (let i = 0; i < c.segs.length; i++) {
      const who = new Set(); let q = 0; let len = 0; let j = i;
      for (; j < c.segs.length && len < 1100; j++) {
        for (const s of c.segs[j]) { if (s.who !== null) { who.add(s.who); q++; } len += s.t.length; }
      }
      const score = who.size * 10 + q - (who.has('*') ? 5 : 0);
      if (!best || score > best.score) best = { score, ci, from: i, to: j };
    }
  });
  if (!best) return null;
  const c = M.book.chapters[best.ci];
  return { ...c, title: c.title, paras: c.paras.slice(best.from, best.to), segs: c.segs.slice(best.from, best.to), i: best.ci, on: true };
}
$('#convoBtn').onclick = () => {
  const scene = liveliestScene();
  if (!scene) { toast('No conversation was found.'); return; }
  make({ preview: true, scene });
};

// ---------- sound: even loudness, room tone, chapter music ----------
const TARGET_RMS = 0.075;   // about -22 dBFS of speech, a common audiobook level
function polish(pcm) {
  if (!$('#normalize').checked) return pcm;
  let sum = 0, n = 0;
  for (let i = 0; i < pcm.length; i++) { const x = pcm[i]; if (x > 0.01 || x < -0.01) { sum += x * x; n++; } }
  if (n < 200) return pcm;
  const g = Math.max(0.3, Math.min(4, TARGET_RMS / Math.sqrt(sum / n)));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let y = pcm[i] * g;
    if (y > 0.85) y = 0.85 + 0.15 * Math.tanh((y - 0.85) / 0.15); else if (y < -0.85) y = -0.85 - 0.15 * Math.tanh((-y - 0.85) / 0.15);
    out[i] = y;
  }
  return out;
}
/** Very quiet pink noise mixed under everything, so pauses aren't digital silence. */
function makeRoomTone() {
  let b0 = 0, b1 = 0, b2 = 0;
  return (pcm) => {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = pcm[i] + (b0 + b1 + b2 + w * 0.1848) * 0.0006;
    }
    return out;
  };
}
const stingCache = new Map();
/** A short original music cue for chapter breaks, made with a few synthesized notes. */
async function makeSting(kind) {
  if (kind === 'none') return null;
  if (stingCache.has(kind)) return stingCache.get(kind);
  const dur = kind === 'pad' ? 4.2 : 3.4;
  const ctx = new OfflineAudioContext(1, Math.round(dur * RATE), RATE);
  const master = ctx.createGain(); master.gain.value = 0.22; master.connect(ctx.destination);
  const note = (f, t, len, type, peak, attack) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + len + 0.05);
  };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  if (kind === 'chime') {
    [72, 76, 79, 84].forEach((m, i) => { note(hz(m), 0.05 + i * 0.32, 2.6, 'sine', 0.5, 0.01); note(hz(m) * 2.76, 0.05 + i * 0.32, 0.8, 'sine', 0.08, 0.005); });
  } else if (kind === 'piano') {
    [[60, 0], [67, 0.45], [64, 0.9], [72, 1.35]].forEach(([m, t]) => { note(hz(m), 0.05 + t, 2.2, 'triangle', 0.5, 0.008); note(hz(m) * 2, 0.05 + t, 1.2, 'sine', 0.12, 0.008); });
  } else {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(master);
    for (const m of [48, 55, 60, 64, 67]) for (const det of [-6, 6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = det;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.05, 1.4); g.gain.setValueAtTime(0.05, 2.4); g.gain.linearRampToValueAtTime(0, dur - 0.05);
      o.connect(g); g.connect(lp); o.start(0); o.stop(dur);
    }
  }
  const buf = await ctx.startRendering();
  const pcm = buf.getChannelData(0).slice();
  stingCache.set(kind, pcm);
  return pcm;
}
$('#stingPlay').onclick = async () => {
  const k = $('#sting').value; if (k === 'none') { toast('Pick a music cue first.'); return; }
  const pcm = await makeSting(k);
  const p = $('#player'); p.src = URL.createObjectURL(new Blob([Formats.wav(pcm, RATE)], { type: 'audio/wav' })); p.play().catch(() => {});
};

// ---------- pronunciations ----------
const pronList = () => PREF.fixes || [];
function pronRules() {
  return pronList().filter((f) => f.from).map((f) => [new RegExp('(?<![\\p{L}\\p{N}])' + f.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu'), f.to || '']);
}
function drawPron() {
  const l = pronList();
  $('#pronCount').textContent = l.length ? `(${l.length})` : '';
  $('#pronRows').innerHTML = l.map((f, i) => `<div class="prow"><span><b>${esc(f.from)}</b> → ${esc(f.to || '(skip)')}</span><button class="icon" data-pt="${i}" title="Hear it">▶</button><button class="icon" data-pd="${i}" title="Remove">✕</button></div>`).join('');
  $('#pronRows').querySelectorAll('[data-pd]').forEach((b) => { b.onclick = () => { const x = pronList().slice(); x.splice(+b.dataset.pd, 1); PREF.fixes = x; savePref(); drawPron(); M.samples.clear(); }; });
  $('#pronRows').querySelectorAll('[data-pt]').forEach((b) => { b.onclick = () => pronTest(pronList()[+b.dataset.pt].to || pronList()[+b.dataset.pt].from, b); });
}
async function pronTest(word, btn) {
  if (!M.voice) { toast('Choose a voice first.'); return; }
  btn.textContent = '…';
  try {
    const pcm = await synth(M.voice, `${word}. I said, ${word}.`, effSpeed());
    const p = $('#player'); p.src = URL.createObjectURL(new Blob([Formats.wav(pcm, RATE)], { type: 'audio/wav' })); await p.play();
  } catch (e) { toast('Couldn\'t play that: ' + e.message); } finally { btn.textContent = '▶'; }
}
$('#pronAdd').onclick = () => {
  const from = $('#pronFrom').value.trim(); if (!from) return;
  PREF.fixes = [...pronList().filter((f) => f.from.toLowerCase() !== from.toLowerCase()), { from, to: $('#pronTo').value.trim() }];
  savePref(); $('#pronFrom').value = ''; $('#pronTo').value = ''; drawPron(); M.samples.clear();
};
$('#pronTest').onclick = (e) => { const w = $('#pronTo').value.trim() || $('#pronFrom').value.trim(); if (w) pronTest(w, e.target); };
$('#pronImport').onclick = () => $('#pronFile').click();
$('#pronFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const incoming = (j.fixes || (j.settings && j.settings.fixes) || []).filter((x) => x && x.from);
    const have = new Set(pronList().map((x) => x.from.toLowerCase()));
    const added = incoming.filter((x) => !have.has(x.from.toLowerCase())).map((x) => ({ from: x.from, to: x.to || '' }));
    PREF.fixes = [...pronList(), ...added]; savePref(); drawPron(); M.samples.clear();
    toast(added.length ? `Added ${added.length} pronunciation${added.length === 1 ? '' : 's'}.` : 'No new pronunciations in that file.');
  } catch (_) { toast('That file couldn\'t be read. Choose ShelfReader-sync.json from your sync folder.'); }
};
$('#pronExport').onclick = () => download(new Blob([JSON.stringify({ fixes: pronList() }, null, 2)], { type: 'application/json' }), 'ShelfReader-pronunciations.json');
drawPron();
['#natural', '#numbers', '#fixLines'].forEach((x) => { $(x).onchange = () => { PREF[x.slice(1)] = $(x).checked; savePref(); M.samples.clear(); }; });
if (typeof PREF.natural === 'boolean') $('#natural').checked = PREF.natural;
if (typeof PREF.numbers === 'boolean') $('#numbers').checked = PREF.numbers;
if (typeof PREF.fixLines === 'boolean') $('#fixLines').checked = PREF.fixLines;

// =====================================================================
// 3. Export options
// =====================================================================
let aacOK = null;
async function checkAac() {
  if (aacOK !== null) return aacOK;
  aacOK = false;
  if (typeof AudioEncoder === 'undefined') return false;
  for (const sampleRate of [RATE, 48000]) {
    try {
      const s = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 1, bitrate: 64000 });
      if (s.supported) { aacOK = sampleRate; break; }
    } catch (_) {}
  }
  return aacOK;
}
const fmt = () => $('input[name=fmt]:checked').value;
function syncExportUI() {
  const f = fmt();
  $('#split').disabled = f === 'wav'; if (f === 'wav') $('#split').value = 'chapters';
  $('#kbps').disabled = f === 'wav';
  PREF.fmt = f; PREF.split = $('#split').value; PREF.kbps = $('#kbps').value; savePref();
  updateSummary();
}
$$('input[name=fmt]').forEach((r) => { r.onchange = syncExportUI; });
['#split', '#kbps', '#chapPause', '#paraPause'].forEach((s) => { $(s).onchange = () => { PREF[s.slice(1)] = $(s).value; savePref(); syncExportUI(); }; });
['#intro', '#announce', '#skipRefs', '#tags'].forEach((s) => { $(s).onchange = () => { PREF[s.slice(1)] = $(s).checked; savePref(); updateSummary(); }; });
$$('input[name=dest]').forEach((r) => { r.onchange = () => { PREF.dest = r.value; savePref(); }; });
if (!('showDirectoryPicker' in window)) { $('#destFolderL').hidden = true; }

function selectedChapters() { return M.book ? M.book.chapters.map((c, i) => ({ ...c, i })).filter((c) => c.on) : []; }
function updateSummary() {
  const ok = !!(M.book && M.voice && selectedChapters().length);
  $('#makeBtn').disabled = !ok || M.making; $('#previewBtn').disabled = !ok || M.making;
  if (!M.book) { $('#summary').textContent = 'Add a book to get started.'; return; }
  const ch = selectedChapters();
  const chars = ch.reduce((a, c) => a + c.chars, 0);
  const sp = speedSupported(M.voice) ? effSpeed() : 1;
  const secs = chars / 5 / WPM * 60 / sp;
  const f = fmt(); const one = $('#split').value === 'one' && f !== 'wav';
  const bytes = f === 'wav' ? secs * RATE * 2 : secs * (+$('#kbps').value) * 125;
  const files = one ? 1 : ch.length;
  const label = { m4b: 'M4B', mp3: 'MP3', wav: 'WAV' }[f];
  let s = `<b>${ch.length}</b> of ${M.book.chapters.length} chapters · about <b>${fmtDur(secs)}</b> of audio · <b>${files}</b> ${label} file${files === 1 ? '' : 's'} · roughly ${fmtMB(bytes)}`;
  if (M.voice && castVoiceCount() > 1) s += ` · <b>${castVoiceCount()}</b> voices`;
  if (!M.voice) s += ' · <span>choose a voice in step 2</span>';
  else if (M.voice.eng === 'cloud') s += ` · ${chars.toLocaleString()} characters will be sent to ${esc(CLOUD[M.voice.provider].name)} (check their pricing)`;
  else if (M.voice.eng === 'kokoro') s += ' · Kokoro takes roughly as long as the audio on a laptop, much less with the Fast engine';
  $('#summary').innerHTML = s;
}

// =====================================================================
// 4. Making the audiobook
// =====================================================================
const vkey = (who) => { const v = voiceFor(who); return v ? `${v.eng}|${v.provider || ''}|${v.id}` : ''; };
/** Puts back sentences that were split after an initial ("A. Writer", "J. R. Smith"). */
function joinInitials(list) {
  const out = [];
  for (const x of list) { const prev = out[out.length - 1]; if (prev && /(^|\s)[A-Z]\.\s*$/.test(prev) && !/\b[AP] M\.\s*$/.test(prev)) out[out.length - 1] += x; else out.push(x); }
  return out;
}
const SCENE_BREAK = /^[\s*#~•·◆◇◊⁂§=_+—–-]{1,24}$/;
/**
 * Splits a chapter into chunks small enough for the voice. Each chunk knows who speaks it, how long to pause
 * after it (paragraph ends, scene breaks, "…" and cut-off "—" lines, quick back-and-forth dialogue), and the
 * text around it (used by premium voices to keep the tone flowing).
 * P = { para, scene } base pause lengths in seconds (already scaled by the style).
 */
function textChunks(c, max, skipRefs, skipFirst, P = { para: 0.4, scene: 1.6 }) {
  const out = [];
  const st = style();
  const multi = dlgMode() !== 'one' && c.segs && M.dlg && M.dlg.quotes;
  const segsOf = (i) => (c.segs && c.segs[i]) || [{ t: c.paras[i], who: null }];
  const isQuickLine = (i) => {
    if (i < 0 || i >= c.paras.length || !c.segs || !c.segs[i]) return false;
    const sg = c.segs[i];
    return c.paras[i].length < 140 && sg.some((x) => x.who !== null) && sg.filter((x) => x.who === null).reduce((a, x) => a + x.t.trim().length, 0) < 40;
  };
  const furniture = M.headers || { has: () => false };
  c.paras.forEach((p0, i) => {
    if (skipFirst && i < skipFirst) return;
    if (skipRefs && (furniture.has(p0) || SpeechText.isPageNumber(p0))) return;
    if (SCENE_BREAK.test(p0) || /^\s*(\* ?){3}\s*$/.test(p0)) {
      if (out.length) out[out.length - 1].gap = Math.max(out[out.length - 1].gap, P.scene);
      return;
    }
    const segs = multi ? segsOf(i) : [{ t: p0, who: null }];
    const narration = segs.filter((x) => x.who === null).map((x) => x.t.trim()).join(' ').replace(/^[\s,;:—–-]+/, '');
    const groups = [];
    for (const sg of segs) {
      let t = sg.t;
      if (skipRefs) t = t.replace(/\[(\d{1,3}|[*†‡])\]/g, '').replace(/https?:\/\/\S+/g, '');
      for (const [re, to] of pronRules()) t = t.replace(re, to);
      if ($('#numbers').checked) t = SpeechText.normalize(t);
      t = t.replace(/\s{2,}/g, ' ').trim();
      if (sg.who === null && multi) t = t.replace(/^[\s,;:—–-]+/, '');
      if (!t || !/[\p{L}\p{N}]/u.test(t)) continue;
      const k = vkey(sg.who);
      const last = groups[groups.length - 1];
      if (last && last.k === k) last.t += ' ' + t; else groups.push({ k, who: sg.who, t });
    }
    // dialogue that bounces back and forth gets shorter gaps
    const quick = isQuickLine(i) && isQuickLine(i + 1);
    const paraGap = quick ? P.para * 0.55 * st.dlg : P.para;
    groups.forEach((g, gi) => {
      const sentences = joinInitials(g.t.match(/[^.!?…]+(?:[.!?…]+["”’»)\]]*|$)\s*/g) || [g.t]);
      // local voices: one piece per sentence and clause, with a pause that fits its punctuation
      if ($('#natural').checked && voiceFor(g.who).eng !== 'cloud') {
        const lastGroup = gi === groups.length - 1;
        const sp = Math.max(0.5, effSpeed());
        const parts = sentences.flatMap((x) => (x.length > max ? [{ t: x, gap: SpeechText.endPause(x) }] : SpeechText.pieces(x.trim())));
        parts.forEach((pc, k) => {
          const end = k === parts.length - 1;
          let gap = pc.gap / 1000 / sp;
          if (end) gap = lastGroup ? Math.max(paraGap, gap) : Math.max(0.24, gap);
          if (/[—–]["”’»]?$/.test(pc.t)) gap = Math.min(gap, 0.06);
          const ct = SpeechText.clean(pc.t);   // hidden or broken characters can make voices stall or fail
          if (SpeechText.hasWords(ct)) out.push({ t: ct, end: end && lastGroup, who: g.who, gap: SpeechText.vary(gap * 1000) / 1000, around: g.who !== null ? narration : '' });
        });
        return;
      }
      let cur = '';
      const push = (t, end) => {
        t = t.trim(); if (!t) return;
        const lastGroup = gi === groups.length - 1;
        let gap;
        if (end && lastGroup) gap = paraGap;
        else if (end) gap = 0.24;                       // the other speaker or the narrator comes next
        else gap = /[.!?…]["”’»)\]]*$/.test(t) ? 0.16 : 0.07;
        if (/(…|\.\.\.)["”’»]?$/.test(t)) gap += 0.3;   // trailing off…
        if (/[—–]["”’»]?$/.test(t)) gap = Math.min(gap, 0.06); // cut off mid-word—
        out.push({ t, end: end && lastGroup, who: g.who, gap, around: g.who !== null ? narration : '' });
      };
      for (let x of sentences) {
        while (x.length > max) {
          let cut = x.lastIndexOf(', ', max); if (cut < max * 0.4) cut = x.lastIndexOf(' ', max); if (cut < 1) cut = max;
          if (cur) { push(cur, false); cur = ''; }
          push(x.slice(0, cut + 1), false); x = x.slice(cut + 1);
        }
        if ((cur + x).length > max && cur) { push(cur, false); cur = ''; }
        cur += x;
      }
      push(cur, true);
    });
  });
  // context: the text just before and after each chunk
  out.forEach((ch, j) => {
    ch.prev = j > 0 ? out[j - 1].t.slice(-300) : '';
    ch.next = j + 1 < out.length ? out[j + 1].t.slice(0, 300) : '';
  });
  return out;
}
const maxChars = (v) => (v.eng === 'cloud' ? (CLOUD[v.provider] || { max: 2500 }).max : v.eng === 'piper' ? 1000 : 400);

/** Encoders: feed Float32 PCM at RATE, get a Blob at the end. */
let mp3Worker = null;
function mp3Call(msg, transfer) {
  if (!mp3Worker) mp3Worker = new Worker('mp3-worker.js');
  return new Promise((res, rej) => {
    mp3Worker.onmessage = (e) => (e.data.error ? rej(new Error(e.data.error)) : res(e.data));
    mp3Worker.postMessage(msg, transfer || []);
  });
}
async function makeEncoder(format, kbps) {
  let samples = 0;
  if (format === 'mp3') {
    await mp3Call({ type: 'start', rate: RATE, kbps });
    return {
      get samples() { return samples; },
      async add(pcm) { samples += pcm.length; const c = pcm.slice(); await mp3Call({ type: 'chunk', pcm: c }, [c.buffer]); },
      async finish(meta) {
        const { mp3 } = await mp3Call({ type: 'end' });
        return new Blob([meta ? Formats.id3(meta) : new Uint8Array(0), mp3], { type: 'audio/mpeg' });
      },
      abort() { mp3Worker?.terminate(); mp3Worker = null; }
    };
  }
  if (format === 'wav') {
    const parts = [];
    return {
      get samples() { return samples; },
      async add(pcm) { samples += pcm.length; parts.push(pcm.slice()); },
      async finish() {
        const all = new Float32Array(samples); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
        return new Blob([Formats.wav(all, RATE)], { type: 'audio/wav' });
      },
      abort() { parts.length = 0; }
    };
  }
  // m4b (AAC via WebCodecs)
  const encRate = await checkAac();
  if (!encRate) throw new Error('This browser can\'t make M4B files. Use Chrome, Edge or Safari, or pick MP3.');
  const frames = []; let asc = null; let err = null; let ts = 0;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); frames.push(b);
      if (meta?.decoderConfig?.description && !asc) asc = new Uint8Array(meta.decoderConfig.description instanceof ArrayBuffer ? meta.decoderConfig.description : meta.decoderConfig.description.buffer);
    },
    error: (e) => { err = e; }
  });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: encRate, numberOfChannels: 1, bitrate: kbps * 1000 });
  return {
    get samples() { return samples; },
    async add(pcm) {
      if (err) throw err;
      samples += pcm.length;
      const data = encRate === RATE ? pcm.slice() : resample(pcm, RATE, encRate);
      for (let i = 0; i < data.length; i += 48000) {
        const part = data.slice(i, i + 48000);
        enc.encode(new AudioData({ format: 'f32', sampleRate: encRate, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round(ts * 1e6 / encRate), data: part }));
        ts += part.length;
      }
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 10));
    },
    async finish(meta) {
      await enc.flush(); enc.close(); if (err) throw err;
      return Formats.muxM4B(frames, encRate, meta || {}, asc);
    },
    abort() { try { enc.close(); } catch (_) {} }
  };
}

const silence = (sec) => new Float32Array(Math.round(sec * RATE));

async function pickFolder() {
  try { return await window.showDirectoryPicker({ id: 'shelf-audiobooks', mode: 'readwrite', startIn: 'music' }); }
  catch (e) { if (e.name !== 'AbortError') toast('Couldn\'t use that folder: ' + e.message); return null; }
}
async function existsIn(dir, name) {
  try { const f = await (await dir.getFileHandle(name)).getFile(); return f.size > 1000; } catch (_) { return false; }
}
async function writeTo(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function addResult(name, blob, note) {
  const url = URL.createObjectURL(blob);
  const el = document.createElement('div'); el.className = 'result done';
  el.innerHTML = `<div class="rn">${esc(name)}<span>${fmtMB(blob.size)}${note ? ' · ' + esc(note) : ''}</span></div><audio controls preload="none" src="${url}"></audio><a href="${url}" download="${esc(name)}">Download</a>`;
  $('#results').appendChild(el);
}

async function make(o = {}) {
  if (M.making || !M.book || !M.voice) return;
  const preview = !!o.preview; const scene = o.scene || null;
  const v = M.voice; const b = M.book;
  const f = preview ? 'mp3' : fmt();
  const perChapter = !preview && (f === 'wav' || $('#split').value === 'chapters');
  const kbps = +$('#kbps').value;
  const st = style();
  const sp = speedSupported(v) ? effSpeed() : 1;
  const chPause = +$('#chapPause').value * st.chap, paraPause = +$('#paraPause').value * st.para;
  const scenePause = Math.max(1.2, chPause * 0.8) * st.scene;
  const opt = { intro: !scene && $('#intro').checked, announce: !scene && $('#announce').checked, skipRefs: $('#skipRefs').checked, tags: $('#tags').checked };
  const chapters = scene ? [scene] : preview ? selectedChapters().slice(0, 1) : selectedChapters();
  const ext = { m4b: 'm4b', mp3: 'mp3', wav: 'wav' }[f];
  const base = safeName(b.title);
  const width = String(chapters.length).length < 2 ? 2 : String(chapters.length).length;
  const nameFor = (c, k) => `${String(k + 1).padStart(width, '0')} ${safeName(c.title)}.${ext}`;

  let dir = null;
  if (!preview && $('input[name=dest]:checked').value === 'folder') {
    dir = await pickFolder(); if (!dir) return;
  }
  let skip = new Set();
  if (dir && perChapter) {
    const found = [];
    for (const [k, c] of chapters.entries()) if (await existsIn(dir, nameFor(c, k))) found.push(k);
    if (found.length && confirm(`${found.length} of these chapter files are already in that folder (from an earlier run). Skip them and make only the missing ones?`)) skip = new Set(found);
  }
  if (f === 'm4b' && !(await checkAac())) { toast('This browser can\'t make M4B files. Use Chrome, Edge or Safari, or pick MP3.', 8000); return; }

  M.making = true; M.cancel = false; updateSummary();
  $('#progress').hidden = false; $('#results').innerHTML = '';
  $('#makeBtn').textContent = 'Making…';
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch (_) {}
  const reWake = async () => { if (document.visibilityState === 'visible' && M.making) { try { wake = await navigator.wakeLock?.request('screen'); } catch (_) {} } };
  document.addEventListener('visibilitychange', reWake);

  // plan all the text first so progress and ETA are honest
  const max = Math.min(...[v, ...(dlgMode() === 'one' ? [] : [...Object.values(M.cast.chars), M.cast.quote])].filter((x) => x && x !== 'narr').map(maxChars));
  const plan = chapters.map((c, k) => {
    // the heading (and a subtitle line merged into the title) is announced instead of read
    let skipFirst = opt.announce && c.paras.length && SpeechText.isHeadingOf(c.paras[0], c.title) ? 1 : 0;
    if (skipFirst && c.paras[1] && c.paras[1].length < 70 && c.title.toLowerCase().endsWith(c.paras[1].trim().toLowerCase().replace(/[.:]$/, ''))) skipFirst = 2;
    let chunks = textChunks(c, max, opt.skipRefs, skipFirst, { para: paraPause, scene: scenePause });
    if (preview) { const lim = scene ? 1300 : 950; let n = 0; chunks = chunks.filter((x) => (n += x.t.length) < lim || n - x.t.length === 0); }
    return { c, k, chunks, chars: chunks.reduce((a, x) => a + x.t.length, 0) };
  });
  const totalChars = plan.reduce((a, p) => a + (skip.has(p.k) ? 0 : p.chars), 0) || 1;
  let doneChars = 0; const t0 = performance.now();
  const meta = (title, extra) => (opt.tags ? { title, artist: b.author, album: b.title, cover: b.cover?.data ? b.cover : null, comment: b.cover?.credit ? 'Cover art: ' + b.cover.credit : '', ...extra } : null);
  const tone = $('#roomTone').checked ? makeRoomTone() : null;
  const put = (pcm) => enc.add(tone ? tone(pcm) : pcm);
  const say = async (text) => { await put(polish(trim(await synth(v, text, sp)))); };
  const sting = preview ? null : await makeSting($('#sting').value).catch(() => null);
  const render = async (ch) => {
    const voice = voiceFor(ch.who);
    for (let attempt = 0; ; attempt++) {
      try { return polish(trim(await synth(voice, ch.t, sp, { who: ch.who, prev: ch.prev, next: ch.next, around: ch.around }))); }
      catch (e) {
        if (M.cancel) return null;
        if (attempt >= 2 || /key was rejected|quota/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  };
  const progress = (label) => {
    const frac = doneChars / totalChars;
    $('#barFill').style.width = (frac * 100).toFixed(1) + '%';
    $('#progText').textContent = label;
    const el = (performance.now() - t0) / 1000;
    $('#progEta').textContent = doneChars > 300 && el > 8 ? `about ${fmtDur(el / frac - el)} left` : 'working out the time left…';
  };

  const finished = [];
  let enc = null;
  try {
    const chapterMarks = [];
    if (!perChapter) enc = await makeEncoder(f, kbps);
    for (const p of plan) {
      if (M.cancel) break;
      if (skip.has(p.k)) { chapterStatus(p.c.i, '✓', 'Already in the folder'); continue; }
      chapterStatus(p.c.i, '⏳');
      if (perChapter) enc = await makeEncoder(f, kbps);
      else chapterMarks.push({ title: p.c.title, startMs: enc.samples / RATE * 1000 });
      if (opt.intro && p.k === 0) {
        await say(`${b.title}${b.author ? '. By ' + b.author : ''}.`); await put(silence(chPause));
      }
      if (sting) { await put(sting); await put(silence(0.5)); }
      if (opt.announce) {
        progress(`${p.c.title}: title`);
        const opening = $('#natural').checked ? SpeechText.chapterOpening(p.c.title.replace(/\s+/g, ' ')) : [{ t: p.c.title.replace(/\s+/g, ' ') + '.', gap: 1000 }];
        for (const [j, x] of opening.entries()) { await say(x.t); await put(silence(j === opening.length - 1 ? Math.min(1.2, chPause * 0.6) : x.gap / 1000)); }
      }
      // Piper loads one voice at a time, so with several voices it makes each voice's lines together, then puts them in order
      const label = (j) => `${p.c.title}: ${Math.round((j / Math.max(1, p.chunks.length)) * 100)}%`;
      let pre = null;
      if (p.chunks.some((ch) => voiceFor(ch.who).eng === 'piper') && new Set(p.chunks.map((ch) => vkey(ch.who))).size > 1) {
        pre = new Array(p.chunks.length);
        const order = p.chunks.map((ch, j) => j).sort((a, c) => vkey(p.chunks[a].who).localeCompare(vkey(p.chunks[c].who)) || a - c);
        for (const [n, j] of order.entries()) {
          if (M.cancel) break;
          progress(label(n));
          pre[j] = await render(p.chunks[j]);
          doneChars += p.chunks[j].t.length;
        }
      }
      for (const [j, ch] of p.chunks.entries()) {
        if (M.cancel) break;
        let pcm;
        if (pre) pcm = pre[j];
        else { progress(label(j)); pcm = await render(ch); doneChars += ch.t.length; }
        if (M.cancel || !pcm) break;
        await put(pcm);
        await put(silence(ch.gap));
      }
      if (M.cancel) break;
      await put(silence(chPause));
      if (perChapter) {
        const name = nameFor(p.c, p.k);
        const blob = await enc.finish(meta(p.c.title, { track: `${p.k + 1}/${plan.length}` }));
        enc = null;
        if (dir) await writeTo(dir, name, blob);
        else finished.push({ name, blob });
        addResult(name, blob, dir ? 'saved to your folder' : '');
      }
      chapterStatus(p.c.i, '✓', 'Done');
    }
    if (!M.cancel && !perChapter) {
      progress('Finishing the file…');
      const name = scene ? `${base} (conversation preview).mp3` : preview ? `${base} (preview).mp3` : `${base}.${ext}`;
      const ends = chapterMarks.map((c, i) => ({ ...c, endMs: i + 1 < chapterMarks.length ? chapterMarks[i + 1].startMs : enc.samples / RATE * 1000 }));
      const blob = await enc.finish(meta(b.title, { chapters: preview ? [] : ends }));
      enc = null;
      if (preview) { addResult(name, blob, 'preview'); const a = $('#results audio'); a.preload = 'auto'; a.play().catch(() => {}); }
      else if (dir) { await writeTo(dir, name, blob); addResult(name, blob, 'saved to your folder'); }
      else { finished.push({ name, blob }); addResult(name, blob, ''); }
    }
    if (M.cancel) {
      $('#progText').textContent = 'Stopped.' + (dir && perChapter ? ' Finished chapters are in your folder; run it again with the same folder to continue.' : '');
    } else {
      $('#barFill').style.width = '100%';
      $('#progEta').textContent = `took ${fmtDur((performance.now() - t0) / 1000)}`;
      $('#progText').textContent = preview ? 'Here\'s the preview.' : dir ? 'Done! Your audiobook is in the folder you chose.' : 'Done! Your download is starting.';
      if (!dir && finished.length === 1) download(finished[0].blob, finished[0].name);
      else if (!dir && finished.length > 1) {
        const files = [];
        for (const x of finished) files.push({ name: x.name, data: new Uint8Array(await x.blob.arrayBuffer()) });
        download(Formats.makeZip(files), `${base} (${ext.toUpperCase()}).zip`);
      }
    }
  } catch (e) {
    console.error(e);
    if (enc) enc.abort();
    if (M.cancel) { $('#progText').textContent = 'Stopped.'; return; }
    $('#progText').textContent = 'Something went wrong: ' + e.message;
    toast('Stopped: ' + e.message, 9000);
  } finally {
    M.making = false; $('#makeBtn').textContent = 'Make audiobook'; updateSummary();
    document.removeEventListener('visibilitychange', reWake);
    try { await wake?.release(); } catch (_) {}
  }
}
$('#makeBtn').onclick = () => make();
$('#previewBtn').onclick = () => make({ preview: true });
$('#cancelBtn').onclick = () => {
  M.cancel = true; $('#progText').textContent = 'Stopping after this sentence…';
  K.gen++; if (K.worker) K.worker.postMessage({ type: 'flush', gen: K.gen });
};
addEventListener('beforeunload', (e) => { if (M.making) { e.preventDefault(); e.returnValue = ''; } });

// =====================================================================
// start-up
// =====================================================================
(async function init() {
  // restore preferences
  $('#kokoroMode').value = PREF.kokoroMode || ('gpu' in navigator ? 'fp32-webgpu' : 'q8-wasm');
  if (PREF.speed) { $('#speed').value = PREF.speed; $('#speedVal').textContent = (+PREF.speed).toFixed(2).replace(/0$/, '') + '×'; }
  if (PREF.fmt) { const r = $(`input[name=fmt][value=${PREF.fmt}]`); if (r) r.checked = true; }
  for (const k of ['split', 'kbps', 'chapPause', 'paraPause']) if (PREF[k]) $('#' + k).value = PREF[k];
  for (const k of ['intro', 'announce', 'skipRefs', 'tags']) if (typeof PREF[k] === 'boolean') $('#' + k).checked = PREF[k];
  if (PREF.dest === 'folder' && 'showDirectoryPicker' in window) $('input[name=dest][value=folder]').checked = true;
  if (PREF.cloudProv) $('#cloudProv').value = PREF.cloudProv;
  if (PREF.openaiStyle) $('#openaiStyle').value = PREF.openaiStyle;
  if (PREF.voice) M.voice = PREF.voice;
  if (PREF.dlgMode) $('#dlgMode').value = PREF.dlgMode;
  $('#readStyle').innerHTML = Object.entries(STYLES).map(([k, x]) => `<option value="${k}">${esc(x.name)}</option>`).join('');
  $('#readStyle').value = STYLES[PREF.readStyle] ? PREF.readStyle : 'natural';
  const styleNote = () => { $('#styleNote').textContent = style().note + (M.voice && M.voice.eng === 'cloud' ? ' Premium voices also change how they perform.' : ''); };
  styleNote();
  $('#readStyle').onchange = () => { PREF.readStyle = $('#readStyle').value; savePref(); styleNote(); M.samples.clear(); if (M.book) { drawChapters(); updateSummary(); } };
  for (const k of ['normalize', 'roomTone']) if (typeof PREF[k] === 'boolean') $('#' + k).checked = PREF[k];
  if (PREF.sting) $('#sting').value = PREF.sting;
  ['#normalize', '#roomTone'].forEach((x) => { $(x).onchange = () => { PREF[x.slice(1)] = $(x).checked; savePref(); M.samples.clear(); }; });
  $('#sting').onchange = () => { PREF.sting = $('#sting').value; savePref(); };
  renderCast();
  $('#sampleText').value = 'It was a bright, cold morning, and the harbor was just waking up. Somewhere a gull called twice, then went quiet.';
  cloudUI();
  setEngine(PREF.eng || 'kokoro');
  showChosen();
  syncExportUI();
  const aac = await checkAac();
  if (!aac) {
    const r = $('input[name=fmt][value=m4b]'); r.disabled = true;
    $('#m4bNote').textContent = 'Not available in this browser. Use Chrome, Edge or Safari.';
    if (r.checked) { $('input[name=fmt][value=mp3]').checked = true; syncExportUI(); }
  }
  if (window.crossOriginIsolated) { const bdg = $('#isoBadge'); bdg.hidden = false; bdg.textContent = 'Fast mode'; bdg.title = 'Voices can use several processor cores'; }
})();
