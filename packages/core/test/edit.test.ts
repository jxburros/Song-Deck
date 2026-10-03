import { describe, expect, it } from 'vitest';
import {
  acceptProposal,
  applyOperations,
  createProposal,
  diffSongs,
  modifyProposal,
  noteToOpNote,
  opNoteToNote,
  proposalFromSongs,
  rejectProposal,
  validateChange,
  validateSong,
} from '../src/edit';
import { cloneSong, songHash } from '../src/ir/song-utils';
import { IdFactory } from '../src/util/ids';
import { LockKeys } from '../src/locks';
import { sectionLayout, songLengthBars } from '../src/timing';
import type { MusicOperation, Song, ValidationReport } from '../src/ir/types';
import { makeSong, notesInBars, TICKS } from './edit-fixtures';

const { BAR, Q } = TICKS;

function codes(r: ValidationReport): string[] {
  return r.issues.map((i) => i.code);
}

function track(song: Song, id: string) {
  return song.tracks.find((t) => t.id === id)!;
}

function apply(song: Song, ops: unknown[], opts = {}) {
  return applyOperations(song, ops as MusicOperation[], { ids: new IdFactory(1, 'test'), ...opts });
}

describe('applyOperations — basics', () => {
  it('never mutates its input and is deterministic with an IdFactory', () => {
    const song = makeSong();
    const snapshot = songHash(song);
    const ops: MusicOperation[] = [
      { op: 'add_notes', track: 'bass', notes: [{ pitch: 'E2', bar: 1, beat: 1.5, duration_beats: 0.5 }] },
      { op: 'set_tempo', bpm: 140 },
    ];
    const a = apply(song, ops);
    const b = apply(song, ops);
    expect(songHash(song)).toBe(snapshot);
    expect(a.applied).toBe(2);
    expect(songHash(a.song)).toBe(songHash(b.song));
  });

  it('accepts the spec §46 "operation" spelling', () => {
    const r = apply(makeSong(), [{ operation: 'set_tempo', bpm: 150 }]);
    expect(r.applied).toBe(1);
    expect(r.song.tempoMap).toEqual([{ tick: 0, bpm: 150 }]);
  });

  it('never throws on malformed model output', () => {
    const song = makeSong();
    const garbage: unknown[] = [
      null,
      42,
      'replace everything',
      [],
      {},
      { op: 'teleport' },
      { op: 'replace_notes' },
      { op: 'replace_notes', track: 'bass', region: { start_bar: Number.NaN, end_bar: 3 }, notes: [] },
      { op: 'replace_notes', track: 'bass', region: { start_bar: 2, end_bar: 3 }, notes: 'lots' },
      { op: 'replace_notes', track: 'nobody', region: { start_bar: 2, end_bar: 3 }, notes: [] },
      { op: 'replace_notes', track: 'bass', region: { start_bar: 99, end_bar: 120 }, notes: [] },
      { op: 'add_notes', track: 'bass', notes: [{ pitch: 'H9', bar: 1, beat: 1, duration_beats: 1 }, { pitch: Number.NaN, bar: 1, beat: 1, duration_beats: 1 }, { pitch: 40, bar: -2, beat: 1, duration_beats: 1 }, { pitch: 40, bar: 1, beat: 1, duration_beats: 1, velocity: 'loud' }, null] },
      { op: 'delete_notes', track: 'bass', pitch_range: 'low' },
      { op: 'transform_notes', track: 'bass' },
      { op: 'set_chords', region: { start_bar: 1, end_bar: 1 } },
      { op: 'set_tempo', bpm: 'fast' },
      { op: 'set_tempo', bpm: 9000 },
      { op: 'set_key', tonic: 'H', mode: 'minor' },
      { op: 'set_key', tonic: 'E', mode: 'sad' },
      { op: 'set_meter', numerator: 4, denominator: 3 },
      { op: 'update_section', section: 'Nowhere', changes: { bars: 4 } },
      { op: 'update_section', section: 'Verse', changes: { bars: -1 } },
      { op: 'insert_section', section: 'Bridge' },
      { op: 'remove_section' },
      { op: 'move_section', section: 'Verse' },
      { op: 'set_lyrics', section: 'Chorus', lines: 5 },
      { op: 'set_mixer', track: 'bass', changes: 'louder' },
      { op: 'set_automation', track: 'bass', param: 'loudness', points: [] },
      { op: 'set_expression', track: 'vocal', expression: { vibrato: 'lots' } },
      { op: 'add_track', name: 'X' },
      { op: 'remove_track', track: 42 },
      { op: 'set_instrument', track: 'bass' },
      { op: 'set_macros', macros: [1, 2] },
      { op: 'set_lock', key: 'everything', locked: true },
      { op: 'set_lock', key: 'song.tempo' },
      { op: 'regenerate', sections: 'Chorus' },
    ];
    let r: ReturnType<typeof apply> | undefined;
    expect(() => {
      r = apply(song, garbage);
    }).not.toThrow();
    expect(r!.applied).toBe(1); // only the add_notes with one... see below
    expect(r!.skipped).toBe(garbage.length - 1);
    expect(r!.report.ok).toBe(false);
    // The single applied op is add_notes, whose invalid notes were all dropped (no valid notes → no change).
    expect(r!.song.tracks.map((t) => t.notes.length)).toEqual(song.tracks.map((t) => t.notes.length));
    expect(codes(r!.report)).toEqual(expect.arrayContaining(['op.malformed', 'op.unknown', 'track.not-found', 'region.invalid', 'region.outside', 'note.invalid', 'tempo.invalid', 'key.invalid', 'meter.invalid', 'section.not-found', 'section.invalid', 'lock.unknown-key']));
    for (const issue of r!.report.issues) {
      if (issue.severity === 'error') expect(issue.opIndex).toBeTypeOf('number');
    }
  });

  it('rejects whole operations atomically', () => {
    const song = makeSong();
    song.locks[LockKeys.trackSection('trk_bass', 'sec_chorus')] = true;
    // Touches verse (fine) and chorus (locked) → nothing applied.
    const r = apply(song, [{ op: 'replace_notes', track: 'bass', region: { start_bar: 11, end_bar: 14 }, notes: [{ pitch: 40, bar: 11, beat: 1, duration_beats: 4 }] }]);
    expect(r.applied).toBe(0);
    expect(codes(r.report)).toContain('lock.violated');
    expect(songHash(r.song)).toBe(songHash(song));
  });
});

describe('note operations', () => {
  it('replace_notes replaces the region, drops out-of-region notes and trims sustained notes', () => {
    const song = makeSong();
    // A long note in bar 4 sustaining into bar 5.
    track(song, 'trk_bass').notes.push({ id: 'long', pitch: 47, tick: 3 * BAR + 3 * Q, duration: 2 * Q, velocity: 80 });
    const r = apply(song, [
      {
        op: 'replace_notes',
        track: 'Bass',
        region: { start_bar: 5, end_bar: 6 },
        notes: [
          { pitch: 'E2', bar: 5, beat: 1, duration_beats: 2 },
          { pitch: 47, bar: 5, beat: 3, duration_beats: 1, velocity: 100 },
          { pitch: 'G2', bar: 6, beat: 4, duration_beats: 4 }, // trimmed at the region end
          { pitch: 'A2', bar: 9, beat: 1, duration_beats: 1 }, // outside → dropped
        ],
      },
    ]);
    expect(r.applied).toBe(1);
    const inRegion = notesInBars(r.song, 'trk_bass', 5, 6);
    expect(inRegion.map((n) => [n.pitch, n.tick, n.duration])).toEqual([
      [40, 4 * BAR, 2 * Q],
      [47, 4 * BAR + 2 * Q, Q],
      [43, 5 * BAR + 3 * Q, Q],
    ]);
    expect(notesInBars(r.song, 'trk_bass', 9, 9).every((n) => n.pitch === 40)).toBe(true);
    expect(track(r.song, 'trk_bass').notes.find((n) => n.id === 'long')!.duration).toBe(Q);
    expect(codes(r.report)).toContain('region.note-outside');
    // Everything outside bars 5–6 unchanged.
    const before = makeSong();
    expect(validateChange(before, r.song, { region: { startTick: 4 * BAR, endTick: 6 * BAR }, trackIds: ['trk_bass'] }).issues.filter((i) => i.code === 'region.violated' && i.trackId !== 'trk_bass')).toEqual([]);
  });

  it('add_notes adds sorted notes with unique ids; out-of-range notes are folded (autoFix)', () => {
    const r = apply(makeSong(), [{ op: 'add_notes', track: 'bass', notes: [{ pitch: 90, bar: 2, beat: 2.5, duration_beats: 0.5, velocity: 300 }, { pitch: 'B1', bar: 2, beat: 1, duration_beats: 1, articulation: 'staccato' }] }]);
    expect(r.applied).toBe(1);
    const bass = track(r.song, 'trk_bass');
    const ids = new Set(bass.notes.map((n) => n.id));
    expect(ids.size).toBe(bass.notes.length);
    const added = bass.notes.filter((n) => n.id.startsWith('n_'));
    expect(added).toHaveLength(2);
    const folded = added.find((n) => n.tick === BAR + Q + Q / 2)!;
    expect(folded.pitch).toBe(66); // 90 folded down two octaves into 28–67
    expect(folded.velocity).toBe(127);
    const fixed = r.report.issues.filter((i) => i.code === 'note.out-of-range');
    expect(fixed).toHaveLength(1);
    expect(fixed[0].fixed).toBe(true);
    expect(added.find((n) => n.pitch === 35)!.articulation).toBe('staccato');
    // sorted
    for (let i = 1; i < bass.notes.length; i++) expect(bass.notes[i].tick).toBeGreaterThanOrEqual(bass.notes[i - 1].tick);
  });

  it('without autoFix out-of-range notes are kept and reported', () => {
    const r = apply(makeSong(), [{ op: 'add_notes', track: 'bass', notes: [{ pitch: 90, bar: 2, beat: 1, duration_beats: 1 }] }], { autoFix: false });
    expect(track(r.song, 'trk_bass').notes.some((n) => n.pitch === 90)).toBe(true);
    const issue = r.report.issues.find((i) => i.code === 'note.out-of-range')!;
    expect(issue.fixed).toBeFalsy();
    expect(issue.severity).toBe('warning');
  });

  it('removes notes past the song end and de-duplicates same-pitch overlaps', () => {
    const r = apply(makeSong(), [
      {
        op: 'add_notes',
        track: 'bass',
        notes: [
          { pitch: 40, bar: 21, beat: 1, duration_beats: 1 },
          { pitch: 40, bar: 1, beat: 1, duration_beats: 1 },
          { pitch: 40, bar: 1, beat: 1.5, duration_beats: 1 },
        ],
      },
    ]);
    const bass = track(r.song, 'trk_bass');
    expect(bass.notes.some((n) => n.tick >= 20 * BAR)).toBe(false);
    expect(bass.notes.filter((n) => n.tick === 0 && n.pitch === 40)).toHaveLength(1);
    expect(codes(r.report)).toEqual(expect.arrayContaining(['note.past-end', 'note.overlap']));
    expect(r.report.issues.filter((i) => i.code === 'note.overlap').every((i) => i.fixed)).toBe(true);
  });

  it('delete_notes by region, pitch range and ids', () => {
    const song = makeSong();
    const r = apply(song, [
      { op: 'delete_notes', track: 'piano', region: { start_bar: 1, end_bar: 2 }, pitch_range: ['B3', 'B4'] },
      { op: 'delete_notes', track: 'drums', note_ids: ['k_0', 'k_1', 'missing'] },
    ]);
    expect(r.applied).toBe(2);
    expect(notesInBars(r.song, 'trk_piano', 1, 2).map((n) => n.pitch)).toEqual([52, 55, 48, 52, 55]);
    expect(track(r.song, 'trk_drums').notes.some((n) => n.id === 'k_0' || n.id === 'k_1')).toBe(false);
    expect(codes(r.report)).toContain('note.not-found');
  });

  it('transform_notes: transpose, diatonic, velocity, timing, quantize, humanize, articulation', () => {
    const song = makeSong();
    const r = apply(song, [
      { op: 'transform_notes', track: 'bass', region: { start_bar: 1, end_bar: 1 }, transform: { transpose_diatonic: 2 } },
      { op: 'transform_notes', track: 'bass', region: { start_bar: 2, end_bar: 2 }, transform: { transpose: 12, velocity_scale: 2, velocity_add: 10 } },
      { op: 'transform_notes', track: 'bass', region: { start_bar: 3, end_bar: 3 }, transform: { time_shift_beats: 0.5, duration_scale: 0.5 } },
      { op: 'transform_notes', track: 'drums', transform: { transpose: 5, articulation: 'accent' } },
    ]);
    expect(r.applied).toBe(4);
    const bar1 = notesInBars(r.song, 'trk_bass', 1, 1);
    expect(bar1.every((n) => n.pitch === 43)).toBe(true); // E2 + 2 scale steps in E minor = G2
    const bar2 = notesInBars(r.song, 'trk_bass', 2, 2);
    expect(bar2.every((n) => n.pitch === 48 && n.velocity === 127)).toBe(true);
    const bar3 = track(r.song, 'trk_bass').notes.filter((n) => n.id.startsWith('b_2_'));
    expect(bar3.map((n) => [n.tick, n.duration])).toEqual([0, 1, 2, 3].map((b) => [2 * BAR + b * Q + Q / 2, Q / 2]));
    const drums = track(r.song, 'trk_drums');
    expect(drums.notes.every((n) => n.articulation === 'accent')).toBe(true);
    expect(drums.notes.filter((n) => n.pitch === 36)).toHaveLength(20); // not transposed
    expect(codes(r.report)).toContain('transform.drums-skipped');
  });

  it('transform_notes quantize (with strength) and deterministic humanize', () => {
    const song = makeSong();
    const bass = track(song, 'trk_bass');
    bass.notes = [
      { id: 'q1', pitch: 40, tick: 130, duration: 470, velocity: 90 },
      { id: 'q2', pitch: 41, tick: 1000, duration: 200, velocity: 90 },
    ];
    const q = apply(song, [{ op: 'transform_notes', track: 'bass', transform: { quantize_beats: 0.25 } }]);
    expect(track(q.song, 'trk_bass').notes.map((n) => [n.tick, n.duration])).toEqual([
      [120, 480],
      [960, 240],
    ]);
    const half = apply(song, [{ op: 'transform_notes', track: 'bass', transform: { quantize_beats: 0.5, quantize_strength: 0.5 } }]);
    expect(track(half.song, 'trk_bass').notes[0].tick).toBe(Math.round(130 + (240 - 130) * 0.5));
    const h1 = apply(makeSong(), [{ op: 'transform_notes', track: 'drums', transform: { humanize: 0.8 } }]);
    const h2 = apply(makeSong(), [{ op: 'transform_notes', track: 'drums', transform: { humanize: 0.8 } }]);
    expect(songHash(h1.song)).toBe(songHash(h2.song));
    const moved = track(h1.song, 'trk_drums').notes.filter((n) => n.tick % 120 !== 0);
    expect(moved.length).toBeGreaterThan(10);
    expect(track(h1.song, 'trk_drums').notes.every((n) => n.velocity >= 1 && n.velocity <= 127)).toBe(true);
  });

  it('set_expression merges vocal expression', () => {
    const r = apply(makeSong(), [{ op: 'set_expression', track: 'vocal', region: { start_bar: 13, end_bar: 16 }, expression: { breathiness: 0.4, vibrato: 2, onset: 'soft', release: 'unknown' } }]);
    expect(r.applied).toBe(1);
    const v = notesInBars(r.song, 'trk_vocal', 13, 16);
    expect(v.every((n) => n.expression?.breathiness === 0.4 && n.expression.vibrato === 1 && n.expression.onset === 'soft')).toBe(true);
    expect(notesInBars(r.song, 'trk_vocal', 17, 20).every((n) => !n.expression)).toBe(true);
    expect(codes(r.report)).toContain('expression.invalid');
  });
});

describe('harmony, tempo, key and meter', () => {
  it('set_chords replaces chords in the region and keeps them contiguous', () => {
    const r = apply(makeSong(), [
      {
        op: 'set_chords',
        region: { start_bar: 5, end_bar: 6 },
        chords: [
          { bar: 5, beat: 1, symbol: 'Am7', duration_beats: 2 },
          { bar: 5, beat: 3, symbol: 'B7', duration_beats: 1 },
          { bar: 6, beat: 1, symbol: 'Cmaj7/E', duration_beats: 4 },
          { bar: 6, beat: 3, symbol: 'Xyz', duration_beats: 2 },
          { bar: 9, beat: 1, symbol: 'G', duration_beats: 4 },
        ],
      },
    ]);
    expect(r.applied).toBe(1);
    const inRegion = r.song.chords.filter((c) => c.tick >= 4 * BAR && c.tick < 6 * BAR);
    expect(inRegion.map((c) => [c.symbol, c.tick, c.duration, c.roman])).toEqual([
      ['Am7', 4 * BAR, 2 * Q, 'iv7'],
      ['B7', 4 * BAR + 2 * Q, 2 * Q, 'V7'],
      ['Cmaj7/E', 5 * BAR, BAR, 'VImaj7'],
    ]);
    expect(codes(r.report)).toEqual(expect.arrayContaining(['chord.unparseable', 'region.chord-outside']));
    expect(validateSong(r.song).issues.filter((i) => i.code.startsWith('chord.'))).toEqual([]);
  });

  it('set_chords fills a leading gap from the sounding chord', () => {
    const r = apply(makeSong(), [{ op: 'set_chords', region: { start_bar: 2, end_bar: 2 }, chords: [{ bar: 2, beat: 3, symbol: 'Am', duration_beats: 2 }] }]);
    const c1 = r.song.chords.find((c) => c.id === 'ch_1')!;
    expect(c1.tick).toBe(BAR);
    expect(c1.duration).toBe(2 * Q);
    expect(validateSong(r.song).issues.filter((i) => i.code.startsWith('chord.'))).toEqual([]);
  });

  it('set_tempo: whole song, at a bar, scaling, invalid', () => {
    expect(apply(makeSong(), [{ op: 'set_tempo', bpm: 90 }]).song.tempoMap).toEqual([{ tick: 0, bpm: 90 }]);
    const at = apply(makeSong(), [{ op: 'set_tempo', bpm: 140, at_bar: 13 }]).song;
    expect(at.tempoMap).toEqual([
      { tick: 0, bpm: 120 },
      { tick: 12 * BAR, bpm: 140 },
    ]);
    const scaled = apply(at, [{ op: 'set_tempo', bpm: 60 }]);
    expect(scaled.song.tempoMap).toEqual([
      { tick: 0, bpm: 60 },
      { tick: 12 * BAR, bpm: 70 },
    ]);
    expect(codes(scaled.report)).toContain('tempo.scaled');
    expect(apply(makeSong(), [{ op: 'set_tempo', bpm: 0 }]).applied).toBe(0);
  });

  it('set_key without transposition re-labels roman numerals', () => {
    const r = apply(makeSong(), [{ op: 'set_key', tonic: 'G', mode: 'major' }]);
    expect(r.song.keyMap).toEqual([{ bar: 0, key: { tonic: 7, mode: 'major' } }]);
    expect(track(r.song, 'trk_bass').notes).toEqual(track(makeSong(), 'trk_bass').notes);
    expect(r.song.chords.slice(0, 4).map((c) => c.roman)).toEqual(['vi', 'IV', 'I', 'V']);
  });

  it('set_key with transpose_notes moves pitched material, never drums', () => {
    const r = apply(makeSong(), [{ op: 'set_key', tonic: 'G', mode: 'minor', transpose_notes: true }]);
    expect(r.applied).toBe(1);
    expect(notesInBars(r.song, 'trk_bass', 1, 1).every((n) => n.pitch === 43)).toBe(true); // E2 → G2 (+3)
    expect(track(r.song, 'trk_drums').notes).toEqual(track(makeSong(), 'trk_drums').notes);
    expect(r.song.chords.slice(0, 4).map((c) => c.symbol)).toEqual(['Gm', 'Eb', 'Bb', 'F']);
    expect(r.song.chords.slice(0, 4).map((c) => c.roman)).toEqual(['i', 'VI', 'III', 'VII']);
  });

  it('set_key modal change maps scale degrees (E minor → E major)', () => {
    const r = apply(makeSong(), [{ op: 'set_key', tonic: 'E', mode: 'major', transpose_notes: true }]);
    // G2 (minor third of E) becomes G#2; C2 (minor sixth) becomes C#2.
    expect(notesInBars(r.song, 'trk_bass', 3, 3).every((n) => n.pitch === 44)).toBe(true);
    expect(notesInBars(r.song, 'trk_bass', 2, 2).every((n) => n.pitch === 37)).toBe(true);
    expect(r.song.chords.slice(0, 4).map((c) => c.symbol)).toEqual(['E', 'C#m', 'G#m', 'D#dim']);
    expect(r.song.chords[0].roman).toBe('I');
  });

  it('set_key at a bar only affects the modulated range', () => {
    const r = apply(makeSong(), [{ op: 'set_key', tonic: 'F#', mode: 'minor', at_bar: 13, transpose_notes: true }]);
    expect(r.song.keyMap).toEqual([
      { bar: 0, key: { tonic: 4, mode: 'minor' } },
      { bar: 12, key: { tonic: 6, mode: 'minor' } },
    ]);
    expect(notesInBars(r.song, 'trk_bass', 12, 12).every((n) => n.pitch === 38)).toBe(true);
    expect(notesInBars(r.song, 'trk_bass', 13, 13).every((n) => n.pitch === 42)).toBe(true);
  });

  it('set_meter re-bars material (4/4 → 3/4 drops beat 4)', () => {
    const r = apply(makeSong(), [{ op: 'set_meter', numerator: 3, denominator: 4 }]);
    expect(r.applied).toBe(1);
    expect(r.song.meterMap).toEqual([{ bar: 0, numerator: 3, denominator: 4 }]);
    expect(songLengthBars(r.song)).toBe(20);
    const bass = track(r.song, 'trk_bass');
    expect(bass.notes).toHaveLength(60);
    expect(bass.notes.filter((n) => n.id.startsWith('b_1_')).map((n) => n.tick)).toEqual([1440, 1440 + Q, 1440 + 2 * Q]);
    // whole-bar chords now last one 3/4 bar
    expect(r.song.chords[1]).toMatchObject({ tick: 1440, duration: 1440 });
    expect(codes(r.report)).toContain('meter.material-dropped');
  });
});

describe('structure operations shift material', () => {
  it('update_section grows a section and shifts later material', () => {
    const r = apply(makeSong(), [{ op: 'update_section', section: 'Verse', changes: { bars: 10, energy: 55, mood: 'tense' } }]);
    expect(r.applied).toBe(1);
    const verse = r.song.sections[1];
    expect(verse).toMatchObject({ bars: 10, energy: 55, mood: ['tense'] });
    // Chorus bass (was bar 13) now starts at bar 15.
    const orig = track(makeSong(), 'trk_bass').notes.find((n) => n.id === 'b_12_0')!;
    const moved = track(r.song, 'trk_bass').notes.find((n) => n.id === 'b_12_0')!;
    expect(moved.tick).toBe(orig.tick + 2 * BAR);
    expect(notesInBars(r.song, 'trk_bass', 13, 14)).toEqual([]);
    expect(r.song.lyrics).toHaveLength(2);
    expect(r.song.chords.find((c) => c.id === 'ch_12')!.tick).toBe(14 * BAR);
    expect(validateSong(r.song).issues.filter((i) => i.code === 'chord.gap')).toHaveLength(1);
  });

  it('update_section shrinks a section and removes its tail', () => {
    const r = apply(makeSong(), [{ op: 'update_section', section: 'Verse', changes: { bars: 6 } }]);
    expect(songLengthBars(r.song)).toBe(18);
    expect(track(r.song, 'trk_bass').notes.some((n) => n.id.startsWith('b_10_') || n.id.startsWith('b_11_'))).toBe(false);
    expect(track(r.song, 'trk_bass').notes.find((n) => n.id === 'b_12_0')!.tick).toBe(10 * BAR);
    expect(codes(r.report)).toContain('section.material-removed');
  });

  it('insert_section (empty) after the verse shifts the chorus', () => {
    const r = apply(makeSong(), [{ op: 'insert_section', after: 'Verse', section: { name: 'Pre-Chorus', kind: 'pre-chorus', bars: 4, energy: 60 } }]);
    expect(r.song.sections.map((s) => s.name)).toEqual(['Intro', 'Verse', 'Pre-Chorus', 'Chorus']);
    expect(notesInBars(r.song, 'trk_bass', 13, 16)).toEqual([]);
    expect(track(r.song, 'trk_vocal').notes[0].tick).toBe(16 * BAR);
    expect(r.song.tempoMap).toEqual([{ tick: 0, bpm: 120 }]);
  });

  it('insert_section with copy_from duplicates material, chords and lyrics', () => {
    const r = apply(makeSong(), [{ op: 'insert_section', section: { name: 'Final Chorus', kind: 'final-chorus', bars: 8 }, copy_from: 'Chorus' }]);
    expect(r.applied).toBe(1);
    const s = r.song.sections[3];
    expect(s).toMatchObject({ name: 'Final Chorus', kind: 'final-chorus', bars: 8, repeatOf: 'sec_chorus' });
    const copied = notesInBars(r.song, 'trk_vocal', 21, 28);
    const orig = notesInBars(r.song, 'trk_vocal', 13, 20);
    expect(copied.map((n) => [n.pitch, n.tick - 8 * BAR, n.syllable])).toEqual(orig.map((n) => [n.pitch, n.tick, n.syllable]));
    expect(new Set([...copied, ...orig].map((n) => n.id)).size).toBe(copied.length + orig.length);
    const newLines = r.song.lyrics.filter((l) => l.sectionId === s.id);
    expect(newLines.map((l) => l.text)).toEqual(['Hold on to the lightning', 'Hold on to the lightning']);
    expect(copied.every((n) => newLines.some((l) => l.id === n.lyricLineId))).toBe(true);
    expect(r.song.chords.filter((c) => c.tick >= 20 * BAR)).toHaveLength(8);
    expect(validateSong(r.song).ok).toBe(true);
  });

  it('insert_section loops copied material to fill a longer section', () => {
    const r = apply(makeSong(), [{ op: 'insert_section', after: 'Intro', section: { name: 'Long Intro', kind: 'intro', bars: 10 }, copy_from: 'Intro' }]);
    // 4-bar intro copied into 10 bars: 4 + 4 + 2 bars of material.
    const copied = notesInBars(r.song, 'trk_bass', 5, 14);
    expect(copied).toHaveLength(40);
    expect(copied.slice(0, 16).map((n) => n.pitch)).toEqual(notesInBars(r.song, 'trk_bass', 1, 4).map((n) => n.pitch));
    expect(notesInBars(r.song, 'trk_bass', 13, 14).map((n) => n.pitch)).toEqual(notesInBars(r.song, 'trk_bass', 1, 2).map((n) => n.pitch));
    expect(r.song.chords.filter((c) => c.tick >= 4 * BAR && c.tick < 14 * BAR).map((c) => c.symbol)).toEqual(['Em', 'C', 'G', 'D', 'Em', 'C', 'G', 'D', 'Em', 'C']);
    expect(validateSong(r.song).ok).toBe(true);
  });

  it('material past the last section follows the new last section', () => {
    const song = makeSong();
    song.tracks[0].notes.push({ id: 'tail', pitch: 40, tick: 21 * BAR, duration: Q, velocity: 80 });
    const r = apply(song, [{ op: 'remove_section', section: 'Verse' }], { autoFix: false });
    expect(r.applied).toBe(1);
    expect(track(r.song, 'trk_bass').notes.find((n) => n.id === 'tail')!.tick).toBe(13 * BAR);
    expect(r.song.meterMap).toEqual([{ bar: 0, numerator: 4, denominator: 4 }]);
  });

  it('remove_section deletes material and lyrics and shifts later material', () => {
    const r = apply(makeSong(), [{ op: 'remove_section', section: 'Intro' }]);
    expect(r.song.sections.map((s) => s.id)).toEqual(['sec_verse', 'sec_chorus']);
    expect(track(r.song, 'trk_bass').notes).toHaveLength(64);
    expect(track(r.song, 'trk_vocal').notes[0].tick).toBe(8 * BAR);
    expect(r.song.chords[0]).toMatchObject({ id: 'ch_4', tick: 0 });
    const r2 = apply(makeSong(), [{ op: 'remove_section', section: 'Chorus' }]);
    expect(r2.song.lyrics).toEqual([]);
    expect(track(r2.song, 'trk_vocal').notes).toEqual([]);
  });

  it('move_section reorders material', () => {
    const r = apply(makeSong(), [{ op: 'move_section', section: 'Chorus', to_index: 0 }]);
    expect(r.song.sections.map((s) => s.name)).toEqual(['Chorus', 'Intro', 'Verse']);
    expect(track(r.song, 'trk_vocal').notes[0].tick).toBe(0);
    expect(track(r.song, 'trk_bass').notes.find((n) => n.id === 'b_0_0')!.tick).toBe(8 * BAR);
    expect(r.song.chords.map((c) => c.id).slice(0, 2)).toEqual(['ch_12', 'ch_13']);
    expect(validateSong(r.song).ok).toBe(true);
  });

  it('structure edits keep the tempo of every bar', () => {
    const song = apply(makeSong(), [{ op: 'set_tempo', bpm: 150, at_bar: 13 }]).song;
    const r = apply(song, [{ op: 'move_section', section: 'Chorus', to_index: 0 }]);
    expect(r.song.tempoMap).toEqual([
      { tick: 0, bpm: 150 },
      { tick: 8 * BAR, bpm: 120 },
    ]);
  });

  it('cannot remove the last section', () => {
    let song = makeSong();
    song = apply(song, [
      { op: 'remove_section', section: 'Intro' },
      { op: 'remove_section', section: 'Verse' },
    ]).song;
    const r = apply(song, [{ op: 'remove_section', section: 'Chorus' }]);
    expect(r.applied).toBe(0);
    expect(codes(r.report)).toContain('section.last');
  });
});

describe('lyrics, mixer, automation, tracks, macros', () => {
  it('set_lyrics replaces lines and un-aligns stale syllables', () => {
    const r = apply(makeSong(), [{ op: 'set_lyrics', section: 'Chorus', lines: ['  We are the  storm ', '', 'We are the fire'] }], { author: 'provider-x' });
    const lines = r.song.lyrics.filter((l) => l.sectionId === 'sec_chorus');
    expect(lines.map((l) => [l.text, l.trackId, l.author])).toEqual([
      ['We are the storm', 'trk_vocal', 'provider-x'],
      ['We are the fire', 'trk_vocal', 'provider-x'],
    ]);
    expect(track(r.song, 'trk_vocal').notes.every((n) => !n.syllable && !n.lyricLineId)).toBe(true);
    expect(codes(r.report)).toContain('lyrics.unaligned');
  });

  it('set_mixer applies, clamps and validates fields; master bus', () => {
    const r = apply(makeSong(), [
      { op: 'set_mixer', track: 'bass', changes: { volumeDb: -3, pan: 2, 'eq.lowShelfDb': 3, 'compressor.enabled': true, loudness: 11 } },
      { op: 'set_mixer', track: 'master', changes: { volumeDb: -1, pan: 0.5 } },
    ]);
    expect(r.applied).toBe(2);
    const strip = r.song.mixer.channels.trk_bass;
    expect(strip.volumeDb).toBe(-3);
    expect(strip.pan).toBe(1);
    expect(strip.eq.lowShelfDb).toBe(3);
    expect(strip.compressor.enabled).toBe(true);
    expect(r.song.mixer.master.volumeDb).toBe(-1);
    expect(codes(r.report)).toEqual(expect.arrayContaining(['mixer.clamped', 'mixer.invalid-field']));
    const diff = diffSongs(makeSong(), r.song);
    expect(diff.mixerChanged).toEqual(expect.arrayContaining([{ target: 'trk_bass', field: 'volumeDb', before: -6, after: -3 }, { target: 'master', field: 'volumeDb', before: 0, after: -1 }]));
  });

  it('set_mixer creates a channel strip when missing', () => {
    const song = makeSong();
    delete song.mixer.channels.trk_piano;
    const r = apply(song, [{ op: 'set_mixer', track: 'Piano', changes: { reverbSend: 0.5 } }]);
    expect(r.song.mixer.channels.trk_piano.reverbSend).toBe(0.5);
    expect(r.song.mixer.channels.trk_piano.volumeDb).toBe(-6);
  });

  it('set_automation writes a lane per target+param and merges ranges', () => {
    const r = apply(makeSong(), [
      { op: 'set_automation', track: 'vocal', param: 'volumeDb', points: [{ bar: 13, beat: 1, value: -12 }, { bar: 14, beat: 1, value: 0 }, { bar: 20, beat: 1, value: 30 }] },
      { op: 'set_automation', track: 'vocal', param: 'volumeDb', points: [{ bar: 14, beat: 1, value: -3 }] },
      { op: 'set_automation', track: 'master', param: 'eq.lowpassHz', points: [{ bar: 1, beat: 1, value: 800 }, { bar: 4, beat: 4.5, value: 20000, curve: 'step' }] },
    ]);
    expect(r.applied).toBe(3);
    const lane = r.song.automation.find((l) => l.target === 'trk_vocal')!;
    expect(lane.points).toEqual([
      { tick: 12 * BAR, value: -12 },
      { tick: 13 * BAR, value: -3 },
      { tick: 19 * BAR, value: 12 },
    ]);
    expect(r.song.automation.find((l) => l.target === 'master')!.points[1]).toEqual({ tick: 3 * BAR + 3.5 * Q, value: 20000, curve: 'step' });
    expect(codes(r.report)).toContain('automation.clamped');
  });

  it('add_track / set_instrument / remove_track', () => {
    const r = apply(makeSong(), [
      { op: 'add_track', name: 'Violin', instrument_id: 'violin', role: 'strings', function: 'counter-melody' },
      { op: 'add_notes', track: 'Violin', notes: [{ pitch: 'G3', bar: 5, beat: 1, duration_beats: 4 }, { pitch: 'C3', bar: 6, beat: 1, duration_beats: 4 }] },
      { op: 'add_track', name: 'Perc', instrument_id: 'shaker-loop', role: 'percussion' },
      { op: 'set_instrument', track: 'piano', instrument_id: 'cello' },
      { op: 'remove_track', track: 'Drums' },
    ]);
    expect(r.applied).toBe(5);
    const violin = r.song.tracks.find((t) => t.name === 'Violin')!;
    expect(violin).toMatchObject({ role: 'strings', instrumentId: 'violin', constraints: { function: 'counter-melody' }, stemGroup: 'strings' });
    expect(violin.notes.map((n) => n.pitch)).toEqual([55, 60]); // C3 folded up into the violin range
    expect(r.song.mixer.channels[violin.id]).toBeDefined();
    const perc = r.song.tracks.find((t) => t.name === 'Perc')!;
    expect(perc.midiChannel).toBe(9);
    const cello = track(r.song, 'trk_piano');
    expect(cello.instrumentId).toBe('cello');
    expect(cello.notes.every((n) => n.pitch >= 36 && n.pitch <= 76)).toBe(true);
    expect(r.song.tracks.some((t) => t.id === 'trk_drums')).toBe(false);
    expect(r.song.mixer.channels.trk_drums).toBeUndefined();
    const channels = r.song.tracks.filter((t) => t.midiChannel !== 9).map((t) => t.midiChannel);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('set_macros on song and track', () => {
    const r = apply(makeSong(), [
      { op: 'set_macros', macros: { energy: 0.9, density: 80, nonsense: 1 } },
      { op: 'set_macros', track: 'bass', macros: { complexity: 0.2 } },
    ]);
    expect(r.song.macros.energy).toBe(0.9);
    expect(r.song.macros.density).toBe(0.8);
    expect(track(r.song, 'trk_bass').macros).toEqual({ complexity: 0.2 });
    expect(codes(r.report)).toContain('macro.invalid');
  });

  it('noteToOpNote / opNoteToNote round trip (1-based bars/beats)', () => {
    const song = makeSong();
    const n = { id: 'x', pitch: 52, tick: 4 * BAR + Q + Q / 2, duration: Q * 1.5, velocity: 77, articulation: 'legato' as const };
    const op = noteToOpNote(song, n);
    expect(op).toEqual({ pitch: 52, bar: 5, beat: 2.5, duration_beats: 1.5, velocity: 77, articulation: 'legato' });
    expect(opNoteToNote(song, op, 'x')).toEqual(n);
    expect(opNoteToNote(song, { pitch: 'E3', bar: 1, beat: 1, duration_beats: 1 }, 'y').pitch).toBe(52);
    expect(() => opNoteToNote(song, { pitch: 'Q', bar: 1, beat: 1, duration_beats: 1 }, 'z')).toThrow();
  });
});

describe('locks (spec §22)', () => {
  it('rejects ops touching locked tracks, sections, notes and song-level components', () => {
    const song = makeSong();
    song.locks = {
      [LockKeys.track('trk_vocal')]: true,
      [LockKeys.section('sec_intro')]: true,
      [LockKeys.tempo]: true,
      [LockKeys.chords]: true,
      [LockKeys.lyrics]: true,
      [LockKeys.mixer('trk_bass')]: true,
    };
    track(song, 'trk_piano').notes.find((n) => n.id === 'p_10_55')!.locked = true; // bar 11
    const ops: unknown[] = [
      { op: 'add_notes', track: 'vocal', notes: [{ pitch: 64, bar: 5, beat: 1, duration_beats: 1 }] },
      { op: 'replace_notes', track: 'bass', region: { start_bar: 3, end_bar: 5 }, notes: [] },
      { op: 'delete_notes', track: 'piano', region: { start_bar: 11, end_bar: 11 } },
      { op: 'set_tempo', bpm: 100 },
      { op: 'set_chords', region: { start_bar: 5, end_bar: 5 }, chords: [{ bar: 5, beat: 1, symbol: 'Am', duration_beats: 4 }] },
      { op: 'set_lyrics', section: 'Chorus', lines: ['nope'] },
      { op: 'set_mixer', track: 'bass', changes: { volumeDb: 0 } },
      { op: 'remove_track', track: 'vocal' },
      { op: 'set_instrument', track: 'vocal', instrument_id: 'violin' },
      { op: 'remove_section', section: 'Intro' },
      { op: 'set_key', tonic: 'A', mode: 'minor', transpose_notes: true },
    ];
    const r = apply(song, ops);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(ops.length);
    const lockIssues = r.report.issues.filter((i) => i.code === 'lock.violated');
    expect(new Set(lockIssues.map((i) => i.opIndex))).toEqual(new Set(ops.map((_, i) => i)));
    expect(songHash(r.song)).toBe(songHash(song));
  });

  it('allows unlocked edits around locked material; whole-track transforms skip locked notes', () => {
    const song = makeSong();
    song.locks = { [LockKeys.trackSection('trk_drums', 'sec_chorus')]: true, [LockKeys.structure]: false };
    const r = apply(song, [
      { op: 'transform_notes', track: 'drums', transform: { velocity_add: -20 } },
      { op: 'insert_section', after: 'Intro', section: { name: 'Break', kind: 'breakdown', bars: 2 } },
    ]);
    expect(r.applied).toBe(2);
    expect(codes(r.report)).toContain('lock.skipped');
    expect(validateChange(song, r.song).ok).toBe(true);
    const chorusDrums = notesInBars(r.song, 'trk_drums', 15, 22);
    expect(chorusDrums.every((n) => n.velocity === track(song, 'trk_drums').notes.find((x) => x.id === n.id)!.velocity)).toBe(true);
    expect(notesInBars(r.song, 'trk_drums', 1, 4).every((n) => n.velocity === track(song, 'trk_drums').notes.find((x) => x.id === n.id)!.velocity - 20)).toBe(true);
  });

  it('structure lock blocks section edits; key/meter locks block their ops', () => {
    const song = makeSong();
    song.locks = { [LockKeys.structure]: true, [LockKeys.key]: true, [LockKeys.meter]: true };
    const r = apply(song, [
      { op: 'insert_section', section: { name: 'X', kind: 'bridge', bars: 4 } },
      { op: 'update_section', section: 'Verse', changes: { bars: 4 } },
      { op: 'move_section', section: 'Verse', to_index: 0 },
      { op: 'set_key', tonic: 'A', mode: 'minor' },
      { op: 'set_meter', numerator: 3, denominator: 4 },
    ]);
    expect(r.applied).toBe(0);
    // metadata edits are still possible
    expect(apply(song, [{ op: 'update_section', section: 'Verse', changes: { energy: 70, purpose: 'Build tension' } }]).applied).toBe(1);
  });

  it('removing a section with locked track material is rejected by the generic lock check', () => {
    const song = makeSong();
    song.locks = { [LockKeys.trackSection('trk_bass', 'sec_verse')]: true };
    const r = apply(song, [{ op: 'remove_section', section: 'Verse' }]);
    expect(r.applied).toBe(0);
    expect(r.report.issues.find((i) => i.code === 'lock.violated')!.message).toMatch(/Bass.*Verse.*locked/);
  });

  it('set_lock: new locks apply to later ops; unlocks are deferred', () => {
    const song = makeSong();
    song.locks = { [LockKeys.track('trk_piano')]: true };
    const r = apply(song, [
      { op: 'set_lock', key: 'track:Bass', locked: true },
      { op: 'add_notes', track: 'bass', notes: [{ pitch: 40, bar: 1, beat: 1.5, duration_beats: 0.5 }] },
      { op: 'set_lock', key: 'track:Piano', locked: false },
      { op: 'delete_notes', track: 'piano' },
      { op: 'set_lock', key: 'tempo', locked: true },
    ]);
    expect(r.applied).toBe(3);
    expect(r.song.locks).toEqual({ 'track:trk_bass': true, 'song.tempo': true });
    expect(codes(r.report)).toEqual(expect.arrayContaining(['lock.deferred', 'lock.violated']));
    expect(track(r.song, 'trk_piano').notes).toHaveLength(60);
  });

  it('respectLocks: false allows editing locked material', () => {
    const song = makeSong();
    song.locks = { [LockKeys.tempo]: true };
    expect(apply(song, [{ op: 'set_tempo', bpm: 99 }], { respectLocks: false }).applied).toBe(1);
  });
});

describe('regenerate', () => {
  const regenOp = { op: 'regenerate', track: 'bass', region: { start_bar: 5, end_bar: 8 }, seed: 3 };

  it('is skipped with an info issue without a composition engine', () => {
    const r = apply(makeSong(), [regenOp]);
    expect(r.applied).toBe(0);
    expect(r.report.ok).toBe(true);
    expect(r.report.issues[0]).toMatchObject({ code: 'op.unsupported', severity: 'info' });
  });

  it('delegates to the engine and validates the result', () => {
    const good = (s: Song) => {
      const out = cloneSong(s);
      for (const n of out.tracks[0].notes) if (n.tick >= 4 * BAR && n.tick < 8 * BAR) n.pitch += 2;
      return out;
    };
    const seen: unknown[] = [];
    const r = apply(makeSong(), [regenOp], {
      regenerate: (s: Song, op: unknown) => {
        seen.push(op);
        return good(s);
      },
    });
    expect(r.applied).toBe(1);
    expect(seen).toEqual([{ op: 'regenerate', track: 'trk_bass', region: { start_bar: 5, end_bar: 8 }, seed: 3 }]);
    const bySection: unknown[] = [];
    apply(makeSong(), [{ op: 'regenerate', sections: ['Chorus', 'verse'], level: 'variation' }], { regenerate: (s: Song, op: unknown) => (bySection.push(op), s) });
    expect(bySection).toEqual([{ op: 'regenerate', sections: ['sec_chorus', 'sec_verse'], level: 'variation' }]);
    expect(notesInBars(r.song, 'trk_bass', 5, 5).every((n) => n.pitch === 42)).toBe(true);
    const sloppy = (s: Song) => {
      const out = cloneSong(s);
      for (const n of out.tracks[0].notes) n.pitch += 2; // changes outside the requested bars
      return out;
    };
    const r2 = apply(makeSong(), [regenOp], { regenerate: sloppy });
    expect(r2.applied).toBe(0);
    expect(codes(r2.report)).toContain('region.violated');
    const song = makeSong();
    song.locks = { [LockKeys.trackSection('trk_bass', 'sec_verse')]: true };
    const r3 = apply(song, [regenOp], { regenerate: good });
    expect(r3.applied).toBe(0);
    expect(codes(r3.report)).toContain('lock.violated');
    const broken = () => {
      throw new Error('model offline');
    };
    expect(apply(makeSong(), [regenOp], { regenerate: broken }).report.issues[0].code).toBe('op.failed');
  });
});

describe('validateSong', () => {
  it('a clean fixture validates', () => {
    const r = validateSong(makeSong());
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('detects invalid MIDI, ranges, overlaps, chords, lyrics and polyphony problems', () => {
    const song = makeSong();
    const bass = track(song, 'trk_bass');
    bass.notes.push({ id: 'bad1', pitch: 130, tick: 0, duration: 10, velocity: 50 });
    bass.notes.push({ id: 'bad2', pitch: 40, tick: 0, duration: 0, velocity: 0 });
    bass.notes.push({ id: 'high', pitch: 80, tick: 10, duration: 100, velocity: 50 });
    bass.notes.push({ id: 'dup', pitch: 40, tick: 100, duration: 480, velocity: 50 });
    song.chords[3] = { ...song.chords[3], symbol: 'H7' };
    song.chords[5] = { ...song.chords[5], duration: BAR * 2 };
    song.chords.splice(8, 1);
    song.lyrics[0] = { ...song.lyrics[0], text: 'Something completely different here' };
    const r = validateSong(song);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(
      expect.arrayContaining(['note.invalid', 'note.out-of-range', 'note.overlap', 'polyphony.mono', 'chord.unparseable', 'chord.overlap', 'chord.gap', 'lyrics.mismatch']),
    );
  });

  it('flags lyric/vocal mismatch counts and missing vocal notes', () => {
    const song = makeSong();
    song.lyrics.push({ id: 'ly_v', sectionId: 'sec_verse', text: 'A verse that nobody sings', trackId: 'trk_vocal' });
    expect(codes(validateSong(song))).toContain('lyrics.no-vocal');
  });
});

describe('diffSongs', () => {
  it('summarizes note changes with bar ranges', () => {
    const before = makeSong();
    const r = apply(before, [
      {
        op: 'replace_notes',
        track: 'bass',
        region: { start_bar: 17, end_bar: 20 },
        notes: [40, 36, 43, 38].flatMap((root, i) => [
          { pitch: root, bar: 17 + i, beat: 1, duration_beats: 1, velocity: 96 },
          { pitch: root + 7, bar: 17 + i, beat: 2.5, duration_beats: 0.5 },
          { pitch: root + 12, bar: 17 + i, beat: 3, duration_beats: 1 },
        ]),
      },
    ]);
    const d = diffSongs(before, r.song);
    const bass = d.tracks.find((t) => t.trackId === 'trk_bass')!;
    // 16 old notes replaced by 12 new ones; the 4 identical downbeats (new ids, same pitch+onset) are not add/remove pairs.
    expect(bass.added).toHaveLength(8);
    expect(bass.removed).toHaveLength(12);
    expect(bass.modified).toHaveLength(0);
    expect(d.summary).toContain('Bass: +8 notes, −12 notes (bars 17–20)');
  });

  it('reports modified notes, chords, structure, tempo, key, tracks', () => {
    const before = makeSong();
    const r = apply(before, [
      { op: 'transform_notes', track: 'bass', region: { start_bar: 1, end_bar: 1 }, transform: { velocity_add: -10 } },
      { op: 'set_chords', region: { start_bar: 9, end_bar: 12 }, chords: [{ bar: 9, beat: 1, symbol: 'Am', duration_beats: 16 }] },
      { op: 'set_tempo', bpm: 128 },
      { op: 'set_key', tonic: 'G', mode: 'major' },
      { op: 'add_track', name: 'Strings', instrument_id: 'strings', role: 'strings' },
      { op: 'remove_track', track: 'piano' },
      { op: 'update_section', section: 'Chorus', changes: { name: 'Big Chorus' } },
    ]);
    expect(r.applied).toBe(7);
    const d = diffSongs(before, r.song);
    expect(d.summary).toEqual(
      expect.arrayContaining([
        'Bass: 4 notes modified (bar 1)',
        'Chords: +1 chord, −4 chords (bars 9–12)',
        'Tempo: 120 → 128 BPM',
        'Key: E minor → G major',
        'Added track "Strings"',
        'Removed track "Piano" (60 notes)',
        'Structure: renamed "Chorus" → "Big Chorus"',
      ]),
    );
    expect(d.tempoChanged && d.keyChanged && d.sectionsChanged).toBe(true);
    expect(d.meterChanged || d.lyricsChanged || d.automationChanged).toBe(false);
    expect(d.tracksAdded).toHaveLength(1);
    expect(d.tracksRemoved).toEqual(['trk_piano']);
    expect(diffSongs(before, cloneSong(before)).summary).toEqual(['No changes']);
  });

  it('does not report identical notes with new ids', () => {
    const before = makeSong();
    const after = cloneSong(before);
    after.tracks[0].notes = after.tracks[0].notes.map((n, i) => ({ ...n, id: `new_${i}` }));
    const d = diffSongs(before, after);
    expect(d.tracks).toEqual([]);
  });
});

describe('proposals (spec §21)', () => {
  it('createProposal computes after/diff/validation and can be accepted or rejected', () => {
    const before = makeSong();
    const p = createProposal(before, [{ op: 'transform_notes', track: 'bass', region: { start_bar: 1, end_bar: 4 }, transform: { transpose: 12 } }], {
      title: 'Bass up an octave',
      source: 'internal',
      instruction: 'make the intro bass higher',
      id: 'prop_1',
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    expect(p).toMatchObject({ id: 'prop_1', status: 'pending', source: 'internal', title: 'Bass up an octave' });
    expect(p.diff.summary).toEqual(['Bass: 16 notes modified (bars 1–4)']);
    expect(p.validation.ok).toBe(true);
    expect(p.before).toEqual(before);
    const accepted = acceptProposal(p);
    expect(notesInBars(accepted, 'trk_bass', 1, 1)[0].pitch).toBe(52);
    expect(rejectProposal(p).status).toBe('rejected');
    expect(p.status).toBe('pending');
  });

  it('a proposal with rejected ops reports them but stays acceptable', () => {
    const song = makeSong();
    song.locks = { [LockKeys.tempo]: true };
    const p = createProposal(song, [{ op: 'set_tempo', bpm: 90 }, { op: 'set_macros', macros: { energy: 1 } }], { title: 't', source: 'llm' });
    expect(p.validation.ok).toBe(false);
    expect(p.after.tempoMap[0].bpm).toBe(120);
    expect(acceptProposal(p).macros.energy).toBe(1);
  });

  it('proposalFromSongs restores locked material and repairs invalid MIDI', () => {
    const before = makeSong();
    before.locks = { [LockKeys.track('trk_vocal')]: true, [LockKeys.tempo]: true };
    const after = cloneSong(before);
    after.tracks[2].notes[0].pitch = 99;
    after.tempoMap = [{ tick: 0, bpm: 200 }];
    after.tracks[0].notes[0].velocity = 0;
    after.tracks[0].notes[1].pitch = 300;
    const p = proposalFromSongs(before, after, { title: 'whole song', source: 'llm' });
    expect(p.after.tracks[2].notes[0].pitch).toBe(71);
    expect(p.after.tempoMap).toEqual([{ tick: 0, bpm: 120 }]);
    expect(p.after.tracks[0].notes[0].velocity).toBe(1);
    expect(p.after.tracks[0].notes.every((n) => n.pitch <= 127)).toBe(true);
    expect(p.validation.ok).toBe(true);
    expect(p.validation.issues.find((i) => i.code === 'lock.violated')!.fixed).toBe(true);
    expect(() => acceptProposal(p)).not.toThrow();
  });

  it('acceptProposal refuses a song that violates locks; modifyProposal re-validates', () => {
    const before = makeSong();
    before.locks = { [LockKeys.structure]: true };
    const after = cloneSong(before);
    after.sections[0].bars = 2;
    const p = proposalFromSongs(before, after, { title: 'shorter intro', source: 'llm' });
    expect(p.validation.ok).toBe(false);
    expect(() => acceptProposal(p)).toThrow(/locked/);
    const fixed = modifyProposal(p, cloneSong(before));
    expect(fixed.validation.ok).toBe(true);
    expect(fixed.id).toBe(p.id);
    expect(fixed.diff.summary).toEqual(['No changes']);
  });
});

describe('validateChange', () => {
  it('detects changes to locked material in section-relative terms', () => {
    const before = makeSong();
    before.locks = { [LockKeys.section('sec_chorus')]: true };
    const moved = apply(before, [{ op: 'insert_section', after: 'Intro', section: { name: 'Gap', kind: 'interlude', bars: 1 } }]).song;
    expect(validateChange(before, moved).ok).toBe(true);
    const edited = cloneSong(moved);
    edited.tracks[0].notes.find((n) => n.id === 'b_15_0')!.velocity = 1;
    const r = validateChange(before, edited);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'lock.violated', sectionId: 'sec_chorus', trackId: 'trk_bass' });
  });

  it('checks the requested range and tracks', () => {
    const before = makeSong();
    const after = cloneSong(before);
    after.tracks[3].notes[0].velocity = 1; // piano bar 1
    const span = sectionLayout(before)[2];
    const r = validateChange(before, after, { region: { startTick: span.startTick, endTick: span.endTick }, trackIds: ['trk_bass'] });
    expect(r.issues.map((i) => [i.code, i.trackId])).toEqual([['region.violated', 'trk_piano']]);
  });
});

describe('robustness (seeded fuzz)', () => {
  it('random valid/invalid operation batches never throw, never mutate input, never corrupt the song or break locks', async () => {
    const { createRng } = await import('../src/util/random');
    const rng = createRng(20261003);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng.next() * a.length)];
    const junk = () => pick<unknown>([undefined, null, Number.NaN, -5, 0, 3, 17, 1e9, 'x', 'E2', '', [], {}, true, 'bass', 'Chorus', 0.5, 300]);
    const n = (lo: number, hi: number) => (rng.next() < 0.15 ? junk() : lo + Math.floor(rng.next() * (hi - lo + 1)));
    const note = () => ({ pitch: rng.next() < 0.2 ? junk() : pick([40, 'E2', 'G4', 72, 'Bb3', 100, -3]), bar: n(1, 22), beat: rng.next() < 0.1 ? junk() : 1 + Math.floor(rng.next() * 8) / 2, duration_beats: rng.next() < 0.1 ? junk() : pick([0.25, 1, 4, 0, -1]), velocity: n(1, 127) });
    const region = () => (rng.next() < 0.1 ? junk() : { start_bar: n(1, 21), end_bar: n(1, 22) });
    const track = () => pick<unknown>(['bass', 'Drums', 'vocal', 'piano', 'nope', 42, undefined, 'master']);
    const section = () => pick<unknown>(['Intro', 'Verse', 'Chorus', 'x', undefined]);
    const makers: (() => unknown)[] = [
      () => ({ op: 'replace_notes', track: track(), region: region(), notes: Array.from({ length: Math.floor(rng.next() * 5) }, note) }),
      () => ({ op: 'add_notes', track: track(), notes: Array.from({ length: 3 }, note) }),
      () => ({ op: 'delete_notes', track: track(), region: rng.next() < 0.5 ? region() : undefined }),
      () => ({ op: 'transform_notes', track: track(), region: region(), transform: { transpose: n(-30, 30), time_shift_beats: pick([-100, 0.5, 1000]), quantize_beats: pick([0.25, 0, 'x']), humanize: pick([0.2, 5]) } }),
      () => ({ op: 'set_chords', region: region(), chords: [{ bar: n(1, 22), beat: 1, symbol: pick(['Am', 'H7', 'G/B']), duration_beats: 4 }] }),
      () => ({ op: 'set_tempo', bpm: n(10, 500), at_bar: rng.next() < 0.5 ? n(1, 25) : undefined }),
      () => ({ op: 'set_key', tonic: pick(['E', 'Bb', 'H']), mode: pick(['major', 'dorian', 'sad']), transpose_notes: rng.next() < 0.5, at_bar: rng.next() < 0.3 ? n(1, 22) : undefined }),
      () => ({ op: 'set_meter', numerator: n(1, 13), denominator: pick([4, 8, 3]), at_bar: rng.next() < 0.5 ? n(1, 22) : undefined }),
      () => ({ op: 'update_section', section: section(), changes: { bars: n(1, 16), energy: junk() } }),
      () => ({ op: 'insert_section', after: section(), section: { name: 'Bridge', kind: 'bridge', bars: n(1, 12) }, copy_from: rng.next() < 0.5 ? section() : undefined }),
      () => ({ op: 'remove_section', section: section() }),
      () => ({ op: 'move_section', section: section(), to_index: n(-2, 5) }),
      () => ({ op: 'set_lyrics', section: section(), lines: rng.next() < 0.2 ? junk() : ['one two', 'three'] }),
      () => ({ op: 'set_mixer', track: track(), changes: { volumeDb: n(-100, 20), pan: junk() } }),
      () => ({ op: 'set_automation', track: track(), param: pick(['volumeDb', 'nope']), points: [{ bar: n(1, 25), beat: 1, value: junk() }] }),
      () => ({ op: 'add_track', name: pick(['Violin', undefined]), instrument_id: pick(['violin', 'mystery', undefined]), role: pick(['strings', 'x']) }),
      () => ({ op: 'remove_track', track: track() }),
      () => ({ op: 'set_instrument', track: track(), instrument_id: pick(['cello', 'drum-kit', undefined]) }),
      () => ({ op: 'set_lock', key: pick(['song.tempo', 'track:Bass', 'section:Chorus', 'garbage']), locked: pick([true, false, undefined]) }),
      () => ({ op: pick(['regenerate', 'bogus']), track: track() }),
    ];
    for (let iter = 0; iter < 80; iter++) {
      const song = makeSong();
      if (iter % 2 === 0) song.locks = { [LockKeys.trackSection('trk_bass', 'sec_verse')]: true, [LockKeys.section('sec_intro')]: true, [LockKeys.tempo]: true };
      const hash = songHash(song);
      const ops = Array.from({ length: 1 + Math.floor(rng.next() * 5) }, () => pick(makers)());
      const r = apply(song, ops, { autoFix: rng.next() < 0.8, regenerate: rng.next() < 0.5 ? (s: Song) => s : undefined });
      expect(songHash(song)).toBe(hash);
      expect(r.applied + r.skipped).toBe(ops.length);
      const corrupt = validateSong(r.song).issues.filter((i) => i.severity === 'error' && !['chord.unparseable'].includes(i.code));
      expect(corrupt).toEqual([]);
      expect(validateChange(song, r.song).issues.filter((i) => i.code === 'lock.violated')).toEqual([]);
    }
  });
});
