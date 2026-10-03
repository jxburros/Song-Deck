/**
 * Extended Karplus–Strong plucked string (Jaffe–Smith): fractional-delay (Hermite) string loop with
 * a one-zero brightness filter, optional one-pole damping (palm mute / dead notes), exact tuning
 * (loop filters' phase delay at f0 is compensated), T60-calibrated loop gain, shaped excitation
 * (noise / smooth pluck mix, velocity-dependent brightness, pick-position comb), finger damping on
 * release, hammer-on / slide / bend / vibrato pitch modulation, tremolo re-picking, harmonics.
 */
import { oneZeroPhaseDelay, onePolePhaseDelay } from '../filters';
import { NOISE_SCALE, clampNum, midiToHz, seedState, sin01, velocityGain, xorshift } from '../utils';
import {
  ART_ACCENT,
  ART_BEND,
  ART_DEAD,
  ART_HARMONIC,
  ART_PALM,
  ART_PIZZ,
  ART_SLIDE,
  ART_TREMOLO,
  type NoteEvent,
  Voice,
  type VoiceHost,
  panGains,
} from './types';

export interface PluckParams {
  engine: 'pluck';
  /** T60 (s) at 110 Hz. */
  decay: number;
  /** T60 ∝ (f0/110)^-decayExp. */
  decayExp: number;
  /** Excitation brightness 0..1 (at velocity ≈ 76). */
  brightness: number;
  /** Velocity → brightness amount. */
  velBright: number;
  /** Loop HF damping 0..1 (one-zero coefficient scale). */
  damping: number;
  /** Pick position 0.02..0.5 (fraction of the string). */
  pickPos: number;
  /** T60 after note-off (finger damping), s. */
  release: number;
  /** T60 for palm-muted notes, s. */
  palmDecay: number;
  /** Palm-mute damping filter cutoff as a multiple of f0. */
  palmCutoff: number;
  /** 0 = noise excitation … 1 = smooth (triangle) pluck. */
  smooth: number;
  /** Pick click noise level. */
  pickNoise?: number;
  vibrato?: { rate: number; cents: number; delay: number };
  gain?: number;
}

const CR = 16;

export class PluckVoice extends Voice {
  private readonly buf: Float64Array;
  private readonly exc: Float64Array;
  private readonly exc2: Float64Array;
  private readonly mask: number;
  private w = 0;
  private delay = 100;
  private s = 0.3; // one-zero coefficient
  private xPrev = 0;
  private dampA = 1; // one-pole damping coefficient (1 = off)
  private dz = 0;
  private g = 0.99;
  private f0 = 110;
  private tau = 0.5; // loop filter phase delay (samples) at f0
  private targetPitch = 60;
  private curPitch = 60;
  private glideRate = 0;
  private bendFrom = 0;
  private bendTime = 0;
  private t = 0;
  private velGain = 1;
  private outGain = 1;
  private killStep = 0;
  private peak = 0;
  private quiet = 0;
  private noise = 1;
  private clickLeft = 0;
  private clickLen = 1;
  private tremT = 0;
  private tremPeriod = 0;
  private art = 0;
  private bright = 0.5;
  private readonly pg = new Float64Array(2);
  private readonly sr: number;

  constructor(host: VoiceHost, private readonly p: PluckParams, private readonly stereo: boolean) {
    super(host);
    this.sr = host.sampleRate;
    let n = 1;
    while (n < this.sr / 18 + 16) n *= 2;
    this.buf = new Float64Array(n);
    this.exc = new Float64Array(n);
    this.exc2 = new Float64Array(n);
    this.mask = n - 1;
  }

  private t60For(f0: number): number {
    const p = this.p;
    let t60 = p.decay * Math.pow(f0 / 110, -p.decayExp);
    if (this.art & ART_PALM) t60 = p.palmDecay;
    if (this.art & ART_DEAD) t60 = 0.035;
    if (this.art & ART_PIZZ) t60 = Math.min(t60, 0.6);
    if (this.art & ART_HARMONIC) t60 *= 1.4;
    return Math.max(0.02, t60);
  }

  /** Configure loop filters and gain for f0 (note start). */
  private setupLoop(f0: number): void {
    const sr = this.sr;
    const p = this.p;
    const w0 = (2 * Math.PI * f0) / sr;
    let s = clampNum(p.damping * 0.5 * Math.pow(f0 / 196, -0.35), 0.02, 0.5);
    if (this.art & ART_HARMONIC) s = 0.04;
    this.s = s;
    this.dampA = 1;
    if (this.art & (ART_PALM | ART_DEAD)) {
      const fc = Math.min(sr * 0.45, f0 * (this.art & ART_DEAD ? 2.5 : p.palmCutoff));
      this.dampA = 1 - Math.exp((-2 * Math.PI * fc) / sr);
    }
    this.tau = oneZeroPhaseDelay(s, w0) + (this.dampA < 1 ? onePolePhaseDelay(this.dampA, w0) : 0);
    this.setGain(this.t60For(f0), f0);
  }

  private setGain(t60: number, f0: number): void {
    const w0 = (2 * Math.PI * f0) / this.sr;
    // per-period loss for T60, compensated for the loop filters' attenuation at f0
    const perPeriod = Math.pow(10, -3 / (t60 * f0));
    const s = this.s;
    const h1 = Math.hypot(1 - s + s * Math.cos(w0), s * Math.sin(w0));
    let h2 = 1;
    if (this.dampA < 1) {
      const a = this.dampA;
      h2 = a / Math.hypot(1 - (1 - a) * Math.cos(w0), (1 - a) * Math.sin(w0));
    }
    this.g = Math.min(0.99995, perPeriod / Math.max(1e-6, h1 * h2));
  }

  private excite(f0: number, amount: number, add: boolean): void {
    const p = this.p;
    const buf = this.buf, mask = this.mask;
    const e = this.exc, c = this.exc2;
    const N = Math.max(4, Math.min(buf.length - 8, Math.round(this.sr / f0)));
    const harmonic = (this.art & ART_HARMONIC) !== 0;
    const smooth = clampNum(p.smooth, 0, 1);
    const apex = Math.max(1, Math.min(N - 1, Math.round(clampNum(p.pickPos, 0.02, 0.5) * N)));
    const fc = Math.min(this.sr * 0.45, 600 * Math.pow(2, this.bright * 5.2));
    const a = 1 - Math.exp((-2 * Math.PI * fc) / this.sr);
    let s = this.noise;
    let lp = 0;
    let mean = 0;
    for (let i = 0; i < N; i++) {
      let v: number;
      if (harmonic) v = Math.sin((2 * Math.PI * i) / N);
      else {
        s = xorshift(s);
        const tri = i < apex ? i / apex : (N - i) / (N - apex);
        v = smooth * (tri * 2 - 1) + (1 - smooth) * s * NOISE_SCALE;
        lp += a * (v - lp);
        v = lp;
      }
      e[i] = v;
      mean += v;
    }
    this.noise = s;
    mean /= N;
    const M = harmonic ? 0 : apex;
    let pk = 0;
    for (let i = 0; i < N; i++) {
      const v = e[i] - mean - (M > 0 ? (e[(i - M + N) % N] - mean) * 0.9 : 0);
      c[i] = v;
      const av = v < 0 ? -v : v;
      if (av > pk) pk = av;
    }
    const norm = pk > 0 ? amount / pk : 0;
    const base = this.w - N;
    for (let i = 0; i < N; i++) {
      const idx = (base + i) & mask;
      buf[idx] = add ? buf[idx] * 0.35 + c[i] * norm : c[i] * norm;
    }
  }

  start(ev: NoteEvent): void {
    this.begin(ev);
    const p = this.p;
    this.art = ev.art;
    this.noise = seedState(ev.seed);
    const vel = clampNum(ev.velocity / 127, 0, 1);
    this.bright = clampNum(p.brightness + p.velBright * (vel - 0.6) + (ev.art & ART_ACCENT ? 0.12 : 0), 0, 1);
    if (ev.art & (ART_DEAD | ART_PALM)) this.bright *= 0.75;
    this.velGain = velocityGain(ev.velocity, 0.85) * (p.gain ?? 1);
    this.outGain = 1;
    this.killStep = 0;
    this.t = 0;
    this.peak = 0;
    this.quiet = 0;
    this.xPrev = 0;
    this.dz = 0;
    this.buf.fill(0);
    this.w = 0;
    this.targetPitch = ev.pitch;
    this.curPitch = ev.art & ART_SLIDE ? (ev.fromPitch >= 0 ? ev.fromPitch : ev.pitch - 2) : ev.pitch;
    this.glideRate = ev.art & ART_SLIDE ? Math.exp(-CR / (0.035 * this.sr)) : 0;
    this.bendFrom = 0;
    this.bendTime = 0;
    if (ev.art & ART_BEND) {
      this.bendFrom = -2;
      this.bendTime = Math.min(0.3, Math.max(0.05, ((ev.end - ev.start) / this.sr) * 0.3));
    }
    this.f0 = midiToHz(ev.pitch);
    this.setupLoop(this.f0);
    const startF = midiToHz(this.curPitch + this.bendFrom);
    this.w = this.buf.length >> 1;
    this.excite(startF, 1, false);
    this.delay = Math.max(3, this.sr / startF - this.tau);
    this.clickLen = Math.max(1, Math.round(0.002 * this.sr));
    this.clickLeft = p.pickNoise ? this.clickLen : 0;
    this.tremPeriod = ev.art & ART_TREMOLO ? (60 / Math.max(30, ev.bpm)) / 8 : 0;
    this.tremT = 0;
    panGains(this.stereo ? ev.pan : 0, this.pg);
  }

  override glideTo(ev: NoteEvent): boolean {
    // hammer-on / pull-off / legato slide: keep the string ringing, retune
    this.note = ev;
    this.pitch = ev.pitch;
    this.startFrame = ev.start;
    this.endFrame = ev.end;
    this.released = false;
    this.targetPitch = ev.pitch;
    this.glideRate = Math.exp(-CR / ((ev.art & ART_SLIDE ? 0.05 : 0.008) * this.sr));
    this.t = 0;
    this.setGain(this.t60For(midiToHz(ev.pitch)), midiToHz(ev.pitch));
    if (!(ev.art & ART_SLIDE)) this.excite(midiToHz(ev.pitch), 0.25, true);
    return true;
  }

  release(): void {
    this.released = true;
    this.setGain(Math.min(this.t60For(this.f0), this.p.release), this.f0);
  }

  kill(): void {
    this.killed = true;
    this.killStep = 1 / Math.max(1, 0.006 * this.sr);
  }

  level(): number {
    return this.peak * this.outGain;
  }

  render(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const buf = this.buf, mask = this.mask;
    const size = mask + 1;
    const sr = this.sr;
    const p = this.p;
    let w = this.w;
    let xPrev = this.xPrev;
    let dz = this.dz;
    const s1 = 1 - this.s, s2 = this.s;
    const da = this.dampA;
    const g = this.g;
    const vg = this.velGain;
    const gl = this.stereo ? this.pg[0] : 1;
    const gr = this.pg[1];
    let peak = 0;
    let og = this.outGain;
    const ks = this.killStep;
    for (let i = start; i < end; ) {
      const segEnd = Math.min(end, i + CR);
      // control: pitch
      if (this.glideRate > 0) this.curPitch = this.targetPitch + (this.curPitch - this.targetPitch) * this.glideRate;
      else this.curPitch = this.targetPitch;
      let pitch = this.curPitch;
      if (this.bendTime > 0 && this.t < this.bendTime) {
        const x = this.t / this.bendTime;
        pitch += this.bendFrom * (1 - x * x * (3 - 2 * x));
      }
      if (p.vibrato && this.t > p.vibrato.delay) {
        const amt = Math.min(1, (this.t - p.vibrato.delay) / 0.3);
        pitch += (p.vibrato.cents / 100) * amt * sin01((this.t - p.vibrato.delay) * p.vibrato.rate);
      }
      const target = Math.max(3, sr / midiToHz(pitch) - this.tau);
      const dStep = (target - this.delay) / (segEnd - i);
      if (this.tremPeriod > 0 && !this.released) {
        this.tremT += (segEnd - i) / sr;
        if (this.tremT >= this.tremPeriod) {
          this.tremT -= this.tremPeriod;
          this.w = w;
          this.excite(midiToHz(pitch), 0.8, true);
        }
      }
      let d = this.delay;
      for (let j = i; j < segEnd; j++) {
        d += dStep;
        const pos = w - d + size;
        const ip = pos | 0;
        const f = pos - ip;
        const x0 = buf[ip & mask];
        const x = x0 + f * (buf[(ip + 1) & mask] - x0);
        let y = s1 * x + s2 * xPrev;
        xPrev = x;
        if (da < 1) {
          dz += da * (y - dz);
          y = dz;
        }
        y *= g;
        buf[w] = y;
        w = (w + 1) & mask;
        let out = y;
        if (this.clickLeft > 0) {
          this.noise = xorshift(this.noise);
          out += this.noise * NOISE_SCALE * (p.pickNoise ?? 0) * (this.clickLeft / this.clickLen);
          this.clickLeft--;
        }
        out *= vg * og;
        if (ks > 0) {
          og -= ks;
          if (og < 0) og = 0;
        }
        if (this.stereo) {
          L[j] += out * gl;
          R[j] += out * gr;
        } else L[j] += out;
        const a = out < 0 ? -out : out;
        if (a > peak) peak = a;
      }
      this.delay = d;
      this.t += (segEnd - i) / sr;
      i = segEnd;
    }
    this.w = w;
    this.xPrev = xPrev;
    this.dz = Math.abs(dz) < 1e-25 ? 0 : dz;
    this.outGain = og;
    this.peak = peak;
    if (peak < 3e-5) this.quiet += end - start;
    else this.quiet = 0;
    if ((this.killed && og <= 0) || (this.quiet > 0.05 * sr && this.t > 0.05)) this.active = false;
  }
}
