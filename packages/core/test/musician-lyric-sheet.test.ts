import { describe, expect, it } from 'vitest';
import { isChordLine, lyricStress, parseLyricSheet, parseSectionHeader, stanzaSimilarity, suggestMoodsFromLyrics, wordStress } from '../src/musician';
import {
  blueprintFromChoices,
  composeSong,
  creditLyricWriter,
  getTag,
  lyricSectionBars,
  matchLyricsToSections,
  placeBlueprintLyrics,
  structureFromLyrics,
  syllablesPerBar,
} from '../src/composer';
import { alignStressToMeter } from '../src/composer/motifs';
import { lineStresses } from '../src/composer/syllables';
import { meterInfo, metricWeight } from '../src/composer/util';
import { createProject } from '../src/ir/defaults';
import { LockKeys, isLyricsSectionLocked } from '../src/locks';
import { sectionLayout } from '../src/timing';
import type { BlueprintLyrics, MotifNote } from '../src/ir/types';
import { validityProblems } from './composer-helpers';

const kinds = (l: BlueprintLyrics) => l.sections.map((s) => s.kind);
const names = (l: BlueprintLyrics) => l.sections.map((s) => s.name);

const LABELLED = `[Verse 1]
Under the streetlights I wait for the rain
Counting the cars as they carry my name

[Pre-Chorus]
And the night is closing in

[Chorus]
Hold on, hold on to me
We were never meant to be free

[Verse 2: Guest Artist]
Nobody answers the call
Shadows are taller than all

[Chorus]

[Bridge]
And if the morning never comes
I'll keep on singing to the sun

[Chorus x2]
`;

describe('parseSectionHeader', () => {
  it.each([
    ['[Verse 1]', 'verse', 'Verse 1', 1],
    ['[Chorus]', 'chorus', 'Chorus', 1],
    ['[Pre-Chorus]', 'pre-chorus', 'Pre-Chorus', 1],
    ['[Pre Chorus]', 'pre-chorus', 'Pre-Chorus', 1],
    ['[Post-Chorus]', 'post-chorus', 'Post-Chorus', 1],
    ['[Bridge]', 'bridge', 'Bridge', 1],
    ['[Hook]', 'chorus', 'Hook', 1],
    ['[Intro]', 'intro', 'Intro', 1],
    ['[Outro]', 'outro', 'Outro', 1],
    ['[Verse 1: Kendrick Lamar]', 'verse', 'Verse 1', 1],
    ['[Chorus: Both]', 'chorus', 'Chorus', 1],
    ['Verse:', 'verse', 'Verse', 1],
    ['Verse 2:', 'verse', 'Verse 2', 1],
    ['(Chorus)', 'chorus', 'Chorus', 1],
    ['(Chorus x2)', 'chorus', 'Chorus', 2],
    ['CHORUS', 'chorus', 'Chorus', 1],
    ['VERSE 2', 'verse', 'Verse 2', 1],
    ['Chorus x2', 'chorus', 'Chorus', 2],
    ['Chorus 2x', 'chorus', 'Chorus', 2],
    ['[Chorus] x3', 'chorus', 'Chorus', 3],
    ['Repeat Chorus', 'chorus', 'Chorus', 1],
    ['[Middle 8]', 'bridge', 'Middle 8', 1],
    ['[Refrain]', 'chorus', 'Refrain', 1],
    ['[Guitar Solo]', 'solo', 'Guitar Solo', 1],
    ['[Instrumental]', 'interlude', 'Instrumental', 1],
  ])('%s', (line, kind, name, repeat) => {
    const h = parseSectionHeader(line);
    expect(h).not.toBeNull();
    expect(h!.kind).toBe(kind);
    expect(h!.name).toBe(name);
    expect(h!.repeat).toBe(repeat);
  });

  it('does not take lyric lines for headers', () => {
    for (const line of ['Chorus of angels singing', 'Hook me up tonight', 'Bridge over troubled water', 'Love: it is all we need', 'I verse the world']) {
      expect(parseSectionHeader(line), line).toBeNull();
    }
  });

  it('keeps the text after an unbracketed "Chorus:" header', () => {
    expect(parseSectionHeader('Chorus: Hold on to me')).toMatchObject({ kind: 'chorus', rest: 'Hold on to me' });
  });
});

describe('isChordLine', () => {
  it('recognises chord-only lines', () => {
    for (const line of ['Am  F  C  G', 'G/B C D', '| Em | C | G | D |', 'Cmaj7 Fmaj7', 'F#m7b5 B7 Em', 'D7sus4 D', 'N.C.', 'Bbadd9 Eb x2']) {
      expect(isChordLine(line), line).toBe(true);
    }
  });
  it('keeps lyric lines', () => {
    for (const line of ['Be a man', 'A', 'Am I dreaming', 'Go Ed go', 'Dance all night']) expect(isChordLine(line), line).toBe(false);
  });
});

describe('parseLyricSheet: labelled sheets', () => {
  it('reads headers, expands references and repeat counts', () => {
    const l = parseLyricSheet(LABELLED);
    expect(l.text).toBe(LABELLED);
    expect(kinds(l)).toEqual(['verse', 'pre-chorus', 'chorus', 'verse', 'chorus', 'bridge', 'chorus']);
    expect(names(l)).toEqual(['Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Chorus']);
    // "[Chorus]" without lines repeats the chorus; "[Chorus x2]" sings it twice.
    expect(l.sections[4].lines).toEqual(l.sections[2].lines);
    expect(l.sections[6].lines).toEqual([...l.sections[2].lines, ...l.sections[2].lines]);
    expect(l.lock).toBeUndefined();
  });

  it('accepts Verse:, (Chorus), CHORUS and Repeat chorus forms', () => {
    const l = parseLyricSheet(`Verse:
I walked the line
I paid the price

CHORUS
Sing it loud tonight
Hold the light

Verse 2:
Another day goes by
Another reason why

(Chorus)

Repeat chorus`);
    expect(kinds(l)).toEqual(['verse', 'chorus', 'verse', 'chorus', 'chorus']);
    expect(l.sections[3].lines).toEqual(['Sing it loud tonight', 'Hold the light']);
  });

  it('strips chord lines, inline chords and stage directions, never changing the words', () => {
    const l = parseLyricSheet(`Capo 2
[Verse 1]
G        D        Em
I walked a lonely road
C              G
(spoken)
[Am]Every [F]step was mine
*laughs*
(ooh, ooh)

[Guitar Solo]

[Chorus]
Am F C G
Carry me home`);
    expect(l.sections[0].lines).toEqual(['I walked a lonely road', 'Every step was mine', '(ooh, ooh)']);
    expect(l.sections[1]).toEqual({ name: 'Guitar Solo', kind: 'solo', lines: [] });
    expect(l.sections[2]).toMatchObject({ kind: 'chorus', lines: ['Carry me home'] });
  });

  it('continues a labelled section across a blank line', () => {
    const l = parseLyricSheet(`[Verse 1]
Line one here
Line two here

Line three here
Line four here

[Chorus]
Shine on`);
    expect(kinds(l)).toEqual(['verse', 'chorus']);
    expect(l.sections[0].lines).toHaveLength(4);
  });

  it('drops lyric-site footers and credits', () => {
    const l = parseLyricSheet(`[Verse 1]
First line of the song
Written by Somebody
You might also like
[Chorus]
Sing along with me
12Embed`);
    expect(l.sections.map((s) => s.lines)).toEqual([['First line of the song'], ['Sing along with me']]);
  });
});

describe('parseLyricSheet: unlabelled songs', () => {
  const CHORUS = 'Hold on, hold on to me\nWe were never meant to be free\nHold on, hold on to me\nThis is where we want to be';
  it('finds the repeated chorus, the verses before it and a late bridge', () => {
    const text = [
      'Under the streetlights I wait for the rain\nCounting the cars as they carry my name\nNobody answers the call\nShadows are taller than all',
      CHORUS,
      'Morning comes and I am still awake\nEvery promise that we used to make\nWritten on the walls of this old town\nNo one ever turns the music down',
      CHORUS,
      'And if the sun never rises\nI will keep on singing',
      CHORUS,
    ].join('\n\n');
    const l = parseLyricSheet(text);
    expect(kinds(l)).toEqual(['verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus']);
    expect(names(l)).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Chorus']);
  });

  it('matches near-duplicate choruses (small word changes)', () => {
    const text = [
      'Walking down the river\nCold wind in my hair\nNo one there to follow\nNo one left to care',
      CHORUS,
      'Running through the city\nLights in every street\nStrangers at the station\nNo one I could meet',
      CHORUS.replace('This is where we want to be', 'This is where we ought to be'),
    ].join('\n\n');
    expect(kinds(parseLyricSheet(text))).toEqual(['verse', 'chorus', 'verse', 'chorus']);
  });

  it('finds a pre-chorus that always leads into the chorus', () => {
    const PRE = 'And I feel it rising\nCalling out my name';
    const text = ['Verse words one\nVerse words two', PRE, CHORUS, 'Second verse one\nSecond verse two', PRE, CHORUS].join('\n\n');
    expect(kinds(parseLyricSheet(text))).toEqual(['verse', 'pre-chorus', 'chorus', 'verse', 'pre-chorus', 'chorus']);
  });

  it('keeps verses that end on a shared refrain line as verses', () => {
    const text = [
      'Come gather round people\nWherever you roam\nAnd admit that the waters\nThe times they are changing',
      'Come writers and critics\nWho prophesize with your pen\nAnd keep your eyes wide\nThe times they are changing',
      'Come senators congressmen\nPlease heed the call\nDon’t stand in the doorway\nThe times they are changing',
    ].join('\n\n');
    expect(kinds(parseLyricSheet(text))).toEqual(['verse', 'verse', 'verse']);
  });

  it('a song without repeats is all verses; empty text is no sections', () => {
    expect(kinds(parseLyricSheet('One line\nTwo line\n\nThree line\nFour line'))).toEqual(['verse', 'verse']);
    expect(parseLyricSheet('').sections).toEqual([]);
    expect(parseLyricSheet('\n\n  \n').sections).toEqual([]);
  });

  it('stanza similarity is symmetric and bounded', () => {
    expect(stanzaSimilarity(['a b c', 'd e f'], ['a b c', 'd e f'])).toBe(1);
    expect(stanzaSimilarity(['a b c'], ['x y z'])).toBe(0);
    expect(stanzaSimilarity(['a b c', 'd e f'], ['d e f', 'q r s'])).toBe(stanzaSimilarity(['d e f', 'q r s'], ['a b c', 'd e f']));
  });
});

describe('structure from lyrics', () => {
  it('sizes sections by lines and syllables at the tempo, adds an intro/outro and a final chorus', () => {
    const l = parseLyricSheet(LABELLED);
    const s = structureFromLyrics(l, { tempo: 120 });
    expect(s.map((x) => x.kind)).toEqual(['intro', 'verse', 'pre-chorus', 'chorus', 'verse', 'chorus', 'bridge', 'final-chorus', 'outro']);
    expect(s.map((x) => x.name)).toEqual(['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Final Chorus', 'Outro']);
    // Long lines take two bars, short ones one; every section is even and at least 2 bars.
    expect(s[1].bars).toBe(4);
    expect(s[7].bars).toBe(2 * s[3].bars);
    for (const x of s) expect(x.bars % 2 === 0 && x.bars >= 2).toBe(true);
    const noFrame = structureFromLyrics(l, { tempo: 120, intro: false, outro: false });
    expect(noFrame[0].kind).toBe('verse');
    expect(noFrame[noFrame.length - 1].kind).toBe('final-chorus');
  });

  it('gives a line more room at fast tempi', () => {
    const line = ['Counting the cars as they carry my name'];
    expect(lyricSectionBars(line, 70)).toBeLessThanOrEqual(lyricSectionBars(line, 180));
    expect(lyricSectionBars(['Oh no'], 120)).toBe(2);
    expect(syllablesPerBar(60)).toBeGreaterThan(syllablesPerBar(160));
    expect(lyricSectionBars(Array(6).fill('Under the streetlights I wait for the rain'), 120)).toBe(12);
  });

  it('keeps a sung intro and instrumental sections from the sheet', () => {
    const l = parseLyricSheet('[Intro]\nOoh ooh\n\n[Verse]\nHello there my friend\n\n[Guitar Solo]\n\n[Outro]\nGoodbye');
    const s = structureFromLyrics(l, { tempo: 100 });
    expect(s.map((x) => x.kind)).toEqual(['intro', 'verse', 'solo', 'outro']);
    expect(s[2].bars).toBe(8);
  });

  it('matches stanzas to sections in order, even when the structure was edited', () => {
    const l = parseLyricSheet(LABELLED);
    const s = structureFromLyrics(l, { tempo: 120 });
    expect(matchLyricsToSections(l.sections, s)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const edited = s.filter((x) => x.kind !== 'bridge' && x.kind !== 'pre-chorus');
    const m = matchLyricsToSections(l.sections, edited);
    expect(m[0]).toBe(1);
    expect(m[2]).toBe(2);
    expect(m.filter((x) => x === -1).length).toBeGreaterThan(0);
  });
});

describe('stress', () => {
  it('stresses the primary syllable and leaves function words unstressed', () => {
    expect(wordStress('remember')).toEqual([0, 1, 0]);
    expect(wordStress('beautiful')).toEqual([1, 0, 0]);
    expect(wordStress('tonight')).toEqual([0, 1]);
    expect(wordStress('into')).toEqual([1, 0]);
    expect(wordStress('the')).toEqual([0]);
    expect(wordStress('and')).toEqual([0]);
    expect(wordStress('rain')).toEqual([1]);
    const s = lyricStress('I remember the rain');
    expect(s.map((x) => x.stress)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(s.map((x) => x.syllable).join('|')).toBe('I|re|mem|ber|the|rain');
  });

  it('maps stress onto the vocal generator syllables', () => {
    const text = 'Under the streetlights I wait for the rain';
    const st = lineStresses(text);
    expect(st[0]).toBe(1); // UN-der
    expect(st.length).toBeGreaterThan(8);
    expect(st[st.length - 1]).toBe(1); // rain
    expect(st[2]).toBe(0); // the
  });

  it('re-times a phrase so stressed syllables land on strong beats', () => {
    const meter = meterInfo({ numerator: 4, denominator: 4 });
    const grid = 240;
    // Stressed syllables on the off-beats, unstressed ones on the beats ("a-RISE a-GAIN" sung late).
    const notes: MotifNote[] = [240, 480, 720, 960].map((offset, i) => ({ offset, duration: 220, degree: i, velocity: 90 }));
    const stress = [1, 0, 1, 0];
    const out = alignStressToMeter(notes, stress, { grid, barOffset: 0, meter, lengthTicks: 1920 });
    expect(out.map((n) => n.offset)).toEqual([0, 240, 480, 720]);
    expect(out.map((n) => n.degree)).toEqual([0, 1, 2, 3]);
    for (let i = 0; i < out.length - 1; i++) expect(out[i].offset + out[i].duration).toBeLessThanOrEqual(out[i + 1].offset);
    // The phrase still ends where it did.
    expect(out[3].offset + out[3].duration).toBe(960 + 220);
    const w = (n: MotifNote) => metricWeight(n.offset, meter);
    expect(w(out[0])).toBe(1);
    expect(w(out[2])).toBeGreaterThanOrEqual(0.75);
    expect(out[0].velocity).toBeGreaterThan(out[1].velocity);
    // Deterministic, and a phrase that already fits is left alone.
    expect(alignStressToMeter(notes, stress, { grid, barOffset: 0, meter, lengthTicks: 1920 })).toEqual(out);
    const fitting: MotifNote[] = [0, 240, 480, 720].map((offset, i) => ({ offset, duration: 220, degree: i, velocity: 90 }));
    expect(alignStressToMeter(fitting, stress, { grid, barOffset: 0, meter, lengthTicks: 1920 })).toEqual(fitting);
    // No room: unchanged.
    expect(alignStressToMeter(notes, stress, { grid, barOffset: 0, meter, lengthTicks: 3 * grid })).toEqual(notes);
  });
});

describe('mood from lyrics (offline)', () => {
  it('reads valence and arousal and only suggests tags the catalog has', () => {
    const sad = suggestMoodsFromLyrics('Tears in the rain, alone and cold, I miss you, the night is empty and gone');
    expect(sad.valence).toBeLessThan(-0.3);
    expect(sad.tempoFeel).not.toBe('fast');
    const happy = suggestMoodsFromLyrics('We dance in the sunshine, smile and laugh, the summer is golden and free, love and joy');
    expect(happy.valence).toBeGreaterThan(0.4);
    for (const r of [sad, happy]) for (const id of r.moods) expect(getTag(id)?.kind).toBe('mood');
    const angry = suggestMoodsFromLyrics('Burn it down, fight, rage and scream, the fire and the war');
    expect(angry.arousal).toBeGreaterThan(0.7);
    expect(angry.tempoFeel).toBe('fast');
    expect(suggestMoodsFromLyrics('xyz qwerty').moods).toEqual([]);
    // Negation flips the sign.
    expect(suggestMoodsFromLyrics('not happy, never happy').valence).toBeLessThan(0);
  });
});

describe('composing from lyrics', () => {
  const lyrics = parseLyricSheet(LABELLED);
  const bp = blueprintFromChoices(
    { genres: [{ genreId: 'pop', weight: 1 }], instruments: [{ instrumentId: 'piano', count: 1 }, { instrumentId: 'drum-kit', count: 1 }, { instrumentId: 'electric-bass', count: 1 }], lyrics },
    { seed: 11 },
  );

  it('puts the lyrics into the right sections on the lead vocal, locked and sung', () => {
    const song = composeSong(bp, undefined, { seed: 11 });
    const vocal = song.tracks.find((t) => t.role === 'vocal' && t.constraints.function === 'melody')!;
    expect(vocal).toBeTruthy();
    const byName = (n: string) => song.sections.find((s) => s.name === n)!;
    const linesOf = (n: string) => song.lyrics.filter((l) => l.sectionId === byName(n).id).map((l) => l.text);
    expect(linesOf('Verse 1')).toEqual(lyrics.sections[0].lines);
    expect(linesOf('Chorus 2')).toEqual(lyrics.sections[2].lines);
    expect(linesOf('Final Chorus')).toHaveLength(4);
    expect(linesOf('Intro')).toEqual([]);
    expect(song.lyrics.every((l) => l.author === 'human' && l.trackId === vocal.id)).toBe(true);
    // Locked per sung section, not the instrumental ones.
    expect(isLyricsSectionLocked(song, byName('Verse 1').id)).toBe(true);
    expect(isLyricsSectionLocked(song, byName('Intro').id)).toBe(false);
    expect(song.locks[LockKeys.sectionLyrics(byName('Bridge').id)]).toBe(true);
    // The melody sings them: each sung section's notes carry syllables of its lines.
    const spans = sectionLayout(song);
    for (const n of ['Verse 1', 'Chorus 1', 'Bridge']) {
      const sp = spans.find((s) => s.section.id === byName(n).id)!;
      const notes = vocal.notes.filter((x) => x.tick >= sp.startTick && x.tick < sp.endTick);
      expect(notes.length, n).toBeGreaterThan(4);
      expect(notes.filter((x) => x.syllable && x.syllable !== '_').length, n).toBeGreaterThan(4);
      expect(new Set(notes.map((x) => x.lyricLineId).filter(Boolean)).size, n).toBe(song.lyrics.filter((l) => l.sectionId === sp.section.id).length);
    }
    expect(validityProblems(song)).toEqual([]);
    expect(song.vocals.mode).toBe('ai-singer');
  });

  it('is deterministic and respects lock: false', () => {
    const a = composeSong(bp, undefined, { seed: 11 });
    const b = composeSong(bp, undefined, { seed: 11 });
    expect(a.lyrics).toEqual(b.lyrics);
    expect(a.tracks.map((t) => t.notes)).toEqual(b.tracks.map((t) => t.notes));
    const unlocked = composeSong({ ...bp, lyrics: { ...bp.lyrics!, lock: false } }, undefined, { seed: 11 });
    expect(Object.keys(unlocked.locks).filter((k) => k.startsWith('lyrics:'))).toEqual([]);
    expect(unlocked.lyrics.length).toBe(a.lyrics.length);
  });

  it('credits the user as lyric writer in the rights metadata', () => {
    const song = composeSong(bp, undefined, { seed: 11 });
    let project = createProject('Lyrics first', song);
    project = creditLyricWriter(project, 'Ada');
    expect(project.meta.rights.lyricWriters).toEqual(['Ada']);
    expect(creditLyricWriter(project, 'ada').meta.rights.lyricWriters).toEqual(['Ada']);
    expect(project.meta.rights.lyricWriters.some((w) => /AI/.test(w))).toBe(false);
  });

  it('places lyrics into an existing draft and reports stanzas without a home', () => {
    const song = composeSong({ ...bp, lyrics: undefined }, undefined, { seed: 11 });
    const draft = { ...song, sections: song.sections.filter((s) => s.kind !== 'bridge'), lyrics: [] };
    const r = placeBlueprintLyrics(draft, lyrics, 3);
    expect(r.unplaced.length).toBeGreaterThan(0);
    expect(r.placed + r.unplaced.length).toBe(lyrics.sections.filter((s) => s.lines.length).length);
  });
});
