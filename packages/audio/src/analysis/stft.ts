/**
 * Short-time Fourier transform with exact weighted-overlap-add inversion.
 *
 * Frames are centred by default (frame t is centred on sample t·hop; the signal is
 * zero-padded by fftSize/2 on both sides), like librosa. `istft` divides by the summed
 * squared window, so analysis → synthesis is an identity wherever the window sum is non-zero
 * (perfect reconstruction for any hop ≤ fftSize/2 with Hann).
 */
import { getFFT } from './fft';
import { analysisWindow, type WindowType } from './windows';

export interface StftOptions {
  fftSize: number;
  hop: number;
  window?: WindowType | Float32Array;
  /** Centre frames on t·hop (default true). */
  center?: boolean;
}

export interface Spectrogram {
  fftSize: number;
  hop: number;
  numFrames: number;
  /** fftSize / 2 + 1 */
  numBins: number;
  /** Frame-major real parts: re[frame * numBins + bin]. */
  re: Float32Array;
  im: Float32Array;
  window: Float32Array;
  center: boolean;
  /** Length of the analysed signal (samples). */
  length: number;
}

/** Magnitude-only spectrogram (frame-major), cheaper to keep around for long signals. */
export interface MagnitudeSpectrogram {
  fftSize: number;
  hop: number;
  numFrames: number;
  numBins: number;
  sampleRate: number;
  /** mag[frame * numBins + bin] */
  mag: Float32Array;
  center: boolean;
}

export function resolveWindow(w: WindowType | Float32Array | undefined, size: number): Float32Array {
  if (w instanceof Float32Array) {
    if (w.length !== size) throw new Error(`window length ${w.length} != fftSize ${size}`);
    return w;
  }
  return analysisWindow(w ?? 'hann', size, true);
}

export function stftFrameCount(length: number, fftSize: number, hop: number, center = true): number {
  if (center) return 1 + Math.floor(length / hop);
  return length < fftSize ? 1 : 1 + Math.floor((length - fftSize) / hop);
}

/**
 * Iterate STFT frames without storing them. The callback receives the frame index and the
 * half spectrum (re/im scratch arrays, valid only during the call).
 */
export function forEachStftFrame(
  x: Float32Array,
  opts: StftOptions,
  cb: (t: number, re: Float64Array, im: Float64Array) => void,
  firstFrame = 0,
  lastFrame?: number,
): number {
  const n = opts.fftSize;
  const hop = opts.hop;
  const center = opts.center !== false;
  const win = resolveWindow(opts.window, n);
  const plan = getFFT(n);
  const frames = stftFrameCount(x.length, n, hop, center);
  const end = Math.min(frames, lastFrame ?? frames);
  const scratch = new Float64Array(n);
  const re = new Float64Array((n >> 1) + 1);
  const im = new Float64Array((n >> 1) + 1);
  const pad = center ? n >> 1 : 0;
  const len = x.length;
  for (let t = firstFrame; t < end; t++) {
    const s = t * hop - pad;
    if (s >= 0 && s + n <= len) {
      plan.realForward(x, re, im, win, s, n);
    } else {
      for (let i = 0; i < n; i++) {
        const j = s + i;
        scratch[i] = j >= 0 && j < len ? x[j] : 0;
      }
      plan.realForward(scratch, re, im, win);
    }
    cb(t, re, im);
  }
  return frames;
}

/** Random-access reader of single STFT frames with reusable buffers. */
export class StftFrameReader {
  private readonly scratch: Float64Array;
  private readonly win: Float32Array;
  private readonly pad: number;

  constructor(
    private readonly x: Float32Array,
    private readonly fftSize: number,
    private readonly hop: number,
    window?: WindowType | Float32Array,
    center = true,
  ) {
    this.scratch = new Float64Array(fftSize);
    this.win = resolveWindow(window, fftSize);
    this.pad = center ? fftSize >> 1 : 0;
  }

  /** Half spectrum of frame t into re/im (length ≥ fftSize/2 + 1). */
  read(t: number, re: Float64Array, im: Float64Array): void {
    const n = this.fftSize;
    const s = t * this.hop - this.pad;
    const plan = getFFT(n);
    const len = this.x.length;
    if (s >= 0 && s + n <= len) {
      plan.realForward(this.x, re, im, this.win, s, n);
      return;
    }
    for (let i = 0; i < n; i++) {
      const j = s + i;
      this.scratch[i] = j >= 0 && j < len ? this.x[j] : 0;
    }
    plan.realForward(this.scratch, re, im, this.win);
  }
}

/** Complex STFT of a mono signal. */
export function stft(buf: Float32Array, opts: StftOptions): Spectrogram {
  const n = opts.fftSize;
  const nb = (n >> 1) + 1;
  const center = opts.center !== false;
  const frames = stftFrameCount(buf.length, n, opts.hop, center);
  const re = new Float32Array(frames * nb);
  const im = new Float32Array(frames * nb);
  forEachStftFrame(buf, opts, (t, fr, fi) => {
    const o = t * nb;
    for (let k = 0; k < nb; k++) {
      re[o + k] = fr[k];
      im[o + k] = fi[k];
    }
  });
  return { fftSize: n, hop: opts.hop, numFrames: frames, numBins: nb, re, im, window: resolveWindow(opts.window, n), center, length: buf.length };
}

/** Inverse STFT (weighted overlap-add, normalised by the summed squared window). */
export function istft(spec: Spectrogram, opts: { length?: number; window?: Float32Array } = {}): Float32Array {
  const n = spec.fftSize;
  const hop = spec.hop;
  const nb = spec.numBins;
  const w = opts.window ?? spec.window;
  const length = opts.length ?? spec.length;
  const pad = spec.center ? n >> 1 : 0;
  const total = Math.max((spec.numFrames - 1) * hop + n, length + pad);
  const y = new Float64Array(total);
  const wsum = new Float64Array(total);
  const plan = getFFT(n);
  const frame = new Float64Array(n);
  for (let t = 0; t < spec.numFrames; t++) {
    const o = t * nb;
    plan.realInverse(spec.re.subarray(o, o + nb), spec.im.subarray(o, o + nb), frame);
    const s = t * hop;
    for (let i = 0; i < n; i++) {
      y[s + i] += frame[i] * w[i];
      wsum[s + i] += w[i] * w[i];
    }
  }
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const j = i + pad;
    const ws = wsum[j];
    out[i] = ws > 1e-10 ? y[j] / ws : 0;
  }
  return out;
}

/** |X| of a complex spectrogram (frame-major). */
export function spectrogramMagnitude(spec: Spectrogram): Float32Array {
  const out = new Float32Array(spec.re.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(spec.re[i], spec.im[i]);
  return out;
}

/** Magnitude spectrogram computed frame by frame (no complex storage). */
export function magnitudeSpectrogram(x: Float32Array, sampleRate: number, opts: StftOptions): MagnitudeSpectrogram {
  const n = opts.fftSize;
  const nb = (n >> 1) + 1;
  const center = opts.center !== false;
  const frames = stftFrameCount(x.length, n, opts.hop, center);
  const mag = new Float32Array(frames * nb);
  forEachStftFrame(x, opts, (t, re, im) => {
    const o = t * nb;
    for (let k = 0; k < nb; k++) mag[o + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  });
  return { fftSize: n, hop: opts.hop, numFrames: frames, numBins: nb, sampleRate, mag, center };
}

/**
 * Streaming weighted overlap-add synthesiser: feed modified half spectra frame by frame,
 * then `finish()` returns the normalised signal. Several instances can share one analysis
 * pass (e.g. one per separated stem).
 */
export class OverlapAdd {
  private readonly y: Float32Array;
  private readonly frame: Float64Array;
  private readonly pad: number;

  constructor(
    private readonly length: number,
    private readonly fftSize: number,
    private readonly hop: number,
    private readonly window: Float32Array,
    center = true,
    /** Shared normaliser (Σ w²); computed once per (length, fftSize, hop). */
    private readonly wsum: Float32Array = OverlapAdd.windowSum(length, fftSize, hop, window, center),
  ) {
    this.pad = center ? fftSize >> 1 : 0;
    const frames = stftFrameCount(length, fftSize, hop, center);
    this.y = new Float32Array(Math.max((frames - 1) * hop + fftSize, length + this.pad));
    this.frame = new Float64Array(fftSize);
  }

  static windowSum(length: number, fftSize: number, hop: number, window: Float32Array, center = true): Float32Array {
    const pad = center ? fftSize >> 1 : 0;
    const frames = stftFrameCount(length, fftSize, hop, center);
    const total = Math.max((frames - 1) * hop + fftSize, length + pad);
    const ws = new Float32Array(total);
    for (let t = 0; t < frames; t++) {
      const s = t * hop;
      for (let i = 0; i < fftSize; i++) ws[s + i] += window[i] * window[i];
    }
    return ws;
  }

  add(t: number, re: ArrayLike<number>, im: ArrayLike<number>): void {
    const plan = getFFT(this.fftSize);
    plan.realInverse(re, im, this.frame);
    const s = t * this.hop;
    const w = this.window;
    const y = this.y;
    const f = this.frame;
    for (let i = 0; i < this.fftSize; i++) y[s + i] += f[i] * w[i];
  }

  finish(): Float32Array {
    const out = new Float32Array(this.length);
    for (let i = 0; i < this.length; i++) {
      const j = i + this.pad;
      const ws = this.wsum[j];
      out[i] = ws > 1e-10 ? this.y[j] / ws : 0;
    }
    return out;
  }
}

/** Bin index → frequency (Hz). */
export function binFrequency(bin: number, fftSize: number, sampleRate: number): number {
  return (bin * sampleRate) / fftSize;
}

/** Frequency → nearest bin index. */
export function frequencyBin(hz: number, fftSize: number, sampleRate: number): number {
  return Math.round((hz * fftSize) / sampleRate);
}
