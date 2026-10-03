import { describe, expect, it } from 'vitest';
import {
  BUILTIN_GENRES,
  applyBuilderConstraints,
  blueprintFromChoices,
  builderGenre,
  composeSong,
  describeChoices,
  getGenre,
  getTag,
  listTags,
  normalizeGenreWeights,
  planComposition,
  structureTemplateNames,
  suggestInstruments,
  tempoBand,
  tempoForFeel,
  titleFromLyrics,
  type BuilderChoices,
} from '../src/composer';
import { parseLyricSheet } from '../src/musician';
import type { Blueprint, GenreProfile, InstrumentProfile } from '../src/ir/types';
import { validityProblems } from './composer-helpers';

const count = (bp: Blueprint) => {
  const m = new Map<string, number>();
  for (const t of bp.instrumentation) m.set(t.instrumentId, (m.get(t.instrumentId) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort());
};

const MOOD = listTags('mood')[0];
const OTHER = listTags().find((t) => t.kind !== 'mood')!;

describe('blueprintFromChoices: instruments', () => {
  it('gives exactly the instruments and counts asked for (plus no vocal when instrumental)', () => {
    const choices: BuilderChoices = {
      instruments: [
        { instrumentId: 'acoustic-guitar', count: 2 },
        { instrumentId: 'violin', count: 3 },
        { instrumentId: 'upright-bass', count: 1 },
        { instrumentId: 'drum-kit', count: 1 },
      ],
      genres: [{ genreId: 'folk', weight: 1 }],
      vocal: 'none',
    };
    const bp = blueprintFromChoices(choices, { seed: 5 });
    expect(count(bp)).toEqual({ 'acoustic-guitar': 2, 'drum-kit': 1, 'upright-bass': 1, violin: 3 });
    expect(bp.vocal).toBeUndefined();
    // Two identical rhythm guitars are an L/R pair; repeated instruments get numbered names.
    expect(bp.instrumentation.filter((t) => t.instrumentId === 'acoustic-guitar').map((t) => t.name)).toEqual(['Acoustic Guitar L', 'Acoustic Guitar R']);
    expect(bp.instrumentation.filter((t) => t.instrumentId === 'violin').map((t) => t.name)).toEqual(['Violin', 'Violin 2', 'Violin 3']);
    // Instrumental: someone carries the melody; extra violins harmonise.
    expect(bp.instrumentation.filter((t) => t.function === 'melody')).toHaveLength(1);
    expect(bp.instrumentation.filter((t) => t.instrumentId === 'violin' && t.function === 'harmony')).toHaveLength(2);
  });

  it('adds one lead vocal when a vocal is chosen, honours roles and functions', () => {
    const bp = blueprintFromChoices(
      {
        instruments: [
          { instrumentId: 'piano', count: 1, role: 'keys', function: 'pad' },
          { instrumentId: 'electric-guitar-clean', count: 1, role: 'lead-guitar', function: 'counter-melody' },
        ],
        vocal: { voiceType: 'soprano', mode: 'melody-only' },
      },
      { seed: 1 },
    );
    expect(count(bp)).toEqual({ 'electric-guitar-clean': 1, 'lead-vocal': 1, piano: 1 });
    expect(bp.instrumentation.find((t) => t.instrumentId === 'piano')).toMatchObject({ role: 'keys', function: 'pad' });
    expect(bp.instrumentation.find((t) => t.instrumentId === 'electric-guitar-clean')).toMatchObject({ role: 'lead-guitar', function: 'counter-melody' });
    expect(bp.vocal).toEqual({ voiceType: 'soprano', mode: 'melody-only' });
    const song = composeSong(bp, undefined, { seed: 1 });
    expect(song.tracks).toHaveLength(3);
    expect(song.tracks.find((t) => t.role === 'vocal')?.vocal?.voiceType).toBe('soprano');
  });

  it('ignores unknown instruments and uses custom instruments', () => {
    const custom: InstrumentProfile = { id: 'felt-keys', name: 'Felt Keys', family: 'keys', gmProgram: 0, range: { low: 36, high: 96 }, polyphony: 'poly', defaultRole: 'keys', defaultFunction: 'accompaniment', articulations: ['normal'], patchId: 'piano', clef: 'grand', stemGroup: 'keys', custom: true };
    const bp = blueprintFromChoices({ instruments: [{ instrumentId: 'felt-keys', count: 2 }, { instrumentId: 'no-such-thing', count: 3 }], vocal: 'none' }, { seed: 2, customInstruments: [custom] });
    expect(count(bp)).toEqual({ 'felt-keys': 2 });
  });

  it('suggests a genre-typical line-up when none is chosen', () => {
    const rock = getGenre('rock')!;
    const sug = suggestInstruments(rock);
    expect(sug.length).toBeGreaterThan(2);
    expect(sug.some((s) => s.instrumentId === 'lead-vocal')).toBe(false);
    const bp = blueprintFromChoices({ genres: [{ genreId: 'rock', weight: 1 }], vocal: 'none' }, { seed: 3 });
    const expected = Object.fromEntries(sug.map((s) => [s.instrumentId, 0]));
    for (const s of sug) expected[s.instrumentId] += s.count;
    expect(count(bp)).toEqual(Object.fromEntries(Object.entries(expected).sort()));
  });
});

describe('blueprintFromChoices: genres, tags and moods', () => {
  it('normalises genre influence into the blend', () => {
    const bp = blueprintFromChoices({ genres: [{ genreId: 'emo', weight: 0.8 }, { genreId: 'pop-punk', weight: 0.4 }, { genreId: 'rock', weight: 0 }] }, { seed: 1 });
    expect(bp.genreBlend.map((g) => g.genreId)).toEqual(['emo', 'pop-punk']);
    expect(bp.genreBlend[0].weight).toBeCloseTo(2 / 3, 5);
    expect(bp.genreBlend[1].weight).toBeCloseTo(1 / 3, 5);
    expect(bp.genreBlend.reduce((t, g) => t + g.weight, 0)).toBeCloseTo(1, 9);
    expect(bp.styles.slice(0, 2)).toEqual([getGenre('emo')!.name, getGenre('pop-punk')!.name]);
    expect(normalizeGenreWeights([{ genreId: 'nope', weight: 1 }])).toEqual([]);
    expect(blueprintFromChoices({}, { seed: 1 }).genreBlend).toEqual([{ genreId: 'pop', weight: 1 }]);
  });

  it('uses custom genres', () => {
    const custom: GenreProfile = { ...structuredClone(getGenre('folk')!), id: 'sea-shanty', name: 'Sea Shanty', builtIn: false, tempo: { min: 90, max: 110, typical: 100 } };
    const bp = blueprintFromChoices({ genres: [{ genreId: 'sea-shanty', weight: 1 }], vocal: 'none' }, { seed: 4, customGenres: [custom] });
    expect(bp.genreBlend).toEqual([{ genreId: 'sea-shanty', weight: 1 }]);
    expect(bp.tempo).toBe(100);
  });

  it('puts chosen tags and whole-song moods into bp.tags (canonical ids, unknown dropped)', () => {
    const bp = blueprintFromChoices({ tags: [OTHER.id, 'definitely-not-a-tag', OTHER.id], moods: [{ tagId: MOOD.id }] }, { seed: 1 });
    expect(bp.tags).toEqual([OTHER.id, MOOD.id]);
    // Aliases resolve to the canonical id.
    const aliased = listTags().find((t) => t.aliases?.length);
    if (aliased) expect(blueprintFromChoices({ tags: [aliased.aliases![0]] }, { seed: 1 }).tags).toEqual([aliased.id]);
  });

  it('maps moods onto sections: whole-song moods everywhere, targeted moods on their sections', () => {
    const bp = blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }], moods: [{ tagId: MOOD.id }] }, { seed: 1 });
    expect(bp.structure.every((s) => s.mood?.includes(MOOD.name.toLowerCase()))).toBe(true);
    expect(bp.moods).toContain(MOOD.name);
    const targeted = blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }], moods: [{ tagId: MOOD.id, section: 'chorus' }] }, { seed: 1 });
    for (const s of targeted.structure) {
      if (s.kind === 'chorus' || s.kind === 'final-chorus') expect(s.mood, s.name).toEqual([MOOD.name.toLowerCase()]);
      else expect(s.mood, s.name).toBeUndefined();
    }
    expect(targeted.moods).toEqual([`${MOOD.name} chorus`]);
    // A section-only mood is not a whole-song tag.
    expect(targeted.tags).toEqual([]);
    const song = composeSong(targeted, undefined, { seed: 1 });
    expect(song.sections.filter((s) => s.kind === 'chorus').every((s) => s.mood?.includes(MOOD.name.toLowerCase()))).toBe(true);
  });

  it('a style tag without genres blends its parent genres', () => {
    const style = listTags('style').find((t) => t.parents?.length);
    if (!style) return; // catalog without style tags
    const bp = blueprintFromChoices({ tags: [style.id] }, { seed: 1 });
    expect(bp.genreBlend.map((g) => g.genreId).sort()).toEqual([...new Set(style.parents!.map((p) => getGenre(p.genreId)!.id))].sort());
    expect(bp.styles).toContain(style.name);
  });
});

describe('blueprintFromChoices: settings', () => {
  it('uses an exact tempo, or resolves a feel against the genre range', () => {
    expect(blueprintFromChoices({ tempo: 143 }, { seed: 1 }).tempo).toBe(143);
    expect(blueprintFromChoices({ tempo: 1000 }, { seed: 1 }).tempo).toBe(300);
    const g = builderGenre({ genres: [{ genreId: 'rock', weight: 1 }] });
    const slow = blueprintFromChoices({ genres: [{ genreId: 'rock', weight: 1 }], tempo: 'slow' }, { seed: 1 }).tempo;
    const mid = blueprintFromChoices({ genres: [{ genreId: 'rock', weight: 1 }], tempo: 'mid' }, { seed: 1 }).tempo;
    const fast = blueprintFromChoices({ genres: [{ genreId: 'rock', weight: 1 }], tempo: 'fast' }, { seed: 1 }).tempo;
    expect(slow).toBeLessThan(mid);
    expect(fast).toBeGreaterThan(mid);
    expect(mid).toBe(Math.round(g.tempo.typical));
    expect(slow).toBe(tempoForFeel('slow', g));
    for (const f of ['slow', 'mid', 'fast'] as const) {
      const [lo, hi] = tempoBand(f, g);
      expect(tempoForFeel(f, g)).toBeGreaterThanOrEqual(Math.floor(lo));
      expect(tempoForFeel(f, g)).toBeLessThanOrEqual(Math.ceil(hi));
    }
  });

  it('uses the chosen key, mode and meter; fills in the rest deterministically', () => {
    const bp = blueprintFromChoices({ key: { tonic: 4, mode: 'minor' }, meter: { numerator: 6, denominator: 8 } }, { seed: 1 });
    expect(bp.key).toEqual({ tonic: 4, mode: 'minor' });
    expect(bp.meter).toEqual({ numerator: 6, denominator: 8 });
    const modeOnly = blueprintFromChoices({ key: { mode: 'dorian' } }, { seed: 9 });
    expect(modeOnly.key.mode).toBe('dorian');
    const tonicOnly = blueprintFromChoices({ key: { tonic: 7 } }, { seed: 9 });
    expect(tonicOnly.key.tonic).toBe(7);
    const choices: BuilderChoices = { genres: [{ genreId: 'synth-pop', weight: 1 }], moods: [{ tagId: MOOD.id }] };
    expect(blueprintFromChoices(choices, { seed: 42 })).toEqual(blueprintFromChoices(choices, { seed: 42 }));
  });

  it('length and structure templates shape the form', () => {
    const base = blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }] }, { seed: 1 });
    const bars = (b: Blueprint) => b.structure.reduce((n, s) => n + s.bars, 0);
    expect(bars(blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }], length: 'short' }, { seed: 1 }))).toBeLessThan(bars(base));
    expect(bars(blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }], length: 'long' }, { seed: 1 }))).toBeGreaterThan(bars(base));
    const twoMin = blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }], length: { minutes: 2 }, tempo: 120 }, { seed: 1 });
    expect(bars(twoMin)).toBeGreaterThanOrEqual(54);
    expect(bars(twoMin)).toBeLessThanOrEqual(66);
    const pop = getGenre('pop')!;
    const names = structureTemplateNames(pop);
    expect(names.length).toBeGreaterThan(0);
    const t = pop.structure.templates.find((x) => x.name === names[names.length - 1])!;
    expect(blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }], structure: t.name }, { seed: 1 }).structure.map((s) => s.kind)).toEqual(t.sections.map((s) => s.kind));
  });

  it('vocal: none, explicit, or auto from the genre', () => {
    expect(blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }], vocal: 'none' }, { seed: 1 }).instrumentation.some((t) => t.instrumentId === 'lead-vocal')).toBe(false);
    const auto = blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }] }, { seed: 1 });
    expect(auto.vocal?.mode).toBe('melody-only');
    expect(auto.instrumentation.filter((t) => t.instrumentId === 'lead-vocal')).toHaveLength(1);
    const orchestral = blueprintFromChoices({ genres: [{ genreId: 'orchestral', weight: 1 }] }, { seed: 1 });
    expect(orchestral.vocal).toBeUndefined();
  });

  it('title, theme and macros pass through', () => {
    const bp = blueprintFromChoices({ title: '  Night Drive ', lyricsTheme: 'leaving home', macros: { complexity: 0.9 } }, { seed: 1 });
    expect(bp.title).toBe('Night Drive');
    expect(bp.lyricsTheme).toBe('leaving home');
    expect(bp.macros.complexity).toBe(0.9);
    expect(bp.seed).toBe(1);
  });
});

describe('blueprintFromChoices: lyrics', () => {
  const lyrics = parseLyricSheet('[Verse 1]\nUnder the streetlights I wait for the rain\nCounting the cars as they carry my name\n\n[Chorus]\nHold on to me tonight\nNever let me go\n\n[Verse 2]\nNobody answers the call\nShadows are taller than all\n\n[Chorus]');
  it('builds the structure around the lyrics, carries them and defaults to an AI singer', () => {
    const bp = blueprintFromChoices({ lyrics, genres: [{ genreId: 'indie-rock', weight: 1 }], length: 'short' }, { seed: 3 });
    expect(bp.structure.map((s) => s.kind)).toEqual(['intro', 'verse', 'chorus', 'verse', 'final-chorus', 'outro']);
    expect(bp.lyrics?.sections).toEqual(lyrics.sections);
    expect(bp.vocal).toEqual({ voiceType: 'tenor', mode: 'ai-singer' });
    expect(bp.title).toBe(titleFromLyrics(lyrics));
    expect(bp.title).toBe('Hold on to Me Tonight');
    const song = composeSong(bp, planComposition(bp, { seed: 3 }), { seed: 3 });
    expect(song.lyrics.length).toBe(8);
    expect(validityProblems(song)).toEqual([]);
  });
});

describe('applyBuilderConstraints', () => {
  const choices: BuilderChoices = {
    title: 'Mine',
    instruments: [{ instrumentId: 'piano', count: 2 }, { instrumentId: 'cello', count: 1 }],
    genres: [{ genreId: 'jazz', weight: 1 }],
    moods: [{ tagId: MOOD.id }],
    tags: [OTHER.id],
    tempo: 92,
    key: { tonic: 2, mode: 'dorian' },
    meter: { numerator: 3, denominator: 4 },
    vocal: 'none',
  };
  const model: Blueprint = {
    ...blueprintFromChoices({ genres: [{ genreId: 'edm', weight: 1 }], vocal: { voiceType: 'alto', mode: 'melody-only' } }, { seed: 99 }),
    title: 'Model title',
    tempo: 128,
    key: { tonic: 9, mode: 'minor' },
    tags: ['made-up-tag', ...(listTags().length > 2 ? [listTags()[2].id] : [])],
    moods: ['Euphoric drop'],
  };

  it('the model cannot override the user’s choices; unknown tags are dropped', () => {
    const bp = applyBuilderConstraints(model, choices, { seed: 7 });
    expect(count(bp)).toEqual({ cello: 1, piano: 2 });
    expect(bp.genreBlend).toEqual([{ genreId: 'jazz', weight: 1 }]);
    expect(bp.tempo).toBe(92);
    expect(bp.key).toEqual({ tonic: 2, mode: 'dorian' });
    expect(bp.meter).toEqual({ numerator: 3, denominator: 4 });
    expect(bp.vocal).toBeUndefined();
    expect(bp.title).toBe('Mine');
    expect(bp.tags).toContain(OTHER.id);
    expect(bp.tags).toContain(MOOD.id);
    expect(bp.tags).not.toContain('made-up-tag');
    for (const id of bp.tags ?? []) expect(getTag(id)).toBeTruthy();
    expect(bp.moods[0]).toBe(MOOD.name);
    expect(bp.moods).toContain('Euphoric drop');
    expect(bp.seed).toBe(7);
  });

  it('keeps the model’s detail where the user left a choice open', () => {
    const open = applyBuilderConstraints(model, { genres: [{ genreId: 'jazz', weight: 1 }] }, { seed: 7 });
    expect(open.tempo).toBe(128);
    expect(open.key).toEqual(model.key);
    expect(open.instrumentation).toEqual(model.instrumentation);
    expect(open.structure).toEqual(model.structure);
    expect(open.title).toBe('Model title');
    // A tempo feel only corrects a model tempo outside the feel's band.
    const slow = applyBuilderConstraints(model, { genres: [{ genreId: 'jazz', weight: 1 }], tempo: 'slow' }, { seed: 7 });
    const [lo, hi] = tempoBand('slow', builderGenre({ genres: [{ genreId: 'jazz', weight: 1 }] }));
    expect(slow.tempo).toBeGreaterThanOrEqual(lo);
    expect(slow.tempo).toBeLessThanOrEqual(hi);
  });

  it('enforces lyrics-driven structure', () => {
    const lyrics = parseLyricSheet('[Verse]\nOne two three four\n\n[Chorus]\nFive six seven');
    const bp = applyBuilderConstraints(model, { lyrics }, { seed: 1 });
    expect(bp.structure.map((s) => s.kind)).toEqual(['intro', 'verse', 'chorus', 'outro']);
    expect(bp.lyrics?.sections).toEqual(lyrics.sections);
  });

  it('every built-in genre builds a valid blueprint', () => {
    for (const g of BUILTIN_GENRES) {
      const bp = blueprintFromChoices({ genres: [{ genreId: g.id, weight: 1 }] }, { seed: 2 });
      expect(bp.instrumentation.length, g.id).toBeGreaterThan(0);
      expect(bp.structure.length, g.id).toBeGreaterThan(0);
      expect(bp.tempo, g.id).toBeGreaterThanOrEqual(30);
    }
  });
});

describe('describeChoices', () => {
  it('lists only what the user fixed, in plain language', () => {
    expect(describeChoices({})).toEqual([]);
    const lines = describeChoices({
      instruments: [{ instrumentId: 'acoustic-guitar', count: 2 }],
      genres: [{ genreId: 'folk', weight: 3 }, { genreId: 'country', weight: 1 }],
      moods: [{ tagId: MOOD.id, section: 'chorus' }],
      tempo: 'slow',
      key: { tonic: 4, mode: 'minor' },
      vocal: 'none',
    });
    expect(lines).toEqual([
      'Instruments, exactly these tracks and counts: Acoustic Guitar (acoustic-guitar) × 2',
      'Genre blend: folk 75%, country 25%',
      `Moods: ${MOOD.id} (chorus only)`,
      'Tempo feel: slow',
      'Key: E minor',
      'Vocal: none (instrumental)',
    ]);
  });
});
