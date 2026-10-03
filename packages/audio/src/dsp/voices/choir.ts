/**
 * Choir (formant pad): each voice is a small ensemble of detuned band-limited sources with
 * independent slow vibrato and a touch of breath noise; the vowel colour comes from a parallel
 * formant bank applied once on the summed instrument output (linear → cheap), see FormantBank.
 */
import { Adsr } from '../envelopes';
import { Biquad } from '../filters';
import { polyBlep } from '../oscillators';
import { NOISE_SCALE, midiToHz, seedState, sin01, velocityGain, xorshift } from '../utils';
import { type NoteEvent, Voice, type VoiceHost, panGains } from './types';

export interface ChoirParams {
  engine: 'choir';
  /** Singers per voice (1..4). */
  singers: number;
  detuneCents: number;
  vibratoCents: number;
  breath: number;
  attack: number;
  release: number;
  velSens: number;
  gain?: number;
}

const MAXS = 4;

export class ChoirVoice extends Voice {
  private readonly env = new Adsr();
  private readonly ph = new Float64Array(MAXS);
  private readonly ratio = new Float64Array(MAXS);
  private readonly vph = new Float64Array(MAXS);
  private readonly vrate = new Float64Array(MAXS);
  private readonly incs = new Float64Array(MAXS);
  private n = 3;
  private f0 = 220;
  private lp = 0;
  private lpA = 0.3;
  private noise = 1;
  private vg = 1;
  private readonly pg = new Float64Array(2);
  private readonly sr: number;

  constructor(
    host: VoiceHost,
    private readonly p: ChoirParams,
    private readonly stereo: boolean,
  ) {
    super(host);
    this.sr = host.sampleRate;
    this.n = Math.max(1, Math.min(MAXS, p.singers));
    this.env.set(p.attack, 1, 1, p.release, this.sr);
    this.lpA = 1 - Math.exp((-2 * Math.PI * 3200) / this.sr);
  }

  start(ev: NoteEvent): void {
    this.begin(ev);
    let s = seedState(ev.seed);
    this.f0 = midiToHz(ev.pitch);
    for (let k = 0; k < this.n; k++) {
      s = xorshift(s);
      this.ph[k] = (s >>> 0) / 4294967296;
      s = xorshift(s);
      this.vph[k] = (s >>> 0) / 4294967296;
      s = xorshift(s);
      this.vrate[k] = 4.6 + ((s >>> 0) / 4294967296) * 1.2;
      const spread = this.n > 1 ? (k / (this.n - 1) - 0.5) * this.p.detuneCents : 0;
      this.ratio[k] = Math.pow(2, spread / 1200);
    }
    this.noise = s || 1;
    this.lp = 0;
    this.vg = (velocityGain(ev.velocity, this.p.velSens) * (this.p.gain ?? 1)) / Math.sqrt(this.n);
    this.env.retrigger();
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
    return this.env.value * this.vg;
  }

  render(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const env = this.host.scratch;
    const alive = this.env.process(env, start, end);
    const n = this.n,
      sr = this.sr;
    const blk = end - start;
    for (let k = 0; k < n; k++) {
      this.vph[k] += (this.vrate[k] * blk) / sr;
      if (this.vph[k] >= 1) this.vph[k] -= 1;
      const vib = (this.p.vibratoCents / 1200) * sin01(this.vph[k]);
      this.incs[k] = Math.min(0.45, ((this.f0 * this.ratio[k]) / sr) * Math.pow(2, vib));
    }
    const ph = this.ph,
      incs = this.incs;
    let lp = this.lp;
    const a = this.lpA;
    const vg = this.vg;
    const br = this.p.breath;
    let ns = this.noise;
    const gl = this.stereo ? this.pg[0] : 1,
      gr = this.pg[1];
    for (let i = start; i < end; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) {
        const dt = incs[k];
        let p = ph[k] + dt;
        if (p >= 1) p -= 1;
        ph[k] = p;
        s += 2 * p - 1 - polyBlep(p, dt);
      }
      ns = xorshift(ns);
      s += ns * NOISE_SCALE * br;
      lp += a * (s - lp);
      const out = lp * env[i] * vg;
      if (this.stereo) {
        L[i] += out * gl;
        R[i] += out * gr;
      } else L[i] += out;
    }
    this.lp = lp;
    this.noise = ns;
    if (!alive) this.active = false;
  }
}

/** Parallel formant bank (stereo) used on the summed choir output. */
export class FormantBank {
  private readonly bands: Biquad[] = [];
  private readonly gains: number[] = [];
  private readonly tmpL: Float64Array;
  private readonly tmpR: Float64Array;
  private readonly accL: Float64Array;
  private readonly accR: Float64Array;
  private dry = 0.12;

  constructor(
    private readonly sampleRate: number,
    blockSize: number,
  ) {
    this.tmpL = new Float64Array(blockSize);
    this.tmpR = new Float64Array(blockSize);
    this.accL = new Float64Array(blockSize);
    this.accR = new Float64Array(blockSize);
  }

  configure(formants: { f: number; q: number; db: number }[], dry = 0.12): void {
    this.bands.length = 0;
    this.gains.length = 0;
    for (const fm of formants) {
      const b = new Biquad().design('bandpass', fm.f, fm.q, 0, this.sampleRate);
      this.bands.push(b);
      this.gains.push(Math.pow(10, fm.db / 20));
    }
    this.dry = dry;
  }

  reset(): void {
    for (const b of this.bands) b.reset();
  }

  process(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const tL = this.tmpL,
      tR = this.tmpR,
      aL = this.accL,
      aR = this.accR;
    for (let i = start; i < end; i++) {
      aL[i] = L[i] * this.dry;
      aR[i] = R[i] * this.dry;
    }
    for (let b = 0; b < this.bands.length; b++) {
      for (let i = start; i < end; i++) {
        tL[i] = L[i];
        tR[i] = R[i];
      }
      this.bands[b].processStereo(tL, tR, start, end);
      const g = this.gains[b];
      for (let i = start; i < end; i++) {
        aL[i] += tL[i] * g;
        aR[i] += tR[i] * g;
      }
    }
    for (let i = start; i < end; i++) {
      L[i] = aL[i];
      R[i] = aR[i];
    }
  }
}
