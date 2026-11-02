// Splash Mural - sort the paint balls; every finished tube pours its colour into a pixel mural.
// Rendering is canvas (board + mural), HUD and panels are DOM. Ads go through the kit only.
import {
  bootKit, portal, createParticles, createFloaters, createShake, createFlash, ease, clamp,
  streak, dayKey,
} from './kit/index.js';
import * as Logic from './logic.js';
import { MURALS, PALETTE, SIZE } from './murals.js';
import { TOTAL_LEVELS, levelInfo, muralPlan, paintedBefore, paintedIn, locate, dailyInfo, dailyPlan, dailyShareText, DAILY_STAGES } from './plan.js';
import * as E from './economy.js';

const W = 720, H = 1280;
const FONT = "Fredoka, system-ui, sans-serif";
const PAPER = '#fbf3e4', INK = '#3b2f4a';
const $ = (id) => document.getElementById(id);
const DEV = ['localhost', '127.0.0.1', ''].includes(location.hostname);

// ---------------------------------------------------------------- state
let kit = null;
let T = 0;                       // game time in seconds (pauses with the loop)
let lv = null;                   // current level (see startLevel)
let phase = 'boot';              // 'play' | 'won' | 'panel'
let hadInput = false;
let layoutCache = null;

// Rules bound to the current level's tube height (4, or 5 for tall tubes).
const capNow = () => (lv ? lv.cap : Logic.CAP);
const { generate, applyMove } = Logic;
const isFullTube = (t) => Logic.isFullTube(t, capNow());
const isSolved = (t) => Logic.isSolved(t, capNow());
const canMove = (t, a, b) => Logic.canMove(t, a, b, capNow());
const hasUsefulMove = (t) => Logic.hasUsefulMove(t, capNow());
const solve = (t, budget) => Logic.solve(t, budget, capNow());

const parts = createParticles({ max: 900 });
const floaters = createFloaters({ font: FONT });
const shake = createShake({ maxOffset: 10, maxAngle: 0.012 });
const flash = createFlash();

// ---------------------------------------------------------------- boot
try { await Promise.race([document.fonts.load(`600 24px ${FONT}`), new Promise((r) => setTimeout(r, 1200))]); } catch (e) { /* system font */ }

kit = await bootKit({
  canvas: $('game'),
  width: W,
  height: H,
  // ?portal=none lets local tests play as if no SDK were present (dev only).
  portal: { debug: DEV, initTimeoutMs: 4000, portal: (DEV && new URLSearchParams(location.search).get('portal')) || undefined },
  save: {
    key: 'splashmural',
    version: 1,
    defaults: () => ({
      level: 1, drops: 30, stars: {}, hintAdAt: 0, streak: streak.create(), audio: null,
      daily: { day: null, stage: 0, moves: 0, done: false }, dailyStreak: streak.create(),
      seen: {},                                   // twists already explained (tall, mystery)
    }),
  },
  music: 'calm',
  update,
  render,
  input: { onDown },
});
const save = kit.save.data;
kit.view.onResize(() => { layoutCache = null; spriteCache.clear(); });

const st = streak.check(save.streak, dayKey());
if (st === 'continued') {
  save.drops += 10;
  later(() => toast(`Day ${save.streak.count} streak! +10 drops`), 600);
}
kit.save.save();
startLevel(save.level);
bindHud();
refreshDailyDot();

// ---------------------------------------------------------------- level
function startLevel(n, keepRestarts = 0) {
  startWith(levelInfo(n), keepRestarts);
}

function startWith(info, keepRestarts = 0) {
  const n = info.n;
  const cap = info.cap || Logic.CAP;
  const tubes = generate(info);
  const sol = Logic.solve(tubes, 30000, cap);
  lv = {
    n, info, tubes, cap,
    // Mystery balls: true = colour hidden. Only the top ball of each tube starts visible.
    mask: info.mystery ? tubes.map((t) => t.map((_, i) => i < t.length - 1)) : null,
    history: [],
    sel: -1,
    par: sol.status === 'solved' ? sol.path.length : null,
    eco: { ...E.newLevelState(), restarts: keepRestarts },
    poured: new Set(),                       // colour ids already poured this level
    base: info.m === null ? new Set() : info.daily ? paintedIn(info.plan, info.l) : paintedBefore(info.m, info.l),
    pending: new Map(),                      // pixel index -> paint time (T)
    splashed: new Set(),                     // pixels that already burst
    flights: [],                             // flying balls (visual only)
    shakeTube: -1, shakeAt: -9,
    hint: null,                              // { a, b, until }
    pourEnd: 0,
    tutorial: !info.daily && n === 1 && keepRestarts === 0,
    stuckShown: false,
  };
  phase = 'play';
  layoutCache = null;
  updateHud();
  if (hadInput) portal.gameplayStart();
  introduceTwist(info);
}

// First time a twist shows up, explain it in one line.
const TWISTS = {
  tall: { title: 'Tall tubes!', text: 'From now on some tubes hold 5 balls.' },
  mystery: { title: 'Mystery balls!', text: 'Hidden balls show their colour when they reach the top of a tube.' },
};
function introduceTwist(info) {
  save.seen = save.seen || {};
  const twist = info.cap === 5 && !save.seen.tall ? 'tall' : info.mystery && !save.seen.mystery ? 'mystery' : null;
  if (!twist) return;
  save.seen[twist] = true;
  kit.save.save();
  const cur = lv;
  later(() => { if (lv === cur && phase === 'play') { kit.audio.play('unlock'); panel({ ...TWISTS[twist], free: { label: 'Got it', fn: () => {} } }); } }, 450);
}

/** Mystery balls: reveal the top ball of every tube. */
function revealTops() {
  if (!lv.mask) return;
  lv.tubes.forEach((t, i) => { if (t.length) lv.mask[i][t.length - 1] = false; });
}

/** Keep the mystery mask in step with a ball moving from tube a to tube b. */
function maskMove(a, b) {
  if (!lv.mask) return;
  lv.mask[b].push(lv.mask[a].pop());
  revealTops();
}

function restartLevel() {
  startWith(lv.info, lv.eco.restarts + 1);
}

// ---------------------------------------------------------------- daily mural
function dailyState() {
  const d = save.daily;
  const today = dayKey();
  if (d.day !== today) Object.assign(d, { day: today, stage: 0, moves: 0, done: false });
  return d;
}

function startDaily() {
  const d = dailyState();
  if (d.done) { dailyDonePanel(false); return; }
  startWith(dailyInfo(d.day, d.stage));
}

function refreshDailyDot() {
  $('b-daily').classList.toggle('dot', !dailyState().done);
}

const DAILY_BONUS = 40;
const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

function dailyDonePanel(fresh) {
  const d = dailyState();
  const m = dailyPlan(d.day).m;
  const more = [{ label: 'Copy result', cls: 'alt', keep: true, fn: () => copyText(dailyShareText(d.day, d.moves)) }];
  if (!fresh) {
    panel({
      title: 'Daily mural done', media: muralImage(m, 12),
      text: `Come back tomorrow for a new one.\nDaily streak: ${days(save.dailyStreak.count)}`,
      free: { label: 'Back to album', fn: () => startLevel(save.level) }, more, escClose: true,
    });
    return;
  }
  panel({
    title: 'Daily mural painted!',
    media: muralImage(m, 12),
    text: `${MURALS[m].name} in ${d.moves} moves. Daily streak: ${days(save.dailyStreak.count)}.`,
    free: { label: `Collect +${DAILY_BONUS}`, fn: () => { addDrops(DAILY_BONUS); startLevel(save.level); } },
    reward: { label: `Collect x2 (+${DAILY_BONUS * 2})`, fn: () => { addDrops(DAILY_BONUS * 2); kit.audio.play('reward'); startLevel(save.level); } },
    more,
  });
}

async function copyText(text) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    // The clipboard API can be blocked inside portal iframes: fall back to a hidden textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
    } catch (e2) { ok = false; }
  }
  toast(ok ? 'Copied! Paste it to your friends' : 'Could not copy here');
}

/** Share the finished picture as an image where the browser supports it, else copy a line of text. */
async function shareMural(m) {
  const text = `I painted "${MURALS[m].name}" in Splash Mural 🎨`;
  try {
    const c = shareCard(m);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], `splash-mural-${MURALS[m].id}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  copyText(text);
}

/** Square 1080 card: the mural big, its name and the game name. */
function shareCard(m) {
  const c = document.createElement('canvas');
  c.width = c.height = 1080;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 1080);
  grad.addColorStop(0, '#2d2860'); grad.addColorStop(1, '#1b1840');
  g.fillStyle = grad; g.fillRect(0, 0, 1080, 1080);
  g.fillStyle = '#f7e2c0'; g.fillRect(150, 110, 780, 780);
  g.imageSmoothingEnabled = false;
  g.drawImage(muralImage(m, 45), 180, 140, 720, 720);
  g.textAlign = 'center';
  g.fillStyle = '#fff8ee'; g.font = `600 64px ${FONT}`; g.fillText(MURALS[m].name, 540, 975);
  g.fillStyle = '#c9c3e8'; g.font = `500 38px ${FONT}`; g.fillText('Splash Mural', 540, 1035);
  return c;
}

// ---------------------------------------------------------------- input
function onDown(p) {
  hadInput = true;
  if (phase !== 'play' || !lv) return;
  kit.audio.unlock();
  const L = layout();
  const i = L.tubes.findIndex((r) => p.x >= r.x - r.w * 0.15 && p.x <= r.x + r.w * 1.15 && p.y >= r.y - L.d * 1.2 && p.y <= r.y + r.h + L.d * 0.2);
  if (i < 0) { if (lv.sel >= 0) { lv.sel = -1; kit.audio.play('click', { vol: 0.5 }); } return; }
  const t = lv.tubes;
  if (lv.sel < 0) {
    if (!t[i].length || isFullTube(t[i])) { nudge(i); return; }
    lv.sel = i;
    kit.audio.play('select');
    return;
  }
  if (lv.sel === i) { lv.sel = -1; kit.audio.play('click', { vol: 0.5 }); return; }
  if (canMove(t, lv.sel, i)) { move(lv.sel, i); return; }
  // Not a legal target: if the tapped tube can be picked up, switch selection.
  if (t[i].length && !isFullTube(t[i])) { lv.sel = i; kit.audio.play('select'); return; }
  nudge(i);
}

function nudge(i) {
  lv.shakeTube = i; lv.shakeAt = T;
  kit.audio.play('error', { vol: 0.6 });
}

function move(a, b, { record = true } = {}) {
  const L = layout();
  const t = lv.tubes;
  const c = t[a][t[a].length - 1];
  const from = ballPos(L, a, t[a].length - 1, lv.sel === a);
  applyMove(t, a, b);
  maskMove(a, b);
  const to = ballPos(L, b, t[b].length - 1, false);
  lv.flights.push({ c, tube: b, slot: t[b].length - 1, x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: T, dur: 0.22 });
  if (record) { lv.history.push([a, b]); lv.eco.moves++; }
  lv.sel = -1;
  lv.hint = null;
  lv.tutorial = false;
  // Delayed effects belong to this level only (a restart in between must not touch the new one).
  const cur = lv;
  const mine = (fn) => () => { if (lv === cur) fn(); };
  later(mine(() => kit.audio.play('drop', { pitch: 0.9 + t[b].length * 0.06 })), 200);
  if (isFullTube(t[b]) && !lv.poured.has(c)) later(mine(() => pour(b, c)), 260);
  if (isSolved(t)) {
    phase = 'won';
    later(mine(() => { lv.wonAt = Math.max(lv.pourEnd, T) + 0.45; }), 300);
  } else {
    later(mine(checkStuck), 320);
  }
}

// ---------------------------------------------------------------- pouring paint into the mural
function pour(tubeIndex, c) {
  if (!lv || lv.poured.has(c)) return;
  lv.poured.add(c);
  lv.history = [];                      // a poured tube cannot be undone
  if (lv.mask) lv.mask[tubeIndex].fill(false); // a finished tube shows all its balls
  const L = layout();
  const r = L.tubes[tubeIndex];
  const list = lv.info.paint[c] || [];
  const top = { x: r.x + r.w / 2, y: r.y };
  kit.audio.play('combo');
  parts.burst(top.x, top.y, { count: 22, colors: [PALETTE[c].hex, '#ffffff'], shape: 'star', speed: [120, 380], life: [0.4, 0.8] });
  if (!list.length) {
    // Colour not in this picture: it fills the paint jar instead.
    save.drops += E.JAR_DROPS;
    kit.save.save();
    floaters.add(top.x, top.y - 30, `+${E.JAR_DROPS}`, { color: '#7fd6ff', size: 40, life: 1.1, rise: 90 });
    bumpDrops();
    later(() => kit.audio.play('coin'), 150);
    return;
  }
  kit.audio.play('splash');
  const step = Math.min(0.045, 1.1 / list.length);
  const start = T + 0.28;
  list.forEach((pi, k) => lv.pending.set(pi, start + k * step));
  lv.pourEnd = Math.max(lv.pourEnd, start + list.length * step + 0.25);
  lv.stream = { x: top.x, y: top.y, c, from: T, until: start + list.length * step, target: list };
}

function cellRect(L, pi) {
  const p = muralPlan(lv.info.m).pixels[pi];
  const cs = L.mural.size / SIZE;
  return { x: L.mural.x + p.x * cs, y: L.mural.y + p.y * cs, s: cs, c: p.c };
}

// ---------------------------------------------------------------- stuck / win
function checkStuck() {
  if (!lv || phase !== 'play' || lv.stuckShown) return;
  const dead = !hasUsefulMove(lv.tubes) || solve(lv.tubes, 15000).status === 'dead';
  if (!dead) return;
  lv.stuckShown = true;
  kit.audio.play('lose', { vol: 0.7 });
  later(stuckPanel, 350);
}

function stuckPanel() {
  const more = [];
  if (!lv.eco.extraTube && save.drops >= E.PRICES.tube) more.push({ label: `Extra tube · ${E.PRICES.tube} drops`, cls: 'cost', fn: () => { E.payTool('tube', lv.eco, save); addTube(); } });
  if (lv.history.length) more.push({ label: 'Undo last move', cls: 'alt', fn: () => { lv.stuckShown = false; useTool('undo'); } });
  panel({
    title: 'No moves left',
    text: 'There is no way to finish from here.',
    free: { label: 'Restart', fn: restartLevel },
    reward: lv.eco.extraTube ? null : { label: 'Extra tube', fn: () => { lv.eco.extraTube = true; addTube(); } },
    more,
  });
}

function finishLevel() {
  if (lv.info.daily) { finishDaily(); return; }
  const n = lv.n;
  const s = E.stars(lv.eco.moves, lv.par);
  const gain = E.levelDrops(s);
  save.stars[n] = Math.max(save.stars[n] || 0, s);
  save.level = Math.max(save.level, n + 1);
  save.drops += gain;
  kit.save.flush();
  portal.gameplayStop();
  kit.audio.play('win');
  const L = layout();
  confetti(L);
  const muralDone = lv.info.m !== null && lv.info.l === MURALS[lv.info.m].levels - 1;
  const starsHtml = `<div class="stars">${[1, 2, 3].map((i) => `<span class="${i <= s ? '' : 'off'}">★</span>`).join('')}</div>`;
  if (muralDone) {
    const m = lv.info.m;
    later(() => {
      kit.audio.play('unlock');
      portal.happytime();
      panel({
        title: `${MURALS[m].name} finished!`,
        media: muralImage(m, 12),
        text: `Level drops +${gain}. Mural bonus +${E.MURAL_DROPS}.`,
        free: { label: `Collect +${E.MURAL_DROPS}`, fn: () => { addDrops(E.MURAL_DROPS); nextLevel(); } },
        reward: { label: `Collect x2 (+${E.MURAL_DROPS * 2})`, fn: () => { addDrops(E.MURAL_DROPS * 2); kit.audio.play('reward'); nextLevel(); } },
        more: [{ label: 'Share picture', cls: 'alt', keep: true, fn: () => shareMural(m) }],
      });
    }, 700);
  } else {
    later(() => panel({
      title: `Level ${n} complete`,
      html: starsHtml,
      text: `+${gain} drops`,
      free: { label: 'Next', fn: nextLevel },
      low: true,
    }), 650);
  }
  updateHud();
}

function finishDaily() {
  const d = dailyState();
  d.moves += lv.eco.moves;
  d.stage = lv.info.l + 1;
  const gain = 15;
  save.drops += gain;
  portal.gameplayStop();
  kit.audio.play('win');
  confetti(layout());
  if (d.stage >= DAILY_STAGES.length) {
    d.done = true;
    streak.check(save.dailyStreak, d.day);
    kit.save.flush();
    refreshDailyDot();
    later(() => { kit.audio.play('unlock'); portal.happytime(); dailyDonePanel(true); }, 700);
  } else {
    kit.save.flush();
    later(() => panel({
      title: `Stage ${d.stage} of ${DAILY_STAGES.length} done`,
      text: `+${gain} drops`,
      free: { label: 'Next stage', fn: async () => { await kit.breakTime(); startDaily(); } },
      low: true,
    }), 650);
  }
  updateHud();
}

async function nextLevel() {
  // Natural break between levels; the portal decides whether an ad really shows.
  if (lv.n >= E.MIDGAME_FROM_LEVEL) await kit.breakTime();
  startLevel(save.level);
}

function addDrops(n) { save.drops += n; kit.save.save(); bumpDrops(); updateHud(); }

function confetti(L) {
  const cols = lv.info.colours.map((c) => PALETTE[c].hex);
  for (let k = 0; k < 3; k++) {
    later(() => parts.burst(L.board.x + L.board.w * (0.2 + 0.3 * k), L.board.y + L.board.h * 0.4,
      { count: 46, colors: cols.concat('#ffffff'), shape: k === 1 ? 'star' : 'square', speed: [220, 620], gravity: 900, life: [0.7, 1.3], size: [5, 10] }), k * 140);
  }
  flash.trigger('#fff3c4', 0.22);
  shake.add(0.35);
}

// ---------------------------------------------------------------- tools
function useTool(tool) {
  if (phase !== 'play') return;
  const a = E.toolAction(tool, lv.eco, save.drops);
  if (tool === 'undo' && !lv.history.length) { toast('Nothing to undo'); return; }
  if (a === 'used') { toast('One extra tube per level'); return; }
  if (a === 'offer') { offerPanel(tool); return; }
  E.payTool(tool, lv.eco, save);
  if (a === 'drops') { kit.save.save(); bumpDrops(); }
  applyTool(tool);
  updateHud();
}

function applyTool(tool) {
  if (tool === 'undo') {
    const [a, b] = lv.history.pop();
    applyMove(lv.tubes, b, a);
    maskMove(b, a);
    lv.sel = -1; lv.hint = null; lv.stuckShown = false;
    kit.audio.play('whoosh', { vol: 0.6 });
  } else if (tool === 'hint') {
    const r = solve(lv.tubes, 30000);
    if (r.status === 'solved' && r.path.length) {
      const [a, b] = r.path[0];
      lv.hint = { a, b, until: T + 3 };
      lv.sel = -1;
      kit.audio.play('sparkle');
    } else {
      toast(r.status === 'dead' ? 'No way forward - try Undo' : 'Hmm, try another move');
    }
  } else if (tool === 'tube') {
    lv.eco.extraTube = true;
    addTube();
  }
}

function addTube() {
  lv.tubes.push([]);
  if (lv.mask) lv.mask.push([]);
  lv.stuckShown = false;
  layoutCache = null;
  kit.audio.play('unlock', { vol: 0.7 });
  updateHud();
}

function offerPanel(tool) {
  const names = { undo: 'Out of undos', hint: 'Out of hints', tube: 'Extra tube' };
  const grant = {
    undo: { label: '+3 undos', fn: () => { lv.eco.freeUndo += 3; kit.audio.play('reward'); updateHud(); } },
    hint: { label: 'Free hint', fn: () => { save.hintAdAt = Date.now(); kit.save.save(); applyTool('hint'); updateHud(); } },
    tube: { label: 'Extra tube', fn: () => { applyTool('tube'); } },
  }[tool];
  let reward = grant;
  let text = `${E.PRICES[tool]} drops, or watch a short video.`;
  if (tool === 'hint' && !E.hintAdReady(save.hintAdAt, Date.now())) {
    reward = null;
    const s = Math.ceil((E.HINT_AD_COOLDOWN_MS - (Date.now() - save.hintAdAt)) / 1000);
    text = `Next video hint in ${s} s.`;
  }
  panel({ title: names[tool], text, free: { label: 'No thanks', fn: () => {} }, reward });
}

// ---------------------------------------------------------------- panels (DOM)
let panelState = null;

function panel(o) {
  panelState = o;
  phase = 'panel';
  portal.gameplayStop();
  $('m-title').textContent = o.title;
  const media = $('m-media');
  media.innerHTML = o.html || '';
  if (o.media) media.appendChild(o.media);
  $('m-text').textContent = o.text || '';
  $('m-free').textContent = o.free.label;
  const rw = $('m-reward');
  rw.textContent = o.reward ? `🎬 ${o.reward.label}` : '';
  rw.hidden = !(o.reward && portal.rewardAvailable());
  rw.disabled = false;
  const more = $('m-more');
  more.innerHTML = '';
  for (const b of o.more || []) {
    const el = document.createElement('button');
    el.className = `btn ${b.cls || 'alt'}`;
    el.textContent = b.label;
    el.onclick = () => { kit.audio.play('click'); if (!b.keep) closePanel(); b.fn(); };
    more.appendChild(el);
  }
  $('modal').classList.toggle('low', !!o.low);
  $('modal').hidden = false;
}

function closePanel() {
  $('modal').hidden = true;
  const was = panelState;
  panelState = null;
  if (phase === 'panel') phase = lv && isSolved(lv.tubes) ? 'won-done' : 'play';
  if (phase === 'play') portal.gameplayStart();
  return was;
}

function bindHud() {
  $('m-free').onclick = () => {
    hadInput = true;
    kit.audio.unlock();
    kit.audio.play('click');
    const o = closePanel();
    if (o && o.free.fn) o.free.fn();
  };
  $('m-reward').onclick = async () => {
    const rw = $('m-reward');
    if (rw.disabled || !panelState || !panelState.reward) return;
    hadInput = true;
    rw.disabled = true;
    const r = await portal.rewarded();
    rw.disabled = false;
    if (r.ok) {
      const o = closePanel();
      o.reward.fn();
    } else {
      rw.hidden = !portal.rewardAvailable();
      toast('Video not available right now');
    }
  };
  $('t-undo').onclick = () => { kit.audio.unlock(); useTool('undo'); };
  $('t-hint').onclick = () => { kit.audio.unlock(); useTool('hint'); };
  $('t-tube').onclick = () => { kit.audio.unlock(); useTool('tube'); };
  $('t-restart').onclick = () => { if (phase === 'play') { kit.audio.play('whoosh'); restartLevel(); } };
  $('b-menu').onclick = () => { if (phase === 'play') menuPanel(); };
  $('b-daily').onclick = () => {
    if (phase !== 'play') return;
    kit.audio.play('click');
    if (lv.info.daily) { toast('You are painting the daily mural'); return; }
    startDaily();
  };
  // Keyboard: Esc opens the menu (portal rule: pause on keyboard games).
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (phase === 'play') menuPanel(); else if (phase === 'panel' && panelState && panelState.escClose) closePanel(); }
    if (phase === 'play' && (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) useTool('undo');
  });
}

function menuPanel() {
  const s = kit.audio.settings();
  const more = [
    lv.info.daily ? { label: 'Back to album', fn: () => startLevel(save.level) } : { label: 'Daily mural', fn: startDaily },
    { label: 'Album', fn: albumPanel },
    { label: `Sound: ${s.sfxOn ? 'on' : 'off'}`, fn: () => { kit.setSound({ sfxOn: !s.sfxOn }); menuPanel(); } },
    { label: `Music: ${s.musicOn ? 'on' : 'off'}`, fn: () => { kit.setSound({ musicOn: !s.musicOn }); if (s.musicOn) kit.audio.music.stop(); menuPanel(); } },
  ];
  panel({
    title: 'Paused',
    text: E.canSkip(lv.eco) ? 'Stuck on this one? You can skip it (no stars).' : '',
    free: { label: 'Resume', fn: () => {} },
    reward: E.canSkip(lv.eco) ? { label: 'Skip level', fn: skipLevel } : null,
    more,
    escClose: true,
  });
}

function skipLevel() {
  // Paint the rest of the picture for this level, no stars.
  save.level = Math.max(save.level, lv.n + 1);
  kit.save.flush();
  startLevel(save.level);
  toast('Level skipped');
}

function albumPanel() {
  const grid = document.createElement('div');
  grid.className = 'album';
  const cur = locate(save.level);
  MURALS.forEach((m, i) => {
    const fig = document.createElement('figure');
    const done = cur.m === null || i < cur.m;
    const levelsDone = done ? m.levels : i === cur.m ? cur.l : 0;
    const img = muralImage(i, 4, levelsDone, i > (cur.m === null ? MURALS.length : cur.m));
    const cap = document.createElement('figcaption');
    cap.textContent = done ? m.name : i === cur.m ? `${levelsDone}/${m.levels}` : '?';
    fig.append(img, cap);
    grid.appendChild(fig);
  });
  const total = MURALS.length;
  const doneCount = cur.m === null ? total : cur.m;
  panel({ title: 'Album', html: '', text: `${doneCount} of ${total} murals finished. More coming soon!`, free: { label: 'Back', fn: () => {} }, escClose: true });
  $('m-media').appendChild(grid);
}

/** A small canvas with mural m painted (all levels by default). */
function muralImage(m, scale, levelsDone = MURALS[m].levels, locked = false) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * scale;
  const g = c.getContext('2d');
  const plan = muralPlan(m);
  const painted = paintedBefore(m, levelsDone);
  g.fillStyle = PAPER;
  g.fillRect(0, 0, c.width, c.height);
  plan.pixels.forEach((p, i) => {
    g.fillStyle = locked ? '#d9d2c4' : painted.has(i) ? PALETTE[p.c].hex : tint(PALETTE[p.c].hex, 0.18);
    g.fillRect(p.x * scale, p.y * scale, scale, scale);
  });
  return c;
}

// ---------------------------------------------------------------- HUD
function updateHud() {
  if (!lv) return;
  const m = lv.info.m;
  if (lv.info.daily) {
    $('t-mural').textContent = `Daily · ${MURALS[m].name}`;
    $('t-level').textContent = `Stage ${lv.info.l + 1}/${DAILY_STAGES.length}`;
  } else {
    $('t-mural').textContent = m === null ? 'Bonus levels' : MURALS[m].name;
    const tw = [lv.cap === 5 ? 'Tall' : '', lv.mask ? 'Mystery' : ''].filter(Boolean).join(' + ');
    $('t-level').textContent = (m === null ? `Level ${lv.n}` : `Level ${lv.n} · ${lv.info.l + 1}/${MURALS[m].levels}`) + (tw ? ` · ${tw}` : '');
  }
  $('drops-n').textContent = save.drops;
  badge('undo', lv.eco.freeUndo > 0 ? String(lv.eco.freeUndo) : save.drops >= E.PRICES.undo ? String(E.PRICES.undo) : '🎬', lv.eco.freeUndo > 0 ? '' : save.drops >= E.PRICES.undo ? 'cost' : 'ad');
  badge('hint', lv.eco.freeHint > 0 ? String(lv.eco.freeHint) : save.drops >= E.PRICES.hint ? String(E.PRICES.hint) : '🎬', lv.eco.freeHint > 0 ? '' : save.drops >= E.PRICES.hint ? 'cost' : 'ad');
  badge('tube', lv.eco.extraTube ? '✓' : save.drops >= E.PRICES.tube ? String(E.PRICES.tube) : '🎬', lv.eco.extraTube ? 'free' : save.drops >= E.PRICES.tube ? 'cost' : 'ad');
}

function badge(tool, text, cls) {
  const el = $(`bd-${tool}`);
  // Without ads (adblock / no portal) an ad badge would be a dead end: show the price instead.
  if (cls === 'ad' && !portal.rewardAvailable()) { text = String(E.PRICES[tool]); cls = 'cost'; }
  el.textContent = text;
  el.className = `bd ${cls}`;
}

function bumpDrops() {
  const p = $('drops');
  p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump');
  $('drops-n').textContent = save.drops;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

// Timers in game time, so they pause during ads together with the loop.
const timers = [];
function later(fn, ms) { timers.push({ at: T + ms / 1000, fn }); }

// ---------------------------------------------------------------- update
function update(dt) {
  T += dt;
  for (let i = timers.length - 1; i >= 0; i--) {
    if (timers[i].at <= T) { const t = timers.splice(i, 1)[0]; try { t.fn(); } catch (e) { console.error(e); } }
  }
  if (lv) {
    lv.flights = lv.flights.filter((f) => T - f.t0 < f.dur);
    // Pixels that just got paint: a little splash each.
    if (lv.info.m !== null && lv.pending.size) {
      const L = layout();
      let k = 0;
      for (const [pi, at] of lv.pending) {
        if (at <= T && !lv.splashed.has(pi)) {
          lv.splashed.add(pi);
          const r = cellRect(L, pi);
          parts.burst(r.x + r.s / 2, r.y + r.s / 2, { count: 3, colors: [PALETTE[r.c].hex], speed: [40, 140], gravity: 300, life: [0.2, 0.45], size: [2, 4] });
          if (k++ === 0) kit.audio.play('bubble', { vol: 0.5, pitch: 0.85 + (lv.splashed.size % 12) * 0.04 });
        }
      }
    }
    if (lv.stream && T < lv.stream.until) {
      const L = layout();
      const s = lv.stream;
      // Aim at the pixel that is about to be painted.
      let next = s.target[s.target.length - 1];
      for (const pi of s.target) { if (lv.pending.get(pi) >= T) { next = pi; break; } }
      const cr = cellRect(L, next);
      const tx = cr.x + cr.s / 2, ty = cr.y + cr.s / 2;
      const ang = Math.atan2(ty - s.y, tx - s.x);
      const dist = Math.hypot(tx - s.x, ty - s.y);
      parts.burst(s.x, s.y, { count: 2, colors: [PALETTE[s.c].hex], angle: ang, spread: 0.25, speed: [dist * 2.2, dist * 2.8], gravity: 0, drag: 0, life: [0.32, 0.4], size: [4, 7] });
    }
    if (phase === 'won' && lv.wonAt && T >= lv.wonAt) { phase = 'won-done'; finishLevel(); }
  }
  parts.update(dt); floaters.update(dt); shake.update(dt); flash.update(dt);
}

// ---------------------------------------------------------------- layout
function layout() {
  if (layoutCache && layoutCache.n === lv.tubes.length) return layoutCache;
  const v = kit.view.bounds;
  const topY = kit.view.toWorld(0, $('top').getBoundingClientRect().bottom).y;
  const botY = kit.view.toWorld(0, $('tools').getBoundingClientRect().top).y;
  const pad = 18;
  const x0 = v.x, w = v.w, y0 = Math.max(v.y, topY), h = Math.min(v.y + v.h, botY) - y0;
  let mural, board;
  // The frame adds ~4.5% on each side of the mural, so sizes below leave room for it.
  if (w > h * 1.05) {
    const size = Math.min(w * 0.4, (h - pad * 2) / 1.1);
    mural = { x: x0 + w * 0.27 - size / 2, y: y0 + (h - size) / 2, size };
    board = { x: x0 + w * 0.5, y: y0 + pad, w: w * 0.48 - pad, h: h - pad * 2 };
  } else {
    // Many tubes need more room: the mural gives some of its height to the board.
    const nt = lv.tubes.length;
    const size = Math.min((w - pad * 2) / 1.1, h * (nt >= 10 ? 0.34 : nt >= 8 ? 0.38 : 0.42));
    mural = { x: x0 + (w - size) / 2, y: y0 + size * 0.045 + pad * 0.6, size };
    const by = mural.y + size * 1.045 + pad;
    board = { x: x0 + pad, y: by, w: w - pad * 2, h: y0 + h - by - pad * 0.5 };
  }
  // Tubes: one or two rows, whichever gives bigger balls (capped relative to the board).
  const n = lv.tubes.length;
  const cap = Math.min(board.w, board.h * 1.2) / 6.5;
  let best = null;
  for (const rows of [1, 2]) {
    const per = Math.ceil(n / rows);
    // Height: each row is a tube (CAP + 0.42) plus 1.2 ball of room for the lifted ball.
    const d = Math.min(board.w / (per * 1.6), board.h / (rows * (lv.cap + 1.62)), cap);
    if (!best || d > best.d) best = { rows, per, d };
  }
  const { rows, per, d } = best;
  const tw = d * 1.22, th = d * lv.cap + d * 0.42;
  const gap = Math.min((board.w - per * tw) / per, d * 0.9);
  const rowH = th + d * 1.2;
  const startY = board.y + (board.h - rows * rowH) / 2 + d * 1.2;
  const tubes = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / per);
    const inRow = row === rows - 1 ? n - per * (rows - 1) : per;
    const col = i - row * per;
    const rowW = inRow * tw + (inRow - 1) * gap;
    tubes.push({ x: board.x + (board.w - rowW) / 2 + col * (tw + gap), y: startY + row * rowH, w: tw, h: th });
  }
  layoutCache = { n, mural, board, tubes, d };
  return layoutCache;
}

function ballPos(L, tube, slot, lifted) {
  const r = L.tubes[tube];
  const x = r.x + r.w / 2;
  if (lifted) return { x, y: r.y - L.d * 0.75 };
  return { x, y: r.y + r.h - L.d * 0.62 - slot * L.d };
}

// ---------------------------------------------------------------- render
const spriteCache = new Map();
function ballSprite(c, d) {
  const px = Math.max(8, Math.ceil(d * kit.view.scale * kit.view.dpr));
  const key = `${c}:${px}`;
  let s = spriteCache.get(key);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = px + 4;
  const g = s.getContext('2d');
  const r = px / 2, cx = r + 2, cy = r + 2;
  const hex = c < 0 ? '#6f6b93' : PALETTE[c].hex;   // c = -1: mystery ball
  const grad = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.08, cx, cy, r);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.22, lighten(hex, 0.25));
  grad.addColorStop(0.75, hex);
  grad.addColorStop(1, shade(hex, 0.62));
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.beginPath(); g.ellipse(cx - r * 0.32, cy - r * 0.42, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2); g.fill();
  if (c < 0) {
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.font = `700 ${r * 1.15}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('?', cx, cy + r * 0.06);
  }
  spriteCache.set(key, s);
  return s;
}

function drawBall(ctx, c, x, y, d, scale = 1) {
  const s = ballSprite(c, d);
  const size = d * scale * (s.width / (s.width - 4));
  ctx.drawImage(s, x - size / 2, y - size / 2, size, size);
}

function render(ctx, alpha) {
  if (!lv) return;
  const v = kit.view.bounds;
  const L = layout();
  // Background
  const g = ctx.createLinearGradient(0, v.y, 0, v.y + v.h);
  g.addColorStop(0, '#2d2860'); g.addColorStop(1, '#1b1840');
  ctx.fillStyle = g;
  ctx.fillRect(v.x, v.y, v.w, v.h);

  ctx.save();
  shake.apply(ctx, v.x + v.w / 2, v.y + v.h / 2);
  drawMural(ctx, L);
  drawBoard(ctx, L);
  parts.draw(ctx);
  floaters.draw(ctx);
  ctx.restore();
  flash.draw(ctx, v.w, v.h, v.x, v.y);
}

function drawMural(ctx, L) {
  const { x, y, size } = L.mural;
  const m = lv.info.m;
  // Frame
  const f = size * 0.045;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  roundRect(ctx, x - f, y - f + 8, size + f * 2, size + f * 2, f * 1.4); ctx.fill();
  ctx.fillStyle = '#f7e2c0';
  roundRect(ctx, x - f, y - f, size + f * 2, size + f * 2, f * 1.4); ctx.fill();
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, size, size);
  if (m === null) {
    ctx.fillStyle = INK;
    ctx.font = `600 ${size * 0.08}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Album complete!', x + size / 2, y + size * 0.42);
    ctx.font = `500 ${size * 0.055}px ${FONT}`;
    ctx.fillText('Bonus levels fill your paint jar', x + size / 2, y + size * 0.56);
    return;
  }
  const plan = muralPlan(m);
  const cs = size / SIZE;
  for (let i = 0; i < plan.pixels.length; i++) {
    const p = plan.pixels[i];
    const hex = PALETTE[p.c].hex;
    const px = x + p.x * cs, py = y + p.y * cs;
    let k = lv.base.has(i) ? 1 : 0;
    const at = lv.pending.get(i);
    if (!k && at !== undefined && at <= T) k = clamp((T - at) / 0.24);
    if (k < 1) {
      ctx.fillStyle = tint(hex, 0.2);
      ctx.fillRect(px, py, cs, cs);
    }
    if (k > 0) {
      const s = ease.outBack(k);
      const o = (cs * (1 - s)) / 2;
      ctx.fillStyle = hex;
      ctx.fillRect(px + o, py + o, cs * s, cs * s);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(px + o, py + o, cs * s, cs * s * 0.18);
      if (k < 1) { ctx.fillStyle = `rgba(255,255,255,${0.6 * (1 - k)})`; ctx.fillRect(px, py, cs, cs); }
    }
  }
  // Colouring-book outline between different colours.
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, cs * 0.11);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of outline(m)) {
    ctx.moveTo(x + x1 * cs, y + y1 * cs);
    ctx.lineTo(x + x2 * cs, y + y2 * cs);
  }
  ctx.stroke();
}

const outlines = new Map();
function outline(m) {
  if (outlines.has(m)) return outlines.get(m);
  const art = MURALS[m].art;
  const at = (x, y) => (y < 0 || y >= SIZE || x < 0 || x >= SIZE ? '.' : art[y][x]);
  const segs = [];
  for (let y = 0; y <= SIZE; y++) {
    for (let x = 0; x <= SIZE; x++) {
      if (at(x, y) !== at(x, y - 1) && (at(x, y) !== '.' || at(x, y - 1) !== '.') && x < SIZE) segs.push([x, y, x + 1, y]);
      if (at(x, y) !== at(x - 1, y) && (at(x, y) !== '.' || at(x - 1, y) !== '.') && y < SIZE) segs.push([x, y, x, y + 1]);
    }
  }
  outlines.set(m, segs);
  return segs;
}

function drawBoard(ctx, L) {
  const d = L.d;
  const hidden = new Set(lv.flights.map((f) => `${f.tube}:${f.slot}`));
  const pulse = 0.5 + 0.5 * Math.sin(T * 6);
  lv.tubes.forEach((tube, i) => {
    const r = L.tubes[i];
    let ox = 0;
    if (i === lv.shakeTube && T - lv.shakeAt < 0.3) ox = Math.sin((T - lv.shakeAt) * 60) * d * 0.12 * (1 - (T - lv.shakeAt) / 0.3);
    const done = isFullTube(tube);
    const hinted = lv.hint && T < lv.hint.until && (i === lv.hint.a || i === lv.hint.b);
    const tutorial = lv.tutorial && lv.hint == null && tutorialMove() && tutorialMove().includes(i);
    // Glass
    ctx.save();
    ctx.translate(ox, 0);
    ctx.fillStyle = done ? withAlpha(PALETTE[tube[0]].hex, 0.18) : 'rgba(255,255,255,0.07)';
    roundRect(ctx, r.x, r.y, r.w, r.h, r.w * 0.45, true); ctx.fill();
    ctx.lineWidth = d * 0.07;
    ctx.strokeStyle = hinted || tutorial ? `rgba(255,210,63,${0.55 + 0.45 * pulse})` : done ? withAlpha(PALETTE[tube[0]].hex, 0.9) : 'rgba(255,255,255,0.38)';
    roundRect(ctx, r.x, r.y, r.w, r.h, r.w * 0.45, true); ctx.stroke();
    // Balls
    tube.forEach((c, slot) => {
      if (hidden.has(`${i}:${slot}`)) return;
      const lifted = i === lv.sel && slot === tube.length - 1;
      const p = ballPos(L, i, slot, lifted);
      const shown = lv.mask && lv.mask[i][slot] ? -1 : c;
      drawBall(ctx, shown, p.x, p.y + (lifted ? Math.sin(T * 8) * d * 0.05 : 0), d * 0.86);
    });
    // Rim highlight
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(r.x + r.w * 0.16, r.y + d * 0.3, r.w * 0.1, r.h - d * 0.8);
    ctx.restore();
    if (hinted && i === lv.hint.a) arrow(ctx, r.x + r.w / 2, r.y - d * 1.45 - pulse * d * 0.15, d);
    if (tutorial && i === tutorialMove()[lv.sel < 0 ? 0 : 1]) arrow(ctx, r.x + r.w / 2, r.y - d * 1.45 - pulse * d * 0.15, d);
  });
  // Flying balls
  for (const f of lv.flights) {
    const k = ease.inOutQuad(clamp((T - f.t0) / f.dur));
    const cx = (f.x0 + f.x1) / 2, cy = Math.min(f.y0, f.y1) - d * 1.1;
    const x = (1 - k) * (1 - k) * f.x0 + 2 * (1 - k) * k * cx + k * k * f.x1;
    const y = (1 - k) * (1 - k) * f.y0 + 2 * (1 - k) * k * cy + k * k * f.y1;
    drawBall(ctx, f.c, x, y, d * 0.86);
  }
  // Tutorial text
  if (lv.tutorial) {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `600 ${Math.max(24, d * 0.42)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const msg = lv.sel < 0 ? 'Tap a tube to pick up the top ball' : 'Now tap where to drop it';
    const last = L.tubes[L.tubes.length - 1];
    ctx.fillText(msg, L.board.x + L.board.w / 2, last.y + last.h + d * 0.75);
  }
}

let tutorialCache = null;
function tutorialMove() {
  if (!lv.tutorial) return null;
  const key = lv.tubes.map((t) => t.join('')).join('|') + lv.sel;
  if (tutorialCache && tutorialCache.key === key) return tutorialCache.move;
  const r = solve(lv.tubes, 20000);
  let move = r.status === 'solved' && r.path.length ? r.path[0] : null;
  if (move && lv.sel >= 0 && move[0] !== lv.sel) move = null;
  tutorialCache = { key, move };
  return move;
}

function arrow(ctx, x, y, d) {
  ctx.fillStyle = '#ffd23f';
  ctx.strokeStyle = INK;
  ctx.lineWidth = d * 0.06;
  ctx.beginPath();
  ctx.moveTo(x, y + d * 0.45);
  ctx.lineTo(x - d * 0.32, y);
  ctx.lineTo(x - d * 0.13, y);
  ctx.lineTo(x - d * 0.13, y - d * 0.35);
  ctx.lineTo(x + d * 0.13, y - d * 0.35);
  ctx.lineTo(x + d * 0.13, y);
  ctx.lineTo(x + d * 0.32, y);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
}

// ---------------------------------------------------------------- drawing helpers
function roundRect(ctx, x, y, w, h, r, bottomOnly = false) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (bottomOnly) {
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + h - r);
    ctx.arcTo(x, y + h, x + r, y + h, r);
    ctx.lineTo(x + w - r, y + h);
    ctx.arcTo(x + w, y + h, x + w, y + h - r, r);
    ctx.lineTo(x + w, y);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function shade(hex, f) { const [r, g, b] = rgb(hex); return `rgb(${r * f | 0},${g * f | 0},${b * f | 0})`; }
function lighten(hex, f) { const [r, g, b] = rgb(hex); return `rgb(${r + (255 - r) * f | 0},${g + (255 - g) * f | 0},${b + (255 - b) * f | 0})`; }
function withAlpha(hex, a) { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; }
// Paper tinted with a little of the target colour (paint-by-number hint).
function tint(hex, a) {
  const [r, g, b] = rgb(hex), [pr, pg, pb] = rgb(PAPER);
  return `rgb(${pr + (r - pr) * a | 0},${pg + (g - pg) * a | 0},${pb + (b - pb) * a | 0})`;
}

if (DEV) window.__game = { get lv() { return lv; }, get phase() { return phase; }, save, kit, solve, move, checkStuck, TOTAL_LEVELS, startLevel, startDaily, layout,
  toClient: (x, y) => { const b = kit.view.bounds, s = kit.view.scale; return { x: (x - b.x) * s, y: (y - b.y) * s }; } };
