/**
 * Chromagram from interpolated spectral peaks with tuning estimation, plus a bass chroma
 * (peaks below ~250 Hz) used for chord roots and key tonic evidence.
 */
import type { AudioData } from '../types';
import { forEachStftFrame } from './stft';
import { clamp, pow2ForDuration, prepareMono } from './util';

export interface ChromaOptions {
  /** Frame hop in seconds (default ≈ 0.046). */
  hopSeconds?: number;
  /** Analysis window in seconds (default ≈ 0.186 → 4096 samples at 22.05 kHz). */
  windowSeconds?: number;
  minHz?: number;
  maxHz?: number;
  /** Upper limit of the bass chroma (Hz). */
  bassMaxHz?: number;
  /** Estimate and compensate the global tuning (default true). */
  tuning?: boolean;
}

export interface ChromaResult {
  /** 12-bin chroma per frame (C = 0), energy-weighted (not normalised). */
  frames: Float32Array[];
  /** 12-bin bass chroma per frame. */
  bassFrames: Float32Array[];
  hopSeconds: number;
  /** Estimated deviation of the recording's tuning from A440, cents. */
  tuningCents: number;
  /** Per-frame spectral energy (linear power). */
  energy: Float32Array;
}

interface FramePeaks {
  pitch: Float32Array;
  amp: Float32Array;
}

/** Interpolated spectral peaks of one magnitude frame. */
export function framePeaks(
  mag: ArrayLike<number>,
  offset: number,
  numBins: number,
  binHz: number,
  kMin: number,
  kMax: number,
  threshold: number,
  maxPeaks = 120,
): { freq: number[]; amp: number[] } {
  const freq: number[] = [];
  const amp: number[] = [];
  for (let k = Math.max(1, kMin); k < Math.min(numBins - 1, kMax); k++) {
    const b = mag[offset + k];
    if (b <= threshold) continue;
    const a = mag[offset + k - 1];
    const c = mag[offset + k + 1];
    if (!(b > a && b >= c)) continue;
    const la = Math.log(a + 1e-12);
    const lb = Math.log(b);
    const lc = Math.log(c + 1e-12);
    const den = la - 2 * lb + lc;
    const d = den < 0 ? clamp((0.5 * (la - lc)) / den, -0.5, 0.5) : 0;
    freq.push((k + d) * binHz);
    amp.push(Math.exp(lb - 0.25 * (la - lc) * d));
  }
  if (freq.length > maxPeaks) {
    const idx = amp
      .map((_, i) => i)
      .sort((i, j) => amp[j] - amp[i])
      .slice(0, maxPeaks)
      .sort((i, j) => i - j);
    return { freq: idx.map((i) => freq[i]), amp: idx.map((i) => amp[i]) };
  }
  return { freq, amp };
}

/** Weighted circular mean of fractional MIDI pitch → tuning offset in semitones (-0.5..0.5). */
export function estimateTuning(
  pitches: ArrayLike<number>,
  weights: ArrayLike<number>,
): { offset: number; strength: number } {
  let c = 0;
  let s = 0;
  let w = 0;
  for (let i = 0; i < pitches.length; i++) {
    const a = 2 * Math.PI * (pitches[i] - Math.round(pitches[i]));
    c += weights[i] * Math.cos(a);
    s += weights[i] * Math.sin(a);
    w += weights[i];
  }
  if (w <= 0) return { offset: 0, strength: 0 };
  const strength = Math.hypot(c, s) / w;
  return { offset: Math.atan2(s, c) / (2 * Math.PI), strength };
}

export function chromagramFromSignal(x: Float32Array, sr: number, opts: ChromaOptions = {}): ChromaResult {
  const fftSize = pow2ForDuration(opts.windowSeconds ?? 0.186, sr, 512, 16384);
  const hop = Math.max(1, Math.round((opts.hopSeconds ?? 0.046) * sr));
  const minHz = opts.minHz ?? 55;
  const maxHz = Math.min(opts.maxHz ?? 5000, sr * 0.45);
  const bassMax = opts.bassMaxHz ?? 250;
  const binHz = sr / fftSize;
  const nb = (fftSize >> 1) + 1;
  const kMin = Math.floor(minHz / binHz);
  const kMax = Math.ceil(maxHz / binHz);
  const peaks: FramePeaks[] = [];
  const energy: number[] = [];
  let globalMax = 0;
  const mag = new Float32Array(nb);
  forEachStftFrame(x, { fftSize, hop }, (_t, re, im) => {
    let fmax = 0;
    let e = 0;
    for (let k = 0; k < nb; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      e += p;
      mag[k] = Math.sqrt(p);
      if (k >= kMin && k <= kMax && mag[k] > fmax) fmax = mag[k];
    }
    energy.push(e);
    if (fmax > globalMax) globalMax = fmax;
    const pk = framePeaks(mag, 0, nb, binHz, kMin, kMax, fmax * 0.01);
    const pitch = new Float32Array(pk.freq.length);
    for (let i = 0; i < pitch.length; i++) pitch[i] = 69 + 12 * Math.log2(pk.freq[i] / 440);
    peaks.push({ pitch, amp: Float32Array.from(pk.amp) });
  });
  const absThr = globalMax * 10 ** (-70 / 20);
  // tuning from strong peaks
  let tuning = 0;
  if (opts.tuning !== false) {
    const ps: number[] = [];
    const ws: number[] = [];
    for (const f of peaks) {
      let m = 0;
      for (let i = 0; i < f.amp.length; i++) if (f.amp[i] > m) m = f.amp[i];
      for (let i = 0; i < f.amp.length; i++) {
        if (f.amp[i] > m * 0.1 && f.amp[i] > absThr * 10) {
          ps.push(f.pitch[i]);
          ws.push(f.amp[i]);
        }
      }
    }
    const t = estimateTuning(ps, ws);
    if (t.strength > 0.2) tuning = t.offset;
  }
  const frames: Float32Array[] = [];
  const bassFrames: Float32Array[] = [];
  const bassPitchMax = 69 + 12 * Math.log2(bassMax / 440);
  for (const f of peaks) {
    const c = new Float32Array(12);
    const b = new Float32Array(12);
    for (let i = 0; i < f.pitch.length; i++) {
      const a = f.amp[i];
      if (a <= absThr) continue;
      const p = f.pitch[i] - tuning;
      const r = Math.round(p);
      const d = p - r;
      const w = Math.cos(Math.PI * d) ** 2;
      const hz = 440 * Math.pow(2, (p - 69) / 12);
      const fw = hz <= 1000 ? 1 : Math.sqrt(1000 / hz);
      const pc = ((r % 12) + 12) % 12;
      c[pc] += a * w * fw;
      if (p <= bassPitchMax) b[pc] += a * w;
    }
    frames.push(c);
    bassFrames.push(b);
  }
  return {
    frames,
    bassFrames,
    hopSeconds: hop / sr,
    tuningCents: Math.round(tuning * 100),
    energy: Float32Array.from(energy),
  };
}

/** Chromagram of a recording (mixes down to mono, analyses at ≈ 22 kHz). */
export function chromagram(buf: AudioData, opts: ChromaOptions = {}): ChromaResult {
  const { x, sr } = prepareMono(buf);
  return chromagramFromSignal(x, sr, opts);
}

/** Average chroma frames between consecutive boundaries (seconds) → one vector per interval. */
export function syncChroma(frames: Float32Array[], hopSeconds: number, boundaries: number[]): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const a = Math.max(0, Math.round(boundaries[i] / hopSeconds));
    const b = Math.min(frames.length, Math.max(a + 1, Math.round(boundaries[i + 1] / hopSeconds)));
    const v = new Float32Array(12);
    for (let t = a; t < b; t++) {
      const f = frames[Math.min(frames.length - 1, t)];
      if (!f) continue;
      for (let k = 0; k < 12; k++) v[k] += f[k];
    }
    const n = Math.max(1, b - a);
    for (let k = 0; k < 12; k++) v[k] /= n;
    out.push(v);
  }
  return out;
}

/** L2-normalise a chroma vector (in place); returns its original norm. */
export function normalizeChroma(v: Float32Array): number {
  let s = 0;
  for (let k = 0; k < v.length; k++) s += v[k] * v[k];
  const n = Math.sqrt(s);
  if (n > 0) for (let k = 0; k < v.length; k++) v[k] /= n;
  return n;
}
