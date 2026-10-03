/**
 * Tempo, beat and downbeat tracking.
 *
 *  1. Onset-strength envelope (onsets.ts).
 *  2. Global autocorrelation → comb-filtered periodicity evidence over a log BPM grid,
 *     weighted by a musical tempo prior (flat ≈ 95–150 BPM, log-Gaussian decay outside).
 *  3. Metrical-level check: if the half-beat positions of the chosen tempo are as strong as
 *     the beats (e.g. a backbeat snare landing "between" beats), the beat is twice as fast.
 *  4. Dynamic-programming beat tracking (Ellis 2007) and least-squares tempo refinement.
 *  5. Meter (3 vs 4) and downbeat phase from beat-synchronous accents: low-band onsets
 *     (kick), overall onset strength and spectral-change (harmony/timbre change at bar lines).
 */
import type { AudioData } from '../types';
import { getFFT } from './fft';
import { onsetEnvelopeFromSignal, type OnsetEnvelope } from './onsets';
import { clamp, clamp01, gaussianSmooth, mean, movingAverage, nextPow2, prepareMono, std } from './util';

export interface TempoOptions {
  minBpm?: number;
  maxBpm?: number;
  /** Centre of the tempo prior (default 120). */
  priorBpm?: number;
  /** Candidate meters (beats per bar), default [4, 3]. */
  meters?: number[];
}

export interface TempoResult {
  bpm: number;
  confidence: number;
  /** Beat times (s). */
  beats: number[];
  /** Downbeat (bar start) times (s), a subset of `beats`. */
  downbeats: number[];
  meter: { numerator: number; denominator: number };
  meterConfidence: number;
}

export interface TempoInternals extends TempoResult {
  /** Beat-synchronous accent per beat (z-scored combination). */
  accents: number[];
  /** Index (into beats) of the first downbeat. */
  downbeatPhase: number;
  /** Periodicity evidence of the chosen tempo (0..1). */
  periodicity: number;
}

const EMPTY: TempoInternals = {
  bpm: 120,
  confidence: 0,
  beats: [],
  downbeats: [],
  meter: { numerator: 4, denominator: 4 },
  meterConfidence: 0,
  accents: [],
  downbeatPhase: 0,
  periodicity: 0,
};

/** Estimate tempo, beats, meter and downbeats of a recording. */
export function detectTempo(buf: AudioData, opts: TempoOptions = {}): TempoResult {
  const { x, sr } = prepareMono(buf);
  if (x.length < sr) return { ...EMPTY, beats: [], downbeats: [] };
  const env = onsetEnvelopeFromSignal(x, sr);
  const r = tempoFromEnvelope(env, opts);
  return { bpm: r.bpm, confidence: r.confidence, beats: r.beats, downbeats: r.downbeats, meter: r.meter, meterConfidence: r.meterConfidence };
}

function autocorrelation(x: Float32Array): Float64Array {
  const n = x.length;
  const size = nextPow2(2 * n);
  const plan = getFFT(size);
  const re = new Float64Array(size / 2 + 1);
  const im = new Float64Array(size / 2 + 1);
  plan.realForward(x, re, im);
  for (let k = 0; k < re.length; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  const out = new Float64Array(size);
  plan.realInverse(re, im, out);
  return out.subarray(0, n);
}

function interp(a: ArrayLike<number>, pos: number): number {
  if (pos < 0) return 0;
  const i = Math.floor(pos);
  if (i + 1 >= a.length) return i < a.length ? a[i] : 0;
  const f = pos - i;
  return a[i] * (1 - f) + a[i + 1] * f;
}

/** Musical tempo prior: flat in the "tactus" region, log-Gaussian outside. */
export function tempoPrior(bpm: number, center = 120): number {
  const d = Math.abs(Math.log2(bpm / center));
  const e = Math.max(0, d - 0.32);
  return Math.exp(-0.5 * (e / 0.45) ** 2);
}

interface TempoCandidate {
  bpm: number;
  evidence: number;
  score: number;
}

function periodicityEvidence(acf: Float64Array, lag: number): number {
  let s = 0;
  let w = 0;
  for (let k = 1; k <= 4; k++) {
    const p = lag * k;
    if (p >= acf.length - 1) break;
    // tolerate small drift: max over ±1 frame per multiple
    const v = Math.max(interp(acf, p - 1), interp(acf, p), interp(acf, p + 1));
    s += v / k;
    w += 1 / k;
  }
  return w > 0 ? s / w : 0;
}

function scanTempi(acf: Float64Array, fps: number, minBpm: number, maxBpm: number, prior: number): TempoCandidate[] {
  const out: TempoCandidate[] = [];
  const step = 1.003;
  for (let bpm = minBpm; bpm <= maxBpm; bpm *= step) {
    const lag = (60 * fps) / bpm;
    const ev = Math.max(0, periodicityEvidence(acf, lag));
    out.push({ bpm, evidence: ev, score: ev * tempoPrior(bpm, prior) });
  }
  return out;
}

/** Ellis-style dynamic-programming beat tracker; returns beat frame indices. */
export function trackBeats(onset: Float32Array, periodFrames: number, tightness = 100): number[] {
  const n = onset.length;
  if (n < 4 || !(periodFrames > 1)) return [];
  const sd = std(onset) || 1;
  // local score: onset envelope smoothed by a Gaussian of width ~period/32
  const local = gaussianSmooth(
    Array.from(onset, (v) => v / sd),
    Math.max(0.5, periodFrames / 32),
  );
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(periodFrames / 2);
  const hi = Math.round(periodFrames * 2);
  const logP = Math.log(periodFrames);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bi = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const d = Math.log(t - tau) - logP;
      const s = cum[tau] - tightness * d * d;
      if (s > best) {
        best = s;
        bi = tau;
      }
    }
    cum[t] = local[t] + (bi >= 0 && best > 0 ? best : 0);
    back[t] = bi >= 0 && best > 0 ? bi : -1;
  }
  // last beat: highest cumulative score within the final period
  let last = n - 1;
  let bestV = -Infinity;
  for (let t = Math.max(0, n - Math.ceil(periodFrames)); t < n; t++) {
    if (cum[t] > bestV) {
      bestV = cum[t];
      last = t;
    }
  }
  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();
  // trim weak leading/trailing beats (silence before/after the music)
  const vals = beats.map((b) => local[b]);
  const thr = 0.5 * Math.sqrt(mean(vals.map((v) => v * v)));
  let a = 0;
  let b = beats.length - 1;
  while (a < b && local[beats[a]] < thr) a++;
  while (b > a && local[beats[b]] < thr) b--;
  return beats.slice(a, b + 1);
}

function strengthNear(env: ArrayLike<number>, pos: number, radius: number): number {
  let m = 0;
  const a = Math.max(0, Math.round(pos - radius));
  const b = Math.min(env.length - 1, Math.round(pos + radius));
  for (let i = a; i <= b; i++) if (env[i] > m) m = env[i];
  return m;
}

/** Mean onset strength at beats vs. halfway between beats. */
function midBeatRatio(env: Float32Array, beats: number[]): number {
  if (beats.length < 4) return 0;
  let on = 0;
  let mid = 0;
  let n = 0;
  for (let i = 0; i + 1 < beats.length; i++) {
    on += strengthNear(env, beats[i], 1);
    mid += strengthNear(env, (beats[i] + beats[i + 1]) / 2, 1);
    n++;
  }
  return on > 1e-9 ? mid / on : 0;
}

/** Least-squares beat period (frames) from beat positions. */
function regressPeriod(beats: number[]): number {
  const n = beats.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(beats);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (beats[i] - my);
    sxx += (i - mx) * (i - mx);
  }
  return sxx > 0 ? sxy / sxx : 0;
}

/** Re-anchor tracked beats to a strictly regular grid when the tempo is steady. */
function regularize(beats: number[], period: number, env: Float32Array): number[] {
  if (beats.length < 4) return beats;
  // residuals from a straight line
  const n = beats.length;
  const my = mean(beats);
  const mx = (n - 1) / 2;
  const intercept = my - period * mx;
  let maxRes = 0;
  for (let i = 0; i < n; i++) maxRes = Math.max(maxRes, Math.abs(beats[i] - (intercept + period * i)));
  if (maxRes > period * 0.12) return beats; // expressive timing: keep the tracked beats
  // steady: fine-tune the phase on the envelope, then emit the grid
  let bestOff = 0;
  let bestS = -Infinity;
  for (let off = -2; off <= 2; off += 0.25) {
    let s = 0;
    for (let i = 0; i < n; i++) s += interp(env, intercept + off + period * i);
    if (s > bestS) {
      bestS = s;
      bestOff = off;
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(intercept + bestOff + period * i);
  return out;
}

/** Spectral-change novelty between consecutive beat intervals (harmony/timbre change at bar lines). */
function beatChange(_env: OnsetEnvelope, beats: number[], bandProfile?: (t: number) => Float32Array): number[] {
  if (!bandProfile || beats.length < 3) return beats.map(() => 0);
  const prof: Float32Array[] = [];
  for (let i = 0; i + 1 < beats.length; i++) prof.push(bandProfile(i));
  const out: number[] = [0];
  for (let i = 1; i < beats.length; i++) {
    const a = prof[i - 1];
    const b = prof[Math.min(prof.length - 1, i)];
    let d = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < a.length; k++) {
      d += a[k] * b[k];
      na += a[k] * a[k];
      nb += b[k] * b[k];
    }
    out.push(na > 0 && nb > 0 ? 1 - d / Math.sqrt(na * nb) : 0);
  }
  // the first and last beats have no complete neighbouring interval: make them neutral
  if (out.length > 3) {
    const inner = out.slice(1, -1).sort((x, y) => x - y);
    const med = inner[inner.length >> 1];
    out[0] = med;
    out[out.length - 1] = med;
  }
  return out;
}

function zscore(a: number[]): number[] {
  const m = mean(a);
  const s = std(a);
  return a.map((v) => (s > 1e-9 ? (v - m) / s : 0));
}

export interface MeterEstimate {
  numerator: number;
  phase: number;
  confidence: number;
}

/** Meter and downbeat phase from per-beat accents (higher accent ⇒ more likely a downbeat). */
export function estimateMeter(accents: number[], meters: number[] = [4, 3]): MeterEstimate {
  const n = accents.length;
  if (n < 6) return { numerator: 4, phase: 0, confidence: 0 };
  const results: { m: number; phase: number; score: number }[] = [];
  for (const m of meters) {
    if (n < 2 * m) continue;
    let best = -Infinity;
    let bestPhase = 0;
    for (let ph = 0; ph < m; ph++) {
      let on = 0;
      let non = 0;
      let off = 0;
      let noff = 0;
      for (let i = 0; i < n; i++) {
        if ((i - ph) % m === 0) {
          on += accents[i];
          non++;
        } else {
          off += accents[i];
          noff++;
        }
      }
      // tiny tie-break: music usually starts on a downbeat (the first tracked beat is a strong beat)
      const s = (non ? on / non : 0) - (noff ? off / noff : 0) + (ph === 0 ? 0.05 : 0);
      if (s > best) {
        best = s;
        bestPhase = ph;
      }
    }
    // mild prior for 4/4 (most popular music)
    results.push({ m, phase: bestPhase, score: best + (m === 4 ? 0.15 : 0) });
  }
  if (!results.length) return { numerator: 4, phase: 0, confidence: 0 };
  results.sort((a, b) => b.score - a.score);
  const top = results[0];
  const second = results[1]?.score ?? 0;
  const contrast = clamp01(top.score / 2);
  const margin = clamp01((top.score - second) / 0.8);
  return { numerator: top.m, phase: top.phase, confidence: clamp01(0.15 + 0.45 * contrast + 0.4 * margin) };
}

/** Mean (per-band, mean-removed) log-band profile of each inter-beat interval. */
function logBandProfile(env: OnsetEnvelope, beats: number[]): ((i: number) => Float32Array) | undefined {
  if (!env.logBands || !env.numBands || beats.length < 3) return undefined;
  const nb = env.numBands;
  const frames = env.numFrames;
  const bandMean = new Float32Array(nb);
  for (let t = 0; t < frames; t++) for (let b = 0; b < nb; b++) bandMean[b] += env.logBands[t * nb + b] / frames;
  return (i: number) => {
    const a = Math.max(0, Math.round(beats[i]));
    const e = Math.min(frames, Math.max(a + 1, Math.round(beats[Math.min(beats.length - 1, i + 1)])));
    const out = new Float32Array(nb);
    for (let t = a; t < e; t++) for (let b = 0; b < nb; b++) out[b] += env.logBands[t * nb + b] - bandMean[b];
    for (let b = 0; b < nb; b++) out[b] /= e - a;
    return out;
  };
}

/**
 * Tempo/beat/meter analysis on a precomputed onset envelope. `bandProfile(i)` (optional)
 * returns a feature vector (e.g. chroma) for the interval between beat i and i+1, used as the
 * harmonic-change cue for downbeats.
 */
export function tempoFromEnvelope(
  env: OnsetEnvelope,
  opts: TempoOptions & { bandProfileForBeats?: (beatsSeconds: number[]) => (i: number) => Float32Array } = {},
): TempoInternals {
  const o = env.envelope;
  const n = o.length;
  const fps = 1 / env.hopSeconds;
  const minBpm = opts.minBpm ?? 50;
  const maxBpm = opts.maxBpm ?? 220;
  const prior = opts.priorBpm ?? 120;
  if (n < fps * 1.5 || std(o) < 1e-6) return { ...EMPTY, beats: [], downbeats: [], accents: [] };

  // detrended, lightly smoothed envelope for periodicity analysis
  const sm = gaussianSmooth(o, 1);
  const trend = movingAverage(sm, Math.round(fps * 0.75));
  const det = new Float32Array(n);
  for (let i = 0; i < n; i++) det[i] = Math.max(0, sm[i] - trend[i]);
  const acfRaw = autocorrelation(det);
  const r0 = acfRaw[0] || 1;
  // unbiased-ish normalisation: correct for the shrinking overlap
  const acf = new Float64Array(acfRaw.length);
  for (let i = 0; i < acf.length; i++) acf[i] = (acfRaw[i] / r0) * (n / Math.max(n - i, n * 0.5));

  const cands = scanTempi(acf, fps, minBpm, maxBpm, prior);
  let best = cands[0];
  for (const c of cands) if (c.score > best.score) best = c;
  let bpm = best.bpm;

  // metrical-level check (half-beat positions as strong as the beats ⇒ tempo is double)
  let period = (60 * fps) / bpm;
  let beats = trackBeats(o, period);
  for (let iter = 0; iter < 2; iter++) {
    const ratio = midBeatRatio(o, beats);
    const doubled = bpm * 2;
    if (ratio > 0.62 && doubled <= Math.min(maxBpm, 200)) {
      const evDouble = periodicityEvidence(acf, (60 * fps) / doubled);
      if (evDouble > 0.25 * best.evidence) {
        bpm = doubled;
        period = (60 * fps) / bpm;
        beats = trackBeats(o, period);
        continue;
      }
    }
    break;
  }

  // refine tempo from the beat positions
  const reg = regressPeriod(beats);
  if (reg > 0 && Math.abs(reg - period) / period < 0.08) period = reg;
  bpm = (60 * fps) / period;
  beats = regularize(beats, period, o);
  const beatTimes = beats.map((b) => Math.max(0, b * env.hopSeconds));

  // confidence
  const periodicity = clamp01(periodicityEvidence(acf, period));
  const ibis: number[] = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  const regularity = ibis.length > 2 ? clamp01(1 - std(ibis) / (mean(ibis) || 1) / 0.15) : 0;
  const onBeat = beats.length ? mean(beats.map((b) => strengthNear(o, b, 1))) : 0;
  const contrast = clamp01((onBeat - mean(o)) / (std(o) * 3 || 1));
  const coverage = clamp01((beats.length * period) / Math.max(1, n));
  const confidence = clamp01((0.45 * Math.tanh(2.5 * periodicity) + 0.3 * contrast + 0.25 * regularity) * (0.6 + 0.4 * coverage));

  // accents for meter / downbeats (window sums: robust to the sub-frame position of each beat)
  const winSum = (a: Float32Array, b: number): number => {
    const c = Math.round(b);
    let v = 0;
    for (let i = c - 1; i <= c + 2; i++) if (i >= 0 && i < a.length) v += a[i];
    return v;
  };
  const low = beats.map((b) => winSum(env.lowEnvelope, b));
  const all = beats.map((b) => winSum(o, b));
  const loud = beats.map((b) => {
    let m = 0;
    for (let i = Math.round(b) - 1; i <= Math.round(b) + 3; i++) if (i >= 0 && i < env.energy.length && env.energy[i] > m) m = env.energy[i];
    return Math.log(m + 1e-12);
  });
  const profile = opts.bandProfileForBeats ? opts.bandProfileForBeats(beatTimes) : logBandProfile(env, beats);
  const change = beatChange(env, beats, profile);
  const zl = zscore(low);
  const za = zscore(all);
  const zc = zscore(change);
  const zv = zscore(loud);
  const accents = beats.map((_, i) => 0.8 * zl[i] + 0.5 * za[i] + 0.8 * zc[i] + 0.6 * zv[i]);
  const meterEst = estimateMeter(accents, opts.meters ?? [4, 3]);
  const downbeats: number[] = [];
  for (let i = meterEst.phase; i < beatTimes.length; i += meterEst.numerator) downbeats.push(beatTimes[i]);

  return {
    bpm: Math.round(bpm * 100) / 100,
    confidence: beats.length >= 4 ? confidence : confidence * 0.3,
    beats: beatTimes,
    downbeats,
    meter: { numerator: meterEst.numerator, denominator: 4 },
    meterConfidence: meterEst.confidence,
    accents,
    downbeatPhase: meterEst.phase,
    periodicity,
  };
}

/** BPM implied by a list of beat times (least squares). */
export function beatsToBpm(beats: number[]): number {
  const p = regressPeriod(beats);
  return p > 0 ? 60 / p : 0;
}

/** Extend a beat grid backwards/forwards to cover [0, duration] with the same period. */
export function extendBeatGrid(beats: number[], bpm: number, duration: number): number[] {
  const period = 60 / bpm;
  if (!beats.length) {
    const out: number[] = [];
    for (let t = 0; t < duration; t += period) out.push(t);
    return out;
  }
  const out = [...beats];
  let t = beats[0] - period;
  while (t >= -1e-6) {
    out.unshift(Math.max(0, t));
    t -= period;
  }
  t = beats[beats.length - 1] + period;
  while (t < duration) {
    out.push(t);
    t += period;
  }
  return out;
}

export function clampBpm(bpm: number): number {
  return clamp(bpm, 20, 400);
}
