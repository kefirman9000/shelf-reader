'use strict';
/* Voice engines beyond the browser's built-in voices:
   - Kokoro (free, open-source, runs on this PC)          voice ids "kokoro:<id>"
   - Piper  (free, open-source, runs on this PC)          voice ids "piper:<voice key>"
   - Premium cloud voices with your own API key           voice ids "cloud:<provider>:<voice>"
   Loaded before app.js; uses its globals (S, api, esc, toast, modal, …) only when called. */

const KOKORO_VOICES = [
  ['af_heart', 'Heart', 'en-US', 'Female'], ['af_bella', 'Bella', 'en-US', 'Female'], ['af_nicole', 'Nicole', 'en-US', 'Female'],
  ['af_aoede', 'Aoede', 'en-US', 'Female'], ['af_kore', 'Kore', 'en-US', 'Female'], ['af_sarah', 'Sarah', 'en-US', 'Female'],
  ['af_nova', 'Nova', 'en-US', 'Female'], ['af_alloy', 'Alloy', 'en-US', 'Female'], ['af_sky', 'Sky', 'en-US', 'Female'],
  ['am_michael', 'Michael', 'en-US', 'Male'], ['am_fenrir', 'Fenrir', 'en-US', 'Male'], ['am_puck', 'Puck', 'en-US', 'Male'],
  ['am_echo', 'Echo', 'en-US', 'Male'], ['am_eric', 'Eric', 'en-US', 'Male'], ['am_liam', 'Liam', 'en-US', 'Male'],
  ['bf_emma', 'Emma', 'en-GB', 'Female'], ['bf_isabella', 'Isabella', 'en-GB', 'Female'], ['bf_alice', 'Alice', 'en-GB', 'Female'],
  ['bf_lily', 'Lily', 'en-GB', 'Female'], ['bm_george', 'George', 'en-GB', 'Male'], ['bm_fable', 'Fable', 'en-GB', 'Male'],
  ['bm_lewis', 'Lewis', 'en-GB', 'Male'], ['bm_daniel', 'Daniel', 'en-GB', 'Male']
];
const KOKORO_BEST = new Set(['af_heart', 'af_bella', 'af_nicole', 'bf_emma']);
const PIPER_GENDER = {
  amy: 'Female', lessac: 'Female', ryan: 'Male', joe: 'Male', kristin: 'Female', kathleen: 'Female', danny: 'Male',
  ljspeech: 'Female', hfc_female: 'Female', hfc_male: 'Male', kusal: 'Male', alan: 'Male', alba: 'Female', cori: 'Female',
  jenny_dioco: 'Female', northern_english_male: 'Male', southern_english_female: 'Female', norman: 'Male', john: 'Male', bryce: 'Male', sam: 'Male'
};
const CLOUD_LINKS = {
  openai: 'https://platform.openai.com/api-keys',
  elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
  azure: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
  google: 'https://console.cloud.google.com/apis/library/texttospeech.googleapis.com'
};

const ENG = {
  kokoro: { worker: null, ready: false, loading: null, pending: new Map(), nextId: 1, gen: 0, onProgress: null },
  piper: { worker: null, pending: new Map(), nextId: 1, gen: 0, stored: [], onProgress: null, catalog: null },
  cloudVoices: {}
};

function engineOf(vid) {
  if (!vid) return 'browser';
  if (vid.startsWith('kokoro:')) return 'kokoro';
  if (vid.startsWith('piper:')) return 'piper';
  if (vid.startsWith('cloud:')) return 'cloud';
  return 'browser';
}

// ---------- audio helpers ----------
function wavFromFloat(data, rate) {
  const n = data.length; const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, data[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}
const fmtMB = (b) => (b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

// ---------- Kokoro ----------
function kokoroWorker() {
  const K = ENG.kokoro;
  if (!K.worker) {
    K.worker = new Worker('tts-worker.js', { type: 'module' });
    K.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { if (K.onProgress) K.onProgress(m.p); }
      else if (m.type === 'ready') { K.ready = true; if (K.loadResolve) K.loadResolve(); }
      else if (m.type === 'loaderror') { if (K.loadReject) K.loadReject(new Error(m.error)); }
      else if (m.type === 'audio') {
        const p = K.pending.get(m.id); if (!p) return;
        K.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
      }
    };
  }
  return K.worker;
}
function kokoroLoad(mode, onProgress) {
  const K = ENG.kokoro;
  if (onProgress) K.onProgress = onProgress;
  if (K.ready) return Promise.resolve();
  if (K.loading) return K.loading;
  const [dtype, device] = (mode || S.settings.kokoro || 'q8-wasm').split('-');
  K.loading = new Promise((res, rej) => { K.loadResolve = res; K.loadReject = rej; });
  kokoroWorker().postMessage({ type: 'load', dtype, device });
  K.loading.catch(() => { K.loading = null; if (K.worker) K.worker.terminate(); K.worker = null; });
  return K.loading;
}
async function kokoroGen(voice, text, speed) {
  await kokoroLoad();
  const K = ENG.kokoro; const id = K.nextId++;
  const r = await new Promise((resolve, reject) => {
    K.pending.set(id, { resolve, reject });
    K.worker.postMessage({ type: 'gen', id, gen: K.gen, text, voice, speed });
  });
  return wavFromFloat(r.data, r.rate);
}

// ---------- Piper ----------
function piperWorker() {
  const P = ENG.piper;
  if (!P.worker) {
    P.worker = new Worker('piper-worker.js', { type: 'module' });
    P.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { if (P.onProgress) P.onProgress(m.voiceId, m.p); return; }
      const p = P.pending.get(m.id); if (!p) return;
      P.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
    };
  }
  return P.worker;
}
function piperCall(msg) {
  const P = ENG.piper; const id = P.nextId++;
  return new Promise((resolve, reject) => { P.pending.set(id, { resolve, reject }); piperWorker().postMessage({ ...msg, id }); });
}
async function piperRefreshStored() {
  try { ENG.piper.stored = (await piperCall({ type: 'stored' })).list || []; } catch (_) { ENG.piper.stored = []; }
  return ENG.piper.stored;
}
async function piperCatalog() {
  if (!ENG.piper.catalog) {
    const m = await import('./vendor/piper.web.js');
    ENG.piper.catalog = Object.values(m.VOICES).filter((v) => v.num_speakers === 1);
  }
  return ENG.piper.catalog;
}
function piperLabel(v) {
  const g = PIPER_GENDER[v.name] || '';
  const nice = v.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const q = { x_low: 'basic', low: 'good', medium: 'better', high: 'best' }[v.quality] || v.quality;
  return `${nice} · ${langLabel(v.language.code.replace('_', '-'))}${g ? ' · ' + g : ''} · ${q}`;
}
const piperSize = (v) => Object.entries(v.files || {}).filter(([k]) => k.endsWith('.onnx')).reduce((a, [, f]) => a + (f.size_bytes || 0), 0);
async function piperGen(voiceId, text) {
  const r = await piperCall({ type: 'gen', gen: ENG.piper.gen, voiceId, text });
  return new Blob([r.wav], { type: 'audio/wav' });
}

// ---------- premium cloud ----------
async function cloudGen(provider, voice, text, speed) {
  const r = await fetch('/api/cloud/speak', {
    method: 'POST', headers: { 'X-Shelf': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, voice, text, speed })
  });
  if (!r.ok) { let m = `Error ${r.status}`; try { m = (await r.json()).error || m; } catch (_) {} throw new Error(m); }
  return { blob: await r.blob(), applied: r.headers.get('X-Speed-Applied') === '1' };
}
async function cloudRefresh() {
  ENG.cloudVoices = {};
  const cfg = S.settings.cloud || {};
  await Promise.all(Object.keys(cfg).filter((p) => cfg[p].configured).map(async (p) => {
    try { ENG.cloudVoices[p] = await api('/api/cloud/voices?provider=' + p); }
    catch (e) { ENG.cloudVoices[p] = []; ENG.cloudVoices[p].error = e.message; }
  }));
}

// ---------- one entry point for all non-browser engines ----------
/** Returns { blob, extra } where extra is any speed-up still to apply at playback. */
async function genAudio(vid, text, rate) {
  const eng = engineOf(vid);
  if (eng === 'kokoro') {
    const sp = Math.max(0.5, Math.min(2, rate));
    return { blob: await kokoroGen(vid.slice(7), text, sp), extra: rate / sp };
  }
  if (eng === 'piper') return { blob: await piperGen(vid.slice(6), text), extra: rate };
  if (eng === 'cloud') {
    const parts = vid.split(':');
    const r = await cloudGen(parts[1], parts.slice(2).join(':'), text, rate);
    return { blob: r.blob, extra: r.applied ? 1 : rate };
  }
  throw new Error('not an audio engine');
}
function flushEngines() {
  for (const k of ['kokoro', 'piper']) {
    const E = ENG[k]; E.gen++;
    if (E.worker) E.worker.postMessage({ type: 'flush', gen: E.gen });
  }
}
function engineReady(vid) {
  const eng = engineOf(vid);
  return eng !== 'kokoro' || ENG.kokoro.ready;
}

// ---------- labels for the voice menu ----------
function extraVoiceOptions() {
  const groups = [];
  const local = [];
  if (S.settings.kokoro) {
    for (const [id, name, lang, g] of KOKORO_VOICES) {
      local.push([`kokoro:${id}`, `${name} · ${langLabel(lang)} · ${g} · Kokoro${KOKORO_BEST.has(id) ? ' ★' : ''}`]);
    }
  }
  if (ENG.piper.catalog) {
    for (const key of ENG.piper.stored) {
      const v = ENG.piper.catalog.find((x) => x.key === key);
      if (v) local.push([`piper:${key}`, piperLabel(v) + ' · Piper']);
    }
  }
  if (local.length) groups.push(['Natural voices (free, on this PC)', local]);
  const cfg = S.settings.cloud || {};
  for (const p of Object.keys(cfg)) {
    const list = ENG.cloudVoices[p];
    if (!cfg[p].configured || !list || !list.length) continue;
    groups.push([`${cfg[p].name} (premium, uses your API key)`, list.map((v) =>
      [`cloud:${p}:${v.id}`, `${v.name}${v.lang ? ' · ' + (/^[a-z]{2}-/i.test(v.lang) ? langLabel(v.lang) : v.lang) : ''}${v.gender ? ' · ' + v.gender[0].toUpperCase() + v.gender.slice(1) : ''}`])]);
  }
  return groups;
}

// ---------- Voice options window ----------
async function openVoiceOptions() {
  const gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
  await piperCatalog().catch(() => {});
  await piperRefreshStored();
  const cfg = S.settings.cloud || {};
  const k = S.settings.kokoro;
  const piperEn = (ENG.piper.catalog || []).filter((v) => v.language.code.startsWith('en'))
    .sort((a, b) => a.language.code.localeCompare(b.language.code) || a.name.localeCompare(b.name));
  const piperRows = (list) => list.map((v) => {
    const have = ENG.piper.stored.includes(v.key);
    return `<div class="fix" data-pv="${esc(v.key)}"><span style="flex:1">${esc(piperLabel(v))} <span class="muted">(${fmtMB(piperSize(v))})</span></span>
      <span class="muted pstat"></span>
      ${have ? `<button data-ptry="${esc(v.key)}">▶ Try</button><button class="danger" data-prm="${esc(v.key)}">Remove</button>` : `<button data-pdl="${esc(v.key)}">Download</button>`}</div>`;
  }).join('');
  modal(`<h2>Voice options</h2>
    <h3>Kokoro natural voices (free, recommended)</h3>
    <p class="muted">Open-source neural voices that run on your PC and sound close to human, with US and UK accents. Download once, then they work offline for listening and MP3 export.</p>
    ${k ? `<div class="setrow"><span style="flex:1">✓ Installed (${k === 'fp32-webgpu' ? 'faster, uses your graphics card' : 'standard'})</span>
      <button id="kTry">▶ Try</button><button class="danger" id="kRemove">Remove</button></div>`
    : `<label class="check"><input type="radio" name="kmode" value="q8-wasm" checked> Standard: about 90 MB download, works on any PC</label>
       ${gpu ? '<label class="check"><input type="radio" name="kmode" value="fp32-webgpu"> Faster with your graphics card: about 330 MB download</label>' : ''}
       <div class="setrow"><button class="primary" id="kInstall">Install Kokoro voices</button><span id="kStat" class="muted"></span></div>`}
    <h3>Piper voices (free, many voices &amp; languages)</h3>
    <p class="muted">Lighter and very fast; less lifelike than Kokoro. Each voice is a separate download. Piper doesn't change speed while generating, so faster speeds are applied during playback.</p>
    <div id="piperList">${piperRows(piperEn)}</div>
    <label class="check"><input type="checkbox" id="piperAll"> Show voices in other languages</label>
    <h3>Premium cloud voices (your own API key)</h3>
    <p class="muted">The most lifelike voices, from paid services. You pay the provider for what you listen to or export, and a whole book can cost real money. Keys are stored only on this PC.</p>
    ${Object.entries(cfg).map(([p, c]) => `<div class="setrow" data-cp="${p}">
      <label style="min-width:120px">${esc(c.name)}</label>
      <input data-k="key" type="password" placeholder="${c.configured ? 'Key saved ' + esc(c.keyHint) : 'API key'}" style="flex:1">
      ${p === 'azure' ? `<input data-k="region" placeholder="region" value="${esc(c.region)}" style="width:90px">` : ''}
      ${p === 'openai' || p === 'elevenlabs' ? `<input data-k="model" placeholder="model" value="${esc(c.model)}" style="width:170px">` : ''}
      <button data-csave="${p}">Save</button>${c.configured ? `<button class="danger" data-cclear="${p}">Remove</button>` : ''}
      <a href="${CLOUD_LINKS[p]}" target="_blank" class="muted" style="font-size:12px">get a key</a></div>`).join('')}
    <h3>Windows 11 natural voices</h3>
    <p class="muted">Windows' own natural voices (Aria, Jenny, Guy) only work in Narrator. A free third-party add-on, <a href="https://github.com/gexgd0419/NaturalVoiceSAPIAdapter" target="_blank">NaturalVoiceSAPIAdapter</a>, can make Microsoft's natural voices appear in other apps, including Shelf Reader's Windows voices and export. It's unofficial and may stop working after Windows updates.</p>`,
  [['Done', () => fillVoiceSelect(), true]]);

  // Kokoro
  const kInstall = $('#kInstall');
  if (kInstall) kInstall.onclick = async () => {
    const mode = (document.querySelector('input[name=kmode]:checked') || {}).value || 'q8-wasm';
    kInstall.disabled = true;
    const files = {};
    try {
      await kokoroLoad(mode, (p) => {
        if (p.file && p.total) files[p.file] = [p.loaded || 0, p.total];
        const tot = Object.values(files).reduce((a, [, t]) => a + t, 0);
        const got = Object.values(files).reduce((a, [l]) => a + l, 0);
        $('#kStat') && ($('#kStat').textContent = tot ? `Downloading… ${fmtMB(got)} of ${fmtMB(tot)}` : 'Preparing…');
      });
      await saveSettings({ kokoro: mode });
      if (S.book) { await saveState({ voice: 'kokoro:af_heart' }); }
      toast('Kokoro voices installed. Heart is now your voice for this book.', 6000);
      fillVoiceSelect(); openVoiceOptions();
      previewVoice('kokoro:af_heart');
    } catch (e) {
      kInstall.disabled = false;
      $('#kStat') && ($('#kStat').textContent = 'Install failed: ' + e.message + '. Check your internet connection and try again.');
    }
  };
  if ($('#kTry')) $('#kTry').onclick = () => previewVoice('kokoro:af_heart');
  if ($('#kRemove')) $('#kRemove').onclick = async () => {
    try { await caches.delete('transformers-cache'); } catch (_) {}
    if (ENG.kokoro.worker) ENG.kokoro.worker.terminate();
    Object.assign(ENG.kokoro, { worker: null, ready: false, loading: null });
    await saveSettings({ kokoro: null });
    fillVoiceSelect(); openVoiceOptions();
  };

  // Piper
  const bindPiper = () => {
    $('#piperList').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.pdl) {
        const key = b.dataset.pdl; const row = b.closest('[data-pv]');
        b.disabled = true;
        ENG.piper.onProgress = (vid, p) => { if (vid === key && p.total) row.querySelector('.pstat').textContent = Math.round(p.loaded * 100 / p.total) + '%'; };
        try { await piperCall({ type: 'download', voiceId: key }); await piperRefreshStored(); toast('Voice downloaded'); fillVoiceSelect(); openVoiceOptions(); }
        catch (err) { b.disabled = false; row.querySelector('.pstat').textContent = 'failed: ' + err.message; }
      } else if (b.dataset.prm) {
        await piperCall({ type: 'remove', voiceId: b.dataset.prm }).catch(() => {});
        await piperRefreshStored(); fillVoiceSelect(); openVoiceOptions();
      } else if (b.dataset.ptry) {
        previewVoice('piper:' + b.dataset.ptry);
      }
    };
  };
  bindPiper();
  $('#piperAll').onchange = (e) => {
    const list = (ENG.piper.catalog || []).filter((v) => e.target.checked || v.language.code.startsWith('en'))
      .sort((a, b) => a.language.code.localeCompare(b.language.code) || a.name.localeCompare(b.name));
    $('#piperList').innerHTML = piperRows(list);
  };

  // Cloud
  document.querySelectorAll('[data-csave]').forEach((b) => (b.onclick = async () => {
    const p = b.dataset.csave; const row = b.closest('[data-cp]');
    const body = { provider: p };
    row.querySelectorAll('input[data-k]').forEach((i) => { if (i.value.trim()) body[i.dataset.k] = i.value.trim(); });
    try {
      const pub = await api('/api/cloud/config', { method: 'PUT', json: body });
      S.settings.cloud = pub;
      await cloudRefresh();
      const list = ENG.cloudVoices[p] || [];
      toast(list.error ? `Saved, but ${pub[p].name} said: ${list.error}` : `${pub[p].name}: ${list.length} voices available`, 7000);
      fillVoiceSelect(); openVoiceOptions();
    } catch (e) { toast(e.message, 6000); }
  }));
  document.querySelectorAll('[data-cclear]').forEach((b) => (b.onclick = async () => {
    S.settings.cloud = await api('/api/cloud/config', { method: 'PUT', json: { provider: b.dataset.cclear, clear: true } });
    await cloudRefresh(); fillVoiceSelect(); openVoiceOptions();
  }));
}

// ---------- export with Kokoro / Piper / cloud voices ----------
async function browserExport({ from, to, vid, rate }) {
  const begin = await api('/api/export/begin', { method: 'POST', json: { title: S.book.title } });
  if (begin.cancelled) return;
  const chapters = S.chapters.length ? S.chapters : [{ title: S.book.title, para: 0 }];
  const a = Math.max(0, Math.min(from, chapters.length - 1));
  const z = Math.max(a, Math.min(to, chapters.length - 1));
  const job = { cancelled: false };
  const actx = new AudioContext({ sampleRate: 24000 });
  const mp3w = new Worker('mp3-worker.js');
  const mp3Call = (msg, transfer) => new Promise((res, rej) => {
    mp3w.onmessage = (e) => (e.data.error ? rej(new Error(e.data.error)) : res(e.data));
    mp3w.postMessage(msg, transfer || []);
  });
  const isCloud = engineOf(vid) === 'cloud';
  const showProgress = (ci, k, n) => {
    $('#toast').hidden = false; clearTimeout(toastTimer);
    $('#toast').innerHTML = `Exporting “${esc(S.book.title)}”: file ${ci - a + 1} of ${z - a + 1} · ${n ? Math.floor(k * 100 / n) : 0}% <button id="bxCancel" style="margin-left:10px">Cancel</button>`;
    $('#bxCancel').onclick = () => { job.cancelled = true; };
  };
  let made = 0;
  try {
    for (let ci = a; ci <= z; ci++) {
      const start = chapters[ci].para;
      const end = ci + 1 < chapters.length ? chapters[ci + 1].para : S.paras.length;
      // local engines: sentence by sentence; cloud: larger pieces (fewer requests)
      const pieces = []; let buf = '';
      for (const [pi, x, y] of S.segs) {
        if (pi < start) continue; if (pi >= end) break;
        const t = spoken(S.paras[pi].slice(x, y)); if (!t) continue;
        if (!isCloud) { pieces.push(t); continue; }
        if (buf && buf.length + t.length > 2500) { pieces.push(buf); buf = ''; }
        buf = buf ? buf + ' ' + t : t;
      }
      if (buf) pieces.push(buf);
      if (!pieces.length) continue;
      await mp3Call({ type: 'start', rate: 24000 });
      for (let k = 0; k < pieces.length; k++) {
        if (job.cancelled) throw new Error('cancelled');
        showProgress(ci, k, pieces.length);
        const r = await genAudio(vid, pieces[k], rate);
        const audio = await actx.decodeAudioData(await r.blob.arrayBuffer());
        const pcm = new Float32Array(audio.getChannelData(0));
        await mp3Call({ type: 'chunk', pcm }, [pcm.buffer]);
        const gap = new Float32Array(24000 * 0.25);
        await mp3Call({ type: 'chunk', pcm: gap }, [gap.buffer]);
      }
      const done = await mp3Call({ type: 'end' });
      const name = `${String(ci + 1).padStart(2, '0')} - ${chapters[ci].title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.mp3`;
      await fetch('/api/export/file', { method: 'POST', headers: { 'X-Shelf': '1', 'X-Filename': encodeURIComponent(name) }, body: done.mp3 });
      made++;
    }
    $('#toast').hidden = true;
    modal(`<h2>Export finished</h2><p>Saved ${made} MP3 file${made === 1 ? '' : 's'} to:<br><span class="muted">${esc(begin.folder)}</span></p>`,
      [['Close'], ['Open folder', () => api('/api/export/open', { method: 'POST' }), true]]);
  } catch (e) {
    toast(e.message === 'cancelled' ? `Export cancelled after ${made} file${made === 1 ? '' : 's'}.` : 'Export failed: ' + e.message, 8000);
  } finally {
    mp3w.terminate(); actx.close().catch(() => {});
  }
}
