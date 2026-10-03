/**
 * Small hand-built fixture songs shared by the edit / io / project tests (no composer dependency).
 */
import { createEmptySong, defaultChannelStrip } from '../src/ir/defaults';
import { sortNotes } from '../src/ir/song-utils';
import { chordToRoman } from '../src/theory/roman';
import { parseChordSymbol } from '../src/theory/chords';
import type { ChordEvent, KeySignature, Note, Song, Track } from '../src/ir/types';

export const E_MINOR: KeySignature = { tonic: 4, mode: 'minor' };
const BAR = 1920;
const Q = 480;

function track(id: string, name: string, role: Track['role'], instrumentId: string, midiChannel: number, notes: Note[], stemGroup: Track['stemGroup']): Track {
  return { id, name, kind: 'midi', role, instrumentId, constraints: {}, notes, clips: [], color: '#888888', stemGroup, midiChannel };
}

/**
 * 20-bar song in E minor, 120 BPM, 4/4:
 *   Intro (bars 1–4), Verse (bars 5–12), Chorus (bars 13–20).
 * Tracks: Bass (one quarter note per beat), Drums (kick/snare/hat), Vocal (chorus melody with
 * syllables and lyric lines), Piano (whole-note triads).
 * Chords: Em C G D, one per bar, repeating.
 */
export function makeSong(): Song {
  const song = createEmptySong({ title: 'Fixture Song', bpm: 120, key: E_MINOR, id: 'song_fixture', seed: 42 });
  song.sections = [
    { id: 'sec_intro', name: 'Intro', kind: 'intro', bars: 4, energy: 30 },
    { id: 'sec_verse', name: 'Verse', kind: 'verse', bars: 8, energy: 45 },
    { id: 'sec_chorus', name: 'Chorus', kind: 'chorus', bars: 8, energy: 80 },
  ];
  const bassRoots = [40, 36, 43, 38]; // E2 C2 G2 D2
  const bass: Note[] = [];
  const drums: Note[] = [];
  const piano: Note[] = [];
  const triads = [
    [52, 55, 59],
    [48, 52, 55],
    [55, 59, 62],
    [50, 54, 57],
  ];
  for (let bar = 0; bar < 20; bar++) {
    const root = bassRoots[bar % 4];
    for (let beat = 0; beat < 4; beat++) {
      bass.push({ id: `b_${bar}_${beat}`, pitch: root, tick: bar * BAR + beat * Q, duration: Q, velocity: 96 });
      drums.push({ id: `h_${bar}_${beat}`, pitch: 42, tick: bar * BAR + beat * Q, duration: 120, velocity: 70 });
    }
    drums.push({ id: `k_${bar}`, pitch: 36, tick: bar * BAR, duration: 120, velocity: 110 });
    drums.push({ id: `s_${bar}`, pitch: 38, tick: bar * BAR + 2 * Q, duration: 120, velocity: 100 });
    for (const p of triads[bar % 4]) piano.push({ id: `p_${bar}_${p}`, pitch: p, tick: bar * BAR, duration: BAR, velocity: 70 });
  }
  // Chorus vocal: "Hold on to the light" ×2 (bars 13–16 and 17–20).
  const words = ['Hold', 'on', 'to', 'the', 'light-', 'ning'];
  const melody = [71, 69, 67, 66, 64, 67];
  const vocal: Note[] = [];
  for (const [li, startBar] of [12, 16].entries()) {
    words.forEach((w, i) => {
      vocal.push({
        id: `v_${li}_${i}`,
        pitch: melody[i],
        tick: startBar * BAR + i * Q * 2,
        duration: Q * 2 - 60,
        velocity: 90,
        syllable: w,
        lyricLineId: `ly_${li}`,
      });
    });
  }
  song.tracks = [
    track('trk_bass', 'Bass', 'bass', 'electric-bass', 0, bass, 'bass'),
    track('trk_drums', 'Drums', 'drums', 'drum-kit', 9, drums, 'drums'),
    track('trk_vocal', 'Vocal', 'vocal', 'lead-vocal', 1, vocal, 'vocals'),
    track('trk_piano', 'Piano', 'keys', 'piano', 2, piano, 'keys'),
  ];
  for (const t of song.tracks) {
    sortNotes(t.notes);
    song.mixer.channels[t.id] = defaultChannelStrip();
  }
  song.lyrics = [
    { id: 'ly_0', sectionId: 'sec_chorus', text: 'Hold on to the lightning', trackId: 'trk_vocal', author: 'human' },
    { id: 'ly_1', sectionId: 'sec_chorus', text: 'Hold on to the lightning', trackId: 'trk_vocal', author: 'human' },
  ];
  const symbols = ['Em', 'C', 'G', 'D'];
  const chords: ChordEvent[] = [];
  for (let bar = 0; bar < 20; bar++) {
    const symbol = symbols[bar % 4];
    const spec = parseChordSymbol(symbol)!;
    chords.push({ id: `ch_${bar}`, tick: bar * BAR, duration: BAR, ...spec, symbol, roman: chordToRoman(spec, E_MINOR) });
  }
  song.chords = chords;
  return song;
}

export const TICKS = { BAR, Q };

/** Notes of a track whose onset is in 1-based bars [a, b]. */
export function notesInBars(song: Song, trackId: string, a: number, b: number): Note[] {
  const t = song.tracks.find((x) => x.id === trackId)!;
  return t.notes.filter((n) => n.tick >= (a - 1) * BAR && n.tick < b * BAR);
}
