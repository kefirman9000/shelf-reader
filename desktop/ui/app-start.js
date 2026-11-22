'use strict';
// Shelf Reader PC app, part 5 of 5 (split from app.js to keep files a readable size).
// The parts share one scope and load in order (see the <script> tags); start-up code is in the last part.

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
    <label class="check"><input type="checkbox" id="uBeta" ${S.settings.betaUpdates ? 'checked' : ''}> Beta updates: get every new build straight away. Off (Stable): only builds that passed every test.</label>
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
  const bt = $('#uBeta'); if (bt) bt.onchange = async () => { await saveSettings({ betaUpdates: bt.checked }); api('/api/update/check', { method: 'POST' }).then(() => renderUpdateBox && renderUpdateBox()).catch(() => {}); };
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


// Find books: suggestions so the page doesn't start empty
(function suggestions() {
  const box = document.createElement('div');
  box.id = 'suggest';
  const picks = ['Jane Austen', 'Sherlock Holmes', 'Mark Twain', 'Agatha Christie', 'Jules Verne', 'Fairy tales', 'Ghost stories', 'Charles Dickens', 'Poetry', 'Philosophy', 'Science fiction', 'Mythology'];
  box.innerHTML = '<span class="muted small">Try:</span> ' + picks.map((p) => `<button class="chip" data-q="${esc(p)}">${esc(p)}</button>`).join('');
  $('#searchStatus').after(box);
  box.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => { $('#q').value = b.dataset.q; runSearch(b.dataset.q); }; });
  const obs = new MutationObserver(() => { box.hidden = $('#results').children.length > 0; });
  obs.observe($('#results'), { childList: true });
})();


// ---------- stall watchdog ----------
// Reading moves on only when the voice says a sentence finished. If it never does (a voice silently dropping
// text, an audio element that stalls, a stuck generator), the watchdog notices and carries on.
function watch(ms) { S.wdAt = Date.now(); S.wdMs = ms; }
setInterval(() => {
  if (!S.playing || !S.wdAt || Date.now() - S.wdAt <= S.wdMs) return;
  S.stalls = (S.stalls || 0) + 1; S.stallsTotal = (S.stallsTotal || 0) + 1;
  const at = S.segIdx;
  const txt = S.segs[at] ? S.paras[S.segs[at][0]].slice(S.segs[at][1], S.segs[at][2]) : '';
  note(`STALL #${S.stalls} at sentence ${at + 1} (no word from the voice for ${Math.round(S.wdMs / 1000)}s): "${txt.slice(0, 160)}"`);
  S.wdAt = 0;
  S.token++; const tok = S.token;
  try { speechSynthesis.cancel(); } catch (_) {}
  AUD.el.onended = null; AUD.el.onerror = null; AUD.el.pause(); AUD.cache.clear();
  if (S.stalls >= 3) { pause(); toast('Reading keeps getting stuck here. Try another voice, or use Settings → Report a problem so it can be fixed.', 10000); return; }
  if (S.stalls >= 2) S.segIdx = ((S.segLastFor || {})[at] ?? at) + 1;   // still stuck: skip it
  if (S.segIdx >= S.segs.length) { finished(); return; }
  afterMove(); speakNext(tok);
}, 2000);

// ---------- event log, crash log and "Report a problem" ----------
const EVENTS = (() => { try { return JSON.parse(localStorage.getItem('events') || '[]'); } catch (_) { return []; } })();
function note(msg) {
  EVENTS.push(new Date().toTimeString().slice(0, 8) + ' ' + String(msg).slice(0, 300));
  while (EVENTS.length > 60) EVENTS.shift();
  try { localStorage.setItem('events', JSON.stringify(EVENTS)); } catch (_) {}
  console.info('[ShelfReader]', msg);
}
window.addEventListener('error', (e) => note(`ERROR ${e.message} at ${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => note(`ERROR (promise) ${e.reason && (e.reason.stack || e.reason.message) || e.reason}`.slice(0, 600)));

function visibleChars(s) {
  return String(s).replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2060\uFEFF\uFFFD\uE000-\uF8FF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    (c) => '<U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '>');
}
async function problemReport(what) {
  const info = await fetch('/api/info').then((r) => r.json()).catch(() => ({}));
  const crash = await fetch('/api/crashlog').then((r) => r.ok ? r.text() : '').catch(() => '');
  const L = [];
  L.push(`Shelf Reader ${info.version || ''} (Windows app) · ${navigator.userAgent.match(/Windows NT [\d.]+|Mac OS X [\d_]+|Linux/)?.[0] || ''}`, '');
  L.push('What happened: ' + (what || '(not described)'), '');
  if (S.book) {
    L.push(`Book: ${S.book.title} (${S.book.id})`);
    L.push(`Sentence ${S.segIdx + 1} of ${S.segs.length}, playing: ${!!S.playing}, loading voice: ${!!S.loadingVoice}`);
    L.push(`Voice: ${currentVoiceName() || 'default'} (${engineOf(currentVoiceName())}) · speed ${currentRate()}`);
    L.push(`Stalls: ${S.stalls || 0} now, ${S.stallsTotal || 0} this session · voice errors in a row: ${S.speechErrors || 0}`);
    for (let d = -1; d <= 2; d++) {
      const k = S.segIdx + d; const sg = S.segs[k]; if (!sg) continue;
      const raw = S.paras[sg[0]].slice(sg[1], sg[2]);
      let said; try { said = (segItems(k) || []).map((x) => x.t).join(' | '); } catch (e) { said = 'ERROR ' + e.message; }
      L.push(`${d === 0 ? '▶' : ' '} [${k + 1}] book: "${visibleChars(raw.slice(0, 400))}"`);
      L.push(`        said: ${said ? '"' + visibleChars(said.slice(0, 400)) + '"' : '(skipped)'}`);
    }
  }
  const st = S.settings || {};
  L.push('', `Settings: natural pauses ${st.naturalPauses !== false}, say numbers ${st.speakNumbers !== false}, fix broken lines ${st.fixBrokenLines !== false}, skip clutter ${st.skipClutter !== false}`);
  L.push('', 'Recent events:', EVENTS.join('\n') || '(none)');
  if (crash) L.push('', 'Crash log:', crash.slice(-6000));
  return L.join('\n');
}
async function reportProblem() {
  const what = () => ($('#rpWhat') || {}).value || '';
  modal(`<h2>Report a problem</h2>
    <p class="muted">Makes a report with the book's name, the sentence it's on, the voice and settings, and what the app did recently. Nothing is sent anywhere: you save or copy it and send it yourself.</p>
    <textarea id="rpWhat" rows="3" style="width:100%" placeholder="What went wrong? (e.g. it stopped reading here)"></textarea>`, [
    ['Cancel'],
    ['Copy', async () => { await navigator.clipboard.writeText(await problemReport(what())); toast('Report copied'); }],
    ['Save report…', async () => {
      const blob = new Blob([await problemReport(what())], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'ShelfReader-report-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt'; a.click();
      toast('Report saved to your Downloads folder');
    }, true]]);
}
