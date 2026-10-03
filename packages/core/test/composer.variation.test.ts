import { describe, expect, it } from 'vitest';
import {
  BRANCH_TEMPLATES,
  applyMacroTransforms,
  composeFromDNA,
  composeSong,
  createVariation,
  extractSongDNA,
  generateAsset,
  getInstrument,
  parsePromptToBlueprint,
} from '../src/composer';
import { cloneSong, songHash, stableStringify } from '../src/ir/song-utils';
import { LockKeys, isTrackSectionLocked } from '../src/locks';
import { sectionLayout, songDurationSeconds } from '../src/timing';
import { parseChordSymbol } from '../src/theory/chords';
import type { Note, Song, VariationLevel } from '../src/ir/types';
import { validityProblems } from './composer-helpers';

const PROMPT =
  'Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.';
const song = composeSong(parsePromptToBlueprint(PROMPT, { seed: 21 }));
const vocalOf = (s: Song) => s.tracks.find((t) => t.role === 'vocal')!;
const shape = (ns: Note[]) => ns.map((n) => [n.pitch, n.tick, n.duration]);
const accompanimentNotes = (s: Song) =>
  s.tracks
    .filter((t) => t.role !== 'vocal')
    .flatMap((t) => t.notes.map((n) => `${t.id}|${n.pitch}|${n.tick}|${n.duration}`));
const diffRatio = (a: string[], b: string[]) => {
  const sb = new Set(b);
  return a.filter((x) => !sb.has(x)).length / Math.max(1, a.length);
};

describe('createVariation (§24)', () => {
  it('ornament changes velocities/articulations/fills but keeps the melody and rhythms', () => {
    const v = createVariation(song, 'ornament', { seed: 5, amount: 0.8 });
    expect(shape(vocalOf(v).notes)).toEqual(shape(vocalOf(song).notes));
    expect(v.chords).toEqual(song.chords);
    expect(v.sections).toEqual(song.sections);
    // Non-drum parts: every original note keeps its pitch and rhythm (grace notes may be added).
    for (const t of v.tracks) {
      if (getInstrument(t.instrumentId).isDrumKit) continue;
      const orig = song.tracks.find((x) => x.id === t.id)!;
      for (const n of orig.notes) {
        const m = t.notes.find((x) => x.id === n.id)!;
        expect(m).toBeDefined();
        expect([m.pitch, m.tick, m.duration]).toEqual([n.pitch, n.tick, n.duration]);
      }
    }
    const velChanged = v.tracks
      .flatMap((t) => t.notes)
      .filter((n) => {
        const o = song.tracks.flatMap((x) => x.notes).find((x) => x.id === n.id);
        return o && o.velocity !== n.velocity;
      }).length;
    expect(velChanged).toBeGreaterThan(100);
    expect(validityProblems(v)).toEqual([]);
  });

  it('variation keeps harmony, motifs, structure and the melody; changes accompaniment', () => {
    const v = createVariation(song, 'variation', { seed: 6, amount: 1 });
    expect(v.chords).toEqual(song.chords);
    expect(v.motifs).toEqual(song.motifs);
    expect(v.sections).toEqual(song.sections);
    expect(vocalOf(v).notes).toEqual(vocalOf(song).notes);
    expect(diffRatio(accompanimentNotes(v), accompanimentNotes(song))).toBeGreaterThan(0.2);
    expect(v.generation.variation).toBe(1);
    expect(validityProblems(v)).toEqual([]);
  });

  it('amount scales how much changes', () => {
    const small = createVariation(song, 'variation', { seed: 6, amount: 0.15 });
    const big = createVariation(song, 'variation', { seed: 6, amount: 0.9 });
    const d = (s: Song) => diffRatio(accompanimentNotes(s), accompanimentNotes(song));
    expect(d(small)).toBeGreaterThan(0);
    expect(d(small)).toBeLessThan(d(big));
    expect(songHash(createVariation(song, 'mutation', { seed: 6, amount: 0 }))).toBe(songHash(song));
  });

  it('reinterpretation keeps the vocal and motifs; substantially changes the arrangement', () => {
    const v = createVariation(song, 'reinterpretation', { seed: 7, amount: 1 });
    expect(vocalOf(v).notes).toEqual(vocalOf(song).notes);
    expect(v.motifs).toEqual(song.motifs);
    expect(v.sections.map((s) => [s.kind, s.bars])).toEqual(song.sections.map((s) => [s.kind, s.bars]));
    expect(diffRatio(accompanimentNotes(v), accompanimentNotes(song))).toBeGreaterThan(0.4);
    expect(validityProblems(v)).toEqual([]);
  });

  it('mutation preserves only the Song DNA', () => {
    const v = createVariation(song, 'mutation', { seed: 8, amount: 1 });
    const a = extractSongDNA(song);
    const b = extractSongDNA(v);
    expect(b.tonalCenter).toEqual(a.tonalCenter);
    expect(b.tempo).toBe(a.tempo);
    expect(b.meter).toEqual(a.meter);
    expect(b.structure).toEqual(a.structure);
    expect(b.motifs).toEqual(a.motifs);
    expect(b.energyCurve).toEqual(a.energyCurve);
    expect(b.principalProgressions.find((p) => p.sectionKind === 'chorus')!.roman).toEqual(
      a.principalProgressions.find((p) => p.sectionKind === 'chorus')!.roman,
    );
    expect(vocalOf(v).notes).not.toEqual(vocalOf(song).notes);
    expect(validityProblems(v)).toEqual([]);
  });

  it('every level respects locks', () => {
    const locked = cloneSong(song);
    const vocal = vocalOf(locked);
    const drums = locked.tracks.find((t) => t.role === 'drums')!;
    const chorus = locked.sections.find((s) => s.kind === 'chorus')!;
    const bass = locked.tracks.find((t) => t.role === 'bass')!;
    locked.locks = {
      [LockKeys.track(vocal.id)]: true,
      [LockKeys.trackSection(bass.id, chorus.id)]: true,
      [LockKeys.section(locked.sections[0].id)]: true,
    };
    drums.notes = drums.notes.map((n, i) => (i % 5 === 0 ? { ...n, locked: true } : n));
    const spans = sectionLayout(locked);
    const snapshot = (s: Song) =>
      stableStringify({
        vocal: vocalOf(s),
        cells: s.tracks.map((t) =>
          spans
            .filter((sp) => isTrackSectionLocked(locked, t.id, sp.section.id))
            .map((sp) => t.notes.filter((n) => n.tick >= sp.startTick && n.tick < sp.endTick)),
        ),
        lockedNotes: s.tracks.flatMap((t) => t.notes.filter((n) => n.locked)),
      });
    const before = snapshot(locked);
    for (const level of ['ornament', 'variation', 'reinterpretation', 'mutation'] as VariationLevel[]) {
      for (const seed of [1, 2, 3]) {
        const v = createVariation(locked, level, { seed, amount: 1 });
        expect(snapshot(v), `${level}/${seed}`).toBe(before);
        expect(validityProblems(v), `${level}/${seed}`).toEqual([]);
      }
    }
  });
});

describe('Song DNA (§11)', () => {
  const dna = extractSongDNA(song);

  it('captures every characteristic', () => {
    expect(dna.tonalCenter).toEqual(song.keyMap[0].key);
    expect(dna.tempo).toBe(song.tempoMap[0].bpm);
    expect(dna.meter).toEqual({ numerator: 4, denominator: 4 });
    expect(dna.harmonicLanguage.mode).toBe('minor');
    const total = Object.values(dna.harmonicLanguage.chordVocabulary).reduce((t, v) => t + v, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(
      dna.harmonicLanguage.chordVocabulary.i ?? dna.harmonicLanguage.chordVocabulary.Isus2 ?? 0,
    ).toBeGreaterThanOrEqual(0);
    const verse = dna.principalProgressions.find((p) => p.sectionKind === 'verse')!;
    expect(verse.roman.length).toBeGreaterThanOrEqual(2);
    expect(verse.roman.length).toBeLessThanOrEqual(8);
    expect(dna.motifs).toEqual(song.motifs);
    const roles = dna.rhythmicIdentity.map((r) => r.role);
    expect(roles).toEqual(expect.arrayContaining(['drums', 'bass', 'vocal', 'rhythm-guitar']));
    for (const r of dna.rhythmicIdentity) {
      expect(r.onsetGrid.length).toBe(16);
      expect(Math.max(...r.onsetGrid)).toBe(1);
      expect(r.syncopation).toBeGreaterThanOrEqual(0);
      expect(r.density).toBeGreaterThan(0);
    }
    const drums = dna.rhythmicIdentity.find((r) => r.role === 'drums')!;
    expect(drums.onsetGrid[0]).toBeGreaterThan(drums.onsetGrid[1]); // downbeats dominate
    for (const c of dna.melodicContour) {
      expect(c.contour.length).toBe(16);
      expect(c.contour.every((x) => x >= 0 && x <= 1)).toBe(true);
    }
    expect(dna.melodicContour.map((c) => c.sectionKind)).toEqual(expect.arrayContaining(['verse', 'chorus']));
    expect(dna.structure.reduce((t, s) => t + s.proportion, 0)).toBeCloseTo(1, 1);
    expect(dna.energyCurve).toEqual(song.sections.map((s) => s.energy));
    expect(dna.repetition.pattern.replace(/\s/g, '').length).toBe(song.sections.length);
    expect(dna.repetition.repeatRatio).toBeGreaterThan(0.2);
    expect(dna.genreBlend).toEqual(song.genreBlend);
    expect(dna.instrumentation.length).toBe(song.tracks.length);
  });

  it('composeFromDNA grows related but different songs', () => {
    const a = composeFromDNA(dna, { seed: 101 });
    const b = composeFromDNA(dna, { seed: 102 });
    expect(songHash(a)).not.toBe(songHash(b));
    for (const s of [a, b]) {
      const d = extractSongDNA(s);
      expect(d.tonalCenter).toEqual(dna.tonalCenter);
      expect(d.tempo).toBe(dna.tempo);
      expect(d.meter).toEqual(dna.meter);
      expect(d.structure.map((x) => [x.kind, x.bars])).toEqual(dna.structure.map((x) => [x.kind, x.bars]));
      expect(d.motifs).toEqual(dna.motifs);
      expect(d.energyCurve).toEqual(dna.energyCurve);
      expect(d.principalProgressions.find((p) => p.sectionKind === 'verse')!.roman).toEqual(
        dna.principalProgressions.find((p) => p.sectionKind === 'verse')!.roman,
      );
      expect(validityProblems(s)).toEqual([]);
    }
    expect(songHash(composeFromDNA(dna, { seed: 101 }))).toBe(songHash(a));
  });

  it('composeFromDNA accepts overrides', () => {
    const s = composeFromDNA(dna, {
      seed: 5,
      title: 'Synth Cousin',
      tempo: 120,
      genreBlend: [{ genreId: 'synth-pop', weight: 1 }],
      instrumentation: [
        { name: 'Lead Vocal', instrumentId: 'lead-vocal', role: 'vocal', function: 'melody' },
        { name: 'Drum Machine', instrumentId: 'electronic-kit', role: 'drums' },
        { name: 'Synth Bass', instrumentId: 'synth-bass', role: 'bass' },
        { name: 'Synth Pad', instrumentId: 'synth-pad', role: 'synth-pad' },
      ],
    });
    expect(s.title).toBe('Synth Cousin');
    expect(s.tempoMap[0].bpm).toBe(120);
    expect(s.tracks.map((t) => t.instrumentId)).toEqual([
      'lead-vocal',
      'electronic-kit',
      'synth-bass',
      'synth-pad',
    ]);
    expect(validityProblems(s)).toEqual([]);
  });
});

describe('branch templates (§53)', () => {
  it('provides Heavy, Acoustic, Synth and Radio Edit', () => {
    expect(BRANCH_TEMPLATES.map((t) => t.id)).toEqual(['heavy', 'acoustic', 'synth', 'radio-edit']);
    for (const t of BRANCH_TEMPLATES) expect(t.name.length).toBeGreaterThan(0);
  });

  it('re-orchestrations keep the vocal melody and harmony', () => {
    const pop = composeSong(
      parsePromptToBlueprint(
        'upbeat pop song with piano, clean guitar, bass, drums and a synth pad, female vocal',
        { seed: 4 },
      ),
    );
    for (const id of ['heavy', 'acoustic', 'synth'] as const) {
      const out = BRANCH_TEMPLATES.find((t) => t.id === id)!.apply(pop, 9);
      expect(vocalOf(out).notes, id).toEqual(vocalOf(pop).notes);
      expect(out.chords, id).toEqual(pop.chords);
      expect(validityProblems(out), id).toEqual([]);
      expect(diffRatio(accompanimentNotes(out), accompanimentNotes(pop)), id).toBeGreaterThan(0.3);
      const ids = out.tracks.map((t) => t.instrumentId);
      if (id === 'heavy') expect(ids).toContain('electric-guitar-distorted');
      if (id === 'acoustic') expect(ids).toContain('acoustic-guitar');
      if (id === 'synth') {
        expect(ids).toContain('synth-bass');
        expect(ids).toContain('electronic-kit');
        expect(ids).not.toContain('electric-guitar-clean');
      }
    }
  });

  it('branch templates respect locks', () => {
    const long = composeSong(parsePromptToBlueprint('a long epic metal song at 100 bpm', { seed: 2 }));
    const locked = cloneSong(long);
    const solo = locked.sections.find((s) => s.kind === 'solo' || s.kind === 'bridge')!;
    const guitar = locked.tracks.find((t) => t.role === 'rhythm-guitar')!;
    const verse = locked.sections.find((s) => s.kind === 'verse')!;
    locked.locks = { [LockKeys.section(solo.id)]: true, [LockKeys.trackSection(guitar.id, verse.id)]: true };
    const edit = BRANCH_TEMPLATES.find((t) => t.id === 'radio-edit')!.apply(locked, 1);
    const a = sectionLayout(locked).find((x) => x.section.id === solo.id)!;
    const b = sectionLayout(edit).find((x) => x.section.id === solo.id)!;
    expect(b.section.bars).toBe(a.section.bars);
    for (const t of locked.tracks) {
      const orig = t.notes
        .filter((n) => n.tick >= a.startTick && n.tick < a.endTick)
        .map((n) => [n.id, n.pitch, n.tick - a.startTick, n.duration, n.velocity]);
      const kept = edit.tracks
        .find((x) => x.id === t.id)!
        .notes.filter((n) => n.tick >= b.startTick && n.tick < b.endTick)
        .map((n) => [n.id, n.pitch, n.tick - b.startTick, n.duration, n.velocity]);
      expect(kept).toEqual(orig);
    }
    const synth = BRANCH_TEMPLATES.find((t) => t.id === 'synth')!.apply(locked, 3);
    // The partly locked guitar keeps its instrument and its locked verse.
    const g2 = synth.tracks.find((t) => t.id === guitar.id)!;
    expect(g2.instrumentId).toBe(guitar.instrumentId);
    const vs = sectionLayout(locked).find((x) => x.section.id === verse.id)!;
    expect(g2.notes.filter((n) => n.tick >= vs.startTick && n.tick < vs.endTick)).toEqual(
      guitar.notes.filter((n) => n.tick >= vs.startTick && n.tick < vs.endTick),
    );
  });

  it('radio edit shortens the song while keeping every chorus intact', () => {
    const long = composeSong(parsePromptToBlueprint('a long epic metal song at 100 bpm', { seed: 2 }));
    const edit = BRANCH_TEMPLATES.find((t) => t.id === 'radio-edit')!.apply(long, 1);
    expect(songDurationSeconds(edit)).toBeLessThan(songDurationSeconds(long));
    expect(edit.title).toContain('Radio Edit');
    const choruses = (s: Song) => s.sections.filter((x) => x.kind === 'chorus').map((x) => x.id);
    expect(choruses(edit)).toEqual(choruses(long));
    expect(validityProblems(edit)).toEqual([]);
    // A kept chorus carries exactly its original notes, shifted.
    const chorusId = choruses(long)[0];
    const a = sectionLayout(long).find((s) => s.section.id === chorusId)!;
    const b = sectionLayout(edit).find((s) => s.section.id === chorusId)!;
    for (const t of long.tracks) {
      const orig = t.notes
        .filter((n) => n.tick >= a.startTick && n.tick < a.endTick)
        .map((n) => [n.id, n.pitch, n.tick - a.startTick]);
      const moved = edit.tracks
        .find((x) => x.id === t.id)!
        .notes.filter((n) => n.tick >= b.startTick && n.tick < b.endTick)
        .map((n) => [n.id, n.pitch, n.tick - b.startTick]);
      expect(moved).toEqual(orig);
    }
  });
});

describe('applyMacroTransforms (§19)', () => {
  it('humanization loosens timing deterministically and tightening pulls back to the grid', () => {
    const tight = applyMacroTransforms(song, { humanization: 0 });
    const loose = applyMacroTransforms(tight, { humanization: 0.9 });
    expect(loose.macros.humanization).toBe(0.9);
    const ticks = (s: Song) => s.tracks.flatMap((t) => t.notes.map((n) => n.tick));
    expect(ticks(loose)).not.toEqual(ticks(tight));
    expect(songHash(applyMacroTransforms(tight, { humanization: 0.9 }))).toBe(songHash(loose));
    const offGrid = (s: Song) => s.tracks.flatMap((t) => t.notes).filter((n) => n.tick % 40 !== 0).length;
    expect(offGrid(tight)).toBeLessThan(offGrid(song));
    expect(validityProblems(loose)).toEqual([]);
  });

  it('dynamics widens or flattens velocities; locked tracks never change', () => {
    const vocal = vocalOf(song);
    const locked = cloneSong(song);
    locked.locks = { [LockKeys.track(vocal.id)]: true };
    const spread = (s: Song) => {
      const v = s.tracks.filter((t) => t.role === 'bass').flatMap((t) => t.notes.map((n) => n.velocity));
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    };
    const flat = applyMacroTransforms(locked, { dynamics: 0 });
    const wide = applyMacroTransforms(locked, { dynamics: 1 });
    expect(spread(flat)).toBeLessThan(spread(locked));
    expect(spread(wide)).toBeGreaterThan(spread(locked));
    expect(vocalOf(flat)).toEqual(vocalOf(locked));
    expect(vocalOf(wide)).toEqual(vocalOf(locked));
  });

  it('stores per-track macros when a track is given', () => {
    const bass = song.tracks.find((t) => t.role === 'bass')!;
    const out = applyMacroTransforms(song, { humanization: 0.9, complexity: 0.8 }, bass.id);
    expect(out.tracks.find((t) => t.id === bass.id)!.macros).toMatchObject({
      humanization: 0.9,
      complexity: 0.8,
    });
    expect(out.macros).toEqual(song.macros);
    for (const t of out.tracks)
      if (t.id !== bass.id) expect(t.notes).toEqual(song.tracks.find((x) => x.id === t.id)!.notes);
  });
});

describe('generateAsset (§25 Generate MIDI)', () => {
  it('creates a melancholy 16-bar cello melody in D minor', () => {
    const { song: s, trackId } = generateAsset(
      {
        description: 'Create a melancholy 16-bar cello melody in D minor',
        instrumentId: 'cello',
        role: 'strings',
        function: 'melody',
        bars: 16,
        key: { tonic: 2, mode: 'minor' },
        tempo: 80,
        meter: { numerator: 4, denominator: 4 },
        moods: ['melancholy'],
        genreIds: ['cinematic'],
        count: 1,
      },
      7,
    );
    expect(s.tracks.length).toBe(1);
    const t = s.tracks[0];
    expect(t.id).toBe(trackId);
    expect(s.sections.reduce((n, x) => n + x.bars, 0)).toBe(16);
    expect(s.keyMap[0].key).toEqual({ tonic: 2, mode: 'minor' });
    expect(t.notes.length).toBeGreaterThan(30);
    for (const n of t.notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(36);
      expect(n.pitch).toBeLessThanOrEqual(76);
    }
    expect(validityProblems(s)).toEqual([]);
  });

  it('creates drum patterns and bass lines over a given progression', () => {
    const drums = generateAsset(
      {
        description: 'Make a pop-punk drum pattern at 176 BPM',
        instrumentId: 'drum-kit',
        role: 'drums',
        bars: 8,
        key: { tonic: 0, mode: 'major' },
        tempo: 176,
        meter: { numerator: 4, denominator: 4 },
        moods: [],
        genreIds: ['pop-punk'],
        count: 1,
      },
      3,
    );
    expect(drums.song.tempoMap[0].bpm).toBe(176);
    expect(drums.song.tracks[0].notes.some((n) => n.pitch === 36)).toBe(true);
    expect(drums.song.tracks[0].notes.some((n) => n.pitch === 38)).toBe(true);
    const req = {
      description: 'bass line',
      instrumentId: 'electric-bass',
      role: 'bass' as const,
      bars: 4,
      key: { tonic: 9, mode: 'minor' as const },
      tempo: 110,
      meter: { numerator: 4, denominator: 4 },
      moods: [],
      genreIds: ['rock'],
      count: 4,
      progression: ['Am', 'F', 'C', 'G'],
    };
    const lines = [1, 2, 3, 4].map((seed) => generateAsset(req, seed).song);
    expect(lines[0].chords.map((c) => c.symbol)).toEqual(['Am', 'F', 'C', 'G']);
    expect(new Set(lines.map((l) => stableStringify(l.tracks[0].notes))).size).toBe(4);
    for (const l of lines) {
      // Each chord change gets its root.
      for (const c of l.chords) {
        const first = l.tracks[0].notes.find((n) => n.tick >= c.tick - 30 && n.tick < c.tick + 60);
        expect(first && first.pitch % 12 === parseChordSymbol(c.symbol)!.root % 12).toBe(true);
      }
      expect(validityProblems(l)).toEqual([]);
    }
    const roman = generateAsset({ ...req, progression: ['i', 'VI', 'III', 'VII'] }, 1).song;
    expect(roman.chords.map((c) => c.symbol)).toEqual(['Am', 'F', 'C', 'G']);
  });
});
