import { describe, expect, it } from 'vitest';
import { BUILTIN_GENRES, BUILTIN_INSTRUMENTS, blendGenres, getGenre, getInstrument, instrumentForGmProgram } from '../src/composer';
import { romanToChord } from '../src/theory/roman';
import type { GenreProfile } from '../src/ir/types';

const SPEC_GENRES = ['pop', 'synth-pop', 'punk', 'pop-punk', 'emo', 'indie-rock', 'metal', 'folk', 'country', 'edm', 'house', 'trance', 'jazz', 'rnb', 'hip-hop', 'orchestral', 'cinematic'];

describe('genre profiles (§14)', () => {
  it('ships every genre of the spec with kebab-case ids', () => {
    const ids = BUILTIN_GENRES.map((g) => g.id);
    for (const id of SPEC_GENRES) expect(ids).toContain(id);
    expect(ids).toContain('alternative-rock');
    expect(ids).toContain('rock');
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('profiles are complete and internally valid', () => {
    for (const g of BUILTIN_GENRES) {
      expect(g.tempo.min).toBeLessThanOrEqual(g.tempo.typical);
      expect(g.tempo.typical).toBeLessThanOrEqual(g.tempo.max);
      expect(g.meters.length).toBeGreaterThan(0);
      expect(g.modes.length).toBeGreaterThan(0);
      expect(g.structure.templates.length).toBeGreaterThan(0);
      expect(g.instruments.some((i) => i.essential)).toBe(true);
      expect(g.harmony.progressions.length).toBeGreaterThan(2);
      for (const p of g.harmony.progressions) for (const r of p.roman) expect(romanToChord(r, { tonic: 0, mode: 'major' }), `${g.id}: ${r}`).not.toBeNull();
      for (const i of g.instruments) expect(BUILTIN_INSTRUMENTS.some((x) => x.id === i.instrumentId), `${g.id}: ${i.instrumentId}`).toBe(true);
    }
  });

  it('looks genres up by id, alias and custom profile', () => {
    expect(getGenre('pop-punk')?.name).toBe('Pop-Punk');
    expect(getGenre('alt-rock')?.id).toBe('alternative-rock');
    expect(getGenre('R&B')?.id).toBe('rnb');
    expect(getGenre('synthpop')?.id).toBe('synth-pop');
    expect(getGenre('no-such-genre')).toBeUndefined();
    const custom: GenreProfile = { ...getGenre('pop')!, id: 'my-genre', name: 'My Genre', builtIn: false };
    expect(getGenre('my-genre', [custom])?.name).toBe('My Genre');
  });
});

describe('genre blending', () => {
  it('weights numeric traits and merges pools', () => {
    const pp = getGenre('pop-punk')!;
    const emo = getGenre('emo')!;
    const cin = getGenre('cinematic')!;
    const b = blendGenres([
      { genreId: 'pop-punk', weight: 50 },
      { genreId: 'emo', weight: 30 },
      { genreId: 'cinematic', weight: 20 },
    ]);
    const exp = Math.round(pp.tempo.typical * 0.5 + emo.tempo.typical * 0.3 + cin.tempo.typical * 0.2);
    expect(b.tempo.typical).toBe(exp);
    expect(b.harmony.extensionRate).toBeCloseTo(pp.harmony.extensionRate * 0.5 + emo.harmony.extensionRate * 0.3 + cin.harmony.extensionRate * 0.2, 6);
    expect(b.name).toBe('50% Pop-Punk / 30% Emo / 20% Cinematic');
    // Dominant genre decides categorical traits.
    expect(b.rhythm.drumStyle).toBe('pop-punk');
    // Pools: progression weights scaled by genre share (identical entries merged).
    const first = pp.harmony.progressions[0];
    const merged = b.harmony.progressions.find((p) => p.roman.join(' ') === first.roman.join(' ') && (p.sectionKinds ?? []).join() === (first.sectionKinds ?? []).join());
    expect(merged).toBeDefined();
    expect(merged!.weight).toBeGreaterThanOrEqual(first.weight * 0.5 - 1e-9);
    expect(b.structure.templates.length).toBe(pp.structure.templates.length + emo.structure.templates.length + cin.structure.templates.length);
    expect(b.instruments.some((i) => i.instrumentId === 'string-ensemble')).toBe(true);
    // Energy per section is a weighted average.
    const e = (g: GenreProfile) => g.dynamics.energyBySection.chorus!;
    expect(b.dynamics.energyBySection.chorus).toBe(Math.round(e(pp) * 0.5 + e(emo) * 0.3 + e(cin) * 0.2));
  });

  it('normalizes weights and handles a single or unknown genre', () => {
    const a = blendGenres([{ genreId: 'jazz', weight: 1 }, { genreId: 'rnb', weight: 1 }]);
    const b = blendGenres([{ genreId: 'jazz', weight: 5 }, { genreId: 'rnb', weight: 5 }]);
    expect(a.tempo).toEqual(b.tempo);
    expect(blendGenres([{ genreId: 'metal', weight: 3 }]).id).toBe('metal');
    expect(blendGenres([{ genreId: 'unknown', weight: 1 }]).id).toBe('pop');
  });
});

describe('instrument profiles (§17)', () => {
  const TABLE: [string, string, string][] = [
    ['drum-kit', 'drums', 'drums-acoustic'], ['electronic-kit', 'drums', 'drums-electronic'], ['percussion', 'percussion', 'percussion'],
    ['electric-bass', 'bass', 'bass-electric'], ['synth-bass', 'bass', 'bass-synth'], ['upright-bass', 'bass', 'bass-upright'],
    ['electric-guitar-distorted', 'guitar', 'guitar-distorted'], ['electric-guitar-clean', 'guitar', 'guitar-clean'], ['acoustic-guitar', 'guitar', 'guitar-acoustic'],
    ['electric-guitar-lead', 'guitar', 'guitar-lead'], ['piano', 'keys', 'piano'], ['electric-piano', 'keys', 'epiano'], ['organ', 'organ', 'organ'],
    ['violin', 'strings', 'strings-solo'], ['viola', 'strings', 'strings-solo'], ['cello', 'strings', 'strings-solo'], ['contrabass', 'strings', 'strings-solo'],
    ['string-ensemble', 'strings', 'strings-ensemble'], ['pizzicato-strings', 'strings', 'strings-pizz'], ['trumpet', 'brass', 'brass-solo'],
    ['trombone', 'brass', 'brass-solo'], ['french-horn', 'brass', 'brass-solo'], ['brass-section', 'brass', 'brass'], ['flute', 'woodwind', 'flute'],
    ['clarinet', 'woodwind', 'reed'], ['saxophone', 'woodwind', 'reed'], ['synth-pad', 'synth', 'pad-warm'], ['synth-lead', 'synth', 'lead-saw'],
    ['synth-arp', 'synth', 'pluck'], ['synth-seq', 'synth', 'pluck'], ['choir', 'vocal', 'choir'], ['lead-vocal', 'vocal', 'vocal-placeholder'],
    ['backing-vocal', 'vocal', 'vocal-placeholder'], ['harp', 'strings', 'harp'], ['timpani', 'percussion', 'timpani'], ['glockenspiel', 'percussion', 'bell'],
    ['marimba', 'percussion', 'mallet'],
  ];

  it('uses the exact ids, families and patch ids of the contract', () => {
    for (const [id, family, patch] of TABLE) {
      const p = BUILTIN_INSTRUMENTS.find((i) => i.id === id);
      expect(p, id).toBeDefined();
      expect(p!.family, id).toBe(family);
      expect(p!.patchId, id).toBe(patch);
      expect(p!.range.low).toBeLessThan(p!.range.high);
      expect(p!.gmProgram).toBeGreaterThanOrEqual(0);
      expect(p!.gmProgram).toBeLessThanOrEqual(127);
    }
    expect(BUILTIN_INSTRUMENTS.length).toBe(TABLE.length);
    expect(getInstrument('drum-kit').isDrumKit).toBe(true);
    expect(getInstrument('electric-bass').range).toMatchObject({ low: 28, high: 55 });
    expect(getInstrument('violin').range).toMatchObject({ low: 55, high: 100 });
    expect(getInstrument('electric-guitar-distorted').notationTranspose).toBe(12);
    expect(getInstrument('piano').clef).toBe('grand');
    expect(getInstrument('lead-vocal').defaultRole).toBe('vocal');
  });

  it('falls back sensibly and never throws', () => {
    expect(getInstrument('rhodes').id).toBe('electric-piano');
    expect(getInstrument('Fiddle').id).toBe('violin');
    expect(getInstrument('heavy guitar').id).toBe('electric-guitar-distorted');
    expect(getInstrument('gm-33').id).toBe('electric-bass');
    expect(getInstrument('kazoo-9000').id).toBe('piano');
    expect(getInstrument('').id).toBeTruthy();
    const custom = { ...getInstrument('violin'), id: 'my-erhu', name: 'Erhu', custom: true };
    expect(getInstrument('my-erhu', [custom]).name).toBe('Erhu');
  });

  it('maps General MIDI programs', () => {
    expect(instrumentForGmProgram(0).id).toBe('piano');
    expect(instrumentForGmProgram(30).id).toBe('electric-guitar-distorted');
    expect(instrumentForGmProgram(33).id).toBe('electric-bass');
    expect(instrumentForGmProgram(40).id).toBe('violin');
    expect(instrumentForGmProgram(48).id).toBe('string-ensemble');
    expect(instrumentForGmProgram(56).id).toBe('trumpet');
    expect(instrumentForGmProgram(81).id).toBe('synth-lead');
    expect(instrumentForGmProgram(89).id).toBe('synth-pad');
    expect(instrumentForGmProgram(10, true).id).toBe('drum-kit');
    for (let p = 0; p < 128; p++) expect(instrumentForGmProgram(p)).toBeDefined();
  });
});
