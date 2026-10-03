/**
 * Synthesized drum kits (GM drum map): acoustic, electronic (808/909 flavoured) and hand
 * percussion. Each piece is a combination of components rendered by one DrumVoice:
 *   tones  — sines with exponential pitch sweep and T60 decay (kick/tom bodies, snare shell,
 *            bells, claves, woodblocks, triangle partials)
 *   noises — filtered (HP/BP/LP) noise layers with attack/decay (snare wires, beaters, shakers)
 *   metal  — bank of square oscillators at inharmonic ratios through BP+HP (hats, cymbals, cowbell)
 *   click  — short transient; bursts — repeated noise bursts (claps, guiro, vibraslap)
 * Velocity changes level AND tone (pitch/brightness/decay). Hats choke each other.
 */
import { GM_DRUM } from '@songdeck/core';
import { Svf } from './filters';
import {
  BLOCK,
  NOISE_SCALE,
  clampNum,
  seedState,
  sin01,
  softClip,
  t60Coef,
  velocityGain,
  xorshift,
} from './utils';
import { ART_DEAD, type NoteEvent, Voice, type VoiceHost, panGains } from './voices/types';

export interface DrumTone {
  f: number;
  fEnd?: number;
  /** pitch sweep time constant (s) */
  sweep?: number;
  decay: number;
  level: number;
}

export interface DrumNoise {
  filter: 'hp' | 'bp' | 'lp';
  f: number;
  q: number;
  decay: number;
  attack?: number;
  level: number;
}

export interface DrumPiece {
  name: string;
  gain: number;
  pan: number;
  tones?: DrumTone[];
  noises?: DrumNoise[];
  metal?: {
    freqs: number[];
    decay: number;
    level: number;
    hp: number;
    bp: number;
    q: number;
    attack?: number;
  };
  click?: { level: number; decay: number };
  bursts?: { count: number; spacing: number };
  /** Soft saturation amount. */
  drive?: number;
  /** Membership / choke group (hats = 1). */
  group?: number;
  chokes?: number;
  /** Velocity → start pitch increase (fraction). */
  velPitch?: number;
  /** Velocity → decay lengthening (fraction). */
  velDecay?: number;
  /** Velocity → noise/metal brightness (0..1). */
  velBright?: number;
  /** Max simultaneous voices of this piece. */
  maxVoices?: number;
}

const HAT808 = [205.3, 304.4, 369.6, 522.7, 540, 800];
const CYM = [261, 349.2, 463.5, 587.6, 789.1, 1043.3];

function tom(f: number, pan: number, decay: number): DrumPiece {
  return {
    name: 'tom',
    gain: 0.85,
    pan,
    tones: [
      { f: f * 1.45, fEnd: f, sweep: 0.06, decay, level: 1 },
      { f: f * 2.4, fEnd: f * 1.6, sweep: 0.05, decay: decay * 0.4, level: 0.18 },
    ],
    noises: [{ filter: 'lp', f: 2500, q: 0.7, decay: 0.05, level: 0.25 }],
    velPitch: 0.06,
    velDecay: 0.3,
  };
}

function conga(f: number, pan: number, decay: number, slap = 0.3): DrumPiece {
  return {
    name: 'conga',
    gain: 0.7,
    pan,
    tones: [
      { f: f * 1.12, fEnd: f, sweep: 0.012, decay, level: 1 },
      { f: f * 2.15, fEnd: f * 2.1, sweep: 0.01, decay: decay * 0.35, level: 0.2 },
    ],
    noises: [{ filter: 'bp', f: 1800, q: 1.2, decay: 0.03, level: slap }],
    velPitch: 0.03,
  };
}

const ACOUSTIC: Record<number, DrumPiece> = {
  [GM_DRUM.KICK_ACOUSTIC]: {
    name: 'kick',
    gain: 1.15,
    pan: 0,
    tones: [{ f: 140, fEnd: 46, sweep: 0.045, decay: 0.55, level: 1 }],
    noises: [{ filter: 'lp', f: 2400, q: 0.7, decay: 0.02, level: 0.3 }],
    click: { level: 0.25, decay: 0.004 },
    drive: 0.35,
    velPitch: 0.12,
  },
  [GM_DRUM.KICK]: {
    name: 'kick',
    gain: 1.2,
    pan: 0,
    tones: [{ f: 165, fEnd: 50, sweep: 0.034, decay: 0.42, level: 1 }],
    noises: [{ filter: 'lp', f: 3200, q: 0.7, decay: 0.016, level: 0.35 }],
    click: { level: 0.3, decay: 0.003 },
    drive: 0.4,
    velPitch: 0.15,
  },
  [GM_DRUM.SIDE_STICK]: {
    name: 'sidestick',
    gain: 0.55,
    pan: 0.05,
    tones: [
      { f: 1750, fEnd: 1650, sweep: 0.01, decay: 0.035, level: 0.6 },
      { f: 520, decay: 0.04, level: 0.4 },
    ],
    noises: [{ filter: 'bp', f: 2600, q: 2.5, decay: 0.035, level: 0.6 }],
  },
  [GM_DRUM.SNARE]: {
    name: 'snare',
    gain: 0.95,
    pan: 0.04,
    tones: [
      { f: 210, fEnd: 182, sweep: 0.015, decay: 0.16, level: 0.65 },
      { f: 335, fEnd: 322, sweep: 0.01, decay: 0.07, level: 0.32 },
    ],
    noises: [
      { filter: 'bp', f: 4800, q: 0.55, decay: 0.24, level: 0.8 },
      { filter: 'hp', f: 2200, q: 0.7, decay: 0.09, level: 0.35 },
    ],
    click: { level: 0.15, decay: 0.002 },
    drive: 0.25,
    velPitch: 0.05,
    velDecay: 0.25,
    velBright: 0.5,
  },
  [GM_DRUM.CLAP]: {
    name: 'clap',
    gain: 0.75,
    pan: 0.06,
    noises: [{ filter: 'bp', f: 1250, q: 1.1, decay: 0.16, level: 1 }],
    bursts: { count: 4, spacing: 0.0095 },
  },
  [GM_DRUM.SNARE_ELECTRIC]: {
    name: 'snare2',
    gain: 0.95,
    pan: 0.04,
    tones: [{ f: 230, fEnd: 195, sweep: 0.012, decay: 0.12, level: 0.55 }],
    noises: [
      { filter: 'hp', f: 1900, q: 0.7, decay: 0.2, level: 0.85 },
      { filter: 'bp', f: 7000, q: 0.8, decay: 0.1, level: 0.3 },
    ],
    click: { level: 0.2, decay: 0.002 },
    drive: 0.2,
    velBright: 0.5,
  },
  [GM_DRUM.FLOOR_TOM_LOW]: tom(82, 0.45, 0.75),
  [GM_DRUM.FLOOR_TOM_HIGH]: tom(98, 0.35, 0.65),
  [GM_DRUM.TOM_LOW]: tom(112, 0.2, 0.55),
  [GM_DRUM.TOM_LOW_MID]: tom(132, 0.05, 0.5),
  [GM_DRUM.TOM_HIGH_MID]: tom(150, -0.1, 0.45),
  [GM_DRUM.TOM_HIGH]: tom(178, -0.25, 0.4),
  [GM_DRUM.HIHAT_CLOSED]: {
    name: 'hh-closed',
    gain: 0.42,
    pan: -0.3,
    metal: { freqs: HAT808.map((f) => f * 1.55), decay: 0.07, level: 0.5, hp: 7200, bp: 10500, q: 0.9 },
    noises: [{ filter: 'hp', f: 8000, q: 0.7, decay: 0.05, level: 0.55 }],
    group: 1,
    chokes: 1,
    velDecay: 0.4,
    velBright: 0.4,
  },
  [GM_DRUM.HIHAT_PEDAL]: {
    name: 'hh-pedal',
    gain: 0.32,
    pan: -0.3,
    metal: {
      freqs: HAT808.map((f) => f * 1.5),
      decay: 0.09,
      level: 0.5,
      hp: 6000,
      bp: 9000,
      q: 0.9,
      attack: 0.003,
    },
    noises: [{ filter: 'hp', f: 6500, q: 0.7, decay: 0.06, level: 0.4, attack: 0.002 }],
    group: 1,
    chokes: 1,
  },
  [GM_DRUM.HIHAT_OPEN]: {
    name: 'hh-open',
    gain: 0.4,
    pan: -0.3,
    metal: { freqs: HAT808.map((f) => f * 1.55), decay: 0.6, level: 0.5, hp: 6800, bp: 10000, q: 0.8 },
    noises: [{ filter: 'hp', f: 7500, q: 0.7, decay: 0.5, level: 0.5 }],
    group: 1,
    chokes: 1,
    velDecay: 0.3,
    maxVoices: 1,
  },
  [GM_DRUM.CRASH]: {
    name: 'crash',
    gain: 0.5,
    pan: -0.45,
    metal: { freqs: CYM.map((f) => f * 1.9), decay: 2.2, level: 0.45, hp: 3800, bp: 7500, q: 0.5 },
    noises: [
      { filter: 'hp', f: 4500, q: 0.7, decay: 1.9, level: 0.5 },
      { filter: 'bp', f: 3000, q: 0.8, decay: 0.25, level: 0.35 },
    ],
    velDecay: 0.3,
    maxVoices: 2,
  },
  [GM_DRUM.CRASH_2]: {
    name: 'crash2',
    gain: 0.5,
    pan: 0.5,
    metal: { freqs: CYM.map((f) => f * 2.15), decay: 2.0, level: 0.45, hp: 4200, bp: 8000, q: 0.5 },
    noises: [
      { filter: 'hp', f: 5000, q: 0.7, decay: 1.7, level: 0.5 },
      { filter: 'bp', f: 3400, q: 0.8, decay: 0.22, level: 0.35 },
    ],
    velDecay: 0.3,
    maxVoices: 2,
  },
  [GM_DRUM.CHINA]: {
    name: 'china',
    gain: 0.5,
    pan: 0.55,
    metal: { freqs: CYM.map((f) => f * 1.45), decay: 1.5, level: 0.6, hp: 2500, bp: 4200, q: 0.7 },
    noises: [{ filter: 'bp', f: 4000, q: 0.6, decay: 1.2, level: 0.45 }],
    drive: 0.3,
    maxVoices: 2,
  },
  [GM_DRUM.SPLASH]: {
    name: 'splash',
    gain: 0.45,
    pan: -0.2,
    metal: { freqs: CYM.map((f) => f * 2.6), decay: 0.9, level: 0.45, hp: 5500, bp: 9000, q: 0.6 },
    noises: [{ filter: 'hp', f: 6000, q: 0.7, decay: 0.8, level: 0.45 }],
    maxVoices: 2,
  },
  [GM_DRUM.RIDE]: {
    name: 'ride',
    gain: 0.36,
    pan: 0.45,
    metal: { freqs: CYM.map((f) => f * 2.4), decay: 2.4, level: 0.3, hp: 5500, bp: 8500, q: 0.6 },
    noises: [
      { filter: 'hp', f: 7000, q: 0.7, decay: 1.4, level: 0.18 },
      { filter: 'bp', f: 5200, q: 3, decay: 0.05, level: 0.45 },
    ],
    tones: [{ f: 3100, decay: 0.6, level: 0.08 }],
    maxVoices: 2,
  },
  [GM_DRUM.RIDE_2]: {
    name: 'ride2',
    gain: 0.34,
    pan: 0.5,
    metal: { freqs: CYM.map((f) => f * 2.2), decay: 2.2, level: 0.3, hp: 5000, bp: 8000, q: 0.6 },
    noises: [
      { filter: 'hp', f: 6500, q: 0.7, decay: 1.3, level: 0.18 },
      { filter: 'bp', f: 4800, q: 3, decay: 0.05, level: 0.45 },
    ],
    maxVoices: 2,
  },
  [GM_DRUM.RIDE_BELL]: {
    name: 'ridebell',
    gain: 0.4,
    pan: 0.45,
    tones: [
      { f: 820, decay: 1.4, level: 0.5 },
      { f: 1235, decay: 1.0, level: 0.35 },
      { f: 1890, decay: 0.7, level: 0.25 },
    ],
    metal: { freqs: CYM.map((f) => f * 2.4), decay: 1.5, level: 0.18, hp: 5000, bp: 8000, q: 0.7 },
    maxVoices: 2,
  },
  [GM_DRUM.TAMBOURINE]: {
    name: 'tambourine',
    gain: 0.4,
    pan: 0.35,
    metal: { freqs: [2380, 3150, 4210, 5320, 6070, 7300], decay: 0.22, level: 0.4, hp: 6000, bp: 8500, q: 1 },
    noises: [{ filter: 'hp', f: 7000, q: 0.7, decay: 0.16, level: 0.4 }],
    bursts: { count: 2, spacing: 0.011 },
  },
  [GM_DRUM.COWBELL]: {
    name: 'cowbell',
    gain: 0.45,
    pan: 0.25,
    metal: { freqs: [562, 845], decay: 0.32, level: 0.9, hp: 400, bp: 900, q: 1.6 },
    click: { level: 0.15, decay: 0.002 },
  },
  [GM_DRUM.VIBRASLAP]: {
    name: 'vibraslap',
    gain: 0.35,
    pan: 0.3,
    noises: [{ filter: 'bp', f: 3000, q: 2, decay: 0.03, level: 0.9 }],
    tones: [{ f: 1650, decay: 0.6, level: 0.15 }],
    bursts: { count: 14, spacing: 0.032 },
  },
  [GM_DRUM.BONGO_HIGH]: conga(420, -0.25, 0.14, 0.35),
  [GM_DRUM.BONGO_LOW]: conga(310, -0.15, 0.18, 0.3),
  [GM_DRUM.CONGA_MUTE]: conga(345, 0.15, 0.06, 0.45),
  [GM_DRUM.CONGA_HIGH]: conga(330, 0.2, 0.25, 0.3),
  [GM_DRUM.CONGA_LOW]: conga(225, 0.3, 0.32, 0.25),
  [GM_DRUM.TIMBALE_HIGH]: {
    name: 'timbale',
    gain: 0.6,
    pan: -0.3,
    tones: [
      { f: 470, fEnd: 440, sweep: 0.01, decay: 0.35, level: 1 },
      { f: 1080, decay: 0.25, level: 0.3 },
    ],
    noises: [{ filter: 'bp', f: 3000, q: 1, decay: 0.05, level: 0.35 }],
  },
  [GM_DRUM.TIMBALE_LOW]: {
    name: 'timbale',
    gain: 0.6,
    pan: -0.2,
    tones: [
      { f: 345, fEnd: 320, sweep: 0.01, decay: 0.4, level: 1 },
      { f: 790, decay: 0.28, level: 0.3 },
    ],
    noises: [{ filter: 'bp', f: 2600, q: 1, decay: 0.05, level: 0.35 }],
  },
  [GM_DRUM.AGOGO_HIGH]: {
    name: 'agogo',
    gain: 0.4,
    pan: 0.3,
    tones: [
      { f: 935, decay: 0.45, level: 0.8 },
      { f: 2290, decay: 0.3, level: 0.35 },
    ],
  },
  [GM_DRUM.AGOGO_LOW]: {
    name: 'agogo',
    gain: 0.4,
    pan: 0.2,
    tones: [
      { f: 650, decay: 0.5, level: 0.8 },
      { f: 1590, decay: 0.32, level: 0.35 },
    ],
  },
  [GM_DRUM.CABASA]: {
    name: 'cabasa',
    gain: 0.35,
    pan: 0.25,
    noises: [{ filter: 'hp', f: 6200, q: 0.7, decay: 0.09, attack: 0.012, level: 0.9 }],
  },
  [GM_DRUM.MARACAS]: {
    name: 'maracas',
    gain: 0.33,
    pan: -0.25,
    noises: [{ filter: 'hp', f: 5200, q: 0.7, decay: 0.07, attack: 0.005, level: 0.9 }],
  },
  [GM_DRUM.WHISTLE_SHORT]: {
    name: 'whistle',
    gain: 0.3,
    pan: 0,
    tones: [{ f: 2320, decay: 0.12, level: 0.7 }],
  },
  [GM_DRUM.WHISTLE_LONG]: {
    name: 'whistle',
    gain: 0.3,
    pan: 0,
    tones: [{ f: 2280, decay: 0.55, level: 0.7 }],
  },
  [GM_DRUM.GUIRO_SHORT]: {
    name: 'guiro',
    gain: 0.35,
    pan: 0.2,
    noises: [{ filter: 'bp', f: 3200, q: 1.5, decay: 0.012, level: 0.9 }],
    bursts: { count: 6, spacing: 0.011 },
  },
  [GM_DRUM.GUIRO_LONG]: {
    name: 'guiro',
    gain: 0.35,
    pan: 0.2,
    noises: [{ filter: 'bp', f: 3000, q: 1.5, decay: 0.012, level: 0.9 }],
    bursts: { count: 16, spacing: 0.013 },
  },
  [GM_DRUM.CLAVES]: {
    name: 'claves',
    gain: 0.45,
    pan: 0.15,
    tones: [{ f: 2500, fEnd: 2470, sweep: 0.005, decay: 0.07, level: 0.9 }],
  },
  [GM_DRUM.WOODBLOCK_HIGH]: {
    name: 'woodblock',
    gain: 0.45,
    pan: -0.15,
    tones: [{ f: 1180, fEnd: 1150, sweep: 0.004, decay: 0.08, level: 0.9 }],
    noises: [{ filter: 'bp', f: 2400, q: 2, decay: 0.012, level: 0.3 }],
  },
  [GM_DRUM.WOODBLOCK_LOW]: {
    name: 'woodblock',
    gain: 0.45,
    pan: -0.1,
    tones: [{ f: 830, fEnd: 810, sweep: 0.004, decay: 0.09, level: 0.9 }],
    noises: [{ filter: 'bp', f: 1900, q: 2, decay: 0.012, level: 0.3 }],
  },
  [GM_DRUM.CUICA_MUTE]: {
    name: 'cuica',
    gain: 0.35,
    pan: 0.2,
    tones: [{ f: 520, fEnd: 760, sweep: 0.03, decay: 0.12, level: 0.8 }],
  },
  [GM_DRUM.CUICA_OPEN]: {
    name: 'cuica',
    gain: 0.35,
    pan: 0.2,
    tones: [{ f: 760, fEnd: 470, sweep: 0.08, decay: 0.3, level: 0.8 }],
  },
  [GM_DRUM.TRIANGLE_MUTE]: {
    name: 'triangle',
    gain: 0.3,
    pan: 0.4,
    tones: [
      { f: 4650, decay: 0.12, level: 0.5 },
      { f: 6420, decay: 0.1, level: 0.3 },
      { f: 8150, decay: 0.08, level: 0.2 },
    ],
  },
  [GM_DRUM.TRIANGLE_OPEN]: {
    name: 'triangle',
    gain: 0.3,
    pan: 0.4,
    tones: [
      { f: 4650, decay: 1.6, level: 0.5 },
      { f: 6420, decay: 1.2, level: 0.3 },
      { f: 8150, decay: 0.9, level: 0.2 },
    ],
    maxVoices: 2,
  },
  [GM_DRUM.SHAKER]: {
    name: 'shaker',
    gain: 0.33,
    pan: 0.3,
    noises: [{ filter: 'hp', f: 5800, q: 0.7, decay: 0.08, attack: 0.014, level: 0.9 }],
  },
};

const ELECTRONIC: Record<number, DrumPiece> = {
  ...ACOUSTIC,
  [GM_DRUM.KICK_ACOUSTIC]: {
    name: 'kick808',
    gain: 1.25,
    pan: 0,
    tones: [{ f: 120, fEnd: 44, sweep: 0.06, decay: 1.0, level: 1 }],
    click: { level: 0.15, decay: 0.003 },
    drive: 0.45,
    velPitch: 0.1,
  },
  [GM_DRUM.KICK]: {
    name: 'kick909',
    gain: 1.2,
    pan: 0,
    tones: [{ f: 190, fEnd: 52, sweep: 0.028, decay: 0.5, level: 1 }],
    noises: [{ filter: 'hp', f: 3500, q: 0.7, decay: 0.012, level: 0.35 }],
    drive: 0.5,
    velPitch: 0.1,
  },
  [GM_DRUM.SNARE]: {
    name: 'snare909',
    gain: 0.9,
    pan: 0,
    tones: [
      { f: 240, fEnd: 190, sweep: 0.012, decay: 0.12, level: 0.6 },
      { f: 410, fEnd: 360, sweep: 0.01, decay: 0.06, level: 0.3 },
    ],
    noises: [{ filter: 'hp', f: 1700, q: 0.7, decay: 0.2, level: 0.85 }],
    velBright: 0.4,
  },
  [GM_DRUM.CLAP]: {
    name: 'clap808',
    gain: 0.8,
    pan: 0,
    noises: [{ filter: 'bp', f: 1100, q: 1.3, decay: 0.28, level: 1 }],
    bursts: { count: 4, spacing: 0.011 },
  },
  [GM_DRUM.HIHAT_CLOSED]: {
    name: 'hh808',
    gain: 0.4,
    pan: -0.2,
    metal: { freqs: HAT808, decay: 0.055, level: 0.8, hp: 8000, bp: 10000, q: 1 },
    group: 1,
    chokes: 1,
  },
  [GM_DRUM.HIHAT_PEDAL]: {
    name: 'hh808p',
    gain: 0.3,
    pan: -0.2,
    metal: { freqs: HAT808, decay: 0.07, level: 0.8, hp: 7000, bp: 9000, q: 1 },
    group: 1,
    chokes: 1,
  },
  [GM_DRUM.HIHAT_OPEN]: {
    name: 'oh808',
    gain: 0.38,
    pan: -0.2,
    metal: { freqs: HAT808, decay: 0.42, level: 0.8, hp: 7500, bp: 10000, q: 1 },
    group: 1,
    chokes: 1,
    maxVoices: 1,
  },
  [GM_DRUM.COWBELL]: {
    name: 'cowbell808',
    gain: 0.45,
    pan: 0.2,
    metal: { freqs: [540, 800], decay: 0.38, level: 0.9, hp: 450, bp: 850, q: 1.4 },
  },
  [GM_DRUM.FLOOR_TOM_LOW]: { ...tom(70, 0.4, 0.8), noises: [] },
  [GM_DRUM.FLOOR_TOM_HIGH]: { ...tom(85, 0.3, 0.7), noises: [] },
  [GM_DRUM.TOM_LOW]: { ...tom(100, 0.15, 0.6), noises: [] },
  [GM_DRUM.TOM_LOW_MID]: { ...tom(120, 0, 0.55), noises: [] },
  [GM_DRUM.TOM_HIGH_MID]: { ...tom(145, -0.15, 0.5), noises: [] },
  [GM_DRUM.TOM_HIGH]: { ...tom(175, -0.3, 0.45), noises: [] },
};

export type DrumKitId = 'acoustic' | 'electronic' | 'percussion';

const KITS: Record<DrumKitId, Record<number, DrumPiece>> = {
  acoustic: ACOUSTIC,
  electronic: ELECTRONIC,
  percussion: ACOUSTIC,
};

const genericPieces = new Map<number, DrumPiece>();

/** Piece for a GM drum note (unknown notes fall back to a pitched percussion hit). */
export function drumPiece(kit: DrumKitId, note: number): DrumPiece {
  const k = KITS[kit] ?? ACOUSTIC;
  const p = k[note];
  if (p) return p;
  if (note < 35) return k[GM_DRUM.KICK];
  // generic pitched block for out-of-map notes (cached: no allocation on note-on)
  const key = Math.round(note);
  let g = genericPieces.get(key);
  if (!g) {
    const f = Math.min(6000, 200 * Math.pow(2, (key - 60) / 24));
    g = {
      name: 'perc',
      gain: 0.4,
      pan: 0,
      tones: [{ f: f * 1.1, fEnd: f, sweep: 0.01, decay: 0.15, level: 0.8 }],
      noises: [{ filter: 'bp', f: Math.min(15000, f * 6), q: 1.5, decay: 0.02, level: 0.3 }],
    };
    genericPieces.set(key, g);
  }
  return g;
}

const MAXT = 3,
  MAXN = 2,
  MAXM = 6;

export class DrumVoice extends Voice {
  piece: DrumPiece | null = null;
  private readonly tph = new Float64Array(MAXT);
  private readonly tf = new Float64Array(MAXT);
  private readonly tfEnd = new Float64Array(MAXT);
  private readonly tSweep = new Float64Array(MAXT);
  private readonly tAmp = new Float64Array(MAXT);
  private readonly tDec = new Float64Array(MAXT);
  private nT = 0;
  private readonly nf: Svf[] = [new Svf(), new Svf()];
  private readonly nType = new Int32Array(MAXN);
  private readonly nAmp = new Float64Array(MAXN);
  private readonly nDec = new Float64Array(MAXN);
  private readonly nAtt = new Float64Array(MAXN);
  private readonly nAttInc = new Float64Array(MAXN);
  private nN = 0;
  private readonly mph = new Float64Array(MAXM);
  private readonly minc = new Float64Array(MAXM);
  private nM = 0;
  private mAmp = 0;
  private mDec = 1;
  private mAtt = 1;
  private mAttInc = 0;
  private readonly mbp = new Svf();
  private readonly mhp = new Svf();
  private clickAmp = 0;
  private clickDec = 0;
  private burstLeft = 0;
  private burstSpacing = 0;
  private burstTimer = 0;
  private burstEnv = 1;
  private drive = 0;
  private noise = 1;
  private gain = 1;
  private fade = 1;
  private fadeStep = 0;
  private peak = 0;
  private quiet = 0;
  private readonly pg = new Float64Array(2);
  private readonly buf = new Float64Array(BLOCK);
  private readonly sr: number;

  constructor(host: VoiceHost) {
    super(host);
    this.sr = host.sampleRate;
  }

  start(ev: NoteEvent): void {
    this.begin(ev);
  }

  startPiece(ev: NoteEvent, piece: DrumPiece): void {
    this.begin(ev);
    this.piece = piece;
    const sr = this.sr;
    const v = clampNum(ev.velocity / 127, 0, 1);
    const dead = (ev.art & ART_DEAD) !== 0;
    const dScale = (1 + (piece.velDecay ?? 0) * (v - 0.7)) * (dead ? 0.3 : 1);
    const bright = 1 + (piece.velBright ?? 0) * (v - 0.7);
    const tones = piece.tones ?? [];
    this.nT = Math.min(MAXT, tones.length);
    for (let k = 0; k < this.nT; k++) {
      const t = tones[k];
      const f = t.f * (1 + (piece.velPitch ?? 0) * (v - 0.6));
      this.tf[k] = f;
      this.tfEnd[k] = t.fEnd ?? t.f;
      this.tSweep[k] = t.sweep ? Math.exp(-1 / (t.sweep * sr)) : 0;
      this.tAmp[k] = t.level;
      this.tDec[k] = t60Coef(t.decay * dScale, sr);
      this.tph[k] = 0;
    }
    const noises = piece.noises ?? [];
    this.nN = Math.min(MAXN, noises.length);
    for (let k = 0; k < this.nN; k++) {
      const nz = noises[k];
      this.nType[k] = nz.filter === 'hp' ? 0 : nz.filter === 'bp' ? 1 : 2;
      this.nf[k].reset();
      this.nf[k].set(Math.min(sr * 0.45, nz.f * bright), nz.q, sr);
      this.nAmp[k] = nz.level * (nz.filter === 'lp' ? 1 : bright);
      this.nDec[k] = t60Coef(nz.decay * dScale, sr);
      this.nAtt[k] = nz.attack ? 0 : 1;
      this.nAttInc[k] = nz.attack ? 1 / (nz.attack * sr) : 0;
    }
    const m = piece.metal;
    this.nM = m ? Math.min(MAXM, m.freqs.length) : 0;
    if (m) {
      for (let k = 0; k < this.nM; k++) {
        this.minc[k] = m.freqs[k] / sr;
        this.mph[k] = k * 0.17;
      }
      this.mAmp = m.level * bright;
      this.mDec = t60Coef(m.decay * dScale, sr);
      this.mAtt = m.attack ? 0 : 1;
      this.mAttInc = m.attack ? 1 / (m.attack * sr) : 0;
      this.mbp.reset();
      this.mhp.reset();
      this.mbp.set(Math.min(sr * 0.45, m.bp * bright), m.q, sr);
      this.mhp.set(Math.min(sr * 0.45, m.hp), 0.7, sr);
    }
    this.clickAmp = piece.click ? piece.click.level * (0.5 + v) : 0;
    this.clickDec = piece.click ? t60Coef(piece.click.decay, sr) : 0;
    this.burstLeft = piece.bursts ? piece.bursts.count - 1 : 0;
    this.burstSpacing = piece.bursts ? Math.round(piece.bursts.spacing * sr) : 0;
    this.burstTimer = this.burstSpacing;
    this.burstEnv = 1;
    this.drive = piece.drive ?? 0;
    this.noise = seedState(ev.seed);
    this.gain = velocityGain(ev.velocity, 0.85) * piece.gain;
    this.fade = 1;
    this.fadeStep = 0;
    this.peak = 0;
    this.quiet = 0;
    panGains(clampNum(piece.pan + ev.pan, -1, 1), this.pg);
  }

  release(): void {
    // drums ignore note-off (one-shot)
    this.released = true;
  }

  /** Choke (hats) / steal: fast fade. */
  kill(): void {
    this.killed = true;
    this.fadeStep = 1 / Math.max(1, 0.012 * this.sr);
  }

  level(): number {
    return this.peak;
  }

  render(L: Float64Array, R: Float64Array, start: number, end: number): void {
    const sr = this.sr;
    const buf = this.buf;
    for (let i = start; i < end; i++) buf[i] = 0;
    // tones
    for (let k = 0; k < this.nT; k++) {
      let amp = this.tAmp[k];
      if (amp < 1e-6) continue;
      let f = this.tf[k];
      const fEnd = this.tfEnd[k];
      const sw = this.tSweep[k];
      const dec = this.tDec[k];
      let ph = this.tph[k];
      const isr = 1 / sr;
      for (let i = start; i < end; i++) {
        if (sw > 0) f = fEnd + (f - fEnd) * sw;
        ph += f * isr;
        if (ph >= 1) ph -= 1;
        buf[i] += sin01(ph) * amp;
        amp *= dec;
      }
      this.tf[k] = f;
      this.tph[k] = ph;
      this.tAmp[k] = amp;
    }
    let ns = this.noise;
    // noise layers (inline TPT SVF); bursts retrigger the layer amplitudes
    if (this.nN > 0) {
      const burstOn = this.burstSpacing > 0;
      for (let k = 0; k < this.nN; k++) {
        if (this.nAmp[k] < 1e-6 && (!burstOn || this.burstLeft === 0)) continue;
        const flt = this.nf[k];
        const type = this.nType[k];
        let amp = this.nAmp[k];
        let att = this.nAtt[k];
        const attInc = this.nAttInc[k];
        const dec = this.nDec[k];
        const a1 = flt.a1,
          a2 = flt.a2,
          a3 = flt.a3,
          kq = flt.k;
        let ic1 = flt.ic1,
          ic2 = flt.ic2;
        let s2 = ns ^ (k * 0x9e3779b9);
        if (s2 === 0) s2 = 1;
        let timer = this.burstTimer;
        let left = this.burstLeft;
        const lvl = burstOn ? (this.piece?.noises?.[k]?.level ?? 0) * 0.9 : 0;
        for (let i = start; i < end; i++) {
          if (burstOn && --timer <= 0 && left > 0) {
            left--;
            timer = this.burstSpacing;
            if (amp < lvl) amp = lvl;
          }
          s2 ^= s2 << 13;
          s2 ^= s2 >>> 17;
          s2 ^= s2 << 5;
          const x = s2 * NOISE_SCALE;
          const v3 = x - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
          const y = type === 0 ? x - kq * v1 - v2 : type === 1 ? v1 : v2;
          let g = amp;
          if (att < 1) {
            att += attInc;
            if (att > 1) att = 1;
            g *= att;
          }
          buf[i] += y * g;
          amp *= dec;
        }
        flt.ic1 = Math.abs(ic1) < 1e-25 ? 0 : ic1;
        flt.ic2 = Math.abs(ic2) < 1e-25 ? 0 : ic2;
        this.nAmp[k] = amp;
        this.nAtt[k] = att;
        if (k === this.nN - 1) {
          this.burstTimer = timer;
          this.burstLeft = left;
        }
        ns = s2 | 0;
      }
    }
    // metal bank → BP → HP
    if (this.nM > 0 && this.mAmp > 1e-6) {
      const nM = this.nM;
      const mph = this.mph,
        minc = this.minc;
      const bp = this.mbp,
        hp = this.mhp;
      const ba1 = bp.a1,
        ba2 = bp.a2,
        ba3 = bp.a3;
      const ha1 = hp.a1,
        ha2 = hp.a2,
        ha3 = hp.a3,
        hk = hp.k;
      let bc1 = bp.ic1,
        bc2 = bp.ic2,
        hc1 = hp.ic1,
        hc2 = hp.ic2;
      let amp = this.mAmp;
      const dec = this.mDec;
      let att = this.mAtt;
      const attInc = this.mAttInc;
      for (let i = start; i < end; i++) {
        let m = 0;
        for (let k = 0; k < nM; k++) {
          let p = mph[k] + minc[k];
          if (p >= 1) p -= 1;
          mph[k] = p;
          m += p < 0.5 ? 0.25 : -0.25;
        }
        let v3 = m - bc2;
        let v1 = ba1 * bc1 + ba2 * v3;
        let v2 = bc2 + ba2 * bc1 + ba3 * v3;
        bc1 = 2 * v1 - bc1;
        bc2 = 2 * v2 - bc2;
        const x = v1;
        v3 = x - hc2;
        v1 = ha1 * hc1 + ha2 * v3;
        v2 = hc2 + ha2 * hc1 + ha3 * v3;
        hc1 = 2 * v1 - hc1;
        hc2 = 2 * v2 - hc2;
        let g = amp;
        if (att < 1) {
          att += attInc;
          if (att > 1) att = 1;
          g *= att;
        }
        buf[i] += (x - hk * v1 - v2) * g;
        amp *= dec;
      }
      bp.ic1 = bc1;
      bp.ic2 = bc2;
      hp.ic1 = hc1;
      hp.ic2 = hc2;
      bp.flush();
      hp.flush();
      this.mAmp = amp;
      this.mAtt = att;
    }
    // click
    if (this.clickAmp > 1e-5) {
      let ca = this.clickAmp;
      const cd = this.clickDec;
      for (let i = start; i < end && ca > 1e-5; i++) {
        ns = xorshift(ns);
        buf[i] += ns * NOISE_SCALE * ca;
        ca *= cd;
      }
      this.clickAmp = ca;
    }
    this.noise = ns || 1;
    // drive, choke fade, pan, peak
    const drive = this.drive;
    const dg = 1 + drive * 3;
    const dn = drive > 0 ? 1 / softClip(dg) : 1;
    const gl = this.pg[0] * this.gain,
      gr = this.pg[1] * this.gain;
    let fade = this.fade;
    const fs = this.fadeStep;
    let peak = 0;
    for (let i = start; i < end; i++) {
      let s = buf[i];
      if (drive > 0) s = softClip(s * dg) * dn;
      if (fs > 0) {
        fade -= fs;
        if (fade < 0) fade = 0;
        s *= fade;
      }
      L[i] += s * gl;
      R[i] += s * gr;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    this.fade = fade;
    this.peak = peak * this.gain;
    if (peak < 5e-5) this.quiet += end - start;
    else this.quiet = 0;
    if ((this.killed && this.fade <= 0) || this.quiet > 0.02 * sr) this.active = false;
  }
}
