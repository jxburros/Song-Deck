import type { KeySignature, MusicOperation, SectionKind, Ticks } from '../ir/types';

/**
 * Public result shapes of the musician module (offline musical intelligence layer).
 *
 * Every interpreter returns structured `MusicOperation`s (spec §46) — it never mutates the
 * song. The edit module validates and applies them to produce a Proposal (§21).
 */

export interface EditInterpretation {
  operations: MusicOperation[];
  /** Human-readable account of what will change and why (and what was skipped because it is locked). */
  explanation: string;
  /** Recognized intent ids, e.g. ["busier", "louder"]. */
  intents: string[];
  /** False when the instruction could not be mapped to any known musical operation. */
  understood: boolean;
}

export interface ExplainedChord {
  id: string;
  symbol: string;
  roman: string;
  function: string;
  /** 0..1 */
  tension: number;
  /** Parallel mode the chord is borrowed from (modal interchange), e.g. "minor". */
  borrowedFrom?: string;
  /** Secondary dominant (V/x, V7/x). */
  secondary?: boolean;
  /** 1-based bar where the chord starts (clamped to the section start). */
  bar: number;
}

export interface SectionExplanation {
  sectionId: string;
  sectionName: string;
  /** Key the section is analysed in (may be the relative major/minor of the song key when the section centres there). */
  key: KeySignature;
  keyName: string;
  chords: ExplainedChord[];
  /** Chord symbols of the (shortest repeating) progression, e.g. "G – D – Em – C". */
  chordSummary: string;
  /** e.g. "I – V – vi – IV in G major." */
  romanSummary: string;
  narrative: string[];
  cadences: { bar: number; type: string; description: string }[];
  borrowed: string[];
  secondaryDominants: string[];
  /** Tension per chord (0..1), same order as `chords`. */
  tensionCurve: number[];
  melody?: {
    trackId: string;
    range: string;
    lowest: string;
    highest: string;
    contour: string;
    chordToneRatio: number;
    stepwiseRatio: number;
  };
  rhythm?: { syncopation: number; density: number; description: string };
  comparisons: string[];
}

export interface SongExplanation {
  overview: string[];
  sections: SectionExplanation[];
}

/** Theory View controls (spec §43). */
export type TheoryControl = 'darker' | 'brighter' | 'more-tension' | 'less-tension' | 'less-conventional' | 'modal' | 'simplify';

export interface ChordSuggestion {
  symbol: string;
  roman: string;
  reason: string;
}

export type LyricAlignmentStatus = 'aligned' | 'too-many-syllables' | 'too-few-syllables';

export interface LyricAlignmentEntry {
  sectionId: string;
  lineId: string;
  syllables: number;
  notes: number;
  status: LyricAlignmentStatus;
}

export interface LyricAlignmentResult {
  operations: MusicOperation[];
  report: LyricAlignmentEntry[];
  /** Sections skipped (locked material, no notes, no lyric lines…). */
  warnings: string[];
}

export interface AlignLyricsOptions {
  sectionIds?: string[];
  /**
   * 'assign' (default): attach syllables to the existing notes ("_" melisma when there are more
   * notes than syllables; adjacent syllables merged when there are more syllables than notes).
   * 'fit-rhythm': split/merge notes so the counts match, preserving the contour.
   */
  mode?: 'assign' | 'fit-rhythm';
}

export interface PlaceholderLyricsOptions {
  mood?: string;
  theme?: string;
  sectionKind: SectionKind;
  lines: number;
  /** Target syllables per line (cycled when shorter than `lines`). */
  syllablesPerLine?: number[];
  seed: number;
}

export interface VocalInterpretation extends EditInterpretation {
  /** Tick range a vocal re-render/regeneration should cover. */
  regenerateRange?: { startTick: Ticks; endTick: Ticks };
}

export interface AssistantAnswer {
  answer: string;
  operations?: MusicOperation[];
  suggestions?: string[];
  intents: string[];
}
