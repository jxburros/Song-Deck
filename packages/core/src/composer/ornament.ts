/**
 * Ornament-level variation (spec §24 "Ornament": change fills, ornamentation, velocity and
 * articulations; preserve almost everything else). Pitches and rhythms of existing notes never
 * change; drum fills are re-rolled in the fill window and grace notes may be added to secondary
 * melodic lines (never to the principal melody). Locked material is untouched.
 */
import type { Articulation, Note, Song, Track } from '../ir/types';
import { PPQ } from '../ir/types';
import { sortNotes } from '../ir/song-utils';
import { IdFactory } from '../util/ids';
import { deriveRng } from '../util/random';
import { LockKeys, isLocked, isTrackSectionLocked } from '../locks';
import { transposeDiatonic } from '../theory/scales';
import { keyAtTick } from '../timing';
import { buildSongGen, makeCell, type GenSettings } from './context';
import type { CellChange } from './engine';
import { generateDrums } from './generators/drums';
import { clamp01, finalizeNotes, resolveSamePitchOverlaps, toVelocity } from './util';

export interface OrnamentScope {
  trackIds?: Set<string>;
  sectionIds?: Set<string>;
  region?: { start: number; end: number };
}

const MELODIC_ROLES = new Set(['lead-guitar', 'synth-lead', 'strings', 'custom']);

function newArticulation(track: Track, family: string, n: Note, rnd: () => number): Articulation | undefined {
  const short = n.duration <= PPQ / 2;
  const long = n.duration >= PPQ;
  switch (family) {
    case 'guitar':
      if (track.role === 'lead-guitar') return long ? (rnd() < 0.5 ? 'bend' : 'slide') : n.articulation;
      return short ? (n.articulation === 'palm-mute' ? undefined : 'palm-mute') : n.articulation;
    case 'strings':
      return short ? 'staccato' : long ? (rnd() < 0.7 ? 'legato' : 'tenuto') : n.articulation;
    case 'brass':
    case 'woodwind':
      return short ? 'staccato' : long ? 'tenuto' : 'accent';
    case 'keys':
    case 'organ':
      return short ? 'staccato' : 'tenuto';
    case 'bass':
      return short ? 'staccato' : n.articulation;
    case 'synth':
      return short ? 'staccato' : 'legato';
    default:
      return n.articulation;
  }
}

/** Ornament the song in place. Returns the cells that changed. */
export function ornamentSong(song: Song, seed: number, amount: number, scope: OrnamentScope, settings: Omit<GenSettings, 'seed'> = {}): CellChange[] {
  const a = clamp01(amount);
  if (a <= 0) return [];
  const g = buildSongGen(song, { ...settings, seed });
  const changes: CellChange[] = [];
  for (const track of song.tracks) {
    if (track.kind !== 'midi') continue;
    if (scope.trackIds && !scope.trackIds.has(track.id)) continue;
    if (isLocked(song.locks, LockKeys.track(track.id))) continue;
    const inst = g.instrumentOf(track);
    const principal = track.id === g.principalMelodyId;
    const changedSections: string[] = [];
    g.spans.forEach((span, spanIndex) => {
      const sid = span.section.id;
      if (scope.sectionIds && !scope.sectionIds.has(sid)) return;
      if (isTrackSectionLocked(song, track.id, sid)) return;
      const rs = scope.region ? Math.max(scope.region.start, span.startTick) : span.startTick;
      const re = scope.region ? Math.min(scope.region.end, span.endTick) : span.endTick;
      if (re <= rs) return;
      const inWindow = (n: Note) => n.tick >= rs && n.tick + n.duration <= re;
      const origIds = new Set(track.notes.map((n) => n.id));
      let changed = false;
      const rngCell = deriveRng(seed, 'ornament', track.id, sid);
      // 1. Velocities, articulations and vocal expression on unlocked notes.
      track.notes = track.notes.map((n) => {
        if (n.tick < span.startTick || n.tick >= span.endTick || n.locked || !inWindow(n)) return n;
        const r = deriveRng(seed, 'ornament', track.id, n.id);
        const out: Note = { ...n };
        out.velocity = toVelocity(n.velocity + Math.round(r.gaussian(0, 0.5) * 16 * a));
        if (!inst.isDrumKit && r.chance(a * 0.3)) {
          if (principal && track.role === 'vocal') {
            const expr = { ...(n.expression ?? {}) };
            expr.vibrato = Math.round(clamp01((expr.vibrato ?? 0.3) + r.range(-0.2, 0.2) * a) * 100) / 100;
            if (r.chance(0.3)) expr.onset = r.pick(['soft', 'normal', 'scoop'] as const);
            out.expression = expr;
          } else {
            const art = newArticulation(track, inst.family === 'bass' ? 'bass' : inst.family, n, () => r.next());
            if (art && art !== 'normal') out.articulation = art;
            else delete out.articulation;
          }
        }
        if (out.velocity !== n.velocity || out.articulation !== n.articulation || out.expression !== n.expression) changed = true;
        return out;
      });
      // 2. Drum fills re-rolled at the section end.
      if (inst.isDrumKit && track.role === 'drums' && span.index < g.spans.length - 1 && g.plays(track.id, sid) && rngCell.chance(0.35 + a * 0.65)) {
        const cell = makeCell(g, track, spanIndex, seed ^ 0x5bd1e995);
        const bar = cell.bars[cell.bars.length - 1];
        const fillStart = Math.max(rs, bar.tick + bar.meter.barTicks - (cell.e1 >= 0.6 ? 2 : 1) * bar.meter.beatTicks);
        const fillEnd = Math.min(re, span.endTick);
        if (fillEnd > fillStart) {
          const fresh = finalizeNotes(generateDrums(cell), { low: 0, high: 127, start: span.startTick, end: span.endTick, drum: true }).filter((n) => n.tick >= fillStart && n.tick + n.duration <= fillEnd);
          const locked = track.notes.filter((n) => n.tick >= fillStart && n.tick < fillEnd && (n.locked || n.tick + n.duration > fillEnd));
          const ids = new IdFactory(seed, `orn/${track.id}/${sid}`);
          const used = new Set(track.notes.map((n) => n.id));
          const added: Note[] = [];
          for (const n of fresh) {
            if (locked.some((l) => l.pitch === n.pitch && l.tick === n.tick)) continue;
            let id = ids.next('n');
            while (used.has(id)) id = ids.next('n');
            used.add(id);
            const note: Note = { id, pitch: n.pitch, tick: n.tick, duration: n.duration, velocity: n.velocity, origin: 'composer/ornament' };
            if (n.articulation && n.articulation !== 'normal') note.articulation = n.articulation;
            added.push(note);
          }
          const keep = track.notes.filter((n) => !(n.tick >= fillStart && n.tick < fillEnd && !n.locked && n.tick + n.duration <= fillEnd));
          track.notes = sortNotes([...keep, ...added]);
          changed = true;
        }
      }
      // 3. Grace notes before long notes of secondary melodic lines.
      if (!principal && !inst.isDrumKit && inst.polyphony === 'mono' && (MELODIC_ROLES.has(track.role) || inst.family === 'woodwind' || inst.family === 'brass')) {
        const ids = new IdFactory(seed, `grace/${track.id}/${sid}`);
        const used = new Set(track.notes.map((n) => n.id));
        const sorted = [...track.notes].sort((x, y) => x.tick - y.tick);
        const added: Note[] = [];
        for (let i = 0; i < sorted.length; i++) {
          const n = sorted[i];
          if (n.tick < rs || n.tick >= re || n.duration < PPQ || n.locked) continue;
          if (!deriveRng(seed, 'grace', n.id).chance(a * 0.25)) continue;
          const t = n.tick - 40;
          const prev = sorted[i - 1];
          if (t < Math.max(rs, span.startTick) || (prev && prev.tick + prev.duration > t)) continue;
          const key = keyAtTick(song, n.tick);
          const p = transposeDiatonic(n.pitch, 1, key);
          let id = ids.next('n');
          while (used.has(id)) id = ids.next('n');
          used.add(id);
          added.push({ id, pitch: p, tick: t, duration: 36, velocity: toVelocity(n.velocity - 12), origin: 'composer/ornament' });
        }
        if (added.length) {
          track.notes = sortNotes([...track.notes, ...added]);
          changed = true;
        }
      }
      if (changed) {
        // Re-rolled fills and grace notes must not collide with ringing notes of the same pitch:
        // locked notes (and, off the drum kit, all original notes) win; new notes yield.
        track.notes = resolveSamePitchOverlaps(track.notes, (n) => n.locked === true || (!inst.isDrumKit && origIds.has(n.id)), 'drop');
        changedSections.push(sid);
      }
    });
    if (changedSections.length) changes.push({ trackId: track.id, sectionIds: changedSections });
  }
  return changes;
}
