import { stableStringify, type GenreProfile, type InstrumentProfile, type Project, type Song } from '@songdeck/core';

/** Merge profile lists by id; later lists win (plugin < Settings < project). */
export function mergeById<T extends { id: string }>(...lists: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) for (const item of list) byId.set(item.id, item);
  return Array.from(byId.values());
}

/**
 * Bundle the custom genre/instrument profiles a song actually uses into the project, so the
 * `.songproject` stays portable (it opens with the same profiles on a machine that lacks the
 * plugin or Settings entry that supplied them).
 */
export function bundleCustomProfiles(project: Project, song: Song, genres: GenreProfile[], instruments: InstrumentProfile[]): Project {
  const genreIds = new Set(song.genreBlend.map((g) => g.genreId));
  const instrumentIds = new Set(song.tracks.map((t) => t.instrumentId));
  // Only profiles that are missing from the project or changed since they were bundled.
  const stale = <T extends { id: string }>(p: T, bundled: T[]) => {
    const have = bundled.find((b) => b.id === p.id);
    return !have || stableStringify(have) !== stableStringify(p);
  };
  const usedGenres = genres.filter((g) => genreIds.has(g.id) && stale(g, project.meta.customGenres));
  const usedInstruments = instruments.filter((i) => instrumentIds.has(i.id) && stale(i, project.meta.customInstruments));
  if (!usedGenres.length && !usedInstruments.length) return project;
  return {
    ...project,
    meta: {
      ...project.meta,
      customGenres: mergeById(project.meta.customGenres, usedGenres),
      customInstruments: mergeById(project.meta.customInstruments, usedInstruments),
    },
  };
}
