/**
 * Brickwall lookahead limiter (stereo-linked).
 *
 * Required gain r[n] = min(1, ceiling/peak[n]) → sliding-window minimum over the lookahead window
 * (monotonic deque) → exponential release → moving average over the same window. Because every
 * value in the averaging window is ≤ the required gain of the sample leaving the delay line, the
 * output never exceeds the ceiling (the classic "min + box filter" construction), with a smooth
 * attack and no overshoot. Latency = lookahead samples.
 */
import { dbToGain } from '../utils';

export class LookaheadLimiter {
  readonly lookahead: number;
  private readonly win: number;
  private ceiling = 1;
  private releaseCoef = 0.001;
  private readonly dl: Float64Array;
  private readonly dr: Float64Array;
  private dpos = 0;
  // deque for sliding min
  private readonly qv: Float64Array;
  private readonly qi: Float64Array;
  private qh = 0;
  private qt = 0;
  private idx = 0;
  // box filter
  private readonly box: Float64Array;
  private bpos = 0;
  private bsum: number;
  private env = 1;
  enabled = true;
  /** Most negative gain change (dB) applied in the last processed block. */
  gainReductionDb = 0;

  constructor(private readonly sampleRate: number, lookaheadSamples: number) {
    this.lookahead = Math.max(1, Math.round(lookaheadSamples));
    this.win = this.lookahead + 1;
    this.dl = new Float64Array(this.win);
    this.dr = new Float64Array(this.win);
    this.qv = new Float64Array(this.win + 1);
    this.qi = new Float64Array(this.win + 1);
    this.box = new Float64Array(this.win).fill(1);
    this.bsum = this.win;
  }

  configure(ceilingDb: number, releaseMs: number): void {
    // tiny safety margin so float32 rounding can never land above the ceiling
    this.ceiling = dbToGain(Math.min(0, ceilingDb)) * (1 - 2e-6);
    this.releaseCoef = 1 - Math.exp(-1 / (Math.max(1, releaseMs) * 0.001 * this.sampleRate));
  }

  reset(): void {
    this.dl.fill(0);
    this.dr.fill(0);
    this.box.fill(1);
    this.bsum = this.win;
    this.qh = this.qt = 0;
    this.idx = 0;
    this.env = 1;
    this.dpos = 0;
    this.gainReductionDb = 0;
  }

  /** Push one required gain value through min → release → box filter; returns the gain to apply. */
  private step(req: number): number {
    const qv = this.qv, qi = this.qi, cap = qv.length;
    const i = this.idx++;
    // pop back while larger
    while (this.qt !== this.qh) {
      const back = (this.qt - 1 + cap) % cap;
      if (qv[back] >= req) this.qt = back;
      else break;
    }
    qv[this.qt] = req;
    qi[this.qt] = i;
    this.qt = (this.qt + 1) % cap;
    // pop front if out of window
    while (qi[this.qh] <= i - this.win) this.qh = (this.qh + 1) % cap;
    const m = qv[this.qh];
    let e = this.env + (1 - this.env) * this.releaseCoef;
    if (m < e) e = m;
    this.env = e;
    const old = this.box[this.bpos];
    this.box[this.bpos] = e;
    this.bpos = this.bpos + 1 === this.win ? 0 : this.bpos + 1;
    this.bsum += e - old;
    return this.bsum / this.win;
  }

  /** In-place stereo processing using the sample peak as detector. */
  process(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const ceil = this.ceiling;
    const dl = this.dl, dr = this.dr, win = this.win;
    let minG = 1;
    for (let i = start; i < end; i++) {
      const xl = L[i], xr = R[i];
      const a = Math.abs(xl), b = Math.abs(xr);
      const pk = a > b ? a : b;
      const req = this.enabled && pk > ceil ? ceil / pk : 1;
      const g = this.step(req);
      // delay line
      const p = this.dpos;
      const ol = dl[p], or = dr[p];
      dl[p] = xl;
      dr[p] = xr;
      this.dpos = p + 1 === win - 1 ? 0 : p + 1;
      L[i] = ol * g;
      R[i] = or * g;
      if (g < minG) minG = g;
    }
    this.gainReductionDb = minG < 1 ? 20 * Math.log10(minG) : 0;
    if (this.idx > 1e15) this.idx = 0;
  }

  /**
   * Offline variant: `peaks[n]` is an external detector value (e.g. 4× true-peak envelope) for
   * input sample n. Processes in place with latency compensation (output aligned to input).
   */
  processOffline(chs: Float64Array[], peaks: Float64Array): void {
    const n = chs[0].length;
    const la = this.lookahead;
    const ceil = this.ceiling;
    const gains = new Float64Array(n);
    // feed required gains, read gain for sample (k - la)
    for (let k = 0; k < n + la; k++) {
      const pk = k < n ? peaks[k] : 0;
      const req = pk > ceil ? ceil / pk : 1;
      const g = this.step(req);
      const j = k - la;
      if (j >= 0) gains[j] = g;
    }
    for (const ch of chs) for (let i = 0; i < n; i++) ch[i] *= gains[i];
  }
}
