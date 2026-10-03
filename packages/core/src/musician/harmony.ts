import type { ChordQuality, ChordSpec, KeySignature, ModeName } from '../ir/types';
import {
  CHORD_INTERVALS,
  chordPitchClasses,
  chordTones,
  diatonicChord,
  formatChordSymbol,
  isDiatonic,
  isDominantQuality,
  isMinorQuality,
  triadQuality,
} from '../theory/chords';
import { FLAT_NAMES, SHARP_NAMES, mod12 } from '../theory/pitch';
import { MODE_INTERVALS, isMinorMode, scalePitchClasses } from '../theory/scales';
import { chordDegree, chordToRoman } from '../theory/roman';
import { chordFunction } from '../theory/analysis';
import type { Rng } from '../util/random';

/**
 * Harmony helpers for the musician layer: chord identification from pitch classes, modal
 * mapping (modal interchange), chord colour transformations used by the Theory View controls
 * and natural-language edits, and refitting notes to changed chords.
 */

const IDENTIFY_ORDER: ChordQuality[] = [
  'maj', 'min', 'dim', 'aug', 'sus4', 'sus2', '5', '7', 'maj7', 'min7', 'm7b5', 'dim7', '6', 'min6', 'add9', 'minadd9',
  '7sus4', '9', 'maj9', 'min9', 'minmaj7', 'aug7', '7b9', '7#9', '11', 'min11', '13', 'maj13',
];

function withBass(spec: ChordSpec, bass?: number): ChordSpec {
  if (bass !== undefined && mod12(bass) !== spec.root) return { ...spec, bass: mod12(bass) };
  return spec;
}

/** Identify a chord from pitch classes (root hint preferred). Exact match first, then best overlap. */
export function identifyChord(pcs: number[], rootHint?: number, bass?: number): ChordSpec | null {
  const set = new Set(pcs.map(mod12));
  if (!set.size) return null;
  const hint = rootHint !== undefined ? mod12(rootHint) : undefined;
  const roots = [...(hint !== undefined ? [hint] : []), ...[...set].filter((p) => p !== hint)];
  for (const r of roots)
    for (const q of IDENTIFY_ORDER) {
      const c = new Set(CHORD_INTERVALS[q].map((i) => mod12(r + i)));
      if (c.size === set.size && [...c].every((p) => set.has(p))) return withBass({ root: r, quality: q }, bass);
    }
  let best: ChordSpec | null = null;
  let bestScore = -Infinity;
  roots.forEach((r) =>
    IDENTIFY_ORDER.forEach((q, qi) => {
      const c = new Set(CHORD_INTERVALS[q].map((i) => mod12(r + i)));
      let inter = 0;
      for (const p of c) if (set.has(p)) inter++;
      const missing = set.size - inter;
      const extra = c.size - inter;
      const score = inter * 2 - missing * 2 - extra - (r === hint ? 0 : 0.75) - qi * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = { root: r, quality: q };
      }
    }),
  );
  return best ? withBass(best, bass) : null;
}

// ---------------------------------------------------------------------------
// Modal mapping
// ---------------------------------------------------------------------------

/** Map a pitch class between modes by scale degree (chromatic pitch classes are left alone). */
export function mapPcByMode(pc: number, from: KeySignature, to: KeySignature): number {
  const rel = mod12(pc - from.tonic);
  const idx = MODE_INTERVALS[from.mode].indexOf(rel);
  if (idx < 0) return mod12(pc);
  return mod12(to.tonic + MODE_INTERVALS[to.mode][idx]);
}

export function mapChordByMode(chord: ChordSpec, from: KeySignature, to: KeySignature): ChordSpec {
  const root = mapPcByMode(chord.root, from, to);
  const pcs = chordPitchClasses({ root: chord.root, quality: chord.quality }).map((pc) => mapPcByMode(pc, from, to));
  const id = identifyChord(pcs, root) ?? { root, quality: chord.quality };
  return withBass(id, chord.bass !== undefined ? mapPcByMode(chord.bass, from, to) : undefined);
}

/** Target mode for "darker": major-like → parallel (natural) minor, minor-like → Phrygian. */
export function darkerMode(mode: ModeName): ModeName {
  switch (mode) {
    case 'major':
    case 'lydian':
    case 'mixolydian':
    case 'dorian':
    case 'melodic-minor':
      return 'minor';
    case 'minor':
    case 'harmonic-minor':
      return 'phrygian';
    default:
      return mode;
  }
}

export const MODE_LABEL: Record<ModeName, string> = {
  major: 'major',
  minor: 'minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  locrian: 'Locrian',
  'harmonic-minor': 'harmonic minor',
  'melodic-minor': 'melodic minor',
};

// ---------------------------------------------------------------------------
// Quality helpers
// ---------------------------------------------------------------------------

const RAISE_THIRD: Partial<Record<ChordQuality, ChordQuality>> = {
  min: 'maj',
  min7: '7',
  min9: '9',
  minadd9: 'add9',
  min6: '6',
  min11: '11',
  minmaj7: 'maj7',
};
const LOWER_THIRD: Partial<Record<ChordQuality, ChordQuality>> = {
  maj: 'min',
  '7': 'min7',
  '9': 'min9',
  add9: 'minadd9',
  '6': 'min6',
  maj7: 'minmaj7',
};

export function raiseThird(q: ChordQuality): ChordQuality {
  return RAISE_THIRD[q] ?? q;
}
export function lowerThird(q: ChordQuality): ChordQuality {
  return LOWER_THIRD[q] ?? q;
}

/** Plain triad on the chord root (extensions, suspensions and slash bass removed). */
export function toTriad(chord: ChordSpec, key: KeySignature): ChordSpec {
  const tq = triadQuality(chord.quality);
  if (tq === 'maj' || tq === 'min' || tq === 'dim' || tq === 'aug') return { root: chord.root, quality: tq };
  const deg = chordDegree(chord, key);
  if (deg >= 0) {
    const d = diatonicChord(key, deg);
    return { root: chord.root, quality: d.quality };
  }
  return { root: chord.root, quality: 'maj' };
}

const FLAT_SPELLING: KeySignature = { tonic: 5, mode: 'major' };
const SHARP_SPELLING: KeySignature = { tonic: 7, mode: 'major' };

/**
 * Chord symbol spelled for its function in the key: chromatic chords on lowered degrees
 * (bVI, bVII, bIII, bII) use flats ("Eb" in G major, not "D#"), raised degrees use sharps.
 */
export function spellChord(spec: ChordSpec, key: KeySignature): string {
  const roman = chordToRoman(spec, key);
  if (roman.startsWith('b')) return formatChordSymbol(spec, FLAT_SPELLING);
  if (roman.startsWith('#')) return formatChordSymbol(spec, SHARP_SPELLING);
  return formatChordSymbol(spec, key);
}

/** Roman numeral that also names a non-chord-tone slash bass ("IV over D"). */
export function romanOf(spec: ChordSpec, key: KeySignature): string {
  const roman = chordToRoman(spec, key);
  if (spec.bass !== undefined && spec.bass !== spec.root && !chordPitchClasses({ root: spec.root, quality: spec.quality }).includes(spec.bass)) {
    const flats = roman.startsWith('b') || keyPrefersFlatsSafe(key);
    return `${roman} over ${(flats ? FLAT_NAMES : SHARP_NAMES)[mod12(spec.bass)]}`;
  }
  return roman;
}

function keyPrefersFlatsSafe(key: KeySignature): boolean {
  return formatChordSymbol({ root: mod12(key.tonic + 10), quality: 'maj' }, key).includes('b');
}

export function describeChord(spec: ChordSpec, key: KeySignature): string {
  return `${spellChord(spec, key)} (${romanOf(spec, key)})`;
}

export function chordChangeText(from: ChordSpec, to: ChordSpec, key: KeySignature): string {
  return `${spellChord(from, key)} → ${spellChord(to, key)} (${romanOf(from, key)} → ${romanOf(to, key)})`;
}

function sameChord(a: ChordSpec, b: ChordSpec): boolean {
  return a.root === b.root && a.quality === b.quality && (a.bass ?? a.root) === (b.bass ?? b.root);
}
export { sameChord };

// ---------------------------------------------------------------------------
// Colour transformations
// ---------------------------------------------------------------------------

/**
 * A major/dominant chord resolving down a fifth: V → I, or a secondary dominant (a dominant seventh,
 * or a major chord from outside the key) → its target. Darkening it would weaken the cadence.
 */
export function isCadentialDominant(chord: ChordSpec, next: ChordSpec | undefined, key: KeySignature): boolean {
  if (!next || mod12(chord.root - next.root) !== 7) return false;
  const target = triadQuality(next.quality);
  if (target !== 'maj' && target !== 'min') return false;
  if (!(chord.quality === 'maj' || (isDominantQuality(chord.quality) && chord.quality !== '7sus4'))) return false;
  const deg = mod12(chord.root - key.tonic);
  if (deg === 7) return true;
  return deg !== 0 && (isDominantQuality(chord.quality) || !isDiatonic({ root: chord.root, quality: 'maj' }, key));
}

/**
 * Darker colour by modal interchange. A V that resolves to the tonic (`next`) keeps its major third —
 * the harmonic-minor dominant — so the cadence still lands.
 */
export function darkenChord(chord: ChordSpec, key: KeySignature, next?: ChordSpec): ChordSpec {
  if (isCadentialDominant(chord, next, key)) return chord;
  return mapChordByMode(chord, key, { tonic: key.tonic, mode: darkerMode(key.mode) });
}

/**
 * Brighter colour, chord by chord — roots never move (mapping a whole minor passage onto the parallel
 * major would turn III/VI/VII into #iii/#vi/#vii° and change the key rather than the colour).
 * Minor-like keys borrow from the parallel major: major tonic (Picardy third), Dorian IV, harmonic-
 * minor V, minor ii instead of ii°. Major-like keys: minor chords turn major (secondary-dominant
 * colour: ii → II, iii → III, vi → VI, a borrowed v → V).
 */
export function brightenChord(chord: ChordSpec, key: KeySignature): ChordSpec {
  const deg = chordDegree(chord, key);
  const tq = triadQuality(chord.quality);
  if (isMinorMode(key.mode)) {
    if (tq === 'min' && (deg === 0 || deg === 3 || deg === 4)) return { ...chord, quality: raiseThird(chord.quality) };
    if (tq === 'dim' && deg === 1) return { ...chord, quality: chord.quality === 'm7b5' ? 'min7' : 'min' };
    return chord;
  }
  if (isMinorQuality(chord.quality) && deg >= 0 && deg <= 5) return { ...chord, quality: raiseThird(chord.quality) };
  return chord;
}

/** Harmonically ambiguous substitute: sus2 / sus4 / 7sus4 (quartal) / power (no third) / 11 / IV-over-V pedal. */
export function ambiguousChord(chord: ChordSpec, key: KeySignature, rng: Rng): { spec: ChordSpec; label: string } {
  const tq = triadQuality(chord.quality);
  if (tq === 'sus' || chord.quality === '5' || tq === 'dim' || tq === 'aug') return { spec: chord, label: 'already ambiguous' };
  const scale = scalePitchClasses(key);
  const inScale = (pcs: number[]) => pcs.every((p) => scale.includes(mod12(p)));
  const r = chord.root;
  const options: { spec: ChordSpec; label: string; w: number }[] = [];
  if (inScale([r, r + 2, r + 7])) options.push({ spec: { root: r, quality: 'sus2' }, label: 'sus2 (third replaced by the 2nd)', w: 3 });
  if (inScale([r, r + 5, r + 7])) options.push({ spec: { root: r, quality: 'sus4' }, label: 'sus4 (third replaced by the 4th)', w: 2.5 });
  if (inScale([r, r + 5, r + 7, r + 10])) options.push({ spec: { root: r, quality: '7sus4' }, label: 'quartal 7sus4 (stacked fourths)', w: isDominantQuality(chord.quality) || chordDegree(chord, key) === 4 ? 3 : 1.2 });
  if (inScale([r, r + 7, r + 10, r + 14, r + 17]))
    options.push({ spec: { root: r, quality: '11' }, label: 'quartal 11 chord (no third)', w: 1 });
  options.push({ spec: { root: r, quality: '5' }, label: 'open fifth (no third)', w: 1 });
  if (chordDegree(chord, key) === 4) options.push({ spec: { root: mod12(r - 2), quality: 'maj', bass: r }, label: 'IV-over-V slash chord (dominant without its leading tone)', w: 2.5 });
  if (chordDegree(chord, key) === 0 && inScale([r + 5, r + 9]))
    options.push({ spec: { root: mod12(r + 5), quality: 'maj', bass: r }, label: 'IV over a tonic pedal', w: 1 });
  const pick = rng.weighted(options, options.map((o) => o.w));
  return { spec: pick.spec, label: pick.label };
}

/** Add tension: sevenths/ninths, altered dominants in minor, sevenths on diminished chords. */
export function tenseChord(chord: ChordSpec, key: KeySignature, rng: Rng): ChordSpec {
  const fn = chordFunction(chord, key);
  const q = chord.quality;
  const tq = triadQuality(q);
  const deg = chordDegree(chord, key);
  if (isDominantQuality(q) && q !== '7sus4') return { ...chord, quality: isMinorMode(key.mode) || deg < 0 || deg === 1 || deg === 2 || deg === 5 ? '7b9' : '9' };
  if (tq === 'sus') return { ...chord, quality: '7sus4' };
  if (tq === 'dim') return { ...chord, quality: q === 'dim' ? (isMinorMode(key.mode) ? 'dim7' : 'm7b5') : q };
  if (tq === 'aug') return { ...chord, quality: 'aug7' };
  if (q === '5') return { ...chord, quality: 'sus4' };
  if (fn === 'dominant' && tq === 'maj') {
    if (isDominantQuality(q)) return { ...chord, quality: isMinorMode(key.mode) ? '7b9' : '9' };
    return { ...chord, quality: deg === 4 || deg < 0 ? '7' : rng.chance(0.5) ? '7' : 'maj7' };
  }
  if (tq === 'maj') {
    if (q === 'maj7' || q === 'add9' || q === '6') return { ...chord, quality: 'maj9' };
    return { ...chord, quality: fn === 'tonic' ? (rng.chance(0.5) ? 'add9' : 'maj7') : 'maj7' };
  }
  if (tq === 'min') {
    if (q === 'min7' || q === 'minadd9') return { ...chord, quality: 'min9' };
    return { ...chord, quality: rng.chance(0.6) ? 'min7' : 'minadd9' };
  }
  return chord;
}

/** Remove tension: diatonic triads, no sevenths/suspensions/chromatic colour. */
export function relaxChord(chord: ChordSpec, key: KeySignature): ChordSpec {
  const deg = chordDegree(chord, key);
  if (deg >= 0) {
    const triad = toTriad(chord, key);
    if (!isDiatonic(triad, key)) return diatonicChord(key, deg);
    return triad;
  }
  const tq = triadQuality(chord.quality);
  return { root: chord.root, quality: tq === 'min' ? 'min' : tq === 'dim' ? 'dim' : 'maj' };
}

/** Unconventional substitution with a label (tritone sub, chromatic mediant, Neapolitan, modal interchange…). */
export function unconventionalChord(chord: ChordSpec, key: KeySignature, rng: Rng): { spec: ChordSpec; label: string } | null {
  const deg = chordDegree(chord, key);
  const tq = triadQuality(chord.quality);
  const r = chord.root;
  const minorKey = isMinorMode(key.mode);
  const opts: { spec: ChordSpec; label: string; w: number }[] = [];
  if ((deg === 4 && tq === 'maj') || isDominantQuality(chord.quality))
    opts.push({ spec: { root: mod12(r + 6), quality: '7' }, label: 'tritone substitution', w: 3 });
  if (deg === 0 && tq === 'maj') {
    opts.push({ spec: { root: mod12(r + 8), quality: 'maj' }, label: 'chromatic mediant (bVI)', w: 2 });
    opts.push({ spec: { root: mod12(r + 4), quality: 'maj' }, label: 'chromatic mediant (III)', w: 1.5 });
  }
  if (deg === 0 && tq === 'min') opts.push({ spec: { root: mod12(r + 3), quality: 'maj', bass: r }, label: 'relative major over the tonic bass', w: 1.5 });
  if (deg === 3 && tq === 'maj') opts.push({ spec: { root: r, quality: 'min' }, label: 'minor iv (modal interchange)', w: 3 });
  if (deg === 3 && tq === 'min') opts.push({ spec: { root: r, quality: 'maj' }, label: 'Dorian major IV', w: 2 });
  if (deg === 5 && tq === 'min' && !minorKey) opts.push({ spec: { root: mod12(r - 1), quality: 'maj' }, label: 'bVI (borrowed from the parallel minor)', w: 3 });
  if (deg === 1) opts.push({ spec: { root: mod12(r - 1), quality: 'maj' }, label: 'Neapolitan bII', w: 2 });
  if (deg === 2 && tq === 'min') opts.push({ spec: { root: r, quality: '7' }, label: 'secondary dominant (V7/vi)', w: 2 });
  if (deg === 6 && minorKey) opts.push({ spec: { root: mod12(r + 3), quality: 'min' }, label: 'minor-key chromatic mediant', w: 1 });
  if (tq === 'maj' || tq === 'min') {
    const third = mod12(r + (tq === 'maj' ? 4 : 3));
    opts.push({ spec: { root: r, quality: chord.quality, bass: third }, label: 'first inversion (third in the bass)', w: 1 });
  }
  if (!opts.length) return null;
  const pick = rng.weighted(opts, opts.map((o) => o.w));
  return { spec: pick.spec, label: pick.label };
}

/** Pick a modal colour for "try modal harmony". */
export function chooseModalColour(key: KeySignature, rng: Rng): ModeName {
  return isMinorMode(key.mode) ? rng.pick(['dorian', 'phrygian'] as ModeName[]) : rng.pick(['mixolydian', 'lydian'] as ModeName[]);
}

/**
 * Re-harmonize a chord in a modal colour: the key's chords are mapped by scale degree into the
 * target mode, with the awkward results replaced by the mode's characteristic chord.
 */
export function modalChord(chord: ChordSpec, key: KeySignature, mode: ModeName): ChordSpec {
  const parentMinor = isMinorMode(key.mode);
  const base: KeySignature = { tonic: key.tonic, mode: parentMinor ? 'minor' : 'major' };
  const mapped = mapChordByMode(chord, base, { tonic: key.tonic, mode });
  const deg = chordDegree(chord, base);
  const tq = triadQuality(mapped.quality);
  if (mode === 'lydian' && deg === 3) return { root: mod12(key.tonic + 2), quality: 'maj' }; // IV → II
  if (mode === 'mixolydian' && deg === 2) return chord; // keep iii (would become diminished)
  if (mode === 'dorian' && deg === 5) return chord; // keep VI
  if (tq === 'dim' && triadQuality(chord.quality) !== 'dim') return chord;
  return mapped;
}

// ---------------------------------------------------------------------------
// Note refitting
// ---------------------------------------------------------------------------

/**
 * Move a pitch so it agrees with a changed chord: a tone of the old chord that is not in the new
 * chord moves to the new chord's tone of the same function (third → third or sus, etc.), else to the
 * nearest new chord tone. Non-chord tones are passed through `scaleMap` when given.
 */
export function refitPitch(pitch: number, oldChord: ChordSpec | undefined, newChord: ChordSpec | undefined, scaleMap?: (pc: number) => number): number {
  const pc = mod12(pitch);
  if (!newChord) return scaleMap ? pitch + signedPcDelta(pc, scaleMap(pc)) : pitch;
  const newPcs = chordPitchClasses(newChord);
  if (newPcs.includes(pc)) return pitch;
  const oldTones = oldChord ? chordTones(oldChord) : [];
  const ot = oldTones.find((t) => t.pc === pc);
  if (!ot) {
    if (scaleMap) {
      const m = scaleMap(pc);
      return pitch + signedPcDelta(pc, m);
    }
    return pitch;
  }
  const newTones = chordTones(newChord);
  let target = newTones.find((t) => t.role === ot.role && t.role !== 'bass');
  if (!target && ot.role === 'third') target = newTones.find((t) => t.role === 'sus');
  if (!target && ot.role === 'sus') target = newTones.find((t) => t.role === 'third');
  if (target) return pitch + signedPcDelta(pc, target.pc);
  // nearest chord tone
  let best = pitch;
  let bestD = 99;
  for (const p of newPcs) {
    const d = signedPcDelta(pc, p);
    if (Math.abs(d) < Math.abs(bestD)) {
      bestD = d;
      best = pitch + d;
    }
  }
  return best;
}

/**
 * Minimal-change refit for melodic lines: a note stays when it is a chord tone, or a scale tone
 * that is not a semitone above a chord tone (an "avoid note"); otherwise it moves to the nearest
 * chord tone of the new chord.
 */
export function refitMelodicPitch(pitch: number, newChord: ChordSpec | undefined, scalePcs: number[]): number {
  if (!newChord) return pitch;
  const pc = mod12(pitch);
  const tones = chordPitchClasses(newChord);
  if (tones.includes(pc)) return pitch;
  // Avoid notes: a half step above a chord tone, or the "wrong" third (minor 3rd over a major triad,
  // major 3rd over a minor one) — e.g. the old G over a Picardy E major chord.
  const tq = triadQuality(newChord.quality);
  const wrongThird = ((tq === 'maj' || tq === 'aug') && mod12(pc - newChord.root) === 3) || (tq === 'min' && mod12(pc - newChord.root) === 4);
  const avoid = wrongThird || tones.some((t) => mod12(pc - t) === 1);
  if (scalePcs.includes(pc) && !avoid) return pitch;
  let best = pitch;
  let bestD = 99;
  for (const t of tones) {
    const d = signedPcDelta(pc, t);
    if (Math.abs(d) < Math.abs(bestD) || (Math.abs(d) === Math.abs(bestD) && d < bestD)) {
      bestD = d;
      best = pitch + d;
    }
  }
  return best;
}

/** Smallest signed semitone move from pc a to pc b (-6..+5). */
export function signedPcDelta(a: number, b: number): number {
  let d = mod12(b - a);
  if (d > 6) d -= 12;
  return d;
}

/** Scale-degree map function between two keys (for passing tones under modal interchange). */
export function scaleMapFn(from: KeySignature, to: KeySignature): (pc: number) => number {
  return (pc) => mapPcByMode(pc, from, to);
}
