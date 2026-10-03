import type {
  InstrumentProfile,
  LockMap,
  MusicOperation,
  Note,
  OpNote,
  Section,
  Song,
  Track,
  VocalExpression,
} from '../ir/types';
import type { IdFactory } from '../util/ids';
import { findTrack, sortNotes } from '../ir/song-utils';
import { beatsToTicks, findSection, musicalToTick, regionToTicks, sectionLayout, songLengthBars, songLengthTicks, tickToBar } from '../timing';
import { parsePitch } from '../theory/pitch';
import { lookupInstrument, type InstrumentLookupOptions, type InstrumentResolver } from './instruments';
import { parseLocks, type ParsedLocks } from './locks-check';
import { ARTICULATIONS, IdAllocator, IssueList, SectionLocator, clampNum, isRecord, oneOf, toNumber, toStr } from './util';

export type RegenerateOperation = Extract<MusicOperation, { op: 'regenerate' }>;

export interface ApplyOptions {
  /** Reject operations that touch locked material (default true). */
  respectLocks?: boolean;
  /** Repair fixable problems (out-of-range notes, overlaps, clamped values) instead of only reporting them (default true). */
  autoFix?: boolean;
  /** Regeneration engine for `regenerate` operations (wire composer's `regenerateUnlocked`). */
  regenerate?: (song: Song, op: RegenerateOperation) => Song;
  /** Project-bundled instrument profiles. */
  customInstruments?: InstrumentProfile[];
  /** Instrument resolver (wire composer's `getInstrument`); falls back to a built-in table. */
  resolveInstrument?: InstrumentResolver;
  /** Deterministic id source (generators); random ids otherwise. */
  ids?: IdFactory;
  /** Author recorded on lyric lines written by `set_lyrics` (rights metadata), e.g. a provider id. */
  author?: string;
}

/** Mutable state threaded through one `applyOperations` call. */
export interface OpContext {
  readonly opIndex: number;
  readonly respectLocks: boolean;
  readonly autoFix: boolean;
  readonly opts: ApplyOptions;
  readonly instruments: InstrumentLookupOptions;
  readonly ids: IdAllocator;
  /** Locks in effect for this batch: the input song's locks plus locks added by earlier ops. */
  readonly locks: ParsedLocks;
  readonly lockMap: LockMap;
  /** Note ids created or modified by this operation, per track. */
  readonly touched: Map<string, Set<string>>;
  error(code: string, message: string, extra?: IssueExtra): void;
  warn(code: string, message: string, extra?: IssueExtra): void;
  info(code: string, message: string, extra?: IssueExtra): void;
  addLock(key: string): void;
  touch(trackId: string, noteId: string): void;
}

type IssueExtra = { trackId?: string; noteId?: string; sectionId?: string; fixed?: boolean };

export function createOpContext(
  opIndex: number,
  issues: IssueList,
  opts: ApplyOptions,
  ids: IdAllocator,
  lockMap: LockMap,
): OpContext {
  const touched = new Map<string, Set<string>>();
  const ctx: OpContext = {
    opIndex,
    respectLocks: opts.respectLocks !== false,
    autoFix: opts.autoFix !== false,
    opts,
    instruments: { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument },
    ids,
    locks: parseLocks(lockMap),
    lockMap,
    touched,
    error: (code, message, extra = {}) => issues.error(code, message, { ...extra, opIndex }),
    warn: (code, message, extra = {}) => issues.warn(code, message, { ...extra, opIndex }),
    info: (code, message, extra = {}) => issues.info(code, message, { ...extra, opIndex }),
    addLock: (key) => {
      lockMap[key] = true;
      Object.assign(ctx.locks, parseLocks(lockMap));
    },
    touch: (trackId, noteId) => {
      let set = touched.get(trackId);
      if (!set) touched.set(trackId, (set = new Set()));
      set.add(noteId);
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

export function resolveTrack(song: Song, ref: unknown, c: OpContext, opName: string): Track | undefined {
  const r = toStr(ref)?.trim();
  if (!r) {
    c.error('op.malformed', `${opName}: missing "track" reference.`);
    return undefined;
  }
  const t = findTrack(song, r);
  if (!t) c.error('track.not-found', `${opName}: track "${r}" not found.`);
  return t;
}

export function resolveMidiTrack(song: Song, ref: unknown, c: OpContext, opName: string): Track | undefined {
  const t = resolveTrack(song, ref, c, opName);
  if (t && t.kind !== 'midi') {
    c.error('track.not-midi', `${opName}: "${t.name}" is an audio track and has no notes.`, { trackId: t.id });
    return undefined;
  }
  return t;
}

export function resolveSection(song: Song, ref: unknown, c: OpContext, opName: string): Section | undefined {
  const r = toStr(ref)?.trim();
  if (!r) {
    c.error('op.malformed', `${opName}: missing "section" reference.`);
    return undefined;
  }
  const s = findSection(song, r) ?? findSectionLoose(song, r);
  if (!s) c.error('section.not-found', `${opName}: section "${r}" not found.`);
  return s;
}

/** "chorus" → first section of kind chorus; "chorus 2" → second chorus. */
function findSectionLoose(song: Song, ref: string): Section | undefined {
  const m = /^\s*([a-z-]+?)\s*(\d+)?\s*$/i.exec(ref.replace(/_/g, '-'));
  if (!m) return undefined;
  const kind = m[1].toLowerCase();
  const nth = m[2] ? parseInt(m[2], 10) : 1;
  const matches = song.sections.filter((s) => s.kind === kind || s.name.toLowerCase().startsWith(kind));
  return matches[nth - 1];
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export interface ResolvedRegion {
  /** 1-based inclusive bars as requested (after clamping). */
  startBar1: number;
  endBar1: number;
  startTick: number;
  endTick: number;
}

/** Parse an OpRegion. Returns undefined (no region) when absent and optional, null on error. */
export function parseRegion(song: Song, raw: unknown, c: OpContext, opName: string, required: boolean): ResolvedRegion | undefined | null {
  if (raw === undefined || raw === null) {
    if (required) {
      c.error('op.malformed', `${opName}: missing "region".`);
      return null;
    }
    return undefined;
  }
  if (!isRecord(raw)) {
    c.error('region.invalid', `${opName}: "region" must be an object with start_bar and end_bar.`);
    return null;
  }
  let start = toNumber(raw.start_bar ?? raw.startBar ?? raw.start);
  let end = toNumber(raw.end_bar ?? raw.endBar ?? raw.end);
  if (start === undefined && end !== undefined) start = end;
  if (end === undefined && start !== undefined) end = start;
  if (start === undefined || end === undefined) {
    c.error('region.invalid', `${opName}: region needs numeric start_bar and end_bar.`);
    return null;
  }
  start = Math.floor(start);
  end = Math.floor(end);
  if (start > end) {
    [start, end] = [end, start];
    c.warn('region.invalid', `${opName}: region start and end were reversed; swapped to bars ${start}–${end}.`, { fixed: true });
  }
  if (end < 1) {
    c.error('region.outside', `${opName}: region bars ${start}–${end} are before the start of the song (bars are 1-based).`);
    return null;
  }
  if (start < 1) {
    c.warn('region.outside', `${opName}: region clamped to start at bar 1.`, { fixed: true });
    start = 1;
  }
  const total = songLengthBars(song);
  if (total > 0) {
    if (start > total) {
      c.error('region.outside', `${opName}: region bars ${start}–${end} are past the end of the song (${total} bars).`);
      return null;
    }
    if (end > total) {
      c.warn('region.outside', `${opName}: region clamped to the end of the song (bar ${total}).`, { fixed: true });
      end = total;
    }
  }
  const { startTick, endTick } = regionToTicks(song, { start_bar: start, end_bar: end });
  return { startBar1: start, endBar1: end, startTick, endTick };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function parseExpression(raw: unknown, c: OpContext, opName: string): VocalExpression | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    c.warn('expression.invalid', `${opName}: "expression" must be an object; ignored.`);
    return undefined;
  }
  const out: VocalExpression = {};
  for (const k of ['breathiness', 'tension', 'vibrato', 'energy'] as const) {
    if (raw[k] === undefined) continue;
    const v = toNumber(raw[k]);
    if (v === undefined) c.warn('expression.invalid', `${opName}: expression.${k} is not a number; ignored.`);
    else out[k] = clampNum(v, 0, 1);
  }
  if (raw.vibratoRate !== undefined) {
    const v = toNumber(raw.vibratoRate);
    if (v === undefined) c.warn('expression.invalid', `${opName}: expression.vibratoRate is not a number; ignored.`);
    else out.vibratoRate = clampNum(v, 0.5, 12);
  }
  const onset = oneOf(raw.onset, ['soft', 'normal', 'hard', 'scoop'] as const);
  if (raw.onset !== undefined && !onset) c.warn('expression.invalid', `${opName}: unknown expression.onset "${String(raw.onset)}"; ignored.`);
  if (onset) out.onset = onset;
  const release = oneOf(raw.release, ['normal', 'falling', 'rising', 'breathy', 'cut'] as const);
  if (raw.release !== undefined && !release) c.warn('expression.invalid', `${opName}: unknown expression.release "${String(raw.release)}"; ignored.`);
  if (release) out.release = release;
  return Object.keys(out).length ? out : undefined;
}

/** Validate an untrusted OpNote. Returns null (with an issue) when unusable. */
export function parseOpNote(song: Song, raw: unknown, c: OpContext, opName: string, index: number, trackId?: string): Omit<Note, 'id'> | null {
  const where = `${opName}: note #${index + 1}`;
  const bad = (msg: string) => {
    c.warn('note.invalid', `${where} ${msg}; note dropped.`, { trackId });
    return null;
  };
  if (!isRecord(raw)) return bad('is not an object');
  const rawPitch = raw.pitch;
  let pitch: number | null = typeof rawPitch === 'number' || typeof rawPitch === 'string' ? parsePitch(rawPitch) : null;
  if (pitch === null) return bad(`has an invalid pitch (${JSON.stringify(rawPitch)})`);
  if (pitch < 0 || pitch > 127) {
    if (!c.autoFix) return bad(`has pitch ${pitch} outside MIDI 0–127`);
    const fixed = foldMidi(pitch);
    c.warn('note.invalid', `${where} pitch ${pitch} outside MIDI 0–127 moved to ${fixed}.`, { trackId, fixed: true });
    pitch = fixed;
  }
  const bar = toNumber(raw.bar);
  if (bar === undefined || bar < 1) return bad(`has an invalid bar (${JSON.stringify(raw.bar)}; bars are 1-based)`);
  const beat = raw.beat === undefined ? 1 : toNumber(raw.beat);
  if (beat === undefined || beat < 1) return bad(`has an invalid beat (${JSON.stringify(raw.beat)}; beats are 1-based)`);
  const tick = musicalToTick(song, Math.floor(bar), beat);
  if (!Number.isFinite(tick) || tick < 0) return bad('has an invalid position');
  let durBeats = toNumber(raw.duration_beats ?? raw.duration ?? raw.durationBeats);
  if (durBeats === undefined) {
    if (!c.autoFix) return bad('has no duration_beats');
    durBeats = 1;
    c.warn('note.duration', `${where} had no duration; set to 1 beat.`, { trackId, fixed: true });
  } else if (durBeats <= 0) {
    if (!c.autoFix) return bad(`has a non-positive duration (${durBeats})`);
    durBeats = 0.25;
    c.warn('note.duration', `${where} had a non-positive duration; set to a sixteenth.`, { trackId, fixed: true });
  }
  const duration = Math.max(1, beatsToTicks(song, durBeats, tick));
  let velocity = 90;
  if (raw.velocity !== undefined && raw.velocity !== null) {
    const v = toNumber(raw.velocity);
    if (v === undefined) return bad(`has an invalid velocity (${JSON.stringify(raw.velocity)})`);
    if (v > 0 && v < 1) velocity = Math.max(1, Math.round(v * 127));
    else if (v < 1 || v > 127) {
      if (!c.autoFix) return bad(`has velocity ${v} outside 1–127`);
      velocity = Math.round(clampNum(v, 1, 127));
      c.warn('note.velocity', `${where} velocity ${v} clamped to ${velocity}.`, { trackId, fixed: true });
    } else velocity = Math.round(v);
  }
  const note: Omit<Note, 'id'> = { pitch, tick, duration, velocity };
  if (raw.articulation !== undefined) {
    const a = oneOf(raw.articulation, ARTICULATIONS);
    if (a) note.articulation = a;
    else c.warn('note.invalid', `${where} has unknown articulation "${String(raw.articulation)}"; ignored.`, { trackId });
  }
  const syl = toStr(raw.syllable);
  if (syl !== undefined && syl.trim() !== '') note.syllable = syl.trim();
  const expr = parseExpression(raw.expression, c, opName);
  if (expr) note.expression = expr;
  return note;
}

export function foldMidi(p: number): number {
  let v = Math.round(p);
  while (v < 0) v += 12;
  while (v > 127) v -= 12;
  return v;
}

/** 1-based bar/beat helpers (exported publicly via edit/index). */
export function noteToOpNote(song: Song, note: Note): OpNote {
  const pos = tickToBar(song, note.tick);
  const beatTicks = (song.ppq * 4) / pos.meter.denominator;
  const op: OpNote = {
    pitch: note.pitch,
    bar: pos.bar + 1,
    beat: round6(pos.tickInBar / beatTicks + 1),
    duration_beats: round6(note.duration / beatTicks),
    velocity: note.velocity,
  };
  if (note.articulation) op.articulation = note.articulation;
  if (note.syllable) op.syllable = note.syllable;
  if (note.expression) op.expression = { ...note.expression };
  return op;
}

export function opNoteToNote(song: Song, op: OpNote, id: string): Note {
  const pitch = parsePitch(op.pitch);
  if (pitch === null || pitch < 0 || pitch > 127) throw new Error(`Invalid pitch: ${JSON.stringify(op.pitch)}`);
  if (!Number.isFinite(op.bar) || op.bar < 1 || !Number.isFinite(op.beat) || op.beat < 1) throw new Error('Invalid bar/beat (1-based)');
  if (!Number.isFinite(op.duration_beats) || op.duration_beats <= 0) throw new Error('Invalid duration_beats');
  const tick = musicalToTick(song, Math.floor(op.bar), op.beat);
  const note: Note = {
    id,
    pitch,
    tick,
    duration: Math.max(1, beatsToTicks(song, op.duration_beats, tick)),
    velocity: Math.round(clampNum(op.velocity ?? 90, 1, 127)),
  };
  if (op.articulation) note.articulation = op.articulation;
  if (op.syllable) note.syllable = op.syllable;
  if (op.expression) note.expression = { ...op.expression };
  return note;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Lock checks used by note operations
// ---------------------------------------------------------------------------

/** Error + true when the region of `track` contains locked material. */
export function regionIsLocked(song: Song, track: Track, startTick: number, endTick: number, c: OpContext, opName: string): boolean {
  if (!c.respectLocks) return false;
  const p = c.locks;
  if (p.tracks.has(track.id)) {
    c.error('lock.violated', `${opName}: track "${track.name}" is locked.`, { trackId: track.id });
    return true;
  }
  for (const span of sectionLayout(song)) {
    if (span.endTick <= startTick || span.startTick >= endTick) continue;
    const sid = span.section.id;
    if (p.sections.has(sid) || p.trackSections.get(track.id)?.has(sid)) {
      c.error('lock.violated', `${opName}: "${track.name}" in "${span.section.name}" is locked.`, { trackId: track.id, sectionId: sid });
      return true;
    }
  }
  const lockedNote = track.notes.find((n) => n.locked && n.tick >= startTick && n.tick < endTick);
  if (lockedNote) {
    c.error('lock.violated', `${opName}: the selection contains locked notes on "${track.name}".`, { trackId: track.id, noteId: lockedNote.id });
    return true;
  }
  return false;
}

/** Whether a note (existing or new) on a track is protected by locks. */
export function isProtected(c: OpContext, locator: SectionLocator, track: Track, note: Pick<Note, 'tick' | 'locked'>): boolean {
  if (!c.respectLocks) return false;
  const p = c.locks;
  if (note.locked || p.tracks.has(track.id)) return true;
  const sid = locator.sectionIdAt(note.tick);
  if (!sid) return false;
  return p.sections.has(sid) || (p.trackSections.get(track.id)?.has(sid) ?? false);
}

/** Selection by region / note ids (for delete/transform/expression ops). */
export function selectNotes(
  track: Track,
  region: ResolvedRegion | undefined,
  noteIds: unknown,
  c: OpContext,
  opName: string,
): { notes: Note[]; explicit: boolean } | null {
  let ids: Set<string> | undefined;
  if (noteIds !== undefined && noteIds !== null) {
    if (!Array.isArray(noteIds)) {
      c.error('op.malformed', `${opName}: "note_ids" must be an array of note ids.`);
      return null;
    }
    ids = new Set(noteIds.map((x) => toStr(x)).filter((x): x is string => !!x));
    const existing = new Set(track.notes.map((n) => n.id));
    const missing = [...ids].filter((id) => !existing.has(id));
    if (missing.length) c.warn('note.not-found', `${opName}: ${missing.length} note id(s) not found on "${track.name}".`, { trackId: track.id });
  }
  const notes = track.notes.filter(
    (n) => (!region || (n.tick >= region.startTick && n.tick < region.endTick)) && (!ids || ids.has(n.id)),
  );
  return { notes, explicit: !!region || !!ids };
}

/** Apply lock policy to a selection: explicit selections with locked notes are rejected; whole-track selections skip locked notes. */
export function filterLockedSelection(
  c: OpContext,
  locator: SectionLocator,
  track: Track,
  sel: { notes: Note[]; explicit: boolean },
  opName: string,
): Note[] | null {
  if (!c.respectLocks) return sel.notes;
  const locked = sel.notes.filter((n) => isProtected(c, locator, track, n));
  if (!locked.length) return sel.notes;
  if (sel.explicit || c.locks.tracks.has(track.id)) {
    c.error('lock.violated', `${opName}: the selection on "${track.name}" contains ${locked.length} locked note(s).`, {
      trackId: track.id,
      noteId: locked[0].id,
    });
    return null;
  }
  c.info('lock.skipped', `${opName}: ${locked.length} locked note(s) on "${track.name}" were left unchanged.`, { trackId: track.id });
  const lockedSet = new Set(locked);
  return sel.notes.filter((n) => !lockedSet.has(n));
}

export function instrumentOf(c: OpContext, track: Track): InstrumentProfile {
  return lookupInstrument(track.instrumentId, c.instruments);
}

export function songEndTick(song: Song): number | undefined {
  return song.sections.length ? songLengthTicks(song) : undefined;
}

export function finalizeTrackNotes(track: Track): void {
  sortNotes(track.notes);
}
