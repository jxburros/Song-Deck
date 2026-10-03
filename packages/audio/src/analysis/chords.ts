/**
 * Chord recognition: chroma (+ bass chroma) → template similarity for 12 roots × {maj, min,
 * 7, maj7, min7, dim, sus4} plus "no chord", decoded with an HMM (Viterbi) whose chord
 * changes are restricted to beat boundaries when beats are known.
 */
import { chordToRoman, formatChordSymbol, isDiatonic, type ChordQuality, type KeySignature } from '@songdeck/core';
import type { AudioData } from '../types';
import { chromagramFromSignal, type ChromaResult } from './chroma';
import { detectKey } from './key';
import { clamp01, mean, percentile, prepareMono } from './util';

export interface ChordSegment {
  /** Seconds. */
  start: number;
  end: number;
  symbol: string;
  root: number;
  quality: ChordQuality;
  confidence: number;
  /** Roman numeral relative to the key used for decoding (when a key is known). */
  roman?: string;
}

export interface ChordOptions {
  /** Beat times (s): chord changes are only allowed on beats. */
  beats?: number[];
  key?: KeySignature;
  /** Precomputed chromagram (skips the spectral analysis). */
  chroma?: ChromaResult;
  /** Minimum chord duration in seconds (shorter segments are merged), default 0.25. */
  minDurationSeconds?: number;
  /** 0..1, higher = fewer chord changes (default 0.5). */
  smoothing?: number;
}

interface Template {
  quality: ChordQuality;
  intervals: number[];
  weights: number[];
  prior: number;
}

const TEMPLATES: Template[] = [
  { quality: 'maj', intervals: [0, 4, 7], weights: [1, 0.9, 0.85], prior: 0 },
  { quality: 'min', intervals: [0, 3, 7], weights: [1, 0.9, 0.85], prior: 0 },
  { quality: '7', intervals: [0, 4, 7, 10], weights: [1, 0.9, 0.8, 0.8], prior: -0.045 },
  { quality: 'maj7', intervals: [0, 4, 7, 11], weights: [1, 0.9, 0.8, 0.8], prior: -0.06 },
  { quality: 'min7', intervals: [0, 3, 7, 10], weights: [1, 0.9, 0.8, 0.8], prior: -0.06 },
  { quality: 'dim', intervals: [0, 3, 6], weights: [1, 0.9, 0.85], prior: -0.05 },
  { quality: 'sus4', intervals: [0, 5, 7], weights: [1, 0.9, 0.85], prior: -0.05 },
];

interface ChordState {
  root: number;
  quality: ChordQuality;
  vec: Float32Array;
  prior: number;
}

function buildStates(): ChordState[] {
  const states: ChordState[] = [];
  for (const t of TEMPLATES) {
    for (let root = 0; root < 12; root++) {
      const v = new Float32Array(12);
      t.intervals.forEach((iv, i) => (v[(root + iv) % 12] = t.weights[i]));
      let n = 0;
      for (let k = 0; k < 12; k++) n += v[k] * v[k];
      n = Math.sqrt(n);
      for (let k = 0; k < 12; k++) v[k] /= n;
      states.push({ root, quality: t.quality, vec: v, prior: t.prior });
    }
  }
  return states;
}

const STATES = buildStates();
const N_STATE = STATES.length; // index of "no chord"

function isDiatonicLoose(root: number, quality: ChordQuality, key: KeySignature): boolean {
  const spec = { root, quality };
  if (isDiatonic(spec, key)) return true;
  if (key.mode === 'minor') return isDiatonic(spec, { tonic: key.tonic, mode: 'harmonic-minor' });
  return false;
}

/** Per-frame similarity of every chord state (+ N) given chroma and bass chroma. */
function frameSimilarities(chroma: ChromaResult, key: KeySignature | undefined): { sim: Float32Array[]; active: boolean[] } {
  const frames = chroma.frames;
  const sums = frames.map((f) => f.reduce((a, b) => a + b, 0));
  const loud = percentile(sums, 95);
  const sim: Float32Array[] = [];
  const active: boolean[] = [];
  const keyBonus = new Float32Array(N_STATE);
  if (key) STATES.forEach((s, i) => (keyBonus[i] = isDiatonicLoose(s.root, s.quality, key) ? 0.035 : -0.01));
  const c = new Float32Array(12);
  for (let t = 0; t < frames.length; t++) {
    const f = frames[t];
    const out = new Float32Array(N_STATE + 1);
    const isActive = sums[t] > loud * 0.03 && sums[t] > 0;
    active.push(isActive);
    if (!isActive) {
      out[N_STATE] = 1;
      sim.push(out);
      continue;
    }
    // compressed, normalised chroma
    let n = 0;
    for (let k = 0; k < 12; k++) {
      c[k] = Math.sqrt(f[k]);
      n += c[k] * c[k];
    }
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < 12; k++) c[k] /= n;
    const b = chroma.bassFrames[t];
    let bmax = 0;
    let bsum = 0;
    for (let k = 0; k < 12; k++) {
      if (b[k] > bmax) bmax = b[k];
      bsum += b[k];
    }
    const bassReliable = bsum > sums[t] * 0.08 && bmax > 0;
    for (let s = 0; s < N_STATE; s++) {
      const st = STATES[s];
      let d = 0;
      for (let k = 0; k < 12; k++) d += c[k] * st.vec[k];
      let v = d + st.prior + keyBonus[s];
      if (bassReliable) v += 0.12 * (b[st.root] / bmax) - 0.04;
      out[s] = v;
    }
    // "no chord": flat chroma (noise, drums) scores well here
    let cmax = 0;
    for (let k = 0; k < 12; k++) if (c[k] > cmax) cmax = c[k];
    out[N_STATE] = 0.42 + 0.6 * (0.45 - cmax);
    sim.push(out);
  }
  return { sim, active };
}

/** Chord recognition for a recording. Segments with no chord ("N") are omitted. */
export function detectChords(buf: AudioData, opts: ChordOptions = {}): { segments: ChordSegment[]; key?: KeySignature } {
  let chroma = opts.chroma;
  if (!chroma) {
    const { x, sr } = prepareMono(buf);
    chroma = chromagramFromSignal(x, sr);
  }
  return chordsFromChroma(chroma, opts);
}

export function chordsFromChroma(chroma: ChromaResult, opts: ChordOptions = {}): { segments: ChordSegment[]; key?: KeySignature } {
  const T = chroma.frames.length;
  if (T === 0) return { segments: [] };
  const key = opts.key ?? (() => {
    const k = detectKey({ frames: chroma.frames, bassFrames: chroma.bassFrames });
    return k.confidence > 0.25 ? k.key : undefined;
  })();
  const { sim } = frameSimilarities(chroma, key);
  const hop = chroma.hopSeconds;
  const S = N_STATE + 1;
  const kappa = 22 * (hop / 0.5); // evidence per half second
  const smoothing = clamp01(opts.smoothing ?? 0.5);
  // change points
  const allowed = new Uint8Array(T);
  if (opts.beats && opts.beats.length > 1) {
    for (const b of opts.beats) {
      const f = Math.round(b / hop);
      if (f >= 0 && f < T) allowed[f] = 1;
    }
    allowed[0] = 1;
  } else allowed.fill(1);
  const switchCost = opts.beats && opts.beats.length > 1 ? 1.2 + 3 * smoothing : 2 + 5 * smoothing;
  // Viterbi
  const score = new Float64Array(S);
  const next = new Float64Array(S);
  const back: Uint8Array[] = [];
  for (let s = 0; s < S; s++) score[s] = kappa * sim[0][s];
  back.push(new Uint8Array(S).fill(255));
  for (let t = 1; t < T; t++) {
    let bestPrev = 0;
    for (let s = 1; s < S; s++) if (score[s] > score[bestPrev]) bestPrev = s;
    const bp = new Uint8Array(S);
    const canSwitch = allowed[t] === 1;
    for (let s = 0; s < S; s++) {
      let v = score[s];
      let from = s;
      if (canSwitch && score[bestPrev] - switchCost > v) {
        v = score[bestPrev] - switchCost;
        from = bestPrev;
      }
      next[s] = v + kappa * sim[t][s];
      bp[s] = from;
    }
    back.push(bp);
    score.set(next);
  }
  let state = 0;
  for (let s = 1; s < S; s++) if (score[s] > score[state]) state = s;
  const path = new Uint8Array(T);
  for (let t = T - 1; t >= 0; t--) {
    path[t] = state;
    if (t > 0) state = back[t][state];
  }
  // segments
  type Raw = { s: number; a: number; b: number };
  let raw: Raw[] = [];
  for (let t = 0; t < T; t++) {
    const last = raw[raw.length - 1];
    if (last && last.s === path[t]) last.b = t + 1;
    else raw.push({ s: path[t], a: t, b: t + 1 });
  }
  // merge too-short segments into the better-matching neighbour
  const minFrames = Math.max(1, Math.round((opts.minDurationSeconds ?? 0.25) / hop));
  let changed = true;
  while (changed && raw.length > 1) {
    changed = false;
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (r.b - r.a >= minFrames) continue;
      const prev = raw[i - 1];
      const nxt = raw[i + 1];
      const fit = (s: number): number => {
        let v = 0;
        for (let t = r.a; t < r.b; t++) v += sim[t][s];
        return v;
      };
      const target = !prev ? nxt : !nxt ? prev : fit(prev.s) >= fit(nxt.s) ? prev : nxt;
      if (target === prev) prev.b = r.b;
      else nxt.a = r.a;
      raw.splice(i, 1);
      changed = true;
      break;
    }
    // re-merge equal neighbours
    const merged: Raw[] = [];
    for (const r of raw) {
      const l = merged[merged.length - 1];
      if (l && l.s === r.s) l.b = r.b;
      else merged.push(r);
    }
    raw = merged;
  }
  const beatTimes = opts.beats && opts.beats.length > 1 ? opts.beats : undefined;
  const snap = (frame: number): number => {
    const t = Math.max(0, frame * hop - hop / 2);
    if (!beatTimes) return t;
    let best = t;
    let bd = Infinity;
    for (const b of beatTimes) {
      const d = Math.abs(b - t);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return bd <= hop * 1.5 ? best : t;
  };
  const duration = T * hop;
  const segments: ChordSegment[] = [];
  for (const r of raw) {
    if (r.s === N_STATE) continue;
    const st = STATES[r.s];
    // confidence: soft-max probability of the chosen chord among all states, averaged
    const probs: number[] = [];
    for (let t = r.a; t < r.b; t++) {
      const row = sim[t];
      let z = 0;
      let mx = -Infinity;
      for (let s = 0; s < S; s++) if (row[s] > mx) mx = row[s];
      for (let s = 0; s < S; s++) z += Math.exp(25 * (row[s] - mx));
      probs.push(Math.exp(25 * (row[r.s] - mx)) / z);
    }
    const durSec = (r.b - r.a) * hop;
    const conf = clamp01(mean(probs) * 0.85 + 0.15 * clamp01(durSec / 1.5));
    const spec = { root: st.root, quality: st.quality };
    segments.push({
      start: snap(r.a),
      end: r.b >= T ? duration : snap(r.b),
      symbol: formatChordSymbol(spec, key),
      root: st.root,
      quality: st.quality,
      confidence: Math.round(conf * 1000) / 1000,
      ...(key ? { roman: chordToRoman(spec, key) } : {}),
    });
  }
  return { segments: segments.filter((s) => s.end > s.start), key };
}
