'use strict';
// Audiobook maker, part 4 of 4 (split from maker.js to keep files a readable size).
// The parts share one scope and load in order (see the <script> tags); start-up code is in the last part.

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
