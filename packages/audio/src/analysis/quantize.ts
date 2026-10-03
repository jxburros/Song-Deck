/**
 * Transcription → Music IR notes: seconds → ticks (constant tempo), grid quantisation with
 * strength, optional snap-to-key, same-pitch overlap cleanup, deterministic ids, and the
 * transcription confidence carried on `Note.confidence` (spec §25 "communicate uncertainty").
 */
import { GM_DRUM, IdFactory, PPQ, quantizeTick, snapToScale, sortNotes, type KeySignature, type Note } from '@songdeck/core';
import type { DrumHit, TranscribedNote } from './types';
import { clamp } from './util';

export interface TranscribedToNotesOptions {
  bpm: number;
  ppq?: number;
  /** Grid in beats (quarter notes): 0.25 = sixteenths, 0 = no quantisation. Default 0.25. */
  quantizeBeats?: number;
  /** 0..1 (default 1). */
  quantizeStrength?: number;
  /** Audio time (s) that maps to tick 0. Default 0. */
  offsetSeconds?: number;
  key?: KeySignature;
  /** Move out-of-key pitches to the nearest scale tone (confidence is reduced for moved notes). */
  snapToKey?: boolean;
  /** Prefix of generated note ids (default "tn"). */
  idPrefix?: string;
  /** Seed for deterministic ids (default 1). */
  seed?: number;
  /** Quantise note ends too (default true). */
  quantizeEnds?: boolean;
  /** Minimum duration in beats (default: one grid step, or 1/16 beat without a grid). */
  minDurationBeats?: number;
  /** Note.origin (default "transcription"). */
  origin?: string;
  /** Pitch limits (notes outside are folded by octaves into range). */
  lowest?: number;
  highest?: number;
}

export function secondsToTicks(seconds: number, bpm: number, ppq = PPQ): number {
  return (seconds * bpm * ppq) / 60;
}

export function ticksToSeconds(ticks: number, bpm: number, ppq = PPQ): number {
  return (ticks * 60) / (bpm * ppq);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function foldPitch(p: number, lo?: number, hi?: number): number {
  let q = p;
  if (lo !== undefined && hi !== undefined && hi - lo >= 12) {
    while (q < lo) q += 12;
    while (q > hi) q -= 12;
  } else {
    if (lo !== undefined) q = Math.max(lo, q);
    if (hi !== undefined) q = Math.min(hi, q);
  }
  return clamp(q, 0, 127);
}

/** Convert transcribed notes (seconds) to IR notes (ticks). */
export function transcribedToNotes(notes: TranscribedNote[], opts: TranscribedToNotesOptions): Note[] {
  const ppq = opts.ppq ?? PPQ;
  const bpm = opts.bpm > 0 ? opts.bpm : 120;
  const q = opts.quantizeBeats ?? 0.25;
  const grid = q > 0 ? Math.max(1, Math.round(q * ppq)) : 0;
  const strength = clamp(opts.quantizeStrength ?? 1, 0, 1);
  const offset = opts.offsetSeconds ?? 0;
  const minDur = Math.max(1, Math.round((opts.minDurationBeats ?? (q > 0 ? q : 1 / 16)) * ppq));
  const ids = new IdFactory(opts.seed ?? 1, 'transcription');
  const prefix = opts.idPrefix ?? 'tn';
  const sorted = [...notes].sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);
  const out: Note[] = [];
  for (const n of sorted) {
    const s = n.startSeconds - offset;
    const e = n.endSeconds - offset;
    if (e <= 0) continue;
    let tick = Math.round(secondsToTicks(Math.max(0, s), bpm, ppq));
    let end = Math.round(secondsToTicks(e, bpm, ppq));
    if (grid) {
      tick = quantizeTick(tick, grid, strength);
      if (opts.quantizeEnds !== false) end = quantizeTick(end, grid, strength);
    }
    tick = Math.max(0, tick);
    if (end - tick < minDur) end = tick + minDur;
    let pitch = foldPitch(Math.round(n.pitch), opts.lowest, opts.highest);
    let confidence = clamp(n.confidence, 0, 1);
    if (opts.snapToKey && opts.key) {
      const snapped = snapToScale(pitch, opts.key);
      if (snapped !== pitch) {
        pitch = snapped;
        confidence *= 0.85;
      }
    }
    out.push({
      id: ids.next(prefix),
      pitch,
      tick,
      duration: end - tick,
      velocity: Math.round(clamp(n.velocity, 1, 127)),
      confidence: round3(confidence),
      origin: opts.origin ?? 'transcription',
    });
  }
  return sortNotes(resolveOverlaps(out));
}

/** Same-pitch notes may not overlap: truncate the earlier one; identical starts keep the more confident. */
export function resolveOverlaps(notes: Note[]): Note[] {
  const byPitch = new Map<number, Note[]>();
  for (const n of notes) {
    const l = byPitch.get(n.pitch);
    if (l) l.push(n);
    else byPitch.set(n.pitch, [n]);
  }
  const keep: Note[] = [];
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.tick - b.tick || (b.confidence ?? 0) - (a.confidence ?? 0));
    let prev: Note | undefined;
    for (const n of list) {
      if (prev && n.tick === prev.tick) {
        // duplicate onset after quantisation: merge into the kept (more confident) note
        prev.duration = Math.max(prev.duration, n.duration);
        prev.velocity = Math.max(prev.velocity, n.velocity);
        continue;
      }
      if (prev && prev.tick + prev.duration > n.tick) prev.duration = Math.max(1, n.tick - prev.tick);
      keep.push(n);
      prev = n;
    }
  }
  return keep;
}

/** Keep only one sounding note at a time (bass / lead lines): later notes cut earlier ones. */
export function enforceMonophony(notes: Note[]): Note[] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || (b.confidence ?? 0) - (a.confidence ?? 0) || a.pitch - b.pitch);
  const out: Note[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.tick === n.tick) continue; // simultaneous: keep the more confident one
    if (prev && prev.tick + prev.duration > n.tick) prev.duration = Math.max(1, n.tick - prev.tick);
    out.push({ ...n });
  }
  return out;
}

export interface DrumHitsToNotesOptions {
  bpm: number;
  ppq?: number;
  /** Default 0.25 (sixteenths). */
  quantizeBeats?: number;
  quantizeStrength?: number;
  offsetSeconds?: number;
  idPrefix?: string;
  seed?: number;
  /** Note length in beats (default 0.25). */
  durationBeats?: number;
  origin?: string;
}

/** Drum hits → IR notes on the GM drum map (one note per drum per grid position). */
export function drumHitsToNotes(hits: DrumHit[], opts: DrumHitsToNotesOptions): Note[] {
  const ppq = opts.ppq ?? PPQ;
  const bpm = opts.bpm > 0 ? opts.bpm : 120;
  const q = opts.quantizeBeats ?? 0.25;
  const grid = q > 0 ? Math.max(1, Math.round(q * ppq)) : 0;
  const strength = clamp(opts.quantizeStrength ?? 1, 0, 1);
  const offset = opts.offsetSeconds ?? 0;
  const dur = Math.max(1, Math.round((opts.durationBeats ?? 0.25) * ppq));
  const ids = new IdFactory(opts.seed ?? 1, 'drums');
  const prefix = opts.idPrefix ?? 'dn';
  const byKey = new Map<string, Note>();
  const sorted = [...hits].sort((a, b) => a.time - b.time || a.drum - b.drum);
  for (const h of sorted) {
    const s = h.time - offset;
    if (s < -0.05) continue;
    let tick = Math.round(secondsToTicks(Math.max(0, s), bpm, ppq));
    if (grid) tick = quantizeTick(tick, grid, strength);
    tick = Math.max(0, tick);
    const key = `${h.drum}@${tick}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.velocity = Math.max(existing.velocity, Math.round(clamp(h.velocity, 1, 127)));
      existing.confidence = round3(Math.max(existing.confidence ?? 0, h.confidence));
      continue;
    }
    byKey.set(key, {
      id: ids.next(prefix),
      pitch: clamp(Math.round(h.drum), 0, 127),
      tick,
      duration: dur,
      velocity: Math.round(clamp(h.velocity, 1, 127)),
      confidence: round3(clamp(h.confidence, 0, 1)),
      origin: opts.origin ?? 'transcription',
    });
  }
  return sortNotes([...byKey.values()]);
}

export interface TapsToNotesOptions {
  bpm: number;
  /** GM drum note (default 39, hand clap). */
  drum?: number;
  /** Default 0.25 (sixteenths). */
  quantizeBeats?: number;
  quantizeStrength?: number;
  ppq?: number;
  /** Audio/tap time mapped to tick 0. Default: the first tap. */
  offsetSeconds?: number;
  /** Per-tap velocities (1..127); default 100. */
  velocities?: number[];
  idPrefix?: string;
  seed?: number;
  durationBeats?: number;
}

/** Spec §27 "tap a rhythm": tap times → quantised percussion notes. */
export function tapsToNotes(tapTimesSeconds: number[], opts: TapsToNotesOptions): Note[] {
  if (!tapTimesSeconds.length) return [];
  const sorted = [...tapTimesSeconds].map((t, i) => ({ t, v: opts.velocities?.[i] ?? 100 })).sort((a, b) => a.t - b.t);
  const offset = opts.offsetSeconds ?? sorted[0].t;
  const hits: DrumHit[] = sorted.map(({ t, v }) => ({ time: t, drum: opts.drum ?? GM_DRUM.CLAP, velocity: v, confidence: 1 }));
  return drumHitsToNotes(hits, {
    bpm: opts.bpm,
    ppq: opts.ppq,
    quantizeBeats: opts.quantizeBeats ?? 0.25,
    quantizeStrength: opts.quantizeStrength,
    offsetSeconds: offset,
    idPrefix: opts.idPrefix ?? 'tap',
    seed: opts.seed,
    durationBeats: opts.durationBeats,
    origin: 'user-tap',
  });
}
