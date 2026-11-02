// Deterministic random helpers. No Date.now / Math.random in the seeded paths.

// FNV-1a over UTF-16 code units -> uint32. Stable across runs and platforms.
export function hashString(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: tiny 32-bit PRNG, returns () => [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// seed: number or string. Without a seed a random one is drawn once (read it back via .seed).
export function createRng(seed) {
  let s;
  if (typeof seed === 'string') s = hashString(seed);
  else if (typeof seed === 'number' && Number.isFinite(seed)) s = Math.floor(seed) >>> 0;
  else s = Math.floor(Math.random() * 4294967296) >>> 0;
  const next = mulberry32(s);
  const rng = {
    seed: s,
    next,
    // Integer in [min, max], both inclusive.
    int(min, max) {
      let lo = Math.ceil(min), hi = Math.floor(max);
      if (lo > hi) [lo, hi] = [Math.ceil(max), Math.floor(min)];
      if (lo > hi) return lo;
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    float(min = 0, max = 1) {
      return min + next() * (max - min);
    },
    pick(arr) {
      return arr.length ? arr[Math.floor(next() * arr.length)] : undefined;
    },
    // Fisher-Yates, in place; returns the same array.
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
    chance(p) {
      return next() < p;
    },
  };
  return rng;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// LOCAL calendar day as 'YYYY-MM-DD'.
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Same day + same salt -> same seed on every device.
export function dailySeed(day, salt = '') {
  return hashString(`${day}|${salt}`);
}
