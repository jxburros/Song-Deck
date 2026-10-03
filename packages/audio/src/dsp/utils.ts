/**
 * Small shared DSP helpers (private to dsp/). Everything here is allocation-free and deterministic.
 */

export const TWO_PI = Math.PI * 2;
/** Floor used for every dB-valued report/meter (≈ 24-bit noise floor). Never -Infinity. */
export const MIN_DB = -144;
const MIN_GAIN = 6.31e-8; // 10^(-144/20)

/** Internal processing block (frames). Automation and parameter smoothing run per block. */
export const BLOCK = 64;

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  const a = Math.abs(g);
  return a > MIN_GAIN ? 20 * Math.log10(a) : MIN_DB;
}

export function powerToDb(p: number): number {
  return p > 4e-15 ? 10 * Math.log10(p) : MIN_DB;
}

export function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Finite number or fallback (guards user/IR provided parameters). */
export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function midiToHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** Smoothing coefficient for a one-pole lowpass with time constant `seconds` at `rate` updates/s. */
export function onePoleCoef(seconds: number, rate: number): number {
  if (seconds <= 0) return 0;
  return Math.exp(-1 / (seconds * rate));
}

/** Coefficient so that multiplying by it every sample decays by 60 dB in `seconds`. */
export function t60Coef(seconds: number, sampleRate: number): number {
  if (seconds <= 0) return 0;
  return Math.exp(-6.907755278982137 / (seconds * sampleRate));
}

// ---------------------------------------------------------------------------
// Deterministic noise (xorshift32). State is a non-zero int32.
// ---------------------------------------------------------------------------

/** Mix a seed into a non-zero xorshift state. */
export function seedState(seed: number): number {
  let h = (seed | 0) ^ 0x2545f491;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h === 0 ? 0x1234567 : h | 0;
}

export function xorshift(s: number): number {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s | 0;
}

/** Map an xorshift state to [-1, 1). */
export const NOISE_SCALE = 1 / 2147483648;

/** Tiny seeded RNG object for build-time (non hot-loop) randomness. */
export class SimpleRng {
  private s: number;
  constructor(seed: number) {
    this.s = seedState(seed);
  }
  /** [0, 1) */
  next(): number {
    this.s = xorshift(this.s);
    return (this.s >>> 0) / 4294967296;
  }
  /** [-1, 1) */
  bipolar(): number {
    this.s = xorshift(this.s);
    return this.s * NOISE_SCALE;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

/** FNV-1a string hash. */
export function hashString(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function combineSeed(a: number, b: number): number {
  let h = Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Sine table (linear interpolation; error < -120 dB)
// ---------------------------------------------------------------------------

export const SINE_SIZE = 4096;
export const SINE_MASK = SINE_SIZE - 1;
export const SINE_TABLE = (() => {
  const t = new Float64Array(SINE_SIZE + 1);
  for (let i = 0; i <= SINE_SIZE; i++) t[i] = Math.sin((TWO_PI * i) / SINE_SIZE);
  return t;
})();

/** sin(2π·phase) for any real phase (in cycles). */
export function sin01(phase: number): number {
  const x = (phase - Math.floor(phase)) * SINE_SIZE;
  const i = x | 0;
  const f = x - i;
  const a = SINE_TABLE[i];
  return a + f * (SINE_TABLE[i + 1] - a);
}

/** Cheap tanh-like soft clipper (Padé), monotone, |y| < 1. */
export function softClip(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** 4-point, 3rd-order Hermite interpolation. */
export function hermite(xm1: number, x0: number, x1: number, x2: number, t: number): number {
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

/** Velocity (1..127) → linear amplitude with a musical curve (≈40 dB range). */
export function velocityGain(velocity: number, sensitivity = 1): number {
  const v = clampNum(velocity / 127, 0, 1);
  const curved = Math.pow(v, 1.7);
  return 1 - sensitivity + sensitivity * curved;
}

export function isFiniteBlock(buf: Float64Array, start: number, end: number): boolean {
  let acc = 0;
  for (let i = start; i < end; i++) acc += buf[i];
  return Number.isFinite(acc);
}

export function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Zeroth-order modified Bessel function (Kaiser windows). */
export function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

export function kaiser(n: number, N: number, beta: number): number {
  // n in [-N/2, N/2]
  const r = (2 * n) / N;
  if (r <= -1 || r >= 1) return Math.abs(r) === 1 ? besselI0(0) / besselI0(beta) : 0;
  return besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta);
}

export function sinc(x: number): number {
  if (Math.abs(x) < 1e-12) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}
