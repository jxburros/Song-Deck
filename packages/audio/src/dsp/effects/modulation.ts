/**
 * Instrument modulation effects: stereo chorus/ensemble, rotary speaker (Leslie-ish), auto-pan
 * tremolo. All allocation-free in process(), deterministic (LFOs start at fixed phases).
 */
import { sin01 } from '../utils';

function readLin(buf: Float64Array, pos: number, mask: number): number {
  const ip = Math.floor(pos);
  const f = pos - ip;
  const a = buf[ip & mask];
  return a + f * (buf[(ip + 1) & mask] - a);
}

export interface ChorusParams {
  rate: number;
  depthMs: number;
  delayMs: number;
  mix: number;
  voices: number;
}

export class Chorus {
  private readonly bl: Float64Array;
  private readonly br: Float64Array;
  private readonly mask: number;
  private w = 0;
  private phase = 0;
  private inc = 0;
  private depth = 0;
  private base = 0;
  private dry = 1;
  private wet = 0;
  private voices = 2;

  constructor(private readonly sampleRate: number) {
    let n = 1;
    while (n < 0.08 * sampleRate) n *= 2;
    this.bl = new Float64Array(n);
    this.br = new Float64Array(n);
    this.mask = n - 1;
  }

  configure(p: ChorusParams): void {
    const sr = this.sampleRate;
    this.inc = p.rate / sr;
    this.depth = (p.depthMs * sr) / 1000;
    this.base = Math.max(this.depth + 2, (p.delayMs * sr) / 1000);
    this.voices = Math.max(1, Math.min(3, Math.round(p.voices)));
    const mix = Math.max(0, Math.min(1, p.mix));
    this.dry = 1 - mix * 0.5;
    this.wet = mix / this.voices;
  }

  reset(): void {
    this.bl.fill(0);
    this.br.fill(0);
    this.phase = 0;
  }

  private readonly d0 = new Float64Array(6);
  private readonly d1 = new Float64Array(6);

  process(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const n = end - start;
    if (n <= 0) return;
    const bl = this.bl, br = this.br, mask = this.mask;
    const size = mask + 1;
    let w = this.w;
    const ph0 = this.phase;
    const inc = this.inc, depth = this.depth, base = this.base, dry = this.dry, wet = this.wet, nv = this.voices;
    const ph1 = ph0 + inc * n;
    const d0 = this.d0, d1 = this.d1;
    for (let v = 0; v < nv; v++) {
      const off = v / nv;
      d0[v] = base + depth * sin01(ph0 + off);
      d1[v] = base + depth * sin01(ph1 + off);
      d0[v + 3] = base + depth * sin01(ph0 + off + 0.25);
      d1[v + 3] = base + depth * sin01(ph1 + off + 0.25);
    }
    const invN = 1 / n;
    for (let i = start; i < end; i++) {
      const xl = L[i], xr = R[i];
      bl[w] = xl;
      br[w] = xr;
      const t = (i - start + 1) * invN;
      let sl = 0, sr = 0;
      for (let v = 0; v < nv; v++) {
        let pos = w - (d0[v] + (d1[v] - d0[v]) * t) + size;
        let ip = pos | 0;
        let f = pos - ip;
        let a = bl[ip & mask];
        sl += a + f * (bl[(ip + 1) & mask] - a);
        pos = w - (d0[v + 3] + (d1[v + 3] - d0[v + 3]) * t) + size;
        ip = pos | 0;
        f = pos - ip;
        a = br[ip & mask];
        sr += a + f * (br[(ip + 1) & mask] - a);
      }
      L[i] = xl * dry + sl * wet;
      R[i] = xr * dry + sr * wet;
      w = (w + 1) & mask;
    }
    this.w = w;
    this.phase = ph1 - Math.floor(ph1);
  }
}

/** Rotary speaker: doppler (modulated delay) + amplitude modulation, two virtual mics at ±90°. */
export class Rotary {
  private readonly buf: Float64Array;
  private readonly mask: number;
  private w = 0;
  private phase = 0;
  private inc = 0;
  private depth = 0;
  private am = 0.25;
  private mix = 0.7;

  constructor(private readonly sampleRate: number) {
    let n = 1;
    while (n < 0.02 * sampleRate) n *= 2;
    this.buf = new Float64Array(n);
    this.mask = n - 1;
  }

  configure(rateHz: number, depthMs: number, am = 0.25, mix = 0.7): void {
    this.inc = rateHz / this.sampleRate;
    this.depth = (depthMs * this.sampleRate) / 1000;
    this.am = am;
    this.mix = mix;
  }

  reset(): void {
    this.buf.fill(0);
    this.phase = 0;
  }

  process(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const buf = this.buf, mask = this.mask;
    let w = this.w, ph = this.phase;
    const inc = this.inc, depth = this.depth, am = this.am, mix = this.mix, dry = 1 - mix;
    const base = depth + 3;
    for (let i = start; i < end; i++) {
      const x = (L[i] + R[i]) * 0.5;
      buf[w] = x;
      const s1 = sin01(ph);
      const s2 = sin01(ph + 0.25);
      const yl = readLin(buf, w - (base + depth * s1), mask) * (1 + am * s2);
      const yr = readLin(buf, w - (base - depth * s1), mask) * (1 - am * s2);
      L[i] = L[i] * dry + yl * mix;
      R[i] = R[i] * dry + yr * mix;
      w = (w + 1) & mask;
      ph += inc;
      if (ph >= 1) ph -= 1;
    }
    this.w = w;
    this.phase = ph;
  }
}

/** Stereo auto-pan tremolo (suitcase electric piano). */
export class AutoPan {
  private phase = 0;
  private inc = 0;
  private depth = 0;
  constructor(private readonly sampleRate: number) {}
  configure(rateHz: number, depth: number): void {
    this.inc = rateHz / this.sampleRate;
    this.depth = Math.max(0, Math.min(1, depth));
  }
  reset(): void {
    this.phase = 0;
  }
  process(L: Float64Array, R: Float64Array, start: number, end: number): void {
    let ph = this.phase;
    const inc = this.inc, d = this.depth;
    for (let i = start; i < end; i++) {
      const s = sin01(ph) * d;
      L[i] *= 1 + s;
      R[i] *= 1 - s;
      ph += inc;
      if (ph >= 1) ph -= 1;
    }
    this.phase = ph;
  }
}
