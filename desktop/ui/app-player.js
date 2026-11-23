'use strict';
// Shelf Reader PC app, part 3 of 5 (split from app.js to keep files a readable size).
// The parts share one scope and load in order (see the <script> tags); start-up code is in the last part.

// ---------- speech ----------
function loadVoices() {
  S.voices = speechSynthesis.getVoices();
  fillVoiceSelect();
}
speechSynthesis.onvoiceschanged = loadVoices;
// ---------- friendly voice names ----------
const COUNTRY = { US: 'US', GB: 'UK', AU: 'Australia', IN: 'India', CA: 'Canada', IE: 'Ireland', NZ: 'New Zealand', ZA: 'South Africa',
  SG: 'Singapore', PH: 'Philippines', HK: 'Hong Kong', KE: 'Kenya', NG: 'Nigeria', TZ: 'Tanzania', MX: 'Mexico', ES: 'Spain', FR: 'France', DE: 'Germany', BR: 'Brazil', PT: 'Portugal' };
let langNames = null;
function langLabel(tag) {
  const [l, c] = String(tag || '').split(/[-_]/);
  if (!langNames) { try { langNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (_) { langNames = { of: (x) => x }; } }
  let ln = l; try { ln = langNames.of(l) || l; } catch (_) {}
  return c ? `${ln} (${COUNTRY[c.toUpperCase()] || c.toUpperCase()})` : ln;
}
// Common Microsoft voice first names → gender (Windows and Edge "Natural" voices)
const MS_FEMALE = new Set(['aria', 'jenny', 'michelle', 'ana', 'ava', 'emma', 'sonia', 'libby', 'maisie', 'natasha', 'clara', 'neerja', 'emily', 'molly', 'leah', 'zira', 'hazel', 'susan', 'heera', 'linda', 'catherine', 'sara', 'nancy', 'jane', 'amber', 'ashley', 'cora', 'elizabeth', 'monica', 'luna', 'rosa', 'yan', 'sam', 'abbi', 'bella', 'hollie', 'olivia', 'annette', 'carly', 'elsie', 'freya', 'joanne', 'kim', 'tina', 'asilia', 'ezinne', 'imani', 'luna', 'mia', 'nova']);
const MS_MALE = new Set(['guy', 'christopher', 'eric', 'roger', 'steffan', 'andrew', 'brian', 'davis', 'ryan', 'william', 'liam', 'prabhat', 'connor', 'mitchell', 'luke', 'david', 'mark', 'george', 'ravi', 'richard', 'sean', 'james', 'jacob', 'jason', 'tony', 'brandon', 'alfie', 'elliot', 'ethan', 'noah', 'oliver', 'thomas', 'darren', 'duncan', 'ken', 'neil', 'tim', 'abeo', 'chilemba', 'elimu', 'wayne', 'kai']);
function voiceLabel(name, lang, extraGender) {
  const n = String(name || '');
  const where = langLabel(lang);
  const g = (x) => (x ? ' · ' + x : '');
  let m = /^Google\s+(.*?)(?:\s+(Female|Male))?$/i.exec(n);
  if (m) {
    // Chrome's voices: "Google US English" is a female voice; UK ones say so in the name
    const gender = m[2] || (/^en-US$/i.test(lang) ? 'Female' : '');
    return `Google · ${where}${g(gender)}`;
  }
  m = /^Microsoft\s+([A-Za-z]+)(?:Multilingual)?\b(.*)$/i.exec(n);
  if (m) {
    const first = m[1];
    const k = first.toLowerCase();
    const gender = extraGender || (MS_FEMALE.has(k) ? 'Female' : MS_MALE.has(k) ? 'Male' : '');
    const natural = /natural|online/i.test(m[2]);
    return `${first} · ${where}${g(gender)}${natural ? ' · Natural ★' : ''}`;
  }
  return `${n.replace(/\s*-\s*[^-]+$/, '')}${where ? ' · ' + where : ''}${g(extraGender)}`;
}
function voiceName(v) { return voiceLabel(v.name, v.lang); }
const isGreatVoice = (v) => /natural|^google/i.test(v.name);
function agoDate(t) {
  const d = Math.floor((Date.now() - t) / 86400000);
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString();
}
function fillVoiceSelect() {
  const sel = $('#voiceSel'); if (!sel) return;
  const lang = (navigator.language || 'en').slice(0, 2);
  const vs = S.voices.filter((v) => v.lang.toLowerCase().startsWith(lang))
    .sort((a, b) => (isGreatVoice(b) - isGreatVoice(a)) || voiceName(a).localeCompare(voiceName(b)));
  const others = S.voices.filter((v) => !vs.includes(v));
  const cur = currentVoiceName();
  const extra = extraVoiceOptions();
  const extraHtml = extra.map(([label, items]) => `<optgroup label="${esc(label)}">${items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</optgroup>`).join('');
  const def = S.voices.find((v) => v.default) || S.voices[0];
  sel.innerHTML = `<option value="">${def ? 'Default: ' + esc(voiceName(def)) : 'Choose a voice…'}</option><option value="__more">＋ More natural &amp; premium voices…</option>` + extraHtml +
    `<optgroup label="${/Electron/.test(navigator.userAgent) ? 'Windows voices' : 'Browser voices'}">` +
    vs.map((v) => `<option value="${esc(v.name)}">${esc(voiceName(v))}</option>`).join('') +
    '</optgroup>' +
    (others.length ? `<optgroup label="Other languages">${others.map((v) => `<option value="${esc(v.name)}">${esc(voiceName(v))}</option>`).join('')}</optgroup>` : '');
  const known = [...sel.options].some((o) => o.value === cur);
  sel.value = known ? cur : '';
}
const currentVoiceName = () => (S.bookState && S.bookState.voice !== undefined ? S.bookState.voice : S.settings.voice) || '';
const currentRate = () => (S.bookState && S.bookState.rate) || S.settings.rate || 1;
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
$('#rateSel').innerHTML = RATES.map((r) => `<option value="${r}">${r}×</option>`).join('');
$('#rateSel').onchange = async (e) => {
  const r = +e.target.value;
  await saveState({ rate: r }); saveSettings({ rate: r });
  if (S.playing) speakFrom(S.segIdx);
};
$('#voiceSel').onchange = async (e) => {
  if (e.target.value === '__more') { fillVoiceSelect(); openVoiceOptions(); return; }
  const v = e.target.value || null;
  await saveState({ voice: v }); saveSettings({ voice: v });
  if (S.playing) speakFrom(S.segIdx);
  else previewVoice(v);
};
const PREVIEW = new Audio();
async function previewVoice(name) {
  speechSynthesis.cancel(); PREVIEW.pause();
  if (engineOf(name) !== 'browser') {
    toast(engineReady(name) ? 'Playing a sample…' : 'Loading the voice for a sample…', 4000);
    try {
      const r = await genAudio(name, 'Hello! This is how I will sound reading your book.', currentRate());
      PREVIEW.src = URL.createObjectURL(r.blob); PREVIEW.preservesPitch = true; PREVIEW.playbackRate = r.extra || 1;
      await PREVIEW.play();
    } catch (e) { toast('Couldn’t play a sample: ' + e.message, 7000); }
    return;
  }
  const u = new SpeechSynthesisUtterance('Hello! This is how I will sound reading your book.');
  const v = S.voices.find((x) => x.name === name);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = currentRate();
  speechSynthesis.speak(u);
}

function setupPlayer() {
  $('#player').hidden = false;
  $('#pTitle').textContent = S.book.title;
  $('#pCover').innerHTML = coverHtml(S.book);
  $('#rateSel').value = String(currentRate());
  fillVoiceSelect();
  updatePlayer();
  setMediaSession();
}
function updatePlayer() {
  setTimeout(updateLeft, 0);
  if (!S.book) return;
  const p = curPara();
  const pct = S.paras.length ? Math.floor((p + 1) * 100 / S.paras.length) : 0;
  const parts = [S.playing ? (S.loadingVoice ? 'Loading voice…' : 'Reading') : 'Paused'];
  const ch = chapterTitle(p); if (ch) parts.push(ch);
  parts.push(pct + '%');
  if (S.sleepChapter) parts.push('sleep at chapter end');
  else if (S.sleepAt) parts.push(`sleep in ${Math.max(1, Math.ceil((S.sleepAt - Date.now()) / 60000))} min`);
  const pn = S.pendingNext && bookById(S.pendingNext.id);
  $('#pStatus').textContent = pn ? `Finished 🎉 · next: “${pn.title}” in a moment · ■ to stop it` : parts.join(' · ');
  $('#pPlay').textContent = pn ? '■' : S.playing ? '❚❚' : '▶';
  if (!S.seeking) $('#seek').value = S.paras.length ? Math.round(p * 100 / Math.max(1, S.paras.length - 1)) : 0;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
}
function savePos(force) {
  const seg = S.segs[S.segIdx]; if (!seg || !S.book) return;
  const now = Date.now();
  if (!force && now - S.lastSave < 2500) return;
  S.lastSave = now;
  api('/api/state/' + S.book.id, { method: 'PUT', json: { pos: seg[0], off: seg[1] } }).then((st) => { S.bookState = st; }).catch(() => {});
}

function play() {
  if (S.pendingNext) { startPendingNext(); return; }
  if (!S.book || !S.segs.length) return;
  S.playing = true;
  keepAlive(true);
  Ambience.reading(true);
  $('#pages').classList.add('listening');
  speakFrom(S.segIdx);
  updatePlayer();
  if (S.view === 'library') renderLibrary();
}
function pause() {
  if (cancelPendingNext()) return;
  if (!S.playing) { updatePlayer(); return; }
  S.playing = false; S.token++;
  Ambience.reading(false);
  speechSynthesis.cancel();
  stopAudio();
  keepAlive(false);
  $('#pages').classList.remove('listening');
  savePos(true);
  updatePlayer();
  if (S.view === 'library') renderLibrary();
}
function toggle() { if (cancelPendingNext()) return; S.playing ? pause() : play(); }
function speakFrom(i) {
  const token = ++S.token;
  speechSynthesis.cancel();
  stopAudio();
  S.segIdx = Math.max(0, Math.min(i, S.segs.length - 1));
  setTimeout(() => { if (token === S.token) speakNext(token); }, 60);
}
function speakNext(token) {
  if (token !== S.token || !S.playing) return;
  // skip pieces that shouldn't be read aloud
  let items = null;
  while (S.segIdx < S.segs.length) {
    items = segItems(S.segIdx);
    if (items) break;
    S.segIdx++;
  }
  if (!items) { finished(); return; }
  S.items = items; S.segStartAt = Date.now();
  const vid = currentVoiceName();
  if (engineOf(vid) === 'browser') browserSpeak(token, items, 0);
  else audioSpeak(token, vid, items.map((x) => x.t).join(' '));
}
const natural = () => S.settings.naturalPauses !== false;
/** Classes for paragraph i: a chapter start, or part of a sentence the book broke across lines (shown as one paragraph). */
function paraClass(i, chapStarts) {
  if (chapStarts.has(i)) return ' class="chap"';
  const c = [];
  if (S.cont && S.cont[i]) c.push('cont');
  if (S.cont && S.cont[i + 1]) c.push('runs');
  return c.length ? ` class="${c.join(' ')}"` : '';
}
/** S.cont[i]: paragraph i is the rest of a sentence the book broke off at the end of paragraph i-1. */
function computeCont() {
  const on = S.settings.fixBrokenLines !== false;
  S.lineLen = on ? SpeechText.lineLength(S.paras) : 0;
  S.cont = S.paras.map((p, i) => on && i > 0 && SpeechText.continues(S.paras[i - 1], p, S.lineLen));
}
const isClutterPara = (pi) => S.settings.skipClutter !== false && (S.skipParas?.has(pi) || S.headers?.has(S.paras[pi]) || SpeechText.isPageNumber(S.paras[pi]));
/** What to say for a sentence, split into pieces with the pause after each (see speechtext.js). */
function segItems(i) {
  const [pi, a, b] = S.segs[i];
  const ci = chapterIndex(pi); const ch = ci >= 0 ? S.chapters[ci] : null;
  if (ch && ch.para === pi && natural() && SpeechText.isHeadingOf(S.paras[pi], ch.title)) {
    // a chapter heading is announced like an audiobook: "Chapter Twelve." … "The Storm." …
    return a === 0 ? SpeechText.chapterOpening(ch.title) : null;
  }
  let t = spoken(S.paras[pi].slice(a, b), pi);
  if (!t) return null;
  // a sentence the book broke across lines is read as one
  S.segLastFor = S.segLastFor || {};
  let last = i;
  if (S.settings.fixBrokenLines !== false) {
    for (;;) {
      const cur = S.segs[last];
      if (cur[2] < S.paras[cur[0]].trimEnd().length) break;
      let j = last + 1;
      while (j < S.segs.length && S.segs[j][0] !== cur[0] && isClutterPara(S.segs[j][0])) j++;
      if (j >= S.segs.length || S.segs[j][1] !== 0 || S.segs[j][0] === cur[0]) break;
      if (!SpeechText.continues(S.paras[cur[0]], S.paras[S.segs[j][0]], S.lineLen || 0)) break;
      const more = spoken(S.paras[S.segs[j][0]].slice(S.segs[j][1], S.segs[j][2]), S.segs[j][0]);
      if (!more) break;
      t = SpeechText.joinText(t, more); last = j;
      if (t.length > 1500) break;
    }
  }
  S.segLastFor[i] = last;
  const browser = engineOf(currentVoiceName()) === 'browser';
  const raw = !natural() ? [{ t, gap: 0 }] : browser ? SpeechText.pieces(t) : [{ t, gap: SpeechText.endPause(t) }];
  return safeItems(raw, browser ? 200 : 900);
}
/** Pieces no voice will choke on: cleaned, nothing without words, none too long. (Browser voices can silently stop
 *  on long text and never say they finished, so theirs are kept short.) Null when nothing is left to say. */
function safeItems(items, max) {
  const out = [];
  for (const it of items || []) {
    const parts = SpeechText.chunks(SpeechText.clean(it.t), max);
    parts.forEach((t, j) => out.push({ t, gap: j === parts.length - 1 ? it.gap : 120 }));
  }
  return out.length ? out : null;
}
/** How long to wait after a sentence: by its punctuation, plus more at paragraph and chapter ends. */
function gapAfter(k) {
  if (!natural()) return 0;
  const it = S.items || [];
  let g = it.length ? it[it.length - 1].gap : 280;
  k = (S.segLastFor || {})[k] ?? k;
  const seg = S.segs[k], nx = S.segs[k + 1];
  if (seg && nx && nx[0] !== seg[0]) g += 260;
  if (seg && nx && chapterIndex(nx[0]) !== chapterIndex(seg[0])) g += 900;
  const browser = engineOf(currentVoiceName()) === 'browser';
  return SpeechText.vary(Math.max(0, g / currentRate() - (browser ? 140 : 40)));
}
/** A tiny, steady change of pace from paragraph to paragraph (±2%), so long listening doesn't sound mechanical. */
const paceFor = (pi) => (natural() ? 1 + (((pi * 7919) % 41) - 20) / 1000 : 1);

/** Called when a sentence finishes, whatever voice engine read it. */
function segDone(token) {
  if (token !== S.token) return;
  S.stalls = 0;
  const wait = gapAfter(S.segIdx);
  if (wait > 0) setTimeout(() => segAdvance(token), wait); else segAdvance(token);
}
function segAdvance(token) {
  if (token !== S.token || !S.playing) return;
  const k = S.segIdx; const next = ((S.segLastFor || {})[k] ?? k) + 1;
  if (S.sleepChapter && next < S.segs.length && chapterIndex(S.segs[next][0]) !== chapterIndex(S.segs[k][0])) {
    S.sleepChapter = false; S.segIdx = next; pause(); setSleep(0); return;
  }
  S.segIdx = next;
  if (S.segIdx >= S.segs.length) { finished(); return; }
  afterMove(); speakNext(token);
}
function speechFailed(token, message) {
  S.speechErrors = (S.speechErrors || 0) + 1;
  note(`voice error #${S.speechErrors} at sentence ${S.segIdx + 1}${message ? ': ' + message : ''}`);
  if (S.speechErrors >= 3) {
    pause();
    toast((message ? message + ' ' : 'This voice isn’t working. ') + 'Try another voice from the menu at the bottom right.', 9000);
    return;
  }
  S.segIdx++; afterMove(); speakNext(token);
}

function browserSpeak(token, items, k) {
  const u = new SpeechSynthesisUtterance(items[k].t);
  const v = S.voices.find((x) => x.name === currentVoiceName());
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = currentRate() * paceFor(S.segs[S.segIdx][0]);
  const allow = () => items[k].t.length * 85 / Math.max(0.3, u.rate) + 10000;
  u.onstart = () => { S.speechErrors = 0; watch(allow()); };
  u.onend = () => {
    if (token !== S.token) return;
    watch(allow() + 3000);
    if (k + 1 < items.length) {
      const wait = SpeechText.vary(Math.max(0, items[k].gap / currentRate() - 140));
      setTimeout(() => { if (token === S.token && S.playing) browserSpeak(token, items, k + 1); }, wait);
    } else segDone(token);
  };
  u.onerror = (ev) => {
    if (token !== S.token || ev.error === 'interrupted' || ev.error === 'canceled') return;
    speechFailed(token);
  };
  S.utter = u; // keep a reference so the browser doesn't drop the callbacks
  if (k === 0) afterMove();
  watch(allow() + 5000);
  speechSynthesis.speak(u);
}

// Kokoro / Piper / cloud: generate audio for each sentence, a couple of sentences ahead.
const AUD = { el: new Audio(), cache: new Map() };
function segSpoken(i) { const it = segItems(i); return it ? it.map((x) => x.t).join(' ') : null; }
function audioFor(i, vid, rate, text) {
  const key = `${i}|${vid}|${rate}`;
  let p = AUD.cache.get(key);
  if (!p) { p = genAudio(vid, text, rate); p.catch(() => {}); AUD.cache.set(key, p); }
  return p;
}
async function audioSpeak(token, vid, text) {
  const rate = currentRate(); const i = S.segIdx;
  afterMove();
  const p = audioFor(i, vid, rate, text);
  let j = i + 1; let n = 0;
  while (j < S.segs.length && n < 2) { const t = segSpoken(j); if (t) { audioFor(j, vid, rate, t); n++; } j++; }
  for (const key of [...AUD.cache.keys()]) { const idx = +key.split('|')[0]; if (idx < i || idx > j) AUD.cache.delete(key); }
  const loading = !engineReady(vid);
  if (loading) { S.loadingVoice = true; updatePlayer(); }
  // making the audio may not take forever: a first-time voice download gets 10 minutes, otherwise 90 seconds
  const limit = loading ? 600000 : 90000;
  watch(limit + 5000);
  let r;
  try {
    r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), limit))]);
  } catch (e) {
    if (e.message === 'timeout') {
      AUD.cache.delete(`${i}|${vid}|${rate}`);
      note(`voice took too long to make sentence ${i + 1} (${vid})`);
      if (token === S.token) { S.loadingVoice = false; updatePlayer(); speechFailed(token, 'The voice took too long.'); }
      return;
    }
    S.loadingVoice = false; updatePlayer();
    if (token !== S.token || e.message === 'dropped') return;
    speechFailed(token, e.message.length < 160 ? e.message + '.' : '');
    return;
  }
  S.loadingVoice = false;
  if (token !== S.token) return;
  S.speechErrors = 0;
  const url = URL.createObjectURL(r.blob);
  const a = AUD.el;
  a.src = url; a.preservesPitch = true; a.playbackRate = Math.max(0.25, Math.min(4, r.extra || 1));
  a.onended = () => { URL.revokeObjectURL(url); segDone(token); };
  a.onloadedmetadata = () => { if (token === S.token && isFinite(a.duration)) watch(a.duration / a.playbackRate * 1000 + 10000); };
  watch(text.length * 85 / Math.max(0.3, rate) + 15000);
  a.onerror = () => { URL.revokeObjectURL(url); if (token === S.token) speechFailed(token); };
  updatePlayer();
  a.play().catch((err) => { if (token === S.token) { pause(); toast('Couldn’t play audio: ' + err.message, 6000); } });
}
function stopAudio() {
  AUD.el.onended = null; AUD.el.onerror = null; AUD.el.pause();
  AUD.cache.clear();
  flushEngines();
  S.loadingVoice = false;
}
function afterMove() {
  highlight(); updatePlayer(); savePos(false);
  const ci = chapterIndex(curPara());
  if (ci !== S.mediaCh) { S.mediaCh = ci; setMediaSession(); }
}
async function finished() {
  S.playing = false; S.token++; keepAlive(false); stopAudio();
  Ambience.reading(false);
  $('#pages').classList.remove('listening');
  S.segIdx = Math.max(0, S.segs.length - 1);
  savePos(true); updatePlayer();
  const done = S.book;
  try {
    const cols = new Set(S.bookState.collections || []); cols.add('Finished'); cols.delete('Want to read');
    await saveState({ collections: [...cols] });
  } catch (e) { note('could not mark the book finished: ' + e.message); }
  api('/api/stats/finished', { method: 'POST', json: { id: done.id, title: done.title, author: done.author } }).catch(() => {});
  // Up next first; with "Keep listening" on, another book from the library
  const q = (S.settings.queue || []).filter((id) => id !== done.id && bookById(id));
  const next = q.length ? bookById(q[0]) : S.settings.autoNextBook ? nextBookAfter(done.id) : null;
  if (!next) {
    toast(S.settings.autoNextBook ? `Finished “${done.title}” 🎉 That was the last unread book in your library.` : `Finished “${done.title}” 🎉`);
    return;
  }
  if (q.length) saveSettings({ queue: q.slice(1) }).catch(() => {});
  // the pause between books: Play starts the next one now, Pause or Cancel stops it
  keepAlive(true);
  S.pendingNext = { id: next.id, from: done.id, timer: setTimeout(startPendingNext, 6000) };
  toastAction(`Finished “${done.title}” 🎉 Next: “${next.title}”…`, 'Cancel', cancelPendingNext, 6000);
  updatePlayer();
}
async function startPendingNext() {
  const p = S.pendingNext; if (!p) return;
  clearTimeout(p.timer); S.pendingNext = null;
  const tried = new Set();
  let b = bookById(p.id);
  while (b && !tried.has(b.id)) {
    tried.add(b.id);
    try {
      await loadBook(b.id);
      if (S.view === 'reader') renderReader();
      play();
      return;
    } catch (e) {
      note('next book could not be opened: ' + b.title + ': ' + e.message);
      b = S.settings.autoNextBook ? nextBookAfter(p.from, tried) : null;
    }
  }
  keepAlive(false); updatePlayer();
  toast("Couldn't open the next book.");
}
function cancelPendingNext() {
  const p = S.pendingNext; if (!p) return false;
  clearTimeout(p.timer); S.pendingNext = null;
  keepAlive(false); updatePlayer();
  toast("Stopped. The next book won't start.");
  return true;
}

/** The book to play when one ends and Up next is empty: Want to read first, then a book you've started,
 *  then the newest one you haven't, then any other unfinished one. Finished books are skipped. */
function nextBookAfter(id, skip) {
  const all = (S.books || []).filter((b) => b.id !== id && !(skip && skip.has(b.id)) && !(b.collections || []).includes('Finished'));
  const newest = (list, key) => list.sort((a, b) => key(b) - key(a))[0] || null;
  return newest(all.filter((b) => (b.collections || []).includes('Want to read')), (b) => b.added || 0)
    || newest(all.filter((b) => b.percent > 0 && b.percent < 98), (b) => b.opened || 0)
    || newest(all.filter((b) => !b.percent), (b) => b.added || 0)
    || newest(all.slice(), (b) => b.opened || 0);
}

// ---------- Up next ----------
async function queueToggle(b) {
  const q = (S.settings.queue || []).slice();
  const i = q.indexOf(b.id);
  if (i >= 0) q.splice(i, 1); else q.push(b.id);
  await saveSettings({ queue: q });
  toast(i >= 0 ? `Removed “${b.title}” from Up next` : `“${b.title}” will play after the books before it in Up next`);
  renderQueueBtn();
}
function renderQueueBtn() {
  const n = (S.settings.queue || []).filter((id) => bookById(id)).length;
  const btn = $('#queueBtn'); if (btn) btn.textContent = `⏭ Up next${n ? ' (' + n + ')' : ''}`;
}
function showQueue() {
  const q = (S.settings.queue || []).filter((id) => bookById(id));
  const html = q.length
    ? q.map((id, k) => { const b = bookById(id); return `<div class="ditem" data-qopen="${id}"><div class="row"><div><b>${k + 1}.</b> ${esc(b.title)}<div class="s">${esc(b.author || '')}</div></div>
        <div>${k ? `<button class="icon" data-qup="${k}" title="Move up">▲</button>` : ''}<button class="icon" data-qdel="${k}" title="Remove">✕</button></div></div></div>`; }).join('')
    : '<p class="muted" style="padding:10px">Nothing queued. Right-click a book and choose <b>Add to Up next</b>; when a book finishes, the next one starts by itself.</p>';
  openDrawer('Up next', html);
  $('#drawerBody').querySelectorAll('[data-qdel]').forEach((x) => { x.onclick = async (e) => { e.stopPropagation(); q.splice(+x.dataset.qdel, 1); await saveSettings({ queue: q }); renderQueueBtn(); showQueue(); }; });
  $('#drawerBody').querySelectorAll('[data-qup]').forEach((x) => { x.onclick = async (e) => { e.stopPropagation(); const k = +x.dataset.qup; [q[k - 1], q[k]] = [q[k], q[k - 1]]; await saveSettings({ queue: q }); showQueue(); }; });
  $('#drawerBody').querySelectorAll('[data-qopen]').forEach((x) => { x.onclick = (e) => { e.stopPropagation(); closeDrawer(); openBook(x.dataset.qopen); }; });
}

// ---------- search inside every book ----------
function searchBooks(q0) {
  openDrawer('Search inside your books', `<form class="dsearch" id="sbForm"><input id="sbQ" placeholder="Word or phrase in any book" value="${esc(q0 || '')}"><button>Search</button></form><div id="sbRes"></div>`);
  const run = async () => {
    const q = $('#sbQ').value.trim(); if (q.length < 2) return;
    $('#sbRes').innerHTML = '<p class="muted" style="padding:10px">Searching…</p>';
    let hits = [];
    try { hits = await api('/api/search-books?q=' + encodeURIComponent(q)); } catch (e) { $('#sbRes').innerHTML = `<p class="muted" style="padding:10px">${esc(e.message)}</p>`; return; }
    if (!hits.length) { $('#sbRes').innerHTML = '<p class="muted" style="padding:10px">Not found in any book.</p>'; return; }
    $('#sbRes').innerHTML = `<p class="muted" style="padding:6px 10px">${hits.length}${hits.length >= 200 ? '+' : ''} places · click to read aloud from there</p>` + hits.map((h, k) => `<div class="ditem" data-sb="${k}">
      <div class="s"><b>${esc(h.title)}</b> · ${esc(h.chapter || '')} · ${h.pct}%</div>${esc(h.snippet.slice(0, h.at))}<b>${esc(h.snippet.slice(h.at, h.at + h.len))}</b>${esc(h.snippet.slice(h.at + h.len))}</div>`).join('');
    $('#sbRes').querySelectorAll('[data-sb]').forEach((x) => { x.onclick = async (e) => {
      e.stopPropagation(); const h = hits[+x.dataset.sb]; closeDrawer();
      await openBook(h.id); jumpTo(h.para, true);
    }; });
  };
  $('#sbForm').onsubmit = (e) => { e.preventDefault(); run(); };
  setTimeout(() => $('#sbQ').focus(), 0);
  if (q0) run();
}

// ---------- about a book: description, subjects, more free books ----------
async function aboutBook(b) {
  modal(`<div class="detail"><div class="cv">${coverHtml(b)}</div><div><h2>${esc(b.title)}</h2><div>${esc(b.author || 'Unknown author')}</div><div id="abBody"><p class="muted">Looking it up on Open Library…</p></div></div></div><div id="abMore"></div>`, [['Close']]);
  const author = (b.author || '').split(/,| and /)[0].trim();
  let subjects = [];
  try {
    const q = new URLSearchParams({ title: b.title, fields: 'key,title,author_name,first_publish_year,subject,number_of_pages_median,edition_count', limit: '1' });
    if (author) q.set('author', author);
    const j = await (await fetch('https://openlibrary.org/search.json?' + q)).json();
    const d = (j.docs || [])[0];
    let desc = '';
    if (d && d.key) {
      try { const w = await (await fetch('https://openlibrary.org' + d.key + '.json')).json(); desc = typeof w.description === 'string' ? w.description : (w.description && w.description.value) || ''; } catch (_) {}
    }
    desc = desc.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/-{3,}[\s\S]*$/, '').trim();
    subjects = ((d && d.subject) || []).filter((x) => x.length < 40 && !/accessible|protected|in library|lending|overdrive|large type|nyt:/i.test(x)).slice(0, 12);
    const facts = [d && d.first_publish_year ? `First published ${d.first_publish_year}` : '', d && d.number_of_pages_median ? `about ${d.number_of_pages_median} pages` : '', d && d.edition_count ? `${d.edition_count} editions` : ''].filter(Boolean).join(' · ');
    $('#abBody').innerHTML = (facts ? `<div class="muted" style="margin-top:6px">${esc(facts)}</div>` : '') +
      `<p>${esc(desc ? (desc.length > 1100 ? desc.slice(0, 1100) + '…' : desc) : 'No description found.')}</p>` +
      (subjects.length ? `<div class="chips">${subjects.map((x) => `<button class="chip" data-subj="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : '') +
      (d && d.key ? `<p class="muted small">From <a href="https://openlibrary.org${esc(d.key)}" target="_blank">Open Library</a></p>` : '');
    $('#abBody').querySelectorAll('[data-subj]').forEach((x) => { x.onclick = () => { $('#modal').hidden = true; show('search'); $('#q').value = x.dataset.subj; runSearch(x.dataset.subj); }; });
  } catch (_) { if ($('#abBody')) $('#abBody').innerHTML = '<p class="muted">Couldn\'t look this book up right now.</p>'; }
  // more free books by the author, and on its main subject
  const lists = [];
  if (author) lists.push(['More by ' + author, author]);
  if (subjects[0]) lists.push(['Free books about ' + subjects[0].toLowerCase(), subjects[0]]);
  for (const [label, q] of lists) {
    let r = [];
    try { r = (await api(`/api/search?source=gutenberg&q=${encodeURIComponent(q)}`)).filter((x) => x.title.toLowerCase() !== b.title.toLowerCase()).slice(0, 8); } catch (_) {}
    if (!r.length || !$('#abMore')) continue;
    const box = document.createElement('div');
    box.innerHTML = `<h3>${esc(label)}</h3><div class="ab-list">${r.map((x, k) => `<div class="result" data-k="${k}"><div class="thumb">${x.cover ? `<img loading="lazy" src="/api/img?url=${encodeURIComponent(x.cover)}" onerror="this.remove()">` : ''}</div><div><div class="t">${esc(x.title)}</div><div class="s">${esc(x.author || '')}</div></div></div>`).join('')}</div>`;
    box.querySelectorAll('[data-k]').forEach((el) => { el.onclick = () => showDetails(r[+el.dataset.k]); });
    $('#abMore').appendChild(box);
  }
}

// ---------- audio clips with bookmarks ----------
async function saveClip(i) {
  if (!S.book) return;
  let vid = currentVoiceName();
  if (engineOf(vid) === 'browser') {
    const g = extraVoiceOptions();
    if (!g.length) { toast('Audio clips need a Kokoro, Piper or premium voice. Set one up in Voice options.', 7000); return; }
    vid = g[0][1][0][0];
  }
  let k = S.segs[S.segIdx] && S.segs[S.segIdx][0] === i ? S.segIdx : segFor(i);
  const [pi, a] = S.segs[k];
  let b = S.segs[k][2];
  if (b - a < 60 && S.segs[k + 1] && S.segs[k + 1][0] === pi) b = S.segs[k + 1][2];
  const quote = S.paras[pi].slice(a, b).trim();
  toast('Making the clip…', 60000);
  try {
    const r = await genAudio(vid, spoken(quote, pi) || quote, currentRate());
    const ext = /mpeg|mp3/.test(r.blob.type) ? 'mp3' : 'wav';
    const file = `clip-${Date.now()}.${ext}`;
    await api(`/api/clip/${S.book.id}/${file}`, { method: 'PUT', body: r.blob, headers: { 'Content-Type': 'application/octet-stream' } });
    const notes = (S.bookState.notes || []).slice();
    notes.push({ type: 'clip', para: pi, start: a, end: b, quote, file, rate: r.extra || 1, text: '', time: Date.now() });
    await saveState({ notes }); refreshMarks();
    toastAction('Saved the clip with a bookmark.', '▶ Play', () => playClip(file, r.extra || 1));
  } catch (e) { toast('Couldn\'t make the clip: ' + e.message, 7000); }
}
function playClip(file, rate) {
  const a = new Audio(`/api/clip/${S.book.id}/${file}`);
  a.preservesPitch = true; a.playbackRate = rate || 1;
  if (S.playing) pause();
  a.play().catch(() => {});
}
function jumpTo(para, startPlaying) {
  if (!S.book) return;
  recordJump(para);
  S.segIdx = segFor(para);
  lastUserScroll = 0;
  savePos(true);
  if (startPlaying && !S.playing) play();
  else if (S.playing) speakFrom(S.segIdx);
  highlight(true); updatePlayer();
}
