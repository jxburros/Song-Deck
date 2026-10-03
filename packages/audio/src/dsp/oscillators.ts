/**
 * Band-limited oscillators: polyBLEP saw/square/pulse (inline helpers), triangle via leaky
 * integration of the BLEP square, and mip-mapped wavetables (organ, glottal source, etc.).
 */
import { SINE_TABLE, SINE_SIZE } from './utils';

/** PolyBLEP residual for a discontinuity at phase 0 (t, dt in cycles). */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Band-limited sawtooth in [-1, 1] at phase t ∈ [0,1) with increment dt. */
export function blSaw(t: number, dt: number): number {
  return 2 * t - 1 - polyBlep(t, dt);
}

/** Band-limited pulse with width pw ∈ (0,1). */
export function blPulse(t: number, dt: number, pw: number): number {
  let v = t < pw ? 1 : -1;
  v += polyBlep(t, dt);
  let t2 = t - pw;
  if (t2 < 0) t2 += 1;
  v -= polyBlep(t2, dt);
  return v;
}

export const WT_SIZE = 4096;
export const WT_MASK = WT_SIZE - 1;

/**
 * Mip-mapped single-cycle wavetable. Level k keeps harmonics h ≤ maxHarm[k]; pick the level whose
 * highest harmonic stays below ~0.45·sampleRate for the played fundamental.
 */
export class Wavetable {
  readonly levels: Float64Array[] = [];
  readonly maxHarm: number[] = [];

  /** amps[h-1], phases[h-1] (cycles) for harmonics 1..H. */
  constructor(amps: ArrayLike<number>, phases?: ArrayLike<number>, normalize: 'peak' | 'none' = 'peak') {
    const H = Math.min(amps.length, WT_SIZE / 2 - 1);
    let hmax = 1;
    while (hmax < H) hmax *= 2;
    const caps: number[] = [];
    for (let c = hmax; c >= 1; c = Math.floor(c / 2)) caps.push(Math.min(c, H));
    let norm = 0;
    for (const cap of caps) {
      const t = new Float64Array(WT_SIZE + 1);
      for (let h = 1; h <= cap; h++) {
        const a = amps[h - 1];
        if (!a) continue;
        const ph = phases ? phases[h - 1] : 0;
        const off = Math.round(ph * SINE_SIZE) & (SINE_SIZE - 1);
        // sin(2π(h·n/N + ph)) using exact table indices (WT_SIZE === SINE_SIZE)
        for (let n = 0; n < WT_SIZE; n++) t[n] += a * SINE_TABLE[(h * n + off) & (SINE_SIZE - 1)];
      }
      if (normalize === 'peak') {
        if (norm === 0) {
          let pk = 0;
          for (let n = 0; n < WT_SIZE; n++) pk = Math.max(pk, Math.abs(t[n]));
          norm = pk > 0 ? 1 / pk : 1;
        }
        for (let n = 0; n < WT_SIZE; n++) t[n] *= norm;
      }
      t[WT_SIZE] = t[0];
      this.levels.push(t);
      this.maxHarm.push(cap);
    }
  }

  /** Index of the mip level to use for fundamental `freq`. */
  levelFor(freq: number, sampleRate: number): number {
    const limit = (0.45 * sampleRate) / Math.max(1, freq);
    for (let i = 0; i < this.maxHarm.length; i++) if (this.maxHarm[i] <= limit) return i;
    return this.maxHarm.length - 1;
  }
}

/** Read a wavetable level with linear interpolation; phase in cycles [0,1). */
export function wtRead(t: Float64Array, phase: number): number {
  const x = phase * WT_SIZE;
  const i = x | 0;
  const f = x - i;
  const a = t[i & WT_MASK];
  return a + f * (t[(i & WT_MASK) + 1] - a);
}
