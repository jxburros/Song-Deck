/**
 * Genre profiles (spec §14): editable rule profiles, not labels. Each profile describes tempo,
 * meters, modes, harmonic vocabulary, structures, instrumentation, rhythm, dynamics, arrangement
 * and production conventions. Profiles can be blended ("50% pop-punk / 30% emo / 20% cinematic").
 */
import type {
  GenreProfile,
  GenreWeight,
  MacroSettings,
  ModeName,
  MusicalFunction,
  SectionKind,
  TrackRole,
} from '../ir/types';
import { weightedAverage } from './util';

type Sec = { kind: SectionKind; bars: number; name?: string };
type Prog = GenreProfile['harmony']['progressions'][number];
type Inst = GenreProfile['instruments'][number];

const s = (kind: SectionKind, bars: number, name?: string): Sec => (name ? { kind, bars, name } : { kind, bars });
const p = (roman: string, weight: number, sectionKinds?: SectionKind[]): Prog => ({
  roman: roman.trim().split(/\s+/),
  weight,
  ...(sectionKinds ? { sectionKinds } : {}),
});
const inst = (instrumentId: string, role: TrackRole, weight: number, fn?: MusicalFunction, essential?: boolean): Inst => ({
  instrumentId,
  role,
  weight,
  ...(fn ? { function: fn } : {}),
  ...(essential ? { essential: true } : {}),
});

// Section-kind groups used to restrict progressions.
const VERSE: SectionKind[] = ['verse', 'intro', 'outro', 'interlude'];
const CHORUS: SectionKind[] = ['chorus', 'final-chorus', 'post-chorus', 'drop'];
const PRE: SectionKind[] = ['pre-chorus', 'build'];
const BRIDGE: SectionKind[] = ['bridge', 'breakdown', 'solo', 'interlude'];

// ---------------------------------------------------------------------------
// Structure templates
// ---------------------------------------------------------------------------

const T = {
  popStandard: (w: number) => ({
    name: 'Verse / Pre / Chorus',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('bridge', 8), s('final-chorus', 8), s('outro', 4)],
  }),
  popShort: (w: number) => ({
    name: 'Verse / Chorus',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('chorus', 8), s('verse', 8), s('chorus', 8), s('bridge', 8), s('final-chorus', 8), s('outro', 4)],
  }),
  popPost: (w: number) => ({
    name: 'Verse / Pre / Chorus / Post-chorus',
    weight: w,
    sections: [
      s('intro', 4), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('post-chorus', 4), s('verse', 8), s('pre-chorus', 4), s('chorus', 8),
      s('post-chorus', 4), s('bridge', 8), s('final-chorus', 8), s('outro', 4),
    ],
  }),
  rockAnthem: (w: number) => ({
    name: 'Rock anthem',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('bridge', 8), s('final-chorus', 16), s('outro', 4)],
  }),
  rockSolo: (w: number) => ({
    name: 'Rock with solo',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('chorus', 8), s('verse', 8), s('chorus', 8), s('solo', 8), s('bridge', 8), s('final-chorus', 8), s('outro', 4)],
  }),
  punk: (w: number) => ({
    name: 'Punk (verse / chorus)',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('chorus', 8), s('verse', 8), s('chorus', 8), s('bridge', 8), s('final-chorus', 8), s('outro', 4)],
  }),
  punkLong: (w: number) => ({
    name: 'Punk (long verses)',
    weight: w,
    sections: [s('intro', 4), s('verse', 16), s('chorus', 8), s('verse', 16), s('chorus', 8), s('bridge', 8), s('final-chorus', 16), s('outro', 4)],
  }),
  emo: (w: number) => ({
    name: 'Emo (breakdown before the last chorus)',
    weight: w,
    sections: [
      s('intro', 4), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('breakdown', 4),
      s('bridge', 8), s('final-chorus', 16), s('outro', 4),
    ],
  }),
  metal: (w: number) => ({
    name: 'Metal (solo section)',
    weight: w,
    sections: [
      s('intro', 8), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('solo', 16),
      s('bridge', 8), s('final-chorus', 8), s('outro', 4),
    ],
  }),
  metalBreakdown: (w: number) => ({
    name: 'Metal (breakdown)',
    weight: w,
    sections: [s('intro', 8), s('verse', 16), s('chorus', 8), s('verse', 16), s('chorus', 8), s('breakdown', 8), s('solo', 8), s('final-chorus', 8), s('outro', 4)],
  }),
  indie: (w: number) => ({
    name: 'Indie (interlude)',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('chorus', 8), s('verse', 8), s('chorus', 8), s('interlude', 4), s('bridge', 8), s('final-chorus', 8), s('outro', 8)],
  }),
  folk: (w: number) => ({
    name: 'Folk (three verses)',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('chorus', 8), s('verse', 8), s('chorus', 8), s('interlude', 4), s('verse', 8), s('final-chorus', 8), s('outro', 4)],
  }),
  country: (w: number) => ({
    name: 'Country (solo)',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('chorus', 8), s('verse', 8), s('chorus', 8), s('solo', 8), s('bridge', 4), s('final-chorus', 8), s('outro', 4)],
  }),
  edmVocal: (w: number) => ({
    name: 'EDM (vocal, two drops)',
    weight: w,
    sections: [s('intro', 8), s('verse', 8), s('build', 8), s('drop', 16), s('verse', 8), s('build', 8), s('drop', 16), s('outro', 8)],
  }),
  edmInstrumental: (w: number) => ({
    name: 'EDM (instrumental)',
    weight: w,
    sections: [s('intro', 8), s('breakdown', 8), s('build', 8), s('drop', 16), s('breakdown', 8), s('build', 8), s('drop', 16), s('outro', 8)],
  }),
  house: (w: number) => ({
    name: 'House',
    weight: w,
    sections: [s('intro', 8), s('verse', 16), s('chorus', 8), s('breakdown', 8), s('build', 4), s('chorus', 16), s('outro', 8)],
  }),
  trance: (w: number) => ({
    name: 'Trance',
    weight: w,
    sections: [s('intro', 16), s('breakdown', 16), s('build', 8), s('drop', 16), s('breakdown', 8), s('build', 8), s('drop', 16), s('outro', 8)],
  }),
  jazz: (w: number) => ({
    name: 'Jazz (head / solos / head)',
    weight: w,
    sections: [
      s('intro', 4), s('verse', 8, 'Head A1'), s('verse', 8, 'Head A2'), s('bridge', 8, 'Head B'), s('verse', 8, 'Head A3'), s('solo', 16, 'Solo 1'),
      s('solo', 16, 'Solo 2'), s('verse', 8, 'Head Out'), s('outro', 4),
    ],
  }),
  hipHop: (w: number) => ({
    name: 'Hip-hop (16-bar verses)',
    weight: w,
    sections: [s('intro', 4), s('verse', 16), s('chorus', 8), s('verse', 16), s('chorus', 8), s('bridge', 8), s('final-chorus', 8), s('outro', 4)],
  }),
  orchestral: (w: number) => ({
    name: 'Orchestral (themes and climax)',
    weight: w,
    sections: [
      s('intro', 4), s('verse', 8, 'Theme A'), s('verse', 8, 'Theme A Variation'), s('bridge', 8, 'Development'), s('build', 4),
      s('chorus', 8, 'Theme B'), s('final-chorus', 8, 'Climax'), s('outro', 8, 'Coda'),
    ],
  }),
  cinematic: (w: number) => ({
    name: 'Cinematic (two builds)',
    weight: w,
    sections: [s('intro', 8), s('verse', 8), s('build', 8), s('chorus', 8), s('breakdown', 8), s('build', 8), s('final-chorus', 16), s('outro', 8)],
  }),
  rnb: (w: number) => ({
    name: 'R&B',
    weight: w,
    sections: [s('intro', 4), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('verse', 8), s('pre-chorus', 4), s('chorus', 8), s('bridge', 8), s('final-chorus', 8), s('outro', 4)],
  }),
};

const ENERGY_BAND = (o: Partial<Record<SectionKind, number>>): Partial<Record<SectionKind, number>> => ({
  intro: 35, verse: 45, 'pre-chorus': 62, chorus: 85, 'post-chorus': 78, bridge: 60, breakdown: 35, build: 70,
  drop: 92, solo: 78, interlude: 45, 'final-chorus': 96, outro: 40, custom: 55, ...o,
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const ROCK_PROGRESSIONS: Prog[] = [
  p('i VI III VII', 3),
  p('i VII VI VII', 1.5, [...VERSE, ...BRIDGE]),
  p('i VI VII i', 1, [...VERSE, ...PRE]),
  p('VI VII i i', 1.5, [...PRE, ...CHORUS]),
  p('VI VII III i', 1, PRE),
  p('I V vi IV', 2.5, CHORUS),
  p('vi IV I V', 2, VERSE),
  p('I bVII IV I', 1.2),
  p('IV I V vi', 1.2, [...CHORUS, ...BRIDGE]),
  p('IV V vi', 1, [...PRE, ...BRIDGE]),
  p('VI i VII', 1, BRIDGE),
  p('iv VI VII', 0.8, [...PRE, ...BRIDGE]),
];

export const BUILTIN_GENRES: GenreProfile[] = [
  {
    id: 'pop',
    name: 'Pop',
    description: 'Hook-centred songwriting with clear verse/chorus contrast and polished, punchy production.',
    builtIn: true,
    tags: ['mainstream', 'vocal', 'radio'],
    tempo: { min: 88, max: 132, typical: 112 },
    meters: [{ numerator: 4, denominator: 4, weight: 1 }],
    modes: [{ mode: 'major', weight: 0.65 }, { mode: 'minor', weight: 0.35 }],
    harmony: {
      progressions: [
        p('I V vi IV', 3), p('vi IV I V', 3), p('I vi IV V', 1.5), p('IV I V vi', 1.5, [...CHORUS, ...PRE]), p('I IV vi V', 1),
        p('vi V IV V', 1, VERSE), p('ii IV I V', 1, PRE), p('IV V', 1.2, PRE), p('vi IV V V', 1, PRE), p('IV vi V', 1, BRIDGE),
        p('ii V vi IV', 0.8, BRIDGE), p('i VI III VII', 1.5), p('VI VII i i', 0.8, [...PRE, ...CHORUS]), p('i iv VI V', 0.6),
      ],
      borrowedChordRate: 0.12,
      extensionRate: 0.2,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.popStandard(3), T.popShort(2), T.popPost(1.5)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('piano', 'keys', 0.9, 'accompaniment', true), inst('electric-guitar-clean', 'rhythm-guitar', 0.6, 'accompaniment'),
      inst('synth-pad', 'synth-pad', 0.6, 'pad'), inst('acoustic-guitar', 'rhythm-guitar', 0.35, 'accompaniment'),
      inst('string-ensemble', 'strings', 0.3, 'pad'), inst('backing-vocal', 'vocal', 0.35, 'harmony'), inst('synth-arp', 'synth-arp', 0.25, 'texture'),
    ],
    rhythm: { drumStyle: 'pop', swing: 0, syncopation: 0.45, subdivision: 16, halfTimeChance: 0.2 },
    dynamics: { energyBySection: ENERGY_BAND({}), dynamicRange: 0.6 },
    arrangement: {
      densityAtLowEnergy: 0.4,
      densityAtHighEnergy: 1,
      restsBySection: { breakdown: ['bass', 'rhythm-guitar'], verse: ['lead-guitar', 'synth-lead'] },
      conventions: ['Sparse verses that open up into a full chorus', 'Hook in the chorus repeated at least twice', 'Bridge offers contrast before the final chorus'],
    },
    production: { description: 'Polished modern pop: punchy drums, bright upfront vocals, wide pads', reverb: 0.3, keywords: ['pop', 'polished', 'radio-ready', 'catchy', 'bright'], masteringTarget: 'streaming' },
    macros: { syncopation: 0.45, complexity: 0.45, humanization: 0.25, repetition: 0.35 },
  },
  {
    id: 'synth-pop',
    name: 'Synth-Pop',
    description: 'Synth-driven pop with steady electronic grooves, arpeggios and lush pads.',
    builtIn: true,
    tags: ['electronic', '80s', 'vocal'],
    tempo: { min: 100, max: 135, typical: 118 },
    meters: [{ numerator: 4, denominator: 4, weight: 1 }],
    modes: [{ mode: 'minor', weight: 0.55 }, { mode: 'major', weight: 0.45 }],
    harmony: {
      progressions: [p('vi IV I V', 3), p('i VI III VII', 3), p('I V vi IV', 2), p('IV V iii vi', 1.2), p('i VII VI VII', 1.2, VERSE), p('VI VII i i', 1, PRE), p('IV V', 1, PRE), p('VI III VII i', 1, BRIDGE)],
      borrowedChordRate: 0.1,
      extensionRate: 0.25,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.popStandard(2), T.popPost(2), T.popShort(1)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('electronic-kit', 'drums', 1, 'rhythm', true), inst('synth-bass', 'bass', 1, 'bass-line', true),
      inst('synth-pad', 'synth-pad', 1, 'pad', true), inst('synth-arp', 'synth-arp', 0.8, 'texture'), inst('synth-lead', 'synth-lead', 0.6, 'hook'),
      inst('electric-piano', 'keys', 0.3, 'accompaniment'), inst('synth-seq', 'synth-seq', 0.35, 'rhythm'),
    ],
    rhythm: { drumStyle: 'synth-pop', swing: 0, syncopation: 0.35, subdivision: 16, halfTimeChance: 0.15 },
    dynamics: { energyBySection: ENERGY_BAND({ verse: 50, chorus: 86 }), dynamicRange: 0.5 },
    arrangement: {
      densityAtLowEnergy: 0.45,
      densityAtHighEnergy: 1,
      restsBySection: { breakdown: ['drums', 'bass'] },
      conventions: ['Arpeggiated synths carry momentum', 'Gated or sidechained pads', 'Lead synth states the hook in intros and post-choruses'],
    },
    production: { description: 'Glossy synth-pop: gated drums, analog-style synths, chorus-drenched pads', reverb: 0.35, keywords: ['synth-pop', '80s', 'analog synths', 'gated reverb'], masteringTarget: 'streaming' },
    macros: { humanization: 0.08, syncopation: 0.35, density: 0.6 },
  },
  {
    id: 'punk',
    name: 'Punk',
    description: 'Fast, raw and loud: power chords, driving eighths and short songs.',
    builtIn: true,
    tags: ['rock', 'fast', 'guitar'],
    tempo: { min: 150, max: 210, typical: 178 },
    meters: [{ numerator: 4, denominator: 4, weight: 1 }],
    modes: [{ mode: 'major', weight: 0.55 }, { mode: 'minor', weight: 0.45 }],
    harmony: {
      progressions: [p('I IV V IV', 2), p('I V vi IV', 2), p('I bVII IV I', 1.5), p('I IV I V', 1.2, VERSE), p('i VI III VII', 1.5), p('IV V', 1, PRE), p('vi IV V', 1, BRIDGE), p('i VII VI VII', 1)],
      borrowedChordRate: 0.15,
      extensionRate: 0,
      harmonicRhythm: 1,
      powerChords: true,
    },
    structure: { templates: [T.punk(2), T.punkLong(1.5)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true), inst('electric-guitar-distorted', 'rhythm-guitar', 0.8, 'rhythm'),
      inst('backing-vocal', 'vocal', 0.3, 'harmony'),
    ],
    rhythm: { drumStyle: 'punk', swing: 0, syncopation: 0.2, subdivision: 8, halfTimeChance: 0.15 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 70, verse: 72, chorus: 92, bridge: 70, 'final-chorus': 98, outro: 75 }), dynamicRange: 0.3 },
    arrangement: { densityAtLowEnergy: 0.8, densityAtHighEnergy: 1, conventions: ['Everyone plays nearly all the time', 'Downstroke eighth-note power chords', 'Skate beat in choruses'] },
    production: { description: 'Raw garage punk: loud guitars, crashy drums, shouted vocals', reverb: 0.12, keywords: ['punk', 'raw', 'fast', 'distorted guitars'], masteringTarget: 'loud-rock' },
    macros: { energy: 0.85, complexity: 0.3, syncopation: 0.2, humanization: 0.3, density: 0.7 },
  },
  {
    id: 'pop-punk',
    name: 'Pop-Punk',
    description: 'Punk energy with pop hooks: big singalong choruses, palm-muted verses, double-tracked guitars.',
    builtIn: true,
    tags: ['rock', 'guitar', 'vocal'],
    tempo: { min: 140, max: 200, typical: 168 },
    meters: [{ numerator: 4, denominator: 4, weight: 1 }],
    modes: [{ mode: 'major', weight: 0.6 }, { mode: 'minor', weight: 0.4 }],
    harmony: {
      progressions: [p('I V vi IV', 3), p('vi IV I V', 2.5), p('IV I V vi', 1.5, CHORUS), p('I iii IV V', 1, VERSE), p('IV V vi', 1, PRE), p('IV V', 1, PRE), p('i VI III VII', 1.5), p('vi V IV', 1, BRIDGE)],
      borrowedChordRate: 0.1,
      extensionRate: 0.05,
      harmonicRhythm: 1,
      powerChords: true,
    },
    structure: { templates: [T.rockAnthem(2), T.punk(1.5), T.popStandard(1)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true), inst('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true),
      inst('electric-guitar-lead', 'lead-guitar', 0.6, 'hook'), inst('backing-vocal', 'vocal', 0.4, 'harmony'), inst('synth-pad', 'synth-pad', 0.15, 'pad'),
    ],
    rhythm: { drumStyle: 'pop-punk', swing: 0, syncopation: 0.3, subdivision: 8, halfTimeChance: 0.3 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 60, verse: 58, 'pre-chorus': 72, chorus: 93, bridge: 62, 'final-chorus': 99, outro: 60 }), dynamicRange: 0.45 },
    arrangement: {
      densityAtLowEnergy: 0.65,
      densityAtHighEnergy: 1,
      restsBySection: { verse: ['lead-guitar'], breakdown: ['rhythm-guitar'] },
      conventions: ['Palm-muted verses, open ringing choruses', 'Skate beat under the chorus', 'Gang vocals in the final chorus'],
    },
    production: { description: 'Tight, bright pop-punk: double-tracked guitars, punchy kick, big singalong vocals', reverb: 0.15, keywords: ['pop-punk', 'energetic', 'singalong', 'double-tracked guitars'], masteringTarget: 'loud-rock' },
    macros: { energy: 0.78, complexity: 0.4, syncopation: 0.3, humanization: 0.2, density: 0.65 },
  },
  {
    id: 'emo',
    name: 'Emo',
    description: 'Emotional, dynamic guitar music: minor-key verses, cathartic choruses, twinkly clean leads.',
    builtIn: true,
    tags: ['rock', 'emotional', 'guitar'],
    tempo: { min: 120, max: 190, typical: 158 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.9 }, { numerator: 6, denominator: 8, weight: 0.1 }],
    modes: [{ mode: 'minor', weight: 0.6 }, { mode: 'major', weight: 0.4 }],
    harmony: {
      progressions: [
        p('i VI III VII', 3), p('VI VII i i', 1.5, [...PRE, ...CHORUS]), p('i iv VI VII', 1.2), p('IV I V vi', 1.5, CHORUS), p('I V vi iii IV', 1, CHORUS),
        p('Imaj7 IVmaj7', 0.8, [...VERSE, ...BRIDGE]), p('VI VII III i', 1, PRE), p('iv VI VII', 1, BRIDGE), p('vi IV I V', 1.5),
      ],
      borrowedChordRate: 0.2,
      extensionRate: 0.25,
      harmonicRhythm: 1,
      powerChords: true,
    },
    structure: { templates: [T.rockAnthem(2.5), T.emo(2), T.punk(0.6)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true), inst('electric-guitar-distorted', 'rhythm-guitar', 0.8, 'rhythm'),
      inst('electric-guitar-clean', 'lead-guitar', 0.6, 'counter-melody'), inst('piano', 'keys', 0.3, 'accompaniment'), inst('violin', 'strings', 0.25, 'counter-melody'),
    ],
    rhythm: { drumStyle: 'emo', swing: 0, syncopation: 0.35, subdivision: 8, halfTimeChance: 0.35 },
    dynamics: { energyBySection: ENERGY_BAND({ verse: 45, 'pre-chorus': 66, chorus: 92, bridge: 60, breakdown: 30, 'final-chorus': 100, outro: 45 }), dynamicRange: 0.75 },
    arrangement: {
      densityAtLowEnergy: 0.45,
      densityAtHighEnergy: 1,
      restsBySection: { breakdown: ['drums', 'bass'] },
      conventions: ['Quiet/loud dynamics', 'Clean twinkly guitar counter-lines', 'Floor-tom verses and cathartic, crash-heavy choruses'],
    },
    production: { description: 'Emotional alt-rock: raw vocals, wall of guitars in choruses, roomy drums', reverb: 0.22, keywords: ['emo', 'cathartic', 'raw vocals', 'wall of guitars'], masteringTarget: 'loud-rock' },
    macros: { energy: 0.7, complexity: 0.5, dynamics: 0.75, humanization: 0.35 },
  },
  {
    id: 'rock',
    name: 'Rock',
    description: 'Guitar-band rock: backbeat drums, riffs, power chords and anthemic choruses.',
    builtIn: true,
    tags: ['guitar', 'band'],
    tempo: { min: 90, max: 170, typical: 122 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.95 }, { numerator: 12, denominator: 8, weight: 0.05 }],
    modes: [{ mode: 'minor', weight: 0.5 }, { mode: 'major', weight: 0.35 }, { mode: 'mixolydian', weight: 0.15 }],
    harmony: { progressions: [...ROCK_PROGRESSIONS, p('I IV V IV', 1)], borrowedChordRate: 0.18, extensionRate: 0.08, harmonicRhythm: 1, powerChords: true },
    structure: { templates: [T.rockAnthem(2), T.rockSolo(1.5), T.popShort(1)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true), inst('electric-guitar-distorted', 'rhythm-guitar', 0.7, 'rhythm'),
      inst('electric-guitar-lead', 'lead-guitar', 0.6, 'hook'), inst('organ', 'keys', 0.25, 'pad'), inst('piano', 'keys', 0.25, 'accompaniment'),
    ],
    rhythm: { drumStyle: 'rock', swing: 0, syncopation: 0.3, subdivision: 8, halfTimeChance: 0.2 },
    dynamics: { energyBySection: ENERGY_BAND({ verse: 52, chorus: 88, solo: 85 }), dynamicRange: 0.55 },
    arrangement: {
      densityAtLowEnergy: 0.55,
      densityAtHighEnergy: 1,
      restsBySection: { verse: ['lead-guitar'] },
      conventions: ['Backbeat on 2 and 4', 'Guitar riff states the hook in the intro', 'Ride cymbal opens up in choruses'],
    },
    production: { description: 'Classic rock band sound: crunchy guitars, live drums, upfront vocals', reverb: 0.2, keywords: ['rock', 'live band', 'guitars', 'anthemic'], masteringTarget: 'loud-rock' },
    macros: { energy: 0.65, humanization: 0.35, syncopation: 0.3 },
  },
  {
    id: 'alternative-rock',
    name: 'Alternative Rock',
    description: 'Moody, dynamic guitar rock: minor-key verses that explode into big choruses.',
    builtIn: true,
    tags: ['rock', 'guitar', 'alternative'],
    tempo: { min: 90, max: 176, typical: 124 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.92 }, { numerator: 6, denominator: 8, weight: 0.08 }],
    modes: [{ mode: 'minor', weight: 0.7 }, { mode: 'major', weight: 0.2 }, { mode: 'dorian', weight: 0.1 }],
    harmony: { progressions: ROCK_PROGRESSIONS, borrowedChordRate: 0.2, extensionRate: 0.12, harmonicRhythm: 1, powerChords: true },
    structure: { templates: [T.rockAnthem(3), T.rockSolo(1), T.emo(0.8)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true), inst('electric-guitar-distorted', 'rhythm-guitar', 0.8, 'rhythm'),
      inst('electric-guitar-lead', 'lead-guitar', 0.55, 'hook'), inst('piano', 'keys', 0.35, 'accompaniment'), inst('string-ensemble', 'strings', 0.2, 'pad'),
    ],
    rhythm: { drumStyle: 'rock', swing: 0, syncopation: 0.32, subdivision: 8, halfTimeChance: 0.3 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 38, verse: 45, 'pre-chorus': 65, chorus: 90, bridge: 70, 'final-chorus': 100, outro: 42 }), dynamicRange: 0.7 },
    arrangement: {
      densityAtLowEnergy: 0.45,
      densityAtHighEnergy: 1,
      restsBySection: { verse: ['lead-guitar'] },
      conventions: ['Restrained verses, huge choruses', 'Bridge builds into a maximal final chorus', 'Double-tracked rhythm guitars panned hard left/right'],
    },
    production: { description: 'Big alternative rock: wide double-tracked guitars, roomy drums, emotional vocal', reverb: 0.24, keywords: ['alternative rock', 'cathartic', 'wide guitars', 'arena'], masteringTarget: 'loud-rock' },
    macros: { energy: 0.66, dynamics: 0.7, humanization: 0.3 },
  },
  {
    id: 'indie-rock',
    name: 'Indie Rock',
    description: 'Jangly or motorik guitar music with understated vocals and inventive arrangements.',
    builtIn: true,
    tags: ['rock', 'indie', 'guitar'],
    tempo: { min: 95, max: 160, typical: 126 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.9 }, { numerator: 3, denominator: 4, weight: 0.05 }, { numerator: 6, denominator: 8, weight: 0.05 }],
    modes: [{ mode: 'major', weight: 0.5 }, { mode: 'minor', weight: 0.35 }, { mode: 'mixolydian', weight: 0.15 }],
    harmony: {
      progressions: [p('I iii vi IV', 1.5), p('vi IV I V', 2), p('I IV vi V', 1.5), p('IV I V', 1.2, CHORUS), p('I V vi IV', 1.5), p('i VII VI VII', 1.2), p('IV iv I', 0.8, BRIDGE), p('ii IV I', 1, PRE), p('I bVII IV', 1)],
      borrowedChordRate: 0.18,
      extensionRate: 0.25,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.indie(2), T.popShort(1.5), T.rockAnthem(1)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('electric-guitar-clean', 'rhythm-guitar', 1, 'accompaniment', true), inst('electric-guitar-clean', 'lead-guitar', 0.6, 'counter-melody'),
      inst('synth-pad', 'synth-pad', 0.3, 'pad'), inst('organ', 'keys', 0.2, 'pad'), inst('percussion', 'percussion', 0.3, 'rhythm'),
    ],
    rhythm: { drumStyle: 'indie', swing: 0, syncopation: 0.35, subdivision: 8, halfTimeChance: 0.2 },
    dynamics: { energyBySection: ENERGY_BAND({ verse: 50, chorus: 80, 'final-chorus': 90 }), dynamicRange: 0.5 },
    arrangement: { densityAtLowEnergy: 0.5, densityAtHighEnergy: 0.95, conventions: ['Motorik or floor-tom grooves', 'Interlocking guitar parts', 'Understated vocal'] },
    production: { description: 'Lo-fi-leaning indie: jangly guitars, roomy drums, intimate vocal', reverb: 0.28, keywords: ['indie', 'jangly guitars', 'warm', 'roomy'], masteringTarget: 'dynamic' },
    macros: { humanization: 0.45, complexity: 0.5, syncopation: 0.35 },
  },
  {
    id: 'metal',
    name: 'Metal',
    description: 'Heavy, aggressive and precise: low power-chord riffs, double kick, gallops and solos.',
    builtIn: true,
    tags: ['rock', 'heavy', 'guitar'],
    tempo: { min: 90, max: 200, typical: 150 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.9 }, { numerator: 6, denominator: 8, weight: 0.05 }, { numerator: 7, denominator: 8, weight: 0.05 }],
    modes: [{ mode: 'minor', weight: 0.55 }, { mode: 'phrygian', weight: 0.25 }, { mode: 'harmonic-minor', weight: 0.2 }],
    harmony: {
      progressions: [p('i VI VII i', 2), p('i bII i VII', 1.2), p('i VI III VII', 1.5), p('i VII VI V', 1.2), p('i iv VI V', 1, [...PRE, ...CHORUS]), p('VI VII i', 1.5, CHORUS), p('i bII', 1, [...VERSE, ...BRIDGE]), p('iv V', 0.8, PRE)],
      borrowedChordRate: 0.25,
      extensionRate: 0,
      harmonicRhythm: 1,
      powerChords: true,
    },
    structure: { templates: [T.metal(2), T.metalBreakdown(1.5)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true), inst('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true),
      inst('electric-guitar-lead', 'lead-guitar', 0.8, 'hook'), inst('choir', 'vocal', 0.15, 'pad'), inst('synth-pad', 'synth-pad', 0.15, 'pad'),
    ],
    rhythm: { drumStyle: 'metal', swing: 0, syncopation: 0.3, subdivision: 16, halfTimeChance: 0.35 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 70, verse: 78, 'pre-chorus': 82, chorus: 92, bridge: 75, breakdown: 85, solo: 90, 'final-chorus': 100, outro: 70 }), dynamicRange: 0.35 },
    arrangement: {
      densityAtLowEnergy: 0.75,
      densityAtHighEnergy: 1,
      conventions: ['Low palm-muted chugs locked with the kick', 'Double-kick choruses, half-time breakdowns', 'Guitar solo over the verse changes'],
    },
    production: { description: 'Modern metal: tight high-gain guitars, triggered drums, aggressive vocals', reverb: 0.15, keywords: ['metal', 'heavy', 'high-gain', 'aggressive'], masteringTarget: 'loud-rock' },
    macros: { energy: 0.9, complexity: 0.65, humanization: 0.12, syncopation: 0.35, density: 0.75 },
  },
  {
    id: 'folk',
    name: 'Folk',
    description: 'Acoustic storytelling: strummed guitars, simple harmony, organic percussion.',
    builtIn: true,
    tags: ['acoustic', 'organic', 'vocal'],
    tempo: { min: 70, max: 130, typical: 98 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.7 }, { numerator: 3, denominator: 4, weight: 0.2 }, { numerator: 6, denominator: 8, weight: 0.1 }],
    modes: [{ mode: 'major', weight: 0.6 }, { mode: 'minor', weight: 0.25 }, { mode: 'mixolydian', weight: 0.1 }, { mode: 'dorian', weight: 0.05 }],
    harmony: {
      progressions: [p('I IV I V', 2), p('I V vi IV', 2), p('vi IV I V', 1.5), p('I IV V I', 1.5), p('I vi IV V', 1), p('IV I V', 1, CHORUS), p('IV V', 1, PRE), p('i VII VI VII', 1), p('i III VII i', 0.8)],
      borrowedChordRate: 0.08,
      extensionRate: 0.1,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.folk(2), T.popShort(1.5)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
      inst('upright-bass', 'bass', 0.7, 'bass-line'), inst('percussion', 'percussion', 0.5, 'rhythm'), inst('violin', 'strings', 0.5, 'counter-melody'),
      inst('drum-kit', 'drums', 0.4, 'rhythm'), inst('piano', 'keys', 0.3, 'accompaniment'), inst('flute', 'custom', 0.15, 'counter-melody'),
    ],
    rhythm: { drumStyle: 'folk', swing: 0.1, syncopation: 0.25, subdivision: 8, halfTimeChance: 0.1 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 30, verse: 38, chorus: 68, 'final-chorus': 80, outro: 30 }), dynamicRange: 0.55 },
    arrangement: { densityAtLowEnergy: 0.4, densityAtHighEnergy: 0.9, conventions: ['Acoustic guitar carries the song', 'Fiddle answers the vocal', 'Light brushes or hand percussion'] },
    production: { description: 'Warm acoustic folk: close-miked guitar and voice, natural room', reverb: 0.3, keywords: ['folk', 'acoustic', 'warm', 'organic'], masteringTarget: 'dynamic' },
    macros: { humanization: 0.5, complexity: 0.35, energy: 0.4 },
  },
  {
    id: 'country',
    name: 'Country',
    description: 'Twangy storytelling: boom-chick grooves, root-fifth bass, I–IV–V harmony.',
    builtIn: true,
    tags: ['acoustic', 'americana', 'vocal'],
    tempo: { min: 80, max: 150, typical: 112 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.85 }, { numerator: 3, denominator: 4, weight: 0.15 }],
    modes: [{ mode: 'major', weight: 0.85 }, { mode: 'mixolydian', weight: 0.1 }, { mode: 'minor', weight: 0.05 }],
    harmony: {
      progressions: [p('I IV V I', 2), p('I IV I V', 2), p('I V vi IV', 1.5), p('I vi IV V', 1.2), p('IV I V', 1.2, CHORUS), p('I II IV I', 0.8), p('IV V', 1, PRE), p('vi IV I V', 1, BRIDGE)],
      borrowedChordRate: 0.05,
      extensionRate: 0.12,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.country(2), T.popShort(1.5)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('drum-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true), inst('electric-guitar-clean', 'lead-guitar', 0.7, 'counter-melody'),
      inst('piano', 'keys', 0.45, 'accompaniment'), inst('violin', 'strings', 0.5, 'counter-melody'),
    ],
    rhythm: { drumStyle: 'country', swing: 0.1, syncopation: 0.2, subdivision: 8, halfTimeChance: 0.1 },
    dynamics: { energyBySection: ENERGY_BAND({ verse: 48, chorus: 78, 'final-chorus': 88 }), dynamicRange: 0.45 },
    arrangement: { densityAtLowEnergy: 0.5, densityAtHighEnergy: 1, conventions: ['Boom-chick or train-beat drums', 'Root-fifth bass', 'Fiddle and twangy guitar fills between vocal lines'] },
    production: { description: 'Nashville country: clean twangy guitars, fiddle, crisp drums', reverb: 0.25, keywords: ['country', 'twang', 'fiddle', 'americana'], masteringTarget: 'streaming' },
    macros: { complexity: 0.4, syncopation: 0.2, humanization: 0.35 },
  },
  {
    id: 'edm',
    name: 'EDM',
    description: 'Festival electronic dance music: builds, drops, four-on-the-floor and big synth hooks.',
    builtIn: true,
    tags: ['electronic', 'dance'],
    tempo: { min: 118, max: 150, typical: 128 },
    meters: [{ numerator: 4, denominator: 4, weight: 1 }],
    modes: [{ mode: 'minor', weight: 0.7 }, { mode: 'major', weight: 0.3 }],
    harmony: {
      progressions: [p('vi IV I V', 3), p('i VI III VII', 3), p('i VII VI VII', 1.5), p('IV V vi vi', 1.2, [...CHORUS, ...PRE]), p('i iv VI VII', 1), p('VI VII', 1, PRE)],
      borrowedChordRate: 0.08,
      extensionRate: 0.2,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.edmVocal(2), T.edmInstrumental(1.5)] },
    instruments: [
      inst('electronic-kit', 'drums', 1, 'rhythm', true), inst('synth-bass', 'bass', 1, 'bass-line', true), inst('synth-pad', 'synth-pad', 1, 'pad', true),
      inst('synth-lead', 'synth-lead', 1, 'hook', true), inst('synth-arp', 'synth-arp', 0.7, 'texture'), inst('synth-seq', 'synth-seq', 0.5, 'rhythm'),
      inst('lead-vocal', 'vocal', 0.6, 'melody'), inst('piano', 'keys', 0.3, 'accompaniment'),
    ],
    rhythm: { drumStyle: 'four-on-floor', swing: 0, syncopation: 0.4, subdivision: 16, halfTimeChance: 0.1 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 40, verse: 50, build: 72, drop: 98, breakdown: 30, outro: 40 }), dynamicRange: 0.7 },
    arrangement: {
      densityAtLowEnergy: 0.35,
      densityAtHighEnergy: 1,
      restsBySection: { breakdown: ['drums', 'bass', 'synth-seq'], intro: ['synth-lead'], build: ['bass'] },
      conventions: ['Snare-roll build-ups into drops', 'Sidechained pads', 'Lead synth carries the drop hook'],
    },
    production: { description: 'Big-room EDM: sidechained supersaws, punchy kick, risers and impacts', reverb: 0.35, keywords: ['edm', 'festival', 'supersaw', 'drop', 'sidechain'], masteringTarget: 'streaming' },
    macros: { humanization: 0.03, density: 0.65, energy: 0.75, repetition: 0.25 },
  },
  {
    id: 'house',
    name: 'House',
    description: 'Four-on-the-floor grooves, offbeat hats, piano/organ stabs and soulful hooks.',
    builtIn: true,
    tags: ['electronic', 'dance', 'groove'],
    tempo: { min: 118, max: 128, typical: 124 },
    meters: [{ numerator: 4, denominator: 4, weight: 1 }],
    modes: [{ mode: 'minor', weight: 0.6 }, { mode: 'dorian', weight: 0.2 }, { mode: 'major', weight: 0.2 }],
    harmony: {
      progressions: [p('i7 iv7', 2), p('ii7 V7 Imaj7 Imaj7', 1.2), p('vi7 ii7 V7 Imaj7', 1.2), p('i VII VI VII', 1.5), p('i7 VImaj7 VII7 i7', 1), p('iv7 v7', 0.8, PRE)],
      borrowedChordRate: 0.1,
      extensionRate: 0.7,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.house(2), T.edmVocal(1)] },
    instruments: [
      inst('electronic-kit', 'drums', 1, 'rhythm', true), inst('synth-bass', 'bass', 1, 'bass-line', true), inst('piano', 'keys', 0.9, 'accompaniment', true),
      inst('synth-pad', 'synth-pad', 0.7, 'pad'), inst('lead-vocal', 'vocal', 0.6, 'melody'), inst('percussion', 'percussion', 0.6, 'rhythm'), inst('organ', 'keys', 0.3, 'accompaniment'),
    ],
    rhythm: { drumStyle: 'four-on-floor', swing: 0.15, syncopation: 0.55, subdivision: 16, halfTimeChance: 0 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 50, verse: 62, chorus: 85, breakdown: 40, build: 72, outro: 50 }), dynamicRange: 0.4 },
    arrangement: { densityAtLowEnergy: 0.45, densityAtHighEnergy: 1, restsBySection: { breakdown: ['drums'] }, conventions: ['Kick on every beat', 'Open hats on the offbeats', 'Offbeat piano stabs'] },
    production: { description: 'Classic house: warm kick, swung hats, piano stabs, soulful vocal chops', reverb: 0.3, keywords: ['house', 'four on the floor', 'piano stabs', 'groovy'], masteringTarget: 'streaming' },
    macros: { humanization: 0.08, syncopation: 0.55, harmonicTension: 0.5, repetition: 0.2 },
  },
  {
    id: 'trance',
    name: 'Trance',
    description: 'Euphoric minor-key anthems: long breakdowns, rolling bass, gated pads and soaring leads.',
    builtIn: true,
    tags: ['electronic', 'dance', 'euphoric'],
    tempo: { min: 128, max: 145, typical: 138 },
    meters: [{ numerator: 4, denominator: 4, weight: 1 }],
    modes: [{ mode: 'minor', weight: 0.85 }, { mode: 'major', weight: 0.15 }],
    harmony: {
      progressions: [p('i VI III VII', 3), p('i VI VII i', 2), p('VI VII i i', 1.5, [...PRE, ...CHORUS]), p('i iv VI V', 1.2), p('i VII VI VII', 1.2)],
      borrowedChordRate: 0.1,
      extensionRate: 0.15,
      harmonicRhythm: 0.5,
    },
    structure: { templates: [T.trance(2), T.edmInstrumental(1)] },
    instruments: [
      inst('electronic-kit', 'drums', 1, 'rhythm', true), inst('synth-bass', 'bass', 1, 'bass-line', true), inst('synth-pad', 'synth-pad', 1, 'pad', true),
      inst('synth-arp', 'synth-arp', 1, 'texture', true), inst('synth-lead', 'synth-lead', 1, 'hook', true), inst('synth-seq', 'synth-seq', 0.7, 'rhythm'),
      inst('lead-vocal', 'vocal', 0.3, 'melody'), inst('string-ensemble', 'strings', 0.3, 'pad'),
    ],
    rhythm: { drumStyle: 'trance', swing: 0, syncopation: 0.3, subdivision: 16, halfTimeChance: 0 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 55, breakdown: 30, build: 75, drop: 100, outro: 50 }), dynamicRange: 0.7 },
    arrangement: {
      densityAtLowEnergy: 0.35,
      densityAtHighEnergy: 1,
      restsBySection: { breakdown: ['drums', 'bass', 'synth-seq'], intro: ['synth-lead'] },
      conventions: ['Rolling off-beat bass', 'Long emotional breakdowns', 'Gated supersaw chords in the drop'],
    },
    production: { description: 'Uplifting trance: supersaw leads, gated pads, long reverb tails', reverb: 0.45, keywords: ['trance', 'euphoric', 'supersaw', 'uplifting'], masteringTarget: 'streaming' },
    macros: { humanization: 0.02, density: 0.7, repetition: 0.2, energy: 0.75 },
  },
  {
    id: 'jazz',
    name: 'Jazz',
    description: 'Swing feel, extended harmony and ii–V–I motion; comping piano, walking bass, ride cymbal.',
    builtIn: true,
    tags: ['acoustic', 'swing', 'harmony'],
    tempo: { min: 70, max: 220, typical: 132 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.85 }, { numerator: 3, denominator: 4, weight: 0.15 }],
    modes: [{ mode: 'major', weight: 0.6 }, { mode: 'minor', weight: 0.25 }, { mode: 'dorian', weight: 0.15 }],
    harmony: {
      progressions: [
        p('ii7 V7 Imaj7 Imaj7', 3), p('Imaj7 vi7 ii7 V7', 2.5), p('iii7 vi7 ii7 V7', 1.5), p('Imaj7 IVmaj7 iii7 vi7', 1.2),
        p('iiø7 V7 i7 i7', 1.5), p('IVmaj7 iv7 iii7 vi7', 1, BRIDGE), p('V7/V V7', 0.8, PRE),
      ],
      borrowedChordRate: 0.3,
      extensionRate: 0.95,
      harmonicRhythm: 2,
    },
    structure: { templates: [T.jazz(2), T.popShort(0.5)] },
    instruments: [
      inst('piano', 'keys', 1, 'accompaniment', true), inst('upright-bass', 'bass', 1, 'bass-line', true), inst('drum-kit', 'drums', 1, 'rhythm', true),
      inst('saxophone', 'custom', 0.8, 'melody'), inst('trumpet', 'custom', 0.4, 'counter-melody'), inst('electric-guitar-clean', 'rhythm-guitar', 0.35, 'accompaniment'),
      inst('lead-vocal', 'vocal', 0.3, 'melody'),
    ],
    rhythm: { drumStyle: 'jazz-swing', swing: 0.66, syncopation: 0.6, subdivision: 12, halfTimeChance: 0 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 35, verse: 50, bridge: 55, solo: 68, outro: 38 }), dynamicRange: 0.65 },
    arrangement: { densityAtLowEnergy: 0.6, densityAtHighEnergy: 1, conventions: ['Walking bass in quarter notes', 'Ride cymbal spang-a-lang, hi-hat on 2 and 4', 'Comping with shell voicings'] },
    production: { description: 'Small-group jazz: natural room, warm upright bass, brushed or ride-driven drums', reverb: 0.3, keywords: ['jazz', 'swing', 'acoustic', 'live room'], masteringTarget: 'dynamic' },
    macros: { complexity: 0.75, harmonicTension: 0.75, syncopation: 0.6, humanization: 0.6, melodicMovement: 0.65 },
  },
  {
    id: 'rnb',
    name: 'R&B',
    description: 'Smooth, syncopated grooves with lush seventh/ninth chords and expressive vocals.',
    builtIn: true,
    tags: ['soul', 'groove', 'vocal'],
    tempo: { min: 60, max: 110, typical: 84 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.85 }, { numerator: 12, denominator: 8, weight: 0.15 }],
    modes: [{ mode: 'minor', weight: 0.5 }, { mode: 'major', weight: 0.35 }, { mode: 'dorian', weight: 0.15 }],
    harmony: {
      progressions: [p('Imaj7 vi7 ii7 V7', 2), p('IVmaj7 iii7 vi7', 1.5), p('ii7 V7 Imaj7 vi7', 1.5), p('vi9 ii9 V9 Imaj7', 1), p('i7 iv7 VImaj7 V7', 1.5), p('i7 iv7', 1.2, VERSE), p('IVmaj7 V7', 1, PRE)],
      borrowedChordRate: 0.2,
      extensionRate: 0.85,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.rnb(2), T.popShort(1)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('electronic-kit', 'drums', 1, 'rhythm', true), inst('electric-bass', 'bass', 1, 'bass-line', true),
      inst('electric-piano', 'keys', 1, 'accompaniment', true), inst('synth-pad', 'synth-pad', 0.6, 'pad'), inst('backing-vocal', 'vocal', 0.5, 'harmony'),
      inst('electric-guitar-clean', 'rhythm-guitar', 0.35, 'accompaniment'), inst('string-ensemble', 'strings', 0.2, 'pad'),
    ],
    rhythm: { drumStyle: 'rnb', swing: 0.2, syncopation: 0.6, subdivision: 16, halfTimeChance: 0.2 },
    dynamics: { energyBySection: ENERGY_BAND({ verse: 45, chorus: 72, 'final-chorus': 82 }), dynamicRange: 0.5 },
    arrangement: { densityAtLowEnergy: 0.5, densityAtHighEnergy: 1, conventions: ['Syncopated kick with ghost-note snares', 'Rhodes chords with 7ths and 9ths', 'Stacked backing vocals in the chorus'] },
    production: { description: 'Smooth contemporary R&B: warm keys, deep bass, silky layered vocals', reverb: 0.3, keywords: ['r&b', 'smooth', 'soulful', 'warm'], masteringTarget: 'streaming' },
    macros: { syncopation: 0.6, harmonicTension: 0.55, humanization: 0.4, complexity: 0.55 },
  },
  {
    id: 'hip-hop',
    name: 'Hip-Hop',
    description: 'Beat-driven: boom-bap or trap drums, deep 808 bass, looped harmony and rhythmic vocals.',
    builtIn: true,
    tags: ['beats', 'urban', 'vocal'],
    tempo: { min: 70, max: 100, typical: 88 },
    meters: [{ numerator: 4, denominator: 4, weight: 1 }],
    modes: [{ mode: 'minor', weight: 0.8 }, { mode: 'major', weight: 0.2 }],
    harmony: {
      progressions: [p('i VI', 2), p('i iv', 1.5), p('i VI III VII', 1.5), p('vi IV', 1), p('i7 iv7 i7 V7', 1), p('VI VII', 1, PRE)],
      borrowedChordRate: 0.1,
      extensionRate: 0.4,
      harmonicRhythm: 0.5,
    },
    structure: { templates: [T.hipHop(2)] },
    instruments: [
      inst('lead-vocal', 'vocal', 1, 'melody', true), inst('electronic-kit', 'drums', 1, 'rhythm', true), inst('synth-bass', 'bass', 1, 'bass-line', true),
      inst('electric-piano', 'keys', 0.8, 'accompaniment', true), inst('synth-pad', 'synth-pad', 0.5, 'pad'), inst('string-ensemble', 'strings', 0.3, 'pad'),
      inst('synth-lead', 'synth-lead', 0.3, 'hook'),
    ],
    rhythm: { drumStyle: 'hip-hop', swing: 0.35, syncopation: 0.55, subdivision: 16, halfTimeChance: 0.3 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 45, verse: 62, chorus: 78, bridge: 55, outro: 45 }), dynamicRange: 0.35 },
    arrangement: { densityAtLowEnergy: 0.55, densityAtHighEnergy: 0.95, conventions: ['Looped two-chord harmony', 'Kick and 808 locked together', 'Sparse beat under the verses'] },
    production: { description: 'Hip-hop beat: dusty drums or crisp trap hats, deep 808, sample-like keys', reverb: 0.15, keywords: ['hip-hop', 'boom bap', '808', 'beat'], masteringTarget: 'streaming' },
    macros: { syncopation: 0.55, humanization: 0.25, repetition: 0.2, melodicMovement: 0.3 },
  },
  {
    id: 'orchestral',
    name: 'Orchestral',
    description: 'Classical orchestration: themes and development, functional harmony, sections of the orchestra in dialogue.',
    builtIn: true,
    tags: ['classical', 'acoustic', 'instrumental'],
    tempo: { min: 60, max: 140, typical: 92 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.6 }, { numerator: 3, denominator: 4, weight: 0.25 }, { numerator: 6, denominator: 8, weight: 0.15 }],
    modes: [{ mode: 'major', weight: 0.5 }, { mode: 'minor', weight: 0.4 }, { mode: 'harmonic-minor', weight: 0.1 }],
    harmony: {
      progressions: [
        p('I IV V I', 2), p('i iv V i', 2), p('I vi IV V', 1.5), p('I V vi iii IV I IV V', 1, VERSE), p('i VI III VII', 1.2), p('ii V I', 1, PRE),
        p('iv V', 1, PRE), p('VI iv V', 1, BRIDGE), p('I V/vi vi IV', 0.8, CHORUS),
      ],
      borrowedChordRate: 0.2,
      extensionRate: 0.15,
      harmonicRhythm: 1,
    },
    structure: { templates: [T.orchestral(2), T.cinematic(0.6)] },
    instruments: [
      inst('string-ensemble', 'strings', 1, 'pad', true), inst('violin', 'strings', 1, 'melody', true), inst('cello', 'strings', 0.8, 'counter-melody'),
      inst('contrabass', 'strings', 0.8, 'bass-line'), inst('french-horn', 'custom', 0.7, 'harmony'), inst('flute', 'custom', 0.5, 'counter-melody'),
      inst('clarinet', 'custom', 0.35, 'harmony'), inst('trumpet', 'custom', 0.35, 'counter-melody'), inst('harp', 'keys', 0.4, 'accompaniment'),
      inst('timpani', 'percussion', 0.6, 'rhythm'), inst('glockenspiel', 'keys', 0.15, 'hook'),
    ],
    rhythm: { drumStyle: 'orchestral', swing: 0, syncopation: 0.15, subdivision: 8, halfTimeChance: 0 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 25, verse: 38, bridge: 55, build: 70, chorus: 82, 'final-chorus': 98, outro: 30 }), dynamicRange: 0.9 },
    arrangement: { densityAtLowEnergy: 0.35, densityAtHighEnergy: 1, conventions: ['Melody passed between sections', 'Tutti at the climax', 'Woodwind colour in quiet passages'] },
    production: { description: 'Concert-hall orchestra: natural hall reverb, wide dynamic range', reverb: 0.55, keywords: ['orchestral', 'symphonic', 'concert hall', 'strings'], masteringTarget: 'dynamic' },
    macros: { humanization: 0.45, dynamics: 0.85, syncopation: 0.15, complexity: 0.55 },
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Film-score drama: ostinatos, big percussion, brass swells and towering builds.',
    builtIn: true,
    tags: ['film', 'epic', 'instrumental'],
    tempo: { min: 70, max: 140, typical: 100 },
    meters: [{ numerator: 4, denominator: 4, weight: 0.8 }, { numerator: 6, denominator: 8, weight: 0.1 }, { numerator: 3, denominator: 4, weight: 0.1 }],
    modes: [{ mode: 'minor', weight: 0.7 }, { mode: 'dorian', weight: 0.1 }, { mode: 'major', weight: 0.2 }],
    harmony: {
      progressions: [p('i VI III VII', 3), p('i VI VII i', 2), p('VI III VII i', 1.2), p('i III VII IV', 1), p('i iv VI V', 1), p('VI VII', 1.2, PRE), p('iv VI VII', 1, [...PRE, ...BRIDGE])],
      borrowedChordRate: 0.18,
      extensionRate: 0.2,
      harmonicRhythm: 0.5,
    },
    structure: { templates: [T.cinematic(2), T.orchestral(0.8)] },
    instruments: [
      inst('string-ensemble', 'strings', 1, 'pad', true), inst('cello', 'strings', 0.9, 'rhythm', true), inst('brass-section', 'custom', 0.9, 'harmony'),
      inst('french-horn', 'custom', 0.6, 'melody'), inst('piano', 'keys', 0.5, 'accompaniment'), inst('choir', 'vocal', 0.5, 'pad'),
      inst('timpani', 'percussion', 0.7, 'rhythm'), inst('drum-kit', 'drums', 0.5, 'rhythm'), inst('synth-pad', 'synth-pad', 0.5, 'pad'),
      inst('contrabass', 'strings', 0.6, 'bass-line'),
    ],
    rhythm: { drumStyle: 'cinematic', swing: 0, syncopation: 0.25, subdivision: 16, halfTimeChance: 0.2 },
    dynamics: { energyBySection: ENERGY_BAND({ intro: 22, verse: 38, build: 72, chorus: 88, breakdown: 30, 'final-chorus': 100, outro: 25 }), dynamicRange: 0.95 },
    arrangement: {
      densityAtLowEnergy: 0.3,
      densityAtHighEnergy: 1,
      restsBySection: { intro: ['drums'], breakdown: ['drums', 'percussion'] },
      conventions: ['Low-string ostinato drives the tension', 'Percussion and brass enter for the climax', 'Long crescendos into impacts'],
    },
    production: { description: 'Epic trailer score: massive percussion, brass swells, huge hall', reverb: 0.6, keywords: ['cinematic', 'epic', 'trailer', 'orchestral hybrid'], masteringTarget: 'dynamic' },
    macros: { dynamics: 0.9, energy: 0.6, humanization: 0.3, repetition: 0.3 },
  },
];

const BY_ID = new Map(BUILTIN_GENRES.map((g) => [g.id, g]));

const GENRE_ALIASES: Record<string, string> = {
  'alt-rock': 'alternative-rock',
  alternative: 'alternative-rock',
  'alt rock': 'alternative-rock',
  'synthpop': 'synth-pop',
  'poppunk': 'pop-punk',
  'indie': 'indie-rock',
  'r&b': 'rnb',
  'r-b': 'rnb',
  'rhythm-and-blues': 'rnb',
  'hiphop': 'hip-hop',
  'rap': 'hip-hop',
  'trap': 'hip-hop',
  'classical': 'orchestral',
  'film-score': 'cinematic',
  'heavy-metal': 'metal',
  'electronic': 'edm',
  'dance': 'edm',
};

function normalizeGenreId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/&/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Genre by id (custom profiles first). Accepts common aliases ("alt-rock", "r&b", "synthpop"). */
export function getGenre(id: string, custom?: GenreProfile[]): GenreProfile | undefined {
  if (!id) return undefined;
  const c = custom?.find((g) => g.id === id);
  if (c) return c;
  const b = BY_ID.get(id);
  if (b) return b;
  const n = normalizeGenreId(id);
  const alias = GENRE_ALIASES[id.trim().toLowerCase()] ?? GENRE_ALIASES[n];
  return custom?.find((g) => normalizeGenreId(g.id) === n || normalizeGenreId(g.name) === n) ?? BY_ID.get(n) ?? (alias ? BY_ID.get(alias) : undefined) ?? BUILTIN_GENRES.find((g) => normalizeGenreId(g.name) === n);
}

/** Resolve a blend to (profile, normalized weight) pairs, dropping unknown ids. Falls back to pop. */
export function resolveBlend(weights: readonly GenreWeight[], custom?: GenreProfile[]): { genre: GenreProfile; weight: number }[] {
  const merged = new Map<string, { genre: GenreProfile; weight: number }>();
  for (const w of weights ?? []) {
    const g = getGenre(w.genreId, custom);
    const wt = Number.isFinite(w.weight) ? Math.max(0, w.weight) : 0;
    if (!g || wt <= 0) continue;
    const prev = merged.get(g.id);
    if (prev) prev.weight += wt;
    else merged.set(g.id, { genre: g, weight: wt });
  }
  const list = [...merged.values()];
  if (!list.length) return [{ genre: BY_ID.get('pop')!, weight: 1 }];
  const total = list.reduce((s2, e) => s2 + e.weight, 0);
  return list.map((e) => ({ genre: e.genre, weight: e.weight / total })).sort((a, b) => b.weight - a.weight);
}

function cloneGenre(g: GenreProfile): GenreProfile {
  return JSON.parse(JSON.stringify(g)) as GenreProfile;
}

/**
 * Weighted blend of genre profiles. Numeric traits are weight-averaged; pools (progressions,
 * structures, instruments, keywords) are merged with weights scaled by each genre's share; the
 * dominant genre decides categorical traits (drum style, subdivision, mastering target).
 */
export function blendGenres(weights: GenreWeight[], custom?: GenreProfile[]): GenreProfile {
  const parts = resolveBlend(weights, custom);
  if (parts.length === 1) return cloneGenre(parts[0].genre);
  const dom = parts[0].genre;
  const avg = (f: (g: GenreProfile) => number) => weightedAverage(parts.map((e) => [f(e.genre), e.weight]));

  const meters = new Map<string, { numerator: number; denominator: number; weight: number }>();
  const modes = new Map<ModeName, number>();
  const progressions = new Map<string, Prog>();
  const templates: GenreProfile['structure']['templates'] = [];
  const instruments = new Map<string, Inst>();
  const energy = new Map<SectionKind, [number, number][]>();
  const rests = new Map<SectionKind, Map<TrackRole, number>>();
  const keywords = new Map<string, number>();
  const conventions: string[] = [];
  const tags = new Set<string>();
  const macroPairs = new Map<keyof MacroSettings, [number, number][]>();

  for (const { genre: g, weight: w } of parts) {
    const gm = g.meters.reduce((t, m) => t + m.weight, 0) || 1;
    for (const m of g.meters) {
      const k = `${m.numerator}/${m.denominator}`;
      const e = meters.get(k) ?? { numerator: m.numerator, denominator: m.denominator, weight: 0 };
      e.weight += (m.weight / gm) * w;
      meters.set(k, e);
    }
    const gmo = g.modes.reduce((t, m) => t + m.weight, 0) || 1;
    for (const m of g.modes) modes.set(m.mode, (modes.get(m.mode) ?? 0) + (m.weight / gmo) * w);
    for (const pr of g.harmony.progressions) {
      const k = `${pr.roman.join(' ')}|${(pr.sectionKinds ?? []).join(',')}`;
      const e = progressions.get(k);
      if (e) e.weight += pr.weight * w;
      else progressions.set(k, { roman: [...pr.roman], weight: pr.weight * w, ...(pr.sectionKinds ? { sectionKinds: [...pr.sectionKinds] } : {}) });
    }
    for (const t of g.structure.templates) templates.push({ name: `${t.name} (${g.name})`, weight: t.weight * w, sections: t.sections.map((x) => ({ ...x })) });
    const seen = new Map<string, number>();
    for (const i of g.instruments) {
      const base = `${i.instrumentId}|${i.role}|${i.function ?? ''}`;
      const occ = (seen.get(base) ?? 0) + 1;
      seen.set(base, occ);
      const k = `${base}|${occ}`;
      const e = instruments.get(k);
      if (e) {
        e.weight += i.weight * w;
        if (i.essential && w >= 0.3) e.essential = true;
      } else {
        instruments.set(k, { ...i, weight: i.weight * w, ...(i.essential && (w >= 0.3 || g === dom) ? { essential: true } : { essential: undefined }) });
      }
    }
    for (const [kind, v] of Object.entries(g.dynamics.energyBySection) as [SectionKind, number][]) {
      const arr = energy.get(kind) ?? [];
      arr.push([v, w]);
      energy.set(kind, arr);
    }
    for (const [kind, roles] of Object.entries(g.arrangement.restsBySection ?? {}) as [SectionKind, TrackRole[]][]) {
      const m = rests.get(kind) ?? new Map<TrackRole, number>();
      for (const r of roles) m.set(r, (m.get(r) ?? 0) + w);
      rests.set(kind, m);
    }
    for (const kw of g.production.keywords) keywords.set(kw, (keywords.get(kw) ?? 0) + w);
    for (const c of g.arrangement.conventions) if (!conventions.includes(c)) conventions.push(c);
    for (const t of g.tags ?? []) tags.add(t);
    for (const [k, v] of Object.entries(g.macros ?? {}) as [keyof MacroSettings, number][]) {
      const arr = macroPairs.get(k) ?? [];
      arr.push([v, w]);
      macroPairs.set(k, arr);
    }
  }

  const restsBySection: Partial<Record<SectionKind, TrackRole[]>> = {};
  for (const [kind, m] of rests) {
    const roles = [...m.entries()].filter(([, w]) => w >= 0.5).map(([r]) => r);
    if (roles.length) restsBySection[kind] = roles;
  }
  const energyBySection: Partial<Record<SectionKind, number>> = {};
  for (const [kind, pairs] of energy) energyBySection[kind] = Math.round(weightedAverage(pairs));
  const macros: Partial<MacroSettings> = {};
  for (const [k, pairs] of macroPairs) macros[k] = Math.round(weightedAverage(pairs) * 1000) / 1000;
  const pct = (w: number) => Math.round(w * 100);
  const powerShare = parts.filter((e) => e.genre.harmony.powerChords).reduce((t, e) => t + e.weight, 0);

  return {
    id: `blend:${parts.map((e) => `${e.genre.id}-${pct(e.weight)}`).join('+')}`,
    name: parts.map((e) => `${pct(e.weight)}% ${e.genre.name}`).join(' / '),
    description: `Blend of ${parts.map((e) => e.genre.name).join(', ')}.`,
    builtIn: false,
    tags: [...tags],
    tempo: {
      min: Math.round(avg((g) => g.tempo.min)),
      max: Math.round(avg((g) => g.tempo.max)),
      typical: Math.round(avg((g) => g.tempo.typical)),
    },
    meters: [...meters.values()].sort((a, b) => b.weight - a.weight),
    modes: [...modes.entries()].map(([mode, weight]) => ({ mode, weight })).sort((a, b) => b.weight - a.weight),
    harmony: {
      progressions: [...progressions.values()],
      borrowedChordRate: avg((g) => g.harmony.borrowedChordRate),
      extensionRate: avg((g) => g.harmony.extensionRate),
      harmonicRhythm: avg((g) => g.harmony.harmonicRhythm),
      powerChords: powerShare >= 0.5,
    },
    structure: { templates },
    instruments: [...instruments.values()].map((i) => {
      const out: Inst = { instrumentId: i.instrumentId, role: i.role, weight: i.weight };
      if (i.function) out.function = i.function;
      if (i.essential) out.essential = true;
      return out;
    }),
    rhythm: {
      drumStyle: dom.rhythm.drumStyle,
      swing: avg((g) => g.rhythm.swing),
      syncopation: avg((g) => g.rhythm.syncopation),
      subdivision: dom.rhythm.subdivision,
      halfTimeChance: avg((g) => g.rhythm.halfTimeChance ?? 0),
    },
    dynamics: { energyBySection, dynamicRange: avg((g) => g.dynamics.dynamicRange) },
    arrangement: {
      densityAtLowEnergy: avg((g) => g.arrangement.densityAtLowEnergy),
      densityAtHighEnergy: avg((g) => g.arrangement.densityAtHighEnergy),
      restsBySection,
      conventions,
    },
    production: {
      description: parts.map((e) => `${pct(e.weight)}% ${e.genre.production.description}`).join('; '),
      reverb: avg((g) => g.production.reverb),
      keywords: [...keywords.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
      masteringTarget: dom.production.masteringTarget,
    },
    macros,
  };
}

/** The blend's profile for a song (song.genreBlend), defaulting to pop. */
export function genreForBlend(blend: readonly GenreWeight[] | undefined, custom?: GenreProfile[]): GenreProfile {
  return blendGenres(blend && blend.length ? [...blend] : [{ genreId: 'pop', weight: 1 }], custom);
}
