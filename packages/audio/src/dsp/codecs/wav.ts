/**
 * WAV (RIFF/WAVE, RF64) encoder/decoder.
 * Decode: PCM 8 (unsigned) / 16 / 24 / 32-bit int, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE.
 * Encode: 8/16/24-bit int PCM (TPDF dither when reducing to ≤16 bits), 32-bit float (default for 32)
 * or 32-bit int. Deterministic.
 */
import type { AudioData } from '../../types';
import { downmixToStereo, quantizeChannels } from './pcm';

export interface WavEncodeOptions {
  /** Default 16. */
  bitDepth?: 8 | 16 | 24 | 32;
  /** IEEE float output (only with bitDepth 32; default true for 32). */
  float?: boolean;
  /** TPDF dither (default: on for ≤16-bit when the input is not already quantized). */
  dither?: boolean;
  /** Dither seed (deterministic). */
  seed?: number;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function writeStr(view: DataView, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
}

export function encodeWav(buf: AudioData, opts: WavEncodeOptions = {}): Uint8Array {
  const bits = opts.bitDepth ?? 16;
  if (![8, 16, 24, 32].includes(bits)) throw new Error(`encodeWav: unsupported bit depth ${bits}`);
  const isFloat = bits === 32 && opts.float !== false;
  const nch = Math.max(1, buf.channels.length);
  const frames = buf.channels[0]?.length ?? 0;
  const bps = bits / 8;
  const blockAlign = nch * bps;
  const dataSize = frames * blockAlign;
  const fmtSize = isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0;
  const pad = dataSize & 1;
  const total = 12 + 8 + fmtSize + factSize + 8 + dataSize + pad;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, total - 8, true);
  writeStr(view, 8, 'WAVE');
  let o = 12;
  writeStr(view, o, 'fmt ');
  view.setUint32(o + 4, fmtSize, true);
  view.setUint16(o + 8, isFloat ? FORMAT_FLOAT : FORMAT_PCM, true);
  view.setUint16(o + 10, nch, true);
  view.setUint32(o + 12, Math.round(buf.sampleRate), true);
  view.setUint32(o + 16, Math.round(buf.sampleRate) * blockAlign, true);
  view.setUint16(o + 20, blockAlign, true);
  view.setUint16(o + 22, bits, true);
  if (isFloat) view.setUint16(o + 24, 0, true);
  o += 8 + fmtSize;
  if (isFloat) {
    writeStr(view, o, 'fact');
    view.setUint32(o + 4, 4, true);
    view.setUint32(o + 8, frames, true);
    o += 12;
  }
  writeStr(view, o, 'data');
  view.setUint32(o + 4, dataSize, true);
  o += 8;
  const chans = buf.channels.length ? buf.channels : [new Float32Array(0)];
  if (isFloat) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        const x = chans[c][i];
        view.setFloat32(o, Number.isFinite(x) ? x : 0, true);
        o += 4;
      }
    }
    return out;
  }
  const q = quantizeChannels({ sampleRate: buf.sampleRate, channels: chans }, bits, {
    dither: opts.dither,
    seed: opts.seed,
  });
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const v = q[c][i];
      switch (bits) {
        case 8:
          out[o++] = (v + 128) & 255;
          break;
        case 16:
          out[o++] = v & 255;
          out[o++] = (v >> 8) & 255;
          break;
        case 24:
          out[o++] = v & 255;
          out[o++] = (v >> 8) & 255;
          out[o++] = (v >> 16) & 255;
          break;
        default:
          out[o++] = v & 255;
          out[o++] = (v >> 8) & 255;
          out[o++] = (v >> 16) & 255;
          out[o++] = (v >>> 24) & 255;
      }
    }
  }
  return out;
}

function readStr(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

export function decodeWav(bytes: Uint8Array): AudioData {
  if (bytes.length < 12) throw new Error('decodeWav: file too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = readStr(bytes, 0);
  if ((riff !== 'RIFF' && riff !== 'RF64') || readStr(bytes, 8) !== 'WAVE')
    throw new Error('decodeWav: not a RIFF/WAVE file');
  let o = 12;
  let format = 0;
  let nch = 0;
  let sampleRate = 0;
  let bits = 0;
  let blockAlign = 0;
  let dataOff = -1;
  let dataSize = 0;
  let ds64DataSize = -1;
  while (o + 8 <= bytes.length) {
    const id = readStr(bytes, o);
    let size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'ds64' && size >= 16) {
      const lo = view.getUint32(body + 8, true);
      const hi = view.getUint32(body + 12, true);
      ds64DataSize = hi * 4294967296 + lo;
    } else if (id === 'fmt ') {
      format = view.getUint16(body, true);
      nch = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bits = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE && size >= 40) {
        format = view.getUint16(body + 24, true); // SubFormat GUID's first two bytes
      }
    } else if (id === 'data') {
      dataOff = body;
      if (riff === 'RF64' && size === 0xffffffff && ds64DataSize >= 0) size = ds64DataSize;
      dataSize = size === 0 || size === 0xffffffff ? bytes.length - body : size;
      dataSize = Math.min(dataSize, bytes.length - body);
      break;
    }
    if (size === 0xffffffff) break;
    o = body + size + (size & 1);
  }
  if (!nch || !sampleRate) throw new Error('decodeWav: missing fmt chunk');
  if (dataOff < 0) throw new Error('decodeWav: missing data chunk');
  if (format !== FORMAT_PCM && format !== FORMAT_FLOAT)
    throw new Error(`decodeWav: unsupported format 0x${format.toString(16)}`);
  const bps = bits / 8;
  if (!blockAlign) blockAlign = bps * nch;
  const frames = Math.floor(dataSize / blockAlign);
  const chans: Float32Array[] = Array.from({ length: nch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    let p = dataOff + i * blockAlign;
    for (let c = 0; c < nch; c++) {
      let v: number;
      if (format === FORMAT_FLOAT) {
        if (bits === 64) v = view.getFloat64(p, true);
        else if (bits === 32) v = view.getFloat32(p, true);
        else throw new Error(`decodeWav: unsupported float bit depth ${bits}`);
        if (!Number.isFinite(v)) v = 0;
      } else if (bits === 8) {
        v = (bytes[p] - 128) / 128;
      } else if (bits === 16) {
        v = view.getInt16(p, true) / 32768;
      } else if (bits === 24) {
        const x = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
        v = ((x << 8) >> 8) / 8388608;
      } else if (bits === 32) {
        v = view.getInt32(p, true) / 2147483648;
      } else {
        throw new Error(`decodeWav: unsupported PCM bit depth ${bits}`);
      }
      chans[c][i] = v;
      p += bps;
    }
  }
  return { sampleRate, channels: downmixToStereo(chans) };
}
