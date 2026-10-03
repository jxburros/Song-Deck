/**
 * Drum transcription.
 *
 *  1. Percussive enhancement (median-filter HPSS mask) of a short-window spectrogram (skippable
 *     for stems that are already percussive).
 *  2. Onsets: log band-energy flux (SuperFlux-style reference) computed separately for low / mid /
 *     high band groups, each normalised on its own and combined by maximum, so a lone hi-hat is as
 *     visible as a kick.
 *  3. Each onset's magnitude *increase* in 14 log bands is normalised per band (with a floor
 *     relative to the most active band, so absent drums are not inflated) and decomposed with a
 *     semi-informed, shape-constrained NMF into three components — low drum (kick/toms), snare,
 *     cymbal — in the spirit of partially fixed NMF drum transcription (Dittmar & Gärtner 2014).
 *  4. Evidence gates (sub-bass for kicks, sustained-and-decaying 1–5 kHz noise for snares, >5 kHz
 *     energy for cymbals), a clip-level presence test and a merge of components that only ever fire
 *     together (one drum split in two) suppress false hits from bleed and sparse kits.
 *  5. Low drums are split into kick (36) vs. toms (41–50) by the post-attack resonance; cymbals by
 *     decay time into closed hat (42) / open hat (46) / crash (49).
 */
import { GM_DRUM } from '@songdeck/core';
import type { AudioData } from '../types';
import { pickOnsetPeaks } from './onsets';
import { medianFilterTime } from './separation';
import { magnitudeSpectrogram } from './stft';
import type { DrumHit } from './types';
import {
  clamp,
  clamp01,
  median,
  percentile,
  pow2ForDuration,
  prepareMono,
  slidingMedianStrided,
} from './util';

export interface DrumTranscriptionOptions {
  /** Onset sensitivity 0..1 (default 0.5). */
  sensitivity?: number;
  /** Skip percussive enhancement (input is already a clean drum stem). */
  skipHpss?: boolean;
}

export interface DrumTranscriptionResult {
  hits: DrumHit[];
  confidence: number;
}

const BAND_EDGES = [30, 60, 90, 130, 180, 250, 350, 500, 800, 1300, 2000, 3200, 5000, 7500, 11000];
type DrumClass = 'low' | 'snare' | 'cymbal';
const CLASSES: DrumClass[] = ['low', 'snare', 'cymbal'];
/** Minimum activation relative to the class's typical hit. */
const REL_THRESHOLD: Record<DrumClass, number> = { low: 0.35, snare: 0.3, cymbal: 0.12 };

/**
 * Initial component shapes in the per-band-normalised space (each band scaled by its typical
 * onset increase, so the drum that dominates a band appears ≈ 1 there).
 */
function priorShape(c: DrumClass, f: number): number {
  switch (c) {
    case 'low': // kick drum and toms (split later by the post-attack resonance)
      return f < 250 ? 1 : f < 500 ? 0.5 : f < 1300 ? 0.2 : 0.05;
    case 'snare':
      return f < 150 ? 0.25 : f < 500 ? 0.6 : f < 5000 ? 1 : 0.6;
    case 'cymbal':
      return f < 2000 ? 0.02 : f < 5000 ? 0.3 : 1;
  }
}

/**
 * Physical limits per component (normalised space): a kick/tom carries little cymbal-band
 * energy and a cymbal little low-band energy. Without these caps NMF happily learns
 * "kick + hat" as one component when every kick coincides with a hat.
 */
function capShape(c: DrumClass, f: number): number {
  switch (c) {
    case 'low':
      return f < 500 ? 1 : f < 1300 ? 0.5 : f < 3000 ? 0.2 : 0.08;
    case 'snare':
      return f < 100 ? 0.15 : 1;
    case 'cymbal':
      return f < 1000 ? 0.03 : f < 2000 ? 0.1 : f < 5000 ? 0.5 : 1;
  }
}

/** Minimum shape per component, keeping each one anchored to what makes it that drum. */
function floorShape(c: DrumClass, f: number): number {
  switch (c) {
    case 'low':
      return f >= 50 && f < 180 ? 0.3 : 0;
    case 'snare':
      return f >= 1000 && f < 5000 ? 0.35 : 0;
    case 'cymbal':
      return f >= 7000 ? 0.5 : 0;
  }
}

/** Euclidean NMF (multiplicative updates) with fixed column count; W columns kept at unit max and capped. */
function nmf(
  U: Float32Array[],
  W0: Float32Array[],
  caps: Float32Array[],
  floors: Float32Array[],
  iters = 150,
): Float32Array[] {
  const N = U.length;
  const K = W0.length;
  const B = W0[0].length;
  const W = W0.map((w) => Float32Array.from(w, (v) => v + 1e-3));
  const H = U.map(() => new Float32Array(K).fill(0.5));
  const eps = 1e-9;
  const WH = new Float32Array(B);
  for (let it = 0; it < iters; it++) {
    // H update
    for (let n = 0; n < N; n++) {
      const u = U[n];
      const h = H[n];
      WH.fill(0);
      for (let k = 0; k < K; k++) for (let b = 0; b < B; b++) WH[b] += W[k][b] * h[k];
      for (let k = 0; k < K; k++) {
        let num = 0;
        let den = 0;
        for (let b = 0; b < B; b++) {
          num += W[k][b] * u[b];
          den += W[k][b] * WH[b];
        }
        h[k] *= num / (den + eps);
      }
    }
    // W update
    const num = W.map(() => new Float32Array(B));
    const den = W.map(() => new Float32Array(B));
    for (let n = 0; n < N; n++) {
      const u = U[n];
      const h = H[n];
      WH.fill(0);
      for (let k = 0; k < K; k++) for (let b = 0; b < B; b++) WH[b] += W[k][b] * h[k];
      for (let k = 0; k < K; k++) {
        if (h[k] <= 0) continue;
        for (let b = 0; b < B; b++) {
          num[k][b] += u[b] * h[k];
          den[k][b] += WH[b] * h[k];
        }
      }
    }
    for (let k = 0; k < K; k++) {
      let m = 0;
      for (let b = 0; b < B; b++) {
        W[k][b] *= num[k][b] / (den[k][b] + eps);
        if (W[k][b] > m) m = W[k][b];
      }
      if (m > 0) {
        for (let b = 0; b < B; b++) W[k][b] = Math.max(floors[k][b], Math.min(W[k][b] / m, caps[k][b]));
        for (let n = 0; n < N; n++) H[n][k] *= m;
      }
    }
  }
  return W;
}

function nnls(A: Float32Array[], u: Float32Array, iters = 80): Float32Array {
  // projected coordinate descent for min ||u - Σ h_k A_k||², h ≥ 0
  const K = A.length;
  const B = u.length;
  const h = new Float32Array(K);
  const norms = A.map((a) => a.reduce((s, v) => s + v * v, 0) || 1);
  const r = Float32Array.from(u);
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let k = 0; k < K; k++) {
      const a = A[k];
      let g = 0;
      for (let b = 0; b < B; b++) g += a[b] * r[b];
      const nh = Math.max(0, h[k] + g / norms[k]);
      const d = nh - h[k];
      if (d !== 0) {
        for (let b = 0; b < B; b++) r[b] -= d * a[b];
        h[k] = nh;
        moved += Math.abs(d);
      }
    }
    if (moved < 1e-6) break;
  }
  return h;
}

/** GM toms from low floor tom (41) to high tom (50) by resonance pitch. */
function tomNote(hz: number): number {
  if (hz < 95) return GM_DRUM.FLOOR_TOM_LOW;
  if (hz < 120) return GM_DRUM.FLOOR_TOM_HIGH;
  if (hz < 150) return GM_DRUM.TOM_LOW;
  if (hz < 185) return GM_DRUM.TOM_LOW_MID;
  if (hz < 230) return GM_DRUM.TOM_HIGH_MID;
  return GM_DRUM.TOM_HIGH;
}

function unitMax(v: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i];
  if (m > 0) for (let i = 0; i < v.length; i++) v[i] /= m;
  return v;
}

export function transcribeDrums(
  buf: AudioData,
  opts: DrumTranscriptionOptions = {},
): DrumTranscriptionResult {
  const { x, sr } = prepareMono(buf);
  if (x.length < sr * 0.1) return { hits: [], confidence: 0 };
  const fftSize = pow2ForDuration(0.046, sr, 256, 4096);
  const hop = fftSize >> 2;
  const hopSec = hop / sr;
  const spec = magnitudeSpectrogram(x, sr, { fftSize, hop });
  const T = spec.numFrames;
  const nb = spec.numBins;
  const binHz = sr / fftSize;
  const full = spec.mag;
  // ---- percussive enhancement -------------------------------------------------------------
  let perc = full;
  if (!opts.skipHpss) {
    const H = medianFilterTime(full, T, nb, Math.max(4, Math.round(0.1 / hopSec)));
    perc = new Float32Array(full.length);
    const row = new Float32Array(nb);
    const fRad = Math.max(3, Math.round(150 / binHz));
    const scratch = { buf: new Float32Array(nb), win: new Float32Array(2 * fRad + 1) };
    for (let t = 0; t < T; t++) {
      const o = t * nb;
      for (let k = 0; k < nb; k++) row[k] = full[o + k];
      slidingMedianStrided(row, 0, 1, nb, fRad, row, scratch);
      for (let k = 0; k < nb; k++) {
        const p = row[k];
        const h = H[o + k];
        perc[o + k] = full[o + k] * ((p * p) / (p * p + h * h + 1e-20));
      }
    }
  }
  // ---- band magnitudes ----------------------------------------------------------------------
  const edges = BAND_EDGES.filter((e) => e < sr * 0.47);
  edges.push(Math.floor(sr * 0.47));
  const NB = edges.length - 1;
  const centers = new Float32Array(NB);
  const k0s: number[] = [];
  const k1s: number[] = [];
  for (let b = 0; b < NB; b++) {
    centers[b] = Math.sqrt(edges[b] * edges[b + 1]);
    k0s.push(Math.max(1, Math.round(edges[b] / binHz)));
    k1s.push(Math.max(Math.round(edges[b] / binHz) + 1, Math.round(edges[b + 1] / binHz)));
  }
  const pBand = new Float32Array(T * NB); // percussive band magnitude
  const fBand = new Float32Array(T * NB); // full band power
  for (let t = 0; t < T; t++) {
    const o = t * nb;
    for (let b = 0; b < NB; b++) {
      let sp = 0;
      let sf = 0;
      for (let k = k0s[b]; k < Math.min(nb, k1s[b]); k++) {
        sp += perc[o + k] * perc[o + k];
        sf += full[o + k] * full[o + k];
      }
      pBand[t * NB + b] = Math.sqrt(sp);
      fBand[t * NB + b] = sf;
    }
  }
  // ---- onsets: group-wise normalised flux, combined by max ----------------------------------
  const groups: number[][] = [[], [], []];
  for (let b = 0; b < NB; b++) groups[centers[b] < 200 ? 0 : centers[b] < 5000 ? 1 : 2].push(b);
  const ref = new Float32Array(NB);
  for (let b = 0; b < NB; b++) {
    const col = new Float32Array(T);
    for (let t = 0; t < T; t++) col[t] = pBand[t * NB + b];
    ref[b] = Math.max(1e-9, percentile(col, 99));
  }
  const groupFlux = groups.map((g) => {
    const f = new Float32Array(T);
    if (!g.length) return f;
    for (let t = 1; t < T; t++) {
      let s = 0;
      for (const b of g) {
        // SuperFlux-style reference: the maximum of the previous three frames, so ripples in a
        // decaying drum do not retrigger
        const cur = Math.log1p((100 * pBand[t * NB + b]) / ref[b]);
        let prevMax = 0;
        for (let l = 1; l <= 3 && t - l >= 0; l++) prevMax = Math.max(prevMax, pBand[(t - l) * NB + b]);
        const prev = Math.log1p((100 * prevMax) / ref[b]);
        if (cur > prev) s += cur - prev;
      }
      f[t] = s / g.length;
    }
    const p = percentile(f, 99.5) || 1;
    for (let t = 0; t < T; t++) f[t] /= p;
    return f;
  });
  const flux = new Float32Array(T);
  for (let t = 0; t < T; t++) flux[t] = Math.max(groupFlux[0][t], groupFlux[1][t], groupFlux[2][t]);
  const sens = clamp(opts.sensitivity ?? 0.5, 0, 1);
  const onsetFrames = pickOnsetPeaks(flux, hopSec, {
    delta: 0.12 - 0.08 * sens,
    floor: 0.12 - 0.08 * sens,
    wait: 0.03,
    preAvg: 0.08,
    postAvg: 0.05,
  });
  if (!onsetFrames.length) return { hits: [], confidence: 0 };

  // ---- onset spectra (magnitude increase per band) --------------------------------------------
  const incs: Float32Array[] = onsetFrames.map((t0) => {
    const v = new Float32Array(NB);
    for (let b = 0; b < NB; b++) {
      let pre = Infinity;
      for (let t = Math.max(0, t0 - 3); t < t0; t++) pre = Math.min(pre, pBand[t * NB + b]);
      if (!Number.isFinite(pre)) pre = 0;
      let post = 0;
      for (let t = t0; t <= Math.min(T - 1, t0 + 2); t++) post = Math.max(post, pBand[t * NB + b]);
      v[b] = Math.max(0, post - pre);
    }
    return v;
  });
  // Per-band scale: the typical (95th-percentile) increase of each band, so a quiet hi-hat counts
  // as much as a loud kick. Bands that are far weaker than the most active one (after compensating
  // the natural spectral tilt of drum sounds) are floored, so a kit without hats does not turn
  // leakage in the hat bands into "typical hat activity".
  const tilt = (f: number): number => (f <= 200 ? 1 : Math.sqrt(200 / f));
  const p95 = new Float32Array(NB);
  for (let b = 0; b < NB; b++)
    p95[b] = percentile(
      incs.map((v) => v[b]),
      95,
    );
  let maxActivity = 0;
  for (let b = 0; b < NB; b++) maxActivity = Math.max(maxActivity, p95[b] / tilt(centers[b]));
  const norm = new Float32Array(NB);
  for (let b = 0; b < NB; b++) norm[b] = Math.max(1e-9, p95[b], 0.05 * maxActivity * tilt(centers[b]));
  const U = incs.map((v) => v.map((x2, b) => x2 / norm[b]));
  const prior = CLASSES.map((c) =>
    unitMax(Float32Array.from({ length: NB }, (_, b) => priorShape(c, centers[b]))),
  );
  // Semi-informed NMF over all onset spectra: lone hits define their component, and mixtures
  // (kick + hat) are explained as sums. Components keep their identity from the initialisation.
  const caps = CLASSES.map((c) => Float32Array.from({ length: NB }, (_, b) => capShape(c, centers[b])));
  const floors = CLASSES.map((c) => Float32Array.from({ length: NB }, (_, b) => floorShape(c, centers[b])));
  const W = U.length >= 4 ? nmf(U, prior, caps, floors) : prior;
  // Evidence gates: each drum must move the bands that define it; components failing their gate
  // are removed and the onset is re-fitted with the rest (a tom is not a snare without noise).
  const bandsIn = (lo: number, hi: number): number[] => {
    const out: number[] = [];
    for (let b = 0; b < NB; b++) if (centers[b] >= lo && centers[b] < hi) out.push(b);
    return out;
  };
  const gateBands: Record<DrumClass, number[]> = {
    low: bandsIn(0, 100),
    snare: bandsIn(1000, 5000),
    cymbal: bandsIn(5000, 1e9),
  };
  const gateLevel: Record<DrumClass, number> = { low: 0.2, snare: 0.25, cymbal: 0.12 };
  const passes = (c: DrumClass, u: Float32Array): boolean => {
    const g = gateBands[c];
    if (!g.length) return true;
    let v = 0;
    for (const b of g) v += u[b];
    v = c === 'snare' ? v / g.length : Math.max(...g.map((b) => u[b]));
    return v >= gateLevel[c];
  };
  // Snare wires keep hissing for 100+ ms but decay from the hit; the attack click of a bass or keys
  // note that leaks into a separated drum stem is gone within milliseconds, and noise that keeps
  // growing after the onset belongs to a later event (e.g. a vocal attack), not to this hit.
  const noiseBands = gateBands.snare;
  const noiseSustain = onsetFrames.map((t0) => {
    if (!noiseBands.length) return 1;
    let peak = 0;
    let later = 0;
    for (const b of noiseBands) {
      let pk = 0;
      for (let t = t0; t <= Math.min(T - 1, t0 + 2); t++) pk = Math.max(pk, fBand[t * NB + b]);
      let l = 0;
      let n = 0;
      const a = t0 + Math.max(3, Math.round(0.035 / hopSec));
      for (let t = a; t <= Math.min(T - 1, a + Math.max(2, Math.round(0.025 / hopSec))); t++) {
        l += fBand[t * NB + b];
        n++;
      }
      peak += pk;
      later += n ? l / n : 0;
    }
    return peak > 0 ? later / peak : 0;
  });
  const Hs: Float32Array[] = U.map((u, i) => {
    const allowed = CLASSES.map(
      (c) => passes(c, u) && (c !== 'snare' || (noiseSustain[i] >= 0.12 && noiseSustain[i] <= 1)),
    );
    const sub = W.filter((_, k) => allowed[k]);
    const hSub = sub.length ? nnls(sub, u) : new Float32Array(0);
    const h = new Float32Array(CLASSES.length);
    let j = 0;
    for (let k = 0; k < CLASSES.length; k++) if (allowed[k]) h[k] = hSub[j++];
    return h;
  });
  /** Fraction of the onset energy explained by component k within the bands where it lives (a hat under a kick is still a hat). */
  const support = W.map((w) => w.map((v) => (v >= 0.2 ? 1 : 0)));
  const localShareOf = (h: Float32Array, k: number, u: Float32Array): number => {
    let tot = 0;
    let e = 0;
    for (let b = 0; b < NB; b++) {
      if (!support[k][b]) continue;
      tot += u[b];
      e += h[k] * W[k][b];
    }
    return tot > 0 ? Math.min(1, e / tot) : 0;
  };
  // ---- decisions ----------------------------------------------------------------------------------
  // reference activation per class: strong, mostly-pure hits (weak pure onsets are often decay ripples)
  const typical = CLASSES.map((_, k) => {
    const all: number[] = [];
    Hs.forEach((h) => {
      if (h[k] > 0) all.push(h[k]);
    });
    const top = percentile(all, 90);
    const pure: number[] = [];
    Hs.forEach((h, i) => {
      if (h[k] >= 0.3 * top && localShareOf(h, k, U[i]) >= 0.6) pure.push(h[k]);
    });
    return Math.max(1e-6, pure.length >= 2 ? median(pure) : percentile(all, 75));
  });

  const topBands: number[] = [];
  for (let b = 0; b < NB; b++) if (edges[b] >= 7400) topBands.push(b);
  if (!topBands.length) topBands.push(NB - 1);
  const highDb = (t: number): number => {
    let s = 0;
    for (const b of topBands) s += fBand[t * NB + b];
    return 10 * Math.log10(s + 1e-12);
  };
  // Clip-level presence: a class must be the main explanation of some onsets (within its own
  // bands — a hat sharing its onset with bass-note bleed in the mid bands is still a hat) before
  // its weaker activations, e.g. a hat under a kick, are believed.
  const dominant = CLASSES.map(
    (_, k) => Hs.filter((h, i) => h[k] >= 0.4 * typical[k] && localShareOf(h, k, U[i]) >= 0.6).length,
  );
  const present = CLASSES.map((_, k) => dominant[k] >= 2 || (dominant[k] >= 1 && onsetFrames.length <= 6));
  // Over-decomposition check: NMF with more components than real drums can split one drum into
  // parts (e.g. a snare's noise learned as a "cymbal", its body as a "tom"). Two components that
  // (almost) always fire together, in both directions, are one instrument: keep the stronger.
  // (A kick that always comes with a hat is different: the hat also plays alone.)
  const active = (h: Float32Array, k: number, u: Float32Array): boolean =>
    h[k] >= 0.3 * typical[k] && localShareOf(h, k, u) >= 0.3;
  const activeIdx = CLASSES.map((_, k) =>
    Hs.map((h, i) => (active(h, k, U[i]) ? i : -1)).filter((i) => i >= 0),
  );
  const energyOf = (k: number, idx: number[]): number => {
    let e = 0;
    for (const i of idx) for (let b = 0; b < NB; b++) e += Hs[i][k] * W[k][b];
    return e;
  };
  for (let k = 0; k < CLASSES.length; k++) {
    for (let j = k + 1; j < CLASSES.length; j++) {
      if (!present[k] || !present[j]) continue;
      const ik = activeIdx[k];
      const ij = activeIdx[j];
      if (ik.length < 3 || ij.length < 3) continue;
      const setJ = new Set(ij);
      const both = ik.filter((i) => setJ.has(i)).length;
      if (both / ik.length >= 0.9 && both / ij.length >= 0.9) {
        if (energyOf(k, ik) >= energyOf(j, ij)) present[j] = false;
        else present[k] = false;
      }
    }
  }
  const hits: DrumHit[] = [];
  const cymbalHits: { i: number; hit: DrumHit }[] = [];
  onsetFrames.forEach((t0, i) => {
    const h = Hs[i];
    const u = U[i];
    const time = Math.round(t0 * hopSec * 1e4) / 1e4;
    const strength = flux[t0];
    CLASSES.forEach((c, k) => {
      if (h[k] <= 0 || !present[k]) return;
      const share = localShareOf(h, k, u);
      const rel = h[k] / typical[k];
      // per-class floors: hi-hats vary widely in level (and are protected by their band gate);
      // separated drum stems carry bass-note attacks that look like soft kicks/toms
      if (rel < REL_THRESHOLD[c] || share < 0.3) return;

      const velocity = Math.round(clamp(110 * Math.sqrt(Math.min(1.3, rel)), 15, 127));
      const confidence = clamp01(
        (0.3 + 0.4 * share + 0.2 * Math.min(1, rel) + 0.1 * Math.min(1, strength)) * 0.92,
      );
      let drum: number = c === 'snare' ? GM_DRUM.SNARE : c === 'cymbal' ? GM_DRUM.HIHAT_CLOSED : GM_DRUM.KICK;
      if (c === 'low') {
        // post-attack low-band resonance (35–100 ms after the onset): kick ≲ 90 Hz, toms higher
        const k1 = Math.max(1, Math.round(40 / binHz));
        const k2 = Math.round(400 / binHz);
        let num = 0;
        let den = 0;
        let bk = k1;
        let bv = 0;
        for (
          let t = Math.min(T - 1, t0 + 3);
          t <= Math.min(T - 1, t0 + Math.max(4, Math.round(0.1 / hopSec)));
          t++
        ) {
          const o = t * nb;
          for (let kk = k1; kk <= k2; kk++) {
            const v = full[o + kk] * full[o + kk];
            num += v * kk * binHz;
            den += v;
            if (v > bv) {
              bv = v;
              bk = kk;
            }
          }
        }
        const centroid = den > 0 ? num / den : 0;
        if (centroid > 105 && bk * binHz > 85) drum = tomNote(bk * binHz);
      }
      const hit: DrumHit = { time, drum, velocity, confidence: Math.round(confidence * 1000) / 1000 };
      hits.push(hit);
      if (c === 'cymbal') cymbalHits.push({ i, hit });
    });
  });
  // ---- cymbal decay → closed hat / open hat / crash --------------------------------------------
  cymbalHits.forEach(({ i, hit }, j) => {
    const t0 = onsetFrames[i];
    const nextOnset = j + 1 < cymbalHits.length ? onsetFrames[cymbalHits[j + 1].i] : T;
    let tp = t0;
    let peak = -Infinity;
    for (let t = t0; t <= Math.min(T - 1, t0 + 3); t++) {
      const v = highDb(t);
      if (v > peak) {
        peak = v;
        tp = t;
      }
    }
    let decay = -1;
    const limit = Math.min(T, nextOnset, tp + Math.round(2 / hopSec));
    for (let t = tp + 1; t < limit; t++) {
      if (highDb(t) < peak - 15) {
        decay = (t - tp) * hopSec;
        break;
      }
    }
    if (decay < 0) {
      // censored by the next hit: extrapolate the observed slope
      const n = limit - tp - 1;
      if (n >= 2) {
        const drop = peak - highDb(limit - 1);
        decay = drop > 0.5 ? (15 * (n * hopSec)) / drop : 2;
      } else decay = 0.05;
    }
    // a simultaneous snare's noise tail lengthens the apparent decay
    const withSnare = hits.some((hh) => hh.time === hit.time && hh.drum === GM_DRUM.SNARE);
    if (decay >= (withSnare ? 0.9 : 0.6)) hit.drum = GM_DRUM.CRASH;
    else if (decay >= (withSnare ? 0.4 : 0.13)) hit.drum = GM_DRUM.HIHAT_OPEN;
  });
  hits.sort((a, b) => a.time - b.time || a.drum - b.drum);
  const confidence = hits.length
    ? Math.round((hits.reduce((s, h) => s + h.confidence, 0) / hits.length) * 0.95 * 1000) / 1000
    : 0;
  return { hits, confidence };
}
