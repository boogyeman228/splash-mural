// dev.js - fake ads for localhost, plus small helpers shared by the portal modules.
// URL ?ads=ok|fail|adblock|slow picks the outcome (default ok; slow = the ad never starts).
// No top-level browser access: everything is resolved from the `win` passed to create().

/** Run fn, return its result (or `fallback` on throw / undefined). */
export function safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; }
}

/** setTimeout / clearTimeout: opts first (tests), then win, then globalThis. Resolved lazily. */
export function timersOf(win, opts = {}) {
  const g = globalThis;
  const pick = (name) => opts[name] ||
    (win && typeof win[name] === 'function' ? win[name].bind(win) : g[name].bind(g));
  return { setT: pick('setTimeout'), clearT: pick('clearTimeout') };
}

/** Reject with Error('timeout') if `p` does not settle within `ms`. */
export function withTimeout(p, ms, t) {
  return new Promise((resolve, reject) => {
    const id = t.setT(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(
      (v) => { t.clearT(id); resolve(v); },
      (e) => { t.clearT(id); reject(e); });
  });
}

/** Query-string parameter of win.location, or null. */
export function searchParam(win, name) {
  try {
    const s = win && win.location && win.location.search;
    return s ? new globalThis.URLSearchParams(s).get(name) : null;
  } catch (e) { return null; }
}

export function browserMobile(win) {
  try {
    if (win && typeof win.matchMedia === 'function') return !!win.matchMedia('(pointer: coarse)').matches;
    const ua = (win && win.navigator && win.navigator.userAgent) || '';
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  } catch (e) { return false; }
}

export function browserLocale(win) {
  return safe(() => win.navigator.language, '') || 'en';
}

const MODES = ['ok', 'fail', 'adblock', 'slow'];

export function create(win, opts = {}) {
  const mode = () => { const m = searchParam(win, 'ads'); return MODES.includes(m) ? m : 'ok'; };
  const docOf = () => (win && win.document && win.document.body ? win.document : null);

  // Full-screen "AD (dev)" overlay; returns { set(msLeft), remove() } or null without a DOM.
  function showOverlay(doc, type) {
    try {
      const el = doc.createElement('div');
      el.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;' +
        'background:rgba(0,0,0,.88);color:#fff;font:700 26px sans-serif;display:flex;' +
        'align-items:center;justify-content:center;text-align:center;white-space:pre;';
      const set = (left) => { el.textContent = `AD (dev) - ${type}\n${(left / 1000).toFixed(1)} s`; };
      doc.body.appendChild(el);
      return {
        set,
        remove() {
          try { if (el.remove) el.remove(); else if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* ignore */ }
        },
      };
    } catch (e) { return null; }
  }

  return {
    name: 'dev',
    async init() { return { ok: true, adblock: mode() === 'adblock' }; },
    loadingStart() {}, loadingFinished() {}, gameplayStart() {}, gameplayStop() {}, happytime() {},

    requestAd(type, h) {
      const { setT } = timersOf(win, opts);
      const m = mode();
      if (m === 'slow') return;                                        // never starts -> facade timeout
      if (m === 'adblock') { setT(() => h.onError('adblock'), 0); return; }
      if (m === 'fail') { setT(() => h.onError('error'), 0); return; }
      const doc = docOf();
      const total = opts.devAdMs != null ? opts.devAdMs : (doc ? 1200 : 5);
      setT(() => {
        const ov = doc ? showOverlay(doc, type) : null;
        h.onStart();
        const end = () => { if (ov) ov.remove(); h.onFinish(); };
        if (!ov) { setT(end, total); return; }
        let left = total;
        ov.set(left);
        const tick = () => {
          const dt = Math.min(100, left);
          setT(() => { left -= dt; if (left <= 0) end(); else { ov.set(left); tick(); } }, dt);
        };
        tick();
      }, doc ? 120 : 0);
    },

    muted() { return false; },
    onSettings() {},
    data() { return null; },
    async shareLink(params) {
      const loc = win && win.location;
      if (!loc) return null;
      const q = new globalThis.URLSearchParams(params || {}).toString();
      return `${loc.origin || ''}${loc.pathname || '/'}${q ? '?' + q : ''}`;
    },
    urlParam(name) { return searchParam(win, name); },
    mobile() { return browserMobile(win); },
    locale() { return browserLocale(win); },
  };
}
