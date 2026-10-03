import { createEmptySong } from '../src/ir/defaults';
import { parseChordSymbol } from '../src/theory/chords';
import { musicalToTick } from '../src/timing';
import type { ChordEvent, LyricLine, Note, Section, Song, Track } from '../src/ir/types';

/**
 * Small hand-built fixture song for the musician tests (no dependency on the composer).
 *
 * G major, 120 BPM, 4/4. Sections (bars, 1-based):
 *   Verse 1 (1–8)   Em C G D (2 bars each)        energy 45
 *   Pre-Chorus (9–12) C D Em D (1 bar each)        energy 55
 *   Chorus 1 (13–20) G D Em C (2 bars each)        energy 90
 *   Bridge (21–28)  C Cm G A7 D                    energy 70→95
 *   Chorus 2 (29–36) G D Em C                       energy 95
 * Tracks: Drums, Bass, Lead Vocal (with syllables in the choruses), Violin (doubles the vocal
 * an octave up in Chorus 1), Piano (triads).
 */

export const BAR = 1920;
export const BEAT = 480;

let noteCounter = 0;
const nid = (prefix: string) => `${prefix}${++noteCounter}`;

function chord(id: string, symbol: string, bar0: number, bars: number): ChordEvent {
  const spec = parseChordSymbol(symbol)!;
  return { id, ...spec, symbol, tick: bar0 * BAR, duration: bars * BAR };
}

export const SECTIONS: Section[] = [
  { id: 'sec-verse1', name: 'Verse 1', kind: 'verse', bars: 8, energy: 45 },
  { id: 'sec-pre', name: 'Pre-Chorus', kind: 'pre-chorus', bars: 4, energy: 55 },
  { id: 'sec-chorus1', name: 'Chorus 1', kind: 'chorus', bars: 8, energy: 90 },
  { id: 'sec-bridge', name: 'Bridge', kind: 'bridge', bars: 8, energy: 70, energyEnd: 95 },
  { id: 'sec-chorus2', name: 'Chorus 2', kind: 'chorus', bars: 8, energy: 95, repeatOf: 'sec-chorus1' },
];

export function fixtureChords(): ChordEvent[] {
  return [
    chord('c1', 'Em', 0, 2),
    chord('c2', 'C', 2, 2),
    chord('c3', 'G', 4, 2),
    chord('c4', 'D', 6, 2),
    chord('c5', 'C', 8, 1),
    chord('c6', 'D', 9, 1),
    chord('c7', 'Em', 10, 1),
    chord('c8', 'D', 11, 1),
    chord('c9', 'G', 12, 2),
    chord('c10', 'D', 14, 2),
    chord('c11', 'Em', 16, 2),
    chord('c12', 'C', 18, 2),
    chord('c13', 'C', 20, 2),
    chord('c14', 'Cm', 22, 2),
    chord('c15', 'G', 24, 1),
    chord('c16', 'A7', 25, 1),
    chord('c17', 'D', 26, 2),
    chord('c18', 'G', 28, 2),
    chord('c19', 'D', 30, 2),
    chord('c20', 'Em', 32, 2),
    chord('c21', 'C', 34, 2),
  ];
}

const ROOT_BASS: Record<string, number> = { Em: 40, C: 36, G: 43, D: 38, Cm: 36, A7: 45 };
const TRIADS: Record<string, number[]> = {
  Em: [55, 59, 64],
  C: [55, 60, 64],
  G: [55, 59, 62],
  D: [57, 62, 66],
  Cm: [55, 60, 63],
  A7: [55, 61, 64],
};

function drums(): Note[] {
  const out: Note[] = [];
  for (let bar = 0; bar < 36; bar++) {
    const t0 = bar * BAR;
    out.push({ id: nid('k'), pitch: 36, tick: t0, duration: 120, velocity: 100 });
    out.push({ id: nid('k'), pitch: 36, tick: t0 + 2 * BEAT, duration: 120, velocity: 96 });
    out.push({ id: nid('s'), pitch: 38, tick: t0 + BEAT, duration: 120, velocity: 104 });
    out.push({ id: nid('s'), pitch: 38, tick: t0 + 3 * BEAT, duration: 120, velocity: 106 });
    for (let e = 0; e < 8; e++) out.push({ id: nid('h'), pitch: 42, tick: t0 + e * 240, duration: 60, velocity: e % 2 ? 62 : 84 });
    if (bar < 8 && bar % 2 === 1) out.push({ id: nid('g'), pitch: 38, tick: t0 + BEAT + 360, duration: 60, velocity: 34, articulation: 'ghost' });
    if ([0, 8, 12, 20, 28].includes(bar)) out.push({ id: nid('c'), pitch: 49, tick: t0, duration: 480, velocity: 110 });
  }
  return out.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}

function bass(chords: ChordEvent[]): Note[] {
  const out: Note[] = [];
  for (let bar = 0; bar < 36; bar++) {
    const c = chords.find((x) => x.tick <= bar * BAR && bar * BAR < x.tick + x.duration)!;
    const root = ROOT_BASS[c.symbol];
    if (bar < 12) {
      out.push({ id: nid('b'), pitch: root, tick: bar * BAR, duration: 2 * BEAT - 20, velocity: 92 });
      out.push({ id: nid('b'), pitch: root, tick: bar * BAR + 2 * BEAT, duration: 2 * BEAT - 20, velocity: 88 });
    } else out.push({ id: nid('b'), pitch: root, tick: bar * BAR, duration: BAR - 20, velocity: 95 });
  }
  return out;
}

function piano(chords: ChordEvent[]): Note[] {
  const out: Note[] = [];
  for (let bar = 0; bar < 36; bar++) {
    const c = chords.find((x) => x.tick <= bar * BAR && bar * BAR < x.tick + x.duration)!;
    for (const p of TRIADS[c.symbol]) out.push({ id: nid('p'), pitch: p, tick: bar * BAR, duration: BAR - 30, velocity: 70 });
  }
  return out;
}

export const VERSE_LINES = ['Walking down the empty road', 'Counting every passing car', 'Waiting for the morning light', 'Hoping you will find me there'];
export const CHORUS_LINES = ['Hold on to the night sky', 'Fire in my heart tonight', 'Never let the light go', 'We will never let go'];

const CHORUS_SYLLABLES = [
  ['Hold', 'on', 'to', 'the', 'night', 'sky'],
  ['Fire', 'in', 'my', 'heart', 'to-', 'night'],
  ['Nev-', 'er', 'let', 'the', 'light', 'go'],
  ['We', 'will', 'nev-', 'er', 'let', 'go'],
];
const CHORUS_PITCHES = [
  [71, 71, 72, 74, 71, 67],
  [74, 72, 71, 69, 71, 67],
  [71, 71, 72, 74, 76, 74],
  [72, 71, 69, 67, 69, 67],
];
const VERSE_PITCHES = [
  [64, 67, 67, 66, 64, 62, 64],
  [64, 64, 67, 69, 67, 64, 60],
  [62, 62, 64, 67, 66, 62, 59],
  [62, 64, 66, 67, 69, 66, 62],
];

function vocal(): Note[] {
  const out: Note[] = [];
  // Verse 1: 4 phrases of 7 notes (no syllables yet), each 2 bars: beats 0,1,2,3,4,4.5,5 then rest.
  const verseBeats = [0, 1, 2, 3, 4, 4.5, 5];
  VERSE_PITCHES.forEach((ph, i) => {
    ph.forEach((p, k) => {
      const tick = i * 2 * BAR + verseBeats[k] * BEAT;
      const next = k + 1 < verseBeats.length ? verseBeats[k + 1] : verseBeats[k] + 1;
      out.push({ id: nid('v'), pitch: p, tick, duration: Math.round((next - verseBeats[k]) * BEAT) - 20, velocity: 84, lyricLineId: `ly-v${i + 1}` });
    });
  });
  // Choruses: 4 phrases of 6 quarter notes with syllables, rest on beats 7-8 of every 2-bar phrase.
  for (const [base, secPrefix] of [
    [12, 'c1'],
    [28, 'c2'],
  ] as const) {
    CHORUS_PITCHES.forEach((ph, i) => {
      ph.forEach((p, k) => {
        const tick = (base + i * 2) * BAR + k * BEAT;
        out.push({
          id: nid('v'),
          pitch: p,
          tick,
          duration: k === 5 ? 2 * BEAT - 20 : BEAT - 20,
          velocity: 90,
          syllable: CHORUS_SYLLABLES[i][k],
          lyricLineId: `ly-${secPrefix}-${i + 1}`,
        });
      });
    });
  }
  return out;
}

function violin(vocalNotes: Note[]): Note[] {
  const out: Note[] = [];
  // Verse: long notes (2 bars each).
  [71, 67, 74, 69].forEach((p, i) => out.push({ id: nid('vn'), pitch: p, tick: i * 2 * BAR, duration: 2 * BAR - 40, velocity: 70 }));
  // Chorus 1: doubles the vocal an octave up.
  for (const v of vocalNotes.filter((n) => n.tick >= 12 * BAR && n.tick < 20 * BAR)) {
    out.push({ id: nid('vn'), pitch: v.pitch + 12, tick: v.tick, duration: v.duration, velocity: 78 });
  }
  return out;
}

function track(id: string, name: string, role: Track['role'], instrumentId: string, notes: Note[], extra: Partial<Track> = {}): Track {
  return {
    id,
    name,
    kind: 'midi',
    role,
    instrumentId,
    constraints: {},
    notes: notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch),
    clips: [],
    color: '#888888',
    stemGroup: role === 'drums' ? 'drums' : role === 'bass' ? 'bass' : role === 'vocal' ? 'vocals' : role === 'strings' ? 'strings' : 'keys',
    ...extra,
  };
}

export function makeSong(): Song {
  noteCounter = 0;
  const song = createEmptySong({ title: 'Fixture Song', bpm: 120, key: { tonic: 7, mode: 'major' }, id: 'song-fixture', seed: 4242 });
  song.sections = SECTIONS.map((s) => ({ ...s }));
  song.chords = fixtureChords();
  const voc = vocal();
  song.tracks = [
    track('t-drums', 'Drums', 'drums', 'drum-kit', drums(), { midiChannel: 9 }),
    track('t-bass', 'Bass', 'bass', 'electric-bass', bass(song.chords)),
    track('t-vocal', 'Lead Vocal', 'vocal', 'lead-vocal', voc, { vocal: { voiceType: 'tenor', mode: 'melody-only' }, constraints: { function: 'melody' } }),
    track('t-violin', 'Violin', 'strings', 'violin', violin(voc), { constraints: { function: 'counter-melody' } }),
    track('t-piano', 'Piano', 'keys', 'piano', piano(song.chords), { constraints: { function: 'accompaniment' } }),
  ];
  const lyrics: LyricLine[] = [
    ...VERSE_LINES.map((text, i) => ({ id: `ly-v${i + 1}`, sectionId: 'sec-verse1', text, trackId: 't-vocal' })),
    ...CHORUS_LINES.map((text, i) => ({ id: `ly-c1-${i + 1}`, sectionId: 'sec-chorus1', text, trackId: 't-vocal' })),
    ...CHORUS_LINES.map((text, i) => ({ id: `ly-c2-${i + 1}`, sectionId: 'sec-chorus2', text, trackId: 't-vocal' })),
  ];
  song.lyrics = lyrics;
  return song;
}

/** Deep-freeze a value (to prove functions never mutate their input). */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export function opsOfType<K extends string>(ops: { op: string }[], op: K) {
  return ops.filter((o) => o.op === op) as Extract<import('../src/ir/types').MusicOperation, { op: K }>[];
}

/** Absolute tick of a 1-based OpNote / OpChord position. */
export function opTick(song: Song, n: { bar: number; beat: number }): number {
  return musicalToTick(song, n.bar, n.beat);
}

/** Fixture variant with two rhythm guitars (for stereo-width tests). */
export function makeSongWithGuitars(): Song {
  const song = makeSong();
  const mk = (id: string, name: string): Track => ({
    id,
    name,
    kind: 'midi',
    role: 'rhythm-guitar',
    instrumentId: 'electric-guitar-distorted',
    constraints: {},
    notes: [{ id: `${id}-n1`, pitch: 52, tick: 0, duration: BAR, velocity: 90 }],
    clips: [],
    color: '#999999',
    stemGroup: 'guitars',
  });
  song.tracks.push(mk('t-gtr-l', 'Guitar L'), mk('t-gtr-r', 'Guitar R'));
  return song;
}
