/**
 * Seeded, reproducible randomness (spec §23 "Generation Seeds").
 *
 * Every generator derives its own stream from (seed, ...keys) via `deriveRng`, so
 * regenerating one track/section never shifts the random stream of another — a
 * prerequisite for "regenerate unlocked material" leaving everything else identical.
 */

/** 32-bit FNV-1a hash of a string. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combine a seed and any number of keys into a new 32-bit seed. */
export function hashSeed(seed: number, ...keys: (string | number)[]): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (const k of keys) {
    const kh = typeof k === 'number' ? fnv1a(`#${k}`) : fnv1a(k);
    h = Math.imul(h ^ kh, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
  }
  return h >>> 0;
}

export interface Rng {
  /** The seed this generator was created from. */
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniformly pick an element. Throws on empty arrays. */
  pick<T>(items: readonly T[]): T;
  /** Pick by weights (non-negative). Falls back to uniform if all weights are 0. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Standard normal sample (Box–Muller). */
  gaussian(mean?: number, stdDev?: number): number;
  /** Fisher–Yates shuffle (returns a new array). */
  shuffle<T>(items: readonly T[]): T[];
  /** Derive an independent child generator for a sub-task. */
  fork(...keys: (string | number)[]): Rng;
}

/** mulberry32 — small, fast, good-quality 32-bit PRNG. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    seed: seed >>> 0,
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('Rng.pick on empty array');
      return items[Math.floor(next() * items.length)];
    },
    weighted: (items, weights) => {
      if (items.length === 0) throw new Error('Rng.weighted on empty array');
      let total = 0;
      for (let i = 0; i < items.length; i++) total += Math.max(0, weights[i] ?? 0);
      if (total <= 0) return items[Math.floor(next() * items.length)];
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i] ?? 0);
        if (r < 0) return items[i];
      }
      return items[items.length - 1];
    },
    gaussian: (mean = 0, stdDev = 1) => {
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
    fork: (...keys) => createRng(hashSeed(seed, ...keys)),
  };
  return rng;
}

/** Create a generator for (seed, ...keys) — the standard way generators get randomness. */
export function deriveRng(seed: number, ...keys: (string | number)[]): Rng {
  return createRng(hashSeed(seed, ...keys));
}

/** A fresh random seed (for "new seed" UI actions; never used inside deterministic generation). */
export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % 1_000_000;
  }
  return Math.floor(Math.random() * 1_000_000);
}
