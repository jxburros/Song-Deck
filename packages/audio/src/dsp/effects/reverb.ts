/**
 * Algorithmic reverb: pre-delay → early reflections (room/hall/chamber) → 4 series input diffusers →
 * 8-line feedback delay network (fast Hadamard mixing, per-line HF damping, decay-time-derived
 * gains, slow delay modulation on two lines) → stereo decorrelated output taps → return EQ.
 * Types: room, hall, plate, chamber; size 0..1, decay (RT60 s), damping 0..1, pre-delay ms.
 *
 * The network runs at half the sample rate (input [1 2 1] low-passed and decimated, output
 * linearly interpolated); its return is low-passed at 9.5 kHz anyway, so this halves the cost
 * inaudibly. Linear and deterministic, so per-stem reverb renders sum to the full-mix reverb.
 */
import type { ReverbSettings } from '@songdeck/core';
import { Biquad } from '../filters';
import { clampNum } from '../utils';

const LINE_MS: Record<ReverbSettings['type'], number[]> = {
  room: [9.3, 11.7, 13.9, 16.3, 18.9, 21.1, 23.7, 26.3],
  chamber: [16.1, 19.5, 23.1, 26.6, 30.7, 34.4, 38.1, 42.4],
  hall: [29.7, 35.3, 41.1, 47.9, 54.3, 61.1, 67.9, 76.3],
  plate: [13.1, 17.3, 21.7, 25.9, 30.1, 34.7, 39.1, 43.9],
};
const DIFF_MS = [4.77, 3.59, 12.73, 9.31];
const DIFF_G: Record<ReverbSettings['type'], number> = { room: 0.6, chamber: 0.65, hall: 0.68, plate: 0.75 };
const ER: Record<ReverbSettings['type'], { ms: number; g: number; side: number }[]> = {
  room: [
    { ms: 4.3, g: 0.55, side: -0.7 },
    { ms: 7.9, g: 0.5, side: 0.6 },
    { ms: 11.3, g: 0.42, side: -0.4 },
    { ms: 15.7, g: 0.38, side: 0.8 },
    { ms: 19.1, g: 0.3, side: -0.9 },
    { ms: 24.9, g: 0.25, side: 0.3 },
  ],
  chamber: [
    { ms: 7.1, g: 0.42, side: -0.6 },
    { ms: 12.7, g: 0.38, side: 0.7 },
    { ms: 19.3, g: 0.32, side: -0.3 },
    { ms: 26.9, g: 0.26, side: 0.5 },
    { ms: 33.1, g: 0.2, side: -0.8 },
  ],
  hall: [
    { ms: 13.1, g: 0.32, side: -0.7 },
    { ms: 21.7, g: 0.3, side: 0.8 },
    { ms: 31.3, g: 0.25, side: -0.2 },
    { ms: 43.9, g: 0.2, side: 0.4 },
    { ms: 56.3, g: 0.15, side: -0.6 },
  ],
  plate: [],
};

function nearestPrime(n: number): number {
  n = Math.max(2, Math.round(n));
  const isPrime = (k: number) => {
    if (k < 2) return false;
    for (let d = 2; d * d <= k; d++) if (k % d === 0) return false;
    return true;
  };
  for (let d = 0; d < 1000; d++) {
    if (isPrime(n + d)) return n + d;
    if (n - d > 2 && isPrime(n - d)) return n - d;
  }
  return n;
}

/** Linear-interpolated read; `pos` must be ≥ 0 (callers add the buffer length). */
function readFrac(buf: Float64Array, pos: number, mask: number): number {
  const ip = pos | 0;
  const f = pos - ip;
  const a = buf[ip & mask];
  return a + f * (buf[(ip + 1) & mask] - a);
}

const MAX_SIZE_SCALE = 1.6;
const MAX_PREDELAY_MS = 500;

export class Reverb {
  /** Internal (half) rate. */
  private readonly hr: number;
  private readonly lines: Float64Array[] = [];
  private readonly lineLen = new Float64Array(8);
  private readonly mask: number;
  private wpos = 0;
  private readonly gains = new Float64Array(8);
  private readonly damp = new Float64Array(8);
  private dampA = 0.5;
  private readonly modPhase = new Float64Array(8);
  private readonly modInc = new Float64Array(8);
  private readonly modOff = new Float64Array(8);
  private modDepth = 0;
  private readonly diff: Float64Array[] = [];
  private readonly diffLen = [1, 1, 1, 1];
  private readonly diffPos = [0, 0, 0, 0];
  private diffG = 0.6;
  private readonly pre: Float64Array;
  private readonly preMask: number;
  private prePos = 0;
  private preDelay = 0;
  private erD = new Int32Array(0);
  private erGL = new Float64Array(0);
  private erGR = new Float64Array(0);
  private erLevel = 0;
  private readonly hpf = new Biquad();
  private readonly lpf = new Biquad();
  private outGain = 0.5;
  private configured = '';
  // half-rate plumbing
  private phase = 0;
  private x1L = 0;
  private x1R = 0;
  private x2L = 0;
  private x2R = 0;
  private accL = 0;
  private accR = 0;
  private yL = 0;
  private yR = 0;

  constructor(private readonly sampleRate: number) {
    const hr = sampleRate / 2;
    this.hr = hr;
    const maxLine = Math.ceil((80 * MAX_SIZE_SCALE * hr) / 1000) + 64;
    let p2 = 1;
    while (p2 < maxLine) p2 *= 2;
    for (let i = 0; i < 8; i++) this.lines.push(new Float64Array(p2));
    this.mask = p2 - 1;
    for (let i = 0; i < 4; i++)
      this.diff.push(new Float64Array(Math.ceil((14 * MAX_SIZE_SCALE * hr) / 1000) + 8));
    let pp = 1;
    while (pp < ((MAX_PREDELAY_MS + 80) * hr) / 1000) pp *= 2;
    this.pre = new Float64Array(pp);
    this.preMask = pp - 1;
    this.hpf.design('highpass', 140, 0.6, 0, sampleRate);
    this.lpf.design('lowpass', 9500, 0.6, 0, sampleRate);
  }

  configure(s: ReverbSettings): void {
    const key = `${s.type}|${s.size}|${s.decaySeconds}|${s.damping}|${s.preDelayMs}`;
    if (key === this.configured) return;
    this.configured = key;
    const hr = this.hr;
    const type = LINE_MS[s.type] ? s.type : 'hall';
    const size = clampNum(s.size, 0, 1);
    const scale = 0.55 + size * (MAX_SIZE_SCALE - 0.55);
    const t60 = clampNum(s.decaySeconds, 0.1, 30);
    for (let i = 0; i < 8; i++) {
      const len = nearestPrime((LINE_MS[type][i] * scale * hr) / 1000);
      this.lineLen[i] = len;
      this.gains[i] = Math.pow(10, (-3 * len) / (t60 * hr));
      this.modInc[i] = (0.23 + 0.11 * i) / hr;
      this.modPhase[i] = i / 8;
    }
    this.modDepth = (type === 'room' ? 0.0004 : 0.00095) * hr;
    for (let i = 0; i < 4; i++) {
      this.diffLen[i] = Math.max(
        1,
        Math.min(this.diff[i].length - 1, nearestPrime((DIFF_MS[i] * (0.6 + 0.6 * size) * hr) / 1000)),
      );
      this.diffPos[i] = 0;
    }
    this.diffG = DIFF_G[type];
    const damping = clampNum(s.damping, 0, 1);
    const cutoff = 16000 * Math.pow(1500 / 16000, damping);
    this.dampA = 1 - Math.exp((-2 * Math.PI * Math.min(cutoff, hr * 0.45)) / hr);
    this.preDelay = Math.round((clampNum(s.preDelayMs, 0, MAX_PREDELAY_MS) * hr) / 1000);
    const er = ER[type];
    this.erD = new Int32Array(er.length);
    this.erGL = new Float64Array(er.length);
    this.erGR = new Float64Array(er.length);
    er.forEach((t, k) => {
      const ang = ((t.side + 1) * Math.PI) / 4;
      this.erD[k] = Math.min(this.preDelay + Math.round((t.ms * scale * hr) / 1000), this.preMask);
      this.erGL[k] = t.g * Math.cos(ang) * Math.SQRT2;
      this.erGR[k] = t.g * Math.sin(ang) * Math.SQRT2;
    });
    this.erLevel = type === 'room' ? 0.7 : type === 'chamber' ? 0.55 : type === 'hall' ? 0.45 : 0;
    // keep late-tail loudness roughly comparable across decay times
    this.outGain = 0.42 / Math.sqrt(Math.max(0.3, t60));
  }

  reset(): void {
    for (const l of this.lines) l.fill(0);
    for (const d of this.diff) d.fill(0);
    this.pre.fill(0);
    this.damp.fill(0);
    this.hpf.reset();
    this.lpf.reset();
    this.wpos = 0;
    this.prePos = 0;
    this.phase = 0;
    this.x1L = this.x1R = this.x2L = this.x2R = 0;
    this.accL = this.accR = 0;
    this.yL = this.yR = 0;
  }

  /** Wet output for inputs [start, end) → outL/outR (overwritten). */
  process(
    inL: Float64Array,
    inR: Float64Array,
    outL: Float64Array,
    outR: Float64Array,
    start: number,
    end: number,
  ): void {
    const lines = this.lines;
    const m0 = this.mask;
    const lens = this.lineLen;
    const gains = this.gains;
    const damp = this.damp;
    const da = this.dampA;
    const pre = this.pre;
    const pm = this.preMask;
    const dg = this.diffG;
    const og = this.outGain;
    const erl = this.erLevel * 0.5;
    const erD = this.erD,
      erGL = this.erGL,
      erGR = this.erGR;
    const nTaps = erD.length;
    const preDelay = this.preDelay;
    // control-rate modulation offsets (per block) for lines 0 and 5
    const mo = this.modOff;
    const halfN = (end - start) * 0.5;
    for (let k = 0; k < 8; k += 5) {
      this.modPhase[k] += this.modInc[k] * halfN;
      if (this.modPhase[k] > 1) this.modPhase[k] -= 1;
      mo[k] = lens[k] + this.modDepth * Math.sin(2 * Math.PI * this.modPhase[k]) * (k & 1 ? 1 : -1);
    }
    const i1 = lens[1] | 0,
      i2 = lens[2] | 0,
      i3 = lens[3] | 0,
      i4 = lens[4] | 0,
      i6 = lens[6] | 0,
      i7 = lens[7] | 0;
    const mo0 = mo[0],
      mo5 = mo[5];
    const l0 = lines[0],
      l1 = lines[1],
      l2 = lines[2],
      l3 = lines[3],
      l4 = lines[4],
      l5 = lines[5],
      l6 = lines[6],
      l7 = lines[7];
    const df0 = this.diff[0],
      df1 = this.diff[1],
      df2 = this.diff[2],
      df3 = this.diff[3];
    const dl0 = this.diffLen[0],
      dl1 = this.diffLen[1],
      dl2 = this.diffLen[2],
      dl3 = this.diffLen[3];
    let dp0 = this.diffPos[0],
      dp1 = this.diffPos[1],
      dp2 = this.diffPos[2],
      dp3 = this.diffPos[3];
    let w = this.wpos;
    let pp = this.prePos;
    let phase = this.phase;
    let x1L = this.x1L,
      x1R = this.x1R,
      x2L = this.x2L,
      x2R = this.x2R;
    let accL = this.accL,
      accR = this.accR;
    let yL = this.yL,
      yR = this.yR;
    for (let i = start; i < end; i++) {
      // [1 2 1]/4 anti-alias pre-filter, then decimate by 2
      const iL = inL[i],
        iR = inR[i];
      const fl = 0.25 * (iL + 2 * x1L + x2L);
      const fr = 0.25 * (iR + 2 * x1R + x2R);
      x2L = x1L;
      x1L = iL;
      x2R = x1R;
      x1R = iR;
      if (phase === 0) {
        accL = fl;
        accR = fr;
        phase = 1;
        outL[i] = yL;
        outR[i] = yR;
        continue;
      }
      phase = 0;
      const xl = (accL + fl) * 0.5;
      const xr = (accR + fr) * 0.5;
      // ---- one half-rate step ----
      pre[pp] = (xl + xr) * 0.5;
      let x = pre[(pp - preDelay) & pm];
      let erL = 0,
        erR = 0;
      for (let t = 0; t < nTaps; t++) {
        const v = pre[(pp - erD[t]) & pm];
        erL += v * erGL[t];
        erR += v * erGR[t];
      }
      pp = (pp + 1) & pm;
      let d = df0[dp0];
      let v = x + dg * d;
      df0[dp0] = v;
      x = d - dg * v;
      if (++dp0 >= dl0) dp0 = 0;
      d = df1[dp1];
      v = x + dg * d;
      df1[dp1] = v;
      x = d - dg * v;
      if (++dp1 >= dl1) dp1 = 0;
      d = df2[dp2];
      v = x + dg * d;
      df2[dp2] = v;
      x = d - dg * v;
      if (++dp2 >= dl2) dp2 = 0;
      d = df3[dp3];
      v = x + dg * d;
      df3[dp3] = v;
      x = d - dg * v;
      if (++dp3 >= dl3) dp3 = 0;
      const wp = w + m0 + 1;
      let y0 = readFrac(l0, wp - mo0, m0);
      let y1 = l1[(w - i1) & m0],
        y2 = l2[(w - i2) & m0],
        y3 = l3[(w - i3) & m0],
        y4 = l4[(w - i4) & m0];
      let y5 = readFrac(l5, wp - mo5, m0);
      let y6 = l6[(w - i6) & m0],
        y7 = l7[(w - i7) & m0];
      damp[0] += da * (y0 - damp[0]);
      y0 = damp[0] * gains[0];
      damp[1] += da * (y1 - damp[1]);
      y1 = damp[1] * gains[1];
      damp[2] += da * (y2 - damp[2]);
      y2 = damp[2] * gains[2];
      damp[3] += da * (y3 - damp[3]);
      y3 = damp[3] * gains[3];
      damp[4] += da * (y4 - damp[4]);
      y4 = damp[4] * gains[4];
      damp[5] += da * (y5 - damp[5]);
      y5 = damp[5] * gains[5];
      damp[6] += da * (y6 - damp[6]);
      y6 = damp[6] * gains[6];
      damp[7] += da * (y7 - damp[7]);
      y7 = damp[7] * gains[7];
      const oL = y0 - y1 + y2 - y3 + y4 - y5 + y6 - y7;
      const oR = y0 + y1 - y2 - y3 + y4 + y5 - y6 - y7;
      const b0 = y0 + y1,
        b1 = y0 - y1,
        b2 = y2 + y3,
        b3 = y2 - y3,
        b4 = y4 + y5,
        b5 = y4 - y5,
        b6 = y6 + y7,
        b7 = y6 - y7;
      const c0 = b0 + b2,
        c2 = b0 - b2,
        c1 = b1 + b3,
        c3 = b1 - b3,
        c4 = b4 + b6,
        c6 = b4 - b6,
        c5 = b5 + b7,
        c7 = b5 - b7;
      const k = 0.35355339059327373;
      const sd = (xl - xr) * 0.15; // keep a little of the stereo image
      const inA = x + sd;
      const inB = x - sd;
      const wm = w & m0;
      l0[wm] = (c0 + c4) * k + inA;
      l1[wm] = (c1 + c5) * k + inB;
      l2[wm] = (c2 + c6) * k - inA;
      l3[wm] = (c3 + c7) * k - inB;
      l4[wm] = (c0 - c4) * k + inA;
      l5[wm] = (c1 - c5) * k - inB;
      l6[wm] = (c2 - c6) * k + inA;
      l7[wm] = (c3 - c7) * k - inB;
      w = (w + 1) & m0;
      const nyL = oL * og + erL * erl;
      const nyR = oR * og + erR * erl;
      // linear interpolation back to the full rate
      outL[i] = (yL + nyL) * 0.5;
      outR[i] = (yR + nyR) * 0.5;
      yL = nyL;
      yR = nyR;
    }
    this.wpos = w;
    this.prePos = pp;
    this.diffPos[0] = dp0;
    this.diffPos[1] = dp1;
    this.diffPos[2] = dp2;
    this.diffPos[3] = dp3;
    this.phase = phase;
    this.x1L = x1L;
    this.x1R = x1R;
    this.x2L = x2L;
    this.x2R = x2R;
    this.accL = accL;
    this.accR = accR;
    this.yL = yL;
    this.yR = yR;
    for (let k = 0; k < 8; k++) if (Math.abs(damp[k]) < 1e-25) damp[k] = 0;
    this.hpf.processStereo(outL, outR, start, end);
    this.lpf.processStereo(outL, outR, start, end);
  }
}
