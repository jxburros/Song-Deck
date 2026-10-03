import { describe, expect, it } from 'vitest';
import { FFT, fftReal, getFFT, ifftReal, istft, stft } from '../src/analysis';
import { lcg } from './analysis-signals';

function naiveDft(x: number[]): { re: number[]; im: number[] } {
  const n = x.length;
  const re: number[] = [];
  const im: number[] = [];
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      sr += x[t] * Math.cos((2 * Math.PI * k * t) / n);
      si -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
    re.push(sr);
    im.push(si);
  }
  return { re, im };
}

describe('analysis: FFT', () => {
  it('real FFT matches a naive DFT for many sizes', () => {
    const rnd = lcg(42);
    for (const n of [2, 4, 8, 16, 64, 256, 1024]) {
      const x = Array.from({ length: n }, () => rnd() * 2 - 1);
      const ref = naiveDft(x);
      const { re, im } = fftReal(x, n);
      let err = 0;
      let mag = 0;
      for (let k = 0; k <= n / 2; k++) {
        err = Math.max(err, Math.abs(re[k] - ref.re[k]), Math.abs(im[k] - ref.im[k]));
        mag = Math.max(mag, Math.abs(ref.re[k]), Math.abs(ref.im[k]));
      }
      expect(err / Math.max(1, mag)).toBeLessThan(1e-9);
      // inverse round trip
      const back = ifftReal(re, im, n);
      for (let t = 0; t < n; t++) expect(back[t]).toBeCloseTo(x[t], 9);
    }
  });

  it('complex FFT forward/inverse matches the naive DFT and round-trips', () => {
    const rnd = lcg(7);
    const n = 128;
    const x = Array.from({ length: n }, () => rnd() - 0.5);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    const plan = new FFT(n);
    plan.forward(re, im);
    const ref = naiveDft(x);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 9);
      expect(im[k]).toBeCloseTo(ref.im[k], 9);
    }
    plan.inverse(re, im);
    for (let t = 0; t < n; t++) {
      expect(re[t]).toBeCloseTo(x[t], 12);
      expect(im[t]).toBeCloseTo(0, 12);
    }
    expect(getFFT(n)).toBe(getFFT(n)); // plans are cached
  });

  it('rejects non power-of-two sizes', () => {
    expect(() => new FFT(100)).toThrow();
  });
});

describe('analysis: STFT / ISTFT', () => {
  it('reconstructs the input perfectly (< -60 dB error)', () => {
    const rnd = lcg(3);
    const sr = 22050;
    const x = new Float32Array(sr * 2 + 123);
    for (let i = 0; i < x.length; i++)
      x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr) + 0.2 * (rnd() * 2 - 1);
    for (const [fftSize, hop] of [
      [1024, 256],
      [2048, 512],
      [512, 256],
    ] as const) {
      const spec = stft(x, { fftSize, hop });
      expect(spec.numBins).toBe(fftSize / 2 + 1);
      const y = istft(spec);
      expect(y.length).toBe(x.length);
      let err = 0;
      let sig = 0;
      for (let i = 0; i < x.length; i++) {
        err += (x[i] - y[i]) ** 2;
        sig += x[i] ** 2;
      }
      const db = 10 * Math.log10(err / sig);
      expect(db).toBeLessThan(-60);
    }
  });

  it('places a sinusoid in the right bin', () => {
    const sr = 22050;
    const n = 2048;
    const hz = (100 * sr) / n; // exactly bin 100
    const x = new Float32Array(sr);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / sr);
    const spec = stft(x, { fftSize: n, hop: 512 });
    const t = 5;
    let best = 0;
    let bestV = 0;
    for (let k = 0; k < spec.numBins; k++) {
      const v = Math.hypot(spec.re[t * spec.numBins + k], spec.im[t * spec.numBins + k]);
      if (v > bestV) {
        bestV = v;
        best = k;
      }
    }
    expect(best).toBe(100);
  });
});
