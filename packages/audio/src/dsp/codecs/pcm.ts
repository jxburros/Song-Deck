/**
 * Float ↔ integer PCM conversion shared by the WAV and FLAC codecs.
 * Scaling convention: int = round(x · 2^(bits-1)), float = int / 2^(bits-1) (bit-exact round trip).
 * TPDF dither (deterministic, seeded) is applied when reducing to ≤16 bits unless the input is
 * already exactly representable at the target resolution (so encode→decode→encode is idempotent),
 * and never on digital silence.
 */
import type { AudioData } from '../../types';
import { NOISE_SCALE, seedState, xorshift } from '../utils';

export function isQuantized(ch: ArrayLike<number>, bits: number): boolean {
  const scale = Math.pow(2, bits - 1);
  const max = scale - 1;
  for (let i = 0; i < ch.length; i++) {
    const v = ch[i] * scale;
    if (v !== Math.round(v) || v > max || v < -scale) return false;
  }
  return true;
}

export interface QuantizeOptions {
  dither?: boolean;
  seed?: number;
}

/** Convert planar float channels to integer PCM at `bits` (8..32). */
export function quantizeChannels(buf: AudioData, bits: number, opts: QuantizeOptions = {}): Int32Array[] {
  const scale = Math.pow(2, bits - 1);
  const max = scale - 1;
  const min = -scale;
  const out: Int32Array[] = [];
  const wantDither = opts.dither ?? bits <= 16;
  for (let c = 0; c < buf.channels.length; c++) {
    const ch = buf.channels[c];
    const n = ch.length;
    const q = new Int32Array(n);
    const dither = wantDither && !isQuantized(ch, bits);
    let s = seedState((opts.seed ?? 0x5eed) + c * 7919);
    for (let i = 0; i < n; i++) {
      const x = ch[i];
      let v = Number.isFinite(x) ? x * scale : 0;
      if (dither && x !== 0) {
        s = xorshift(s);
        const r1 = s * NOISE_SCALE;
        s = xorshift(s);
        const r2 = s * NOISE_SCALE;
        v += (r1 + r2) * 0.5; // triangular PDF over ±1 LSB
      }
      let r = Math.round(v);
      if (r > max) r = max;
      else if (r < min) r = min;
      q[i] = r;
    }
    out.push(q);
  }
  return out;
}

export function intToFloatChannels(chs: Int32Array[], bits: number, sampleRate: number): AudioData {
  const inv = 1 / Math.pow(2, bits - 1);
  return {
    sampleRate,
    channels: chs.map((q) => {
      const f = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) f[i] = q[i] * inv;
      return f;
    }),
  };
}

/** ITU-style downmix of >2 interleaved-order channels (FL FR FC LFE BL BR …) to stereo. */
export function downmixToStereo(chs: Float32Array[]): Float32Array[] {
  if (chs.length <= 2) return chs;
  const n = chs[0].length;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const k = Math.SQRT1_2;
  const fc = chs[2];
  const bl = chs.length > 4 ? chs[4] : undefined;
  const br = chs.length > 5 ? chs[5] : undefined;
  for (let i = 0; i < n; i++) {
    const c = fc[i] * k;
    L[i] = chs[0][i] + c + (bl ? bl[i] * k : 0);
    R[i] = chs[1][i] + c + (br ? br[i] * k : 0);
  }
  return [L, R];
}
