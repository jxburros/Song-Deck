/**
 * Filters: RBJ biquads (transposed direct form II, stereo state), Simper/Cytomic TPT state-variable
 * filter, one-pole filters, DC blocker. Coefficients are only recomputed when a designer is called.
 */
import { clampNum } from './utils';

export type BiquadType =
  'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peak' | 'lowshelf' | 'highshelf' | 'allpass';

const DENORMAL = 1e-25;

export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  z1L = 0;
  z2L = 0;
  z1R = 0;
  z2R = 0;

  reset(): void {
    this.z1L = this.z2L = this.z1R = this.z2R = 0;
  }

  setIdentity(): this {
    this.b0 = 1;
    this.b1 = this.b2 = this.a1 = this.a2 = 0;
    return this;
  }

  /** RBJ cookbook designer. For shelves `q` is the shelf slope S (1 = steepest monotone). */
  design(type: BiquadType, freq: number, q: number, gainDb: number, sampleRate: number): this {
    const f = clampNum(freq, 1, sampleRate * 0.4999);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const Q = Math.max(1e-4, q);
    let alpha = sw / (2 * Q);
    const A = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cw) / 2;
        b1 = 1 - cw;
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2;
        b1 = -(1 + cw);
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1;
        b1 = -2 * cw;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'allpass':
        b0 = 1 - alpha;
        b1 = -2 * cw;
        b2 = 1 + alpha;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'peak':
        b0 = 1 + alpha * A;
        b1 = -2 * cw;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cw;
        a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const S = Math.min(Q, 1);
        alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
        const sa = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + sa);
        b1 = 2 * A * (A - 1 - (A + 1) * cw);
        b2 = A * (A + 1 - (A - 1) * cw - sa);
        a0 = A + 1 + (A - 1) * cw + sa;
        a1 = -2 * (A - 1 + (A + 1) * cw);
        a2 = A + 1 + (A - 1) * cw - sa;
        break;
      }
      case 'highshelf': {
        const S = Math.min(Q, 1);
        alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
        const sa = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + sa);
        b1 = -2 * A * (A - 1 + (A + 1) * cw);
        b2 = A * (A + 1 + (A - 1) * cw - sa);
        a0 = A + 1 - (A - 1) * cw + sa;
        a1 = 2 * (A - 1 - (A + 1) * cw);
        a2 = A + 1 - (A - 1) * cw - sa;
        break;
      }
      default:
        return this.setIdentity();
    }
    const inv = 1 / a0;
    this.b0 = b0 * inv;
    this.b1 = b1 * inv;
    this.b2 = b2 * inv;
    this.a1 = a1 * inv;
    this.a2 = a2 * inv;
    return this;
  }

  /** Set raw (normalized, a0 = 1) coefficients. */
  setCoefs(b0: number, b1: number, b2: number, a1: number, a2: number): this {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
    return this;
  }

  copyCoefs(o: Biquad): this {
    this.b0 = o.b0;
    this.b1 = o.b1;
    this.b2 = o.b2;
    this.a1 = o.a1;
    this.a2 = o.a2;
    return this;
  }

  /** Flush denormal-range states (call at block end when using tick/tickR). */
  flush(): void {
    if (Math.abs(this.z1L) < DENORMAL) this.z1L = 0;
    if (Math.abs(this.z2L) < DENORMAL) this.z2L = 0;
    if (Math.abs(this.z1R) < DENORMAL) this.z1R = 0;
    if (Math.abs(this.z2R) < DENORMAL) this.z2R = 0;
  }

  /** Single sample, left state. */
  tick(x: number): number {
    const y = this.b0 * x + this.z1L;
    this.z1L = this.b1 * x - this.a1 * y + this.z2L;
    this.z2L = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Single sample, right state. */
  tickR(x: number): number {
    const y = this.b0 * x + this.z1R;
    this.z1R = this.b1 * x - this.a1 * y + this.z2R;
    this.z2R = this.b2 * x - this.a2 * y;
    return y;
  }

  processMono(buf: Float64Array | Float32Array, start: number, end: number): void {
    const b0 = this.b0,
      b1 = this.b1,
      b2 = this.b2,
      a1 = this.a1,
      a2 = this.a2;
    let z1 = this.z1L,
      z2 = this.z2L;
    for (let i = start; i < end; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    if (Math.abs(z1) < DENORMAL) z1 = 0;
    if (Math.abs(z2) < DENORMAL) z2 = 0;
    this.z1L = z1;
    this.z2L = z2;
  }

  processStereo(
    L: Float64Array | Float32Array,
    R: Float64Array | Float32Array,
    start: number,
    end: number,
  ): void {
    const b0 = this.b0,
      b1 = this.b1,
      b2 = this.b2,
      a1 = this.a1,
      a2 = this.a2;
    let z1 = this.z1L,
      z2 = this.z2L,
      w1 = this.z1R,
      w2 = this.z2R;
    for (let i = start; i < end; i++) {
      const x = L[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      L[i] = y;
      const u = R[i];
      const v = b0 * u + w1;
      w1 = b1 * u - a1 * v + w2;
      w2 = b2 * u - a2 * v;
      R[i] = v;
    }
    if (Math.abs(z1) < DENORMAL) z1 = 0;
    if (Math.abs(z2) < DENORMAL) z2 = 0;
    if (Math.abs(w1) < DENORMAL) w1 = 0;
    if (Math.abs(w2) < DENORMAL) w2 = 0;
    this.z1L = z1;
    this.z2L = z2;
    this.z1R = w1;
    this.z2R = w2;
  }

  /** Magnitude response at `freq` (for tests/analysis). */
  magnitude(freq: number, sampleRate: number): number {
    const w = (2 * Math.PI * freq) / sampleRate;
    const c1 = Math.cos(w),
      s1 = Math.sin(w),
      c2 = Math.cos(2 * w),
      s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2;
    const ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2;
    const di = -(this.a1 * s1 + this.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

/**
 * Topology-preserving-transform state variable filter (Andrew Simper). Stable under fast modulation.
 * Use `set()` at control rate and the inline `lp/bp/hp` per sample.
 */
export class Svf {
  ic1 = 0;
  ic2 = 0;
  a1 = 1;
  a2 = 0;
  a3 = 0;
  k = 1.4142135623730951;

  set(freq: number, q: number, sampleRate: number): void {
    const f = clampNum(freq, 5, sampleRate * 0.49);
    const g = Math.tan((Math.PI * f) / sampleRate);
    const k = 1 / Math.max(0.05, q);
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  reset(): void {
    this.ic1 = this.ic2 = 0;
  }

  lp(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }

  bp(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v1;
  }

  hp(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return x - this.k * v1 - v2;
  }

  flush(): void {
    if (Math.abs(this.ic1) < DENORMAL) this.ic1 = 0;
    if (Math.abs(this.ic2) < DENORMAL) this.ic2 = 0;
  }
}

/** One-pole lowpass/highpass pair (6 dB/oct). */
export class OnePole {
  a = 1;
  zL = 0;
  zR = 0;
  set(freq: number, sampleRate: number): void {
    const f = clampNum(freq, 0.1, sampleRate * 0.49);
    this.a = 1 - Math.exp((-2 * Math.PI * f) / sampleRate);
  }
  reset(v = 0): void {
    this.zL = this.zR = v;
  }
  lp(x: number): number {
    this.zL += this.a * (x - this.zL);
    return this.zL;
  }
  lpR(x: number): number {
    this.zR += this.a * (x - this.zR);
    return this.zR;
  }
  hp(x: number): number {
    this.zL += this.a * (x - this.zL);
    return x - this.zL;
  }
  hpR(x: number): number {
    this.zR += this.a * (x - this.zR);
    return x - this.zR;
  }
  flush(): void {
    if (Math.abs(this.zL) < DENORMAL) this.zL = 0;
    if (Math.abs(this.zR) < DENORMAL) this.zR = 0;
  }
}

/** First-order DC blocker y = x - x1 + R·y1. */
export class DcBlocker {
  r = 0.995;
  x1L = 0;
  y1L = 0;
  x1R = 0;
  y1R = 0;
  set(cutoff: number, sampleRate: number): void {
    this.r = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  }
  reset(): void {
    this.x1L = this.y1L = this.x1R = this.y1R = 0;
  }
  tick(x: number): number {
    const y = x - this.x1L + this.r * this.y1L;
    this.x1L = x;
    this.y1L = y;
    return y;
  }
  tickR(x: number): number {
    const y = x - this.x1R + this.r * this.y1R;
    this.x1R = x;
    this.y1R = y;
    return y;
  }
  processMono(buf: Float64Array, start: number, end: number): void {
    let x1 = this.x1L,
      y1 = this.y1L;
    const r = this.r;
    for (let i = start; i < end; i++) {
      const x = buf[i];
      const y = x - x1 + r * y1;
      x1 = x;
      y1 = y;
      buf[i] = y;
    }
    if (Math.abs(y1) < DENORMAL) y1 = 0;
    this.x1L = x1;
    this.y1L = y1;
  }
}

/** Phase delay (samples) of the one-zero filter (1-s) + s·z^-1 at angular frequency w. */
export function oneZeroPhaseDelay(s: number, w: number): number {
  const ph = Math.atan2(s * Math.sin(w), 1 - s + s * Math.cos(w));
  return ph / w;
}

/** Phase delay (samples) of the one-pole lowpass a / (1 - (1-a) z^-1) at angular frequency w. */
export function onePolePhaseDelay(a: number, w: number): number {
  const p = 1 - a;
  const ph = Math.atan2(p * Math.sin(w), 1 - p * Math.cos(w));
  return ph / w;
}
