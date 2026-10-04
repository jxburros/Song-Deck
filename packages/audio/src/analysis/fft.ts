/**
 * Radix-2 FFT with reusable plans (bit-reversal + twiddle tables) and a real-input transform
 * built on a half-size complex FFT. Pure TypeScript, Float64 internally.
 */
import { isPow2, nextPow2 } from './util';

export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cosT: Float64Array;
  private readonly sinT: Float64Array;
  private halfPlan: FFT | null = null;
  private zr: Float64Array | null = null;
  private zi: Float64Array | null = null;

  constructor(size: number) {
    if (!isPow2(size) || size < 1) throw new Error(`FFT size must be a power of two (got ${size})`);
    this.size = size;
    const bits = Math.round(Math.log2(size));
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      let v = i;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (v & 1);
        v >>= 1;
      }
      this.rev[i] = r;
    }
    const half = Math.max(1, size >> 1);
    this.cosT = new Float64Array(half);
    this.sinT = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      this.cosT[k] = Math.cos((2 * Math.PI * k) / size);
      this.sinT[k] = Math.sin((2 * Math.PI * k) / size);
    }
  }

  /** In-place forward complex FFT (X[k] = Σ x[n] e^{-2πikn/N}). */
  forward(re: Float64Array | Float32Array, im: Float64Array | Float32Array): void {
    this.transform(re, im, -1);
  }

  /** In-place inverse complex FFT, scaled by 1/N. */
  inverse(re: Float64Array | Float32Array, im: Float64Array | Float32Array): void {
    this.transform(re, im, 1);
    const n = this.size;
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  private transform(re: Float64Array | Float32Array, im: Float64Array | Float32Array, sign: number): void {
    const n = this.size;
    if (n <= 1) return;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    // length-2 butterflies
    for (let i = 0; i < n; i += 2) {
      const ar = re[i];
      const ai = im[i];
      const br = re[i + 1];
      const bi = im[i + 1];
      re[i] = ar + br;
      im[i] = ai + bi;
      re[i + 1] = ar - br;
      im[i + 1] = ai - bi;
    }
    const cosT = this.cosT;
    const sinT = this.sinT;
    for (let size = 4; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let j0 = 0, k = 0; j0 < half; j0++, k += step) {
        const wr = cosT[k];
        const wi = sign * sinT[k];
        for (let j = j0; j < n; j += size) {
          const l = j + half;
          const xr = re[l];
          const xi = im[l];
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          const ur = re[j];
          const ui = im[j];
          re[l] = ur - tr;
          im[l] = ui - ti;
          re[j] = ur + tr;
          im[j] = ui + ti;
        }
      }
    }
  }

  private ensureHalf(): FFT {
    if (!this.halfPlan) {
      const m = this.size >> 1;
      this.halfPlan = getFFT(Math.max(1, m));
      this.zr = new Float64Array(Math.max(1, m));
      this.zi = new Float64Array(Math.max(1, m));
    }
    return this.halfPlan;
  }

  /**
   * Real-input forward FFT. `input` (length ≤ size, zero-padded) → bins 0..size/2 written to
   * outRe/outIm (length ≥ size/2 + 1). Optional `window` multiplies the input.
   */
  realForward(
    input: ArrayLike<number>,
    outRe: Float64Array | Float32Array,
    outIm: Float64Array | Float32Array,
    window?: ArrayLike<number>,
    inputOffset = 0,
    inputLength = input.length - inputOffset,
  ): void {
    const n = this.size;
    if (n < 4) {
      // tiny sizes: direct DFT
      for (let k = 0; k <= n >> 1; k++) {
        let sr = 0;
        let si = 0;
        for (let t = 0; t < n; t++) {
          const v = t < inputLength ? input[inputOffset + t] * (window ? window[t] : 1) : 0;
          sr += v * Math.cos((2 * Math.PI * k * t) / n);
          si -= v * Math.sin((2 * Math.PI * k * t) / n);
        }
        outRe[k] = sr;
        outIm[k] = si;
      }
      return;
    }
    const half = this.ensureHalf();
    const m = n >> 1;
    const zr = this.zr!;
    const zi = this.zi!;
    const len = Math.min(inputLength, n);
    if (window) {
      for (let k = 0; k < m; k++) {
        const a = 2 * k;
        const b = a + 1;
        zr[k] = a < len ? input[inputOffset + a] * window[a] : 0;
        zi[k] = b < len ? input[inputOffset + b] * window[b] : 0;
      }
    } else {
      for (let k = 0; k < m; k++) {
        const a = 2 * k;
        const b = a + 1;
        zr[k] = a < len ? input[inputOffset + a] : 0;
        zi[k] = b < len ? input[inputOffset + b] : 0;
      }
    }
    half.transform(zr, zi, -1);
    const cosT = this.cosT;
    const sinT = this.sinT;
    outRe[0] = zr[0] + zi[0];
    outIm[0] = 0;
    outRe[m] = zr[0] - zi[0];
    outIm[m] = 0;
    for (let k = 1; k < m; k++) {
      const a = zr[k];
      const b = zi[k];
      const c = zr[m - k];
      const d = zi[m - k];
      const feR = 0.5 * (a + c);
      const feI = 0.5 * (b - d);
      const foR = 0.5 * (b + d);
      const foI = -0.5 * (a - c);
      const wr = cosT[k];
      const ws = sinT[k];
      outRe[k] = feR + foR * wr + foI * ws;
      outIm[k] = feI + foI * wr - foR * ws;
    }
  }

  /** Inverse of `realForward`: bins 0..size/2 → real signal of length `size` (scaled 1/N). */
  realInverse(re: ArrayLike<number>, im: ArrayLike<number>, out: Float64Array | Float32Array): void {
    const n = this.size;
    if (n < 4) {
      for (let t = 0; t < n; t++) {
        let s = 0;
        for (let k = 0; k < n; k++) {
          const kk = k <= n >> 1 ? k : n - k;
          const r = re[kk];
          const i = k <= n >> 1 ? im[kk] : -im[kk];
          s += r * Math.cos((2 * Math.PI * k * t) / n) - i * Math.sin((2 * Math.PI * k * t) / n);
        }
        out[t] = s / n;
      }
      return;
    }
    const half = this.ensureHalf();
    const m = n >> 1;
    const zr = this.zr!;
    const zi = this.zi!;
    const cosT = this.cosT;
    const sinT = this.sinT;
    for (let k = 0; k < m; k++) {
      const xr = re[k];
      const xi = im[k];
      const yr = re[m - k];
      const yi = -im[m - k];
      const feR = 0.5 * (xr + yr);
      const feI = 0.5 * (xi + yi);
      const dR = 0.5 * (xr - yr);
      const dI = 0.5 * (xi - yi);
      const wr = cosT[k];
      const ws = sinT[k];
      const foR = dR * wr - dI * ws;
      const foI = dR * ws + dI * wr;
      zr[k] = feR - foI;
      zi[k] = feI + foR;
    }
    half.transform(zr, zi, 1);
    const s = 1 / m;
    for (let k = 0; k < m; k++) {
      out[2 * k] = zr[k] * s;
      out[2 * k + 1] = zi[k] * s;
    }
  }
}

const plans = new Map<number, FFT>();

/** Cached FFT plan for a power-of-two size. */
export function getFFT(size: number): FFT {
  let p = plans.get(size);
  if (!p) {
    p = new FFT(size);
    plans.set(size, p);
  }
  return p;
}

/**
 * Real FFT of `input`, zero-padded to `size` (default: next power of two). Returns the
 * non-redundant half spectrum (size/2 + 1 bins).
 */
export function fftReal(
  input: ArrayLike<number>,
  size = nextPow2(Math.max(2, input.length)),
): { re: Float64Array; im: Float64Array } {
  if (!isPow2(size)) throw new Error(`fftReal size must be a power of two (got ${size})`);
  const plan = getFFT(size);
  const re = new Float64Array((size >> 1) + 1);
  const im = new Float64Array((size >> 1) + 1);
  plan.realForward(input, re, im);
  return { re, im };
}

/** Inverse of `fftReal` (half spectrum → real signal of length `size`). */
export function ifftReal(
  re: ArrayLike<number>,
  im: ArrayLike<number>,
  size = (re.length - 1) * 2,
): Float64Array {
  const plan = getFFT(size);
  const out = new Float64Array(size);
  plan.realInverse(re, im, out);
  return out;
}

/** In-place complex FFT convenience (arrays must be a power of two long). */
export function fftComplex(re: Float64Array, im: Float64Array, inverse = false): void {
  const plan = getFFT(re.length);
  if (inverse) plan.inverse(re, im);
  else plan.forward(re, im);
}
