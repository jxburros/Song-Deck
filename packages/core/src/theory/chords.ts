import type { ChordQuality, ChordSpec, KeySignature, PitchClass } from '../ir/types';
import { mod12, pitchClassFromName, spellPitchClass } from './pitch';
import { MODE_INTERVALS } from './scales';

/** Semitone intervals above the root for each quality (extensions above the octave kept > 12). */
export const CHORD_INTERVALS: Record<ChordQuality, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  minmaj7: [0, 3, 7, 11],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  '7sus4': [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  minadd9: [0, 3, 7, 14],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  '11': [0, 7, 10, 14, 17],
  min11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21],
  maj13: [0, 4, 7, 11, 14, 21],
  aug7: [0, 4, 8, 10],
  '7b9': [0, 4, 7, 10, 13],
  '7#9': [0, 4, 7, 10, 15],
};

export const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  '5': '5',
  '6': '6',
  min6: 'm6',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
  minmaj7: 'm(maj7)',
  m7b5: 'm7b5',
  dim7: 'dim7',
  '7sus4': '7sus4',
  add9: 'add9',
  minadd9: 'm(add9)',
  '9': '9',
  maj9: 'maj9',
  min9: 'm9',
  '11': '11',
  min11: 'm11',
  '13': '13',
  maj13: 'maj13',
  aug7: 'aug7',
  '7b9': '7b9',
  '7#9': '7#9',
};

export const ALL_CHORD_QUALITIES = Object.keys(CHORD_INTERVALS) as ChordQuality[];

const SUFFIX_ALIASES: Record<string, ChordQuality> = {
  '': 'maj',
  M: 'maj',
  maj: 'maj',
  major: 'maj',
  m: 'min',
  mi: 'min',
  min: 'min',
  minor: 'min',
  '-': 'min',
  dim: 'dim',
  '°': 'dim',
  o: 'dim',
  aug: 'aug',
  '+': 'aug',
  '#5': 'aug',
  sus: 'sus4',
  sus4: 'sus4',
  sus2: 'sus2',
  '2': 'sus2',
  '5': '5',
  '6': '6',
  maj6: '6',
  m6: 'min6',
  min6: 'min6',
  '-6': 'min6',
  '7': '7',
  dom7: '7',
  maj7: 'maj7',
  M7: 'maj7',
  ma7: 'maj7',
  'Δ': 'maj7',
  'Δ7': 'maj7',
  m7: 'min7',
  min7: 'min7',
  mi7: 'min7',
  '-7': 'min7',
  mmaj7: 'minmaj7',
  mM7: 'minmaj7',
  'm(maj7)': 'minmaj7',
  'm(M7)': 'minmaj7',
  minmaj7: 'minmaj7',
  m7b5: 'm7b5',
  'm7(b5)': 'm7b5',
  '-7b5': 'm7b5',
  'ø': 'm7b5',
  'ø7': 'm7b5',
  dim7: 'dim7',
  '°7': 'dim7',
  o7: 'dim7',
  '7sus4': '7sus4',
  '7sus': '7sus4',
  add9: 'add9',
  add2: 'add9',
  madd9: 'minadd9',
  'm(add9)': 'minadd9',
  minadd9: 'minadd9',
  '9': '9',
  maj9: 'maj9',
  M9: 'maj9',
  m9: 'min9',
  min9: 'min9',
  '11': '11',
  m11: 'min11',
  min11: 'min11',
  '13': '13',
  maj13: 'maj13',
  M13: 'maj13',
  aug7: 'aug7',
  '+7': 'aug7',
  '7#5': 'aug7',
  '7+': 'aug7',
  '7b9': '7b9',
  '7#9': '7#9',
};

/** Parse a chord symbol: "Em", "G/B", "F#m7b5", "Bbsus4", "A5", "Cmaj7/E". Returns null if unparseable. */
export function parseChordSymbol(symbol: string): ChordSpec | null {
  const s = symbol.trim();
  const m = /^([A-Ga-g](?:#|♯|b|♭)?)(.*?)(?:\/([A-Ga-g](?:#|♯|b|♭)?))?$/.exec(s);
  if (!m) return null;
  const root = pitchClassFromName(m[1]);
  if (root === null) return null;
  const rawSuffix = m[2].replace(/\s+/g, '').replace(/^\((.*)\)$/, '$1');
  let quality: ChordQuality | undefined = SUFFIX_ALIASES[rawSuffix];
  if (!quality) {
    // Case-insensitive fallback only for spelled-out words ("MAJ7", "Min", "Sus4"), never for bare "M"/"m".
    const lower = rawSuffix.toLowerCase();
    if (/^(maj|min|dim|aug|sus|add|dom)/.test(lower)) quality = SUFFIX_ALIASES[lower];
  }
  if (!quality) return null;
  const spec: ChordSpec = { root, quality };
  if (m[3]) {
    const bass = pitchClassFromName(m[3]);
    if (bass === null) return null;
    if (bass !== root) spec.bass = bass;
  }
  return spec;
}

/** Canonical chord symbol for a spec, spelled for the key when given. */
export function formatChordSymbol(chord: ChordSpec, key?: KeySignature): string {
  const root = spellPitchClass(chord.root, key);
  const bass = chord.bass !== undefined && chord.bass !== chord.root ? `/${spellPitchClass(chord.bass, key)}` : '';
  return `${root}${QUALITY_SUFFIX[chord.quality]}${bass}`;
}

/** Pitch classes of the chord (root first, extensions included, bass added if not a chord tone). */
export function chordPitchClasses(chord: ChordSpec): PitchClass[] {
  const out: PitchClass[] = [];
  for (const i of CHORD_INTERVALS[chord.quality]) {
    const pc = mod12(chord.root + i);
    if (!out.includes(pc)) out.push(pc);
  }
  if (chord.bass !== undefined && !out.includes(chord.bass)) out.push(chord.bass);
  return out;
}

export type ChordToneRole = 'root' | 'third' | 'fifth' | 'seventh' | 'sixth' | 'ninth' | 'eleventh' | 'thirteenth' | 'sus' | 'bass';

/** Chord tones with their function, ordered by voicing importance (root, 3rd, 7th, 5th, extensions). */
export function chordTones(chord: ChordSpec): { pc: PitchClass; role: ChordToneRole; interval: number }[] {
  const tones: { pc: PitchClass; role: ChordToneRole; interval: number }[] = CHORD_INTERVALS[chord.quality].map((interval) => {
    const i = interval % 12;
    let role: ChordToneRole;
    if (interval === 0) role = 'root';
    else if (i === 3 || i === 4) role = interval > 12 ? 'ninth' : 'third';
    else if (i === 2 || i === 1) role = interval >= 12 ? 'ninth' : 'sus';
    else if (i === 5) role = interval >= 12 ? 'eleventh' : 'sus';
    else if (i === 6 || i === 7 || i === 8) role = 'fifth';
    else if (i === 9) role = interval >= 12 ? 'thirteenth' : chord.quality === 'dim7' ? 'seventh' : 'sixth';
    else role = 'seventh';
    if (interval === 15 && chord.quality === '7#9') role = 'ninth';
    if (interval === 14 || interval === 13) role = 'ninth';
    if (interval === 17) role = 'eleventh';
    if (interval === 21) role = 'thirteenth';
    return { pc: mod12(chord.root + interval), role, interval };
  });
  const order: ChordToneRole[] = ['root', 'third', 'sus', 'seventh', 'sixth', 'fifth', 'ninth', 'eleventh', 'thirteenth'];
  tones.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  if (chord.bass !== undefined && !tones.some((t) => t.pc === chord.bass)) {
    tones.push({ pc: chord.bass, role: 'bass', interval: mod12(chord.bass - chord.root) });
  }
  return tones;
}

export function isChordTone(pitch: number, chord: ChordSpec): boolean {
  return chordPitchClasses(chord).includes(mod12(pitch));
}

/** Whether a quality is minor-flavoured (minor third, not diminished). */
export function isMinorQuality(q: ChordQuality): boolean {
  return q === 'min' || q === 'min6' || q === 'min7' || q === 'minmaj7' || q === 'minadd9' || q === 'min9' || q === 'min11';
}

export function isDominantQuality(q: ChordQuality): boolean {
  return q === '7' || q === '9' || q === '13' || q === '7b9' || q === '7#9' || q === '7sus4' || q === 'aug7' || q === '11';
}

/** Reduce any chord to its basic triad quality (for analysis and roman numerals). */
export function triadQuality(q: ChordQuality): 'maj' | 'min' | 'dim' | 'aug' | 'sus' | '5' {
  if (q === '5') return '5';
  if (q === 'sus2' || q === 'sus4' || q === '7sus4' || q === '11') return 'sus';
  if (q === 'dim' || q === 'dim7' || q === 'm7b5') return 'dim';
  if (q === 'aug' || q === 'aug7') return 'aug';
  if (isMinorQuality(q)) return 'min';
  return 'maj';
}

/** Build a triad/seventh by stacking thirds from the key's scale at a degree (0..6). */
export function diatonicChord(key: KeySignature, degree: number, seventh = false): ChordSpec {
  const iv = MODE_INTERVALS[key.mode];
  const at = (d: number) => iv[d % 7] + (d >= 7 ? 12 : 0);
  const d = ((degree % 7) + 7) % 7;
  const root = at(d);
  const third = at(d + 2) - root;
  const fifth = at(d + 4) - root;
  const sev = at(d + 6) - root;
  let quality: ChordQuality;
  if (third === 4 && fifth === 7) quality = seventh ? (sev === 11 ? 'maj7' : '7') : 'maj';
  else if (third === 3 && fifth === 7) quality = seventh ? (sev === 10 ? 'min7' : 'minmaj7') : 'min';
  else if (third === 3 && fifth === 6) quality = seventh ? (sev === 10 ? 'm7b5' : 'dim7') : 'dim';
  else if (third === 4 && fifth === 8) quality = seventh ? 'aug7' : 'aug';
  else quality = 'maj';
  return { root: mod12(key.tonic + root), quality };
}

export function diatonicChords(key: KeySignature, sevenths = false): ChordSpec[] {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => diatonicChord(key, d, sevenths));
}

/** True if every chord tone is in the key's scale. */
export function isDiatonic(chord: ChordSpec, key: KeySignature): boolean {
  const scale = MODE_INTERVALS[key.mode].map((i) => mod12(key.tonic + i));
  return chordPitchClasses({ root: chord.root, quality: chord.quality }).every((pc) => scale.includes(pc));
}

/** Same chord with a different quality (keeps root/bass). */
export function withQuality(chord: ChordSpec, quality: ChordQuality): ChordSpec {
  return { ...chord, quality };
}

export function chordsEqual(a: ChordSpec, b: ChordSpec): boolean {
  return a.root === b.root && a.quality === b.quality && (a.bass ?? a.root) === (b.bass ?? b.root);
}
