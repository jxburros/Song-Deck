import type { KeySignature, Song, Track } from '../ir/types';
import { GM_DRUM } from '../ir/gm';
import { barToTick, quantizeTick, tickToBar } from '../timing';
import { chordPitchClasses, chordTones, isDominantQuality, triadQuality } from '../theory/chords';
import { mod12 } from '../theory/pitch';
import { isInScale, pitchToScaleIndex, scaleIndexToPitch, scalePitchClasses, transposeDiatonic } from '../theory/scales';
import { chordFunction } from '../theory/analysis';
import type { Rng } from '../util/random';
import { DRUM_GROUPS } from './nlp';
import { refitPitch } from './harmony';
import {
  type ChordSlot,
  type TickRange,
  type WorkNote,
  avgPitch,
  barIndex,
  beatTicks,
  clampVel,
  foldPitch,
  keyAt,
  mergeRanges,
  rangeContaining,
  slotAt,
  sortWork,
} from './op-helpers';

/**
 * Deterministic note transforms used by the natural-language edit interpreter. Each takes the
 * editable, in-scope notes of one track (ticks) and returns their replacement. Notes keep their
 * `id` when modified (identity-preserving); new notes have no id.
 */

export interface TransformContext {
  song: Song;
  track: Track;
  rng: Rng;
  /** Scope ranges: new notes are only created inside them. */
  ranges: TickRange[];
  /** All current notes of the track (in and out of scope, locked included), sorted. */
  context: WorkNote[];
  /** Current chord timeline (may already reflect earlier harmonic edits). */
  chords: ChordSlot[];
  isDrums: boolean;
  isBass: boolean;
  isVocal: boolean;
  isMelodic: boolean;
  low: number;
  high: number;
  /** Intensity multiplier from "slightly" / "much" (default 1). */
  amount: number;
}

export interface TransformResult {
  notes: WorkNote[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const tpb = (ctx: TransformContext, tick: number) => beatTicks(ctx.song, tick);
const chordAt = (ctx: TransformContext, tick: number) => slotAt(ctx.chords, tick)?.spec;
const keyOf = (ctx: TransformContext, tick: number): KeySignature => keyAt(ctx.song, tick);
const posInBar = (ctx: TransformContext, tick: number) => tickToBar(ctx.song, tick).beat;
const frac = (x: number) => x - Math.floor(x);
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;
const cloneN = (n: WorkNote): WorkNote => ({ ...n, expression: n.expression ? { ...n.expression } : undefined });

function strip(n: WorkNote): WorkNote {
  const out = { ...n };
  if (out.expression === undefined) delete out.expression;
  if (out.syllable === undefined) delete out.syllable;
  if (out.articulation === undefined) delete out.articulation;
  return out;
}

/** First onset strictly after `tick` among the track's notes (any pitch). */
function nextOnset(ctx: TransformContext, tick: number, pool: WorkNote[] = ctx.context): number | undefined {
  let best: number | undefined;
  for (const n of pool) if (n.tick > tick && (best === undefined || n.tick < best)) best = n.tick;
  return best;
}

function noteStartingAt(pool: WorkNote[], tick: number): WorkNote | undefined {
  const at = pool.filter((n) => n.tick === tick);
  return at.sort((a, b) => b.pitch - a.pitch)[0];
}

/** True when a meaningful share of onsets carry more than one note (chords). */
export function isPolyphonic(notes: WorkNote[]): boolean {
  if (notes.length < 3) return false;
  const byTick = new Map<number, number>();
  for (const n of notes) byTick.set(n.tick, (byTick.get(n.tick) ?? 0) + 1);
  const multi = [...byTick.values()].filter((c) => c > 1).length;
  return multi / byTick.size >= 0.3;
}

export function groupByOnset(notes: WorkNote[]): WorkNote[][] {
  const map = new Map<number, WorkNote[]>();
  for (const n of notes) map.set(n.tick, [...(map.get(n.tick) ?? []), n]);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

/** Split a monophonic line into phrases at rests of at least `gapTicks`. */
export function splitPhrases<T extends { tick: number; duration: number }>(notes: T[], gapTicks: number): T[][] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const out: T[][] = [];
  let cur: T[] = [];
  let end = -Infinity;
  for (const n of sorted) {
    if (cur.length && n.tick - end >= gapTicks) {
      out.push(cur);
      cur = [];
    }
    cur.push(n);
    end = Math.max(end, n.tick + n.duration);
  }
  if (cur.length) out.push(cur);
  return out;
}

function inScope(ctx: TransformContext, tick: number): boolean {
  return ctx.ranges.some((r) => tick >= r.startTick && tick < r.endTick);
}

function scopeEnd(ctx: TransformContext, tick: number): number {
  return rangeContaining(ctx.ranges, tick)?.endTick ?? tick;
}

function fold(ctx: TransformContext, p: number): number {
  return foldPitch(p, ctx.low, ctx.high);
}

function nearestWithPc(pc: number, near: number): number {
  const base = near - mod12(near - pc);
  return near - base <= 6 ? base : base + 12;
}

function nearestChordTone(ctx: TransformContext, pitch: number, tick: number, exclude?: number): number {
  const chord = chordAt(ctx, tick);
  const pcs = chord ? chordPitchClasses(chord) : scalePitchClasses(keyOf(ctx, tick));
  let best = pitch;
  let bestD = Infinity;
  for (let d = -7; d <= 7; d++) {
    const p = pitch + d;
    if (p === exclude) continue;
    if (pcs.includes(mod12(p)) && Math.abs(d) < bestD) {
      bestD = Math.abs(d);
      best = p;
    }
  }
  return best;
}

/** Approach tone leading into `target` (chromatic, diatonic step, or fifth below for bass). */
function approachTone(ctx: TransformContext, target: number, prev: number, tick: number): number {
  const key = keyOf(ctx, tick);
  const fromBelow = prev <= target;
  const r = ctx.rng.next();
  let p: number;
  if (ctx.isBass) {
    if (r < 0.35) p = target - 1;
    else if (r < 0.75) p = transposeDiatonic(target, fromBelow ? -1 : 1, key);
    else p = target - 7 >= ctx.low ? target - 7 : target + 5;
  } else if (r < 0.7) p = transposeDiatonic(target, fromBelow ? -1 : 1, key);
  else p = fromBelow ? target - 1 : target + 1;
  if (p === target) p = target - 1;
  return fold(ctx, p);
}

/** Fill tone for subdivided long notes: bass → root/octave/fifth; melody → neighbour figures. */
function fillTone(ctx: TransformContext, base: WorkNote, prev: number, tick: number, idx: number): number {
  const chord = chordAt(ctx, tick);
  const key = keyOf(ctx, tick);
  if (ctx.isBass) {
    const root = chord ? nearestWithPc(chord.bass ?? chord.root, base.pitch) : base.pitch;
    const choices = chord
      ? [root + 12 <= ctx.high ? root + 12 : root, nearestWithPc(mod12(chord.root + 7), root), root]
      : [base.pitch, base.pitch + 12, base.pitch];
    return fold(ctx, choices[(idx - 1 + ctx.rng.int(0, 1)) % choices.length]);
  }
  const options = [transposeDiatonic(base.pitch, 1, key), transposeDiatonic(base.pitch, -1, key), base.pitch];
  if (chord) {
    const tones = chordPitchClasses(chord);
    const ct = [...tones].map((pc) => nearestWithPc(pc, prev)).filter((p) => p !== prev);
    if (ct.length) options.push(ct[ctx.rng.int(0, ct.length - 1)]);
  }
  return fold(ctx, options[ctx.rng.int(0, options.length - 1)]);
}

function withSyllable(ctx: TransformContext, n: WorkNote): WorkNote {
  if (ctx.isVocal) n.syllable = '_';
  return n;
}

// ---------------------------------------------------------------------------
// Busier / simpler
// ---------------------------------------------------------------------------

export function busier(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  if (ctx.isDrums) return busierDrums(ctx, notes);
  if (isPolyphonic(notes)) return busierChords(ctx, notes);
  const sorted = sortWork(notes.map(cloneN));
  const out: WorkNote[] = [];
  let added = 0;
  let split = 0;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const beat = tpb(ctx, n.tick);
    const gap = Math.max(1, Math.round(beat / 16));
    const nextT = nextOnset(ctx, n.tick);
    const limit = Math.min(nextT ?? scopeEnd(ctx, n.tick), scopeEnd(ctx, n.tick), n.tick + Math.max(n.duration, beat) + beat * 2);
    const span = limit - n.tick;
    const next = nextT !== undefined ? noteStartingAt(ctx.context, nextT) : undefined;
    if (n.duration >= beat * 0.95 && span >= 2 * beat) {
      const beats = Math.min(4, Math.floor(span / beat));
      n.duration = beat - gap;
      out.push(n);
      split++;
      let prev = n.pitch;
      for (let b = 1; b < beats; b++) {
        const t = n.tick + b * beat;
        const isLast = b === beats - 1 && next !== undefined && nextT !== undefined && nextT - t <= beat * 1.01;
        const p = isLast ? approachTone(ctx, next!.pitch, prev, t) : fillTone(ctx, n, prev, t, b);
        out.push(withSyllable(ctx, { pitch: p, tick: t, duration: beat - gap, velocity: clampVel(n.velocity - 10) }));
        prev = p;
        added++;
      }
    } else if (n.duration >= beat * 0.9 && span >= beat * 0.95 && next) {
      const half = Math.round(span / 2);
      n.duration = half - gap;
      out.push(n);
      out.push(
        withSyllable(ctx, {
          pitch: approachTone(ctx, next.pitch, n.pitch, n.tick + half),
          tick: n.tick + half,
          duration: Math.max(gap, span - half - gap),
          velocity: clampVel(n.velocity - 12),
        }),
      );
      added++;
      split++;
    } else out.push(n);
  }
  return {
    notes: out,
    summary: added
      ? `added ${added} passing/approach tone${added === 1 ? '' : 's'}${split ? ` and subdivided ${split} long note${split === 1 ? '' : 's'}` : ''}`
      : 'the line is already as active as its rhythm allows — no long notes to subdivide',
  };
}

function busierChords(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const out: WorkNote[] = [];
  let strikes = 0;
  for (const g of groupByOnset(sortWork(notes.map(cloneN)))) {
    const t0 = g[0].tick;
    const beat = tpb(ctx, t0);
    const gap = Math.max(1, Math.round(beat / 16));
    const dur = Math.max(...g.map((n) => n.duration));
    const nextT = nextOnset(ctx, t0) ?? t0 + dur;
    const span = Math.min(dur, nextT - t0, scopeEnd(ctx, t0) - t0);
    const step = span >= 2 * beat ? beat : span >= beat ? beat / 2 : 0;
    if (!step) {
      out.push(...g);
      continue;
    }
    const count = Math.floor(span / step);
    for (const n of g) {
      n.duration = Math.round(step - gap);
      out.push(n);
    }
    for (let k = 1; k < count; k++) {
      const t = Math.round(t0 + k * step);
      const accent = (k % 2 === 0 ? 0 : -10) - 4;
      for (const n of g) out.push({ pitch: n.pitch, tick: t, duration: Math.round(step - gap), velocity: clampVel(n.velocity + accent), articulation: n.articulation });
      strikes++;
    }
  }
  return { notes: out, summary: strikes ? `re-articulated sustained chords with ${strikes} extra rhythmic strikes` : 'chords are already articulated rhythmically' };
}

const HAT_PITCHES = new Set<number>([...DRUM_GROUPS.hats, ...DRUM_GROUPS.ride]);
const KICKS = new Set<number>(DRUM_GROUPS.kick);
const SNARES = new Set<number>([GM_DRUM.SNARE, GM_DRUM.SNARE_ELECTRIC, GM_DRUM.CLAP]);
const TOMS = new Set<number>(DRUM_GROUPS.toms);
const CRASHES = new Set<number>(DRUM_GROUPS.crash);

function busierDrums(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const out = notes.map(cloneN);
  const occupied = new Set(ctx.context.map((n) => `${n.pitch}@${n.tick}`));
  const has = (pitch: number, tick: number) => occupied.has(`${pitch}@${tick}`);
  const add = (n: WorkNote) => {
    if (!inScope(ctx, n.tick) || has(n.pitch, n.tick)) return false;
    occupied.add(`${n.pitch}@${n.tick}`);
    out.push(n);
    return true;
  };
  let hats = 0;
  let ghosts = 0;
  let kicks = 0;
  // Hats: halve the subdivision.
  const hatNotes = sortWork(out.filter((n) => HAT_PITCHES.has(n.pitch)));
  for (let i = 0; i + 1 < hatNotes.length; i++) {
    const a = hatNotes[i];
    const b = hatNotes[i + 1];
    const beat = tpb(ctx, a.tick);
    const d = b.tick - a.tick;
    if (d >= beat / 2 - 1 && d <= beat + 1 && (d === Math.round(beat / 2) || d === beat)) {
      const t = a.tick + Math.round(d / 2);
      if (add({ pitch: GM_DRUM.HIHAT_CLOSED === a.pitch || a.pitch === GM_DRUM.HIHAT_OPEN ? GM_DRUM.HIHAT_CLOSED : a.pitch, tick: t, duration: Math.max(30, Math.round(d / 4)), velocity: clampVel(a.velocity * 0.6) }))
        hats++;
    }
  }
  if (!hatNotes.length) {
    for (const r of ctx.ranges) {
      for (let t = r.startTick; t < r.endTick; ) {
        const beat = tpb(ctx, t);
        if (add({ pitch: GM_DRUM.HIHAT_CLOSED, tick: t, duration: Math.round(beat / 4), velocity: frac(posInBar(ctx, t)) < 0.01 ? 80 : 60 })) hats++;
        t += Math.round(beat / 2);
      }
    }
  }
  // Ghost snares before backbeats.
  for (const s of out.filter((n) => SNARES.has(n.pitch) && n.velocity >= 70)) {
    const beat = tpb(ctx, s.tick);
    if (ctx.rng.chance(0.7 * Math.min(1.3, ctx.amount))) {
      if (add({ pitch: GM_DRUM.SNARE, tick: s.tick - Math.round(beat / 4), duration: Math.round(beat / 8), velocity: 34, articulation: 'ghost' })) ghosts++;
    }
  }
  // Extra kicks on the "and" of 3 (or the bar's second half) per bar.
  const bars = new Set(out.map((n) => barIndex(ctx.song, n.tick)));
  for (const b of bars) {
    const start = barToTick(ctx.song, b);
    const beat = tpb(ctx, start);
    const meter = tickToBar(ctx.song, start).meter;
    const pos = meter.numerator >= 4 ? 2.5 : meter.numerator / 2;
    const t = start + Math.round(pos * beat);
    const nearKick = ctx.context.some((n) => KICKS.has(n.pitch) && Math.abs(n.tick - t) < beat / 4);
    if (!nearKick && ctx.rng.chance(0.65)) {
      if (add({ pitch: GM_DRUM.KICK, tick: t, duration: Math.round(beat / 4), velocity: 92 })) kicks++;
    }
  }
  const parts = [hats && `${hats} hi-hat subdivisions`, ghosts && `${ghosts} ghost snares`, kicks && `${kicks} syncopated kicks`].filter(Boolean);
  return { notes: out, summary: parts.length ? `added ${parts.join(', ')}` : 'the groove is already dense — nothing added' };
}

export function simplify(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  if (ctx.isDrums) return simplifyDrums(ctx, notes);
  const sorted = sortWork(notes.map(cloneN));
  if (!sorted.length) return { notes: [], summary: 'no notes to simplify' };
  const totalBeats = sorted.length ? Math.max(1, (sorted[sorted.length - 1].tick + sorted[sorted.length - 1].duration - sorted[0].tick) / tpb(ctx, sorted[0].tick)) : 1;
  const onsets = new Set(sorted.map((n) => n.tick)).size;
  const density = onsets / totalBeats;
  const protectedNote = (n: WorkNote) => ctx.isVocal && !!n.syllable && n.syllable !== '_' && n.syllable !== '-';
  const kept: WorkNote[] = [];
  let removed = 0;
  for (const n of sorted) {
    const beat = tpb(ctx, n.tick);
    const pos = posInBar(ctx, n.tick);
    const f = frac(pos);
    const onBeat = near(f, 0) || near(f, 1);
    const onEighth = onBeat || near(f, 0.5);
    const chord = chordAt(ctx, n.tick);
    const chordTone = chord ? chordPitchClasses(chord).includes(mod12(n.pitch)) : true;
    let drop = false;
    if (!onEighth && n.duration < beat) drop = true;
    else if (!onBeat && density > 1.5 && n.duration < beat && !chordTone) drop = true;
    else if (!onBeat && density > 2.2 && n.duration < beat) drop = true;
    if (drop && protectedNote(n)) drop = false;
    if (drop) removed++;
    else kept.push(n);
  }
  // Merge repeated same-pitch notes (monophonic lines).
  const merged: WorkNote[] = [];
  let mergedCount = 0;
  if (!isPolyphonic(kept)) {
    for (const n of kept) {
      const last = merged[merged.length - 1];
      const beat = tpb(ctx, n.tick);
      if (last && last.pitch === n.pitch && n.tick - (last.tick + last.duration) <= beat / 2 && !protectedNote(n) && n.tick - last.tick <= beat * 2) {
        last.duration = n.tick + n.duration - last.tick;
        mergedCount++;
        continue;
      }
      merged.push(n);
    }
  } else merged.push(...kept);
  // Let remaining notes ring into the space that was freed (up to the next kept onset).
  const final = sortWork(merged);
  for (let i = 0; i < final.length; i++) {
    const n = final[i];
    const nextKept = final.slice(i + 1).find((m) => m.tick > n.tick)?.tick ?? nextOnset(ctx, n.tick, ctx.context.filter((c) => !inScope(ctx, c.tick))) ?? scopeEnd(ctx, n.tick);
    const removedAfter = sorted.filter((m) => m.tick > n.tick && m.tick < nextKept && !final.includes(m));
    if (removedAfter.length) {
      const until = Math.max(...removedAfter.map((m) => m.tick + m.duration));
      const beat = tpb(ctx, n.tick);
      const target = Math.min(until, nextKept - Math.round(beat / 16)) - n.tick;
      if (target > n.duration) n.duration = target;
    }
  }
  const total = removed + mergedCount;
  return {
    notes: final,
    summary: total
      ? `removed ${removed} weak-beat/passing note${removed === 1 ? '' : 's'}${mergedCount ? `, merged ${mergedCount} repeated note${mergedCount === 1 ? '' : 's'}` : ''} and let the remaining notes ring`
      : 'the part is already simple — nothing removed',
  };
}

function simplifyDrums(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const sorted = sortWork(notes.map(cloneN));
  const hatTicks = sorted.filter((n) => HAT_PITCHES.has(n.pitch)).map((n) => posInBar(ctx, n.tick));
  const hatHasSixteenths = hatTicks.some((p) => near(frac(p), 0.25) || near(frac(p), 0.75));
  const kept: WorkNote[] = [];
  let removed = 0;
  for (const n of sorted) {
    const pos = posInBar(ctx, n.tick);
    const f = frac(pos);
    const onBeat = near(f, 0) || near(f, 1);
    const beatIdx = Math.round(pos - f);
    const meter = tickToBar(ctx.song, n.tick).meter;
    const downbeat = onBeat && beatIdx === 0;
    const ghost = n.articulation === 'ghost' || n.velocity < 50;
    let keep: boolean;
    if (KICKS.has(n.pitch)) keep = onBeat && (beatIdx === 0 || (meter.numerator === 4 && beatIdx === 2) || (meter.numerator !== 4 && beatIdx % 2 === 0));
    else if (SNARES.has(n.pitch) || n.pitch === GM_DRUM.SIDE_STICK) keep = onBeat && !ghost && (meter.numerator === 4 ? beatIdx % 2 === 1 : beatIdx > 0);
    else if (HAT_PITCHES.has(n.pitch)) keep = hatHasSixteenths ? onBeat || near(f, 0.5) : onBeat;
    else if (CRASHES.has(n.pitch)) keep = downbeat;
    else if (TOMS.has(n.pitch)) keep = downbeat;
    else keep = onBeat && !ghost;
    if (keep) kept.push(n);
    else removed++;
  }
  return {
    notes: kept,
    summary: removed
      ? `removed ${removed} ghost/fill/off-beat hit${removed === 1 ? '' : 's'}, keeping the downbeats, the backbeat and a steadier ${hatHasSixteenths ? '8th' : 'quarter'}-note pulse`
      : 'the groove is already minimal — nothing removed',
  };
}

// ---------------------------------------------------------------------------
// Harmonic shading, half/double time
// ---------------------------------------------------------------------------

/** Refit pitches to a changed chord timeline (and/or a modal scale map for passing tones). */
export function refitNotes(
  ctx: TransformContext,
  notes: WorkNote[],
  oldSlots: ChordSlot[],
  newSlots: ChordSlot[],
  scaleMapAt?: (tick: number) => ((pc: number) => number) | undefined,
): TransformResult {
  if (ctx.isDrums) return { notes, summary: '' };
  let moved = 0;
  const out = notes.map((n) => {
    const oldC = slotAt(oldSlots, n.tick)?.spec;
    const newC = slotAt(newSlots, n.tick)?.spec;
    const map = scaleMapAt?.(n.tick);
    const p = refitPitch(n.pitch, oldC, newC, map);
    if (p !== n.pitch) {
      moved++;
      return { ...cloneN(n), pitch: p };
    }
    return n;
  });
  return { notes: out, summary: moved ? `re-pitched ${moved} note${moved === 1 ? '' : 's'} to fit` : '' };
}

/** Expressive tendencies for darker (softer, legato, lower) / brighter (lighter, detached, higher). */
export function shadeExpression(ctx: TransformContext, notes: WorkNote[], mood: 'darker' | 'brighter'): TransformResult {
  if (!notes.length) return { notes, summary: '' };
  const out = sortWork(notes.map(cloneN));
  const parts: string[] = [];
  const mid = (ctx.low + ctx.high) / 2;
  const avg = avgPitch(out);
  if (mood === 'darker') {
    for (const n of out) n.velocity = clampVel(n.velocity - Math.round(8 * ctx.amount));
    parts.push('softer dynamics');
    if (!ctx.isDrums) {
      for (let i = 0; i < out.length; i++) {
        const n = out[i];
        const nextT = nextOnset(ctx, n.tick, out) ?? nextOnset(ctx, n.tick);
        const beat = tpb(ctx, n.tick);
        if (nextT !== undefined && nextT - (n.tick + n.duration) > 0 && nextT - n.tick <= n.duration + beat) n.duration = nextT - n.tick - Math.round(beat / 32);
      }
      parts.push('legato phrasing');
      if (ctx.isMelodic && avg > mid + 5 && Math.min(...out.map((n) => n.pitch)) - 12 >= ctx.low) {
        for (const n of out) n.pitch -= 12;
        parts.push('an octave lower register');
      }
    }
  } else {
    for (const n of out) n.velocity = clampVel(n.velocity + Math.round(6 * ctx.amount));
    parts.push('lighter, brighter dynamics');
    if (!ctx.isDrums) {
      for (const n of out) {
        const beat = tpb(ctx, n.tick);
        if (n.duration >= beat / 2) n.duration = Math.max(Math.round(beat / 4), Math.round(n.duration * 0.88));
      }
      parts.push('slightly detached articulation');
      if (ctx.isMelodic && avg < mid - 5 && Math.max(...out.map((n) => n.pitch)) + 12 <= ctx.high) {
        for (const n of out) n.pitch += 12;
        parts.push('an octave higher register');
      }
    }
  }
  return { notes: out, summary: parts.join(', ') };
}

function refitToChordAt(ctx: TransformContext, n: WorkNote, oldTick: number): number {
  if (ctx.isDrums) return n.pitch;
  const oldC = chordAt(ctx, oldTick);
  const newC = chordAt(ctx, n.tick);
  if (!oldC || !newC) return n.pitch;
  const wasChordTone = chordPitchClasses(oldC).includes(mod12(n.pitch));
  if (!wasChordTone) return n.pitch;
  return refitPitch(n.pitch, oldC, newC);
}

/** Half-time feel: the first half of every bar is stretched over the whole bar (snare on 2 → 3). */
export function halfTime(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const out: WorkNote[] = [];
  let dropped = 0;
  for (const n of notes) {
    const start = barToTick(ctx.song, barIndex(ctx.song, n.tick));
    const len = barToTick(ctx.song, barIndex(ctx.song, n.tick) + 1) - start;
    const rel = n.tick - start;
    if (rel >= len / 2 || (ctx.isDrums && (n.articulation === 'ghost' || n.velocity < 45))) {
      dropped++;
      continue;
    }
    const m = cloneN(n);
    m.tick = start + rel * 2;
    m.duration = Math.max(1, Math.min(n.duration * 2, len - rel * 2));
    m.pitch = refitToChordAt(ctx, m, n.tick);
    out.push(m);
  }
  return {
    notes: out,
    summary: ctx.isDrums
      ? 'half-time feel: each bar’s groove stretched ×2 so the backbeat snare lands on beat 3, hats/kicks spaced out'
      : `stretched the rhythm ×2 within each bar (half-time)${dropped ? `, dropping ${dropped} note${dropped === 1 ? '' : 's'} from the second half of bars` : ''}`,
  };
}

/** Double-time feel: each bar's content compressed into half a bar and repeated. */
export function doubleTime(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const out: WorkNote[] = [];
  if (ctx.isVocal) {
    // Vocal lines: compress the whole scope from its start and repeat (keeps phrases intact).
    for (const r of mergeRanges(ctx.ranges)) {
      const inR = notes.filter((n) => n.tick >= r.startTick && n.tick < r.endTick);
      const half = Math.round((r.endTick - r.startTick) / 2);
      for (const n of inR) {
        const m = cloneN(n);
        m.tick = r.startTick + Math.round((n.tick - r.startTick) / 2);
        m.duration = Math.max(1, Math.round(n.duration / 2));
        out.push(m);
        const c = cloneN(m);
        delete c.id;
        c.tick = m.tick + half;
        out.push(c);
      }
    }
    return { notes: out, summary: 'sang the line twice as fast and repeated it (double-time)' };
  }
  for (const n of notes) {
    const b = barIndex(ctx.song, n.tick);
    const start = barToTick(ctx.song, b);
    const len = barToTick(ctx.song, b + 1) - start;
    const rel = n.tick - start;
    const m = cloneN(n);
    m.tick = start + Math.round(rel / 2);
    m.duration = Math.max(1, Math.round(n.duration / 2));
    m.pitch = refitToChordAt(ctx, m, n.tick);
    out.push(m);
    const c = cloneN(m);
    delete c.id;
    c.tick = m.tick + Math.round(len / 2);
    c.pitch = refitToChordAt(ctx, c, n.tick);
    if (inScope(ctx, c.tick)) out.push(c);
  }
  return {
    notes: out,
    summary: ctx.isDrums ? 'double-time feel: each bar’s groove played twice as fast (backbeat on every off-beat)' : 'compressed each bar’s rhythm ×2 and repeated it (double-time)',
  };
}

// ---------------------------------------------------------------------------
// Tension
// ---------------------------------------------------------------------------

export function addTension(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const out = sortWork(notes.map(cloneN));
  if (!out.length && !ctx.isDrums) return { notes: out, summary: 'no notes in range' };
  const ranges = mergeRanges(ctx.ranges);
  const start = ranges[0]?.startTick ?? 0;
  const end = ranges[ranges.length - 1]?.endTick ?? start + 1;
  const parts: string[] = [];
  // Crescendo across the range.
  for (const n of out) {
    const pos = Math.max(0, Math.min(1, (n.tick - start) / Math.max(1, end - start)));
    n.velocity = clampVel(n.velocity + Math.round((-8 + 24 * pos) * ctx.amount));
  }
  parts.push('a crescendo across the range');
  if (ctx.isDrums) {
    // Snare build in the last bar: 8ths then 16ths, rising.
    const lastBar = barIndex(ctx.song, end - 1);
    const barStartT = barToTick(ctx.song, lastBar);
    const beat = tpb(ctx, barStartT);
    const buildStart = Math.max(barStartT + Math.round(beat * 2), start);
    const kept = out.filter((n) => !(SNARES.has(n.pitch) && n.tick >= buildStart && n.tick < end));
    let hits = 0;
    for (let t = buildStart; t < end; ) {
      const lastBeat = end - t <= beat;
      const step = Math.round(lastBeat ? beat / 4 : beat / 2);
      const pos = (t - buildStart) / Math.max(1, end - buildStart);
      kept.push({ pitch: GM_DRUM.SNARE, tick: t, duration: Math.round(step / 2), velocity: clampVel(64 + 50 * pos) });
      hits++;
      t += step;
    }
    parts.push(`a ${hits}-hit snare build into the next bar`);
    return { notes: kept, summary: parts.join(', ') };
  }
  const chordStarts = new Set(ctx.chords.map((c) => c.tick));
  if (isPolyphonic(out)) {
    let ext = 0;
    for (const g of groupByOnset(out)) {
      if (g.length < 2) continue;
      const chord = chordAt(ctx, g[0].tick);
      if (!chord) continue;
      const pcs = new Set(g.map((n) => mod12(n.pitch)));
      const dominant = chordFunction(chord, keyOf(ctx, g[0].tick)) === 'dominant' && triadQuality(chord.quality) === 'maj';
      const candidates = dominant ? [10, 1, 2] : isDominantQuality(chord.quality) ? [2] : triadQuality(chord.quality) === 'min' ? [10, 2] : [2, 11];
      const pc = candidates.map((i) => mod12(chord.root + i)).find((p) => !pcs.has(p) && (isInScale(p, keyOf(ctx, g[0].tick)) || dominant));
      if (pc === undefined) continue;
      const top = Math.max(...g.map((n) => n.pitch));
      let p = nearestWithPc(pc, top - 3);
      if (g.some((n) => Math.abs(n.pitch - p) < 1)) continue;
      p = fold(ctx, p);
      const dur = Math.min(...g.map((n) => n.duration));
      out.push({ pitch: p, tick: g[0].tick, duration: dur, velocity: clampVel(g.reduce((s, n) => s + n.velocity, 0) / g.length - 8) });
      ext++;
    }
    if (ext) parts.push(`added ${ext} chord extension${ext === 1 ? '' : 's'} (7ths/9ths)`);
    return { notes: sortWork(out), summary: parts.join(', ') };
  }
  // Monophonic: suspensions at chord changes + chromatic approach notes.
  const result: WorkNote[] = [];
  let sus = 0;
  let appr = 0;
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    const beat = tpb(ctx, n.tick);
    const chord = chordAt(ctx, n.tick);
    if (chord && chordStarts.has(n.tick) && n.duration >= beat * 0.95) {
      const third = chordTones(chord).find((t) => t.role === 'third');
      if (third && mod12(n.pitch) === third.pc && !ctx.isBass) {
        const fourth = nearestWithPc(mod12(chord.root + 5), n.pitch + 1);
        const half = Math.round(n.duration / 2);
        result.push({ ...n, pitch: fourth, duration: half });
        result.push(withSyllable(ctx, { pitch: n.pitch, tick: n.tick + half, duration: n.duration - half, velocity: clampVel(n.velocity - 6) }));
        sus++;
        continue;
      }
    }
    const nextT = nextOnset(ctx, n.tick);
    const next = nextT !== undefined ? noteStartingAt(ctx.context, nextT) : undefined;
    if (next && nextT !== undefined && chordStarts.has(nextT) && n.duration >= beat * 0.95 && nextT - n.tick >= beat && inScope(ctx, nextT - 1) && appr < 8) {
      const at = nextT - Math.round(beat / 2);
      if (at > n.tick) {
        n.duration = Math.min(n.duration, at - n.tick - Math.round(beat / 32));
        result.push(n);
        const p = ctx.isBass ? next.pitch - 1 : ctx.rng.chance(0.5) ? next.pitch + 1 : next.pitch - 1;
        result.push(withSyllable(ctx, { pitch: fold(ctx, p), tick: at, duration: Math.round(beat / 2) - Math.round(beat / 32), velocity: clampVel(n.velocity + 4) }));
        appr++;
        continue;
      }
    }
    result.push(n);
  }
  if (sus) parts.push(`${sus} suspension${sus === 1 ? '' : 's'} (4–3) at chord changes`);
  if (appr) parts.push(`${appr} chromatic approach note${appr === 1 ? '' : 's'}`);
  return { notes: sortWork(result), summary: parts.join(', ') };
}

// ---------------------------------------------------------------------------
// Answer instead of doubling
// ---------------------------------------------------------------------------

export function answerPhrases(ctx: TransformContext, notes: WorkNote[], reference: WorkNote[]): TransformResult {
  const ref = sortWork(reference.filter((n) => inScope(ctx, n.tick) || inScope(ctx, n.tick + n.duration - 1)).map(cloneN));
  if (!ref.length) return { notes, summary: 'the reference part has no notes in this range, so there is nothing to answer' };
  const beat0 = tpb(ctx, ref[0].tick);
  const sounding = mergeRanges(ref.map((n) => ({ startTick: n.tick - Math.round(beat0 / 8), endTick: n.tick + n.duration + Math.round(beat0 / 8) })));
  const overlapsRef = (n: WorkNote) =>
    sounding.some((s) => {
      const ov = Math.min(s.endTick, n.tick + n.duration) - Math.max(s.startTick, n.tick);
      return (n.tick >= s.startTick && n.tick < s.endTick) || ov > n.duration * 0.25;
    });
  const kept = notes.filter((n) => !overlapsRef(n));
  const removed = notes.length - kept.length;
  const targetCenter = notes.length ? avgPitch(notes) : (ctx.low + ctx.high) / 2 + 2;
  const vel = notes.length ? Math.round(notes.reduce((s, n) => s + n.velocity, 0) / notes.length) : 80;
  const phrases = splitPhrases(ref, Math.round(beat0 / 2));
  const answers: WorkNote[] = [];
  let count = 0;
  for (let i = 0; i < phrases.length; i++) {
    const ph = phrases[i];
    const restStart = Math.max(...ph.map((n) => n.tick + n.duration));
    const nextStart = i + 1 < phrases.length ? phrases[i + 1][0].tick : scopeEnd(ctx, restStart - 1);
    const beat = tpb(ctx, restStart);
    const restEnd = Math.min(nextStart, scopeEnd(ctx, restStart - 1));
    if (restEnd - restStart < beat * 0.95 || !inScope(ctx, restStart)) continue;
    if (kept.some((n) => n.tick >= restStart && n.tick < restEnd)) continue;
    const motif = ph.slice(-4);
    const m0 = motif[0].tick;
    const motifLen = Math.max(1, motif[motif.length - 1].tick + motif[motif.length - 1].duration - m0);
    const avail = restEnd - restStart - Math.round(beat / 4);
    const startAt = restStart + ((Math.round(beat / 2) - ((restStart - barToTick(ctx.song, barIndex(ctx.song, restStart))) % Math.round(beat / 2))) % Math.round(beat / 2));
    const scale = Math.min(1, (avail - (startAt - restStart)) / motifLen);
    if (scale <= 0.2) continue;
    const key = keyOf(ctx, restStart);
    const steps = ctx.rng.pick([2, -2, 0, 4]);
    const shifted = motif.map((n) => transposeDiatonic(n.pitch, steps, key));
    const octave = Math.round((targetCenter - avgPitch(shifted.map((p) => ({ pitch: p })))) / 12) * 12;
    const phraseNotes: WorkNote[] = motif.map((n, k) => ({
      pitch: fold(ctx, shifted[k] + octave),
      tick: startAt + Math.round((n.tick - m0) * scale),
      duration: Math.max(Math.round(beat / 8), Math.round(n.duration * scale) - Math.round(beat / 32)),
      velocity: clampVel(vel - 4 + k * 2),
      articulation: ctx.track.role === 'strings' ? 'legato' : undefined,
    }));
    const last = phraseNotes[phraseNotes.length - 1];
    last.pitch = fold(ctx, nearestChordTone(ctx, last.pitch, last.tick));
    // Let the last note sustain into the rest (but release before the reference re-enters).
    last.duration = Math.max(last.duration, Math.min(restEnd - last.tick - Math.round(beat / 4), beat * 2));
    answers.push(...phraseNotes.filter((n) => n.duration > 0 && inScope(ctx, n.tick)).map(strip));
    count++;
  }
  return {
    notes: sortWork([...kept, ...answers]),
    summary: `removed ${removed} note${removed === 1 ? '' : 's'} that doubled or overlapped the reference part and wrote ${count} answering phrase${count === 1 ? '' : 's'} in its rests (imitating the end of each phrase)`,
  };
}

// ---------------------------------------------------------------------------
// Pitch rewrites: new pitches, inversion, retrograde, transposition, doubling, harmony
// ---------------------------------------------------------------------------

export function newPitchesSameRhythm(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  if (ctx.isDrums) return { notes, summary: 'drum parts have no pitches to change' };
  const sorted = sortWork(notes.map(cloneN));
  if (isPolyphonic(sorted)) {
    let changed = 0;
    for (const g of groupByOnset(sorted)) {
      if (g.length < 2) continue;
      const byPitch = [...g].sort((a, b) => a.pitch - b.pitch);
      if (ctx.rng.chance(0.5)) {
        const low = byPitch[0];
        if (low.pitch + 12 <= ctx.high) low.pitch += 12;
      } else {
        const high = byPitch[byPitch.length - 1];
        if (high.pitch - 12 >= ctx.low) high.pitch -= 12;
      }
      changed++;
    }
    return { notes: sorted, summary: `re-voiced ${changed} chord${changed === 1 ? '' : 's'} (new inversions) with the same rhythm` };
  }
  let prev = sorted[0]?.pitch ?? 60;
  let changed = 0;
  for (const n of sorted) {
    const key = keyOf(ctx, n.tick);
    const chord = chordAt(ctx, n.tick);
    const f = frac(posInBar(ctx, n.tick));
    const strong = near(f, 0) || near(f, 1);
    const scalePcs = scalePitchClasses(key);
    const chordPcs = chord ? chordPitchClasses(chord) : scalePcs;
    let pcs: number[];
    if (ctx.isBass) pcs = strong && chord ? [chord.bass ?? chord.root, ...(ctx.rng.chance(0.25) ? [mod12(chord.root + 7)] : [])] : chordPcs;
    else pcs = strong ? chordPcs : scalePcs;
    const lo = Math.max(ctx.low, n.pitch - 7);
    const hi = Math.min(ctx.high, n.pitch + 7);
    const cands: number[] = [];
    for (let p = lo; p <= hi; p++) if (pcs.includes(mod12(p))) cands.push(p);
    const pool = cands.filter((p) => p !== n.pitch);
    const choices = pool.length ? pool : cands.length ? cands : [n.pitch];
    const weights = choices.map((p) => (1 / (1 + Math.abs(p - prev))) * (chordPcs.includes(mod12(p)) ? 1.5 : 1) * (Math.abs(p - prev) > 7 ? 0.2 : 1));
    const p = ctx.rng.weighted(choices, weights);
    if (p !== n.pitch) changed++;
    n.pitch = p;
    prev = p;
  }
  return { notes: sorted, summary: `wrote new ${ctx.isBass ? 'chord-root/chord-tone' : 'chord-tone (strong beats) and scale-tone'} pitches for ${changed} note${changed === 1 ? '' : 's'}, keeping every onset, duration and velocity` };
}

export function invertMelody(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  if (ctx.isDrums) return { notes, summary: 'drum parts cannot be inverted' };
  const sorted = sortWork(notes.map(cloneN));
  if (!sorted.length) return { notes: sorted, summary: 'no notes' };
  const key = keyOf(ctx, sorted[0].tick);
  const axis = pitchToScaleIndex(sorted[0].pitch, key);
  for (const n of sorted) {
    const k = keyOf(ctx, n.tick);
    const s = pitchToScaleIndex(n.pitch, k);
    n.pitch = scaleIndexToPitch(2 * axis.index - s.index, k) - s.alteration;
  }
  let shift = 0;
  const lo = Math.min(...sorted.map((n) => n.pitch));
  const hi = Math.max(...sorted.map((n) => n.pitch));
  while (lo + shift < ctx.low && hi + shift + 12 <= ctx.high + 12) shift += 12;
  while (hi + shift > ctx.high && lo + shift - 12 >= ctx.low - 12) shift -= 12;
  for (const n of sorted) n.pitch = fold(ctx, n.pitch + shift);
  return { notes: sorted, summary: `mirrored the contour diatonically around the first note (${sorted.length} notes; rhythm unchanged)` };
}

export function reverseNotes(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  if (!notes.length) return { notes, summary: 'no notes' };
  const out: WorkNote[] = [];
  for (const r of mergeRanges(ctx.ranges)) {
    const inR = notes.filter((n) => n.tick >= r.startTick && n.tick < r.endTick);
    if (!inR.length) continue;
    const s = Math.min(...inR.map((n) => n.tick));
    const e = Math.min(r.endTick, Math.max(...inR.map((n) => n.tick + n.duration)));
    for (const n of inR) {
      const m = cloneN(n);
      m.tick = Math.max(s, s + e - (n.tick + n.duration));
      m.duration = Math.min(n.duration, e - m.tick);
      out.push(m);
    }
  }
  return { notes: out, summary: `played ${out.length} notes in reverse order (retrograde)${ctx.isVocal ? ' — lyrics will need re-alignment' : ''}` };
}

export function transposeNotes(ctx: TransformContext, notes: WorkNote[], spec: { semitones?: number; steps?: number }): TransformResult {
  if (ctx.isDrums) return { notes, summary: 'drum parts are not transposed' };
  const out = notes.map((n) => {
    const m = cloneN(n);
    if (spec.steps) m.pitch = transposeDiatonic(m.pitch, spec.steps, keyOf(ctx, m.tick));
    if (spec.semitones) m.pitch += spec.semitones;
    return m;
  });
  return { notes: out, summary: '' };
}

/** Octave register move that keeps the part inside its range. */
export function registerShift(ctx: TransformContext, notes: WorkNote[], dir: 1 | -1): TransformResult {
  if (ctx.isDrums || !notes.length) return { notes, summary: '' };
  const lo = Math.min(...notes.map((n) => n.pitch));
  const hi = Math.max(...notes.map((n) => n.pitch));
  const fits = dir > 0 ? hi + 12 <= ctx.high : lo - 12 >= ctx.low;
  const semis = fits ? 12 * dir : 0;
  if (!semis) {
    const steps = 2 * dir;
    const out = notes.map((n) => ({ ...cloneN(n), pitch: fold(ctx, transposeDiatonic(n.pitch, steps, keyOf(ctx, n.tick))) }));
    return { notes: out, summary: `moved ${dir > 0 ? 'up' : 'down'} a diatonic third (an octave would leave the instrument's range)` };
  }
  return { notes: notes.map((n) => ({ ...cloneN(n), pitch: n.pitch + semis })), summary: `moved ${dir > 0 ? 'up' : 'down'} an octave` };
}

export function octaveDoubling(ctx: TransformContext, source: WorkNote[], semitones: number): TransformResult {
  const out: WorkNote[] = [];
  for (const n of source) {
    const p = n.pitch + semitones;
    const q = p >= ctx.low && p <= ctx.high ? p : fold(ctx, p);
    out.push(strip({ pitch: q, tick: n.tick, duration: n.duration, velocity: clampVel(n.velocity * 0.85), articulation: n.articulation }));
  }
  return { notes: out, summary: `doubled ${out.length} note${out.length === 1 ? '' : 's'} ${semitones >= 0 ? 'an octave higher' : 'an octave lower'}` };
}

export function harmonizeNotes(ctx: TransformContext, source: WorkNote[], steps: number): TransformResult {
  const out: WorkNote[] = [];
  for (const n of source) {
    const key = keyOf(ctx, n.tick);
    let p = transposeDiatonic(n.pitch, steps, key);
    const f = frac(posInBar(ctx, n.tick));
    const chord = chordAt(ctx, n.tick);
    if (chord && (near(f, 0) || near(f, 1)) && !chordPitchClasses(chord).includes(mod12(p))) {
      const alt = transposeDiatonic(n.pitch, steps + (steps > 0 ? -1 : 1), key);
      if (chordPitchClasses(chord).includes(mod12(alt)) && alt !== n.pitch) p = alt;
    }
    out.push(strip({ pitch: fold(ctx, p), tick: n.tick, duration: n.duration, velocity: clampVel(n.velocity - 10), articulation: n.articulation }));
  }
  const label = Math.abs(steps) === 2 ? 'third' : Math.abs(steps) === 5 ? 'sixth' : Math.abs(steps) === 9 ? 'tenth' : `${Math.abs(steps)}-step`;
  return { notes: out, summary: `added a diatonic ${label} ${steps > 0 ? 'above' : 'below'} (${out.length} notes, adjusted to chord tones on strong beats)` };
}

// ---------------------------------------------------------------------------
// Dynamics & articulation
// ---------------------------------------------------------------------------

export function velocityChange(ctx: TransformContext, notes: WorkNote[], add: number): TransformResult {
  return { notes: notes.map((n) => ({ ...cloneN(n), velocity: clampVel(n.velocity + add) })), summary: '' };
}

export function velocityRamp(ctx: TransformContext, notes: WorkNote[], from: number, to: number): TransformResult {
  const ranges = mergeRanges(ctx.ranges);
  const s = ranges[0]?.startTick ?? 0;
  const e = ranges[ranges.length - 1]?.endTick ?? s + 1;
  return {
    notes: notes.map((n) => {
      const pos = Math.max(0, Math.min(1, (n.tick - s) / Math.max(1, e - s)));
      return { ...cloneN(n), velocity: clampVel(n.velocity + Math.round((from + (to - from) * pos) * ctx.amount)) };
    }),
    summary: '',
  };
}

export function expressiveDynamics(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const sorted = sortWork(notes.map(cloneN));
  if (!sorted.length) return { notes: sorted, summary: '' };
  const beat = tpb(ctx, sorted[0].tick);
  const phrases = splitPhrases(sorted, beat);
  for (const ph of phrases) {
    const k = ph.length;
    ph.forEach((n, i) => {
      const arc = Math.sin((Math.PI * (i + 0.5)) / k);
      n.velocity = clampVel(n.velocity + Math.round((arc - 0.45) * 26 * ctx.amount) + 2);
    });
    if (ctx.isMelodic && !ctx.isDrums) {
      for (let i = 0; i + 1 < ph.length; i++) {
        const gap = ph[i + 1].tick - (ph[i].tick + ph[i].duration);
        if (gap > 0 && gap <= beat / 4) ph[i].duration += gap - Math.round(beat / 32);
      }
    }
  }
  return { notes: sorted, summary: `shaped ${phrases.length} phrase${phrases.length === 1 ? '' : 's'} with rising-and-falling dynamics${ctx.isMelodic ? ' and more connected phrasing' : ''}` };
}

export function flattenDynamics(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  if (!notes.length) return { notes, summary: '' };
  const mean = notes.reduce((s, n) => s + n.velocity, 0) / notes.length;
  return { notes: notes.map((n) => ({ ...cloneN(n), velocity: clampVel(mean + (n.velocity - mean) * 0.4) })), summary: 'evened out the velocities (60% less variation)' };
}

export function accentDownbeats(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  let count = 0;
  const out = notes.map((n) => {
    const pos = posInBar(ctx, n.tick);
    if (near(pos, 0)) {
      count++;
      return { ...cloneN(n), velocity: clampVel(n.velocity + 15), articulation: n.articulation === 'normal' || !n.articulation ? ('accent' as const) : n.articulation };
    }
    return n;
  });
  return { notes: out, summary: `accented ${count} downbeat${count === 1 ? '' : 's'}` };
}

export function legatoNotes(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const sorted = sortWork(notes.map(cloneN));
  let changed = 0;
  for (const n of sorted) {
    const nextT = nextOnset(ctx, n.tick, [...sorted, ...ctx.context]);
    const beat = tpb(ctx, n.tick);
    if (nextT === undefined) continue;
    const target = Math.min(nextT - n.tick - Math.round(beat / 32), n.duration * 3);
    if (target > n.duration) {
      n.duration = target;
      changed++;
    }
    if (!ctx.isDrums) n.articulation = 'legato';
  }
  return { notes: sorted, summary: `connected ${changed} note${changed === 1 ? '' : 's'} into the next (legato)` };
}

export function staccatoNotes(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  return {
    notes: notes.map((n) => {
      const beat = tpb(ctx, n.tick);
      return { ...cloneN(n), duration: Math.max(Math.round(beat / 8), Math.min(Math.round(n.duration * 0.5), Math.round(beat / 2))), articulation: 'staccato' as const };
    }),
    summary: '',
  };
}

export function lengthen(ctx: TransformContext, notes: WorkNote[], factor: number): TransformResult {
  const sorted = sortWork(notes.map(cloneN));
  for (const n of sorted) {
    const nextT = nextOnset(ctx, n.tick, [...sorted, ...ctx.context]);
    const beat = tpb(ctx, n.tick);
    const max = nextT !== undefined && !isPolyphonic(sorted) ? nextT - n.tick - Math.round(beat / 32) : Infinity;
    n.duration = Math.max(n.duration, Math.min(Math.round(n.duration * factor), max));
  }
  return { notes: sorted, summary: '' };
}

export function scaleDurations(ctx: TransformContext, notes: WorkNote[], factor: number): TransformResult {
  return { notes: notes.map((n) => ({ ...cloneN(n), duration: Math.max(Math.round(tpb(ctx, n.tick) / 16), Math.round(n.duration * factor)) })), summary: '' };
}

// ---------------------------------------------------------------------------
// Timing: swing, straighten, syncopation, quantize, humanize
// ---------------------------------------------------------------------------

function swingUnit(ctx: TransformContext, notes: WorkNote[]): number {
  const sixteenths = notes.some((n) => {
    const f = frac(posInBar(ctx, n.tick));
    return near(f, 0.25) || near(f, 0.75);
  });
  const beat = notes.length ? tpb(ctx, notes[0].tick) : 480;
  return sixteenths ? beat / 2 : beat;
}

export function swingNotes(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const unit = swingUnit(ctx, notes);
  const shift = Math.round(unit * (2 / 3 - 1 / 2) * Math.min(1, 0.75 * ctx.amount));
  let moved = 0;
  const out = notes.map((n) => {
    const rel = (n.tick - barToTick(ctx.song, barIndex(ctx.song, n.tick))) % unit;
    if (Math.abs(rel - unit / 2) < unit / 12) {
      moved++;
      const m = cloneN(n);
      m.tick += shift;
      m.duration = Math.max(Math.round(unit / 8), m.duration - shift);
      return m;
    }
    if (rel < unit / 12 && Math.abs(n.duration - unit / 2) < unit / 8) return { ...cloneN(n), duration: n.duration + shift };
    return n;
  });
  return { notes: out, summary: `swung ${moved} off-beat ${unit === tpb(ctx, notes[0]?.tick ?? 0) ? '8th' : '16th'} note${moved === 1 ? '' : 's'} toward a triplet feel` };
}

export function straightenNotes(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const unit = notes.length ? tpb(ctx, notes[0].tick) : 480;
  let moved = 0;
  const out = notes.map((n) => {
    const rel = (n.tick - barToTick(ctx.song, barIndex(ctx.song, n.tick))) % unit;
    for (const sub of [unit, unit / 2]) {
      const r = rel % sub;
      if (r > sub / 2 + sub / 24 && r < sub * 0.8) {
        moved++;
        const m = cloneN(n);
        const d = Math.round(r - sub / 2);
        m.tick -= d;
        m.duration += d;
        return m;
      }
    }
    return n;
  });
  return { notes: out, summary: `straightened ${moved} swung note${moved === 1 ? '' : 's'}` };
}

export function syncopateNotes(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const sorted = sortWork(notes.map(cloneN));
  let moved = 0;
  const firstTick = sorted[0]?.tick;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    if (n.tick === firstTick) continue;
    const pos = posInBar(ctx, n.tick);
    const f = frac(pos);
    const beatIdx = Math.round(pos - f);
    const meter = tickToBar(ctx.song, n.tick).meter;
    const strong = near(f, 0) && (beatIdx === 0 || (meter.numerator === 4 && beatIdx === 2));
    if (ctx.isDrums) {
      if (!(KICKS.has(n.pitch) && near(f, 0) && beatIdx === 2)) continue;
    } else if (!strong) continue;
    if (!ctx.rng.chance(Math.min(0.9, 0.55 * ctx.amount))) continue;
    const beat = tpb(ctx, n.tick);
    const shift = Math.round(isPolyphonic(sorted) || ctx.isBass ? beat / 2 : ctx.rng.chance(0.5) ? beat / 2 : beat / 4);
    const newTick = n.tick - shift;
    if (!inScope(ctx, newTick)) continue;
    const group = ctx.isDrums ? [n] : sorted.filter((m) => m.tick === n.tick);
    for (const m of group) {
      m.tick = newTick;
      m.duration += ctx.isDrums ? 0 : shift;
    }
    for (const p of sorted) if (p.tick < newTick && p.tick + p.duration > newTick && !group.includes(p) && !ctx.isDrums) p.duration = Math.max(Math.round(beat / 8), newTick - p.tick);
    moved += group.length;
  }
  return { notes: sortWork(sorted), summary: moved ? `anticipated ${moved} strong-beat note${moved === 1 ? '' : 's'} (pushed ahead of the beat)` : 'no strong-beat notes to push' };
}

export function desyncopateNotes(ctx: TransformContext, notes: WorkNote[]): TransformResult {
  const out: WorkNote[] = [];
  const seen = new Set<string>();
  let moved = 0;
  for (const n of sortWork(notes.map(cloneN))) {
    const beat = tpb(ctx, n.tick);
    const start = barToTick(ctx.song, barIndex(ctx.song, n.tick));
    const q = start + quantizeTick(n.tick - start, beat, 1);
    if (q !== n.tick) {
      moved++;
      n.duration = Math.max(Math.round(beat / 4), n.duration - (q - n.tick));
      n.tick = q;
    }
    const key = `${n.pitch}@${n.tick}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return { notes: out, summary: `moved ${moved} off-beat note${moved === 1 ? '' : 's'} onto the beat` };
}

export function quantizeNotes(ctx: TransformContext, notes: WorkNote[], gridBeats: number, strength: number): TransformResult {
  return {
    notes: notes.map((n) => {
      const start = barToTick(ctx.song, barIndex(ctx.song, n.tick));
      const grid = Math.round(gridBeats * tpb(ctx, n.tick));
      return { ...cloneN(n), tick: start + quantizeTick(n.tick - start, grid, strength) };
    }),
    summary: '',
  };
}

export function humanizeNotes(ctx: TransformContext, notes: WorkNote[], amount: number): TransformResult {
  return {
    notes: notes.map((n) => {
      const beat = tpb(ctx, n.tick);
      const m = cloneN(n);
      m.tick = Math.max(0, m.tick + Math.round(ctx.rng.gaussian(0, (beat / 40) * amount)));
      m.velocity = clampVel(m.velocity + Math.round(ctx.rng.gaussian(0, 9 * amount)));
      return m;
    }),
    summary: '',
  };
}

// ---------------------------------------------------------------------------
// Removal & fills
// ---------------------------------------------------------------------------

export function removeNotes(ctx: TransformContext, notes: WorkNote[], filter?: { drumPitches?: number[]; ghost?: boolean; high?: boolean; low?: boolean }): TransformResult {
  let pred: (n: WorkNote) => boolean = () => true;
  let what = 'all notes in range';
  if (filter?.drumPitches) {
    const set = new Set(filter.drumPitches);
    pred = (n) => set.has(n.pitch);
    what = 'the selected drum voice';
  } else if (filter?.ghost) {
    pred = (n) => n.articulation === 'ghost' || n.velocity < 45;
    what = 'ghost notes';
  } else if (filter?.high || filter?.low) {
    const ps = notes.map((n) => n.pitch).sort((a, b) => a - b);
    const q = ps[Math.floor(ps.length * (filter.high ? 0.75 : 0.25))] ?? 60;
    pred = filter.high ? (n) => n.pitch > q : (n) => n.pitch < q;
    what = filter.high ? 'the highest notes' : 'the lowest notes';
  }
  const kept = notes.filter((n) => !pred(n));
  return { notes: kept, summary: `removed ${notes.length - kept.length} note${notes.length - kept.length === 1 ? '' : 's'} (${what})` };
}

export function addDrumFills(ctx: TransformContext, notes: WorkNote[], everyBars: number): TransformResult {
  const out = notes.map(cloneN);
  const ranges = mergeRanges(ctx.ranges);
  const bars: number[] = [];
  for (const r of ranges) {
    const a = barIndex(ctx.song, r.startTick);
    const b = barIndex(ctx.song, r.endTick - 1);
    for (let x = a; x <= b; x++) if ((x - a + 1) % everyBars === 0 || x === b) bars.push(x);
  }
  const uniqueBars = [...new Set(bars)];
  let fills = 0;
  const toms = [GM_DRUM.TOM_HIGH, GM_DRUM.TOM_HIGH_MID, GM_DRUM.TOM_LOW_MID, GM_DRUM.FLOOR_TOM_HIGH];
  let result = out;
  for (const b of uniqueBars) {
    const end = barToTick(ctx.song, b + 1);
    const beat = tpb(ctx, end - 1);
    const s = end - beat;
    if (!inScope(ctx, s)) continue;
    result = result.filter((n) => !(n.tick >= s && n.tick < end && (HAT_PITCHES.has(n.pitch) || SNARES.has(n.pitch) || TOMS.has(n.pitch))));
    for (let k = 0; k < 4; k++) result.push({ pitch: toms[k], tick: s + Math.round((k * beat) / 4), duration: Math.round(beat / 4), velocity: clampVel(88 + k * 7) });
    fills++;
  }
  return { notes: result, summary: `added ${fills} tom fill${fills === 1 ? '' : 's'} on the last beat of ${everyBars === 1 ? 'the range' : `every ${everyBars} bars`}` };
}
