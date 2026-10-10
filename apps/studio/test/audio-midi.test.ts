import { describe, expect, it } from 'vitest';
import { LockKeys, createEmptySong, type Track } from '@songdeck/core';
import { guessMode, notesFromTranscription, notesLockedReason } from '../src/engine/audio-midi';

const song = createEmptySong({ title: 'T', bpm: 120, id: 's' }); // a quarter note = 0.5 s = 480 ticks

const audioTrack = (extra: Partial<Track>): Track => ({
  id: 'a',
  name: 'Take',
  kind: 'audio',
  role: 'custom',
  instrumentId: 'audio',
  constraints: {},
  notes: [],
  clips: [],
  color: '#888888',
  stemGroup: 'others',
  ...extra,
});

describe('making MIDI from an audio track', () => {
  it('places notes on the song timeline from where the audio starts, without a grid', () => {
    const notes = notesFromTranscription(
      song,
      {
        method: 'yin',
        transcribed: [
          { pitch: 60, startSeconds: 0.013, endSeconds: 0.49, velocity: 90, confidence: 0.9 },
          { pitch: 62, startSeconds: 0.5, endSeconds: 0.75, velocity: 80, confidence: 0.8 },
          // overlapping second note of the same line: monophony keeps one note sounding at a time
          { pitch: 64, startSeconds: 0.7, endSeconds: 1, velocity: 70, confidence: 0.7 },
        ],
      },
      'melody',
      2, // the audio begins 2 s (bar 2) into the song
      'n',
    );
    expect(notes.map((n) => [n.pitch, n.tick, n.tick + n.duration])).toEqual([
      [60, 1932, 2390], // 2.013 s → 1932.48 ticks, not snapped to 1920
      [62, 2400, 2592],
      [64, 2592, 2880],
    ]);
    expect(notes.every((n) => n.origin === 'transcription:yin')).toBe(true);
    expect(notes[0].confidence).toBe(0.9);
  });

  it('turns drum hits into short GM drum notes', () => {
    const notes = notesFromTranscription(
      song,
      {
        method: 'drums',
        transcribed: [],
        drumHits: [
          { time: 0, drum: 36, velocity: 100, confidence: 0.9 },
          { time: 0.5, drum: 38, velocity: 90, confidence: 0.8 },
        ],
      },
      'drums',
      0,
      'd',
    );
    expect(notes.map((n) => [n.pitch, n.tick, n.duration])).toEqual([
      [36, 0, 120],
      [38, 480, 120],
    ]);
  });

  it('guesses what an audio track holds from its role and stem group', () => {
    expect(guessMode(audioTrack({ role: 'vocal', stemGroup: 'vocals' }))).toBe('melody');
    expect(guessMode(audioTrack({ stemGroup: 'bass' }))).toBe('melody');
    expect(guessMode(audioTrack({ stemGroup: 'drums' }))).toBe('drums');
    expect(guessMode(audioTrack({ stemGroup: 'keys' }))).toBe('chords');
    expect(guessMode(audioTrack({}))).toBeNull();
  });

  it('never replaces locked notes', () => {
    const note = { id: 'n', pitch: 60, tick: 0, duration: 480, velocity: 90 };
    const take = audioTrack({ notes: [note] });
    expect(notesLockedReason(song, take)).toBeNull();
    expect(notesLockedReason(song, audioTrack({ notes: [{ ...note, locked: true }] }))).toMatch(
      /locked notes/,
    );
    const locked = { ...song, locks: { [LockKeys.track('a')]: true } };
    expect(notesLockedReason(locked, take)).toMatch(/is locked/);
  });
});

it('keeps provider drum notes when the provider has no separate drumHits array', () => {
  const notes = notesFromTranscription(
    song,
    {
      method: 'bridge',
      transcribed: [
        { pitch: 36, startSeconds: 0.5, endSeconds: 0.6, velocity: 100, confidence: 0.8 },
        { pitch: 42, startSeconds: 0.5, endSeconds: 0.6, velocity: 75, confidence: 0.9 },
      ],
    },
    'drums',
    2,
    'remote',
  );
  expect(notes.map((n) => [n.pitch, n.tick, n.duration])).toEqual([
    [36, 2400, 120],
    [42, 2400, 120],
  ]);
});

it('protects section and track-section locks even when the recording has no notes yet', () => {
  for (const key of [LockKeys.section('verse'), LockKeys.trackSection('a', 'verse')]) {
    const locked = {
      ...song,
      sections: [{ id: 'verse', name: 'Verse', kind: 'verse' as const, bars: 4, energy: 50 }],
      locks: { [key]: true },
    };
    expect(notesLockedReason(locked, audioTrack({}))).toMatch(/locked sections/);
  }
});

it('maps note starts and ends across tempo changes rather than using one BPM', () => {
  const varying = {
    ...song,
    tempoMap: [
      { tick: 0, bpm: 120 },
      { tick: 1920, bpm: 60 },
    ],
  };
  const notes = notesFromTranscription(
    varying,
    {
      method: 'bridge',
      transcribed: [{ pitch: 60, startSeconds: 0, endSeconds: 1, velocity: 80, confidence: 1 }],
    },
    'chords',
    1.5,
    'tempo',
  );
  expect(notes[0]).toMatchObject({ tick: 1440, duration: 720 });
});
