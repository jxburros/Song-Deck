/**
 * Sample instruments (user soundfonts / sample libraries, spec §28) and the sampler voice.
 * Zones follow SFZ semantics: key/velocity ranges, pitch_keycenter, tune/transpose, loop modes,
 * AHDSR amp envelope, velocity tracking, volume/pan, choke groups (group/off_by), release
 * triggers, round robin (seq_length/seq_position) and random layers (lorand/hirand).
 */
import type { AudioData } from '../types';
import { clampNum, hermite } from './utils';
import { type NoteEvent, Voice, type VoiceHost, panGains } from './voices/types';

export type SampleLoopMode = 'no_loop' | 'one_shot' | 'loop_continuous' | 'loop_sustain';

export interface SampleZone {
  sample: AudioData;
  lokey: number;
  hikey: number;
  pitchKeycenter: number;
  lovel: number;
  hivel: number;
  loopMode?: SampleLoopMode;
  /** Loop start/end in sample frames (end inclusive, as in SFZ). */
  loopStart?: number;
  loopEnd?: number;
  /** Playback start offset / end (frames). */
  offset?: number;
  end?: number;
  /** Envelope in seconds; sustain in percent (SFZ convention). */
  ampegAttack?: number;
  ampegHold?: number;
  ampegDecay?: number;
  ampegSustain?: number;
  ampegRelease?: number;
  /** dB */
  volume?: number;
  /** cents */
  tune?: number;
  /** semitones */
  transpose?: number;
  /** -100..100 */
  pan?: number;
  /** cents per key (default 100) */
  pitchKeytrack?: number;
  /** percent (default 100) */
  ampVeltrack?: number;
  group?: number;
  offBy?: number;
  trigger?: 'attack' | 'release';
  seqLength?: number;
  seqPosition?: number;
  lorand?: number;
  hirand?: number;
}

export interface SampleInstrument {
  name?: string;
  zones: SampleZone[];
  /** Max simultaneous voices (default 32). */
  polyphony?: number;
}

/** Per-instrument mutable playback state (round-robin counters). */
export class ZoneMatcher {
  private readonly counters: Int32Array;
  constructor(private readonly inst: SampleInstrument) {
    this.counters = new Int32Array(inst.zones.length);
  }
  reset(): void {
    this.counters.fill(0);
  }
  /** Collect matching zone indices into `out` (returns count). */
  match(pitch: number, velocity: number, rand: number, trigger: 'attack' | 'release', out: Int32Array): number {
    const zones = this.inst.zones;
    const key = Math.round(pitch);
    const vel = Math.round(clampNum(velocity, 1, 127));
    let n = 0;
    for (let i = 0; i < zones.length && n < out.length; i++) {
      const z = zones[i];
      if ((z.trigger ?? 'attack') !== trigger) continue;
      if (key < z.lokey || key > z.hikey || vel < z.lovel || vel > z.hivel) continue;
      if (z.lorand !== undefined || z.hirand !== undefined) {
        if (rand < (z.lorand ?? 0) || rand >= (z.hirand ?? 1)) continue;
      }
      if (z.seqLength && z.seqLength > 1) {
        const c = this.counters[i]++;
        if ((c % z.seqLength) + 1 !== (z.seqPosition ?? 1)) continue;
      }
      out[n++] = i;
    }
    return n;
  }
}

const ST_ATTACK = 1, ST_HOLD = 2, ST_DECAY = 3, ST_SUSTAIN = 4, ST_RELEASE = 5, ST_IDLE = 0;

export class SamplerVoice extends Voice {
  zone: SampleZone | null = null;
  zoneIndex = -1;
  private pos = 0;
  private rate = 1;
  private ch0: Float32Array = new Float32Array(0);
  private ch1: Float32Array | null = null;
  private len = 0;
  private endPos = 0;
  private loopMode: SampleLoopMode = 'no_loop';
  private ls = 0;
  private le = 0;
  private gain = 1;
  private readonly pg = new Float64Array(2);
  // envelope
  private st = ST_IDLE;
  private ev = 0;
  private aInc = 1;
  private holdLeft = 0;
  private dCoef = 0;
  private sus = 1;
  private rCoef = 0;
  private killCoef = 0;
  private readonly sr: number;
  /** Optional one-pole lowpass (velocity brightness for generated instruments). */
  lowpassHz = 0;
  private lpA = 1;
  private lpL = 0;
  private lpR = 0;

  constructor(host: VoiceHost) {
    super(host);
    this.sr = host.sampleRate;
    this.killCoef = Math.exp(-6.9 / (0.006 * this.sr));
  }

  start(ev: NoteEvent): void {
    this.begin(ev);
  }

  startZone(ev: NoteEvent, zone: SampleZone, zoneIndex: number, extraPan = 0): void {
    this.begin(ev);
    this.zone = zone;
    this.zoneIndex = zoneIndex;
    const s = zone.sample;
    this.ch0 = s.channels[0];
    this.ch1 = s.channels.length > 1 ? s.channels[1] : null;
    this.len = this.ch0.length;
    const semis = ((ev.pitch - zone.pitchKeycenter) * (zone.pitchKeytrack ?? 100)) / 100 + (zone.transpose ?? 0) + (zone.tune ?? 0) / 100;
    this.rate = Math.pow(2, semis / 12) * (s.sampleRate / this.sr);
    this.pos = clampNum(zone.offset ?? 0, 0, Math.max(0, this.len - 1));
    this.endPos = Math.min(this.len, zone.end !== undefined ? zone.end + 1 : this.len);
    this.loopMode = zone.loopMode ?? (zone.loopStart !== undefined && zone.loopEnd !== undefined ? 'loop_continuous' : 'no_loop');
    this.ls = clampNum(zone.loopStart ?? 0, 0, this.len - 1);
    this.le = clampNum(zone.loopEnd ?? this.len - 1, this.ls, this.len - 1);
    if ((this.loopMode === 'loop_continuous' || this.loopMode === 'loop_sustain') && this.le - this.ls < 2) this.loopMode = 'no_loop';
    const vt = (zone.ampVeltrack ?? 100) / 100;
    const v = clampNum(ev.velocity / 127, 0, 1);
    this.gain = (1 - vt * (1 - v * v)) * Math.pow(10, (zone.volume ?? 0) / 20);
    panGains(clampNum((zone.pan ?? 0) / 100 + extraPan, -1, 1), this.pg);
    const sr = this.sr;
    this.aInc = 1 / Math.max(1, Math.max(0.0015, zone.ampegAttack ?? 0.0015) * sr);
    this.holdLeft = Math.round((zone.ampegHold ?? 0) * sr);
    this.sus = clampNum((zone.ampegSustain ?? 100) / 100, 0, 1);
    this.dCoef = Math.exp(-6.9 / (Math.max(0.002, zone.ampegDecay ?? 0) * sr));
    this.rCoef = Math.exp(-6.9 / (Math.max(0.006, zone.ampegRelease ?? 0.03) * sr));
    this.st = ST_ATTACK;
    this.ev = 0;
    this.lpA = this.lowpassHz > 0 ? 1 - Math.exp((-2 * Math.PI * Math.min(this.lowpassHz, sr * 0.45)) / sr) : 1;
    this.lpL = this.lpR = 0;
  }

  release(): void {
    this.released = true;
    if (this.loopMode === 'one_shot') return;
    if (this.st !== ST_IDLE) this.st = ST_RELEASE;
  }

  kill(): void {
    this.killed = true;
    if (this.st !== ST_IDLE) {
      this.st = ST_RELEASE;
      this.rCoef = this.killCoef;
    }
  }

  level(): number {
    return this.ev * this.gain;
  }

  override reset(): void {
    super.reset();
    this.st = ST_IDLE;
    this.zone = null;
  }

  render(L: Float64Array, R: Float64Array, start: number, end: number): void {
    // ---- envelope pass (AHDSR) into scratch ----
    const env = this.host.scratch;
    let st = this.st, e = this.ev;
    let last = end;
    for (let i = start; i < end; i++) {
      if (st === ST_SUSTAIN) {
        e = this.sus;
      } else if (st === ST_ATTACK) {
        e += this.aInc;
        if (e >= 1) {
          e = 1;
          st = this.holdLeft > 0 ? ST_HOLD : ST_DECAY;
        }
      } else if (st === ST_HOLD) {
        if (--this.holdLeft <= 0) st = ST_DECAY;
      } else if (st === ST_DECAY) {
        e = this.sus + (e - this.sus) * this.dCoef;
        if (Math.abs(e - this.sus) < 1e-5) {
          e = this.sus;
          st = ST_SUSTAIN;
        }
      } else if (st === ST_RELEASE) {
        e *= this.rCoef;
        if (e < 2.5e-4) {
          e = 0;
          st = ST_IDLE;
        }
      } else {
        last = i;
        break;
      }
      env[i] = e;
    }
    this.st = st;
    this.ev = e;
    // ---- sample pass ----
    const c0 = this.ch0, c1 = this.ch1;
    const len = this.len;
    let pos = this.pos;
    const rate = this.rate;
    const looping = this.loopMode === 'loop_continuous' || (this.loopMode === 'loop_sustain' && !this.released);
    const ls = this.ls, le = this.le, loopLen = le - ls + 1;
    const endPos = this.endPos;
    const g = this.gain;
    const gl = this.pg[0] * g, gr = this.pg[1] * g;
    const lpA = this.lpA;
    let lpL = this.lpL, lpR = this.lpR;
    const n = last - start;
    const fast = !looping && lpA >= 1 && pos >= 1 && pos + rate * n + 3 < Math.min(len, endPos);
    if (fast && !c1) {
      for (let i = start; i < last; i++) {
        const ip = pos | 0;
        const f = pos - ip;
        const xm1 = c0[ip - 1], x0 = c0[ip], x1 = c0[ip + 1], x2 = c0[ip + 2];
        const k1 = 0.5 * (x1 - xm1);
        const k2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
        const k3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        const a = (((k3 * f + k2) * f + k1) * f + x0) * env[i];
        L[i] += a * gl;
        R[i] += a * gr;
        pos += rate;
      }
    } else {
      for (let i = start; i < last; i++) {
        const ip = Math.floor(pos);
        if (!looping && ip >= endPos) {
          st = ST_IDLE;
          break;
        }
        const f = pos - ip;
        let xm1: number, x0: number, x1: number, x2: number;
        let ym1 = 0, y0 = 0, y1 = 0, y2 = 0;
        if (looping) {
          const i1 = ip + 1 > le ? ip + 1 - loopLen : ip + 1;
          const i2 = ip + 2 > le ? ip + 2 - loopLen : ip + 2;
          xm1 = ip >= 1 ? c0[ip - 1] : 0;
          x0 = c0[ip];
          x1 = c0[i1];
          x2 = c0[i2];
          if (c1) {
            ym1 = ip >= 1 ? c1[ip - 1] : 0;
            y0 = c1[ip];
            y1 = c1[i1];
            y2 = c1[i2];
          }
        } else {
          xm1 = ip >= 1 && ip - 1 < len ? c0[ip - 1] : 0;
          x0 = ip < len ? c0[ip] : 0;
          x1 = ip + 1 < len ? c0[ip + 1] : 0;
          x2 = ip + 2 < len ? c0[ip + 2] : 0;
          if (c1) {
            ym1 = ip >= 1 && ip - 1 < len ? c1[ip - 1] : 0;
            y0 = ip < len ? c1[ip] : 0;
            y1 = ip + 1 < len ? c1[ip + 1] : 0;
            y2 = ip + 2 < len ? c1[ip + 2] : 0;
          }
        }
        let a = hermite(xm1, x0, x1, x2, f);
        let b = c1 ? hermite(ym1, y0, y1, y2, f) : a;
        if (lpA < 1) {
          lpL += lpA * (a - lpL);
          lpR += lpA * (b - lpR);
          a = lpL;
          b = lpR;
        }
        const amp = env[i];
        L[i] += a * amp * gl;
        R[i] += b * amp * gr;
        pos += rate;
        if (looping && pos >= le + 1) pos -= loopLen;
      }
    }
    this.pos = pos;
    this.st = st;
    this.lpL = lpL;
    this.lpR = lpR;
    if (st === ST_IDLE) this.active = false;
  }
}
