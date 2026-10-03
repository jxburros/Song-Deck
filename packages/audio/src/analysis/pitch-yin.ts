/**
 * YIN fundamental-frequency tracking (de Cheveigné & Kawahara 2002):
 * difference function (FFT cross-correlation + prefix energies), cumulative-mean
 * normalisation, absolute threshold, parabolic interpolation, voicing decision (aperiodicity
 * + level gate) and octave-error correction against the local median contour.
 */
import type { AudioData } from '../types';
import { getFFT } from './fft';
import { analysisDecimate, analysisMono, clamp01, nextPow2, percentile } from './util';

export interface PitchTrackOptions {
  /** Lowest f0 searched (Hz), default 50. */
  minHz?: number;
  /** Highest f0 searched (Hz), default 1000. */
  maxHz?: number;
  /** Frame hop (s), default 0.01. */
  hopSeconds?: number;
  /** YIN absolute threshold on the normalised difference (default 0.12). */
  threshold?: number;
  /** Frames whose best aperiodicity exceeds this are unvoiced (default 0.35). */
  voicingThreshold?: number;
  /** Frames quieter than this (dB below the loud 95th percentile) are unvoiced (default -40). */
  silenceDb?: number;
  /** Skip octave-error correction. */
  raw?: boolean;
}

export interface PitchTrack {
  /** Frame centre times (s). */
  times: Float32Array;
  /** f0 in Hz, 0 = unvoiced. */
  f0: Float32Array;
  /** Periodicity confidence 0..1 (1 − aperiodicity), 0 when unvoiced. */
  confidence: Float32Array;
  hopSeconds: number;
  /** Frame RMS (linear). */
  rms: Float32Array;
}

/** Pitch tracking on a raw mono signal. */
export function yinTrack(x: Float32Array, sr: number, opts: PitchTrackOptions = {}): PitchTrack {
  const minHz = Math.max(20, opts.minHz ?? 50);
  const maxHz = Math.min(sr * 0.45, Math.max(minHz * 1.5, opts.maxHz ?? 1000));
  const hop = Math.max(1, Math.round((opts.hopSeconds ?? 0.01) * sr));
  const thr = opts.threshold ?? 0.12;
  const voicing = opts.voicingThreshold ?? 0.35;
  const tauMin = Math.max(2, Math.floor(sr / maxHz));
  const tauMax = Math.max(tauMin + 2, Math.ceil(sr / minHz));
  const W = Math.max(tauMax, Math.round(0.02 * sr));
  const span = W + tauMax + 2;
  const N = nextPow2(span);
  const plan = getFFT(N);
  const nb = N / 2 + 1;
  const pad = span;
  const xp = new Float32Array(x.length + 2 * pad);
  xp.set(x, pad);
  const cs = new Float64Array(xp.length + 1);
  for (let i = 0; i < xp.length; i++) cs[i + 1] = cs[i] + xp[i] * xp[i];
  const frames = 1 + Math.floor(x.length / hop);
  const times = new Float32Array(frames);
  const f0 = new Float32Array(frames);
  const conf = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const aRe = new Float64Array(nb);
  const aIm = new Float64Array(nb);
  const bRe = new Float64Array(nb);
  const bIm = new Float64Array(nb);
  const r = new Float64Array(N);
  const d = new Float64Array(tauMax + 2);
  const dn = new Float64Array(tauMax + 2);
  const aperiodicity = new Float32Array(frames);
  const half = Math.round(span / 2);
  for (let t = 0; t < frames; t++) {
    const c = t * hop + pad;
    const s = c - half;
    times[t] = (t * hop) / sr;
    const e0 = cs[s + W] - cs[s];
    rms[t] = Math.sqrt(Math.max(0, cs[c + (W >> 1)] - cs[c - (W >> 1)]) / W);
    if (e0 <= 1e-10) {
      aperiodicity[t] = 1;
      continue;
    }
    plan.realForward(xp, aRe, aIm, undefined, s, W);
    plan.realForward(xp, bRe, bIm, undefined, s, W + tauMax + 1);
    // conj(A) * B
    for (let k = 0; k < nb; k++) {
      const re = aRe[k] * bRe[k] + aIm[k] * bIm[k];
      const im = aRe[k] * bIm[k] - aIm[k] * bRe[k];
      aRe[k] = re;
      aIm[k] = im;
    }
    plan.realInverse(aRe, aIm, r);
    d[0] = 0;
    dn[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      const e1 = cs[s + tau + W] - cs[s + tau];
      const v = Math.max(0, e0 + e1 - 2 * r[tau]);
      d[tau] = v;
      run += v;
      dn[tau] = run > 0 ? (v * tau) / run : 1;
    }
    // absolute threshold → first dip, then descend to its local minimum
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (dn[tau] < thr) {
        while (tau + 1 <= tauMax && dn[tau + 1] < dn[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let mv = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (dn[tau] < mv) {
          mv = dn[tau];
          best = tau;
        }
      }
    }
    let tauF = best;
    if (best > tauMin && best < tauMax) {
      const y0 = dn[best - 1];
      const y1 = dn[best];
      const y2 = dn[best + 1];
      const den = y0 - 2 * y1 + y2;
      if (den > 0) tauF = best + Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / den));
    }
    aperiodicity[t] = dn[best];
    f0[t] = sr / tauF;
    conf[t] = clamp01(1 - dn[best]);
  }
  // voicing: aperiodicity + level gate
  const loud = percentile(rms, 95);
  const gate = Math.max(1e-5, loud * Math.pow(10, (opts.silenceDb ?? -40) / 20));
  for (let t = 0; t < frames; t++) {
    if (aperiodicity[t] > voicing || rms[t] < gate || !(f0[t] > 0)) {
      f0[t] = 0;
      conf[t] = 0;
    }
  }
  if (!opts.raw) correctOctaves(f0, conf);
  return { times, f0, confidence: conf, hopSeconds: hop / sr, rms };
}

/** Fix isolated octave jumps against the local median pitch; drop voiced blips < 3 frames. */
export function correctOctaves(f0: Float32Array, conf: Float32Array, radius = 8): void {
  const n = f0.length;
  const midi = new Float32Array(n);
  for (let i = 0; i < n; i++) midi[i] = f0[i] > 0 ? 69 + 12 * Math.log2(f0[i] / 440) : NaN;
  const fixed = Float32Array.from(midi);
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i])) continue;
    win.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) if (!Number.isNaN(midi[j])) win.push(midi[j]);
    if (win.length < 5) continue;
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    const dv = midi[i] - med;
    if (Math.abs(dv - 12) < 2) fixed[i] = midi[i] - 12;
    else if (Math.abs(dv + 12) < 2) fixed[i] = midi[i] + 12;
    else if (Math.abs(dv - 19) < 1.5) fixed[i] = midi[i] - 19; // third-harmonic lock
  }
  for (let i = 0; i < n; i++) if (!Number.isNaN(fixed[i])) f0[i] = 440 * Math.pow(2, (fixed[i] - 69) / 12);
  // remove isolated voiced blips
  let i = 0;
  while (i < n) {
    if (f0[i] > 0) {
      let j = i;
      while (j < n && f0[j] > 0) j++;
      if (j - i < 3) for (let k = i; k < j; k++) {
        f0[k] = 0;
        conf[k] = 0;
      }
      i = j;
    } else i++;
  }
}

/** Choose an analysis rate high enough for `maxHz` (cheap decimation of the input). */
export function pitchAnalysisSignal(buf: AudioData, maxHz: number): { x: Float32Array; sr: number } {
  const mono = analysisMono(buf);
  const target = maxHz <= 1300 ? 11025 : 22050;
  const factor = Math.max(1, Math.round(buf.sampleRate / target));
  return factor > 1 ? { x: analysisDecimate(mono, factor), sr: buf.sampleRate / factor } : { x: mono, sr: buf.sampleRate };
}

/** Monophonic pitch track (YIN). */
export function trackPitch(buf: AudioData, opts: PitchTrackOptions = {}): PitchTrack {
  const maxHz = opts.maxHz ?? 1000;
  const { x, sr } = pitchAnalysisSignal(buf, maxHz);
  return yinTrack(x, sr, opts);
}

/** Median f0 (Hz) of the voiced frames, or 0. */
export function medianF0(track: PitchTrack): number {
  const v: number[] = [];
  for (let i = 0; i < track.f0.length; i++) if (track.f0[i] > 0) v.push(track.f0[i]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}
