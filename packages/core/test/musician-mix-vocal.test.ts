import { describe, expect, it } from 'vitest';
import { interpretMixInstruction, interpretVocalInstruction } from '../src/musician';
import { LockKeys } from '../src/locks';
import { stableStringify } from '../src/ir/song-utils';
import { BAR, deepFreeze, makeSong, makeSongWithGuitars, opsOfType } from './musician-fixtures';

const mixerOf = (ops: { op: string }[], track: string) => opsOfType(ops, 'set_mixer').find((o) => o.track === track)?.changes;

describe('interpretMixInstruction (§41 AI mix assistant)', () => {
  const song = makeSong();

  it('"Make the vocal clearer": presence boost, high-pass, less reverb, and carves competing tracks', () => {
    const r = interpretMixInstruction(song, 'Make the vocal clearer');
    expect(r.understood).toBe(true);
    expect(r.intents).toEqual(['clarity']);
    expect(mixerOf(r.operations, 't-vocal')).toEqual({ 'eq.highMidHz': 3000, 'eq.highMidDb': 3, 'eq.highpassHz': 100, reverbSend: 0.11 });
    // Violin and piano share the vocal's register → 250–400 Hz cut; bass and drums are left alone.
    for (const t of ['t-violin', 't-piano']) expect(mixerOf(r.operations, t)).toEqual({ 'eq.lowMidHz': 320, 'eq.lowMidDb': -2, 'eq.lowMidQ': 1.2 });
    expect(mixerOf(r.operations, 't-bass')).toBeUndefined();
    expect(mixerOf(r.operations, 't-drums')).toBeUndefined();
    expect(r.explanation).toMatch(/presence/);
  });

  it('"Put the violin farther back": lower, wetter and duller', () => {
    const r = interpretMixInstruction(song, 'Put the violin farther back');
    expect(r.intents).toEqual(['push-back']);
    expect(r.operations).toHaveLength(1);
    expect(mixerOf(r.operations, 't-violin')).toEqual({ volumeDb: -9, reverbSend: 0.3, 'eq.highShelfDb': -2.5 });
  });

  it('"Make the drums hit harder": slow-attack compression, kick body and stick attack', () => {
    const r = interpretMixInstruction(song, 'Make the drums hit harder');
    expect(r.intents).toEqual(['punch']);
    expect(mixerOf(r.operations, 't-drums')).toEqual({
      'compressor.enabled': true,
      'compressor.thresholdDb': -20,
      'compressor.ratio': 4,
      'compressor.attackMs': 30,
      'compressor.releaseMs': 90,
      'compressor.makeupDb': 2,
      'eq.lowShelfHz': 80,
      'eq.lowShelfDb': 2.5,
      'eq.highMidHz': 4000,
      'eq.highMidDb': 1.5,
      volumeDb: -4.5,
    });
  });

  it('"Reduce muddiness": low-mid cuts everywhere, high-passes on everything but the bass', () => {
    const r = interpretMixInstruction(song, 'Reduce muddiness');
    expect(r.intents).toEqual(['muddiness']);
    expect(mixerOf(r.operations, 't-bass')).toEqual({ 'eq.lowMidHz': 300, 'eq.lowMidDb': -2 });
    expect(mixerOf(r.operations, 't-vocal')).toEqual({ 'eq.lowMidHz': 300, 'eq.lowMidDb': -3, 'eq.highpassHz': 100 });
    expect(mixerOf(r.operations, 't-violin')).toEqual({ 'eq.lowMidHz': 300, 'eq.lowMidDb': -3, 'eq.highpassHz': 180 });
    expect(mixerOf(r.operations, 't-piano')).toEqual({ 'eq.lowMidHz': 300, 'eq.lowMidDb': -3, 'eq.highpassHz': 70 });
    // "Reduce" is not read as a level change.
    expect(r.operations.some((o) => o.op === 'set_mixer' && 'volumeDb' in o.changes)).toBe(false);
  });

  it('"Bring the violin forward in the last chorus" automates only that section (1-based bars)', () => {
    const r = interpretMixInstruction(song, 'Bring the violin forward in the last chorus');
    expect(r.intents).toEqual(['forward']);
    const auto = opsOfType(r.operations, 'set_automation');
    const vol = auto.find((o) => o.param === 'volumeDb')!;
    expect(vol.track).toBe('t-violin');
    // Chorus 2 = bars 29–36 (the last section, so there is no ramp back afterwards).
    expect(vol.points).toEqual([
      { bar: 28, beat: 4, value: -6 },
      { bar: 29, beat: 1, value: -3.5 },
      { bar: 36, beat: 4, value: -3.5 },
    ]);
    expect(auto.find((o) => o.param === 'reverbSend')!.points.map((p) => p.value)).toEqual([0.15, 0.09, 0.09]);
    expect(auto.find((o) => o.param === 'eq.highMidDb')!.points.map((p) => p.value)).toEqual([0, 1.5, 1.5]);
    // The presence frequency is not automatable → a static change, and the explanation says so.
    expect(mixerOf(r.operations, 't-violin')).toEqual({ 'eq.highMidHz': 3000 });
    expect(r.explanation).toMatch(/not automatable/);
  });

  it('ramps back after a mid-song section and builds on existing automation', () => {
    const s = makeSong();
    s.automation = [{ id: 'lane-1', target: 't-violin', param: 'volumeDb', points: [{ tick: 0, value: -8 }, { tick: 36 * BAR, value: -8 }], enabled: true }];
    const r = interpretMixInstruction(s, 'bring the violin forward in the bridge');
    const vol = opsOfType(r.operations, 'set_automation').find((o) => o.param === 'volumeDb')!;
    expect(vol.points).toEqual([
      { bar: 20, beat: 4, value: -8 },
      { bar: 21, beat: 1, value: -5.5 },
      { bar: 28, beat: 4, value: -5.5 },
      { bar: 29, beat: 1, value: -8 },
    ]);
  });

  it('§73 example: "Bring the violin forward in the last chorus and make the vocal slightly drier"', () => {
    const r = interpretMixInstruction(song, 'Bring the violin forward in the last chorus and make the vocal slightly drier');
    expect(r.intents).toEqual(['forward', 'drier']);
    expect(opsOfType(r.operations, 'set_automation').every((o) => o.track === 't-violin')).toBe(true);
    expect(mixerOf(r.operations, 't-vocal')).toEqual({ reverbSend: 0.11 });
    expect(r.operations.some((o) => o.op === 'set_automation' && o.track === 't-vocal')).toBe(false);
  });

  it('handles levels, sends, mute/solo and pan', () => {
    expect(mixerOf(interpretMixInstruction(song, 'make the vocal slightly drier').operations, 't-vocal')).toEqual({ reverbSend: 0.11 });
    const wet = interpretMixInstruction(song, 'more reverb overall');
    expect(wet.intents).toEqual(['wetter']);
    expect(mixerOf(wet.operations, 't-bass')).toBeUndefined();
    expect(mixerOf(wet.operations, 't-vocal')).toEqual({ reverbSend: 0.25 });
    expect(wet.explanation).toMatch(/bass was kept dry/);
    expect(mixerOf(interpretMixInstruction(song, 'louder bass').operations, 't-bass')).toEqual({ volumeDb: -4 });
    expect(mixerOf(interpretMixInstruction(song, 'turn the vocal down 3 dB').operations, 't-vocal')).toEqual({ volumeDb: -9 });
    expect(mixerOf(interpretMixInstruction(song, 'vocal up 2 dB').operations, 't-vocal')).toEqual({ volumeDb: -4 });
    expect(mixerOf(interpretMixInstruction(song, 'mute the piano').operations, 't-piano')).toEqual({ mute: true });
    expect(mixerOf(interpretMixInstruction(song, 'solo the drums').operations, 't-drums')).toEqual({ solo: true });
    expect(mixerOf(interpretMixInstruction(song, 'pan the violin left').operations, 't-violin')).toEqual({ pan: -0.5 });
    const harsh = interpretMixInstruction(song, 'the vocal is too harsh');
    expect(harsh.intents).toEqual(['harsh']);
    expect(mixerOf(harsh.operations, 't-vocal')).toEqual({ 'eq.highMidHz': 3500, 'eq.highMidDb': -2.5 });
    expect(interpretMixInstruction(song, 'unmute the piano').operations).toHaveLength(0);
  });

  it('widens double-tracked guitars by panning them apart', () => {
    const g = makeSongWithGuitars();
    const r = interpretMixInstruction(g, 'make the drums punchier and the guitars wider');
    expect(r.intents).toEqual(['punch', 'wider']);
    expect(mixerOf(r.operations, 't-gtr-l')).toEqual({ width: 1.4, pan: -0.7 });
    expect(mixerOf(r.operations, 't-gtr-r')).toEqual({ width: 1.4, pan: 0.7 });
    expect(mixerOf(r.operations, 't-drums')!['compressor.enabled']).toBe(true);
    // No guitars in the base fixture: understood, but nothing to change.
    const none = interpretMixInstruction(song, 'wider guitars');
    expect(none.operations).toHaveLength(0);
    expect(none.intents).toEqual(['wider']);
    expect(none.explanation).toMatch(/no guitar track/);
  });

  it('applies to the selected track when none is named', () => {
    const r = interpretMixInstruction(song, 'make it louder', { selection: { trackIds: ['t-piano'] } });
    expect(r.operations).toEqual([expect.objectContaining({ op: 'set_mixer', track: 't-piano', changes: { volumeDb: -4 } })]);
  });

  it('respects mixer locks', () => {
    const s = makeSong();
    s.locks[LockKeys.mixer('t-vocal')] = true;
    const r = interpretMixInstruction(s, 'Make the vocal clearer');
    expect(r.operations.some((o) => 'track' in o && o.track === 't-vocal')).toBe(false);
    expect(mixerOf(r.operations, 't-violin')).toBeDefined();
    expect(r.explanation).toMatch(/Mixer settings of Lead Vocal are locked/);
  });

  it('says so when it cannot map a request, and is pure', () => {
    const r = interpretMixInstruction(song, 'make it sound amazing');
    expect(r.understood).toBe(false);
    expect(r.operations).toHaveLength(0);
    const frozen = deepFreeze(makeSong());
    const before = stableStringify(frozen);
    interpretMixInstruction(frozen, 'Bring the violin forward in the last chorus and reduce muddiness');
    expect(stableStringify(frozen)).toBe(before);
  });
});

describe('interpretVocalInstruction (§37 vocal regeneration commands)', () => {
  const song = makeSong();
  const vocal = song.tracks.find((t) => t.id === 't-vocal')!;

  it('"Make the final line more aggressive" → velocity + tension/energy/hard onsets on bars 35–36 only', () => {
    const r = interpretVocalInstruction(song, 't-vocal', 'Make the final line more aggressive', {}, { seed: 3 });
    expect(r.understood).toBe(true);
    expect(r.intents).toEqual(['aggressive']);
    const tr = opsOfType(r.operations, 'transform_notes');
    expect(tr).toEqual([expect.objectContaining({ track: 't-vocal', region: { start_bar: 35, end_bar: 36 }, transform: { velocity_add: 14 } })]);
    const ex = opsOfType(r.operations, 'set_expression')[0];
    expect(ex.region).toEqual({ start_bar: 35, end_bar: 36 });
    expect(ex.expression).toEqual({ tension: 0.75, energy: 0.8, breathiness: 0.05, onset: 'hard' });
    expect(r.regenerateRange).toEqual({ startTick: 34 * BAR, endTick: 68620 });
    expect(r.explanation).toMatch(/We will never let go/);
  });

  it('"Add vibrato here" on selected notes (deeper on sustained notes)', () => {
    const ids = vocal.notes.filter((n) => n.tick >= 12 * BAR && n.tick < 14 * BAR).map((n) => n.id);
    const r = interpretVocalInstruction(song, 't-vocal', 'Add vibrato here', { noteIds: ids }, { seed: 3 });
    expect(r.intents).toEqual(['vibrato']);
    const ex = opsOfType(r.operations, 'set_expression');
    expect(ex.flatMap((o) => o.note_ids ?? []).sort()).toEqual([...ids].sort());
    for (const o of ex) {
      expect(o.expression.vibrato).toBeGreaterThanOrEqual(0.4);
      expect(o.expression.vibratoRate).toBe(5.5);
    }
    expect(r.operations.every((o) => o.op !== 'replace_notes')).toBe(true);
  });

  it('"Sing this note more softly" touches only the selected note', () => {
    const note = vocal.notes[30];
    const r = interpretVocalInstruction(song, 't-vocal', 'Sing this note more softly', { noteIds: [note.id] }, { seed: 3 });
    expect(r.intents).toEqual(['softer']);
    expect(opsOfType(r.operations, 'transform_notes')).toEqual([expect.objectContaining({ note_ids: [note.id], transform: { velocity_add: -15 } })]);
    expect(opsOfType(r.operations, 'set_expression')[0].expression).toEqual({ breathiness: 0.4, tension: 0.2, energy: 0.25, onset: 'soft' });
    expect(r.regenerateRange).toEqual({ startTick: note.tick, endTick: note.tick + note.duration });
  });

  it('"Change the melody on the word \'fire\'" re-pitches just those notes onto chord tones', () => {
    const r = interpretVocalInstruction(song, 't-vocal', "Change the melody on the word 'fire'", {}, { seed: 3 });
    expect(r.intents).toEqual(['change-melody']);
    const fireIds = vocal.notes.filter((n) => /^fire/i.test(n.syllable ?? '')).map((n) => n.id);
    expect(fireIds).toHaveLength(2);
    const tr = opsOfType(r.operations, 'transform_notes');
    expect(tr.flatMap((o) => o.note_ids ?? []).sort()).toEqual([...fireIds].sort());
    for (const o of tr) {
      const shift = o.transform.transpose ?? 0;
      expect(shift).not.toBe(0);
      for (const id of o.note_ids!) {
        const n = vocal.notes.find((x) => x.id === id)!;
        // Both "Fire" notes sit on the D chord (V): the new pitch must be D, F# or A.
        expect([2, 6, 9]).toContain((n.pitch + shift) % 12);
      }
    }
    // Seeded: same seed, same melody; the instruction is deterministic.
    expect(stableStringify(interpretVocalInstruction(song, 't-vocal', "Change the melody on the word 'fire'", {}, { seed: 3 }))).toBe(stableStringify(r));
  });

  it('"Regenerate only the second chorus vocal" emits a section-scoped regenerate op', () => {
    const r = interpretVocalInstruction(song, 't-vocal', 'Regenerate only the second chorus vocal', {}, { seed: 3 });
    expect(r.intents).toEqual(['regenerate']);
    // A fresh pass: variation levels would keep the principal melody, i.e. this very vocal.
    expect(r.operations).toEqual([{ op: 'regenerate', track: 't-vocal', sections: ['sec-chorus2'], seed: 4, reason: expect.any(String) }]);
    expect(r.regenerateRange).toEqual({ startTick: 28 * BAR, endTick: 36 * BAR });
  });

  it('handles releases, breath, scoops, legato and vibrato removal within a section', () => {
    const rel = interpretVocalInstruction(song, 't-vocal', 'make it breathier with a falling release at phrase ends', { sectionIds: ['sec-chorus1'] });
    expect(rel.intents.sort()).toEqual(['breathier', 'release-falling']);
    const falling = opsOfType(rel.operations, 'set_expression').find((o) => o.expression.release === 'falling')!;
    expect(falling.note_ids).toHaveLength(4); // one per phrase end
    const scoop = interpretVocalInstruction(song, 't-vocal', 'scoop into notes', { sectionIds: ['sec-chorus2'] });
    expect(opsOfType(scoop.operations, 'set_expression')[0]).toEqual(expect.objectContaining({ region: { start_bar: 29, end_bar: 36 }, expression: { onset: 'scoop' } }));
    const legato = interpretVocalInstruction(song, 't-vocal', 'more legato in the verse');
    expect(opsOfType(legato.operations, 'transform_notes')[0].transform).toEqual({ articulation: 'legato' });
    const still = interpretVocalInstruction(song, 't-vocal', 'no vibrato', { sectionIds: ['sec-chorus1'] });
    expect(still.intents).toEqual(['less-vibrato']);
    expect(opsOfType(still.operations, 'set_expression')[0].expression).toEqual({ vibrato: 0 });
  });

  it('moves a line by an octave and warns about the voice range', () => {
    const r = interpretVocalInstruction(song, 't-vocal', 'sing the second line an octave higher', { sectionIds: ['sec-chorus1'] });
    expect(r.intents).toEqual(['transpose']);
    expect(opsOfType(r.operations, 'transform_notes')[0]).toEqual(expect.objectContaining({ region: { start_bar: 15, end_bar: 16 }, transform: { transpose: 12 } }));
    expect(r.explanation).toMatch(/outside the tenor range/);
  });

  it('redirects mix requests to the mix assistant', () => {
    const r = interpretVocalInstruction(song, 't-vocal', 'make the vocal slightly drier');
    expect(r.intents).toEqual(['mix:drier']);
    expect(r.operations).toEqual([expect.objectContaining({ op: 'set_mixer', track: 't-vocal', changes: { reverbSend: 0.11 } })]);
  });

  it('respects locks, rejects unknown requests and is pure', () => {
    const locked = makeSong();
    locked.locks[LockKeys.trackSection('t-vocal', 'sec-chorus2')] = true;
    const r = interpretVocalInstruction(locked, 't-vocal', 'Make the final line more aggressive');
    expect(r.operations).toHaveLength(0);
    expect(r.explanation).toMatch(/locked/i);
    const unknown = interpretVocalInstruction(song, 't-vocal', 'dance like nobody is watching');
    expect(unknown.understood).toBe(false);
    expect(interpretVocalInstruction(song, 'nope', 'louder').understood).toBe(false);
    const frozen = deepFreeze(makeSong());
    const before = stableStringify(frozen);
    interpretVocalInstruction(frozen, 't-vocal', "Change the melody on the word 'fire' and make it breathier");
    expect(stableStringify(frozen)).toBe(before);
  });
});
