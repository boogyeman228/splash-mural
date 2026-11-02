// audio.js: audio manager. Owns the AudioContext, the buses, mute reasons, the voice cap and
// the sample cache. Nothing browser-specific runs at import time (safe in Node tests).
//
//   sfx voices ─┐
//               ├─ sfxBus ─┐
//   music ──────── musicBus ─┴─ master (mute ramp) ─ destination

import { PRESETS, playSfx, duration } from './sfx.js';
import { createMusic, TRACKS } from './music.js';

const MAX_VOICES = 8;
const MIN_GAP = 0.035; // seconds between two plays of the same preset
const TC = 0.02;       // ramp time constant: ~60 ms to settle, no clicks
const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

// Smoothly move an AudioParam to target.
function ramp(ctx, param, target) {
  try {
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.setTargetAtTime(target, t, TC);
    if (target === 0) param.setValueAtTime(0, t + 0.3); // land exactly on silence
  } catch { /* ignore */ }
}

export function createAudio(opts = {}) {
  let ctx = null, master = null, sfxBus = null, musicBus = null, music = null;
  let sfxOn = opts.sfxOn !== false, musicOn = opts.musicOn !== false;
  let sfxVolume = clamp01(opts.sfxVolume ?? 0.8), musicVolume = clamp01(opts.musicVolume ?? 0.45);
  let wantedTrack = null; // what the game asked for; played when unlocked and allowed
  let voices = [];        // end times of sounds that may still be audible
  const mutes = new Set(), presets = { ...PRESETS }, samples = new Map(), lastPlay = new Map();
  const pendingSamples = [];

  const busTargets = () => [sfxOn ? sfxVolume : 0, musicOn ? musicVolume : 0];
  const masterTarget = () => (mutes.size ? 0 : 1);

  function refresh() {
    if (!ctx) return;
    const [s, m] = busTargets();
    ramp(ctx, sfxBus.gain, s);
    ramp(ctx, musicBus.gain, m);
    ramp(ctx, master.gain, masterTarget());
  }

  function syncMusic() {
    if (!music) return;
    if (wantedTrack && musicOn) music.start(wantedTrack);
    else if (music.playing) music.stop();
  }

  function resume() {
    try {
      if (ctx.state !== 'running') {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
    } catch { /* ignore */ }
  }

  function decode(buf) {
    // old Safari only knows the callback form
    return new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  async function loadNow(name, url) {
    try {
      const f = opts.fetch || (opts.win || globalThis).fetch || globalThis.fetch;
      const r = await f(url);
      if (r.ok === false) return false;
      samples.set(name, await decode(await r.arrayBuffer()));
      return true;
    } catch { return false; }
  }

  function unlock() {
    if (!ctx) {
      try {
        const win = opts.win || globalThis;
        const Ctor = opts.AudioContext || win.AudioContext || win.webkitAudioContext;
        if (!Ctor) return null;
        const c = new Ctor();
        const m = c.createGain(), sb = c.createGain(), mb = c.createGain();
        m.gain.value = masterTarget();
        [sb.gain.value, mb.gain.value] = busTargets();
        sb.connect(m); mb.connect(m); m.connect(c.destination);
        ctx = c; master = m; sfxBus = sb; musicBus = mb;
        music = createMusic(c, mb, opts.timers);
      } catch { ctx = null; return null; }
      // iOS wants a real (silent) sound inside the gesture
      try {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, 22050);
        s.connect(ctx.destination);
        s.start(0);
      } catch { /* ignore */ }
      for (const j of pendingSamples.splice(0)) loadNow(j.name, j.url).then(j.done);
      syncMusic();
    }
    resume();
    return ctx;
  }

  function attachUnlock(target) {
    const evs = ['pointerdown', 'keydown', 'touchend'];
    const detach = () => {
      try { evs.forEach(e => target.removeEventListener(e, onGesture, true)); } catch { /* ignore */ }
    };
    // iOS ignores pointerdown for unlocking: keep listening until the context runs or a
    // touchend / keydown (which iOS accepts) has tried.
    function onGesture(e) {
      unlock();
      const type = e && e.type;
      if (!ctx || ctx.state === 'running' || type === 'touchend' || type === 'keydown') detach();
    }
    try { evs.forEach(e => target.addEventListener(e, onGesture, true)); } catch { /* ignore */ }
    return detach;
  }

  function play(what, o = {}) {
    if (!ctx || !sfxOn || mutes.size) return false;
    try {
      const params = typeof what === 'string' ? presets[what] : what;
      const sample = typeof what === 'string' ? samples.get(what) : null;
      if (!params && !sample) return false;
      const now = ctx.currentTime;
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') resume();
      voices = voices.filter(e => e > now);
      if (voices.length >= MAX_VOICES) return false;
      const key = typeof what === 'string' ? what : params;
      const prev = lastPlay.get(key);
      if (prev !== undefined && now - prev < MIN_GAP - 1e-9) return false;
      lastPlay.set(key, now);
      const vol = Number.isFinite(o.vol) ? o.vol : 1;
      const rate = Number.isFinite(o.pitch) && o.pitch > 0 ? o.pitch : 1; // 0 / NaN would pin a voice slot forever
      const pan = o.pan || 0;
      if (sample) {
        const src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = sample;
        src.playbackRate.value = rate;
        g.gain.value = vol;
        let out = g;
        if (pan && ctx.createStereoPanner) {
          const pn = ctx.createStereoPanner();
          pn.pan.value = pan;
          g.connect(pn);
          out = pn;
        }
        src.connect(g);
        out.connect(sfxBus);
        src.start(now);
        voices.push(now + (sample.duration || 0.5) / rate);
      } else {
        playSfx(ctx, sfxBus, params, { when: now, vol, rate, pan });
        voices.push(now + duration(params));
      }
      return true;
    } catch { return false; }
  }

  const api = {
    unlock, attachUnlock, play,
    register(name, params) { presets[name] = params; },
    // Fetch + decode a sample; play(name) then prefers it over the synth preset.
    // Before unlock() the load waits for the context. Resolves true/false, never rejects.
    loadSample(name, url) {
      if (ctx) return loadNow(name, url);
      return new Promise(done => pendingSamples.push({ name, url, done }));
    },
    setMuted(reason, on) {
      if (on) mutes.add(reason); else mutes.delete(reason);
      refresh();
    },
    isMuted: () => mutes.size > 0,
    setSfxOn(b) { sfxOn = !!b; refresh(); },
    setMusicOn(b) { musicOn = !!b; refresh(); syncMusic(); },
    toggleSfx() { api.setSfxOn(!sfxOn); return sfxOn; },
    toggleMusic() { api.setMusicOn(!musicOn); return musicOn; },
    setSfxVolume(v) { sfxVolume = clamp01(v); refresh(); },
    setMusicVolume(v) { musicVolume = clamp01(v); refresh(); },
    settings: () => ({ sfxOn, musicOn, sfxVolume, musicVolume }),
    applySettings(s) {
      if (!s || typeof s !== 'object') return;
      if (typeof s.sfxOn === 'boolean') sfxOn = s.sfxOn;
      if (typeof s.musicOn === 'boolean') musicOn = s.musicOn;
      if (typeof s.sfxVolume === 'number') sfxVolume = clamp01(s.sfxVolume);
      if (typeof s.musicVolume === 'number') musicVolume = clamp01(s.musicVolume);
      refresh();
      syncMusic();
    },
    music: {
      // Remembers the request; sounds as soon as the context exists and music is on.
      start(track = 'calm') { wantedTrack = TRACKS[track] ? track : 'calm'; syncMusic(); },
      stop() { wantedTrack = null; syncMusic(); },
      get playing() { return !!(music && music.playing); },
    },
    get ctx() { return ctx; },
    watchVisibility(doc) {
      const on = () => api.setMuted('hidden', !!doc.hidden);
      try { doc.addEventListener('visibilitychange', on); } catch { /* ignore */ }
      on();
      return () => { try { doc.removeEventListener('visibilitychange', on); } catch { /* ignore */ } };
    },
  };
  return api;
}
