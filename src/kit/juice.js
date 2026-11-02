// Game-feel helpers: easing, tweens, screen shake, particles, floating text, spring, flash.

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

// Every easing is pinned to exactly 0 at t<=0 and 1 at t>=1.
const pin = (f) => (t) => (t <= 0 ? 0 : t >= 1 ? 1 : f(t));
const outBounceRaw = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
export const ease = {
  linear: pin((t) => t),
  inQuad: pin((t) => t * t),
  outQuad: pin((t) => 1 - (1 - t) * (1 - t)),
  inOutQuad: pin((t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)),
  outCubic: pin((t) => 1 - Math.pow(1 - t, 3)),
  inOutCubic: pin((t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)),
  outBack: pin((t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }),
  outElastic: pin((t) => Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: pin(outBounceRaw),
};

// ---------------------------------------------------------------- tweens
export function createTweens() {
  let items = [];
  let live = 0;

  function to(obj, props, dur, { ease: e = ease.outQuad, delay = 0, onDone } = {}) {
    const fn = typeof e === 'function' ? e : ease[e] || ease.linear;
    const tw = { obj, props, dur: Math.max(0, dur), delay: Math.max(0, delay), t: 0, fn, onDone, from: null, dead: false };
    items.push(tw);
    live++;
    return tw;
  }

  function kill(tw) {
    if (!tw || tw.dead) return false;
    tw.dead = true;
    live--;
    return true;
  }

  function update(dt) {
    const list = items; // snapshot: clear() inside onDone swaps `items`
    const n = list.length; // tweens added from onDone start next frame
    for (let i = 0; i < n; i++) {
      const tw = list[i];
      if (tw.dead) continue;
      let d = dt;
      if (tw.delay > 0) {
        tw.delay -= d;
        if (tw.delay > 0) continue;
        d = -tw.delay; // time left over after the delay ran out
        tw.delay = 0;
      }
      if (!tw.from) { // capture start values when the tween really starts
        tw.from = {};
        for (const k in tw.props) tw.from[k] = tw.obj[k];
      }
      tw.t += d;
      const p = tw.dur === 0 ? 1 : Math.min(tw.t / tw.dur, 1);
      const k = tw.fn(p);
      for (const key in tw.props) tw.obj[key] = p >= 1 ? tw.props[key] : lerp(tw.from[key], tw.props[key], k);
      if (p >= 1) {
        kill(tw);
        if (tw.onDone) tw.onDone(tw.obj);
      }
    }
    if (n > 0) items = items.filter((x) => !x.dead);
  }

  return {
    to,
    cancel: kill,
    update,
    clear() {
      for (const tw of items) tw.dead = true;
      items = [];
      live = 0;
    },
    get count() { return live; },
  };
}

// ---------------------------------------------------------------- shake
// shake amount = trauma^2; trauma decays linearly.
export function createShake({ decay = 1.6, maxOffset = 14, maxAngle = 0.06, rnd = Math.random } = {}) {
  let trauma = 0;
  const out = { x: 0, y: 0, angle: 0 };
  return {
    add(t) { trauma = clamp(trauma + t, 0, 1); },
    update(dt) { trauma = Math.max(0, trauma - decay * dt); },
    offset() {
      const s = trauma * trauma;
      out.x = maxOffset * s * (rnd() * 2 - 1);
      out.y = maxOffset * s * (rnd() * 2 - 1);
      out.angle = maxAngle * s * (rnd() * 2 - 1);
      return out;
    },
    // Rotates around (cx, cy), normally the screen centre, so it shakes instead of swinging.
    apply(ctx, cx = 0, cy = 0) {
      if (trauma <= 0) return;
      const o = this.offset();
      ctx.translate(o.x + cx, o.y + cy);
      ctx.rotate(o.angle);
      ctx.translate(-cx, -cy);
    },
    get trauma() { return trauma; },
  };
}

// ---------------------------------------------------------------- particles
const SHAPES = { circle: 0, square: 1, star: 2 };
const TAU = Math.PI * 2;

export function createParticles({ max = 500, rnd = Math.random } = {}) {
  const x = new Float32Array(max), y = new Float32Array(max);
  const vx = new Float32Array(max), vy = new Float32Array(max);
  const life = new Float32Array(max), maxLife = new Float32Array(max);
  const size = new Float32Array(max), rot = new Float32Array(max), vrot = new Float32Array(max);
  const grav = new Float32Array(max), drag = new Float32Array(max);
  const shrinkA = new Uint8Array(max), shape = new Uint8Array(max), color = new Uint16Array(max);
  const palette = [];
  const paletteIdx = new Map();
  let alive = 0;
  let cursor = 0;
  let quality = 1;

  const pick = (r) => (Array.isArray(r) ? r[0] + (r[1] - r[0]) * rnd() : r);
  const colorId = (c) => {
    let id = paletteIdx.get(c);
    if (id === undefined) {
      if (palette.length >= 1024) return 0;
      id = palette.push(c) - 1;
      paletteIdx.set(c, id);
    }
    return id;
  };

  function slot() {
    for (let k = 0; k < max; k++) { // prefer a free slot, else overwrite at the cursor
      const i = (cursor + k) % max;
      if (life[i] <= 0) { cursor = (i + 1) % max; alive++; return i; }
    }
    const i = cursor;
    cursor = (cursor + 1) % max;
    return i;
  }

  function burst(px, py, o = {}) {
    const {
      count = 16, colors = ['#fff'], speed = [120, 320], angle = 0, spread = TAU, gravity = 600,
      drag: dr = 1.5, life: lf = [0.4, 0.9], size: sz = [3, 7], shrink = true, shape: sh = 'circle',
    } = o;
    let n = Math.round(count * quality);
    if (n < 1 && count > 0 && quality > 0) n = 1;
    const cols = Array.isArray(colors) ? colors : [colors];
    const shapeId = SHAPES[sh] ?? 0;
    for (let k = 0; k < n && max > 0; k++) {
      const i = slot();
      const a = angle + (rnd() - 0.5) * spread;
      const s = pick(speed);
      x[i] = px; y[i] = py;
      vx[i] = Math.cos(a) * s; vy[i] = Math.sin(a) * s;
      const l = Math.max(0.01, pick(lf));
      life[i] = l; maxLife[i] = l;
      size[i] = pick(sz);
      rot[i] = rnd() * TAU; vrot[i] = (rnd() - 0.5) * 10;
      grav[i] = gravity; drag[i] = dr;
      shrinkA[i] = shrink ? 1 : 0; shape[i] = shapeId;
      color[i] = colorId(cols[Math.floor(rnd() * cols.length) % cols.length]);
    }
  }

  function update(dt) {
    if (alive === 0) return;
    for (let i = 0; i < max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) { life[i] = 0; alive--; continue; }
      const damp = Math.exp(-drag[i] * dt);
      vx[i] *= damp;
      vy[i] = vy[i] * damp + grav[i] * dt;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      rot[i] += vrot[i] * dt;
    }
  }

  function draw(ctx) {
    if (alive === 0) return;
    let fill = null;
    for (let i = 0; i < max; i++) {
      if (life[i] <= 0) continue;
      const t = life[i] / maxLife[i];
      const s = shrinkA[i] ? size[i] * t : size[i];
      if (s <= 0.05) continue;
      ctx.globalAlpha = t < 0.3 ? t / 0.3 : 1;
      if (color[i] !== fill) { fill = color[i]; ctx.fillStyle = palette[fill]; }
      if (shape[i] === 1) {
        ctx.fillRect(x[i] - s, y[i] - s, s * 2, s * 2);
      } else if (shape[i] === 2) {
        ctx.beginPath();
        for (let p = 0; p < 10; p++) {
          const r = p % 2 === 0 ? s * 1.4 : s * 0.6;
          const a = rot[i] + (p * Math.PI) / 5;
          const px = x[i] + Math.cos(a) * r, py = y[i] + Math.sin(a) * r;
          if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x[i], y[i], s, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  return {
    burst, update, draw,
    get count() { return alive; },
    setQuality(q) { quality = clamp(Number(q) || 0, 0, 1); },
    get quality() { return quality; },
    clear() { life.fill(0); alive = 0; cursor = 0; },
  };
}

// ---------------------------------------------------------------- floating text
export function createFloaters({ max = 64, font = 'sans-serif' } = {}) {
  let items = [];
  return {
    add(x, y, text, { color = '#fff', size = 28, life = 0.9, rise = 60 } = {}) {
      items.push({ x, y, text: String(text), color, size, life: Math.max(0.01, life), rise, age: 0 });
      if (items.length > max) items.shift();
    },
    update(dt) {
      let w = 0;
      for (const f of items) {
        f.age += dt;
        if (f.age < f.life) items[w++] = f;
      }
      items.length = w;
    },
    draw(ctx) {
      if (!items.length) return;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      for (const f of items) {
        const t = f.age / f.life;
        ctx.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        ctx.font = `bold ${f.size}px ${font}`;
        ctx.lineWidth = Math.max(2, f.size / 6);
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        const yy = f.y - f.rise * ease.outCubic(t);
        ctx.strokeText(f.text, f.x, yy);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, yy);
      }
      ctx.restore();
    },
    get count() { return items.length; },
  };
}

// ---------------------------------------------------------------- spring (squash & stretch)
export function createSpring({ stiffness = 300, damping = 18, value = 1 } = {}) {
  const s = {
    value, target: value, velocity: 0,
    update(dt) {
      const n = Math.max(1, Math.ceil(Math.min(dt, 0.1) / (1 / 120))); // substeps keep it stable
      const h = Math.min(dt, 0.1) / n;
      for (let i = 0; i < n; i++) {
        const a = stiffness * (s.target - s.value) - damping * s.velocity;
        s.velocity += a * h;
        s.value += s.velocity * h;
      }
      if (Math.abs(s.target - s.value) < 1e-4 && Math.abs(s.velocity) < 1e-3) { // settle exactly
        s.value = s.target;
        s.velocity = 0;
      }
    },
    kick(v) { s.velocity += v; },
  };
  return s;
}

// ---------------------------------------------------------------- full-screen flash
export function createFlash() {
  let color = '#fff', dur = 0.15, t = 0;
  return {
    trigger(c = '#fff', d = 0.15) { color = c; dur = Math.max(0.001, d); t = dur; },
    update(dt) { t = Math.max(0, t - dt); },
    // x/y: top-left of the area (use view.bounds when the view has extra space)
    draw(ctx, w, h, x = 0, y = 0) {
      if (t <= 0) return;
      ctx.save();
      ctx.globalAlpha = 0.8 * (t / dur);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    },
    get active() { return t > 0; },
  };
}
