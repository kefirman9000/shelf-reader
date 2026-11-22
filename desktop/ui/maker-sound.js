'use strict';
// Audiobook maker, part 3 of 4 (split from maker.js to keep files a readable size).
// The parts share one scope and load in order (see the <script> tags); start-up code is in the last part.

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
