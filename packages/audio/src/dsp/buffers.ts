/**
 * AudioData utilities: mixing, high-quality resampling (Kaiser-windowed sinc, exact polyphase for
 * rational ratios), channel conversion, normalization, slicing, fades, crossfaded splicing.
 * All functions return new buffers (inputs are never mutated).
 */
import type { AudioData } from '../types';
import { besselI0, dbToGain, gcd } from './utils';

function frames(buf: AudioData): number {
  return buf.channels[0]?.length ?? 0;
}

function emptyLike(sampleRate: number, n: number, nch: number): AudioData {
  return {
    sampleRate,
    channels: Array.from({ length: Math.max(1, nch) }, () => new Float32Array(Math.max(0, n))),
  };
}

function clone(buf: AudioData): AudioData {
  return { sampleRate: buf.sampleRate, channels: buf.channels.map((c) => new Float32Array(c)) };
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

const RS_HALF_ZEROS = 16; // zero crossings each side (for cutoff = 1)
const RS_BETA = 8.6;

function kaiserWin(t: number, halfWidth: number): number {
  const r = t / halfWidth;
  if (r <= -1 || r >= 1) return 0;
  return besselI0(RS_BETA * Math.sqrt(1 - r * r)) / besselI0(RS_BETA);
}

function sincK(x: number): number {
  if (Math.abs(x) < 1e-12) return 1;
  return Math.sin(Math.PI * x) / (Math.PI * x);
}

/**
 * Resample to `sampleRate`. Anti-aliasing cutoff at 0.95 × the lower Nyquist, ~-90 dB stopband.
 * Rational ratios with ≤ 2048 phases use an exact precomputed polyphase bank.
 */
export function resample(buf: AudioData, sampleRate: number): AudioData {
  const inSr = buf.sampleRate;
  const outSr = Math.round(sampleRate);
  if (!(outSr > 0)) throw new Error(`resample: invalid sample rate ${sampleRate}`);
  if (Math.round(inSr) === outSr) return clone(buf);
  const n = frames(buf);
  const ratio = outSr / inSr;
  const outN = Math.round(n * ratio);
  const fc = Math.min(1, ratio) * 0.95; // cutoff relative to the input Nyquist
  const half = RS_HALF_ZEROS / fc; // kernel half width in input samples
  const taps = Math.ceil(half) * 2 + 1;
  const g = gcd(Math.round(inSr), outSr);
  const up = outSr / g;
  const down = Math.round(inSr) / g;
  const out = emptyLike(outSr, outN, buf.channels.length);
  if (up <= 2048 && Number.isInteger(up) && Number.isInteger(down)) {
    // exact polyphase: output j sits at input position j·down/up = base + phase/up
    const bank = new Float64Array(up * taps);
    const offset = Math.ceil(half);
    for (let p = 0; p < up; p++) {
      const frac = p / up;
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const t = k - offset - frac; // input index (base + k - offset) relative to position
        const v = fc * sincK(fc * t) * kaiserWin(t, half);
        bank[p * taps + k] = v;
        sum += v;
      }
      // normalize DC gain to 1 for each phase
      for (let k = 0; k < taps; k++) bank[p * taps + k] /= sum / 1;
    }
    for (let c = 0; c < buf.channels.length; c++) {
      const x = buf.channels[c];
      const y = out.channels[c];
      for (let j = 0; j < outN; j++) {
        const num = j * down;
        const base = Math.floor(num / up);
        const p = num - base * up;
        const start = base - offset;
        const bo = p * taps;
        let s = 0;
        if (start >= 0 && start + taps <= n) {
          for (let k = 0; k < taps; k++) s += bank[bo + k] * x[start + k];
        } else {
          for (let k = 0; k < taps; k++) {
            const i = start + k;
            if (i >= 0 && i < n) s += bank[bo + k] * x[i];
          }
        }
        y[j] = s;
      }
    }
    return out;
  }
  // general ratio: fine table with linear interpolation between phases
  const interp = new SincInterpolator(RS_HALF_ZEROS, 512, fc);
  for (let c = 0; c < buf.channels.length; c++) {
    const x = buf.channels[c];
    const y = out.channels[c];
    for (let j = 0; j < outN; j++) y[j] = interp.read(x, j / ratio);
  }
  return out;
}

/**
 * Band-limited fractional reader (windowed sinc, linear interpolation between table phases).
 * Used for on-the-fly resampling of audio clips in the renderer.
 */
export class SincInterpolator {
  private readonly table: Float64Array;
  private readonly res: number;
  private readonly halfTaps: number;
  private readonly fc: number;
  private readonly halfWidth: number;

  /** @param zeros zero crossings per side at cutoff 1; @param res table points per input sample; @param fc cutoff (≤1, × input Nyquist) */
  constructor(zeros = 8, res = 256, fc = 0.95) {
    this.fc = Math.max(0.01, Math.min(1, fc));
    this.halfWidth = zeros / this.fc;
    this.halfTaps = Math.ceil(this.halfWidth);
    this.res = res;
    const len = this.halfTaps * res + 2;
    this.table = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / res;
      this.table[i] = this.fc * sincK(this.fc * t) * kaiserWin(t, this.halfWidth);
    }
  }

  /** Value of `x` at fractional index `pos` (zero outside the buffer). */
  read(x: ArrayLike<number>, pos: number): number {
    const base = Math.floor(pos);
    const frac = pos - base;
    const n = x.length;
    const res = this.res;
    const tab = this.table;
    const ht = this.halfTaps;
    let s = 0;
    let wsum = 0;
    for (let k = -ht + 1; k <= ht; k++) {
      const t = Math.abs(k - frac) * res;
      const ti = t | 0;
      if (ti + 1 >= tab.length) continue;
      const w = tab[ti] + (t - ti) * (tab[ti + 1] - tab[ti]);
      wsum += w;
      const i = base + k;
      if (i >= 0 && i < n) s += w * x[i];
    }
    return wsum !== 0 ? s / wsum : 0;
  }
}

// ---------------------------------------------------------------------------
// Channel conversion and simple operations
// ---------------------------------------------------------------------------

export function toMono(buf: AudioData): AudioData {
  const n = frames(buf);
  if (buf.channels.length <= 1) return clone(buf.channels.length ? buf : emptyLike(buf.sampleRate, 0, 1));
  const out = new Float32Array(n);
  const k = 1 / buf.channels.length;
  for (const ch of buf.channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return { sampleRate: buf.sampleRate, channels: [out] };
}

export function toStereo(buf: AudioData): AudioData {
  if (buf.channels.length >= 2)
    return {
      sampleRate: buf.sampleRate,
      channels: [new Float32Array(buf.channels[0]), new Float32Array(buf.channels[1])],
    };
  const src = buf.channels[0] ?? new Float32Array(0);
  return { sampleRate: buf.sampleRate, channels: [new Float32Array(src), new Float32Array(src)] };
}

function conform(buf: AudioData, sampleRate: number, nch: number): AudioData {
  let b = Math.round(buf.sampleRate) === Math.round(sampleRate) ? buf : resample(buf, sampleRate);
  if (nch === 2 && b.channels.length === 1) b = toStereo(b);
  else if (nch === 1 && b.channels.length > 1) b = toMono(b);
  return b;
}

export function gainAudio(buf: AudioData, db: number): AudioData {
  const g = dbToGain(db);
  return {
    sampleRate: buf.sampleRate,
    channels: buf.channels.map((c) => Float32Array.from(c, (v) => v * g)),
  };
}

/** Scale so that the sample peak equals `peakDb` dBFS (silence is returned unchanged). */
export function normalizePeak(buf: AudioData, peakDb = -1): AudioData {
  let pk = 0;
  for (const ch of buf.channels) for (let i = 0; i < ch.length; i++) pk = Math.max(pk, Math.abs(ch[i]));
  if (pk <= 0) return clone(buf);
  const g = dbToGain(peakDb) / pk;
  return {
    sampleRate: buf.sampleRate,
    channels: buf.channels.map((c) => Float32Array.from(c, (v) => v * g)),
  };
}

/** Sum buffers (linear gains, default 1). Output: first buffer's rate, max channel count, max length. */
export function mixBuffers(bufs: AudioData[], gains?: number[]): AudioData {
  if (!bufs.length) return emptyLike(44100, 0, 2);
  const sr = bufs[0].sampleRate;
  const nch = Math.max(...bufs.map((b) => Math.min(2, b.channels.length)));
  const conformed = bufs.map((b) => conform(b, sr, nch));
  const n = Math.max(...conformed.map(frames));
  const out = emptyLike(sr, n, nch);
  conformed.forEach((b, bi) => {
    const g = gains?.[bi] ?? 1;
    for (let c = 0; c < nch; c++) {
      const src = b.channels[Math.min(c, b.channels.length - 1)];
      const dst = out.channels[c];
      for (let i = 0; i < src.length; i++) dst[i] += src[i] * g;
    }
  });
  return out;
}

export function concatAudio(bufs: AudioData[]): AudioData {
  if (!bufs.length) return emptyLike(44100, 0, 2);
  const sr = bufs[0].sampleRate;
  const nch = Math.max(...bufs.map((b) => Math.min(2, b.channels.length)));
  const conformed = bufs.map((b) => conform(b, sr, nch));
  const total = conformed.reduce((a, b) => a + frames(b), 0);
  const out = emptyLike(sr, total, nch);
  let o = 0;
  for (const b of conformed) {
    for (let c = 0; c < nch; c++) out.channels[c].set(b.channels[Math.min(c, b.channels.length - 1)], o);
    o += frames(b);
  }
  return out;
}

/** Copy of [startSec, endSec) (clamped to the buffer). */
export function sliceAudio(buf: AudioData, startSec: number, endSec?: number): AudioData {
  const n = frames(buf);
  const a = Math.max(0, Math.min(n, Math.round(startSec * buf.sampleRate)));
  const b = Math.max(a, Math.min(n, endSec === undefined ? n : Math.round(endSec * buf.sampleRate)));
  return { sampleRate: buf.sampleRate, channels: buf.channels.map((c) => c.slice(a, b)) };
}

/** Raised-cosine fade in / fade out (seconds). */
export function applyFades(buf: AudioData, inSec: number, outSec: number): AudioData {
  const out = clone(buf);
  const n = frames(out);
  const fi = Math.min(n, Math.max(0, Math.round(inSec * buf.sampleRate)));
  const fo = Math.min(n, Math.max(0, Math.round(outSec * buf.sampleRate)));
  for (const ch of out.channels) {
    for (let i = 0; i < fi; i++) ch[i] *= 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / fi);
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / fo);
  }
  return out;
}

/**
 * Replace `base` from `atSeconds` with `insert` (converted to base's rate/channels), equal-power
 * crossfading `crossfadeSeconds` at both boundaries (the crossfades sit inside the inserted span).
 * The result is extended if the insert runs past the end of `base`.
 */
export function spliceWithCrossfade(
  base: AudioData,
  insert: AudioData,
  atSeconds: number,
  crossfadeSeconds = 0.01,
): AudioData {
  const sr = base.sampleRate;
  const nch = Math.max(1, Math.min(2, base.channels.length));
  const ins = conform(insert, sr, nch);
  const at = Math.max(0, Math.round(atSeconds * sr));
  const insN = frames(ins);
  const baseN = frames(base);
  const n = Math.max(baseN, at + insN);
  const xf = Math.max(0, Math.min(Math.floor(insN / 2), Math.round(crossfadeSeconds * sr)));
  const out = emptyLike(sr, n, nch);
  for (let c = 0; c < nch; c++) {
    const b = base.channels[Math.min(c, base.channels.length - 1)] ?? new Float32Array(0);
    const s = ins.channels[Math.min(c, ins.channels.length - 1)];
    const o = out.channels[c];
    o.set(b.subarray(0, Math.min(baseN, n)));
    for (let i = 0; i < insN; i++) {
      const j = at + i;
      const bv = j < baseN ? b[j] : 0;
      let gi = 1;
      if (xf > 0 && i < xf) gi = Math.sin(((i + 0.5) / xf) * (Math.PI / 2));
      else if (xf > 0 && i >= insN - xf) gi = Math.sin(((insN - i - 0.5) / xf) * (Math.PI / 2));
      const gb = gi >= 1 ? 0 : Math.sqrt(Math.max(0, 1 - gi * gi));
      o[j] = s[i] * gi + bv * gb;
    }
  }
  return out;
}
