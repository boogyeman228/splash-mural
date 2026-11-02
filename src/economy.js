// economy.js - pure rules for drops (soft currency), tools, stars and ad offers. No DOM, no ads.
export const PRICES = { undo: 10, hint: 15, tube: 60 };
export const FREE_UNDO = 3;          // per level
export const FREE_HINT = 1;          // per level
export const HINT_AD_COOLDOWN_MS = 60_000;
export const JAR_DROPS = 5;          // a tube whose colour is not in the picture fills the jar
export const MURAL_DROPS = 50;       // bonus for finishing a mural (x2 with an ad)
export const SKIP_AFTER_RESTARTS = 2;
export const MIDGAME_FROM_LEVEL = 4; // natural-break ads only after this level

export const newLevelState = () => ({ moves: 0, freeUndo: FREE_UNDO, freeHint: FREE_HINT, extraTube: false, restarts: 0 });

export function stars(moves, par) {
  if (!par) return 3;
  if (moves <= par) return 3;
  if (moves <= Math.ceil(par * 1.4)) return 2;
  return 1;
}

export const levelDrops = (s) => 10 + 5 * s;

/**
 * What pressing a tool does: 'free' (included), 'drops' (pay PRICES[tool]), 'offer' (show the
 * panel: watch an ad or close) or 'used' (extra tube already used this level).
 */
export function toolAction(tool, level, drops) {
  if (tool === 'undo' && level.freeUndo > 0) return 'free';
  if (tool === 'hint' && level.freeHint > 0) return 'free';
  if (tool === 'tube' && level.extraTube) return 'used';
  return drops >= PRICES[tool] ? 'drops' : 'offer';
}

/** Spend for a tool. Mutates level and save; returns false when not allowed. */
export function payTool(tool, level, save) {
  const a = toolAction(tool, level, save.drops);
  if (a === 'free') { if (tool === 'undo') level.freeUndo--; else level.freeHint--; return true; }
  if (a === 'drops') { save.drops -= PRICES[tool]; if (tool === 'tube') level.extraTube = true; return true; }
  return false;
}

/** A hint ad can be offered at most once a minute (portal rule: no ad spam). */
export const hintAdReady = (lastAt, now) => !lastAt || now - lastAt >= HINT_AD_COOLDOWN_MS;

export const canSkip = (level) => level.restarts >= SKIP_AFTER_RESTARTS;
