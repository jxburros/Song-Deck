/**
 * Six-band channel EQ (spec §40): HPF, low shelf, low-mid peak, high-mid peak, high shelf, LPF.
 * RBJ biquads; coefficients are recomputed only when a band's parameters change, inactive bands
 * (0 dB / off) are skipped.
 */
import type { EqSettings } from '@songdeck/core';
import { Biquad } from '../filters';
import { clampNum } from '../utils';

export type EqParams = Pick<
  EqSettings,
  | 'enabled'
  | 'highpassHz'
  | 'lowShelfHz'
  | 'lowShelfDb'
  | 'lowMidHz'
  | 'lowMidDb'
  | 'lowMidQ'
  | 'highMidHz'
  | 'highMidDb'
  | 'highMidQ'
  | 'highShelfHz'
  | 'highShelfDb'
  | 'lowpassHz'
>;

const HP = 0, LS = 1, LM = 2, HM = 3, HS = 4, LP = 5;

export class ChannelEq {
  private readonly bands = [new Biquad(), new Biquad(), new Biquad(), new Biquad(), new Biquad(), new Biquad()];
  private readonly active = [false, false, false, false, false, false];
  /** Cached parameter tuples per band (freq, gain, q) to detect changes. */
  private readonly cache = new Float64Array(18).fill(NaN);
  enabled = false;

  constructor(private readonly sampleRate: number) {}

  reset(): void {
    for (const b of this.bands) b.reset();
  }

  /** Apply parameters (call per block with smoothed/automated values). */
  update(p: EqParams): void {
    this.enabled = !!p.enabled;
    if (!this.enabled) return;
    const sr = this.sampleRate;
    const nyq = sr * 0.49;
    this.setBand(HP, p.highpassHz > 10 && p.highpassHz < nyq, 'highpass', p.highpassHz, 0, 0.7071);
    this.setBand(LS, Math.abs(p.lowShelfDb) > 0.01, 'lowshelf', p.lowShelfHz, p.lowShelfDb, 1);
    this.setBand(LM, Math.abs(p.lowMidDb) > 0.01, 'peak', p.lowMidHz, p.lowMidDb, clampNum(p.lowMidQ || 1, 0.1, 18));
    this.setBand(HM, Math.abs(p.highMidDb) > 0.01, 'peak', p.highMidHz, p.highMidDb, clampNum(p.highMidQ || 1, 0.1, 18));
    this.setBand(HS, Math.abs(p.highShelfDb) > 0.01, 'highshelf', p.highShelfHz, p.highShelfDb, 1);
    this.setBand(LP, p.lowpassHz > 10 && p.lowpassHz < nyq, 'lowpass', p.lowpassHz, 0, 0.7071);
  }

  private setBand(i: number, on: boolean, type: 'highpass' | 'lowpass' | 'peak' | 'lowshelf' | 'highshelf', f: number, db: number, q: number): void {
    if (!on) {
      if (this.active[i]) {
        this.active[i] = false;
        this.bands[i].reset();
      }
      return;
    }
    const c = this.cache;
    const o = i * 3;
    const freq = clampNum(f || 1000, 10, this.sampleRate * 0.49);
    if (!this.active[i] || c[o] !== freq || c[o + 1] !== db || c[o + 2] !== q) {
      this.bands[i].design(type, freq, q, db, this.sampleRate);
      c[o] = freq;
      c[o + 1] = db;
      c[o + 2] = q;
      if (!this.active[i]) this.bands[i].reset();
      this.active[i] = true;
    }
  }

  get anyActive(): boolean {
    return this.enabled && this.active.some(Boolean);
  }

  process(L: Float64Array, R: Float64Array, start: number, end: number): void {
    if (!this.enabled) return;
    for (let i = 0; i < 6; i++) if (this.active[i]) this.bands[i].processStereo(L, R, start, end);
  }
}
