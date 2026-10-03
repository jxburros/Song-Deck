import { describe, expect, it } from 'vitest';
import { kWeightingCoefficients, measureLoudness } from '../src/dsp';
import type { AudioData } from '../src/types';

function tone(freq: number, seconds: number, sr: number, ampDb: number, phase = 0, fadeSec = 0.05): Float32Array {
  const n = Math.round(seconds * sr);
  const a = Math.pow(10, ampDb / 20);
  const x = new Float32Array(n);
  const fl = Math.round(fadeSec * sr);
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (fl > 0 && i < fl) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fl);
    if (fl > 0 && n - 1 - i < fl) g = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / fl);
    x[i] = a * g * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  }
  return x;
}

describe('measureLoudness (ITU-R BS.1770-4 / EBU R128)', () => {
  it('derives the BS.1770 K-weighting coefficients at 48 kHz', () => {
    const k = kWeightingCoefficients(48000);
    expect(k.shelf[0]).toBeCloseTo(1.53512485958697, 10);
    expect(k.shelf[1]).toBeCloseTo(-2.69169618940638, 10);
    expect(k.shelf[2]).toBeCloseTo(1.19839281085285, 10);
    expect(k.shelf[3]).toBeCloseTo(-1.69065929318241, 10);
    expect(k.shelf[4]).toBeCloseTo(0.73248077421585, 10);
    expect(k.highpass[3]).toBeCloseTo(-1.99004745483398, 10);
    expect(k.highpass[4]).toBeCloseTo(0.99007225036621, 10);
  });

  it('997 Hz sine at -20 dBFS in one channel measures -23.0 LUFS at any sample rate; identical stereo is +3 dB', () => {
    for (const sr of [44100, 48000, 96000]) {
      const x = tone(997, 10, sr, -20, 0, 0);
      const mono = measureLoudness({ sampleRate: sr, channels: [x] });
      expect(Math.abs(mono.integratedLufs - -23.0), `${sr}`).toBeLessThan(0.1);
      expect(mono.momentaryMaxLufs).toBeCloseTo(mono.integratedLufs, 1);
      expect(mono.shortTermMaxLufs).toBeCloseTo(mono.integratedLufs, 1);
      const st = measureLoudness({ sampleRate: sr, channels: [x, x] });
      expect(st.integratedLufs - mono.integratedLufs).toBeCloseTo(3.01, 1);
      expect(mono.lra).toBeLessThan(0.1);
    }
  });

  it('gates silence and quiet passages (absolute -70 / relative -10 LU)', () => {
    const sr = 48000;
    const loud = tone(997, 5, sr, -20, 0, 0);
    const buf = new Float32Array(sr * 15);
    buf.set(loud, 0); // 5 s tone + 10 s silence
    const r = measureLoudness({ sampleRate: sr, channels: [buf] });
    expect(Math.abs(r.integratedLufs - -23)).toBeLessThan(0.2);
    // a -45 dB passage is excluded by the relative gate
    const quiet = tone(997, 5, sr, -45, 0, 0);
    buf.set(quiet, sr * 5);
    const r2 = measureLoudness({ sampleRate: sr, channels: [buf] });
    expect(Math.abs(r2.integratedLufs - -23)).toBeLessThan(0.2);
    const silent = measureLoudness({ sampleRate: sr, channels: [new Float32Array(sr * 2)] });
    expect(silent.integratedLufs).toBe(-144);
    expect(silent.truePeakDb).toBe(-144);
  });

  it('measures loudness range from short-term distribution', () => {
    const sr = 48000;
    // 20 s at -20 dBFS then 20 s at -30 dBFS → LRA close to 10 LU
    const a = tone(1000, 20, sr, -20, 0, 0);
    const b = tone(1000, 20, sr, -30, 0, 0);
    const x = new Float32Array(a.length + b.length);
    x.set(a);
    x.set(b, a.length);
    const r = measureLoudness({ sampleRate: sr, channels: [x] });
    expect(r.lra).toBeGreaterThan(8.5);
    expect(r.lra).toBeLessThan(10.5);
  });

  it('true peak catches inter-sample peaks (4x oversampling) of known signals', () => {
    const sr = 48000;
    // fs/4 sine at 45° phase: every sample is ±A/√2 but the waveform peaks at A
    const A = 0.5;
    const x = tone(sr / 4, 1, sr, 20 * Math.log10(A), Math.PI / 4, 0.02);
    const r = measureLoudness({ sampleRate: sr, channels: [x] });
    expect(r.samplePeakDb).toBeCloseTo(20 * Math.log10(A / Math.SQRT2), 1);
    expect(Math.abs(r.truePeakDb - 20 * Math.log10(A))).toBeLessThan(0.2);
    // low-frequency sine: true peak = sample peak = amplitude
    const y = tone(997, 1, 44100, -6, 0.3);
    const r2 = measureLoudness({ sampleRate: 44100, channels: [y] });
    expect(r2.truePeakDb).toBeCloseTo(-6, 1);
    // a 0 dBFS full-scale square-ish signal overshoots in true peak
    const sq = new Float32Array(4800);
    for (let i = 0; i < sq.length; i++) sq[i] = Math.floor(i / 6) % 2 ? 1 : -1;
    const r3 = measureLoudness({ sampleRate: 48000, channels: [sq] } as AudioData);
    expect(r3.truePeakDb).toBeGreaterThan(0.3);
  });
});
