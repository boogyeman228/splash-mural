// Pointer + keyboard input. Pointer callbacks get { x, y, id, button } (x/y through toWorld).
// onKey gets { key, code, down, repeat }. onUp may carry cancelled:true (pointercancel, block, blur).

const TAP_MS = 300;
const TAP_PX = 12;
const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export function createInput(el, opts = {}, win) {
  const w = win || globalThis.window || globalThis;
  const { toWorld = (x, y) => ({ x, y }), onDown, onMove, onUp, onTap, onKey, onFirstInput } = opts;
  const nowFn = opts.now || (() => (globalThis.performance ? globalThis.performance.now() : Date.now()));

  const reasons = new Set();
  const presses = new Map(); // pointerId -> { sx, sy, t, moved, button }
  const keys = new Set();
  const pointer = { x: 0, y: 0, down: false };
  const bound = []; // [target, type, fn] for destroy()
  let firstDone = false;
  let destroyed = false;

  try {
    if (el.style) {
      el.style.touchAction = 'none';
      el.style.userSelect = 'none';
      el.style.webkitUserSelect = 'none';
      el.style.webkitTapHighlightColor = 'transparent';
    }
  } catch (e) { /* ignore */ }

  const listen = (target, type, fn, o) => {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, fn, o);
    bound.push([target, type, fn, o]);
  };
  const stamp = (e) => (typeof e.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : nowFn());
  const blocked = () => reasons.size > 0 || destroyed;
  const world = (e) => toWorld(e.clientX, e.clientY);
  const info = (e, p) => ({ x: p.x, y: p.y, id: e.pointerId ?? 0, button: e.button ?? 0 });

  function first() {
    if (firstDone) return;
    firstDone = true;
    if (onFirstInput) {
      try { onFirstInput(); } catch (err) { /* a portal hiccup must not break input */ }
    }
  }

  function endPress(id, p, cancelled) {
    const press = presses.get(id);
    if (!press) return;
    presses.delete(id);
    pointer.down = presses.size > 0;
    const data = { x: p.x, y: p.y, id, button: press.button };
    if (cancelled) data.cancelled = true;
    if (onUp) onUp(data);
    if (!cancelled && onTap && p.t - press.t <= TAP_MS && !press.moved) onTap(data);
  }

  function cancelAll() {
    for (const [id] of [...presses]) endPress(id, { x: pointer.x, y: pointer.y, t: nowFn() }, true);
    for (const code of [...keys]) {
      keys.delete(code);
      if (onKey) onKey({ key: code, code, down: false, repeat: false });
    }
  }

  function down(e) {
    if (blocked()) return;
    if (e.preventDefault) e.preventDefault();
    const p = world(e);
    pointer.x = p.x; pointer.y = p.y;
    try { if (el.setPointerCapture && e.pointerId !== undefined) el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    presses.set(e.pointerId ?? 0, { sx: e.clientX, sy: e.clientY, t: stamp(e), moved: false, button: e.button ?? 0 });
    pointer.down = true;
    first();
    if (onDown) onDown(info(e, p));
  }

  function move(e) {
    if (blocked()) return;
    const p = world(e);
    pointer.x = p.x; pointer.y = p.y;
    const press = presses.get(e.pointerId ?? 0);
    if (press && !press.moved && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) >= TAP_PX) press.moved = true;
    if (onMove) onMove({ ...info(e, p), down: !!press });
  }

  function up(e) {
    if (blocked()) return;
    const id = e.pointerId ?? 0;
    const press = presses.get(id);
    if (!press) return;
    const p = world(e);
    pointer.x = p.x; pointer.y = p.y;
    if (Math.hypot(e.clientX - press.sx, e.clientY - press.sy) >= TAP_PX) press.moved = true;
    endPress(id, { x: p.x, y: p.y, t: stamp(e) }, false);
  }

  function cancel(e) {
    if (blocked()) return;
    const id = e.pointerId ?? 0;
    if (presses.has(id)) endPress(id, { x: pointer.x, y: pointer.y, t: nowFn() }, true);
  }

  function keyDown(e) {
    if (blocked()) return;
    const code = e.code || e.key;
    if (SCROLL_KEYS.has(code) && e.preventDefault) e.preventDefault();
    keys.add(code);
    first();
    if (onKey) onKey({ key: e.key, code, down: true, repeat: !!e.repeat });
  }

  function keyUp(e) {
    if (blocked()) return;
    const code = e.code || e.key;
    if (!keys.delete(code)) return;
    if (onKey) onKey({ key: e.key, code, down: false, repeat: false });
  }

  listen(el, 'pointerdown', down);
  listen(el, 'pointermove', move);
  listen(el, 'pointerup', up);
  listen(el, 'pointercancel', cancel);
  listen(el, 'contextmenu', (e) => { if (e.preventDefault) e.preventDefault(); });
  listen(w, 'keydown', keyDown);
  listen(w, 'keyup', keyUp);
  listen(w, 'blur', cancelAll);

  return {
    block(reason = 'default') {
      if (destroyed) return;
      const was = reasons.size > 0;
      reasons.add(reason);
      if (!was) cancelAll(); // abort presses and held keys in progress
    },
    unblock(reason = 'default') { reasons.delete(reason); },
    get blocked() { return reasons.size > 0; },
    pointer,
    isKeyDown: (code) => keys.has(code),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      presses.clear();
      keys.clear();
      pointer.down = false;
      for (const [t, type, fn, o] of bound) {
        try { t.removeEventListener(type, fn, o); } catch (e) { /* ignore */ }
      }
      bound.length = 0;
    },
  };
}
