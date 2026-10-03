/**
 * Monophonic transcription (humming, singing, bass lines, monophonic instruments).
 *
 * YIN f0 track → global tuning estimate → Viterbi decoding over {silence, semitone states}
 * with a vibrato-tolerant observation model and note-change penalties → note segmentation,
 * re-articulation splitting on energy dips → per-note pitch / bend / velocity / confidence.
 */
import type { AudioData } from '../types';
import { estimateTuning } from './chroma';
import { yinTrack, pitchAnalysisSignal, type PitchTrack } from './pitch-yin';
import type { TranscribedNote } from './types';
import { clamp, clamp01, linToDb, percentile } from './util';

export interface MonophonicOptions {
  minHz?: number;
  maxHz?: number;
  /** Notes shorter than this are dropped/merged (default 0.07 s). */
  minNoteSeconds?: number;
  /** Pitch-track hop (default 0.01 s). */
  hopSeconds?: number;
  /** Semitone standard deviation of the observation model (vibrato tolerance), default 0.45. */
  pitchSigma?: number;
  /** Cost of changing note (higher = fewer, longer notes), default 6. */
  changePenalty?: number;
  /** Split repeated same-pitch notes on energy dips (default true). */
  splitRepeats?: boolean;
  /** Aperiodicity above which frames are unvoiced (default 0.35; raise for breathy singing). */
  voicingThreshold?: number;
  /** Minimum energy dip (dB) that splits a sustained pitch into repeated notes (default 5). */
  splitDipDb?: number;
}

export interface MonophonicResult {
  notes: TranscribedNote[];
  confidence: number;
  /** Detected deviation of the performance's tuning from A440 (cents). */
  tuningCents: number;
  /** Fraction of frames that were voiced. */
  voicedFraction: number;
}

export function transcribeMonophonic(buf: AudioData, opts: MonophonicOptions = {}): MonophonicResult {
  const maxHz = opts.maxHz ?? 1100;
  const { x, sr } = pitchAnalysisSignal(buf, maxHz);
  const track = yinTrack(x, sr, {
    minHz: opts.minHz ?? 60,
    maxHz,
    hopSeconds: opts.hopSeconds ?? 0.01,
    voicingThreshold: opts.voicingThreshold,
  });
  return notesFromPitchTrack(track, opts);
}

/** Segment a pitch track into notes. */
export function notesFromPitchTrack(track: PitchTrack, opts: MonophonicOptions = {}): MonophonicResult {
  const n = track.f0.length;
  const hop = track.hopSeconds;
  const minHz = opts.minHz ?? 60;
  const maxHz = opts.maxHz ?? 1100;
  const empty: MonophonicResult = { notes: [], confidence: 0, tuningCents: 0, voicedFraction: 0 };
  if (n === 0) return empty;
  const midi = new Float32Array(n);
  let voiced = 0;
  const vp: number[] = [];
  const vw: number[] = [];
  for (let t = 0; t < n; t++) {
    if (track.f0[t] > 0) {
      midi[t] = 69 + 12 * Math.log2(track.f0[t] / 440);
      voiced++;
      vp.push(midi[t]);
      vw.push(track.confidence[t]);
    } else midi[t] = NaN;
  }
  if (voiced < 3) return { ...empty, voicedFraction: voiced / n };
  const tun = estimateTuning(vp, vw);
  const delta = tun.strength > 0.3 ? tun.offset : 0;

  // ---- Viterbi over {silence} ∪ semitone states -------------------------------------
  const pLow = Math.floor(69 + 12 * Math.log2(minHz / 440)) - 1;
  const pHigh = Math.ceil(69 + 12 * Math.log2(maxHz / 440)) + 1;
  const K = pHigh - pLow + 1;
  const S = K + 1; // state 0 = silence
  const sigma = opts.pitchSigma ?? 0.45;
  const inv2s2 = 1 / (2 * sigma * sigma);
  const J = opts.changePenalty ?? 6;
  const Js = 2;
  const C_UNVOICED_PITCH = 1.2;
  const C_VOICED_SILENT = 4;
  let cost = new Float64Array(S);
  let next = new Float64Array(S);
  const back = new Uint16Array(n * S);
  const obs = (t: number, s: number): number => {
    const m = midi[t];
    if (Number.isNaN(m)) return s === 0 ? 0 : C_UNVOICED_PITCH;
    const c = track.confidence[t];
    if (s === 0) return c * C_VOICED_SILENT;
    const d = m - delta - (pLow + s - 1);
    return c * Math.min(d * d, 9) * inv2s2 + (1 - c) * 0.5;
  };
  for (let s = 0; s < S; s++) cost[s] = obs(0, s) + (s === 0 ? 0 : Js);
  for (let t = 1; t < n; t++) {
    // best pitch state at t-1
    let bestP = 1;
    for (let s = 2; s < S; s++) if (cost[s] < cost[bestP]) bestP = s;
    for (let s = 0; s < S; s++) {
      let v = cost[s];
      let from = s;
      if (s === 0) {
        if (cost[bestP] + Js < v) {
          v = cost[bestP] + Js;
          from = bestP;
        }
      } else {
        if (cost[0] + Js < v) {
          v = cost[0] + Js;
          from = 0;
        }
        const other = bestP === s ? secondBest(cost, s) : bestP;
        if (other > 0 && cost[other] + J < v) {
          v = cost[other] + J;
          from = other;
        }
      }
      next[s] = v + obs(t, s);
      back[t * S + s] = from;
    }
    const tmp = cost;
    cost = next;
    next = tmp;
  }
  let st = 0;
  for (let s = 1; s < S; s++) if (cost[s] < cost[st]) st = s;
  const path = new Uint16Array(n);
  for (let t = n - 1; t >= 0; t--) {
    path[t] = st;
    if (t > 0) st = back[t * S + st];
  }

  // ---- runs → candidate notes ------------------------------------------------------------
  /** `cut`: the run starts at a deliberate re-articulation (never merged into its predecessor). */
  type Run = { s: number; a: number; b: number; cut?: boolean };
  let runs: Run[] = [];
  for (let t = 0; t < n; t++) {
    const l = runs[runs.length - 1];
    if (l && l.s === path[t]) l.b = t + 1;
    else runs.push({ s: path[t], a: t, b: t + 1 });
  }
  runs = runs.filter((r) => r.s !== 0);

  const rmsDb = new Float32Array(n);
  for (let t = 0; t < n; t++) rmsDb[t] = linToDb(track.rms[t]);
  // split repeated notes on energy dips (re-articulation without a pitch change)
  if (opts.splitRepeats !== false) {
    const out: Run[] = [];
    const minSplit = Math.max(3, Math.round(0.06 / hop));
    const dip = opts.splitDipDb ?? 5;
    for (const r of runs) {
      let a = r.a;
      for (let t = r.a + minSplit; t < r.b - minSplit; t++) {
        const v = rmsDb[t];
        if (v > rmsDb[t - 1] || v > rmsDb[t + 1]) continue;
        const w = Math.round(0.15 / hop);
        let lmax = -Infinity;
        let rmax = -Infinity;
        for (let k = Math.max(a, t - w); k < t; k++) lmax = Math.max(lmax, rmsDb[k]);
        for (let k = t + 1; k <= Math.min(r.b - 1, t + w); k++) rmax = Math.max(rmax, rmsDb[k]);
        if (lmax - v >= dip && rmax - v >= dip && t - a >= minSplit) {
          out.push({ s: r.s, a, b: t, cut: a !== r.a ? true : r.cut });
          a = t + 1;
        }
      }
      out.push({ s: r.s, a, b: r.b, cut: a !== r.a ? true : r.cut });
    }
    runs = out;
  }
  // drop / merge too-short runs
  const minFrames = Math.max(1, Math.round((opts.minNoteSeconds ?? 0.07) / hop));
  const merged: Run[] = [];
  for (const r of runs) {
    const l = merged[merged.length - 1];
    if (r.b - r.a >= minFrames) {
      // a dropped glitch between two same-pitch runs: bridge it (unless this is a re-articulation)
      if (l && l.s === r.s && r.a - l.b <= 2 && !r.cut) l.b = r.b;
      else merged.push({ ...r });
    } else if (l && l.s === r.s && r.a - l.b <= 2 && !r.cut) l.b = r.b;
  }

  // ---- note properties ---------------------------------------------------------------------
  const notes: TranscribedNote[] = [];
  const peakDb: number[] = [];
  for (const r of merged) {
    let mx = -Infinity;
    for (let t = r.a; t < r.b; t++) mx = Math.max(mx, rmsDb[t]);
    peakDb.push(mx);
  }
  const refDb = percentile(peakDb, 90);
  merged.forEach((r, i) => {
    const pitch = pLow + r.s - 1;
    const devs: number[] = [];
    let cs = 0;
    let vf = 0;
    for (let t = r.a; t < r.b; t++) {
      if (Number.isNaN(midi[t])) continue;
      vf++;
      devs.push(midi[t] - pitch);
      const d = midi[t] - delta - pitch;
      cs += track.confidence[t] * Math.exp(-(d * d) / (2 * 0.6 * 0.6));
    }
    const len = r.b - r.a;
    devs.sort((a, b) => a - b);
    const bend = devs.length ? Math.round(devs[devs.length >> 1] * 100) : 0;
    const dur = len * hop;
    const conf = clamp01((vf ? cs / vf : 0) * (vf / len) * Math.sqrt(Math.min(1, dur / 0.15)));
    const velocity = Math.round(clamp(96 + 2.2 * (peakDb[i] - refDb), 15, 127));
    const note: TranscribedNote = {
      pitch,
      startSeconds: Math.max(0, r.a * hop - hop / 2),
      endSeconds: r.b * hop - hop / 2,
      velocity,
      confidence: Math.round(conf * 1000) / 1000,
    };
    if (bend !== 0) note.pitchBendCents = bend;
    notes.push(note);
  });
  let wsum = 0;
  let csum = 0;
  for (const nt of notes) {
    const d = nt.endSeconds - nt.startSeconds;
    wsum += d;
    csum += d * nt.confidence;
  }
  const confidence = wsum > 0 ? clamp01((csum / wsum) * (0.75 + 0.25 * tun.strength)) : 0;
  return {
    notes,
    confidence: Math.round(confidence * 1000) / 1000,
    tuningCents: Math.round(delta * 100),
    voicedFraction: voiced / n,
  };
}

function secondBest(cost: Float64Array, exclude: number): number {
  let b = -1;
  for (let s = 1; s < cost.length; s++) {
    if (s === exclude) continue;
    if (b < 0 || cost[s] < cost[b]) b = s;
  }
  return b;
}
