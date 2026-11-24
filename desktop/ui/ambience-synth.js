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
    { id: 'birds', icon: '🐦', name: 'Morning birds' },
    { id: 'chimes', icon: '🎐', name: 'Wind chimes' },
    { id: 'roof', icon: '🏠', name: 'Rain on a roof' },
    { id: 'train', icon: '🚆', name: 'Train journey' },
    { id: 'clock', icon: '🕰', name: 'Ticking clock' },
    { id: 'purr', icon: '🐈', name: 'Cat purring' },
  ];
  const PRESETS = [
    { name: 'Rainy night', mix: { rain: 0.6, thunder: 0.35 } },
    { name: 'Seaside', mix: { waves: 0.7, wind: 0.2 } },
    { name: 'By the fire', mix: { fire: 0.6, rain: 0.3 } },
    { name: 'Summer night', mix: { crickets: 0.5, stream: 0.3 } },
    { name: 'Focus', mix: { brown: 0.5 } },
    { name: 'Thunderstorm', mix: { roof: 0.6, thunder: 0.6, wind: 0.3 } },
    { name: 'Cozy cabin', mix: { fire: 0.55, roof: 0.4, wind: 0.25 } },
    { name: 'Train ride', mix: { train: 0.65, rain: 0.2 } },
    { name: 'Morning garden', mix: { birds: 0.5, stream: 0.3, chimes: 0.2 } },
    { name: 'Cat nap', mix: { purr: 0.55, clock: 0.3, fire: 0.25 } },
    { name: 'Deep sleep', mix: { brown: 0.45, roof: 0.3 } },
  ];
  // per-sound level so each one is about as loud as the others at the same slider position
  const GAIN = { rain: 0.36, thunder: 3.2, waves: 0.64, stream: 0.62, wind: 1.25, fire: 2.9, crickets: 1.25, fan: 1.4, white: 0.12, pink: 0.24, brown: 0.87,
    birds: 2.4, chimes: 0.95, roof: 1.1, train: 0.5, clock: 2, purr: 1.6 };

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  const coef = (fc, sr) => 1 - Math.exp(-2 * Math.PI * fc / sr);

  function make(id, sr, seed) {
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
      case 'rain': {
        let hp = 0, lp = 0, wob = 0, wobT = 0.5, wobN = 0;
        const aHp = coef(600, sr), aLp = coef(6500, sr), aW = coef(0.4, sr);
        const env = new Float32Array(12), dec = new Float32Array(12); let dh = 0;
        const aDh = coef(2500, sr);
        return () => {
          const x = w(); hp += aHp * (x - hp); const hiss = x - hp; lp += aLp * (hiss - lp);
          if (--wobN <= 0) { wobT = 0.75 + r() * 0.35; wobN = sec(0.5, 2); }
          wob += aW * (wobT - wob);
          if (r() < 70 / sr) for (let i = 0; i < 12; i++) if (env[i] < 0.001) { const a = r(); env[i] = 0.25 + a * a * 1.2; dec[i] = Math.exp(-1 / (sr * (0.003 + r() * 0.01))); break; }
          let d = 0; const y = w(); dh += aDh * (y - dh); const dn = y - dh;
          for (let i = 0; i < 12; i++) if (env[i] > 0.001) { d += env[i] * dn; env[i] *= dec[i]; }
          return lp * 0.55 * wob + d * 0.35;
        };
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
      case 'birds': {
        // a few birds, each singing short phrases of quick chirps (pitch sweeps), with pauses between
        const bd = [];
        for (let i = 0; i < 4; i++) bd.push({ next: sec(0.2, 2), syl: 0, n: 0, t: 0, len: 0, gap: 0, after: 0, f0: 0, f1: 0, ph: 0, base: 2600 + r() * 2200, v: 0.4 + r() * 0.6, style: Math.floor(r() * 3) });
        let bed = 0, bed2 = 0; const aB = coef(1500, sr), aB2 = coef(300, sr);
        return () => {
          let s = 0;
          for (const b of bd) {
            if (b.n === 0) { if (--b.next <= 0) { b.n = 3 + Math.floor(r() * 6); b.syl = 0; b.t = 0; b.len = 0; b.gap = 0; } continue; }
            if (b.t >= b.len) {
              if (b.gap > 0) { b.gap--; continue; }
              if (b.syl >= b.n) { b.n = 0; b.next = sec(0.8, 4.5); continue; }
              b.syl++; b.t = 0; b.len = sec(0.04, 0.13); b.after = sec(0.03, 0.12);
              const up = b.style === 0 ? 1 : b.style === 1 ? -1 : (r() < 0.5 ? 1 : -1);
              b.f0 = b.base * (0.85 + r() * 0.3); b.f1 = b.f0 * (1 + up * (0.2 + r() * 0.5));
            }
            const p = b.t / b.len; const f = b.f0 + (b.f1 - b.f0) * p;
            b.ph += 2 * Math.PI * f / sr; if (b.ph > 1000) b.ph -= 4 * Math.PI * Math.floor(b.ph / (4 * Math.PI));
            const e = Math.sin(Math.PI * p);
            s += Math.sin(b.ph + 0.4 * Math.sin(b.ph * 0.5)) * e * e * b.v;
            if (++b.t >= b.len) b.gap = b.after;
          }
          const x = pink(); bed += aB * (x - bed); bed2 += aB2 * (bed - bed2);
          return s * 0.22 + (bed - bed2) * 0.04;
        };
      }
      case 'chimes': {
        // wind chimes tuned to a pentatonic scale, struck more often when the wind picks up
        const notes = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2].map((k) => 523.25 * k);
        const vo = []; for (let i = 0; i < 8; i++) vo.push({ a: 0, d: 0, w1: 0, w2: 0, p1: 0, p2: 0 });
        let wind = 0.3, windT = 0.3, nw = 0; const aW = coef(0.3, sr);
        let air = 0, air2 = 0; const aA = coef(700, sr);
        return () => {
          if (--nw <= 0) { windT = r() * r(); nw = sec(2, 6); }
          wind += aW * (windT - wind);
          if (r() < (0.5 + wind * 5) / sr) {
            for (const v of vo) if (v.a < 0.002) { const f = notes[Math.floor(r() * notes.length)]; v.a = 0.3 + r() * 0.7; v.d = Math.exp(-1 / (sr * (1.5 + r() * 2))); v.w1 = 2 * Math.PI * f / sr; v.w2 = 2 * Math.PI * f * 2.76 / sr; v.p1 = 0; v.p2 = 0; break; }
          }
          let s = 0;
          for (const v of vo) if (v.a >= 0.002) { v.p1 += v.w1; v.p2 += v.w2; s += v.a * (Math.sin(v.p1) + 0.35 * v.a * Math.sin(v.p2)); v.a *= v.d; }
          const x = pink(); air += aA * (x - air); air2 += aA * (air - air2);
          return s * 0.25 + air2 * wind * 0.5;
        };
      }
      case 'roof': {
        // rain on a roof: muffled patter, heavier drops thudding, and now and then a drip from the gutter
        let lp = 0, lp2 = 0, wob = 0.8, wobT = 0.8, wobN = 0; const aLp = coef(1100, sr), aW = coef(0.3, sr);
        const env = new Float64Array(10), dec = new Float64Array(10); let th = 0, th2 = 0; const aTh = coef(260, sr);
        let drip = 0, dripD = Math.exp(-1 / (sr * 0.05)), dripW = 0, dripP = 0, nextDrip = sec(1, 4);
        const rise = Math.exp(Math.log(1.6) / (sr * 0.05));
        return () => {
          const x = w(); lp += aLp * (x - lp); lp2 += aLp * (lp - lp2);
          if (--wobN <= 0) { wobT = 0.7 + r() * 0.4; wobN = sec(0.7, 2.5); }
          wob += aW * (wobT - wob);
          if (r() < 45 / sr) for (let i = 0; i < 10; i++) if (env[i] < 0.001) { const a = r(); env[i] = 0.3 + a * a * 1.4; dec[i] = Math.exp(-1 / (sr * (0.006 + r() * 0.02))); break; }
          const y = w(); th += aTh * (y - th); th2 += aTh * (th - th2);
          let d = 0; for (let i = 0; i < 10; i++) if (env[i] > 0.001) { d += env[i] * th2; env[i] *= dec[i]; }
          if (--nextDrip <= 0) { drip = 0.5 + r() * 0.5; dripW = 2 * Math.PI * (900 + r() * 500) / sr; dripP = 0; nextDrip = sec(0.6, 3.5); }
          let dr = 0; if (drip > 0.001) { dripW *= rise; dripP += dripW; dr = Math.sin(dripP) * drip; drip *= dripD; }
          return lp2 * 0.9 * wob + d * 1.6 + dr * 0.12;
        };
      }
      case 'train': {
        // a train journey: a low swaying rumble and the clickety-clack of wheels over the rail joints
        let lp = 0, lp2 = 0, sway = 0.8, swayT = 0.8, ns = 0; const aLp = coef(140, sr), aS = coef(0.5, sr);
        let hp = 0, bp = 0; const aHp = coef(500, sr), aBp = coef(2200, sr);
        const per = sec(0.95, 1.15); const gapW = Math.floor(sr * 0.11);
        const hits = [0, gapW, Math.floor(per * 0.55), Math.floor(per * 0.55) + gapW];
        let t = 0, env = 0, thump = 0, tp = 0; const envD = Math.exp(-1 / (sr * 0.018)), thD = Math.exp(-1 / (sr * 0.06)), tw = 2 * Math.PI * 55 / sr;
        return () => {
          if (--ns <= 0) { swayT = 0.65 + r() * 0.45; ns = sec(1, 3); }
          sway += aS * (swayT - sway);
          if (++t >= per) t = 0;
          if (t === hits[0] || t === hits[1] || t === hits[2] || t === hits[3]) { env = 0.7 + r() * 0.3; thump = 0.6 + r() * 0.4; }
          const x = brown(); lp += aLp * (x - lp); lp2 += aLp * (lp - lp2);
          const y = w(); hp += aHp * (y - hp); bp += aBp * ((y - hp) - bp);
          tp += tw; if (tp > 2 * Math.PI) tp -= 2 * Math.PI;
          const c = bp * env + Math.sin(tp) * thump * 0.5;
          env *= envD; thump *= thD;
          return lp2 * 2.2 * sway + c * 0.6;
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
      case 'purr': {
        // a cat purring: low rumbling pulses about 25 times a second, breathing in and out
        let lp = 0, lp2 = 0; const aLp = coef(320, sr);
        let ph = 0, rate = 25, brLen = sec(1.0, 1.5), inhale = true, t = 0;
        return () => {
          if (++t >= brLen) { t = 0; inhale = !inhale; brLen = inhale ? sec(1.0, 1.4) : sec(1.2, 1.8); rate = inhale ? 22 + r() * 3 : 25 + r() * 4; }
          const breath = Math.pow(Math.sin(Math.PI * t / brLen), 0.6) * (inhale ? 0.6 : 1);
          ph += 2 * Math.PI * rate / sr; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
          const pulse = Math.pow(Math.max(0, Math.sin(ph)), 3);
          const x = brown() * 0.8 + pink() * 0.3; lp += aLp * (x - lp); lp2 += aLp * (lp - lp2);
          return lp2 * (0.15 + pulse) * breath * 1.6;
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
    constructor(sr) { this.sr = sr; this.gen = {}; this.g = {}; this.target = {}; this.master = 0; this.masterT = 0; this.seed = 1234; }
    set(mix, master) {
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
        if (!this.gen[id]) this.gen[id] = make(id, this.sr, this.seed++ * 2654435761);
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

  const api = { SOUNDS, PRESETS, GAIN, make, Mixer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmbienceSynth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
