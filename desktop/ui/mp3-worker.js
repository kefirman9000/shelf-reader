// Streams audio (Float32 samples) into an MP3 file, chunk by chunk, off the main thread.
// Messages: {type:'start', rate} → {type:'chunk', pcm} … → {type:'end'} → replies {mp3: Uint8Array}
importScripts('vendor/lame.all.js');

let enc = null;
let parts = [];
let size = 0;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'start') {
      enc = new lamejs.Mp3Encoder(1, m.rate, m.kbps || 64);
      parts = []; size = 0;
      self.postMessage({ ok: true });
    } else if (m.type === 'chunk') {
      const f = m.pcm; const s = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); s[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      for (let i = 0; i < s.length; i += 1152) {
        const b = enc.encodeBuffer(s.subarray(i, i + 1152));
        if (b.length) { parts.push(b); size += b.length; }
      }
      self.postMessage({ ok: true });
    } else if (m.type === 'end') {
      const f = enc.flush(); if (f.length) { parts.push(f); size += f.length; }
      const out = new Uint8Array(size); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      parts = []; size = 0; enc = null;
      self.postMessage({ mp3: out }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
