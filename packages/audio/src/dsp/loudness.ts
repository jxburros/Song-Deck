/**
 * Loudness measurement — ITU-R BS.1770-4 / EBU R128 (Tech 3341/3342).
 *
 *  - K-weighting (pre-filter shelf + RLB high-pass) derived for ANY sample rate from the analog
 *    prototypes exactly as libebur128 does (identical to the BS.1770 48 kHz coefficients at 48 kHz).
 *  - Momentary: 400 ms blocks, 75 % overlap (100 ms hop). Short-term: 3 s window, 100 ms hop.
 *  - Integrated: absolute gate -70 LUFS, relative gate -10 LU (energy domain).
 *  - LRA (Tech 3342): 3 s short-term blocks (1 s hop, as libebur128), absolute gate -70 LUFS,
 *    relative gate -20 LU, L95 − L10 (nearest-rank percentiles).
 *  - True peak: 4× polyphase FIR oversampling (Kaiser-windowed sinc, 16 taps per phase,
 *    per-phase unity DC gain) — the max of |x| over the original and 3 interpolated phases.
 *
 * All dB results are finite (floored at -144) so reports survive JSON round trips.
 */
import type { AudioData } from '../types';
import { MIN_DB, kaiser, sinc } from './utils';

export interface LoudnessReport {
  integratedLufs: number;
  shortTermMaxLufs: number;
  momentaryMaxLufs: number;
  truePeakDb: number;
  samplePeakDb: number;
  /** Loudness range in LU. */
  lra: number;
}

export interface KWeighting {
  shelf: [number, number, number, number, number];
  highpass: [number, number, number, number, number];
}

/** K-weighting biquads [b0, b1, b2, a1, a2] for `sampleRate` (libebur128 derivation). */
export function kWeightingCoefficients(sampleRate: number): KWeighting {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: [number, number, number, number, number] = [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  ];
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highpass: [number, number, number, number, number] = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return { shelf, highpass };
}

const LUFS_OFFSET = -0.691;

function energyToLufs(e: number): number {
  return e > 0 ? LUFS_OFFSET + 10 * Math.log10(e) : MIN_DB;
}

// ---------------------------------------------------------------------------
// True peak interpolator
// ---------------------------------------------------------------------------

const TP_TAPS = 16; // per phase
const TP_HALF = TP_TAPS / 2;
const TP_CUTOFF = 0.95;
/** TP_PHASES[p][k] for fractional offsets (p+1)/4, taps at n - 7 .. n + 8. */
const TP_PHASES: Float64Array[] = (() => {
  const phases: Float64Array[] = [];
  const beta = 8;
  for (let p = 1; p <= 3; p++) {
    const frac = p / 4;
    const h = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      const t = k - (TP_HALF - 1) - frac; // tap position relative to the interpolation point
      const v = TP_CUTOFF * sinc(TP_CUTOFF * t) * kaiser(t, TP_TAPS, beta);
      h[k] = v;
      sum += v;
    }
    for (let k = 0; k < TP_TAPS; k++) h[k] /= sum;
    phases.push(h);
  }
  return phases;
})();

/**
 * Per-sample true-peak magnitude: out[n] = max(|x[n]|, |x̂(n + 1/4)|, |x̂(n + 1/2)|, |x̂(n + 3/4)|).
 */
export function truePeakEnvelope(x: ArrayLike<number>, out: Float64Array): void {
  const n = x.length;
  const h0 = TP_PHASES[0], h1 = TP_PHASES[1], h2 = TP_PHASES[2];
  for (let i = 0; i < n; i++) {
    let m = Math.abs(x[i]);
    const base = i - (TP_HALF - 1);
    let s0 = 0, s1 = 0, s2 = 0;
    if (base >= 0 && base + TP_TAPS <= n) {
      for (let k = 0; k < TP_TAPS; k++) {
        const v = x[base + k];
        s0 += h0[k] * v;
        s1 += h1[k] * v;
        s2 += h2[k] * v;
      }
    } else {
      for (let k = 0; k < TP_TAPS; k++) {
        const j = base + k;
        if (j < 0 || j >= n) continue;
        const v = x[j];
        s0 += h0[k] * v;
        s1 += h1[k] * v;
        s2 += h2[k] * v;
      }
    }
    const a0 = Math.abs(s0), a1 = Math.abs(s1), a2 = Math.abs(s2);
    if (a0 > m) m = a0;
    if (a1 > m) m = a1;
    if (a2 > m) m = a2;
    out[i] = m;
  }
}

/** Linear true-peak value of one channel. */
export function truePeakLinear(x: ArrayLike<number>): number {
  const n = x.length;
  const h0 = TP_PHASES[0], h1 = TP_PHASES[1], h2 = TP_PHASES[2];
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  // Only interpolate where the neighbourhood can exceed the current max: interpolated values are
  // bounded by Σ|h| · (local max), so blocks whose 3-block neighbourhood is below m/Σ|h| are skipped.
  const B = TP_TAPS;
  const nb = Math.ceil(n / B);
  const bmax = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let mm = 0;
    const e = Math.min(n, (b + 1) * B);
    for (let i = b * B; i < e; i++) {
      const a = Math.abs(x[i]);
      if (a > mm) mm = a;
    }
    bmax[b] = mm;
  }
  for (let b = 0; b < nb; b++) {
    const local = Math.max(bmax[b], b > 0 ? bmax[b - 1] : 0, b + 1 < nb ? bmax[b + 1] : 0);
    if (local * TP_SUM_ABS < m) continue;
    const e = Math.min(n, (b + 1) * B);
    for (let i = b * B; i < e; i++) {
      const base = i - (TP_HALF - 1);
      let s0 = 0, s1 = 0, s2 = 0;
      if (base >= 0 && base + TP_TAPS <= n) {
        for (let k = 0; k < TP_TAPS; k++) {
          const v = x[base + k];
          s0 += h0[k] * v;
          s1 += h1[k] * v;
          s2 += h2[k] * v;
        }
      } else {
        for (let k = 0; k < TP_TAPS; k++) {
          const j = base + k;
          if (j < 0 || j >= n) continue;
          const v = x[j];
          s0 += h0[k] * v;
          s1 += h1[k] * v;
          s2 += h2[k] * v;
        }
      }
      const a = Math.max(Math.abs(s0), Math.abs(s1), Math.abs(s2));
      if (a > m) m = a;
    }
  }
  return m;
}

const TP_SUM_ABS = (() => {
  let s = 0;
  for (const h of TP_PHASES) {
    let t = 0;
    for (let k = 0; k < TP_TAPS; k++) t += Math.abs(h[k]);
    s = Math.max(s, t);
  }
  return s;
})();

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Per-100 ms K-weighted energy sums (channel weights applied). */
function segmentEnergies(buf: AudioData): { seg: Float64Array; segLen: number } {
  const sr = buf.sampleRate;
  const segLen = Math.max(1, Math.round(sr / 10));
  const n = buf.channels[0]?.length ?? 0;
  const nseg = Math.floor(n / segLen);
  const seg = new Float64Array(nseg);
  const { shelf, highpass } = kWeightingCoefficients(sr);
  const [sb0, sb1, sb2, sa1, sa2] = shelf;
  const [hb0, hb1, hb2, ha1, ha2] = highpass;
  for (const ch of buf.channels.slice(0, 2)) {
    // channel weight 1.0 for L/R/mono
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let s = 0; s < nseg; s++) {
      let acc = 0;
      const end = (s + 1) * segLen;
      for (let i = s * segLen; i < end; i++) {
        const x = ch[i];
        const y = sb0 * x + sb1 * x1 + sb2 * x2 - sa1 * y1 - sa2 * y2;
        x2 = x1;
        x1 = x;
        const z = hb0 * y + hb1 * y1 + hb2 * y2 - ha1 * z1 - ha2 * z2;
        y2 = y1;
        y1 = y;
        z2 = z1;
        z1 = z;
        acc += z * z;
      }
      seg[s] += acc;
    }
  }
  return { seg, segLen };
}

/** Windowed mean-square energies: window of `w` segments, hop `hop` segments. */
function windowEnergies(seg: Float64Array, segLen: number, w: number, hop: number): Float64Array {
  if (seg.length < w) return new Float64Array(0);
  const count = Math.floor((seg.length - w) / hop) + 1;
  const out = new Float64Array(count);
  for (let b = 0; b < count; b++) {
    let s = 0;
    for (let k = 0; k < w; k++) s += seg[b * hop + k];
    out[b] = s / (w * segLen);
  }
  return out;
}

function gatedMean(energies: Float64Array, relativeLu: number): { mean: number; kept: number[] } {
  const absGate = Math.pow(10, (-70 - LUFS_OFFSET) / 10);
  let sum = 0;
  let cnt = 0;
  for (const e of energies) {
    if (e > absGate) {
      sum += e;
      cnt++;
    }
  }
  if (cnt === 0) return { mean: 0, kept: [] };
  const relGate = (sum / cnt) * Math.pow(10, relativeLu / 10);
  const kept: number[] = [];
  sum = 0;
  for (const e of energies) {
    if (e > absGate && e > relGate) {
      sum += e;
      kept.push(e);
    }
  }
  return { mean: kept.length ? sum / kept.length : 0, kept };
}

export function measureLoudness(buf: AudioData): LoudnessReport {
  const { seg, segLen } = segmentEnergies(buf);
  let momentary = windowEnergies(seg, segLen, 4, 1);
  if (momentary.length === 0 && seg.length > 0) {
    // shorter than 400 ms: one zero-padded block
    let s = 0;
    for (const e of seg) s += e;
    momentary = Float64Array.of(s / (4 * segLen));
  }
  const shortTerm = windowEnergies(seg, segLen, 30, 1);
  const lraBlocks = windowEnergies(seg, segLen, 30, 10);

  const integ = gatedMean(momentary, -10);
  let mMax = 0;
  for (const e of momentary) if (e > mMax) mMax = e;
  let sMax = 0;
  for (const e of shortTerm) if (e > sMax) sMax = e;

  let lra = 0;
  const lg = gatedMean(lraBlocks, -20);
  if (lg.kept.length > 1) {
    const ls = lg.kept.map(energyToLufs).sort((a, b) => a - b);
    const n = ls.length;
    const lo = ls[Math.round((n - 1) * 0.1)];
    const hi = ls[Math.round((n - 1) * 0.95)];
    lra = Math.max(0, hi - lo);
  }

  let sp = 0;
  let tp = 0;
  for (const ch of buf.channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > sp) sp = a;
    }
    tp = Math.max(tp, truePeakLinear(ch));
  }
  const toDb = (g: number): number => (g > 6.31e-8 ? 20 * Math.log10(g) : MIN_DB);
  return {
    integratedLufs: integ.kept.length ? energyToLufs(integ.mean) : MIN_DB,
    shortTermMaxLufs: shortTerm.length ? energyToLufs(sMax) : momentary.length ? energyToLufs(mMax) : MIN_DB,
    momentaryMaxLufs: momentary.length ? energyToLufs(mMax) : MIN_DB,
    truePeakDb: toDb(tp),
    samplePeakDb: toDb(sp),
    lra,
  };
}

/** Integrated loudness only (fast path used by the mastering loop). */
export function integratedLoudness(buf: AudioData): number {
  const { seg, segLen } = segmentEnergies(buf);
  let momentary = windowEnergies(seg, segLen, 4, 1);
  if (momentary.length === 0 && seg.length > 0) {
    let s = 0;
    for (const e of seg) s += e;
    momentary = Float64Array.of(s / (4 * segLen));
  }
  const g = gatedMean(momentary, -10);
  return g.kept.length ? energyToLufs(g.mean) : MIN_DB;
}
