'use strict';
/* Reading features: paragraph rendering (highlights, footnotes, pictures), highlighter pens,
   footnote pop-ups, notes export, page-flip, reading stats, night schedule, "last time" recap,
   and phone ↔ PC sync settings. Loaded before app.js; uses its globals when called. */

// ---------- paragraph rendering ----------
const HL_COLORS = { yellow: 'Yellow', green: 'Green', pink: 'Pink' };
const fnLinks = (h) => h.replace(/\[(\d{1,3}|[*†‡])\]/g, '<a class="fn" data-n="$1" title="Show note">[$1]</a>');

/** HTML for paragraph i: highlighter marks, the sentence being read (ma..mb), footnote links. */
function paraHTML(i, ma = -1, mb = -1) {
  const t = S.paras[i] || '';
  const ranges = [];
  for (const n of (S.bookState && S.bookState.notes) || []) {
    if (n.type === 'hl' && n.para === i && n.end > n.start) ranges.push([Math.max(0, n.start), Math.min(t.length, n.end), 'hl hl-' + (n.color || 'yellow')]);
  }
  const cuts = new Set([0, t.length]);
  for (const [x, y] of ranges) { cuts.add(x); cuts.add(y); }
  if (ma >= 0 && mb > ma) { cuts.add(ma); cuts.add(Math.min(t.length, mb)); }
  const pts = [...cuts].sort((x, y) => x - y);
  let out = '';
  for (let k = 0; k < pts.length - 1; k++) {
    const x = pts[k]; const y = pts[k + 1];
    if (y <= x) continue;
    let seg = fnLinks(esc(t.slice(x, y)));
    const cls = ranges.filter(([p, q]) => p <= x && q >= y).map((r) => r[2]);
    if (cls.length) seg = `<span class="${cls[cls.length - 1]}">${seg}</span>`;
    if (ma >= 0 && x >= ma && y <= mb) seg = `<mark>${seg}</mark>`;
    out += seg;
  }
  return out;
}
function picturesHTML(i) {
  const list = (S.pictures && S.pictures.get(i)) || [];
  return list.map((src) => `<figure class="pic"><img loading="lazy" alt="" src="/api/picture/${S.book.id}?src=${encodeURIComponent(src)}" onerror="this.parentNode.remove()"></figure>`).join('');
}
function indexPictures(list) {
  S.pictures = new Map();
  for (const p of list || []) { if (!S.pictures.has(p.para)) S.pictures.set(p.para, []); S.pictures.get(p.para).push(p.src); }
  S.fnDefs = null;
}

// ---------- highlighter & selection bubble ----------
function selectionInPara() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const txA = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode).closest('.tx');
  const txB = (r.endContainer.nodeType === 1 ? r.endContainer : r.endContainer.parentNode).closest('.tx');
  if (!txA || txA !== txB) return null;
  const p = txA.closest('p[data-i]'); if (!p) return null;
  const before = (node, off) => { const q = document.createRange(); q.setStart(txA, 0); q.setEnd(node, off); return q.toString().length; };
  const start = before(r.startContainer, r.startOffset); const end = before(r.endContainer, r.endOffset);
  const text = r.toString();
  if (!text.trim() || end <= start) return null;
  return { para: +p.dataset.i, start, end, text, rect: r.getBoundingClientRect() };
}
async function addHighlight(sel, color, noteText = '') {
  const notes = [...(S.bookState.notes || []), { type: 'hl', para: sel.para, start: sel.start, end: sel.end, color, text: noteText, quote: sel.text.slice(0, 600), time: Date.now() }]
    .sort((a, b) => a.para - b.para || (a.start || 0) - (b.start || 0));
  await saveState({ notes });
  window.getSelection().removeAllRanges();
  rerenderPara(sel.para);
  toast(noteText ? 'Highlight and note saved' : 'Highlighted');
}
function rerenderPara(i) {
  for (const box of ['#text', '#pages']) {
    const el = $(`${box} p[data-i="${i}"] .tx`); if (!el) continue;
    const seg = S.segs[S.segIdx];
    el.innerHTML = seg && seg[0] === i ? paraHTML(i, seg[1], seg[2]) : paraHTML(i);
  }
}
function showSelBubble() {
  const b = $('#selBubble');
  const sel = selectionInPara();
  if (!sel || S.view !== 'reader') { b.hidden = true; return; }
  const words = sel.text.trim().split(/\s+/).length;
  b.innerHTML = (words <= 3 ? `<button data-a="define">Define</button>` : '') +
    Object.keys(HL_COLORS).map((c) => `<button data-a="hl" data-c="${c}" class="sw sw-${c}" title="Highlight ${HL_COLORS[c].toLowerCase()}"></button>`).join('') +
    `<button data-a="note">Note</button>`;
  b.style.left = Math.max(8, Math.min(innerWidth - 260, sel.rect.left)) + 'px';
  b.style.top = Math.max(8, sel.rect.top - 40) + 'px';
  b.hidden = false;
  b.onmousedown = (e) => e.preventDefault(); // keep the selection
  b.onclick = (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    b.hidden = true;
    if (btn.dataset.a === 'define') define(sel.text.trim().split(/\s+/)[0]);
    else if (btn.dataset.a === 'hl') addHighlight(sel, btn.dataset.c);
    else if (btn.dataset.a === 'note') {
      modal(`<h2>Note</h2><div class="muted" style="margin-bottom:8px">“${esc(sel.text.slice(0, 200))}”</div><textarea id="hlNote" rows="4" placeholder="Your note"></textarea>`,
        [['Cancel'], ['Save', () => addHighlight(sel, 'yellow', $('#hlNote').value.trim()), true]]);
      setTimeout(() => $('#hlNote').focus(), 0);
    }
  };
}

// ---------- footnote pop-ups ----------
const FN_DEF = /^\s*\[?(?:Footnote\s+)?(\d{1,3}|[*†‡])(?:\]|:|\.|\))\s*/i;
function footnoteText(n, from) {
  if (!S.fnDefs) {
    S.fnDefs = new Map();
    S.paras.forEach((p, i) => { const m = FN_DEF.exec(p); if (m && p.length > m[0].length + 3) { const k = m[1]; if (!S.fnDefs.has(k)) S.fnDefs.set(k, []); S.fnDefs.get(k).push(i); } });
  }
  const list = (S.fnDefs.get(n) || []).filter((i) => i !== from);
  const i = list.find((x) => x > from) ?? list[list.length - 1];
  if (i === undefined) return null;
  return { para: i, text: S.paras[i].replace(FN_DEF, '').replace(/\]\s*$/, '') };
}
function showFootnote(a) {
  const n = a.dataset.n; const from = +a.closest('p[data-i]').dataset.i;
  const f = footnoteText(n, from);
  const pop = $('#fnPop'); const r = a.getBoundingClientRect();
  pop.innerHTML = f ? `<div class="fn-n">Note ${esc(n)}</div><div>${esc(f.text)}</div><button data-go="${f.para}">Go to note</button>`
    : `<div class="fn-n">Note ${esc(n)}</div><div class="muted">This book's note text couldn't be found.</div>`;
  pop.hidden = false;
  pop.style.left = Math.max(8, Math.min(innerWidth - 380, r.left - 20)) + 'px';
  pop.style.top = (r.bottom + 8 + 200 > innerHeight ? Math.max(8, r.top - 210) : r.bottom + 8) + 'px';
  const go = pop.querySelector('[data-go]'); if (go) go.onclick = () => { pop.hidden = true; jumpTo(+go.dataset.go, false); };
}

// ---------- export highlights & notes ----------
function exportNotes() {
  const notes = (S.bookState.notes || []).slice().sort((a, b) => a.para - b.para || (a.start || 0) - (b.start || 0));
  if (!notes.length) { toast('No bookmarks, highlights or notes in this book yet.'); return; }
  let md = `# ${S.book.title}\n${S.book.author ? `*${S.book.author}*\n` : ''}\nHighlights and notes exported from Shelf Reader on ${new Date().toLocaleDateString()}.\n`;
  let lastCh = null;
  for (const n of notes) {
    const ch = chapterTitle(n.para) || '';
    if (ch !== lastCh) { md += `\n## ${ch || 'Beginning'}\n`; lastCh = ch; }
    if (n.type === 'hl') md += `\n> ${(n.quote || S.paras[n.para].slice(n.start, n.end)).replace(/\n/g, ' ')}\n` + (n.text ? `\n**Note:** ${n.text}\n` : '');
    else if (n.text) md += `\n**Note** (on “${S.paras[n.para].slice(0, 80)}…”): ${n.text}\n`;
    else md += `\n🔖 Bookmark: “${S.paras[n.para].slice(0, 120)}…”\n`;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `${S.book.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)} - notes.md`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('Exported your highlights and notes');
}

// ---------- page flip ----------
function flipFrame(dir, mid) {
  const frame = $('#pageFrame');
  const persp = 'perspective(1800px)';
  const a1 = frame.animate([{ transform: `${persp} rotateY(0deg)` }, { transform: `${persp} rotateY(${-dir * 90}deg)`, filter: 'brightness(.7)' }], { duration: 170, easing: 'ease-in' });
  a1.onfinish = () => {
    mid();
    frame.animate([{ transform: `${persp} rotateY(${dir * 90}deg)`, filter: 'brightness(.7)' }, { transform: `${persp} rotateY(0deg)` }], { duration: 190, easing: 'ease-out' });
  };
}

// ---------- reading stats ----------
const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let lastActivity = 0;
['keydown', 'wheel', 'mousedown'].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (!S.book) return;
  const listen = S.playing ? 30 : 0;
  const read = !S.playing && S.view === 'reader' && Date.now() - lastActivity < 120000 && document.visibilityState === 'visible' ? 30 : 0;
  if (listen || read) api('/api/stats/add', { method: 'POST', json: { day: todayKey(), listen, read } }).catch(() => {});
}, 30000);

async function showStats() {
  let st; try { st = await api('/api/stats'); } catch (e) { toast(e.message); return; }
  const days = st.days || {};
  const mins = (k) => Math.round(((days[k] || {}).read || 0) / 60 + ((days[k] || {}).listen || 0) / 60);
  const goal = st.goal || 30;
  const today = mins(todayKey());
  let streak = 0;
  for (let d = new Date(); ; d.setDate(d.getDate() - 1)) { if (mins(todayKey(d)) >= 1) streak++; else if (todayKey(d) !== todayKey()) break; if (streak > 3650) break; }
  const last14 = []; for (let k = 13; k >= 0; k--) { const d = new Date(); d.setDate(d.getDate() - k); last14.push([todayKey(d), d]); }
  const max = Math.max(goal, ...last14.map(([k]) => mins(k)));
  const year = new Date().getFullYear();
  const finished = (st.finished || []).filter((f) => String(f.date || '').startsWith(String(year)));
  const total = Object.keys(days).reduce((a, k) => a + mins(k), 0);
  modal(`<h2>Reading stats</h2>
    <div class="stat-row"><div><div class="big">${today}<span class="muted"> / ${goal} min</span></div><div class="muted">today</div></div>
      <div><div class="big">${streak}</div><div class="muted">day streak</div></div>
      <div><div class="big">${finished.length}</div><div class="muted">finished in ${year}</div></div>
      <div><div class="big">${total >= 120 ? Math.round(total / 60) + ' h' : total + ' min'}</div><div class="muted">all time</div></div></div>
    <div class="goalbar"><div style="width:${Math.min(100, today * 100 / goal)}%"></div></div>
    <h3>Last two weeks</h3>
    <div class="bars">${last14.map(([k, d]) => `<div class="bar" title="${k}: ${mins(k)} min"><div style="height:${Math.round(mins(k) * 100 / max)}%" class="${mins(k) >= goal ? 'met' : ''}"></div><span>${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span></div>`).join('')}</div>
    <div class="setrow"><label>Daily goal</label><select id="goalSel">${[10, 15, 20, 30, 45, 60, 90, 120].map((g) => `<option value="${g}" ${g === goal ? 'selected' : ''}>${g} minutes</option>`).join('')}</select></div>
    <h3>Finished in ${year}</h3>
    ${finished.length ? finished.slice().reverse().map((f) => `<div class="fix"><span style="flex:1"><b>${esc(f.title)}</b> <span class="muted">${esc(f.author || '')}</span></span><span class="muted">${esc(String(f.date).slice(0, 10))}</span></div>`).join('') : '<p class="muted">Books you finish (by listening to the end, or with Collections → Finished) show up here.</p>'}`,
  [['Close', null, true]]);
  $('#goalSel').onchange = (e) => api('/api/stats/goal', { method: 'PUT', json: { goal: +e.target.value } }).then(showStats);
}

// ---------- night schedule ----------
function nightActive() {
  const n = S.settings.night;
  if (!n || !n.on) return false;
  const now = new Date(); const cur = now.getHours() * 60 + now.getMinutes();
  const t = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const a = t(n.from || '21:00'); const b = t(n.to || '07:00');
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}
function effectiveTheme() { return nightActive() ? (S.settings.night.theme ?? 3) : (S.settings.theme || 0); }
let lastTheme = null;
setInterval(() => { if (S.settings && effectiveTheme() !== lastTheme) applyAppearance(); }, 60000);

// ---------- "last time" recap ----------
function showRecap(prevOpened) {
  const box = $('#recap');
  box.hidden = true;
  if (!S.book || !prevOpened || Date.now() - prevOpened < 3600e3) return;
  const i = Math.max(0, S.segIdx - 1);
  if (S.segIdx <= 0) return;
  const [pi, a, b] = S.segs[i];
  const sentence = S.paras[pi].slice(a, b);
  const when = Date.now() - prevOpened < 2 * 86400e3 ? (new Date(prevOpened).getDate() === new Date().getDate() ? 'earlier today' : 'yesterday') : new Date(prevOpened).toLocaleDateString();
  box.innerHTML = `<div class="rc-t">Last time (${esc(when)}) · ${esc(chapterTitle(pi) || S.book.title)}</div>
    <div class="rc-s">“${esc(sentence.length > 180 ? sentence.slice(0, 180) + '…' : sentence)}”</div>
    <div class="rc-b"><button class="primary" id="rcGo">▶ Continue listening</button><button id="rcX">Dismiss</button></div>`;
  box.hidden = false;
  $('#rcGo').onclick = () => { box.hidden = true; play(); };
  $('#rcX').onclick = () => { box.hidden = true; };
  setTimeout(() => { box.hidden = true; }, 20000);
}

// ---------- phone ↔ PC sync (settings) ----------
async function syncSettingsHTML() {
  let s = {}; try { s = await api('/api/sync'); } catch (_) {}
  return s.folder
    ? `<p>Syncing with <span class="muted">${esc(s.folder)}</span>${s.last ? ` · last synced ${new Date(s.last).toLocaleTimeString()}` : ''}${s.error ? `<br><span style="color:#e06c6c">${esc(s.error)}</span>` : ''}</p>
       <div class="setrow"><button id="syNow">Sync now</button><button id="syPick">Change folder…</button><button class="danger" id="syOff">Turn off</button></div>`
    : `<p class="muted">Keep your place, bookmarks, highlights, notes, collections and stats the same on your phone and PC. Pick a folder inside <b>Google Drive</b> or <b>OneDrive</b> on this PC, and on your phone choose the same <b>ShelfReader-sync.json</b> file (Menu → Sync with PC). Books themselves aren't copied; add them on both devices or use backup &amp; restore.</p>
       <div class="setrow"><button id="syPick" class="primary">Choose sync folder…</button></div>`;
}
function bindSyncSettings(reopen) {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('#syPick', async () => { try { const r = await api('/api/sync/setup', { method: 'POST' }); if (r.folder) toast('Sync is on'); await afterSync(); reopen(); } catch (e) { toast(e.message, 7000); } });
  on('#syNow', async () => { try { await api('/api/sync/now', { method: 'POST' }); toast('Synced'); await afterSync(); reopen(); } catch (e) { toast(e.message, 7000); } });
  on('#syOff', async () => { await api('/api/sync/off', { method: 'POST' }); reopen(); });
}
async function afterSync() {
  S.settings = await api('/api/settings');
  if (S.book) { try { const d = await api('/api/state/' + S.book.id); S.bookState = d; } catch (_) {} }
  if (S.view === 'library') renderLibrary();
}
