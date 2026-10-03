import type { AutomationLane, ChordEvent, LockMap, Note, Song, Track, ValidationIssue } from '../ir/types';
import { LockKeys } from '../locks';
import { channelFor, cloneSong, sortNotes, stableStringify } from '../ir/song-utils';
import { sectionLayout } from '../timing';
import { SectionLocator, noteContentKey, sameMultiset, barsLabel } from './util';

/**
 * "Locked material unchanged" (spec §22, §48).
 *
 * Every comparison is made in section-relative coordinates (`sectionId:barOffset:tickInBar`),
 * so inserting, removing, moving or resizing *other* sections never registers as a change of
 * locked material, while any change to the locked notes/chords/lyrics themselves does.
 */

export interface ParsedLocks {
  tempo: boolean;
  key: boolean;
  meter: boolean;
  structure: boolean;
  chords: boolean;
  lyrics: boolean;
  motifs: boolean;
  tracks: Set<string>;
  /** trackId → locked section ids */
  trackSections: Map<string, Set<string>>;
  sections: Set<string>;
  sectionChords: Set<string>;
  sectionLyrics: Set<string>;
  motifIds: Set<string>;
  mixers: Set<string>;
  unknown: string[];
}

export function parseLocks(locks: LockMap): ParsedLocks {
  const p: ParsedLocks = {
    tempo: false,
    key: false,
    meter: false,
    structure: false,
    chords: false,
    lyrics: false,
    motifs: false,
    tracks: new Set(),
    trackSections: new Map(),
    sections: new Set(),
    sectionChords: new Set(),
    sectionLyrics: new Set(),
    motifIds: new Set(),
    mixers: new Set(),
    unknown: [],
  };
  for (const [key, on] of Object.entries(locks ?? {})) {
    if (on !== true) continue;
    let m: RegExpExecArray | null;
    if (key === LockKeys.tempo) p.tempo = true;
    else if (key === LockKeys.key) p.key = true;
    else if (key === LockKeys.meter) p.meter = true;
    else if (key === LockKeys.structure) p.structure = true;
    else if (key === LockKeys.chords) p.chords = true;
    else if (key === LockKeys.lyrics) p.lyrics = true;
    else if (key === LockKeys.motifs) p.motifs = true;
    else if ((m = /^track:(.+):section:(.+)$/.exec(key))) {
      const set = p.trackSections.get(m[1]) ?? new Set<string>();
      set.add(m[2]);
      p.trackSections.set(m[1], set);
    } else if ((m = /^track:(.+)$/.exec(key))) p.tracks.add(m[1]);
    else if ((m = /^chords:section:(.+)$/.exec(key))) p.sectionChords.add(m[1]);
    else if ((m = /^lyrics:section:(.+)$/.exec(key))) p.sectionLyrics.add(m[1]);
    else if ((m = /^section:(.+)$/.exec(key))) p.sections.add(m[1]);
    else if ((m = /^motif:(.+)$/.exec(key))) p.motifIds.add(m[1]);
    else if ((m = /^mixer:(.+)$/.exec(key))) p.mixers.add(m[1]);
    else p.unknown.push(key);
  }
  return p;
}

/** True if any lock is set at all (fast path). */
export function hasAnyLock(locks: LockMap): boolean {
  for (const v of Object.values(locks ?? {})) if (v === true) return true;
  return false;
}

/** Whether a note of `track` at `tick` (section `sid`) is protected by the lock map. */
export function noteProtected(p: ParsedLocks, trackId: string, note: Pick<Note, 'locked'>, sid: string | undefined): boolean {
  if (note.locked) return true;
  if (p.tracks.has(trackId)) return true;
  if (sid === undefined) return false;
  if (p.sections.has(sid)) return true;
  return p.trackSections.get(trackId)?.has(sid) ?? false;
}

/** Whether a section's chords are protected. */
export function chordsProtected(p: ParsedLocks, sid: string | undefined): boolean {
  if (p.chords) return true;
  if (sid === undefined) return false;
  return p.sectionChords.has(sid) || p.sections.has(sid);
}

export function lyricsProtected(p: ParsedLocks, sid: string): boolean {
  return p.lyrics || p.sectionLyrics.has(sid) || p.sections.has(sid);
}

function chordContentKey(c: ChordEvent): string {
  return JSON.stringify([c.root, c.quality, c.bass ?? null, c.symbol, c.duration]);
}

function groupNotesBySection(track: Track | undefined, loc: SectionLocator): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!track) return map;
  for (const n of track.notes) {
    const pl = loc.place(n.tick);
    const list = map.get(pl.sid);
    const sig = `${pl.key}|${noteContentKey(n)}`;
    if (list) list.push(sig);
    else map.set(pl.sid, [sig]);
  }
  return map;
}

function chordsBySection(song: Song, loc: SectionLocator): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of song.chords) {
    const pl = loc.place(c.tick);
    const sig = `${pl.key}|${chordContentKey(c)}`;
    const list = map.get(pl.sid);
    if (list) list.push(sig);
    else map.set(pl.sid, [sig]);
  }
  return map;
}

function lanePoints(lanes: AutomationLane[], target: string, loc: SectionLocator): string[] {
  return lanes
    .filter((l) => l.target === target)
    .map((l) => `${l.param}|${l.enabled}|${l.points.map((p) => `${loc.locate(p.tick)}=${p.value}/${p.curve ?? ''}`).join(',')}`)
    .sort();
}

/** Same sections and meter map by reference (no structure edit happened between the states). */
function sameLayoutRef(a: Song, b: Song): boolean {
  return a.sections === b.sections && a.meterMap === b.meterMap;
}

function trackName(song: Song, id: string): string {
  return song.tracks.find((t) => t.id === id)?.name ?? id;
}

function sectionName(song: Song, id: string): string {
  return song.sections.find((s) => s.id === id)?.name ?? id;
}

/**
 * All lock violations between `before` and `after` for the lock map in effect (`before.locks`
 * unless given). Each issue has code `lock.violated` and severity `error`.
 */
export function lockViolations(before: Song, after: Song, locks: LockMap = before.locks): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!hasAnyLock(locks)) return issues;
  const p = parseLocks(locks);
  const lb = new SectionLocator(before);
  const la = new SectionLocator(after);
  const err = (message: string, extra: Partial<ValidationIssue> = {}) =>
    issues.push({ severity: 'error', code: 'lock.violated', message, ...extra });

  // --- song-level --------------------------------------------------------
  if (p.tempo) {
    const sig = (s: Song, l: SectionLocator) =>
      [...s.tempoMap].sort((a, b) => a.tick - b.tick).map((t) => `${l.locate(t.tick)}=${t.bpm}`);
    if (!sameMultiset(sig(before, lb), sig(after, la))) err('Tempo is locked but the tempo map changed.');
  }
  if (p.key) {
    const sig = (s: Song, l: SectionLocator) => s.keyMap.map((k) => `${l.locateBar(k.bar)}=${k.key.tonic}/${k.key.mode}`);
    if (!sameMultiset(sig(before, lb), sig(after, la))) err('Key is locked but the key map changed.');
  }
  if (p.meter) {
    const sig = (s: Song, l: SectionLocator) => s.meterMap.map((m) => `${l.locateBar(m.bar)}=${m.numerator}/${m.denominator}`);
    if (!sameMultiset(sig(before, lb), sig(after, la))) err('Meter is locked but the meter map changed.');
  }
  if (p.structure) {
    const sig = (s: Song) => s.sections.map((x) => `${x.id}|${x.name}|${x.kind}|${x.bars}`).join(';');
    if (sig(before) !== sig(after)) err('Song structure is locked but sections changed.');
  }
  if (p.motifs) {
    if (stableStringify(before.motifs) !== stableStringify(after.motifs)) err('Motifs are locked but changed.');
  }
  for (const id of p.motifIds) {
    const a = before.motifs.find((m) => m.id === id);
    const b = after.motifs.find((m) => m.id === id);
    if (a && stableStringify(a) !== stableStringify(b ?? null)) err(`Motif "${a.name}" is locked but changed.`);
  }

  // --- chords ------------------------------------------------------------
  const lockedChordSections = new Set<string>([...p.sectionChords, ...p.sections]);
  const chordsUnchanged = before.chords === after.chords && sameLayoutRef(before, after);
  if (!chordsUnchanged && (p.chords || lockedChordSections.size)) {
    const cb = chordsBySection(before, lb);
    const ca = chordsBySection(after, la);
    if (p.chords) {
      const all = (m: Map<string, string[]>) => [...m.values()].flat();
      if (!sameMultiset(all(cb), all(ca))) err('Chords are locked but the chord progression changed.');
    } else {
      for (const sid of lockedChordSections) {
        if (!before.sections.some((s) => s.id === sid)) continue;
        if (!sameMultiset(cb.get(sid) ?? [], ca.get(sid) ?? [])) {
          err(`Chords in "${sectionName(before, sid)}" are locked but changed.`, { sectionId: sid });
        }
      }
    }
  }

  // --- lyrics ------------------------------------------------------------
  const lineSig = (s: Song, sid?: string) =>
    s.lyrics.filter((l) => sid === undefined || l.sectionId === sid).map((l) => stableStringify(l));
  if (before.lyrics === after.lyrics) {
    // unchanged
  } else if (p.lyrics) {
    if (lineSig(before).join('\n') !== lineSig(after).join('\n')) err('Lyrics are locked but changed.');
  } else {
    for (const sid of new Set([...p.sectionLyrics, ...p.sections])) {
      if (!before.sections.some((s) => s.id === sid)) continue;
      if (lineSig(before, sid).join('\n') !== lineSig(after, sid).join('\n')) {
        err(`Lyrics of "${sectionName(before, sid)}" are locked but changed.`, { sectionId: sid });
      }
    }
  }

  // --- sections (existence / length) --------------------------------------
  for (const sid of p.sections) {
    const b = before.sections.find((s) => s.id === sid);
    if (!b) continue;
    const a = after.sections.find((s) => s.id === sid);
    if (!a) err(`Section "${b.name}" is locked but was removed.`, { sectionId: sid });
    else if (a.bars !== b.bars) err(`Section "${b.name}" is locked but its length changed.`, { sectionId: sid });
  }

  // --- notes ---------------------------------------------------------------
  const beforeTracks = new Map(before.tracks.map((t) => [t.id, t] as const));
  const afterTracks = new Map(after.tracks.map((t) => [t.id, t] as const));
  // Identical notes arrays (structural sharing) mean identical material.
  const layoutSame = sameLayoutRef(before, after);
  const untouched = (tid: string) => {
    const b = beforeTracks.get(tid);
    const a = afterTracks.get(tid);
    return !!b && !!a && layoutSame && b.notes === a.notes;
  };
  const groupCache = new Map<string, [Map<string, string[]>, Map<string, string[]>]>();
  const groups = (tid: string) => {
    let g = groupCache.get(tid);
    if (!g) {
      g = [groupNotesBySection(beforeTracks.get(tid), lb), groupNotesBySection(afterTracks.get(tid), la)];
      groupCache.set(tid, g);
    }
    return g;
  };

  for (const tid of p.tracks) {
    const b = beforeTracks.get(tid);
    if (!b) continue;
    const a = afterTracks.get(tid);
    if (!a) {
      err(`Track "${b.name}" is locked but was removed.`, { trackId: tid });
      continue;
    }
    if (a.instrumentId !== b.instrumentId || a.kind !== b.kind) {
      err(`Track "${b.name}" is locked but its instrument changed.`, { trackId: tid });
    }
    if (stableStringify(a.clips) !== stableStringify(b.clips)) err(`Track "${b.name}" is locked but its audio clips changed.`, { trackId: tid });
    if (untouched(tid)) continue;
    const [gb, ga] = groups(tid);
    const all = (m: Map<string, string[]>) => [...m.values()].flat();
    if (!sameMultiset(all(gb), all(ga))) err(`Track "${b.name}" is locked but its notes changed.`, { trackId: tid });
  }

  const sectionChecks: [string, string][] = [];
  for (const [tid, sids] of p.trackSections) for (const sid of sids) sectionChecks.push([tid, sid]);
  for (const sid of p.sections) for (const tid of new Set([...beforeTracks.keys(), ...afterTracks.keys()])) sectionChecks.push([tid, sid]);
  const seenPairs = new Set<string>();
  for (const [tid, sid] of sectionChecks) {
    if (p.tracks.has(tid) || untouched(tid)) continue; // already compared as a whole / unchanged
    const pairKey = `${tid}|${sid}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    if (!before.sections.some((s) => s.id === sid)) continue;
    const [gb, ga] = groups(tid);
    const b = gb.get(sid) ?? [];
    const a = ga.get(sid) ?? [];
    if (!sameMultiset(b, a)) {
      const name = trackName(before, tid) ?? trackName(after, tid);
      err(`"${name}" in "${sectionName(before, sid)}" is locked but changed.`, { trackId: tid, sectionId: sid });
    }
  }

  // note-level locks
  for (const t of before.tracks) {
    if (p.tracks.has(t.id) || untouched(t.id)) continue;
    const at = afterTracks.get(t.id);
    let afterById: Map<string, Note> | undefined;
    for (const n of t.notes) {
      if (!n.locked) continue;
      if (!afterById) afterById = new Map((at?.notes ?? []).map((x) => [x.id, x] as const));
      const m = afterById.get(n.id);
      if (!m || la.locate(m.tick) !== lb.locate(n.tick) || noteContentKey(m) !== noteContentKey(n)) {
        err(`A locked note in "${t.name}" (${barsLabel(before, n.tick, n.tick + 1)}) was changed or removed.`, { trackId: t.id, noteId: n.id });
      }
    }
  }

  // --- mixer -----------------------------------------------------------------
  for (const target of p.mixers) {
    if (target === 'master') {
      const sig = (s: Song) => stableStringify([s.mixer.master, s.mixer.reverb, s.mixer.delay]);
      if (sig(before) !== sig(after) || !sameMultiset(lanePoints(before.automation, 'master', lb), lanePoints(after.automation, 'master', la))) {
        err('The master bus is locked but its settings changed.');
      }
      continue;
    }
    if (!beforeTracks.has(target)) continue;
    const sb = stableStringify(channelFor(before, target));
    const sa = stableStringify(channelFor(after, target));
    if (sb !== sa || !sameMultiset(lanePoints(before.automation, target, lb), lanePoints(after.automation, target, la))) {
      err(`The mixer channel of "${trackName(before, target)}" is locked but changed.`, { trackId: target });
    }
  }
  return issues;
}

export interface ChangeScope {
  /** Allowed tick range [startTick, endTick) (by note onset). */
  region?: { startTick: number; endTick: number };
  /** Tracks that may change. */
  trackIds?: string[];
}

function sameLayout(a: Song, b: Song): boolean {
  const la = sectionLayout(a);
  const lb = sectionLayout(b);
  if (la.length !== lb.length) return false;
  for (let i = 0; i < la.length; i++) {
    if (la[i].section.id !== lb[i].section.id || la[i].startTick !== lb[i].startTick || la[i].endTick !== lb[i].endTick) return false;
  }
  return stableStringify(a.meterMap) === stableStringify(b.meterMap);
}

/** "Requested bar range honored": changes outside the scope are errors (`region.violated`). */
export function scopeViolations(before: Song, after: Song, scope: ChangeScope): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!scope.region && !scope.trackIds) return issues;
  const region = scope.region;
  const allowed = scope.trackIds ? new Set(scope.trackIds) : undefined;
  const structureSame = sameLayout(before, after);
  if (region && !structureSame) {
    issues.push({ severity: 'info', code: 'region.unchecked', message: 'Song structure changed; the requested bar range could not be verified.' });
  }
  const checkRegion = !!region && structureSame;
  const outside = (n: Note) => !region || n.tick < region.startTick || n.tick >= region.endTick;
  const sig = (n: Note) => {
    let end = n.tick + n.duration;
    if (checkRegion && n.tick < region!.startTick) end = Math.min(end, region!.startTick);
    return `${n.tick}|${end}|${noteContentKey({ ...n, duration: 0 })}`;
  };
  const ids = new Set([...before.tracks.map((t) => t.id), ...after.tracks.map((t) => t.id)]);
  for (const id of ids) {
    const b = before.tracks.find((t) => t.id === id);
    const a = after.tracks.find((t) => t.id === id);
    const name = (b ?? a)!.name;
    const inScope = !allowed || allowed.has(id);
    if (!inScope) {
      if (!a || !b) {
        issues.push({ severity: 'error', code: 'region.violated', message: `Track "${name}" was ${a ? 'added' : 'removed'} outside the requested tracks.`, trackId: id });
        continue;
      }
      const exact = (n: Note) => `${n.tick}|${noteContentKey(n)}`;
      if (!sameMultiset(b.notes.map(exact), a.notes.map(exact))) {
        issues.push({ severity: 'error', code: 'region.violated', message: `Track "${name}" changed but was not part of the requested change.`, trackId: id });
      }
      continue;
    }
    if (!checkRegion || !a || !b) continue;
    const bs = b.notes.filter(outside).map(sig);
    const as = a.notes.filter(outside).map(sig);
    if (!sameMultiset(bs, as)) {
      issues.push({
        severity: 'error',
        code: 'region.violated',
        message: `Track "${name}" changed outside the requested range (${barsLabel(before, region!.startTick, region!.endTick)}).`,
        trackId: id,
      });
    }
  }
  if (checkRegion) {
    const csig = (c: ChordEvent) => `${c.tick}|${c.root}|${c.quality}|${c.bass ?? ''}`;
    const cOut = (c: ChordEvent) => c.tick < region!.startTick || c.tick >= region!.endTick;
    if (!sameMultiset(before.chords.filter(cOut).map(csig), after.chords.filter(cOut).map(csig))) {
      issues.push({ severity: 'error', code: 'region.violated', message: `Chords changed outside the requested range (${barsLabel(before, region!.startTick, region!.endTick)}).` });
    }
  }
  return issues;
}

/**
 * Put locked material from `before` back into `after` (used to sanitize whole-song proposals).
 * Only possible when both songs share the same bar/section layout; returns the number of
 * restored components (0 when the layouts differ).
 */
export function restoreLockedMaterial(before: Song, after: Song, locks: LockMap = before.locks): { song: Song; restored: number } {
  if (!hasAnyLock(locks) || !sameLayout(before, after)) return { song: after, restored: 0 };
  const violations = lockViolations(before, after, locks);
  if (!violations.length) return { song: after, restored: 0 };
  const p = parseLocks(locks);
  const out = cloneSong(after);
  let restored = 0;
  const spans = sectionLayout(before);
  const spanOf = (sid: string) => spans.find((s) => s.section.id === sid);

  if (p.tempo && stableStringify(out.tempoMap) !== stableStringify(before.tempoMap)) {
    out.tempoMap = cloneSong(before.tempoMap);
    restored++;
  }
  if (p.key && stableStringify(out.keyMap) !== stableStringify(before.keyMap)) {
    out.keyMap = cloneSong(before.keyMap);
    restored++;
  }
  if (p.motifs && stableStringify(out.motifs) !== stableStringify(before.motifs)) {
    out.motifs = cloneSong(before.motifs);
    restored++;
  }
  for (const id of p.motifIds) {
    const m = before.motifs.find((x) => x.id === id);
    if (!m) continue;
    const i = out.motifs.findIndex((x) => x.id === id);
    if (i >= 0 && stableStringify(out.motifs[i]) === stableStringify(m)) continue;
    if (i >= 0) out.motifs[i] = cloneSong(m);
    else out.motifs.push(cloneSong(m));
    restored++;
  }

  // chords
  if (p.chords) {
    if (stableStringify(out.chords) !== stableStringify(before.chords)) {
      out.chords = cloneSong(before.chords);
      restored++;
    }
  } else {
    for (const sid of new Set([...p.sectionChords, ...p.sections])) {
      const span = spanOf(sid);
      if (!span) continue;
      const inSpan = (c: ChordEvent) => c.tick >= span.startTick && c.tick < span.endTick;
      const b = before.chords.filter(inSpan);
      const a = out.chords.filter(inSpan);
      if (stableStringify(a) === stableStringify(b)) continue;
      out.chords = [...out.chords.filter((c) => !inSpan(c)), ...cloneSong(b)].sort((x, y) => x.tick - y.tick);
      restored++;
    }
  }

  // lyrics
  if (p.lyrics) {
    if (stableStringify(out.lyrics) !== stableStringify(before.lyrics)) {
      out.lyrics = cloneSong(before.lyrics);
      restored++;
    }
  } else {
    for (const sid of new Set([...p.sectionLyrics, ...p.sections])) {
      const b = before.lyrics.filter((l) => l.sectionId === sid);
      const a = out.lyrics.filter((l) => l.sectionId === sid);
      if (stableStringify(a) === stableStringify(b)) continue;
      out.lyrics = [...out.lyrics.filter((l) => l.sectionId !== sid), ...cloneSong(b)];
      restored++;
    }
  }

  // tracks
  for (const tid of p.tracks) {
    const b = before.tracks.find((t) => t.id === tid);
    if (!b) continue;
    const i = out.tracks.findIndex((t) => t.id === tid);
    if (i >= 0 && stableStringify(out.tracks[i]) === stableStringify(b)) continue;
    if (i >= 0) out.tracks[i] = cloneSong(b);
    else out.tracks.splice(Math.min(before.tracks.indexOf(b), out.tracks.length), 0, cloneSong(b));
    restored++;
  }
  const pairs: [string, string][] = [];
  for (const [tid, sids] of p.trackSections) for (const sid of sids) pairs.push([tid, sid]);
  for (const sid of p.sections) for (const t of before.tracks) pairs.push([t.id, sid]);
  for (const [tid, sid] of pairs) {
    if (p.tracks.has(tid)) continue;
    const span = spanOf(sid);
    const b = before.tracks.find((t) => t.id === tid);
    const a = out.tracks.find((t) => t.id === tid);
    if (!span || !b || !a) continue;
    const inSpan = (n: Note) => n.tick >= span.startTick && n.tick < span.endTick;
    const bn = b.notes.filter(inSpan);
    const an = a.notes.filter(inSpan);
    if (sameMultiset(bn.map(noteContentKeyAt), an.map(noteContentKeyAt))) continue;
    a.notes = sortNotes([...a.notes.filter((n) => !inSpan(n)), ...cloneSong(bn)]);
    restored++;
  }
  // note-level locks
  for (const b of before.tracks) {
    if (p.tracks.has(b.id)) continue;
    const a = out.tracks.find((t) => t.id === b.id);
    if (!a) continue;
    let changed = false;
    for (const n of b.notes) {
      if (!n.locked) continue;
      const i = a.notes.findIndex((x) => x.id === n.id);
      if (i >= 0 && noteContentKeyAt(a.notes[i]) === noteContentKeyAt(n)) continue;
      if (i >= 0) a.notes.splice(i, 1);
      a.notes.push(cloneSong(n));
      changed = true;
    }
    if (changed) {
      sortNotes(a.notes);
      restored++;
    }
  }

  // mixer
  for (const target of p.mixers) {
    if (target === 'master') {
      out.mixer.master = cloneSong(before.mixer.master);
      out.mixer.reverb = cloneSong(before.mixer.reverb);
      out.mixer.delay = cloneSong(before.mixer.delay);
    } else if (before.mixer.channels[target]) {
      out.mixer.channels[target] = cloneSong(before.mixer.channels[target]);
    } else {
      delete out.mixer.channels[target];
    }
    out.automation = [...out.automation.filter((l) => l.target !== target), ...cloneSong(before.automation.filter((l) => l.target === target))];
    restored++;
  }
  return { song: out, restored };
}

function noteContentKeyAt(n: Note): string {
  return `${n.tick}|${noteContentKey(n)}`;
}
