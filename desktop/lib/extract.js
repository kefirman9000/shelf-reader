'use strict';
// Turns EPUB / TXT / PDF files into paragraphs plus a chapter list.
// Mirrors the Android app's Extract.kt so phone backups line up.

const AdmZip = require('adm-zip');

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', shy: '', copy: '©',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä',
  ccedil: 'ç', szlig: 'ß'
};

function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    try {
      if (e[0] === '#') {
        const n = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return String.fromCodePoint(n);
      }
      return NAMED[e] !== undefined ? NAMED[e] : m;
    } catch (_) {
      return m;
    }
  });
}

const ws = (s) => s.replace(/\s+/g, ' ').trim();
const clean = (s) => ws(decodeEntities(s.replace(/<[^>]*>/g, ' ')));
const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };

function attr(tag, name) {
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(tag);
  return m ? m[1] : null;
}

function resolvePath(base, href) {
  const parts = [];
  for (const p of (base + href).split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join('/');
}

const IMG_MARK = /\u0007([^\u0007]*)\u0007/g;
/** Returns [{ text, imgs }] — imgs are picture paths (inside the EPUB) shown before the paragraph. */
function htmlToParagraphsRich(html, dir) {
  let h = html;
  const b = /<body[^>]*>/i.exec(h);
  if (b) h = h.slice(b.index + b[0].length);
  h = h.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ');
  // pictures → invisible markers (kept in place, removed from the text afterwards)
  h = h.replace(/<(?:img|image)\b[^>]*>/gi, (tag) => {
    const src = attr(tag, 'src') || attr(tag, 'xlink:href') || attr(tag, 'href');
    return src && !/^data:/i.test(src) ? `\u0007${resolvePath(dir || '', dec(src.split('#')[0]))}\u0007` : '';
  });
  // footnote references → [n]
  h = h.replace(/<a\b([^>]*)>\s*(?:<sup[^>]*>)?\s*\[?(\d{1,3}|[*†‡])\]?\s*(?:<\/sup>)?\s*<\/a>/gi, (m, attrs, n) =>
    (/noteref|footnote|endnote|#fn|#note|#ftn|#en\d/i.test(attrs) || /<sup/i.test(m)) ? `[${n}]` : m);
  h = h.replace(/<sup[^>]*>\s*(\d{1,3}|[*†‡])\s*<\/sup>/gi, '[$1]');
  h = h.replace(/<\/?(p|div|h[1-6]|li|blockquote|tr|section|article|br|hr|dt|dd|pre)\b[^>]*>/gi, '\n\n');
  h = h.replace(/<[^>]*>/g, '');
  h = decodeEntities(h);
  const out = []; let pending = [];
  for (const piece of h.split(/\n\s*\n/)) {
    const imgs = []; let m;
    IMG_MARK.lastIndex = 0;
    while ((m = IMG_MARK.exec(piece))) if (m[1]) imgs.push(m[1]);
    const text = ws(piece.replace(IMG_MARK, ''));
    if (!text) { pending.push(...imgs); continue; }
    out.push({ text, imgs: pending.concat(imgs) }); pending = [];
  }
  return { paras: out, trailing: pending };
}
function htmlToParagraphs(html) { return htmlToParagraphsRich(html).paras.map((p) => p.text); }

function txt(text) {
  let t = text.replace(/\r\n?/g, '\n');
  const s = /\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i.exec(t);
  if (s) t = t.slice(s.index + s[0].length);
  const e = /\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i.exec(t);
  if (e) t = t.slice(0, e.index);
  return t.split(/\n\s*\n/).map(ws).filter(Boolean);
}

class Epub {
  constructor(buf) {
    this.zip = new AdmZip(buf);
    const c = this.read('META-INF/container.xml');
    if (!c) throw new Error('not a valid EPUB');
    const m = /full-path\s*=\s*"([^"]+)"/.exec(c);
    if (!m) throw new Error('EPUB has no package file');
    this.opfPath = m[1];
    this.opf = this.read(this.opfPath);
    if (!this.opf) throw new Error('EPUB package file is missing');
    this.base = dirOf(this.opfPath);
  }
  entry(name) {
    return this.zip.getEntry(name) || this.zip.getEntries().find((e) => e.entryName.toLowerCase() === name.toLowerCase()) || null;
  }
  read(name) { const e = this.entry(name); return e ? e.getData().toString('utf8') : null; }
  readBuf(name) { const e = this.entry(name); return e ? e.getData() : null; }
  items() {
    return [...this.opf.matchAll(/<(?:\w+:)?item\b[^>]*>/gi)].map((m) => m[0]);
  }
}

function epubInfo(buf) {
  try {
    const e = new Epub(buf);
    const t = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(e.opf);
    const a = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(e.opf);
    return { title: t ? clean(t[1]) : null, author: a ? clean(a[1]) : null };
  } catch (_) {
    return { title: null, author: null };
  }
}

function epubCover(buf) {
  try {
    const e = new Epub(buf);
    const items = e.items();
    const isImage = (t) => (attr(t, 'media-type') || '').startsWith('image');
    let tag = items.find((t) => (attr(t, 'properties') || '').split(' ').includes('cover-image')) || null;
    if (!tag) {
      const meta = [...e.opf.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => attr(t, 'name') === 'cover');
      const id = meta ? attr(meta, 'content') : null;
      if (id) tag = items.find((t) => attr(t, 'id') === id) || null;
    }
    if (!tag || !isImage(tag)) {
      tag = items.find((t) => isImage(t) && ((attr(t, 'id') || '') + ' ' + (attr(t, 'href') || '')).toLowerCase().includes('cover')) || tag;
    }
    if (!tag) return null;
    const href = attr(tag, 'href');
    if (!href) return null;
    const data = e.readBuf(resolvePath(e.base, dec(href)));
    if (!data) return null;
    return { data, type: attr(tag, 'media-type') || 'image/jpeg' };
  } catch (_) {
    return null;
  }
}

function epub(buf) {
  const e = new Epub(buf);
  const manifest = {};
  for (const t of e.items()) {
    const id = attr(t, 'id'); const href = attr(t, 'href');
    if (id && href) manifest[id] = { href, type: attr(t, 'media-type') || '', props: attr(t, 'properties') || '' };
  }
  const spineTag = (/<(?:\w+:)?spine\b[^>]*>/i.exec(e.opf) || [''])[0];
  const spine = [...e.opf.matchAll(/<(?:\w+:)?itemref\b[^>]*>/gi)].map((m) => attr(m[0], 'idref')).filter(Boolean);

  const toc = new Map();
  const navItems = Object.values(manifest).filter((i) => i.props.split(' ').includes('nav'));
  for (const nav of navItems) {
    const navPath = resolvePath(e.base, dec(nav.href));
    const html = e.read(navPath);
    if (!html) continue;
    const d = dirOf(navPath);
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const p = resolvePath(d, dec(m[1].split('#')[0]));
      const t = clean(m[2]);
      if (t && p && !toc.has(p)) toc.set(p, t);
    }
  }
  if (toc.size === 0) {
    const tocId = attr(spineTag, 'toc');
    const ncx = (tocId && manifest[tocId]) || Object.values(manifest).find((i) => i.type.includes('ncx'));
    if (ncx) {
      const ncxPath = resolvePath(e.base, dec(ncx.href));
      const x = e.read(ncxPath);
      if (x) {
        const d = dirOf(ncxPath);
        for (const m of x.matchAll(/<navLabel[^>]*>\s*<text[^>]*>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content[^>]*src\s*=\s*["']([^"']+)["']/gi)) {
          const p = resolvePath(d, dec(m[2].split('#')[0]));
          const t = clean(m[1]);
          if (t && !toc.has(p)) toc.set(p, t);
        }
      }
    }
  }

  const navPaths = new Set(navItems.map((i) => resolvePath(e.base, dec(i.href))));
  const out = [];
  let carryImgs = [];
  for (const idref of spine) {
    const item = manifest[idref];
    if (!item) continue;
    const path = resolvePath(e.base, dec(item.href.split('#')[0]));
    if (navPaths.has(path)) continue;
    const title = toc.get(path);
    if (title && /^(table of )?contents$/i.test(title)) continue;
    const html = e.read(path);
    if (!html) continue;
    const rich = htmlToParagraphsRich(html, dirOf(path));
    const ps = rich.paras;
    if (!ps.length) { carryImgs.push(...rich.trailing); continue; }
    let chap = title || null;
    if (!chap && toc.size === 0) {
      const h = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
      const t = h ? clean(h[1]) : '';
      if (t && t.length < 120) chap = t;
    }
    ps.forEach((pp, k) => {
      const imgs = k === 0 ? carryImgs.concat(pp.imgs) : pp.imgs;
      out.push({ text: pp.text, chap: k === 0 ? chap : null, imgs });
    });
    carryImgs = rich.trailing.slice();
  }
  if (!out.length) throw new Error("couldn't find any text in this EPUB");
  return out;
}

async function pdf(buf) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const r = await pdfParse(buf);
  const text = r.text.replace(/\r\n/g, '\n').replace(/-\n(?=[a-z])/g, '');
  const blocks = text.split(/\n\s*\n/);
  const chosen = blocks.length > 5 ? blocks : [text];
  const out = chosen.map(ws).filter(Boolean);
  if (!out.length) throw new Error('this PDF has no text layer (it may be a scan)');
  return out;
}

const PAGE_NUM = /^\[?((page|pg\.?|p\.)\s*)?\d{1,4}\]?$/i;

function splitLong(p) {
  const sentences = p.split(/(?<=[.!?…]["”’)]?)\s+/);
  const out = [];
  let sb = '';
  for (const s of sentences) {
    if (s.length > 2500) {
      if (sb) { out.push(sb); sb = ''; }
      for (let i = 0; i < s.length; i += 2000) out.push(s.slice(i, i + 2000));
      continue;
    }
    if (sb && sb.length + s.length > 800) { out.push(sb); sb = ''; }
    sb = sb ? sb + ' ' + s : s;
  }
  if (sb) out.push(sb);
  return out;
}

function normalize(ps) {
  let list = ps;
  const s = list.findIndex((p) => /START OF (THE|THIS) PROJECT GUTENBERG/i.test(p.text));
  let e = -1;
  for (let i = list.length - 1; i >= 0; i--) if (/END OF (THE|THIS) PROJECT GUTENBERG/i.test(list[i].text)) { e = i; break; }
  if (s >= 0 && e > s) list = list.slice(s + 1, e);
  else if (s >= 0) list = list.slice(s + 1);
  const out = [];
  let carry = null; let carryImgs = [];
  for (const p of list) {
    const c = p.chap || carry;
    const imgs = carryImgs.concat(p.imgs || []);
    carry = null; carryImgs = [];
    if (PAGE_NUM.test(p.text)) { carry = c; carryImgs = imgs; continue; }
    if (p.text.length <= 1200) out.push({ text: p.text, chap: c, imgs });
    else splitLong(p.text).forEach((piece, k) => out.push({ text: piece, chap: k === 0 ? c : null, imgs: k === 0 ? imgs : [] }));
  }
  if (!out.length) throw new Error('no readable text found');
  return out;
}

const HEADING = new RegExp(
  '^(chapter|book|part|letter|canto|act|volume|stave|section)\\b[\\s.:]*' +
  '([0-9]+|[ivxlcdm]+\\b|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|' +
  'sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|the\\s+\\w+|first|second|third|fourth|fifth|' +
  'sixth|seventh|eighth|ninth|tenth|last).*$', 'i');
const ROMAN = /^[IVXLC]{1,7}\.$|^[IVXLC]{2,7}$/;
const NAMED_HEAD = /^(prologue|epilogue|preface|introduction|foreword|afterword|conclusion)\.?$/i;

function detectHeadings(list) {
  for (const p of list) {
    if (!p.chap && p.text.length <= 80 && (HEADING.test(p.text) || ROMAN.test(p.text) || NAMED_HEAD.test(p.text))) p.chap = p.text;
  }
}

/** Returns { paras: string[], chapters: [{title, para}] } */
async function documentFrom(buf, format) {
  let raw;
  if (format === 'epub') raw = epub(buf);
  else if (format === 'pdf') raw = (await pdf(buf)).map((text) => ({ text, chap: null }));
  else raw = txt(buf.toString('utf8')).map((text) => ({ text, chap: null }));
  const list = normalize(raw);
  if (list.filter((p) => p.chap).length < 2) detectHeadings(list);
  const chapters = [];
  list.forEach((p, i) => { if (p.chap) chapters.push({ title: p.chap, para: i }); });
  if (chapters.length && chapters[0].para > 0) chapters.unshift({ title: 'Beginning', para: 0 });
  const images = [];
  list.forEach((p, i) => { for (const src of p.imgs || []) images.push({ para: i, src }); });
  return { paras: list.map((p) => p.text.replace(/\n/g, ' ')), chapters, images };
}

/** Reads a file (e.g. a picture) from inside an EPUB. */
function epubEntry(buf, name) {
  try { const e = new Epub(buf); return e.readBuf(name); } catch (_) { return null; }
}

module.exports = { documentFrom, epubInfo, epubCover, epubEntry, decodeEntities, clean };
