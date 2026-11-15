// Natural voices (Kokoro, open-source, runs on this PC). Runs in a worker so the app stays responsive.
import { KokoroTTS } from './vendor/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;
let gen = 0;           // bumped by "flush" to drop queued requests after a jump
let chain = Promise.resolve();

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    chain = chain.then(async () => {
      try {
        tts = await KokoroTTS.from_pretrained(MODEL, {
          dtype: m.dtype,
          device: m.device,
          progress_callback: (p) => self.postMessage({ type: 'progress', p: { status: p.status, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress } })
        });
        self.postMessage({ type: 'ready' });
      } catch (err) {
        self.postMessage({ type: 'loaderror', error: String((err && err.message) || err) });
      }
    });
  } else if (m.type === 'flush') {
    gen = m.gen;
  } else if (m.type === 'gen') {
    chain = chain.then(async () => {
      if (m.gen < gen) { self.postMessage({ type: 'audio', id: m.id, error: 'dropped' }); return; }
      if (!tts) { self.postMessage({ type: 'audio', id: m.id, error: 'voices are not loaded' }); return; }
      try {
        const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
        const data = out.audio;
        self.postMessage({ type: 'audio', id: m.id, data, rate: out.sampling_rate }, [data.buffer]);
      } catch (err) {
        self.postMessage({ type: 'audio', id: m.id, error: String((err && err.message) || err) });
      }
    });
  }
};
