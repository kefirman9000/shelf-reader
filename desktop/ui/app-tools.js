'use strict';
// Shelf Reader PC app, part 4 of 5 (split from app.js to keep files a readable size).
// The parts share one scope and load in order (see the <script> tags); start-up code is in the last part.

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
$('#ambBtn').onclick = () => Ambience.open();
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
      if (Date.now() >= S.sleepAt) { setSleep(0); if (S.playing) pause(true); else Ambience.hush(); toast('Sleep timer: paused'); } else updatePlayer();
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
  if (e.key === ' ' && (S.book || Ambience.withoutBook())) { e.preventDefault(); toggle(); }
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
    <div class="setrow"><label>Text size</label><input type="range" id="sSize" min="13" max="40" value="${s.textSize || 19}" style="flex:1"><b id="sSizeVal" style="min-width:28px;text-align:right">${s.textSize || 19}</b></div>
    <div class="setrow"><label>Page turn</label><select id="sTurn"><option value="slide">Slide</option><option value="flip" ${s.pageTurn === 'flip' ? 'selected' : ''}>Flip</option></select></div>
    <label class="check"><input type="checkbox" id="sNight" ${s.night && s.night.on ? 'checked' : ''}> Night mode on a schedule</label>
    <div class="setrow"><label>Night mode</label>from <input type="time" id="sNightFrom" value="${esc((s.night && s.night.from) || '21:00')}"> to <input type="time" id="sNightTo" value="${esc((s.night && s.night.to) || '07:00')}">
      <select id="sNightTheme">${opt(['Dark', 'Light', 'Sepia', 'Black'], (s.night && s.night.theme) ?? 3)}</select></div>
    <h3>Reading aloud</h3>
    <div class="setrow"><button id="sVoices" class="primary">Voice options: natural &amp; premium voices…</button> <button id="sAmbience">🌧 Background sounds… (${esc(Ambience.summary())})</button> <button id="sReport">🐞 Report a problem</button></div>
    <label class="check"><input type="checkbox" id="sClutter" ${s.skipClutter !== false ? 'checked' : ''}> Skip page numbers, running headers, footnote markers, links and scan notices</label>
    <label class="check"><input type="checkbox" id="sAutoNext" ${s.autoNextBook ? 'checked' : ''}> Keep listening: when a book ends, start another (Up next first, then Want to read, then books you've started)</label>
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
  $('#sSize').oninput = (e) => { $('#text').style.fontSize = e.target.value + 'px'; $('#sSizeVal').textContent = e.target.value; };
  $('#sSize').onchange = (e) => saveSettings({ textSize: +e.target.value });
  $('#sClutter').onchange = (e) => saveSettings({ skipClutter: e.target.checked }).then(() => { if (S.playing) speakFrom(S.segIdx); });
  $('#sAutoNext').onchange = (e) => saveSettings({ autoNextBook: e.target.checked });
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
  $('#sAmbience').onclick = () => { $('#modal').hidden = true; Ambience.open(); };
  $('#sReport').onclick = () => reportProblem();
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
