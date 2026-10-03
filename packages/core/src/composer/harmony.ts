/**
 * Harmony planning helpers (spec §13, §15): progression families, realization in any key/mode,
 * chord colouring by harmonic tension (extensions, borrowed chords, secondary dominants,
 * suspensions) and verse/chorus contrast ("perceptual lift").
 */
import type { ChordQuality, ChordSpec, GenreProfile, KeySignature, ModeName, SectionKind } from '../ir/types';
import { romanToChord } from '../theory/roman';
import { diatonicChord, formatChordSymbol, isDiatonic } from '../theory/chords';
import { mod12 } from '../theory/pitch';
import { MODE_INTERVALS, isMinorMode } from '../theory/scales';
import type { Rng } from '../util/random';
import { clamp01, sameChord } from './util';

const C_MAJOR: KeySignature = { tonic: 0, mode: 'major' };
const C_MINOR: KeySignature = { tonic: 0, mode: 'minor' };

const MAJORISH: ModeName[] = ['major', 'lydian', 'mixolydian'];

export function isModalKey(key: KeySignature): boolean {
  return key.mode !== 'major' && key.mode !== 'minor' && key.mode !== 'harmonic-minor' && key.mode !== 'melodic-minor';
}

function triadOf(c: ChordSpec): ChordSpec {
  const q = c.quality;
  const base: ChordQuality =
    q === 'min' || q === 'min7' || q === 'min9' || q === 'min6' || q === 'minadd9' || q === 'min11' || q === 'minmaj7'
      ? 'min'
      : q === 'dim' || q === 'dim7' || q === 'm7b5'
        ? 'dim'
        : q === 'aug' || q === 'aug7'
          ? 'aug'
          : q === 'sus2' || q === 'sus4' || q === '7sus4'
            ? q === 'sus2' ? 'sus2' : 'sus4'
            : q === '5'
              ? '5'
              : 'maj';
  return { root: c.root, quality: base };
}

/** Whether a roman progression is written from a major or a minor tonic's point of view. */
export function progressionFamily(roman: readonly string[]): 'major' | 'minor' {
  let maj = 0;
  let min = 0;
  for (const r of roman) {
    const a = romanToChord(r, C_MAJOR);
    const b = romanToChord(r, C_MINOR);
    if (a && isDiatonic(triadOf(a), C_MAJOR)) maj++;
    if (b && isDiatonic(triadOf(b), C_MINOR)) min++;
  }
  if (maj === min) return roman.some((r) => /^i(?![iv])|^i$/.test(r) || /^i[^iv]/.test(r)) ? 'minor' : 'major';
  return maj > min ? 'major' : 'minor';
}

/** Characteristic progressions for modal keys, written relative to the mode's own scale. */
export const MODAL_PROGRESSIONS: Partial<Record<ModeName, string[][]>> = {
  dorian: [['i', 'IV'], ['i', 'IV', 'i', 'VII'], ['i', 'III', 'VII', 'IV'], ['i', 'ii', 'III', 'IV'], ['i', 'v', 'VII', 'IV']],
  mixolydian: [['I', 'VII', 'IV', 'I'], ['I', 'v', 'VII', 'IV'], ['I', 'VII', 'I', 'IV'], ['IV', 'VII', 'I']],
  phrygian: [['i', 'II', 'i', 'VII'], ['i', 'II', 'III', 'II'], ['i', 'vii', 'VI', 'II']],
  lydian: [['I', 'II', 'I', 'II'], ['I', 'II', 'vi', 'V'], ['I', 'II', 'iii', 'II']],
  locrian: [['i°', 'II', 'iii', 'II'], ['i°', 'II', 'i°', 'VII']],
};

/**
 * Realize roman numerals in a key. Progressions are re-targeted by family: a major-family
 * progression in a minor key is played from the relative major (I–V–vi–IV in E minor → G–D–Em–C),
 * a minor-family one in a major key from the relative minor. Harmonic/melodic minor keys get a
 * major dominant.
 */
export function realizeRomans(roman: readonly string[], key: KeySignature, direct = false): ChordSpec[] {
  let realKey: KeySignature = key;
  if (!direct) {
    const fam = progressionFamily(roman);
    const keyMajorish = MAJORISH.includes(key.mode);
    if (fam === 'major') realKey = keyMajorish ? { tonic: key.tonic, mode: 'major' } : { tonic: mod12(key.tonic + 3), mode: 'major' };
    else realKey = keyMajorish ? { tonic: mod12(key.tonic + 9), mode: 'minor' } : { tonic: key.tonic, mode: 'minor' };
  }
  const out: ChordSpec[] = [];
  for (const r of roman) {
    const c = romanToChord(r, realKey);
    if (!c) continue;
    // Harmonic / melodic minor: the dominant is major.
    if ((key.mode === 'harmonic-minor' || key.mode === 'melodic-minor') && mod12(c.root - key.tonic) === 7) {
      if (c.quality === 'min') c.quality = 'maj';
      else if (c.quality === 'min7') c.quality = '7';
    }
    out.push(c);
  }
  return out;
}

function diatonicFraction(chords: readonly ChordSpec[], key: KeySignature): number {
  if (!chords.length) return 0;
  return chords.filter((c) => isDiatonic(triadOf(c), key)).length / chords.length;
}

export interface ProgressionCandidate {
  chords: ChordSpec[];
  weight: number;
  roman: string[];
}

/** All progressions of a genre usable for a section kind in a key. */
export function candidateProgressions(genre: GenreProfile, key: KeySignature, kind: SectionKind): ProgressionCandidate[] {
  const out: ProgressionCandidate[] = [];
  const modal = isModalKey(key);
  for (const pr of genre.harmony.progressions) {
    let w = pr.weight;
    if (pr.sectionKinds && pr.sectionKinds.length) {
      if (!pr.sectionKinds.includes(kind)) continue;
      w *= 1.8;
    }
    const chords = realizeRomans(pr.roman, key);
    if (!chords.length) continue;
    if (modal && diatonicFraction(chords, key) < 0.75) continue;
    out.push({ chords, weight: w, roman: [...pr.roman] });
  }
  if (modal) {
    for (const r of MODAL_PROGRESSIONS[key.mode] ?? []) {
      const chords = realizeRomans(r, key, true);
      if (chords.length) out.push({ chords, weight: 3, roman: r });
    }
  }
  if (!out.length) {
    const fallback = isMinorMode(key.mode) ? ['i', 'VI', 'III', 'VII'] : ['I', 'V', 'vi', 'IV'];
    out.push({ chords: realizeRomans(fallback, key), weight: 1, roman: fallback });
  }
  return out;
}

function sameSequence(a: readonly ChordSpec[], b: readonly ChordSpec[]): boolean {
  return a.length === b.length && a.every((c, i) => sameChord(c, b[i]));
}

function sameSet(a: readonly ChordSpec[], b: readonly ChordSpec[]): boolean {
  const key = (c: ChordSpec) => `${c.root}:${triadOf(c).quality}`;
  const sa = new Set(a.map(key));
  const sb = new Set(b.map(key));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** Interval (0..11) of a chord root above the key tonic. */
function rootInterval(c: ChordSpec, key: KeySignature): number {
  return mod12(c.root - key.tonic);
}

function isTonic(c: ChordSpec, key: KeySignature): boolean {
  return rootInterval(c, key) === 0;
}

/** Chorus "lift": in minor keys the relative major (III) or VI, in major keys I or IV. */
function liftFactor(first: ChordSpec, key: KeySignature): number {
  const iv = rootInterval(first, key);
  if (isMinorMode(key.mode)) {
    if (iv === 3) return 2.6;
    if (iv === 8) return 2.0;
    if (iv === 0) return 1.0;
    return 0.8;
  }
  if (iv === 0) return 2.4;
  if (iv === 5) return 1.8;
  if (iv === 9) return 0.7;
  return 1;
}

function isDominantFunction(c: ChordSpec, key: KeySignature): boolean {
  const iv = rootInterval(c, key);
  return iv === 7 || iv === 5 || iv === 2 || (isMinorMode(key.mode) && iv === 10) || iv === 11;
}

function rotations(chords: readonly ChordSpec[]): ChordSpec[][] {
  const out: ChordSpec[][] = [];
  for (let i = 1; i < chords.length; i++) out.push([...chords.slice(i), ...chords.slice(0, i)]);
  return out;
}

export interface PlannedHarmony {
  verse?: ChordSpec[];
  chorus?: ChordSpec[];
  pre?: ChordSpec[];
  bridge?: ChordSpec[];
}

/**
 * Choose a progression for a section kind, scoring candidates for musical function:
 * choruses lift away from the verse, pre-choruses end on a dominant-function chord,
 * bridges avoid starting on the tonic and contrast with both.
 */
export function chooseProgression(
  genre: GenreProfile,
  key: KeySignature,
  kind: SectionKind,
  planned: PlannedHarmony,
  rng: Rng,
): ChordSpec[] {
  const cands = candidateProgressions(genre, key, kind);
  const scored: { chords: ChordSpec[]; w: number }[] = [];
  const add = (chords: ChordSpec[], w: number) => scored.push({ chords, w });
  for (const c of cands) {
    let w = c.weight;
    const first = c.chords[0];
    const last = c.chords[c.chords.length - 1];
    switch (kind) {
      case 'verse':
      case 'intro':
      case 'interlude':
      case 'custom':
        // Verses sit on the home chord (i / vi-ish): tonic or relative start.
        if (isTonic(first, key)) w *= 1.8;
        break;
      case 'chorus':
      case 'final-chorus':
      case 'drop':
      case 'post-chorus':
        w *= liftFactor(first, key);
        if (planned.verse) {
          if (sameSequence(c.chords, planned.verse)) w *= 0.12;
          else if (sameSet(c.chords, planned.verse)) w *= 1.3;
        }
        break;
      case 'pre-chorus':
      case 'build':
        if (isDominantFunction(last, key)) w *= 2;
        if (isTonic(last, key)) w *= 0.4;
        if (isTonic(first, key)) w *= 0.5;
        if (planned.verse && sameSequence(c.chords, planned.verse)) w *= 0.2;
        if (planned.chorus && sameSequence(c.chords, planned.chorus)) w *= 0.2;
        break;
      case 'bridge':
      case 'breakdown':
      case 'solo':
        w *= isTonic(first, key) ? 0.5 : 1.8;
        if (planned.verse && sameSequence(c.chords, planned.verse)) w *= 0.25;
        if (planned.chorus && sameSequence(c.chords, planned.chorus)) w *= 0.25;
        break;
      default:
        break;
    }
    add(c.chords, w);
  }
  // The classic lift: the verse progression rotated to start on the lift chord (Em–C–G–D → G–D–Em–C).
  if ((kind === 'chorus' || kind === 'final-chorus' || kind === 'drop') && planned.verse && planned.verse.length >= 3) {
    for (const rot of rotations(planned.verse)) {
      const lf = liftFactor(rot[0], key);
      if (lf >= 1.8) add(rot, 3.2 * lf);
    }
  }
  return rng.weighted(
    scored.map((x) => x.chords),
    scored.map((x) => x.w),
  ).map((c) => ({ ...c }));
}

// ---------------------------------------------------------------------------
// Colouring
// ---------------------------------------------------------------------------

export interface ColorOptions {
  extensionRate: number;
  borrowedRate: number;
  /** macros.harmonicTension 0..1 */
  tension: number;
  /** -1 (bright) … +1 (dark) from moods. */
  darkness: number;
  powerChords: boolean;
  /** Genre flavour for extension choices. */
  flavor: 'jazz' | 'soul' | 'pop' | 'rock' | 'ambient' | 'classical';
  /** Keep the first chord as written (a chorus's lift chord, a verse's home chord). */
  protectFirst?: boolean;
}

function extendChord(c: ChordSpec, key: KeySignature, flavor: ColorOptions['flavor'], rng: Rng): ChordSpec {
  const iv = rootInterval(c, key);
  const dominant = iv === 7 && (c.quality === 'maj' || c.quality === '7');
  if (flavor === 'classical' && !dominant) return c;
  // Diatonic chords take the key's own seventh (VII7 not VIImaj7 in minor) or a diatonic add9.
  if (isDiatonic(c, key)) {
    const scale = MODE_INTERVALS[key.mode].map((i) => mod12(key.tonic + i));
    const degree = scale.indexOf(c.root);
    if (degree >= 0) {
      const seventh = diatonicChord(key, degree, true).quality;
      const ninthOk = scale.includes(mod12(c.root + 2));
      const wantsAdd9 = (flavor === 'pop' || flavor === 'rock' || flavor === 'ambient') && ninthOk && rng.chance(flavor === 'pop' ? 0.45 : 0.65);
      if (wantsAdd9 && (c.quality === 'maj' || c.quality === 'min')) return { ...c, quality: c.quality === 'maj' ? 'add9' : 'minadd9' };
      if ((flavor === 'jazz' || flavor === 'soul') && ninthOk && rng.chance(0.3)) {
        if (seventh === 'maj7') return { ...c, quality: 'maj9' };
        if (seventh === 'min7') return { ...c, quality: 'min9' };
        if (seventh === '7') return { ...c, quality: '9' };
      }
      return { ...c, quality: seventh };
    }
  }
  switch (c.quality) {
    case 'maj':
      if (dominant) return { ...c, quality: flavor === 'jazz' && rng.chance(0.3) ? '9' : '7' };
      if (flavor === 'jazz') return { ...c, quality: rng.chance(0.3) ? 'maj9' : iv === 0 && rng.chance(0.25) ? '6' : 'maj7' };
      if (flavor === 'soul') return { ...c, quality: rng.chance(0.4) ? 'maj9' : 'maj7' };
      if (flavor === 'ambient' || flavor === 'rock') return { ...c, quality: rng.chance(0.7) ? 'add9' : 'maj7' };
      if (flavor === 'classical') return c;
      return { ...c, quality: rng.chance(0.55) ? 'add9' : 'maj7' };
    case 'min':
      if (flavor === 'jazz' || flavor === 'soul') return { ...c, quality: rng.chance(0.35) ? 'min9' : 'min7' };
      if (flavor === 'ambient' || flavor === 'rock') return { ...c, quality: rng.chance(0.6) ? 'minadd9' : 'min7' };
      if (flavor === 'classical') return c;
      return { ...c, quality: rng.chance(0.6) ? 'min7' : 'minadd9' };
    case 'dim':
      return { ...c, quality: 'm7b5' };
    default:
      return c;
  }
}

/**
 * Colour a progression by harmonic tension and mood. Decisions are made per distinct chord so a
 * repeating chord keeps the same colour every time it returns.
 */
export function colorProgression(chords: readonly ChordSpec[], key: KeySignature, o: ColorOptions, rng: Rng): ChordSpec[] {
  const minorKey = isMinorMode(key.mode);
  const tension = clamp01(o.tension);
  let out = chords.map((c) => ({ ...c }));
  const pick = <T>(cache: Map<string, T>, c: ChordSpec, f: () => T): T => {
    const k = `${c.root}:${c.quality}:${c.bass ?? ''}`;
    if (!cache.has(k)) cache.set(k, f());
    return cache.get(k)!;
  };

  // 1. Modal interchange (borrowed chords) — darker moods borrow more.
  const pBorrow = clamp01(o.borrowedRate * (0.5 + Math.max(0, o.darkness)) + tension * 0.08);
  const borrowCache = new Map<string, ChordSpec>();
  out = out.map((c, i) =>
    o.protectFirst && sameChord(c, chords[0]) ? c : pick(borrowCache, c, () => {
      if (!rng.chance(pBorrow)) return c;
      const iv = rootInterval(c, key);
      if (!minorKey) {
        if (iv === 5 && c.quality === 'maj') return { root: c.root, quality: 'min' }; // iv (minor plagal)
        if (iv === 9 && c.quality === 'min' && o.darkness > 0) return { root: mod12(key.tonic + 8), quality: 'maj' }; // bVI
        if (iv === 7 && c.quality === 'maj' && i < chords.length - 1 && o.darkness > 0) return { root: mod12(key.tonic + 10), quality: 'maj' }; // bVII
      } else {
        if (iv === 7 && c.quality === 'min') return { root: c.root, quality: tension > 0.5 ? '7' : 'maj' }; // harmonic-minor V
        if (iv === 5 && c.quality === 'min' && o.darkness < 0.1) return { root: c.root, quality: 'maj' }; // dorian IV
      }
      return c;
    }),
  );

  // 2. Secondary dominant: the chord before a non-tonic target becomes V(7)/target.
  if (!o.powerChords && out.length >= 3 && rng.chance(tension * 0.45)) {
    const targets: number[] = [];
    for (let t = 2; t < out.length; t++) {
      const tc = out[t];
      const tq = triadOf(tc).quality;
      if ((tq === 'maj' || tq === 'min') && !isTonic(tc, key) && !sameChord(out[t - 1], tc)) targets.push(t);
    }
    if (targets.length) {
      const t = rng.pick(targets);
      out[t - 1] = { root: mod12(out[t].root + 7), quality: tension > 0.55 ? '7' : 'maj' };
    }
  }

  // 3. Extensions (7ths, 9ths, add9).
  if (!o.powerChords) {
    const pExt = clamp01(o.extensionRate * (0.55 + tension));
    const extCache = new Map<string, ChordSpec>();
    out = out.map((c) => pick(extCache, c, () => (rng.chance(pExt) ? extendChord(c, key, o.flavor, rng) : c)));
  }

  // 4. Suspensions as colour (sus2 on tonic/subdominant, sus4 on dominant).
  const pSus = tension * (o.powerChords ? 0.1 : 0.16);
  const susCache = new Map<string, ChordSpec>();
  out = out.map((c) =>
    pick(susCache, c, () => {
      if (c.quality !== 'maj' && c.quality !== 'min') return c;
      if (!rng.chance(pSus)) return c;
      const iv = rootInterval(c, key);
      if (iv === 7 && c.quality === 'maj') return { ...c, quality: 'sus4' };
      if (iv === 0 || iv === 5) return { ...c, quality: 'sus2' };
      return c;
    }),
  );
  return out;
}

export function flavorFor(genre: GenreProfile): ColorOptions['flavor'] {
  const d = genre.rhythm.drumStyle;
  if (d === 'jazz-swing') return 'jazz';
  if (d === 'rnb' || d === 'hip-hop' || d === 'trap' || (d === 'four-on-floor' && genre.harmony.extensionRate > 0.4)) return 'soul';
  if (d === 'orchestral') return 'classical';
  if (d === 'cinematic' || d === 'trance' || d === 'emo' || d === 'indie') return 'ambient';
  if (d === 'rock' || d === 'punk' || d === 'pop-punk' || d === 'metal') return 'rock';
  return 'pop';
}

// ---------------------------------------------------------------------------
// Harmonic rhythm & expansion to plan slots
// ---------------------------------------------------------------------------

/** Snap a (possibly blended) chords-per-bar value to 0.5, 1 or 2. */
export function snapHarmonicRhythm(hr: number): number {
  if (!(hr > 0)) return 1;
  const opts = [0.5, 1, 2];
  let best = 1;
  let bestD = Infinity;
  for (const o of opts) {
    const d = Math.abs(Math.log2(hr) - Math.log2(o));
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * Expand a progression into the plan's harmony list: with hr = 1 the cycle itself (it repeats to
 * fill the section), hr = 0.5 each chord doubled, hr = 2 enough entries for two chords per bar.
 * Optional `susResolve` turns the final chord into "Xsus4 → X" (two slots in the last bar).
 */
export function expandHarmony(chords: readonly ChordSpec[], bars: number, hr: number, key: KeySignature, opts: { endOnTonic?: boolean; susResolve?: boolean } = {}): string[] {
  if (!chords.length) return [formatChordSymbol({ root: key.tonic, quality: isMinorMode(key.mode) ? 'min' : 'maj' }, key)];
  const n = chords.length;
  const B = Math.max(1, Math.round(bars));
  let perBar: number;
  let full: ChordSpec[];
  let plainCycle = false;
  if (hr >= 2) {
    perBar = 2;
    full = Array.from({ length: B * 2 }, (_, i) => chords[i % n]);
  } else if (hr <= 0.5 && B >= 2 * n) {
    perBar = 1;
    full = Array.from({ length: B }, (_, i) => chords[Math.floor(i / 2) % n]);
  } else if (n > B) {
    perBar = Math.ceil(n / B);
    full = Array.from({ length: B * perBar }, (_, i) => chords[i % n]);
  } else {
    perBar = 1;
    full = Array.from({ length: B }, (_, i) => chords[i % n]);
    plainCycle = true;
  }
  if (opts.endOnTonic) {
    const last = full[full.length - 1];
    if (mod12(last.root - key.tonic) !== 0) {
      full[full.length - 1] = { root: key.tonic, quality: isMinorMode(key.mode) ? 'min' : 'maj' };
      plainCycle = false;
    }
  }
  if (opts.susResolve) {
    const last = full[full.length - 1];
    if (last.quality === 'maj' || last.quality === '7') {
      if (perBar === 1) full = full.flatMap((c) => [c, c]);
      full[full.length - 2] = { root: last.root, quality: 'sus4' };
      plainCycle = false;
    }
  }
  // A plain cycle at one chord per bar is written once ("Em–C–G–D" for an 8-bar verse).
  const list = plainCycle ? chords.slice() : full;
  return list.map((c) => formatChordSymbol(c, key));
}

/** Slots per bar implied by a harmony list (see `expandHarmony`). */
export function slotsPerBarFor(harmonyLength: number, bars: number): number {
  if (bars <= 0 || harmonyLength <= bars) return 1;
  return Math.max(1, Math.ceil(harmonyLength / bars));
}

/** Mood words → darkness −1 (bright) … +1 (dark). */
export function moodDarkness(moods: readonly string[]): number {
  const DARK = ['melancholy', 'melancholic', 'sad', 'dark', 'brooding', 'angry', 'aggressive', 'haunting', 'mysterious', 'somber', 'sombre', 'lonely', 'heartbroken', 'desperate', 'tense', 'eerie', 'moody', 'wistful', 'bittersweet', 'fierce', 'intense'];
  const BRIGHT = ['happy', 'joyful', 'uplifting', 'hopeful', 'triumphant', 'playful', 'euphoric', 'bright', 'romantic', 'peaceful', 'anthemic', 'heroic', 'majestic', 'sunny'];
  let d = 0;
  let n = 0;
  for (const m of moods) {
    const w = m.toLowerCase();
    for (const x of DARK) if (w.includes(x)) {
      d += 1;
      n++;
    }
    for (const x of BRIGHT) if (w.includes(x)) {
      d -= 1;
      n++;
    }
  }
  return n ? Math.max(-1, Math.min(1, d / n)) : 0;
}
