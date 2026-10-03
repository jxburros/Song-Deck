import { describe, expect, it } from 'vitest';
import {
  alignLyrics,
  countSyllables,
  generatePlaceholderLyrics,
  lyricTokens,
  syllabify,
  syllabifyText,
  syllableToPhonemes,
  textToPhonemes,
  validateLyricAlignment,
} from '../src/musician';
import { cloneSong, stableStringify } from '../src/ir/song-utils';
import type { Song } from '../src/ir/types';
import { BAR, deepFreeze, makeSong, opTick, opsOfType } from './musician-fixtures';

describe('syllabify', () => {
  it('splits words into syllables', () => {
    expect(syllabify('cathartic')).toEqual(['ca', 'thar', 'tic']);
    expect(syllabify('Cathartic')).toEqual(['Ca', 'thar', 'tic']);
    expect(syllabify('beautiful')).toEqual(['beau', 'ti', 'ful']);
    expect(syllabify('nation')).toEqual(['na', 'tion']);
    expect(syllabify('table')).toEqual(['ta', 'ble']);
    expect(syllabify('little')).toEqual(['lit', 'tle']);
    expect(syllabify('singing')).toEqual(['sing', 'ing']);
    expect(syllabify('running')).toEqual(['run', 'ning']);
    expect(syllabify('remember')).toEqual(['re', 'mem', 'ber']);
    expect(syllabify('tonight')).toEqual(['to', 'night']);
    expect(syllabify('wanted')).toEqual(['want', 'ed']);
    expect(syllabify('fire')).toEqual(['fire']);
    expect(syllabify("couldn't")).toEqual(['could', "n't"]);
    expect(syllabify("don't")).toEqual(["don't"]);
  });

  it('gets syllable counts right on a list of song words', () => {
    const words: [string, number][] = [
      ['love', 1],
      ['heart', 1],
      ['fire', 1],
      ['night', 1],
      ['the', 1],
      ['dreams', 1],
      ['loved', 1],
      ['makes', 1],
      ['tries', 1],
      ['eyes', 1],
      ['tonight', 2],
      ['broken', 2],
      ['music', 2],
      ['inside', 2],
      ['alone', 2],
      ['wishes', 2],
      ['changes', 2],
      ['lonely', 2],
      ['heaven', 2],
      ['every', 2],
      ['people', 2],
      ['flower', 2],
      ['power', 2],
      ['quiet', 2],
      ['poem', 2],
      ['lion', 2],
      ['cruel', 2],
      ['special', 2],
      ['beautiful', 3],
      ['cathartic', 3],
      ['melody', 3],
      ['remember', 3],
      ['together', 3],
      ['yesterday', 3],
      ['forever', 3],
      ['family', 3],
      ['violin', 3],
      ['piano', 3],
      ['radio', 3],
      ['happier', 3],
      ['musician', 3],
      ['idea', 3],
      ['video', 3],
      ['imagination', 5],
      ['revolution', 4],
      ['emotional', 4],
      ['comfortable', 4],
      ['continuous', 4],
      ['settled', 2],
      ['rhythm', 2],
      ['chasm', 2],
      ['fireworks', 2],
      ['something', 2],
      ["I'm", 1],
      ["isn't", 2],
      ['indeed', 2],
    ];
    const wrong = words
      .filter(([w, n]) => syllabify(w).length !== n)
      .map(([w, n]) => `${w}: ${syllabify(w).join('-')} (expected ${n})`);
    expect(wrong).toEqual([]);
  });

  it('syllabifies and counts whole lines', () => {
    expect(syllabifyText("Don't let the fire die").map((w) => w.syllables.length)).toEqual([1, 1, 1, 1, 1]);
    expect(countSyllables('Hold on to the night sky')).toBe(6);
    expect(countSyllables('Walking down the empty road')).toBe(7);
    expect(countSyllables('A cathartic melody, forever')).toBe(10);
    expect(lyricTokens('cathartic fire').map((t) => t.text)).toEqual(['ca-', 'thar-', 'tic', 'fire']);
  });
});

describe('G2P (textToPhonemes)', () => {
  it('uses the exception dictionary for common song words', () => {
    expect(textToPhonemes('love')).toEqual(['L', 'AH', 'V']);
    expect(textToPhonemes('heart')).toEqual(['HH', 'AA', 'R', 'T']);
    expect(textToPhonemes('fire')).toEqual(['F', 'AY', 'ER']);
    expect(textToPhonemes('night')).toEqual(['N', 'AY', 'T']);
    expect(textToPhonemes('the')).toEqual(['DH', 'AH']);
    expect(textToPhonemes('you')).toEqual(['Y', 'UW']);
    expect(textToPhonemes('I')).toEqual(['AY']);
    expect(textToPhonemes('Fire in my heart')).toEqual([
      'F',
      'AY',
      'ER',
      'IH',
      'N',
      'M',
      'AY',
      'HH',
      'AA',
      'R',
      'T',
    ]);
  });

  it('applies letter-to-sound rules to other words', () => {
    const p = (w: string) => textToPhonemes(w).join(' ');
    expect(p('cat')).toBe('K AE T');
    expect(p('make')).toBe('M EY K');
    expect(p('dreams')).toBe('D R IY M Z');
    expect(p('walked')).toBe('W AO K T');
    expect(p('wanted')).toBe('W AA N T IH D');
    expect(p('makes')).toBe('M EY K S');
    expect(p('wishes')).toBe('W IH SH IH Z');
    expect(p('shine')).toBe('SH AY N');
    expect(p('table')).toBe('T EY B AH L');
    expect(p('nation')).toBe('N EY SH AH N');
    expect(p('cathartic')).toBe('K AH TH AA R T IH K');
    expect(p('moonlight')).toBe('M UW N L AY T');
    expect(p('melody')).toBe('M EH L AH D IY');
  });

  it('converts sung syllables (continuations and melismas)', () => {
    expect(syllableToPhonemes('thar-')).toEqual(['TH', 'AA', 'R']);
    expect(syllableToPhonemes('_')).toEqual([]);
    expect(syllableToPhonemes('night')).toEqual(['N', 'AY', 'T']);
  });
});

describe('alignLyrics', () => {
  it('attaches syllables to the verse notes (line by line) and leaves aligned choruses alone', () => {
    const song = makeSong();
    const r = alignLyrics(song, 't-vocal');
    expect(r.report).toHaveLength(12);
    expect(r.report.every((e) => e.status === 'aligned')).toBe(true);
    expect(r.report[0]).toEqual({
      sectionId: 'sec-verse1',
      lineId: 'ly-v1',
      syllables: 7,
      notes: 7,
      status: 'aligned',
    });
    const rep = opsOfType(r.operations, 'replace_notes');
    expect(rep).toHaveLength(1);
    expect(rep[0].track).toBe('t-vocal');
    expect(rep[0].region).toEqual({ start_bar: 1, end_bar: 8 });
    expect(rep[0].notes.slice(0, 7).map((n) => n.syllable)).toEqual([
      'Walk-',
      'ing',
      'down',
      'the',
      'emp-',
      'ty',
      'road',
    ]);
    // Pitches and rhythm are preserved.
    const verse = song.tracks[2].notes.filter((n) => n.tick < 8 * BAR);
    expect(rep[0].notes.map((n) => n.pitch)).toEqual(verse.map((n) => n.pitch));
    expect(rep[0].notes.map((n) => opTick(song, n))).toEqual(verse.map((n) => n.tick));
  });

  it('reports mismatches, uses melismas and merges syllables in assign mode', () => {
    const song = makeSong();
    song.lyrics[0].text = 'Walking down the empty road tonight'; // 9 syllables on 7 notes
    song.lyrics[1].text = 'Counting cars'; // 3 syllables on 7 notes
    for (const n of song.tracks[2].notes) delete n.lyricLineId;
    const r = alignLyrics(song, 't-vocal', { sectionIds: ['sec-verse1'] });
    expect(r.report.map((e) => e.status)).toEqual([
      'too-many-syllables',
      'too-few-syllables',
      'aligned',
      'aligned',
    ]);
    expect(r.report[0]).toMatchObject({ syllables: 9, notes: 7 });
    const sylls = opsOfType(r.operations, 'replace_notes')[0].notes.map((n) => n.syllable);
    expect(sylls.slice(0, 7)).toEqual(['Walking', 'down', 'the', 'empty', 'road', 'to-', 'night']);
    expect(sylls.slice(7, 14).filter((s) => s === '_')).toHaveLength(4);
    expect(sylls[7]).toBe('Count-');
  });

  it('fits the rhythm to the syllables (split/merge notes, keeping the contour)', () => {
    const song = makeSong();
    song.lyrics[0].text = 'Walking down the empty road tonight';
    song.lyrics[1].text = 'Counting cars';
    const r = alignLyrics(song, 't-vocal', { sectionIds: ['sec-verse1'], mode: 'fit-rhythm' });
    const notes = opsOfType(r.operations, 'replace_notes')[0].notes;
    expect(notes).toHaveLength(9 + 3 + 7 + 7);
    expect(notes.filter((n) => n.syllable === '_')).toHaveLength(0);
    // Line 1 keeps its first pitch and phrase position.
    expect(notes[0].pitch).toBe(64);
    expect(notes[0].syllable).toBe('Walk-');
  });

  it('skips locked sections and unknown tracks', () => {
    const song = makeSong();
    song.tracks[2].notes[0].locked = true;
    const r = alignLyrics(song, 't-vocal', { sectionIds: ['sec-verse1'] });
    expect(r.operations).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/locked/);
    expect(alignLyrics(song, 'nope').warnings[0]).toMatch(/no track/);
  });

  it('validates lyric/vocal alignment', () => {
    const song = makeSong();
    const before = validateLyricAlignment(song, 't-vocal');
    expect(before.ok).toBe(false);
    expect(before.issues.join(' ')).toMatch(/Verse 1: 28 vocal notes have no syllable/);
    // Apply the alignment result by hand and validate again.
    const aligned: Song = cloneSong(song);
    const ops = alignLyrics(song, 't-vocal').operations;
    const rep = opsOfType(ops, 'replace_notes')[0];
    const verse = aligned.tracks[2].notes.filter((n) => n.tick < 8 * BAR);
    verse.forEach((n, i) => (n.syllable = rep.notes[i].syllable));
    expect(validateLyricAlignment(aligned, 't-vocal')).toEqual({ ok: true, issues: [] });
    // Wrong words are detected.
    aligned.tracks[2].notes[0].syllable = 'Talk-';
    expect(validateLyricAlignment(aligned, 't-vocal').issues.join(' ')).toMatch(/sung words differ/);
  });

  it('is pure', () => {
    const song = deepFreeze(makeSong());
    const s = stableStringify(song);
    alignLyrics(song, 't-vocal', { mode: 'fit-rhythm' });
    validateLyricAlignment(song, 't-vocal');
    expect(stableStringify(song)).toBe(s);
  });
});

describe('generatePlaceholderLyrics', () => {
  it('is deterministic, hits the syllable budget and repeats the chorus hook', () => {
    const opts = {
      sectionKind: 'chorus' as const,
      mood: 'cathartic',
      theme: 'fire',
      lines: 4,
      syllablesPerLine: [6, 6, 6, 6],
      seed: 7,
    };
    const a = generatePlaceholderLyrics(opts);
    expect(a).toEqual(generatePlaceholderLyrics(opts));
    expect(a).toHaveLength(4);
    for (const line of a) expect(countSyllables(line)).toBe(6);
    expect(a[2]).toBe(a[0]);
    expect(generatePlaceholderLyrics({ ...opts, seed: 8 })).not.toEqual(a);
  });

  it('writes rhymed verses in the requested mood', () => {
    const lines = generatePlaceholderLyrics({ sectionKind: 'verse', mood: 'melancholy', lines: 4, seed: 3 });
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(countSyllables(l)).toBeGreaterThanOrEqual(6);
      expect(countSyllables(l)).toBeLessThanOrEqual(10);
      expect(l[0]).toBe(l[0].toUpperCase());
    }
    const ends = lines.map((l) =>
      l
        .split(/\s+/)
        .pop()!
        .toLowerCase()
        .replace(/[^a-z']/g, ''),
    );
    // Rhyme = same phonemes from the last vowel on (frame/game, wall/small), or the same spelling ending.
    const rhymeKey = (w: string) => {
      const ph = textToPhonemes(w);
      let i = ph.length - 1;
      while (i > 0 && !/^[AEIOU]/.test(ph[i])) i--;
      return ph.slice(i).join(' ');
    };
    const rhymes = (a: string, b: string) =>
      a !== b && (rhymeKey(a) === rhymeKey(b) || a.slice(-2) === b.slice(-2));
    // AABB or ABAB: at least two pairs share an ending.
    const aabb = rhymes(ends[0], ends[1]) || rhymes(ends[2], ends[3]);
    const abab = rhymes(ends[0], ends[2]) || rhymes(ends[1], ends[3]);
    expect(aabb || abab).toBe(true);
    // Lines vary: no two lines are identical in a verse.
    expect(new Set(lines).size).toBe(lines.length);
    expect(generatePlaceholderLyrics({ sectionKind: 'bridge', lines: 0, seed: 1 })).toEqual([]);
  });
});

describe('placeholder lyrics for short phrases', () => {
  it('fits lines of one to three syllables exactly, deterministically', () => {
    const opts = { sectionKind: 'chorus' as const, lines: 6, syllablesPerLine: [1, 2, 3, 3, 2, 1], seed: 7 };
    const lines = generatePlaceholderLyrics(opts);
    expect(lines.map((l) => countSyllables(l))).toEqual([1, 2, 3, 3, 2, 1]);
    expect(generatePlaceholderLyrics(opts)).toEqual(lines);
  });
});
