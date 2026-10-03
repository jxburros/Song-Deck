import { describe, expect, it } from 'vitest';
import { interpretEditInstruction } from '../src/musician';
import { parseChordSymbol, chordPitchClasses } from '../src/theory/chords';
import { stableStringify, cloneSong } from '../src/ir/song-utils';
import { LockKeys } from '../src/locks';
import type { MusicOperation, Song } from '../src/ir/types';
import { BAR, BEAT, deepFreeze, makeSong, opTick, opsOfType } from './musician-fixtures';

const byId = (song: Song) => new Map(song.tracks.flatMap((t) => t.notes.map((n) => [n.id, n] as const)));
const opsOn = (ops: MusicOperation[], track: string) => ops.filter((o) => 'track' in o && o.track === track);

describe('interpretEditInstruction — core spec examples (§20)', () => {
  it('makes the bass busier with passing/approach tones on the bass track only', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'Make the bass busier', {}, { seed: 7 });
    expect(r.understood).toBe(true);
    expect(r.intents).toEqual(['busier']);
    const reps = opsOfType(r.operations, 'replace_notes');
    expect(reps.length).toBeGreaterThan(0);
    expect(r.operations.every((o) => 'track' in o && o.track === 't-bass')).toBe(true);
    const chorus = reps.find((o) => o.region.start_bar === 13)!;
    expect(chorus.region.end_bar).toBe(20);
    const before = song.tracks[1].notes.filter((n) => n.tick >= 12 * BAR && n.tick < 20 * BAR).length;
    expect(chorus.notes.length).toBeGreaterThan(before);
    // Still a bass line: every pitch inside the electric-bass range, and downbeats keep the chord root.
    for (const n of chorus.notes) expect(n.pitch as number).toBeGreaterThanOrEqual(28);
    const bar13 = chorus.notes.find((n) => n.bar === 13 && n.beat === 1)!;
    expect((bar13.pitch as number) % 12).toBe(7); // G
    expect(r.explanation).toMatch(/passing\/approach/);
  });

  it('simplifies the drums by deleting weak-beat and ghost notes but keeping downbeats and backbeats', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'simplify the drums', {});
    const del = opsOfType(r.operations, 'delete_notes');
    expect(del).toHaveLength(1);
    expect(del[0].track).toBe('t-drums');
    const ids = new Set(del[0].note_ids);
    const drums = song.tracks[0].notes;
    const ghosts = drums.filter((n) => n.articulation === 'ghost');
    expect(ghosts.length).toBeGreaterThan(0);
    for (const g of ghosts) expect(ids.has(g.id)).toBe(true);
    for (const n of drums) {
      const pos = (n.tick % BAR) / BEAT;
      if (n.pitch === 36 && (pos === 0 || pos === 2)) expect(ids.has(n.id)).toBe(false);
      if (n.pitch === 38 && n.velocity > 60 && (pos === 1 || pos === 3)) expect(ids.has(n.id)).toBe(false);
      if (n.pitch === 42 && pos % 1 !== 0) expect(ids.has(n.id)).toBe(true);
    }
  });

  it('makes a selected melody sadder via modal interchange (chords + melody + other parts fitted)', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'make this melody sadder', { trackIds: ['t-vocal'], sectionIds: ['sec-chorus1'] });
    expect(r.intents).toEqual(['darker']);
    const sc = opsOfType(r.operations, 'set_chords');
    expect(sc).toHaveLength(1);
    expect(sc[0].region).toEqual({ start_bar: 13, end_bar: 20 });
    expect(sc[0].chords.map((c) => c.symbol)).toEqual(['Gm', 'Dm', 'Eb', 'Cm']);
    // Every vocal B (major third of G) becomes Bb.
    const notes = byId(song);
    const vocalOps = opsOfType(r.operations, 'transform_notes').filter((o) => o.track === 't-vocal');
    const lowered = vocalOps.filter((o) => o.transform.transpose === -1).flatMap((o) => o.note_ids ?? []);
    expect(lowered.length).toBeGreaterThan(0);
    for (const id of lowered) expect([11, 4, 6]).toContain(notes.get(id)!.pitch % 12);
    expect(vocalOps.some((o) => (o.transform.velocity_add ?? 0) < 0)).toBe(true);
    // Other pitched parts were adjusted, drums untouched.
    expect(opsOn(r.operations, 't-piano').length).toBeGreaterThan(0);
    expect(opsOn(r.operations, 't-drums')).toHaveLength(0);
    expect(r.explanation).toMatch(/parallel G minor/);
  });

  it('changes the drums to half-time inside the selection (snare moves to beat 3)', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'Change this to half-time', { trackIds: ['t-drums'], sectionIds: ['sec-chorus1'] });
    expect(r.intents).toEqual(['half-time']);
    const rep = opsOfType(r.operations, 'replace_notes');
    expect(rep).toHaveLength(1);
    expect(rep[0].region).toEqual({ start_bar: 13, end_bar: 20 });
    const bar13 = rep[0].notes.filter((n) => n.bar === 13);
    const snares = bar13.filter((n) => n.pitch === 38).map((n) => n.beat);
    expect(snares).toEqual([3]);
    const hats = bar13.filter((n) => n.pitch === 42).map((n) => n.beat);
    expect(hats).toEqual([1, 2, 3, 4]);
    expect(opsOfType(r.operations, 'update_section')[0]).toMatchObject({ section: 'sec-chorus1', changes: { feel: 'half-time' } });
  });

  it('changes to double-time (backbeat on every off-beat)', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'double-time drums in the chorus', {});
    const rep = opsOfType(r.operations, 'replace_notes').find((o) => o.region.start_bar === 13)!;
    const snareBeats = rep.notes.filter((n) => n.bar === 13 && n.pitch === 38).map((n) => n.beat);
    expect(snareBeats).toEqual([1.5, 2.5, 3.5, 4.5]);
  });

  it('adds tension over four selected bars: suspensions in the chords, crescendo and a snare build', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'Add tension over these four bars', { startTick: 8 * BAR, endTick: 12 * BAR });
    expect(r.intents).toEqual(['tension']);
    const sc = opsOfType(r.operations, 'set_chords')[0];
    expect(sc.region.start_bar).toBeGreaterThanOrEqual(9);
    expect(sc.region.end_bar).toBeLessThanOrEqual(12);
    expect(sc.chords.map((c) => c.symbol)).toContain('D7sus4');
    expect(sc.chords.some((c) => /7|9/.test(c.symbol))).toBe(true);
    const drums = opsOfType(r.operations, 'replace_notes').find((o) => o.track === 't-drums')!;
    const build = drums.notes.filter((n) => n.bar === 12 && n.pitch === 38 && n.beat >= 3);
    expect(build.length).toBeGreaterThanOrEqual(5);
    const vels = build.map((n) => n.velocity!);
    expect(vels[vels.length - 1]).toBeGreaterThan(vels[0]);
    expect(opsOn(r.operations, 't-bass').length).toBeGreaterThan(0);
  });

  it('makes the violin answer the vocal instead of doubling it', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'Make the violin answer the vocal rather than double it', { sectionIds: ['sec-chorus1'] });
    expect(r.intents).toEqual(['answer']);
    expect(r.operations.every((o) => 'track' in o && o.track === 't-violin')).toBe(true);
    const rep = opsOfType(r.operations, 'replace_notes')[0];
    expect(rep.region).toEqual({ start_bar: 13, end_bar: 20 });
    const vocal = song.tracks[2].notes.filter((n) => n.tick >= 12 * BAR && n.tick < 20 * BAR);
    expect(rep.notes.length).toBeGreaterThan(0);
    for (const n of rep.notes) {
      const t = opTick(song, n);
      // No answering note starts while the vocal is sounding.
      expect(vocal.some((v) => t >= v.tick && t < v.tick + v.duration)).toBe(false);
    }
    expect(r.explanation).toMatch(/answering phrase/);
  });

  it('keeps the rhythm but changes the pitches (transpose-only, identity-preserving)', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'Keep the rhythm but change the pitches', { trackIds: ['t-vocal'], sectionIds: ['sec-verse1'] }, { seed: 3 });
    expect(r.intents).toEqual(['repitch']);
    const ts = opsOfType(r.operations, 'transform_notes');
    expect(ts.length).toBeGreaterThan(0);
    expect(r.operations.every((o) => o.op === 'transform_notes')).toBe(true);
    for (const o of ts) expect(Object.keys(o.transform)).toEqual(['transpose']);
    const changed = ts.flatMap((o) => o.note_ids ?? []);
    expect(changed.length).toBeGreaterThan(14);
    const notes = byId(song);
    for (const id of changed) expect(notes.get(id)!.tick).toBeLessThan(8 * BAR);
    const again = interpretEditInstruction(song, 'Keep the rhythm but change the pitches', { trackIds: ['t-vocal'], sectionIds: ['sec-verse1'] }, { seed: 3 });
    expect(stableStringify(again.operations)).toBe(stableStringify(r.operations));
  });

  it('turns chords harmonically ambiguous (sus/quartal/no-third) and fits the accompaniment, not the melody', () => {
    const song = makeSong();
    const r = interpretEditInstruction(song, 'Turn these chords into something more harmonically ambiguous', { sectionIds: ['sec-chorus1'] }, { seed: 5 });
    expect(r.intents).toEqual(['ambiguous']);
    const sc = opsOfType(r.operations, 'set_chords')[0];
    expect(sc.region).toEqual({ start_bar: 13, end_bar: 20 });
    for (const c of sc.chords) {
      const spec = parseChordSymbol(c.symbol)!;
      const ambiguous = ['sus2', 'sus4', '7sus4', '5', '11'].includes(spec.quality) || (spec.bass !== undefined && !chordPitchClasses({ root: spec.root, quality: spec.quality }).includes(spec.bass));
      expect(ambiguous).toBe(true);
    }
    expect(opsOn(r.operations, 't-vocal')).toHaveLength(0);
    expect(opsOn(r.operations, 't-piano').length).toBeGreaterThan(0);
  });
});

describe('interpretEditInstruction — other intents', () => {
  const song = makeSong();
  const transformOf = (instr: string, sel = {}) => opsOfType(interpretEditInstruction(song, instr, sel).operations, 'transform_notes');

  it('transposes by semitones, octaves and diatonic intervals', () => {
    expect(transformOf('transpose the violin up 2 semitones')[0]).toMatchObject({ track: 't-violin', transform: { transpose: 2 } });
    expect(transformOf('move the piano down an octave')[0].transform).toEqual({ transpose: -12 });
    expect(transformOf('shift the violin up a third')[0].transform).toEqual({ transpose_diatonic: 2 });
  });

  it('changes dynamics and articulation with uniform transforms', () => {
    expect(transformOf('make the bass louder')[0].transform).toEqual({ velocity_add: 12 });
    expect(transformOf('make the bass slightly softer')[0].transform).toEqual({ velocity_add: -6 });
    const st = transformOf('make the piano staccato')[0];
    expect(st.transform).toEqual({ duration_scale: 0.5, articulation: 'staccato' });
    const merged = transformOf('make the bass louder and more staccato');
    expect(merged).toHaveLength(1);
    expect(merged[0].transform).toEqual({ velocity_add: 12, duration_scale: 0.5, articulation: 'staccato' });
    expect(transformOf('shorter notes on the piano')[0].transform).toEqual({ duration_scale: 0.7 });
  });

  it('humanizes, tightens and quantizes timing', () => {
    expect(transformOf('humanize the drums')[0].transform.humanize).toBeCloseTo(0.3);
    expect(transformOf('quantize the bass to 16ths')[0].transform).toEqual({ quantize_beats: 0.25, quantize_strength: 1 });
    expect(transformOf('tighten the drums')[0].transform).toEqual({ quantize_beats: 0.25, quantize_strength: 0.6 });
  });

  it('adds swing (delays off-beats) and syncopation (anticipations)', () => {
    const sw = transformOf('more swing on the drums');
    expect(sw.some((o) => (o.transform.time_shift_beats ?? 0) > 0)).toBe(true);
    // Time-shifting ops always address notes by id (regions re-select at apply time).
    expect(sw.every((o) => o.note_ids && !o.region)).toBe(true);
    const sy = transformOf('make the bass more syncopated in the chorus');
    expect(sy.some((o) => (o.transform.time_shift_beats ?? 0) < 0)).toBe(true);
  });

  it('applies legato, longer notes and expressive dynamics', () => {
    const lg = transformOf('make the violin legato');
    expect(lg.some((o) => o.transform.articulation === 'legato')).toBe(true);
    const r = interpretEditInstruction(song, 'Make this less busy during the verse but more emotional during the chorus', { trackIds: ['t-violin'] });
    expect(r.intents).toEqual(['simplify', 'expressive']);
    expect(r.explanation).toMatch(/Verse 1/);
    expect(r.explanation).toMatch(/Chorus 1, Chorus 2/);
    const ids = opsOfType(r.operations, 'transform_notes').flatMap((o) => o.note_ids ?? []);
    const notes = byId(song);
    for (const id of ids) expect(notes.get(id)!.tick).toBeGreaterThanOrEqual(12 * BAR);
  });

  it('removes a drum element within a section', () => {
    const r = interpretEditInstruction(song, 'remove the hi-hats in the bridge', {});
    const del = opsOfType(r.operations, 'delete_notes')[0];
    const notes = byId(song);
    expect(del.note_ids!.length).toBe(64);
    for (const id of del.note_ids!) {
      const n = notes.get(id)!;
      expect(n.pitch).toBe(42);
      expect(n.tick).toBeGreaterThanOrEqual(20 * BAR);
      expect(n.tick).toBeLessThan(28 * BAR);
    }
  });

  it('doubles the melody an octave higher on a new backing-vocal track with the same syllables', () => {
    const r = interpretEditInstruction(song, 'Double the melody an octave higher', { sectionIds: ['sec-chorus1'] });
    expect(r.intents).toEqual(['double-octave']);
    const add = opsOfType(r.operations, 'add_track')[0];
    expect(add).toMatchObject({ instrument_id: 'backing-vocal', role: 'vocal' });
    const notes = opsOfType(r.operations, 'add_notes')[0];
    expect(notes.track).toBe(add.name);
    const vocal = song.tracks[2].notes.filter((n) => n.tick >= 12 * BAR && n.tick < 20 * BAR);
    expect(notes.notes).toHaveLength(vocal.length);
    expect(notes.notes[0].pitch).toBe(vocal[0].pitch + 12);
    expect(notes.notes[0].syllable).toBe('Hold');
  });

  it('harmonizes a monophonic instrument on its own new track', () => {
    const r = interpretEditInstruction(song, 'harmonize the violin in thirds', {});
    expect(opsOfType(r.operations, 'add_track')[0]).toMatchObject({ instrument_id: 'violin', name: 'Violin Harmony' });
    expect(opsOfType(r.operations, 'add_notes')[0].notes.length).toBe(song.tracks[3].notes.length);
  });

  it('inverts a melody around its first note and reverses with id-addressed time shifts', () => {
    const inv = interpretEditInstruction(song, 'invert the melody', { sectionIds: ['sec-verse1'] });
    const ts = opsOfType(inv.operations, 'transform_notes');
    const firstId = song.tracks[2].notes[0].id;
    expect(ts.flatMap((o) => o.note_ids ?? [])).not.toContain(firstId);
    const rev = interpretEditInstruction(song, 'reverse the violin in the verse', {});
    const rts = opsOfType(rev.operations, 'transform_notes');
    expect(rts.length).toBe(4);
    expect(rts.every((o) => o.note_ids && !o.region && o.transform.time_shift_beats !== undefined)).toBe(true);
  });

  it('adds drum fills', () => {
    const r = interpretEditInstruction(song, 'add a drum fill at the end of the chorus', {});
    const rep = opsOfType(r.operations, 'replace_notes');
    expect(rep.length).toBeGreaterThan(0);
    expect(rep.flatMap((o) => o.notes).some((n) => [50, 48, 47, 43].includes(n.pitch as number))).toBe(true);
  });

  it('reports unknown instructions with the list of capabilities', () => {
    const r = interpretEditInstruction(song, 'flibber the jabberwock', {});
    expect(r.understood).toBe(false);
    expect(r.operations).toHaveLength(0);
    expect(r.explanation).toMatch(/I can:/);
    expect(r.explanation).toMatch(/half-time/);
  });

  it('explains a missing instrument instead of guessing', () => {
    const r = interpretEditInstruction(song, 'make the trumpet busier', {});
    expect(r.understood).toBe(true);
    expect(r.operations).toHaveLength(0);
    expect(r.explanation).toMatch(/no trumpet track/);
  });
});

describe('interpretEditInstruction — locks, purity, determinism', () => {
  it('produces no ops for a locked track and says so', () => {
    const song = makeSong();
    song.locks[LockKeys.track('t-bass')] = true;
    const r = interpretEditInstruction(song, 'make the bass busier', {});
    expect(r.understood).toBe(true);
    expect(r.operations).toHaveLength(0);
    expect(r.explanation).toMatch(/[Ll]ocked/);
  });

  it('skips locked sections of a track', () => {
    const song = makeSong();
    song.locks[LockKeys.trackSection('t-drums', 'sec-chorus1')] = true;
    const r = interpretEditInstruction(song, 'simplify the drums', {});
    const notes = byId(song);
    const ids = opsOfType(r.operations, 'delete_notes').flatMap((o) => o.note_ids ?? []);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const t = notes.get(id)!.tick;
      expect(t >= 12 * BAR && t < 20 * BAR).toBe(false);
    }
    expect(r.explanation).toMatch(/Locked material was skipped/);
    expect(r.explanation).toMatch(/Chorus 1/);
  });

  it('never touches a note-level locked note (and never replaces its bar)', () => {
    const song = makeSong();
    const vocal = song.tracks[2];
    const lockedNote = vocal.notes[3];
    lockedNote.locked = true;
    const r = interpretEditInstruction(song, 'keep the rhythm but change the pitches', { trackIds: ['t-vocal'], sectionIds: ['sec-verse1'] });
    for (const o of r.operations) {
      if ('note_ids' in o && o.note_ids) expect(o.note_ids).not.toContain(lockedNote.id);
      if (o.op === 'replace_notes') expect(lockedNote.tick >= (o.region.start_bar - 1) * BAR && lockedNote.tick < o.region.end_bar * BAR).toBe(false);
    }
    const busier = interpretEditInstruction(song, 'make the vocal busier', { sectionIds: ['sec-verse1'] });
    for (const o of opsOfType(busier.operations, 'replace_notes')) expect(lockedNote.tick >= (o.region.start_bar - 1) * BAR && lockedNote.tick < o.region.end_bar * BAR).toBe(false);
  });

  it('leaves locked chords alone', () => {
    const song = makeSong();
    song.locks[LockKeys.sectionChords('sec-chorus1')] = true;
    const r = interpretEditInstruction(song, 'make this melody sadder', { trackIds: ['t-vocal'], sectionIds: ['sec-chorus1'] });
    expect(opsOfType(r.operations, 'set_chords')).toHaveLength(0);
    expect(r.explanation).toMatch(/Chords in Chorus 1 are locked/);
    // Chord tones of the unchanged chords are kept; only passing tones may be coloured.
    const notes = byId(song);
    for (const o of opsOfType(r.operations, 'transform_notes').filter((x) => x.track === 't-vocal' && x.transform.transpose)) {
      for (const id of o.note_ids ?? []) {
        const n = notes.get(id)!;
        const chord = song.chords.find((c) => c.tick <= n.tick && n.tick < c.tick + c.duration)!;
        expect(chordPitchClasses(chord).includes(n.pitch % 12)).toBe(false);
      }
    }
  });

  it('never mutates the song and is deterministic', () => {
    const song = deepFreeze(makeSong());
    const before = stableStringify(song);
    const instructions = [
      'make the bass busier',
      'simplify the drums',
      'make this melody sadder',
      'change this to half-time',
      'add tension over these four bars',
      'make the violin answer the vocal rather than double it',
      'keep the rhythm but change the pitches',
      'turn these chords into something more harmonically ambiguous',
      'make it brighter',
      'more swing',
      'double the melody an octave higher',
    ];
    for (const ins of instructions) {
      const a = interpretEditInstruction(song, ins, { sectionIds: ['sec-chorus1'] }, { seed: 11 });
      const b = interpretEditInstruction(cloneSong(song), ins, { sectionIds: ['sec-chorus1'] }, { seed: 11 });
      expect(stableStringify(a)).toBe(stableStringify(b));
    }
    expect(stableStringify(song)).toBe(before);
  });

  it('is fast on a full song', () => {
    const song = makeSong();
    interpretEditInstruction(song, 'make the bass busier', {});
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) interpretEditInstruction(song, 'make everything busier and add tension in the chorus', {});
    expect((performance.now() - t0) / 5).toBeLessThan(150);
  });
});
