/**
 * Mixer DSP (spec §40): channel strips (phase invert → drive → 6-band EQ → compressor → M/S width →
 * equal-power pan + volume + mute/solo gain → post-fader reverb/delay sends) and the master bus
 * (EQ → glue compressor → width → volume → brickwall lookahead limiter). All parameter changes are
 * smoothed per block and ramped per sample (no zipper noise); automation overrides strip values.
 */
import type { ChannelStrip, MasterBus } from '@songdeck/core';
import {
  AP_COUNT,
  AP_DELAY,
  AP_DRIVE,
  AP_HIGHMID,
  AP_HIGHPASS,
  AP_HIGHSHELF,
  AP_LOWMID,
  AP_LOWPASS,
  AP_LOWSHELF,
  AP_PAN,
  AP_REVERB,
  AP_VOLUME,
  AP_WIDTH,
} from './automation';
import { BlockSmoother } from './envelopes';
import { Compressor } from './effects/compressor';
import { ChannelEq, type EqParams } from './effects/eq';
import { LookaheadLimiter } from './effects/limiter';
import { Drive } from './effects/saturation';
import { BLOCK, MIN_DB, clampNum, dbToGain, num } from './utils';

export interface Meter {
  peakDb: number;
  rmsDb: number;
}

class MeterState {
  peak = 0;
  ms = 0;
  private readonly peakDecay: number;
  private readonly rmsCoef: number;
  constructor(sampleRate: number) {
    // peak falls 20 dB/s, RMS window ≈ 300 ms
    this.peakDecay = Math.pow(10, -20 / 20 / (sampleRate / BLOCK));
    this.rmsCoef = Math.exp(-BLOCK / (0.3 * sampleRate));
  }
  update(L: Float64Array, R: Float64Array, n: number): void {
    let pk = 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const a = L[i],
        b = R[i];
      const aa = a < 0 ? -a : a,
        bb = b < 0 ? -b : b;
      if (aa > pk) pk = aa;
      if (bb > pk) pk = bb;
      s += a * a + b * b;
    }
    const ms = s / Math.max(1, 2 * n);
    this.peak = Math.max(pk, this.peak * this.peakDecay);
    const c = Math.pow(this.rmsCoef, n / BLOCK);
    this.ms = this.ms * c + ms * (1 - c);
    if (!Number.isFinite(this.peak)) this.peak = 0;
    if (!Number.isFinite(this.ms)) this.ms = 0;
  }
  /** Pre-computed block statistics. */
  push(pk: number, ms: number, n: number): void {
    if (!(pk === pk) || !(ms === ms)) return;
    this.peak = Math.max(pk, this.peak * this.peakDecay);
    const c = Math.pow(this.rmsCoef, n / BLOCK);
    this.ms = this.ms * c + ms * (1 - c);
  }
  reset(): void {
    this.peak = 0;
    this.ms = 0;
  }
  read(): Meter {
    return {
      peakDb: this.peak > 6.31e-8 ? 20 * Math.log10(this.peak) : MIN_DB,
      rmsDb: this.ms > 4e-15 ? 10 * Math.log10(this.ms) : MIN_DB,
    };
  }
}

const SMOOTH_S = 0.03;

/** Automation value for parameter `i`, or `v` when not automated. */
function av(auto: Float64Array | null, i: number, v: number): number {
  if (auto === null) return v;
  const x = auto[i];
  return x === x ? x : v;
}

function panL(p: number): number {
  return Math.cos(((clampNum(p, -1, 1) + 1) * Math.PI) / 4) * Math.SQRT2;
}
function panR(p: number): number {
  return Math.sin(((clampNum(p, -1, 1) + 1) * Math.PI) / 4) * Math.SQRT2;
}

export class StripProcessor {
  private readonly eq: ChannelEq;
  private readonly comp: Compressor;
  private readonly drv: Drive;
  private readonly vol = new BlockSmoother(-6);
  private readonly pan = new BlockSmoother(0);
  private readonly rev = new BlockSmoother(0);
  private readonly dly = new BlockSmoother(0);
  private readonly width = new BlockSmoother(1);
  private readonly drive = new BlockSmoother(0);
  private readonly audible = new BlockSmoother(1);
  private readonly eqGain = [
    new BlockSmoother(0),
    new BlockSmoother(0),
    new BlockSmoother(0),
    new BlockSmoother(0),
  ];
  private strip: ChannelStrip | null = null;
  private compOn = false;
  private phase = false;
  // last block gains (ramp starts)
  private gl = 0;
  private gr = 0;
  private sr0 = 0;
  private sd0 = 0;
  private w0 = 1;
  private readonly eqp: EqParams = {
    enabled: false,
    highpassHz: 0,
    lowShelfHz: 120,
    lowShelfDb: 0,
    lowMidHz: 400,
    lowMidDb: 0,
    lowMidQ: 1,
    highMidHz: 2500,
    highMidDb: 0,
    highMidQ: 1,
    highShelfHz: 8000,
    highShelfDb: 0,
    lowpassHz: 0,
  };
  readonly meter: MeterState;
  private first = true;
  private eqDirty = true;

  constructor(private readonly sampleRate: number) {
    this.eq = new ChannelEq(sampleRate);
    this.comp = new Compressor(sampleRate);
    this.drv = new Drive(sampleRate);
    this.meter = new MeterState(sampleRate);
    const bps = sampleRate / BLOCK;
    for (const s of [this.vol, this.pan, this.rev, this.dly, this.width, this.drive, ...this.eqGain])
      s.setTime(SMOOTH_S, bps);
    this.audible.setTime(0.008, bps);
  }

  /** Set the strip's base values (smoothed unless `snap`). */
  setStrip(s: ChannelStrip, snap: boolean): void {
    this.strip = s;
    const set = (sm: BlockSmoother, v: number) => (snap ? sm.snap(v) : (sm.target = v));
    set(this.vol, clampNum(num(s.volumeDb, -6), -120, 24));
    set(this.pan, clampNum(num(s.pan, 0), -1, 1));
    set(this.rev, clampNum(num(s.reverbSend, 0), 0, 1));
    set(this.dly, clampNum(num(s.delaySend, 0), 0, 1));
    set(this.width, clampNum(num(s.width, 1), 0, 2));
    set(this.drive, clampNum(num(s.drive, 0), 0, 1));
    const e = s.eq;
    if (e) {
      set(this.eqGain[0], num(e.lowShelfDb, 0));
      set(this.eqGain[1], num(e.lowMidDb, 0));
      set(this.eqGain[2], num(e.highMidDb, 0));
      set(this.eqGain[3], num(e.highShelfDb, 0));
    }
    this.compOn = !!s.compressor?.enabled;
    if (this.compOn) this.comp.configure(s.compressor);
    this.phase = !!s.phaseInvert;
    this.eqDirty = true;
    if (snap) this.first = true;
  }

  setAudible(on: boolean, snap: boolean): void {
    if (snap) this.audible.snap(on ? 1 : 0);
    else this.audible.target = on ? 1 : 0;
  }

  reset(): void {
    this.eq.reset();
    this.comp.reset();
    this.drv.reset();
    this.meter.reset();
    for (const s of [
      this.vol,
      this.pan,
      this.rev,
      this.dly,
      this.width,
      this.drive,
      this.audible,
      ...this.eqGain,
    ])
      s.snap(s.target);
    this.first = true;
    this.eqDirty = true;
  }

  /**
   * Process one block in place and mix into the buses.
   * `auto` holds automation values (NaN = not automated) indexed by AP_*.
   */
  process(
    L: Float64Array,
    R: Float64Array,
    n: number,
    auto: Float64Array | null,
    mL: Float64Array,
    mR: Float64Array,
    revL: Float64Array | null,
    revR: Float64Array | null,
    dlyL: Float64Array | null,
    dlyR: Float64Array | null,
  ): number {
    const s = this.strip;
    const volDb = av(auto, AP_VOLUME, this.vol.step());
    const pan = clampNum(av(auto, AP_PAN, this.pan.step()), -1, 1);
    const rev = clampNum(av(auto, AP_REVERB, this.rev.step()), 0, 1);
    const dly = clampNum(av(auto, AP_DELAY, this.dly.step()), 0, 1);
    const width = clampNum(av(auto, AP_WIDTH, this.width.step()), 0, 2);
    const drive = clampNum(av(auto, AP_DRIVE, this.drive.step()), 0, 1);
    const aud = this.audible.step();
    if (this.phase) {
      for (let i = 0; i < n; i++) {
        L[i] = -L[i];
        R[i] = -R[i];
      }
    }
    if (drive > 0.001) {
      this.drv.set(drive);
      this.drv.process(L, R, 0, n);
    }
    // EQ (parameters only re-evaluated while smoothing / automating / after a change)
    if (
      s?.eq &&
      (this.eqDirty ||
        auto !== null ||
        !this.eqGain[0].settled ||
        !this.eqGain[1].settled ||
        !this.eqGain[2].settled ||
        !this.eqGain[3].settled)
    ) {
      this.eqDirty = false;
      const e = s.eq;
      const p = this.eqp;
      p.enabled = e.enabled !== false;
      p.highpassHz = av(auto, AP_HIGHPASS, num(e.highpassHz, 0));
      p.lowShelfHz = num(e.lowShelfHz, 120);
      p.lowShelfDb = av(auto, AP_LOWSHELF, this.eqGain[0].step());
      p.lowMidHz = num(e.lowMidHz, 400);
      p.lowMidDb = av(auto, AP_LOWMID, this.eqGain[1].step());
      p.lowMidQ = num(e.lowMidQ, 1);
      p.highMidHz = num(e.highMidHz, 2500);
      p.highMidDb = av(auto, AP_HIGHMID, this.eqGain[2].step());
      p.highMidQ = num(e.highMidQ, 1);
      p.highShelfHz = num(e.highShelfHz, 8000);
      p.highShelfDb = av(auto, AP_HIGHSHELF, this.eqGain[3].step());
      p.lowpassHz = av(auto, AP_LOWPASS, num(e.lowpassHz, 0));
      this.eq.update(p);
    }
    if (s?.eq) this.eq.process(L, R, 0, n);
    if (this.compOn) this.comp.process(L, R, 0, n);
    // width
    const w0 = this.first ? width : this.w0;
    if (w0 !== 1 || width !== 1) {
      const dw = (width - w0) / n;
      let w = w0;
      for (let i = 0; i < n; i++) {
        w += dw;
        const m = (L[i] + R[i]) * 0.5;
        const sd = (L[i] - R[i]) * 0.5 * w;
        L[i] = m + sd;
        R[i] = m - sd;
      }
    }
    this.w0 = width;
    // pan + volume + mute/solo
    const g = dbToGain(volDb) * aud;
    const gl1 = g * panL(pan),
      gr1 = g * panR(pan);
    const gl0 = this.first ? gl1 : this.gl,
      gr0 = this.first ? gr1 : this.gr;
    const r0 = this.first ? rev : this.sr0,
      d0 = this.first ? dly : this.sd0;
    const inv = 1 / n;
    const doRev = !!(revL && revR && (rev > 0 || r0 > 0));
    const doDly = !!(dlyL && dlyR && (dly > 0 || d0 > 0));
    let pk = 0,
      ms = 0;
    const dgl = (gl1 - gl0) * inv,
      dgr = (gr1 - gr0) * inv;
    let cl = gl0,
      cr = gr0;
    for (let i = 0; i < n; i++) {
      cl += dgl;
      cr += dgr;
      const l = L[i] * cl;
      const r = R[i] * cr;
      L[i] = l;
      R[i] = r;
      mL[i] += l;
      mR[i] += r;
      const al = l < 0 ? -l : l,
        ar = r < 0 ? -r : r;
      if (al > pk) pk = al;
      if (ar > pk) pk = ar;
      ms += l * l + r * r;
    }
    if (doRev) {
      const rl = revL!,
        rr = revR!;
      const dk = (rev - r0) * inv;
      let k = r0;
      for (let i = 0; i < n; i++) {
        k += dk;
        rl[i] += L[i] * k;
        rr[i] += R[i] * k;
      }
    }
    if (doDly) {
      const dl = dlyL!,
        dr = dlyR!;
      const dk = (dly - d0) * inv;
      let k = d0;
      for (let i = 0; i < n; i++) {
        k += dk;
        dl[i] += L[i] * k;
        dr[i] += R[i] * k;
      }
    }
    this.gl = gl1;
    this.gr = gr1;
    this.sr0 = rev;
    this.sd0 = dly;
    this.first = false;
    this.meter.push(pk, ms / (2 * n), n);
    return (doRev ? 1 : 0) | (doDly ? 2 : 0);
  }
}

export class MasterProcessor {
  private readonly eq: ChannelEq;
  private readonly comp: Compressor;
  readonly limiter: LookaheadLimiter;
  private readonly vol = new BlockSmoother(0);
  private readonly width = new BlockSmoother(1);
  private readonly eqGain = [
    new BlockSmoother(0),
    new BlockSmoother(0),
    new BlockSmoother(0),
    new BlockSmoother(0),
  ];
  private master: MasterBus | null = null;
  private compOn = false;
  private g0 = 1;
  private w0 = 1;
  private first = true;
  readonly meter: MeterState;
  private readonly eqp: EqParams = {
    enabled: false,
    highpassHz: 0,
    lowShelfHz: 120,
    lowShelfDb: 0,
    lowMidHz: 400,
    lowMidDb: 0,
    lowMidQ: 1,
    highMidHz: 2500,
    highMidDb: 0,
    highMidQ: 1,
    highShelfHz: 8000,
    highShelfDb: 0,
    lowpassHz: 0,
  };

  constructor(sampleRate: number) {
    this.eq = new ChannelEq(sampleRate);
    this.comp = new Compressor(sampleRate);
    this.limiter = new LookaheadLimiter(sampleRate, BLOCK);
    this.meter = new MeterState(sampleRate);
    const bps = sampleRate / BLOCK;
    for (const s of [this.vol, this.width, ...this.eqGain]) s.setTime(SMOOTH_S, bps);
  }

  setMaster(m: MasterBus, snap: boolean): void {
    this.master = m;
    const set = (sm: BlockSmoother, v: number) => (snap ? sm.snap(v) : (sm.target = v));
    set(this.vol, clampNum(num(m.volumeDb, 0), -120, 24));
    set(this.width, clampNum(num(m.width, 1), 0, 2));
    if (m.eq) {
      set(this.eqGain[0], num(m.eq.lowShelfDb, 0));
      set(this.eqGain[1], num(m.eq.lowMidDb, 0));
      set(this.eqGain[2], num(m.eq.highMidDb, 0));
      set(this.eqGain[3], num(m.eq.highShelfDb, 0));
    }
    this.compOn = !!m.compressor?.enabled;
    if (this.compOn) this.comp.configure(m.compressor);
    const lim = m.limiter ?? { enabled: true, ceilingDb: -1, releaseMs: 80 };
    this.limiter.enabled = lim.enabled !== false;
    this.limiter.configure(num(lim.ceilingDb, -1), num(lim.releaseMs, 80));
    if (snap) this.first = true;
  }

  reset(): void {
    this.eq.reset();
    this.comp.reset();
    this.limiter.reset();
    this.meter.reset();
    for (const s of [this.vol, this.width, ...this.eqGain]) s.snap(s.target);
    this.first = true;
  }

  get gainReductionDb(): number {
    return this.limiter.gainReductionDb;
  }

  process(L: Float64Array, R: Float64Array, n: number, auto: Float64Array | null): void {
    const m = this.master;
    const volDb = av(auto, AP_VOLUME, this.vol.step());
    const width = clampNum(av(auto, AP_WIDTH, this.width.step()), 0, 2);
    if (m?.eq) {
      const e = m.eq;
      const p = this.eqp;
      p.enabled = e.enabled !== false;
      p.highpassHz = av(auto, AP_HIGHPASS, num(e.highpassHz, 0));
      p.lowShelfHz = num(e.lowShelfHz, 120);
      p.lowShelfDb = av(auto, AP_LOWSHELF, this.eqGain[0].step());
      p.lowMidHz = num(e.lowMidHz, 400);
      p.lowMidDb = av(auto, AP_LOWMID, this.eqGain[1].step());
      p.lowMidQ = num(e.lowMidQ, 1);
      p.highMidHz = num(e.highMidHz, 2500);
      p.highMidDb = av(auto, AP_HIGHMID, this.eqGain[2].step());
      p.highMidQ = num(e.highMidQ, 1);
      p.highShelfHz = num(e.highShelfHz, 8000);
      p.highShelfDb = av(auto, AP_HIGHSHELF, this.eqGain[3].step());
      p.lowpassHz = av(auto, AP_LOWPASS, num(e.lowpassHz, 0));
      this.eq.update(p);
      this.eq.process(L, R, 0, n);
    }
    if (this.compOn) this.comp.process(L, R, 0, n);
    const w0 = this.first ? width : this.w0;
    const g1 = dbToGain(volDb);
    const g0 = this.first ? g1 : this.g0;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) * inv;
      const w = w0 + (width - w0) * t;
      const g = g0 + (g1 - g0) * t;
      let l = L[i],
        r = R[i];
      if (w !== 1) {
        const mm = (l + r) * 0.5;
        const sd = (l - r) * 0.5 * w;
        l = mm + sd;
        r = mm - sd;
      }
      L[i] = l * g;
      R[i] = r * g;
    }
    this.w0 = width;
    this.g0 = g1;
    this.first = false;
    this.limiter.process(L, R, 0, n);
    this.meter.update(L, R, n);
  }
}

export { AP_COUNT };
