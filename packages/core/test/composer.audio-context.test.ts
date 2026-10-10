import { expect, it } from 'vitest';
import { composeSong, parsePromptToBlueprint, regenerateUnlocked } from '../src/composer';
import { buildSongGen, makeCell } from '../src/composer/context';

it('uses attached audio MIDI as melody and drum context without regenerating the recording', () => {
  const song = composeSong(
    parsePromptToBlueprint('Piano, drums and bass, instrumental, 8 bars', { seed: 12 }),
  );
  const melody =
    song.tracks.find((t) => t.role === 'keys') ??
    song.tracks.find((t) => t.role !== 'drums' && t.role !== 'bass')!;
  const drums = song.tracks.find((t) => t.role === 'drums')!;
  const bass = song.tracks.find((t) => t.role === 'bass')!;
  for (const t of [melody, drums]) {
    t.kind = 'audio';
    t.audioMidi = {
      play: 'audio',
      mode: t === drums ? 'drums' : 'melody',
      instrumentId: t.instrumentId,
      method: 'test',
      sourceKey: 'test',
      confidence: 1,
      createdAt: new Date().toISOString(),
    };
  }
  melody.constraints.function = 'melody';
  melody.notes = [{ id: 'melody', tick: 0, duration: 480, pitch: 72, velocity: 90 }];
  drums.notes = [{ id: 'kick', tick: 0, duration: 120, pitch: 36, velocity: 90 }];
  const before = structuredClone(song.tracks.filter((t) => t.kind === 'audio'));
  const g = buildSongGen(song, { seed: 12 });
  expect(g.principalMelodyId).toBe(melody.id);
  const cell = makeCell(g, bass, 0, 12);
  expect(cell.melodyNotes()).toEqual(melody.notes);
  expect(cell.kickTicks()).toEqual([0]);
  const next = regenerateUnlocked(song, { seed: 42 }).song;
  expect(next.tracks.filter((t) => t.kind === 'audio')).toEqual(before);
});

it('reads preserved MIDI even when arrangement constraints exclude that section', () => {
  const song = composeSong(
    parsePromptToBlueprint('Piano, drums and bass, instrumental, 8 bars', { seed: 12 }),
  );
  const melody = song.tracks.find((t) => t.role === 'keys')!;
  const drums = song.tracks.find((t) => t.role === 'drums')!;
  const bass = song.tracks.find((t) => t.role === 'bass')!;
  melody.constraints = { function: 'melody', sectionIds: ['not-here'] };
  drums.constraints.sectionIds = ['not-here'];
  melody.notes = [{ id: 'held', tick: 0, duration: 480, pitch: 72, velocity: 90 }];
  drums.notes = [{ id: 'kick', tick: 120, duration: 120, pitch: 36, velocity: 90 }];
  const g = buildSongGen(song, { seed: 12 });
  expect(g.plays(melody.id, song.sections[0].id)).toBe(false);
  const cell = makeCell(g, bass, 0, 12);
  expect(cell.melodyNotes()).toEqual(melody.notes);
  expect(cell.kickTicks()).toEqual([120]);
});

it('includes sustained melody across section boundaries without moving the source notes', () => {
  const song = composeSong(
    parsePromptToBlueprint('Piano, drums and bass, instrumental, 8 bars', { seed: 12 }),
  );
  song.sections = [
    { id: 'a', kind: 'verse', name: 'A', bars: 1, energy: 50 },
    { id: 'b', kind: 'chorus', name: 'B', bars: 1, energy: 70 },
  ];
  const melody = song.tracks.find((t) => t.role === 'keys')!;
  const bass = song.tracks.find((t) => t.role === 'bass')!;
  melody.constraints.function = 'melody';
  melody.notes = [{ id: 'held', tick: 1800, duration: 480, pitch: 72, velocity: 90 }];
  const cell = makeCell(buildSongGen(song, { seed: 12 }), bass, 1, 12);
  expect(cell.melodyNotes()[0]).toMatchObject({ tick: 1920, duration: 360 });
  expect(melody.notes[0]).toMatchObject({ tick: 1800, duration: 480 });
});

it('recognizes melody attached to a piano recording ahead of an empty generated vocal', () => {
  const song = composeSong(parsePromptToBlueprint('Piano, drums and bass, 8 bars', { seed: 12 }));
  const melody = song.tracks.find((t) => t.role === 'keys')!;
  melody.kind = 'audio';
  melody.constraints = {};
  melody.audioMidi = {
    play: 'audio',
    mode: 'melody',
    instrumentId: 'piano',
    sourceKey: '',
    method: 'test',
    confidence: 1,
    createdAt: '',
  };
  melody.notes = [{ id: 'source', tick: 0, duration: 480, pitch: 64, velocity: 90 }];
  expect(buildSongGen(song, { seed: 12 }).principalMelodyId).toBe(melody.id);
});
