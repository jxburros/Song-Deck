import { describe, expect, it } from 'vitest';
import { BUILTIN_GENRES, BUILTIN_TAGS, composeSong, defaultBlueprint, parsePromptToBlueprint } from '../src/composer';
import { GM_DRUM } from '../src/ir/gm';
import type { Blueprint } from '../src/ir/types';

const SPEC_PROMPT =
  'Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.';

const names = (bp: Blueprint) => bp.instrumentation.map((t) => t.name);
const kinds = (bp: Blueprint) => bp.structure.map((s) => s.kind);

describe('parsePromptToBlueprint — the §73 example', () => {
  const bp = parsePromptToBlueprint(SPEC_PROMPT);

  it('reads genre, tempo, key and meter', () => {
    expect(bp.genreBlend).toEqual([{ genreId: 'alternative-rock', weight: 1 }]);
    expect(bp.styles).toEqual(['Alternative rock']);
    expect(bp.tempo).toBeGreaterThanOrEqual(150);
    expect(bp.tempo).toBeLessThanOrEqual(172);
    expect(bp.key).toEqual({ tonic: 4, mode: 'minor' }); // E minor
    expect(bp.meter).toEqual({ numerator: 4, denominator: 4 });
  });

  it('builds the instrumentation with double-tracked guitars and a tenor', () => {
    expect(names(bp)).toEqual(['Lead Vocal', 'Drums', 'Bass', 'Rhythm Guitar L', 'Rhythm Guitar R', 'Piano', 'Violin']);
    const gl = bp.instrumentation.find((t) => t.name === 'Rhythm Guitar L')!;
    const gr = bp.instrumentation.find((t) => t.name === 'Rhythm Guitar R')!;
    expect(gl.instrumentId).toBe('electric-guitar-distorted');
    expect(gl.pan).toBeLessThan(0);
    expect(gr.pan).toBeGreaterThan(0);
    expect(bp.instrumentation.find((t) => t.name === 'Violin')!.function).toBe('counter-melody');
    expect(bp.vocal).toMatchObject({ voiceType: 'tenor', mode: 'melody-only' });
  });

  it('plans a verse/pre/chorus structure with per-section moods and energy', () => {
    expect(kinds(bp)).toEqual(['intro', 'verse', 'pre-chorus', 'chorus', 'verse', 'pre-chorus', 'chorus', 'bridge', 'final-chorus', 'outro']);
    expect(bp.structure.map((s) => s.name)).toContain('Final Chorus');
    const verse = bp.structure.find((s) => s.kind === 'verse')!;
    const chorus = bp.structure.find((s) => s.kind === 'chorus')!;
    expect(verse.mood).toContain('melancholy');
    expect(chorus.mood).toContain('cathartic');
    expect(chorus.energy!).toBeGreaterThanOrEqual(90);
    expect(verse.energy!).toBeLessThan(chorus.energy!);
    const bridge = bp.structure.find((s) => s.kind === 'bridge')!;
    expect(bridge.energyEnd!).toBeGreaterThan(bridge.energy!);
    expect(bp.moods).toEqual(expect.arrayContaining(['Melancholy verse', 'Huge cathartic chorus']));
  });

  it('is deterministic for the same prompt and seed', () => {
    expect(parsePromptToBlueprint(SPEC_PROMPT)).toEqual(bp);
    expect(parsePromptToBlueprint(SPEC_PROMPT, { seed: 9 })).toEqual(parsePromptToBlueprint(SPEC_PROMPT, { seed: 9 }));
    expect(parsePromptToBlueprint(SPEC_PROMPT, { seed: 9 }).seed).toBe(9);
  });
});

describe('parsePromptToBlueprint — details', () => {
  it('parses explicit BPM, keys and modes', () => {
    expect(parsePromptToBlueprint('emo song at 164 BPM').tempo).toBe(164);
    expect(parsePromptToBlueprint('a pop song in E minor').key).toEqual({ tonic: 4, mode: 'minor' });
    expect(parsePromptToBlueprint('folk tune in D dorian').key).toEqual({ tonic: 2, mode: 'dorian' });
    expect(parsePromptToBlueprint('ballad in F# major').key).toEqual({ tonic: 6, mode: 'major' });
    expect(parsePromptToBlueprint('a song in Bb').key).toEqual({ tonic: 10, mode: 'major' });
    expect(parsePromptToBlueprint('a song in a minor key').key).toEqual({ tonic: 9, mode: 'minor' });
    expect(parsePromptToBlueprint('in the key of C sharp minor').key).toEqual({ tonic: 1, mode: 'minor' });
    // "in a dark mood" is not a key.
    expect(parsePromptToBlueprint('rock song in a dark mood').key.mode).toBe('minor');
  });

  it('parses meters and waltz', () => {
    expect(parsePromptToBlueprint('folk song in 6/8').meter).toEqual({ numerator: 6, denominator: 8 });
    expect(parsePromptToBlueprint('a jazz waltz').meter).toEqual({ numerator: 3, denominator: 4 });
    expect(parsePromptToBlueprint('metal in 7/8').meter).toEqual({ numerator: 7, denominator: 8 });
  });

  it('parses genre blends with percentages', () => {
    const bp = parsePromptToBlueprint('50% pop-punk 30% emo 20% cinematic');
    expect(bp.genreBlend).toEqual([
      { genreId: 'pop-punk', weight: 50 },
      { genreId: 'emo', weight: 30 },
      { genreId: 'cinematic', weight: 20 },
    ]);
    const plain = parsePromptToBlueprint('a synth-pop and house crossover');
    expect(plain.genreBlend.map((g) => g.genreId)).toEqual(['synth-pop', 'house']);
    // Longest match wins: "pop-punk" is not also "pop" and "punk".
    expect(parsePromptToBlueprint('pop punk anthem').genreBlend).toEqual([{ genreId: 'pop-punk', weight: 1 }]);
  });

  it('maps tempo words relative to the genre', () => {
    const fast = parsePromptToBlueprint('fast punk song').tempo;
    const slow = parsePromptToBlueprint('slow punk song').tempo;
    const typical = parsePromptToBlueprint('punk song').tempo;
    expect(fast).toBeGreaterThan(typical);
    expect(slow).toBeLessThan(typical);
  });

  it('reads vocal type and instrumental requests', () => {
    expect(parsePromptToBlueprint('pop song with a female soprano').vocal?.voiceType).toBe('soprano');
    expect(parsePromptToBlueprint('pop song, female vocals').vocal?.voiceType).toBe('mezzo');
    expect(parsePromptToBlueprint('rock song with a deep male voice').vocal?.voiceType).toBe('baritone');
    expect(parsePromptToBlueprint('alto vocal over piano').vocal?.voiceType).toBe('alto');
    const inst = parsePromptToBlueprint('instrumental synth-pop track');
    expect(inst.vocal).toBeUndefined();
    expect(inst.instrumentation.some((t) => t.role === 'vocal')).toBe(false);
    expect(parsePromptToBlueprint('cinematic piece for strings').vocal).toBeUndefined();
  });

  it('counts instruments and names doubled parts', () => {
    const bp = parsePromptToBlueprint('rock song with drums, bass, three guitars and two violins');
    expect(names(bp)).toEqual(expect.arrayContaining(['Rhythm Guitar L', 'Rhythm Guitar R', 'Lead Guitar', 'Violin', 'Violin 2']));
    const syn = parsePromptToBlueprint('synthwave with a drum machine, synth bass, pads, an arpeggiator and a lead synth');
    expect(syn.instrumentation.map((t) => t.instrumentId)).toEqual(expect.arrayContaining(['electronic-kit', 'synth-bass', 'synth-pad', 'synth-arp', 'synth-lead']));
    // A colour instrument without a rhythm section adds to the genre's band.
    const add = parsePromptToBlueprint('pop-punk song with strings');
    expect(add.instrumentation.map((t) => t.role)).toEqual(expect.arrayContaining(['drums', 'bass', 'rhythm-guitar', 'strings']));
    // A solo request stays solo.
    const solo = parsePromptToBlueprint('solo piano piece, instrumental');
    expect(solo.instrumentation.map((t) => t.instrumentId)).toEqual(['piano']);
  });

  it('parses titles, themes and length hints', () => {
    expect(parsePromptToBlueprint('a song called "Paper Lanterns" about summer').title).toBe('Paper Lanterns');
    expect(parsePromptToBlueprint('an emo song titled midnight drive, fast').title).toBe('Midnight Drive');
    expect(parsePromptToBlueprint('a folk song about the sea and old friends').lyricsTheme).toBe('the sea and old friends');
    const normal = parsePromptToBlueprint('pop song');
    const short = parsePromptToBlueprint('a short pop song');
    const bars = (b: Blueprint) => b.structure.reduce((n, s) => n + s.bars, 0);
    expect(bars(short)).toBeLessThan(bars(normal));
    const two = parsePromptToBlueprint('a 2 minute pop song at 120 bpm');
    expect(Math.abs(bars(two) * 2 - 120)).toBeLessThanOrEqual(30); // ~60 bars of 4/4 at 120 BPM
  });

  it('parses explicit structures', () => {
    const bp = parsePromptToBlueprint('structure: intro - verse - chorus - verse - chorus - bridge - chorus - outro');
    expect(kinds(bp)).toEqual(['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'final-chorus', 'outro']);
  });

  it('maps mood and macro words', () => {
    const dark = parsePromptToBlueprint('a dark, aggressive and complex metal track with syncopated riffs');
    expect(dark.macros.complexity).toBeGreaterThan(0.7);
    expect(dark.macros.syncopation).toBeGreaterThan(0.6);
    expect(dark.macros.energy).toBeGreaterThan(0.7);
    expect(dark.key.mode).not.toBe('major');
    const happy = parsePromptToBlueprint('a happy, uplifting pop song');
    expect(happy.key.mode).toBe('major');
    const chill = parsePromptToBlueprint('chill sparse lo-fi beat');
    expect(chill.macros.density).toBeLessThan(0.4);
  });

  it('turns unknown text into a valid blueprint', () => {
    for (const p of ['', 'asdf qwerty', '!!!', 'make me something nice']) {
      const bp = parsePromptToBlueprint(p);
      expect(bp.tempo).toBeGreaterThan(30);
      expect(bp.structure.length).toBeGreaterThan(0);
      expect(bp.instrumentation.length).toBeGreaterThan(0);
      expect(bp.genreBlend.length).toBeGreaterThan(0);
    }
  });
});

describe('defaultBlueprint', () => {
  it('is complete and derives from the genre', () => {
    const bp = defaultBlueprint();
    expect(bp.title).toBe('Untitled');
    expect(bp.structure.length).toBeGreaterThan(4);
    expect(bp.instrumentation.some((t) => t.role === 'drums')).toBe(true);
    const metal = defaultBlueprint({ genreBlend: [{ genreId: 'metal', weight: 1 }] });
    expect(metal.tempo).toBe(150);
    expect(metal.instrumentation.some((t) => t.instrumentId === 'electric-guitar-distorted')).toBe(true);
    expect(defaultBlueprint({ tempo: 99 }).tempo).toBe(99);
  });
});

describe('parsePromptToBlueprint — genres and tags', () => {
  const LOFI_SOUL = 'A warm lo-fi soul song about driving home at dawn, Rhodes, bass, brushed drums, female alto vocal';

  it('reads the lo-fi soul prompt as soul with warm / lo-fi / brushes (regression)', () => {
    const bp = parsePromptToBlueprint(LOFI_SOUL);
    expect(bp.genreBlend.map((g) => g.genreId)).toEqual(['soul']);
    expect(bp.tags).toEqual(expect.arrayContaining(['warm', 'lo-fi', 'brushed-drums']));
    expect(bp.tags).not.toContain('driving');
    expect(bp.moods).toContain('Warm');
    const drums = bp.instrumentation.find((t) => t.role === 'drums')!;
    expect(drums.instrumentId).toBe('drum-kit');
    expect(drums.name).toMatch(/brush/i);
    expect(bp.instrumentation.find((t) => t.role === 'bass')!.instrumentId).toBe('electric-bass');
    expect(bp.instrumentation.some((t) => t.instrumentId === 'electric-piano')).toBe(true);
    expect(bp.vocal?.voiceType).toBe('alto');
    // Brushes: no crash cymbals, softer snare.
    const song = composeSong(bp);
    const kit = song.tracks.find((t) => t.role === 'drums')!;
    expect(kit.notes.some((n) => n.pitch === GM_DRUM.CRASH)).toBe(false);
    expect(song.tags).toEqual(bp.tags);
  });

  it('recognises every genre by name and maps microgenres to their parents', () => {
    for (const g of BUILTIN_GENRES) {
      const bp = parsePromptToBlueprint(`a ${g.name.toLowerCase()} song`);
      expect([...bp.genreBlend].sort((a, b) => b.weight - a.weight)[0].genreId, g.name).toBe(g.id);
    }
    const cases: [string, string, string][] = [
      ['a midwest emo song', 'emo', 'midwest-emo'],
      ['deep house track with a vaporwave vibe', 'house', 'deep-house'],
      ['dream pop ballad', 'shoegaze', 'dream-pop'],
      ['lo-fi beats to chill to', 'lo-fi-hip-hop', 'lo-fi'],
      ['dark trap beat', 'trap', 'dark'],
      ['reggaeton perreo with 808s', 'reggaeton', ''],
      ['liquid drum and bass', 'drum-and-bass', 'liquid-dnb'],
      ['a vaporwave track', 'synth-pop', 'vaporwave'],
    ];
    for (const [prompt, genre, tag] of cases) {
      const bp = parsePromptToBlueprint(prompt);
      expect(bp.genreBlend.map((g) => g.genreId), prompt).toContain(genre);
      if (tag) expect(bp.tags, prompt).toContain(tag);
    }
    // Vocal tags hide their genre word: a rap verse is not a hip-hop blend.
    expect(parsePromptToBlueprint('k-pop with a rap verse').genreBlend.map((g) => g.genreId)).toEqual(['k-pop']);
    // An idiomatic flavour instrument swaps into the genre's band.
    const rt = parsePromptToBlueprint('reggaeton perreo with 808s');
    expect(rt.instrumentation.filter((t) => t.role === 'bass').map((t) => t.instrumentId)).toEqual(['808-bass']);
    expect(rt.instrumentation.some((t) => t.role === 'drums')).toBe(true);
  });

  it('finds every tag by name', () => {
    for (const t of BUILTIN_TAGS) expect(parsePromptToBlueprint(`a ${t.name.toLowerCase()} song`).tags, t.id).toContain(t.id);
  });

  it('keeps tag deltas out of the base macros and orders genre-naming style tags last', () => {
    const plain = parsePromptToBlueprint('a pop song');
    const tagged = parsePromptToBlueprint('an aggressive pop song');
    expect(tagged.tags).toContain('aggressive');
    // "aggressive" still moves the base energy through the mood lexicon, not through tag deltas.
    expect(tagged.macros.energy).toBeGreaterThan(plain.macros.energy);
    const dh = parsePromptToBlueprint('deep house track with a vaporwave vibe');
    expect(dh.tags!.indexOf('deep-house')).toBeGreaterThan(dh.tags!.indexOf('vaporwave'));
    expect(dh.tempo).toBeGreaterThanOrEqual(116);
  });
});
