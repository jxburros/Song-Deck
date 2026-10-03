/**
 * Drawbar organ: the nine drawbars (16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1') are harmonics 1,3,2,4,6,8,10,12,16 of
 * the sub-fundamental f/2, so a whole registration is one mip-mapped wavetable (one lookup per
 * voice-sample). Key click, optional percussion (2nd/3rd harmonic), near-instant envelopes.
 * The rotary speaker is applied at instrument level (see patches).
 */
import { Adsr } from '../envelopes';
import { Wavetable, wtRead } from '../oscillators';
import { NOISE_SCALE, midiToHz, seedState, sin01, t60Coef, velocityGain, xorshift } from '../utils';
import { type NoteEvent, Voice, type VoiceHost, panGains } from './types';

export interface OrganParams {
  engine: 'organ';
  /** Nine drawbar settings 0..8. */
  drawbars: number[];
  click: number;
  percussion?: { harmonic: 2 | 3; level: number; decay: number };
  velSens: number;
  gain?: number;
}

const HARM = [1, 3, 2, 4, 6, 8, 10, 12, 16];
const tableCache = new Map<string, Wavetable>();

function organTable(drawbars: number[]): Wavetable {
  const key = drawbars.join(',');
  let t = tableCache.get(key);
  if (!t) {
    const amps = new Array(16).fill(0);
    drawbars.slice(0, 9).forEach((v, i) => {
      if (v > 0) amps[HARM[i] - 1] += Math.pow(10, ((Math.min(8, v) - 8) * 3) / 20);
    });
    t = new Wavetable(amps);
    tableCache.set(key, t);
  }
  return t;
}

export class OrganVoice extends Voice {
  private readonly env = new Adsr();
  private readonly table: Wavetable;
  private level0: Float64Array;
  private phase = 0;
  private inc = 0;
  private pPhase = 0;
  private pInc = 0;
  private pAmp = 0;
  private pCoef = 0;
  private clickLeft = 0;
  private clickLen = 1;
  private noise = 1;
  private vg = 1;
  private readonly pg = new Float64Array(2);
  private readonly sr: number;

  constructor(host: VoiceHost, private readonly p: OrganParams, private readonly stereo: boolean) {
    super(host);
    this.sr = host.sampleRate;
    this.table = organTable(p.drawbars);
    this.level0 = this.table.levels[0];
    this.env.set(0.004, 1, 1, 0.025, this.sr);
  }

  start(ev: NoteEvent): void {
    this.begin(ev);
    const f0 = midiToHz(ev.pitch);
    this.inc = f0 / 2 / this.sr;
    this.level0 = this.table.levels[this.table.levelFor(f0 / 2, this.sr)];
    this.phase = 0;
    const pc = this.p.percussion;
    if (pc) {
      this.pInc = (f0 * pc.harmonic) / this.sr;
      this.pPhase = 0;
      this.pAmp = pc.harmonic * f0 < this.sr * 0.45 ? pc.level : 0;
      this.pCoef = t60Coef(pc.decay, this.sr);
    }
    this.clickLen = Math.max(1, Math.round(0.003 * this.sr));
    this.clickLeft = this.clickLen;
    this.noise = seedState(ev.seed);
    this.vg = velocityGain(ev.velocity, this.p.velSens) * (this.p.gain ?? 1);
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
    const t = this.level0;
    let ph = this.phase;
    const inc = this.inc;
    let pp = this.pPhase, pa = this.pAmp;
    const pi = this.pInc, pc = this.pCoef;
    const vg = this.vg;
    const gl = this.stereo ? this.pg[0] : 1, gr = this.pg[1];
    const click = this.p.click;
    let ns = this.noise;
    for (let i = start; i < end; i++) {
      let s = wtRead(t, ph);
      ph += inc;
      if (ph >= 1) ph -= 1;
      if (pa > 1e-5) {
        s += pa * sin01(pp);
        pp += pi;
        if (pp >= 1) pp -= 1;
        pa *= pc;
      }
      if (this.clickLeft > 0) {
        ns = xorshift(ns);
        s += ns * NOISE_SCALE * click * (this.clickLeft / this.clickLen);
        this.clickLeft--;
      }
      const out = s * env[i] * vg;
      if (this.stereo) {
        L[i] += out * gl;
        R[i] += out * gr;
      } else L[i] += out;
    }
    this.phase = ph;
    this.pPhase = pp;
    this.pAmp = pa;
    this.noise = ns;
    if (!alive) this.active = false;
  }
}
