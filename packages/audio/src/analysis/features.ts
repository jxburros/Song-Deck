/**
 * Frame-level spectral features: filterbanks (mel / log-spaced), centroid, flatness, rolloff,
 * RMS, spectral flux, MFCC-like timbre coefficients.
 */
import type { MagnitudeSpectrogram } from './stft';

export interface Filterbank {
  numBands: number;
  /** First bin of each band. */
  start: Int32Array;
  /** Weights per band (bins start..start+len-1). */
  weights: Float32Array[];
  /** Centre frequency of each band (Hz). */
  centers: Float32Array;
}

export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

export function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function triangularBank(edgesHz: number[], fftSize: number, sampleRate: number, normalize: boolean): Filterbank {
  const numBands = edgesHz.length - 2;
  const binHz = sampleRate / fftSize;
  const nb = (fftSize >> 1) + 1;
  const start = new Int32Array(numBands);
  const weights: Float32Array[] = [];
  const centers = new Float32Array(numBands);
  for (let b = 0; b < numBands; b++) {
    const lo = edgesHz[b];
    const c = edgesHz[b + 1];
    const hi = edgesHz[b + 2];
    centers[b] = c;
    let k0 = Math.max(0, Math.floor(lo / binHz));
    let k1 = Math.min(nb - 1, Math.ceil(hi / binHz));
    // guarantee at least one bin (narrow low bands)
    const kc = Math.min(nb - 1, Math.max(0, Math.round(c / binHz)));
    if (k1 < k0) k1 = k0;
    const w: number[] = [];
    for (let k = k0; k <= k1; k++) {
      const f = k * binHz;
      let v = 0;
      if (f >= lo && f <= c) v = c > lo ? (f - lo) / (c - lo) : 1;
      else if (f > c && f <= hi) v = hi > c ? (hi - f) / (hi - c) : 1;
      w.push(Math.max(0, v));
    }
    let sum = w.reduce((a, b2) => a + b2, 0);
    if (sum <= 0) {
      k0 = kc;
      w.length = 0;
      w.push(1);
      sum = 1;
    }
    const arr = Float32Array.from(w);
    if (normalize) for (let i = 0; i < arr.length; i++) arr[i] /= sum;
    start[b] = k0;
    weights.push(arr);
  }
  return { numBands, start, weights, centers };
}

/** Mel-spaced triangular filterbank. */
export function melFilterbank(numBands: number, fMin: number, fMax: number, fftSize: number, sampleRate: number, normalize = true): Filterbank {
  const mMin = hzToMel(fMin);
  const mMax = hzToMel(Math.min(fMax, sampleRate / 2));
  const edges: number[] = [];
  for (let i = 0; i < numBands + 2; i++) edges.push(melToHz(mMin + ((mMax - mMin) * i) / (numBands + 1)));
  return triangularBank(edges, fftSize, sampleRate, normalize);
}

/** Log-frequency-spaced triangular filterbank. */
export function logFilterbank(numBands: number, fMin: number, fMax: number, fftSize: number, sampleRate: number, normalize = true): Filterbank {
  const lMin = Math.log(fMin);
  const lMax = Math.log(Math.min(fMax, sampleRate / 2));
  const edges: number[] = [];
  for (let i = 0; i < numBands + 2; i++) edges.push(Math.exp(lMin + ((lMax - lMin) * i) / (numBands + 1)));
  return triangularBank(edges, fftSize, sampleRate, normalize);
}

/** Apply a filterbank to one frame of a (power or magnitude) spectrum. */
export function applyFilterbank(fb: Filterbank, frame: ArrayLike<number>, frameOffset: number, out: Float32Array, outOffset = 0, square = false): void {
  for (let b = 0; b < fb.numBands; b++) {
    const w = fb.weights[b];
    const s = fb.start[b] + frameOffset;
    let acc = 0;
    if (square) {
      for (let i = 0; i < w.length; i++) {
        const v = frame[s + i];
        acc += w[i] * v * v;
      }
    } else {
      for (let i = 0; i < w.length; i++) acc += w[i] * frame[s + i];
    }
    out[outOffset + b] = acc;
  }
}

/** Band energies (power) for every frame of a magnitude spectrogram: [frame * numBands + band]. */
export function bandEnergies(spec: MagnitudeSpectrogram, fb: Filterbank): Float32Array {
  const out = new Float32Array(spec.numFrames * fb.numBands);
  for (let t = 0; t < spec.numFrames; t++) applyFilterbank(fb, spec.mag, t * spec.numBins, out, t * fb.numBands, true);
  return out;
}

/** Spectral centroid (Hz) of one magnitude frame. */
export function spectralCentroid(mag: ArrayLike<number>, offset: number, numBins: number, binHz: number): number {
  let num = 0;
  let den = 0;
  for (let k = 1; k < numBins; k++) {
    const v = mag[offset + k];
    num += v * k * binHz;
    den += v;
  }
  return den > 0 ? num / den : 0;
}

/** Spectral flatness (geometric / arithmetic mean of power) over bins [k0, k1). 0 = tonal, 1 = white noise. */
export function spectralFlatness(mag: ArrayLike<number>, offset: number, k0: number, k1: number): number {
  let logSum = 0;
  let sum = 0;
  let n = 0;
  for (let k = k0; k < k1; k++) {
    const p = mag[offset + k] * mag[offset + k] + 1e-12;
    logSum += Math.log(p);
    sum += p;
    n++;
  }
  if (n === 0 || sum <= 0) return 0;
  return Math.exp(logSum / n) / (sum / n);
}

/** Frequency below which `fraction` of the spectral energy lies. */
export function spectralRolloff(mag: ArrayLike<number>, offset: number, numBins: number, binHz: number, fraction = 0.85): number {
  let total = 0;
  for (let k = 0; k < numBins; k++) total += mag[offset + k] * mag[offset + k];
  if (total <= 0) return 0;
  let acc = 0;
  for (let k = 0; k < numBins; k++) {
    acc += mag[offset + k] * mag[offset + k];
    if (acc >= fraction * total) return k * binHz;
  }
  return (numBins - 1) * binHz;
}

/** Frame RMS with centred frames (frame t centred on t·hop). */
export function frameRms(x: Float32Array, frameSize: number, hop: number): Float32Array {
  const frames = 1 + Math.floor(x.length / hop);
  const out = new Float32Array(frames);
  const cs = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + x[i] * x[i];
  const half = frameSize >> 1;
  for (let t = 0; t < frames; t++) {
    const a = Math.max(0, t * hop - half);
    const b = Math.min(x.length, t * hop + half);
    out[t] = b > a ? Math.sqrt((cs[b] - cs[a]) / frameSize) : 0;
  }
  return out;
}

/** Zero-crossing rate per frame (crossings per sample). */
export function zeroCrossingRate(x: Float32Array, frameSize: number, hop: number): Float32Array {
  const frames = 1 + Math.floor(x.length / hop);
  const out = new Float32Array(frames);
  const half = frameSize >> 1;
  for (let t = 0; t < frames; t++) {
    const a = Math.max(1, t * hop - half);
    const b = Math.min(x.length, t * hop + half);
    let z = 0;
    for (let i = a; i < b; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) z++;
    out[t] = b > a ? z / (b - a) : 0;
  }
  return out;
}

/**
 * Positive spectral flux of log-compressed band energies (rows = frames). Uses a ±1 band
 * maximum filter on the previous frame (SuperFlux-style vibrato suppression).
 */
export function logBandFlux(bands: Float32Array, numBands: number, numFrames: number, lag = 1, maxFilter = true): Float32Array {
  const flux = new Float32Array(numFrames);
  for (let t = lag; t < numFrames; t++) {
    const o = t * numBands;
    const p = (t - lag) * numBands;
    let s = 0;
    for (let b = 0; b < numBands; b++) {
      let ref = bands[p + b];
      if (maxFilter) {
        if (b > 0 && bands[p + b - 1] > ref) ref = bands[p + b - 1];
        if (b + 1 < numBands && bands[p + b + 1] > ref) ref = bands[p + b + 1];
      }
      const d = bands[o + b] - ref;
      if (d > 0) s += d;
    }
    flux[t] = s / numBands;
  }
  return flux;
}

/** DCT-II of log band energies → cepstral (MFCC-like) coefficients, c0 excluded. */
export function cepstrum(logBands: ArrayLike<number>, offset: number, numBands: number, numCoeffs: number, out: Float32Array, outOffset = 0): void {
  for (let c = 1; c <= numCoeffs; c++) {
    let s = 0;
    for (let b = 0; b < numBands; b++) s += logBands[offset + b] * Math.cos((Math.PI * c * (b + 0.5)) / numBands);
    out[outOffset + c - 1] = s * Math.sqrt(2 / numBands);
  }
}
