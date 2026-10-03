/**
 * Track sources for the renderer:
 *  - PolyInstrument: preallocated voice pool for a patch (VA / pluck / piano / FM / organ / choir /
 *    modal / drums / sampler) with polyphony limits, voice stealing (quietest releasing voice, else
 *    oldest), mono legato / retrigger, same-pitch retrigger, hat/zone choke groups, chase on seek,
 *    articulation sub-instruments (pizzicato) and an instrument FX chain.
 *  - VocalInstrument: the formant singer driven by a phoneme/expression timeline.
 *  - ClipPlayer: audio clips (stems/recordings) with offset, gain, fades, on-the-fly resampling.
 * Event building converts Notes → frame-accurate NoteEvents (articulations, velocity, strums).
 */
import type { AudioClip, Song, Track } from '@songdeck/core';
import type { TimeMap } from '@songdeck/core';
import type { AssetResolver, AudioData } from '../types';
import { SincInterpolator } from './buffers';
import { type DrumPiece, DrumVoice, drumPiece } from './drums';
import { AmpSim } from './effects/amp';
import { AutoPan, Chorus, Rotary } from './effects/modulation';
import { Biquad, DcBlocker } from './filters';
import type { InstrumentFxSpec, PatchDefinition } from './patches';
import { type SampleInstrument, type SampleZone, SamplerVoice, ZoneMatcher } from './sampler';
import { VocalEngine, prepareVocal } from './singing/voice';
import { BLOCK, clampNum, combineSeed, dbToGain, hashString, num } from './utils';
import { ChoirVoice, FormantBank } from './voices/choir';
import { FmVoice } from './voices/fm';
import { ModalVoice } from './voices/modal';
import { OrganVoice } from './voices/organ';
import { type PianoParams, pianoZone } from './voices/piano';
import { PluckVoice } from './voices/pluck';
import {
  ART_ACCENT,
  ART_DEAD,
  ART_GHOST,
  ART_LEGATO,
  ART_MARCATO,
  ART_PALM,
  ART_PIZZ,
  ART_SLIDE,
  ART_STACCATO,
  type NoteEvent,
  type Voice,
  type VoiceHost,
  articulationFlag,
} from './voices/types';
import { VaVoice } from './voices/va';

export interface TrackSource {
  /** Render one block (L and R are cleared by the caller and fully written as stereo). */
  render(L: Float64Array, R: Float64Array, blockStart: number, n: number): void;
  /** True when the last rendered block was silent and internal tails have flushed. */
  readonly idle: boolean;
  /** Hard stop + reposition (seek): chase sustained notes that are sounding at `frame`. */
  seek(frame: number): void;
  /** Loop wrap: release sounding notes and continue from `frame`. */
  loopTo(frame: number): void;
}

// ---------------------------------------------------------------------------
// Event building
// ---------------------------------------------------------------------------

export interface EventBuildContext {
  timeMap: TimeMap;
  ppq: number;
  startSec: number;
  sampleRate: number;
  seed: number;
}

/** Notes → sorted NoteEvents for a patch. */
export function buildNoteEvents(track: Track, patch: PatchDefinition, ctx: EventBuildContext): NoteEvent[] {
  const sr = ctx.sampleRate;
  const tm = ctx.timeMap;
  const notes = [...track.notes].filter((n) => Number.isFinite(n.tick) && Number.isFinite(n.pitch) && n.duration > 0).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const events: NoteEvent[] = [];
  const pluckLike = patch.engine === 'pluck';
  const drums = patch.engine === 'drums';
  // strum groups
  const strumOffset = new Map<string, number>();
  if (patch.strumMs && !drums) {
    let i = 0;
    while (i < notes.length) {
      let j = i;
      while (j + 1 < notes.length && notes[j + 1].tick === notes[i].tick) j++;
      if (j > i) {
        const group = notes.slice(i, j + 1).sort((a, b) => a.pitch - b.pitch);
        const half = Math.max(1, Math.round(ctx.ppq / 2));
        const down = notes[i].tick % half === 0;
        const ordered = down ? group : [...group].reverse();
        ordered.forEach((n, k) => {
          const v = clampNum(n.velocity / 127, 0, 1);
          strumOffset.set(n.id, (k * patch.strumMs! * (1.25 - 0.5 * v)) / 1000);
        });
      }
      i = j + 1;
    }
  }
  for (let k = 0; k < notes.length; k++) {
    const n = notes[k];
    const art = articulationFlag(n.articulation);
    const s0 = tm.tickToSeconds(n.tick);
    const s1 = tm.tickToSeconds(n.tick + n.duration);
    let dur = Math.max(0.01, s1 - s0);
    if (art & ART_STACCATO) dur = Math.max(0.04, dur * 0.45);
    if (art & ART_MARCATO) dur *= 0.75;
    if (art & ART_DEAD) dur = Math.min(dur, 0.08);
    if (art & ART_PALM && !pluckLike) dur = Math.max(0.04, dur * 0.5);
    if (art & ART_PIZZ && !pluckLike && !patch.articulationPatches?.pizzicato) dur = Math.min(dur, 0.15);
    let vel = clampNum(num(n.velocity, 90), 1, 127);
    if (art & ART_GHOST) vel = Math.max(1, vel * 0.45);
    if (art & ART_ACCENT) vel = Math.min(127, vel * 1.15 + 8);
    if (art & ART_MARCATO) vel = Math.min(127, vel + 6);
    const strum = strumOffset.get(n.id) ?? 0;
    const start = Math.round((s0 + strum - ctx.startSec) * sr);
    const end = start + Math.max(1, Math.round(dur * sr));
    const pitchPan = patch.stereo && patch.pitchPan ? clampNum(((n.pitch - 60) / 40) * patch.pitchPan, -0.9, 0.9) : 0;
    events.push({
      id: n.id,
      index: k,
      start,
      end,
      pitch: n.pitch,
      velocity: vel,
      art,
      seed: combineSeed(ctx.seed, hashString(n.id || `${n.tick}:${n.pitch}`)),
      bpm: tm.bpmAt(n.tick),
      fromPitch: -1,
      legato: false,
      pan: pitchPan,
    });
  }
  events.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  // legato / slides
  const legatoTol = Math.round(0.012 * sr);
  for (let k = 1; k < events.length; k++) {
    const e = events[k];
    const prev = events[k - 1];
    if (prev.start === e.start) continue;
    const touching = prev.end >= e.start - legatoTol;
    if (e.art & ART_SLIDE) e.fromPitch = e.start - prev.end < 0.5 * sr ? prev.pitch : e.pitch - 2;
    if (patch.mono && touching && (patch.autoLegato || e.art & (ART_LEGATO | ART_SLIDE) || prev.art & ART_LEGATO)) {
      e.legato = true;
      e.fromPitch = prev.pitch;
    }
  }
  if (!patch.mono) {
    for (let k = 0; k < events.length; k++) {
      const e = events[k];
      if (!(e.art & ART_LEGATO)) continue;
      const next = events.find((x, j) => j > k && x.start > e.start);
      if (next && next.start - e.end < 0.25 * sr && next.start > e.start) e.end = Math.max(e.end, next.start + Math.round(0.02 * sr));
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Instrument FX chain
// ---------------------------------------------------------------------------

type FxProc =
  | { kind: 'amp'; p: AmpSim; mono: true }
  | { kind: 'eq'; p: Biquad[]; mono: false }
  | { kind: 'chorus'; p: Chorus; mono: false }
  | { kind: 'rotary'; p: Rotary; mono: false }
  | { kind: 'autopan'; p: AutoPan; mono: false }
  | { kind: 'formant'; p: FormantBank; mono: false };

class FxChain {
  private readonly items: FxProc[] = [];
  /** DC / sub-sonic blocker on every instrument output (kick bursts, asymmetric strings). */
  private readonly dc = new DcBlocker();
  constructor(specs: InstrumentFxSpec[] | undefined, sr: number, private readonly dcBlock: boolean) {
    this.dc.set(12, sr);
    for (const s of specs ?? []) {
      switch (s.type) {
        case 'amp': {
          const a = new AmpSim(sr);
          a.configure(s.params);
          this.items.push({ kind: 'amp', p: a, mono: true });
          break;
        }
        case 'eq':
          this.items.push({ kind: 'eq', p: s.bands.map((b) => new Biquad().design(b.type, b.f, b.q, b.db, sr)), mono: false });
          break;
        case 'chorus': {
          const c = new Chorus(sr);
          c.configure(s.params);
          this.items.push({ kind: 'chorus', p: c, mono: false });
          break;
        }
        case 'rotary': {
          const r = new Rotary(sr);
          r.configure(s.rate, s.depthMs, s.am, s.mix);
          this.items.push({ kind: 'rotary', p: r, mono: false });
          break;
        }
        case 'autopan': {
          const a = new AutoPan(sr);
          a.configure(s.rate, s.depth);
          this.items.push({ kind: 'autopan', p: a, mono: false });
          break;
        }
        case 'formant': {
          const f = new FormantBank(sr, BLOCK);
          f.configure(s.formants, s.dry);
          this.items.push({ kind: 'formant', p: f, mono: false });
          break;
        }
      }
    }
  }

  reset(): void {
    for (const it of this.items) {
      if (it.kind === 'eq') for (const b of it.p) b.reset();
      else it.p.reset();
    }
    this.dc.reset();
  }

  /** `monoIn`: only L is valid on input (R gets a copy before the first stereo stage / at the end). */
  process(L: Float64Array, R: Float64Array, n: number, monoIn: boolean): void {
    let mono = monoIn;
    const items = this.items;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.kind === 'amp') {
        if (!mono) {
          for (let i = 0; i < n; i++) L[i] = (L[i] + R[i]) * 0.5;
          mono = true;
        }
        it.p.process(L, 0, n);
        continue;
      }
      if (it.kind === 'eq') {
        const bands = it.p;
        for (let b = 0; b < bands.length; b++) {
          if (mono) bands[b].processMono(L, 0, n);
          else bands[b].processStereo(L, R, 0, n);
        }
        continue;
      }
      if (mono) {
        for (let i = 0; i < n; i++) R[i] = L[i];
        mono = false;
      }
      it.p.process(L, R, 0, n);
    }
    const dc = this.dc;
    if (!this.dcBlock) {
      if (mono) for (let i = 0; i < n; i++) R[i] = L[i];
    } else {
      const r = dc.r;
      let x1 = dc.x1L, y1 = dc.y1L;
      if (mono) {
        for (let i = 0; i < n; i++) {
          const x = L[i];
          const y = x - x1 + r * y1;
          x1 = x;
          y1 = y;
          L[i] = y;
          R[i] = y;
        }
      } else {
        let u1 = dc.x1R, v1 = dc.y1R;
        for (let i = 0; i < n; i++) {
          const x = L[i];
          const y = x - x1 + r * y1;
          x1 = x;
          y1 = y;
          L[i] = y;
          const u = R[i];
          const v = u - u1 + r * v1;
          u1 = u;
          v1 = v;
          R[i] = v;
        }
        dc.x1R = u1;
        dc.y1R = Math.abs(v1) < 1e-25 ? 0 : v1;
      }
      dc.x1L = x1;
      dc.y1L = Math.abs(y1) < 1e-25 ? 0 : y1;
    }
  }
}

// ---------------------------------------------------------------------------
// PolyInstrument
// ---------------------------------------------------------------------------

export interface PolyInstrumentOptions {
  sampleInstrument?: SampleInstrument;
  /** Sub-instrument for pizzicato notes. */
  pizzPatch?: PatchDefinition;
}

const CHASE_POOL = 48;

export class PolyInstrument implements TrackSource {
  private readonly host: VoiceHost;
  private readonly voices: Voice[] = [];
  private readonly maxPoly: number;
  private events: NoteEvent[] = [];
  private cursor = 0;
  private readonly fx: FxChain;
  private readonly gain: number;
  private readonly matcher: ZoneMatcher | null = null;
  private readonly zoneIdx = new Int32Array(32);
  private readonly pianoZones = new Map<number, SampleZone>();
  private readonly chasePool: NoteEvent[] = [];
  private noteRand = 0;
  private silentBlocks = 1e9;
  private readonly idleAfter: number;
  sub: PolyInstrument | null = null;
  private subEvents: NoteEvent[] = [];

  constructor(
    readonly patch: PatchDefinition,
    readonly sampleRate: number,
    private readonly opts: PolyInstrumentOptions = {},
  ) {
    this.host = { sampleRate, scratch: new Float64Array(BLOCK), scratch2: new Float64Array(BLOCK) };
    this.maxPoly = Math.max(1, patch.polyphony);
    const pool = patch.mono ? 3 : this.maxPoly + Math.min(8, Math.max(2, Math.ceil(this.maxPoly / 4)));
    for (let i = 0; i < pool; i++) this.voices.push(this.createVoice());
    const dcBlock = patch.engine === 'drums' || patch.engine === 'pluck' || patch.engine === 'modal' || patch.engine === 'sampler' || patch.engine === 'piano';
    this.fx = new FxChain(patch.fx, sampleRate, dcBlock);
    this.gain = dbToGain(num(patch.gainDb, 0));
    if (patch.engine === 'sampler' && opts.sampleInstrument) this.matcher = new ZoneMatcher(opts.sampleInstrument);
    for (let i = 0; i < CHASE_POOL; i++) {
      this.chasePool.push({ id: '', index: 0, start: 0, end: 0, pitch: 60, velocity: 100, art: 0, seed: 1, bpm: 120, fromPitch: -1, legato: false, pan: 0 });
    }
    if (opts.pizzPatch) this.sub = new PolyInstrument(opts.pizzPatch, sampleRate);
    // FX tails (chorus/rotary buffers, amp & EQ filters) are flushed well within 250 ms
    this.idleAfter = Math.ceil((0.25 * sampleRate) / BLOCK);
  }

  get idle(): boolean {
    return this.silentBlocks > this.idleAfter && (this.sub === null || this.sub.idle);
  }

  private createVoice(): Voice {
    const p = this.patch;
    const h = this.host;
    switch (p.engine) {
      case 'va':
        return new VaVoice(h, p.params as never, p.stereo);
      case 'pluck':
        return new PluckVoice(h, p.params as never, p.stereo);
      case 'fm':
        return new FmVoice(h, p.params as never, p.stereo);
      case 'organ':
        return new OrganVoice(h, p.params as never, p.stereo);
      case 'choir':
        return new ChoirVoice(h, p.params as never, p.stereo);
      case 'modal':
        return new ModalVoice(h, p.params as never, p.stereo);
      case 'drums':
        return new DrumVoice(h);
      default:
        return new SamplerVoice(h);
    }
  }

  /** Install events; keeps sounding voices whose notes still exist (live edits). */
  setEvents(events: NoteEvent[], frame: number): void {
    const main: NoteEvent[] = [];
    const sub: NoteEvent[] = [];
    for (const e of events) (this.sub && e.art & ART_PIZZ ? sub : main).push(e);
    const byId = new Map(main.map((e) => [e.id, e]));
    for (const v of this.voices) {
      if (!v.active || v.released || !v.note) continue;
      const e = byId.get(v.note.id);
      if (!e || e.pitch !== v.note.pitch) v.release();
      else {
        v.note = e;
        v.endFrame = e.end;
      }
    }
    this.events = main;
    this.cursor = lowerBound(main, frame);
    this.prepareZones(main);
    if (this.sub) {
      this.subEvents = sub;
      this.sub.setEvents(sub, frame);
    }
  }

  /** Pre-render piano multisamples needed by the events (keeps rendering out of process()). */
  private prepareZones(events: NoteEvent[]): void {
    if (this.patch.engine !== 'piano') return;
    for (const e of events) this.zoneFor(e.pitch, e.velocity);
  }

  private zoneFor(pitch: number, velocity: number): SampleZone {
    const p = this.patch.params as PianoParams;
    const step = Math.max(1, p.zoneStep);
    const center = 21 + Math.round((Math.round(pitch) - 21) / step) * step;
    let li = 0;
    for (let i = 0; i < p.layers.length; i++) {
      const lo = i === 0 ? 1 : Math.floor((p.layers[i - 1] + p.layers[i]) / 2) + 1;
      if (velocity >= lo) li = i;
    }
    const key = center * 16 + li;
    let z = this.pianoZones.get(key);
    if (!z) {
      z = pianoZone(this.sampleRate, pitch, velocity, p);
      this.pianoZones.set(key, z);
    }
    return z;
  }

  seek(frame: number): void {
    for (const v of this.voices) v.reset();
    this.fx.reset();
    this.silentBlocks = 1e9;
    this.matcher?.reset();
    this.cursor = lowerBound(this.events, frame);
    this.chase(frame);
    this.sub?.seek(frame);
  }

  loopTo(frame: number): void {
    for (const v of this.voices) if (v.active && !v.released) v.release();
    this.cursor = lowerBound(this.events, frame);
    this.chase(frame);
    this.sub?.loopTo(frame);
  }

  private chase(frame: number): void {
    if (!this.patch.sustained) return;
    let used = 0;
    for (let k = 0; k < this.events.length && used < CHASE_POOL; k++) {
      const e = this.events[k];
      if (e.start >= frame) break;
      if (e.end <= frame + Math.round(0.05 * this.sampleRate)) continue;
      const c = this.chasePool[used++];
      Object.assign(c, e);
      c.start = frame;
      c.legato = false;
      this.noteOn(c, 0);
    }
  }

  private countSounding(): number {
    let c = 0;
    for (const v of this.voices) if (v.active && !v.killed) c++;
    return c;
  }

  private allocate(): Voice {
    if (this.countSounding() >= this.maxPoly) {
      // steal: quietest releasing voice, else the oldest
      let victim: Voice | null = null;
      let best = Infinity;
      for (const v of this.voices) {
        if (!v.active || v.killed || !v.released) continue;
        const l = v.level();
        if (l < best) {
          best = l;
          victim = v;
        }
      }
      if (!victim) {
        let oldest = Infinity;
        for (const v of this.voices) {
          if (!v.active || v.killed) continue;
          if (v.startFrame < oldest) {
            oldest = v.startFrame;
            victim = v;
          }
        }
      }
      victim?.kill();
    }
    for (const v of this.voices) if (!v.active) return v;
    // all voices busy (fading): hard-reuse the quietest
    let q: Voice = this.voices[0];
    let ql = Infinity;
    for (const v of this.voices) {
      const l = v.level();
      if (l < ql) {
        ql = l;
        q = v;
      }
    }
    q.reset();
    return q;
  }

  private noteOn(ev: NoteEvent, offset: number): void {
    const p = this.patch;
    this.silentBlocks = 0;
    switch (p.engine) {
      case 'drums': {
        const piece: DrumPiece = drumPiece(p.kit ?? 'acoustic', ev.pitch);
        if (piece.chokes !== undefined) {
          for (const v of this.voices) if (v.active && !v.killed && (v as DrumVoice).piece?.group === piece.chokes) v.kill();
        }
        const limit = piece.maxVoices ?? 3;
        let count = 0;
        for (const v of this.voices) if (v.active && !v.killed && (v as DrumVoice).piece === piece) count++;
        while (count >= limit) {
          let oldest: Voice | null = null;
          for (const v of this.voices) if (v.active && !v.killed && (v as DrumVoice).piece === piece && (!oldest || v.startFrame < oldest.startFrame)) oldest = v;
          if (!oldest) break;
          oldest.kill();
          count--;
        }
        const v = this.allocate() as DrumVoice;
        v.startPiece(ev, piece);
        v.renderFrom = offset;
        return;
      }
      case 'piano':
      case 'sampler': {
        if (p.engine === 'piano') {
          // re-striking a sounding key damps the previous strike
          for (const v of this.voices) if (v.active && !v.released && v.pitch === ev.pitch) v.release();
          const zone = this.zoneFor(ev.pitch, ev.velocity);
          const v = this.allocate() as SamplerVoice;
          v.startZone(ev, zone, 0, ev.pan);
          v.renderFrom = offset;
          return;
        }
        const inst = this.opts.sampleInstrument;
        if (!inst || !this.matcher) return;
        this.noteRand = ((ev.seed >>> 0) % 100000) / 100000;
        const nz = this.matcher.match(ev.pitch, ev.velocity, this.noteRand, 'attack', this.zoneIdx);
        for (let k = 0; k < nz; k++) {
          const zi = this.zoneIdx[k];
          const z = inst.zones[zi];
          if (z.group !== undefined) {
            for (const v of this.voices) if (v.active && !v.killed && (v as SamplerVoice).zone?.offBy === z.group) v.kill();
          }
          const v = this.allocate() as SamplerVoice;
          v.startZone(ev, z, zi, 0);
          v.renderFrom = offset;
        }
        return;
      }
      default:
        break;
    }
    if (p.mono) {
      let cur: Voice | null = null;
      for (const v of this.voices) if (v.active && !v.killed && !v.released && (!cur || v.startFrame >= cur.startFrame)) cur = v;
      if (cur && ev.legato && cur.glideTo(ev)) return;
      for (const v of this.voices) if (v.active && !v.killed) v.kill();
    } else {
      let reuse: Voice | null = null;
      for (const v of this.voices) {
        if (v.active && !v.killed && v.pitch === ev.pitch) {
          if (p.engine === 'va' && !reuse) {
            reuse = v;
            continue;
          }
          if (v.released) continue;
          if (p.engine === 'pluck') v.kill();
          else v.release();
        }
      }
      if (reuse && reuse.retrigger(ev)) {
        reuse.renderFrom = offset;
        return;
      }
    }
    const v = this.allocate();
    v.start(ev);
    v.renderFrom = offset;
  }

  /** Release-trigger zones for sampler instruments. */
  private releaseTrigger(v: Voice, offset: number): void {
    const inst = this.opts.sampleInstrument;
    if (!inst || !this.matcher || !v.note) return;
    const nz = this.matcher.match(v.note.pitch, v.note.velocity, this.noteRand, 'release', this.zoneIdx);
    for (let k = 0; k < nz; k++) {
      const z = inst.zones[this.zoneIdx[k]];
      const nv = this.allocate() as SamplerVoice;
      nv.startZone(v.note, z, this.zoneIdx[k], 0);
      nv.renderFrom = offset;
    }
  }

  render(L: Float64Array, R: Float64Array, blockStart: number, n: number): void {
    const end = blockStart + n;
    const ev = this.events;
    while (this.cursor < ev.length && ev[this.cursor].start < end) {
      const e = ev[this.cursor++];
      if (e.end <= blockStart) continue;
      this.noteOn(e, Math.max(0, e.start - blockStart));
    }
    if (this.silentBlocks > this.idleAfter) {
      // nothing sounding and FX tails flushed: skip voices and FX entirely
      if (this.sub) this.renderSub(L, R, blockStart, n);
      return;
    }
    const stereo = this.patch.stereo || this.patch.engine === 'drums' || this.patch.engine === 'piano' || this.patch.engine === 'sampler';
    let anyActive = false;
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (!v.active) continue;
      anyActive = true;
      let s = v.renderFrom;
      v.renderFrom = 0;
      if (!v.released && !v.killed && v.endFrame < end) {
        const off = Math.max(s, Math.min(n, v.endFrame - blockStart));
        if (off > s) v.render(L, R, s, off);
        if (v.active) {
          v.release();
          if (this.patch.engine === 'sampler') this.releaseTrigger(v, off);
        }
        s = off;
      }
      if (v.active && s < n) v.render(L, R, s, n);
    }
    if (this.gain !== 1) {
      const g = this.gain;
      for (let i = 0; i < n; i++) L[i] *= g;
      if (stereo) for (let i = 0; i < n; i++) R[i] *= g;
    }
    this.fx.process(L, R, n, !stereo);
    if (anyActive) this.silentBlocks = 0;
    else this.silentBlocks++;
    if (this.sub) this.renderSub(L, R, blockStart, n);
  }

  private renderSub(L: Float64Array, R: Float64Array, blockStart: number, n: number): void {
    const sub = this.sub!;
    const sL = this.host.scratch, sR = this.host.scratch2;
    sL.fill(0, 0, n);
    sR.fill(0, 0, n);
    sub.render(sL, sR, blockStart, n);
    for (let i = 0; i < n; i++) {
      L[i] += sL[i];
      R[i] += sR[i];
    }
  }

  /** Fade everything out (instrument replaced while playing). */
  killAll(): void {
    for (const v of this.voices) if (v.active) v.kill();
    this.cursor = this.events.length;
    this.sub?.killAll();
  }

  get activeVoices(): number {
    let c = 0;
    for (const v of this.voices) if (v.active) c++;
    return c + (this.sub ? this.sub.activeVoices : 0);
  }

  get eventCount(): number {
    return this.events.length + this.subEvents.length;
  }
}

function lowerBound(events: NoteEvent[], frame: number): number {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].start < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Vocal track
// ---------------------------------------------------------------------------

export class VocalInstrument implements TrackSource {
  private engine: VocalEngine;
  private readonly gain: number;
  constructor(
    song: Song,
    track: Track,
    private readonly sampleRate: number,
    private startSec: number,
    private readonly voiceId: string | undefined,
    seed: number,
    gainDb: number,
  ) {
    const tl = prepareVocal(song, track, sampleRate, startSec, voiceId);
    this.engine = new VocalEngine(tl.voice, sampleRate, combineSeed(seed, hashString(track.id)));
    this.engine.setTimeline(tl);
    this.gain = dbToGain(gainDb);
  }

  get idle(): boolean {
    return this.engine.idle;
  }

  update(song: Song, track: Track, startSec: number, frame: number): void {
    this.startSec = startSec;
    const tl = prepareVocal(song, track, this.sampleRate, startSec, this.voiceId);
    this.engine.setTimeline(tl);
    this.engine.seek(frame);
  }

  render(L: Float64Array, R: Float64Array, blockStart: number, n: number): void {
    this.engine.render(L, 0, blockStart, n);
    const g = this.gain;
    for (let i = 0; i < n; i++) {
      const x = L[i] * g;
      L[i] = x;
      R[i] = x;
    }
  }

  seek(frame: number): void {
    this.engine.seek(frame);
  }

  loopTo(frame: number): void {
    this.engine.seek(frame);
  }
}

// ---------------------------------------------------------------------------
// Audio clips
// ---------------------------------------------------------------------------

interface ClipState {
  start: number;
  len: number;
  srcOffset: number;
  ratio: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  ch0: Float32Array;
  ch1: Float32Array | null;
  interp: SincInterpolator | null;
}

const interpCache = new Map<string, SincInterpolator>();

function interpolatorFor(ratio: number): SincInterpolator {
  // downsampling needs a lower cutoff; quantize to keep the cache small
  const fc = Math.min(1, 1 / ratio) * 0.95;
  const key = fc.toFixed(3);
  let it = interpCache.get(key);
  if (!it) {
    it = new SincInterpolator(8, 256, fc);
    interpCache.set(key, it);
  }
  return it;
}

export class ClipPlayer implements TrackSource {
  private clips: ClipState[] = [];
  idle = true;
  /** Clip asset ids that could not be resolved. */
  missing: string[] = [];

  constructor(
    track: Track,
    tm: TimeMap,
    startSec: number,
    private readonly sampleRate: number,
    assets: AssetResolver | undefined,
    private readonly assetCache: Map<string, AudioData | undefined>,
  ) {
    this.build(track, tm, startSec, assets);
  }

  build(track: Track, tm: TimeMap, startSec: number, assets: AssetResolver | undefined): void {
    const sr = this.sampleRate;
    this.clips = [];
    this.missing = [];
    for (const c of track.clips ?? []) {
      if (!c || c.muted) continue;
      const asset = this.resolve(c, assets);
      if (!asset || !asset.channels.length) {
        this.missing.push(c.assetId);
        continue;
      }
      const ratio = asset.sampleRate / sr;
      const assetLen = asset.channels[0].length;
      const srcOffset = Math.max(0, num(c.offsetSeconds, 0)) * asset.sampleRate;
      const maxDur = (assetLen - srcOffset) / asset.sampleRate;
      const durSec = Math.min(num(c.durationSeconds, maxDur) > 0 ? num(c.durationSeconds, maxDur) : maxDur, maxDur);
      if (!(durSec > 0)) continue;
      const startFrame = Math.round((tm.tickToSeconds(c.tick) - startSec) * sr);
      this.clips.push({
        start: startFrame,
        len: Math.round(durSec * sr),
        srcOffset,
        ratio,
        gain: dbToGain(num(c.gainDb, 0)),
        fadeIn: Math.round(Math.max(0, num(c.fadeInSeconds, 0)) * sr),
        fadeOut: Math.round(Math.max(0, num(c.fadeOutSeconds, 0)) * sr),
        ch0: asset.channels[0],
        ch1: asset.channels.length > 1 ? asset.channels[1] : null,
        interp: Math.abs(ratio - 1) < 1e-9 && Number.isInteger(srcOffset) ? null : interpolatorFor(ratio),
      });
    }
  }

  private resolve(c: AudioClip, assets: AssetResolver | undefined): AudioData | undefined {
    const cached = this.assetCache.get(c.assetId);
    if (cached) return cached;
    let a: AudioData | undefined;
    try {
      a = assets?.(c.assetId);
    } catch {
      a = undefined;
    }
    // only successful lookups are cached: an asset that arrives later is picked up by updateSong()
    if (a) this.assetCache.set(c.assetId, a);
    return a;
  }

  render(L: Float64Array, R: Float64Array, blockStart: number, n: number): void {
    const end = blockStart + n;
    let idle = true;
    for (let ci = 0; ci < this.clips.length; ci++) {
      const c = this.clips[ci];
      if (c.start >= end || c.start + c.len <= blockStart) continue;
      idle = false;
      const i0 = Math.max(blockStart, c.start) - blockStart;
      const i1 = Math.min(end, c.start + c.len) - blockStart;
      const c0 = c.ch0, c1 = c.ch1;
      for (let i = i0; i < i1; i++) {
        const t = blockStart + i - c.start;
        let g = c.gain;
        if (c.fadeIn > 0 && t < c.fadeIn) g *= Math.sin(((t + 0.5) / c.fadeIn) * (Math.PI / 2));
        const rem = c.len - t;
        if (c.fadeOut > 0 && rem < c.fadeOut) g *= Math.sin(((rem - 0.5) / c.fadeOut) * (Math.PI / 2));
        const pos = c.srcOffset + t * c.ratio;
        let a: number, b: number;
        if (c.interp) {
          a = c.interp.read(c0, pos);
          b = c1 ? c.interp.read(c1, pos) : a;
        } else {
          const ip = pos | 0;
          a = ip < c0.length ? c0[ip] : 0;
          b = c1 ? (ip < c1.length ? c1[ip] : 0) : a;
        }
        L[i] += a * g;
        R[i] += b * g;
      }
    }
    this.idle = idle;
  }

  seek(): void {}
  loopTo(): void {}
}
