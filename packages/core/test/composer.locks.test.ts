import { describe, expect, it } from 'vitest';
import { composeSong, parsePromptToBlueprint, regenerateUnlocked } from '../src/composer';
import { interpretVocalInstruction } from '../src/musician';
import { cloneSong, stableStringify } from '../src/ir/song-utils';
import { LockKeys, isChordSectionLocked, isNoteLocked, isTrackSectionLocked } from '../src/locks';
import { regionToTicks, sectionLayout } from '../src/timing';
import { createRng } from '../src/util/random';
import type { Song } from '../src/ir/types';
import { validityProblems } from './composer-helpers';

const PROMPT =
  'Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.';
const base = composeSong(parsePromptToBlueprint(PROMPT, { seed: 11 }));

/** Everything the lock map protects, serialized for byte comparison. */
function lockedMaterial(song: Song): string {
  const spans = sectionLayout(song);
  const out: Record<string, unknown> = {};
  const L = song.locks;
  if (L[LockKeys.tempo]) out.tempo = song.tempoMap;
  if (L[LockKeys.key]) out.key = song.keyMap;
  if (L[LockKeys.meter]) out.meter = song.meterMap;
  if (L[LockKeys.structure]) out.structure = song.sections;
  if (L[LockKeys.chords]) out.chords = song.chords;
  if (L[LockKeys.lyrics]) out.lyrics = song.lyrics;
  if (L[LockKeys.motifs]) out.motifs = song.motifs;
  for (const m of song.motifs) if (L[LockKeys.motif(m.id)]) out[`motif:${m.id}`] = m;
  for (const sp of spans) {
    if (isChordSectionLocked(song, sp.section.id))
      out[`chords:${sp.section.id}`] = song.chords.filter(
        (c) => c.tick >= sp.startTick && c.tick < sp.endTick,
      );
  }
  for (const t of song.tracks) {
    if (L[LockKeys.track(t.id)]) {
      out[`track:${t.id}`] = t;
      continue;
    }
    for (const sp of spans) {
      if (!isTrackSectionLocked(song, t.id, sp.section.id)) continue;
      out[`cell:${t.id}:${sp.section.id}`] = {
        notes: t.notes.filter((n) => n.tick >= sp.startTick && n.tick < sp.endTick),
        phrases: song.phrases.filter(
          (p) => p.trackId === t.id && p.startTick >= sp.startTick && p.startTick < sp.endTick,
        ),
      };
    }
    for (const n of t.notes) if (n.locked) out[`note:${t.id}:${n.id}`] = n;
    if (L[LockKeys.mixer(t.id)]) out[`mixer:${t.id}`] = song.mixer.channels[t.id];
  }
  return stableStringify(out);
}

function withRandomLocks(song: Song, seed: number): Song {
  const s = cloneSong(song);
  const rng = createRng(seed);
  const locks: Record<string, boolean> = {};
  const pick = <T>(xs: T[]) => xs[rng.int(0, xs.length - 1)];
  const tracks = s.tracks;
  const sections = s.sections;
  locks[LockKeys.track(pick(tracks).id)] = true;
  for (let i = 0; i < 3; i++) locks[LockKeys.trackSection(pick(tracks).id, pick(sections).id)] = true;
  locks[LockKeys.section(pick(sections).id)] = true;
  locks[LockKeys.sectionChords(pick(sections).id)] = true;
  locks[LockKeys.motif(pick(s.motifs).id)] = true;
  locks[LockKeys.mixer(pick(tracks).id)] = true;
  for (const k of [LockKeys.tempo, LockKeys.key, LockKeys.meter, LockKeys.structure, LockKeys.lyrics])
    if (rng.chance(0.5)) locks[k] = true;
  if (rng.chance(0.3)) locks[LockKeys.chords] = true;
  if (rng.chance(0.3)) locks[LockKeys.motifs] = true;
  s.locks = locks;
  // Note-level locks on ~10% of the notes of two tracks.
  for (const t of [pick(tracks), pick(tracks)])
    t.notes = t.notes.map((n) => (rng.chance(0.1) ? { ...n, locked: true } : n));
  s.lyrics = [{ id: 'ly1', sectionId: sections[1].id, text: 'Under the streetlights I wait for the rain' }];
  return s;
}

describe('regenerateUnlocked: lock guarantee (§22)', () => {
  it('leaves every kind of locked material byte-identical across many seeds', () => {
    for (let seed = 1; seed <= 16; seed++) {
      const song = withRandomLocks(base, seed);
      const before = lockedMaterial(song);
      const res = regenerateUnlocked(song, { seed: 1000 + seed, includeChords: seed % 2 === 0 });
      expect(lockedMaterial(res.song), `seed ${seed}`).toBe(before);
      expect(res.song.locks).toEqual(song.locks);
      expect(validityProblems(res.song), `seed ${seed}`).toEqual([]);
      expect(res.changed.length).toBeGreaterThan(0);
      for (const ch of res.changed)
        for (const sid of ch.sectionIds) expect(isTrackSectionLocked(song, ch.trackId, sid)).toBe(false);
    }
  });

  it('does not mutate its input', () => {
    const song = withRandomLocks(base, 3);
    const snapshot = stableStringify(song);
    regenerateUnlocked(song, { seed: 5, includeChords: true });
    expect(stableStringify(song)).toBe(snapshot);
  });

  it('regenerates the bass while harmony, vocal, drums and violin are locked (§73)', () => {
    const song = cloneSong(base);
    const id = (role: string, inst?: string) =>
      song.tracks.find((t) => t.role === role && (!inst || t.instrumentId === inst))!.id;
    song.locks = {
      [LockKeys.chords]: true,
      [LockKeys.track(id('vocal'))]: true,
      [LockKeys.track(id('drums'))]: true,
      [LockKeys.track(id('strings', 'violin'))]: true,
    };
    const before = lockedMaterial(song);
    const bassId = id('bass');
    const res = regenerateUnlocked(song, { seed: 4242, trackIds: [bassId] });
    expect(lockedMaterial(res.song)).toBe(before);
    expect(res.changed.map((c) => c.trackId)).toEqual([bassId]);
    for (const t of res.song.tracks)
      if (t.id !== bassId) expect(t).toEqual(song.tracks.find((x) => x.id === t.id));
    expect(res.song.tracks.find((t) => t.id === bassId)!.notes).not.toEqual(
      song.tracks.find((t) => t.id === bassId)!.notes,
    );
    // The bass still locks to the (unchanged) kick and follows the locked chords.
    expect(validityProblems(res.song)).toEqual([]);
  });

  it('restricts regeneration to sections', () => {
    const verse = base.sections.find((s) => s.kind === 'verse')!;
    const res = regenerateUnlocked(base, { seed: 8, sectionIds: [verse.id] });
    const spans = sectionLayout(base);
    const sp = spans.find((s) => s.section.id === verse.id)!;
    for (const t of res.song.tracks) {
      const orig = base.tracks.find((x) => x.id === t.id)!;
      const outside = (n: { tick: number }) => n.tick < sp.startTick || n.tick >= sp.endTick;
      expect(t.notes.filter(outside)).toEqual(orig.notes.filter(outside));
    }
    expect(res.changed.every((c) => c.sectionIds.every((s) => s === verse.id))).toBe(true);
    expect(res.changed.length).toBeGreaterThan(0);
  });

  it('only changes material inside a region ("Regenerate bars 33–41")', () => {
    const region = regionToTicks(base, { start_bar: 33, end_bar: 41 });
    for (const seed of [1, 2, 3, 4]) {
      const song = withRandomLocks(base, 50 + seed);
      const res = regenerateUnlocked(song, {
        seed: 300 + seed,
        startTick: region.startTick,
        endTick: region.endTick,
        includeChords: true,
      });
      for (const t of res.song.tracks) {
        const orig = song.tracks.find((x) => x.id === t.id)!;
        const keep = (n: { tick: number; duration: number }) =>
          n.tick < region.startTick || n.tick + n.duration > region.endTick;
        // Notes outside the region and notes crossing its edges are preserved exactly.
        expect(t.notes.filter(keep), t.name).toEqual(orig.notes.filter(keep));
        // Everything new lies inside the region.
        for (const n of t.notes)
          if (!orig.notes.some((o) => o.id === n.id)) {
            expect(n.tick).toBeGreaterThanOrEqual(region.startTick);
            expect(n.tick + n.duration).toBeLessThanOrEqual(region.endTick);
          }
      }
      const outsideChords = (s: Song) =>
        s.chords.filter((c) => c.tick < region.startTick || c.tick + c.duration > region.endTick);
      expect(outsideChords(res.song)).toEqual(outsideChords(song));
      expect(lockedMaterial(res.song)).toBe(lockedMaterial(song));
      expect(validityProblems(res.song)).toEqual([]);
    }
    const res = regenerateUnlocked(base, { seed: 999, startTick: region.startTick, endTick: region.endTick });
    const changedNotes = res.song.tracks.reduce(
      (n, t) =>
        n +
        t.notes.filter((x) => !base.tracks.find((o) => o.id === t.id)!.notes.some((o) => o.id === x.id))
          .length,
      0,
    );
    expect(changedNotes).toBeGreaterThan(0);
  });

  it('keeps note-level locks and never overlaps them on monophonic tracks', () => {
    const song = cloneSong(base);
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    vocal.notes = vocal.notes.map((n, i) => (i % 3 === 0 ? { ...n, locked: true } : n));
    const res = regenerateUnlocked(song, { seed: 61, trackIds: [vocal.id] });
    const after = res.song.tracks.find((t) => t.id === vocal.id)!;
    for (const n of vocal.notes.filter((x) => x.locked)) expect(after.notes).toContainEqual(n);
    for (let i = 1; i < after.notes.length; i++)
      expect(after.notes[i].tick).toBeGreaterThanOrEqual(
        after.notes[i - 1].tick + after.notes[i - 1].duration,
      );
    for (const t of res.song.tracks)
      for (const n of t.notes)
        if (isNoteLocked(song, t, n)) expect(song.tracks.find((x) => x.id === t.id)!.notes).toContainEqual(n);
  });

  it('re-plans unlocked chords only when asked, and motifs only when nothing depends on them', () => {
    const plain = regenerateUnlocked(base, { seed: 12 });
    expect(plain.song.chords).toEqual(base.chords);
    const withChords = regenerateUnlocked(base, { seed: 12, includeChords: true });
    expect(withChords.song.chords).not.toEqual(base.chords);
    // A fresh full regeneration writes new motifs…
    expect(plain.song.motifs).not.toEqual(base.motifs);
    // …but not when the motifs are locked or the scope is partial.
    const locked = cloneSong(base);
    locked.locks = { [LockKeys.motifs]: true };
    expect(regenerateUnlocked(locked, { seed: 12 }).song.motifs).toEqual(base.motifs);
    expect(regenerateUnlocked(base, { seed: 12, sectionIds: [base.sections[1].id] }).song.motifs).toEqual(
      base.motifs,
    );
  });
});

describe('vocal regeneration through the composer (§37)', () => {
  it('phrase records cover every note of their phrase, even after humanized timing', () => {
    for (const seed of [3, 11, 29]) {
      const bp = parsePromptToBlueprint(
        'Loose, laid-back indie rock with a male vocal, guitars, bass and drums.',
        { seed },
      );
      const song = composeSong(bp, undefined, { seed });
      const vocal = song.tracks.find((t) => t.role === 'vocal')!;
      const byId = new Map(song.phrases.map((p) => [p.id, p]));
      const members = vocal.notes.filter((n) => n.phraseId);
      expect(members.length).toBeGreaterThan(0);
      for (const n of members) {
        const ph = byId.get(n.phraseId!)!;
        expect(ph, `phrase ${n.phraseId}`).toBeTruthy();
        expect(n.tick).toBeGreaterThanOrEqual(ph.startTick);
        expect(n.tick + n.duration).toBeLessThanOrEqual(ph.endTick);
      }
    }
  });

  it('"Regenerate only the second chorus vocal" changes that chorus vocal and nothing else', () => {
    const bp = parsePromptToBlueprint(
      'Pop song in G major at 120 BPM with a female vocal, piano, bass and drums.',
      { seed: 11 },
    );
    const song = composeSong(bp, undefined, { seed: 11 });
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    expect(vocal).toBeTruthy();
    const r = interpretVocalInstruction(
      song,
      vocal.id,
      'Regenerate only the second chorus vocal',
      {},
      { seed: 5 },
    );
    const op = r.operations[0] as Extract<(typeof r.operations)[number], { op: 'regenerate' }>;
    expect(op?.op).toBe('regenerate');
    const chorus2 = sectionLayout(song).filter((s) => s.section.kind === 'chorus')[1];
    const next = regenerateUnlocked(song, {
      seed: op.seed!,
      trackIds: [vocal.id],
      sectionIds: op.sections,
      level: op.level,
    }).song;
    const inChorus2 = (s: Song) =>
      stableStringify(
        s.tracks
          .find((t) => t.id === vocal.id)!
          .notes.filter((n) => n.tick >= chorus2.startTick && n.tick < chorus2.endTick)
          .map((n) => [n.tick, n.pitch, n.duration]),
      );
    const outside = (s: Song) =>
      stableStringify(
        s.tracks
          .find((t) => t.id === vocal.id)!
          .notes.filter((n) => n.tick < chorus2.startTick || n.tick >= chorus2.endTick)
          .map((n) => [n.tick, n.pitch, n.duration]),
      );
    expect(inChorus2(next)).not.toBe(inChorus2(song));
    expect(outside(next)).toBe(outside(song));
    for (const t of song.tracks)
      if (t.id !== vocal.id)
        expect(stableStringify(next.tracks.find((x) => x.id === t.id)!.notes)).toBe(stableStringify(t.notes));
  });
});

it('regenerates repeated section kinds in their own key after modulation', () => {
  const song = cloneSong(base);
  song.sections = [
    { id: 'v1', kind: 'verse', name: 'Verse 1', bars: 4, energy: 50 },
    { id: 'v2', kind: 'verse', name: 'Verse 2', bars: 4, energy: 50 },
    { id: 'end', kind: 'outro', name: 'End', bars: 1, energy: 30 },
  ];
  song.keyMap = [
    { bar: 0, key: { tonic: 0, mode: 'major' } },
    { bar: 4, key: { tonic: 2, mode: 'major' } },
  ];
  song.locks = {};
  song.chords = [];
  const next = regenerateUnlocked(song, { seed: 31, includeChords: true, trackIds: [] }).song;
  const first = next.chords.filter((c) => c.tick < 4 * 1920);
  const second = next.chords.filter((c) => c.tick >= 4 * 1920 && c.tick < 8 * 1920);
  expect(second.map((c) => (c.root + 10) % 12)).toEqual(first.map((c) => c.root));
});
