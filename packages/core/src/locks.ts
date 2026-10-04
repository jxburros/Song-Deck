import type { Id, LockMap, Note, Song, Ticks, Track } from './ir/types';
import { sectionLayout } from './timing';

/**
 * Lock keys (spec §22). "Regenerate unlocked material" must leave every locked component
 * byte-identical; this module answers "is X locked?" for every layer of the composition.
 */
export const LockKeys = {
  tempo: 'song.tempo',
  key: 'song.key',
  meter: 'song.meter',
  structure: 'song.structure',
  chords: 'song.chords',
  lyrics: 'song.lyrics',
  motifs: 'song.motifs',
  track: (trackId: Id) => `track:${trackId}`,
  trackSection: (trackId: Id, sectionId: Id) => `track:${trackId}:section:${sectionId}`,
  section: (sectionId: Id) => `section:${sectionId}`,
  sectionChords: (sectionId: Id) => `chords:section:${sectionId}`,
  sectionLyrics: (sectionId: Id) => `lyrics:section:${sectionId}`,
  motif: (motifId: Id) => `motif:${motifId}`,
  mixer: (trackId: Id) => `mixer:${trackId}`,
} as const;

export function isLocked(locks: LockMap, key: string): boolean {
  return locks[key] === true;
}

export function setLock(locks: LockMap, key: string, locked: boolean): LockMap {
  const next = { ...locks };
  if (locked) next[key] = true;
  else delete next[key];
  return next;
}

/** Track material in a section is locked if the track, the section, or the pair is locked. */
export function isTrackSectionLocked(song: Pick<Song, 'locks'>, trackId: Id, sectionId: Id): boolean {
  const l = song.locks;
  return (
    isLocked(l, LockKeys.track(trackId)) ||
    isLocked(l, LockKeys.section(sectionId)) ||
    isLocked(l, LockKeys.trackSection(trackId, sectionId))
  );
}

export function isChordSectionLocked(song: Pick<Song, 'locks'>, sectionId: Id): boolean {
  const l = song.locks;
  return (
    isLocked(l, LockKeys.chords) ||
    isLocked(l, LockKeys.sectionChords(sectionId)) ||
    isLocked(l, LockKeys.section(sectionId))
  );
}

export function isLyricsSectionLocked(song: Pick<Song, 'locks'>, sectionId: Id): boolean {
  const l = song.locks;
  return (
    isLocked(l, LockKeys.lyrics) ||
    isLocked(l, LockKeys.sectionLyrics(sectionId)) ||
    isLocked(l, LockKeys.section(sectionId))
  );
}

export interface LockedRange {
  startTick: Ticks;
  endTick: Ticks;
  sectionId: Id;
}

/** Tick ranges of a track that are locked (whole track → whole song). */
export function lockedRangesForTrack(song: Song, trackId: Id): LockedRange[] {
  return sectionLayout(song)
    .filter((s) => isTrackSectionLocked(song, trackId, s.section.id))
    .map((s) => ({ startTick: s.startTick, endTick: s.endTick, sectionId: s.section.id }));
}

/** Whether a specific note is protected (note lock, or it starts inside a locked range). */
export function isNoteLocked(song: Song, track: Track, note: Note): boolean {
  if (note.locked) return true;
  if (isLocked(song.locks, LockKeys.track(track.id))) return true;
  return lockedRangesForTrack(song, track.id).some((r) => note.tick >= r.startTick && note.tick < r.endTick);
}

/** Notes of a track that must survive any regeneration unchanged. */
export function lockedNotes(song: Song, track: Track): Note[] {
  const ranges = lockedRangesForTrack(song, track.id);
  const whole = isLocked(song.locks, LockKeys.track(track.id));
  return track.notes.filter(
    (n) => n.locked || whole || ranges.some((r) => n.tick >= r.startTick && n.tick < r.endTick),
  );
}

/** Count of locked components (for UI badges). */
export function lockCount(locks: LockMap): number {
  return Object.values(locks).filter(Boolean).length;
}
