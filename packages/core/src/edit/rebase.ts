import type { MixerState, Song, Track } from '../ir/types';
import { cloneSong, sortNotes, stableStringify } from '../ir/song-utils';

/**
 * Three-way merge of a proposal onto the song as it is now (spec §21).
 *
 * A proposal records the song it was computed against (`before`) and the proposed song
 * (`after`). While it is pending the user can keep editing, accept other proposals, or receive
 * collaborators' revisions. Accepting must apply only what the proposal changed and keep every
 * other edit. Items with ids (tracks, notes, audio clips, lyric lines, motifs, phrases,
 * automation lanes, mixer channels, lock keys) merge individually; everything else (tempo, key
 * and meter maps, sections, chords, settings…) merges as a unit.
 *
 * When the proposal and a later edit changed the same item, the proposal's version wins and the
 * item is reported as a conflict. Items deleted since the proposal was made stay deleted.
 */

export interface RebaseResult {
  song: Song;
  /** Human-readable parts that were changed both by the proposal and since it was made. */
  conflicts: string[];
}

const same = (a: unknown, b: unknown): boolean => a === b || stableStringify(a) === stableStringify(b);
const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

class Conflicts {
  private counts = new Map<string, number>();
  add(label: string) {
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([label, n]) => (n > 1 ? `${label} (${n})` : label));
  }
}

function mergeUnit<T>(base: T, proposed: T, current: T, label: string, conflicts: Conflicts): T {
  if (same(base, proposed)) return current;
  if (!same(base, current) && !same(proposed, current)) conflicts.add(label);
  return copy(proposed);
}

function freshId(id: string, taken: (id: string) => boolean): string {
  for (let i = 2; ; i++) if (!taken(`${id}_${i}`)) return `${id}_${i}`;
}

function mergeById<T extends { id: string }>(
  base: readonly T[],
  proposed: readonly T[],
  current: readonly T[],
  label: (item: T) => string,
  conflicts: Conflicts,
  mergeItem?: (b: T, p: T, c: T) => T,
): T[] {
  const B = new Map(base.map((x) => [x.id, x]));
  const P = new Map(proposed.map((x) => [x.id, x]));
  const C = new Map(current.map((x) => [x.id, x]));
  const out: T[] = [];
  for (const c of current) {
    const b = B.get(c.id);
    const p = P.get(c.id);
    if (!b)
      out.push(c); // added since the proposal was made
    else if (!p) {
      // The proposal removes it.
      if (!same(b, c)) conflicts.add(`${label(c)}: removed by the proposal but edited since`);
    } else if (same(b, p)) out.push(c);
    else if (mergeItem) out.push(mergeItem(b, p, c));
    else {
      if (!same(b, c) && !same(p, c)) conflicts.add(label(c));
      out.push(copy(p));
    }
  }
  const used = new Set(out.map((x) => x.id));
  for (const [id, p] of P) {
    const b = B.get(id);
    if (!b) {
      // Added by the proposal (a fresh id if it collides with something added since).
      const item = copy(p);
      if (C.has(id)) item.id = freshId(id, (x) => used.has(x) || P.has(x));
      used.add(item.id);
      out.push(item);
    } else if (!C.has(id) && !same(b, p))
      conflicts.add(`${label(p)}: changed by the proposal but deleted since`);
  }
  return out;
}

function mergeTrack(b: Track, p: Track, c: Track, conflicts: Conflicts): Track {
  const out: Record<string, unknown> = { ...c };
  const keys = new Set([...Object.keys(b), ...Object.keys(p), ...Object.keys(c)]);
  for (const key of keys) {
    if (key === 'id' || key === 'notes' || key === 'clips') continue;
    const k = key as keyof Track;
    const v = mergeUnit(b[k], p[k], c[k], `Track "${c.name}": ${key}`, conflicts);
    if (v === undefined) delete out[key];
    else out[key] = v;
  }
  const track = out as unknown as Track;
  track.notes = sortNotes(mergeById(b.notes, p.notes, c.notes, () => `Notes on "${c.name}"`, conflicts));
  track.clips = mergeById(
    b.clips ?? [],
    p.clips ?? [],
    c.clips ?? [],
    () => `Audio clips on "${c.name}"`,
    conflicts,
  );
  return track;
}

function mergeMixer(
  b: MixerState,
  p: MixerState,
  c: MixerState,
  trackName: (id: string) => string,
  conflicts: Conflicts,
): MixerState {
  const channels = { ...c.channels };
  for (const id of new Set([
    ...Object.keys(b.channels),
    ...Object.keys(p.channels),
    ...Object.keys(c.channels),
  ])) {
    const v = mergeUnit(b.channels[id], p.channels[id], c.channels[id], `Mixer: ${trackName(id)}`, conflicts);
    if (v === undefined) delete channels[id];
    else channels[id] = v;
  }
  return {
    ...c,
    channels,
    master: mergeUnit(b.master, p.master, c.master, 'Mixer: master', conflicts),
    reverb: mergeUnit(b.reverb, p.reverb, c.reverb, 'Mixer: reverb bus', conflicts),
    delay: mergeUnit(b.delay, p.delay, c.delay, 'Mixer: delay bus', conflicts),
  };
}

const UNIT_FIELDS = [
  ['title', 'Title'],
  ['tempoMap', 'Tempo'],
  ['meterMap', 'Meter'],
  ['keyMap', 'Key'],
  ['sections', 'Structure'],
  ['chords', 'Chords'],
  ['macros', 'Macros'],
  ['genreBlend', 'Genre blend'],
  ['blueprint', 'Blueprint'],
  ['plan', 'Composition plan'],
  ['dna', 'Song DNA'],
  ['generation', 'Generation settings'],
  ['production', 'Production settings'],
  ['vocals', 'Vocal settings'],
  ['mastering', 'Mastering settings'],
] as const satisfies readonly (readonly [keyof Song, string])[];

/** Apply what changed from `before` to `after` onto `current`. */
export function rebaseProposal(before: Song, after: Song, current: Song): RebaseResult {
  if (same(before, current)) return { song: cloneSong(after), conflicts: [] };
  const conflicts = new Conflicts();
  // Merge into a clone of the current song so the result shares no objects with it.
  const song = cloneSong(current);
  const now = cloneSong(current);
  const out = song as unknown as Record<string, unknown>;
  for (const [key, label] of UNIT_FIELDS) {
    if (same(before[key], after[key])) continue;
    const v = mergeUnit(before[key], after[key], now[key], label, conflicts);
    if (v === undefined) delete out[key];
    else out[key] = v;
  }
  const nameOf = (id: string) =>
    now.tracks.find((t) => t.id === id)?.name ?? after.tracks.find((t) => t.id === id)?.name ?? id;
  song.tracks = mergeById(
    before.tracks,
    after.tracks,
    now.tracks,
    (t) => `Track "${t.name}"`,
    conflicts,
    (b, p, c) => mergeTrack(b, p, c, conflicts),
  );
  song.lyrics = mergeById(before.lyrics, after.lyrics, now.lyrics, () => 'Lyrics', conflicts);
  song.motifs = mergeById(before.motifs, after.motifs, now.motifs, (m) => `Motif "${m.name}"`, conflicts);
  song.phrases = mergeById(before.phrases, after.phrases, now.phrases, () => 'Phrases', conflicts);
  song.automation = mergeById(
    before.automation,
    after.automation,
    now.automation,
    (l) => `Automation: ${l.target === 'master' ? 'master' : nameOf(l.target)} ${l.param}`,
    conflicts,
  );
  song.mixer = mergeMixer(before.mixer, after.mixer, now.mixer, nameOf, conflicts);
  const locks = { ...now.locks };
  for (const key of new Set([
    ...Object.keys(before.locks),
    ...Object.keys(after.locks),
    ...Object.keys(now.locks),
  ])) {
    const v = mergeUnit(before.locks[key], after.locks[key], now.locks[key], `Lock ${key}`, conflicts);
    if (v === undefined) delete locks[key];
    else locks[key] = v;
  }
  song.locks = locks;
  return { song, conflicts: conflicts.list() };
}
