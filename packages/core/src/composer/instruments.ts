/**
 * Built-in instrument profiles (spec §17). Ids and patch ids are a contract with the audio
 * renderer (`patchId` → guide-render synth patch) and the UI.
 */
import type { Articulation, InstrumentProfile } from '../ir/types';

const STRING_ARTIC: Articulation[] = [
  'normal',
  'legato',
  'staccato',
  'pizzicato',
  'tremolo',
  'accent',
  'marcato',
  'tenuto',
];
const WIND_ARTIC: Articulation[] = ['normal', 'legato', 'staccato', 'accent', 'marcato', 'tenuto'];
const GUITAR_ARTIC: Articulation[] = [
  'normal',
  'palm-mute',
  'staccato',
  'accent',
  'dead',
  'slide',
  'bend',
  'harmonic',
];
const KEYS_ARTIC: Articulation[] = ['normal', 'staccato', 'legato', 'accent', 'tenuto'];
const DRUM_ARTIC: Articulation[] = ['normal', 'accent', 'ghost'];
const SYNTH_ARTIC: Articulation[] = ['normal', 'staccato', 'legato', 'accent', 'slide'];
const VOCAL_ARTIC: Articulation[] = ['normal', 'legato', 'staccato', 'accent', 'slide'];

export const BUILTIN_INSTRUMENTS: InstrumentProfile[] = [
  // --- Drums & percussion -------------------------------------------------
  {
    id: 'drum-kit',
    name: 'Drum Kit',
    family: 'drums',
    gmProgram: 0,
    isDrumKit: true,
    range: { low: 27, high: 87 },
    polyphony: 'poly',
    defaultRole: 'drums',
    defaultFunction: 'rhythm',
    articulations: DRUM_ARTIC,
    patchId: 'drums-acoustic',
    clef: 'percussion',
    stemGroup: 'drums',
  },
  {
    id: 'electronic-kit',
    name: 'Electronic Drum Kit',
    family: 'drums',
    gmProgram: 25,
    isDrumKit: true,
    range: { low: 27, high: 87 },
    polyphony: 'poly',
    defaultRole: 'drums',
    defaultFunction: 'rhythm',
    articulations: DRUM_ARTIC,
    patchId: 'drums-electronic',
    clef: 'percussion',
    stemGroup: 'drums',
  },
  {
    id: 'percussion',
    name: 'Percussion',
    family: 'percussion',
    gmProgram: 0,
    isDrumKit: true,
    range: { low: 27, high: 87 },
    polyphony: 'poly',
    defaultRole: 'percussion',
    defaultFunction: 'rhythm',
    articulations: DRUM_ARTIC,
    patchId: 'percussion',
    clef: 'percussion',
    stemGroup: 'drums',
  },
  // --- Bass -----------------------------------------------------------------
  {
    id: 'electric-bass',
    name: 'Electric Bass',
    family: 'bass',
    gmProgram: 33,
    range: { low: 28, high: 55, comfortableLow: 28, comfortableHigh: 50 },
    polyphony: 'mono',
    defaultRole: 'bass',
    defaultFunction: 'bass-line',
    articulations: ['normal', 'staccato', 'accent', 'slide', 'ghost', 'palm-mute'],
    patchId: 'bass-electric',
    clef: 'bass',
    notationTranspose: 12,
    stemGroup: 'bass',
  },
  {
    id: 'synth-bass',
    name: 'Synth Bass',
    family: 'bass',
    gmProgram: 38,
    range: { low: 24, high: 60, comfortableLow: 28, comfortableHigh: 52 },
    polyphony: 'mono',
    defaultRole: 'bass',
    defaultFunction: 'bass-line',
    articulations: ['normal', 'staccato', 'accent', 'slide', 'legato'],
    patchId: 'bass-synth',
    clef: 'bass',
    stemGroup: 'bass',
  },
  {
    id: 'upright-bass',
    name: 'Upright Bass',
    family: 'bass',
    gmProgram: 32,
    range: { low: 28, high: 55, comfortableLow: 28, comfortableHigh: 50 },
    polyphony: 'mono',
    defaultRole: 'bass',
    defaultFunction: 'bass-line',
    articulations: ['normal', 'staccato', 'pizzicato', 'accent', 'slide', 'ghost'],
    patchId: 'bass-upright',
    clef: 'bass',
    notationTranspose: 12,
    stemGroup: 'bass',
  },
  // --- Guitars --------------------------------------------------------------
  {
    id: 'electric-guitar-distorted',
    name: 'Distorted Guitar',
    family: 'guitar',
    gmProgram: 30,
    range: { low: 40, high: 86, comfortableLow: 40, comfortableHigh: 76 },
    polyphony: 'poly',
    defaultRole: 'rhythm-guitar',
    defaultFunction: 'rhythm',
    articulations: GUITAR_ARTIC,
    patchId: 'guitar-distorted',
    clef: 'treble-8vb',
    notationTranspose: 12,
    stemGroup: 'guitars',
  },
  {
    id: 'electric-guitar-clean',
    name: 'Clean Electric Guitar',
    family: 'guitar',
    gmProgram: 27,
    range: { low: 40, high: 86, comfortableLow: 40, comfortableHigh: 79 },
    polyphony: 'poly',
    defaultRole: 'rhythm-guitar',
    defaultFunction: 'accompaniment',
    articulations: GUITAR_ARTIC,
    patchId: 'guitar-clean',
    clef: 'treble-8vb',
    notationTranspose: 12,
    stemGroup: 'guitars',
  },
  {
    id: 'acoustic-guitar',
    name: 'Acoustic Guitar',
    family: 'guitar',
    gmProgram: 25,
    range: { low: 40, high: 84, comfortableLow: 40, comfortableHigh: 76 },
    polyphony: 'poly',
    defaultRole: 'rhythm-guitar',
    defaultFunction: 'accompaniment',
    articulations: ['normal', 'palm-mute', 'staccato', 'accent', 'dead', 'slide', 'harmonic'],
    patchId: 'guitar-acoustic',
    clef: 'treble-8vb',
    notationTranspose: 12,
    stemGroup: 'guitars',
  },
  {
    id: 'electric-guitar-lead',
    name: 'Lead Guitar',
    family: 'guitar',
    gmProgram: 29,
    range: { low: 40, high: 88, comfortableLow: 52, comfortableHigh: 84 },
    polyphony: 'mono',
    defaultRole: 'lead-guitar',
    defaultFunction: 'hook',
    articulations: GUITAR_ARTIC,
    patchId: 'guitar-lead',
    clef: 'treble-8vb',
    notationTranspose: 12,
    stemGroup: 'guitars',
  },
  // --- Keys -----------------------------------------------------------------
  {
    id: 'piano',
    name: 'Piano',
    family: 'keys',
    gmProgram: 0,
    range: { low: 21, high: 108, comfortableLow: 36, comfortableHigh: 91 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'accompaniment',
    articulations: KEYS_ARTIC,
    patchId: 'piano',
    clef: 'grand',
    stemGroup: 'keys',
  },
  {
    id: 'electric-piano',
    name: 'Electric Piano',
    family: 'keys',
    gmProgram: 4,
    range: { low: 28, high: 100, comfortableLow: 40, comfortableHigh: 86 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'accompaniment',
    articulations: KEYS_ARTIC,
    patchId: 'epiano',
    clef: 'grand',
    stemGroup: 'keys',
  },
  {
    id: 'organ',
    name: 'Organ',
    family: 'organ',
    gmProgram: 16,
    range: { low: 36, high: 96, comfortableLow: 43, comfortableHigh: 84 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'pad',
    articulations: ['normal', 'staccato', 'legato', 'accent'],
    patchId: 'organ',
    clef: 'grand',
    stemGroup: 'keys',
  },
  // --- Strings --------------------------------------------------------------
  {
    id: 'violin',
    name: 'Violin',
    family: 'strings',
    gmProgram: 40,
    range: { low: 55, high: 100, comfortableLow: 55, comfortableHigh: 88 },
    polyphony: 'mono',
    defaultRole: 'strings',
    defaultFunction: 'counter-melody',
    articulations: STRING_ARTIC,
    patchId: 'strings-solo',
    clef: 'treble',
    stemGroup: 'strings',
  },
  {
    id: 'viola',
    name: 'Viola',
    family: 'strings',
    gmProgram: 41,
    range: { low: 48, high: 88, comfortableLow: 48, comfortableHigh: 79 },
    polyphony: 'mono',
    defaultRole: 'strings',
    defaultFunction: 'harmony',
    articulations: STRING_ARTIC,
    patchId: 'strings-solo',
    clef: 'treble',
    stemGroup: 'strings',
  },
  {
    id: 'cello',
    name: 'Cello',
    family: 'strings',
    gmProgram: 42,
    range: { low: 36, high: 76, comfortableLow: 36, comfortableHigh: 69 },
    polyphony: 'mono',
    defaultRole: 'strings',
    defaultFunction: 'counter-melody',
    articulations: STRING_ARTIC,
    patchId: 'strings-solo',
    clef: 'bass',
    stemGroup: 'strings',
  },
  {
    id: 'contrabass',
    name: 'Contrabass',
    family: 'strings',
    gmProgram: 43,
    range: { low: 28, high: 67, comfortableLow: 28, comfortableHigh: 55 },
    polyphony: 'mono',
    defaultRole: 'strings',
    defaultFunction: 'bass-line',
    articulations: STRING_ARTIC,
    patchId: 'strings-solo',
    clef: 'bass',
    notationTranspose: 12,
    stemGroup: 'strings',
  },
  {
    id: 'string-ensemble',
    name: 'String Ensemble',
    family: 'strings',
    gmProgram: 48,
    range: { low: 28, high: 100, comfortableLow: 40, comfortableHigh: 88 },
    polyphony: 'poly',
    defaultRole: 'strings',
    defaultFunction: 'pad',
    articulations: STRING_ARTIC,
    patchId: 'strings-ensemble',
    clef: 'grand',
    stemGroup: 'strings',
  },
  {
    id: 'pizzicato-strings',
    name: 'Pizzicato Strings',
    family: 'strings',
    gmProgram: 45,
    range: { low: 28, high: 96, comfortableLow: 36, comfortableHigh: 84 },
    polyphony: 'poly',
    defaultRole: 'strings',
    defaultFunction: 'accompaniment',
    articulations: ['pizzicato', 'normal', 'accent'],
    patchId: 'strings-pizz',
    clef: 'grand',
    stemGroup: 'strings',
  },
  {
    id: 'harp',
    name: 'Harp',
    family: 'strings',
    gmProgram: 46,
    range: { low: 24, high: 103, comfortableLow: 36, comfortableHigh: 91 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'accompaniment',
    articulations: ['normal', 'harmonic', 'legato'],
    patchId: 'harp',
    clef: 'grand',
    stemGroup: 'strings',
  },
  // --- Brass ----------------------------------------------------------------
  {
    id: 'trumpet',
    name: 'Trumpet',
    family: 'brass',
    gmProgram: 56,
    range: { low: 52, high: 82, comfortableLow: 58, comfortableHigh: 77 },
    polyphony: 'mono',
    defaultRole: 'custom',
    defaultFunction: 'counter-melody',
    articulations: WIND_ARTIC,
    patchId: 'brass-solo',
    clef: 'treble',
    notationTranspose: 2,
    stemGroup: 'others',
  },
  {
    id: 'trombone',
    name: 'Trombone',
    family: 'brass',
    gmProgram: 57,
    range: { low: 40, high: 72, comfortableLow: 45, comfortableHigh: 67 },
    polyphony: 'mono',
    defaultRole: 'custom',
    defaultFunction: 'harmony',
    articulations: [...WIND_ARTIC, 'slide'],
    patchId: 'brass-solo',
    clef: 'bass',
    stemGroup: 'others',
  },
  {
    id: 'french-horn',
    name: 'French Horn',
    family: 'brass',
    gmProgram: 60,
    range: { low: 34, high: 77, comfortableLow: 41, comfortableHigh: 72 },
    polyphony: 'mono',
    defaultRole: 'custom',
    defaultFunction: 'harmony',
    articulations: WIND_ARTIC,
    patchId: 'brass-solo',
    clef: 'treble',
    notationTranspose: 7,
    stemGroup: 'others',
  },
  {
    id: 'brass-section',
    name: 'Brass Section',
    family: 'brass',
    gmProgram: 61,
    range: { low: 40, high: 84, comfortableLow: 48, comfortableHigh: 79 },
    polyphony: 'poly',
    defaultRole: 'custom',
    defaultFunction: 'harmony',
    articulations: WIND_ARTIC,
    patchId: 'brass',
    clef: 'grand',
    stemGroup: 'others',
  },
  // --- Woodwinds ------------------------------------------------------------
  {
    id: 'flute',
    name: 'Flute',
    family: 'woodwind',
    gmProgram: 73,
    range: { low: 60, high: 96, comfortableLow: 62, comfortableHigh: 91 },
    polyphony: 'mono',
    defaultRole: 'custom',
    defaultFunction: 'counter-melody',
    articulations: WIND_ARTIC,
    patchId: 'flute',
    clef: 'treble',
    stemGroup: 'others',
  },
  {
    id: 'clarinet',
    name: 'Clarinet',
    family: 'woodwind',
    gmProgram: 71,
    range: { low: 50, high: 91, comfortableLow: 52, comfortableHigh: 84 },
    polyphony: 'mono',
    defaultRole: 'custom',
    defaultFunction: 'counter-melody',
    articulations: WIND_ARTIC,
    patchId: 'reed',
    clef: 'treble',
    notationTranspose: 2,
    stemGroup: 'others',
  },
  {
    id: 'saxophone',
    name: 'Saxophone',
    family: 'woodwind',
    gmProgram: 65,
    range: { low: 49, high: 81, comfortableLow: 51, comfortableHigh: 77 },
    polyphony: 'mono',
    defaultRole: 'custom',
    defaultFunction: 'melody',
    articulations: [...WIND_ARTIC, 'slide'],
    patchId: 'reed',
    clef: 'treble',
    notationTranspose: 9,
    stemGroup: 'others',
  },
  // --- Synths ---------------------------------------------------------------
  {
    id: 'synth-pad',
    name: 'Synth Pad',
    family: 'synth',
    gmProgram: 89,
    range: { low: 36, high: 96, comfortableLow: 48, comfortableHigh: 84 },
    polyphony: 'poly',
    defaultRole: 'synth-pad',
    defaultFunction: 'pad',
    articulations: SYNTH_ARTIC,
    patchId: 'pad-warm',
    clef: 'grand',
    stemGroup: 'keys',
  },
  {
    id: 'synth-lead',
    name: 'Synth Lead',
    family: 'synth',
    gmProgram: 81,
    range: { low: 48, high: 96, comfortableLow: 55, comfortableHigh: 88 },
    polyphony: 'mono',
    defaultRole: 'synth-lead',
    defaultFunction: 'hook',
    articulations: SYNTH_ARTIC,
    patchId: 'lead-saw',
    clef: 'treble',
    stemGroup: 'keys',
  },
  {
    id: 'synth-arp',
    name: 'Synth Arp',
    family: 'synth',
    gmProgram: 80,
    range: { low: 43, high: 96, comfortableLow: 52, comfortableHigh: 88 },
    polyphony: 'poly',
    defaultRole: 'synth-arp',
    defaultFunction: 'texture',
    articulations: SYNTH_ARTIC,
    patchId: 'pluck',
    clef: 'treble',
    stemGroup: 'keys',
  },
  {
    id: 'synth-seq',
    name: 'Synth Sequence',
    family: 'synth',
    gmProgram: 87,
    range: { low: 36, high: 88, comfortableLow: 43, comfortableHigh: 76 },
    polyphony: 'poly',
    defaultRole: 'synth-seq',
    defaultFunction: 'rhythm',
    articulations: SYNTH_ARTIC,
    patchId: 'pluck',
    clef: 'treble',
    stemGroup: 'keys',
  },
  // --- Voices -----------------------------------------------------------------
  {
    id: 'choir',
    name: 'Choir',
    family: 'vocal',
    gmProgram: 52,
    range: { low: 40, high: 84, comfortableLow: 45, comfortableHigh: 79 },
    polyphony: 'poly',
    defaultRole: 'vocal',
    defaultFunction: 'pad',
    articulations: VOCAL_ARTIC,
    patchId: 'choir',
    clef: 'grand',
    stemGroup: 'vocals',
  },
  {
    // Absolute range spans every voice type (bass E2 … soprano C6); the comfortable range is a
    // tenor's. Generators use the track's voice type (VOICE_RANGES) for the actual tessitura.
    id: 'lead-vocal',
    name: 'Lead Vocal',
    family: 'vocal',
    gmProgram: 53,
    range: { low: 40, high: 84, comfortableLow: 50, comfortableHigh: 69 },
    polyphony: 'mono',
    defaultRole: 'vocal',
    defaultFunction: 'melody',
    articulations: VOCAL_ARTIC,
    patchId: 'vocal-placeholder',
    clef: 'treble-8vb',
    notationTranspose: 12,
    stemGroup: 'vocals',
  },
  {
    id: 'backing-vocal',
    name: 'Backing Vocals',
    family: 'vocal',
    gmProgram: 52,
    range: { low: 40, high: 84, comfortableLow: 52, comfortableHigh: 74 },
    polyphony: 'mono',
    defaultRole: 'vocal',
    defaultFunction: 'harmony',
    articulations: VOCAL_ARTIC,
    patchId: 'vocal-placeholder',
    clef: 'treble',
    stemGroup: 'vocals',
  },
  // --- Pitched percussion ---------------------------------------------------
  {
    id: 'timpani',
    name: 'Timpani',
    family: 'percussion',
    gmProgram: 47,
    range: { low: 38, high: 60, comfortableLow: 40, comfortableHigh: 57 },
    polyphony: 'poly',
    defaultRole: 'percussion',
    defaultFunction: 'rhythm',
    articulations: ['normal', 'accent', 'tremolo', 'marcato'],
    patchId: 'timpani',
    clef: 'bass',
    stemGroup: 'drums',
  },
  {
    id: 'glockenspiel',
    name: 'Glockenspiel',
    family: 'percussion',
    gmProgram: 9,
    range: { low: 79, high: 108, comfortableLow: 79, comfortableHigh: 103 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'hook',
    articulations: ['normal', 'accent'],
    patchId: 'bell',
    clef: 'treble',
    notationTranspose: -24,
    stemGroup: 'others',
  },
  {
    id: 'marimba',
    name: 'Marimba',
    family: 'percussion',
    gmProgram: 12,
    range: { low: 45, high: 96, comfortableLow: 48, comfortableHigh: 91 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'accompaniment',
    articulations: ['normal', 'accent', 'tremolo'],
    patchId: 'mallet',
    clef: 'grand',
    stemGroup: 'others',
  },
  // --- Genre-specific and world instruments (genre expansion) ---------------
  {
    id: 'nylon-guitar',
    name: 'Nylon Guitar',
    family: 'guitar',
    gmProgram: 24,
    range: { low: 40, high: 83, comfortableLow: 40, comfortableHigh: 76 },
    polyphony: 'poly',
    defaultRole: 'rhythm-guitar',
    defaultFunction: 'accompaniment',
    articulations: ['normal', 'staccato', 'accent', 'dead', 'slide', 'harmonic'],
    patchId: 'guitar-nylon',
    clef: 'treble-8vb',
    notationTranspose: 12,
    stemGroup: 'guitars',
  },
  {
    id: 'banjo',
    name: 'Banjo',
    family: 'guitar',
    gmProgram: 105,
    range: { low: 48, high: 86, comfortableLow: 50, comfortableHigh: 81 },
    polyphony: 'poly',
    defaultRole: 'rhythm-guitar',
    defaultFunction: 'accompaniment',
    articulations: ['normal', 'staccato', 'accent', 'slide', 'harmonic'],
    patchId: 'banjo',
    clef: 'treble-8vb',
    notationTranspose: 12,
    stemGroup: 'guitars',
  },
  {
    id: 'mandolin',
    name: 'Mandolin',
    family: 'guitar',
    gmProgram: 25,
    range: { low: 55, high: 88, comfortableLow: 55, comfortableHigh: 84 },
    polyphony: 'poly',
    defaultRole: 'rhythm-guitar',
    defaultFunction: 'accompaniment',
    articulations: ['normal', 'staccato', 'accent', 'tremolo', 'slide'],
    patchId: 'mandolin',
    clef: 'treble',
    stemGroup: 'guitars',
  },
  {
    id: 'pedal-steel',
    name: 'Pedal Steel Guitar',
    family: 'guitar',
    gmProgram: 27,
    range: { low: 40, high: 88, comfortableLow: 52, comfortableHigh: 84 },
    polyphony: 'mono',
    defaultRole: 'lead-guitar',
    defaultFunction: 'counter-melody',
    articulations: ['normal', 'legato', 'slide', 'bend', 'accent'],
    patchId: 'pedal-steel',
    clef: 'treble-8vb',
    notationTranspose: 12,
    stemGroup: 'guitars',
  },
  {
    id: 'sitar',
    name: 'Sitar',
    family: 'guitar',
    gmProgram: 104,
    range: { low: 48, high: 84, comfortableLow: 53, comfortableHigh: 79 },
    polyphony: 'mono',
    defaultRole: 'custom',
    defaultFunction: 'counter-melody',
    articulations: ['normal', 'legato', 'slide', 'bend', 'accent'],
    patchId: 'sitar',
    clef: 'treble',
    stemGroup: 'others',
  },
  {
    id: 'clavinet',
    name: 'Clavinet',
    family: 'keys',
    gmProgram: 7,
    range: { low: 29, high: 88, comfortableLow: 41, comfortableHigh: 84 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'accompaniment',
    articulations: KEYS_ARTIC,
    patchId: 'clavinet',
    clef: 'grand',
    stemGroup: 'keys',
  },
  {
    id: 'accordion',
    name: 'Accordion',
    family: 'keys',
    gmProgram: 21,
    range: { low: 41, high: 93, comfortableLow: 48, comfortableHigh: 86 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'accompaniment',
    articulations: ['normal', 'staccato', 'legato', 'accent'],
    patchId: 'accordion',
    clef: 'grand',
    stemGroup: 'keys',
  },
  {
    id: 'harmonica',
    name: 'Harmonica',
    family: 'woodwind',
    gmProgram: 22,
    range: { low: 60, high: 96, comfortableLow: 60, comfortableHigh: 88 },
    polyphony: 'mono',
    defaultRole: 'custom',
    defaultFunction: 'counter-melody',
    articulations: [...WIND_ARTIC, 'bend', 'slide'],
    patchId: 'harmonica',
    clef: 'treble',
    stemGroup: 'others',
  },
  {
    id: 'steel-pan',
    name: 'Steel Pan',
    family: 'percussion',
    gmProgram: 114,
    range: { low: 60, high: 88, comfortableLow: 62, comfortableHigh: 86 },
    polyphony: 'poly',
    defaultRole: 'keys',
    defaultFunction: 'hook',
    articulations: ['normal', 'accent', 'tremolo'],
    patchId: 'steel-pan',
    clef: 'treble',
    stemGroup: 'others',
  },
  {
    id: 'log-drum',
    name: 'Log Drum',
    family: 'bass',
    gmProgram: 117,
    range: { low: 31, high: 60, comfortableLow: 33, comfortableHigh: 55 },
    polyphony: 'mono',
    defaultRole: 'bass',
    defaultFunction: 'bass-line',
    articulations: ['normal', 'staccato', 'accent', 'slide'],
    patchId: 'log-drum',
    clef: 'bass',
    stemGroup: 'bass',
  },
  {
    id: '808-bass',
    name: '808 Bass',
    family: 'bass',
    gmProgram: 38,
    range: { low: 24, high: 55, comfortableLow: 26, comfortableHigh: 48 },
    polyphony: 'mono',
    defaultRole: 'bass',
    defaultFunction: 'bass-line',
    articulations: SYNTH_ARTIC,
    patchId: 'bass-808',
    clef: 'bass',
    stemGroup: 'bass',
  },
  {
    id: 'chip-lead',
    name: 'Chiptune Lead',
    family: 'synth',
    gmProgram: 80,
    range: { low: 48, high: 96, comfortableLow: 55, comfortableHigh: 88 },
    polyphony: 'mono',
    defaultRole: 'synth-lead',
    defaultFunction: 'hook',
    articulations: SYNTH_ARTIC,
    patchId: 'chip-pulse',
    clef: 'treble',
    stemGroup: 'keys',
  },
];

const BY_ID = new Map(BUILTIN_INSTRUMENTS.map((i) => [i.id, i]));

/** Common names → built-in ids (used for unknown ids and prompt words). */
const ALIASES: Record<string, string> = {
  drums: 'drum-kit',
  drum: 'drum-kit',
  kit: 'drum-kit',
  'acoustic-drums': 'drum-kit',
  'drum-machine': 'electronic-kit',
  'electronic-drums': 'electronic-kit',
  '808': '808-bass',
  '808s': '808-bass',
  'tr-808': 'electronic-kit',
  '808-drums': 'electronic-kit',
  perc: 'percussion',
  shaker: 'percussion',
  tambourine: 'percussion',
  bass: 'electric-bass',
  'bass-guitar': 'electric-bass',
  'acoustic-bass': 'upright-bass',
  'double-bass': 'upright-bass',
  guitar: 'electric-guitar-clean',
  'electric-guitar': 'electric-guitar-clean',
  'clean-guitar': 'electric-guitar-clean',
  'distorted-guitar': 'electric-guitar-distorted',
  'overdriven-guitar': 'electric-guitar-distorted',
  'rhythm-guitar': 'electric-guitar-distorted',
  'lead-guitar': 'electric-guitar-lead',
  'classical-guitar': 'nylon-guitar',
  'spanish-guitar': 'nylon-guitar',
  'flamenco-guitar': 'nylon-guitar',
  'lap-steel': 'pedal-steel',
  'steel-guitar': 'pedal-steel',
  'pedal-steel-guitar': 'pedal-steel',
  clav: 'clavinet',
  squeezebox: 'accordion',
  'mouth-harp': 'harmonica',
  'blues-harp': 'harmonica',
  'steel-drum': 'steel-pan',
  'steel-drums': 'steel-pan',
  steelpan: 'steel-pan',
  'log-drums': 'log-drum',
  chiptune: 'chip-lead',
  '8-bit': 'chip-lead',
  'square-lead': 'chip-lead',
  '808-bass': '808-bass',
  keys: 'piano',
  keyboard: 'piano',
  'grand-piano': 'piano',
  epiano: 'electric-piano',
  'e-piano': 'electric-piano',
  rhodes: 'electric-piano',
  wurlitzer: 'electric-piano',
  hammond: 'organ',
  fiddle: 'violin',
  strings: 'string-ensemble',
  'string-section': 'string-ensemble',
  pizzicato: 'pizzicato-strings',
  horn: 'french-horn',
  horns: 'brass-section',
  brass: 'brass-section',
  sax: 'saxophone',
  'alto-sax': 'saxophone',
  'tenor-sax': 'saxophone',
  synth: 'synth-pad',
  pad: 'synth-pad',
  lead: 'synth-lead',
  arp: 'synth-arp',
  arpeggiator: 'synth-arp',
  sequencer: 'synth-seq',
  vocal: 'lead-vocal',
  vocals: 'lead-vocal',
  voice: 'lead-vocal',
  singer: 'lead-vocal',
  'backing-vocals': 'backing-vocal',
  harmonies: 'backing-vocal',
  bells: 'glockenspiel',
  vibraphone: 'marimba',
  xylophone: 'marimba',
};

function normalizeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Look up a custom or built-in profile without falling back. */
export function findInstrumentProfile(
  id: string,
  custom?: readonly InstrumentProfile[],
): InstrumentProfile | undefined {
  const c = custom?.find((p) => p.id === id);
  if (c) return c;
  const b = BY_ID.get(id);
  if (b) return b;
  const n = normalizeId(id);
  return (
    custom?.find((p) => normalizeId(p.id) === n) ??
    BY_ID.get(n) ??
    (ALIASES[n] ? BY_ID.get(ALIASES[n]) : undefined)
  );
}

/**
 * Instrument profile for an id. Unknown ids resolve through aliases ("rhodes"), GM ids ("gm-33"),
 * keyword heuristics, and finally the piano — never throws.
 */
export function getInstrument(id: string, custom?: InstrumentProfile[]): InstrumentProfile {
  const direct = findInstrumentProfile(id ?? '', custom);
  if (direct) return direct;
  const n = normalizeId(id ?? '');
  const gm = /^gm-?(\d{1,3})(-drums?)?$/.exec(n);
  if (gm) return instrumentForGmProgram(parseInt(gm[1], 10), Boolean(gm[2]));
  // Keyword heuristics, most specific first.
  const words = n.split('-');
  const has = (w: string) => words.includes(w) || n.includes(w);
  if (has('drum') || has('kit') || has('beat'))
    return BY_ID.get(has('electr') || has('808') ? 'electronic-kit' : 'drum-kit')!;
  if (has('perc')) return BY_ID.get('percussion')!;
  if (has('bass'))
    return BY_ID.get(
      has('synth') ? 'synth-bass' : has('upright') || has('double') ? 'upright-bass' : 'electric-bass',
    )!;
  if (has('guitar')) {
    if (has('lead') || has('solo')) return BY_ID.get('electric-guitar-lead')!;
    if (has('acoustic') || has('nylon')) return BY_ID.get('acoustic-guitar')!;
    if (has('dist') || has('heavy') || has('drive') || has('crunch'))
      return BY_ID.get('electric-guitar-distorted')!;
    return BY_ID.get('electric-guitar-clean')!;
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (alias.length >= 4 && n.includes(alias)) return BY_ID.get(target)!;
  }
  for (const p of BUILTIN_INSTRUMENTS) {
    if (n.includes(p.id) || p.id.includes(n)) return p;
  }
  if (has('vocal') || has('voice') || has('sing')) return BY_ID.get('lead-vocal')!;
  if (has('string')) return BY_ID.get('string-ensemble')!;
  if (has('synth')) return BY_ID.get('synth-pad')!;
  return BY_ID.get('piano')!;
}

/** Best built-in profile for a General MIDI program (0..127), or the drum kit for channel-10 parts. */
export function instrumentForGmProgram(program: number, isDrum = false): InstrumentProfile {
  if (isDrum) return BY_ID.get('drum-kit')!;
  const p = Math.max(0, Math.min(127, Math.round(Number.isFinite(program) ? program : 0)));
  const exact = BUILTIN_INSTRUMENTS.find((i) => !i.isDrumKit && i.gmProgram === p);
  if (exact) return exact;
  const pick = (id: string) => BY_ID.get(id)!;
  if (p <= 3) return pick('piano');
  if (p <= 5) return pick('electric-piano');
  if (p <= 7) return pick('piano');
  if (p <= 15) {
    if (p === 8 || p === 9 || p === 10 || p === 14) return pick('glockenspiel');
    return pick('marimba');
  }
  if (p <= 23) return pick('organ');
  if (p <= 31) {
    if (p <= 25) return pick('acoustic-guitar');
    if (p === 29) return pick('electric-guitar-lead');
    if (p === 30) return pick('electric-guitar-distorted');
    return pick('electric-guitar-clean');
  }
  if (p <= 39) {
    if (p === 32) return pick('upright-bass');
    if (p >= 38) return pick('synth-bass');
    return pick('electric-bass');
  }
  if (p <= 47) {
    const map: Record<number, string> = {
      40: 'violin',
      41: 'viola',
      42: 'cello',
      43: 'contrabass',
      44: 'string-ensemble',
      45: 'pizzicato-strings',
      46: 'harp',
      47: 'timpani',
    };
    return pick(map[p] ?? 'string-ensemble');
  }
  if (p <= 55) {
    if (p <= 51) return pick('string-ensemble');
    if (p === 53) return pick('lead-vocal');
    if (p === 55) return pick('brass-section');
    return pick('choir');
  }
  if (p <= 63) {
    if (p === 56 || p === 59) return pick('trumpet');
    if (p === 57 || p === 58) return pick('trombone');
    if (p === 60) return pick('french-horn');
    return pick('brass-section');
  }
  if (p <= 71) return pick(p <= 67 ? 'saxophone' : 'clarinet');
  if (p <= 79) return pick('flute');
  if (p <= 87) return pick(p === 80 ? 'synth-arp' : 'synth-lead');
  if (p <= 103) return pick('synth-pad');
  if (p <= 111) {
    if (p === 110) return pick('violin');
    if (p === 111) return pick('clarinet');
    if (p === 107) return pick('harp');
    if (p === 108) return pick('marimba');
    if (p === 109) return pick('flute');
    return pick('acoustic-guitar');
  }
  if (p <= 119) {
    if (p === 112) return pick('glockenspiel');
    if (p === 113 || p === 114) return pick('marimba');
    if (p === 119) return pick('synth-pad');
    return pick('timpani');
  }
  return pick('synth-pad');
}

/** Effective pitch range of an instrument (comfortable bounds filled in). */
export function instrumentRange(p: InstrumentProfile): {
  low: number;
  high: number;
  comfortableLow: number;
  comfortableHigh: number;
} {
  const low = p.range.low;
  const high = p.range.high;
  return {
    low,
    high,
    comfortableLow: Math.max(low, p.range.comfortableLow ?? low),
    comfortableHigh: Math.min(high, p.range.comfortableHigh ?? high),
  };
}
