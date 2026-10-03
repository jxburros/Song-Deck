import type { ChordQuality, ChordSpec, KeySignature, ModeName } from '../ir/types';
import { CHORD_INTERVALS, diatonicChord, isDiatonic, isDominantQuality, triadQuality } from './chords';
import { mod12 } from './pitch';
import { MODE_INTERVALS, isMinorMode, parallelKey } from './scales';

/**
 * Roman numerals are interpreted relative to the key's OWN mode scale:
 * in E minor, "VI" = C and "VII" = D; in C major, "bVII" = Bb and "iv" = Fm (borrowed).
 *
 * Grammar: [accidental] NUMERAL [°|ø|+] [ext] [/TARGET]
 *   accidental: b, #, ♭, ♯
 *   NUMERAL: I..VII (uppercase = major triad, lowercase = minor triad)
 *   ext: 7, maj7, M7, 9, maj9, 6, sus2, sus4, sus, 5, add9, 11, 13
 *   TARGET: a numeral for secondary function (V/V, V7/vi, vii°/V)
 */

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export interface ParsedRoman {
  accidental: number;
  degree: number;
  upper: boolean;
  modifier: '' | '°' | 'ø' | '+';
  ext: string;
  target?: ParsedRoman;
}

export function parseRoman(text: string): ParsedRoman | null {
  const [mainRaw, targetRaw] = text.trim().split('/');
  const m = /^(b|#|♭|♯)?(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(°|o|ø|\+|dim)?(.*)$/.exec(mainRaw.trim());
  if (!m) return null;
  const accidental = m[1] === 'b' || m[1] === '♭' ? -1 : m[1] === '#' || m[1] === '♯' ? 1 : 0;
  const upper = m[2] === m[2].toUpperCase();
  const degree = NUMERALS.indexOf(m[2].toUpperCase());
  const mod = m[3] === 'o' || m[3] === 'dim' ? '°' : ((m[3] ?? '') as ParsedRoman['modifier']);
  const ext = (m[4] ?? '').trim();
  if (!/^(|7|maj7|M7|9|maj9|M9|6|sus2|sus4|sus|5|add9|11|13|7sus4|65|64|43|42|2)$/.test(ext)) return null;
  const parsed: ParsedRoman = { accidental, degree, upper, modifier: mod, ext };
  if (targetRaw !== undefined) {
    const t = parseRoman(targetRaw);
    if (!t) return null;
    parsed.target = t;
  }
  return parsed;
}

function qualityFor(p: ParsedRoman, key: KeySignature, rootInterval: number, diatonicContext: boolean): ChordQuality {
  const ext = p.ext;
  if (ext === '5') return '5';
  if (ext === 'sus2') return 'sus2';
  if (ext === 'sus4' || ext === 'sus') return 'sus4';
  if (ext === '7sus4') return '7sus4';
  if (p.modifier === 'ø') return 'm7b5';
  // "°7" is always fully diminished; half-diminished is written "ø7".
  if (p.modifier === '°') return ext === '7' ? 'dim7' : 'dim';
  if (p.modifier === '+') return ext === '7' ? 'aug7' : 'aug';
  if (p.upper) {
    switch (ext) {
      case '7':
        return diatonicContext ? diatonicSeventhQuality(key, p.degree, '7') : '7';
      case 'maj7':
      case 'M7':
        return 'maj7';
      case '9':
        return '9';
      case 'maj9':
      case 'M9':
        return 'maj9';
      case '6':
        return '6';
      case 'add9':
      case '2':
        return 'add9';
      case '11':
        return '11';
      case '13':
        return '13';
      default:
        return 'maj';
    }
  }
  switch (ext) {
    case '7':
      return 'min7';
    case 'maj7':
    case 'M7':
      return 'minmaj7';
    case '9':
      return 'min9';
    case '6':
      return 'min6';
    case 'add9':
    case '2':
      return 'minadd9';
    case '11':
      return 'min11';
    default:
      void rootInterval;
      return 'min';
  }
}

function diatonicSeventhQuality(key: KeySignature, degree: number, fallback: ChordQuality): ChordQuality {
  return diatonicChord(key, degree, true).quality ?? fallback;
}


/** Convert a roman numeral to a chord in the key. Returns null if unparseable. */
export function romanToChord(roman: string, key: KeySignature): ChordSpec | null {
  const p = parseRoman(roman);
  if (!p) return null;
  let localKey = key;
  if (p.target) {
    // Secondary function: the target numeral's chord defines a temporary tonic.
    const targetChord = romanToChord(romanText(p.target), key);
    if (!targetChord) return null;
    const tq = triadQuality(targetChord.quality);
    localKey = { tonic: targetChord.root, mode: tq === 'min' || tq === 'dim' ? 'minor' : 'major' };
    // Secondary dominants are major/dominant even when the local key is minor.
    if (p.degree === 4 && p.upper) localKey = { tonic: targetChord.root, mode: 'major' };
    if (p.degree === 6 && !p.upper) localKey = { tonic: targetChord.root, mode: 'harmonic-minor' };
  }
  const intervals = MODE_INTERVALS[localKey.mode];
  const rootInterval = intervals[p.degree] + p.accidental;
  const root = mod12(localKey.tonic + rootInterval);
  const scaleTriad = diatonicChord(localKey, p.degree);
  const diatonicContext =
    p.accidental === 0 &&
    !p.target &&
    ((p.upper && scaleTriad.quality === 'maj') || (!p.upper && (scaleTriad.quality === 'min' || scaleTriad.quality === 'dim')));
  let quality = qualityFor(p, localKey, rootInterval, diatonicContext);
  // Lowercase numeral on a diminished scale triad without explicit ° (e.g. "vii" in major) → diminished.
  if (!p.upper && p.modifier === '' && p.ext === '' && diatonicContext && scaleTriad.quality === 'dim') quality = 'dim';
  const chord: ChordSpec = { root, quality };
  const inv = inversionFromFigures(p.ext, quality);
  if (inv > 0) {
    const ivs = CHORD_INTERVALS[quality];
    const idx = Math.min(inv * 1, ivs.length - 1);
    chord.bass = mod12(root + ivs[idx]);
  }
  return chord;
}

function inversionFromFigures(ext: string, quality: ChordQuality): number {
  void quality;
  if (ext === '64' || ext === '43') return 2;
  if (ext === '65') return 1;
  if (ext === '42') return 3;
  return 0;
}

export function romanText(p: ParsedRoman): string {
  const acc = p.accidental === -1 ? 'b' : p.accidental === 1 ? '#' : '';
  const num = p.upper ? NUMERALS[p.degree] : NUMERALS[p.degree].toLowerCase();
  return `${acc}${num}${p.modifier}${p.ext}${p.target ? '/' + romanText(p.target) : ''}`;
}

function suffixForQuality(q: ChordQuality): { upper: boolean; modifier: string; ext: string } {
  switch (q) {
    case 'maj':
      return { upper: true, modifier: '', ext: '' };
    case 'min':
      return { upper: false, modifier: '', ext: '' };
    case 'dim':
      return { upper: false, modifier: '°', ext: '' };
    case 'aug':
      return { upper: true, modifier: '+', ext: '' };
    case 'sus2':
      return { upper: true, modifier: '', ext: 'sus2' };
    case 'sus4':
      return { upper: true, modifier: '', ext: 'sus4' };
    case '5':
      return { upper: true, modifier: '', ext: '5' };
    case '6':
      return { upper: true, modifier: '', ext: '6' };
    case 'min6':
      return { upper: false, modifier: '', ext: '6' };
    case '7':
      return { upper: true, modifier: '', ext: '7' };
    case 'maj7':
      return { upper: true, modifier: '', ext: 'maj7' };
    case 'min7':
      return { upper: false, modifier: '', ext: '7' };
    case 'minmaj7':
      return { upper: false, modifier: '', ext: 'maj7' };
    case 'm7b5':
      return { upper: false, modifier: 'ø', ext: '7' };
    case 'dim7':
      return { upper: false, modifier: '°', ext: '7' };
    case '7sus4':
      return { upper: true, modifier: '', ext: '7sus4' };
    case 'add9':
      return { upper: true, modifier: '', ext: 'add9' };
    case 'minadd9':
      return { upper: false, modifier: '', ext: 'add9' };
    case '9':
      return { upper: true, modifier: '', ext: '9' };
    case 'maj9':
      return { upper: true, modifier: '', ext: 'maj9' };
    case 'min9':
      return { upper: false, modifier: '', ext: '9' };
    case '11':
      return { upper: true, modifier: '', ext: '11' };
    case 'min11':
      return { upper: false, modifier: '', ext: '11' };
    case '13':
    case 'maj13':
      return { upper: true, modifier: '', ext: q === '13' ? '13' : 'maj7' };
    case 'aug7':
      return { upper: true, modifier: '+', ext: '7' };
    case '7b9':
    case '7#9':
      return { upper: true, modifier: '', ext: '7' };
    default:
      return { upper: true, modifier: '', ext: '' };
  }
}

function numeralFor(interval: number, key: KeySignature): { degree: number; accidental: number } {
  const iv = MODE_INTERVALS[key.mode];
  const exact = iv.indexOf(interval);
  if (exact >= 0) return { degree: exact, accidental: 0 };
  // Minor keys: raised 6th/7th degrees (melodic/harmonic minor) are written #vi / #vii.
  if (isMinorMode(key.mode) && (interval === 9 || interval === 11)) {
    const d = iv.indexOf(interval - 1);
    if (d >= 0) return { degree: d, accidental: 1 };
  }
  // Prefer flattened upper degree (bVII, bVI, bIII, bII); #IV for the tritone in major-ish keys.
  if (interval === 6 && !isMinorMode(key.mode)) {
    const d = iv.indexOf(5);
    if (d >= 0) return { degree: d, accidental: 1 };
  }
  const up = iv.indexOf(mod12(interval + 1));
  if (up >= 0) return { degree: up, accidental: -1 };
  const down = iv.indexOf(mod12(interval - 1));
  if (down >= 0) return { degree: down, accidental: 1 };
  return { degree: 0, accidental: 0 };
}

/**
 * Roman numeral for a chord in a key, with secondary-dominant detection (V/V, V7/vi…)
 * and figured-bass inversions for slash chords.
 */
export function chordToRoman(chord: ChordSpec, key: KeySignature): string {
  const interval = mod12(chord.root - key.tonic);
  const { upper, modifier, ext } = suffixForQuality(chord.quality);

  // Secondary dominant: non-diatonic dominant-7th (or major triad not explained by the parallel
  // key's modal interchange) resolving down a fifth to a diatonic, non-tonic chord.
  const explainedByParallel = chord.quality === 'maj' && isDiatonic(chord, parallelKey(key));
  if (!isDiatonic(chord, key) && !explainedByParallel && (chord.quality === 'maj' || isDominantQuality(chord.quality))) {
    const targetInterval = mod12(interval + 5);
    const iv = MODE_INTERVALS[key.mode];
    const td = iv.indexOf(targetInterval);
    if (td > 0) {
      const target = diatonicChord(key, td);
      if (target.quality !== 'dim') {
        const targetUpper = target.quality === 'maj' || target.quality === 'aug';
        const tNum = targetUpper ? NUMERALS[td] : NUMERALS[td].toLowerCase();
        return `V${ext === '7' || isDominantQuality(chord.quality) ? '7' : ''}/${tNum}`;
      }
    }
  }

  const { degree, accidental } = numeralFor(interval, key);
  const acc = accidental === -1 ? 'b' : accidental === 1 ? '#' : '';
  const num = upper ? NUMERALS[degree] : NUMERALS[degree].toLowerCase();
  let figures = '';
  if (chord.bass !== undefined && chord.bass !== chord.root) {
    const bassInterval = mod12(chord.bass - chord.root);
    const ivs = CHORD_INTERVALS[chord.quality].map((i) => i % 12);
    const hasSeventh = ivs.length >= 4;
    const pos = ivs.indexOf(bassInterval);
    if (pos === 1) figures = hasSeventh ? '65' : '6';
    else if (pos === 2) figures = hasSeventh ? '43' : '64';
    else if (pos === 3) figures = '42';
  }
  if (figures && (ext === '7' || ext === '')) return `${acc}${num}${modifier}${figures}`;
  return `${acc}${num}${modifier}${ext}`;
}

/** Diatonic scale degree (0..6) of a chord root, or -1 when chromatic. */
export function chordDegree(chord: ChordSpec, key: KeySignature): number {
  return MODE_INTERVALS[key.mode].indexOf(mod12(chord.root - key.tonic));
}

const BORROW_SOURCES: ModeName[] = ['minor', 'major', 'dorian', 'mixolydian', 'phrygian', 'lydian', 'harmonic-minor'];

/** If the chord is not diatonic but belongs to a parallel mode, return that mode (modal interchange). */
export function borrowedFrom(chord: ChordSpec, key: KeySignature): ModeName | null {
  if (isDiatonic(chord, key)) return null;
  for (const mode of BORROW_SOURCES) {
    if (mode === key.mode) continue;
    if (isDiatonic(chord, { tonic: key.tonic, mode })) return mode;
  }
  return null;
}

/** Realize a roman progression to chord specs; unparseable numerals are skipped. */
export function realizeProgression(romans: readonly string[], key: KeySignature): ChordSpec[] {
  const out: ChordSpec[] = [];
  for (const r of romans) {
    const c = romanToChord(r, key);
    if (c) out.push(c);
  }
  return out;
}
