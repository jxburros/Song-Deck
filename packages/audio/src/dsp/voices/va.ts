/**
 * Subtractive ("virtual analog") voice: up to 3 band-limited oscillators (polyBLEP saw / square /
 * pulse, integrated-square triangle, sine) with unison detune, sub oscillator, band-passed breath /
 * bow noise, TPT state-variable filter (12 or 24 dB) with envelope / key / velocity / LFO
 * modulation, ADSR amp, delayed vibrato, glide, scoop and articulation handling.
 * Used for strings, brass, pads, leads, synth bass, plucks, flute and reeds.
 */
import { Adsr, ENV_IDLE, ENV_RELEASE, ENV_SUSTAIN } from '../envelopes';
import { Svf } from '../filters';
import { polyBlep } from '../oscillators';
import { NOISE_SCALE, clampNum, midiToHz, seedState, sin01, velocityGain, xorshift } from '../utils';
import {
  ART_ACCENT,
  ART_BEND,
  ART_DEAD,
  ART_HARMONIC,
  ART_PALM,
  ART_SLIDE,
  ART_STACCATO,
  ART_TREMOLO,
  type NoteEvent,
  Voice,
  type VoiceHost,
  panGains,
} from './types';

export type VaWave = 'saw' | 'square' | 'pulse' | 'tri' | 'sine';

export interface VaParams {
  engine: 'va';
  oscs: { wave: VaWave; level: number; semi?: number; cents?: number; pw?: number }[];
  unison?: number;
  /** Total unison detune spread (cents). */
  detune?: number;
  /** Sine sub-oscillator one octave down. */
  sub?: number;
  /** Band-passed noise level (breath / bow), centred at f0 × noiseMul. */
  noise?: number;
  noiseMul?: number;
  noiseQ?: number;
  /** Extra noise burst at the attack (chiff / bow scrape), seconds. */
  chiff?: number;
  filter: {
    type: 'lp12' | 'lp24' | 'bp';
    cutoff: number;
    reso: number;
    keytrack: number;
    envOct: number;
    velOct: number;
    a: number;
    d: number;
    s: number;
    r: number;
  };
  amp: { a: number; d: number; s: number; r: number };
  velSens: number;
  vibrato?: { rate: number; cents: number; delay: number; fade: number };
  filterLfo?: { rate: number; oct: number };
  pwm?: { rate: number; depth: number };
  /** Legato glide time (s). */
  glide?: number;
  /** Attack pitch scoop (semitones, negative = from below) and time (s). */
  scoop?: { semis: number; time: number };
  /** Random slow pitch drift (cents). */
  drift?: number;
  /** Output gain. */
  gain?: number;
}

const CR = 16; // control rate (samples)
const MAX_OSC = 3;
const MAX_UNI = 7;

export class VaVoice extends Voice {
  private readonly amp = new Adsr();
  private readonly fenv = new Adsr();
  private readonly f1 = new Svf();
  private readonly f2 = new Svf();
  private readonly nf = new Svf();
  private readonly phases = new Float64Array(MAX_OSC * MAX_UNI);
  private readonly tri = new Float64Array(MAX_OSC * MAX_UNI);
  private readonly incs = new Float64Array(MAX_OSC * MAX_UNI);
  private readonly ratio = new Float64Array(MAX_OSC * MAX_UNI);
  private readonly lvl = new Float64Array(MAX_OSC);
  private readonly waveCode = new Int32Array(MAX_OSC);
  private readonly pw = new Float64Array(MAX_OSC);
  private subPhase = 0;
  private nOsc = 1;
  private nUni = 1;
  private noise = 0;
  private velGain = 1;
  private vel01 = 0.8;
  private curPitch = 60;
  private targetPitch = 60;
  private glideCoef = 0;
  private t = 0; // seconds since note start
  private art = 0;
  private bendFrom = 0;
  private bendTime = 0;
  private noiseState = 1;
  private driftState = 0;
  private driftTarget = 0;
  private driftTimer = 0;
  private readonly buf = new Float64Array(64);
  private cutKey = NaN;
  private cutEnv = NaN;
  private trem = 0;
  private chiffLeft = 0;
  private readonly pg = new Float64Array(2);
  private peak = 0;
  private readonly sr: number;

  constructor(host: VoiceHost, private readonly p: VaParams, private readonly stereo: boolean) {
    super(host);
    this.sr = host.sampleRate;
    const oscs = p.oscs.slice(0, MAX_OSC);
    this.nOsc = oscs.length;
    this.nUni = Math.max(1, Math.min(MAX_UNI, Math.round(p.unison ?? 1)));
    const uniNorm = 1 / Math.sqrt(this.nUni);
    oscs.forEach((o, i) => {
      this.lvl[i] = o.level * uniNorm;
      this.waveCode[i] = o.wave === 'saw' ? 0 : o.wave === 'square' ? 1 : o.wave === 'pulse' ? 2 : o.wave === 'tri' ? 3 : 4;
      this.pw[i] = o.pw ?? 0.5;
      for (let u = 0; u < this.nUni; u++) {
        const spread = this.nUni > 1 ? (u / (this.nUni - 1) - 0.5) * (p.detune ?? 0) : 0;
        this.ratio[i * MAX_UNI + u] = Math.pow(2, ((o.semi ?? 0) * 100 + (o.cents ?? 0) + spread) / 1200);
      }
    });
    this.noise = p.noise ?? 0;
    this.amp.set(p.amp.a, p.amp.d, p.amp.s, p.amp.r, this.sr);
    this.fenv.set(p.filter.a, p.filter.d, p.filter.s, p.filter.r, this.sr);
    this.glideCoef = p.glide ? Math.exp(-CR / (Math.max(0.005, p.glide / 3) * this.sr)) : 0;
  }

  start(ev: NoteEvent): void {
    this.begin(ev);
    const p = this.p;
    this.art = ev.art;
    this.vel01 = clampNum(ev.velocity / 127, 0, 1);
    this.velGain = velocityGain(ev.velocity, p.velSens) * (p.gain ?? 1);
    this.t = 0;
    let s = seedState(ev.seed);
    for (let k = 0; k < this.phases.length; k++) {
      s = xorshift(s);
      this.phases[k] = (s >>> 0) / 4294967296;
      this.tri[k] = 0;
    }
    this.subPhase = 0;
    this.noiseState = xorshift(s) || 1;
    this.driftState = 0;
    this.driftTarget = 0;
    this.driftTimer = 0;
    this.targetPitch = ev.pitch;
    this.curPitch = ev.pitch;
    if (ev.art & ART_SLIDE) this.curPitch = ev.fromPitch >= 0 ? ev.fromPitch : ev.pitch - 2;
    this.bendFrom = 0;
    this.bendTime = 0;
    if (ev.art & ART_BEND) {
      this.bendFrom = -2;
      this.bendTime = Math.min(0.25, Math.max(0.04, ((ev.end - ev.start) / this.sr) * 0.3));
    }
    this.chiffLeft = (p.chiff ?? 0) * this.sr;
    this.amp.retrigger();
    this.fenv.retrigger();
    this.cutKey = NaN;
    this.f1.reset();
    this.f2.reset();
    this.nf.reset();
    this.trem = 0;
    this.peak = 0;
    panGains(this.stereo ? ev.pan : 0, this.pg);
  }

  override glideTo(ev: NoteEvent): boolean {
    // portamento without re-attack
    this.note = ev;
    this.pitch = ev.pitch;
    this.startFrame = ev.start;
    this.endFrame = ev.end;
    this.targetPitch = ev.pitch;
    this.art = ev.art;
    this.released = false;
    this.vel01 = clampNum(ev.velocity / 127, 0, 1);
    this.velGain = velocityGain(ev.velocity, this.p.velSens) * (this.p.gain ?? 1);
    if (!this.p.glide) this.curPitch = ev.pitch;
    if (this.amp.stage === ENV_RELEASE || this.amp.stage === ENV_IDLE) this.amp.trigger();
    return true;
  }

  /** Same pitch struck again while sounding/releasing: re-attack from the current level (no click). */
  override retrigger(ev: NoteEvent): boolean {
    this.note = ev;
    this.pitch = ev.pitch;
    this.startFrame = ev.start;
    this.endFrame = ev.end;
    this.released = false;
    this.art = ev.art;
    this.vel01 = clampNum(ev.velocity / 127, 0, 1);
    this.velGain = velocityGain(ev.velocity, this.p.velSens) * (this.p.gain ?? 1);
    this.targetPitch = ev.pitch;
    this.curPitch = ev.pitch;
    this.t = 0;
    this.amp.trigger();
    this.fenv.trigger();
    return true;
  }

  release(): void {
    this.released = true;
    this.amp.release();
    this.fenv.release();
  }

  kill(): void {
    this.killed = true;
    this.amp.kill();
  }

  level(): number {
    return this.amp.value * this.velGain;
  }

  render(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const p = this.p;
    const sr = this.sr;
    const env = this.host.scratch;
    const buf = this.buf;
    const n = end - start;
    if (n <= 0) return;
    const alive = this.amp.process(env, start, end);
    // ---- block-rate pitch ----
    if (this.glideCoef > 0) this.curPitch = this.targetPitch + (this.curPitch - this.targetPitch) * Math.pow(this.glideCoef, n / CR);
    else if (this.art & ART_SLIDE) this.curPitch = this.targetPitch + (this.curPitch - this.targetPitch) * Math.exp(-n / (0.03 * sr));
    else this.curPitch = this.targetPitch;
    let pitch = this.curPitch;
    if (this.bendTime > 0 && this.t < this.bendTime) pitch += this.bendFrom * (1 - this.t / this.bendTime);
    if (p.scoop && !(this.art & ART_STACCATO)) pitch += p.scoop.semis * Math.exp(-this.t / Math.max(0.005, p.scoop.time));
    if (p.vibrato) {
      const v = p.vibrato;
      const amt = clampNum((this.t - v.delay) / Math.max(0.01, v.fade), 0, 1);
      if (amt > 0) pitch += (v.cents / 100) * amt * sin01(this.t * v.rate);
    }
    let ns = this.noiseState;
    if (p.drift) {
      this.driftTimer -= n;
      if (this.driftTimer <= 0) {
        ns = xorshift(ns);
        this.driftTarget = ns * NOISE_SCALE * p.drift;
        this.driftTimer = 0.25 * sr;
      }
      this.driftState += (this.driftTarget - this.driftState) * 0.04;
      pitch += this.driftState / 100;
    }
    const f0 = midiToHz(pitch);
    const dt0 = f0 / sr;
    // ---- oscillators (one tight loop per oscillator) ----
    for (let j = start; j < end; j++) buf[j] = 0;
    const nOsc = this.nOsc, nUni = this.nUni;
    const phases = this.phases, tri = this.tri, ratio = this.ratio;
    let pwmOff = 0;
    if (p.pwm) pwmOff = p.pwm.depth * sin01(this.t * p.pwm.rate);
    for (let o = 0; o < nOsc; o++) {
      const wc = this.waveCode[o];
      const lv = this.lvl[o];
      const pwv = wc === 1 ? 0.5 : clampNum(this.pw[o] + pwmOff, 0.05, 0.95);
      for (let u = 0; u < nUni; u++) {
        const k = o * MAX_UNI + u;
        const dt = Math.min(0.45, dt0 * ratio[k]);
        let ph = phases[k];
        if (wc === 0) {
          const hi = 1 - dt;
          const idt = 1 / dt;
          const lv2 = 2 * lv;
          for (let j = start; j < end; j++) {
            ph += dt;
            if (ph >= 1) ph -= 1;
            let v = lv2 * ph - lv;
            if (ph < dt) {
              const x = ph * idt;
              v -= (x + x - x * x - 1) * lv;
            } else if (ph > hi) {
              const x = (ph - 1) * idt;
              v -= (x * x + x + x + 1) * lv;
            }
            buf[j] += v;
          }
        } else if (wc === 4) {
          for (let j = start; j < end; j++) {
            ph += dt;
            if (ph >= 1) ph -= 1;
            buf[j] += sin01(ph) * lv;
          }
        } else {
          let tv = tri[k];
          for (let j = start; j < end; j++) {
            ph += dt;
            if (ph >= 1) ph -= 1;
            let v = ph < pwv ? 1 : -1;
            v += polyBlep(ph, dt);
            let t2 = ph - pwv;
            if (t2 < 0) t2 += 1;
            v -= polyBlep(t2, dt);
            if (wc === 3) {
              tv = tv * 0.9995 + 4 * dt * v;
              buf[j] += tv * lv;
            } else buf[j] += v * lv;
          }
          tri[k] = tv;
        }
        phases[k] = ph;
      }
    }
    const subLvl = p.sub ?? 0;
    if (subLvl > 0) {
      let sp = this.subPhase;
      const si = dt0 * 0.5;
      for (let j = start; j < end; j++) {
        sp += si;
        if (sp >= 1) sp -= 1;
        buf[j] += subLvl * sin01(sp);
      }
      this.subPhase = sp;
    }
    if (this.noise > 0) {
      const nf = this.nf;
      nf.set(clampNum(f0 * (p.noiseMul ?? 1), 100, sr * 0.45), p.noiseQ ?? 2, sr);
      const nl = this.noise;
      const chiffLen = (p.chiff ?? 0.01) * sr;
      for (let j = start; j < end; j++) {
        ns = xorshift(ns);
        let nz = ns * NOISE_SCALE;
        if (this.chiffLeft > 0) {
          nz *= 1 + 4 * (this.chiffLeft / chiffLen);
          this.chiffLeft--;
        }
        buf[j] += nf.bp(nz) * nl;
      }
    }
    this.noiseState = ns;
    // ---- filter (coefficients every CR samples) + amp ----
    const filt = p.filter;
    const fType = filt.type === 'lp24' ? 2 : filt.type === 'bp' ? 3 : 1;
    const q = 0.5 + clampNum(filt.reso, 0, 1) * 11.5;
    const dark = this.art & (ART_PALM | ART_DEAD) ? 0.45 : this.art & ART_HARMONIC ? 0.6 : 1;
    const accentBoost = this.art & ART_ACCENT ? 1.35 : 1;
    const keyMul = Math.pow(2, (filt.keytrack * (pitch - 60)) / 12 + filt.velOct * (this.vel01 - 0.6));
    let lfoMul = 1;
    if (p.filterLfo) lfoMul = Math.pow(2, p.filterLfo.oct * sin01(this.t * p.filterLfo.rate));
    const baseCut = filt.cutoff * keyMul * lfoMul * dark;
    const tremRate = this.art & ART_TREMOLO ? Math.min(16, ((this.note?.bpm ?? 120) / 60) * 8) / sr : 0;
    const vg = this.velGain;
    const stereo = this.stereo;
    const gl = stereo ? this.pg[0] : 1, gr = this.pg[1];
    const f1 = this.f1, f2 = this.f2;
    let peak = 0;
    let ic1 = f1.ic1, ic2 = f1.ic2, jc1 = f2.ic1, jc2 = f2.ic2;
    let trem = this.trem;
    // filter: coefficients every CR samples from the (control-rate) filter envelope
    // static filter envelope (sustain) and no LFO → one coefficient set for the whole block
    const staticEnv = (this.fenv.stage === ENV_SUSTAIN || this.fenv.stage === ENV_IDLE) && !p.filterLfo;
    const segLen = staticEnv ? end - start : CR;
    if (staticEnv && this.cutKey === baseCut && this.cutEnv === this.fenv.value) {
      // coefficients unchanged since the previous block
    } else if (staticEnv) {
      this.cutKey = baseCut;
      this.cutEnv = this.fenv.value;
      const cut = clampNum(baseCut * Math.pow(2, filt.envOct * accentBoost * this.fenv.value), 30, sr * 0.45);
      if (fType === 3) f1.set(cut, q, sr);
      else {
        f1.set(cut, fType === 2 ? Math.max(0.5, q * 0.7) : q, sr);
        if (fType === 2) f2.set(cut, 0.54, sr);
      }
    }
    for (let i = start; i < end; ) {
      const segEnd = Math.min(end, i + segLen);
      if (!staticEnv) {
      this.cutKey = NaN;
      const fev = this.fenv.advance(segEnd - i);
      const cut = clampNum(baseCut * Math.pow(2, filt.envOct * accentBoost * fev), 30, sr * 0.45);
      if (fType === 3) f1.set(cut, q, sr);
      else {
        f1.set(cut, fType === 2 ? Math.max(0.5, q * 0.7) : q, sr);
        if (fType === 2) f2.set(cut, 0.54, sr);
      }
      }
      const a1 = f1.a1, a2 = f1.a2, a3 = f1.a3;
      if (fType === 2) {
        const b1 = f2.a1, b2 = f2.a2, b3 = f2.a3;
        for (let j = i; j < segEnd; j++) {
          const v3 = buf[j] - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
          const w3 = v2 - jc2;
          const w1 = b1 * jc1 + b2 * w3;
          const w2 = jc2 + b2 * jc1 + b3 * w3;
          jc1 = 2 * w1 - jc1;
          jc2 = 2 * w2 - jc2;
          buf[j] = w2;
        }
      } else if (fType === 3) {
        for (let j = i; j < segEnd; j++) {
          const v3 = buf[j] - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
          buf[j] = v1;
        }
      } else {
        for (let j = i; j < segEnd; j++) {
          const v3 = buf[j] - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
          buf[j] = v2;
        }
      }
      i = segEnd;
    }
    // amp (+ tremolo) and output
    if (tremRate > 0) {
      for (let j = start; j < end; j++) {
        trem += tremRate;
        if (trem >= 1) trem -= 1;
        env[j] *= 0.55 + 0.45 * sin01(trem + 0.25);
      }
    }
    if (stereo) {
      const ggl = gl * vg, ggr = gr * vg;
      for (let j = start; j < end; j++) {
        const y = buf[j] * env[j];
        L[j] += y * ggl;
        R[j] += y * ggr;
        const a = y < 0 ? -y : y;
        if (a > peak) peak = a;
      }
    } else {
      for (let j = start; j < end; j++) {
        const y = buf[j] * env[j] * vg;
        L[j] += y;
        const a = y < 0 ? -y : y;
        if (a > peak) peak = a;
      }
    }
    f1.ic1 = ic1;
    f1.ic2 = ic2;
    f2.ic1 = jc1;
    f2.ic2 = jc2;
    this.trem = trem;
    this.t += n / sr;
    this.peak = peak;
    f1.flush();
    f2.flush();
    this.nf.flush();
    if (!alive) this.active = false;
  }
}
