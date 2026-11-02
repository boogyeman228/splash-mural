// logic.js - pure ball-sort rules: generation, moves, solver. No DOM.
// Tubes are arrays of colour ids, bottom first. `cap` is the tube height (4 normally, 5 for tall tubes).
import { mulberry32 } from './kit/rng.js';

export const CAP = 4;

export const isFullTube = (t, cap = CAP) => t.length === cap && t.every((c) => c === t[0]);

export function isSolved(tubes, cap = CAP) {
  return tubes.every((t) => t.length === 0 || isFullTube(t, cap));
}

export function canMove(tubes, a, b, cap = CAP) {
  if (a === b) return false;
  const A = tubes[a], B = tubes[b];
  if (!A || !B || !A.length || B.length >= cap) return false;
  return B.length === 0 || B[B.length - 1] === A[A.length - 1];
}

export function applyMove(tubes, a, b) {
  tubes[b].push(tubes[a].pop());
}

/** True when at least one legal move exists that is not a pointless shuffle of a sorted tube. */
export function hasUsefulMove(tubes, cap = CAP) {
  for (let a = 0; a < tubes.length; a++) {
    const A = tubes[a];
    if (!A.length || isFullTube(A, cap)) continue;
    for (let b = 0; b < tubes.length; b++) {
      if (!canMove(tubes, a, b, cap)) continue;
      if (tubes[b].length === 0 && A.every((c) => c === A[0])) continue;
      return true;
    }
  }
  return false;
}

/**
 * Build a level by scrambling a solved board with reverse moves, so it is always solvable.
 * colours: list of colour ids; empties: number of empty tubes; seed: uint32; cap: tube height.
 */
export function generate({ colours, empties, seed, cap = CAP }) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = mulberry32((seed + attempt * 7919) >>> 0);
    const tubes = colours.map((c) => Array(cap).fill(c));
    for (let i = 0; i < empties; i++) tubes.push([]);
    const steps = colours.length * cap * 6;
    for (let done = 0, tries = 0; done < steps && tries < steps * 60; tries++) {
      const a = Math.floor(r() * tubes.length), b = Math.floor(r() * tubes.length);
      const A = tubes[a], B = tubes[b];
      if (a === b || !A.length || B.length >= cap) continue;
      const x = A[A.length - 1];
      if (A.length > 1 && A[A.length - 2] !== x) continue; // the forward move must have been legal
      B.push(A.pop());
      done++;
    }
    // Shuffle tube order so empties are not always on the right.
    for (let i = tubes.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [tubes[i], tubes[j]] = [tubes[j], tubes[i]];
    }
    // No tube may start sorted: its paint would never pour into the mural.
    if (!isSolved(tubes, cap) && !tubes.some((t) => isFullTube(t, cap))) return tubes;
  }
  throw new Error('could not generate a level');
}

const key = (tubes) => tubes.map((t) => t.join(',')).sort().join('|');

/**
 * DFS solver. Returns { status: 'solved', path: [[a,b],...] } | { status: 'dead' } (no solution)
 * | { status: 'unknown' } (node budget hit).
 */
export function solve(start, budget = 30000, cap = CAP) {
  const tubes = start.map((t) => t.slice());
  const seen = new Set();
  let nodes = 0;
  const path = [];
  const dfs = () => {
    if (isSolved(tubes, cap)) return true;
    if (++nodes > budget) return null;
    const k = key(tubes);
    if (seen.has(k)) return false;
    seen.add(k);
    const moves = [];
    for (let a = 0; a < tubes.length; a++) {
      const A = tubes[a];
      if (!A.length || isFullTube(A, cap)) continue;
      for (let b = 0; b < tubes.length; b++) {
        if (!canMove(tubes, a, b, cap)) continue;
        if (tubes[b].length === 0 && A.every((c) => c === A[0])) continue; // pointless relocation
        moves.push([a, b, tubes[b].length ? 1 : 0]);
      }
    }
    moves.sort((m, n) => n[2] - m[2]);
    let unknown = false;
    for (const [a, b] of moves) {
      applyMove(tubes, a, b);
      path.push([a, b]);
      const res = dfs();
      if (res === true) return true;
      path.pop();
      tubes[a].push(tubes[b].pop());
      if (res === null) { unknown = true; break; }
    }
    return unknown ? null : false;
  };
  const res = dfs();
  if (res === true) return { status: 'solved', path };
  return { status: res === null ? 'unknown' : 'dead' };
}
