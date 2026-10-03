import type { LockMap, MusicOperation, Note, Song, Track, ValidationReport } from '../ir/types';
import { cloneSong, sortNotes } from '../ir/song-utils';
import { findSection, sectionLayout, songLengthTicks } from '../timing';
import { foldIntoRange } from '../theory/scales';
import { isDrumTrack, lookupInstrument, trackRange } from './instruments';
import { lockViolations, noteProtected, parseLocks, scopeViolations } from './locks-check';
import { createOpContext, foldMidi, parseRegion, resolveTrack, type ApplyOptions, type OpContext, type RegenerateOperation } from './op-context';
import { opAddNotes, opDeleteNotes, opReplaceNotes, opSetExpression, opTransformNotes } from './ops-notes';
import { opSetAutomation, opSetChords, opSetKey, opSetLock, opSetLyrics, opSetMacros, opSetMeter, opSetMixer, opSetTempo } from './ops-song';
import { opInsertSection, opMoveSection, opRemoveSection, opUpdateSection } from './ops-structure';
import { opAddTrack, opRemoveTrack, opSetInstrument } from './ops-tracks';
import { IdAllocator, IssueList, SectionLocator, barsLabel, isRecord, noteContentKey, toStr } from './util';

export type { ApplyOptions, RegenerateOperation } from './op-context';

export interface ApplyResult {
  /** The edited song (a new object; the input is never mutated). */
  song: Song;
  report: ValidationReport;
  /** Operations that were applied. */
  applied: number;
  /** Operations that were rejected or could not be applied. */
  skipped: number;
}

type Handler = (song: Song, op: Record<string, unknown>, c: OpContext) => boolean;

function opRegenerate(song: Song, op: Record<string, unknown>, c: OpContext): boolean {
  const name = 'regenerate';
  const regen = c.opts.regenerate;
  if (!regen) {
    c.info('op.unsupported', `${name}: no composition engine is attached; regeneration was skipped.`);
    return false;
  }
  // Validate references up front so a bad request is reported clearly.
  let trackIds: string[] | undefined;
  if (op.track !== undefined && op.track !== null) {
    const t = resolveTrack(song, op.track, c, name);
    if (!t) return false;
    trackIds = [t.id];
  }
  let startTick: number | undefined;
  let endTick: number | undefined;
  const region = parseRegion(song, op.region, c, name, false);
  if (region === null) return false;
  if (region) {
    startTick = region.startTick;
    endTick = region.endTick;
  }
  if (op.sections !== undefined && op.sections !== null) {
    if (!Array.isArray(op.sections)) {
      c.error('op.malformed', `${name}: "sections" must be an array of section ids or names.`);
      return false;
    }
    const spans = sectionLayout(song);
    for (const ref of op.sections) {
      const s = findSection(song, toStr(ref) ?? '');
      if (!s) {
        c.error('section.not-found', `${name}: section ${JSON.stringify(ref)} not found.`);
        return false;
      }
      const span = spans.find((x) => x.section.id === s.id)!;
      startTick = startTick === undefined ? span.startTick : Math.min(startTick, span.startTick);
      endTick = endTick === undefined ? span.endTick : Math.max(endTick, span.endTick);
    }
  }
  let result: Song;
  try {
    result = regen(cloneSong(song), op as unknown as RegenerateOperation);
  } catch (e) {
    c.error('op.failed', `${name}: the composition engine failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (!isRecord(result) || !Array.isArray((result as Song).tracks) || !Array.isArray((result as Song).sections)) {
    c.error('op.failed', `${name}: the composition engine returned an invalid song.`);
    return false;
  }
  const scope = scopeViolations(song, result, {
    region: startTick !== undefined && endTick !== undefined ? { startTick, endTick } : undefined,
    trackIds,
  });
  const violations = scope.filter((i) => i.severity === 'error');
  if (violations.length) {
    for (const v of violations) c.error(v.code, `${name}: ${v.message}`, { trackId: v.trackId });
    return false;
  }
  // Notes that are new or changed count as touched (validated/auto-fixed below).
  const beforeKeys = new Set<string>();
  for (const t of song.tracks) for (const n of t.notes) beforeKeys.add(`${t.id}|${n.tick}|${noteContentKey(n)}`);
  // Replace the draft's content with the regenerated song.
  for (const key of Object.keys(song) as (keyof Song)[]) delete (song as Partial<Song>)[key];
  Object.assign(song, cloneSong(result));
  for (const t of song.tracks) for (const n of t.notes) if (!beforeKeys.has(`${t.id}|${n.tick}|${noteContentKey(n)}`)) c.touch(t.id, n.id);
  return true;
}

const HANDLERS: Record<MusicOperation['op'], Handler> = {
  replace_notes: opReplaceNotes,
  add_notes: opAddNotes,
  delete_notes: opDeleteNotes,
  transform_notes: opTransformNotes,
  set_chords: opSetChords,
  set_tempo: opSetTempo,
  set_key: opSetKey,
  set_meter: opSetMeter,
  update_section: opUpdateSection,
  insert_section: opInsertSection,
  remove_section: opRemoveSection,
  move_section: opMoveSection,
  set_lyrics: opSetLyrics,
  set_mixer: opSetMixer,
  set_automation: opSetAutomation,
  set_expression: opSetExpression,
  add_track: opAddTrack,
  remove_track: opRemoveTrack,
  set_instrument: opSetInstrument,
  set_macros: opSetMacros,
  set_lock: opSetLock,
  regenerate: opRegenerate,
};

/** Accept `{ "operation": "replace_notes", ... }` (spec §46 example) as well as `{ "op": ... }`. */
function opName(op: Record<string, unknown>): string | undefined {
  const n = toStr(op.op) ?? toStr(op.operation) ?? toStr(op.type);
  return n?.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Apply structured musical operations (spec §46) to a song.
 *
 * - Never mutates `song`; never throws on bad model output.
 * - Each operation is applied atomically to a draft: an invalid or rejected operation is skipped
 *   and reported (`opIndex`), leaving the song as it was before that operation.
 * - With `respectLocks` (default) any operation that would change locked material is rejected
 *   (`lock.violated`); locks added by earlier ops in the batch apply to later ops, unlocks take
 *   effect only after the change is accepted.
 * - With `autoFix` (default) new/edited notes are folded into the instrument range, clamped to
 *   valid MIDI, trimmed at the song end and de-duplicated; fixes are reported with `fixed: true`.
 */
export function applyOperations(song: Song, ops: MusicOperation[], opts: ApplyOptions = {}): ApplyResult {
  const issues = new IssueList();
  let work = cloneSong(song);
  const ids = new IdAllocator(work, opts.ids);
  const lockMap: LockMap = {};
  for (const [k, v] of Object.entries(song.locks ?? {})) if (v === true) lockMap[k] = true;
  const touched = new Map<string, Set<string>>();
  let applied = 0;
  let skipped = 0;
  const list: unknown[] = Array.isArray(ops) ? ops : [];
  if (!Array.isArray(ops)) issues.error('op.malformed', 'Operations must be an array.');

  list.forEach((raw, opIndex) => {
    if (!isRecord(raw)) {
      issues.error('op.malformed', `Operation #${opIndex + 1} is not an object.`, { opIndex });
      skipped++;
      return;
    }
    const name = opName(raw);
    if (!name) {
      issues.error('op.malformed', `Operation #${opIndex + 1} has no "op" name.`, { opIndex });
      skipped++;
      return;
    }
    const handler = (HANDLERS as Record<string, Handler | undefined>)[name];
    if (!handler) {
      issues.error('op.unknown', `Unknown operation "${name}".`, { opIndex });
      skipped++;
      return;
    }
    const opIssues = new IssueList(Infinity);
    const ctx = createOpContext(opIndex, opIssues, opts, ids, lockMap);
    const draft = cloneSong(work);
    let ok = false;
    try {
      ok = handler(draft, raw, ctx);
    } catch (e) {
      ctx.error('op.failed', `${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      ok = false;
    }
    if (ok && ctx.respectLocks) {
      const violations = lockViolations(work, draft, lockMap);
      if (violations.length) {
        for (const v of violations) opIssues.add({ ...v, message: `${name}: ${v.message}`, opIndex });
        ok = false;
      }
    }
    issues.addAll(opIssues.issues);
    if (ok) {
      work = draft;
      applied++;
      for (const [tid, set] of ctx.touched) {
        let all = touched.get(tid);
        if (!all) touched.set(tid, (all = new Set()));
        for (const id of set) all.add(id);
      }
    } else skipped++;
  });

  // Locks of the input song: material protected before this batch must come out unchanged.
  const originalLocks = song.locks ?? {};
  finalizeNotes(work, touched, opts, issues, originalLocks);
  if (opts.respectLocks !== false) {
    // Safety net: nothing (including the auto-fix pass) may alter locked material.
    for (const v of lockViolations(song, work, originalLocks)) issues.add(v);
  }
  return { song: work, report: issues.report(), applied, skipped };
}

/** Sort notes and validate/auto-fix every note created or modified by the batch. */
function finalizeNotes(song: Song, touched: Map<string, Set<string>>, opts: ApplyOptions, issues: IssueList, lockMap: LockMap): void {
  const autoFix = opts.autoFix !== false;
  const lookup = { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument };
  const end = song.sections.length ? songLengthTicks(song) : Infinity;
  const respect = opts.respectLocks !== false;
  const locks = parseLocks(lockMap);
  const locator = new SectionLocator(song);
  const protectedNote = (track: Track, n: Note) => respect && noteProtected(locks, track.id, n, locator.sectionIdAt(n.tick));
  for (const track of song.tracks) {
    sortNotes(track.notes);
    const ids = touched.get(track.id);
    if (!ids || !ids.size || track.kind !== 'midi') continue;
    const drums = isDrumTrack(track, lookup);
    const range = trackRange(track, lookup);
    const removed = new Set<Note>();
    for (const n of track.notes) {
      if (!ids.has(n.id)) continue;
      // MIDI validity first: bad data never enters the song.
      if (!Number.isFinite(n.tick) || n.tick < 0 || !Number.isFinite(n.duration) || !Number.isFinite(n.pitch) || !Number.isFinite(n.velocity)) {
        removed.add(n);
        issues.warn('note.invalid', `Invalid note data on "${track.name}" removed.`, { trackId: track.id, noteId: n.id, fixed: true });
        continue;
      }
      if (n.pitch < 0 || n.pitch > 127) {
        if (autoFix) {
          const p = foldMidi(n.pitch);
          issues.warn('note.invalid', `Pitch ${n.pitch} on "${track.name}" is outside MIDI 0–127; moved to ${p}.`, { trackId: track.id, noteId: n.id, fixed: true });
          n.pitch = p;
        } else {
          removed.add(n);
          issues.warn('note.invalid', `Pitch ${n.pitch} on "${track.name}" is outside MIDI 0–127; note removed.`, { trackId: track.id, noteId: n.id, fixed: true });
          continue;
        }
      }
      if (n.duration < 1) {
        n.duration = 1;
        issues.warn('note.duration', `Zero-length note on "${track.name}" given a minimal duration.`, { trackId: track.id, noteId: n.id, fixed: true });
      }
      const v = Math.round(Math.min(127, Math.max(1, n.velocity)));
      if (v !== n.velocity) n.velocity = v;
      if (n.tick >= end) {
        if (autoFix) {
          removed.add(n);
          issues.warn('note.past-end', `A note on "${track.name}" starts after the end of the song and was removed.`, { trackId: track.id, noteId: n.id, fixed: true });
        } else issues.warn('note.past-end', `A note on "${track.name}" starts after the end of the song.`, { trackId: track.id, noteId: n.id });
        continue;
      }
      if (n.tick + n.duration > end) {
        if (autoFix) {
          n.duration = end - n.tick;
          issues.info('note.past-end', `A note on "${track.name}" was shortened to end with the song.`, { trackId: track.id, noteId: n.id, fixed: true });
        } else issues.warn('note.past-end', `A note on "${track.name}" extends past the end of the song.`, { trackId: track.id, noteId: n.id });
      }
      if (!drums && (n.pitch < range.low || n.pitch > range.high)) {
        if (autoFix) {
          const p = foldIntoRange(n.pitch, range.low, range.high);
          issues.warn(
            'note.out-of-range',
            `Pitch ${n.pitch} is outside the range of "${track.name}" (${range.low}–${range.high}); moved to ${p}.`,
            { trackId: track.id, noteId: n.id, fixed: true },
          );
          n.pitch = p;
        } else {
          issues.warn('note.out-of-range', `Pitch ${n.pitch} is outside the range of "${track.name}" (${range.low}–${range.high}).`, { trackId: track.id, noteId: n.id });
        }
      }
    }
    if (removed.size) track.notes = track.notes.filter((n) => !removed.has(n));
    sortNotes(track.notes);
    fixOverlaps(song, track, ids, autoFix, issues, (n) => protectedNote(track, n));
    if (lookupInstrument(track.instrumentId, lookup).polyphony === 'mono' && !drums) {
      const overlaps = countPolyphonicOverlaps(track.notes);
      if (overlaps) {
        issues.warn('polyphony.mono', `"${track.name}" is a monophonic instrument but has ${overlaps} overlapping note(s).`, { trackId: track.id });
      }
    }
  }
}

/** Same-pitch overlaps involving edited notes: duplicates removed, earlier notes trimmed. */
function fixOverlaps(song: Song, track: Track, ids: Set<string>, autoFix: boolean, issues: IssueList, isProtected: (n: Note) => boolean): void {
  const byPitch = new Map<number, Note[]>();
  for (const n of track.notes) {
    const list = byPitch.get(n.pitch);
    if (list) list.push(n);
    else byPitch.set(n.pitch, [n]);
  }
  const remove = new Set<Note>();
  for (const list of byPitch.values()) {
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      if (remove.has(a)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.tick >= a.tick + a.duration) break;
        if (remove.has(b)) continue;
        const involved = ids.has(a.id) || ids.has(b.id);
        if (!involved) continue;
        const where = barsLabel(song, b.tick, b.tick + 1);
        if (!autoFix) {
          issues.warn('note.overlap', `Overlapping notes of the same pitch on "${track.name}" (${where}).`, { trackId: track.id, noteId: b.id });
          continue;
        }
        if (a.tick === b.tick) {
          // Exact duplicate onset: drop the edited one (or the later one), never a locked note.
          const victim = isProtected(b) ? a : isProtected(a) ? b : ids.has(b.id) ? b : a;
          if (isProtected(victim)) {
            issues.warn('note.overlap', `Duplicate notes on "${track.name}" (${where}).`, { trackId: track.id, noteId: b.id });
            continue;
          }
          remove.add(victim);
          issues.warn('note.overlap', `Duplicate note on "${track.name}" (${where}) removed.`, { trackId: track.id, noteId: victim.id, fixed: true });
          if (victim === a) break;
        } else if (!isProtected(a)) {
          a.duration = b.tick - a.tick;
          issues.info('note.overlap', `Overlapping note on "${track.name}" (${where}) shortened.`, { trackId: track.id, noteId: a.id, fixed: true });
        } else {
          issues.warn('note.overlap', `A note overlaps a locked note on "${track.name}" (${where}).`, { trackId: track.id, noteId: b.id });
        }
      }
    }
  }
  if (remove.size) track.notes = track.notes.filter((n) => !remove.has(n));
}

/** Number of notes that start while another note is still sounding. */
export function countPolyphonicOverlaps(notes: readonly Note[]): number {
  let count = 0;
  let maxEnd = -Infinity;
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  for (const n of sorted) {
    if (n.tick < maxEnd) count++;
    maxEnd = Math.max(maxEnd, n.tick + n.duration);
  }
  return count;
}
