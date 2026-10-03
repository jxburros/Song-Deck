import type {
  Articulation,
  InstrumentFamily,
  InstrumentProfile,
  MusicalFunction,
  StemGroup,
  Track,
  TrackRole,
} from '../ir/types';
import { GM_PROGRAM_NAMES } from '../ir/gm';
import { STEM_COLORS } from '../ir/palette';

/**
 * Instrument lookup used by the Validation Engine and the serializers.
 *
 * The canonical instrument catalogue lives in `composer/` (`getInstrument`). To keep `edit/` and
 * `io/` free of a dependency on the composition engine, every lookup goes through
 * {@link lookupInstrument}, which tries, in order:
 *   1. caller-provided custom profiles (project-bundled `customInstruments`),
 *   2. an injected resolver (`resolveInstrument` option — wire composer's `getInstrument` here),
 *   3. the small private fallback table below (+ keyword heuristics for unknown ids).
 *
 * Ids of the form `gm-<program>` (created by MIDI import for programs without a dedicated
 * profile) always resolve to a profile carrying that General MIDI program.
 */

export type InstrumentResolver = (id: string) => InstrumentProfile | undefined;

export interface InstrumentLookupOptions {
  customInstruments?: InstrumentProfile[];
  resolveInstrument?: InstrumentResolver;
}

type Clef = InstrumentProfile['clef'];

interface Row {
  id: string;
  name: string;
  family: InstrumentFamily;
  gm: number;
  low: number;
  high: number;
  poly: 'mono' | 'poly';
  role: TrackRole;
  fn: MusicalFunction;
  clef: Clef;
  stem: StemGroup;
  drum?: boolean;
  transpose?: number;
  comfortable?: [number, number];
}

const ROWS: Row[] = [
  // Ids match composer/instruments (BUILTIN_INSTRUMENTS) so imported and composed songs agree.
  {
    id: 'drum-kit',
    name: 'Drum Kit',
    family: 'drums',
    gm: 0,
    low: 27,
    high: 87,
    poly: 'poly',
    role: 'drums',
    fn: 'rhythm',
    clef: 'percussion',
    stem: 'drums',
    drum: true,
  },
  {
    id: 'electronic-kit',
    name: 'Electronic Drum Kit',
    family: 'drums',
    gm: 25,
    low: 27,
    high: 87,
    poly: 'poly',
    role: 'drums',
    fn: 'rhythm',
    clef: 'percussion',
    stem: 'drums',
    drum: true,
  },
  {
    id: 'percussion',
    name: 'Percussion',
    family: 'percussion',
    gm: 0,
    low: 27,
    high: 87,
    poly: 'poly',
    role: 'percussion',
    fn: 'rhythm',
    clef: 'percussion',
    stem: 'drums',
    drum: true,
  },
  {
    id: 'electric-bass',
    name: 'Electric Bass',
    family: 'bass',
    gm: 33,
    low: 28,
    high: 67,
    poly: 'mono',
    role: 'bass',
    fn: 'bass-line',
    clef: 'bass',
    stem: 'bass',
    transpose: 12,
    comfortable: [28, 55],
  },
  {
    id: 'upright-bass',
    name: 'Upright Bass',
    family: 'bass',
    gm: 32,
    low: 28,
    high: 67,
    poly: 'mono',
    role: 'bass',
    fn: 'bass-line',
    clef: 'bass',
    stem: 'bass',
    transpose: 12,
  },
  {
    id: 'synth-bass',
    name: 'Synth Bass',
    family: 'bass',
    gm: 38,
    low: 24,
    high: 72,
    poly: 'mono',
    role: 'bass',
    fn: 'bass-line',
    clef: 'bass',
    stem: 'bass',
  },
  {
    id: 'electric-guitar-clean',
    name: 'Clean Electric Guitar',
    family: 'guitar',
    gm: 27,
    low: 40,
    high: 88,
    poly: 'poly',
    role: 'rhythm-guitar',
    fn: 'accompaniment',
    clef: 'treble-8vb',
    stem: 'guitars',
    transpose: 12,
  },
  {
    id: 'electric-guitar-distorted',
    name: 'Distorted Guitar',
    family: 'guitar',
    gm: 30,
    low: 40,
    high: 88,
    poly: 'poly',
    role: 'rhythm-guitar',
    fn: 'accompaniment',
    clef: 'treble-8vb',
    stem: 'guitars',
    transpose: 12,
  },
  {
    id: 'electric-guitar-lead',
    name: 'Lead Guitar',
    family: 'guitar',
    gm: 29,
    low: 40,
    high: 90,
    poly: 'poly',
    role: 'lead-guitar',
    fn: 'melody',
    clef: 'treble-8vb',
    stem: 'guitars',
    transpose: 12,
  },
  {
    id: 'acoustic-guitar',
    name: 'Acoustic Guitar',
    family: 'guitar',
    gm: 25,
    low: 40,
    high: 84,
    poly: 'poly',
    role: 'rhythm-guitar',
    fn: 'accompaniment',
    clef: 'treble-8vb',
    stem: 'guitars',
    transpose: 12,
  },
  {
    id: 'piano',
    name: 'Piano',
    family: 'keys',
    gm: 0,
    low: 21,
    high: 108,
    poly: 'poly',
    role: 'keys',
    fn: 'accompaniment',
    clef: 'grand',
    stem: 'keys',
  },
  {
    id: 'electric-piano',
    name: 'Electric Piano',
    family: 'keys',
    gm: 4,
    low: 28,
    high: 103,
    poly: 'poly',
    role: 'keys',
    fn: 'accompaniment',
    clef: 'grand',
    stem: 'keys',
  },
  {
    id: 'organ',
    name: 'Organ',
    family: 'organ',
    gm: 16,
    low: 36,
    high: 96,
    poly: 'poly',
    role: 'keys',
    fn: 'pad',
    clef: 'grand',
    stem: 'keys',
  },
  {
    id: 'glockenspiel',
    name: 'Glockenspiel',
    family: 'percussion',
    gm: 9,
    low: 72,
    high: 108,
    poly: 'poly',
    role: 'custom',
    fn: 'texture',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'marimba',
    name: 'Marimba',
    family: 'percussion',
    gm: 12,
    low: 45,
    high: 96,
    poly: 'poly',
    role: 'custom',
    fn: 'accompaniment',
    clef: 'grand',
    stem: 'others',
  },
  {
    id: 'timpani',
    name: 'Timpani',
    family: 'percussion',
    gm: 47,
    low: 40,
    high: 60,
    poly: 'poly',
    role: 'percussion',
    fn: 'rhythm',
    clef: 'bass',
    stem: 'others',
  },
  {
    id: 'string-ensemble',
    name: 'String Ensemble',
    family: 'strings',
    gm: 48,
    low: 28,
    high: 96,
    poly: 'poly',
    role: 'strings',
    fn: 'pad',
    clef: 'grand',
    stem: 'strings',
  },
  {
    id: 'pizzicato-strings',
    name: 'Pizzicato Strings',
    family: 'strings',
    gm: 45,
    low: 28,
    high: 96,
    poly: 'poly',
    role: 'strings',
    fn: 'accompaniment',
    clef: 'grand',
    stem: 'strings',
  },
  {
    id: 'synth-strings',
    name: 'Synth Strings',
    family: 'strings',
    gm: 50,
    low: 28,
    high: 96,
    poly: 'poly',
    role: 'strings',
    fn: 'pad',
    clef: 'grand',
    stem: 'strings',
  },
  {
    id: 'violin',
    name: 'Violin',
    family: 'strings',
    gm: 40,
    low: 55,
    high: 103,
    poly: 'mono',
    role: 'strings',
    fn: 'counter-melody',
    clef: 'treble',
    stem: 'strings',
    comfortable: [55, 93],
  },
  {
    id: 'viola',
    name: 'Viola',
    family: 'strings',
    gm: 41,
    low: 48,
    high: 88,
    poly: 'mono',
    role: 'strings',
    fn: 'harmony',
    clef: 'treble',
    stem: 'strings',
  },
  {
    id: 'cello',
    name: 'Cello',
    family: 'strings',
    gm: 42,
    low: 36,
    high: 76,
    poly: 'mono',
    role: 'strings',
    fn: 'counter-melody',
    clef: 'bass',
    stem: 'strings',
  },
  {
    id: 'contrabass',
    name: 'Contrabass',
    family: 'strings',
    gm: 43,
    low: 28,
    high: 67,
    poly: 'mono',
    role: 'bass',
    fn: 'bass-line',
    clef: 'bass',
    stem: 'bass',
    transpose: 12,
  },
  {
    id: 'harp',
    name: 'Harp',
    family: 'strings',
    gm: 46,
    low: 23,
    high: 103,
    poly: 'poly',
    role: 'keys',
    fn: 'accompaniment',
    clef: 'grand',
    stem: 'strings',
  },
  {
    id: 'trumpet',
    name: 'Trumpet',
    family: 'brass',
    gm: 56,
    low: 52,
    high: 84,
    poly: 'mono',
    role: 'custom',
    fn: 'melody',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'trombone',
    name: 'Trombone',
    family: 'brass',
    gm: 57,
    low: 40,
    high: 72,
    poly: 'mono',
    role: 'custom',
    fn: 'harmony',
    clef: 'bass',
    stem: 'others',
  },
  {
    id: 'french-horn',
    name: 'French Horn',
    family: 'brass',
    gm: 60,
    low: 34,
    high: 77,
    poly: 'mono',
    role: 'custom',
    fn: 'harmony',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'tuba',
    name: 'Tuba',
    family: 'brass',
    gm: 58,
    low: 28,
    high: 58,
    poly: 'mono',
    role: 'bass',
    fn: 'bass-line',
    clef: 'bass',
    stem: 'others',
  },
  {
    id: 'brass-section',
    name: 'Brass Section',
    family: 'brass',
    gm: 61,
    low: 40,
    high: 84,
    poly: 'poly',
    role: 'custom',
    fn: 'hook',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'saxophone',
    name: 'Saxophone',
    family: 'woodwind',
    gm: 65,
    low: 49,
    high: 81,
    poly: 'mono',
    role: 'custom',
    fn: 'melody',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'tenor-sax',
    name: 'Tenor Saxophone',
    family: 'woodwind',
    gm: 66,
    low: 44,
    high: 76,
    poly: 'mono',
    role: 'custom',
    fn: 'melody',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'flute',
    name: 'Flute',
    family: 'woodwind',
    gm: 73,
    low: 60,
    high: 96,
    poly: 'mono',
    role: 'custom',
    fn: 'counter-melody',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'clarinet',
    name: 'Clarinet',
    family: 'woodwind',
    gm: 71,
    low: 50,
    high: 91,
    poly: 'mono',
    role: 'custom',
    fn: 'counter-melody',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'oboe',
    name: 'Oboe',
    family: 'woodwind',
    gm: 68,
    low: 58,
    high: 91,
    poly: 'mono',
    role: 'custom',
    fn: 'counter-melody',
    clef: 'treble',
    stem: 'others',
  },
  {
    id: 'synth-pad',
    name: 'Synth Pad',
    family: 'synth',
    gm: 89,
    low: 36,
    high: 96,
    poly: 'poly',
    role: 'synth-pad',
    fn: 'pad',
    clef: 'grand',
    stem: 'keys',
  },
  {
    id: 'synth-lead',
    name: 'Synth Lead',
    family: 'synth',
    gm: 81,
    low: 48,
    high: 96,
    poly: 'mono',
    role: 'synth-lead',
    fn: 'melody',
    clef: 'treble',
    stem: 'keys',
  },
  {
    id: 'synth-arp',
    name: 'Synth Arp',
    family: 'synth',
    gm: 80,
    low: 36,
    high: 96,
    poly: 'poly',
    role: 'synth-arp',
    fn: 'texture',
    clef: 'treble',
    stem: 'keys',
  },
  {
    id: 'synth-seq',
    name: 'Synth Sequence',
    family: 'synth',
    gm: 87,
    low: 24,
    high: 96,
    poly: 'poly',
    role: 'synth-seq',
    fn: 'rhythm',
    clef: 'treble',
    stem: 'keys',
  },
  {
    id: 'lead-vocal',
    name: 'Lead Vocal',
    family: 'vocal',
    gm: 53,
    low: 45,
    high: 84,
    poly: 'mono',
    role: 'vocal',
    fn: 'melody',
    clef: 'treble',
    stem: 'vocals',
    comfortable: [52, 76],
  },
  {
    id: 'backing-vocal',
    name: 'Backing Vocals',
    family: 'vocal',
    gm: 52,
    low: 45,
    high: 84,
    poly: 'poly',
    role: 'vocal',
    fn: 'harmony',
    clef: 'treble',
    stem: 'vocals',
  },
  {
    id: 'choir',
    name: 'Choir',
    family: 'vocal',
    gm: 52,
    low: 40,
    high: 84,
    poly: 'poly',
    role: 'vocal',
    fn: 'pad',
    clef: 'grand',
    stem: 'vocals',
  },
];

const GENERIC: Row = {
  id: 'generic',
  name: 'Instrument',
  family: 'other',
  gm: 0,
  low: 21,
  high: 108,
  poly: 'poly',
  role: 'custom',
  fn: 'accompaniment',
  clef: 'treble',
  stem: 'others',
};

/** Keyword heuristics for instrument ids that are not in the table (checked in order). */
const KEYWORDS: [RegExp, string][] = [
  [/electr.*(drum|kit)|808|909/, 'electronic-kit'],
  [/drum|kit|kick|snare|hat|cymbal|beat/, 'drum-kit'],
  [/timpani/, 'timpani'],
  [/perc|shaker|tambourine|conga|bongo|clap/, 'percussion'],
  [/synth.?bass|sub.?bass|bass.?synth/, 'synth-bass'],
  [/contrabass/, 'contrabass'],
  [/upright|double.?bass|acoustic.?bass/, 'upright-bass'],
  [/bass/, 'electric-bass'],
  [/acoustic.*guitar|guitar.*acoustic|nylon|classical.?guitar/, 'acoustic-guitar'],
  [/lead.?guitar|guitar.?lead|solo.?guitar/, 'electric-guitar-lead'],
  [/dist|heavy|metal|fuzz|overdrive|crunch/, 'electric-guitar-distorted'],
  [/guitar/, 'electric-guitar-clean'],
  [/rhodes|wurli|e.?piano|electric.?piano/, 'electric-piano'],
  [/piano|keys|keyboard|clav/, 'piano'],
  [/organ|hammond/, 'organ'],
  [/glock|celesta|bells/, 'glockenspiel'],
  [/marimba|xylo|vibra/, 'marimba'],
  [/violin|fiddle/, 'violin'],
  [/viola/, 'viola'],
  [/cello/, 'cello'],
  [/pizz/, 'pizzicato-strings'],
  [/synth.?string/, 'synth-strings'],
  [/string|orchestra/, 'string-ensemble'],
  [/harp/, 'harp'],
  [/trumpet|cornet|flugel/, 'trumpet'],
  [/trombone/, 'trombone'],
  [/horn/, 'french-horn'],
  [/tuba/, 'tuba'],
  [/brass/, 'brass-section'],
  [/tenor.?sax/, 'tenor-sax'],
  [/sax/, 'saxophone'],
  [/flute|piccolo|recorder/, 'flute'],
  [/clarinet/, 'clarinet'],
  [/oboe|bassoon/, 'oboe'],
  [/pad/, 'synth-pad'],
  [/arp/, 'synth-arp'],
  [/seq/, 'synth-seq'],
  [/choir/, 'choir'],
  [/backing|harmony.?vocal|bgv/, 'backing-vocal'],
  [/vocal|voice|vox|sing|melody/, 'lead-vocal'],
  [/lead|synth/, 'synth-lead'],
];

const ARTICULATIONS_BY_FAMILY: Partial<Record<InstrumentFamily, Articulation[]>> = {
  drums: ['normal', 'accent', 'ghost'],
  percussion: ['normal', 'accent', 'ghost'],
  bass: ['normal', 'staccato', 'legato', 'accent', 'palm-mute', 'slide', 'ghost', 'dead'],
  guitar: [
    'normal',
    'staccato',
    'legato',
    'accent',
    'palm-mute',
    'slide',
    'bend',
    'harmonic',
    'dead',
    'tremolo',
  ],
  strings: ['normal', 'staccato', 'legato', 'accent', 'marcato', 'tenuto', 'pizzicato', 'tremolo'],
  vocal: ['normal', 'legato', 'accent', 'staccato'],
};

function rowToProfile(row: Row, id = row.id, name = row.name): InstrumentProfile {
  const profile: InstrumentProfile = {
    id,
    name,
    family: row.family,
    gmProgram: row.gm,
    range: { low: row.low, high: row.high },
    polyphony: row.poly,
    defaultRole: row.role,
    defaultFunction: row.fn,
    articulations: ARTICULATIONS_BY_FAMILY[row.family] ?? [
      'normal',
      'staccato',
      'legato',
      'accent',
      'marcato',
      'tenuto',
    ],
    patchId: row.id,
    clef: row.clef,
    stemGroup: row.stem,
  };
  if (row.comfortable) {
    profile.range.comfortableLow = row.comfortable[0];
    profile.range.comfortableHigh = row.comfortable[1];
  }
  if (row.drum) profile.isDrumKit = true;
  if (row.transpose) profile.notationTranspose = row.transpose;
  return profile;
}

const BY_ID = new Map(ROWS.map((r) => [r.id, r] as const));

/** GM family (program / 8) → fallback row for `gm-<n>` ids. */
const GM_FAMILY_ROWS: Row[] = [
  BY_ID.get('piano')!,
  BY_ID.get('marimba')!,
  BY_ID.get('organ')!,
  BY_ID.get('electric-guitar-clean')!,
  BY_ID.get('electric-bass')!,
  BY_ID.get('string-ensemble')!,
  BY_ID.get('string-ensemble')!,
  BY_ID.get('brass-section')!,
  BY_ID.get('saxophone')!,
  BY_ID.get('flute')!,
  BY_ID.get('synth-lead')!,
  BY_ID.get('synth-pad')!,
  {
    ...GENERIC,
    id: 'gm-fx',
    family: 'fx',
    low: 24,
    high: 108,
    role: 'custom',
    fn: 'texture',
    stem: 'others',
  },
  { ...GENERIC, id: 'gm-ethnic', family: 'other', low: 36, high: 96, stem: 'others' },
  {
    ...GENERIC,
    id: 'gm-percussive',
    family: 'percussion',
    low: 36,
    high: 96,
    role: 'percussion',
    fn: 'rhythm',
    stem: 'drums',
  },
  {
    ...GENERIC,
    id: 'gm-sfx',
    family: 'fx',
    low: 21,
    high: 108,
    role: 'custom',
    fn: 'texture',
    stem: 'others',
  },
];

/** Canonical instrument ids for General MIDI programs that have a dedicated fallback profile. */
const GM_PROGRAM_IDS: Record<number, string> = {
  0: 'piano',
  1: 'piano',
  2: 'piano',
  3: 'piano',
  4: 'electric-piano',
  5: 'electric-piano',
  6: 'piano',
  7: 'piano',
  8: 'glockenspiel',
  9: 'glockenspiel',
  10: 'glockenspiel',
  11: 'marimba',
  12: 'marimba',
  13: 'marimba',
  14: 'glockenspiel',
  16: 'organ',
  17: 'organ',
  18: 'organ',
  19: 'organ',
  20: 'organ',
  24: 'acoustic-guitar',
  25: 'acoustic-guitar',
  26: 'electric-guitar-clean',
  27: 'electric-guitar-clean',
  28: 'electric-guitar-clean',
  29: 'electric-guitar-lead',
  30: 'electric-guitar-distorted',
  32: 'upright-bass',
  33: 'electric-bass',
  34: 'electric-bass',
  35: 'electric-bass',
  36: 'electric-bass',
  37: 'electric-bass',
  38: 'synth-bass',
  39: 'synth-bass',
  40: 'violin',
  41: 'viola',
  42: 'cello',
  43: 'contrabass',
  44: 'string-ensemble',
  45: 'pizzicato-strings',
  46: 'harp',
  47: 'timpani',
  48: 'string-ensemble',
  49: 'string-ensemble',
  50: 'synth-strings',
  51: 'synth-strings',
  52: 'choir',
  53: 'lead-vocal',
  56: 'trumpet',
  57: 'trombone',
  58: 'tuba',
  60: 'french-horn',
  61: 'brass-section',
  65: 'saxophone',
  66: 'tenor-sax',
  68: 'oboe',
  71: 'clarinet',
  73: 'flute',
  80: 'synth-arp',
  81: 'synth-lead',
  82: 'synth-lead',
  83: 'synth-lead',
  84: 'synth-lead',
  85: 'synth-lead',
  86: 'synth-lead',
  87: 'synth-seq',
  88: 'synth-pad',
  89: 'synth-pad',
  90: 'synth-pad',
  91: 'synth-pad',
  92: 'synth-pad',
  93: 'synth-pad',
  94: 'synth-pad',
  95: 'synth-pad',
};

function titleCase(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Fallback profile for an instrument id (never undefined). */
export function fallbackInstrument(id: string): InstrumentProfile {
  const row = BY_ID.get(id);
  if (row) return rowToProfile(row);
  const gm = /^gm-(\d{1,3})$/.exec(id);
  if (gm) {
    const program = Math.min(127, parseInt(gm[1], 10));
    const canonical = GM_PROGRAM_IDS[program];
    const base = canonical ? BY_ID.get(canonical)! : GM_FAMILY_ROWS[Math.floor(program / 8)];
    return { ...rowToProfile(base, id, gmProgramName(program)), gmProgram: program };
  }
  const lower = id.toLowerCase();
  for (const [re, target] of KEYWORDS) {
    if (re.test(lower)) return rowToProfile(BY_ID.get(target)!, id, titleCase(id));
  }
  return rowToProfile(GENERIC, id, titleCase(id) || GENERIC.name);
}

function gmProgramName(program: number): string {
  return GM_PROGRAM_NAMES[program] ?? `GM Program ${program + 1}`;
}

/** Resolve an instrument id: custom profiles → injected resolver → fallback table. */
export function lookupInstrument(id: string, opts: InstrumentLookupOptions = {}): InstrumentProfile {
  const custom = opts.customInstruments?.find((p) => p.id === id);
  if (custom) return custom;
  if (/^gm-\d{1,3}$/.test(id)) return fallbackInstrument(id);
  const resolved = opts.resolveInstrument?.(id);
  if (resolved) return resolved;
  return fallbackInstrument(id);
}

/** Whether an instrument id is known to the fallback table (or custom/injected profiles). */
export function isKnownInstrument(id: string, opts: InstrumentLookupOptions = {}): boolean {
  if (opts.customInstruments?.some((p) => p.id === id)) return true;
  if (BY_ID.has(id) || /^gm-\d{1,3}$/.test(id)) return true;
  if (opts.resolveInstrument) {
    const p = opts.resolveInstrument(id);
    return !!p && p.id === id;
  }
  return false;
}

/** Instrument id for a General MIDI program (MIDI import). Drums (channel 10) → "drum-kit". */
export function instrumentIdForProgram(program: number, isDrumChannel = false): string {
  if (isDrumChannel) return 'drum-kit';
  const p = Math.max(0, Math.min(127, Math.round(program)));
  return GM_PROGRAM_IDS[p] ?? `gm-${p}`;
}

/** Whether a track plays an (unpitched) drum kit. */
export function isDrumTrack(
  track: Pick<Track, 'instrumentId' | 'role' | 'midiChannel'>,
  opts: InstrumentLookupOptions = {},
): boolean {
  if (track.midiChannel === 9) return true;
  const profile = lookupInstrument(track.instrumentId, opts);
  if (profile.isDrumKit) return true;
  return (
    (track.role === 'drums' || track.role === 'percussion') &&
    profile.family !== 'synth' &&
    profile.family !== 'keys'
  );
}

/** Effective playable range of a track: user constraints (§17) override the instrument range. */
export function trackRange(track: Track, opts: InstrumentLookupOptions = {}): { low: number; high: number } {
  const profile = lookupInstrument(track.instrumentId, opts);
  let low = profile.range.low;
  let high = profile.range.high;
  const c = track.constraints ?? {};
  if (typeof c.lowest === 'number' && Number.isFinite(c.lowest)) low = c.lowest;
  if (typeof c.highest === 'number' && Number.isFinite(c.highest)) high = c.highest;
  if (low > high) [low, high] = [high, low];
  return { low: Math.max(0, Math.round(low)), high: Math.min(127, Math.round(high)) };
}

export function colorForStemGroup(group: StemGroup): string {
  return STEM_COLORS[group] ?? STEM_COLORS.others;
}
