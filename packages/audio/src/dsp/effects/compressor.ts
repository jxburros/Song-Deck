/**
 * Feed-forward, stereo-linked compressor with soft knee (Giannoulis/Massberg/Reiss gain computer),
 * peak detector smoothed in the dB domain with separate attack/release, makeup gain.
 */
import type { CompressorSettings } from '@songdeck/core';
import { clampNum } from '../utils';

const LOG10_20 = 20 / Math.LN10; // 20·log10(x) = LOG10_20·ln(x)
const DB_TO_LN = Math.LN10 / 20;

export class Compressor {
  private threshold = -18;
  private ratio = 3;
  private knee = 6;
  private makeup = 0;
  private attackCoef = 0;
  private releaseCoef = 0;
  private attackCoef4 = 0;
  private releaseCoef4 = 0;
  private lastGain = 1;
  private env = 0; // smoothed gain reduction (dB, ≤ 0)
  /** Current gain reduction in dB (≤ 0) for metering. */
  gainReductionDb = 0;

  constructor(private readonly sampleRate: number) {}

  configure(s: Pick<CompressorSettings, 'thresholdDb' | 'ratio' | 'kneeDb' | 'attackMs' | 'releaseMs' | 'makeupDb'>): void {
    this.threshold = clampNum(s.thresholdDb, -80, 0);
    this.ratio = clampNum(s.ratio, 1, 100);
    this.knee = clampNum(s.kneeDb, 0, 24);
    this.makeup = clampNum(s.makeupDb, -24, 36);
    this.attackCoef = Math.exp(-1 / (Math.max(0.05, s.attackMs) * 0.001 * this.sampleRate));
    this.releaseCoef = Math.exp(-1 / (Math.max(1, s.releaseMs) * 0.001 * this.sampleRate));
    this.attackCoef4 = Math.pow(this.attackCoef, 4);
    this.releaseCoef4 = Math.pow(this.releaseCoef, 4);
    this.lastGain = Math.exp(this.makeup * DB_TO_LN);
  }

  reset(): void {
    this.env = 0;
    this.gainReductionDb = 0;
    this.lastGain = Math.exp(this.makeup * DB_TO_LN);
  }

  /** Static curve: gain reduction (dB, ≤ 0) for input level x (dB). */
  private computeGr(x: number): number {
    const T = this.threshold, R = this.ratio, W = this.knee;
    const d = x - T;
    if (2 * d < -W) return 0;
    if (W > 0 && 2 * Math.abs(d) <= W) {
      const t = d + W / 2;
      return ((1 / R - 1) * t * t) / (2 * W);
    }
    return d * (1 / R - 1);
  }

  process(L: Float64Array, R: Float64Array, start: number, end: number): void {
    let env = this.env;
    const ac = this.attackCoef, rc = this.releaseCoef;
    const ac4 = this.attackCoef4, rc4 = this.releaseCoef4;
    const makeup = this.makeup;
    const kneeLo = this.threshold - this.knee / 2;
    const kneeLoLin = Math.exp(kneeLo * DB_TO_LN);
    let minGr = 0;
    let g0 = this.lastGain;
    for (let i = start; i < end; i += 4) {
      const e = Math.min(end, i + 4);
      // peak over the sub-block
      let pk = 0;
      for (let j = i; j < e; j++) {
        const a = L[j] < 0 ? -L[j] : L[j];
        const b = R[j] < 0 ? -R[j] : R[j];
        if (a > pk) pk = a;
        if (b > pk) pk = b;
      }
      let gr = 0;
      if (pk > kneeLoLin) gr = this.computeGr(LOG10_20 * Math.log(pk));
      const full = e - i === 4;
      if (gr < env) env = full ? ac4 * env + (1 - ac4) * gr : ac * env + (1 - ac) * gr;
      else env = full ? rc4 * env + (1 - rc4) * gr : rc * env + (1 - rc) * gr;
      const g1 = Math.exp((env + makeup) * DB_TO_LN);
      const step = (g1 - g0) / (e - i);
      let g = g0;
      for (let j = i; j < e; j++) {
        g += step;
        L[j] *= g;
        R[j] *= g;
      }
      g0 = g1;
      if (env < minGr) minGr = env;
    }
    if (env > -1e-9) env = 0;
    this.env = env;
    this.lastGain = g0;
    this.gainReductionDb = minGr;
  }
}
