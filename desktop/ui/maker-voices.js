'use strict';
// Audiobook maker, part 2 of 4 (split from maker.js to keep files a readable size).
// The parts share one scope and load in order (see the <script> tags); start-up code is in the last part.

// =====================================================================
// 2. Voices
// =====================================================================
const KOKORO_VOICES = [
  ['af_heart', 'Heart', 'American', 'Female', 1], ['af_bella', 'Bella', 'American', 'Female', 1], ['af_nicole', 'Nicole', 'American', 'Female · soft', 1],
  ['am_michael', 'Michael', 'American', 'Male', 1], ['am_fenrir', 'Fenrir', 'American', 'Male', 0], ['am_puck', 'Puck', 'American', 'Male', 0],
  ['bf_emma', 'Emma', 'British', 'Female', 1], ['bm_george', 'George', 'British', 'Male', 1], ['bm_fable', 'Fable', 'British', 'Male', 0],
  ['af_aoede', 'Aoede', 'American', 'Female', 0], ['af_kore', 'Kore', 'American', 'Female', 0], ['af_sarah', 'Sarah', 'American', 'Female', 0],
  ['af_nova', 'Nova', 'American', 'Female', 0], ['af_alloy', 'Alloy', 'American', 'Female', 0], ['af_sky', 'Sky', 'American', 'Female', 0],
  ['am_echo', 'Echo', 'American', 'Male', 0], ['am_eric', 'Eric', 'American', 'Male', 0], ['am_liam', 'Liam', 'American', 'Male', 0],
  ['bf_isabella', 'Isabella', 'British', 'Female', 0], ['bf_alice', 'Alice', 'British', 'Female', 0], ['bf_lily', 'Lily', 'British', 'Female', 0],
  ['bm_lewis', 'Lewis', 'British', 'Male', 0], ['bm_daniel', 'Daniel', 'British', 'Male', 0]
];
const PIPER_GENDER = {
  amy: 'Female', lessac: 'Female', ryan: 'Male', joe: 'Male', kristin: 'Female', kathleen: 'Female', danny: 'Male', ljspeech: 'Female',
  hfc_female: 'Female', hfc_male: 'Male', kusal: 'Male', alan: 'Male', alba: 'Female', cori: 'Female', jenny_dioco: 'Female',
  northern_english_male: 'Male', southern_english_female: 'Female', norman: 'Male', john: 'Male', bryce: 'Male', sam: 'Male'
};
const OPENAI_VOICES = [['marin', 'Female', 1], ['cedar', 'Male', 1], ['alloy', 'Neutral'], ['ash', 'Male'], ['ballad', 'Male'], ['coral', 'Female'], ['echo', 'Male'],
  ['fable', 'Male · British'], ['nova', 'Female'], ['onyx', 'Male · deep'], ['sage', 'Female'], ['shimmer', 'Female'], ['verse', 'Male']];
const CLOUD = {
  openai: { name: 'OpenAI', link: 'https://platform.openai.com/api-keys', max: 3500 },
  elevenlabs: { name: 'ElevenLabs', link: 'https://elevenlabs.io/app/settings/api-keys', max: 2500 },
  azure: { name: 'Microsoft Azure', link: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices', max: 3000 },
  google: { name: 'Google Cloud', link: 'https://console.cloud.google.com/apis/library/texttospeech.googleapis.com', max: 3000 }
};
const ENG_NOTES = {
  kokoro: 'The most natural free voices, in English. They run on this device: the first time, the voice model downloads once. ★ marks the best voices.',
  piper: 'Clear, fast voices in more than 30 languages. They also run on this device, and each voice downloads once (20–110 MB).',
  cloud: 'Studio-quality voices from OpenAI, ElevenLabs, Microsoft or Google, using your own account. They need an internet connection and are billed by the service.'
};

const speed = () => +$('#speed').value;

/** Narrator style presets: pace, pauses, and how premium voices perform. */
const STYLES = {
  natural: { name: 'Natural', note: 'Clear, warm storytelling.', speed: 1, para: 1, chap: 1, scene: 1, dlg: 1,
    openai: 'Read like a skilled audiobook narrator: natural, warm and clear, with gentle variation in pace and tone.', el: { stability: 0.5, style: 0.15 }, azure: 'narration-professional', pitch: 0 },
  bedtime: { name: 'Cozy bedtime', note: 'Slower and softer, with relaxed pauses.', speed: 0.92, para: 1.35, chap: 1.4, scene: 1.3, dlg: 1.15,
    openai: 'Read softly and soothingly, like a bedtime story: unhurried, warm and gentle, with relaxed pauses.', el: { stability: 0.75, style: 0.05 }, azure: 'narration-relaxed', pitch: -1.5 },
  thriller: { name: 'Suspense / thriller', note: 'Tighter pace, tense delivery, quick dialogue, long pauses at scene breaks.', speed: 1.04, para: 0.85, chap: 1.1, scene: 1.6, dlg: 0.7,
    openai: 'Read with quiet intensity and suspense: tight pacing, tension in the voice, and a dramatic beat before reveals.', el: { stability: 0.35, style: 0.45 }, azure: 'narration-professional', pitch: -0.5 },
  nonfiction: { name: 'Nonfiction / lecture', note: 'Even, confident and articulate.', speed: 1, para: 1.1, chap: 1.25, scene: 1, dlg: 1,
    openai: 'Read like a clear, confident nonfiction narrator: measured and articulate, engaged, lightly emphasizing key ideas.', el: { stability: 0.65, style: 0.1 }, azure: 'narration-professional', pitch: 0 },
  children: { name: "Children's story", note: 'Bright and expressive, a little slower.', speed: 0.94, para: 1.2, chap: 1.3, scene: 1.2, dlg: 1,
    openai: "Read like a lively children's storyteller: bright, expressive and playful, with clear words and fun character voices.", el: { stability: 0.3, style: 0.6 }, azure: 'cheerful', pitch: 1 },
  dramatic: { name: 'Dramatic / epic', note: 'Rich and theatrical, with weighty pauses.', speed: 0.97, para: 1.2, chap: 1.5, scene: 1.8, dlg: 1,
    openai: 'Read like a dramatic narrator of an epic tale: rich and resonant, with bold emotion and weighty pauses.', el: { stability: 0.3, style: 0.55 }, azure: 'narration-professional', pitch: -1 }
};
const style = () => STYLES[$('#readStyle')?.value] || STYLES.natural;
/** The speed actually sent to the voice: your setting × the style's pace. */
const effSpeed = () => speed() * style().speed;

// ----- Kokoro worker -----
const K = { worker: null, ready: false, loading: null, pending: new Map(), next: 1, gen: 0 };
function kokoroLoad() {
  if (K.ready) return Promise.resolve();
  if (K.loading) return K.loading;
  const mode = $('#kokoroMode').value;
  const [dtype, device] = mode.split('-');
  K.worker = new Worker('tts-worker.js', { type: 'module' });
  K.loading = new Promise((res, rej) => {
    const files = {};
    K.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        if (m.p.file && m.p.total) { files[m.p.file] = [m.p.loaded || 0, m.p.total]; }
        const t = Object.values(files).reduce((a, [l, tt]) => [a[0] + l, a[1] + tt], [0, 0]);
        if (t[1] > 1e6) $('#kokoroStatus').textContent = `Downloading the voice model… ${fmtMB(t[0])} of ${fmtMB(t[1])}`;
      } else if (m.type === 'ready') { K.ready = true; $('#kokoroStatus').textContent = 'Voice model ready ✓'; res(); }
      else if (m.type === 'loaderror') { rej(new Error(m.error)); }
      else if (m.type === 'audio') {
        const p = K.pending.get(m.id); if (!p) return; K.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
      }
    };
  });
  $('#kokoroStatus').textContent = 'Starting the voice model…';
  K.worker.postMessage({ type: 'load', dtype, device });
  K.loading.catch((e) => {
    K.loading = null; K.worker?.terminate(); K.worker = null;
    if (device === 'webgpu') { $('#kokoroMode').value = 'q8-wasm'; $('#kokoroStatus').textContent = 'Your graphics card couldn\'t be used, so the compatible engine is selected. Try again.'; }
    else $('#kokoroStatus').textContent = 'The voice model failed to load: ' + e.message;
  });
  return K.loading;
}
$('#kokoroMode').onchange = () => {
  PREF.kokoroMode = $('#kokoroMode').value; savePref();
  if (K.worker) { K.worker.terminate(); K.worker = null; K.ready = false; K.loading = null; $('#kokoroStatus').textContent = ''; }
};
async function kokoroSynth(voice, text, sp) {
  await kokoroLoad();
  const id = K.next++;
  const r = await new Promise((resolve, reject) => { K.pending.set(id, { resolve, reject }); K.worker.postMessage({ type: 'gen', id, gen: K.gen, text, voice, speed: sp }); });
  return r.rate === RATE ? r.data : resample(r.data, r.rate, RATE);
}

// ----- Piper worker -----
const P = { worker: null, pending: new Map(), next: 1, onProgress: null };
function piperCall(msg) {
  if (!P.worker) {
    P.worker = new Worker('piper-worker.js', { type: 'module' });
    P.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { if (P.onProgress) P.onProgress(m.voiceId, m.p); return; }
      const p = P.pending.get(m.id); if (!p) return; P.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
    };
  }
  const id = P.next++;
  return new Promise((resolve, reject) => { P.pending.set(id, { resolve, reject }); P.worker.postMessage({ ...msg, id }); });
}
async function piperCatalog() {
  if (!M.piper.catalog) {
    const mod = await import('./vendor/piper.web.js');
    M.piper.catalog = Object.values(mod.VOICES).filter((v) => v.num_speakers === 1);
    try { M.piper.stored = (await piperCall({ type: 'stored' })).list || []; } catch (_) { M.piper.stored = []; }
  }
  return M.piper.catalog;
}
const piperSize = (v) => Object.entries(v.files || {}).filter(([k]) => k.endsWith('.onnx')).reduce((a, [, f]) => a + (f.size_bytes || 0), 0);
async function piperSynth(voiceId, text) {
  if (!M.piper.stored.includes(voiceId)) {
    P.onProgress = (vid, p) => { if (vid === voiceId && p.total) setVoiceBusyText(`Downloading voice… ${Math.round((p.loaded / p.total) * 100)}%`); };
    await piperCall({ type: 'download', voiceId });
    M.piper.stored.push(voiceId);
  }
  const r = await piperCall({ type: 'gen', gen: 0, voiceId, text });
  return decodeTo(r.wav);
}

// ----- premium cloud voices (straight from the browser to the provider) -----
function cloudCfg(p) { return (PREF.cloud && PREF.cloud[p]) || M.cloudSession?.[p] || {}; }
async function req(url, opts = {}) {
  let r;
  try { r = await fetch(url, opts); } catch (e) { throw new Error('Couldn\'t reach the service. Check your connection.'); }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || (j.detail && (j.detail.message || j.detail)) || j.message || msg; if (typeof msg !== 'string') msg = JSON.stringify(msg).slice(0, 200); } catch (_) {}
    if (r.status === 401 || r.status === 403) msg = 'The API key was rejected: ' + msg;
    if (r.status === 429) msg = 'The service says you\'ve hit a rate or quota limit: ' + msg;
    throw new Error(msg);
  }
  return r;
}
async function cloudVoices(p) {
  const c = cloudCfg(p);
  if (p === 'openai') return OPENAI_VOICES.map(([id, g, best]) => ({ id, name: id[0].toUpperCase() + id.slice(1), tags: g, best }));
  if (p === 'elevenlabs') {
    const j = await (await req('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': c.key } })).json();
    return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, tags: [v.labels?.gender, v.labels?.accent, v.labels?.description || v.labels?.descriptive].filter(Boolean).join(' · '), sample: v.preview_url }));
  }
  if (p === 'azure') {
    const j = await (await req(`https://${c.region || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': c.key } })).json();
    const lang = (navigator.language || 'en').split('-')[0];
    return j.filter((v) => v.Locale.startsWith(lang + '-') || v.Locale.startsWith('en-')).sort((a, b) => (/Dragon|HD/.test(b.ShortName) - /Dragon|HD/.test(a.ShortName)) || a.ShortName.localeCompare(b.ShortName))
      .map((v) => ({ id: v.ShortName, name: v.DisplayName || v.LocalName, tags: `${v.LocaleName || v.Locale} · ${v.Gender}`, best: /Dragon|HD/.test(v.ShortName) }));
  }
  if (p === 'google') {
    const j = await (await req('https://texttospeech.googleapis.com/v1/voices?key=' + encodeURIComponent(c.key))).json();
    const rank = (n) => (/Chirp3-HD/.test(n) ? 0 : /Studio/.test(n) ? 1 : /Neural2/.test(n) ? 2 : /Wavenet/.test(n) ? 3 : 4);
    const lang = (navigator.language || 'en').split('-')[0];
    return (j.voices || []).filter((v) => rank(v.name) < 4 && (v.languageCodes || []).some((l) => l.startsWith(lang) || l.startsWith('en')))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
      .map((v) => ({ id: v.name, name: v.name.split('-').slice(2).join(' '), tags: `${(v.languageCodes || [])[0]} · ${(v.ssmlGender || '').toLowerCase()}`, best: rank(v.name) === 0 }));
  }
  return [];
}
const xmlEsc = (s) => s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
async function cloudSynth(p, voice, text, sp, ctx = {}) {
  const c = cloudCfg(p);
  if (!c.key) throw new Error(`Add your ${CLOUD[p].name} key first.`);
  let buf;
  if (p === 'openai') {
    const body = { model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3', speed: Math.max(0.25, Math.min(4, sp)) };
    body.instructions = openaiInstructions(ctx);
    buf = await (await req('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).arrayBuffer();
  } else if (p === 'elevenlabs') {
    buf = await (await req(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': c.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text, model_id: 'eleven_multilingual_v2',
        // the text just before and after helps the voice carry on in the same tone
        ...(ctx.prev ? { previous_text: ctx.prev } : {}), ...(ctx.next ? { next_text: ctx.next } : {}),
        voice_settings: { stability: style().el.stability, similarity_boost: 0.75, style: style().el.style, use_speaker_boost: true, speed: Math.max(0.7, Math.min(1.2, sp)) }
      })
    })).arrayBuffer();
  } else if (p === 'azure') {
    const lang = voice.split('-').slice(0, 2).join('-'); const pct = Math.round((sp - 1) * 100);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${xmlEsc(voice)}"><mstts:express-as style="${style().azure}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${xmlEsc(text)}</prosody></mstts:express-as></voice></speak>`;
    buf = await (await req(`https://${c.region || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': c.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3' }, body: ssml
    })).arrayBuffer();
  } else if (p === 'google') {
    const lang = voice.split('-').slice(0, 2).join('-');
    const j = await (await req('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(c.key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: lang, name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: Math.max(0.25, Math.min(2, sp)), sampleRateHertz: RATE, ...(/Chirp/.test(voice) ? {} : { pitch: style().pitch }) } })
    })).json();
    buf = Uint8Array.from(atob(j.audioContent || ''), (ch) => ch.charCodeAt(0)).buffer;
  }
  return decodeTo(buf);
}

/** OpenAI voices take acting directions: the style, who is speaking, and how the book says the line is delivered. */
function openaiInstructions(ctx) {
  const extra = $('#openaiStyle').value.trim();
  let t = extra || style().openai;
  if (ctx.who && ctx.who !== '*') {
    const desc = (M.cast.desc || {})[ctx.who];
    t += ` This line is dialogue spoken by the character ${ctx.who}${desc ? ` (${desc})` : ''}; perform it in character.`;
  } else if (ctx.who === '*') t += ' This line is dialogue; perform it as a character, not as the narrator.';
  if (ctx.around) t += ` The book describes how it is said: "${ctx.around.slice(0, 140)}". Match that delivery.`;
  if (ctx.prev && !ctx.who) t += ` (For context only, the previous line was: "${ctx.prev.slice(-160)}")`;
  return t;
}

// ----- audio helpers -----
async function decodeTo(buf) {
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const ab = await ctx.decodeAudioData(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (ab.numberOfChannels === 1) return ab.getChannelData(0).slice();
  const a = ab.getChannelData(0), b = ab.getChannelData(1); const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}
function resample(data, from, to) {
  if (from === to) return data;
  const n = Math.round(data.length * to / from); const out = new Float32Array(n); const r = from / to;
  for (let i = 0; i < n; i++) { const x = i * r; const j = Math.floor(x); const f = x - j; out[i] = (data[j] || 0) * (1 - f) + (data[j + 1] ?? data[j] ?? 0) * f; }
  return out;
}
/** Trims long silence at the ends of a clip so pauses stay even. */
function trim(pcm) {
  const th = 0.004; let a = 0, b = pcm.length;
  while (a < b && Math.abs(pcm[a]) < th) a++;
  while (b > a && Math.abs(pcm[b - 1]) < th) b--;
  a = Math.max(0, a - 480); b = Math.min(pcm.length, b + 960);
  return pcm.subarray(a, b);
}

/** One entry point: text → Float32 mono samples at RATE */
async function synth(v, text, sp, ctx) {
  if (v.eng === 'kokoro') return kokoroSynth(v.id, text, Math.max(0.5, Math.min(2, sp)));
  if (v.eng === 'piper') return piperSynth(v.id, text);
  if (v.eng === 'cloud') return cloudSynth(v.provider, v.id, text, sp, ctx || {});
  throw new Error('Pick a voice first.');
}
const speedSupported = (v) => v && v.eng !== 'piper';

// ----- voice list UI -----
function setEngine(eng) {
  M.eng = eng; PREF.eng = eng; savePref();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.eng === eng));
  $('#kokoroOpts').hidden = eng !== 'kokoro'; $('#piperOpts').hidden = eng !== 'piper'; $('#cloudOpts').hidden = eng !== 'cloud';
  $('#engNote').textContent = ENG_NOTES[eng];
  drawVoices();
}
$$('.tab').forEach((t) => { t.onclick = () => setEngine(t.dataset.eng); });

const gOf = (t) => (/\bfemale\b|\bwoman\b|^f$/i.test(t || '') ? 'f' : /\bmale\b|\bman\b|^m$/i.test(t || '') ? 'm' : '');
/** The voices of one engine, as objects { eng, id, name, tags, best, gender, provider? }. Piper: the given language. */
async function voiceList(eng, lang, bestOnly = true) {
  if (eng === 'kokoro') return KOKORO_VOICES.map(([id, name, accent, g, best]) => ({ eng: 'kokoro', id, name, tags: `${accent} · ${g}`, best: !!best, gender: gOf(g.split(' ')[0]) }));
  if (eng === 'piper') {
    const cat = await piperCatalog();
    const order = { high: 0, medium: 1, low: 2, x_low: 3 };
    let vs = cat.filter((v) => v.language.code === lang);
    if (bestOnly) {
      const best = new Map();
      for (const v of vs) { const b = best.get(v.name); if (!b || order[v.quality] < order[b.quality]) best.set(v.name, v); }
      vs = [...best.values()];
    }
    vs.sort((a, b) => order[a.quality] - order[b.quality] || a.name.localeCompare(b.name));
    return vs.map((v) => ({
      eng: 'piper', id: v.key, name: v.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      tags: [PIPER_GENDER[v.name], { x_low: 'basic', low: 'good', medium: 'better', high: 'best' }[v.quality], M.piper.stored.includes(v.key) ? 'downloaded ✓' : fmtMB(piperSize(v))].filter(Boolean).join(' · '),
      best: v.quality === 'high', gender: gOf(PIPER_GENDER[v.name])
    }));
  }
  if (eng.startsWith('cloud:')) {
    const p = eng.slice(6);
    return (M.cloudVoices[p] || []).map((v) => ({ eng: 'cloud', provider: p, id: v.id, name: v.name, tags: v.tags, best: v.best, preview: v.sample, gender: gOf(String(v.tags || '').split(' · ').find((x) => /male|female/i.test(x)) || '') }));
  }
  return [];
}
const engKey = (v) => (v.eng === 'cloud' ? 'cloud:' + v.provider : v.eng);
const piperLangOf = (v) => (v && v.eng === 'piper' ? v.id.split('-')[0] : $('#piperLang').value);

async function drawVoices() {
  const box = $('#voices');
  let list = [];
  if (M.eng === 'piper') {
    box.innerHTML = '<div class="empty">Loading the voice list…</div>';
    let cat;
    try { cat = await piperCatalog(); } catch (e) { box.innerHTML = `<div class="empty">Couldn't load Piper voices: ${esc(e.message)}</div>`; return; }
    const langs = new Map();
    for (const v of cat) langs.set(v.language.code, `${v.language.name_english} (${v.language.country_english})`);
    const sel = $('#piperLang');
    if (!sel.options.length) {
      sel.innerHTML = [...langs.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('');
      const want = PREF.piperLang || (navigator.language || 'en-US').replace('-', '_');
      sel.value = langs.has(want) ? want : [...langs.keys()].find((k) => k.startsWith(want.split('_')[0])) || 'en_US';
    }
    list = await voiceList('piper', sel.value, $('#piperBestOnly').checked);
  } else if (M.eng === 'cloud') {
    const p = $('#cloudProv').value;
    if (!M.cloudVoices[p]) { box.innerHTML = `<div class="empty">Paste your ${esc(CLOUD[p].name)} API key above and press <b>Load voices</b>.</div>`; return; }
    list = await voiceList('cloud:' + p);
  } else list = await voiceList('kokoro');
  if (!list.length) { box.innerHTML = '<div class="empty">No voices here.</div>'; return; }
  box.innerHTML = list.map((v, i) => `
    <div class="voice ${M.voice && M.voice.eng === v.eng && M.voice.id === v.id ? 'sel' : ''}" data-i="${i}" role="button" tabindex="0">
      <button class="play" title="Hear a sample" aria-label="Play sample">▶</button>
      <div class="vi"><div class="vn">${esc(v.name)}${v.best ? ' <span class="star">★</span>' : ''}</div><div class="vt">${esc(v.tags || '')}</div></div>
    </div>`).join('');
  box.querySelectorAll('.voice').forEach((el) => {
    const v = list[+el.dataset.i];
    el.onclick = (e) => { if (e.target.closest('.play')) return; chooseVoice(v); };
    el.onkeydown = (e) => { if (e.key === 'Enter') chooseVoice(v); };
    el.querySelector('.play').onclick = () => playSample(v, el.querySelector('.play'));
  });
}
$('#piperLang').onchange = () => { PREF.piperLang = $('#piperLang').value; savePref(); drawVoices(); };
$('#piperBestOnly').onchange = () => drawVoices();

function chooseVoice(v) {
  M.voice = v; PREF.voice = v; savePref();
  $$('.voice').forEach((el) => el.classList.remove('sel'));
  const box = $('#voices');
  const idx = [...box.querySelectorAll('.voice')].findIndex((el) => el.querySelector('.vn').textContent.replace(' ★', '') === v.name);
  if (idx >= 0) box.querySelectorAll('.voice')[idx].classList.add('sel');
  showChosen(); updateSummary();
  if (M.book && dlgMode() !== 'one') renderCast();
}
function showChosen() {
  const v = M.voice;
  const eng = v ? (v.eng === 'cloud' ? CLOUD[v.provider].name : v.eng === 'kokoro' ? 'Kokoro' : 'Piper') : '';
  $('#voiceChosen').innerHTML = v ? `Voice: <b>${esc(v.name)}</b> · ${esc(eng)}${!speedSupported(v) && speed() !== 1 ? ' · Piper voices read at their own pace, so the speed setting doesn\'t apply.' : ''}` : 'Tap a voice to choose it. Use ▶ to hear it first.';
}

let busyBtn = null;
function setVoiceBusyText(t) { if (busyBtn) busyBtn.title = t; $('#voiceChosen').textContent = t; }
async function playSample(v, btn) {
  const player = $('#player');
  if (btn.classList.contains('on')) { player.pause(); return; }
  const text = ($('#sampleText').value.trim() || 'Hello! This is how I would sound reading your book.').slice(0, 500);
  const key = [v.eng, v.provider, v.id, text, effSpeed(), $('#readStyle').value].join('|');
  $$('.voice .play').forEach((b) => b.classList.remove('on'));
  let url = M.samples.get(key);
  if (!url) {
    if (v.eng === 'cloud' && v.preview && !$('#sampleText').value.trim()) url = v.preview;
    else {
      btn.classList.add('busy'); btn.textContent = '…'; busyBtn = btn;
      if (v.eng === 'kokoro' && !K.ready) setVoiceBusyText('Getting Kokoro ready. The first time, it downloads once…');
      try {
        const pcm = await synth(v, text, effSpeed());
        url = URL.createObjectURL(new Blob([Formats.wav(pcm, RATE)], { type: 'audio/wav' }));
        M.samples.set(key, url);
      } catch (e) {
        toast('Couldn\'t make a sample: ' + e.message, 8000);
        return;
      } finally {
        btn.classList.remove('busy'); btn.textContent = '▶'; busyBtn = null; showChosen();
        if (v.eng === 'piper') drawVoicesSoon();
      }
    }
  }
  player.src = url;
  player.onended = player.onpause = () => { btn.classList.remove('on'); btn.textContent = '▶'; };
  try { await player.play(); btn.classList.add('on'); btn.textContent = '❚❚'; } catch (_) {}
  if (!M.voice) chooseVoice(v);
}
let redrawT = 0;
function drawVoicesSoon() { clearTimeout(redrawT); redrawT = setTimeout(drawVoices, 50); }

$('#speed').oninput = () => {
  $('#speedVal').textContent = speed().toFixed(2).replace(/0$/, '') + '×';
  PREF.speed = speed(); savePref(); showChosen();
  if (M.book) { drawChapters(); updateSummary(); }
};

// cloud settings
function cloudUI() {
  const p = $('#cloudProv').value; const c = cloudCfg(p);
  $('#cloudKey').value = c.key || ''; $('#cloudRegion').value = c.region || '';
  $('#azureRegionF').hidden = p !== 'azure';
  $('#openaiStyleF').hidden = p !== 'openai';
  $('#cloudGetKey').href = CLOUD[p].link; $('#cloudGetKey').textContent = `Get a ${CLOUD[p].name} key`;
  $('#cloudRemember').checked = !!(PREF.cloud && PREF.cloud[p]);
  drawVoices();
}
$('#cloudProv').onchange = () => { PREF.cloudProv = $('#cloudProv').value; savePref(); cloudUI(); };
function storeCloud() {
  const p = $('#cloudProv').value;
  const c = { key: $('#cloudKey').value.trim(), region: $('#cloudRegion').value.trim() };
  M.cloudSession = M.cloudSession || {}; M.cloudSession[p] = c;
  PREF.cloud = PREF.cloud || {};
  if ($('#cloudRemember').checked) PREF.cloud[p] = c; else delete PREF.cloud[p];
  savePref();
}
$('#cloudRemember').onchange = storeCloud;
$('#cloudLoad').onclick = async () => {
  storeCloud();
  const p = $('#cloudProv').value;
  if (!cloudCfg(p).key) { toast('Paste your API key first.'); return; }
  $('#voices').innerHTML = '<div class="empty">Loading voices…</div>';
  try { M.cloudVoices[p] = await cloudVoices(p); }
  catch (e) { $('#voices').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  drawVoices();
};
$('#openaiStyle').onchange = () => { PREF.openaiStyle = $('#openaiStyle').value; savePref(); M.samples.clear(); };
