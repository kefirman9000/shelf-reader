// Background sounds (PC): every sound plays, nothing breaks, the mix stays in range and fades out.
// The phone app's AmbienceSynthTest checks its version against the same loudness figures.
const assert = require('assert');
const A = require('../ui/ambience-synth.js');
const sr = 48000;
for (const s of A.SOUNDS) {
  const g = A.make(s.id, sr, 99);
  let sum = 0; const n = sr * 20;
  for (let i = 0; i < n; i++) { const x = g(); assert(Number.isFinite(x), s.id + ' made a broken sample'); sum += x * x; }
  const rms = Math.sqrt(sum / n);
  assert(rms > 0.01 && rms < 0.7, `${s.id}: loudness ${rms}`);
}
const m = new A.Mixer(sr);
m.set(Object.fromEntries(A.SOUNDS.map((s) => [s.id, 1])), 1);
const buf = new Float32Array(sr);
for (let k = 0; k < 6; k++) { m.render(buf); for (const x of buf) assert(Number.isFinite(x) && Math.abs(x) <= 1, 'out of range ' + x); }
m.set({}, 0);
for (let k = 0; k < 6; k++) m.render(buf);
assert(m.silent(), "didn't fade out");
assert.strictEqual(m.render(buf), 0, 'still making sound after fading out');
for (const p of A.PRESETS) for (const id of Object.keys(p.mix)) assert(A.SOUNDS.some((s) => s.id === id), p.name + ': unknown sound ' + id);
console.log('background sounds ok:', A.SOUNDS.length, 'sounds');
