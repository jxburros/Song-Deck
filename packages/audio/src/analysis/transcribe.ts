/**
 * Transcribe mode (spec §25 / §27): one entry point that picks the right transcription path for
 * the source (monophonic voice/bass, polyphonic guitar/piano, drums, auto-classified isolated
 * stems, or separated full mixes), estimates tempo/key when not given, and returns quantised
 * IR notes with per-note confidence plus honest warnings.
 */
import { keyName, type KeySignature, type Note, type TrackRole } from '@songdeck/core';
import type { AudioData } from '../types';
import { classifyStem, type StemInstrumentId } from './classify';
import { keyFromNotes, detectKey } from './key';
import { drumHitsToNotes, enforceMonophony, transcribedToNotes } from './quantize';
import { separateSources } from './separation';
import { detectTempo, type TempoResult } from './tempo';
import { transcribeDrums } from './transcribe-drums';
import { transcribeMonophonic } from './transcribe-mono';
import { transcribePolyphonic } from './transcribe-poly';
import type { DrumHit, TranscribedNote } from './types';
import { clamp01, prepareChannels, throwIfAborted } from './util';

export type TranscriptionSource = 'humming' | 'singing' | 'guitar' | 'bass' | 'piano' | 'drums' | 'isolated' | 'full-mix';

export interface TranscribeAudioOptions {
  source: TranscriptionSource;
  /** Known tempo (e.g. recorded against the app's metronome); detected when omitted. */
  bpm?: number;
  key?: KeySignature;
  /** Grid in beats (0.25 = 16ths, 0 = none). Default 0.25. */
  quantizeBeats?: number;
  quantizeStrength?: number;
  snapToKey?: boolean;
  /**
   * Audio time (s) that becomes tick 0. Default: 0 when `bpm` is given (metronome take),
   * otherwise the detected bar grid (first downbeat, with a pickup bar if needed).
   */
  offsetSeconds?: number;
  seed?: number;
  signal?: AbortSignal;
}

export interface TranscribeAudioResult {
  notes: Note[];
  drumHits?: DrumHit[];
  bpm: number;
  bpmConfidence: number;
  key: KeySignature;
  keyConfidence: number;
  confidence: number;
  method: string;
  suggestedInstrumentId: string;
  suggestedRole: TrackRole;
  warnings: string[];
  /** Audio time of tick 0. */
  offsetSeconds: number;
  /** Raw (unquantised) notes in seconds. */
  transcribed: TranscribedNote[];
}

const RANGES: Record<string, [number, number]> = {
  'lead-vocal': [40, 88],
  'electric-bass': [23, 67],
  piano: [21, 108],
  'electric-guitar-clean': [40, 88],
  'electric-guitar-distorted': [40, 88],
  'acoustic-guitar': [40, 84],
  'synth-lead': [36, 100],
  'synth-pad': [24, 100],
  'string-ensemble': [28, 100],
};

type Path = 'mono-voice' | 'mono-bass' | 'poly' | 'drums';

function pathForInstrument(id: StemInstrumentId): Path {
  if (id === 'drum-kit') return 'drums';
  if (id === 'electric-bass') return 'mono-bass';
  if (id === 'lead-vocal' || id === 'synth-lead') return 'mono-voice';
  return 'poly';
}

/** Bar-grid origin: first downbeat folded back to the start, minus a pickup bar when events precede it. */
export function gridOrigin(tempo: Pick<TempoResult, 'bpm' | 'downbeats' | 'meter'>, firstEventSeconds: number): number {
  const barSec = (60 / tempo.bpm) * tempo.meter.numerator;
  if (!tempo.downbeats.length || !(barSec > 0)) return 0;
  let origin = tempo.downbeats[0] - Math.floor(tempo.downbeats[0] / barSec + 1e-6) * barSec;
  if (firstEventSeconds < origin - 0.06) origin -= barSec;
  return origin;
}

export async function transcribeAudio(buf: AudioData, opts: TranscribeAudioOptions): Promise<TranscribeAudioResult> {
  throwIfAborted(opts.signal);
  const warnings: string[] = [];
  const work = prepareChannels(buf);
  let path: Path;
  let instrumentId: string;
  let role: TrackRole;
  let method: string;
  switch (opts.source) {
    case 'humming':
    case 'singing':
      path = 'mono-voice';
      instrumentId = 'lead-vocal';
      role = 'vocal';
      method = 'yin + hmm note segmentation';
      break;
    case 'bass':
      path = 'mono-bass';
      instrumentId = 'electric-bass';
      role = 'bass';
      method = 'yin + hmm note segmentation (bass range)';
      break;
    case 'guitar':
      path = 'poly';
      instrumentId = 'electric-guitar-clean';
      role = 'rhythm-guitar';
      method = 'harmonic-sum salience + iterative cancellation';
      break;
    case 'piano':
      path = 'poly';
      instrumentId = 'piano';
      role = 'keys';
      method = 'harmonic-sum salience + iterative cancellation';
      break;
    case 'drums':
      path = 'drums';
      instrumentId = 'drum-kit';
      role = 'drums';
      method = 'percussive onsets + constrained NMF drum templates';
      break;
    case 'isolated': {
      const c = classifyStem(work);
      path = pathForInstrument(c.instrumentId);
      instrumentId = c.instrumentId;
      role = c.role;
      method = `classified as ${c.instrumentId} (${Math.round(c.confidence * 100)}%) → ${path}`;
      if (c.confidence < 0.4) warnings.push(`Instrument classification is uncertain (${c.instrumentId}, ${Math.round(c.confidence * 100)}%).`);
      break;
    }
    case 'full-mix':
    default:
      path = 'mono-voice';
      instrumentId = 'lead-vocal';
      role = 'vocal';
      method = 'built-in separation → lead melody (vocal stem) + drums';
      warnings.push('Full-mix transcription returns the lead melody and drum hits only; use Rebuild to reconstruct every part.');
      break;
  }
  throwIfAborted(opts.signal);

  // ---- transcription ---------------------------------------------------------------------------
  let transcribed: TranscribedNote[] = [];
  let drumHits: DrumHit[] | undefined;
  let confidence = 0;
  let melodySource = work;
  if (opts.source === 'full-mix') {
    const sep = separateSources(work, { signal: opts.signal });
    melodySource = sep.stems.vocals;
    const d = transcribeDrums(sep.stems.drums, { skipHpss: true });
    drumHits = d.hits;
    if (work.channels.length < 2) warnings.push('Mono input: the melody stem relies on pitch-fluctuation cues only and may contain accompaniment.');
    confidence = sep.confidence.vocals;
  }
  throwIfAborted(opts.signal);
  if (path === 'mono-voice' || path === 'mono-bass') {
    const bass = path === 'mono-bass';
    const r = transcribeMonophonic(melodySource, {
      minHz: bass ? 28 : 70,
      maxHz: bass ? 420 : 1100,
      voicingThreshold: opts.source === 'singing' || opts.source === 'full-mix' ? 0.4 : 0.35,
      minNoteSeconds: bass ? 0.06 : 0.07,
    });
    transcribed = r.notes;
    confidence = opts.source === 'full-mix' ? Math.sqrt(confidence * r.confidence) : r.confidence;
    if (r.voicedFraction < 0.1) warnings.push('Very little pitched sound was found; is the recording silent or noisy?');
    if (Math.abs(r.tuningCents) >= 25) warnings.push(`The performance is ${r.tuningCents > 0 ? 'sharp' : 'flat'} by about ${Math.abs(r.tuningCents)} cents; notes were rounded relative to that tuning.`);
  } else if (path === 'poly') {
    const range = RANGES[instrumentId] ?? [36, 96];
    const r = transcribePolyphonic(work, { minPitch: Math.max(28, range[0]), maxPitch: Math.min(100, range[1]), maxPolyphony: instrumentId === 'piano' ? 8 : 6, signal: opts.signal });
    transcribed = r.notes;
    confidence = r.confidence;
    warnings.push('Polyphonic transcription is approximate: octave doublings and dense voicings may be missed.');
  } else {
    const r = transcribeDrums(work);
    drumHits = r.hits;
    confidence = r.confidence;
  }
  throwIfAborted(opts.signal);

  // ---- tempo -------------------------------------------------------------------------------------
  let bpm = opts.bpm ?? 0;
  let bpmConfidence = opts.bpm ? 1 : 0;
  let offset = opts.offsetSeconds ?? 0;
  if (!opts.bpm) {
    const tempo = detectTempo(work);
    bpm = tempo.beats.length >= 4 ? tempo.bpm : 120;
    bpmConfidence = tempo.beats.length >= 4 ? tempo.confidence : 0;
    if (bpmConfidence < 0.35) warnings.push(`Tempo is uncertain (${Math.round(bpm)} BPM, ${Math.round(bpmConfidence * 100)}%): set the tempo or record with the metronome for a reliable grid.`);
    const firstEvent = Math.min(transcribed[0]?.startSeconds ?? Infinity, drumHits?.[0]?.time ?? Infinity);
    if (opts.offsetSeconds === undefined) offset = Number.isFinite(firstEvent) && bpmConfidence >= 0.35 ? gridOrigin(tempo, firstEvent) : Number.isFinite(firstEvent) ? firstEvent : 0;
  }

  // ---- key ---------------------------------------------------------------------------------------
  let key: KeySignature = opts.key ?? { tonic: 0, mode: 'major' };
  let keyConfidence = opts.key ? 1 : 0;
  if (!opts.key && path !== 'drums') {
    const k = path === 'poly' ? detectKey(work) : keyFromNotes(transcribed.map((n) => ({ pitch: n.pitch, duration: n.endSeconds - n.startSeconds, velocity: n.velocity })));
    key = k.key;
    keyConfidence = k.confidence;
    if (keyConfidence > 0 && keyConfidence < 0.35 && k.alternatives[0]) warnings.push(`Key is ambiguous: ${keyName(k.key)} or ${keyName(k.alternatives[0].key)}.`);
  }

  // ---- IR notes ----------------------------------------------------------------------------------
  const quantizeBeats = opts.quantizeBeats ?? 0.25;
  let notes: Note[] = [];
  if (drumHits && path === 'drums') {
    notes = drumHitsToNotes(drumHits, { bpm, quantizeBeats, quantizeStrength: opts.quantizeStrength, offsetSeconds: offset, seed: opts.seed });
  } else {
    const range = RANGES[instrumentId];
    notes = transcribedToNotes(transcribed, {
      bpm,
      quantizeBeats,
      quantizeStrength: opts.quantizeStrength,
      offsetSeconds: offset,
      key,
      snapToKey: opts.snapToKey,
      seed: opts.seed,
      lowest: range?.[0],
      highest: range?.[1],
    });
    if (path === 'mono-voice' || path === 'mono-bass') notes = enforceMonophony(notes);
  }
  if (!notes.length) warnings.push('No notes were found.');
  const tempoFactor = opts.bpm ? 1 : 0.75 + 0.25 * bpmConfidence;
  return {
    notes,
    drumHits,
    bpm: Math.round(bpm * 100) / 100,
    bpmConfidence: Math.round(bpmConfidence * 1000) / 1000,
    key,
    keyConfidence: Math.round(keyConfidence * 1000) / 1000,
    confidence: Math.round(clamp01(confidence * (quantizeBeats > 0 ? tempoFactor : 1)) * 1000) / 1000,
    method,
    suggestedInstrumentId: instrumentId,
    suggestedRole: role,
    warnings,
    offsetSeconds: Math.round(offset * 1e4) / 1e4,
    transcribed,
  };
}

