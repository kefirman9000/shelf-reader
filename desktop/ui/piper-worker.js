// Piper voices (open-source, run on this PC). One voice model is loaded at a time.
import { TtsSession, download, stored, remove } from './vendor/piper.web.js';

let session = null;
let current = null;
let gen = 0;
let chain = Promise.resolve();
const post = (m, t) => self.postMessage(m, t || []);

async function useVoice(voiceId) {
  if (session && current === voiceId) return;
  TtsSession._instance = null;
  session = await TtsSession.create({
    voiceId,
    progress: (p) => post({ type: 'progress', voiceId, p: { loaded: p.loaded, total: p.total } })
  });
  current = voiceId;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'flush') { gen = m.gen; return; }
  chain = chain.then(async () => {
    try {
      if (m.type === 'stored') {
        post({ type: 'stored', id: m.id, list: await stored() });
      } else if (m.type === 'download') {
        await download(m.voiceId, (p) => post({ type: 'progress', voiceId: m.voiceId, p: { loaded: p.loaded, total: p.total } }));
        post({ type: 'downloaded', id: m.id, voiceId: m.voiceId });
      } else if (m.type === 'remove') {
        await remove(m.voiceId);
        if (current === m.voiceId) { session = null; current = null; TtsSession._instance = null; }
        post({ type: 'removed', id: m.id });
      } else if (m.type === 'gen') {
        if (m.gen < gen) { post({ type: 'audio', id: m.id, error: 'dropped' }); return; }
        await useVoice(m.voiceId);
        const blob = await session.predict(m.text);
        const buf = await blob.arrayBuffer();
        post({ type: 'audio', id: m.id, wav: buf }, [buf]);
      }
    } catch (err) {
      post({ type: m.type === 'gen' ? 'audio' : 'error', id: m.id, error: String((err && err.message) || err) });
    }
  });
};
