/**
 * FLAC encoder + decoder (pure TypeScript).
 *
 * Encoder: fixed block size 4096, per-subframe choice of CONSTANT / VERBATIM / FIXED (orders 0–4) /
 * LPC (Levinson–Durbin, quantized coefficients), partitioned Rice (RICE / RICE2 with escape codes),
 * wasted-bits detection, stereo decorrelation (independent / left-side / side-right / mid-side chosen
 * per frame), CRC-8 frame headers, CRC-16 frame footers, STREAMINFO with the MD5 of the samples.
 * Decoder: everything the format allows for 1–8 channels at 4–32 bits (CONSTANT, VERBATIM, FIXED,
 * LPC, Rice/Rice2 + escapes, wasted bits, all channel assignments), with CRC verification.
 */
import type { AudioData } from '../../types';
import { Md5 } from './md5';
import { downmixToStereo, quantizeChannels } from './pcm';

export interface FlacEncodeOptions {
  /** 16 (default) or 24. */
  bitDepth?: 16 | 24;
  /** TPDF dither when reducing to 16 bits (default on unless already quantized). */
  dither?: boolean;
  seed?: number;
  /** Block size in samples (default 4096). */
  blockSize?: number;
  /** Max LPC order (0 disables LPC; default 8). */
  maxLpcOrder?: number;
}

// ---------------------------------------------------------------------------
// CRC
// ---------------------------------------------------------------------------

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

function crc8(b: Uint8Array, start: number, end: number): number {
  let c = 0;
  for (let i = start; i < end; i++) c = CRC8[c ^ b[i]];
  return c;
}

function crc16(b: Uint8Array, start: number, end: number): number {
  let c = 0;
  for (let i = start; i < end; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
  return c;
}

// ---------------------------------------------------------------------------
// Bit I/O
// ---------------------------------------------------------------------------

class BitWriter {
  buf: Uint8Array;
  pos = 0;
  private acc = 0;
  private nb = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(Math.max(1024, capacity));
  }

  /** Make room for `extra` more bytes (call once per frame with a worst-case estimate). */
  reserve(extra: number): void {
    if (this.pos + extra + 8 <= this.buf.length) return;
    let n = this.buf.length * 2;
    while (n < this.pos + extra + 8) n *= 2;
    const nb = new Uint8Array(n);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }

  /** Write the low `n` bits (n ≤ 24) of non-negative int `v`, MSB first. */
  private put(v: number, n: number): void {
    const acc = (this.acc << n) | v;
    let nb = this.nb + n;
    const buf = this.buf;
    while (nb >= 8) {
      nb -= 8;
      buf[this.pos++] = (acc >>> nb) & 0xff;
    }
    this.acc = acc & ((1 << nb) - 1);
    this.nb = nb;
  }

  /** Write the low `n` bits (n ≤ 32) of unsigned `v`, MSB first. */
  bits(v: number, n: number): void {
    if (n <= 24) {
      this.put(n === 0 ? 0 : v & ((1 << n) - 1), n);
    } else {
      const hi = n - 16;
      this.put(Math.floor(v / 65536) & ((1 << hi) - 1), hi);
      this.put(v & 0xffff, 16);
    }
  }

  signed(v: number, n: number): void {
    if (n === 0) return;
    if (n <= 24) this.put(v & ((1 << n) - 1), n);
    else this.bits(v < 0 ? v + 4294967296 : v, n);
  }

  zeros(n: number): void {
    while (n >= 24) {
      this.put(0, 24);
      n -= 24;
    }
    if (n > 0) this.put(0, n);
  }

  /** Rice code of folded (non-negative, < 2^31) residual. */
  rice(u: number, k: number): void {
    const q = u >>> k;
    if (q + 1 + k <= 24) {
      this.put((1 << k) | (u & ((1 << k) - 1)), q + 1 + k);
    } else {
      this.zeros(q);
      this.put(1, 1);
      if (k > 0) this.bits(u & (k >= 31 ? 0x7fffffff : (1 << k) - 1), k);
    }
  }

  align(): void {
    if (this.nb > 0) this.put(0, 8 - this.nb);
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

class BitReader {
  pos = 0; // bit position
  constructor(private readonly b: Uint8Array) {}

  get bytePos(): number {
    return Math.floor(this.pos / 8);
  }

  bits(n: number): number {
    let v = 0;
    const b = this.b;
    while (n > 0) {
      const idx = Math.floor(this.pos / 8);
      if (idx >= b.length) throw new Error('FLAC: unexpected end of stream');
      const off = this.pos - idx * 8;
      const avail = 8 - off;
      const take = n < avail ? n : avail;
      const bits = (b[idx] >>> (avail - take)) & ((1 << take) - 1);
      v = v * (1 << take) + bits;
      this.pos += take;
      n -= take;
    }
    return v;
  }

  signed(n: number): number {
    if (n === 0) return 0;
    const v = this.bits(n);
    const half = Math.pow(2, n - 1);
    return v >= half ? v - 2 * half : v;
  }

  unary(): number {
    let count = 0;
    const b = this.b;
    for (;;) {
      const idx = Math.floor(this.pos / 8);
      if (idx >= b.length) throw new Error('FLAC: unexpected end of stream');
      const off = this.pos - idx * 8;
      const byte = (b[idx] << off) & 0xff;
      if (byte !== 0) {
        const lz = Math.clz32(byte) - 24;
        count += lz;
        this.pos += lz + 1;
        return count;
      }
      count += 8 - off;
      this.pos += 8 - off;
    }
  }

  align(): void {
    this.pos = Math.ceil(this.pos / 8) * 8;
  }
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

const SR_CODES: Record<number, number> = {
  88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11,
};

function blockSizeCode(n: number): { code: number; extra: number; extraBits: number } {
  const table: Record<number, number> = {
    192: 1, 576: 2, 1152: 3, 2304: 4, 4608: 5, 256: 8, 512: 9, 1024: 10, 2048: 11, 4096: 12, 8192: 13, 16384: 14, 32768: 15,
  };
  if (table[n]) return { code: table[n], extra: 0, extraBits: 0 };
  if (n <= 256) return { code: 6, extra: n - 1, extraBits: 8 };
  return { code: 7, extra: n - 1, extraBits: 16 };
}

function writeUtf8Number(w: BitWriter, v: number): void {
  if (v < 0x80) {
    w.bits(v, 8);
    return;
  }
  let nbytes: number;
  if (v < 0x800) nbytes = 2;
  else if (v < 0x10000) nbytes = 3;
  else if (v < 0x200000) nbytes = 4;
  else if (v < 0x4000000) nbytes = 5;
  else if (v < 0x80000000) nbytes = 6;
  else nbytes = 7;
  const firstBits = nbytes === 7 ? 0 : 7 - nbytes;
  const lead = nbytes === 7 ? 0xfe : (0xff << (8 - nbytes)) & 0xff;
  const shift = 6 * (nbytes - 1);
  w.bits(lead | (Math.floor(v / Math.pow(2, shift)) & ((1 << firstBits) - 1)), 8);
  for (let i = nbytes - 2; i >= 0; i--) w.bits(0x80 | (Math.floor(v / Math.pow(2, 6 * i)) & 0x3f), 8);
}

/** Scratch buffers shared by the encoder (sized per block). */
interface EncScratch {
  res: Int32Array; // chosen residual
  cand: Int32Array; // candidate residual
  tmp: Int32Array; // wasted-bits shifted input
  win: Float64Array; // windowed signal
  window: Float64Array; // Tukey(0.5) window for the current block size
  windowN: number;
  sums: Float64Array; // partition sums
}

/** Fixed predictor residual for `order`; first `order` entries are warm-up (set to 0). */
function fixedResidual(x: Int32Array, n: number, order: number, res: Int32Array): void {
  for (let i = 0; i < order && i < n; i++) res[i] = 0;
  switch (order) {
    case 0:
      for (let i = 0; i < n; i++) res[i] = x[i];
      break;
    case 1:
      for (let i = 1; i < n; i++) res[i] = x[i] - x[i - 1];
      break;
    case 2:
      for (let i = 2; i < n; i++) res[i] = x[i] - 2 * x[i - 1] + x[i - 2];
      break;
    case 3:
      for (let i = 3; i < n; i++) res[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
      break;
    default:
      for (let i = 4; i < n; i++) res[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
  }
}

/** Sum of |residual| for fixed orders 0..4 (cheap order selection). */
function fixedAbsSums(x: Int32Array, n: number, out: Float64Array): void {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  for (let i = 4; i < n; i++) {
    const x0 = x[i], x1 = x[i - 1], x2 = x[i - 2], x3 = x[i - 3], x4 = x[i - 4];
    const e1 = x0 - x1;
    const e2 = e1 - (x1 - x2);
    const e3 = e2 - (x1 - 2 * x2 + x3);
    const e4 = e3 - (x1 - 3 * x2 + 3 * x3 - x4);
    s0 += x0 < 0 ? -x0 : x0;
    s1 += e1 < 0 ? -e1 : e1;
    s2 += e2 < 0 ? -e2 : e2;
    s3 += e3 < 0 ? -e3 : e3;
    s4 += e4 < 0 ? -e4 : e4;
  }
  out[0] = s0;
  out[1] = s1;
  out[2] = s2;
  out[3] = s3;
  out[4] = s4;
}

interface RicePlan {
  bits: number;
  porder: number;
  method: number; // 0 = RICE (4-bit), 1 = RICE2 (5-bit)
  params: Int32Array;
}

/** Choose the best partition order + Rice parameters for residual[order..n). */
function planRice(res: Int32Array, n: number, order: number, sums: Float64Array, maxPorder = 8): RicePlan {
  let maxP = 0;
  while (maxP < maxPorder && n % (1 << (maxP + 1)) === 0 && n >> (maxP + 1) > order) maxP++;
  const parts = 1 << maxP;
  const psize = n >> maxP;
  for (let p = 0; p < parts; p++) {
    let s = 0;
    const start = p === 0 ? order : p * psize;
    const end = (p + 1) * psize;
    for (let i = start; i < end; i++) {
      const r = res[i];
      s += r >= 0 ? 2 * r : -2 * r - 1;
    }
    sums[p] = s;
  }
  let best: RicePlan | null = null;
  let np = parts;
  for (let po = maxP; po >= 0; po--) {
    if (po < maxP) {
      for (let p = 0; p < np / 2; p++) sums[p] = sums[2 * p] + sums[2 * p + 1];
      np /= 2;
    }
    const size = n >> po;
    let bits = 0;
    let method = 0;
    const params = new Int32Array(np);
    for (let p = 0; p < np; p++) {
      const cnt = p === 0 ? size - order : size;
      const s = sums[p];
      let bestK = 0;
      let bestBits = 0;
      if (cnt > 0) {
        bestBits = Infinity;
        const mean = s / cnt;
        const k0 = mean > 2 ? Math.max(0, Math.floor(Math.log2(mean)) - 1) : 0;
        for (let k = k0; k <= Math.min(30, k0 + 2); k++) {
          const b = cnt * (k + 1) + Math.floor(s / (1 << k));
          if (b < bestBits) {
            bestBits = b;
            bestK = k;
          }
        }
      }
      if (bestK > 14) method = 1;
      params[p] = bestK;
      bits += bestBits;
    }
    bits += np * (method ? 5 : 4) + 6;
    if (!best || bits < best.bits) best = { bits, porder: po, method, params };
  }
  return best!;
}

function writeResidual(w: BitWriter, res: Int32Array, n: number, order: number, plan: RicePlan): void {
  w.bits(plan.method, 2);
  w.bits(plan.porder, 4);
  const np = 1 << plan.porder;
  const size = n >> plan.porder;
  const pbits = plan.method ? 5 : 4;
  for (let p = 0; p < np; p++) {
    const k = plan.params[p];
    w.bits(k, pbits);
    const start = p === 0 ? order : p * size;
    const end = (p + 1) * size;
    for (let i = start; i < end; i++) {
      const r = res[i];
      w.rice(r >= 0 ? 2 * r : -2 * r - 1, k);
    }
  }
}

/** Levinson–Durbin on autocorrelation r[0..maxOrder]; returns coefficient sets for orders 1..max. */
function levinson(r: Float64Array, maxOrder: number): Float64Array[] {
  const out: Float64Array[] = [];
  const a = new Float64Array(maxOrder + 1);
  const tmp = new Float64Array(maxOrder + 1);
  let err = r[0];
  for (let i = 1; i <= maxOrder; i++) {
    if (err <= 0) break;
    let acc = r[i];
    for (let j = 1; j < i; j++) acc -= a[j] * r[i - j];
    const k = acc / err;
    tmp.set(a);
    a[i] = k;
    for (let j = 1; j < i; j++) a[j] = tmp[j] - k * tmp[i - j];
    err *= 1 - k * k;
    out.push(a.slice(1, i + 1));
  }
  return out;
}

interface LpcQuant {
  q: Int32Array;
  shift: number;
  precision: number;
}

function quantizeLpc(c: Float64Array, precision: number): LpcQuant | null {
  let cmax = 0;
  for (let i = 0; i < c.length; i++) cmax = Math.max(cmax, Math.abs(c[i]));
  if (cmax <= 0 || !Number.isFinite(cmax)) return null;
  const log2cmax = Math.floor(Math.log2(cmax)) + 1;
  let shift = precision - 1 - log2cmax;
  if (shift > 15) shift = 15;
  if (shift < 0) return null;
  const qmax = (1 << (precision - 1)) - 1;
  const qmin = -(1 << (precision - 1));
  const q = new Int32Array(c.length);
  let errAcc = 0;
  for (let i = 0; i < c.length; i++) {
    errAcc += c[i] * (1 << shift);
    let v = Math.round(errAcc);
    if (v > qmax) v = qmax;
    else if (v < qmin) v = qmin;
    errAcc -= v;
    q[i] = v;
  }
  return { q, shift, precision };
}

/** LPC residual; returns the sum of |residual| or -1 if a residual overflows. */
function lpcResidual(x: Int32Array, n: number, lq: LpcQuant, res: Int32Array): number {
  const order = lq.q.length;
  const div = Math.pow(2, lq.shift);
  for (let i = 0; i < order; i++) res[i] = 0;
  const q = lq.q;
  let abs = 0;
  for (let i = order; i < n; i++) {
    let s = 0;
    for (let j = 0; j < order; j++) s += q[j] * x[i - 1 - j];
    const r = x[i] - Math.floor(s / div);
    if (r > 1073741823 || r < -1073741824) return -1;
    res[i] = r;
    abs += r < 0 ? -r : r;
  }
  return abs;
}

/** Encode one channel block as the cheapest subframe type. */
function encodeSubframe(w: BitWriter, xin: Int32Array, n: number, bps: number, scratch: EncScratch, maxLpc: number): void {
  // constant?
  const first = xin[0];
  let allSame = true;
  for (let i = 1; i < n; i++)
    if (xin[i] !== first) {
      allSame = false;
      break;
    }
  if (allSame) {
    w.bits(0, 8); // pad + CONSTANT + no wasted bits
    w.signed(first, bps);
    return;
  }
  // wasted bits
  let or = 0;
  for (let i = 0; i < n; i++) or |= xin[i];
  let wasted = 0;
  if (or !== 0) while (((or >> wasted) & 1) === 0 && wasted < bps - 1) wasted++;
  let x = xin;
  if (wasted > 0) {
    x = scratch.tmp;
    for (let i = 0; i < n; i++) x[i] = xin[i] >> wasted;
  }
  const ebps = bps - wasted;

  // fixed predictor (order by sum |e|)
  const fs = scratch.sums;
  fixedAbsSums(x, n, fs);
  let fOrder = 0;
  for (let o = 1; o <= 4; o++) if (fs[o] < fs[fOrder]) fOrder = o;
  if (n <= 4) fOrder = Math.max(0, Math.min(fOrder, n - 1));
  let bestAbs = fs[fOrder] * 1.02; // slight preference for LPC at equal cost (better tails)
  let kind: 0 | 1 = 0; // 0 fixed, 1 lpc
  let lpcQ: LpcQuant | null = null;

  // LPC (single order search: maxLpc), chosen when its residual is smaller
  if (maxLpc > 0 && n > 4 * maxLpc + 16) {
    if (scratch.windowN !== n) {
      const taper = Math.floor(n * 0.25);
      for (let i = 0; i < n; i++) {
        let g = 1;
        if (i < taper) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
        else if (i >= n - taper) g = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / taper);
        scratch.window[i] = g;
      }
      scratch.windowN = n;
    }
    const win = scratch.win;
    const wnd = scratch.window;
    for (let i = 0; i < n; i++) win[i] = x[i] * wnd[i];
    const r = new Float64Array(maxLpc + 1);
    for (let lag = 0; lag <= maxLpc; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += win[i] * win[i - lag];
      r[lag] = s;
    }
    if (r[0] > 0) {
      r[0] *= 1 + 1e-9;
      const sets = levinson(r, maxLpc);
      if (sets.length) {
        const lq = quantizeLpc(sets[sets.length - 1], ebps <= 16 ? 13 : 15);
        if (lq) {
          const abs = lpcResidual(x, n, lq, scratch.cand);
          if (abs >= 0 && abs < bestAbs) {
            bestAbs = abs;
            kind = 1;
            lpcQ = lq;
            const t = scratch.res;
            scratch.res = scratch.cand;
            scratch.cand = t;
          }
        }
      }
    }
  }
  const order = kind === 1 ? lpcQ!.q.length : fOrder;
  if (kind === 0) fixedResidual(x, n, fOrder, scratch.res);
  const plan = planRice(scratch.res, n, order, scratch.sums);
  const predBits = plan.bits + order * ebps + (kind === 1 ? 9 + order * lpcQ!.precision : 0);
  const verbatim = n * ebps <= predBits;

  // header
  w.bits(0, 1);
  if (verbatim) w.bits(1, 6);
  else if (kind === 0) w.bits(8 | fOrder, 6);
  else w.bits(32 | (order - 1), 6);
  if (wasted > 0) {
    w.bits(1, 1);
    w.zeros(wasted - 1);
    w.bits(1, 1);
  } else w.bits(0, 1);

  if (verbatim) {
    for (let i = 0; i < n; i++) w.signed(x[i], ebps);
    return;
  }
  for (let i = 0; i < order; i++) w.signed(x[i], ebps);
  if (kind === 1) {
    const lq = lpcQ!;
    w.bits(lq.precision - 1, 4);
    w.signed(lq.shift, 5);
    for (let i = 0; i < order; i++) w.signed(lq.q[i], lq.precision);
  }
  writeResidual(w, scratch.res, n, order, plan);
}

/** Cheap cost proxy for stereo decorrelation: sum |2nd-order fixed residual|. */
function estimateBits(x: Int32Array, n: number): number {
  let s = 0;
  for (let i = 2; i < n; i++) {
    const e = x[i] - 2 * x[i - 1] + x[i - 2];
    s += e < 0 ? -e : e;
  }
  return s;
}

export function encodeFlac(buf: AudioData, opts: FlacEncodeOptions = {}): Uint8Array {
  const bps = opts.bitDepth ?? 16;
  if (bps !== 16 && bps !== 24) throw new Error(`encodeFlac: unsupported bit depth ${bps}`);
  const sr = Math.round(buf.sampleRate);
  if (sr <= 0 || sr >= 1 << 20) throw new Error(`encodeFlac: unsupported sample rate ${sr}`);
  const chans = buf.channels.length ? buf.channels : [new Float32Array(0)];
  const nch = Math.min(8, chans.length);
  const total = chans[0].length;
  const q = quantizeChannels({ sampleRate: sr, channels: chans.slice(0, nch) }, bps, { dither: opts.dither, seed: opts.seed });
  const blockSize = Math.max(16, Math.min(65535, opts.blockSize ?? 4096));
  const maxLpc = Math.max(0, Math.min(32, opts.maxLpcOrder ?? 8));

  // MD5 of interleaved little-endian samples
  const md5 = new Md5();
  const bytesPer = bps / 8;
  const chunkFrames = 4096;
  const mbuf = new Uint8Array(chunkFrames * nch * bytesPer);
  for (let f0 = 0; f0 < total; f0 += chunkFrames) {
    const f1 = Math.min(total, f0 + chunkFrames);
    let o = 0;
    for (let i = f0; i < f1; i++) {
      for (let c = 0; c < nch; c++) {
        const v = q[c][i];
        mbuf[o++] = v & 255;
        mbuf[o++] = (v >> 8) & 255;
        if (bytesPer === 3) mbuf[o++] = (v >> 16) & 255;
      }
    }
    md5.update(mbuf, 0, o);
  }
  const digest = md5.digest();

  const w = new BitWriter(Math.ceil(total * nch * bytesPer * 0.7) + 4096);
  const scratch: EncScratch = {
    res: new Int32Array(blockSize),
    cand: new Int32Array(blockSize),
    tmp: new Int32Array(blockSize),
    win: new Float64Array(blockSize),
    window: new Float64Array(blockSize),
    windowN: 0,
    sums: new Float64Array(512),
  };
  const xs = Array.from({ length: Math.max(nch, 2) + 2 }, () => new Int32Array(blockSize));
  let minFrame = Infinity;
  let maxFrame = 0;
  const srCode = SR_CODES[sr] ?? (sr % 1000 === 0 && sr / 1000 < 256 ? 12 : sr < 65536 ? 13 : sr % 10 === 0 && sr / 10 < 65536 ? 14 : 0);
  const ssCode = bps === 16 ? 4 : 6;
  let frameNo = 0;
  for (let start = 0; start < total || (total === 0 && frameNo === 0); start += blockSize) {
    if (total === 0) break;
    const n = Math.min(blockSize, total - start);
    w.reserve(n * (nch + 1) * 4 + 64);
    const frameStart = w.pos;
    for (let c = 0; c < nch; c++) {
      const src = q[c];
      const dst = xs[c];
      for (let i = 0; i < n; i++) dst[i] = src[start + i];
    }
    // stereo decorrelation choice
    let assignment = nch - 1;
    if (nch === 2) {
      const L = xs[0], R = xs[1], M = xs[2], S = xs[3];
      for (let i = 0; i < n; i++) {
        M[i] = (L[i] + R[i]) >> 1;
        S[i] = L[i] - R[i];
      }
      const bl = estimateBits(L, n), br = estimateBits(R, n), bm = estimateBits(M, n), bs = estimateBits(S, n);
      const opts4 = [bl + br, bl + bs, bs + br, bm + bs];
      let best = 0;
      for (let k = 1; k < 4; k++) if (opts4[k] < opts4[best]) best = k;
      assignment = best === 0 ? 1 : 7 + best; // 1 = independent stereo, 8 = L/S, 9 = S/R, 10 = M/S
    }
    // header
    const bsc = blockSizeCode(n);
    w.bits(0xfff8, 16);
    w.bits(bsc.code, 4);
    w.bits(srCode, 4);
    w.bits(assignment, 4);
    w.bits(ssCode, 3);
    w.bits(0, 1);
    writeUtf8Number(w, frameNo);
    if (bsc.extraBits) w.bits(bsc.extra, bsc.extraBits);
    if (srCode === 12) w.bits(sr / 1000, 8);
    else if (srCode === 13) w.bits(sr, 16);
    else if (srCode === 14) w.bits(sr / 10, 16);
    w.bits(crc8(w.buf, frameStart, w.pos), 8);
    // subframes
    if (nch === 2 && assignment >= 8) {
      const L = xs[0], R = xs[1], M = xs[2], S = xs[3];
      if (assignment === 8) {
        encodeSubframe(w, L, n, bps, scratch, maxLpc);
        encodeSubframe(w, S, n, bps + 1, scratch, maxLpc);
      } else if (assignment === 9) {
        encodeSubframe(w, S, n, bps + 1, scratch, maxLpc);
        encodeSubframe(w, R, n, bps, scratch, maxLpc);
      } else {
        encodeSubframe(w, M, n, bps, scratch, maxLpc);
        encodeSubframe(w, S, n, bps + 1, scratch, maxLpc);
      }
    } else {
      for (let c = 0; c < nch; c++) encodeSubframe(w, xs[c], n, bps, scratch, maxLpc);
    }
    w.align();
    w.bits(crc16(w.buf, frameStart, w.pos), 16);
    const fsize = w.pos - frameStart;
    minFrame = Math.min(minFrame, fsize);
    maxFrame = Math.max(maxFrame, fsize);
    frameNo++;
  }
  const frames = w.bytes();

  // header + STREAMINFO
  const h = new BitWriter(64);
  h.bits(0x664c6143, 32); // "fLaC"
  h.bits(1, 1); // last metadata block
  h.bits(0, 7); // STREAMINFO
  h.bits(34, 24);
  const minBlock = total === 0 ? 16 : total <= blockSize ? Math.max(16, total) : blockSize;
  const maxBlock = total === 0 ? 16 : total <= blockSize ? Math.max(16, total) : blockSize;
  h.bits(minBlock, 16);
  h.bits(maxBlock, 16);
  h.bits(frameNo ? minFrame : 0, 24);
  h.bits(frameNo ? maxFrame : 0, 24);
  h.bits(sr, 20);
  h.bits(nch - 1, 3);
  h.bits(bps - 1, 5);
  h.bits(Math.floor(total / 4294967296) & 0xf, 4);
  h.bits(total >>> 0, 32);
  for (let i = 0; i < 16; i++) h.bits(digest[i], 8);
  const head = h.bytes();
  const out = new Uint8Array(head.length + frames.length);
  out.set(head, 0);
  out.set(frames, head.length);
  return out;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

export interface FlacInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  md5: string;
  minBlockSize: number;
  maxBlockSize: number;
}

function decodeResidual(r: BitReader, n: number, order: number, out: Float64Array): void {
  const method = r.bits(2);
  if (method > 1) throw new Error('FLAC: reserved residual coding method');
  const pbits = method === 0 ? 4 : 5;
  const escape = method === 0 ? 15 : 31;
  const porder = r.bits(4);
  const parts = 1 << porder;
  const size = n >> porder;
  let idx = order;
  for (let p = 0; p < parts; p++) {
    const cnt = p === 0 ? size - order : size;
    if (cnt < 0) throw new Error('FLAC: invalid partition order');
    const k = r.bits(pbits);
    if (k === escape) {
      const nb = r.bits(5);
      for (let i = 0; i < cnt; i++) out[idx++] = r.signed(nb);
    } else {
      const pk = Math.pow(2, k);
      for (let i = 0; i < cnt; i++) {
        const qq = r.unary();
        const u = qq * pk + (k ? r.bits(k) : 0);
        out[idx++] = u % 2 === 1 ? -(u + 1) / 2 : u / 2;
      }
    }
  }
}

function decodeSubframe(r: BitReader, n: number, bps: number, out: Float64Array, res: Float64Array): void {
  if (r.bits(1) !== 0) throw new Error('FLAC: subframe padding bit set');
  const type = r.bits(6);
  let wasted = 0;
  if (r.bits(1)) wasted = r.unary() + 1;
  const ebps = bps - wasted;
  if (type === 0) {
    const v = r.signed(ebps);
    for (let i = 0; i < n; i++) out[i] = v;
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = r.signed(ebps);
  } else if (type >= 8 && type <= 12) {
    const order = type & 7;
    for (let i = 0; i < order; i++) out[i] = r.signed(ebps);
    decodeResidual(r, n, order, res);
    switch (order) {
      case 0:
        for (let i = 0; i < n; i++) out[i] = res[i];
        break;
      case 1:
        for (let i = 1; i < n; i++) out[i] = res[i] + out[i - 1];
        break;
      case 2:
        for (let i = 2; i < n; i++) out[i] = res[i] + 2 * out[i - 1] - out[i - 2];
        break;
      case 3:
        for (let i = 3; i < n; i++) out[i] = res[i] + 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3];
        break;
      default:
        for (let i = 4; i < n; i++) out[i] = res[i] + 4 * out[i - 1] - 6 * out[i - 2] + 4 * out[i - 3] - out[i - 4];
    }
  } else if (type >= 32) {
    const order = (type & 31) + 1;
    for (let i = 0; i < order; i++) out[i] = r.signed(ebps);
    const precision = r.bits(4) + 1;
    if (precision === 16) throw new Error('FLAC: invalid LPC precision');
    const shift = r.signed(5);
    const coefs = new Float64Array(order);
    for (let i = 0; i < order; i++) coefs[i] = r.signed(precision);
    decodeResidual(r, n, order, res);
    const div = Math.pow(2, Math.abs(shift));
    for (let i = order; i < n; i++) {
      let s = 0;
      for (let j = 0; j < order; j++) s += coefs[j] * out[i - 1 - j];
      out[i] = res[i] + (shift >= 0 ? Math.floor(s / div) : s * div);
    }
  } else {
    throw new Error(`FLAC: reserved subframe type ${type}`);
  }
  if (wasted > 0) {
    const m = Math.pow(2, wasted);
    for (let i = 0; i < n; i++) out[i] *= m;
  }
}

function readUtf8Number(r: BitReader): number {
  const b0 = r.bits(8);
  if (b0 < 0x80) return b0;
  let n = 0;
  let mask = 0x80;
  while (b0 & mask) {
    n++;
    mask >>= 1;
  }
  if (n < 2 || n > 7) throw new Error('FLAC: invalid frame number');
  let v = b0 & (mask - 1);
  for (let i = 1; i < n; i++) {
    const b = r.bits(8);
    if ((b & 0xc0) !== 0x80) throw new Error('FLAC: invalid frame number');
    v = v * 64 + (b & 0x3f);
  }
  return v;
}

export function flacInfo(bytes: Uint8Array): FlacInfo {
  return parseHeader(bytes).info;
}

function parseHeader(bytes: Uint8Array): { info: FlacInfo; frameStart: number } {
  if (bytes.length < 42 || bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) {
    throw new Error('decodeFlac: not a FLAC stream');
  }
  let o = 4;
  let info: FlacInfo | null = null;
  for (;;) {
    if (o + 4 > bytes.length) throw new Error('decodeFlac: truncated metadata');
    const last = bytes[o] & 0x80;
    const type = bytes[o] & 0x7f;
    const len = (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    if (type === 0) {
      const r = new BitReader(bytes.subarray(o + 4, o + 4 + len));
      const minBlockSize = r.bits(16);
      const maxBlockSize = r.bits(16);
      r.bits(24);
      r.bits(24);
      const sampleRate = r.bits(20);
      const channels = r.bits(3) + 1;
      const bitsPerSample = r.bits(5) + 1;
      const totalSamples = r.bits(4) * 4294967296 + r.bits(32);
      let md5 = '';
      for (let i = 0; i < 16; i++) md5 += r.bits(8).toString(16).padStart(2, '0');
      info = { sampleRate, channels, bitsPerSample, totalSamples, md5, minBlockSize, maxBlockSize };
    }
    o += 4 + len;
    if (last) break;
  }
  if (!info) throw new Error('decodeFlac: missing STREAMINFO');
  return { info, frameStart: o };
}

const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const SAMPLE_SIZES = [0, 8, 12, 0, 16, 20, 24, 32];

export function decodeFlac(bytes: Uint8Array, opts: { verifyCrc?: boolean } = {}): AudioData {
  const verify = opts.verifyCrc !== false;
  const { info, frameStart } = parseHeader(bytes);
  const nch = info.channels;
  let cap = info.totalSamples > 0 ? info.totalSamples : 1 << 16;
  let chans: Int32Array[] = Array.from({ length: nch }, () => new Int32Array(cap));
  let written = 0;
  const maxBs = Math.max(info.maxBlockSize || 4096, 16);
  let work = Array.from({ length: Math.max(2, nch) }, () => new Float64Array(maxBs));
  let res = new Float64Array(maxBs);
  let p = frameStart;
  let frameBps = info.bitsPerSample;
  while (p + 2 <= bytes.length) {
    if (!(bytes[p] === 0xff && (bytes[p + 1] & 0xfe) === 0xf8)) {
      p++;
      continue;
    }
    const r = new BitReader(bytes.subarray(p));
    r.bits(16);
    const bsCode = r.bits(4);
    const srCode = r.bits(4);
    const chAssign = r.bits(4);
    const ssCode = r.bits(3);
    r.bits(1);
    readUtf8Number(r);
    let n = BLOCK_SIZES[bsCode];
    if (bsCode === 6) n = r.bits(8) + 1;
    else if (bsCode === 7) n = r.bits(16) + 1;
    if (srCode === 12) r.bits(8);
    else if (srCode === 13 || srCode === 14) r.bits(16);
    const headerEnd = r.bytePos;
    const crc = r.bits(8);
    if (n === 0 || (verify && crc !== crc8(bytes, p, p + headerEnd))) {
      // false sync — keep scanning
      p++;
      continue;
    }
    frameBps = ssCode === 0 ? info.bitsPerSample : SAMPLE_SIZES[ssCode] || info.bitsPerSample;
    const fch = chAssign < 8 ? chAssign + 1 : 2;
    if (n > work[0].length) {
      work = Array.from({ length: Math.max(2, nch) }, () => new Float64Array(n));
      res = new Float64Array(n);
    }
    for (let c = 0; c < fch; c++) {
      const side = (chAssign === 8 && c === 1) || (chAssign === 9 && c === 0) || (chAssign === 10 && c === 1);
      decodeSubframe(r, n, frameBps + (side ? 1 : 0), work[c], res);
    }
    r.align();
    const frameEnd = r.bytePos;
    const fcrc = r.bits(16);
    if (verify && fcrc !== crc16(bytes, p, p + frameEnd)) throw new Error('decodeFlac: frame CRC-16 mismatch');
    const a = work[0], b = work[1];
    if (chAssign === 8) for (let i = 0; i < n; i++) b[i] = a[i] - b[i];
    else if (chAssign === 9) for (let i = 0; i < n; i++) a[i] = a[i] + b[i];
    else if (chAssign === 10) {
      for (let i = 0; i < n; i++) {
        const side = b[i];
        const mid = a[i] * 2 + (Math.abs(side) % 2);
        a[i] = (mid + side) / 2;
        b[i] = (mid - side) / 2;
      }
    }
    if (written + n > cap) {
      cap = Math.max(cap * 2, written + n);
      chans = chans.map((ch) => {
        const g = new Int32Array(cap);
        g.set(ch.subarray(0, written));
        return g;
      });
    }
    for (let c = 0; c < Math.min(fch, nch); c++) {
      const src = work[c];
      const dst = chans[c];
      for (let i = 0; i < n; i++) dst[written + i] = src[i];
    }
    written += n;
    p += frameEnd + 2;
  }
  const scale = 1 / Math.pow(2, info.bitsPerSample - 1);
  const outCh = chans.map((ch) => {
    const f = new Float32Array(written);
    for (let i = 0; i < written; i++) f[i] = ch[i] * scale;
    return f;
  });
  return { sampleRate: info.sampleRate, channels: downmixToStereo(outCh) };
}

/** Raw integer samples of a FLAC stream (testing / bit-exactness checks). */
export function decodeFlacInt(bytes: Uint8Array): { info: FlacInfo; channels: Int32Array[] } {
  const info = flacInfo(bytes);
  const audio = decodeFlac(bytes);
  const scale = Math.pow(2, info.bitsPerSample - 1);
  return { info, channels: audio.channels.map((c) => Int32Array.from(c, (v) => Math.round(v * scale))) };
}
