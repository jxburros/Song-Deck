/**
 * Two-operator-pair FM voice (DX-style): each pair = modulator → carrier with decaying modulation
 * index (velocity → brightness) and its own amplitude decay. Electric piano, bells, mallets.
 */
import { Adsr } from '../envelopes';
import { NOISE_SCALE, clampNum, midiToHz, seedState, sin01, t60Coef, velocityGain, xorshift } from '../utils';
import { ART_DEAD, ART_PALM, ART_STACCATO, type NoteEvent, Voice, type VoiceHost, panGains } from './types';

export interface FmPair {
  /** Carrier frequency ratio. */
  carrier: number;
  /** Modulator frequency ratio. */
  mod: number;
  /** Modulation index at velocity 0 and the extra index at full velocity. */
  index: number;
  indexVel: number;
  /** Index decay T60 (s). */
  indexDecay: number;
  /** Index floor (fraction of the start index) after decay. */
  indexSustain?: number;
  level: number;
  /** Amplitude T60 at C4 (s); scaled by (f/261.6)^-decayExp. */
  decay: number;
  decayExp?: number;
  /** Detune (cents) of this pair (chorusing). */
  cents?: number;
}

export interface FmParams {
  engine: 'fm';
  pairs: FmPair[];
  attack: number;
  release: number;
  velSens: number;
  /** Short filtered noise strike at the attack (mallets). */
  strike?: { level: number; decay: number };
  gain?: number;
}

const MAXP = 3;

export class FmVoice extends Voice {
  private readonly env = new Adsr();
  private readonly cph = new Float64Array(MAXP);
  private readonly mph = new Float64Array(MAXP);
  private readonly cinc = new Float64Array(MAXP);
  private readonly minc = new Float64Array(MAXP);
  private readonly idx = new Float64Array(MAXP);
  private readonly idxFloor = new Float64Array(MAXP);
  private readonly idxCoef = new Float64Array(MAXP);
  private readonly amp = new Float64Array(MAXP);
  private readonly ampCoef = new Float64Array(MAXP);
  private nPairs = 1;
  private vg = 1;
  private noise = 1;
  private strikeAmp = 0;
  private strikeCoef = 0;
  private lp = 0;
  private quiet = 0;
  private peak = 0;
  private readonly pg = new Float64Array(2);
  private readonly sr: number;

  constructor(host: VoiceHost, private readonly p: FmParams, private readonly stereo: boolean) {
    super(host);
    this.sr = host.sampleRate;
    this.nPairs = Math.min(MAXP, p.pairs.length);
  }

  start(ev: NoteEvent): void {
    this.begin(ev);
    const p = this.p;
    const sr = this.sr;
    const f0 = midiToHz(ev.pitch);
    const v = clampNum(ev.velocity / 127, 0, 1);
    const short = (ev.art & (ART_DEAD | ART_PALM)) !== 0;
    for (let k = 0; k < this.nPairs; k++) {
      const pr = p.pairs[k];
      const det = Math.pow(2, (pr.cents ?? 0) / 1200);
      this.cinc[k] = Math.min(0.49, (f0 * pr.carrier * det) / sr);
      this.minc[k] = (f0 * pr.mod * det) / sr;
      this.cph[k] = 0;
      this.mph[k] = 0;
      const i0 = pr.index + pr.indexVel * v * v;
      this.idx[k] = i0;
      this.idxFloor[k] = i0 * (pr.indexSustain ?? 0);
      this.idxCoef[k] = t60Coef(pr.indexDecay, sr);
      this.amp[k] = pr.level;
      const t60 = pr.decay * Math.pow(f0 / 261.6, -(pr.decayExp ?? 0.5)) * (short ? 0.15 : 1);
      this.ampCoef[k] = t60Coef(Math.max(0.03, t60), sr);
    }
    this.vg = velocityGain(ev.velocity, p.velSens) * (p.gain ?? 1);
    this.env.set(p.attack, 1, 1, ev.art & ART_STACCATO ? Math.min(0.08, p.release) : p.release, sr);
    this.env.retrigger();
    this.noise = seedState(ev.seed);
    this.strikeAmp = p.strike ? p.strike.level * (0.4 + 0.6 * v) : 0;
    this.strikeCoef = p.strike ? t60Coef(p.strike.decay, sr) : 0;
    this.lp = 0;
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
    const n = this.nPairs;
    const cph = this.cph, mph = this.mph, cinc = this.cinc, minc = this.minc;
    const idx = this.idx, idxF = this.idxFloor, idxC = this.idxCoef, amp = this.amp, ampC = this.ampCoef;
    const vg = this.vg;
    const gl = this.stereo ? this.pg[0] : 1, gr = this.pg[1];
    let peak = 0;
    let sa = this.strikeAmp;
    const sc = this.strikeCoef;
    let ns = this.noise;
    let lp = this.lp;
    for (let i = start; i < end; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) {
        let mp = mph[k] + minc[k];
        mp -= Math.floor(mp);
        mph[k] = mp;
        let cp = cph[k] + cinc[k];
        if (cp >= 1) cp -= 1;
        cph[k] = cp;
        const ix = idxF[k] + (idx[k] - idxF[k]);
        s += sin01(cp + ix * sin01(mp) * 0.15915494309189535) * amp[k];
        idx[k] = idxF[k] + (idx[k] - idxF[k]) * idxC[k];
        amp[k] *= ampC[k];
      }
      if (sa > 1e-5) {
        ns = xorshift(ns);
        lp += 0.25 * (ns * NOISE_SCALE - lp);
        s += lp * sa;
        sa *= sc;
      }
      const out = s * env[i] * vg;
      if (this.stereo) {
        L[i] += out * gl;
        R[i] += out * gr;
      } else L[i] += out;
      const a = out < 0 ? -out : out;
      if (a > peak) peak = a;
    }
    this.strikeAmp = sa;
    this.noise = ns;
    this.lp = lp;
    this.peak = peak;
    if (peak < 1e-4) this.quiet += end - start;
    else this.quiet = 0;
    if (!alive || this.quiet > 0.03 * this.sr) this.active = false;
  }
}
