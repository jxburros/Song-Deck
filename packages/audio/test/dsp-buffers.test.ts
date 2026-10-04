import { describe, expect, it } from 'vitest';
import {
  applyFades,
  concatAudio,
  gainAudio,
  mixBuffers,
  normalizePeak,
  resample,
  sliceAudio,
  spliceWithCrossfade,
  toMono,
  toStereo,
} from '../src/dsp';
import { cents, db, peak, rms, sine, toneMag, yinF0 } from './dsp-helpers';

describe('buffer utilities', () => {
  it('resamples with preserved pitch/level and good anti-aliasing', () => {
    for (const [from, to] of [
      [44100, 48000],
      [48000, 44100],
      [22050, 44100],
      [44100, 32000],
      [44100, 44099],
    ]) {
      const x = sine(1000, 1, from, 0.5);
      const y = resample(x, to);
      expect(y.sampleRate).toBe(to);
      expect(y.channels[0].length).toBe(Math.round(from === to ? from : to));
      expect(Math.abs(cents(yinF0(y.channels[0], to, 4000), 1000)), `${from}->${to}`).toBeLessThan(2);
      expect(rms(y.channels[0], 4000, to - 4000)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    }
    // a 20 kHz tone at 48 kHz must be removed when going to 22.05 kHz (Nyquist 11 kHz)
    const hi = sine(20000, 0.5, 48000, 0.5);
    const lo = resample(hi, 22050);
    expect(rms(lo.channels[0], 2000, lo.channels[0].length - 2000)).toBeLessThan(0.5 * 1e-3);
    // band-limited content below the new Nyquist passes
    expect(
      toneMag(resample(sine(9000, 0.5, 48000, 0.5), 22050).channels[0], 22050, 9000, 1000, 8192),
    ).toBeGreaterThan(0.1);
  });

  it('converts channels, gains, normalizes, slices and concatenates', () => {
    const st = { sampleRate: 1000, channels: [Float32Array.of(1, 0, -1), Float32Array.of(0, 1, 1)] };
    expect(Array.from(toMono(st).channels[0])).toEqual([0.5, 0.5, 0]);
    const s2 = toStereo({ sampleRate: 1000, channels: [Float32Array.of(0.25, -0.5)] });
    expect(s2.channels.length).toBe(2);
    expect(Array.from(s2.channels[1])).toEqual([0.25, -0.5]);
    const g = gainAudio(s2, -6.0206);
    expect(g.channels[0][1]).toBeCloseTo(-0.25, 4);
    const n = normalizePeak(s2, 0);
    expect(peak(n.channels[0])).toBeCloseTo(1, 6);
    const x = sine(100, 2, 8000);
    const sl = sliceAudio(x, 0.5, 1.25);
    expect(sl.channels[0].length).toBe(6000);
    expect(sl.channels[0][0]).toBe(x.channels[0][4000]);
    const c = concatAudio([sl, sine(100, 0.5, 4000)]);
    expect(c.sampleRate).toBe(8000);
    expect(c.channels[0].length).toBe(10000);
    // inputs are never mutated
    expect(st.channels[0][0]).toBe(1);
  });

  it('mixes buffers of different rates, lengths and channel counts', () => {
    const a = sine(440, 1, 44100, 0.25, 2);
    const b = sine(440, 0.5, 22050, 0.25, 1);
    const m = mixBuffers([a, b], [1, 2]);
    expect(m.sampleRate).toBe(44100);
    expect(m.channels.length).toBe(2);
    expect(m.channels[0].length).toBe(44100);
    // in-phase addition: 0.25 + 2·0.25 = 0.75 peak in the overlap
    expect(peak(m.channels[1], 1000, 20000)).toBeCloseTo(0.75, 2);
    expect(peak(m.channels[1], 30000, 44100)).toBeCloseTo(0.25, 2);
  });

  it('applies click-free fades', () => {
    const x = sine(200, 1, 8000, 0.5);
    const f = applyFades(x, 0.1, 0.2);
    expect(Math.abs(f.channels[0][0])).toBeLessThan(1e-3);
    expect(Math.abs(f.channels[0][7999])).toBeLessThan(1e-3);
    expect(rms(f.channels[0], 2000, 4000)).toBeCloseTo(rms(x.channels[0], 2000, 4000), 6);
  });

  it('splices with an equal-power crossfade and extends the base when needed', () => {
    const sr = 8000;
    const base = sine(100, 2, sr, 0.5);
    const ins = sine(300, 0.5, sr, 0.5);
    const out = spliceWithCrossfade(base, ins, 1, 0.02);
    expect(out.channels[0].length).toBe(2 * sr);
    expect(
      Math.abs(cents(yinF0(out.channels[0], sr, Math.round(1.2 * sr), 1024, 50, 1000), 300)),
    ).toBeLessThan(5);
    expect(
      Math.abs(cents(yinF0(out.channels[0], sr, Math.round(0.4 * sr), 1024, 50, 1000), 100)),
    ).toBeLessThan(5);
    expect(
      Math.abs(cents(yinF0(out.channels[0], sr, Math.round(1.6 * sr), 1024, 50, 1000), 100)),
    ).toBeLessThan(5);
    // no discontinuity at the boundaries
    let maxStep = 0;
    for (let i = sr - 400; i < sr + 400; i++)
      maxStep = Math.max(maxStep, Math.abs(out.channels[0][i] - out.channels[0][i - 1]));
    expect(maxStep).toBeLessThan(0.15);
    // past the end + different sample rate and channel count
    const ext = spliceWithCrossfade(sine(100, 1, sr, 0.5, 2), sine(300, 1, 16000, 0.5, 1), 0.75, 0.01);
    expect(ext.channels.length).toBe(2);
    expect(ext.sampleRate).toBe(sr);
    expect(ext.channels[0].length).toBe(Math.round(1.75 * sr));
    expect(db(rms(ext.channels[1], Math.round(1.2 * sr), Math.round(1.6 * sr)))).toBeGreaterThan(-10);
  });
});
