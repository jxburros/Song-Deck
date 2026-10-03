/**
 * Small numeric helpers shared by the analysis modules (private to analysis/; only a few are
 * re-exported). Everything here is deterministic and allocation-conscious: analysis runs on
 * multi-minute songs inside Web Workers and Node render nodes.
 */
import type { AudioData } from '../types';

/** Preferred internal analysis rate. Inputs are decimated by an integer factor towards it. */
export const ANALYSIS_RATE = 22050;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Power of two closest (in log scale) to `seconds * sampleRate`. */
export function pow2ForDuration(seconds: number, sampleRate: number, min = 64, max = 1 << 16): number {
  const n = Math.max(min, Math.min(max, seconds * sampleRate));
  return 1 << Math.round(Math.log2(n));
}

export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function mean(a: ArrayLike<number>, start = 0, end = a.length): number {
  if (end <= start) return 0;
  let s = 0;
  for (let i = start; i < end; i++) s += a[i];
  return s / (end - start);
}

export function std(a: ArrayLike<number>, start = 0, end = a.length): number {
  if (end - start < 2) return 0;
  const m = mean(a, start, end);
  let s = 0;
  for (let i = start; i < end; i++) {
    const d = a[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / (end - start));
}

export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values as ArrayLike<number>);
  a.sort();
  return n % 2 ? a[n >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

/** Linear-interpolated percentile (p in 0..100). */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values as ArrayLike<number>);
  a.sort();
  const pos = clamp(p / 100, 0, 1) * (n - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < n ? a[i] * (1 - f) + a[i + 1] * f : a[i];
}

export function maxOf(a: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return a.length ? m : 0;
}

export function argMax(a: ArrayLike<number>, start = 0, end = a.length): number {
  let bi = start;
  let bv = -Infinity;
  for (let i = start; i < end; i++) {
    if (a[i] > bv) {
      bv = a[i];
      bi = i;
    }
  }
  return bi;
}

export function linToDb(v: number, floorDb = -120): number {
  return v > 0 ? Math.max(floorDb, 20 * Math.log10(v)) : floorDb;
}

export function powToDb(v: number, floorDb = -120): number {
  return v > 0 ? Math.max(floorDb, 10 * Math.log10(v)) : floorDb;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Pearson correlation of two equal-length vectors (0 when either is constant). */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a, 0, n);
  const mb = mean(b, 0, n);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Centered moving average with edge shrinking. */
export function movingAverage(x: ArrayLike<number>, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  return out;
}

/** Centered moving maximum (window 2*radius+1). */
export function movingMax(x: ArrayLike<number>, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    const a = Math.max(0, i - radius);
    const b = Math.min(n - 1, i + radius);
    for (let j = a; j <= b; j++) if (x[j] > m) m = x[j];
    out[i] = m;
  }
  return out;
}

/** Gaussian smoothing (sigma in samples). */
export function gaussianSmooth(x: ArrayLike<number>, sigma: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (sigma <= 0) {
    for (let i = 0; i < n; i++) out[i] = x[i];
    return out;
  }
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp((-0.5 * i * i) / (sigma * sigma));
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    for (let j = -r; j <= r; j++) {
      const t = i + j;
      if (t < 0 || t >= n) continue;
      s += x[t] * k[j + r];
      w += k[j + r];
    }
    out[i] = w > 0 ? s / w : 0;
  }
  return out;
}

/**
 * Sliding median over a strided series (in place into `dst`), window `2*radius+1`, edges
 * replicated. Uses an insertion-sorted window: O(n * width), fast for the small widths used
 * by HPSS (≈ 9..41).
 */
export function slidingMedianStrided(
  src: Float32Array,
  offset: number,
  stride: number,
  count: number,
  radius: number,
  dst: Float32Array,
  scratch?: { buf: Float32Array; win: Float32Array },
): void {
  if (count <= 0) return;
  const width = 2 * radius + 1;
  const buf = scratch && scratch.buf.length >= count ? scratch.buf : new Float32Array(count);
  const win = scratch && scratch.win.length >= width ? scratch.win : new Float32Array(width);
  for (let i = 0; i < count; i++) buf[i] = src[offset + i * stride];
  // initial window: positions -radius..radius (replicated edges)
  let wn = 0;
  for (let j = -radius; j <= radius; j++) {
    const v = buf[j < 0 ? 0 : j >= count ? count - 1 : j];
    // insertion
    let p = wn;
    while (p > 0 && win[p - 1] > v) {
      win[p] = win[p - 1];
      p--;
    }
    win[p] = v;
    wn++;
  }
  const mid = radius;
  for (let i = 0; i < count; i++) {
    dst[offset + i * stride] = win[mid];
    if (i + 1 >= count) break;
    // remove outgoing (i - radius), insert incoming (i + 1 + radius)
    const outIdx = i - radius;
    const inIdx = i + 1 + radius;
    const vo = buf[outIdx < 0 ? 0 : outIdx >= count ? count - 1 : outIdx];
    const vi = buf[inIdx < 0 ? 0 : inIdx >= count ? count - 1 : inIdx];
    if (vo === vi) continue;
    // binary search position of vo
    let lo = 0;
    let hi = width - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (win[m] < vo) lo = m + 1;
      else hi = m;
    }
    let pos = lo;
    // replace win[pos] (== vo) with vi, then bubble to keep sorted
    win[pos] = vi;
    while (pos > 0 && win[pos - 1] > vi) {
      win[pos] = win[pos - 1];
      win[pos - 1] = vi;
      pos--;
    }
    while (pos < width - 1 && win[pos + 1] < vi) {
      win[pos] = win[pos + 1];
      win[pos + 1] = vi;
      pos++;
    }
  }
}

// ---------------------------------------------------------------------------
// Mono mix-down and integer decimation (kept private: the dsp module owns the public
// `toMono` / `resample`).
// ---------------------------------------------------------------------------

/** Average of all channels. Returns the channel itself (not a copy) for mono input — never mutate. */
export function analysisMono(buf: AudioData): Float32Array {
  const chs = buf.channels;
  if (chs.length === 0) return new Float32Array(0);
  if (chs.length === 1) return chs[0];
  const n = chs[0].length;
  const out = new Float32Array(n);
  const g = 1 / chs.length;
  for (const ch of chs) {
    const m = Math.min(n, ch.length);
    for (let i = 0; i < m; i++) out[i] += ch[i] * g;
  }
  return out;
}

const decimatorCache = new Map<number, Float64Array>();

function decimationFilter(factor: number): Float64Array {
  const cached = decimatorCache.get(factor);
  if (cached) return cached;
  const half = 16 * factor;
  const taps = 2 * half + 1;
  const h = new Float64Array(taps);
  const fc = (0.5 / factor) * 0.9; // cutoff, cycles per input sample
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - half;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  decimatorCache.set(factor, h);
  return h;
}

/** Low-pass + keep every `factor`-th sample. */
export function analysisDecimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x;
  const h = decimationFilter(factor);
  const half = (h.length - 1) >> 1;
  const n = x.length;
  const outLen = Math.ceil(n / factor);
  const out = new Float32Array(outLen);
  for (let o = 0; o < outLen; o++) {
    const c = o * factor;
    let acc = 0;
    const k0 = Math.max(0, half - c);
    const k1 = Math.min(h.length - 1, half + (n - 1 - c));
    for (let k = k0; k <= k1; k++) acc += h[k] * x[c + k - half];
    out[o] = acc;
  }
  return out;
}

/** Integer decimation factor that brings `sampleRate` closest to the analysis rate (never below ~16 kHz). */
export function decimationFactor(sampleRate: number, target = ANALYSIS_RATE): number {
  return Math.max(1, Math.round(sampleRate / target));
}

/**
 * Generic band-limited resampler (windowed sinc, linear table interpolation). Only used
 * where an exact target rate is required; analysis normally uses `analysisDecimate`.
 */
export function analysisResample(x: Float32Array, fromRate: number, toRate: number, zeroCrossings = 12): Float32Array {
  if (fromRate === toRate || x.length === 0) return x;
  const ratio = toRate / fromRate;
  const outLen = Math.max(0, Math.round(x.length * ratio));
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, ratio) * 0.92;
  const halfWidth = Math.ceil(zeroCrossings / cutoff);
  const RES = 128;
  const tableLen = halfWidth * RES + 2;
  const table = new Float32Array(tableLen);
  for (let i = 0; i < tableLen; i++) {
    const t = i / RES;
    const s = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
    const u = t / halfWidth;
    const w = u >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
    table[i] = cutoff * s * w;
  }
  const step = 1 / ratio;
  const n = x.length;
  for (let o = 0; o < outLen; o++) {
    const center = o * step;
    const i0 = Math.max(0, Math.ceil(center - halfWidth));
    const i1 = Math.min(n - 1, Math.floor(center + halfWidth));
    let acc = 0;
    for (let i = i0; i <= i1; i++) {
      const d = Math.abs(center - i) * RES;
      const k = d | 0;
      const f = d - k;
      acc += x[i] * (table[k] + (table[k + 1] - table[k]) * f);
    }
    out[o] = acc;
  }
  return out;
}

/** Mono signal at (approximately) the analysis rate. */
export function prepareMono(buf: AudioData, target = ANALYSIS_RATE): { x: Float32Array; sr: number } {
  const mono = analysisMono(buf);
  const f = decimationFactor(buf.sampleRate, target);
  if (f <= 1) return { x: mono, sr: buf.sampleRate };
  return { x: analysisDecimate(mono, f), sr: buf.sampleRate / f };
}

/** All channels decimated towards the analysis rate. */
export function prepareChannels(buf: AudioData, target = ANALYSIS_RATE): AudioData {
  const f = decimationFactor(buf.sampleRate, target);
  if (f <= 1) return buf;
  return { sampleRate: buf.sampleRate / f, channels: buf.channels.map((c) => analysisDecimate(c, f)) };
}

export function rmsOf(x: ArrayLike<number>, start = 0, end = x.length): number {
  if (end <= start) return 0;
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / (end - start));
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export function abortError(message = 'Analysis aborted'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Let the event loop run (abort handlers, UI messages) between heavy synchronous stages. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deterministic 32-bit hash of a few audio samples (stable seeds/ids for analysis output). */
export function audioFingerprint(x: Float32Array): number {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(x.length / 4096));
  for (let i = 0; i < x.length; i += step) {
    const v = Math.round(x[i] * 32767) | 0;
    h ^= v & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  h ^= x.length;
  return h >>> 0;
}
