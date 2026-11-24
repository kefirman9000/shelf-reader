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
// the heartbeat follows its speed setting
{
  const beats = (bpm) => { const g = A.make('heart', 8000, 7, { heartBpm: bpm }); let n = 0, quiet = 0; for (let i = 0; i < 8000 * 30; i++) { const x = Math.abs(g()); if (quiet > 0) quiet--; else if (x > 0.4) { n++; quiet = 8000 * 0.15; } } return n; };
  const slow = beats(50), fast = beats(120);
  assert(slow >= 40 && slow <= 55 && fast >= 100 && fast <= 125, `heartbeat speed: ${slow} thuds in 30 s at 50 a minute (want about 50: lub and dub), ${fast} at 120 (about 120)`);
  console.log('heartbeat speed ok:', slow, 'vs', fast, 'thuds in 30 s');
}
