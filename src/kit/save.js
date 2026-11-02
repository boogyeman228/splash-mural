// Versioned save with fallbacks (portal cloud -> localStorage -> memory). Never throws.
// Stored format: JSON { v: version, t: timestamp, d: data }. Previous good copy lives in `${key}.bak`.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- backends: { name, get(k) -> string|null, set(k, v) -> boolean, remove(k) } ----

export function memoryBackend() {
  const m = new Map();
  return {
    name: 'memory',
    get: (k) => (m.has(k) ? m.get(k) : null),
    set(k, v) { m.set(k, String(v)); return true; },
    remove(k) { m.delete(k); return true; },
  };
}

function storageBackend(name, store) {
  return {
    name,
    get(k) {
      try { const v = store.getItem(k); return typeof v === 'string' ? v : null; } catch { return null; }
    },
    set(k, v) {
      try { store.setItem(k, v); return true; } catch { return false; }
    },
    remove(k) {
      try { store.removeItem(k); return true; } catch { return false; }
    },
  };
}

// store: CrazyGames data module (getItem/setItem/removeItem) or null.
export function portalBackend(store) {
  return store && typeof store.getItem === 'function' ? storageBackend('portal', store) : null;
}

// storage: window.localStorage (may be undefined / blocked). Returns null when unusable.
export function localBackend(storage) {
  try {
    const probe = '__kit_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
  } catch {
    return null;
  }
  return storageBackend('local', storage);
}

// ---- helpers ----

// Deep merge: defaults fill what is missing, stored values win. Arrays come from stored as-is.
function merge(def, stored) {
  const out = {};
  for (const k of Object.keys(def)) {
    if (k === '__proto__') continue;
    const dv = def[k];
    const has = Object.hasOwn(stored, k);
    if (isObj(dv)) out[k] = has && isObj(stored[k]) ? merge(dv, stored[k]) : dv;
    else out[k] = has ? stored[k] : dv;
  }
  for (const k of Object.keys(stored)) {
    if (k !== '__proto__' && !Object.hasOwn(out, k)) out[k] = stored[k];
  }
  return out;
}

function parseEntry(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!isObj(o) || !isObj(o.d)) return null;
    return { v: Number.isInteger(o.v) && o.v >= 1 ? o.v : 1, d: o.d };
  } catch {
    return null;
  }
}

export function createSave(opts = {}) {
  const { key, version = 1, migrations = {}, debounceMs = 400, now = () => Date.now() } = opts;
  const bakKey = `${key}.bak`;
  const getWin = () => opts.win || globalThis;

  const defaults = () => {
    try {
      const d = typeof opts.defaults === 'function' ? opts.defaults() : opts.defaults;
      return isObj(d) ? d : {};
    } catch {
      return {};
    }
  };

  // Backends: explicit list, else portal (opts.portal = module with data(), or a storage-like) -> local -> memory.
  let backends;
  if (Array.isArray(opts.backends)) {
    backends = opts.backends.filter(Boolean);
    if (!backends.length) backends.push(memoryBackend());
  } else {
    backends = [];
    try {
      const p = opts.portal;
      const store = p && typeof p.data === 'function' ? p.data() : p;
      const b = portalBackend(store);
      if (b) backends.push(b);
    } catch { /* ignore */ }
    try {
      const b = localBackend(getWin().localStorage);
      if (b) backends.push(b);
    } catch { /* blocked storage getter can throw SecurityError */ }
    backends.push(memoryBackend());
  }

  let writeV = version; // data from a newer game version keeps its version stamp
  let timer = null;

  const safeGet = (b, k) => { try { return b.get(k); } catch { return null; } };

  // Entry -> upgraded data or null if a migration fails.
  function upgrade(e) {
    let d = e.d;
    if (e.v > version) {
      writeV = e.v;
      return merge(defaults(), d);
    }
    try {
      for (let v = e.v; v < version; v++) {
        const m = migrations[v];
        if (typeof m === 'function') {
          const r = m(d);
          if (isObj(r)) d = r;
        }
      }
    } catch {
      return null;
    }
    writeV = version;
    return merge(defaults(), d);
  }

  function clearTimer() {
    if (timer == null) return;
    try {
      const ct = opts.clearTimeout || getWin().clearTimeout || globalThis.clearTimeout;
      ct.call(getWin(), timer);
    } catch { /* ignore */ }
    timer = null;
  }

  const save = {
    data: defaults(),

    get backendNames() { return backends.map((b) => b.name); },

    load() {
      for (const k of [key, bakKey]) {
        for (const b of backends) {
          const e = parseEntry(safeGet(b, k));
          if (!e) continue;
          const d = upgrade(e);
          if (d) { save.data = d; return d; }
        }
      }
      writeV = version;
      save.data = defaults();
      return save.data;
    },

    // Debounced write.
    save() {
      clearTimer();
      try {
        const st = opts.setTimeout || getWin().setTimeout || globalThis.setTimeout;
        timer = st.call(getWin(), () => { timer = null; save.flush(); }, debounceMs);
      } catch {
        timer = null;
        save.flush();
      }
    },

    // Immediate write to all backends. Returns true if at least one accepted it.
    flush() {
      clearTimer();
      let str;
      try {
        str = JSON.stringify({ v: writeV, t: now(), d: save.data });
      } catch {
        return false;
      }
      if (typeof str !== 'string') return false;
      let ok = false;
      for (const b of backends) {
        try {
          const prev = safeGet(b, key);
          if (parseEntry(prev)) b.set(bakKey, prev); // only a good copy becomes the backup
          if (b.set(key, str) !== false) ok = true;
        } catch { /* ignore */ }
      }
      return ok;
    },

    reset() {
      writeV = version;
      save.data = defaults();
      save.flush();
      return save.data;
    },

    // Flush when the page is hidden or closed. Returns a detach function.
    attachAutoFlush(doc = globalThis.document, win = getWin()) {
      const onVis = () => { if (doc && doc.hidden) save.flush(); };
      const onHide = () => { save.flush(); };
      try { doc && doc.addEventListener('visibilitychange', onVis); } catch { /* ignore */ }
      try { win && win.addEventListener('pagehide', onHide); } catch { /* ignore */ }
      return () => {
        try { doc && doc.removeEventListener('visibilitychange', onVis); } catch { /* ignore */ }
        try { win && win.removeEventListener('pagehide', onHide); } catch { /* ignore */ }
      };
    },
  };
  return save;
}
