// crazygames.js - adapter for the CrazyGames SDK v3 (window.CrazyGames.SDK).
// Every SDK call is wrapped: a failing SDK must never break the game.
import { safe, timersOf, withTimeout, searchParam, browserMobile, browserLocale } from './dev.js';

export function create(win, opts = {}) {
  const sdk = () => (win && win.CrazyGames && win.CrazyGames.SDK) || null;
  let usable = false;   // SDK initialised in environment 'local' or 'crazygames'

  const game = (m, ...a) => { if (usable) safe(() => sdk().game[m](...a)); };
  const sysInfo = () => (usable ? safe(() => sdk().user.systemInfo, null) : null);

  return {
    name: 'crazygames',

    async init() {
      const s = sdk();
      if (!s) return { ok: false, adblock: false };
      try { await s.init(); } catch (e) { return { ok: false, adblock: false }; }
      usable = s.environment === 'local' || s.environment === 'crazygames';
      if (!usable) return { ok: false, adblock: false };
      let adblock = false;
      try { adblock = !!(await withTimeout(s.ad.hasAdblock(), 3000, timersOf(win, opts))); } catch (e) { adblock = false; }
      return { ok: true, adblock };
    },

    loadingStart() { game('loadingStart'); },
    loadingFinished() { game('loadingStop'); },
    gameplayStart() { game('gameplayStart'); },
    gameplayStop() { game('gameplayStop'); },
    happytime() { game('happytime'); },

    requestAd(type, h) {
      try {
        sdk().ad.requestAd(type, {
          adStarted: () => h.onStart(),
          adFinished: () => h.onFinish(),
          adError: (err) => h.onError(err && err.code === 'unfilled' ? 'unfilled' : 'error'),
        });
      } catch (e) { h.onError('exception'); }
    },

    muted() { return usable ? !!safe(() => sdk().game.settings.muteAudio, false) : false; },
    onSettings(cb) {
      if (!usable) return;
      safe(() => sdk().game.addSettingsChangeListener((st) => {
        const m = st && typeof st.muteAudio === 'boolean' ? st.muteAudio : this.muted();
        safe(() => cb({ muteAudio: m }));
      }));
    },

    data() {
      const s = sdk();
      if (!usable || !s || !s.data || typeof s.data.getItem !== 'function') return null;
      return {
        getItem: (k) => s.data.getItem(k),
        setItem: (k, v) => s.data.setItem(k, v),
        removeItem: (k) => s.data.removeItem(k),
      };
    },

    async shareLink(params) {
      if (!usable) return null;
      const v = await sdk().game.inviteLink(params || {});
      return typeof v === 'string' && v ? v : null;
    },
    urlParam(name) {
      const v = usable ? safe(() => sdk().game.getInviteParam(name), null) : null;
      return v != null ? v : searchParam(win, name);
    },

    mobile() {
      const i = sysInfo();
      return i && i.device && i.device.type ? i.device.type !== 'desktop' : browserMobile(win);
    },
    locale() {
      const i = sysInfo();
      return (i && i.locale) || browserLocale(win);
    },
  };
}
