/**
 * Guitar amp + cabinet simulation (mono): input tightening high-pass, mid push, high gain into a
 * 2× oversampled asymmetric waveshaper, DC blocker, then a 4×12"-ish cabinet response
 * (low resonance, mid scoop, presence peak, steep high roll-off).
 */
import { Biquad, DcBlocker } from '../filters';
import { softClip } from '../utils';
import { OversampledShaper } from './saturation';

export interface AmpParams {
  /** Pre-gain in dB (e.g. 6 = crunch, 30 = high gain). */
  driveDb: number;
  /** Asymmetry 0..0.5 (even harmonics). */
  asym: number;
  /** Mid scoop (dB, negative = scooped). */
  midDb: number;
  /** Presence boost (dB). */
  presenceDb: number;
  /** Cabinet low-pass cutoff (Hz). */
  cabHz: number;
  /** Output trim (dB). */
  outDb: number;
}

export class AmpSim {
  private readonly inHp = new Biquad();
  private readonly push = new Biquad();
  private readonly shaper: OversampledShaper;
  private readonly dc = new DcBlocker();
  private readonly cab: Biquad[] = [];
  private gain = 1;
  private out = 1;
  private bias = 0;
  private biasOut = 0;

  constructor(private readonly sampleRate: number) {
    this.shaper = new OversampledShaper((x) => softClip(x));
    this.dc.set(20, sampleRate);
  }

  configure(p: AmpParams): void {
    const sr = this.sampleRate;
    this.inHp.design('highpass', 110, 0.7071, 0, sr);
    this.push.design('peak', 750, 0.8, 6, sr);
    this.gain = Math.pow(10, p.driveDb / 20);
    this.out = Math.pow(10, p.outDb / 20);
    this.bias = Math.max(0, Math.min(0.5, p.asym));
    this.biasOut = softClip(this.bias);
    const b = this.bias,
      bo = this.biasOut;
    this.shaper.setShape((x) => softClip(x + b) - bo);
    this.cab.length = 0;
    const mk = () => {
      const q = new Biquad();
      this.cab.push(q);
      return q;
    };
    mk().design('highpass', 75, 0.7071, 0, sr);
    mk().design('peak', 115, 1.1, 3, sr);
    mk().design('peak', 480, 1.0, p.midDb, sr);
    mk().design('peak', 2300, 1.4, p.presenceDb, sr);
    mk().design('lowpass', p.cabHz, 0.9, 0, sr);
    const last = mk().design('lowpass', p.cabHz * 1.35, 0.6, 0, sr);
    last.setCoefs(last.b0 * this.out, last.b1 * this.out, last.b2 * this.out, last.a1, last.a2);
    const g = this.gain;
    this.push.setCoefs(this.push.b0 * g, this.push.b1 * g, this.push.b2 * g, this.push.a1, this.push.a2);
  }

  reset(): void {
    this.inHp.reset();
    this.push.reset();
    this.shaper.reset();
    this.dc.reset();
    for (const c of this.cab) c.reset();
  }

  process(buf: Float64Array, start: number, end: number): void {
    // input gain is folded into `push`, output trim into the last cab filter (see configure)
    this.inHp.processMono(buf, start, end);
    this.push.processMono(buf, start, end);
    this.shaper.process(buf, start, end);
    this.dc.processMono(buf, start, end);
    const cab = this.cab;
    for (let k = 0; k < cab.length; k++) cab[k].processMono(buf, start, end);
  }
}
