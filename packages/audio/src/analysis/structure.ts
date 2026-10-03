/**
 * Song-structure segmentation.
 *
 * Bar-synchronous features (chroma + MFCC-like timbre + loudness) → self-similarity matrix →
 * multi-scale checkerboard-kernel novelty (Foote 2000) → boundaries on bar lines (downbeats)
 * → segment clustering (mean-feature similarity + diagonal "same sequence" similarity) into
 * A/B/C labels → section kinds from repetition, position and energy
 * (intro / verse / pre-chorus / chorus / bridge / outro).
 */
import type { SectionKind } from '@songdeck/core';
import type { AudioData } from '../types';
import { chromagramFromSignal, type ChromaResult } from './chroma';
import { applyFilterbank, cepstrum, melFilterbank } from './features';
import { forEachStftFrame } from './stft';
import { clamp01, cosineSimilarity, mean, median, percentile, pow2ForDuration, prepareMono, std, throwIfAborted } from './util';

export interface StructureOptions {
  /** Beat times (s). */
  beats: number[];
  /** Downbeat (bar start) times (s); default: every `beatsPerBar` beats from the first beat. */
  downbeats?: number[];
  bpm: number;
  beatsPerBar?: number;
  /** Minimum section length in bars (default 4; 2 for very short pieces). */
  minSectionBars?: number;
  chroma?: ChromaResult;
  signal?: AbortSignal;
}

export interface StructureSegment {
  startSeconds: number;
  endSeconds: number;
  /** Repetition label: "A", "B", "C"… (same letter = same material). */
  label: string;
  kind: SectionKind;
  confidence: number;
  /** Bar index (0-based, relative to the downbeat grid) of the segment start. */
  startBar: number;
  bars: number;
  /** Mean loudness relative to the loudest segment (0..1). */
  energy: number;
}

interface BarFeatures {
  start: number;
  end: number;
  chroma: Float32Array;
  timbre: Float32Array;
  loudness: number;
}

function barGrid(opts: StructureOptions, duration: number): number[] {
  const bpb = opts.beatsPerBar ?? 4;
  let downs = opts.downbeats && opts.downbeats.length >= 2 ? [...opts.downbeats] : [];
  if (!downs.length) {
    if (opts.beats.length >= 2) for (let i = 0; i < opts.beats.length; i += bpb) downs.push(opts.beats[i]);
    else {
      const bar = (60 / Math.max(1, opts.bpm)) * bpb;
      for (let t = 0; t < duration; t += bar) downs.push(t);
    }
  }
  downs = downs.filter((t) => t < duration - 0.05);
  // extend the grid to cover the whole recording
  const barLen = downs.length >= 2 ? (downs[downs.length - 1] - downs[0]) / (downs.length - 1) : (60 / Math.max(1, opts.bpm)) * bpb;
  while (downs.length && downs[0] - barLen > -barLen * 0.5 && downs[0] > 0.25 * barLen) downs.unshift(Math.max(0, downs[0] - barLen));
  let last = downs[downs.length - 1] ?? 0;
  while (last + barLen < duration - 0.25 * barLen) {
    last += barLen;
    downs.push(last);
  }
  downs.push(duration);
  return downs;
}

export function segmentStructure(buf: AudioData, opts: StructureOptions): { segments: StructureSegment[] } {
  const { x, sr } = prepareMono(buf);
  const duration = x.length / sr;
  if (duration < 1) return { segments: [] };
  const grid = barGrid(opts, duration);
  const nBars = grid.length - 1;
  if (nBars < 1) return { segments: [] };
  const chroma = opts.chroma ?? chromagramFromSignal(x, sr);
  throwIfAborted(opts.signal);
  // timbre: mel → cepstrum per frame
  const fftSize = pow2ForDuration(0.093, sr, 512, 8192);
  const hop = fftSize >> 1;
  const fb = melFilterbank(32, 40, Math.min(10000, sr * 0.45), fftSize, sr);
  const nb = (fftSize >> 1) + 1;
  const mags = new Float32Array(nb);
  const mel = new Float32Array(32);
  const frameCeps: Float32Array[] = [];
  const frameLoud: number[] = [];
  forEachStftFrame(x, { fftSize, hop }, (_t, re, im) => {
    for (let k = 0; k < nb; k++) mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    applyFilterbank(fb, mags, 0, mel, 0, true);
    let e = 0;
    for (let b = 0; b < 32; b++) {
      e += mel[b];
      mel[b] = Math.log(mel[b] + 1e-9);
    }
    const c = new Float32Array(12);
    cepstrum(mel, 0, 32, 12, c);
    frameCeps.push(c);
    frameLoud.push(e);
  });
  const tHop = hop / sr;
  const bars: BarFeatures[] = [];
  for (let i = 0; i < nBars; i++) {
    const a = grid[i];
    const b = grid[i + 1];
    const ch = new Float32Array(12);
    const ca = Math.max(0, Math.floor(a / chroma.hopSeconds));
    const cb = Math.min(chroma.frames.length, Math.max(ca + 1, Math.ceil(b / chroma.hopSeconds)));
    for (let t = ca; t < cb; t++) for (let k = 0; k < 12; k++) ch[k] += Math.sqrt(chroma.frames[t]?.[k] ?? 0);
    const tm = new Float32Array(12);
    const fa = Math.max(0, Math.floor(a / tHop));
    const fbb = Math.min(frameCeps.length, Math.max(fa + 1, Math.ceil(b / tHop)));
    let loud = 0;
    for (let t = fa; t < fbb; t++) {
      for (let k = 0; k < 12; k++) tm[k] += frameCeps[t][k] / (fbb - fa);
      loud += frameLoud[t] / (fbb - fa);
    }
    loud = 10 * Math.log10(loud + 1e-12);
    let n = 0;
    for (let k = 0; k < 12; k++) n += ch[k] * ch[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < 12; k++) ch[k] /= n;
    bars.push({ start: a, end: b, chroma: ch, timbre: tm, loudness: loud });
  }
  // standardise timbre & loudness across bars
  const tMean = new Float32Array(12);
  const tStd = new Float32Array(12);
  for (let k = 0; k < 12; k++) {
    const col = bars.map((b) => b.timbre[k]);
    tMean[k] = mean(col);
    tStd[k] = std(col) || 1;
  }
  const louds = bars.map((b) => b.loudness);
  const lMean = mean(louds);
  const lStd = std(louds) || 1;
  const feat = bars.map((b) => {
    const v = new Float32Array(12 + 12 + 1);
    for (let k = 0; k < 12; k++) v[k] = b.chroma[k] - 1 / Math.sqrt(12);
    for (let k = 0; k < 12; k++) v[12 + k] = ((b.timbre[k] - tMean[k]) / tStd[k]) * 0.35;
    v[24] = ((b.loudness - lMean) / lStd) * 0.6;
    return v;
  });
  // self-similarity of single bars (used for repetition / clustering)
  const S = new Float32Array(nBars * nBars);
  for (let i = 0; i < nBars; i++) {
    for (let j = i; j < nBars; j++) {
      const s = (cosineSimilarity(feat[i], feat[j]) + 1) / 2;
      S[i * nBars + j] = s;
      S[j * nBars + i] = s;
    }
  }
  // Novelty: harmony often changes every bar inside a section, so the harmonic curve uses chroma
  // averaged over a 4-bar phrase window (constant inside a repeating 2- or 4-chord cycle); the
  // texture curve uses timbre + loudness. Both are normalised and combined.
  // window i-2..i+2 with half-weight ends: effective length 4 bars, centred on bar i like the
  // texture features, and constant inside any repeating 2- or 4-chord cycle
  const phraseW = nBars >= 12 ? [0.5, 1, 1, 1, 0.5] : [0.5, 1, 0.5];
  const half = phraseW.length >> 1;
  const harmFeat = feat.map((_, i) => {
    const v = new Float32Array(12);
    phraseW.forEach((w, d) => {
      const j = Math.max(0, Math.min(nBars - 1, i + d - half));
      for (let k = 0; k < 12; k++) v[k] += w * feat[j][k];
    });
    return v;
  });
  const texFeat = feat.map((f) => f.slice(12));
  const ssm = (fs: Float32Array[]): Float32Array => {
    const m = new Float32Array(nBars * nBars);
    for (let i = 0; i < nBars; i++) {
      for (let j = i; j < nBars; j++) {
        const v = (cosineSimilarity(fs[i], fs[j]) + 1) / 2;
        m[i * nBars + j] = v;
        m[j * nBars + i] = v;
      }
    }
    return m;
  };
  const checker = (M: Float32Array, w: number): Float32Array => {
    const nov = new Float32Array(nBars + 1);
    let full = 0;
    for (let a = -w; a < w; a++) for (let b = -w; b < w; b++) full += Math.exp(-0.5 * (((a + 0.5) / w) ** 2 + ((b + 0.5) / w) ** 2));
    for (let i = 1; i < nBars; i++) {
      // cells outside the song count as "unknown" (0): partial kernels at the edges cannot spike
      let acc = 0;
      for (let a = -w; a < w; a++) {
        for (let b = -w; b < w; b++) {
          const ia = i + a;
          const ib = i + b;
          if (ia < 0 || ib < 0 || ia >= nBars || ib >= nBars) continue;
          const sign = (a < 0) === (b < 0) ? 1 : -1;
          const g = Math.exp(-0.5 * (((a + 0.5) / w) ** 2 + ((b + 0.5) / w) ** 2));
          acc += sign * g * (M[ia * nBars + ib] - 0.5);
        }
      }
      nov[i] = Math.max(0, acc / full);
    }
    const m = Math.max(...nov) || 1;
    for (let i = 0; i <= nBars; i++) nov[i] /= m;
    return nov;
  };
  const SH = ssm(harmFeat);
  const ST = ssm(texFeat);
  const novelty = new Float32Array(nBars + 1);
  const scales = nBars >= 40 ? [2, 4, 8] : nBars >= 16 ? [2, 4] : [2];
  const nr = repetitionNovelty(feat, nBars);
  // texture at the 2-bar scale mostly reflects bar-to-bar variation (melody, voicings): use it
  // only at phrase scales unless the piece is short; repetition gets half weight
  let wTot = 0;
  for (const w of scales) {
    const nh = checker(SH, w);
    const useTex = w >= 4 || scales.length === 1;
    const nt = useTex ? checker(ST, w) : undefined;
    for (let i = 0; i <= nBars; i++) novelty[i] += nh[i] + (nt ? nt[i] : 0);
    wTot += useTex ? 2 : 1;
  }
  if (nBars >= 16) {
    for (let i = 0; i <= nBars; i++) novelty[i] += 0.5 * nr[i];
    wTot += 0.5;
  }
  for (let i = 0; i <= nBars; i++) novelty[i] /= wTot;
  {
    const m = Math.max(...novelty) || 1;
    for (let i = 0; i <= nBars; i++) novelty[i] /= m;
  }
  // boundaries
  const minBars = Math.max(1, opts.minSectionBars ?? (nBars >= 24 ? 4 : 2));
  const cands: number[] = [];
  const prominence = (i: number): number => {
    let lmin = novelty[i];
    let rmin = novelty[i];
    for (let j = Math.max(1, i - minBars); j < i; j++) lmin = Math.min(lmin, novelty[j]);
    for (let j = i + 1; j <= Math.min(nBars - 1, i + minBars); j++) rmin = Math.min(rmin, novelty[j]);
    return novelty[i] - Math.max(lmin, rmin);
  };
  const peaks: number[] = [];
  for (let i = 1; i < nBars; i++) if (novelty[i] >= novelty[i - 1] && novelty[i] >= novelty[i + 1]) peaks.push(novelty[i]);
  // adaptive: a boundary must be at least about half as strong as the song's clear boundaries
  const thr = Math.max(0.3, 0.55 * percentile(peaks, 75));
  for (let i = 1; i < nBars; i++) {
    if (novelty[i] >= novelty[i - 1] && novelty[i] >= novelty[i + 1] && novelty[i] > thr && prominence(i) >= 0.12) cands.push(i);
  }
  cands.sort((a, b) => novelty[b] - novelty[a]);
  const chosen: number[] = [];
  for (const c of cands) {
    if (c < minBars || nBars - c < Math.min(minBars, 2)) continue;
    if (chosen.every((o) => Math.abs(o - c) >= minBars)) chosen.push(c);
  }
  chosen.sort((a, b) => a - b);
  const bounds = [0, ...chosen, nBars];
  type Seg = { a: number; b: number; label?: number; strength: number };
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) segs.push({ a: bounds[i], b: bounds[i + 1], strength: i === 0 ? 1 : novelty[bounds[i]] });
  // clustering
  const segMean = (s: Seg): Float32Array => {
    const v = new Float32Array(25);
    for (let i = s.a; i < s.b; i++) for (let k = 0; k < 25; k++) v[k] += feat[i][k] / (s.b - s.a);
    return v;
  };
  const diagSim = (p: Seg, q: Seg): number => {
    const len = Math.min(p.b - p.a, q.b - q.a);
    if (len <= 0) return 0;
    let s = 0;
    for (let j = 0; j < len; j++) s += S[(p.a + j) * nBars + (q.a + j)];
    return s / len;
  };
  const means = segs.map(segMean);
  const sim = (i: number, j: number): number => {
    const lenRatio = Math.min(segs[i].b - segs[i].a, segs[j].b - segs[j].a) / Math.max(segs[i].b - segs[i].a, segs[j].b - segs[j].a);
    const c = (cosineSimilarity(means[i], means[j]) + 1) / 2;
    return (0.5 * c + 0.5 * diagSim(segs[i], segs[j])) * (0.85 + 0.15 * lenRatio);
  };
  const protos: number[] = [];
  const labelSim: number[] = [];
  const threshold = 0.82;
  segs.forEach((s, i) => {
    let best = -1;
    let bv = 0;
    protos.forEach((p, li) => {
      const v = sim(i, p);
      if (v > bv) {
        bv = v;
        best = li;
      }
    });
    if (best >= 0 && bv >= threshold) {
      s.label = best;
      labelSim.push(bv);
    } else {
      s.label = protos.length;
      protos.push(i);
      labelSim.push(best >= 0 ? 1 - bv : 1);
    }
  });
  // energies
  const segLoud = segs.map((s) => median(bars.slice(s.a, s.b).map((b) => b.loudness)));
  const maxLoud = Math.max(...segLoud);
  const minLoud = Math.min(...segLoud);
  const energy = segLoud.map((l) => (maxLoud - minLoud > 0.5 ? (l - minLoud) / (maxLoud - minLoud) : 0.6));
  const kinds = assignKinds(segs.map((s) => s.label ?? 0), energy, segs.map((s) => s.b - s.a));
  const novMax = Math.max(1e-9, ...chosen.map((c) => novelty[c]));
  const segments: StructureSegment[] = segs.map((s, i) => ({
    startSeconds: Math.round(bars[s.a].start * 1000) / 1000,
    endSeconds: Math.round((s.b >= nBars ? duration : bars[s.b].start) * 1000) / 1000,
    label: String.fromCharCode(65 + Math.min(25, s.label ?? 0)),
    kind: kinds[i],
    confidence: Math.round(clamp01(0.25 + 0.4 * (i === 0 ? 0.8 : s.strength / novMax) + 0.25 * clamp01(labelSim[i])) * 1000) / 1000,
    startBar: s.a,
    bars: s.b - s.a,
    energy: Math.round(energy[i] * 1000) / 1000,
  }));
  return { segments };
}

/**
 * Repetition novelty from "structure features" (Serrà et al. 2012): time-delay embedded bar
 * features → mutual k-nearest-neighbour recurrence plot → circular time-lag matrix smoothed
 * along time → change between consecutive lag profiles. Peaks where the repetition pattern
 * changes, even when the sound itself barely changes (e.g. a bridge with the same band).
 */
export function repetitionNovelty(feat: Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n + 1);
  if (n < 8) return out;
  const m = 3; // embedding: bars i-1, i, i+1
  const emb = feat.map((_, i) => {
    const v = new Float32Array(feat[0].length * m);
    for (let d = 0; d < m; d++) {
      const j = Math.max(0, Math.min(n - 1, i + d - 1));
      v.set(feat[j], d * feat[0].length);
    }
    return v;
  });
  const dist = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let s = 0;
      for (let k = 0; k < emb[i].length; k++) {
        const d = emb[i][k] - emb[j][k];
        s += d * d;
      }
      dist[i * n + j] = s;
      dist[j * n + i] = s;
    }
  }
  const K = Math.max(2, Math.round(0.08 * n));
  const knn = new Float32Array(n); // K-th neighbour distance per row
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) if (Math.abs(i - j) > 1) row.push(dist[i * n + j]);
    row.sort((a, b) => a - b);
    knn[i] = row[Math.min(row.length - 1, K - 1)] ?? Infinity;
  }
  // lag matrix L[i][l] = R(i, i+l mod n)
  const L = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let l = 1; l < n; l++) {
      const j = (i + l) % n;
      const d = dist[i * n + j];
      L[i * n + l] = d <= knn[i] && d <= knn[j] ? 1 : 0;
    }
  }
  // smooth along time
  const sig = 1.5;
  const r = 4;
  const P = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let l = 0; l < n; l++) {
      let acc = 0;
      let w = 0;
      for (let d = -r; d <= r; d++) {
        const t = i + d;
        if (t < 0 || t >= n) continue;
        const g = Math.exp(-0.5 * (d / sig) ** 2);
        acc += g * L[t * n + l];
        w += g;
      }
      P[i * n + l] = acc / w;
    }
  }
  for (let i = 1; i < n; i++) {
    let s = 0;
    for (let l = 0; l < n; l++) {
      const d = P[i * n + l] - P[(i - 1) * n + l];
      s += d * d;
    }
    out[i] = Math.sqrt(s);
  }
  // ignore the first/last two bars (embedding edge effects) for normalisation
  let mx = 0;
  for (let i = 2; i <= n - 2; i++) mx = Math.max(mx, out[i]);
  if (mx > 0) for (let i = 0; i <= n; i++) out[i] = Math.min(1, out[i] / mx);
  return out;
}

/** Section kinds from label repetition, position and relative energy. */
export function assignKinds(labels: number[], energy: number[], lengths: number[]): SectionKind[] {
  const n = labels.length;
  const kinds: SectionKind[] = new Array(n).fill('verse');
  if (n === 0) return kinds;
  if (n === 1) return ['verse'];
  const count = new Map<number, number>();
  labels.forEach((l) => count.set(l, (count.get(l) ?? 0) + 1));
  const labelEnergy = new Map<number, number>();
  for (const l of count.keys()) labelEnergy.set(l, mean(labels.map((x, i) => (x === l ? energy[i] : NaN)).filter((v) => !Number.isNaN(v))));
  const repeated = [...count.entries()].filter(([, c]) => c >= 2).map(([l]) => l);
  let chorus = -1;
  let verse = -1;
  if (repeated.length) {
    // chorus: loud and repeated (energy dominates; a unique first/last section is intro/outro material)
    const chorusScore = (l: number): number => {
      const idx = labels.map((x, j) => (x === l ? j : -1)).filter((j) => j >= 0);
      if (idx.length === 1 && (idx[0] === 0 || idx[0] === n - 1)) return -Infinity;
      return (labelEnergy.get(l) ?? 0) + 0.15 * ((count.get(l) ?? 1) - 1);
    };
    chorus = [...count.keys()].reduce((a, b) => (chorusScore(b) > chorusScore(a) ? b : a));
    const others = repeated.filter((l) => l !== chorus);
    if (others.length) {
      // the verse usually appears before the first chorus
      const firstChorus = labels.indexOf(chorus);
      verse = others.reduce((a, b) => {
        const ia = labels.indexOf(a);
        const ib = labels.indexOf(b);
        const sa = (ia < firstChorus ? 1 : 0) + (count.get(a) ?? 0) * 0.1;
        const sb = (ib < firstChorus ? 1 : 0) + (count.get(b) ?? 0) * 0.1;
        return sb > sa ? b : a;
      });
    }
  } else {
    // no repetition: louder half → chorus-like
    const order = energy.map((e, i) => [e, i] as const).sort((a, b) => b[0] - a[0]);
    order.forEach(([, i], r) => (kinds[i] = r < Math.ceil(n / 3) ? 'chorus' : 'verse'));
  }
  if (repeated.length) {
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      if (l === chorus) kinds[i] = 'chorus';
      else if (l === verse) kinds[i] = 'verse';
      else if ((count.get(l) ?? 0) >= 2) {
        // a third repeated block: pre-chorus if it is short and always leads into the chorus,
        // bridge if it only appears after the first chorus, otherwise verse/chorus by energy
        const idx = labels.map((x, j) => (x === l ? j : -1)).filter((j) => j >= 0);
        const leadsIn = idx.every((j) => labels[j + 1] === chorus);
        const chorusLen = median(labels.map((x, j) => (x === chorus ? lengths[j] : NaN)).filter((v) => !Number.isNaN(v)));
        if (leadsIn && lengths[i] <= 0.75 * chorusLen) kinds[i] = 'pre-chorus';
        else if (chorus >= 0 && idx[0] > labels.indexOf(chorus)) kinds[i] = 'bridge';
        else kinds[i] = energy[i] > 0.6 ? 'chorus' : 'verse';
      }
      else {
        // unique material
        const next = labels[i + 1];
        if (i === 0) kinds[i] = 'intro';
        else if (i === n - 1) kinds[i] = 'outro';
        else if (next === chorus && lengths[i] <= 8 && labels[i - 1] !== chorus) kinds[i] = 'pre-chorus';
        else if (i > n / 2) kinds[i] = 'bridge';
        else kinds[i] = 'verse';
      }
    }
  }
  return kinds;
}
