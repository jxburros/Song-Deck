/**
 * Cell engine: (re)generates track × section cells into a song.
 *
 * Lock guarantee (spec §22): cells under a track / section / track×section lock are never touched;
 * note-level locks survive; with a region (§39 "Regenerate bars 33–41") only notes lying entirely
 * inside the region are replaced and notes crossing its edges are kept. New notes never overlap
 * kept material on monophonic instruments and never duplicate a kept attack.
 */
import type { Note, Phrase, Track } from '../ir/types';
import { sortNotes, stableStringify } from '../ir/song-utils';
import { IdFactory } from '../util/ids';
import { LockKeys, isLocked, isTrackSectionLocked } from '../locks';
import { makeCell, type SongGen } from './context';
import { generationPriority, runGenerator } from './generators';
import { finalizeNotes, resolveSamePitchOverlaps, type RawNote } from './util';

export interface CellScope {
  trackIds?: Set<string>;
  sectionIds?: Set<string>;
  /** [start, end) region in ticks. */
  region?: { start: number; end: number };
  /** Extra per-cell predicate (variation amount, level filters). */
  filter?: (track: Track, sectionId: string) => boolean;
  /** Respect locks (always true for user-facing regeneration). */
  respectLocks: boolean;
}

export interface CellChange {
  trackId: string;
  sectionIds: string[];
}

function overlaps(a: { tick: number; duration: number }, b: { tick: number; duration: number }): boolean {
  return a.tick < b.tick + b.duration && b.tick < a.tick + a.duration;
}

/** Tracks in generation order (dependencies first). */
export function orderedTracks(g: SongGen): Track[] {
  return g.song.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.kind === 'midi')
    .map(({ t, i }) => {
      const inst = g.instrumentOf(t);
      const fn = t.constraints?.function ?? inst.defaultFunction;
      return { t, i, p: generationPriority(t, inst, fn, g.principalMelodyId) };
    })
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.t);
}

/**
 * Generate every cell in scope into `g.song` (mutates it). Returns the cells whose notes changed.
 * `seed` drives the generators; ids are scoped per track/section(/region) so they never collide.
 */
export function writeCells(g: SongGen, seed: number, scope: CellScope): CellChange[] {
  const song = g.song;
  const changes = new Map<string, string[]>();
  for (const track of orderedTracks(g)) {
    if (scope.trackIds && !scope.trackIds.has(track.id)) continue;
    if (scope.respectLocks && isLocked(song.locks, LockKeys.track(track.id))) continue;
    let touched = false;
    g.spans.forEach((span, spanIndex) => {
      const section = span.section;
      if (scope.sectionIds && !scope.sectionIds.has(section.id)) return;
      const region = scope.region;
      if (region && (span.endTick <= region.start || span.startTick >= region.end)) return;
      if (scope.respectLocks && isTrackSectionLocked(song, track.id, section.id)) return;
      if (scope.filter && !scope.filter(track, section.id)) return;
      const cell = makeCell(g, track, spanIndex, seed);
      const out = g.plays(track.id, section.id) ? runGenerator(cell) : { notes: [] as RawNote[] };
      const inst = cell.inst;
      const drum = inst.isDrumKit === true;
      const mono = !drum && inst.polyphony === 'mono';
      const rs = region ? Math.max(region.start, span.startTick) : span.startTick;
      const re = region ? Math.min(region.end, span.endTick) : span.endTick;
      const generated = finalizeNotes(out.notes, { low: drum ? 0 : cell.range.low, high: drum ? 127 : cell.range.high, start: span.startTick, end: span.endTick, mono, drum });

      const before = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
      const inside = (n: { tick: number; duration: number }) => (region ? n.tick >= rs && n.tick + n.duration <= re : true);
      const kept = before.filter((n) => n.locked === true || !inside(n));
      // Material that must not be overlapped: kept notes plus notes ringing in from earlier sections.
      const blockers = [...kept, ...track.notes.filter((n) => n.tick < span.startTick && n.tick + n.duration > span.startTick)];
      const candidates = generated.filter((n) => inside(n));
      const accepted: RawNote[] = [];
      for (const n of candidates) {
        if (mono ? blockers.some((k) => overlaps(k, n)) : blockers.some((k) => k.pitch === n.pitch && (k.tick === n.tick || (!drum && overlaps(k, n))))) continue;
        accepted.push(n);
      }
      // Ids: deterministic per (seed, track, section[, region]); never colliding with kept notes.
      const ids = new IdFactory(seed, `n/${track.id}/${section.id}${region ? `/${rs}-${re}` : ''}`);
      const used = new Set(track.notes.map((n) => n.id));
      for (const k of before) if (!kept.includes(k)) used.delete(k.id);
      // Phrases (vocal): only phrases fully inside the regenerated window are replaced.
      const phraseIds = new Map<string, string>();
      const newPhrases: Phrase[] = [];
      const pids = new IdFactory(seed, `ph/${track.id}/${section.id}${region ? `/${rs}-${re}` : ''}`);
      for (const d of out.phrases ?? []) {
        if (d.startTick < rs || d.endTick > re) continue;
        const members = accepted.filter((n) => n.phraseId === d.key);
        if (!members.length) continue;
        // Humanized timing can move a phrase's notes slightly outside the planned span: the record
        // covers every note of the phrase.
        const startTick = Math.min(d.startTick, ...members.map((n) => n.tick));
        const endTick = Math.max(d.endTick, ...members.map((n) => n.tick + n.duration));
        const ph: Phrase = { id: pids.next('ph'), trackId: track.id, startTick, endTick, label: d.label, sectionId: section.id };
        if (d.motifId) ph.motifId = d.motifId;
        if (d.lyricLineId) ph.lyricLineId = d.lyricLineId;
        phraseIds.set(d.key, ph.id);
        newPhrases.push(ph);
      }
      const newNotes: Note[] = accepted.map((n) => {
        let id = ids.next('n');
        let k = 1;
        while (used.has(id)) id = `${id.split('~')[0]}~${k++}`;
        used.add(id);
        const note: Note = { id, pitch: n.pitch, tick: n.tick, duration: n.duration, velocity: n.velocity };
        if (n.articulation && n.articulation !== 'normal') note.articulation = n.articulation;
        if (n.motifId) note.motifId = n.motifId;
        const pid = n.phraseId ? phraseIds.get(n.phraseId) : undefined;
        if (pid) note.phraseId = pid;
        if (n.syllable) note.syllable = n.syllable;
        if (n.lyricLineId) note.lyricLineId = n.lyricLineId;
        if (n.expression && Object.keys(n.expression).length) note.expression = n.expression;
        note.origin = `composer/${track.role}`;
        return note;
      });
      const outside = track.notes.filter((n) => n.tick < span.startTick || n.tick >= span.endTick);
      // New attacks never collide with the tails of kept notes of the same pitch (and vice versa).
      const fresh = new Set(newNotes);
      const nextNotes = sortNotes(resolveSamePitchOverlaps([...outside, ...kept, ...newNotes], (n) => !fresh.has(n), 'drop'));
      const changed = stableStringify(before) !== stableStringify(nextNotes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick));
      track.notes = nextNotes;
      if (track.role === 'vocal' || (out.phrases && out.phrases.length)) {
        const keptPhraseIds = new Set(kept.map((n) => n.phraseId).filter(Boolean) as string[]);
        song.phrases = [
          ...song.phrases.filter(
            (p) => p.trackId !== track.id || p.startTick < span.startTick || p.startTick >= span.endTick || keptPhraseIds.has(p.id) || p.startTick < rs || p.endTick > re,
          ),
          ...newPhrases,
        ].sort((a, b) => a.startTick - b.startTick || a.trackId.localeCompare(b.trackId));
      }
      if (changed) {
        changes.set(track.id, [...(changes.get(track.id) ?? []), section.id]);
        touched = true;
      }
    });
    if (touched) track.generator = { id: `composer/${track.role}`, seed };
  }
  return [...changes.entries()].map(([trackId, sectionIds]) => ({ trackId, sectionIds }));
}
