import { describe, expect, it } from 'vitest';
import { applyTheoryControl, explainSection, explainSong, suggestChordSubstitutions } from '../src/musician';
import { parseChordSymbol } from '../src/theory/chords';
import { LockKeys } from '../src/locks';
import { stableStringify } from '../src/ir/song-utils';
import { composeSong, parsePromptToBlueprint } from '../src/composer';
import { deepFreeze, makeSong, opsOfType } from './musician-fixtures';

describe('explainSection (Theory View §43)', () => {
  const song = makeSong();

  it('explains a I–V–vi–IV chorus in G major', () => {
    const ex = explainSection(song, 'sec-chorus1');
    expect(ex.romanSummary).toBe('I – V – vi – IV in G major.');
    expect(ex.chordSummary).toBe('G – D – Em – C');
    expect(ex.key).toEqual({ tonic: 7, mode: 'major' });
    expect(ex.keyName).toBe('G major');
    expect(ex.chords.map((c) => c.roman)).toEqual(['I', 'V', 'vi', 'IV']);
    expect(ex.chords.map((c) => c.function)).toEqual(['tonic', 'dominant', 'tonic', 'predominant']);
    expect(ex.chords.map((c) => c.bar)).toEqual([13, 15, 17, 19]);
    expect(ex.tensionCurve).toHaveLength(4);
    for (const t of ex.tensionCurve) expect(t).toBeGreaterThanOrEqual(0);
    expect(ex.narrative.join(' ')).toMatch(/axis/);
    // The spec's example sentence, computed from the actual verse/chorus emphasis.
    expect(ex.narrative).toContain(
      'The verse emphasizes E minor while the chorus places more weight on G major, producing a perceptual emotional lift without requiring a full modulation.',
    );
    expect(ex.cadences.map((c) => c.type)).toContain('authentic');
    expect(ex.cadences.find((c) => c.type === 'authentic')!.bar).toBe(13);
  });

  it('describes the melody and rhythm of the section', () => {
    const ex = explainSection(song, 'sec-chorus1');
    expect(ex.melody).toBeDefined();
    expect(ex.melody!.trackId).toBe('t-vocal');
    expect(ex.melody!.lowest).toBe('G4');
    expect(ex.melody!.highest).toBe('E5');
    expect(ex.melody!.chordToneRatio).toBeGreaterThan(0);
    expect(ex.melody!.chordToneRatio).toBeLessThanOrEqual(1);
    expect(ex.melody!.stepwiseRatio).toBeGreaterThan(0.5);
    expect(ex.rhythm).toBeDefined();
    expect(ex.rhythm!.density).toBeGreaterThan(0);
    expect(ex.comparisons.some((c) => /Energy 90 vs 45 in Verse 1/.test(c))).toBe(true);
    expect(ex.comparisons.some((c) => /higher than in Verse 1/.test(c))).toBe(true);
  });

  it('detects borrowed chords, secondary dominants and cadences in the bridge', () => {
    const ex = explainSection(song, 'sec-bridge');
    const cm = ex.chords.find((c) => c.symbol === 'Cm')!;
    expect(cm.roman).toBe('iv');
    expect(cm.borrowedFrom).toBe('minor');
    const a7 = ex.chords.find((c) => c.symbol === 'A7')!;
    expect(a7.roman).toBe('V7/V');
    expect(a7.secondary).toBe(true);
    expect(a7.borrowedFrom).toBeUndefined();
    expect(ex.borrowed[0]).toMatch(/^Cm \(iv\) — borrowed from G minor/);
    expect(ex.secondaryDominants[0]).toMatch(/^A7 \(V7\/V\) — secondary dominant that tonicizes D/);
    const types = ex.cadences.map((c) => c.type);
    expect(types).toContain('minor-plagal');
    expect(types).toContain('half');
  });

  it('analyses each section in the key it centres on (relative minor/major)', () => {
    const verse = explainSection(song, 'sec-verse1');
    expect(verse.romanSummary).toBe('i – VI – III – VII in E minor.');
    expect(verse.narrative.join(' ')).toMatch(/relative minor/);
    const emSong = makeSong();
    emSong.keyMap = [{ bar: 0, key: { tonic: 4, mode: 'minor' } }];
    const chorus = explainSection(emSong, 'sec-chorus1');
    expect(chorus.romanSummary).toBe('I – V – vi – IV in G major.');
    expect(chorus.narrative.join(' ')).toMatch(/relative major, G major/);
    const pre = explainSection(song, 'Pre-Chorus');
    expect(pre.romanSummary).toBe('IV – V – vi – V in G major.');
    expect(pre.cadences.map((c) => c.type)).toEqual(['deceptive', 'half']);
  });

  it('explains the whole song', () => {
    const ex = explainSong(song);
    expect(ex.sections).toHaveLength(5);
    expect(ex.overview[0]).toMatch(/G major, 120 BPM in 4\/4, 36 bars/);
    expect(ex.overview.join(' ')).toMatch(/borrowed chords and secondary dominants in Bridge\./);
    expect(ex.overview.join(' ')).toMatch(/Chorus 2 repeats Chorus 1/);
  });

  it('states each fact once per section (narrative and comparisons together)', () => {
    const songs = [
      song,
      ...[
        'epic pop with a huge chorus',
        'sad folk waltz in 6/8',
        'dark trance 140 bpm',
        'jazz in D dorian',
      ].map((p, i) => composeSong(parsePromptToBlueprint(p, { seed: i + 1 }))),
    ];
    const sentences = (text: string) =>
      text
        .split(/(?<=[.!?])\s+/)
        .map((t) => t.trim())
        .filter(Boolean);
    for (const s of songs) {
      for (const sec of s.sections) {
        const ex = explainSection(s, sec.id);
        const all = [...ex.narrative, ...ex.comparisons].flatMap(sentences);
        const repeated = all.filter((t, i) => all.indexOf(t) !== i);
        expect(repeated, `${s.title} / ${sec.name}`).toEqual([]);
        // The energy step to each neighbouring section is reported in exactly one place.
        for (const other of s.sections.filter((o) => o.id !== sec.id)) {
          const names = new RegExp(` ${other.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
          expect(
            all.filter((t) => /^Energy \d/.test(t) && names.test(t)).length,
            `${sec.name} vs ${other.name}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
    const chorus = explainSection(song, 'sec-chorus1');
    const lift =
      'The verse emphasizes E minor while the chorus places more weight on G major, producing a perceptual emotional lift without requiring a full modulation.';
    expect(chorus.narrative.filter((t) => t === lift)).toHaveLength(1);
    expect(chorus.comparisons).not.toContain(lift);
    expect(
      chorus.comparisons.filter((t) => t.startsWith('Energy 90') && t.includes('Pre-Chorus')),
    ).toHaveLength(1);
    expect(explainSection(song, 'sec-bridge').comparisons.some((t) => t.startsWith('Energy 70→95 vs'))).toBe(
      true,
    );
  });

  it('is pure and throws on unknown sections', () => {
    const frozen = deepFreeze(makeSong());
    expect(() => explainSong(frozen)).not.toThrow();
    expect(() => explainSection(frozen, 'nope')).toThrow();
  });
});

describe('applyTheoryControl (§43 controls)', () => {
  const song = makeSong();

  it('"Make darker" borrows from the parallel minor and fits the melody/accompaniment', () => {
    const r = applyTheoryControl(song, 'sec-chorus1', 'darker', { seed: 1 });
    expect(r.understood).toBe(true);
    const sc = opsOfType(r.operations, 'set_chords');
    expect(sc).toHaveLength(1);
    expect(sc[0].chords.map((c) => c.symbol)).toEqual(['Gm', 'Dm', 'Eb', 'Cm']);
    const vocal = opsOfType(r.operations, 'transform_notes').filter((o) => o.track === 't-vocal');
    expect(vocal.length).toBeGreaterThan(0);
    expect(r.explanation).toMatch(/Modal interchange/);
    expect(r.explanation).toMatch(/Adjusted/);
  });

  it('"Increase tension" adds sevenths, secondary dominants and a closing suspension', () => {
    const r = applyTheoryControl(song, 'sec-bridge', 'more-tension', { seed: 1 });
    const symbols = opsOfType(r.operations, 'set_chords').flatMap((o) => o.chords.map((c) => c.symbol));
    expect(symbols).toContain('D7sus4');
    expect(symbols.some((s) => /maj7|m7|7b9|9/.test(s))).toBe(true);
    // A7 stays a dominant (V7/V) — tension never turns a secondary dominant into maj7.
    expect(symbols.find((s) => s.startsWith('A'))).toMatch(/^A(7|9|7b9)$/);
    expect(r.explanation).toMatch(/7sus4/);
  });

  it('"Reduce tension" and "Simplify" return to diatonic triads', () => {
    for (const control of ['less-tension', 'simplify'] as const) {
      const r = applyTheoryControl(song, 'sec-bridge', control, { seed: 1 });
      const symbols = opsOfType(r.operations, 'set_chords').flatMap((o) => o.chords.map((c) => c.symbol));
      expect(symbols).toContain('Am');
      expect(symbols).not.toContain('Cm');
      expect(symbols).not.toContain('A7');
    }
    const none = applyTheoryControl(song, 'sec-chorus1', 'simplify', { seed: 1 });
    expect(none.operations).toHaveLength(0);
    expect(none.explanation).toMatch(/already/);
  });

  it('"Make less conventional" and "Try modal harmony" are seeded and explained', () => {
    const a = applyTheoryControl(song, 'sec-chorus1', 'less-conventional', { seed: 4 });
    const b = applyTheoryControl(song, 'sec-chorus1', 'less-conventional', { seed: 4 });
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(opsOfType(a.operations, 'set_chords').length).toBe(1);
    expect(a.explanation).toMatch(/tritone|mediant|Neapolitan|interchange|inversion|bVI|Dorian|secondary/);
    const m = applyTheoryControl(song, 'sec-chorus1', 'modal', { seed: 2 });
    expect(m.explanation).toMatch(/Mixolydian|Lydian/);
    for (const c of opsOfType(m.operations, 'set_chords').flatMap((o) => o.chords))
      expect(parseChordSymbol(c.symbol)).not.toBeNull();
  });

  it('"Make brighter" raises minor thirds in a major key', () => {
    const r = applyTheoryControl(song, 'sec-chorus1', 'brighter', { seed: 1 });
    const sc = opsOfType(r.operations, 'set_chords')[0];
    // Only the changed chord's bars are restated: Em (vi) → E (V/ii).
    expect(sc.region).toEqual({ start_bar: 17, end_bar: 18 });
    expect(sc.chords.map((c) => c.symbol)).toEqual(['E']);
    expect(r.explanation).toMatch(/Em → E \(vi → V\/ii\)/);
  });

  it('"Make darker" keeps a dominant that resolves down a fifth (the cadence still lands)', () => {
    // Bridge: C – Cm – G – A7 – D, and D (V) resolves to Chorus 2's G.
    const r = applyTheoryControl(song, 'sec-bridge', 'darker', { seed: 1 });
    const symbols = opsOfType(r.operations, 'set_chords').flatMap((o) => o.chords.map((c) => c.symbol));
    expect(symbols).toContain('Gm');
    expect(symbols).not.toContain('Dm');
    expect(r.explanation).toMatch(/D \(V\) keeps its major third because it resolves down a fifth to G/);
  });

  it('"Make brighter" in a minor-centred section borrows from the parallel major without moving roots', () => {
    // Verse 1 centres on E minor (i – VI – III – VII): only the tonic gets a major third.
    const r = applyTheoryControl(song, 'sec-verse1', 'brighter', { seed: 1 });
    const sc = opsOfType(r.operations, 'set_chords');
    expect(sc).toHaveLength(1);
    expect(sc[0].region).toEqual({ start_bar: 1, end_bar: 2 });
    expect(sc[0].chords.map((c) => c.symbol)).toEqual(['E']);
    expect(r.explanation).toMatch(/Em → E \(i → I\)/);
    expect(r.explanation).toMatch(/Picardy/);
    // The melody's G (minor third) over the new E major chord moves to G#.
    const vocal = opsOfType(r.operations, 'transform_notes').filter((o) => o.track === 't-vocal');
    expect(vocal.some((o) => o.transform.transpose === 1)).toBe(true);
  });

  it('respects chord locks', () => {
    const locked = makeSong();
    locked.locks[LockKeys.sectionChords('sec-chorus1')] = true;
    const r = applyTheoryControl(locked, 'sec-chorus1', 'darker', { seed: 1 });
    expect(r.operations).toHaveLength(0);
    expect(r.explanation).toMatch(/locked/);
  });

  it('does not touch locked notes when fitting parts', () => {
    const s = makeSong();
    s.locks[LockKeys.track('t-violin')] = true;
    const r = applyTheoryControl(s, 'sec-chorus1', 'darker', { seed: 1 });
    expect(r.operations.some((o) => 'track' in o && o.track === 't-violin')).toBe(false);
    expect(r.explanation).toMatch(/Locked material was skipped: Violin/);
  });
});

describe('suggestChordSubstitutions', () => {
  const song = makeSong();

  it('offers relatives, borrowed chords, secondary dominants, tritone subs, suspensions and inversions', () => {
    const subs = suggestChordSubstitutions(song, 'c10'); // D (V) in Chorus 1, followed by Em
    const by = (sym: string) => subs.find((s) => s.symbol === sym);
    expect(by('Bm')?.roman).toBe('iii');
    expect(by('F')?.roman).toBe('bVII');
    expect(by('F')?.reason).toMatch(/Borrowed/);
    expect(by('B7')?.roman).toBe('V7/vi');
    expect(by('Ab7')?.reason).toMatch(/Tritone substitution/);
    expect(by('Dsus4')).toBeDefined();
    expect(by('D/F#')?.reason).toMatch(/inversion/);
    for (const s of subs) expect(s.reason.length).toBeGreaterThan(10);
    expect(new Set(subs.map((s) => s.symbol)).size).toBe(subs.length);
    expect(subs.map((s) => s.symbol)).not.toContain('D');
  });

  it('returns nothing for an unknown chord id', () => {
    expect(suggestChordSubstitutions(song, 'nope')).toEqual([]);
  });
});
