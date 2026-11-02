// Responsive HiDPI canvas. Design area (width x height) is centred and scaled to fit;
// the extra space on the long side stays visible, view.bounds is the visible world rect.

export function createView(canvas, { width = 720, height = 1280, maxDpr = 2, win, ctxOptions } = {}) {
  const w = win || globalThis.window || globalThis;
  const ctx = canvas.getContext('2d', ctxOptions);
  const listeners = new Set();
  const bound = [];
  let timer = null;

  const view = {
    canvas, ctx, width, height,
    scale: 1, dpr: 1, cssW: width, cssH: height,
    bounds: { x: 0, y: 0, w: width, h: height },
    resize, begin, toWorld, onResize, destroy,
  };

  function cssSize() {
    let cw = 0, ch = 0;
    try {
      const r = canvas.getBoundingClientRect && canvas.getBoundingClientRect();
      if (r) { cw = r.width; ch = r.height; }
    } catch (e) { /* ignore */ }
    if (!(cw > 0) || !(ch > 0)) { cw = canvas.clientWidth; ch = canvas.clientHeight; }
    if (!(cw > 0) || !(ch > 0)) { cw = w.innerWidth; ch = w.innerHeight; }
    if (!(cw > 0) || !(ch > 0)) { cw = width; ch = height; }
    return [cw, ch];
  }

  function resize() {
    const [cw, ch] = cssSize();
    const dpr = Math.max(1, Math.min(Number(w.devicePixelRatio) || 1, maxDpr));
    const pw = Math.max(1, Math.round(cw * dpr));
    const ph = Math.max(1, Math.round(ch * dpr));
    // assigning width/height clears the canvas, so only touch them on a real change
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const scale = Math.min(cw / width, ch / height);
    const bw = cw / scale, bh = ch / scale;
    view.cssW = cw; view.cssH = ch; view.dpr = dpr; view.scale = scale;
    const b = view.bounds;
    b.w = bw; b.h = bh; b.x = (width - bw) / 2; b.y = (height - bh) / 2;
    for (const cb of [...listeners]) cb(view);
  }

  function begin() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = view.dpr * view.scale;
    ctx.setTransform(k, 0, 0, k, -view.bounds.x * k, -view.bounds.y * k);
  }

  function toWorld(clientX, clientY) {
    let left = 0, top = 0;
    try {
      const r = canvas.getBoundingClientRect && canvas.getBoundingClientRect();
      if (r) { left = r.left || 0; top = r.top || 0; }
    } catch (e) { /* ignore */ }
    return {
      x: (clientX - left) / view.scale + view.bounds.x,
      y: (clientY - top) / view.scale + view.bounds.y,
    };
  }

  function onResize(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function onOrientation() {
    resize();
    // browsers often report the old size right after orientationchange: measure again shortly
    try {
      if (w.setTimeout) {
        if (timer !== null && w.clearTimeout) w.clearTimeout(timer);
        timer = w.setTimeout(() => { timer = null; resize(); }, 150);
      }
    } catch (e) { /* ignore */ }
  }

  function destroy() {
    for (const [type, fn] of bound) {
      try { w.removeEventListener(type, fn); } catch (e) { /* ignore */ }
    }
    bound.length = 0;
    listeners.clear();
    if (timer !== null && w.clearTimeout) w.clearTimeout(timer);
    timer = null;
  }

  for (const [type, fn] of [['resize', resize], ['orientationchange', onOrientation]]) {
    if (w.addEventListener) {
      w.addEventListener(type, fn);
      bound.push([type, fn]);
    }
  }
  resize();
  return view;
}
