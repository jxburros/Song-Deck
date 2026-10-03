/**
 * Modal synthesis voice: a bank of exponentially decaying sinusoidal modes plus a filtered-noise
 * mallet strike and an initial pitch drop (timpani / membranes / struck objects).
 */
import { Adsr } from '../envelopes';
import { NOISE_SCALE, midiToHz, seedState, sin01, t60Coef, velocityGain, xorshift } from '../utils';
import { ART_DEAD, ART_PALM, type NoteEvent, Voice, type VoiceHost, panGains } from './types';

export interface ModalParams {
  engine: 'modal';
  modes: { ratio: number; amp: number; t60: number }[];
  strike: { level: number; decay: number; cutoff: number };
  /** Initial pitch excess (cents) relaxing over `dropTime`. */
  pitchDrop?: number;
  dropTime?: number;
  /** Velocity → upper-mode brightness. */
  velBright: number;
  release: number;
  velSens: number;
  gain?: number;
}

const MAXM = 10;

export class ModalVoice extends Voice {
  private readonly env = new Adsr();
  private readonly ph = new Float64Array(MAXM);
  private readonly inc = new Float64Array(MAXM);
  private readonly amp = new Float64Array(MAXM);
  private readonly coef = new Float64Array(MAXM);
  private n = 0;
  private readonly buf = new Float64Array(64);
  private drop = 0;
  private dropCoef = 0;
  private strike = 0;
  private strikeCoef = 0;
  private lpA = 0.1;
  private lp = 0;
  private noise = 1;
  private vg = 1;
  private quiet = 0;
  private peak = 0;
  private readonly pg = new Float64Array(2);
  private readonly sr: number;

  constructor(host: VoiceHost, private readonly p: ModalParams, private readonly stereo: boolean) {
    super(host);
    this.sr = host.sampleRate;
    this.n = Math.min(MAXM, p.modes.length);
  }

  start(ev: NoteEvent): void {
    this.begin(ev);
    const p = this.p, sr = this.sr;
    this.n = Math.min(MAXM, p.modes.length);
    const f0 = midiToHz(ev.pitch);
    const v = Math.max(0, Math.min(1, ev.velocity / 127));
    const short = (ev.art & (ART_DEAD | ART_PALM)) !== 0;
    for (let k = 0; k < this.n; k++) {
      const m = p.modes[k];
      const f = f0 * m.ratio;
      this.inc[k] = f / sr;
      this.ph[k] = 0;
      const bright = k === 0 ? 1 : Math.pow(0.5 + 0.5 * v, p.velBright * k * 0.5);
      this.amp[k] = f < sr * 0.45 ? m.amp * bright : 0;
      this.coef[k] = t60Coef(m.t60 * (short ? 0.12 : 1), sr);
    }
    this.drop = (p.pitchDrop ?? 0) / 1200;
    this.dropCoef = Math.exp(-1 / ((p.dropTime ?? 0.1) * sr));
    this.strike = p.strike.level * (0.3 + 0.7 * v);
    this.strikeCoef = t60Coef(p.strike.decay, sr);
    this.lpA = 1 - Math.exp((-2 * Math.PI * p.strike.cutoff * (0.5 + v)) / sr);
    this.lp = 0;
    this.noise = seedState(ev.seed);
    this.vg = velocityGain(ev.velocity, p.velSens) * (p.gain ?? 1);
    this.env.set(0.001, 1, 1, p.release, sr);
    this.env.retrigger();
    this.quiet = 0;
    panGains(this.stereo ? ev.pan : 0, this.pg);
  }

  release(): void {
    this.released = true;
    this.env.release();
  }

  kill(): void {
    this.killed = true;
    this.env.kill();
  }

  level(): number {
    return this.peak;
  }

  render(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const env = this.host.scratch;
    const alive = this.env.process(env, start, end);
    const ph = this.ph, inc = this.inc, amp = this.amp, coef = this.coef;
    // pitch drop applied per block
    const pm = Math.pow(2, this.drop);
    this.drop *= Math.pow(this.dropCoef, end - start);
    let st = this.strike;
    const sc = this.strikeCoef, a = this.lpA;
    let lp = this.lp;
    let ns = this.noise;
    const vg = this.vg;
    const gl = this.stereo ? this.pg[0] : 1, gr = this.pg[1];
    let peak = 0;
    // drop fully decayed modes (the list only shrinks; order is irrelevant)
    let nm = this.n;
    for (let k = 0; k < nm; ) {
      if (amp[k] < 1e-4) {
        nm--;
        amp[k] = amp[nm];
        ph[k] = ph[nm];
        inc[k] = inc[nm];
        coef[k] = coef[nm];
      } else k++;
    }
    this.n = nm;
    const buf = this.buf;
    for (let i = start; i < end; i++) buf[i] = 0;
    for (let k = 0; k < nm; k++) {
      let p = ph[k];
      const dp = inc[k] * pm;
      let a = amp[k];
      const c = coef[k];
      for (let i = start; i < end; i++) {
        p += dp;
        if (p >= 1) p -= 1;
        buf[i] += sin01(p) * a;
        a *= c;
      }
      ph[k] = p;
      amp[k] = a;
    }
    for (let i = start; i < end; i++) {
      let s = buf[i];
      if (st > 1e-5) {
        ns = xorshift(ns);
        lp += a * (ns * NOISE_SCALE - lp);
        s += lp * st;
        st *= sc;
      }
      const out = s * env[i] * vg;
      if (this.stereo) {
        L[i] += out * gl;
        R[i] += out * gr;
      } else L[i] += out;
      const ab = out < 0 ? -out : out;
      if (ab > peak) peak = ab;
    }
    this.strike = st;
    this.lp = lp;
    this.noise = ns;
    this.peak = peak;
    if (peak < 1e-4) this.quiet += end - start;
    else this.quiet = 0;
    if (!alive || this.quiet > 0.03 * this.sr) this.active = false;
  }
}
