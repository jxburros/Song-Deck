/**
 * Envelopes. ADSR with a linear (click-free, ≥1 ms) attack and exponential decay/release
 * (times are "to -60 dB"). Block-oriented to keep voice loops tight.
 */
import { t60Coef } from './utils';

export const ENV_IDLE = 0;
export const ENV_ATTACK = 1;
export const ENV_DECAY = 2;
export const ENV_SUSTAIN = 3;
export const ENV_RELEASE = 4;

export class Adsr {
  stage = ENV_IDLE;
  value = 0;
  private attackInc = 1;
  private decayCoef = 0;
  sustain = 1;
  private releaseCoef = 0;
  private decay16 = 0;
  private release16 = 0;
  private sr = 44100;

  set(attack: number, decay: number, sustain: number, release: number, sampleRate: number): this {
    this.sr = sampleRate;
    this.attackInc = 1 / Math.max(1, Math.max(0.001, attack) * sampleRate);
    this.decayCoef = t60Coef(Math.max(0.002, decay), sampleRate);
    this.sustain = Math.min(1, Math.max(0, sustain));
    this.releaseCoef = t60Coef(Math.max(0.004, release), sampleRate);
    this.decay16 = Math.pow(this.decayCoef, 16);
    this.release16 = Math.pow(this.releaseCoef, 16);
    return this;
  }

  setRelease(release: number): void {
    this.releaseCoef = t60Coef(Math.max(0.004, release), this.sr);
    this.release16 = Math.pow(this.releaseCoef, 16);
  }

  setDecay(decay: number): void {
    this.decayCoef = t60Coef(Math.max(0.002, decay), this.sr);
    this.decay16 = Math.pow(this.decayCoef, 16);
  }

  /** Start (or restart from the current level, click-free). */
  trigger(): void {
    this.stage = ENV_ATTACK;
  }

  /** Hard reset to zero then trigger. */
  retrigger(): void {
    this.value = 0;
    this.stage = ENV_ATTACK;
  }

  release(): void {
    if (this.stage !== ENV_IDLE) this.stage = ENV_RELEASE;
  }

  /** Fast fade (voice stealing / choke). */
  kill(seconds = 0.006): void {
    if (this.stage === ENV_IDLE) return;
    this.releaseCoef = t60Coef(seconds, this.sr);
    this.release16 = Math.pow(this.releaseCoef, 16);
    this.stage = ENV_RELEASE;
  }

  reset(): void {
    this.stage = ENV_IDLE;
    this.value = 0;
  }

  get active(): boolean {
    return this.stage !== ENV_IDLE;
  }

  next(): number {
    let v = this.value;
    switch (this.stage) {
      case ENV_ATTACK:
        v += this.attackInc;
        if (v >= 1) {
          v = 1;
          this.stage = this.sustain >= 1 ? ENV_SUSTAIN : ENV_DECAY;
        }
        break;
      case ENV_DECAY:
        v = this.sustain + (v - this.sustain) * this.decayCoef;
        if (Math.abs(v - this.sustain) < 1e-5) {
          v = this.sustain;
          this.stage = ENV_SUSTAIN;
        }
        break;
      case ENV_SUSTAIN:
        v = this.sustain;
        if (v <= 0) {
          this.stage = ENV_IDLE;
        }
        break;
      case ENV_RELEASE:
        v *= this.releaseCoef;
        if (v < 2.5e-4) {
          v = 0;
          this.stage = ENV_IDLE;
        }
        break;
      default:
        v = 0;
    }
    this.value = v;
    return v;
  }

  /**
   * Advance `n` samples and return the value at the START of that span (control-rate use, e.g.
   * filter envelopes). Exponential segments are stepped in closed form.
   */
  advance(n: number): number {
    const v0 = this.value;
    let v = v0;
    let left = n;
    while (left > 0) {
      const st = this.stage;
      if (st === ENV_ATTACK) {
        const need = Math.ceil((1 - v) / this.attackInc);
        if (need > left) {
          v += this.attackInc * left;
          left = 0;
        } else {
          v = 1;
          left -= need;
          this.stage = this.sustain >= 1 ? ENV_SUSTAIN : ENV_DECAY;
        }
      } else if (st === ENV_DECAY) {
        v = this.sustain + (v - this.sustain) * (left === 16 ? this.decay16 : Math.pow(this.decayCoef, left));
        if (Math.abs(v - this.sustain) < 1e-5) {
          v = this.sustain;
          this.stage = this.sustain > 0 ? ENV_SUSTAIN : ENV_IDLE;
        }
        left = 0;
      } else if (st === ENV_RELEASE) {
        v *= left === 16 ? this.release16 : Math.pow(this.releaseCoef, left);
        if (v < 2.5e-4) {
          v = 0;
          this.stage = ENV_IDLE;
        }
        left = 0;
      } else {
        if (st === ENV_SUSTAIN) v = this.sustain;
        else v = 0;
        left = 0;
      }
    }
    this.value = v;
    return v0;
  }

  /** Fill out[start..end) with envelope values. Returns false if the envelope ended (idle). */
  process(out: Float64Array, start: number, end: number): boolean {
    let v = this.value;
    let stage = this.stage;
    const ai = this.attackInc,
      dc = this.decayCoef,
      s = this.sustain,
      rc = this.releaseCoef;
    for (let i = start; i < end; i++) {
      if (stage === ENV_ATTACK) {
        v += ai;
        if (v >= 1) {
          v = 1;
          stage = s >= 1 ? ENV_SUSTAIN : ENV_DECAY;
        }
      } else if (stage === ENV_DECAY) {
        v = s + (v - s) * dc;
        if (v - s < 1e-5 && v - s > -1e-5) {
          v = s;
          stage = s > 0 ? ENV_SUSTAIN : ENV_IDLE;
          if (s <= 0) v = 0;
        }
      } else if (stage === ENV_RELEASE) {
        v *= rc;
        if (v < 2.5e-4) {
          v = 0;
          stage = ENV_IDLE;
        }
      } else if (stage === ENV_SUSTAIN) {
        v = s;
      } else {
        v = 0;
      }
      out[i] = v;
    }
    this.value = v;
    this.stage = stage;
    return stage !== ENV_IDLE;
  }
}

/** Linear smoother evaluated per block: returns per-sample ramp start/step. */
export class BlockSmoother {
  current = 0;
  target = 0;
  private coef = 0;

  constructor(value = 0) {
    this.current = value;
    this.target = value;
  }

  /** Time constant in seconds at `blocksPerSecond` updates. */
  setTime(seconds: number, blocksPerSecond: number): void {
    this.coef = seconds > 0 ? Math.exp(-1 / (seconds * blocksPerSecond)) : 0;
  }

  snap(v: number): void {
    this.current = this.target = v;
  }

  /** Advance one block; returns the new value (ramp from previous `current` to this). */
  step(): number {
    const d = this.target - this.current;
    if (Math.abs(d) < 1e-9 * (1 + Math.abs(this.target))) this.current = this.target;
    else this.current = this.target - d * this.coef;
    return this.current;
  }

  get settled(): boolean {
    return this.current === this.target;
  }
}
