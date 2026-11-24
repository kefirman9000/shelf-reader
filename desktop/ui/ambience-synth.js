// Background sounds, made on the fly (nothing to download): rain, thunder, waves, stream, wind,
// fire, crickets, fan and white / pink / brown noise. Same sounds and levels as the phone app
// (app/src/main/java/com/shelfreader/AmbienceSynth.kt) — keep the two in step.
// Works in the page, in an AudioWorklet, and in Node (for the tests).
(function (root) {
  const SOUNDS = [
    { id: 'rain', icon: '🌧', name: 'Rain' },
    { id: 'thunder', icon: '⛈', name: 'Distant thunder' },
    { id: 'waves', icon: '🌊', name: 'Ocean waves' },
    { id: 'stream', icon: '🏞', name: 'Forest stream' },
    { id: 'wind', icon: '🍃', name: 'Wind' },
    { id: 'fire', icon: '🔥', name: 'Crackling fire' },
    { id: 'crickets', icon: '🦗', name: 'Night crickets' },
    { id: 'fan', icon: '🌀', name: 'Fan' },
    { id: 'white', icon: '⚪', name: 'White noise' },
    { id: 'pink', icon: '🌸', name: 'Pink noise' },
    { id: 'brown', icon: '🟤', name: 'Brown noise' },
    { id: 'soft', icon: '☁', name: 'Soft noise' },
    { id: 'drone', icon: '🎵', name: 'Deep drone' },
    { id: 'airplane', icon: '✈', name: 'Airplane cabin' },
    { id: 'train', icon: '🚆', name: 'Train rumble' },
    { id: 'underwater', icon: '🫧', name: 'Underwater' },
    { id: 'heart', icon: '❤', name: 'Heartbeat' },
    { id: 'clock', icon: '🕰', name: 'Ticking clock' },
  ];
  const PRESETS = [
    { name: 'Rainy night', mix: { rain: 0.6, thunder: 0.35 } },
    { name: 'Seaside', mix: { waves: 0.7, wind: 0.2 } },
    { name: 'By the fire', mix: { fire: 0.6, rain: 0.3 } },
    { name: 'Summer night', mix: { crickets: 0.5, stream: 0.3 } },
    { name: 'Focus', mix: { brown: 0.5 } },
    { name: 'Thunderstorm', mix: { rain: 0.6, thunder: 0.6, wind: 0.3 } },
    { name: 'Cozy cabin', mix: { fire: 0.55, rain: 0.3, wind: 0.25 } },
    { name: 'Night flight', mix: { airplane: 0.65, soft: 0.2 } },
    { name: 'Night train', mix: { train: 0.6, brown: 0.25 } },
    { name: 'Deep focus', mix: { drone: 0.45, brown: 0.35 } },
    { name: 'Deep sleep', mix: { brown: 0.45, soft: 0.35 } },
    { name: 'Underwater', mix: { underwater: 0.6, drone: 0.2 } },
    { name: 'Calm heart', mix: { heart: 0.6, soft: 0.3 } },
    { name: 'Womb', mix: { heart: 0.55, underwater: 0.5 } },
  ];
  // per-sound level so each one is about as loud as the others at the same slider position
  const GAIN = { rain: 0.3, thunder: 3.2, waves: 0.64, stream: 0.62, wind: 1.25, fire: 2.9, crickets: 1.25, fan: 1.4, white: 0.12, pink: 0.24, brown: 0.87,
    soft: 0.3, drone: 1.5, airplane: 0.5, train: 0.55, underwater: 0.55, clock: 2, heart: 0.9 };
  // heartbeat speed, beats a minute (the heartbeat's own setting)
  const HEART = { min: 40, max: 140, def: 60 };

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  const coef = (fc, sr) => 1 - Math.exp(-2 * Math.PI * fc / sr);

  /** P: live settings shared with the mixer, e.g. { heartBpm: 60 }; changes are heard from the next beat. */
  function make(id, sr, seed, P) {
    P = P || { heartBpm: HEART.def };
    const r = rng(seed);
    const w = () => r() * 2 - 1;
    // pink noise (Paul Kellet)
    let p0 = 0, p1 = 0, p2 = 0;
    const pink = () => { const x = w(); p0 = 0.99765 * p0 + x * 0.099046; p1 = 0.963 * p1 + x * 0.2965164; p2 = 0.57 * p2 + x * 1.0526913; return (p0 + p1 + p2 + x * 0.1848) * 0.25; };
    let br = 0;
    const brown = () => { br = (br + 0.02 * w()) / 1.02; return br * 3.5; };
    const sec = (a, b) => Math.floor((a + r() * (b - a)) * sr);

    switch (id) {
      case 'white': return w;
      case 'pink': return pink;
      case 'brown': return brown;
      case 'fan': {
        let l1 = 0, l2 = 0; const a = coef(700, sr), t = 2 * Math.PI * 58 / sr; let ph = 0;
        return () => { const x = brown() * 0.7 + pink() * 0.5; l1 += a * (x - l1); l2 += a * (l1 - l2); ph += t; return l2 + Math.sin(ph) * 0.012; };
      }
      case 'thunder': {
        let next = sec(2, 6), t = 0, att = 1, peak = 0, tau = 1, lvl = 0, lp1 = 0, lp2 = 0, a = coef(200, sr), fl = 0, flT = 1, flN = 0, bed = 0;
        const aFl = coef(6, sr), aBed = coef(70, sr);
        return () => {
          if (--next <= 0) { att = sec(0.15, 0.8); t = 0; const k = r(); peak = 0.35 + k * 0.65; tau = (2 + r() * 4) * sr; a = coef(120 + k * 350, sr); next = sec(10, 28); }
          t++;
          lvl = t < att ? peak * t / att : peak * Math.exp(-(t - att) / tau);
          if (--flN <= 0) { flT = 0.4 + r() * 0.6; flN = sec(0.05, 0.3); }
          fl += aFl * (flT - fl);
          const x = brown(); lp1 += a * (x - lp1); lp2 += a * (lp1 - lp2);
          bed += aBed * (x - bed);
          return lp2 * lvl * fl * 2.2 + bed * 0.12;
        };
      }
      case 'waves': {
        let t = 0, per = sec(7, 12), lp = 0, lp2 = 0, floor = 0.15;
        return () => {
          if (++t >= per) { t = 0; per = sec(7, 12); floor = 0.1 + r() * 0.1; }
          const ph = t / per;
          const e = ph < 0.4 ? Math.pow(ph / 0.4, 2) : Math.exp(-(ph - 0.4) * 5);
          const env = floor + (1 - floor) * e;
          const x = brown() * 0.8 + pink() * (0.3 + 1.4 * e);
          const a = coef(250 + 3800 * Math.pow(e, 1.5), sr);
          lp += a * (x - lp); lp2 += a * (lp - lp2);
          return lp2 * env;
        };
      }
      case 'stream': {
        let hp = 0, lp = 0, lp2 = 0, cut = 2500, cutT = 2500, n = 0;
        const aHp = coef(350, sr), aC = coef(9, sr);
        const f = [0.7 + r(), 1.3 + r(), 2.1 + r() * 2, 3.5 + r() * 3].map(v => 2 * Math.PI * v / sr), ph = [r() * 6, r() * 6, r() * 6, r() * 6];
        return () => {
          const x = pink(); hp += aHp * (x - hp); const b = x - hp;
          if (--n <= 0) { cutT = 1200 + r() * 4000; n = sec(0.03, 0.15); }
          cut += aC * (cutT - cut);
          const a = coef(cut, sr); lp += a * (b - lp); lp2 += a * (lp - lp2);
          let m = 0; for (let i = 0; i < 4; i++) { ph[i] += f[i]; m += Math.sin(ph[i]); }
          return lp2 * (0.7 + 0.075 * m);
        };
      }
      case 'wind': {
        let low = 0, band = 0, fc = 400, fcT = 400, g = 0.5, gT = 0.5, nf = 0, ng = 0;
        const aF = coef(0.25, sr), aG = coef(0.4, sr);
        return () => {
          if (--nf <= 0) { fcT = 180 + r() * 900; nf = sec(2, 5); }
          if (--ng <= 0) { gT = 0.25 + r() * 0.75; ng = sec(1.5, 4); }
          fc += aF * (fcT - fc); g += aG * (gT - g);
          const x = brown() * 0.7 + pink() * 0.4;
          const f = 2 * Math.sin(Math.PI * fc / sr);
          low += f * band; const high = x - low - 0.45 * band; band += f * high;
          return band * g;
        };
      }
      case 'fire': {
        let bed = 0, bed2 = 0, rate = 8, rateT = 8, nr = 0, hp = 0, pl = 0;
        const aB = coef(180, sr), aR = coef(0.8, sr), aHp = coef(1800, sr), aPl = coef(1200, sr);
        const env = new Float32Array(16), dec = new Float32Array(16), pop = new Uint8Array(16);
        return () => {
          if (--nr <= 0) { rateT = 3 + r() * 25; nr = sec(0.4, 2); }
          rate += aR * (rateT - rate);
          const add = (big) => { for (let i = 0; i < 16; i++) if (env[i] < 0.001) { const a = r(); env[i] = big ? 0.6 + a * 0.8 : 0.15 + a * a * a * 1.3; dec[i] = Math.exp(-1 / (sr * (big ? 0.006 + r() * 0.01 : 0.0005 + r() * 0.0025))); pop[i] = big ? 1 : 0; break; } };
          if (r() < rate / sr) add(false);
          if (r() < 0.5 / sr) add(true);
          const x = brown(); bed += aB * (x - bed); bed2 += aB * (bed - bed2);
          const y = w(); hp += aHp * (y - hp); const hn = y - hp; pl += aPl * (y - pl);
          let c = 0; for (let i = 0; i < 16; i++) if (env[i] > 0.001) { c += env[i] * (pop[i] ? pl * 2.5 : hn); env[i] *= dec[i]; }
          return bed2 * 0.5 + c * 0.6;
        };
      }
      case 'clock': {
        // a ticking clock: tick… tock… twice a second, each with a little wooden ring
        const per = Math.floor(sr * 0.5); let t = per - sec(0.05, 0.4), tock = false;
        let env = 0, ring = 0, ph = 0, w0 = 0, bp = 0, bp2 = 0, a = coef(3000, sr);
        const eD = Math.exp(-1 / (sr * 0.004)), rD = Math.exp(-1 / (sr * 0.025));
        return () => {
          if (++t >= per) { t = 0; tock = !tock; env = 0.8 + r() * 0.1; ring = 0.5; w0 = 2 * Math.PI * (tock ? 780 : 960) / sr; ph = 0; a = coef(tock ? 2200 : 3200, sr); }
          const y = w(); bp += a * (y - bp); bp2 += a * (bp - bp2);
          ph += w0;
          const s = (bp - bp2) * env + Math.sin(ph) * ring * 0.25;
          env *= eD; ring *= rD;
          return s;
        };
      }
      case 'rain': {
        // steady rain: an even hiss with a soft body underneath, gently getting heavier and lighter
        let hp = 0, lp = 0, body = 0, body2 = 0, wob = 0.85, wobT = 0.85, wobN = 0;
        const aHp = coef(500, sr), aLp = coef(5500, sr), aB = coef(900, sr), aW = coef(0.25, sr);
        return () => {
          const x = w(); hp += aHp * (x - hp); lp += aLp * ((x - hp) - lp);
          const y = pink(); body += aB * (y - body); body2 += aB * (body - body2);
          if (--wobN <= 0) { wobT = 0.75 + r() * 0.3; wobN = sec(1.5, 4); }
          wob += aW * (wobT - wob);
          return (lp * 0.55 + body2 * 0.7) * wob;
        };
      }
      case 'soft': {
        // soft noise: pink noise with the hiss taken off, like a distant waterfall or a quiet room fan
        let a1 = 0, a2 = 0, a3 = 0; const a = coef(1100, sr);
        return () => { const x = pink(); a1 += a * (x - a1); a2 += a * (a1 - a2); a3 += a * (a2 - a3); return a3 * 1.6; };
      }
      case 'drone': {
        // a deep, warm drone: a few low tones, slightly out of tune with each other so they slowly beat,
        // breathing in and out very slowly, over a little soft noise
        const fs = [55, 55.3, 82.4, 110.2, 164.7], amp = [1, 0.8, 0.5, 0.35, 0.15];
        const ph = fs.map(() => r() * 6.283), wv = fs.map((f) => 2 * Math.PI * f / sr);
        let br1 = 0, brT = 1, brN = 0, lp = 0, lp2 = 0; const aBr = coef(0.08, sr), aLp = coef(400, sr);
        return () => {
          if (--brN <= 0) { brT = 0.7 + r() * 0.3; brN = sec(4, 9); }
          br1 += aBr * (brT - br1);
          let s = 0;
          for (let i = 0; i < fs.length; i++) { ph[i] += wv[i]; if (ph[i] > 6.283185307179586) ph[i] -= 6.283185307179586; s += Math.sin(ph[i]) * amp[i]; }
          const x = brown(); lp += aLp * (x - lp); lp2 += aLp * (lp - lp2);
          return s * 0.12 * br1 + lp2 * 0.25;
        };
      }
      case 'airplane': {
        // inside an airliner at night: a steady, deep roar of the engines and air, with a low engine hum
        let lp = 0, lp2 = 0, hp = 0, mid = 0, mid2 = 0; const aLp = coef(260, sr), aHp = coef(150, sr), aM = coef(1400, sr);
        const h1 = 2 * Math.PI * 92 / sr, h2 = 2 * Math.PI * 184.5 / sr; let p1 = 0, p2 = 0;
        return () => {
          const x = brown(); lp += aLp * (x - lp); lp2 += aLp * (lp - lp2);
          const y = pink(); hp += aHp * (y - hp); mid += aM * ((y - hp) - mid); mid2 += aM * (mid - mid2);
          p1 += h1; if (p1 > 6.283185307179586) p1 -= 6.283185307179586; p2 += h2; if (p2 > 6.283185307179586) p2 -= 6.283185307179586;
          return lp2 * 1.6 + mid2 * 0.9 + Math.sin(p1) * 0.02 + Math.sin(p2) * 0.01;
        };
      }
      case 'train': {
        // the low rumble of a train carriage, swaying slowly
        let lp = 0, lp2 = 0, lp3 = 0, sway = 0.85, swayT = 0.85, ns = 0, mid = 0, mid2 = 0;
        const aLp = coef(120, sr), aS = coef(0.35, sr), aM = coef(600, sr);
        return () => {
          if (--ns <= 0) { swayT = 0.7 + r() * 0.3; ns = sec(1.5, 4); }
          sway += aS * (swayT - sway);
          const x = brown(); lp += aLp * (x - lp); lp2 += aLp * (lp - lp2); lp3 += aLp * (lp2 - lp3);
          const y = pink(); mid += aM * (y - mid); mid2 += aM * (mid - mid2);
          return (lp3 * 2.6 + mid2 * 0.35) * sway;
        };
      }
      case 'underwater': {
        // deep under water: a muffled, slowly swelling low rush
        let lp = 0, lp2 = 0, lp3 = 0, sw = 0.8, swT = 0.8, ns = 0; const aLp = coef(220, sr), aS = coef(0.12, sr);
        return () => {
          if (--ns <= 0) { swT = 0.55 + r() * 0.45; ns = sec(3, 7); }
          sw += aS * (swT - sw);
          const x = brown() * 0.8 + pink() * 0.4; lp += aLp * (x - lp); lp2 += aLp * (lp - lp2); lp3 += aLp * (lp2 - lp3);
          return lp3 * 2.4 * sw;
        };
      }
      case 'heart': {
        // a calm heartbeat, lub-dub, at the speed you choose. Each beat is a soft low thud that drops in pitch.
        let next = 0, t = 0, s2At = -1, e1 = 0, e2 = 0, a1 = 0, a2 = 0, f1 = 0, f2 = 0, ph1 = 0, ph2 = 0, lp = 0, lp2 = 0, bed = 0, bed2 = 0;
        const d1 = Math.exp(-1 / (sr * 0.075)), d2 = Math.exp(-1 / (sr * 0.06)), fd = Math.exp(-1 / (sr * 0.035)), kA = coef(80, sr);
        const aLp = coef(200, sr), aB = coef(80, sr), TAU = 2 * Math.PI;
        return () => {
          if (--next <= 0) {
            const bpm = Math.max(HEART.min, Math.min(HEART.max, +P.heartBpm || HEART.def));
            const period = 60 / bpm * (0.98 + r() * 0.04);   // a living heart isn't a metronome
            next = Math.floor(period * sr); t = 0;
            s2At = Math.floor(Math.min(0.32, period * 0.36) * sr);
            e1 = 0.9 + r() * 0.1; a1 = 0; f1 = 120; ph1 = 0;
          }
          if (t++ === s2At) { e2 = 0.6 + r() * 0.1; a2 = 0; f2 = 150; ph2 = 0; }
          f1 = 52 + (f1 - 52) * fd; f2 = 64 + (f2 - 64) * fd;
          ph1 += TAU * f1 / sr; if (ph1 > TAU) ph1 -= TAU;
          ph2 += TAU * f2 / sr; if (ph2 > TAU) ph2 -= TAU;
          a1 += kA * (1 - a1); a2 += kA * (1 - a2);
          const x = w(); lp += aLp * (x - lp); lp2 += aLp * (lp - lp2);
          const y = brown(); bed += aB * (y - bed); bed2 += aB * (bed - bed2);
          const out = (Math.sin(ph1) + lp2 * 2.5) * e1 * a1 + (Math.sin(ph2) + lp2 * 2.5) * e2 * a2 + bed2 * 0.15;
          e1 *= d1; e2 *= d2;
          return out;
        };
      }
      case 'crickets': {
        const N = 3, cr = [];
        for (let i = 0; i < N; i++) cr.push({ f: 2 * Math.PI * (4200 + r() * 1000) / sr, ph: 0, next: sec(0.1, 1.2), pulse: -1, t: 0, pl: Math.floor(sr * 0.016), gap: Math.floor(sr * 0.014), n: 3 + Math.floor(r() * 2), v: 0.35 + r() * 0.65, every: [0.55 + r() * 0.5] });
        let bed = 0; const aB = coef(900, sr);
        return () => {
          let s = 0;
          for (const c of cr) {
            if (c.pulse < 0) { if (--c.next <= 0) { c.pulse = 0; c.t = 0; } }
            else {
              const cyc = c.pl + c.gap;
              if (c.t < c.pl) { const e = Math.sin(Math.PI * c.t / c.pl); c.ph += c.f; s += Math.sin(c.ph) * e * e * c.v; }
              if (++c.t >= cyc) { c.t = 0; if (++c.pulse >= c.n) { c.pulse = -1; c.next = Math.floor(sr * c.every[0] * (0.85 + r() * 0.3)); if (r() < 0.04) c.next += sec(2, 5); } }
            }
          }
          const x = pink(); bed += aB * (x - bed);
          return s * 0.18 + bed * 0.25;
        };
      }
    }
    return () => 0;
  }

  /** Mixes the chosen sounds. mix = { rain: 0.6, … } (0–1 each); master 0–1. */
  class Mixer {
    constructor(sr) { this.sr = sr; this.gen = {}; this.g = {}; this.target = {}; this.master = 0; this.masterT = 0; this.seed = 1234; this.params = { heartBpm: HEART.def }; }
    set(mix, master, params) {
      if (params) Object.assign(this.params, params);
      for (const s of SOUNDS) { const v = Math.max(0, Math.min(1, +(mix && mix[s.id]) || 0)); this.target[s.id] = v * v * GAIN[s.id]; }
      this.masterT = Math.max(0, Math.min(1, master));
    }
    silent() { return this.master < 1e-4 && this.masterT === 0; }
    render(out, n = out.length) {
      const ids = SOUNDS.map(s => s.id);
      const kG = 1 - Math.exp(-1 / (this.sr * 0.08)), kM = 1 - Math.exp(-1 / (this.sr * 0.6));
      const act = [];
      for (const id of ids) {
        const tg = this.target[id] || 0, g = this.g[id] || 0;
        if (tg === 0 && g < 1e-4) { this.g[id] = 0; if (this.gen[id]) delete this.gen[id]; continue; }
        if (!this.gen[id]) this.gen[id] = make(id, this.sr, this.seed++ * 2654435761, this.params);
        act.push(id);
      }
      for (let i = 0; i < n; i++) {
        this.master += kM * (this.masterT - this.master);
        let x = 0;
        for (const id of act) { const g = this.g[id] = (this.g[id] || 0) + kG * ((this.target[id] || 0) - (this.g[id] || 0)); x += this.gen[id]() * g; }
        x *= this.master;
        // gentle limiter
        out[i] = x > 0.6 ? 0.6 + (x - 0.6) / (1 + ((x - 0.6) / 0.4) ** 2) ** 0.5 : x < -0.6 ? -0.6 + (x + 0.6) / (1 + ((x + 0.6) / 0.4) ** 2) ** 0.5 : x;
      }
      return act.length;
    }
  }

  const api = { SOUNDS, PRESETS, GAIN, HEART, make, Mixer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmbienceSynth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
