// poki.js - adapter for the Poki SDK v2 (window.PokiSDK).
// An init() rejection means an adblocker: the game keeps running, ads are reported as blocked.
import { safe, searchParam, browserMobile, browserLocale } from './dev.js';

export function create(win, opts = {}) {
  const sdk = () => (win && win.PokiSDK) || null;
  const call = (m, ...a) => safe(() => sdk()[m](...a));

  return {
    name: 'poki',

    async init() {
      const p = sdk();
      if (!p) return { ok: false, adblock: false };
      if (opts.debug) safe(() => p.setDebug(true));
      try { await p.init(); return { ok: true, adblock: false }; } catch (e) { return { ok: true, adblock: true }; }
    },

    loadingStart() { const p = sdk(); if (p && typeof p.gameLoadingStart === 'function') call('gameLoadingStart'); },
    loadingFinished() { call('gameLoadingFinished'); },
    gameplayStart() { call('gameplayStart'); },
    gameplayStop() { call('gameplayStop'); },
    happytime() {},

    requestAd(type, h) {
      let started = false;
      const onStart = () => { if (started) return; started = true; h.onStart(); };
      let pr;
      try {
        const p = sdk();
        pr = type === 'rewarded' ? p.rewardedBreak(onStart) : p.commercialBreak(onStart);
      } catch (e) { h.onError('exception'); return; }
      Promise.resolve(pr).then((res) => {
        if (type === 'rewarded') {
          if (res === true) { onStart(); h.onFinish(); }               // reward only on a real `true`
          else h.onError(started ? 'error' : 'unfilled');
        } else {
          h.onFinish();                                                // started stays false if no ad showed
        }
      }, () => h.onError('error'));
    },

    muted() { return false; },
    onSettings() {},
    data() { return null; },

    async shareLink(params) {
      const v = await sdk().shareableURL(params || {});
      return typeof v === 'string' && v ? v : null;
    },
    urlParam(name) {
      const v = safe(() => sdk().getURLParam(name), null);
      return v ? v : searchParam(win, name);
    },

    mobile() { return browserMobile(win); },
    locale() { return safe(() => sdk().getLanguage(), '') || browserLocale(win); },
  };
}
