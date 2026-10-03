import type { KeySignature, MidiPitch, ModeName, PitchClass } from '../ir/types';
import { mod12, pitchClassFromName, spellPitchClass } from './pitch';

export const MODE_INTERVALS: Record<ModeName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic-minor': [0, 2, 3, 5, 7, 9, 11],
};

export const ALL_MODES = Object.keys(MODE_INTERVALS) as ModeName[];

export const PENTATONIC_MAJOR = [0, 2, 4, 7, 9] as const;
export const PENTATONIC_MINOR = [0, 3, 5, 7, 10] as const;
export const BLUES_SCALE = [0, 3, 5, 6, 7, 10] as const;

/** Modes with a minor third above the tonic. */
export function isMinorMode(mode: ModeName): boolean {
  return MODE_INTERVALS[mode][2] === 3;
}

export function scalePitchClasses(key: KeySignature): PitchClass[] {
  return MODE_INTERVALS[key.mode].map((i) => mod12(key.tonic + i));
}

export function isInScale(pitch: number, key: KeySignature): boolean {
  return scalePitchClasses(key).includes(mod12(pitch));
}

/** Pentatonic pitch classes appropriate to the key (major or minor pentatonic). */
export function pentatonicPitchClasses(key: KeySignature): PitchClass[] {
  const pent = isMinorMode(key.mode) ? PENTATONIC_MINOR : PENTATONIC_MAJOR;
  return pent.map((i) => mod12(key.tonic + i));
}

/**
 * Absolute scale index ↔ MIDI pitch.
 * Index 0 is the tonic in MIDI octave -1 (pitch = tonic pc). Each +7 is one octave.
 */
export function scaleIndexToPitch(index: number, key: KeySignature): MidiPitch {
  const intervals = MODE_INTERVALS[key.mode];
  const octave = Math.floor(index / 7);
  const deg = index - octave * 7;
  return key.tonic + octave * 12 + intervals[deg];
}

/**
 * Nearest scale index at or below the pitch, plus the chromatic alteration needed
 * (0 for in-scale pitches, +1 for a raised note).
 */
export function pitchToScaleIndex(pitch: MidiPitch, key: KeySignature): { index: number; alteration: number } {
  const intervals = MODE_INTERVALS[key.mode];
  const rel = pitch - key.tonic;
  const octave = Math.floor(rel / 12);
  const within = rel - octave * 12;
  let deg = 0;
  for (let i = 0; i < 7; i++) if (intervals[i] <= within) deg = i;
  return { index: octave * 7 + deg, alteration: within - intervals[deg] };
}

/** Scale degree (0..6) of a pitch, with alteration for chromatic notes. */
export function scaleDegreeOf(pitch: MidiPitch, key: KeySignature): { degree: number; alteration: number } {
  const { index, alteration } = pitchToScaleIndex(pitch, key);
  return { degree: ((index % 7) + 7) % 7, alteration };
}

/** Move a pitch by scale steps, preserving any chromatic alteration. */
export function transposeDiatonic(pitch: MidiPitch, steps: number, key: KeySignature): MidiPitch {
  const { index, alteration } = pitchToScaleIndex(pitch, key);
  return scaleIndexToPitch(index + steps, key) + alteration;
}

/** Snap a pitch to the key's scale. */
export function snapToScale(pitch: MidiPitch, key: KeySignature, prefer: 'nearest' | 'up' | 'down' = 'nearest'): MidiPitch {
  if (isInScale(pitch, key)) return pitch;
  const up = (() => {
    for (let d = 1; d < 12; d++) if (isInScale(pitch + d, key)) return pitch + d;
    return pitch;
  })();
  const down = (() => {
    for (let d = 1; d < 12; d++) if (isInScale(pitch - d, key)) return pitch - d;
    return pitch;
  })();
  if (prefer === 'up') return up;
  if (prefer === 'down') return down;
  return up - pitch <= pitch - down ? up : down;
}

/** Snap to the nearest pitch whose pitch class is in `pcs`. */
export function snapToPitchClasses(pitch: MidiPitch, pcs: readonly PitchClass[]): MidiPitch {
  if (pcs.length === 0) return pitch;
  for (let d = 0; d < 12; d++) {
    if (pcs.includes(mod12(pitch + d))) return pitch + d;
    if (pcs.includes(mod12(pitch - d))) return pitch - d;
  }
  return pitch;
}

/** Place a pitch class in the octave closest to `near`. */
export function nearestPitchWithClass(pc: PitchClass, near: MidiPitch): MidiPitch {
  const base = near - mod12(near - pc);
  return near - base <= 6 ? base : base + 12;
}

/** Fold a pitch into [low, high] by octaves (keeps pitch class). */
export function foldIntoRange(pitch: MidiPitch, low: MidiPitch, high: MidiPitch): MidiPitch {
  let p = pitch;
  if (high - low < 12) return Math.min(high, Math.max(low, p));
  while (p < low) p += 12;
  while (p > high) p -= 12;
  return p;
}

export function relativeKey(key: KeySignature): KeySignature {
  if (key.mode === 'major') return { tonic: mod12(key.tonic + 9), mode: 'minor' };
  if (isMinorMode(key.mode)) return { tonic: mod12(key.tonic + 3), mode: 'major' };
  return key;
}

export function parallelKey(key: KeySignature): KeySignature {
  return { tonic: key.tonic, mode: isMinorMode(key.mode) ? 'major' : 'minor' };
}

const MODE_LABEL: Record<ModeName, string> = {
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

/** "E minor", "Bb major", "D Dorian". */
export function keyName(key: KeySignature): string {
  return `${spellPitchClass(key.tonic, key)} ${MODE_LABEL[key.mode]}`;
}

const MODE_ALIASES: [RegExp, ModeName][] = [
  [/^(maj|major|ionian|M)$/, 'major'],
  [/^(m|min|minor|aeolian|-)$/, 'minor'],
  [/^dorian$/, 'dorian'],
  [/^phrygian$/, 'phrygian'],
  [/^lydian$/, 'lydian'],
  [/^mixolydian$/, 'mixolydian'],
  [/^locrian$/, 'locrian'],
  [/^harmonic[\s-]?minor$/, 'harmonic-minor'],
  [/^melodic[\s-]?minor$/, 'melodic-minor'],
];

/** Parse "E minor", "Em", "F# major", "Bb", "D dorian", "c#m", "A harmonic minor". */
export function parseKey(text: string): KeySignature | null {
  const m = /^\s*([A-Ga-g](?:#|♯|b|♭)?)\s*(.*?)\s*$/.exec(text);
  if (!m) return null;
  const tonic = pitchClassFromName(m[1]);
  if (tonic === null) return null;
  const rest = m[2];
  if (rest === '') return { tonic, mode: 'major' };
  for (const [re, mode] of MODE_ALIASES) {
    if (re.test(rest) || re.test(rest.toLowerCase())) return { tonic, mode };
  }
  return null;
}
