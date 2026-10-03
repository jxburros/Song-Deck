import { describe, expect, it } from 'vitest';
import { decodeFlac, decodeWav, encodeFlac, encodeWav, flacInfo } from '../src/dsp';
import { md5Hex } from '../src/dsp/codecs/md5';
import type { AudioData } from '../src/types';
import { lcg } from './dsp-helpers';

function signal(n: number, channels: number, kind: 'noise' | 'tone' | 'silence' | 'mixed', seed = 1, sr = 44100): AudioData {
  const rnd = lcg(seed);
  const chs: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (kind === 'noise') x[i] = (rnd() * 2 - 1) * 0.9;
      else if (kind === 'tone') x[i] = 0.7 * Math.sin((2 * Math.PI * (220 + 110 * c) * i) / sr) * (0.5 + 0.5 * Math.sin(i / 5000));
      else if (kind === 'mixed') x[i] = 0.5 * Math.sin((2 * Math.PI * 330 * i) / sr) + (rnd() * 2 - 1) * 0.01 + (i % 9000 < 300 ? 0.4 : 0);
    }
    chs.push(x);
  }
  return { sampleRate: sr, channels: chs };
}

function quantize(buf: AudioData, bits: number): AudioData {
  const s = Math.pow(2, bits - 1);
  return {
    sampleRate: buf.sampleRate,
    channels: buf.channels.map((c) => Float32Array.from(c, (v) => Math.max(-s, Math.min(s - 1, Math.round(v * s))) / s)),
  };
}

function maxDiff(a: AudioData, b: AudioData): number {
  let m = 0;
  for (let c = 0; c < a.channels.length; c++) for (let i = 0; i < a.channels[c].length; i++) m = Math.max(m, Math.abs(a.channels[c][i] - b.channels[c][i]));
  return m;
}

function identical(a: AudioData, b: AudioData): boolean {
  if (a.channels.length !== b.channels.length || a.sampleRate !== b.sampleRate) return false;
  for (let c = 0; c < a.channels.length; c++) {
    if (a.channels[c].length !== b.channels[c].length) return false;
    for (let i = 0; i < a.channels[c].length; i++) if (a.channels[c][i] !== b.channels[c][i]) return false;
  }
  return true;
}

describe('md5', () => {
  it('matches RFC 1321 test vectors', () => {
    const t = (s: string) => md5Hex(new TextEncoder().encode(s));
    expect(t('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(t('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(t('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(t('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
});

describe('WAV', () => {
  it('round-trips at 8/16/24-bit int and 32-bit float within quantization error', () => {
    const src = signal(20000, 2, 'tone', 3, 48000);
    for (const [bits, tol] of [
      [8, 2.5 / 128],
      [16, 2.5 / 32768],
      [24, 0.51 / 8388608],
    ] as const) {
      const bytes = encodeWav(src, { bitDepth: bits });
      expect(bytes.length).toBe(44 + 20000 * 2 * (bits / 8));
      const d = decodeWav(bytes);
      expect(d.sampleRate).toBe(48000);
      expect(d.channels.length).toBe(2);
      expect(maxDiff(src, d), `${bits}-bit`).toBeLessThan(tol);
    }
    const f = decodeWav(encodeWav(src, { bitDepth: 32 }));
    expect(identical(f, src)).toBe(true);
    const i32 = decodeWav(encodeWav(src, { bitDepth: 32, float: false }));
    expect(maxDiff(src, i32)).toBeLessThan(1e-7);
  });

  it('is deterministic, dithers 16-bit by default, and is exact for pre-quantized input', () => {
    const src = signal(5000, 1, 'tone');
    const a = encodeWav(src, { bitDepth: 16 });
    const b = encodeWav(src, { bitDepth: 16 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const noDither = decodeWav(encodeWav(src, { bitDepth: 16, dither: false }));
    expect(maxDiff(src, noDither)).toBeLessThanOrEqual(0.5 / 32768 + 1e-9);
    const q = quantize(src, 16);
    expect(identical(decodeWav(encodeWav(q, { bitDepth: 16 })), q)).toBe(true);
    // silence stays digital silence (no dither noise)
    const sil = decodeWav(encodeWav({ sampleRate: 44100, channels: [new Float32Array(1000)] }, { bitDepth: 16 }));
    expect(sil.channels[0].every((v) => v === 0)).toBe(true);
    // clipping is clamped
    const hot = decodeWav(encodeWav({ sampleRate: 44100, channels: [Float32Array.of(2, -2, 0.5)] }, { bitDepth: 16, dither: false }));
    expect(hot.channels[0][0]).toBeCloseTo(32767 / 32768, 6);
    expect(hot.channels[0][1]).toBe(-1);
  });

  it('decodes WAVE_FORMAT_EXTENSIBLE, 64-bit float, unknown chunks and >2 channels', () => {
    // hand-built extensible 24-bit stereo file with a LIST chunk before data
    const frames = 3;
    const vals = [
      [0.5, -0.25],
      [-1, 0.75],
      [0, 0.125],
    ];
    const data = new Uint8Array(frames * 2 * 3);
    let o = 0;
    for (const [l, r] of vals)
      for (const v of [l, r]) {
        const iv = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388608)));
        data[o++] = iv & 255;
        data[o++] = (iv >> 8) & 255;
        data[o++] = (iv >> 16) & 255;
      }
    const fmt = new Uint8Array(40);
    const fv = new DataView(fmt.buffer);
    fv.setUint16(0, 0xfffe, true);
    fv.setUint16(2, 2, true);
    fv.setUint32(4, 96000, true);
    fv.setUint32(8, 96000 * 6, true);
    fv.setUint16(12, 6, true);
    fv.setUint16(14, 24, true);
    fv.setUint16(16, 22, true);
    fv.setUint16(18, 24, true);
    fv.setUint32(20, 3, true);
    fv.setUint16(24, 1, true); // KSDATAFORMAT_SUBTYPE_PCM
    const list = new TextEncoder().encode('INFOabc'); // 7 bytes → padded
    const chunks: [string, Uint8Array][] = [
      ['fmt ', fmt],
      ['LIST', list],
      ['data', data],
    ];
    const size = 12 + chunks.reduce((a, [, b]) => a + 8 + b.length + (b.length & 1), 0);
    const file = new Uint8Array(size);
    const dv = new DataView(file.buffer);
    file.set(new TextEncoder().encode('RIFF'), 0);
    dv.setUint32(4, size - 8, true);
    file.set(new TextEncoder().encode('WAVE'), 8);
    let p = 12;
    for (const [id, body] of chunks) {
      file.set(new TextEncoder().encode(id), p);
      dv.setUint32(p + 4, body.length, true);
      file.set(body, p + 8);
      p += 8 + body.length + (body.length & 1);
    }
    const d = decodeWav(file);
    expect(d.sampleRate).toBe(96000);
    expect(Array.from(d.channels[0])).toEqual([0.5, -1, 0]);
    expect(Array.from(d.channels[1])).toEqual([-0.25, 0.75, 0.125]);

    // 64-bit float mono
    const f64 = new Uint8Array(44 + 16);
    const v64 = new DataView(f64.buffer);
    f64.set(new TextEncoder().encode('RIFF'), 0);
    v64.setUint32(4, 52, true);
    f64.set(new TextEncoder().encode('WAVEfmt '), 8);
    v64.setUint32(16, 16, true);
    v64.setUint16(20, 3, true);
    v64.setUint16(22, 1, true);
    v64.setUint32(24, 8000, true);
    v64.setUint32(28, 64000, true);
    v64.setUint16(32, 8, true);
    v64.setUint16(34, 64, true);
    f64.set(new TextEncoder().encode('data'), 36);
    v64.setUint32(40, 16, true);
    v64.setFloat64(44, 0.3, true);
    v64.setFloat64(52, -0.6, true);
    const d64 = decodeWav(f64);
    expect(d64.channels[0][0]).toBeCloseTo(0.3, 6);
    expect(d64.channels[0][1]).toBeCloseTo(-0.6, 6);

    // 6-channel → stereo downmix
    const six: AudioData = { sampleRate: 44100, channels: Array.from({ length: 6 }, (_, c) => Float32Array.of(c === 2 ? 0.5 : 0.1)) };
    const enc6 = encodeWav(six, { bitDepth: 32 });
    const dec6 = decodeWav(enc6);
    expect(dec6.channels.length).toBe(2);
    expect(dec6.channels[0][0]).toBeCloseTo(0.1 + 0.5 * Math.SQRT1_2 + 0.1 * Math.SQRT1_2, 5);
    expect(() => decodeWav(new Uint8Array(10))).toThrow();
  });
});

describe('FLAC', () => {
  const cases: [string, number, number, 'noise' | 'tone' | 'silence' | 'mixed'][] = [
    ['16-bit stereo noise', 16, 2, 'noise'],
    ['16-bit mono tone', 16, 1, 'tone'],
    ['16-bit stereo silence', 16, 2, 'silence'],
    ['24-bit stereo mixed', 24, 2, 'mixed'],
    ['24-bit mono noise', 24, 1, 'noise'],
    ['24-bit stereo tone', 24, 2, 'tone'],
  ];
  for (const [name, bits, ch, kind] of cases) {
    it(`round-trips bit-exactly: ${name}`, () => {
      const src = quantize(signal(20011, ch, kind, bits * ch), bits);
      const bytes = encodeFlac(src, { bitDepth: bits as 16 | 24 });
      const info = flacInfo(bytes);
      expect(info.bitsPerSample).toBe(bits);
      expect(info.channels).toBe(ch);
      expect(info.totalSamples).toBe(20011);
      expect(info.sampleRate).toBe(44100);
      const d = decodeFlac(bytes);
      expect(identical(d, src)).toBe(true);
      // STREAMINFO MD5 equals the MD5 of the little-endian interleaved PCM
      const bps = bits / 8;
      const pcm = new Uint8Array(20011 * ch * bps);
      let o = 0;
      const s = Math.pow(2, bits - 1);
      for (let i = 0; i < 20011; i++)
        for (let c = 0; c < ch; c++) {
          const v = Math.round(src.channels[c][i] * s);
          for (let b = 0; b < bps; b++) pcm[o++] = (v >> (8 * b)) & 255;
        }
      expect(info.md5).toBe(md5Hex(pcm));
      if (kind === 'silence') expect(bytes.length).toBeLessThan(400);
      if (kind === 'tone') expect(bytes.length).toBeLessThan(pcm.length * 0.6);
    });
  }

  it('dithers float input deterministically and decodes to the dithered integers', () => {
    const src = signal(8000, 2, 'tone');
    const a = encodeFlac(src, { bitDepth: 16 });
    const b = encodeFlac(src, { bitDepth: 16 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const viaWav = decodeWav(encodeWav(src, { bitDepth: 16 }));
    expect(identical(decodeFlac(a), viaWav)).toBe(true);
  });

  it('handles odd block sizes, tiny inputs and detects corruption', () => {
    const src = quantize(signal(5000, 2, 'mixed'), 16);
    const bytes = encodeFlac(src, { bitDepth: 16, blockSize: 1152, maxLpcOrder: 12 });
    expect(identical(decodeFlac(bytes), src)).toBe(true);
    const tiny = quantize(signal(7, 1, 'noise'), 16);
    expect(identical(decodeFlac(encodeFlac(tiny)), tiny)).toBe(true);
    const empty = encodeFlac({ sampleRate: 22050, channels: [new Float32Array(0)] });
    expect(decodeFlac(empty).channels[0].length).toBe(0);
    const bad = bytes.slice();
    bad[bad.length - 40] ^= 0x55;
    expect(() => decodeFlac(bad)).toThrow();
    expect(() => decodeFlac(new Uint8Array(100))).toThrow();
  });
});
