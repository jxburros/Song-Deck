/**
 * Built-in guide-render patches (spec §28 "built-in instrument library") and the mappings from
 * instrument profile ids / General MIDI programs to patch ids.
 */
import type { StemGroup } from '@songdeck/core';
import type { DrumKitId } from './drums';
import type { AmpParams } from './effects/amp';
import type { ChorusParams } from './effects/modulation';
import type { BiquadType } from './filters';
import type { ChoirParams } from './voices/choir';
import type { FmParams } from './voices/fm';
import type { ModalParams } from './voices/modal';
import type { OrganParams } from './voices/organ';
import type { PianoParams } from './voices/piano';
import type { PluckParams } from './voices/pluck';
import type { VaParams } from './voices/va';

export type InstrumentFxSpec =
  | { type: 'amp'; params: AmpParams }
  | { type: 'chorus'; params: ChorusParams }
  | { type: 'eq'; bands: { type: BiquadType; f: number; q: number; db: number }[] }
  | { type: 'rotary'; rate: number; depthMs: number; am?: number; mix?: number }
  | { type: 'autopan'; rate: number; depth: number }
  | { type: 'formant'; formants: { f: number; q: number; db: number }[]; dry?: number };

export type PatchEngine = 'va' | 'pluck' | 'piano' | 'fm' | 'organ' | 'choir' | 'modal' | 'drums' | 'vocal' | 'sampler';

export interface PatchDefinition {
  id: string;
  name: string;
  description: string;
  engine: PatchEngine;
  params?: VaParams | PluckParams | PianoParams | FmParams | OrganParams | ChoirParams | ModalParams;
  kit?: DrumKitId;
  stemGroup: StemGroup;
  /** Max simultaneous notes. */
  polyphony: number;
  /** Monophonic (one note at a time, legato aware). */
  mono?: boolean;
  /** Overlapping notes become legato transitions (glide / hammer-on) without the legato articulation. */
  autoLegato?: boolean;
  /** Voices write stereo (pads, kits, keys); otherwise the patch is mono and panned by the strip. */
  stereo: boolean;
  /** Sustained sound: notes are re-started ("chased") after seeking / looping into them. */
  sustained: boolean;
  /** Output trim (dB) — patches are level-matched to ≈ -18 dBFS RMS at velocity 100. */
  gainDb: number;
  /** Chord strum spread per string (ms) for guitar-like patches. */
  strumMs?: number;
  /** Stereo spread of voices by pitch (keyboard / harp image). */
  pitchPan?: number;
  fx?: InstrumentFxSpec[];
  /** Articulations rendered by another patch (e.g. pizzicato on a strings track). */
  articulationPatches?: { pizzicato?: string };
  /** Typical sounding range [low, high]. */
  range: [number, number];
}

const va = (p: Omit<VaParams, 'engine'>): VaParams => ({ engine: 'va', ...p });
const pluck = (p: Omit<PluckParams, 'engine'>): PluckParams => ({ engine: 'pluck', ...p });
const fm = (p: Omit<FmParams, 'engine'>): FmParams => ({ engine: 'fm', ...p });

const ENSEMBLE_CHORUS: ChorusParams = { rate: 0.55, depthMs: 3.2, delayMs: 13, mix: 0.55, voices: 2 };
const LIGHT_CHORUS: ChorusParams = { rate: 0.8, depthMs: 1.8, delayMs: 9, mix: 0.3, voices: 2 };
const PAD_CHORUS: ChorusParams = { rate: 0.33, depthMs: 4, delayMs: 15, mix: 0.55, voices: 2 };

export const PATCHES: Record<string, PatchDefinition> = {
  // ------------------------------------------------------------------ drums
  'drums-acoustic': {
    id: 'drums-acoustic',
    name: 'Acoustic Drum Kit',
    description: 'Synthesized acoustic kit (GM drum map) with velocity-sensitive tone, hat choke and stereo image.',
    engine: 'drums',
    kit: 'acoustic',
    stemGroup: 'drums',
    polyphony: 32,
    stereo: true,
    sustained: false,
    gainDb: -1,
    range: [35, 81],
  },
  'drums-electronic': {
    id: 'drums-electronic',
    name: 'Electronic Drum Kit',
    description: '808/909-flavoured synthesized kit.',
    engine: 'drums',
    kit: 'electronic',
    stemGroup: 'drums',
    polyphony: 32,
    stereo: true,
    sustained: false,
    gainDb: -2.5,
    range: [35, 81],
  },
  percussion: {
    id: 'percussion',
    name: 'Hand Percussion',
    description: 'Congas, bongos, shakers, tambourine, cowbell, claves, woodblocks (GM map).',
    engine: 'drums',
    kit: 'percussion',
    stemGroup: 'drums',
    polyphony: 24,
    stereo: true,
    sustained: false,
    gainDb: -1,
    range: [35, 82],
  },
  // ------------------------------------------------------------------ bass
  'bass-electric': {
    id: 'bass-electric',
    name: 'Electric Bass',
    description: 'Finger-style electric bass (plucked string), palm mute, slides, hammer-ons.',
    engine: 'pluck',
    params: pluck({ decay: 2.6, decayExp: 0.5, brightness: 0.42, velBright: 0.35, damping: 0.6, pickPos: 0.17, release: 0.07, palmDecay: 0.32, palmCutoff: 4, smooth: 0.55, pickNoise: 0.04 }),
    stemGroup: 'bass',
    polyphony: 2,
    mono: true,
    stereo: false,
    sustained: false,
    gainDb: 2.5,
    fx: [{ type: 'eq', bands: [{ type: 'lowshelf', f: 100, q: 1, db: 2.5 }, { type: 'peak', f: 750, q: 1, db: -2 }, { type: 'highshelf', f: 3500, q: 1, db: -5 }] }],
    range: [28, 67],
  },
  'bass-synth': {
    id: 'bass-synth',
    name: 'Synth Bass',
    description: 'Analog-style mono bass: saw + sub, 24 dB filter with envelope, legato glide.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 0.8 }, { wave: 'square', level: 0.5, cents: 6 }],
      filter: { type: 'lp24', cutoff: 320, reso: 0.25, keytrack: 0.5, envOct: 2.6, velOct: 1, a: 0.002, d: 0.28, s: 0.22, r: 0.08 },
      amp: { a: 0.003, d: 0.35, s: 0.85, r: 0.07 },
      velSens: 0.6,
      glide: 0.05,
    }),
    stemGroup: 'bass',
    polyphony: 2,
    mono: true,
    autoLegato: true,
    stereo: false,
    sustained: true,
    gainDb: -9,
    range: [24, 60],
  },
  'bass-upright': {
    id: 'bass-upright',
    name: 'Upright Bass',
    description: 'Acoustic double bass pizzicato: dark thump, wooden body resonance.',
    engine: 'pluck',
    params: pluck({ decay: 1.3, decayExp: 0.4, brightness: 0.3, velBright: 0.3, damping: 0.72, pickPos: 0.22, release: 0.09, palmDecay: 0.25, palmCutoff: 3.5, smooth: 0.85, pickNoise: 0.03 }),
    stemGroup: 'bass',
    polyphony: 2,
    mono: true,
    stereo: false,
    sustained: false,
    gainDb: 1,
    fx: [{ type: 'eq', bands: [{ type: 'peak', f: 105, q: 1.2, db: 3 }, { type: 'peak', f: 260, q: 1.2, db: 2 }, { type: 'highshelf', f: 2200, q: 1, db: -7 }] }],
    range: [28, 67],
  },
  // ------------------------------------------------------------------ guitars
  'guitar-distorted': {
    id: 'guitar-distorted',
    name: 'Distorted Guitar',
    description: 'High-gain rhythm guitar: plucked strings into an oversampled asymmetric amp + 4x12 cab; tight palm-muted chugs.',
    engine: 'pluck',
    params: pluck({ decay: 6, decayExp: 0.3, brightness: 0.78, velBright: 0.2, damping: 0.32, pickPos: 0.12, release: 0.06, palmDecay: 0.2, palmCutoff: 5, smooth: 0.3, pickNoise: 0.08 }),
    stemGroup: 'guitars',
    polyphony: 6,
    stereo: false,
    sustained: false,
    strumMs: 6,
    gainDb: -1,
    fx: [{ type: 'amp', params: { driveDb: 30, asym: 0.15, midDb: -3, presenceDb: 3, cabHz: 5000, outDb: -14 } }],
    range: [40, 84],
  },
  'guitar-clean': {
    id: 'guitar-clean',
    name: 'Clean Electric Guitar',
    description: 'Clean electric guitar with light chorus.',
    engine: 'pluck',
    params: pluck({ decay: 4, decayExp: 0.45, brightness: 0.6, velBright: 0.3, damping: 0.42, pickPos: 0.14, release: 0.1, palmDecay: 0.25, palmCutoff: 5, smooth: 0.4, pickNoise: 0.05 }),
    stemGroup: 'guitars',
    polyphony: 6,
    stereo: false,
    sustained: false,
    strumMs: 9,
    gainDb: 3,
    fx: [
      { type: 'eq', bands: [{ type: 'highpass', f: 85, q: 0.7, db: 0 }, { type: 'peak', f: 3200, q: 1.2, db: -2 }, { type: 'highshelf', f: 7000, q: 1, db: -3 }] },
      { type: 'chorus', params: LIGHT_CHORUS },
    ],
    range: [40, 86],
  },
  'guitar-acoustic': {
    id: 'guitar-acoustic',
    name: 'Acoustic Guitar',
    description: 'Steel-string acoustic: bright strings, strummed chords, wooden body resonances.',
    engine: 'pluck',
    params: pluck({ decay: 3.2, decayExp: 0.45, brightness: 0.72, velBright: 0.3, damping: 0.36, pickPos: 0.2, release: 0.14, palmDecay: 0.22, palmCutoff: 5, smooth: 0.2, pickNoise: 0.1 }),
    stemGroup: 'guitars',
    polyphony: 6,
    stereo: false,
    sustained: false,
    strumMs: 12,
    gainDb: 6,
    fx: [
      {
        type: 'eq',
        bands: [
          { type: 'highpass', f: 70, q: 0.7, db: 0 },
          { type: 'peak', f: 105, q: 1.5, db: 4 },
          { type: 'peak', f: 220, q: 1.4, db: 2.5 },
          { type: 'peak', f: 420, q: 1, db: -2 },
          { type: 'highshelf', f: 6000, q: 1, db: 2 },
        ],
      },
    ],
    range: [40, 86],
  },
  'guitar-lead': {
    id: 'guitar-lead',
    name: 'Lead Guitar',
    description: 'Singing overdriven lead: sustain, vibrato, bends, slides and hammer-on legato.',
    engine: 'pluck',
    params: pluck({ decay: 7, decayExp: 0.25, brightness: 0.72, velBright: 0.25, damping: 0.35, pickPos: 0.13, release: 0.08, palmDecay: 0.22, palmCutoff: 5, smooth: 0.35, pickNoise: 0.06, vibrato: { rate: 5.6, cents: 22, delay: 0.35 } }),
    stemGroup: 'guitars',
    polyphony: 2,
    mono: true,
    autoLegato: true,
    stereo: false,
    sustained: false,
    gainDb: -2.5,
    fx: [{ type: 'amp', params: { driveDb: 34, asym: 0.2, midDb: 2, presenceDb: 2, cabHz: 5500, outDb: -16 } }],
    range: [52, 91],
  },
  // ------------------------------------------------------------------ keys
  piano: {
    id: 'piano',
    name: 'Grand Piano',
    description: 'Additive piano model (inharmonic partials, hammer spectrum, two-string beating), multisampled at render time.',
    engine: 'piano',
    params: { engine: 'piano', layers: [42, 82, 118], zoneStep: 3, brightness: 0.55, decayScale: 1, hammer: 1 },
    stemGroup: 'keys',
    polyphony: 32,
    stereo: true,
    sustained: false,
    pitchPan: 0.55,
    gainDb: 2,
    range: [21, 108],
  },
  epiano: {
    id: 'epiano',
    name: 'Electric Piano',
    description: 'FM tine electric piano with velocity bark and stereo tremolo.',
    engine: 'fm',
    params: fm({
      pairs: [
        { carrier: 1, mod: 1, index: 0.5, indexVel: 2.2, indexDecay: 1.6, indexSustain: 0.25, level: 1, decay: 4.5, decayExp: 0.5, cents: -3 },
        { carrier: 1, mod: 14, index: 0.15, indexVel: 1.2, indexDecay: 0.12, level: 0.32, decay: 1.2, decayExp: 0.5, cents: 3 },
      ],
      attack: 0.002,
      release: 0.25,
      velSens: 0.85,
    }),
    stemGroup: 'keys',
    polyphony: 16,
    stereo: true,
    sustained: false,
    pitchPan: 0.25,
    gainDb: -5,
    fx: [{ type: 'autopan', rate: 4.2, depth: 0.22 }],
    range: [28, 103],
  },
  organ: {
    id: 'organ',
    name: 'Drawbar Organ',
    description: 'Tonewheel-style drawbar organ (00 8743 002) with key click, percussion and slow rotary speaker.',
    engine: 'organ',
    params: { engine: 'organ', drawbars: [0, 0, 8, 7, 4, 3, 0, 0, 2], click: 0.06, percussion: { harmonic: 3, level: 0.18, decay: 0.45 }, velSens: 0.15 },
    stemGroup: 'keys',
    polyphony: 16,
    stereo: true,
    sustained: true,
    gainDb: -9,
    fx: [
      { type: 'rotary', rate: 0.85, depthMs: 0.35, am: 0.22, mix: 0.75 },
      { type: 'eq', bands: [{ type: 'highshelf', f: 6000, q: 1, db: -3 }] },
    ],
    range: [36, 96],
  },
  // ------------------------------------------------------------------ strings
  'strings-solo': {
    id: 'strings-solo',
    name: 'Solo Strings',
    description: 'Bowed solo string (violin/viola/cello/contrabass): bow noise, body resonances, delayed vibrato, portamento.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 1 }],
      noise: 0.05,
      noiseMul: 3,
      noiseQ: 1.2,
      filter: { type: 'lp12', cutoff: 1900, reso: 0.12, keytrack: 0.8, envOct: 0.6, velOct: 0.8, a: 0.12, d: 0.4, s: 0.75, r: 0.25 },
      amp: { a: 0.09, d: 0.3, s: 0.9, r: 0.22 },
      velSens: 0.7,
      vibrato: { rate: 5.6, cents: 22, delay: 0.25, fade: 0.4 },
      glide: 0.07,
      drift: 5,
    }),
    stemGroup: 'strings',
    polyphony: 4,
    autoLegato: false,
    stereo: false,
    sustained: true,
    gainDb: -12,
    fx: [
      {
        type: 'eq',
        bands: [
          { type: 'peak', f: 290, q: 1.2, db: 3 },
          { type: 'peak', f: 1100, q: 1.5, db: -2.5 },
          { type: 'peak', f: 2800, q: 1.4, db: 3 },
          { type: 'highshelf', f: 6000, q: 1, db: -5 },
        ],
      },
    ],
    articulationPatches: { pizzicato: 'strings-pizz' },
    range: [28, 100],
  },
  'strings-ensemble': {
    id: 'strings-ensemble',
    name: 'String Ensemble',
    description: 'Section strings: detuned bowed oscillators, slow attack, ensemble chorus.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 1 }, { wave: 'saw', level: 0.8, cents: 10 }, { wave: 'saw', level: 0.8, cents: -9 }],
      noise: 0.02,
      noiseMul: 4,
      filter: { type: 'lp12', cutoff: 2400, reso: 0.1, keytrack: 0.6, envOct: 0.4, velOct: 0.6, a: 0.25, d: 0.5, s: 0.85, r: 0.5 },
      amp: { a: 0.22, d: 0.4, s: 0.95, r: 0.45 },
      velSens: 0.6,
      vibrato: { rate: 5.2, cents: 8, delay: 0.3, fade: 0.5 },
    }),
    stemGroup: 'strings',
    polyphony: 16,
    stereo: true,
    sustained: true,
    pitchPan: 0.35,
    gainDb: -11,
    fx: [
      { type: 'eq', bands: [{ type: 'peak', f: 300, q: 1, db: 2 }, { type: 'peak', f: 1200, q: 1.2, db: -2 }, { type: 'highshelf', f: 7000, q: 1, db: -4 }] },
      { type: 'chorus', params: ENSEMBLE_CHORUS },
    ],
    articulationPatches: { pizzicato: 'strings-pizz' },
    range: [28, 100],
  },
  'strings-pizz': {
    id: 'strings-pizz',
    name: 'Pizzicato Strings',
    description: 'Plucked section strings.',
    engine: 'pluck',
    params: pluck({ decay: 0.55, decayExp: 0.35, brightness: 0.42, velBright: 0.3, damping: 0.6, pickPos: 0.3, release: 0.3, palmDecay: 0.2, palmCutoff: 4, smooth: 0.85, pickNoise: 0.02 }),
    stemGroup: 'strings',
    polyphony: 12,
    stereo: true,
    sustained: false,
    pitchPan: 0.4,
    gainDb: 3,
    fx: [{ type: 'eq', bands: [{ type: 'peak', f: 280, q: 1.2, db: 3 }, { type: 'highshelf', f: 4000, q: 1, db: -4 }] }],
    range: [28, 100],
  },
  harp: {
    id: 'harp',
    name: 'Harp',
    description: 'Concert harp: finger-plucked strings that ring after release.',
    engine: 'pluck',
    params: pluck({ decay: 4, decayExp: 0.6, brightness: 0.55, velBright: 0.3, damping: 0.45, pickPos: 0.4, release: 1.2, palmDecay: 0.3, palmCutoff: 4, smooth: 0.75, pickNoise: 0.02 }),
    stemGroup: 'strings',
    polyphony: 16,
    stereo: true,
    sustained: false,
    pitchPan: 0.5,
    gainDb: -2.5,
    fx: [{ type: 'eq', bands: [{ type: 'peak', f: 320, q: 1, db: 2 }] }],
    range: [24, 103],
  },
  // ------------------------------------------------------------------ brass & winds
  brass: {
    id: 'brass',
    name: 'Brass Section',
    description: 'Brass section: filter "blat" on attack, scoop, section width.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 1 }, { wave: 'saw', level: 0.8, cents: 9 }],
      filter: { type: 'lp12', cutoff: 520, reso: 0.15, keytrack: 0.7, envOct: 2.5, velOct: 1.6, a: 0.05, d: 0.35, s: 0.55, r: 0.18 },
      amp: { a: 0.04, d: 0.3, s: 0.85, r: 0.18 },
      velSens: 0.75,
      scoop: { semis: -0.4, time: 0.04 },
      vibrato: { rate: 5.2, cents: 10, delay: 0.35, fade: 0.4 },
      drift: 3,
    }),
    stemGroup: 'others',
    polyphony: 8,
    stereo: true,
    sustained: true,
    pitchPan: 0.3,
    gainDb: -13,
    fx: [{ type: 'eq', bands: [{ type: 'peak', f: 1200, q: 0.8, db: 3 }, { type: 'highshelf', f: 6000, q: 1, db: -3 }] }, { type: 'chorus', params: LIGHT_CHORUS }],
    range: [34, 84],
  },
  'brass-solo': {
    id: 'brass-solo',
    name: 'Solo Brass',
    description: 'Trumpet / trombone / horn: velocity-driven brightness, scoop, vibrato, legato.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 1 }],
      noise: 0.02,
      noiseMul: 2,
      filter: { type: 'lp12', cutoff: 460, reso: 0.18, keytrack: 0.75, envOct: 2.7, velOct: 1.8, a: 0.04, d: 0.4, s: 0.6, r: 0.15 },
      amp: { a: 0.035, d: 0.3, s: 0.88, r: 0.15 },
      velSens: 0.75,
      scoop: { semis: -0.5, time: 0.035 },
      vibrato: { rate: 5.4, cents: 16, delay: 0.3, fade: 0.4 },
      glide: 0.04,
      drift: 3,
    }),
    stemGroup: 'others',
    polyphony: 2,
    mono: true,
    autoLegato: true,
    stereo: false,
    sustained: true,
    gainDb: -11.5,
    fx: [{ type: 'eq', bands: [{ type: 'peak', f: 1000, q: 0.9, db: 2 }] }],
    range: [40, 84],
  },
  flute: {
    id: 'flute',
    name: 'Flute',
    description: 'Flute: near-sine tone, breath noise, chiff, delayed vibrato.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'sine', level: 1 }, { wave: 'sine', level: 0.16, semi: 12 }, { wave: 'sine', level: 0.06, semi: 19 }],
      noise: 0.14,
      noiseMul: 3,
      noiseQ: 0.8,
      chiff: 0.03,
      filter: { type: 'lp12', cutoff: 4500, reso: 0, keytrack: 0.4, envOct: 0.3, velOct: 0.5, a: 0.05, d: 0.2, s: 0.9, r: 0.12 },
      amp: { a: 0.07, d: 0.2, s: 0.9, r: 0.12 },
      velSens: 0.6,
      vibrato: { rate: 5, cents: 14, delay: 0.2, fade: 0.3 },
      glide: 0.04,
    }),
    stemGroup: 'others',
    polyphony: 2,
    mono: true,
    autoLegato: true,
    stereo: false,
    sustained: true,
    gainDb: -12,
    range: [59, 98],
  },
  reed: {
    id: 'reed',
    name: 'Reed (Clarinet/Sax)',
    description: 'Single-reed woodwind: hollow pulse tone, reed formant, breath, vibrato.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'pulse', level: 1, pw: 0.42 }, { wave: 'saw', level: 0.3 }],
      noise: 0.05,
      noiseMul: 2.5,
      filter: { type: 'lp12', cutoff: 950, reso: 0.3, keytrack: 0.85, envOct: 1.4, velOct: 1.2, a: 0.03, d: 0.3, s: 0.7, r: 0.1 },
      amp: { a: 0.03, d: 0.2, s: 0.9, r: 0.1 },
      velSens: 0.7,
      vibrato: { rate: 5.2, cents: 14, delay: 0.3, fade: 0.3 },
      glide: 0.04,
    }),
    stemGroup: 'others',
    polyphony: 2,
    mono: true,
    autoLegato: true,
    stereo: false,
    sustained: true,
    gainDb: -17,
    fx: [{ type: 'eq', bands: [{ type: 'peak', f: 1500, q: 1, db: 3 }, { type: 'peak', f: 3000, q: 1.2, db: 2 }] }],
    range: [44, 91],
  },
  // ------------------------------------------------------------------ synths
  'pad-warm': {
    id: 'pad-warm',
    name: 'Warm Pad',
    description: 'Slow, warm analog pad with drifting filter and wide chorus.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 1 }, { wave: 'saw', level: 0.9, cents: 9 }],
      filter: { type: 'lp24', cutoff: 900, reso: 0.15, keytrack: 0.3, envOct: 0.8, velOct: 0.4, a: 0.7, d: 1.2, s: 0.8, r: 1.1 },
      amp: { a: 0.6, d: 1, s: 0.9, r: 1.1 },
      velSens: 0.4,
      filterLfo: { rate: 0.15, oct: 0.25 },
      drift: 4,
    }),
    stemGroup: 'keys',
    polyphony: 12,
    stereo: true,
    sustained: true,
    pitchPan: 0.3,
    gainDb: -14,
    fx: [{ type: 'chorus', params: PAD_CHORUS }],
    range: [36, 96],
  },
  'pad-bright': {
    id: 'pad-bright',
    name: 'Bright Pad',
    description: 'Bright, airy poly pad with PWM shimmer.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 1 }, { wave: 'saw', level: 0.9, cents: -9 }, { wave: 'pulse', level: 0.45, pw: 0.3, cents: 5 }],
      filter: { type: 'lp12', cutoff: 3200, reso: 0.25, keytrack: 0.4, envOct: 0.6, velOct: 0.4, a: 0.3, d: 1, s: 0.85, r: 0.9 },
      amp: { a: 0.3, d: 0.8, s: 0.9, r: 0.9 },
      velSens: 0.4,
      pwm: { rate: 0.3, depth: 0.15 },
    }),
    stemGroup: 'keys',
    polyphony: 12,
    stereo: true,
    sustained: true,
    pitchPan: 0.3,
    gainDb: -14,
    fx: [{ type: 'chorus', params: PAD_CHORUS }, { type: 'eq', bands: [{ type: 'highshelf', f: 6000, q: 1, db: 2 }] }],
    range: [36, 96],
  },
  'lead-saw': {
    id: 'lead-saw',
    name: 'Saw Lead',
    description: 'Fat detuned saw lead with glide and vibrato.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 1 }, { wave: 'saw', level: 0.7, cents: 8 }],
      filter: { type: 'lp24', cutoff: 1800, reso: 0.3, keytrack: 0.6, envOct: 1.5, velOct: 0.8, a: 0.003, d: 0.3, s: 0.6, r: 0.1 },
      amp: { a: 0.004, d: 0.2, s: 0.9, r: 0.12 },
      velSens: 0.5,
      vibrato: { rate: 5.5, cents: 18, delay: 0.3, fade: 0.3 },
      glide: 0.06,
    }),
    stemGroup: 'others',
    polyphony: 2,
    mono: true,
    autoLegato: true,
    stereo: false,
    sustained: true,
    gainDb: -9,
    fx: [{ type: 'chorus', params: LIGHT_CHORUS }],
    range: [48, 96],
  },
  'lead-square': {
    id: 'lead-square',
    name: 'Square Lead',
    description: 'Hollow square/pulse lead with PWM.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'square', level: 1 }, { wave: 'pulse', level: 0.4, pw: 0.3, cents: -6 }],
      filter: { type: 'lp12', cutoff: 2200, reso: 0.2, keytrack: 0.6, envOct: 1.2, velOct: 0.6, a: 0.003, d: 0.25, s: 0.7, r: 0.1 },
      amp: { a: 0.004, d: 0.2, s: 0.85, r: 0.1 },
      velSens: 0.5,
      pwm: { rate: 0.4, depth: 0.1 },
      vibrato: { rate: 5.5, cents: 15, delay: 0.3, fade: 0.3 },
      glide: 0.05,
    }),
    stemGroup: 'others',
    polyphony: 2,
    mono: true,
    autoLegato: true,
    stereo: false,
    sustained: true,
    gainDb: -13.5,
    range: [48, 96],
  },
  pluck: {
    id: 'pluck',
    name: 'Synth Pluck',
    description: 'Snappy filtered pluck for arpeggios and sequences.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'saw', level: 1 }, { wave: 'square', level: 0.5, cents: 5 }],
      filter: { type: 'lp24', cutoff: 550, reso: 0.35, keytrack: 0.6, envOct: 3.2, velOct: 1, a: 0.001, d: 0.22, s: 0, r: 0.15 },
      amp: { a: 0.002, d: 0.5, s: 0, r: 0.2 },
      velSens: 0.6,
    }),
    stemGroup: 'keys',
    polyphony: 12,
    stereo: true,
    sustained: false,
    pitchPan: 0.25,
    gainDb: 2,
    fx: [{ type: 'chorus', params: LIGHT_CHORUS }],
    range: [36, 96],
  },
  // ------------------------------------------------------------------ voices
  choir: {
    id: 'choir',
    name: 'Choir Aahs',
    description: 'Formant choir pad: ensemble of glottal-like sources through an "aah" formant bank.',
    engine: 'choir',
    params: { engine: 'choir', singers: 3, detuneCents: 14, vibratoCents: 18, breath: 0.08, attack: 0.3, release: 0.6, velSens: 0.5 },
    stemGroup: 'vocals',
    polyphony: 16,
    stereo: true,
    sustained: true,
    pitchPan: 0.3,
    gainDb: -3,
    fx: [
      {
        type: 'formant',
        formants: [
          { f: 800, q: 5, db: 0 },
          { f: 1150, q: 6, db: -4 },
          { f: 2900, q: 7, db: -10 },
        ],
        dry: 0.15,
      },
      { type: 'chorus', params: { rate: 0.4, depthMs: 3, delayMs: 15, mix: 0.4, voices: 3 } },
    ],
    range: [40, 84],
  },
  'vocal-placeholder': {
    id: 'vocal-placeholder',
    name: 'Placeholder Vocal',
    description: 'Formant singing synthesizer (lyrics, phonemes, expression) — sounds synthetic but intelligible.',
    engine: 'vocal',
    stemGroup: 'vocals',
    polyphony: 1,
    mono: true,
    stereo: false,
    sustained: true,
    gainDb: 4,
    range: [40, 84],
  },
  // ------------------------------------------------------------------ pitched percussion
  timpani: {
    id: 'timpani',
    name: 'Timpani',
    description: 'Modal timpani: tuned membrane modes, mallet strike, initial pitch glide.',
    engine: 'modal',
    params: {
      engine: 'modal',
      modes: [
        { ratio: 1, amp: 1, t60: 3.5 },
        { ratio: 1.504, amp: 0.55, t60: 2.4 },
        { ratio: 1.742, amp: 0.35, t60: 2 },
        { ratio: 2.0, amp: 0.28, t60: 1.7 },
        { ratio: 2.245, amp: 0.2, t60: 1.4 },
        { ratio: 2.494, amp: 0.14, t60: 1.2 },
        { ratio: 2.8, amp: 0.1, t60: 1 },
        { ratio: 0.58, amp: 0.35, t60: 0.3 },
      ],
      strike: { level: 0.5, decay: 0.05, cutoff: 400 },
      pitchDrop: 25,
      dropTime: 0.08,
      velBright: 1,
      release: 1.5,
      velSens: 0.9,
    },
    stemGroup: 'others',
    polyphony: 4,
    stereo: false,
    sustained: false,
    gainDb: -7.5,
    fx: [{ type: 'eq', bands: [{ type: 'lowshelf', f: 120, q: 1, db: 2 }] }],
    range: [36, 60],
  },
  bell: {
    id: 'bell',
    name: 'Bells / Glockenspiel',
    description: 'FM bells (inharmonic 1:3.5 pair + 2.76 partial).',
    engine: 'fm',
    params: fm({
      pairs: [
        { carrier: 1, mod: 3.5, index: 0.8, indexVel: 2.5, indexDecay: 0.8, level: 1, decay: 3.5, decayExp: 0.35 },
        { carrier: 2.76, mod: 1, index: 0, indexVel: 0.4, indexDecay: 0.3, level: 0.3, decay: 1.4, decayExp: 0.35 },
      ],
      attack: 0.001,
      release: 1.2,
      velSens: 0.8,
    }),
    stemGroup: 'others',
    polyphony: 12,
    stereo: true,
    sustained: false,
    pitchPan: 0.3,
    gainDb: -3,
    range: [60, 108],
  },
  mallet: {
    id: 'mallet',
    name: 'Marimba / Mallets',
    description: 'FM marimba: woody attack, tuned 4:1 overtone, short decay.',
    engine: 'fm',
    params: fm({
      pairs: [
        { carrier: 1, mod: 4, index: 0.5, indexVel: 2.5, indexDecay: 0.06, level: 1, decay: 1.3, decayExp: 0.7 },
        { carrier: 4, mod: 1, index: 0, indexVel: 0, indexDecay: 0.1, level: 0.12, decay: 0.25, decayExp: 0.5 },
      ],
      attack: 0.001,
      release: 0.4,
      velSens: 0.8,
      strike: { level: 0.25, decay: 0.015 },
    }),
    stemGroup: 'others',
    polyphony: 12,
    stereo: true,
    sustained: false,
    pitchPan: 0.4,
    gainDb: 0.5,
    range: [45, 96],
  },
  sine: {
    id: 'sine',
    name: 'Sine (fallback)',
    description: 'Plain sine tone used when no better patch is known.',
    engine: 'va',
    params: va({
      oscs: [{ wave: 'sine', level: 1 }],
      filter: { type: 'lp12', cutoff: 14000, reso: 0, keytrack: 0, envOct: 0, velOct: 0, a: 0.001, d: 0.1, s: 1, r: 0.1 },
      amp: { a: 0.005, d: 0.1, s: 1, r: 0.08 },
      velSens: 0.6,
    }),
    stemGroup: 'others',
    polyphony: 16,
    stereo: false,
    sustained: true,
    gainDb: -13,
    range: [24, 108],
  },
};

const INSTRUMENT_PATCH: Record<string, string> = {
  'drum-kit': 'drums-acoustic',
  'electronic-kit': 'drums-electronic',
  percussion: 'percussion',
  'electric-bass': 'bass-electric',
  'synth-bass': 'bass-synth',
  'upright-bass': 'bass-upright',
  'electric-guitar-distorted': 'guitar-distorted',
  'electric-guitar-clean': 'guitar-clean',
  'acoustic-guitar': 'guitar-acoustic',
  'electric-guitar-lead': 'guitar-lead',
  piano: 'piano',
  'electric-piano': 'epiano',
  organ: 'organ',
  violin: 'strings-solo',
  viola: 'strings-solo',
  cello: 'strings-solo',
  contrabass: 'strings-solo',
  'string-ensemble': 'strings-ensemble',
  'pizzicato-strings': 'strings-pizz',
  trumpet: 'brass-solo',
  trombone: 'brass-solo',
  'french-horn': 'brass-solo',
  'brass-section': 'brass',
  flute: 'flute',
  clarinet: 'reed',
  saxophone: 'reed',
  'synth-pad': 'pad-warm',
  'synth-lead': 'lead-saw',
  'synth-arp': 'pluck',
  'synth-seq': 'pluck',
  choir: 'choir',
  'lead-vocal': 'vocal-placeholder',
  'backing-vocal': 'vocal-placeholder',
  harp: 'harp',
  timpani: 'timpani',
  glockenspiel: 'bell',
  marimba: 'mallet',
};

/** Patch for an instrument profile id (falls back by keyword, then to "sine"). */
export function patchIdForInstrument(instrumentId: string): string {
  return resolveInstrumentPatch(instrumentId) ?? 'sine';
}

/** Like patchIdForInstrument but `undefined` when nothing matches (renderer falls back by role). */
export function resolveInstrumentPatch(instrumentId: string): string | undefined {
  if (!instrumentId) return undefined;
  const id = instrumentId.toLowerCase();
  if (INSTRUMENT_PATCH[id]) return INSTRUMENT_PATCH[id];
  if (PATCHES[id]) return id;
  const rules: [RegExp, string][] = [
    [/vocal|voice|singer/, 'vocal-placeholder'],
    [/choir/, 'choir'],
    [/electronic.*(kit|drum)|808|909|drum-machine/, 'drums-electronic'],
    [/kit|drum/, 'drums-acoustic'],
    [/perc|conga|bongo|shaker|tambourine/, 'percussion'],
    [/synth.*bass|bass.*synth|sub-bass/, 'bass-synth'],
    [/upright|double-bass|contrabass/, 'bass-upright'],
    [/bass/, 'bass-electric'],
    [/dist|overdrive|metal|crunch/, 'guitar-distorted'],
    [/lead.*guitar|guitar.*lead/, 'guitar-lead'],
    [/acoustic|nylon|steel|banjo|mandolin|ukulele/, 'guitar-acoustic'],
    [/guitar/, 'guitar-clean'],
    [/rhodes|wurli|e-?piano|electric-piano/, 'epiano'],
    [/piano|keys|harpsichord/, 'piano'],
    [/organ/, 'organ'],
    [/pizz/, 'strings-pizz'],
    [/ensemble|strings|orchestra/, 'strings-ensemble'],
    [/violin|viola|cello|fiddle/, 'strings-solo'],
    [/brass-section|horns/, 'brass'],
    [/trumpet|trombone|horn|tuba|brass/, 'brass-solo'],
    [/flute|piccolo|recorder|whistle|pan/, 'flute'],
    [/sax|clarinet|oboe|bassoon|reed|harmonica|accordion/, 'reed'],
    [/pad/, 'pad-warm'],
    [/arp|seq|pluck/, 'pluck'],
    [/lead|synth/, 'lead-saw'],
    [/harp/, 'harp'],
    [/timpani|taiko/, 'timpani'],
    [/glock|bell|celesta|chime/, 'bell'],
    [/marimba|xylo|vibra|mallet/, 'mallet'],
  ];
  for (const [re, p] of rules) if (re.test(id)) return p;
  return undefined;
}

const GM_TABLE: string[] = (() => {
  const t: string[] = new Array(128).fill('sine');
  const set = (from: number, to: number, p: string) => {
    for (let i = from; i <= to; i++) t[i] = p;
  };
  set(0, 3, 'piano');
  set(4, 5, 'epiano');
  set(6, 7, 'pluck');
  t[8] = 'bell';
  t[9] = 'bell';
  t[10] = 'bell';
  set(11, 13, 'mallet');
  t[14] = 'bell';
  t[15] = 'harp';
  set(16, 20, 'organ');
  set(21, 23, 'reed');
  set(24, 25, 'guitar-acoustic');
  set(26, 28, 'guitar-clean');
  set(29, 30, 'guitar-distorted');
  t[31] = 'guitar-clean';
  t[32] = 'bass-upright';
  set(33, 37, 'bass-electric');
  set(38, 39, 'bass-synth');
  set(40, 43, 'strings-solo');
  t[44] = 'strings-ensemble';
  t[45] = 'strings-pizz';
  t[46] = 'harp';
  t[47] = 'timpani';
  set(48, 51, 'strings-ensemble');
  set(52, 54, 'choir');
  t[55] = 'brass';
  set(56, 60, 'brass-solo');
  set(61, 63, 'brass');
  set(64, 71, 'reed');
  set(72, 79, 'flute');
  t[80] = 'lead-square';
  t[81] = 'lead-saw';
  t[82] = 'flute';
  t[83] = 'lead-square';
  t[84] = 'guitar-lead';
  t[85] = 'choir';
  set(86, 87, 'lead-saw');
  t[88] = 'pad-bright';
  t[89] = 'pad-warm';
  t[90] = 'pad-bright';
  t[91] = 'choir';
  t[92] = 'strings-ensemble';
  t[93] = 'pad-bright';
  set(94, 95, 'pad-warm');
  set(96, 103, 'pad-bright');
  t[104] = 'guitar-clean';
  set(105, 106, 'guitar-acoustic');
  t[107] = 'harp';
  t[108] = 'mallet';
  t[109] = 'reed';
  t[110] = 'strings-solo';
  t[111] = 'reed';
  t[112] = 'bell';
  set(113, 115, 'mallet');
  set(116, 118, 'timpani');
  t[119] = 'pad-bright';
  set(120, 127, 'sine');
  return t;
})();

/** Patch for a General MIDI program (0..127); `isDrum` (channel 10) → acoustic kit. */
export function patchIdForGmProgram(program: number, isDrum = false): string {
  if (isDrum) return 'drums-acoustic';
  const p = Math.max(0, Math.min(127, Math.round(program)));
  return GM_TABLE[p];
}
