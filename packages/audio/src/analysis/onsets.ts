/**
 * Onset detection: log-compressed band-energy spectral flux (SuperFlux-style max filter) with
 * adaptive-threshold peak picking.
 */
import type { AudioData } from '../types';
import { bandEnergies, logBandFlux, logFilterbank } from './features';
import { magnitudeSpectrogram } from './stft';
import { clamp, maxOf, percentile, pow2ForDuration, prepareMono } from './util';

export interface OnsetEnvelope {
  /** Onset strength per frame, normalised so the 99.5th percentile ≈ 1. */
  envelope: Float32Array;
  /** Onset strength from the low bands only (≈ kick drum accents). */
  lowEnvelope: Float32Array;
  /** Onset strength from the high bands only (≈ hats / cymbals). */
  highEnvelope: Float32Array;
  /** Frame energy (sum of band powers, linear). */
  energy: Float32Array;
  /** Log-compressed band energies, frame-major [frame * numBands + band] (timbre/harmony change cues). */
  logBands: Float32Array;
  numBands: number;
  hop: number;
  hopSeconds: number;
  sampleRate: number;
  numFrames: number;
}

export interface OnsetEnvelopeOptions {
  /** Frame hop (default ≈ 11.6 ms). */
  hopSeconds?: number;
  /** Window length (default ≈ 46 ms). */
  windowSeconds?: number;
  numBands?: number;
  minHz?: number;
  maxHz?: number;
}

/** Frames by which the flux peak precedes the true onset (window leading-edge effect), compensated. */
const ALIGN_FRAMES = 1;

export function onsetEnvelopeFromSignal(x: Float32Array, sr: number, opts: OnsetEnvelopeOptions = {}): OnsetEnvelope {
  const fftSize = pow2ForDuration(opts.windowSeconds ?? 0.046, sr, 256, 8192);
  const hop = Math.max(1, Math.round((opts.hopSeconds ?? 0.0116) * sr));
  const spec = magnitudeSpectrogram(x, sr, { fftSize, hop });
  const numBands = opts.numBands ?? 40;
  const fb = logFilterbank(numBands, opts.minHz ?? 30, Math.min(opts.maxHz ?? 11000, sr * 0.48), fftSize, sr, false);
  const bands = bandEnergies(spec, fb);
  const frames = spec.numFrames;
  const energy = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let s = 0;
    for (let b = 0; b < numBands; b++) s += bands[t * numBands + b];
    energy[t] = s;
  }
  // log compression relative to the loud end of the signal
  const ref = Math.max(1e-12, percentile(bands, 99.5));
  const gamma = 1e4 / ref;
  const logBands = new Float32Array(bands.length);
  for (let i = 0; i < bands.length; i++) logBands[i] = Math.log1p(gamma * bands[i]);
  const flux = logBandFlux(logBands, numBands, frames, 1, true);
  // sub-band fluxes
  let lowCount = 0;
  let highStart = numBands;
  for (let b = 0; b < numBands; b++) {
    if (fb.centers[b] < 150) lowCount = b + 1;
    if (fb.centers[b] >= 5000 && highStart === numBands) highStart = b;
  }
  lowCount = Math.max(1, lowCount);
  const low = new Float32Array(frames);
  const high = new Float32Array(frames);
  for (let t = 1; t < frames; t++) {
    const o = t * numBands;
    const p = (t - 1) * numBands;
    let s = 0;
    for (let b = 0; b < lowCount; b++) {
      const d = logBands[o + b] - logBands[p + b];
      if (d > 0) s += d;
    }
    low[t] = s / lowCount;
    let h = 0;
    for (let b = highStart; b < numBands; b++) {
      const d = logBands[o + b] - logBands[p + b];
      if (d > 0) h += d;
    }
    high[t] = highStart < numBands ? h / (numBands - highStart) : 0;
  }
  const shift = (a: Float32Array): Float32Array => {
    if (ALIGN_FRAMES <= 0) return a;
    const out = new Float32Array(a.length);
    for (let t = 0; t + ALIGN_FRAMES < a.length; t++) out[t + ALIGN_FRAMES] = a[t];
    return out;
  };
  const norm = (a: Float32Array): Float32Array => {
    const p = percentile(a, 99.5);
    const m = maxOf(a);
    const s = p > 1e-9 ? p : m > 1e-9 ? m : 1;
    for (let i = 0; i < a.length; i++) a[i] = a[i] / s;
    return a;
  };
  return {
    envelope: norm(shift(flux)),
    lowEnvelope: norm(shift(low)),
    highEnvelope: norm(shift(high)),
    energy,
    logBands,
    numBands,
    hop,
    hopSeconds: hop / sr,
    sampleRate: sr,
    numFrames: frames,
  };
}

export interface PeakPickOptions {
  /** Seconds. */
  preMax?: number;
  postMax?: number;
  preAvg?: number;
  postAvg?: number;
  /** Threshold above the local mean (envelope units, envelope ≈ 0..1). */
  delta?: number;
  /** Minimum time between onsets (s). */
  wait?: number;
  /** Absolute floor (envelope units). */
  floor?: number;
}

/** Adaptive-threshold peak picking (Böck et al.); returns frame indices. */
export function pickOnsetPeaks(env: ArrayLike<number>, hopSeconds: number, o: PeakPickOptions = {}): number[] {
  const f = (s: number): number => Math.max(0, Math.round(s / hopSeconds));
  const preMax = f(o.preMax ?? 0.03);
  const postMax = Math.max(1, f(o.postMax ?? 0.03));
  const preAvg = f(o.preAvg ?? 0.1);
  const postAvg = f(o.postAvg ?? 0.07);
  const delta = o.delta ?? 0.06;
  const wait = f(o.wait ?? 0.03);
  const floor = o.floor ?? 0.04;
  const n = env.length;
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + env[i];
  const out: number[] = [];
  let last = -Infinity;
  for (let t = 1; t < n; t++) {
    const v = env[t];
    if (v < floor) continue;
    let isMax = true;
    for (let j = Math.max(0, t - preMax); j <= Math.min(n - 1, t + postMax); j++) {
      if (env[j] > v || (env[j] === v && j < t)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const a = Math.max(0, t - preAvg);
    const b = Math.min(n, t + postAvg + 1);
    const avg = (cs[b] - cs[a]) / (b - a);
    if (v < avg + delta) continue;
    if (t - last <= wait) continue;
    out.push(t);
    last = t;
  }
  return out;
}

export interface OnsetOptions extends OnsetEnvelopeOptions, PeakPickOptions {
  /** Sensitivity 0..1 (default 0.5); maps to the peak-picking threshold. */
  sensitivity?: number;
}

export interface OnsetResult {
  times: number[];
  strengths: number[];
  envelope: Float32Array;
  hopSeconds: number;
}

/** Detect note/drum onsets (seconds). */
export function detectOnsets(buf: AudioData, opts: OnsetOptions = {}): OnsetResult {
  const { x, sr } = prepareMono(buf);
  if (x.length === 0) return { times: [], strengths: [], envelope: new Float32Array(0), hopSeconds: opts.hopSeconds ?? 0.0116 };
  const env = onsetEnvelopeFromSignal(x, sr, opts);
  const sens = clamp(opts.sensitivity ?? 0.5, 0, 1);
  const peaks = pickOnsetPeaks(env.envelope, env.hopSeconds, {
    ...opts,
    delta: opts.delta ?? 0.12 - 0.1 * sens,
    floor: opts.floor ?? 0.08 - 0.06 * sens,
  });
  return {
    times: peaks.map((t) => t * env.hopSeconds),
    strengths: peaks.map((t) => Math.min(1, env.envelope[t])),
    envelope: env.envelope,
    hopSeconds: env.hopSeconds,
  };
}
