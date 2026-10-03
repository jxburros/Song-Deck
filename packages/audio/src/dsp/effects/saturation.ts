/**
 * Saturation: channel "drive" (soft asymmetric saturator with level compensation and DC removal)
 * and a 2× oversampled waveshaper used by the guitar amp simulation.
 */
import { softClip } from '../utils';

/** Channel-strip drive 0..1 (0 = bypass). Gains ramp per block for click-free automation. */
export class Drive {
  private pre = 1;
  private post = 1;
  private bias = 0;
  private biasOut = 0;
  private dcxL = 0;
  private dcyL = 0;
  private dcxR = 0;
  private dcyR = 0;
  private readonly dcR: number;

  constructor(sampleRate: number) {
    this.dcR = Math.exp((-2 * Math.PI * 12) / sampleRate);
  }

  set(drive: number): void {
    const d = Math.max(0, Math.min(1, drive));
    this.pre = Math.pow(10, (d * 18) / 20);
    this.post = Math.pow(this.pre, -0.75);
    this.bias = 0.12 * d;
    this.biasOut = softClip(this.bias);
  }

  reset(): void {
    this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0;
  }

  process(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const pre = this.pre, post = this.post, bias = this.bias, bo = this.biasOut, r = this.dcR;
    let xl = this.dcxL, yl = this.dcyL, xr = this.dcxR, yr = this.dcyR;
    for (let i = start; i < end; i++) {
      const a = (softClip(L[i] * pre + bias) - bo) * post;
      const b = (softClip(R[i] * pre + bias) - bo) * post;
      const ya = a - xl + r * yl;
      xl = a;
      yl = ya;
      const yb = b - xr + r * yr;
      xr = b;
      yr = yb;
      L[i] = ya;
      R[i] = yb;
    }
    this.dcxL = xl;
    this.dcyL = Math.abs(yl) < 1e-25 ? 0 : yl;
    this.dcxR = xr;
    this.dcyR = Math.abs(yr) < 1e-25 ? 0 : yr;
  }
}

/** 31-tap halfband lowpass (Kaiser), odd-phase taps; even-phase is a pure 0.5 delay at the center. */
const HB_TAPS = (() => {
  const N = 31;
  const c = 15;
  const h = new Float64Array(N);
  const beta = 7;
  const i0 = (x: number) => {
    let s = 1, t = 1;
    for (let k = 1; k < 40; k++) {
      t *= (x * x) / (4 * k * k);
      s += t;
    }
    return s;
  };
  for (let n = 0; n < N; n++) {
    const m = n - c;
    const sincv = m === 0 ? 0.5 : Math.sin((Math.PI * m) / 2) / (Math.PI * m);
    const r = m / c;
    const w = i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
    h[n] = sincv * w;
  }
  // non-zero side taps are at odd offsets from the center → even indices
  const side = new Float64Array(16);
  for (let k = 0; k < 16; k++) side[k] = h[2 * k];
  // normalize so the side phase sums to 0.5
  let s = 0;
  for (let k = 0; k < 16; k++) s += side[k];
  for (let k = 0; k < 16; k++) side[k] *= 0.5 / s;
  return side;
})();

/**
 * Mono 2× oversampled waveshaper: y = shape(x) with a halfband up/down-sampler.
 * Latency ≈ 15.5 samples (same for every patch using it, so it is musically irrelevant).
 */
export class OversampledShaper {
  private readonly hist = new Float64Array(64); // input history for upsampling
  private hpos = 0;
  private readonly hist2 = new Float64Array(64); // oversampled history (odd phase for decimation)
  private h2pos = 0;
  private readonly center = new Float64Array(16); // delay line for the pure-delay phase
  private cpos = 0;

  constructor(private shape: (x: number) => number) {}

  setShape(fn: (x: number) => number): void {
    this.shape = fn;
  }

  reset(): void {
    this.hist.fill(0);
    this.hist2.fill(0);
    this.center.fill(0);
  }

  process(buf: Float64Array, start: number, end: number): void {
    const h = HB_TAPS;
    const hist = this.hist;
    const hist2 = this.hist2;
    const center = this.center;
    const shape = this.shape;
    let hp = this.hpos, h2 = this.h2pos, cp = this.cpos;
    for (let i = start; i < end; i++) {
      // upsample: write input, produce two oversampled values
      hp = (hp + 1) & 31;
      hist[hp] = buf[i];
      hist[hp + 32] = buf[i];
      // even oversampled sample: 16-tap FIR (×2 for the zero-stuffing gain)
      // odd oversampled sample: the center tap (0.5·2) → pure delay x[t-7]
      const xa = hist[hp + 32 - 7];
      let xb = 0;
      for (let k = 0; k < 16; k++) xb += h[k] * hist[hp + 32 - k];
      xb *= 2;
      const yb = shape(xb);
      const ya = shape(xa);
      // decimate: lowpass at 2× rate then keep one of two samples
      // output = 0.5·ya(delayed) + Σ side taps over the yb stream
      h2 = (h2 + 1) & 31;
      hist2[h2] = yb;
      hist2[h2 + 32] = yb;
      cp = (cp + 1) & 15;
      center[cp] = ya;
      let acc = 0;
      for (let k = 0; k < 16; k++) acc += h[k] * hist2[h2 + 32 - k];
      buf[i] = acc + 0.5 * center[(cp - 8 + 16) & 15];
    }
    this.hpos = hp;
    this.h2pos = h2;
    this.cpos = cp;
  }
}
