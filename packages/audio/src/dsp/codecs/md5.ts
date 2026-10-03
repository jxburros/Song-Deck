/**
 * Streaming MD5 (RFC 1321) — used for the FLAC STREAMINFO signature of the decoded samples.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21, 6, 10, 15, 21,
];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

export class Md5 {
  private h0 = 0x67452301;
  private h1 = 0xefcdab89 | 0;
  private h2 = 0x98badcfe | 0;
  private h3 = 0x10325476;
  private readonly buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private readonly w = new Int32Array(16);

  update(data: Uint8Array, start = 0, end = data.length): this {
    let i = start;
    this.total += end - start;
    if (this.bufLen > 0) {
      while (i < end && this.bufLen < 64) this.buf[this.bufLen++] = data[i++];
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (i + 64 <= end) {
      this.block(data, i);
      i += 64;
    }
    while (i < end) this.buf[this.bufLen++] = data[i++];
    return this;
  }

  digest(): Uint8Array {
    const bitLenLo = (this.total * 8) >>> 0;
    const bitLenHi = Math.floor((this.total * 8) / 4294967296) >>> 0;
    const pad = new Uint8Array((this.bufLen < 56 ? 56 : 120) - this.bufLen + 8);
    pad[0] = 0x80;
    const p = pad.length - 8;
    pad[p] = bitLenLo & 255;
    pad[p + 1] = (bitLenLo >>> 8) & 255;
    pad[p + 2] = (bitLenLo >>> 16) & 255;
    pad[p + 3] = (bitLenLo >>> 24) & 255;
    pad[p + 4] = bitLenHi & 255;
    pad[p + 5] = (bitLenHi >>> 8) & 255;
    pad[p + 6] = (bitLenHi >>> 16) & 255;
    pad[p + 7] = (bitLenHi >>> 24) & 255;
    const savedTotal = this.total;
    this.update(pad);
    this.total = savedTotal;
    const out = new Uint8Array(16);
    const hs = [this.h0, this.h1, this.h2, this.h3];
    for (let j = 0; j < 4; j++) {
      out[j * 4] = hs[j] & 255;
      out[j * 4 + 1] = (hs[j] >>> 8) & 255;
      out[j * 4 + 2] = (hs[j] >>> 16) & 255;
      out[j * 4 + 3] = (hs[j] >>> 24) & 255;
    }
    return out;
  }

  private block(d: Uint8Array, o: number): void {
    const w = this.w;
    for (let j = 0; j < 16; j++) {
      const b = o + j * 4;
      w[j] = d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24);
    }
    let a = this.h0,
      b = this.h1,
      c = this.h2,
      dd = this.h3;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = (b & c) | (~b & dd);
        g = i;
      } else if (i < 32) {
        f = (dd & b) | (~dd & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ dd;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~dd);
        g = (7 * i) & 15;
      }
      const tmp = dd;
      dd = c;
      c = b;
      const x = (a + f + K[i] + w[g]) | 0;
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
      a = tmp;
    }
    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + dd) | 0;
  }
}

export function md5(data: Uint8Array): Uint8Array {
  return new Md5().update(data).digest();
}

export function md5Hex(data: Uint8Array): string {
  return Array.from(md5(data), (b) => b.toString(16).padStart(2, '0')).join('');
}
