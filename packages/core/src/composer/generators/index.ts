/**
 * Role generator dispatch and generation order. Drums come first (bass locks to the kick), then
 * the principal melody (counter-melodies answer it), then accompaniment, then lines that react to
 * everything else (lead guitar, synth leads).
 */
import type { InstrumentProfile, MusicalFunction, Track } from '../../ir/types';
import type { Cell } from '../context';
import { generateBass } from './bass';
import { generateChordal } from './chordal';
import { generateDrums } from './drums';
import { generateRhythmGuitar } from './guitar';
import { generateMelodicLine } from './lead';
import { generatePercussion } from './percussion';
import { generateArp, generateSeq } from './synth';
import type { GenOutput } from './types';
import { generateVocal } from './vocal';

export type { GenOutput, PhraseDraft } from './types';

const MELODIC: MusicalFunction[] = ['melody', 'counter-melody', 'hook', 'solo', 'fills'];

/** Lower runs earlier. */
export function generationPriority(track: Track, inst: InstrumentProfile, fn: MusicalFunction, principalId?: string): number {
  if (inst.isDrumKit) return track.role === 'drums' ? 0 : 1;
  if (track.id === principalId) return 2;
  switch (track.role) {
    case 'bass':
      return 3;
    case 'rhythm-guitar':
      return 4;
    case 'keys':
      return MELODIC.includes(fn) ? 11.5 : 5;
    case 'synth-pad':
      return 6;
    case 'strings':
      return fn === 'bass-line' ? 3.5 : MELODIC.includes(fn) ? 10.5 : 7;
    case 'synth-seq':
      return 8;
    case 'synth-arp':
      return 9;
    case 'vocal':
      return 10;
    case 'lead-guitar':
      return 11;
    case 'synth-lead':
      return 12;
    case 'percussion':
      return 14;
    default:
      return fn === 'bass-line' ? 3.5 : MELODIC.includes(fn) ? 13 : 7.5;
  }
}

export function runGenerator(c: Cell): GenOutput {
  const fn = c.fn;
  const inst = c.inst;
  if (inst.isDrumKit) return { notes: c.track.role === 'percussion' ? generatePercussion(c) : generateDrums(c) };
  switch (c.track.role) {
    case 'drums':
    case 'percussion':
      return { notes: generatePercussion(c) };
    case 'bass':
      return MELODIC.includes(fn) ? generateMelodicLine(c) : { notes: generateBass(c) };
    case 'rhythm-guitar':
      if (fn === 'bass-line') return { notes: generateBass(c) };
      return MELODIC.includes(fn) ? generateMelodicLine(c) : { notes: generateRhythmGuitar(c) };
    case 'lead-guitar':
      return fn === 'accompaniment' || fn === 'rhythm' ? { notes: generateRhythmGuitar(c) } : generateMelodicLine(c);
    case 'keys':
      if (fn === 'bass-line') return { notes: generateBass(c) };
      return MELODIC.includes(fn) ? generateMelodicLine(c) : { notes: generateChordal(c) };
    case 'strings':
    case 'synth-pad':
    case 'custom':
      if (fn === 'bass-line') return { notes: generateBass(c) };
      if (inst.polyphony === 'poly' && !MELODIC.includes(fn) && fn !== 'rhythm') return { notes: generateChordal(c) };
      return generateMelodicLine(c);
    case 'synth-arp':
      return { notes: generateArp(c) };
    case 'synth-seq':
      return { notes: generateSeq(c) };
    case 'synth-lead':
      return generateMelodicLine(c);
    case 'vocal':
      return generateVocal(c);
    default:
      return generateMelodicLine(c);
  }
}
