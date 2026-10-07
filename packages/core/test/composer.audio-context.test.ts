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
