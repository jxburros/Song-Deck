/**
 * Built-in source separation (DSP, not a neural separator — confidences say so).
 *
 *  1. HPSS (Fitzgerald 2010): median filtering of the magnitude spectrogram across time
 *     (harmonic enhancement) and frequency (percussive enhancement) → soft Wiener-like masks.
 *     Percussive → drums.
 *  2. Bass: harmonic content below ≈ 120–260 Hz (smooth crossover) plus the bass's own upper
 *     partials — a per-frame bass f0 (harmonic summation) defines a harmonic comb whose bins are
 *     claimed by the bass, Wiener-style, only up to the energy a partial of that bass would carry,
 *     and only for centre-panned content.
 *  3. Vocals: centre-panned (stereo L/R similarity, Avendano 2003) harmonic mid-band content,
 *     emphasised where the harmonic magnitude "fluctuates" relative to its 1-second median
 *     (second-stage HPSS idea of Tachibana/FitzGerald: vibrato and melodic motion vs. steady
 *     accompaniment). Mono input → only the fluctuation cue → much lower confidence.
 *  4. Other = everything else.
 *
 * Masks form an exact partition of unity per time-frequency bin and the inverse STFT uses
 * weighted overlap-add normalisation, so the four stems sum back to the input (≈ float error).
 */
import type { AudioData } from '../types';
import { OverlapAdd, StftFrameReader, forEachStftFrame, resolveWindow, stftFrameCount } from './stft';
import type { StemName } from './types';
import { abortError, clamp01, pow2ForDuration, sanitizeSignal, slidingMedianStrided } from './util';

export interface SeparationOptions {
  onProgress?(p: number): void;
  signal?: AbortSignal;
  /** Analysis window (s), default ≈ 0.093. */
  windowSeconds?: number;
}

export interface SeparationResult {
  stems: { drums: AudioData; bass: AudioData; vocals: AudioData; other: AudioData };
  method: string;
  confidence: Record<StemName, number>;
}

/** Median filter along time for every bin (rows = frames), cache-friendly (all bins advance together). */
export function medianFilterTime(
  src: Float32Array,
  frames: number,
  bins: number,
  radius: number,
  dst = new Float32Array(src.length),
): Float32Array {
  if (frames === 0) return dst;
  const width = 2 * radius + 1;
  const win = new Float32Array(bins * width);
  const row = (t: number): number => (t < 0 ? 0 : t >= frames ? frames - 1 : t) * bins;
  for (let k = 0; k < bins; k++) {
    const o = k * width;
    let n = 0;
    for (let j = -radius; j <= radius; j++) {
      const v = src[row(j) + k];
      let p = n;
      while (p > 0 && win[o + p - 1] > v) {
        win[o + p] = win[o + p - 1];
        p--;
      }
      win[o + p] = v;
      n++;
    }
  }
  for (let t = 0; t < frames; t++) {
    const base = t * bins;
    for (let k = 0; k < bins; k++) dst[base + k] = win[k * width + radius];
    if (t + 1 >= frames) break;
    const ro = row(t - radius);
    const ri = row(t + 1 + radius);
    for (let k = 0; k < bins; k++) {
      const vo = src[ro + k];
      const vi = src[ri + k];
      if (vo === vi) continue;
      const o = k * width;
      let lo = 0;
      let hi = width - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (win[o + m] < vo) lo = m + 1;
        else hi = m;
      }
      let p = lo;
      win[o + p] = vi;
      while (p > 0 && win[o + p - 1] > vi) {
        win[o + p] = win[o + p - 1];
        win[o + p - 1] = vi;
        p--;
      }
      while (p < width - 1 && win[o + p + 1] < vi) {
        win[o + p] = win[o + p + 1];
        win[o + p + 1] = vi;
        p++;
      }
    }
  }
  return dst;
}

/** Median filter along frequency within one frame row. */
export function medianFilterFreqRow(
  src: Float32Array,
  offset: number,
  bins: number,
  radius: number,
  dst: Float32Array,
  dstOffset = 0,
  scratch?: { buf: Float32Array; win: Float32Array },
): void {
  if (dstOffset === offset && dst === src) {
    slidingMedianStrided(src, offset, 1, bins, radius, dst, scratch);
    return;
  }
  // slidingMedianStrided writes at the same offsets it reads: use a temporary row
  const tmp = new Float32Array(bins);
  for (let k = 0; k < bins; k++) tmp[k] = src[offset + k];
  slidingMedianStrided(tmp, 0, 1, bins, radius, tmp, scratch);
  for (let k = 0; k < bins; k++) dst[dstOffset + k] = tmp[k];
}

/** Median filter along frequency for every frame. */
export function medianFilterFreq(
  src: Float32Array,
  frames: number,
  bins: number,
  radius: number,
  dst = new Float32Array(src.length),
): Float32Array {
  const scratch = { buf: new Float32Array(bins), win: new Float32Array(2 * radius + 1) };
  if (dst !== src) dst.set(src);
  for (let t = 0; t < frames; t++) slidingMedianStrided(dst, t * bins, 1, bins, radius, dst, scratch);
  return dst;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Low-frequency (bass) share of harmonic content at frequency f. */
function bassWeight(f: number): number {
  return 1 - smoothstep(120, 260, f);
}

/** Vocal-band weighting. */
function vocalBandWeight(f: number): number {
  if (f < 140) return 0;
  if (f < 260) return smoothstep(140, 260, f);
  if (f <= 4500) return 1;
  return 0.35 + 0.65 * (1 - smoothstep(4500, 9000, f));
}

/** Split a mix into drums / bass / vocals / other stems (same rate and channel count as the input). */
export function separateSources(buf: AudioData, opts: SeparationOptions = {}): SeparationResult {
  const sr = buf.sampleRate;
  const chans = (
    buf.channels.length >= 2
      ? [buf.channels[0], buf.channels[1]]
      : buf.channels.length === 1
        ? [buf.channels[0]]
        : [new Float32Array(0)]
  ).map(sanitizeSignal);
  const stereo = chans.length === 2;
  const len = chans[0].length;
  const fftSize = pow2ForDuration(opts.windowSeconds ?? 0.093, sr, 512, 16384);
  const hop = fftSize >> 2;
  const nb = (fftSize >> 1) + 1;
  const binHz = sr / fftSize;
  const frames = stftFrameCount(len, fftSize, hop, true);
  const win = resolveWindow('hann', fftSize);
  const progress = (p: number): void => opts.onProgress?.(clamp01(p));
  const check = (): void => {
    if (opts.signal?.aborted) throw abortError('Separation aborted');
  };
  check();
  progress(0);

  // ---- pass 1: mono magnitude ---------------------------------------------------------------
  const M = new Float32Array(frames * nb);
  const accumulate = (ch: Float32Array, first: boolean): void => {
    forEachStftFrame(ch, { fftSize, hop }, (t, re, im) => {
      if ((t & 1023) === 0) check();
      const o = t * nb;
      if (first) for (let k = 0; k < nb; k++) M[o + k] = re[k] * re[k] + im[k] * im[k];
      else for (let k = 0; k < nb; k++) M[o + k] += re[k] * re[k] + im[k] * im[k];
    });
  };
  accumulate(chans[0], true);
  progress(0.08);
  if (stereo) accumulate(chans[1], false);
  const g = 1 / chans.length;
  for (let i = 0; i < M.length; i++) M[i] = Math.sqrt(M[i] * g);
  progress(0.16);
  check();

  // ---- stage 1 HPSS ---------------------------------------------------------------------------
  const tRad1 = Math.max(4, Math.round(0.2 / (hop / sr)));
  const fRad1 = Math.max(4, Math.round(90 / binHz));
  const Hmed = medianFilterTime(M, frames, nb, tRad1);
  progress(0.3);
  check();
  const freqScratch = { buf: new Float32Array(nb), win: new Float32Array(2 * fRad1 + 1) };
  const pRow = new Float32Array(nb);
  // M → Hm (harmonic magnitude) in place
  for (let t = 0; t < frames; t++) {
    const o = t * nb;
    for (let k = 0; k < nb; k++) pRow[k] = M[o + k];
    slidingMedianStrided(pRow, 0, 1, nb, fRad1, pRow, freqScratch);
    for (let k = 0; k < nb; k++) {
      const h = Hmed[o + k];
      const p = pRow[k];
      const mh = (h * h) / (h * h + p * p + 1e-20);
      M[o + k] *= mh;
    }
  }
  progress(0.4);
  check();
  // ---- stage 2: long-term harmonic median (fluctuation cue) -------------------------------------
  const tRad2 = Math.max(8, Math.round(0.5 / (hop / sr)));
  const H2 = medianFilterTime(M, frames, nb, tRad2);
  progress(0.5);
  // ---- bass pitch per frame (harmonic summation on the harmonic spectrogram) -------------------
  // The bass's upper partials reach far into the vocal band; bins on its harmonic comb are
  // routed to the bass stem instead of leaking into vocals/other.
  const { f0: bassF0, conf: bassConf, amp: bassAmp } = bassPitchTrack(M, frames, nb, binHz);
  progress(0.55);
  check();

  // ---- pass 2: masks + resynthesis -------------------------------------------------------------
  const wsum = OverlapAdd.windowSum(len, fftSize, hop, win, true);
  const names: StemName[] = ['drums', 'bass', 'vocals', 'other'];
  // drums, bass and vocals are resynthesised; "other" = input − (drums + bass + vocals), which equals
  // the masked resynthesis exactly (masks partition unity, the WOLA inverse is linear and exact)
  const ola = names
    .slice(0, 3)
    .map(() => chans.map(() => new OverlapAdd(len, fftSize, hop, win, true, wsum)));
  const specs = chans.map(() => ({ re: new Float64Array(nb), im: new Float64Array(nb) }));
  const outRe = new Float64Array(nb);
  const outIm = new Float64Array(nb);
  const masks = names.map(() => new Float32Array(nb));
  const bw = new Float32Array(nb);
  const vw = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    bw[k] = bassWeight(k * binHz);
    vw[k] = vocalBandWeight(k * binHz);
  }
  const alpha = stereo ? 0.55 : 0.12;
  const energy = { drums: 0, bass: 0, vocals: 0, other: 0, total: 0, centreVocal: 0 };
  const readers = chans.map((ch) => new StftFrameReader(ch, fftSize, hop, win, true));
  const mono = new Float32Array(nb);
  for (let t = 0; t < frames; t++) {
    if ((t & 511) === 0) {
      check();
      progress(0.55 + 0.45 * (t / frames));
    }
    for (let c = 0; c < chans.length; c++) readers[c].read(t, specs[c].re, specs[c].im);
    const o = t * nb;
    // recompute stage-1 harmonic mask for this frame from the channel spectra
    for (let k = 0; k < nb; k++) {
      let p = 0;
      for (let c = 0; c < chans.length; c++)
        p += specs[c].re[k] * specs[c].re[k] + specs[c].im[k] * specs[c].im[k];
      pRow[k] = Math.sqrt(p * g);
      mono[k] = pRow[k];
    }
    slidingMedianStrided(pRow, 0, 1, nb, fRad1, pRow, freqScratch);
    for (let k = 0; k < nb; k++) {
      const h = Hmed[o + k];
      const p = pRow[k];
      const mh = (h * h) / (h * h + p * p + 1e-20);
      const hm = mono[k] * mh;
      const h2 = H2[o + k];
      const ex = hm > h2 ? hm - h2 : 0;
      const fluct = hm > 1e-12 ? clamp01(((ex * ex) / (hm * hm)) * 1.6) : 0;
      let centre = 1;
      let centreSoft = 1;
      if (stereo) {
        const lr = specs[0].re[k];
        const li = specs[0].im[k];
        const rr = specs[1].re[k];
        const ri = specs[1].im[k];
        const pl = lr * lr + li * li;
        const pr = rr * rr + ri * ri;
        const cross = lr * rr + li * ri;
        const psi = pl + pr > 1e-20 ? Math.max(0, (2 * cross) / (pl + pr)) : 0;
        const p2 = psi * psi;
        centre = p2 * p2 * p2;
        centreSoft = p2;
      }
      const vocalShare = vw[k] * centre * (alpha + (1 - alpha) * fluct);
      let bShare = bw[k];
      const f0b = bassF0[t];
      if (f0b > 0 && k * binHz > 150) {
        const h = (k * binHz) / f0b;
        const n = Math.round(h);
        if (n >= 2 && n <= 12) {
          const d = Math.abs(k * binHz - n * f0b) / binHz;
          const sig = 0.7 + 0.08 * n;
          // Wiener-style: the bass can only claim what a partial of its amplitude would carry
          const expected = bassAmp[t] / n; // bassAmp is measured on the harmonic spectrogram
          const obs = mono[k] * mh + 1e-12;
          const ratio = Math.min(1, (expected * expected) / (obs * obs));
          // bass is (almost always) centre-panned: side content on its comb stays where it is
          bShare = Math.max(bShare, 0.9 * bassConf[t] * centreSoft * ratio * Math.exp(-0.5 * (d / sig) ** 2));
        }
      }
      const nonBass = mh * (1 - bShare);
      masks[0][k] = 1 - mh;
      masks[1][k] = mh * bShare;
      masks[2][k] = nonBass * vocalShare;
      masks[3][k] = nonBass * (1 - vocalShare);
      const e = mono[k] * mono[k];
      energy.total += e;
      energy.drums += e * masks[0][k] * masks[0][k];
      energy.bass += e * masks[1][k] * masks[1][k];
      energy.vocals += e * masks[2][k] * masks[2][k];
      energy.other += e * masks[3][k] * masks[3][k];
      energy.centreVocal += e * masks[2][k] * masks[2][k] * centre;
    }
    for (let s = 0; s < 3; s++) {
      const m = masks[s];
      for (let c = 0; c < chans.length; c++) {
        const sp = specs[c];
        for (let k = 0; k < nb; k++) {
          outRe[k] = sp.re[k] * m[k];
          outIm[k] = sp.im[k] * m[k];
        }
        ola[s][c].add(t, outRe, outIm);
      }
    }
  }
  const stems = {} as SeparationResult['stems'];
  names.slice(0, 3).forEach((n, s) => {
    stems[n] = { sampleRate: sr, channels: ola[s].map((o) => o.finish()) };
  });
  stems.other = {
    sampleRate: sr,
    channels: chans.map((ch, c) => {
      const o = new Float32Array(len);
      const d = stems.drums.channels[c];
      const b = stems.bass.channels[c];
      const v = stems.vocals.channels[c];
      for (let i = 0; i < len; i++) o[i] = ch[i] - d[i] - b[i] - v[i];
      return o;
    }),
  };
  // If the input had more than two channels, the extra channels are ignored (stems are stereo).
  const tot = energy.total || 1;
  const presence = (e: number): number => 0.45 + 0.55 * clamp01(e / tot / 0.08);
  const vocalCentre = energy.vocals > 0 ? energy.centreVocal / energy.vocals : 0;
  const confidence: Record<StemName, number> = {
    drums: round3(0.62 * presence(energy.drums)),
    bass: round3(0.55 * presence(energy.bass)),
    vocals: round3((stereo ? 0.3 + 0.2 * vocalCentre : 0.22) * presence(energy.vocals)),
    other: round3(0.4 * presence(energy.other)),
  };
  progress(1);
  return {
    stems,
    method: stereo
      ? 'builtin-dsp: two-stage median-filter HPSS + stereo centre similarity + bass low-pass/harmonic-comb split'
      : 'builtin-dsp: two-stage median-filter HPSS + bass low-pass/harmonic-comb split (mono: vocals by fluctuation only)',
    confidence,
  };
}

/**
 * Bass f0 per frame by harmonic summation (35–260 Hz candidates, 8 partials) on a magnitude
 * spectrogram, with a confidence = share of the low/mid harmonic energy on that comb.
 */
export function bassPitchTrack(
  mag: Float32Array,
  frames: number,
  bins: number,
  binHz: number,
): { f0: Float32Array; conf: Float32Array; amp: Float32Array } {
  const f0 = new Float32Array(frames);
  const conf = new Float32Array(frames);
  const amp = new Float32Array(frames);
  const cands: number[] = [];
  for (let f = 35; f <= 260; f *= Math.pow(2, 1 / 96)) cands.push(f);
  const maxHz = Math.min(1500, (bins - 2) * binHz);
  const kLo = Math.max(1, Math.floor(35 / binHz));
  const kHi = Math.min(bins - 2, Math.ceil(maxHz / binHz));
  const kBassHi = Math.ceil(260 / binHz);
  const at = (o: number, hz: number): number => {
    const x = hz / binHz;
    const i = Math.floor(x);
    if (i + 1 >= bins) return 0;
    const fr = x - i;
    return mag[o + i] * (1 - fr) + mag[o + i + 1] * fr;
  };
  for (let t = 0; t < frames; t++) {
    const o = t * bins;
    let total = 0;
    let lowMax = 0;
    for (let k = kLo; k <= kHi; k++) total += mag[o + k];
    for (let k = kLo; k <= kBassHi; k++) lowMax = Math.max(lowMax, mag[o + k]);
    if (total <= 1e-12 || lowMax <= 0) continue;
    let best = -1;
    let bestS = 0;
    for (const c of cands) {
      if (at(o, c) < 0.25 * lowMax) continue; // the fundamental must be present
      let s = 0;
      for (let h = 1; h <= 8; h++) {
        const hz = c * h;
        if (hz > maxHz) break;
        s += at(o, hz) / Math.sqrt(h);
      }
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    if (best < 0) continue;
    // confidence: share of the low/mid harmonic energy sitting on the comb
    let comb = 0;
    for (let h = 1; h <= 8; h++) {
      const hz = best * h;
      if (hz > maxHz) break;
      const k = Math.round(hz / binHz);
      for (let d = -1; d <= 1; d++) if (k + d >= kLo && k + d <= kHi) comb += mag[o + k + d];
    }
    f0[t] = best;
    conf[t] = clamp01((comb / total) * 1.6);
    amp[t] = at(o, best);
  }
  return { f0, conf, amp };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
