// sfx.js: procedural sound effects. A preset is a plain object describing a WebAudio graph.
// No samples, no downloads. Pure functions: ctx / rnd are passed in, nothing global is touched.
//
// params:
//   wave      'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise'   (no wave = container for layers)
//   freq      Hz (for noise: centre of the default band-pass), freqEnd  exponential slide target
//   attack, hold, release   seconds (default .005 / 0 / .1); release is exponential
//   volume    peak gain before the sfx bus (default .2; noise gets a built-in make-up gain)
//   vibrato   { rate Hz, depth cents }
//   filter    { type, freq, q, freqEnd? }   freqEnd sweeps the filter (whoosh)
//   jitter    0..1  random pitch spread (up to about +-0.6 semitone)
//   notes     [semitone offsets] played one after another (arpeggio), noteLen seconds apart
//   detune    cents, delay  start offset in seconds
//   layers    [params]  extra voices started together with this one

const NOISE_MAKEUP = 2.5; // band-limited noise is much quieter than a sine at the same gain
const NOISE_SECONDS = 1.6;
const semi = s => Math.pow(2, s / 12);

const A = [0, 4, 7, 12, 16, 19]; // major arpeggio, used by win / reward

export const PRESETS = {
  tap: {
    wave: 'triangle', freq: 620, freqEnd: 430, attack: 0.002, release: 0.07, volume: 0.22,
    filter: { type: 'lowpass', freq: 2600, q: 0.5 }, jitter: 0.35,
  },
  select: {
    wave: 'sine', freq: 700, freqEnd: 940, attack: 0.004, release: 0.1, volume: 0.2, jitter: 0.2,
    layers: [{ wave: 'sine', freq: 1400, freqEnd: 1880, attack: 0.004, release: 0.06, volume: 0.05 }],
  },
  pop: {
    wave: 'sine', freq: 380, freqEnd: 900, attack: 0.002, release: 0.09, volume: 0.26, jitter: 0.4,
    layers: [{ wave: 'noise', attack: 0.001, release: 0.02, volume: 0.06,
      filter: { type: 'bandpass', freq: 2500, q: 1 } }],
  },
  drop: {
    wave: 'triangle', freq: 760, freqEnd: 240, attack: 0.004, release: 0.2, volume: 0.24, jitter: 0.2,
    filter: { type: 'lowpass', freq: 1800, q: 0.6 },
  },
  merge: { // rising "ba-ding"; pass { pitch } to climb with the merge level
    wave: 'triangle', freq: 440, notes: [0, 7], noteLen: 0.065, attack: 0.006, release: 0.2, volume: 0.22,
    filter: { type: 'lowpass', freq: 3200, q: 0.5 },
    layers: [{ wave: 'sine', freq: 880, notes: [0, 7], noteLen: 0.065, attack: 0.006, release: 0.25,
      volume: 0.07, detune: 6 }],
  },
  coin: {
    wave: 'triangle', freq: 988, notes: [0, 5], noteLen: 0.075, attack: 0.003, release: 0.28, volume: 0.2,
    layers: [{ wave: 'sine', freq: 1976, notes: [0, 5], noteLen: 0.075, attack: 0.003, release: 0.2,
      volume: 0.05 }],
  },
  combo: {
    wave: 'triangle', freq: 523, notes: [0, 4, 7, 12], noteLen: 0.055, attack: 0.004, release: 0.22,
    volume: 0.19, filter: { type: 'lowpass', freq: 4000, q: 0.5 },
    layers: [{ wave: 'sine', freq: 1046, notes: [0, 4, 7, 12], noteLen: 0.055, release: 0.2, volume: 0.05 }],
  },
  win: {
    wave: 'triangle', freq: 392, notes: A, noteLen: 0.09, attack: 0.006, release: 0.4, volume: 0.2,
    filter: { type: 'lowpass', freq: 4200, q: 0.5 },
    layers: [
      { wave: 'sine', freq: 196, attack: 0.02, hold: 0.4, release: 0.7, volume: 0.12, delay: 0.35 },
      { wave: 'sine', freq: 784, notes: A, noteLen: 0.09, release: 0.5, volume: 0.05, detune: 8 },
    ],
  },
  lose: {
    wave: 'triangle', freq: 330, notes: [0, -3, -7], noteLen: 0.16, attack: 0.01, release: 0.35,
    volume: 0.2, filter: { type: 'lowpass', freq: 1100, q: 0.5 }, vibrato: { rate: 5, depth: 20 },
  },
  whoosh: {
    wave: 'noise', attack: 0.06, hold: 0.02, release: 0.24, volume: 0.2,
    filter: { type: 'bandpass', freq: 300, freqEnd: 2400, q: 1 },
  },
  thud: {
    layers: [
      { wave: 'sine', freq: 130, freqEnd: 48, attack: 0.003, release: 0.25, volume: 0.3 },
      { wave: 'noise', attack: 0.001, release: 0.09, volume: 0.15, filter: { type: 'lowpass', freq: 400, q: 0.7 } },
    ],
  },
  error: { // soft low double buzz, not harsh
    wave: 'square', freq: 247, notes: [0, -4], noteLen: 0.1, attack: 0.006, release: 0.14, volume: 0.15,
    filter: { type: 'lowpass', freq: 800, q: 0.7 },
  },
  click: {
    wave: 'triangle', freq: 1800, freqEnd: 900, attack: 0.001, release: 0.03, volume: 0.15,
    layers: [{ wave: 'noise', attack: 0.0005, release: 0.015, volume: 0.08,
      filter: { type: 'highpass', freq: 3500, q: 0.7 } }],
  },
  unlock: {
    wave: 'sine', freq: 659, notes: [0, 4, 7, 12, 16], noteLen: 0.07, attack: 0.005, release: 0.32,
    volume: 0.17,
    layers: [{ wave: 'triangle', freq: 1318, notes: [0, 4, 7, 12, 16], noteLen: 0.07, release: 0.25, volume: 0.04 }],
  },
  reward: {
    wave: 'triangle', freq: 440, notes: A, noteLen: 0.075, attack: 0.005, release: 0.45, volume: 0.19,
    filter: { type: 'lowpass', freq: 4500, q: 0.5 },
    layers: [
      { wave: 'sine', freq: 880, notes: A, noteLen: 0.075, release: 0.5, volume: 0.06, detune: 8 },
      { wave: 'noise', attack: 0.01, release: 0.3, volume: 0.04, delay: 0.3,
        filter: { type: 'highpass', freq: 6000, q: 0.6 } },
    ],
  },
  // extras for painting / liquid games
  splash: {
    layers: [
      { wave: 'noise', attack: 0.01, release: 0.3, volume: 0.2, filter: { type: 'bandpass', freq: 1800, freqEnd: 500, q: 0.8 } },
      { wave: 'sine', freq: 300, freqEnd: 700, attack: 0.003, release: 0.12, volume: 0.12, delay: 0.03, jitter: 0.5 },
    ],
  },
  bubble: { wave: 'sine', freq: 300, freqEnd: 780, attack: 0.003, release: 0.1, volume: 0.2, jitter: 0.5 },
  sparkle: {
    wave: 'sine', freq: 1568, notes: [0, 12, 7, 16], noteLen: 0.05, attack: 0.003, release: 0.2, volume: 0.1,
  },
};

// Length of one voice (its notes), without layers.
function voiceSpan(p) {
  const n = p.notes && p.notes.length ? p.notes.length : 1;
  return (n - 1) * (p.noteLen ?? 0.08) + (p.attack ?? 0.005) + (p.hold ?? 0) + (p.release ?? 0.1);
}

// Total length in seconds (pitch does not change it).
export function duration(p) {
  if (!p) return 0;
  let d = p.wave ? voiceSpan(p) : 0;
  for (const l of p.layers || []) d = Math.max(d, duration(l));
  return (p.delay || 0) + d;
}

// One shared white-noise buffer per context.
const noiseCache = new WeakMap();
function noiseBuffer(ctx, rnd) {
  let b = noiseCache.get(ctx);
  if (!b) {
    const sr = ctx.sampleRate || 44100;
    b = ctx.createBuffer(1, Math.floor(sr * NOISE_SECONDS), sr);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

// Play one voice (all its arpeggio notes). Returns the end time.
function voice(ctx, out, p, t0, rate, vol, rnd, jit) {
  const notes = p.notes && p.notes.length ? p.notes : [0];
  const nl = p.noteLen ?? 0.08;
  const a = p.attack ?? 0.005, h = p.hold ?? 0, r = p.release ?? 0.1;
  const total = a + h + r;
  const noise = p.wave === 'noise';
  const peak = (p.volume ?? 0.2) * vol * (noise ? NOISE_MAKEUP : 1);
  const f0 = (p.freq ?? 440) * rate * jit;
  let end = t0;
  notes.forEach((s, i) => {
    const t = t0 + i * nl, te = t + total, k = semi(s);
    // envelope: starts at 0 (no click), exponential tail
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    if (h > 0) g.gain.setValueAtTime(peak, t + a + h);
    g.gain.exponentialRampToValueAtTime(0.0001, te);
    g.connect(out);
    let src, head;
    if (noise) {
      src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, rnd);
      src.loop = true;
    } else {
      src = ctx.createOscillator();
      src.type = p.wave;
      src.frequency.setValueAtTime(f0 * k, t);
      if (p.freqEnd) src.frequency.exponentialRampToValueAtTime(Math.max(1, p.freqEnd * rate * jit * k), te);
      if (p.detune && src.detune) src.detune.value = p.detune;
    }
    head = src;
    // filter (noise without an explicit filter gets a band-pass around freq)
    const fl = p.filter || (noise && p.freq ? { type: 'bandpass', freq: p.freq, q: 0.8 } : null);
    if (fl) {
      const f = ctx.createBiquadFilter();
      f.type = fl.type || 'lowpass';
      const ff = fl.freq * (noise ? rate : Math.sqrt(rate));
      f.frequency.setValueAtTime(ff, t);
      if (fl.freqEnd) f.frequency.exponentialRampToValueAtTime(fl.freqEnd * rate, te);
      f.Q.value = fl.q ?? 0.7;
      src.connect(f);
      f.connect(g);
    } else {
      src.connect(g);
    }
    let lfo = null;
    if (p.vibrato && !noise) {
      lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = p.vibrato.rate || 5;
      lg.gain.value = f0 * k * (p.vibrato.depth || 15) / 1200 * 0.69;
      lfo.connect(lg);
      lg.connect(src.frequency);
      lfo.start(t);
      lfo.stop(te + 0.03);
    }
    if (noise) src.start(t, rnd() * (NOISE_SECONDS - 0.7));
    else src.start(t);
    src.stop(te + 0.03);
    src.onended = () => { try { g.disconnect(); } catch { /* already gone */ } };
    end = Math.max(end, te);
  });
  return end;
}

// Play params on ctx into dest. opts: when (ctx time), vol (multiplier), rate (frequency
// multiplier, 1 = as written), pan (-1..1), rnd (default Math.random).
// Returns the end time (ctx seconds).
export function playSfx(ctx, dest, params, opts = {}) {
  const when = opts.when ?? ctx.currentTime;
  const vol = opts.vol ?? 1, rate = opts.rate ?? 1;
  const rnd = opts.rnd || Math.random;
  let out = dest;
  if (opts.pan && ctx.createStereoPanner) {
    const pn = ctx.createStereoPanner();
    pn.pan.value = Math.max(-1, Math.min(1, opts.pan));
    pn.connect(dest);
    out = pn;
  }
  const run = (p, t, inheritedJit) => {
    const jit = p.jitter ? Math.pow(2, ((rnd() * 2 - 1) * p.jitter * 0.6) / 12) : inheritedJit;
    const t0 = t + (p.delay || 0);
    let end = t0;
    if (p.wave) end = voice(ctx, out, p, t0, rate, vol, rnd, jit);
    for (const l of p.layers || []) end = Math.max(end, run(l, t0, jit));
    return end;
  };
  return run(params, when, 1);
}
