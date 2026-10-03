/**
 * Mixer defaults for generated songs (spec §40): sensible channel strips per role, double-tracked
 * guitars panned wide, high-pass filters on everything that isn't bass, compression on drums, bass
 * and vocals, reverb sends scaled by the genre's production reverb, vocal slightly forward.
 */
import type { ChannelStrip, GenreProfile, InstrumentProfile, MixerState, Song, Track, TrackRole } from '../ir/types';
import { defaultChannelStrip, defaultCompressor, defaultEq, defaultMixer } from '../ir/defaults';
import { colorForRole } from '../ir/palette';
import { clamp, clamp01 } from './util';

export function trackColor(role: TrackRole): string {
  return colorForRole(role);
}

const HPF_BY_INSTRUMENT: Record<string, number> = {
  'lead-vocal': 90, 'backing-vocal': 120, choir: 90, violin: 180, viola: 120, cello: 50, contrabass: 30, 'string-ensemble': 60,
  'pizzicato-strings': 70, harp: 60, flute: 180, clarinet: 120, saxophone: 100, trumpet: 140, trombone: 70, 'french-horn': 70,
  'brass-section': 80, piano: 50, 'electric-piano': 70, organ: 70, 'synth-pad': 120, 'synth-arp': 150, 'synth-lead': 120, 'synth-seq': 100,
  'electric-guitar-distorted': 90, 'electric-guitar-clean': 100, 'acoustic-guitar': 100, 'electric-guitar-lead': 110, percussion: 200,
  glockenspiel: 400, marimba: 80, timpani: 35,
};

function baseVolume(role: TrackRole, instrumentId: string, fn?: string): number {
  if (role === 'vocal') return instrumentId === 'lead-vocal' || fn === 'melody' ? -3 : instrumentId === 'choir' ? -11 : -10;
  switch (role) {
    case 'drums':
      return -5;
    case 'percussion':
      return instrumentId === 'timpani' ? -9 : -13;
    case 'bass':
      return -6;
    case 'rhythm-guitar':
      return -9;
    case 'lead-guitar':
      return -8;
    case 'keys':
      return -9;
    case 'strings':
      return instrumentId === 'string-ensemble' ? -11 : -9;
    case 'synth-pad':
      return -13;
    case 'synth-arp':
      return -12;
    case 'synth-seq':
      return -12;
    case 'synth-lead':
      return -9;
    default:
      return -10;
  }
}

function basePan(track: Track, instrumentId: string, pairIndex: number, pairCount: number): number {
  if (track.role === 'rhythm-guitar' && pairCount >= 2) {
    const side = pairIndex % 2 === 0 ? -1 : 1;
    return side * (pairIndex < 2 ? 0.72 : 0.4);
  }
  if (track.role === 'vocal') {
    if (instrumentId === 'lead-vocal' || track.constraints?.function === 'melody') return 0;
    return pairCount >= 2 ? (pairIndex % 2 === 0 ? -0.45 : 0.45) : 0.25;
  }
  const table: Record<string, number> = {
    'electric-guitar-lead': 0.2, 'electric-guitar-clean': -0.3, 'acoustic-guitar': -0.25, piano: -0.2, 'electric-piano': -0.25, organ: 0.3,
    violin: 0.35, viola: 0.15, cello: -0.3, contrabass: -0.15, 'string-ensemble': 0.1, 'pizzicato-strings': 0.2, harp: -0.35,
    trumpet: 0.3, trombone: -0.25, 'french-horn': -0.35, 'brass-section': 0.25, flute: 0.4, clarinet: -0.4, saxophone: 0.25,
    'synth-arp': -0.35, 'synth-seq': 0.35, 'synth-lead': 0.15, percussion: 0.4, glockenspiel: 0.3, marimba: -0.3, choir: 0, timpani: -0.1,
  };
  if (track.role === 'rhythm-guitar' && pairCount === 1) return -0.3;
  return table[instrumentId] ?? 0;
}

/** Channel strip for one generated track. */
export function defaultChannelFor(track: Track, instrument: InstrumentProfile, genre: GenreProfile, pairIndex: number, pairCount: number, panOverride?: number): ChannelStrip {
  const id = instrument.id;
  const fn = track.constraints?.function;
  const strip = defaultChannelStrip({ volumeDb: baseVolume(track.role, id, fn), pan: clamp(panOverride ?? basePan(track, id, pairIndex, pairCount), -1, 1) });
  const eq = defaultEq();
  eq.highpassHz = track.role === 'bass' || track.role === 'drums' || instrument.isDrumKit ? (track.role === 'bass' ? 30 : 0) : HPF_BY_INSTRUMENT[id] ?? 80;
  if (instrument.isDrumKit && track.role === 'percussion') eq.highpassHz = 200;
  const comp = defaultCompressor();
  const reverb = clamp01(genre.production.reverb);
  let reverbFactor = 0.6;
  let delay = 0;
  switch (track.role) {
    case 'drums':
      Object.assign(comp, { enabled: true, thresholdDb: -16, ratio: 4, attackMs: 10, releaseMs: 120, makeupDb: 2 });
      eq.lowShelfDb = 1;
      eq.highShelfDb = 1;
      reverbFactor = 0.35;
      break;
    case 'bass':
      Object.assign(comp, { enabled: true, thresholdDb: -20, ratio: 4, attackMs: 15, releaseMs: 150, makeupDb: 2 });
      eq.lowShelfDb = 1;
      reverbFactor = 0;
      strip.width = 0.5;
      strip.drive = genre.harmony.powerChords ? 0.12 : 0.04;
      break;
    case 'vocal':
      if (id === 'lead-vocal' || fn === 'melody') {
        Object.assign(comp, { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 5, releaseMs: 100, makeupDb: 2 });
        eq.highMidDb = 1.5;
        eq.highMidHz = 3000;
        eq.highShelfDb = 1.5;
        reverbFactor = 0.85;
        delay = genre.rhythm.drumStyle === 'punk' || genre.rhythm.drumStyle === 'metal' ? 0.06 : 0.14;
        strip.width = 0.8;
      } else {
        Object.assign(comp, { enabled: true, thresholdDb: -20, ratio: 3, attackMs: 8, releaseMs: 120 });
        reverbFactor = 1.1;
      }
      break;
    case 'rhythm-guitar':
      if (id === 'electric-guitar-distorted') {
        eq.lowMidDb = -2;
        eq.lowMidHz = 400;
      }
      reverbFactor = 0.45;
      break;
    case 'lead-guitar':
    case 'synth-lead':
      Object.assign(comp, { enabled: true, thresholdDb: -18, ratio: 2.5, attackMs: 12, releaseMs: 140 });
      reverbFactor = 0.8;
      delay = 0.16;
      break;
    case 'strings':
      reverbFactor = 1.0;
      if (id === 'string-ensemble') strip.width = 1.3;
      break;
    case 'synth-pad':
      reverbFactor = 1.1;
      strip.width = 1.4;
      break;
    case 'synth-arp':
      reverbFactor = 0.8;
      delay = 0.22;
      strip.width = 1.2;
      break;
    case 'synth-seq':
      reverbFactor = 0.5;
      delay = 0.12;
      break;
    case 'keys':
      reverbFactor = 0.75;
      break;
    case 'percussion':
      reverbFactor = 0.6;
      break;
    default:
      reverbFactor = 0.8;
  }
  strip.eq = eq;
  strip.compressor = comp;
  strip.reverbSend = Math.round(clamp01(reverb * reverbFactor) * 100) / 100;
  strip.delaySend = delay;
  return strip;
}

/** Shared reverb/delay buses shaped by the genre's production style. */
export function mixerForGenre(genre: GenreProfile): MixerState {
  const m = defaultMixer();
  const d = genre.rhythm.drumStyle;
  const rv = clamp01(genre.production.reverb);
  m.reverb.type = d === 'orchestral' || d === 'cinematic' || d === 'trance' ? 'hall' : d === 'punk' || d === 'indie' || d === 'folk' || d === 'country' || d === 'jazz-swing' || d === 'hip-hop' ? 'room' : 'plate';
  m.reverb.size = Math.round((0.35 + rv * 0.6) * 100) / 100;
  m.reverb.decaySeconds = Math.round((0.8 + rv * 3.2) * 10) / 10;
  m.reverb.returnDb = -6 + Math.round(rv * 4);
  m.delay.feedback = d === 'trance' || d === 'synth-pop' ? 0.38 : 0.28;
  if (genre.production.masteringTarget === 'loud-rock') m.master.compressor.ratio = 3;
  return m;
}

/** Fill mixer channels for every track of a song that has no strip yet. */
export function fillMixer(song: Song, genre: GenreProfile, instrumentOf: (t: Track) => InstrumentProfile, pans?: Map<string, number>): void {
  const groups = new Map<string, Track[]>();
  for (const t of song.tracks) {
    const k = `${t.role}|${t.instrumentId}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  for (const t of song.tracks) {
    if (song.mixer.channels[t.id]) continue;
    const group = groups.get(`${t.role}|${t.instrumentId}`) ?? [t];
    song.mixer.channels[t.id] = defaultChannelFor(t, instrumentOf(t), genre, group.indexOf(t), group.length, pans?.get(t.id));
  }
}
