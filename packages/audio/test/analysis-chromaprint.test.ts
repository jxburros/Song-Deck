import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chromaprintBase64,
  chromaprintFingerprint,
  chromaprintRaw,
  compressFingerprint,
  encodeChromaprint,
  fingerprintBitErrorRate,
} from '../src/analysis';
import { decodeWav, encodeWav } from '../src/dsp';
import type { AudioData } from '../src/types';

/**
 * Chromaprint port vs the reference `fpcalc` (chromaprint 1.5.1). The golden strings below were
 * produced by `fpcalc -json` on WAV files of exactly these synthesized signals; when `fpcalc` is
 * on PATH the comparison is also re-run live on more varied material.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Chord stabs with harmonics plus short noise bursts (deterministic). */
function chordStabs(sr: number, seconds: number, seed: number, stereo: boolean): AudioData {
  const r = rng(seed);
  const n = Math.floor(sr * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let t0 = 0; t0 < seconds; t0 += 1) {
    const root = 40 + Math.floor(r() * 24);
    const chord = [root, root + 4 + (r() < 0.5 ? -1 : 0), root + 7, root + 12 + Math.floor(r() * 3)];
    const s0 = Math.floor(t0 * sr);
    const s1 = Math.min(n, Math.floor((t0 + 1) * sr));
    for (const m of chord) {
      const f = 440 * 2 ** ((m - 69) / 12);
      const amp = 0.08 + r() * 0.05;
      const pan = r();
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) / sr;
        const v = amp * Math.exp(-t * 1.5) * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t));
        L[i] += v * (stereo ? 1 - pan : 1);
        R[i] += v * (stereo ? pan : 1);
      }
    }
    for (let i = s0; i < Math.min(s1, s0 + Math.floor(0.05 * sr)); i++) {
      const v = (r() * 2 - 1) * 0.2 * (1 - (i - s0) / (0.05 * sr));
      L[i] += v;
      R[i] += v;
    }
  }
  return { sampleRate: sr, channels: stereo ? [L, R] : [L] };
}

/** Round-trip through 16-bit WAV, exactly what fpcalc reads. */
const as16bit = (a: AudioData) => decodeWav(encodeWav(a, { bitDepth: 16, dither: false }));

const GOLDEN_MONO_11025 = 'AQAAS1qcMIkUJsBz4j9-43twXIEfTD_45MEuShIqnjhD_HB-5CrEC-GP8jr2CJ8GqtgN5wvC3VApmcg51JJCDf5x4-lR5MfMlAokY1Jywk1xHTF8whem_3iOmjvY5cd1bDf8IJSO5CY6nfDIHH8S7Etwgjv8B_2R_EMeodYPPsXhPcf046OKp8JvTI4duAKR_Ih4PAWGCCMUGIIIItAQwwRSQjEiiBKASKAQFQgZKRAyggghpBBGEEKRQoogRJBBiCBkwAHACWAcAEQoaAA';
const GOLDEN_STEREO_44100 = 'AQAAZBKZJEpY4flx3fgminjUbOjX4wfCnEgu_B7OHdVz4TO-4_gYMYT5InkV5A-uH4903MYz-Cd63A_K7BI2pQuL5zhSQdKD8LiJZ3lwHT2uBkfzbQBLysSTb0kQ_sd_7IGQH75w7cKVPzhzuOmP7zj-HWMeInvyQDGZI0-SGa6O77CHNwnCC_qRP0K_THAYx_jxY9cR2of0I74w9B8eJrAH90cvHBMfhQn8acPxHB_4I5kuxOmOXXheXGKPP0ePM_HQlIowPJUAAAygiBCApGVMEAKIUAIghQRAhiBBHUIQKIEAEggSRBhAYAghkEAKCAAMAwAIQoBAxAGhBDGAIESQUUARxaSAxArCpEAGGGWEQAg55wRSRBCjFHCIAQ';

describe('Chromaprint port', () => {
  it('reproduces fpcalc exactly for 16-bit mono 11025 Hz input', () => {
    const fp = chromaprintFingerprint(as16bit(chordStabs(11025, 12, 1, false)));
    expect(fp.algorithm).toBe(1);
    expect(fp.durationSeconds).toBeCloseTo(12, 6);
    expect(fp.fingerprint).toBe(GOLDEN_MONO_11025);
  });

  it('matches fpcalc for resampled 44.1 kHz stereo input', () => {
    const fp = chromaprintFingerprint(as16bit(chordStabs(44100, 15, 2, true)));
    expect(fp.fingerprint).toBe(GOLDEN_STEREO_44100);
  });

  it('compresses and base64-encodes like chromaprint', () => {
    expect(chromaprintBase64(Uint8Array.of(1, 0, 0, 0))).toBe('AQAAAA');
    expect(encodeChromaprint([])).toBe('AQAAAA');
    // One sub-fingerprint with bits 0, 2 and 31 set: deltas 1, 2, 29 (7 + exception 22), terminator 0.
    const c = compressFingerprint([0x80000005]);
    expect([...c.subarray(0, 4)]).toEqual([1, 0, 0, 1]);
    expect(c.length).toBe(4 + Math.ceil((4 * 3) / 8) + 1);
  });

  it('only fingerprints full frames of the first 120 seconds and handles silence/short input', () => {
    expect(chromaprintRaw(new Int16Array(4095)).length).toBe(0);
    expect(chromaprintFingerprint({ sampleRate: 44100, channels: [new Float32Array(10)] }).raw.length).toBe(0);
    const silent = chromaprintFingerprint({ sampleRate: 11025, channels: [new Float32Array(11025 * 10)] });
    expect(silent.raw.length).toBeGreaterThan(0);
    const long = chromaprintFingerprint({ sampleRate: 11025, channels: [new Float32Array(11025 * 130)] });
    const capped = chromaprintFingerprint({ sampleRate: 11025, channels: [new Float32Array(11025 * 120)] });
    expect(long.raw.length).toBe(capped.raw.length);
    expect(long.durationSeconds).toBeCloseTo(130, 6);
  });

  it('measures bit error rate', () => {
    expect(fingerprintBitErrorRate([0xffffffff], [0])).toBe(1);
    expect(fingerprintBitErrorRate([1, 2], [1, 3])).toBeCloseTo(1 / 64, 9);
  });
});

let fpcalc = false;
try {
  execFileSync('fpcalc', ['-version'], { stdio: 'ignore' });
  fpcalc = true;
} catch {
  fpcalc = false;
}

describe.skipIf(!fpcalc)('Chromaprint port vs live fpcalc', () => {
  it('is bit-exact at 11025 Hz and near-identical after resampling', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sd-chromaprint-'));
    try {
      const r = rng(11);
      const noise = (sr: number) => {
        const n = sr * 20;
        const L = new Float32Array(n);
        const R = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          L[i] = (r() * 2 - 1) * 0.3 * (0.5 + 0.5 * Math.sin(i / sr));
          R[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / sr) + 0.05 * (r() * 2 - 1);
        }
        return { sampleRate: sr, channels: [L, R] };
      };
      const cases: [string, AudioData, number][] = [
        ['noise-11025', noise(11025), 0],
        ['stabs-48000', chordStabs(48000, 20, 3, true), 0.01],
        ['noise-44100', noise(44100), 0.01],
        ['stabs-22050', chordStabs(22050, 25, 4, false), 0.01],
      ];
      for (const [name, audio, maxBer] of cases) {
        const file = path.join(dir, `${name}.wav`);
        writeFileSync(file, encodeWav(audio, { bitDepth: 16, dither: false }));
        const ref = JSON.parse(execFileSync('fpcalc', ['-raw', '-json', file]).toString()) as { fingerprint: number[]; duration: number };
        const ours = chromaprintFingerprint(decodeWav(encodeWav(audio, { bitDepth: 16, dither: false })));
        expect(ours.raw.length, name).toBe(ref.fingerprint.length);
        expect(fingerprintBitErrorRate(ours.raw, ref.fingerprint), name).toBeLessThanOrEqual(maxBer);
        if (audio.sampleRate === 11025 && audio.channels.length === 1) {
          const enc = JSON.parse(execFileSync('fpcalc', ['-json', file]).toString()) as { fingerprint: string };
          expect(ours.fingerprint).toBe(enc.fingerprint);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
