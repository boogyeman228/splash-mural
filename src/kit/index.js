// game-kit entry point: re-exports every module and bootKit(), which wires them together
// the same way in every game (ads mute audio, block input and pause the loop; portal mute
// setting; cloud save; gameplayStart on the first input). See ../API.md.
import * as portal from './portal/portal.js';
import { createAudio } from './audio.js';
import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { createView } from './view.js';
import { createSave, portalBackend, localBackend, memoryBackend } from './save.js';

export { portal };
export { createAudio } from './audio.js';
export { PRESETS } from './sfx.js';
export { createLoop } from './loop.js';
export * from './juice.js';
export { createInput } from './input.js';
export { createView } from './view.js';
export * from './rng.js';
export { createSave, portalBackend, localBackend, memoryBackend } from './save.js';
export * from './meta.js';

/**
 * Start a game. Returns { portal, view, audio, input, loop, save, setSound, rewardButton, breakTime }.
 * opts: {
 *   canvas, width = 720, height = 1280,          // design resolution (portrait by default)
 *   save: { key, version, defaults, migrations }, // see save.js; audio settings live in data.audio
 *   step = 1/60, update(dt), render(ctx, alpha, frameDt),
 *   input: { onDown, onMove, onUp, onTap, onKey }, // world coordinates
 *   music: 'calm' | 'bright' | null,               // starts after the first gesture
 *   portal: { portal?, debug? },                   // forwarded to portal.init
 *   win = window,
 * }
 */
export async function bootKit(opts) {
  const win = opts.win || globalThis;
  const doc = win.document;

  await portal.init({ win, ...(opts.portal || {}) });
  portal.loadingStart();

  // Save: cloud (CrazyGames data module) -> localStorage -> memory.
  const backends = [];
  const pdata = portal.data();
  const cloud = pdata ? portalBackend(pdata) : null;
  if (cloud) backends.push(cloud);
  const local = localBackend(safeLocal(win)); // null when blocked (incognito, quota)
  if (local) backends.push(local);
  backends.push(memoryBackend());
  const save = createSave({ ...(opts.save || {}), backends, win });
  save.load();
  save.attachAutoFlush(doc, win);

  // Audio: settings from the save, silent during ads, when hidden and when the portal asks.
  const audio = createAudio({ win });
  if (save.data.audio) audio.applySettings(save.data.audio);
  audio.attachUnlock(win);
  if (doc) audio.watchVisibility(doc);
  audio.setMuted('portal', portal.portalMuted());
  portal.onSettings((s) => audio.setMuted('portal', !!(s && s.muteAudio)));
  if (opts.music) {
    // Music needs an unlocked context, so it starts on the first gesture.
    const startMusic = () => {
      win.removeEventListener('pointerdown', startMusic);
      win.removeEventListener('keydown', startMusic);
      audio.unlock();
      if (audio.settings().musicOn) audio.music.start(opts.music);
    };
    win.addEventListener('pointerdown', startMusic);
    win.addEventListener('keydown', startMusic);
  }

  const view = createView(opts.canvas, { width: opts.width || 720, height: opts.height || 1280, win });

  const handlers = opts.input || {};
  const input = createInput(opts.canvas, {
    ...handlers,
    toWorld: (x, y) => view.toWorld(x, y),
    onFirstInput: () => portal.gameplayStart(),
  }, win);

  const loop = createLoop({
    step: opts.step || 1 / 60,
    update: (dt) => opts.update && opts.update(dt),
    render: (alpha, frameDt) => {
      view.begin();
      if (opts.render) opts.render(view.ctx, alpha, frameDt);
    },
  });

  portal.onAdState((playing) => {
    audio.setMuted('ad', playing);
    if (playing) { input.block('ad'); loop.pause('ad'); } else { input.unblock('ad'); loop.resume('ad'); }
  });

  /** Change sound settings and remember them in the save. */
  function setSound({ sfxOn, musicOn } = {}) {
    if (sfxOn !== undefined) audio.setSfxOn(sfxOn);
    if (musicOn !== undefined) {
      audio.setMusicOn(musicOn);
      if (musicOn && opts.music && audio.ctx && !audio.music.playing) audio.music.start(opts.music);
    }
    save.data.audio = audio.settings();
    save.save();
  }

  /**
   * Bind a DOM button to a rewarded ad. The button hides itself when no reward can be shown
   * (adblock, no SDK) - portals forbid "ad blocked" messages. Returns { refresh() }.
   * Portal rules: label with 🎬, the button must not be green, and a free option of equal or
   * larger size must sit next to or above it.
   */
  function rewardButton(el, onGrant, onFail) {
    const refresh = () => { el.hidden = !portal.rewardAvailable(); };
    el.addEventListener('click', async () => {
      if (el.disabled) return;
      el.disabled = true;
      const r = await portal.rewarded();
      el.disabled = false;
      refresh();
      if (r.ok) onGrant(); else if (onFail) onFail(r.reason);
    });
    portal.onAdState(refresh);
    refresh();
    if (portal.info().portal === 'dev') checkRewardButton(el, win);
    return { refresh };
  }

  /** Call at natural breaks only (level end, game over, back to menu). The portal decides. */
  const breakTime = () => portal.midgame();

  portal.loadingFinished();
  loop.start();
  return { portal, view, audio, input, loop, save, setSound, rewardButton, breakTime };
}

// Reading window.localStorage itself throws in some browsers when storage is blocked.
function safeLocal(win) {
  try { return win.localStorage || null; } catch (e) { return null; }
}

/** Dev-only check of the portal rules for reward buttons (logs a warning, never throws). */
function checkRewardButton(el, win) {
  try {
    if (!/🎬/.test(el.textContent || '')) console.warn('[kit] reward button needs the 🎬 icon:', el);
    const bg = win.getComputedStyle ? win.getComputedStyle(el).backgroundColor : '';
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || '');
    if (m) {
      const [r, g, b] = [+m[1], +m[2], +m[3]];
      if (g > 120 && g > r * 1.3 && g > b * 1.3) console.warn('[kit] reward buttons must not be green:', el, bg);
    }
  } catch (e) { /* QA helper only */ }
}
