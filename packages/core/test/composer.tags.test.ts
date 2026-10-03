import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderGenresDoc } from '../src/composer/genre-docs';
import {
  BUILTIN_TAGS,
  applyTagsToGenre,
  applyTagsToMacros,
  composeSong,
  defaultBlueprint,
  findTags,
  genreForBlueprint,
  getGenre,
  getInstrument,
  getTag,
  listTags,
  tagCatalogSummary,
  tagParents,
} from '../src/composer';
import { createVariation, regenerateUnlocked } from '../src/composer';
import { genreForSong, songTags } from '../src/composer/tags';
import { createProject } from '../src/ir/defaults';
import { packProject, unpackProject } from '../src/project';
import { defaultMacros } from '../src/ir/defaults';
import type { Blueprint, GenreProfile, Song } from '../src/ir/types';

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const withoutTags = (g: GenreProfile) => JSON.stringify({ ...g, tags: undefined });

describe('tag catalog', () => {
  it('has several hundred tags of every kind with unique kebab-case ids', () => {
    expect(BUILTIN_TAGS.length).toBeGreaterThanOrEqual(400);
    expect(listTags('style').length).toBeGreaterThanOrEqual(250);
    expect(listTags('mood').length).toBeGreaterThanOrEqual(60);
    for (const kind of ['era', 'production', 'vocal', 'region', 'rhythm'] as const)
      expect(listTags(kind).length, kind).toBeGreaterThanOrEqual(10);
    const ids = BUILTIN_TAGS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const t of BUILTIN_TAGS) {
      expect(t.name, t.id).toBeTruthy();
      expect(t.description, t.id).toBeTruthy();
      expect(t.group, t.id).toBeTruthy();
    }
  });

  it('keeps the ids the Compose builder relies on', () => {
    for (const id of ['warm', 'lo-fi', 'melancholy', 'cathartic', 'dreamy', 'epic', 'chill'])
      expect(getTag(id)?.id).toBe(id);
  });

  it('names, aliases and ids never collide between tags', () => {
    const owner = new Map<string, string>();
    for (const t of BUILTIN_TAGS) {
      for (const n of new Set([t.id, t.name, ...(t.aliases ?? [])].map(norm))) {
        if (!n) continue;
        const prev = owner.get(n);
        expect(prev === undefined || prev === t.id, `"${n}" is used by ${prev} and ${t.id}`).toBe(true);
        owner.set(n, t.id);
      }
    }
  });

  it('style tags name parent genres that exist; other references are valid', () => {
    for (const t of BUILTIN_TAGS) {
      if (t.kind === 'style') expect(t.parents?.length, t.id).toBeGreaterThan(0);
      for (const p of t.parents ?? []) {
        expect(getGenre(p.genreId)?.id, `${t.id} → ${p.genreId}`).toBe(p.genreId);
        expect(p.weight).toBeGreaterThan(0);
      }
      for (const a of t.effect.instruments?.add ?? [])
        expect(getInstrument(a.instrumentId).id, `${t.id} → ${a.instrumentId}`).toBe(a.instrumentId);
      for (const r of t.effect.instruments?.remove ?? [])
        expect(getInstrument(r).id, `${t.id} removes ${r}`).toBe(r);
    }
  });

  it('every tag has a musical effect and changes the genre profile or the macros', () => {
    const pop = getGenre('pop')!;
    const base = withoutTags(pop);
    const macros = defaultMacros();
    for (const t of BUILTIN_TAGS) {
      const e = t.effect;
      const musical = Boolean(
        e.tempo ||
        e.modes?.length ||
        e.meters?.length ||
        e.rhythm ||
        e.harmony ||
        e.instruments ||
        e.macros ||
        e.energyShift,
      );
      expect(musical, `${t.id} only changes production keywords`).toBe(true);
      const genreChanged = withoutTags(applyTagsToGenre(pop, [t.id])) !== base;
      const macrosChanged = JSON.stringify(applyTagsToMacros(macros, [t.id])) !== JSON.stringify(macros);
      expect(genreChanged || macrosChanged, t.id).toBe(true);
    }
  });

  it('finds tags in free text, longest names first, and resolves aliases', () => {
    const ids = findTags(
      'A warm lo-fi soul song with midwest emo guitars, half-time drums and a dreamy chorus',
    ).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['warm', 'lo-fi', 'midwest-emo', 'half-time', 'dreamy']));
    expect(ids).not.toContain('emo');
    expect(getTag('lofi')?.id).toBe('lo-fi');
    expect(getTag('Deep House')?.id).toBe('deep-house');
    expect(getTag('nope')).toBeUndefined();
    expect(tagParents(['midwest-emo']).map((p) => p.genreId)).toContain('emo');
    expect(tagCatalogSummary({ kinds: ['mood'] })).toContain('melancholy');
  });

  it('style tags pull an empty blend toward their parents and shape the profile', () => {
    const g = genreForBlueprint({ genreBlend: [], tags: ['reggae', 'dancehall'].filter((id) => getTag(id)) });
    expect(g.rhythm.drumStyle).toBe('dembow');
    const bossa = genreForBlueprint({ genreBlend: [], tags: ['shibuya-kei'] });
    expect(bossa.name).toMatch(/J-Pop|Bossa/);
    const fast = genreForBlueprint({ genreBlend: [{ genreId: 'metal', weight: 1 }], tags: ['thrash-metal'] });
    expect(fast.tempo.min).toBeGreaterThanOrEqual(170);
  });

  it('a song remembers its tags', () => {
    const song = { genreBlend: [{ genreId: 'pop', weight: 1 }], tags: ['dark', 'nope'] } as unknown as Song;
    expect(songTags(song)).toEqual(['dark']);
    expect(genreForSong(song).modes[0].mode).toBe('minor');
  });

  it('every tag changes the composed music', () => {
    const base = defaultBlueprint({ genreBlend: [{ genreId: 'pop', weight: 1 }], seed: 3 });
    const bp: Blueprint = { ...base, structure: base.structure.slice(0, 4) };
    const musical = (s: Song) =>
      JSON.stringify({
        tempo: s.tempoMap,
        meter: s.meterMap,
        key: s.keyMap,
        chords: s.chords.map((c) => c.symbol),
        notes: s.tracks.map((t) => t.notes.map((n) => [n.pitch, n.tick, n.duration, n.velocity])),
      });
    const plain = musical(composeSong(bp, undefined, { seed: 3 }));
    for (const t of BUILTIN_TAGS) {
      const tagged = composeSong({ ...bp, tags: [t.id] }, undefined, { seed: 3 });
      expect(tagged.tags).toEqual([t.id]);
      expect(musical(tagged), t.id).not.toBe(plain);
    }
  });

  it('tags shape generation, survive regeneration, variations and .songproject round-trips; macros stay the user base', () => {
    const bp = defaultBlueprint({
      genreBlend: [{ genreId: 'pop', weight: 1 }],
      tags: ['one-drop-test'].concat(['dancehall', 'aggressive']),
      seed: 4,
    });
    expect(bp.tags).toEqual(['dancehall', 'aggressive']);
    const song = composeSong(bp, undefined, { seed: 4 });
    expect(song.tags).toEqual(['dancehall', 'aggressive']);
    // The song's own macros are the blueprint's (user base); tag deltas are not baked in.
    expect(song.macros).toEqual({ ...defaultMacros(), ...bp.macros });
    expect(genreForSong(song).rhythm.drumStyle).toBe('dembow');
    const regen = regenerateUnlocked(song, { seed: 9 }).song;
    expect(regen.tags).toEqual(song.tags);
    expect(regen.macros).toEqual(song.macros);
    for (const level of ['variation', 'reinterpretation', 'mutation'] as const) {
      const v = createVariation(song, level, { seed: 11, amount: 0.5 });
      expect(songTags(v), level).toEqual(['dancehall', 'aggressive']);
    }
    const { project } = unpackProject(packProject(createProject('Tags', song)));
    expect(project.song.tags).toEqual(['dancehall', 'aggressive']);
    expect(project.song.blueprint?.tags).toEqual(['dancehall', 'aggressive']);
  });
});

describe('docs/GENRES.md', () => {
  it('is generated from the current genres and tags (run `npm run docs:genres` after changing them)', () => {
    const doc = readFileSync(new URL('../../../docs/GENRES.md', import.meta.url), 'utf8');
    expect(doc === renderGenresDoc(), 'docs/GENRES.md is stale: run `npm run docs:genres`').toBe(true);
  });
});
