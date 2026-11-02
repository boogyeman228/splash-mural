// Fixed-timestep game loop (accumulator pattern).
// update(dt) always gets exactly `step`; render(alpha, frameDt) runs once per frame.

const EPS = 1e-9; // absorbs float drift so 60/120/144/165 Hz give the same step count

export function createLoop({ step = 1 / 60, maxFrame = 0.25, update, render, raf, caf, now } = {}) {
  const reasons = new Set();
  let acc = 0;
  let last = null; // previous frame timestamp (ms); null until the baseline is set
  let running = false;
  let handle = null;
  let timeScale = 1;
  let hitstopLeft = 0;
  let steps = 0;
  let frames = 0;
  let fps = 0;
  let fpsTime = 0;
  let fpsFrames = 0;

  const getRaf = () => raf || (globalThis.requestAnimationFrame ? (f) => globalThis.requestAnimationFrame(f) : null);
  const getCaf = () => caf || (globalThis.cancelAnimationFrame ? (h) => globalThis.cancelAnimationFrame(h) : null);
  const getNow = () => (now ? now() : globalThis.performance ? globalThis.performance.now() : Date.now());

  function tick(tsMs) {
    if (last === null) { // first tick only sets the baseline
      last = tsMs;
      return;
    }
    let dt = (tsMs - last) / 1000;
    last = tsMs;
    if (!(dt > 0)) dt = 0;
    if (dt > maxFrame) dt = maxFrame;
    frames++;

    // fps over ~0.5 s windows of real time
    fpsTime += dt;
    fpsFrames++;
    if (fpsTime >= 0.5) {
      fps = fpsFrames / fpsTime;
      fpsTime = 0;
      fpsFrames = 0;
    }

    let simDt = dt;
    if (hitstopLeft > 0) { // hitstop eats real time
      if (hitstopLeft >= simDt) {
        hitstopLeft -= simDt;
        simDt = 0;
      } else {
        simDt -= hitstopLeft;
        hitstopLeft = 0;
      }
    }

    if (reasons.size > 0) {
      acc = 0; // paused: no catch-up burst on resume
    } else {
      acc += simDt * timeScale;
      while (acc >= step - EPS) {
        acc -= step;
        steps++;
        if (update) update(step);
        if (reasons.size > 0) { acc = 0; break; } // update() paused the loop
      }
      if (acc < 0) acc = 0;
    }
    if (render) render(Math.min(acc / step, 1), dt);
  }

  function frame(ts) {
    if (!running) return;
    const r = getRaf();
    if (r) handle = r(frame); // schedule first so a throw in update does not kill the loop
    tick(typeof ts === 'number' ? ts : getNow());
  }

  const loop = {
    start() {
      if (running) return;
      const r = getRaf();
      if (!r) return;
      running = true;
      last = null;
      acc = 0;
      handle = r(frame);
    },
    stop() {
      running = false;
      const c = getCaf();
      if (c && handle !== null) {
        try { c(handle); } catch (e) { /* ignore */ }
      }
      handle = null;
    },
    pause(reason = 'default') { reasons.add(reason); },
    resume(reason = 'default') { reasons.delete(reason); },
    get paused() { return reasons.size > 0; },
    get running() { return running; },
    setTimeScale(s) { timeScale = Math.max(0, Number(s) || 0); },
    hitstop(seconds) { if (seconds > hitstopLeft) hitstopLeft = seconds; },
    tick,
    stats() { return { fps, steps, frames }; },
  };
  return loop;
}
