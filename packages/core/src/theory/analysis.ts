import type { ChordSpec, KeySignature } from '../ir/types';
import { CHORD_INTERVALS, isDiatonic, isDominantQuality, triadQuality } from './chords';
import { mod12 } from './pitch';
import { borrowedFrom, chordDegree } from './roman';
import { isMinorMode } from './scales';

export type HarmonicFunction = 'tonic' | 'predominant' | 'dominant' | 'chromatic';

/** Functional-harmony role of a chord in a key. */
export function chordFunction(chord: ChordSpec, key: KeySignature): HarmonicFunction {
  const deg = chordDegree(chord, key);
  const interval = mod12(chord.root - key.tonic);
  if (deg < 0) {
    // Common chromatic chords
    if (interval === 10 || interval === 8 || interval === 3)
      return isMinorMode(key.mode) ? 'tonic' : 'predominant';
    if (interval === 1) return 'predominant'; // Neapolitan
    return 'chromatic';
  }
  if (isMinorMode(key.mode)) {
    if (deg === 0 || deg === 2 || deg === 5) return deg === 5 ? 'predominant' : 'tonic';
    if (deg === 1 || deg === 3) return 'predominant';
    return 'dominant'; // v/V, VII
  }
  if (deg === 0 || deg === 2 || deg === 5) return 'tonic';
  if (deg === 1 || deg === 3) return 'predominant';
  return 'dominant';
}

export type CadenceType = 'authentic' | 'plagal' | 'half' | 'deceptive';

/** Detect a cadence formed by prev → cur. */
export function detectCadence(prev: ChordSpec, cur: ChordSpec, key: KeySignature): CadenceType | null {
  const pi = mod12(prev.root - key.tonic);
  const ci = mod12(cur.root - key.tonic);
  const prevIsDominant =
    pi === 7 && (triadQuality(prev.quality) === 'maj' || isDominantQuality(prev.quality));
  if (prevIsDominant && ci === 0) return 'authentic';
  if (pi === 5 && ci === 0) return 'plagal';
  if (prevIsDominant && (ci === 9 || ci === 8)) return 'deceptive';
  if (ci === 7 && pi !== 7) return 'half';
  return null;
}

/**
 * Harmonic tension 0..1 for a chord in context (dominant function, sevenths, dissonant
 * qualities, chromaticism and inversions raise tension).
 */
export function chordTension(chord: ChordSpec, key: KeySignature): number {
  const fn = chordFunction(chord, key);
  let t = fn === 'tonic' ? 0.1 : fn === 'predominant' ? 0.35 : fn === 'dominant' ? 0.6 : 0.55;
  const ivs = CHORD_INTERVALS[chord.quality];
  if (ivs.length >= 4) t += 0.12;
  if (ivs.length >= 5) t += 0.06;
  const tq = triadQuality(chord.quality);
  if (tq === 'dim' || tq === 'aug') t += 0.2;
  if (tq === 'sus') t += 0.12;
  if (chord.quality === '7b9' || chord.quality === '7#9') t += 0.15;
  if (!isDiatonic(chord, key)) t += borrowedFrom(chord, key) ? 0.08 : 0.15;
  if (chord.bass !== undefined && chord.bass !== chord.root) t += 0.05;
  return Math.max(0, Math.min(1, t));
}

/** Characteristic (colour) scale degree of each mode relative to major/minor — used by modal-harmony suggestions. */
export const MODE_COLOR_NOTE: Record<string, { interval: number; description: string }> = {
  dorian: { interval: 9, description: 'raised 6th (bright minor)' },
  phrygian: { interval: 1, description: 'flat 2nd (dark, Spanish)' },
  lydian: { interval: 6, description: 'raised 4th (dreamy, floating)' },
  mixolydian: { interval: 10, description: 'flat 7th (bluesy major)' },
  locrian: { interval: 6, description: 'flat 5th (unstable)' },
  'harmonic-minor': { interval: 11, description: 'raised 7th (exotic, strong pull)' },
  'melodic-minor': { interval: 9, description: 'raised 6th and 7th (jazz minor)' },
};
