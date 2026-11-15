'use strict';
// Free, legal book sources. Mirrors Sources.kt in the Android app.

const { decodeEntities, clean } = require('./extract');

const UA = 'ShelfReader/1.0 (desktop ebook reader)';
const enc = encodeURIComponent;

async function get(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
    return r;
  } finally {
    clearTimeout(t);
  }
}
const getText = async (url) => (await get(url)).text();
const getJson = async (url) => (await get(url)).json();
async function getBuffer(url, timeoutMs = 120000) {
  const r = await get(url, timeoutMs);
  return Buffer.from(await r.arrayBuffer());
}

const strOrArr = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
const prettyName = (n) => { const p = n.split(', '); return p.length === 2 ? `${p[1]} ${p[0]}` : n; };
const fmtNum = (n) => Number(n).toLocaleString('en-US');
const joinInfo = (parts) => parts.filter(Boolean).join(' · ') || null;

async function gutenberg(q) {
  const j = await getJson('https://gutendex.com/books/?search=' + enc(q));
  const out = [];
  for (const b of j.results || []) {
    const f = b.formats || {};
    let url = null; let format = null;
    if (f['application/epub+zip']) { url = f['application/epub+zip']; format = 'epub'; }
    else {
      const k = Object.keys(f).find((x) => x.startsWith('text/plain'));
      if (k) { url = f[k]; format = 'txt'; }
    }
    if (!url) continue;
    const subjects = (b.subjects || []).slice(0, 3).join('; ');
    out.push({
      source: 'Gutenberg', title: b.title || '', author: (b.authors || []).map((a) => prettyName(a.name || '')).join(', '),
      url, format, cover: f['image/jpeg'] || null,
      description: (b.summaries && b.summaries[0]) || null,
      info: joinInfo([b.download_count ? `${fmtNum(b.download_count)} downloads` : null, subjects])
    });
  }
  return out;
}

async function standardEbooks(q) {
  const html = await getText('https://standardebooks.org/ebooks?query=' + enc(q));
  const out = []; const seen = new Set();
  for (const m of html.matchAll(/about="(\/ebooks\/[^"#?]+)"([\s\S]*?)(?=about="\/ebooks\/|<\/ol>|$)/g)) {
    const path = m[1].replace(/\/$/, '');
    const slug = path.replace('/ebooks/', '').split('/');
    if (slug.length < 2 || seen.has(path)) continue;
    seen.add(path);
    const names = [...m[2].matchAll(/property="schema:name"[^>]*>([^<]+)</g)].map((x) => decodeEntities(x[1]).trim()).filter(Boolean);
    const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
    out.push({
      source: 'Standard Ebooks',
      title: names[0] || cap(slug[1].replace(/-/g, ' ')),
      author: names[1] || slug[0].split('-').map(cap).join(' '),
      url: `https://standardebooks.org${path}/downloads/${slug.join('_')}.epub?source=download`,
      format: 'epub',
      cover: `https://standardebooks.org${path}/downloads/cover-thumbnail.jpg`
    });
  }
  return out;
}

async function archive(q) {
  const cleanQ = q.replace(/[\\"():[\]{}^~*?!+\-/]/g, ' ').trim();
  if (!cleanQ) return [];
  const query = `(${cleanQ}) AND mediatype:(texts) AND NOT access-restricted-item:(true)`;
  const url = 'https://archive.org/advancedsearch.php?q=' + enc(query) +
    '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=description&fl%5B%5D=year&fl%5B%5D=downloads' +
    '&rows=40&output=json&sort%5B%5D=downloads+desc';
  const j = await getJson(url);
  return ((j.response && j.response.docs) || []).filter((d) => d.identifier).map((d) => ({
    source: 'Internet Archive', title: strOrArr(d.title) || d.identifier, author: strOrArr(d.creator),
    iaId: d.identifier, cover: 'https://archive.org/services/img/' + enc(d.identifier),
    description: clean(strOrArr(d.description)).slice(0, 1500) || null,
    info: joinInfo([strOrArr(d.year), d.downloads ? `${fmtNum(d.downloads)} downloads` : null])
  }));
}

async function openLibrary(q) {
  const url = 'https://openlibrary.org/search.json?q=' + enc(q) +
    '&has_fulltext=true&ebook_access=public&limit=40' +
    '&fields=key,title,author_name,ia,ebook_access,cover_i,first_publish_year,number_of_pages_median,first_sentence,subject';
  const j = await getJson(url);
  const out = [];
  for (const d of j.docs || []) {
    if (d.ebook_access && d.ebook_access !== 'public') continue;
    if (!d.ia || !d.ia.length) continue;
    out.push({
      source: 'Open Library', title: d.title || '', author: strOrArr(d.author_name), iaId: d.ia[0],
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : 'https://archive.org/services/img/' + enc(d.ia[0]),
      description: d.first_sentence ? 'Opening line: ' + strOrArr(d.first_sentence) : null,
      info: joinInfo([
        d.first_publish_year ? `First published ${d.first_publish_year}` : null,
        d.number_of_pages_median ? `${d.number_of_pages_median} pages` : null,
        (d.subject || []).slice(0, 3).join('; ')
      ])
    });
  }
  return out;
}

async function wikisource(q) {
  const j = await getJson('https://en.wikisource.org/w/api.php?action=query&list=search&srnamespace=0&srlimit=30&format=json&srsearch=' + enc(q));
  return ((j.query && j.query.search) || []).filter((o) => o.title && !o.title.includes('/')).map((o) => ({
    source: 'Wikisource', title: o.title, author: '',
    url: 'https://ws-export.wmcloud.org/?format=epub-3&lang=en&page=' + enc(o.title), format: 'epub',
    description: o.snippet ? '…' + clean(o.snippet) + '…' : null,
    info: o.wordcount ? `${fmtNum(o.wordcount)} words` : null
  }));
}

async function feedbooks(q) {
  const xml = await getText('https://catalog.feedbooks.com/search.atom?query=' + enc(q));
  const out = [];
  for (const m of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const e = m[0];
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(e);
    if (!t) continue;
    const a = /<author>\s*<name>([\s\S]*?)<\/name>/i.exec(e);
    let url = null; let cover = null;
    for (const l of e.matchAll(/<link\b[^>]*>/gi)) {
      const tag = l[0];
      const rel = (/rel="([^"]+)"/.exec(tag) || [])[1] || '';
      const type = (/type="([^"]+)"/.exec(tag) || [])[1] || '';
      const href = (/href="([^"]+)"/.exec(tag) || [])[1];
      if (!href) continue;
      if (!url && (rel === 'http://opds-spec.org/acquisition' || rel === 'http://opds-spec.org/acquisition/open-access') && type.includes('epub')) url = decodeEntities(href);
      if (!cover && rel.startsWith('http://opds-spec.org/image')) cover = decodeEntities(href);
    }
    if (!url) continue;
    const s = /<(summary|content)[^>]*>([\s\S]*?)<\/\1>/i.exec(e);
    out.push({
      source: 'Feedbooks', title: decodeEntities(t[1]).trim(), author: a ? decodeEntities(a[1]).trim() : '',
      url, format: 'epub', cover, description: s ? clean(decodeEntities(s[2])) : null
    });
  }
  return out;
}

/** Best readable file in an Internet Archive item → { url, format } */
async function resolveArchive(id) {
  const j = await getJson('https://archive.org/metadata/' + enc(id));
  if (j.metadata && String(j.metadata['access-restricted-item']) === 'true') {
    throw new Error("this one is lend-only on archive.org, so it can't be downloaded");
  }
  const names = (j.files || []).map((f) => f.name || '').filter((n) => !n.includes('_encrypted') && !n.endsWith('_lcp.epub'));
  const pick =
    (names.find((n) => /\.epub$/i.test(n)) && { name: names.find((n) => /\.epub$/i.test(n)), format: 'epub' }) ||
    (names.find((n) => /_djvu\.txt$/i.test(n)) && { name: names.find((n) => /_djvu\.txt$/i.test(n)), format: 'txt' }) ||
    (names.find((n) => /\.txt$/i.test(n)) && { name: names.find((n) => /\.txt$/i.test(n)), format: 'txt' }) ||
    (names.find((n) => /\.pdf$/i.test(n)) && { name: names.find((n) => /\.pdf$/i.test(n)), format: 'pdf' });
  if (!pick) throw new Error('no EPUB, text or PDF file in this item');
  return { url: `https://archive.org/download/${enc(id)}/${pick.name.split('/').map(enc).join('/')}`, format: pick.format };
}

async function define(word) {
  const w = word.trim().toLowerCase().replace(/[^\p{L}'-]/gu, '');
  if (!w) throw new Error('select a single word');
  let arr;
  try {
    arr = await getJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + enc(w));
  } catch (e) {
    if (String(e.message).includes('404')) return { word: w, text: `No definition found for “${w}”.` };
    throw e;
  }
  const lines = [];
  let phonetic = '';
  let count = 0;
  for (const [i, entry] of arr.entries()) {
    if (i === 0 && entry.phonetic) phonetic = entry.phonetic;
    for (const m of entry.meanings || []) {
      for (const d of (m.definitions || []).slice(0, 2)) {
        if (count >= 6) break;
        lines.push({ pos: m.partOfSpeech || '', def: d.definition || '', example: d.example || '' });
        count++;
      }
    }
  }
  return { word: w, phonetic, defs: lines };
}

const SOURCES = { gutenberg, standardEbooks, archive, openLibrary, wikisource, feedbooks };

module.exports = { SOURCES, resolveArchive, getBuffer, getJson, define };
