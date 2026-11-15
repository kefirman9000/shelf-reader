'use strict';
/* Cover art for the audiobook maker: published covers (Open Library), free-licensed art (Openverse, Wikimedia
   Commons), original designed covers, or your own picture. Then crop to square or book shape, optionally add
   the title, and use it. Loaded after maker.js (uses $, $$, M, esc, toast, drawCover). */

const CV = { tab: 'covers', src: 'openverse', picked: null, img: null, shape: 'square', text: 'none', dark: 0.25, designIdx: 0 };
const CV_STOP = new Set('a an the of and or in on at to for with from by into my your his her their our its is are was were be this that these those book volume part novel story stories tale tales'.split(' '));

function cvOpen() {
  if (!M.book) return;
  $('#coverDlg').hidden = false;
  document.body.style.overflow = 'hidden';
  cvSetTab(CV.tab);
}
function cvClose() { $('#coverDlg').hidden = true; document.body.style.overflow = ''; }
$('#coverBtn').onclick = cvOpen;
$('#cvClose').onclick = cvClose;
$('#coverDlg').onclick = (e) => { if (e.target.id === 'coverDlg') cvClose(); };
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#coverDlg').hidden) cvClose(); });

function cvDefaultQuery(tab) {
  const t = (M.book.title || '').trim(); const a = (M.book.author || '').split(',')[0].trim();
  if (tab === 'covers') return [t, a].filter(Boolean).join(' ');
  const words = t.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !CV_STOP.has(w));
  return words.slice(0, 3).join(' ') || 'landscape painting';
}

function cvSetTab(tab) {
  CV.tab = tab;
  $$('#coverDlg .tab').forEach((t) => t.classList.toggle('active', t.dataset.cv === tab));
  $('#cvEdit').hidden = true; $('#cvBrowse').hidden = false;
  $('#cvSearch').hidden = !(tab === 'covers' || tab === 'art');
  $('#cvSrcF').hidden = tab !== 'art';
  $('#cvUpload').hidden = tab !== 'upload';
  const notes = {
    covers: 'Covers of published editions, from Open Library. Fine for your own listening; the artwork belongs to its publisher, so don\'t share or sell files that use it.',
    art: 'Free-licensed and public-domain pictures. The credit is shown below the picture and saved in the audio files, as the licenses ask.',
    design: 'Original covers made right here from your title and author. Use them anywhere.',
    upload: 'Use a JPEG or PNG picture from your device.'
  };
  $('#cvNote').textContent = notes[tab];
  $('#cvGrid').innerHTML = '';
  if (tab === 'covers' || tab === 'art') {
    $('#cvQuery').value = CV['q_' + tab] || cvDefaultQuery(tab);
    cvSearch();
  } else if (tab === 'design') cvDesigns();
}
$$('#coverDlg .tab').forEach((t) => { t.onclick = () => cvSetTab(t.dataset.cv); });
$('#cvGo').onclick = () => cvSearch();
$('#cvQuery').onkeydown = (e) => { if (e.key === 'Enter') cvSearch(); };
$('#cvSrc').onchange = () => { CV.src = $('#cvSrc').value; cvSearch(); };
$('#cvPick').onclick = () => $('#coverFile').click();

const stripHtml = (h) => { const d = document.createElement('div'); d.innerHTML = h || ''; return (d.textContent || '').trim(); };

async function cvSearch() {
  const q = $('#cvQuery').value.trim(); if (!q) return;
  CV['q_' + CV.tab] = q;
  const grid = $('#cvGrid');
  grid.innerHTML = '<div class="empty">Searching…</div>';
  let items = [];
  try {
    if (CV.tab === 'covers') {
      const j = await (await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&fields=key,title,author_name,cover_i,first_publish_year&limit=40`)).json();
      const seen = new Set();
      items = (j.docs || []).filter((d) => d.cover_i && !seen.has(d.cover_i) && seen.add(d.cover_i)).slice(0, 24).map((d) => ({
        thumb: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
        full: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
        label: `${d.title}${d.first_publish_year ? ' (' + d.first_publish_year + ')' : ''}`,
        credit: `Cover of “${d.title}”${d.author_name ? ' by ' + d.author_name[0] : ''}, via Open Library`, link: 'https://openlibrary.org' + d.key
      }));
    } else if (CV.src === 'openverse') {
      const j = await (await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=24&mature=false`)).json();
      items = (j.results || []).map((r) => ({
        thumb: r.thumbnail || r.url, full: r.url, fallback: r.thumbnail,
        label: `${r.title || 'Untitled'}${r.creator ? ' · ' + r.creator : ''}`,
        credit: r.attribution ? r.attribution.replace(/\s+/g, ' ').replace(/ To view .*$/, '').trim() : `“${r.title || 'Untitled'}” by ${r.creator || 'unknown'}, ${String(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim(),
        link: r.foreign_landing_url || r.url, license: String(r.license || '').toUpperCase()
      }));
    } else {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=24&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1400`;
      const j = await (await fetch(url)).json();
      items = Object.values((j.query && j.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0)).map((pg) => {
        const ii = (pg.imageinfo || [])[0] || {}; const md = ii.extmetadata || {};
        const title = pg.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '');
        const artist = stripHtml(md.Artist && md.Artist.value) || 'unknown';
        const lic = (md.LicenseShortName && md.LicenseShortName.value) || '';
        return { thumb: ii.thumburl || ii.url, full: ii.thumburl || ii.url, label: `${title} · ${artist}`, credit: `“${title}” by ${artist}${lic ? ', ' + lic : ''}, Wikimedia Commons`, link: ii.descriptionurl, license: lic };
      }).filter((x) => x.thumb);
    }
  } catch (e) {
    grid.innerHTML = `<div class="empty">Couldn't search right now (${esc(e.message)}). Check your connection and try again.</div>`;
    return;
  }
  if (!items.length) { grid.innerHTML = '<div class="empty">Nothing found. Try other words.</div>'; return; }
  grid.innerHTML = items.map((it, i) => `<button class="cv-item" data-i="${i}" title="${esc(it.label)}"><img loading="lazy" src="${esc(it.thumb)}" alt=""><span>${esc(it.label)}</span>${it.license ? `<em>${esc(it.license)}</em>` : ''}</button>`).join('');
  grid.querySelectorAll('.cv-item').forEach((b) => { b.onclick = () => cvUseItem(items[+b.dataset.i], b); });
  grid.querySelectorAll('img').forEach((im) => { im.onerror = () => { im.closest('.cv-item').remove(); }; });
}

async function cvFetchImage(url) {
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  if (!/^image\//.test(blob.type) && blob.size < 2000) throw new Error('not a picture');
  return createImageBitmap(blob);
}
async function cvUseItem(it, btn) {
  btn.classList.add('busy');
  let img = null;
  for (const u of [it.full, it.fallback, it.thumb].filter(Boolean)) {
    try { img = await cvFetchImage(u); if (img.width >= 300 || u === it.thumb) break; } catch (_) { img = null; }
  }
  btn.classList.remove('busy');
  if (!img) { toast('That picture can\'t be downloaded from here. Try another one.'); return; }
  if (CV.tab === 'covers' && img.width < 50) { toast('Open Library has no real picture for that one. Try another.'); return; }
  CV.img = img; CV.design = null; CV.credit = it.credit; CV.link = it.link;
  CV.text = CV.tab === 'covers' ? 'none' : 'band';
  CV.shape = 'square';
  cvEdit();
}

// ---------- original designed covers ----------
const PALETTES = [
  ['#1d3557', '#457b9d', '#f1faee', '#e63946'], ['#2b2d42', '#8d99ae', '#edf2f4', '#ef233c'], ['#264653', '#2a9d8f', '#e9c46a', '#f4a261'],
  ['#3d405b', '#81b29a', '#f4f1de', '#e07a5f'], ['#0b132b', '#1c2541', '#5bc0be', '#fcd581'], ['#582f0e', '#936639', '#ede0d4', '#b6ad90'],
  ['#10002b', '#5a189a', '#e0aaff', '#ff9e00'], ['#081c15', '#2d6a4f', '#d8f3dc', '#95d5b2']
];
const PATTERNS = ['horizon', 'circles', 'waves', 'stripes', 'grid', 'peaks', 'frame', 'rings'];
function drawDesign(ctx, w, h, k) {
  const pal = PALETTES[k % PALETTES.length]; const pat = PATTERNS[Math.floor(k / 1) % PATTERNS.length];
  const [bg, mid, light, acc] = pal;
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, bg); g.addColorStop(1, mid);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.save();
  const u = Math.min(w, h);
  if (pat === 'horizon') {
    ctx.fillStyle = acc; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(w * 0.5, h * 0.62, u * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fillRect(0, h * 0.62, w, h * 0.38);
    ctx.strokeStyle = light; ctx.globalAlpha = 0.35; ctx.lineWidth = u * 0.006;
    for (let i = 1; i < 7; i++) { ctx.beginPath(); const y = h * 0.62 + i * i * h * 0.008; ctx.moveTo(w * (0.5 - 0.06 * i), y); ctx.lineTo(w * (0.5 + 0.06 * i), y); ctx.stroke(); }
  } else if (pat === 'circles') {
    for (let i = 0; i < 9; i++) { ctx.globalAlpha = 0.18; ctx.fillStyle = i % 2 ? light : acc; ctx.beginPath(); ctx.arc(w * (0.15 + ((i * 37) % 70) / 100), h * (0.12 + ((i * 53) % 60) / 100), u * (0.08 + (i % 4) * 0.05), 0, Math.PI * 2); ctx.fill(); }
  } else if (pat === 'waves') {
    for (let r = 0; r < 6; r++) {
      ctx.globalAlpha = 0.25 + r * 0.1; ctx.fillStyle = r % 2 ? light : acc; ctx.beginPath(); ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += w / 60) ctx.lineTo(x, h * (0.55 + r * 0.07) + Math.sin(x / w * Math.PI * 3 + r) * h * 0.025);
      ctx.lineTo(w, h); ctx.fill();
    }
  } else if (pat === 'stripes') {
    ctx.globalAlpha = 0.22; ctx.fillStyle = light;
    for (let i = -10; i < 20; i++) { ctx.beginPath(); ctx.moveTo(i * u * 0.12, 0); ctx.lineTo(i * u * 0.12 + u * 0.05, 0); ctx.lineTo(i * u * 0.12 + u * 0.05 - h * 0.6, h); ctx.lineTo(i * u * 0.12 - h * 0.6, h); ctx.fill(); }
  } else if (pat === 'grid') {
    ctx.fillStyle = light; ctx.globalAlpha = 0.35;
    for (let x = u * 0.06; x < w; x += u * 0.07) for (let y = u * 0.06; y < h; y += u * 0.07) { ctx.beginPath(); ctx.arc(x, y, u * 0.006, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1; ctx.fillStyle = acc; ctx.fillRect(w * 0.1, h * 0.1, w * 0.03, h * 0.34);
  } else if (pat === 'peaks') {
    [[0.62, light, 0.25], [0.7, acc, 0.6], [0.8, bg, 1]].forEach(([y, c, a], r) => {
      ctx.globalAlpha = a; ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(0, h);
      for (let i = 0; i <= 8; i++) ctx.lineTo(w * i / 8, h * (y - (i % 2 ? 0.12 + r * 0.02 : 0) ));
      ctx.lineTo(w, h); ctx.fill();
    });
  } else if (pat === 'frame') {
    ctx.strokeStyle = acc; ctx.lineWidth = u * 0.012; ctx.strokeRect(w * 0.06, h * 0.06, w * 0.88, h * 0.88);
    ctx.lineWidth = u * 0.004; ctx.strokeStyle = light; ctx.globalAlpha = 0.6; ctx.strokeRect(w * 0.085, h * 0.085, w * 0.83, h * 0.83);
  } else if (pat === 'rings') {
    ctx.strokeStyle = light; ctx.lineWidth = u * 0.004;
    for (let i = 1; i < 14; i++) { ctx.globalAlpha = 0.5 - i * 0.03; ctx.beginPath(); ctx.arc(w * 0.78, h * 0.25, u * 0.05 * i, 0, Math.PI * 2); ctx.stroke(); }
  }
  ctx.restore();
}
function cvDesigns() {
  const grid = $('#cvGrid');
  grid.innerHTML = PATTERNS.map((_, i) => `<button class="cv-item design" data-i="${i}"><canvas width="240" height="240"></canvas><span>Design ${i + 1}</span></button>`).join('');
  grid.querySelectorAll('.cv-item').forEach((b) => {
    const k = +b.dataset.i;
    const c = b.querySelector('canvas'); const ctx = c.getContext('2d');
    drawDesign(ctx, 240, 240, k); drawTitle(ctx, 240, 240, 'big', 0);
    b.onclick = () => { CV.img = null; CV.design = k; CV.credit = ''; CV.link = ''; CV.text = 'big'; CV.shape = 'square'; cvEdit(); };
  });
}

// ---------- editor ----------
function wrapLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  return lines;
}
function drawTitle(ctx, w, h, mode, dark) {
  if (mode === 'none') return;
  const title = M.book.title || ''; const author = M.book.author || '';
  const u = Math.min(w, h);
  ctx.save();
  if (mode === 'band') {
    const bandH = h * 0.27;
    const g = ctx.createLinearGradient(0, h - bandH * 1.4, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.3, 'rgba(0,0,0,0.62)'); g.addColorStop(1, 'rgba(0,0,0,0.8)');
    ctx.fillStyle = g; ctx.fillRect(0, h - bandH * 1.4, w, bandH * 1.4);
    let size = u * 0.075; ctx.font = `600 ${size}px Georgia, 'Times New Roman', serif`;
    let lines = wrapLines(ctx, title, w * 0.86);
    while (lines.length > 2 && size > u * 0.045) { size *= 0.9; ctx.font = `600 ${size}px Georgia, serif`; lines = wrapLines(ctx, title, w * 0.86); }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    let y = h - bandH * 0.62 - (lines.length - 1) * size * 1.12;
    for (const l of lines) { ctx.fillText(l, w / 2, y); y += size * 1.12; }
    if (author) { ctx.font = `${u * 0.036}px system-ui, sans-serif`; ctx.globalAlpha = 0.85; ctx.fillText(author.toUpperCase(), w / 2, h - bandH * 0.2); }
  } else {
    if (dark) { ctx.fillStyle = `rgba(0,0,0,${dark})`; ctx.fillRect(0, 0, w, h); }
    let size = u * 0.11; ctx.font = `700 ${size}px Georgia, 'Times New Roman', serif`;
    let lines = wrapLines(ctx, title, w * 0.8);
    while (lines.length > 3 && size > u * 0.06) { size *= 0.9; ctx.font = `700 ${size}px Georgia, serif`; lines = wrapLines(ctx, title, w * 0.8); }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = u * 0.02;
    let y = h * 0.36 - (lines.length - 1) * size * 0.55;
    for (const l of lines) { ctx.fillText(l, w / 2, y); y += size * 1.1; }
    if (author) {
      ctx.font = `${u * 0.042}px system-ui, sans-serif`; ctx.globalAlpha = 0.9;
      const a = author.toUpperCase().split('').join(' ');
      ctx.fillText(a, w / 2, y + size * 0.35);
    }
  }
  ctx.restore();
}
function cvRender(canvas) {
  const [w, h] = CV.shape === 'square' ? [1400, 1400] : [1200, 1800];
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, w, h);
  if (CV.img) {
    const img = CV.img;
    const s = Math.max(w / img.width, h / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) * (CV.text === 'band' ? 0.35 : 0.5), dw, dh);
    if (CV.text !== 'band' && CV.dark && CV.text !== 'none') { /* darkening is applied with the title */ }
  } else drawDesign(ctx, w, h, CV.design || 0);
  drawTitle(ctx, w, h, CV.text, CV.img ? CV.dark : 0);
}
function cvEdit() {
  $('#cvBrowse').hidden = true; $('#cvEdit').hidden = false;
  $$('#cvShape button').forEach((b) => b.classList.toggle('on', b.dataset.v === CV.shape));
  $$('#cvText button').forEach((b) => b.classList.toggle('on', b.dataset.v === CV.text));
  $('#cvDark').value = CV.dark; $('#cvDarkF').hidden = !CV.img || CV.text !== 'big';
  $('#cvCredit').innerHTML = CV.credit ? `Credit: ${esc(CV.credit)}${CV.link ? ` · <a href="${esc(CV.link)}" target="_blank" rel="noopener">source</a>` : ''}` : (CV.design != null ? 'An original design. No credit needed.' : '');
  cvRender($('#cvCanvas'));
}
$$('#cvShape button').forEach((b) => { b.onclick = () => { CV.shape = b.dataset.v; cvEdit(); }; });
$$('#cvText button').forEach((b) => { b.onclick = () => { CV.text = b.dataset.v; cvEdit(); }; });
$('#cvDark').oninput = () => { CV.dark = +$('#cvDark').value; cvRender($('#cvCanvas')); };
$('#cvBack').onclick = () => { $('#cvEdit').hidden = true; $('#cvBrowse').hidden = false; if (CV.tab === 'upload') cvSetTab('upload'); };
$('#cvUse').onclick = async () => {
  const canvas = $('#cvCanvas');
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  const data = new Uint8Array(await blob.arrayBuffer());
  if (M.book.cover?.url) URL.revokeObjectURL(M.book.cover.url);
  M.book.cover = { mime: 'image/jpeg', data, url: URL.createObjectURL(blob), credit: CV.credit || '' };
  drawCover(); cvClose();
  toast('Cover updated. It will be added to your audio files.');
};
/** Your own picture goes through the same editor (crop + optional title). */
async function cvFromFile(f) {
  try { CV.img = await createImageBitmap(f); } catch (_) { toast('That picture couldn\'t be opened.'); return; }
  CV.design = null; CV.credit = ''; CV.link = ''; CV.text = 'none'; CV.tab = 'upload';
  if ($('#coverDlg').hidden) cvOpen();
  cvSetTab('upload'); cvEdit();
}
