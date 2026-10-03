/**
 * Tempo-synced stereo delay bus: time = timeBeats at the current bpm (smoothly slewed on tempo or
 * setting changes), feedback through high-cut / low-cut filters, optional ping-pong.
 */
import type { DelaySettings } from '@songdeck/core';
import { Biquad } from '../filters';
import { clampNum } from '../utils';

const MAX_SECONDS = 4;

export class StereoDelay {
  private readonly bl: Float64Array;
  private readonly br: Float64Array;
  private readonly mask: number;
  private w = 0;
  private delay = 0; // current (smoothed) delay in samples
  private target = 0;
  private readonly slew: number;
  private feedback = 0.3;
  private pingPong = true;
  private readonly hcL = new Biquad();
  private readonly hcR = new Biquad();
  private readonly lcL = new Biquad();
  private readonly lcR = new Biquad();
  private cfgKey = '';

  constructor(private readonly sampleRate: number) {
    let n = 1;
    while (n < MAX_SECONDS * sampleRate + 8) n *= 2;
    this.bl = new Float64Array(n);
    this.br = new Float64Array(n);
    this.mask = n - 1;
    this.slew = 1 - Math.exp(-1 / (0.08 * sampleRate));
  }

  private timeBeats = 0.75;
  private bpm = 120;

  /** Tempo at the current position (call per block; cheap). */
  setBpm(bpm: number, snap = false): void {
    this.bpm = clampNum(bpm, 20, 400);
    const sec = (this.timeBeats * 60) / this.bpm;
    this.target = clampNum(sec * this.sampleRate, 1, MAX_SECONDS * this.sampleRate);
    if (snap || this.delay === 0) this.delay = this.target;
  }

  configure(s: DelaySettings, bpm: number, snap = false): void {
    this.timeBeats = clampNum(s.timeBeats, 0.01, 16);
    this.setBpm(bpm, snap);
    this.feedback = clampNum(s.feedback, 0, 0.95);
    this.pingPong = !!s.pingPong;
    const key = `${s.highCutHz}|${s.lowCutHz}`;
    if (key !== this.cfgKey) {
      this.cfgKey = key;
      const hc = clampNum(s.highCutHz || 20000, 200, this.sampleRate * 0.45);
      const lc = clampNum(s.lowCutHz || 20, 10, 5000);
      this.hcL.design('lowpass', hc, 0.7071, 0, this.sampleRate);
      this.hcR.copyCoefs(this.hcL);
      this.lcL.design('highpass', lc, 0.7071, 0, this.sampleRate);
      this.lcR.copyCoefs(this.lcL);
    }
  }

  reset(): void {
    this.bl.fill(0);
    this.br.fill(0);
    this.hcL.reset();
    this.hcR.reset();
    this.lcL.reset();
    this.lcR.reset();
    this.delay = this.target;
  }

  /** Wet output → outL/outR (overwritten). */
  process(inL: Float64Array, inR: Float64Array, outL: Float64Array, outR: Float64Array, start: number, end: number): void {
    const bl = this.bl, br = this.br, mask = this.mask;
    const size = mask + 1;
    const fb = this.feedback;
    let w = this.w;
    let d = this.delay;
    const tgt = this.target, slew = this.slew;
    const pp = this.pingPong;
    const h = this.hcL, l = this.lcL;
    const hb0 = h.b0, hb1 = h.b1, hb2 = h.b2, ha1 = h.a1, ha2 = h.a2;
    const lb0 = l.b0, lb1 = l.b1, lb2 = l.b2, la1 = l.a1, la2 = l.a2;
    let h1L = this.hcL.z1L, h2L = this.hcL.z2L, h1R = this.hcR.z1L, h2R = this.hcR.z2L;
    let l1L = this.lcL.z1L, l2L = this.lcL.z2L, l1R = this.lcR.z1L, l2R = this.lcR.z2L;
    for (let i = start; i < end; i++) {
      d += (tgt - d) * slew;
      const pos = w - d + size;
      const ip = pos | 0;
      const f = pos - ip;
      const a0 = bl[ip & mask], a1 = bl[(ip + 1) & mask];
      const b0 = br[ip & mask], b1 = br[(ip + 1) & mask];
      const yl = a0 + f * (a1 - a0);
      const yr = b0 + f * (b1 - b0);
      // high-cut then low-cut (TDF-II), left
      let t = hb0 * yl + h1L;
      h1L = hb1 * yl - ha1 * t + h2L;
      h2L = hb2 * yl - ha2 * t;
      let u = lb0 * t + l1L;
      l1L = lb1 * t - la1 * u + l2L;
      l2L = lb2 * t - la2 * u;
      const fl = u * fb;
      // right
      t = hb0 * yr + h1R;
      h1R = hb1 * yr - ha1 * t + h2R;
      h2R = hb2 * yr - ha2 * t;
      u = lb0 * t + l1R;
      l1R = lb1 * t - la1 * u + l2R;
      l2R = lb2 * t - la2 * u;
      const fr = u * fb;
      if (pp) {
        bl[w] = (inL[i] + inR[i]) * 0.5 + fr;
        br[w] = fl;
      } else {
        bl[w] = inL[i] + fl;
        br[w] = inR[i] + fr;
      }
      outL[i] = yl;
      outR[i] = yr;
      w = (w + 1) & mask;
    }
    this.w = w;
    this.delay = d;
    this.hcL.z1L = h1L;
    this.hcL.z2L = h2L;
    this.hcR.z1L = h1R;
    this.hcR.z2L = h2R;
    this.lcL.z1L = l1L;
    this.lcL.z2L = l2L;
    this.lcR.z1L = l1R;
    this.lcR.z2L = l2R;
    this.hcL.flush();
    this.hcR.flush();
    this.lcL.flush();
    this.lcR.flush();
  }
}
