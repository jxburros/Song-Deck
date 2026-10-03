/**
 * Key detection: correlation of a duration-weighted pitch-class distribution with averaged
 * Krumhansl–Kessler and Temperley key profiles, plus a bass-line profile (tonic/dominant
 * emphasis) that separates relative major/minor keys.
 */
import type { KeySignature } from '@songdeck/core';
import type { AudioData } from '../types';
import { chromagram } from './chroma';
import { clamp01, pearson, percentile } from './util';

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TP_MAJOR = [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4];
const TP_MINOR = [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33];
/** Typical bass-note distributions (degree of the bass relative to the tonic). */
const BASS_MAJOR = [1.0, 0.05, 0.35, 0.05, 0.3, 0.6, 0.05, 0.75, 0.05, 0.5, 0.05, 0.1];
const BASS_MINOR = [1.0, 0.05, 0.2, 0.5, 0.05, 0.55, 0.05, 0.7, 0.55, 0.05, 0.5, 0.15];

function zs(a: number[]): number[] {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const s = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) || 1;
  return a.map((v) => (v - m) / s);
}

/**
 * Audio chroma of a note also contains its overtones (3rd/6th harmonic → fifth, 5th → major
 * third, 7th → minor seventh). Key profiles describe note distributions, so they are smeared
 * with the same harmonic kernel before being compared with audio chroma (cf. Gómez's HPCP).
 */
const HARMONIC_KERNEL: [number, number][] = [
  [0, 1],
  [7, 0.3],
  [4, 0.1],
  [10, 0.04],
];

function withHarmonics(profile: number[]): number[] {
  const out = new Array<number>(12).fill(0);
  for (let i = 0; i < 12; i++) for (const [iv, w] of HARMONIC_KERNEL) out[(i + iv) % 12] += profile[i] * w;
  return out;
}

const PROFILE_MAJOR = zs(withHarmonics(zs(KK_MAJOR).map((v, i) => v + zs(TP_MAJOR)[i] + 4)));
const PROFILE_MINOR = zs(withHarmonics(zs(KK_MINOR).map((v, i) => v + zs(TP_MINOR)[i] + 4)));
/** Profiles for symbolic input (note lists): no overtones. */
const NOTE_PROFILE_MAJOR = zs(KK_MAJOR).map((v, i) => v + zs(TP_MAJOR)[i]);
const NOTE_PROFILE_MINOR = zs(KK_MINOR).map((v, i) => v + zs(TP_MINOR)[i]);

export interface KeyResult {
  key: KeySignature;
  confidence: number;
  /** Next-best keys with their scores (correlation units). */
  alternatives: { key: KeySignature; score: number }[];
}

export interface KeyInput {
  frames: Float32Array[];
  bassFrames?: Float32Array[];
  /** Optional per-frame weights (e.g. energy). */
  weights?: ArrayLike<number>;
}

function rotate(profile: number[], tonic: number): number[] {
  const out = new Array<number>(12);
  for (let pc = 0; pc < 12; pc++) out[pc] = profile[(pc - tonic + 12) % 12];
  return out;
}

/** Duration-weighted pitch-class histogram from chroma frames (silent frames ignored). */
export function chromaHistogram(frames: Float32Array[], weights?: ArrayLike<number>): number[] {
  const hist = new Array<number>(12).fill(0);
  if (!frames.length) return hist;
  const sums = frames.map((f) => f.reduce((a, b) => a + b, 0));
  const thr = percentile(sums, 90) * 0.02;
  frames.forEach((f, i) => {
    const s = sums[i];
    if (s <= thr || s <= 0) return;
    const w = weights ? weights[i] : 1;
    let n = 0;
    for (let k = 0; k < 12; k++) n += Math.sqrt(f[k]);
    if (n <= 0) return;
    for (let k = 0; k < 12; k++) hist[k] += (w * Math.sqrt(f[k])) / n;
  });
  return hist;
}

/** Score all 24 major/minor keys for a pitch-class histogram (+ optional bass histogram). */
export function keyFromHistogram(
  hist: ArrayLike<number>,
  bassHist?: ArrayLike<number>,
  bassWeight = 0.45,
  symbolic = false,
): KeyResult {
  const h = Array.from(hist);
  const total = h.reduce((a, b) => a + b, 0);
  const scores: { key: KeySignature; score: number }[] = [];
  const bass = bassHist ? Array.from(bassHist) : undefined;
  const bassTotal = bass ? bass.reduce((a, b) => a + b, 0) : 0;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const prof = symbolic
        ? mode === 'major'
          ? NOTE_PROFILE_MAJOR
          : NOTE_PROFILE_MINOR
        : mode === 'major'
          ? PROFILE_MAJOR
          : PROFILE_MINOR;
      let s = total > 0 ? pearson(h, rotate(prof, tonic)) : 0;
      if (bass && bassTotal > 0)
        s += bassWeight * pearson(bass, rotate(mode === 'major' ? BASS_MAJOR : BASS_MINOR, tonic));
      scores.push({ key: { tonic, mode }, score: s });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const norm = 1 + (bass && bassTotal > 0 ? bassWeight : 0);
  const s1 = best.score / norm;
  const s2 = scores[1].score / norm;
  // Margin to the runner-up drives confidence; relative/parallel-key ambiguity shows up as a small margin.
  const confidence = total > 0 ? clamp01((0.22 + 2.6 * (s1 - s2)) * clamp01(s1 / 0.55)) : 0;
  return {
    key: best.key,
    confidence: Math.round(confidence * 1000) / 1000,
    alternatives: scores
      .slice(1, 6)
      .map((s) => ({ key: s.key, score: Math.round((s.score / norm) * 1000) / 1000 })),
  };
}

/** Detect the key of a recording or of precomputed chroma frames. */
export function detectKey(input: AudioData | KeyInput): KeyResult {
  let frames: Float32Array[];
  let bassFrames: Float32Array[] | undefined;
  let weights: ArrayLike<number> | undefined;
  if ('channels' in input) {
    const c = chromagram(input);
    frames = c.frames;
    bassFrames = c.bassFrames;
  } else {
    frames = input.frames;
    bassFrames = input.bassFrames;
    weights = input.weights;
  }
  const hist = chromaHistogram(frames, weights);
  const bassHist = bassFrames ? chromaHistogram(bassFrames, weights) : undefined;
  return keyFromHistogram(hist, bassHist);
}

/**
 * Key of a note list (melodies, transcriptions): duration-weighted pitch classes; the lowest
 * notes and the final note act as the "bass" evidence. Confidence is scaled down because a
 * single melody carries less harmonic information than a full arrangement.
 */
export function keyFromNotes(notes: { pitch: number; duration: number; velocity?: number }[]): KeyResult {
  const hist = new Array<number>(12).fill(0);
  const bass = new Array<number>(12).fill(0);
  if (!notes.length) return { key: { tonic: 0, mode: 'major' }, confidence: 0, alternatives: [] };
  const sorted = [...notes].map((n) => n.pitch).sort((a, b) => a - b);
  const lowCut = sorted[Math.floor(sorted.length * 0.25)];
  for (const n of notes) {
    const pc = ((Math.round(n.pitch) % 12) + 12) % 12;
    const w = Math.max(0.05, n.duration) * (n.velocity ? 0.5 + n.velocity / 254 : 1);
    hist[pc] += w;
    if (n.pitch <= lowCut) bass[pc] += w;
  }
  const last = notes[notes.length - 1];
  bass[((Math.round(last.pitch) % 12) + 12) % 12] += Math.max(0.2, last.duration) * 2;
  const r = keyFromHistogram(hist, bass, 0.3, true);
  return { ...r, confidence: Math.round(r.confidence * 0.8 * 1000) / 1000 };
}
