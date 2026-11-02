// music.js: quiet procedural background music with a lookahead scheduler.
// Every note is a tiny playSfx() voice, so there are no files and CPU stays low.
//
// A track: { bpm, root (MIDI), scale (semitones, pentatonic), chords (semitone offsets from
// root, one chord per bar, I-vi-IV-V style), layers }. One step = an eighth note, 8 steps per bar.
// Layer kinds: pad (chord, once per bar), arp (walks over chord tones), bass (chord root),
// bell (random scale note with probability prob), hat / snare (filtered noise).
// layer.steps = steps of the bar (0..7) on which the layer fires.

import { playSfx } from './sfx.js';

const TICK_MS = 25;
const AHEAD = 0.12; // seconds scheduled in advance
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const ALL = [0, 1, 2, 3, 4, 5, 6, 7];
const CHORDS = [[0, 4, 7], [-3, 0, 4], [-7, -3, 0], [-5, -1, 2]]; // I vi IV V

export const TRACKS = {
  calm: {
    bpm: 72, root: 60, scale: [0, 2, 4, 7, 9], chords: CHORDS,
    layers: [
      { kind: 'pad', steps: [0], wave: 'sine', vol: 0.05, filter: { type: 'lowpass', freq: 900, q: 0.4 } },
      { kind: 'arp', steps: [0, 2, 4, 6], wave: 'triangle', vol: 0.045, pattern: [0, 1, 2, 3, 2, 1],
        filter: { type: 'lowpass', freq: 2400, q: 0.4 } },
      { kind: 'bass', steps: [0], wave: 'sine', vol: 0.07 },
      { kind: 'bell', steps: ALL, wave: 'sine', vol: 0.035, prob: 0.12 },
    ],
  },
  bright: {
    bpm: 112, root: 62, scale: [0, 2, 4, 7, 9], chords: CHORDS,
    layers: [
      { kind: 'pad', steps: [0], wave: 'triangle', vol: 0.03, filter: { type: 'lowpass', freq: 1200, q: 0.4 } },
      { kind: 'arp', steps: ALL, wave: 'triangle', vol: 0.04, pattern: [0, 1, 2, 3, 2, 1, 2, 1],
        filter: { type: 'lowpass', freq: 3000, q: 0.4 } },
      { kind: 'bass', steps: [0, 4, 6], wave: 'triangle', vol: 0.08 },
      { kind: 'bell', steps: ALL, wave: 'sine', vol: 0.035, prob: 0.25 },
      { kind: 'hat', steps: [1, 3, 5, 7], vol: 0.05 },
      { kind: 'snare', steps: [2, 6], vol: 0.06 },
    ],
  },
};

// Small seeded generator so the default melody is repeatable without Math.random.
function lcg(seed = 12345) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Pick the n-th chord tone, climbing an octave every full chord.
const tone = (chord, i) => chord[i % chord.length] + 12 * Math.floor(i / chord.length);

export function createMusic(ctx, dest, opts) {
  const o = opts || {};
  const rnd = o.rnd || lcg();
  let running = false, timer = null, out = null, fading = null;
  let name = 'calm', pending = null, step = 0, next = 0, counters = [];

  function note(m, p, when, vol = 1) {
    playSfx(ctx, out, { jitter: 0, ...p, freq: hz(m) }, { when, vol, rnd });
  }

  function fire(track, L, i, sib, bar, when) {
    const chord = track.chords[bar % track.chords.length];
    const stepDur = 30 / track.bpm, barDur = stepDur * 8;
    const human = 0.85 + 0.3 * rnd();
    switch (L.kind) {
      case 'pad':
        chord.forEach((t, k) => note(track.root + t, {
          wave: L.wave, attack: barDur * 0.3, hold: barDur * 0.4, release: barDur * 0.6,
          volume: L.vol, filter: L.filter, detune: k % 2 ? 6 : -6,
        }, when));
        break;
      case 'arp': {
        const idx = counters[i]++ % L.pattern.length;
        note(track.root + 12 + tone(chord, L.pattern[idx]), {
          wave: L.wave, attack: 0.008, release: Math.min(0.6, stepDur * 3), volume: L.vol, filter: L.filter,
        }, when, sib === 0 ? 1.2 : 1);
        break;
      }
      case 'bass':
        note(track.root - 12 + chord[0], {
          wave: L.wave, attack: 0.012, hold: stepDur * 0.5, release: stepDur * 1.5, volume: L.vol,
          filter: { type: 'lowpass', freq: 420, q: 0.5 },
        }, when);
        break;
      case 'bell':
        if (rnd() < L.prob) {
          const m = track.root + 12 + track.scale[Math.floor(rnd() * track.scale.length)] + (rnd() < 0.5 ? 0 : 12);
          note(m, { wave: L.wave, attack: 0.005, release: 0.9, volume: L.vol }, when);
        }
        break;
      case 'hat':
        playSfx(ctx, out, { wave: 'noise', attack: 0.001, release: 0.035, volume: L.vol,
          filter: { type: 'highpass', freq: 7000, q: 0.5 } }, { when, vol: human, rnd });
        break;
      case 'snare':
        playSfx(ctx, out, { wave: 'noise', attack: 0.001, release: 0.09, volume: L.vol,
          filter: { type: 'bandpass', freq: 1800, q: 0.8 } }, { when, vol: human, rnd });
        break;
    }
  }

  function scheduleStep(when) {
    if (pending && step % 8 === 0) {
      name = pending; pending = null;
      counters = TRACKS[name].layers.map(() => 0); // layer indexes differ between tracks
    }
    const track = TRACKS[name];
    const sib = step % 8, bar = Math.floor(step / 8);
    track.layers.forEach((L, i) => {
      if (L.steps.includes(sib)) fire(track, L, i, sib, bar, when);
    });
  }

  function tick() {
    try {
      const now = ctx.currentTime;
      if (next < now - 0.25) next = now + 0.02; // tab was throttled: skip what was missed
      while (next < now + AHEAD) {
        scheduleStep(next);
        next += 30 / TRACKS[name].bpm;
        step++;
      }
    } catch { /* closed context etc.: never break the page */ }
  }

  function start(trackName = name) {
    const want = TRACKS[trackName] ? trackName : 'calm';
    if (running) { pending = want !== name ? want : null; return; }
    name = want; pending = null; step = 0; counters = TRACKS[name].layers.map(() => 0);
    try {
      if (fading) { fading.disconnect(); fading = null; }
      out = ctx.createGain();
      const t = ctx.currentTime;
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(1, t + 0.4); // gentle fade-in
      out.connect(dest);
      next = t + 0.05;
      const si = o.setInterval || globalThis.setInterval;
      timer = si(tick, TICK_MS);
      running = true;
      tick();
    } catch { running = false; }
  }

  function stop() {
    if (!running) return;
    running = false;
    try { (o.clearInterval || globalThis.clearInterval)(timer); } catch { /* ignore */ }
    timer = null;
    try {
      const t = ctx.currentTime, g = out.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.setTargetAtTime(0, t, 0.12); // fade out; notes already scheduled become inaudible
      fading = out;
    } catch { /* ignore */ }
    out = null;
  }

  return {
    start, stop,
    // Switch track at the next bar line (or set the track used by the next start()).
    setTrack(n) {
      if (!TRACKS[n]) return false;
      if (running) pending = n; else name = n;
      return true;
    },
    get playing() { return running; },
    get track() { return pending || name; },
  };
}
