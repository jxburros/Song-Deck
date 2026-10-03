import type {
  Articulation,
  ChordEvent,
  ChordSpec,
  EditSelection,
  KeySignature,
  MusicOperation,
  Note,
  NoteTransform,
  OpChord,
  OpNote,
  OpRegion,
  Song,
  Ticks,
  Track,
  VocalExpression,
} from '../ir/types';
import { barToTick, chordAtTick, keyAtTick, sectionLayout, tickToBar, tickToMusical, ticksPerBeat, type SectionSpan } from '../timing';
import { LockKeys, isChordSectionLocked, isLocked, isTrackSectionLocked } from '../locks';
import { formatChordSymbol, parseChordSymbol } from '../theory/chords';
import { stableStringify } from '../ir/song-utils';

/**
 * Helpers shared by the musician interpreters: internal ("work") notes in ticks ↔ 1-based
 * `OpNote`s, scopes, lock checks, and emission of compact, lock-respecting operations from a
 * before/after note diff.
 */

// ---------------------------------------------------------------------------
// Work notes
// ---------------------------------------------------------------------------

export interface WorkNote {
  /** Original note id (undefined for notes created by a transform). */
  id?: string;
  pitch: number;
  tick: Ticks;
  duration: Ticks;
  velocity: number;
  articulation?: Articulation;
  syllable?: string;
  expression?: VocalExpression;
}

export interface TickRange {
  startTick: Ticks;
  endTick: Ticks;
}

export function toWork(n: Note): WorkNote {
  const w: WorkNote = { id: n.id, pitch: n.pitch, tick: n.tick, duration: n.duration, velocity: n.velocity };
  if (n.articulation !== undefined) w.articulation = n.articulation;
  if (n.syllable !== undefined) w.syllable = n.syllable;
  if (n.expression !== undefined) w.expression = { ...n.expression };
  return w;
}

export function sortWork<T extends { tick: number; pitch: number }>(notes: T[]): T[] {
  return notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}

export const clampVel = (v: number) => Math.max(1, Math.min(127, Math.round(v)));
export const clampPitch = (p: number) => Math.max(0, Math.min(127, Math.round(p)));
export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
export const round2 = (x: number) => Math.round(x * 100) / 100;
export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Ticks per beat at a tick (meter-aware). */
export function beatTicks(song: Song, tick: Ticks): number {
  return ticksPerBeat(tickToBar(song, tick).meter.denominator, song.ppq);
}

export function barIndex(song: Song, tick: Ticks): number {
  return tickToBar(song, Math.max(0, tick)).bar;
}

export function barStart(song: Song, tick: Ticks): Ticks {
  return barToTick(song, barIndex(song, tick));
}

export function barLength(song: Song, tick: Ticks): Ticks {
  const b = barIndex(song, tick);
  return barToTick(song, b + 1) - barToTick(song, b);
}

/** Beat position (0-based, fractional) within the bar. */
export function beatInBar(song: Song, tick: Ticks): number {
  return tickToBar(song, tick).beat;
}

export function toOpNote(song: Song, n: WorkNote): OpNote {
  const { bar, beat } = tickToMusical(song, n.tick);
  const op: OpNote = {
    pitch: n.pitch,
    bar,
    beat: round6(beat),
    duration_beats: round6(n.duration / beatTicks(song, n.tick)),
    velocity: clampVel(n.velocity),
  };
  if (n.articulation !== undefined && n.articulation !== 'normal') op.articulation = n.articulation;
  if (n.syllable !== undefined) op.syllable = n.syllable;
  if (n.expression !== undefined && Object.keys(n.expression).length) op.expression = { ...n.expression };
  return op;
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export function mergeRanges(ranges: TickRange[]): TickRange[] {
  const sorted = ranges.filter((r) => r.endTick > r.startTick).sort((a, b) => a.startTick - b.startTick);
  const out: TickRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startTick <= last.endTick) last.endTick = Math.max(last.endTick, r.endTick);
    else out.push({ ...r });
  }
  return out;
}

export function intersectRanges(a: TickRange[], b: TickRange[]): TickRange[] {
  const out: TickRange[] = [];
  for (const x of a) for (const y of b) {
    const s = Math.max(x.startTick, y.startTick);
    const e = Math.min(x.endTick, y.endTick);
    if (e > s) out.push({ startTick: s, endTick: e });
  }
  return mergeRanges(out);
}

export function inRanges(ranges: TickRange[], tick: Ticks): boolean {
  return ranges.some((r) => tick >= r.startTick && tick < r.endTick);
}

export function rangeContaining(ranges: TickRange[], tick: Ticks): TickRange | undefined {
  return ranges.find((r) => tick >= r.startTick && tick < r.endTick);
}

export function rangesLength(ranges: TickRange[]): number {
  return ranges.reduce((s, r) => s + (r.endTick - r.startTick), 0);
}

/** End of the song (sections, notes or chords — whichever is last), rounded up to a bar line. */
export function songEndTick(song: Song): Ticks {
  const layout = sectionLayout(song);
  let end = layout.length ? layout[layout.length - 1].endTick : 0;
  for (const t of song.tracks) for (const n of t.notes) end = Math.max(end, n.tick + n.duration);
  for (const c of song.chords) end = Math.max(end, c.tick + c.duration);
  if (end <= 0) return barToTick(song, 1);
  const b = tickToBar(song, end - 1).bar;
  return barToTick(song, b + 1);
}

export function songRange(song: Song): TickRange {
  return { startTick: 0, endTick: songEndTick(song) };
}

/** 1-based inclusive bars covering a tick range. */
export function rangeToRegion(song: Song, r: TickRange): OpRegion {
  const a = tickToBar(song, r.startTick).bar;
  const b = tickToBar(song, Math.max(r.startTick, r.endTick - 1)).bar;
  return { start_bar: a + 1, end_bar: b + 1 };
}

/** Human label for a set of ranges: "bars 5–8" / "bars 1–4, 9–12". */
export function describeRanges(song: Song, ranges: TickRange[]): string {
  if (!ranges.length) return 'nowhere';
  const parts = mergeRanges(ranges).map((r) => {
    const reg = rangeToRegion(song, r);
    return reg.start_bar === reg.end_bar ? `${reg.start_bar}` : `${reg.start_bar}–${reg.end_bar}`;
  });
  return `${parts.length === 1 && !parts[0].includes('–') ? 'bar' : 'bars'} ${parts.join(', ')}`;
}

export function sectionRanges(song: Song, sectionIds: string[]): TickRange[] {
  const layout = sectionLayout(song);
  return mergeRanges(layout.filter((s) => sectionIds.includes(s.section.id)).map((s) => ({ startTick: s.startTick, endTick: s.endTick })));
}

export function sectionsOverlapping(song: Song, ranges: TickRange[]): SectionSpan[] {
  return sectionLayout(song).filter((s) => ranges.some((r) => r.startTick < s.endTick && s.startTick < r.endTick));
}

/** Selection → tick ranges (explicit range, sections, or the extent of selected notes). */
export function selectionRanges(song: Song, sel: EditSelection | undefined): TickRange[] | null {
  if (!sel) return null;
  if (sel.startTick !== undefined || sel.endTick !== undefined) {
    const s = Math.max(0, sel.startTick ?? 0);
    const e = sel.endTick ?? songEndTick(song);
    if (e > s) return [{ startTick: s, endTick: e }];
  }
  if (sel.sectionIds && sel.sectionIds.length) {
    const r = sectionRanges(song, sel.sectionIds);
    if (r.length) return r;
  }
  if (sel.noteIds && sel.noteIds.length) {
    const ids = new Set(sel.noteIds);
    let s = Infinity;
    let e = -Infinity;
    for (const t of song.tracks)
      for (const n of t.notes)
        if (ids.has(n.id)) {
          s = Math.min(s, n.tick);
          e = Math.max(e, n.tick + n.duration);
        }
    if (e > s) return [{ startTick: s, endTick: e }];
  }
  return null;
}

/** Tracks referenced by the selection (explicit track ids, or the tracks owning the selected notes). */
export function selectionTracks(song: Song, sel: EditSelection | undefined): Track[] {
  if (!sel) return [];
  if (sel.trackIds && sel.trackIds.length) return song.tracks.filter((t) => sel.trackIds!.includes(t.id));
  if (sel.noteIds && sel.noteIds.length) {
    const ids = new Set(sel.noteIds);
    return song.tracks.filter((t) => t.notes.some((n) => ids.has(n.id)));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

export function lockedRanges(song: Song, track: Track): TickRange[] {
  if (isLocked(song.locks, LockKeys.track(track.id))) return [{ startTick: 0, endTick: Number.MAX_SAFE_INTEGER }];
  return sectionLayout(song)
    .filter((s) => isTrackSectionLocked(song, track.id, s.section.id))
    .map((s) => ({ startTick: s.startTick, endTick: s.endTick }));
}

/** Fast "is this note protected?" for one track (note lock, track lock, section lock). */
export function lockChecker(song: Song, track: Track): (n: { tick: number; locked?: boolean }) => boolean {
  const ranges = lockedRanges(song, track);
  return (n) => !!n.locked || ranges.some((r) => n.tick >= r.startTick && n.tick < r.endTick);
}

export function isTrackFullyLocked(song: Song, track: Track): boolean {
  return isLocked(song.locks, LockKeys.track(track.id));
}

export function isMixerLocked(song: Song, trackId: string): boolean {
  return isLocked(song.locks, LockKeys.mixer(trackId));
}

/** Sections (names) in the given ranges where the track is locked. */
export function lockedSectionNames(song: Song, track: Track, ranges: TickRange[]): string[] {
  return sectionsOverlapping(song, ranges)
    .filter((s) => isTrackSectionLocked(song, track.id, s.section.id))
    .map((s) => s.section.name);
}

// ---------------------------------------------------------------------------
// Track classification & ranges
// ---------------------------------------------------------------------------

export function isDrumTrack(t: Track): boolean {
  return t.role === 'drums' || t.role === 'percussion' || ['drum-kit', 'electronic-kit', 'percussion'].includes(t.instrumentId) || t.midiChannel === 9;
}

export function isVocalTrack(t: Track): boolean {
  return t.role === 'vocal' || ['lead-vocal', 'backing-vocal'].includes(t.instrumentId);
}

export function isBassTrack(t: Track): boolean {
  return t.role === 'bass' || ['electric-bass', 'synth-bass', 'upright-bass', 'contrabass'].includes(t.instrumentId) || t.constraints.function === 'bass-line';
}

export function isMelodicTrack(t: Track): boolean {
  const f = t.constraints.function;
  return (
    isVocalTrack(t) ||
    f === 'melody' ||
    f === 'counter-melody' ||
    f === 'hook' ||
    f === 'solo' ||
    t.role === 'lead-guitar' ||
    t.role === 'synth-lead' ||
    ['violin', 'flute', 'trumpet', 'saxophone', 'clarinet', 'electric-guitar-lead', 'synth-lead', 'cello'].includes(t.instrumentId)
  );
}

export function isPitchedTrack(t: Track): boolean {
  return t.kind === 'midi' && !isDrumTrack(t);
}

/** Lead melody: lead vocal → melody function → lead instruments → highest pitched part. */
export function findMelodyTrack(song: Song): Track | undefined {
  const withNotes = song.tracks.filter((t) => t.kind === 'midi' && t.notes.length > 0);
  const pool = withNotes.length ? withNotes : song.tracks;
  return (
    pool.find((t) => isVocalTrack(t) && t.instrumentId !== 'backing-vocal' && !/backing|harmony/i.test(t.name)) ??
    pool.find((t) => isVocalTrack(t)) ??
    pool.find((t) => t.constraints.function === 'melody') ??
    pool.find((t) => t.constraints.function === 'hook') ??
    pool.find((t) => t.role === 'synth-lead' || t.role === 'lead-guitar') ??
    pool
      .filter((t) => isPitchedTrack(t) && !isBassTrack(t) && t.notes.length)
      .sort((a, b) => avgPitch(b.notes) - avgPitch(a.notes))[0]
  );
}

export function avgPitch(notes: { pitch: number }[]): number {
  return notes.length ? notes.reduce((s, n) => s + n.pitch, 0) / notes.length : 60;
}

const INSTRUMENT_RANGES: Record<string, [number, number]> = {
  'electric-bass': [28, 67],
  'synth-bass': [24, 72],
  'upright-bass': [28, 67],
  contrabass: [28, 67],
  'electric-guitar-distorted': [40, 88],
  'electric-guitar-clean': [40, 88],
  'acoustic-guitar': [40, 84],
  'electric-guitar-lead': [40, 91],
  piano: [21, 108],
  'electric-piano': [28, 103],
  organ: [36, 96],
  violin: [55, 100],
  viola: [48, 91],
  cello: [36, 76],
  'string-ensemble': [28, 100],
  'pizzicato-strings': [28, 96],
  trumpet: [54, 82],
  trombone: [40, 72],
  'french-horn': [34, 77],
  'brass-section': [40, 82],
  flute: [60, 96],
  clarinet: [50, 91],
  saxophone: [49, 81],
  'synth-pad': [36, 96],
  'synth-lead': [48, 96],
  'synth-arp': [36, 96],
  'synth-seq': [36, 96],
  choir: [40, 81],
  'lead-vocal': [48, 79],
  'backing-vocal': [48, 79],
  harp: [24, 103],
  timpani: [40, 55],
  glockenspiel: [79, 108],
  marimba: [45, 96],
};

const VOICE_RANGES: Record<string, [number, number]> = {
  soprano: [60, 84],
  mezzo: [57, 81],
  alto: [53, 77],
  tenor: [48, 72],
  baritone: [45, 69],
  bass: [40, 64],
};

/** Playable/singable range of a track: constraints → voice type → instrument table → role default. */
export function trackPitchRange(t: Track): { low: number; high: number } {
  let [low, high] = INSTRUMENT_RANGES[t.instrumentId] ?? (isBassTrack(t) ? [28, 67] : isDrumTrack(t) ? [27, 87] : [36, 96]);
  if (isVocalTrack(t) && t.vocal?.voiceType) [low, high] = VOICE_RANGES[t.vocal.voiceType] ?? [low, high];
  if (t.constraints.lowest !== undefined) low = t.constraints.lowest;
  if (t.constraints.highest !== undefined) high = t.constraints.highest;
  return { low, high };
}

/** Fold a pitch into a range by octaves (keeps pitch class). */
export function foldPitch(p: number, low: number, high: number): number {
  let x = Math.round(p);
  if (high - low < 12) return Math.max(low, Math.min(high, x));
  while (x < low) x += 12;
  while (x > high) x -= 12;
  return x;
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

export function chordSpecOf(c: ChordEvent): ChordSpec {
  const spec: ChordSpec = { root: c.root, quality: c.quality };
  if (c.bass !== undefined && c.bass !== c.root) spec.bass = c.bass;
  if (spec.quality === undefined) {
    const p = parseChordSymbol(c.symbol);
    if (p) return p;
  }
  return spec;
}

export function chordSpecAt(song: Song, tick: Ticks): ChordSpec | undefined {
  const c = chordAtTick(song, tick);
  return c ? chordSpecOf(c) : undefined;
}

export function keyAt(song: Song, tick: Ticks): KeySignature {
  return keyAtTick(song, tick);
}

export interface ChordSlot {
  tick: Ticks;
  duration: Ticks;
  spec: ChordSpec;
  /** Id of the chord event this slot replaces (or comes from). */
  sourceId?: string;
}

/** Chord timeline (sorted, non-overlapping view of song.chords). */
export function chordSlots(song: Song): ChordSlot[] {
  return [...song.chords]
    .sort((a, b) => a.tick - b.tick)
    .map((c) => ({ tick: c.tick, duration: c.duration, spec: chordSpecOf(c), sourceId: c.id }));
}

export function slotAt(slots: ChordSlot[], tick: Ticks): ChordSlot | undefined {
  let found: ChordSlot | undefined;
  for (const s of slots) if (s.tick <= tick && tick < s.tick + s.duration) found = s;
  return found;
}

function sameSpec(a: ChordSpec, b: ChordSpec): boolean {
  return a.root === b.root && a.quality === b.quality && (a.bass ?? a.root) === (b.bass ?? b.root);
}

export function toOpChord(song: Song, tick: Ticks, duration: Ticks, spec: ChordSpec, key?: KeySignature): OpChord {
  const { bar, beat } = tickToMusical(song, tick);
  return {
    bar,
    beat: round6(beat),
    symbol: formatChordSymbol(spec, key ?? keyAtTick(song, tick)),
    duration_beats: round6(duration / beatTicks(song, tick)),
  };
}

/**
 * `set_chords` operations for a modified chord timeline. Changed chords are grouped into bar runs
 * (split at section boundaries); runs in chord-locked sections are skipped and reported.
 */
export function chordOpsFromSlots(
  song: Song,
  finalSlots: ChordSlot[],
  reason: string,
): { ops: MusicOperation[]; lockedSections: string[]; changed: number } {
  const original = chordSlots(song);
  const bySource = new Map<string, ChordSlot[]>();
  for (const s of finalSlots) if (s.sourceId) bySource.set(s.sourceId, [...(bySource.get(s.sourceId) ?? []), s]);
  const changedBars = new Set<number>();
  let changed = 0;
  for (const o of original) {
    const repl = o.sourceId ? bySource.get(o.sourceId) : undefined;
    const same = repl && repl.length === 1 && repl[0].tick === o.tick && repl[0].duration === o.duration && sameSpec(repl[0].spec, o.spec);
    if (same) continue;
    changed++;
    const a = barIndex(song, o.tick);
    const b = barIndex(song, o.tick + Math.max(1, o.duration) - 1);
    for (let x = a; x <= b; x++) changedBars.add(x);
  }
  for (const s of finalSlots)
    if (!s.sourceId) {
      changed++;
      const a = barIndex(song, s.tick);
      const b = barIndex(song, s.tick + Math.max(1, s.duration) - 1);
      for (let x = a; x <= b; x++) changedBars.add(x);
    }
  if (!changedBars.size) return { ops: [], lockedSections: [], changed: 0 };
  const layout = sectionLayout(song);
  const sectionOfBar = (bar: number) => layout.find((s) => bar >= s.startBar && bar < s.endBar);
  const bars = [...changedBars].sort((a, b) => a - b);
  const runs: { start: number; end: number }[] = [];
  for (const b of bars) {
    const last = runs[runs.length - 1];
    if (last && b === last.end + 1 && sectionOfBar(b)?.section.id === sectionOfBar(last.end)?.section.id) last.end = b;
    else runs.push({ start: b, end: b });
  }
  const ops: MusicOperation[] = [];
  const lockedSections = new Set<string>();
  for (const run of runs) {
    const sec = sectionOfBar(run.start);
    if (sec && isChordSectionLocked(song, sec.section.id)) {
      lockedSections.add(sec.section.name);
      continue;
    }
    if (!sec && isLocked(song.locks, LockKeys.chords)) {
      lockedSections.add('song');
      continue;
    }
    const startTick = barToTick(song, run.start);
    const endTick = barToTick(song, run.end + 1);
    const chords: OpChord[] = [];
    for (const s of [...finalSlots].sort((a, b) => a.tick - b.tick)) {
      const st = Math.max(s.tick, startTick);
      const en = Math.min(s.tick + s.duration, endTick);
      if (en > st) chords.push(toOpChord(song, st, en - st, s.spec));
    }
    ops.push({ op: 'set_chords', region: { start_bar: run.start + 1, end_bar: run.end + 1 }, chords, reason });
  }
  return { ops, lockedSections: [...lockedSections], changed };
}

// ---------------------------------------------------------------------------
// Note diff → operations
// ---------------------------------------------------------------------------

export interface NoteDiff {
  removed: Note[];
  added: WorkNote[];
  modified: { before: Note; after: WorkNote }[];
}

function sameExpression(a?: VocalExpression, b?: VocalExpression): boolean {
  return stableStringify(a ?? {}) === stableStringify(b ?? {});
}

export function diffNotes(original: Note[], final: WorkNote[]): NoteDiff {
  const byId = new Map(original.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const added: WorkNote[] = [];
  const modified: { before: Note; after: WorkNote }[] = [];
  for (const f of final) {
    const b = f.id ? byId.get(f.id) : undefined;
    if (!b || seen.has(b.id)) {
      added.push({ ...f, id: undefined });
      continue;
    }
    seen.add(b.id);
    const changed =
      b.pitch !== f.pitch ||
      b.tick !== f.tick ||
      b.duration !== f.duration ||
      clampVel(b.velocity) !== clampVel(f.velocity) ||
      (b.articulation ?? 'normal') !== (f.articulation ?? 'normal') ||
      (b.syllable ?? '') !== (f.syllable ?? '') ||
      !sameExpression(b.expression, f.expression);
    if (changed) modified.push({ before: b, after: f });
  }
  const removed = original.filter((n) => !seen.has(n.id));
  return { removed, added, modified };
}

export interface EmitOptions {
  reason: string;
  /** Maximum number of distinct transform groups before falling back to replace_notes. */
  maxGroups?: number;
}

export interface EmitResult {
  ops: MusicOperation[];
  added: number;
  removed: number;
  modified: number;
}

/**
 * Emit the most compact operations that turn `original` into `final` for one track:
 *   only removals → delete_notes · only additions → add_notes · only per-note changes →
 *   grouped transform_notes / set_expression · anything structural → replace_notes over
 *   the affected bar runs (never across bars holding locked notes).
 */
export function emitNoteOps(song: Song, track: Track, original: Note[], final: WorkNote[], opts: EmitOptions): EmitResult {
  const diff = diffNotes(original, final);
  const res: EmitResult = { ops: [], added: diff.added.length, removed: diff.removed.length, modified: diff.modified.length };
  if (!diff.added.length && !diff.removed.length && !diff.modified.length) return res;
  const reason = opts.reason;
  const syllableChange = diff.modified.some((m) => (m.before.syllable ?? '') !== (m.after.syllable ?? ''));
  const kinds = (diff.added.length ? 1 : 0) + (diff.removed.length ? 1 : 0) + (diff.modified.length ? 1 : 0);
  if (kinds === 1 && !syllableChange) {
    if (diff.removed.length) {
      res.ops.push({ op: 'delete_notes', track: track.id, note_ids: diff.removed.map((n) => n.id), reason });
      return res;
    }
    if (diff.added.length) {
      res.ops.push({ op: 'add_notes', track: track.id, notes: sortWork([...diff.added]).map((n) => toOpNote(song, n)), reason });
      return res;
    }
    const grouped = transformGroups(song, track, original, diff.modified, reason);
    if (grouped.transformOps <= (opts.maxGroups ?? 24)) {
      res.ops.push(...grouped.ops);
      return res;
    }
  }
  res.ops.push(...replaceOps(song, track, original, final, diff, reason));
  return res;
}

function transformGroups(
  song: Song,
  track: Track,
  original: Note[],
  modified: { before: Note; after: WorkNote }[],
  reason: string,
): { ops: MusicOperation[]; transformOps: number } {
  const groups = new Map<string, { transform: NoteTransform; ids: string[] }>();
  const exprGroups = new Map<string, { expression: VocalExpression; ids: string[] }>();
  for (const { before: b, after: a } of modified) {
    const t: NoteTransform = {};
    if (a.pitch !== b.pitch) t.transpose = a.pitch - b.pitch;
    if (clampVel(a.velocity) !== clampVel(b.velocity)) t.velocity_add = clampVel(a.velocity) - clampVel(b.velocity);
    if (a.tick !== b.tick) t.time_shift_beats = round6((a.tick - b.tick) / beatTicks(song, b.tick));
    if (a.duration !== b.duration) t.duration_scale = round6(a.duration / Math.max(1, b.duration));
    if ((a.articulation ?? 'normal') !== (b.articulation ?? 'normal')) t.articulation = a.articulation ?? 'normal';
    if (Object.keys(t).length) {
      const key = stableStringify(t);
      const g = groups.get(key) ?? { transform: t, ids: [] };
      g.ids.push(b.id);
      groups.set(key, g);
    }
    if (!sameExpression(a.expression, b.expression)) {
      const e = a.expression ?? {};
      const key = stableStringify(e);
      const g = exprGroups.get(key) ?? { expression: e, ids: [] };
      g.ids.push(b.id);
      exprGroups.set(key, g);
    }
  }
  const ops: MusicOperation[] = [];
  for (const g of groups.values()) {
    const region = exactRegion(song, original, g.ids);
    if (region) ops.push({ op: 'transform_notes', track: track.id, region, transform: g.transform, reason });
    else ops.push({ op: 'transform_notes', track: track.id, note_ids: g.ids, transform: g.transform, reason });
  }
  for (const g of exprGroups.values()) {
    const region = exactRegion(song, original, g.ids);
    if (region) ops.push({ op: 'set_expression', track: track.id, region, expression: g.expression, reason });
    else ops.push({ op: 'set_expression', track: track.id, note_ids: g.ids, expression: g.expression, reason });
  }
  return { ops, transformOps: groups.size + exprGroups.size };
}

/** A whole-bar region whose notes are exactly `ids` (so a region op is equivalent to the id list). */
export function exactRegion(song: Song, original: Note[], ids: string[]): OpRegion | null {
  if (!ids.length) return null;
  const idSet = new Set(ids);
  const notes = original.filter((n) => idSet.has(n.id));
  if (notes.length !== idSet.size) return null;
  const a = Math.min(...notes.map((n) => barIndex(song, n.tick)));
  const b = Math.max(...notes.map((n) => barIndex(song, n.tick)));
  const s = barToTick(song, a);
  const e = barToTick(song, b + 1);
  const inBars = original.filter((n) => n.tick >= s && n.tick < e);
  if (inBars.length !== notes.length || inBars.some((n) => !idSet.has(n.id) || n.locked)) return null;
  return { start_bar: a + 1, end_bar: b + 1 };
}

function replaceOps(song: Song, track: Track, original: Note[], final: WorkNote[], diff: NoteDiff, reason: string): MusicOperation[] {
  const affected = new Set<number>();
  const mark = (tick: number) => affected.add(barIndex(song, tick));
  diff.removed.forEach((n) => mark(n.tick));
  diff.added.forEach((n) => mark(n.tick));
  diff.modified.forEach((m) => {
    mark(m.before.tick);
    mark(m.after.tick);
  });
  const isLockedFn = lockChecker(song, track);
  const blocked = new Set<number>();
  for (const n of original) if (isLockedFn(n)) blocked.add(barIndex(song, n.tick));
  const layout = sectionLayout(song);
  const secOf = (bar: number) => layout.find((s) => bar >= s.startBar && bar < s.endBar)?.section.id ?? '';
  const runBars = [...affected].filter((b) => !blocked.has(b)).sort((a, b) => a - b);
  const runs: { start: number; end: number }[] = [];
  for (const b of runBars) {
    const last = runs[runs.length - 1];
    if (last && b === last.end + 1 && secOf(b) === secOf(last.end)) last.end = b;
    else runs.push({ start: b, end: b });
  }
  const inRun = (tick: number) => {
    const b = barIndex(song, tick);
    return runs.some((r) => b >= r.start && b <= r.end);
  };
  const ops: MusicOperation[] = [];
  // Fallback for bars that also hold locked notes: identity-preserving per-note ops.
  const delIds: string[] = [];
  const adds: WorkNote[] = [];
  const mods: { before: Note; after: WorkNote }[] = [];
  for (const n of diff.removed) if (!inRun(n.tick)) delIds.push(n.id);
  for (const n of diff.added) if (!inRun(n.tick)) adds.push(n);
  for (const m of diff.modified) {
    const bIn = inRun(m.before.tick);
    const aIn = inRun(m.after.tick);
    if (!bIn && !aIn) mods.push(m);
    else if (bIn && !aIn) adds.push({ ...m.after, id: undefined });
    else if (!bIn && aIn) delIds.push(m.before.id);
  }
  if (delIds.length) ops.push({ op: 'delete_notes', track: track.id, note_ids: delIds, reason });
  for (const run of runs) {
    const s = barToTick(song, run.start);
    const e = barToTick(song, run.end + 1);
    const notes = sortWork(final.filter((n) => n.tick >= s && n.tick < e)).map((n) => toOpNote(song, n));
    ops.push({ op: 'replace_notes', track: track.id, region: { start_bar: run.start + 1, end_bar: run.end + 1 }, notes, reason });
  }
  if (adds.length) ops.push({ op: 'add_notes', track: track.id, notes: sortWork(adds).map((n) => toOpNote(song, n)), reason });
  if (mods.length) ops.push(...transformGroups(song, track, original, mods, reason).ops);
  return ops;
}

/**
 * Uniform transform over the editable notes of a scope: a region op per whole-bar run when
 * the run holds exactly those notes, otherwise an explicit note-id list.
 */
export function uniformTransformOps(song: Song, track: Track, editable: Note[], transform: NoteTransform, reason: string): MusicOperation[] {
  if (!editable.length) return [];
  const original = track.notes;
  const byBar = new Map<number, Note[]>();
  for (const n of editable) {
    const b = barIndex(song, n.tick);
    byBar.set(b, [...(byBar.get(b) ?? []), n]);
  }
  const editableIds = new Set(editable.map((n) => n.id));
  const fullBars = new Set<number>();
  for (const [b, ns] of byBar) {
    const s = barToTick(song, b);
    const e = barToTick(song, b + 1);
    const all = original.filter((n) => n.tick >= s && n.tick < e);
    if (all.length === ns.length && all.every((n) => editableIds.has(n.id) && !n.locked)) fullBars.add(b);
  }
  const ops: MusicOperation[] = [];
  const sorted = [...fullBars].sort((a, b) => a - b);
  const runs: { start: number; end: number }[] = [];
  for (const b of sorted) {
    const last = runs[runs.length - 1];
    if (last && b === last.end + 1) last.end = b;
    else runs.push({ start: b, end: b });
  }
  for (const r of runs) ops.push({ op: 'transform_notes', track: track.id, region: { start_bar: r.start + 1, end_bar: r.end + 1 }, transform, reason });
  const rest = editable.filter((n) => !fullBars.has(barIndex(song, n.tick)));
  if (rest.length) ops.push({ op: 'transform_notes', track: track.id, note_ids: rest.map((n) => n.id), transform, reason });
  return ops;
}

/** Pitch name helper for explanations. */
export function sectionNameAt(song: Song, tick: Ticks): string | undefined {
  return sectionLayout(song).find((s) => tick >= s.startTick && tick < s.endTick)?.section.name;
}
