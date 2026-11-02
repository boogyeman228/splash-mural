// plan.js - pure: which level belongs to which mural, its colours and which mural pixels
// each completed tube paints. Deterministic, so progress is derived from the level number.
import { MURALS, PALETTE, pixelsOf } from './murals.js';
import { hashString, dailySeed } from './kit/rng.js';

export const TOTAL_LEVELS = MURALS.reduce((s, m) => s + m.levels, 0);
export const DAILY_STAGES = [5, 6, 7];          // colours in the three daily levels
const WAVE = [7, 8, 9, 8, 9, 7, 9, 8];          // after the ramp: breather levels between hard ones

/**
 * Twists by mural, introduced one at a time:
 *   murals 1-5 plain; 6-7 TALL tubes (5 balls); 8 plain breather; 9-10 MYSTERY balls (only the top
 *   ball of each tube is visible); 11-12 alternate tall / mystery; 13+ cycle tall, mystery, both.
 */
export function twists(n) {
  const { m, l } = locate(n);
  const k = m === null ? n : l;
  if (m === null || m >= 12) return { tall: k % 3 !== 1, mystery: k % 3 !== 0 };
  if (m === 5 || m === 6) return { tall: true, mystery: false };
  if (m === 8 || m === 9) return { tall: false, mystery: true };
  if (m === 10 || m === 11) return { tall: l % 2 === 0, mystery: l % 2 === 1 };
  return { tall: false, mystery: false };
}

/**
 * Difficulty by global level number (1-based). Two empty tubes always (one gives shallow scrambles).
 * Each twist costs one colour so the level stays fair.
 */
export function difficulty(n) {
  const base = n <= 24 ? Math.min(9, 3 + Math.floor((n - 1) / 4)) : WAVE[(n - 25) % WAVE.length];
  const t = twists(n);
  const colours = Math.max(Math.min(base, 4), base - (t.tall ? 1 : 0) - (t.mystery ? 1 : 0));
  return { colours, empties: 2, cap: t.tall ? 5 : 4, mystery: t.mystery };
}

/** Global level -> { m: mural index, l: level inside the mural } (m = null after the album). */
export function locate(n) {
  let start = 1;
  for (let m = 0; m < MURALS.length; m++) {
    if (n < start + MURALS[m].levels) return { m, l: n - start, first: start };
    start += MURALS[m].levels;
  }
  return { m: null, l: 0, first: start };
}

/**
 * Plan a mural painted over levels with the given colour counts.
 * -> { pixels: [{x,y,c}], levels: [{ colours: [id], paint: { [colourId]: [pixelIndex] } }] }
 */
export function buildPlan(m, counts, salt = 0) {
  const pixels = pixelsOf(MURALS[m]);
  const own = [...new Set(pixels.map((p) => p.c))];
  const amount = Object.fromEntries(own.map((c) => [c, pixels.filter((p) => p.c === c).length]));
  const used = Object.fromEntries(own.map((c) => [c, 0]));
  const extras = PALETTE.map((_, i) => i).filter((c) => !own.includes(c));
  const levels = counts.map((k, l) => {
    // Spread the mural's colours evenly over its levels; big colours first on ties.
    const pick = own.slice().sort((a, b) => used[a] - used[b] || amount[b] - amount[a] || a - b).slice(0, k);
    pick.forEach((c) => used[c]++);
    // Extra colours (not in the picture) pour into the paint jar instead.
    const rot = (m * 3 + l + salt) % Math.max(1, extras.length);
    const ordered = extras.slice(rot).concat(extras.slice(0, rot));
    while (pick.length < k && ordered.length) pick.push(ordered.shift());
    return { colours: pick.sort((a, b) => a - b), paint: {} };
  });
  // Split each colour's pixels bottom-up between the levels that carry that colour.
  for (const c of own) {
    const idx = pixels.map((p, i) => i).filter((i) => pixels[i].c === c)
      .sort((i, j) => pixels[j].y - pixels[i].y || pixels[i].x - pixels[j].x);
    const carriers = levels.filter((lv) => lv.colours.includes(c));
    carriers.forEach((lv, i) => {
      lv.paint[c] = idx.slice(Math.floor((i * idx.length) / carriers.length), Math.floor(((i + 1) * idx.length) / carriers.length));
    });
  }
  return { pixels, levels };
}

const cache = new Map();
/** Album plan of mural m. */
export function muralPlan(m) {
  if (!cache.has(m)) {
    const first = MURALS.slice(0, m).reduce((s, x) => s + x.levels, 0) + 1;
    cache.set(m, buildPlan(m, Array.from({ length: MURALS[m].levels }, (_, l) => difficulty(first + l).colours)));
  }
  return cache.get(m);
}

/** Everything needed to start global level n. */
export function levelInfo(n) {
  const { m, l } = locate(n);
  const d = difficulty(n);
  if (m === null) {
    // After the album: endless levels, every tube pours into the jar.
    const colours = PALETTE.map((_, i) => i).slice(0, d.colours);
    return { n, m: null, l: 0, colours, empties: d.empties, cap: d.cap, mystery: d.mystery, paint: {}, seed: hashString(`endless:${n}`) };
  }
  const lv = muralPlan(m).levels[l];
  return { n, m, l, colours: lv.colours, empties: d.empties, cap: d.cap, mystery: d.mystery, paint: lv.paint, seed: hashString(`${MURALS[m].id}:${l}`) };
}

/** Pixel indexes already painted when the first `levelsDone` levels of a plan are complete. */
export function paintedIn(plan, levelsDone) {
  const set = new Set();
  for (let l = 0; l < Math.min(levelsDone, plan.levels.length); l++) {
    for (const list of Object.values(plan.levels[l].paint)) list.forEach((i) => set.add(i));
  }
  return set;
}
export const paintedBefore = (m, levelsDone) => paintedIn(muralPlan(m), levelsDone);

// ---------------------------------------------------------------- daily mural
// Same three levels for everyone on a calendar day: mural and boards come from the date.
const dailyCache = new Map();
export function dailyPlan(day) {
  if (!dailyCache.has(day)) {
    const seed = dailySeed(day, 'mural');
    const m = seed % MURALS.length;
    dailyCache.set(day, { m, plan: buildPlan(m, DAILY_STAGES, seed % 7) });
    if (dailyCache.size > 4) dailyCache.delete(dailyCache.keys().next().value);
  }
  return dailyCache.get(day);
}

export function dailyInfo(day, stage) {
  const { m, plan } = dailyPlan(day);
  const lv = plan.levels[stage];
  return { daily: true, day, n: stage + 1, m, l: stage, plan, colours: lv.colours, empties: 2, cap: 4, mystery: false, paint: lv.paint, seed: dailySeed(day, `stage${stage}`) };
}

/** Daily number shown in the share text (#1 = 1 Nov 2026). */
export function dailyNumber(day) {
  const [y, mo, d] = day.split('-').map(Number);
  return Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(2026, 10, 1)) / 86400000) + 1;
}

/** Share text for a finished daily (no links: portals only allow links through their SDK). */
export function dailyShareText(day, moves) {
  const { m } = dailyPlan(day);
  return `Splash Mural Daily #${dailyNumber(day)} 🎨\n${MURALS[m].name} painted in ${moves} moves\n🟥🟨🟦 3/3`;
}
