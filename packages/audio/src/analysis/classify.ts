/**
 * Instrument / stem classification by interpretable heuristics (no trained model):
 * spectral centroid, flatness, low/high energy ratios, percussiveness (HPSS), onset rate,
 * post-onset sustain, YIN voicing / pitch range / vibrato, polyphony (from the polyphonic
 * salience tracker), mid-band density and crest factor (distortion proxies).
 * Each candidate instrument gets a fuzzy score; scores → soft-max → capped confidence.
 */
import type { TrackRole } from '@songdeck/core';
import type { AudioData } from '../types';
import { onsetEnvelopeFromSignal, pickOnsetPeaks } from './onsets';
import { yinTrack } from './pitch-yin';
import { medianFilterTime } from './separation';
import { magnitudeSpectrogram } from './stft';
import { transcribePolyphonicSignal } from './transcribe-poly';
import { analysisDecimate, clamp01, mean, percentile, pow2ForDuration, prepareMono, slidingMedianStrided } from './util';

export type StemInstrumentId =
  | 'drum-kit'
  | 'electric-bass'
  | 'lead-vocal'
  | 'electric-guitar-distorted'
  | 'electric-guitar-clean'
  | 'acoustic-guitar'
  | 'piano'
  | 'string-ensemble'
  | 'synth-pad'
  | 'synth-lead';

export const STEM_INSTRUMENT_ROLE: Record<StemInstrumentId, TrackRole> = {
  'drum-kit': 'drums',
  'electric-bass': 'bass',
  'lead-vocal': 'vocal',
  'electric-guitar-distorted': 'rhythm-guitar',
  'electric-guitar-clean': 'rhythm-guitar',
  'acoustic-guitar': 'rhythm-guitar',
  piano: 'keys',
  'string-ensemble': 'strings',
  'synth-pad': 'synth-pad',
  'synth-lead': 'synth-lead',
};

export interface ClassifyOptions {
  /** Restrict the decision to these instruments. */
  candidates?: StemInstrumentId[];
  /** Analyse at most this many seconds (spread over the file), default 45. */
  maxSeconds?: number;
}

export interface StemClassification {
  role: TrackRole;
  instrumentId: StemInstrumentId;
  confidence: number;
  features: Record<string, number>;
  /** Soft-max probability of every candidate. */
  scores: Record<string, number>;
}

const up = (x: number, a: number, b: number): number => clamp01((x - a) / (b - a));
const down = (x: number, a: number, b: number): number => 1 - up(x, a, b);
const inRange = (x: number, lo: number, hi: number, soft = 0.25): number => {
  const w = (hi - lo) * soft;
  return Math.min(up(x, lo - w, lo + w), down(x, hi - w, hi + w));
};

/** Representative excerpt: up to three windows spread over the signal, joined. */
function excerpt(x: Float32Array, sr: number, maxSeconds: number): Float32Array {
  const max = Math.round(maxSeconds * sr);
  if (x.length <= max) return x;
  const part = Math.floor(max / 3);
  const out = new Float32Array(part * 3);
  [0.2, 0.5, 0.8].forEach((pos, i) => {
    const start = Math.max(0, Math.min(x.length - part, Math.round(pos * x.length - part / 2)));
    out.set(x.subarray(start, start + part), i * part);
  });
  return out;
}

/** Extract the classification features of a mono signal. */
export function stemFeatures(x0: Float32Array, sr: number, maxSeconds = 45): Record<string, number> {
  const x = excerpt(x0, sr, maxSeconds);
  const f: Record<string, number> = {};
  const fftSize = pow2ForDuration(0.093, sr, 512, 8192);
  const hop = fftSize >> 2;
  const spec = magnitudeSpectrogram(x, sr, { fftSize, hop });
  const T = spec.numFrames;
  const nb = spec.numBins;
  const binHz = sr / fftSize;
  const mag = spec.mag;
  // frame energies & activity
  const fe = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let k = 1; k < nb; k++) s += mag[t * nb + k] * mag[t * nb + k];
    fe[t] = s;
  }
  const loud = percentile(fe, 95);
  const active: number[] = [];
  for (let t = 0; t < T; t++) if (fe[t] > loud * 10 ** (-35 / 10) && fe[t] > 0) active.push(t);
  f.activity = T ? active.length / T : 0;
  if (!active.length) return { ...f, silent: 1 };
  // spectral shape
  let cNum = 0;
  let cDen = 0;
  let low = 0;
  let high = 0;
  let tot = 0;
  const flats: number[] = [];
  const midFlats: number[] = [];
  const kLow = Math.round(250 / binHz);
  const kHigh = Math.round(4000 / binHz);
  const kF0 = Math.max(1, Math.round(100 / binHz));
  const kF1 = Math.min(nb - 1, Math.round(8000 / binHz));
  const kM0 = Math.round(500 / binHz);
  const kM1 = Math.min(nb - 1, Math.round(4000 / binHz));
  for (const t of active) {
    const o = t * nb;
    let ls = 0;
    let s = 0;
    for (let k = 1; k < nb; k++) {
      const p = mag[o + k] * mag[o + k];
      cNum += p * k * binHz;
      cDen += p;
      if (k < kLow) low += p;
      if (k > kHigh) high += p;
      tot += p;
    }
    for (let k = kF0; k < kF1; k++) {
      const p = mag[o + k] * mag[o + k] + 1e-14;
      ls += Math.log(p);
      s += p;
    }
    flats.push(Math.exp(ls / (kF1 - kF0)) / (s / (kF1 - kF0)));
    ls = 0;
    s = 0;
    for (let k = kM0; k < kM1; k++) {
      const p = mag[o + k] * mag[o + k] + 1e-14;
      ls += Math.log(p);
      s += p;
    }
    midFlats.push(Math.exp(ls / (kM1 - kM0)) / (s / (kM1 - kM0)));
  }
  f.centroid = cDen > 0 ? cNum / cDen : 0;
  f.lowRatio = tot > 0 ? low / tot : 0;
  f.highRatio = tot > 0 ? high / tot : 0;
  f.flatness = mean(flats);
  f.midFlatness = mean(midFlats);
  // percussiveness (HPSS energy share)
  const H = medianFilterTime(mag, T, nb, Math.max(4, Math.round(0.2 / (hop / sr))));
  const row = new Float32Array(nb);
  const fRad = Math.max(3, Math.round(100 / binHz));
  const scratch = { buf: new Float32Array(nb), win: new Float32Array(2 * fRad + 1) };
  let pe = 0;
  let te = 0;
  for (const t of active) {
    const o = t * nb;
    for (let k = 0; k < nb; k++) row[k] = mag[o + k];
    slidingMedianStrided(row, 0, 1, nb, fRad, row, scratch);
    for (let k = 1; k < nb; k++) {
      const p = row[k] * row[k];
      const h = H[o + k] * H[o + k];
      const e = mag[o + k] * mag[o + k];
      pe += (e * p) / (p + h + 1e-20);
      te += e;
    }
  }
  f.percussiveness = te > 0 ? pe / te : 0;
  // onsets & sustain
  const env = onsetEnvelopeFromSignal(x, sr);
  const on = pickOnsetPeaks(env.envelope, env.hopSeconds, { delta: 0.08, floor: 0.06 });
  const activeSeconds = (active.length * hop) / sr;
  f.onsetRate = activeSeconds > 0 ? on.length / activeSeconds : 0;
  const sus: number[] = [];
  for (const o of on) {
    const a = env.energy[Math.min(env.energy.length - 1, o + 1)];
    const later = Math.min(env.energy.length - 1, o + Math.round(0.25 / env.hopSeconds));
    if (a > 0) sus.push(Math.min(1.5, env.energy[later] / a));
  }
  f.sustain = sus.length ? Math.min(1, percentile(sus, 50)) : 1;
  // crest factor
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    sq += x[i] * x[i];
  }
  f.crest = sq > 0 ? peak / Math.sqrt(sq / x.length) : 0;
  // pitch (YIN at ~11 kHz)
  const dec = Math.max(1, Math.round(sr / 11025));
  const y = dec > 1 ? analysisDecimate(x, dec) : x;
  const tr = yinTrack(y, sr / dec, { minHz: 35, maxHz: 1400, hopSeconds: 0.01, voicingThreshold: 0.3 });
  const midi: number[] = [];
  const confs: number[] = [];
  for (let i = 0; i < tr.f0.length; i++) {
    if (tr.f0[i] > 0) {
      midi.push(69 + 12 * Math.log2(tr.f0[i] / 440));
      confs.push(tr.confidence[i]);
    }
  }
  const activeFrames = (active.length * hop) / sr / tr.hopSeconds;
  f.voiced = activeFrames > 0 ? Math.min(1, midi.length / activeFrames) : 0;
  f.medianHz = midi.length ? 440 * Math.pow(2, (percentile(midi, 50) - 69) / 12) : 0;
  f.pitchRange = midi.length > 10 ? percentile(midi, 90) - percentile(midi, 10) : 0;
  f.harmonicity = confs.length ? mean(confs) : 0;
  // vibrato: periodic 4–8 Hz modulation of voiced runs
  let vibFrames = 0;
  let voicedRunFrames = 0;
  let i = 0;
  while (i < tr.f0.length) {
    if (!(tr.f0[i] > 0)) {
      i++;
      continue;
    }
    let j = i;
    while (j < tr.f0.length && tr.f0[j] > 0) j++;
    const len = j - i;
    if (len * tr.hopSeconds >= 0.4) {
      voicedRunFrames += len;
      const m = Array.from(tr.f0.subarray(i, j), (v) => 69 + 12 * Math.log2(v / 440));
      const r = Math.round(0.12 / tr.hopSeconds);
      const resid: number[] = [];
      for (let k = 0; k < m.length; k++) {
        let s = 0;
        let n = 0;
        for (let q = Math.max(0, k - r); q <= Math.min(m.length - 1, k + r); q++) {
          s += m[q];
          n++;
        }
        resid.push(m[k] - s / n);
      }
      let zc = 0;
      for (let k = 1; k < resid.length; k++) if (resid[k - 1] < 0 !== resid[k] < 0) zc++;
      const rate = zc / 2 / (len * tr.hopSeconds);
      const extent = Math.sqrt(mean(resid.map((v) => v * v))) * Math.SQRT2;
      if (rate >= 3.5 && rate <= 8.5 && extent >= 0.12 && extent <= 1.5) vibFrames += len;
    }
    i = j;
  }
  f.vibrato = voicedRunFrames > 0 ? vibFrames / voicedRunFrames : 0;
  // polyphony from the salience tracker (shorter excerpt)
  const polyX = excerpt(x, sr, Math.min(20, maxSeconds));
  const poly = transcribePolyphonicSignal(polyX, sr, { minPitch: 28, maxPitch: 100, maxPolyphony: 6 });
  f.polyphony = poly.meanPolyphony;
  f.noteRate = poly.notes.length / Math.max(1, polyX.length / sr);
  return f;
}

function scoreAll(f: Record<string, number>): Record<StemInstrumentId, number> {
  const poly = f.polyphony ?? 1;
  return {
    'drum-kit':
      2.5 * up(f.percussiveness, 0.35, 0.65) +
      up(f.flatness, 0.15, 0.4) +
      down(f.voiced, 0.2, 0.5) +
      0.5 * up(f.onsetRate, 1, 4) +
      0.5 * down(f.sustain, 0.3, 0.6) +
      down(f.sustain, 0.1, 0.35),
    'electric-bass':
      2.5 * up(f.lowRatio, 0.35, 0.7) +
      1.5 * down(f.medianHz, 160, 320) +
      0.8 * down(poly, 1.4, 2.4) +
      0.5 * up(f.voiced, 0.3, 0.6) +
      up(f.sustain, 0.15, 0.4) -
      2 * up(f.percussiveness, 0.4, 0.6),
    'lead-vocal':
      1.2 * up(f.voiced, 0.3, 0.6) +
      1.2 * down(poly, 1.3, 2.2) +
      2 * up(f.vibrato, 0.05, 0.3) +
      0.5 * inRange(f.medianHz, 150, 800) +
      0.5 * down(f.lowRatio, 0.3, 0.5) +
      0.3 * up(f.sustain, 0.3, 0.6) -
      1.5 * up(f.percussiveness, 0.45, 0.7),
    'synth-lead':
      up(f.voiced, 0.4, 0.7) +
      down(poly, 1.3, 2.2) +
      0.8 * up(f.centroid, 1200, 2500) +
      0.8 * up(f.harmonicity, 0.85, 0.95) +
      1.4 * down(f.vibrato, 0.05, 0.3) +
      0.8 * up(f.highRatio, 0.01, 0.06) +
      0.3 * up(f.sustain, 0.4, 0.7) -
      1.5 * up(f.percussiveness, 0.45, 0.7),
    'synth-pad':
      1.5 * up(poly, 1.8, 3) +
      1.5 * up(f.sustain, 0.6, 0.85) +
      2 * down(f.onsetRate, 0.6, 1.6) +
      0.5 * down(f.flatness, 0.1, 0.3) +
      down(f.vibrato, 0.1, 0.3) -
      up(f.percussiveness, 0.3, 0.5),
    'string-ensemble':
      1.2 * up(poly, 1.8, 3) +
      1.2 * up(f.sustain, 0.6, 0.85) +
      1.5 * up(f.vibrato, 0.05, 0.25) +
      2 * down(f.onsetRate, 0.6, 1.6) +
      0.5 * up(f.centroid, 600, 1000) +
      0.4 * inRange(f.centroid, 600, 2500) -
      up(f.percussiveness, 0.3, 0.5),
    piano:
      1.2 * up(poly, 1.5, 2.8) +
      1.5 * inRange(f.sustain, 0.1, 0.55) +
      0.8 * up(f.pitchRange, 10, 24) +
      0.5 * inRange(f.percussiveness, 0.08, 0.45) +
      0.5 * down(f.flatness, 0.1, 0.25) +
      0.3 * up(f.onsetRate, 1, 3),
    'acoustic-guitar':
      up(poly, 1.5, 3) +
      inRange(f.sustain, 0.15, 0.6) +
      up(f.highRatio, 0.05, 0.15) +
      0.6 * inRange(f.flatness, 0.08, 0.3) +
      0.5 * up(f.onsetRate, 1.5, 4) +
      0.4 * inRange(f.centroid, 1500, 4000),
    'electric-guitar-clean':
      0.8 * up(poly, 1.2, 2.5) +
      inRange(f.sustain, 0.25, 0.7) +
      0.8 * inRange(f.centroid, 700, 2500) +
      0.6 * down(f.flatness, 0.08, 0.2) +
      0.4 * down(f.highRatio, 0.08, 0.2),
    'electric-guitar-distorted':
      1.5 * up(f.midFlatness, 0.2, 0.4) +
      1.5 * down(f.crest, 1.8, 4) +
      0.5 * down(f.crest, 1.8, 3) +
      up(f.sustain, 0.5, 0.8) +
      0.6 * inRange(f.centroid, 900, 3500) +
      0.4 * up(poly, 1.2, 2.2) +
      0.8 * up(f.onsetRate, 1, 2.5) +
      0.8 * up(f.noteRate, 4, 10),
  };
}

/** Classify a stem (or isolated recording) into an instrument + track role. */
export function classifyStem(buf: AudioData, opts: ClassifyOptions = {}): StemClassification {
  const { x, sr } = prepareMono(buf);
  const f = stemFeatures(x, sr, opts.maxSeconds ?? 45);
  const all = scoreAll(f);
  const cands = (opts.candidates?.length ? opts.candidates : (Object.keys(all) as StemInstrumentId[])).filter((c) => c in all);
  if (f.silent) {
    const id = cands.includes('synth-pad') ? 'synth-pad' : cands[0];
    return { role: STEM_INSTRUMENT_ROLE[id], instrumentId: id, confidence: 0, features: f, scores: {} };
  }
  const temp = 2;
  const mx = Math.max(...cands.map((c) => all[c]));
  const exps = cands.map((c) => Math.exp(temp * (all[c] - mx)));
  const z = exps.reduce((a, b) => a + b, 0);
  const scores: Record<string, number> = {};
  cands.forEach((c, i) => (scores[c] = Math.round((exps[i] / z) * 1000) / 1000));
  const best = cands[exps.indexOf(Math.max(...exps))];
  // heuristic classifier: cap confidence, scale by how much signal there was
  const confidence = Math.round(Math.min(0.85, scores[best]) * (0.6 + 0.4 * clamp01(f.activity / 0.3)) * 1000) / 1000;
  const features: Record<string, number> = {};
  for (const [k, v] of Object.entries(f)) features[k] = Math.round(v * 1000) / 1000;
  return { role: STEM_INSTRUMENT_ROLE[best], instrumentId: best, confidence, features, scores };
}
