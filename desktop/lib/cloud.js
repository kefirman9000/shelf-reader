'use strict';
// Premium cloud voices with the user's own API keys. Keys stay on this PC (settings.json)
// and are only sent to the provider they belong to.

const PROVIDERS = {
  openai: { name: 'OpenAI', needs: ['key'], defaults: { model: 'gpt-4o-mini-tts' } },
  elevenlabs: { name: 'ElevenLabs', needs: ['key'], defaults: { model: 'eleven_multilingual_v2' } },
  azure: { name: 'Microsoft Azure', needs: ['key', 'region'], defaults: { region: 'eastus' } },
  google: { name: 'Google Cloud', needs: ['key'], defaults: {} }
};

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

async function req(url, opts = {}, timeout = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const body = await r.text();
        const j = JSON.parse(body);
        msg = (j.error && (j.error.message || j.error)) || (j.detail && (j.detail.message || j.detail)) || j.message || msg;
        if (typeof msg !== 'string') msg = JSON.stringify(msg).slice(0, 200);
      } catch (_) {}
      if (r.status === 401 || r.status === 403) msg = 'The API key was rejected: ' + msg;
      throw new Error(msg);
    }
    return r;
  } finally {
    clearTimeout(t);
  }
}

const cfg = (settings, p) => Object.assign({}, PROVIDERS[p].defaults, (settings.cloud || {})[p] || {});
const configured = (settings, p) => PROVIDERS[p].needs.every((k) => !!cfg(settings, p)[k]);

/** Settings safe to show in the UI (keys masked). */
function publicView(settings) {
  const out = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const c = cfg(settings, id);
    out[id] = { name: p.name, configured: configured(settings, id), keyHint: c.key ? '••••' + String(c.key).slice(-4) : '', region: c.region || '', model: c.model || '' };
  }
  return out;
}

async function voices(settings, p) {
  if (!configured(settings, p)) return [];
  const c = cfg(settings, p);
  if (p === 'openai') return OPENAI_VOICES.map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1), lang: 'en-US', gender: '' }));
  if (p === 'elevenlabs') {
    const j = await (await req('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': c.key } })).json();
    return (j.voices || []).map((v) => ({
      id: v.voice_id, name: v.name, lang: (v.labels && v.labels.accent) || '', gender: (v.labels && v.labels.gender) || ''
    }));
  }
  if (p === 'azure') {
    const j = await (await req(`https://${c.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': c.key } })).json();
    return j.filter((v) => /^en-/i.test(v.Locale)).map((v) => ({ id: v.ShortName, name: v.LocalName || v.DisplayName, lang: v.Locale, gender: v.Gender || '' }));
  }
  if (p === 'google') {
    const j = await (await req('https://texttospeech.googleapis.com/v1/voices?languageCode=en&key=' + encodeURIComponent(c.key))).json();
    const rank = (n) => (/Chirp3-HD/.test(n) ? 0 : /Studio/.test(n) ? 1 : /Neural2/.test(n) ? 2 : /Wavenet/.test(n) ? 3 : 4);
    return (j.voices || []).filter((v) => rank(v.name) < 4).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
      .map((v) => ({ id: v.name, name: v.name.split('-').slice(2).join(' '), lang: (v.languageCodes || [])[0] || '', gender: (v.ssmlGender || '').toLowerCase() }));
  }
  return [];
}

const esc = (s) => s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));

/** Returns { audio: Buffer (mp3), applied: boolean (speed handled by provider) } */
async function speak(settings, p, voice, text, speed = 1) {
  if (!configured(settings, p)) throw new Error(`Add your ${PROVIDERS[p].name} key in Voice options first.`);
  const c = cfg(settings, p);
  if (p === 'openai') {
    const r = await req('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: c.model || 'gpt-4o-mini-tts', voice, input: text.slice(0, 4000), response_format: 'mp3', speed: Math.max(0.25, Math.min(4, speed)) })
    });
    return { audio: Buffer.from(await r.arrayBuffer()), applied: true };
  }
  if (p === 'elevenlabs') {
    const r = await req(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': c.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: c.model || 'eleven_multilingual_v2' })
    });
    return { audio: Buffer.from(await r.arrayBuffer()), applied: false };
  }
  if (p === 'azure') {
    const lang = voice.split('-').slice(0, 2).join('-');
    const pct = Math.round((speed - 1) * 100);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${esc(voice)}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${esc(text)}</prosody></voice></speak>`;
    const r = await req(`https://${c.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': c.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'ShelfReader' },
      body: ssml
    });
    return { audio: Buffer.from(await r.arrayBuffer()), applied: true };
  }
  if (p === 'google') {
    const lang = voice.split('-').slice(0, 2).join('-');
    const r = await req('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(c.key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: lang, name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: Math.max(0.25, Math.min(2, speed)) } })
    });
    const j = await r.json();
    return { audio: Buffer.from(j.audioContent || '', 'base64'), applied: speed <= 2 };
  }
  throw new Error('unknown provider');
}

module.exports = { PROVIDERS, publicView, voices, speak };
