// Meta-progression helpers: pure functions on plain JSON state (store it inside save.data).

const DAY_MS = 86400000;

// 'YYYY-MM-DD' -> days since epoch (UTC midnight of those parts, so DST never matters). NaN if bad.
function dayNumber(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return t / DAY_MS;
}

// Calendar days from A to B (positive when B is later).
export function daysBetween(dayKeyA, dayKeyB) {
  return Math.round(dayNumber(dayKeyB) - dayNumber(dayKeyA));
}

export const wallet = {
  create: () => ({ coins: 0, earned: 0 }),
  // Ignores non-positive / non-finite amounts. Returns the new balance.
  add(w, n) {
    if (Number.isFinite(n) && n > 0) {
      w.coins += n;
      w.earned += n;
    }
    return w.coins;
  },
  can: (w, n) => Number.isFinite(n) && n >= 0 && w.coins >= n,
  spend(w, n) {
    if (!wallet.can(w, n)) return false;
    w.coins -= n;
    return true;
  },
};

export const streak = {
  create: () => ({ count: 0, best: 0, last: null, broken: null }),
  // Call once per session start.
  check(s, today) {
    if (s.last == null) {
      s.count = 1;
      s.best = Math.max(s.best || 0, 1);
      s.last = today;
      s.broken = null;
      return 'started';
    }
    const diff = daysBetween(s.last, today);
    // Same day, clock moved back or garbage date: change nothing.
    if (!Number.isFinite(diff) || diff <= 0) return 'same';
    if (diff === 1) {
      s.count += 1;
      s.best = Math.max(s.best || 0, s.count);
      s.last = today;
      s.broken = null;
      return 'continued';
    }
    s.broken = s.count;
    s.count = 1;
    s.last = today;
    return 'broken';
  },
  // Broken on this very day and not repaired yet.
  canRepair: (s, today) => s.broken > 0 && s.last === today,
  repair(s, today) {
    if (!streak.canRepair(s, today)) return false;
    s.count = s.broken + 1;
    s.best = Math.max(s.best || 0, s.count);
    s.broken = null;
    return true;
  },
};

export const daily = {
  create: () => ({ day: null, done: false, progress: 0 }),
  // Resets on a new day. Returns true when it rolled over.
  roll(d, today) {
    if (d.day === today) return false;
    d.day = today;
    d.done = false;
    d.progress = 0;
    return true;
  },
  // Returns true the first time it is completed.
  complete(d) {
    if (d.done) return false;
    d.done = true;
    return true;
  },
};

export const collection = {
  create: () => ({ have: [] }),
  // True when the id is new.
  unlock(c, id) {
    if (c.have.includes(id)) return false;
    c.have.push(id);
    return true;
  },
  has: (c, id) => c.have.includes(id),
  // Share of allIds that are owned, 0..1.
  progress(c, allIds) {
    const ids = [...new Set(allIds)];
    if (!ids.length) return 0;
    return ids.filter((id) => c.have.includes(id)).length / ids.length;
  },
};

// lastTs / now in ms (Date.now() style). Returns unrounded earnings, capped at capSec of time.
export function offlineEarnings(lastTs, now, ratePerSec, capSec = 8 * 3600) {
  if (!Number.isFinite(lastTs) || !Number.isFinite(now) || !(ratePerSec > 0)) return 0;
  const sec = Math.min((now - lastTs) / 1000, capSec);
  return sec > 0 ? sec * ratePerSec : 0;
}
