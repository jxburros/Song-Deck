import type { EqSettings } from '@songdeck/core';

/**
 * Frequency response of the six-band channel EQ, computed from the same RBJ "Audio EQ Cookbook"
 * biquads the audio engine uses (12 dB/oct Butterworth HP/LP, S=1 shelves, constant-Q peaks).
 */

export type BandType = 'highpass' | 'lowshelf' | 'peak' | 'highshelf' | 'lowpass';
type Coefs = [number, number, number, number, number];

export function biquad(type: BandType, freq: number, q: number, gainDb: number, fs: number): Coefs {
  const f = Math.max(10, Math.min(fs * 0.49, freq));
  const w0 = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  let alpha = sw / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'peak':
      b0 = 1 + alpha * A;
      b1 = -2 * cw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cw;
      a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const S = Math.min(q, 1);
      alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cw + sa);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - sa);
      a0 = A + 1 + (A - 1) * cw + sa;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - sa;
      break;
    }
    case 'highshelf': {
      const S = Math.min(q, 1);
      alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cw + sa);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - sa);
      a0 = A + 1 - (A - 1) * cw + sa;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - sa;
      break;
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** |H(e^jw)| in dB of a normalized biquad at frequency f. */
export function magnitudeDb(c: Coefs, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const [b0, b1, b2, a1, a2] = c;
  const num = b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * cw + 2 * b0 * b2 * c2w;
  const den = 1 + a1 * a1 + a2 * a2 + 2 * (a1 + a1 * a2) * cw + 2 * a2 * c2w;
  return 10 * Math.log10(Math.max(1e-30, num) / Math.max(1e-30, den));
}

export type BandId = 'hp' | 'ls' | 'lm' | 'hm' | 'hs' | 'lp';

export interface BandSpec {
  id: BandId;
  label: string;
  short: string;
  type: BandType;
  freqKey: keyof EqSettings;
  gainKey?: keyof EqSettings;
  qKey?: keyof EqSettings;
  minHz: number;
  maxHz: number;
  color: string;
}

export const BANDS: BandSpec[] = [
  { id: 'hp', label: 'Low cut', short: 'HPF', type: 'highpass', freqKey: 'highpassHz', minHz: 20, maxHz: 8000, color: '#8fa3c7' },
  { id: 'ls', label: 'Low shelf', short: 'LOW', type: 'lowshelf', freqKey: 'lowShelfHz', gainKey: 'lowShelfDb', minHz: 20, maxHz: 2000, color: '#ff8a3d' },
  { id: 'lm', label: 'Low-mid', short: 'LO-MID', type: 'peak', freqKey: 'lowMidHz', gainKey: 'lowMidDb', qKey: 'lowMidQ', minHz: 40, maxHz: 8000, color: '#f5c451' },
  { id: 'hm', label: 'High-mid', short: 'HI-MID', type: 'peak', freqKey: 'highMidHz', gainKey: 'highMidDb', qKey: 'highMidQ', minHz: 200, maxHz: 16000, color: '#46c2cb' },
  { id: 'hs', label: 'High shelf', short: 'HIGH', type: 'highshelf', freqKey: 'highShelfHz', gainKey: 'highShelfDb', minHz: 1000, maxHz: 20000, color: '#a68cff' },
  { id: 'lp', label: 'High cut', short: 'LPF', type: 'lowpass', freqKey: 'lowpassHz', minHz: 200, maxHz: 20000, color: '#8fa3c7' },
];

/** Whether a band changes the signal (mirrors the engine's band activation rules). */
export function bandActive(eq: EqSettings, b: BandSpec, fs = 48000): boolean {
  if (!eq.enabled) return false;
  const f = eq[b.freqKey] as number;
  if (b.type === 'highpass' || b.type === 'lowpass') return f > 10 && f < fs * 0.49;
  return Math.abs((eq[b.gainKey!] as number) ?? 0) > 0.01;
}

export function bandCoefs(eq: EqSettings, b: BandSpec, fs = 48000): Coefs {
  const f = eq[b.freqKey] as number;
  if (b.type === 'highpass' || b.type === 'lowpass') return biquad(b.type, f, 0.7071, 0, fs);
  const gain = (eq[b.gainKey!] as number) ?? 0;
  const q = b.qKey ? Math.max(0.1, Math.min(18, (eq[b.qKey] as number) || 1)) : 1;
  return biquad(b.type, f, q, gain, fs);
}

/** Total response (dB) at each frequency. */
export function eqResponse(eq: EqSettings, freqs: ArrayLike<number>, fs = 48000): Float64Array {
  const out = new Float64Array(freqs.length);
  if (!eq.enabled) return out;
  for (const b of BANDS) {
    if (!bandActive(eq, b, fs)) continue;
    const c = bandCoefs(eq, b, fs);
    for (let i = 0; i < freqs.length; i++) out[i] += magnitudeDb(c, freqs[i], fs);
  }
  return out;
}

/** Response of a single band (dB) at each frequency (0 when inactive). */
export function bandResponse(eq: EqSettings, b: BandSpec, freqs: ArrayLike<number>, fs = 48000): Float64Array {
  const out = new Float64Array(freqs.length);
  if (!bandActive(eq, b, fs)) return out;
  const c = bandCoefs(eq, b, fs);
  for (let i = 0; i < freqs.length; i++) out[i] = magnitudeDb(c, freqs[i], fs);
  return out;
}

export const F_MIN = 20;
export const F_MAX = 20000;

export function logFreqs(n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (n - 1));
  return out;
}

export function freqToX(f: number, x0: number, w: number): number {
  return x0 + (Math.log(Math.max(F_MIN, f) / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
}

export function xToFreq(x: number, x0: number, w: number): number {
  const t = Math.max(0, Math.min(1, (x - x0) / w));
  return F_MIN * Math.pow(F_MAX / F_MIN, t);
}

/** Round a frequency to a musically sensible resolution. */
export function roundFreq(f: number): number {
  if (f < 100) return Math.round(f);
  if (f < 1000) return Math.round(f / 5) * 5;
  if (f < 10000) return Math.round(f / 50) * 50;
  return Math.round(f / 100) * 100;
}
