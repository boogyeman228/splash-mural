// portal.js - unified portal facade (CrazyGames / Poki / dev / none).
// The only module the game talks to. One portal per page (module singleton).
// Every SDK call is wrapped, init() never rejects, the game runs with no SDK or all ads failing.
import * as crazygames from './crazygames.js';
import * as poki from './poki.js';
import * as dev from './dev.js';
import { safe, timersOf, withTimeout, searchParam, browserMobile, browserLocale } from './dev.js';

const REASONS = ['unavailable', 'adblock', 'busy', 'timeout', 'error', 'unfilled', 'exception'];
const ADAPTERS = { crazygames, poki, dev };

const fresh = () => ({
  opts: {}, win: null, adapter: null, portal: 'none', ready: false, adblock: false, initP: null, dead: false,
  playing: false, sent: false,                       // wanted gameplay state / state last sent to the SDK
  busy: false, adPlaying: false, wasPlaying: false, pendingStart: false, cur: null,
  loadStart: false, loadStartSent: false, loadFin: false, loadFinSent: false,
  adCbs: [], setCbs: [],
});
let S = fresh();

// Built-in 'none' adapter: nothing to talk to, ads unavailable.
function noneAdapter(win) {
  return {
    name: 'none',
    async init() { return { ok: false, adblock: false }; },
    loadingStart() {}, loadingFinished() {}, gameplayStart() {}, gameplayStop() {}, happytime() {},
    requestAd(type, h) { h.onError('unavailable'); },
    muted() { return false; }, onSettings() {}, data() { return null; },
    async shareLink() { return null; }, urlParam(n) { return searchParam(win, n); },
    mobile() { return browserMobile(win); }, locale() { return browserLocale(win); },
  };
}

function detect(win) {
  if (win.CrazyGames && win.CrazyGames.SDK) return 'crazygames';
  if (win.PokiSDK) return 'poki';
  const h = (win.location && win.location.hostname) || '';
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '' ||
      h.endsWith('.local') || h.endsWith('.localhost')) return 'dev';
  return 'none';
}

const log = (...a) => { if (S.opts.debug) safe(() => console.log('[portal]', ...a)); };
const A = (m, ...a) => (S.adapter ? safe(() => S.adapter[m](...a)) : undefined);
function emit(list, v) {
  for (const cb of list.slice()) { try { cb(v); } catch (e) { /* listener errors never break the game */ } }
}
function subscribe(list, cb) {
  list.push(cb);
  return () => { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); };
}

// ---------- init ----------

async function doInit(st, opts) {
  const win = opts.win || globalThis;
  st.opts = opts; st.win = win;
  const name = opts.portal || detect(win);
  let adapter = null, res = null;
  if (name !== 'none') {
    try {
      adapter = ADAPTERS[name].create(win, opts);
      res = await withTimeout(adapter.init(), opts.initTimeoutMs != null ? opts.initTimeoutMs : 10000, timersOf(win, opts));
    } catch (e) { res = null; log('init failed', name, e && e.message); }
  }
  if (st.dead) return;
  if (res && res.ok) {
    st.adapter = adapter; st.portal = name; st.ready = true; st.adblock = !!res.adblock;
    A('onSettings', (s) => emit(st.setCbs, { muteAudio: !!(s && s.muteAudio) }));
  } else {
    st.adapter = noneAdapter(win); st.portal = 'none'; st.ready = false; st.adblock = !!(res && res.adblock);
  }
  log('portal', st.portal, 'ready', st.ready, 'adblock', st.adblock);
  applyLoading();
  applyGameplay();
}

export async function init(opts = {}) {
  if (!S.initP) {
    const st = S;
    st.initP = doInit(st, opts || {}).catch((e) => { log('init error', e); });
  }
  try { await S.initP; } catch (e) { /* never rejects */ }
  return info();
}

export function info() {
  const w = S.win || globalThis;
  return {
    portal: S.portal, ready: S.ready, adblock: S.adblock,
    mobile: !!(S.adapter ? safe(() => S.adapter.mobile(), false) : browserMobile(w)),
    locale: (S.adapter ? safe(() => S.adapter.locale(), '') : '') || browserLocale(w),
  };
}

// ---------- loading / gameplay ----------

function applyLoading() {
  if (!S.ready) return;
  if (S.loadStart && !S.loadStartSent && !S.loadFinSent) { S.loadStartSent = true; A('loadingStart'); }
  if (S.loadFin && !S.loadFinSent) { S.loadFinSent = true; A('loadingFinished'); }
}
export function loadingStart() { S.loadStart = true; applyLoading(); }
export function loadingFinished() { S.loadFin = true; applyLoading(); }

// Send only real transitions to the SDK (S.sent tracks what it last heard).
function applyGameplay() {
  if (!S.ready || S.sent === S.playing) return;
  S.sent = S.playing;
  A(S.playing ? 'gameplayStart' : 'gameplayStop');
}
export function gameplayStart() {
  if (S.busy) { S.pendingStart = true; return; }      // deferred until the ad is over
  S.playing = true; applyGameplay();
}
export function gameplayStop() {
  if (S.busy) { S.pendingStart = false; S.wasPlaying = false; return; }
  S.playing = false; applyGameplay();
}
export function isGameplay() { return S.playing; }
export function happytime() { if (S.ready) A('happytime'); }

// ---------- ads ----------

export function isAdPlaying() { return S.adPlaying; }
export function onAdState(cb) { return subscribe(S.adCbs, cb); }
export function rewardAvailable() { return S.ready && !S.adblock && !S.busy; }

// Runs one ad request. Resolves { started, finished, reason }.
function runAd(type) {
  const st = S;
  return new Promise((resolve) => {
    const { setT, clearT } = timersOf(st.win, st.opts);
    const adTimeoutMs = st.opts.adTimeoutMs != null ? st.opts.adTimeoutMs : 15000;
    const adMaxMs = st.opts.adMaxMs != null ? st.opts.adMaxMs : 120000;
    let started = false, done = false, t1 = 0, t2 = 0;

    st.busy = true; st.wasPlaying = st.playing; st.pendingStart = false;
    st.playing = false; applyGameplay();                // gameplayStop -> ad

    const finish = (finished, reason) => {
      if (done) return;                                 // late callbacks land here
      done = true; clearT(t1); clearT(t2);
      if (st.dead) { resolve({ started, finished: false, reason: 'error' }); return; }
      if (started) { st.adPlaying = false; emit(st.adCbs, false); }
      st.busy = false; st.cur = null;
      const resume = st.wasPlaying || st.pendingStart;  // -> gameplayStart only if it was running
      st.wasPlaying = false; st.pendingStart = false;
      if (resume) gameplayStart();
      resolve({ started, finished, reason });
    };
    st.cur = { abort: () => finish(false, 'error') };

    t1 = setT(() => { if (!started) finish(false, 'timeout'); }, adTimeoutMs);
    try {
      st.adapter.requestAd(type, {
        onStart: () => {
          if (done || started) return;
          started = true; clearT(t1);
          st.adPlaying = true; emit(st.adCbs, true);
          t2 = setT(() => finish(type === 'midgame', 'timeout'), adMaxMs);
        },
        onFinish: () => { if (type === 'rewarded' && !started) finish(false, 'unfilled'); else finish(true); },
        onError: (reason) => finish(false, REASONS.includes(reason) ? reason : 'error'),
      });
    } catch (e) { finish(false, 'exception'); }
  });
}

// Reason why no ad can be requested right now, or null.
function adBlocker() {
  if (S.busy) return 'busy';
  if (!S.ready) return 'unavailable';
  if (S.adblock) return 'adblock';
  return null;
}

export async function rewarded() {
  const why = adBlocker();
  if (why) return { ok: false, reason: why };
  const r = await runAd('rewarded');
  return r.started && r.finished ? { ok: true } : { ok: false, reason: r.reason || 'error' };
}

// shown:true when the ad ran to its end (or hit adMaxMs); error after the start counts as not shown.
export async function midgame() {
  const why = adBlocker();
  if (why) return { shown: false, reason: why };
  const r = await runAd('midgame');
  return r.started && r.finished ? { shown: true } : { shown: false, reason: r.reason || 'unfilled' };
}

// ---------- portal services ----------

export function portalMuted() { return S.ready ? !!A('muted') : false; }
export function onSettings(cb) { return subscribe(S.setCbs, cb); }
export function data() { return S.ready ? A('data') || null : null; }

export async function shareLink(params) {
  if (!S.ready) return null;
  try {
    const v = await S.adapter.shareLink(params || {});
    return typeof v === 'string' && v ? v : null;
  } catch (e) { return null; }
}

export function urlParam(name) {
  let v = S.ready ? A('urlParam', name) : null;
  if (v == null || v === '') v = searchParam(S.win || globalThis, name);
  return v == null ? null : String(v);
}

export function _reset() {
  S.dead = true;
  if (S.cur) S.cur.abort();
  S = fresh();
}
