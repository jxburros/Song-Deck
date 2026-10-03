import { describe, expect, it } from 'vitest';
import { BUILTIN_GENRES, BUILTIN_INSTRUMENTS, createEmptySong, createProject, type GenreProfile, type InstrumentProfile, type Track } from '@songdeck/core';
import { bundleCustomProfiles, mergeById } from '../src/state/profiles';

const customGenre: GenreProfile = { ...BUILTIN_GENRES[0], id: 'lofi-hiphop', name: 'Lo-fi Hip-Hop' };
const unusedGenre: GenreProfile = { ...BUILTIN_GENRES[0], id: 'unused-genre', name: 'Unused' };
const customInstrument: InstrumentProfile = { ...BUILTIN_INSTRUMENTS[0], id: 'my-rhodes', name: 'My Rhodes' };

describe('custom profile bundling', () => {
  it('merges by id with later lists winning', () => {
    const a = { id: 'x', v: 1 };
    const b = { id: 'x', v: 2 };
    const c = { id: 'y', v: 3 };
    expect(mergeById([a], [b, c])).toEqual([b, c]);
  });

  it('bundles only the custom profiles the song uses', () => {
    const song = createEmptySong({ title: 'Portable' });
    song.genreBlend = [{ genreId: 'lofi-hiphop', weight: 1 }, { genreId: BUILTIN_GENRES[1].id, weight: 0.5 }];
    // Only instrumentId matters here; a partial track keeps the fixture readable.
    song.tracks = [{ id: 't1', name: 'Keys', instrumentId: 'my-rhodes', notes: [] } as unknown as Track];
    const project = createProject('Portable', song);
    const next = bundleCustomProfiles(project, song, [customGenre, unusedGenre], [customInstrument]);
    expect(next.meta.customGenres.map((g) => g.id)).toEqual(['lofi-hiphop']);
    expect(next.meta.customInstruments.map((i) => i.id)).toEqual(['my-rhodes']);
  });

  it('returns the same project when nothing custom is used', () => {
    const song = createEmptySong({ title: 'Plain' });
    song.genreBlend = [{ genreId: BUILTIN_GENRES[0].id, weight: 1 }];
    const project = createProject('Plain', song);
    expect(bundleCustomProfiles(project, song, [customGenre], [customInstrument])).toBe(project);
  });
});
