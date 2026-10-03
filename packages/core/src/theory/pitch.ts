import type { KeySignature, MidiPitch, ModeName, PitchClass } from '../ir/types';

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function mod12(n: number): PitchClass {
  return ((n % 12) + 12) % 12;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Parse a pitch-class name: "C", "c#", "Db", "B#", "Fb", "F##", "Ebb", "C♯", "B♭". */
export function pitchClassFromName(name: string): PitchClass | null {
  const m = /^\s*([A-Ga-g])((?:#|♯|x|##|b|♭|bb)*)\s*$/.exec(name);
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  const acc = m[2] ?? '';
  for (const ch of acc.replace(/##/g, 'x').replace(/bb/g, 'β')) {
    if (ch === '#' || ch === '♯') pc += 1;
    else if (ch === 'x') pc += 2;
    else if (ch === 'b' || ch === '♭') pc -= 1;
    else if (ch === 'β') pc -= 2;
  }
  return mod12(pc);
}

/** "A4" → 69, "C-1" → 0, "Eb3" → 51. Scientific pitch notation (C4 = 60). */
export function noteNameToMidi(name: string): MidiPitch | null {
  const m = /^\s*([A-Ga-g](?:#|♯|x|##|b|♭|bb)*)\s*(-?\d+)\s*$/.exec(name);
  if (!m) return null;
  const letter = m[1][0].toUpperCase();
  const pc = pitchClassFromName(m[1]);
  if (pc === null) return null;
  const octave = parseInt(m[2], 10);
  // Octave belongs to the letter: B#3 is C4 (60), Cb4 is B3 (59).
  const letterPc = LETTER_PC[letter];
  let accidentalShift = pc - letterPc;
  if (accidentalShift > 6) accidentalShift -= 12;
  if (accidentalShift < -6) accidentalShift += 12;
  const midi = (octave + 1) * 12 + letterPc + accidentalShift;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** 61 → "C#4" (or "Db4" with flats). */
export function midiToNoteName(pitch: MidiPitch, useFlats = false): string {
  const p = Math.round(pitch);
  const names = useFlats ? FLAT_NAMES : SHARP_NAMES;
  return `${names[mod12(p)]}${Math.floor(p / 12) - 1}`;
}

/** Parse a pitch given as MIDI number or note name (structured AI output). */
export function parsePitch(p: number | string): MidiPitch | null {
  if (typeof p === 'number') return Number.isFinite(p) ? Math.round(p) : null;
  const trimmed = p.trim();
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return noteNameToMidi(trimmed);
}

export function pitchToFrequency(pitch: number, a4 = 440): number {
  return a4 * Math.pow(2, (pitch - 69) / 12);
}

/** Fractional MIDI pitch for a frequency. */
export function frequencyToPitch(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

/** Semitone offset of each mode's tonic above its parent major (Ionian) tonic. */
const MODE_PARENT_OFFSET: Record<ModeName, number> = {
  major: 0,
  dorian: 2,
  phrygian: 4,
  lydian: 5,
  mixolydian: 7,
  minor: 9,
  'harmonic-minor': 9,
  'melodic-minor': 9,
  locrian: 11,
};

/** Whether a key is conventionally spelled with flats. */
export function keyPrefersFlats(key: KeySignature): boolean {
  const parent = mod12(key.tonic - MODE_PARENT_OFFSET[key.mode]);
  if (parent === 6) return key.mode !== 'major'; // F# major, but Eb minor / Ab dorian
  return parent === 5 || parent === 10 || parent === 3 || parent === 8 || parent === 1;
}

/** Spell a pitch class appropriately for a key (no key → sharps). */
export function spellPitchClass(pc: PitchClass, key?: KeySignature): string {
  const flats = key ? keyPrefersFlats(key) : false;
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)];
}

export function midiToNoteNameInKey(pitch: MidiPitch, key?: KeySignature): string {
  return midiToNoteName(pitch, key ? keyPrefersFlats(key) : false);
}

const INTERVAL_NAMES = ['P1', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7'];

/** "m3", "P5", "M9"… for a semitone distance. */
export function intervalName(semitones: number): string {
  const s = Math.abs(Math.round(semitones));
  if (s < 12) return INTERVAL_NAMES[s];
  const base = INTERVAL_NAMES[s % 12];
  const compound: Record<string, string> = { m2: 'm9', M2: 'M9', m3: 'm10', M3: 'M10', P4: 'P11', TT: '#11', P5: 'P12', m6: 'm13', M6: 'M13' };
  if (s % 12 === 0) return s === 12 ? 'P8' : `P8x${s / 12}`;
  return s < 24 ? (compound[base] ?? `${base}+8`) : `${base}+${Math.floor(s / 12)}oct`;
}
