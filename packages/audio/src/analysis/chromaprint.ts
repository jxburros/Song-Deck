/**
 * Chromaprint audio fingerprint (the algorithm behind AcoustID), ported to TypeScript from the
 * reference implementation (github.com/acoustid/chromaprint, MIT licence, © Lukas Lalinsky).
 *
 * Pipeline of the default algorithm (CHROMAPRINT_ALGORITHM_TEST2, id 1), stage by stage:
 *
 *   mono 16-bit PCM @ 11025 Hz
 *   → frames of 4096 samples every 1365 samples (overlap 4096 − 4096/3), full frames only
 *   → Hamming window (scaled by 1/32767) → real FFT → power spectrum
 *   → 12-band chroma of bins 28 Hz…3520 Hz (no interpolation)
 *   → 5-tap temporal filter [0.25 0.75 1 0.75 0.25] → Euclidean normalisation (norm < 0.01 → 0)
 *   → rolling integral image → 16 Haar-like classifiers (filter + 3-threshold quantizer, gray-coded)
 *   → one 32-bit sub-fingerprint per chroma row
 *
 * The compressed fingerprint ("AQAA…", what fpcalc prints and AcoustID accepts) is the
 * algorithm byte, a 24-bit length, XOR-delta bit positions packed as 3-bit normal values and
 * 5-bit exceptions, then URL-safe base64 without padding.
 *
 * Like `fpcalc`, input at other rates/channel counts is first down-mixed and band-limited
 * resampled to 11025 Hz and only the first 120 seconds are fingerprinted. fpcalc resamples
 * with FFmpeg (swresample) and computes its FFT in single precision, so for such input the
 * port is near-identical rather than bit-exact (validated against fpcalc 1.5.1 in
 * test/analysis-chromaprint.test.ts and documented in docs/RIGHTS.md); 16-bit mono input at
 * 11025 Hz bypasses resampling and reproduces fpcalc's fingerprint exactly.
 *
 * Fingerprints only identify the same recording (including re-encodes); they do not detect
 * covers, re-recordings, humming or melodies.
 */
import type { AudioData } from '../types';
import { getFFT } from './fft';

export const CHROMAPRINT_SAMPLE_RATE = 11025;
export const CHROMAPRINT_FRAME_SIZE = 4096;
export const CHROMAPRINT_FRAME_OVERLAP = CHROMAPRINT_FRAME_SIZE - Math.floor(CHROMAPRINT_FRAME_SIZE / 3);
/** CHROMAPRINT_ALGORITHM_TEST2 (the default; what AcoustID expects). */
export const CHROMAPRINT_ALGORITHM = 1;
/** fpcalc's default `-length`. */
export const CHROMAPRINT_MAX_SECONDS = 120;

const MIN_FREQ = 28;
const MAX_FREQ = 3520;
const NUM_BANDS = 12;
const FILTER_COEFFICIENTS = [0.25, 0.75, 1.0, 0.75, 0.25];

/** Classifier = Haar-like filter (type, y, height, width) + quantizer thresholds (t0, t1, t2). */
type Classifier = readonly [
  type: number,
  y: number,
  height: number,
  width: number,
  t0: number,
  t1: number,
  t2: number,
];

// kClassifiersTest2 from fingerprinter_configuration.cpp.
const CLASSIFIERS: readonly Classifier[] = [
  [0, 4, 3, 15, 1.98215, 2.35817, 2.63523],
  [4, 4, 6, 15, -1.03809, -0.651211, -0.282167],
  [1, 0, 4, 16, -0.298702, 0.119262, 0.558497],
  [3, 8, 2, 12, -0.105439, 0.0153946, 0.135898],
  [3, 4, 4, 8, -0.142891, 0.0258736, 0.200632],
  [4, 0, 3, 5, -0.826319, -0.590612, -0.368214],
  [1, 2, 2, 9, -0.557409, -0.233035, 0.0534525],
  [2, 7, 3, 4, -0.0646826, 0.00620476, 0.0784847],
  [2, 6, 2, 16, -0.192387, -0.029699, 0.215855],
  [2, 1, 3, 2, -0.0397818, -0.00568076, 0.0292026],
  [5, 10, 1, 15, -0.53823, -0.369934, -0.190235],
  [3, 6, 2, 10, -0.124877, 0.0296483, 0.139239],
  [2, 1, 1, 14, -0.101475, 0.0225617, 0.231971],
  [3, 5, 6, 4, -0.0799915, -0.00729616, 0.063262],
  [1, 9, 2, 12, -0.272556, 0.019424, 0.302559],
  [3, 4, 2, 14, -0.164292, -0.0321188, 0.0846339],
];
const MAX_FILTER_WIDTH = CLASSIFIERS.reduce((m, c) => Math.max(m, c[3]), 0);
const GRAY_CODE = [0, 1, 3, 2];

// ---------------------------------------------------------------------------------------------
// Core: 16-bit mono PCM at 11025 Hz → raw sub-fingerprints
// ---------------------------------------------------------------------------------------------

/** Chroma band (0..11) of every FFT bin in [minIndex, maxIndex). */
function prepareNotes(
  frameSize: number,
  sampleRate: number,
): { minIndex: number; maxIndex: number; notes: Int8Array } {
  const freqToIndex = (f: number) => {
    const x = (frameSize * f) / sampleRate;
    return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
  };
  const minIndex = Math.max(1, freqToIndex(MIN_FREQ));
  const maxIndex = Math.min(frameSize / 2, freqToIndex(MAX_FREQ));
  const notes = new Int8Array(frameSize);
  const base = 440 / 16;
  for (let i = minIndex; i < maxIndex; i++) {
    const freq = (i * sampleRate) / frameSize;
    const octave = Math.log(freq / base) / Math.log(2);
    const note = NUM_BANDS * (octave - Math.floor(octave));
    notes[i] = Math.trunc(note);
  }
  return { minIndex, maxIndex, notes };
}

/** Rolling integral image of 12-column chroma rows (keeps the last `maxRows` rows). */
class RollingIntegralImage {
  private readonly data: Float64Array;
  rows = 0;
  constructor(private readonly maxRows: number) {
    this.data = new Float64Array(maxRows * NUM_BANDS);
  }
  private row(i: number): number {
    return (i % this.maxRows) * NUM_BANDS;
  }
  addRow(features: ArrayLike<number>): void {
    const cur = this.row(this.rows);
    let acc = 0;
    for (let c = 0; c < NUM_BANDS; c++) {
      acc += features[c];
      this.data[cur + c] = acc;
    }
    if (this.rows > 0) {
      const last = this.row(this.rows - 1);
      for (let c = 0; c < NUM_BANDS; c++) this.data[cur + c] = this.data[last + c] + this.data[cur + c];
    }
    this.rows++;
  }
  area(r1: number, c1: number, r2: number, c2: number): number {
    if (r1 === r2 || c1 === c2) return 0;
    const d = this.data;
    if (r1 === 0) {
      const row = this.row(r2 - 1);
      return c1 === 0 ? d[row + c2 - 1] : d[row + c2 - 1] - d[row + c1 - 1];
    }
    const row1 = this.row(r1 - 1);
    const row2 = this.row(r2 - 1);
    if (c1 === 0) return d[row2 + c2 - 1] - d[row1 + c2 - 1];
    return d[row2 + c2 - 1] - d[row1 + c2 - 1] - d[row2 + c1 - 1] + d[row1 + c1 - 1];
  }
}

const subtractLog = (a: number, b: number) => Math.log((1 + a) / (1 + b));

/** filter_utils.h Filter0..Filter5 (x = time row, y = chroma band, w = width in rows, h = height in bands). */
function applyFilter(
  img: RollingIntegralImage,
  type: number,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  switch (type) {
    case 0:
      return subtractLog(img.area(x, y, x + w, y + h), 0);
    case 1: {
      const h2 = Math.floor(h / 2);
      return subtractLog(img.area(x, y + h2, x + w, y + h), img.area(x, y, x + w, y + h2));
    }
    case 2: {
      const w2 = Math.floor(w / 2);
      return subtractLog(img.area(x + w2, y, x + w, y + h), img.area(x, y, x + w2, y + h));
    }
    case 3: {
      const w2 = Math.floor(w / 2);
      const h2 = Math.floor(h / 2);
      const a = img.area(x, y + h2, x + w2, y + h) + img.area(x + w2, y, x + w, y + h2);
      const b = img.area(x, y, x + w2, y + h2) + img.area(x + w2, y + h2, x + w, y + h);
      return subtractLog(a, b);
    }
    case 4: {
      const h3 = Math.floor(h / 3);
      const a = img.area(x, y + h3, x + w, y + 2 * h3);
      const b = img.area(x, y, x + w, y + h3) + img.area(x, y + 2 * h3, x + w, y + h);
      return subtractLog(a, b);
    }
    case 5: {
      const w3 = Math.floor(w / 3);
      const a = img.area(x + w3, y, x + 2 * w3, y + h);
      const b = img.area(x, y, x + w3, y + h) + img.area(x + 2 * w3, y, x + w, y + h);
      return subtractLog(a, b);
    }
    default:
      return 0;
  }
}

function quantize(v: number, t0: number, t1: number, t2: number): number {
  if (v < t1) return v < t0 ? 0 : 1;
  return v < t2 ? 2 : 3;
}

/**
 * Raw Chromaprint sub-fingerprints of 16-bit mono PCM at 11025 Hz (no resampling). Samples
 * may be an Int16Array or any integer-valued array in −32768…32767.
 */
export function chromaprintRaw(samples: ArrayLike<number>): Uint32Array {
  const frameSize = CHROMAPRINT_FRAME_SIZE;
  const hop = frameSize - CHROMAPRINT_FRAME_OVERLAP;
  const { minIndex, maxIndex, notes } = prepareNotes(frameSize, CHROMAPRINT_SAMPLE_RATE);
  const window = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i++)
    window[i] = (0.54 - 0.46 * Math.cos((i * 2 * Math.PI) / (frameSize - 1))) / 32767;
  const fft = getFFT(frameSize);
  const re = new Float64Array(frameSize / 2 + 1);
  const im = new Float64Array(frameSize / 2 + 1);
  const features = new Float64Array(NUM_BANDS);
  // Chroma filter: ring buffer of the last 8 chroma vectors.
  const ring: Float64Array[] = Array.from({ length: 8 }, () => new Float64Array(NUM_BANDS));
  let ringOffset = 0;
  let ringSize = 1;
  const filtered = new Float64Array(NUM_BANDS);
  const image = new RollingIntegralImage(256 + 1);
  const out: number[] = [];

  const n = samples.length;
  for (let start = 0; start + frameSize <= n; start += hop) {
    fft.realForward(samples, re, im, window, start, frameSize);
    features.fill(0);
    for (let i = minIndex; i < maxIndex; i++) features[notes[i]] += re[i] * re[i] + im[i] * im[i];
    // ChromaFilter
    ring[ringOffset].set(features);
    ringOffset = (ringOffset + 1) % 8;
    if (ringSize < FILTER_COEFFICIENTS.length) {
      ringSize++;
      continue;
    }
    const offset = (ringOffset + 8 - FILTER_COEFFICIENTS.length) % 8;
    filtered.fill(0);
    for (let b = 0; b < NUM_BANDS; b++) {
      for (let j = 0; j < FILTER_COEFFICIENTS.length; j++)
        filtered[b] += ring[(offset + j) % 8][b] * FILTER_COEFFICIENTS[j];
    }
    // ChromaNormalizer (Euclidean norm, threshold 0.01)
    let sq = 0;
    for (let b = 0; b < NUM_BANDS; b++) sq += filtered[b] * filtered[b];
    const norm = sq > 0 ? Math.sqrt(sq) : 0;
    if (norm < 0.01) filtered.fill(0);
    else for (let b = 0; b < NUM_BANDS; b++) filtered[b] /= norm;
    // FingerprintCalculator
    image.addRow(filtered);
    if (image.rows >= MAX_FILTER_WIDTH) {
      const x = image.rows - MAX_FILTER_WIDTH;
      let bits = 0;
      for (const [type, y, h, w, t0, t1, t2] of CLASSIFIERS) {
        bits = ((bits << 2) | GRAY_CODE[quantize(applyFilter(image, type, x, y, w, h), t0, t1, t2)]) >>> 0;
      }
      out.push(bits);
    }
  }
  return Uint32Array.from(out);
}

// ---------------------------------------------------------------------------------------------
// Compression + base64 (fingerprint_compressor.cpp, utils/base64.h)
// ---------------------------------------------------------------------------------------------

function packBits(values: number[], bits: number): Uint8Array {
  const out = new Uint8Array(Math.floor((values.length * bits + 7) / 8));
  let pos = 0;
  for (const v of values) {
    for (let b = 0; b < bits; b++, pos++) if ((v >> b) & 1) out[pos >> 3] |= 1 << (pos & 7);
  }
  return out;
}

/** Compressed (binary) fingerprint, as chromaprint_get_fingerprint produces before base64. */
export function compressFingerprint(raw: ArrayLike<number>, algorithm = CHROMAPRINT_ALGORITHM): Uint8Array {
  const normal: number[] = [];
  const exceptional: number[] = [];
  const process = (x: number) => {
    let bit = 1;
    let lastBit = 0;
    x >>>= 0;
    while (x !== 0) {
      if ((x & 1) !== 0) {
        const value = bit - lastBit;
        if (value >= 7) {
          normal.push(7);
          exceptional.push(value - 7);
        } else normal.push(value);
        lastBit = bit;
      }
      x >>>= 1;
      bit++;
    }
    normal.push(0);
  };
  const size = raw.length;
  if (size > 0) {
    process(raw[0]);
    for (let i = 1; i < size; i++) process((raw[i] ^ raw[i - 1]) >>> 0);
  }
  const a = packBits(normal, 3);
  const b = packBits(exceptional, 5);
  const out = new Uint8Array(4 + a.length + b.length);
  out[0] = algorithm & 255;
  out[1] = (size >> 16) & 255;
  out[2] = (size >> 8) & 255;
  out[3] = size & 255;
  out.set(a, 4);
  out.set(b, 4 + a.length);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Chromaprint's URL-safe base64 without padding. */
export function chromaprintBase64(bytes: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const s0 = bytes[i];
    const s1 = bytes[i + 1];
    const s2 = bytes[i + 2];
    s +=
      B64[(s0 >> 2) & 63] +
      B64[((s0 << 4) | (s1 >> 4)) & 63] +
      B64[((s1 << 2) | (s2 >> 6)) & 63] +
      B64[s2 & 63];
  }
  const rest = bytes.length - i;
  if (rest === 2) {
    const s0 = bytes[i];
    const s1 = bytes[i + 1];
    s += B64[(s0 >> 2) & 63] + B64[((s0 << 4) | (s1 >> 4)) & 63] + B64[(s1 << 2) & 63];
  } else if (rest === 1) {
    const s0 = bytes[i];
    s += B64[(s0 >> 2) & 63] + B64[(s0 << 4) & 63];
  }
  return s;
}

/** Encoded fingerprint string ("AQAA…") from raw sub-fingerprints. */
export function encodeChromaprint(raw: ArrayLike<number>, algorithm = CHROMAPRINT_ALGORITHM): string {
  return chromaprintBase64(compressFingerprint(raw, algorithm));
}

// ---------------------------------------------------------------------------------------------
// AudioData front end (down-mix, resample, quantize — what fpcalc's FFmpeg reader does)
// ---------------------------------------------------------------------------------------------

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/**
 * Band-limited resampler (Kaiser-windowed sinc, β = 9, cutoff 0.97 × Nyquist of the lower rate,
 * 16 zero crossings) close to FFmpeg swresample's defaults. Returns at most `maxOut` samples.
 */
export function resampleForFingerprint(
  x: Float32Array,
  fromRate: number,
  toRate: number,
  maxOut = Infinity,
): Float32Array {
  const outLen = Math.max(0, Math.min(maxOut, Math.floor((x.length * toRate) / fromRate)));
  if (fromRate === toRate) return x.length > outLen ? x.subarray(0, outLen) : x;
  const out = new Float32Array(outLen);
  const ratio = toRate / fromRate;
  const cutoff = 0.97 * Math.min(1, ratio);
  const zeroCrossings = 16;
  const halfWidth = zeroCrossings / cutoff; // in input samples
  const beta = 9;
  const i0beta = besselI0(beta);
  const RES = 512;
  const tableLen = Math.ceil(halfWidth * RES) + 2;
  const table = new Float32Array(tableLen);
  for (let i = 0; i < tableLen; i++) {
    const t = i / RES;
    if (t >= halfWidth) break;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
    const u = t / halfWidth;
    table[i] = (cutoff * sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - u * u)))) / i0beta;
  }
  const step = fromRate / toRate;
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

export interface ChromaprintOptions {
  /** Seconds of audio fingerprinted from the start (default 120, like fpcalc). */
  maxSeconds?: number;
}

export interface ChromaprintResult {
  /** Compressed, base64-encoded fingerprint (AcoustID `fingerprint` parameter). */
  fingerprint: string;
  /** Raw 32-bit sub-fingerprints. */
  raw: Uint32Array;
  /** Duration of the whole input in seconds (AcoustID `duration`, rounded by the caller). */
  durationSeconds: number;
  algorithm: number;
}

/** Fingerprint decoded audio the way `fpcalc` does (mono, 11025 Hz, 16-bit, first 120 s). */
export function chromaprintFingerprint(audio: AudioData, opts: ChromaprintOptions = {}): ChromaprintResult {
  const frames = audio.channels[0]?.length ?? 0;
  const durationSeconds = audio.sampleRate > 0 ? frames / audio.sampleRate : 0;
  const maxSeconds = opts.maxSeconds ?? CHROMAPRINT_MAX_SECONDS;
  if (!frames || !(audio.sampleRate > 1000))
    return {
      fingerprint: encodeChromaprint([]),
      raw: new Uint32Array(0),
      durationSeconds,
      algorithm: CHROMAPRINT_ALGORITHM,
    };
  // Only read what the fingerprint needs (+ filter margin).
  const inFrames = Math.min(frames, Math.ceil(maxSeconds * audio.sampleRate) + 64);
  const mono = new Float32Array(inFrames);
  const nch = audio.channels.length;
  for (const ch of audio.channels) for (let i = 0; i < inFrames; i++) mono[i] += ch[i] / nch;
  const limit = Math.floor(maxSeconds * CHROMAPRINT_SAMPLE_RATE);
  const resampled = resampleForFingerprint(mono, audio.sampleRate, CHROMAPRINT_SAMPLE_RATE, limit);
  const pcm = new Int16Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    const v = Math.round(resampled[i] * 32768);
    pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  const raw = chromaprintRaw(pcm);
  return { fingerprint: encodeChromaprint(raw), raw, durationSeconds, algorithm: CHROMAPRINT_ALGORITHM };
}

/** Bit error rate between two raw fingerprints over their common length (0 = identical). */
export function fingerprintBitErrorRate(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (!n) return a.length === b.length ? 0 : 1;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    let v = (a[i] ^ b[i]) >>> 0;
    while (v) {
      v &= v - 1;
      diff++;
    }
  }
  return diff / (n * 32);
}
