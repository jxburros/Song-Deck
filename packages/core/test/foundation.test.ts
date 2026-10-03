import { describe, expect, it } from 'vitest';
import {
  barToTick,
  chordToRoman,
  createEmptySong,
  createRng,
  createTimeMap,
  deriveRng,
  diatonicChords,
  formatChordSymbol,
  guitarVoicing,
  IdFactory,
  keyName,
  midiToNoteName,
  musicalToTick,
  noteNameToMidi,
  parseChordSymbol,
  parseKey,
  romanToChord,
  sectionLayout,
  tickToBar,
  tickToMusical,
  transposeDiatonic,
  voiceChord,
  borrowedFrom,
  detectCadence,
  chordFunction,
  isNoteLocked,
  LockKeys,
  songHash,
  cloneSong,
  pitchClassFromName,
} from '../src';
import type { KeySignature, Song } from '../src';

const C: KeySignature = { tonic: 0, mode: 'major' };
const Em: KeySignature = { tonic: 4, mode: 'minor' };
const sym = (r: string, k: KeySignature) => {
  const c = romanToChord(r, k);
  return c ? formatChordSymbol(c, k) : null;
};

describe('pitch', () => {
  it('parses and formats note names', () => {
    expect(noteNameToMidi('A4')).toBe(69);
    expect(noteNameToMidi('C4')).toBe(60);
    expect(noteNameToMidi('C-1')).toBe(0);
    expect(noteNameToMidi('Eb3')).toBe(51);
    expect(noteNameToMidi('B#3')).toBe(60);
    expect(noteNameToMidi('Cb4')).toBe(59);
    expect(midiToNoteName(61)).toBe('C#4');
    expect(midiToNoteName(61, true)).toBe('Db4');
    expect(pitchClassFromName('F##')).toBe(7);
  });
});

describe('keys', () => {
  it('parses keys', () => {
    expect(parseKey('E minor')).toEqual({ tonic: 4, mode: 'minor' });
    expect(parseKey('Em')).toEqual({ tonic: 4, mode: 'minor' });
    expect(parseKey('Bb')).toEqual({ tonic: 10, mode: 'major' });
    expect(parseKey('D dorian')).toEqual({ tonic: 2, mode: 'dorian' });
    expect(parseKey('F# major')).toEqual({ tonic: 6, mode: 'major' });
    expect(parseKey('A harmonic minor')).toEqual({ tonic: 9, mode: 'harmonic-minor' });
    expect(keyName({ tonic: 10, mode: 'major' })).toBe('Bb major');
    expect(keyName({ tonic: 3, mode: 'minor' })).toBe('Eb minor');
    expect(keyName({ tonic: 6, mode: 'major' })).toBe('F# major');
  });
  it('transposes diatonically', () => {
    expect(transposeDiatonic(60, 2, C)).toBe(64);
    expect(transposeDiatonic(64, 1, C)).toBe(65);
    expect(transposeDiatonic(71, 1, C)).toBe(72);
    expect(transposeDiatonic(60, -1, C)).toBe(59);
  });
});

describe('chords', () => {
  it('parses symbols', () => {
    expect(parseChordSymbol('Em')).toEqual({ root: 4, quality: 'min' });
    expect(parseChordSymbol('G/B')).toEqual({ root: 7, quality: 'maj', bass: 11 });
    expect(parseChordSymbol('F#m7b5')).toEqual({ root: 6, quality: 'm7b5' });
    expect(parseChordSymbol('Bbsus4')).toEqual({ root: 10, quality: 'sus4' });
    expect(parseChordSymbol('A5')).toEqual({ root: 9, quality: '5' });
    expect(parseChordSymbol('Cmaj7/E')).toEqual({ root: 0, quality: 'maj7', bass: 4 });
    expect(parseChordSymbol('CM7')).toEqual({ root: 0, quality: 'maj7' });
    expect(parseChordSymbol('Cm7')).toEqual({ root: 0, quality: 'min7' });
    expect(parseChordSymbol('nonsense')).toBeNull();
  });
  it('formats with key-aware spelling', () => {
    expect(formatChordSymbol({ root: 10, quality: 'maj' }, C)).toBe('A#');
    expect(formatChordSymbol({ root: 10, quality: 'maj' }, { tonic: 5, mode: 'major' })).toBe('Bb');
    expect(formatChordSymbol({ root: 7, quality: 'maj', bass: 11 })).toBe('G/B');
  });
  it('builds diatonic chords', () => {
    expect(diatonicChords(C).map((c) => formatChordSymbol(c, C))).toEqual([
      'C',
      'Dm',
      'Em',
      'F',
      'G',
      'Am',
      'Bdim',
    ]);
    expect(diatonicChords(Em).map((c) => formatChordSymbol(c, Em))).toEqual([
      'Em',
      'F#dim',
      'G',
      'Am',
      'Bm',
      'C',
      'D',
    ]);
  });
});

describe('roman numerals', () => {
  it('realizes numerals relative to the key mode', () => {
    expect(['i', 'VI', 'III', 'VII'].map((r) => sym(r, Em))).toEqual(['Em', 'C', 'G', 'D']);
    expect(['I', 'V', 'vi', 'IV'].map((r) => sym(r, { tonic: 7, mode: 'major' }))).toEqual([
      'G',
      'D',
      'Em',
      'C',
    ]);
    expect(sym('V', Em)).toBe('B');
    expect(sym('V7', Em)).toBe('B7');
    expect(sym('bVII', C)).toBe('A#'); // spelled with sharps in C (no flats preference)
    expect(sym('iv', C)).toBe('Fm');
    expect(sym('V/V', C)).toBe('D');
    expect(sym('V7/vi', C)).toBe('E7');
    expect(sym('vii°/V', C)).toBe('F#dim');
    expect(sym('vii°7', C)).toBe('Bdim7');
    expect(sym('viiø7', C)).toBe('Bm7b5');
    expect(sym('IV7', C)).toBe('Fmaj7');
    expect(sym('Imaj7', C)).toBe('Cmaj7');
    expect(sym('ii7', C)).toBe('Dm7');
    expect(sym('vii', C)).toBe('Bdim');
  });
  it('analyzes chords to numerals', () => {
    expect(chordToRoman({ root: 7, quality: 'maj' }, C)).toBe('V');
    expect(chordToRoman({ root: 9, quality: 'min' }, C)).toBe('vi');
    expect(chordToRoman({ root: 10, quality: 'maj' }, C)).toBe('bVII');
    expect(chordToRoman({ root: 2, quality: '7' }, C)).toBe('V7/V');
    expect(chordToRoman({ root: 4, quality: 'maj' }, C)).toBe('V/vi');
    expect(chordToRoman({ root: 5, quality: 'min' }, C)).toBe('iv');
    expect(chordToRoman({ root: 11, quality: 'maj' }, Em)).toBe('V');
    expect(chordToRoman({ root: 9, quality: 'maj' }, Em)).toBe('IV');
    expect(chordToRoman({ root: 3, quality: 'dim' }, Em)).toBe('#vii°');
    expect(chordToRoman({ root: 7, quality: 'maj', bass: 11 }, C)).toBe('V6');
  });
  it('detects borrowed chords, functions and cadences', () => {
    expect(borrowedFrom({ root: 10, quality: 'maj' }, C)).toBe('minor');
    expect(borrowedFrom({ root: 7, quality: 'maj' }, C)).toBeNull();
    expect(chordFunction({ root: 7, quality: '7' }, C)).toBe('dominant');
    expect(chordFunction({ root: 5, quality: 'maj' }, C)).toBe('predominant');
    expect(detectCadence({ root: 7, quality: '7' }, { root: 0, quality: 'maj' }, C)).toBe('authentic');
    expect(detectCadence({ root: 7, quality: 'maj' }, { root: 9, quality: 'min' }, C)).toBe('deceptive');
    expect(detectCadence({ root: 5, quality: 'maj' }, { root: 0, quality: 'maj' }, C)).toBe('plagal');
  });
});

describe('voicing', () => {
  it('voices within range and leads voices smoothly', () => {
    const v1 = voiceChord({ root: 0, quality: 'maj' }, { low: 55, high: 76, voices: 4 });
    expect(v1.every((p) => p >= 55 && p <= 76)).toBe(true);
    const v2 = voiceChord({ root: 5, quality: 'maj' }, { low: 55, high: 76, voices: 4, previous: v1 });
    const move = v2.reduce((s, p, i) => s + Math.abs(p - [...v1].sort((a, b) => a - b)[i]), 0);
    expect(move).toBeLessThanOrEqual(8);
  });
  it('produces guitar shapes', () => {
    expect(guitarVoicing({ root: 4, quality: 'min' })).toEqual([40, 47, 52, 55, 59, 64]);
    expect(guitarVoicing({ root: 9, quality: 'maj' }, 'power')).toEqual([45, 52, 57]);
  });
});

describe('timing', () => {
  const song: Song = createEmptySong({ bpm: 120 });
  song.sections = [
    { id: 's1', name: 'Intro', kind: 'intro', bars: 4, energy: 30 },
    { id: 's2', name: 'Verse', kind: 'verse', bars: 8, energy: 45 },
  ];
  it('converts bars and ticks', () => {
    expect(barToTick(song, 4)).toBe(4 * 1920);
    expect(tickToBar(song, 1920 * 5 + 480).bar).toBe(5);
    expect(tickToBar(song, 1920 * 5 + 480).beat).toBe(1);
    expect(musicalToTick(song, 17, 1)).toBe(16 * 1920);
    expect(tickToMusical(song, 16 * 1920 + 240)).toEqual({ bar: 17, beat: 1.5 });
    const layout = sectionLayout(song);
    expect(layout[1].startBar).toBe(4);
    expect(layout[1].endTick).toBe(12 * 1920);
  });
  it('handles meter changes', () => {
    const s2 = cloneSong(song);
    s2.meterMap = [
      { bar: 0, numerator: 4, denominator: 4 },
      { bar: 4, numerator: 6, denominator: 8 },
    ];
    expect(barToTick(s2, 6)).toBe(4 * 1920 + 2 * 1440);
    expect(tickToBar(s2, 4 * 1920 + 1440 + 240).bar).toBe(5);
    expect(tickToBar(s2, 4 * 1920 + 1440 + 240).beat).toBe(1);
  });
  it('maps tempo changes to seconds', () => {
    const s3 = cloneSong(song);
    s3.tempoMap = [
      { tick: 0, bpm: 120 },
      { tick: 1920, bpm: 60 },
    ];
    const tm = createTimeMap(s3);
    expect(tm.tickToSeconds(1920)).toBeCloseTo(2);
    expect(tm.tickToSeconds(1920 + 480)).toBeCloseTo(3);
    expect(tm.secondsToTick(3)).toBeCloseTo(2400);
  });
});

describe('random & ids & locks', () => {
  it('is deterministic per seed and key', () => {
    const a = deriveRng(882914, 'drums', 'verse');
    const b = deriveRng(882914, 'drums', 'verse');
    const c = deriveRng(882914, 'bass', 'verse');
    const sa = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(sa);
    expect(c.next()).not.toBe(sa[0]);
    const r = createRng(1);
    for (let i = 0; i < 100; i++) {
      const v = r.int(3, 5);
      expect(v >= 3 && v <= 5).toBe(true);
    }
    const f1 = new IdFactory(7, 'x');
    const f2 = new IdFactory(7, 'x');
    expect(f1.next('n')).toBe(f2.next('n'));
  });
  it('resolves locks', () => {
    const song: Song = createEmptySong();
    song.sections = [
      { id: 's1', name: 'Verse', kind: 'verse', bars: 4, energy: 40 },
      { id: 's2', name: 'Chorus', kind: 'chorus', bars: 4, energy: 80 },
    ];
    const track = {
      id: 't1',
      name: 'Drums',
      kind: 'midi' as const,
      role: 'drums' as const,
      instrumentId: 'drum-kit',
      constraints: {},
      notes: [
        { id: 'a', pitch: 36, tick: 0, duration: 120, velocity: 100 },
        { id: 'b', pitch: 36, tick: 4 * 1920, duration: 120, velocity: 100 },
      ],
      clips: [],
      color: '#fff',
      stemGroup: 'drums' as const,
    };
    song.tracks = [track];
    song.locks = { [LockKeys.trackSection('t1', 's1')]: true };
    expect(isNoteLocked(song, track, track.notes[0])).toBe(true);
    expect(isNoteLocked(song, track, track.notes[1])).toBe(false);
    expect(songHash(song)).toBe(songHash(cloneSong(song)));
  });
});
