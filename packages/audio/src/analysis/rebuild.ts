/**
 * Rebuild mode (spec §25, §26): reconstruct an editable Song from a recording.
 *
 *   Audio → source separation → tempo/beats/meter/downbeats → key → chords → pitch
 *   transcription (vocals: mono, bass: mono, other: poly, drums) → instrument classification →
 *   MIDI reconstruction (quantisation + instrument-aware correction: range folding, bass/lead
 *   monophony, low-confidence key snapping, spurious-note removal, drum mapping) → structure →
 *   Song (tempo/meter/key maps, sections, chords, tracks, mixer) + a confidence report.
 *
 * Everything is deterministic for a given input and seed; stages yield to the event loop and
 * honour an AbortSignal (rejects with an Error named "AbortError").
 */
import {
  ENGINE_VERSION,
  IdFactory,
  PPQ,
  chordToRoman,
  createEmptySong,
  defaultChannelStrip,
  formatChordSymbol,
  isInScale,
  keyName,
  snapToScale,
  sortNotes,
  type ChordEvent,
  type KeySignature,
  type Note,
  type Section,
  type SectionKind,
  type Song,
  type StemGroup,
  type Track,
  type TrackRole,
} from '@songdeck/core';
import type { AudioData } from '../types';
import { chromagramFromSignal, type ChromaResult } from './chroma';
import { chordsFromChroma, type ChordSegment } from './chords';
import { classifyStem, type StemClassification } from './classify';
import { detectKey, type KeyResult } from './key';
import { onsetEnvelopeFromSignal, pickOnsetPeaks } from './onsets';
import { drumHitsToNotes, enforceMonophony, secondsToTicks, transcribedToNotes } from './quantize';
import { separateSources } from './separation';
import { segmentStructure, type StructureSegment } from './structure';
import { estimateMeter, extendBeatGrid, tempoFromEnvelope, type TempoInternals } from './tempo';
import { gridOrigin } from './transcribe';
import { transcribeDrums } from './transcribe-drums';
import { transcribeMonophonic } from './transcribe-mono';
import { transcribePolyphonicSignal } from './transcribe-poly';
import type { DrumHit, StemName, TranscribedNote } from './types';
import { abortError, analysisMono, audioFingerprint, clamp01, mean, prepareChannels, yieldToEventLoop } from './util';

export type RebuildStageId = 'separation' | 'tempo' | 'key' | 'chords' | 'pitch' | 'instruments' | 'midi' | 'structure';

export interface RebuildStage {
  id: RebuildStageId;
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  confidence: number;
  detail: string;
}

export interface RebuildReport {
  stages: RebuildStage[];
  overallConfidence: number;
  bpm: number;
  key: KeySignature;
  durationSeconds: number;
  warnings: string[];
  /** Per track id. */
  trackConfidence: Record<string, number>;
  /** Regions the UI should highlight as uncertain (spec §25). */
  lowConfidenceRegions: { trackId: string; startTick: number; endTick: number; confidence: number }[];
  /** Time in the source audio that corresponds to tick 0. */
  offsetSeconds: number;
  meter: { numerator: number; denominator: number };
  separationMethod: string;
}

export interface RebuildOptions {
  title?: string;
  onProgress?(stage: RebuildStageId, progress: number, stages: RebuildStage[]): void;
  signal?: AbortSignal;
  /** Optional provider override for source separation (e.g. a neural separator); stems at any rate. */
  separation?: (buf: AudioData) => Promise<{ drums: AudioData; bass: AudioData; vocals: AudioData; other: AudioData }>;
  /** Generation seed recorded in the song and used for ids (default 1). */
  seed?: number;
  /** Quantisation grid in beats (default 0.25 = sixteenths). */
  quantizeBeats?: number;
}

const STAGES: { id: RebuildStageId; label: string }[] = [
  { id: 'separation', label: 'Source separation' },
  { id: 'tempo', label: 'Tempo / beat detection' },
  { id: 'key', label: 'Key detection' },
  { id: 'chords', label: 'Chord analysis' },
  { id: 'pitch', label: 'Pitch transcription' },
  { id: 'instruments', label: 'Instrument classification' },
  { id: 'midi', label: 'MIDI reconstruction' },
  { id: 'structure', label: 'Song structure reconstruction' },
];

const OTHER_CANDIDATES = ['piano', 'electric-guitar-clean', 'electric-guitar-distorted', 'acoustic-guitar', 'synth-pad', 'string-ensemble', 'synth-lead'] as const;

const INSTRUMENT_INFO: Record<string, { name: string; stemGroup: StemGroup; range: [number, number]; color: string }> = {
  'drum-kit': { name: 'Drums', stemGroup: 'drums', range: [27, 87], color: '#e4572e' },
  'electric-bass': { name: 'Bass', stemGroup: 'bass', range: [28, 60], color: '#4c6ef5' },
  'lead-vocal': { name: 'Vocal Melody', stemGroup: 'vocals', range: [45, 84], color: '#f2c14e' },
  piano: { name: 'Piano', stemGroup: 'keys', range: [28, 100], color: '#2bb3a3' },
  'electric-guitar-clean': { name: 'Clean Guitar', stemGroup: 'guitars', range: [40, 88], color: '#9b5de5' },
  'electric-guitar-distorted': { name: 'Distorted Guitar', stemGroup: 'guitars', range: [40, 88], color: '#c0392b' },
  'acoustic-guitar': { name: 'Acoustic Guitar', stemGroup: 'guitars', range: [40, 84], color: '#b5838d' },
  'synth-pad': { name: 'Synth Pad', stemGroup: 'keys', range: [36, 96], color: '#43aa8b' },
  'string-ensemble': { name: 'Strings', stemGroup: 'strings', range: [28, 100], color: '#577590' },
  'synth-lead': { name: 'Synth Lead', stemGroup: 'keys', range: [48, 96], color: '#f8961e' },
};

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function sumStems(a: AudioData, ...rest: AudioData[]): Float32Array {
  const x = Float32Array.from(analysisMono(a));
  for (const r of rest) {
    const m = analysisMono(r);
    const n = Math.min(x.length, m.length);
    for (let i = 0; i < n; i++) x[i] += m[i];
  }
  return x;
}

function sectionName(kind: SectionKind, index: number, total: number): string {
  const base: Record<string, string> = {
    intro: 'Intro',
    verse: 'Verse',
    'pre-chorus': 'Pre-Chorus',
    chorus: 'Chorus',
    'post-chorus': 'Post-Chorus',
    bridge: 'Bridge',
    breakdown: 'Breakdown',
    build: 'Build',
    drop: 'Drop',
    solo: 'Solo',
    interlude: 'Interlude',
    'final-chorus': 'Final Chorus',
    outro: 'Outro',
    custom: 'Section',
  };
  const b = base[kind] ?? 'Section';
  return total > 1 || kind === 'verse' || kind === 'chorus' || kind === 'pre-chorus' ? `${b} ${index}` : b;
}

function medianOf(v: number[]): number {
  if (!v.length) return 0;
  const a = [...v].sort((x, y) => x - y);
  return a[a.length >> 1];
}

/**
 * Kick drums leak into a low-pass bass stem as short low "notes" just after each kick, cutting
 * the real bass note into pieces: drop such notes and stitch the real note back together
 * (starting with the kick).
 */
export function removeKickBleed(notes: TranscribedNote[], kicks: number[], bassOnsets: number[] = []): TranscribedNote[] {
  if (!kicks.length || notes.length < 3) return notes;
  const medPitch = medianOf(notes.map((n) => n.pitch));
  const medConf = medianOf(notes.map((n) => n.confidence));
  const sorted = [...notes].sort((a, b) => a.startSeconds - b.startSeconds).map((n) => ({ ...n }));
  // a kick under a new bass note can make the pitch tracker lock an octave low
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    if (!kicks.some((k) => Math.abs(k - n.startSeconds) < 0.06)) continue;
    const neigh = [sorted[i - 1]?.pitch, sorted[i + 1]?.pitch].filter((p): p is number => p !== undefined);
    if (neigh.length && neigh.some((p) => p === n.pitch + 12) && n.pitch < medPitch - 6) n.pitch += 12;
  }
  const kickFor = (t: number): number | undefined => {
    let best: number | undefined;
    for (const k of kicks) if (t >= k - 0.05 && t <= k + 0.25 && (best === undefined || k > best)) best = k;
    return best;
  };
  const out: TranscribedNote[] = [];
  let i = 0;
  while (i < sorted.length) {
    const n = sorted[i];
    const k = kickFor(n.startSeconds);
    const isBleed = (m: TranscribedNote): boolean => m.endSeconds - m.startSeconds < 0.3 && (m.pitch < medPitch - 5 || m.confidence < medConf * 0.8);
    if (k === undefined || !isBleed(n)) {
      out.push(n);
      i++;
      continue;
    }
    // a run of bleed notes after this kick
    let j = i;
    while (j < sorted.length && kickFor(sorted[j].startSeconds) === k && isBleed(sorted[j])) j++;
    const runEnd = sorted[j - 1].endSeconds;
    const next = sorted[j];
    const prev = out[out.length - 1];
    if (next && next.startSeconds - runEnd < 0.08) {
      if (prev && prev.endSeconds > k) prev.endSeconds = Math.max(prev.startSeconds + 0.02, k);
      const ownAttack = next.startSeconds - k > 0.12 && bassOnsets.some((o) => Math.abs(o - next.startSeconds) < 0.04);
      if (ownAttack) {
        // the next note has its own attack: the bleed hid a separate (repeated) note on the kick
        out.push({ ...next, startSeconds: Math.max(prev ? prev.endSeconds : 0, k), endSeconds: next.startSeconds - 0.01, confidence: Math.round(next.confidence * 0.7 * 1000) / 1000 });
      } else {
        // the real note started with the kick and simply continues
        next.startSeconds = Math.max(prev ? prev.endSeconds : 0, Math.min(next.startSeconds, k));
      }
    }
    i = j;
  }
  return out;
}

function overlap(a: TranscribedNote, b: TranscribedNote): number {
  return Math.max(0, Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds));
}

/**
 * Drop melody notes that merely duplicate a simultaneous bass note (bleed of the bass into the
 * vocal stem): unisons always, octave doublings only when not confident. Melody notes that the
 * bleed had split into fragments are joined again.
 */
export function removeDoubling(notes: TranscribedNote[], ref: TranscribedNote[], octaveToo: boolean): TranscribedNote[] {
  if (!ref.length || !notes.length) return notes;
  const medConf = medianOf(notes.map((n) => n.confidence));
  const removed: TranscribedNote[] = [];
  const kept = notes.filter((n) => {
    const d = n.endSeconds - n.startSeconds;
    // unison, or an octave below (sub-harmonic tracking of the leaking bass): bleed
    const unison = ref.some((r) => (r.pitch === n.pitch || r.pitch === n.pitch + 12) && overlap(r, n) >= 0.6 * d);
    const octave = octaveToo && n.confidence <= medConf && ref.some((r) => r.pitch + 12 === n.pitch && overlap(r, n) >= 0.5 * d);
    if (unison || octave) removed.push(n);
    return !(unison || octave);
  });
  if (!removed.length) return kept;
  const out: TranscribedNote[] = [];
  for (const n of kept) {
    const prev = out[out.length - 1];
    const bridged =
      prev &&
      prev.pitch === n.pitch &&
      n.startSeconds - prev.endSeconds <= 0.3 &&
      removed.some((r) => r.startSeconds >= prev.endSeconds - 0.03 && r.endSeconds <= n.startSeconds + 0.03);
    if (bridged) {
      prev.endSeconds = n.endSeconds;
      prev.confidence = Math.max(prev.confidence, n.confidence);
      prev.velocity = Math.max(prev.velocity, n.velocity);
    } else out.push({ ...n });
  }
  return out;
}

/** Lower the confidence of accompaniment notes that duplicate the melody (likely bleed). */
export function penalizeDoubling(notes: TranscribedNote[], melody: TranscribedNote[]): TranscribedNote[] {
  if (!melody.length) return notes;
  return notes.map((n) => {
    const d = n.endSeconds - n.startSeconds;
    const dup = melody.some((m) => m.pitch === n.pitch && overlap(m, n) >= 0.6 * d);
    return dup ? { ...n, confidence: Math.round(n.confidence * 0.6 * 1000) / 1000 } : n;
  });
}

/** Rebuild an editable project from a recording. */
export async function rebuildProject(buf: AudioData, opts: RebuildOptions = {}): Promise<{ song: Song; report: RebuildReport }> {
  const stages: RebuildStage[] = STAGES.map((s) => ({ ...s, status: 'pending', confidence: 0, detail: '' }));
  const warnings: string[] = [];
  const seed = opts.seed ?? 1;
  const stage = (id: RebuildStageId): RebuildStage => stages.find((s) => s.id === id)!;
  const emit = (id: RebuildStageId, p: number): void => {
    try {
      opts.onProgress?.(id, clamp01(p), stages.map((s) => ({ ...s })));
    } catch {
      // progress listeners must not break the pipeline
    }
  };
  const checkAbort = (id?: RebuildStageId): void => {
    if (opts.signal?.aborted) {
      if (id) {
        const s = stage(id);
        if (s.status === 'running') {
          s.status = 'failed';
          s.detail = 'aborted';
        }
      }
      throw abortError('Rebuild aborted');
    }
  };
  const begin = async (id: RebuildStageId): Promise<void> => {
    await yieldToEventLoop();
    checkAbort();
    stage(id).status = 'running';
    emit(id, 0);
  };
  const finish = (id: RebuildStageId, confidence: number, detail: string, status: RebuildStage['status'] = 'done'): void => {
    const s = stage(id);
    s.status = status;
    s.confidence = round3(clamp01(confidence));
    s.detail = detail;
    emit(id, 1);
  };
  const fail = (id: RebuildStageId, err: unknown): void => {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${stage(id).label} failed (${msg}); continuing with fallbacks.`);
    finish(id, 0, `failed: ${msg}`, 'failed');
  };

  checkAbort();
  const work = prepareChannels(buf);
  const sr = work.sampleRate;
  const len = work.channels[0]?.length ?? 0;
  const duration = len / sr;
  if (!len || duration < 1) throw new Error('rebuildProject: audio is empty or shorter than one second');
  const mixMono = analysisMono(work);
  const stereo = work.channels.length >= 2;

  // ---- 1. separation ------------------------------------------------------------------------------
  await begin('separation');
  let stems: Record<StemName, AudioData>;
  let sepConf: Record<StemName, number> = { drums: 0.3, bass: 0.3, vocals: 0.2, other: 0.3 };
  let separationMethod = 'none';
  try {
    if (opts.separation) {
      const ext = await opts.separation(buf);
      checkAbort('separation');
      stems = { drums: prepareChannels(ext.drums), bass: prepareChannels(ext.bass), vocals: prepareChannels(ext.vocals), other: prepareChannels(ext.other) };
      sepConf = { drums: 0.7, bass: 0.7, vocals: 0.7, other: 0.6 };
      separationMethod = 'provider';
      finish('separation', 0.7, 'External separation provider (quality not verified by the engine).');
    } else {
      const sep = separateSources(work, { signal: opts.signal, onProgress: (p) => emit('separation', p * 0.98) });
      stems = sep.stems;
      sepConf = sep.confidence;
      separationMethod = sep.method;
      const c = mean(Object.values(sep.confidence));
      finish('separation', c, `${sep.method}${stereo ? '' : ' — mono input'}`);
      if (!stereo) warnings.push('Mono input: vocals cannot be separated by stereo position; the vocal melody may include other parts.');
      warnings.push('Built-in separation is DSP (HPSS + spectral masks), not a neural separator: expect bleed between stems.');
    }
  } catch (e) {
    fail('separation', e);
    const silent = (): AudioData => ({ sampleRate: sr, channels: work.channels.map((c) => new Float32Array(c.length)) });
    stems = { drums: work, bass: silent(), vocals: silent(), other: work };
    separationMethod = 'none (failed)';
  }

  // ---- 2. tempo -------------------------------------------------------------------------------------
  await begin('tempo');
  let tempo: TempoInternals;
  let chroma: ChromaResult;
  const harmonic = sumStems(stems.bass, stems.vocals, stems.other);
  try {
    chroma = chromagramFromSignal(harmonic, sr);
    emit('tempo', 0.4);
    const env = onsetEnvelopeFromSignal(mixMono, sr);
    tempo = tempoFromEnvelope(env, {
      bandProfileForBeats: (beats) => (i: number) => {
        const a = Math.max(0, Math.round(beats[i] / chroma.hopSeconds));
        const b = Math.min(chroma.frames.length, Math.max(a + 1, Math.round((beats[i + 1] ?? beats[i] + 0.5) / chroma.hopSeconds)));
        const v = new Float32Array(12);
        for (let t = a; t < b; t++) for (let k = 0; k < 12; k++) v[k] += Math.sqrt(chroma.frames[t][k]);
        return v;
      },
    });
    if (tempo.beats.length < 4) throw new Error('no regular beat found');
    const reg = tempo.confidence;
    finish('tempo', tempo.confidence * 0.7 + tempo.meterConfidence * 0.3, `${tempo.bpm} BPM, ${tempo.meter.numerator}/${tempo.meter.denominator} (meter ${Math.round(tempo.meterConfidence * 100)}%)`);
    if (reg < 0.35) warnings.push(`Tempo detection is uncertain (${Math.round(reg * 100)}%): bars and quantisation may be off; adjust the tempo and re-run if needed.`);
    if (tempo.meterConfidence < 0.35) warnings.push(`Meter is uncertain; assumed ${tempo.meter.numerator}/${tempo.meter.denominator}.`);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    chroma ??= chromagramFromSignal(harmonic, sr);
    const beats = extendBeatGrid([], 120, duration);
    tempo = { bpm: 120, confidence: 0, beats, downbeats: beats.filter((_, i) => i % 4 === 0), meter: { numerator: 4, denominator: 4 }, meterConfidence: 0, accents: [], downbeatPhase: 0, periodicity: 0 };
    warnings.push('No steady beat was found; a 120 BPM grid was assumed (free-tempo or ambient material).');
    finish('tempo', 0, 'fallback 120 BPM grid', 'failed');
  }
  const bpm = tempo.bpm;
  const meter = tempo.meter;
  const fullBeats = extendBeatGrid(tempo.beats, bpm, duration);

  // ---- 3. key -------------------------------------------------------------------------------------------
  await begin('key');
  let keyRes: KeyResult;
  try {
    keyRes = detectKey({ frames: chroma.frames, bassFrames: chroma.bassFrames });
    finish('key', keyRes.confidence, `${keyName(keyRes.key)}${keyRes.alternatives[0] ? ` (alt. ${keyName(keyRes.alternatives[0].key)})` : ''}`);
    if (keyRes.confidence === 0) warnings.push('No tonal content was found; the key defaults to C major.');
    else if (keyRes.confidence < 0.35 && keyRes.alternatives[0]) warnings.push(`Key is ambiguous between ${keyName(keyRes.key)} and ${keyName(keyRes.alternatives[0].key)}.`);
  } catch (e) {
    fail('key', e);
    keyRes = { key: { tonic: 0, mode: 'major' }, confidence: 0, alternatives: [] };
  }
  const key = keyRes.key;

  // ---- 4. chords ------------------------------------------------------------------------------------------
  await begin('chords');
  let chordSegs: ChordSegment[] = [];
  try {
    chordSegs = chordsFromChroma(chroma, { beats: fullBeats, key }).segments;
    // chord changes usually fall on bar lines: refine the downbeat phase with them
    if (tempo.beats.length >= 8 && chordSegs.length >= 3) {
      const m = meter.numerator;
      const nearestBeat = (t: number): number => {
        let bi = 0;
        let bd = Infinity;
        tempo.beats.forEach((b, i) => {
          const d = Math.abs(b - t);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        });
        return bd < 0.2 ? bi : -1;
      };
      const changes = new Array<number>(tempo.beats.length).fill(0);
      for (const c of chordSegs.slice(1)) {
        const bi = nearestBeat(c.start);
        if (bi >= 0) changes[bi] += 1;
      }
      const cm = mean(changes);
      const cs = Math.sqrt(mean(changes.map((v) => (v - cm) ** 2))) || 1;
      const acc = tempo.accents.map((a, i) => a + 1.2 * ((changes[i] - cm) / cs));
      const est = estimateMeter(acc, [m]);
      if (est.phase !== tempo.downbeatPhase) {
        tempo.downbeatPhase = est.phase;
        tempo.downbeats = tempo.beats.filter((_, i) => i >= est.phase && (i - est.phase) % m === 0);
      }
    }
    const conf = chordSegs.length ? mean(chordSegs.map((c) => c.confidence)) : 0;
    finish('chords', conf, `${chordSegs.length} chord segments, ${new Set(chordSegs.map((c) => c.symbol)).size} distinct chords`);
  } catch (e) {
    fail('chords', e);
  }

  // ---- 5. pitch -----------------------------------------------------------------------------------------------
  await begin('pitch');
  let vocalNotes: TranscribedNote[] = [];
  let vocalVoiced = 0;
  let vocalConf = 0;
  let bassNotes: TranscribedNote[] = [];
  let bassConf = 0;
  let otherNotes: TranscribedNote[] = [];
  let otherConf = 0;
  let drumHits: DrumHit[] = [];
  let drumConf = 0;
  const pitchDetail: string[] = [];
  try {
    const v = transcribeMonophonic(stems.vocals, { minHz: 80, maxHz: 1100, voicingThreshold: 0.35, minNoteSeconds: 0.08, splitDipDb: 12 });
    // a lead vocal below G2 is almost certainly bass bleed tracked in the vocal stem
    vocalNotes = v.notes.filter((n) => n.pitch >= 43);
    vocalVoiced = v.voicedFraction;
    vocalConf = v.confidence;
    pitchDetail.push(`vocals ${v.notes.length}`);
    emit('pitch', 0.25);
    await yieldToEventLoop();
    checkAbort('pitch');
    const b = transcribeMonophonic(stems.bass, { minHz: 28, maxHz: 330, voicingThreshold: 0.35, minNoteSeconds: 0.06, splitDipDb: 8 });
    bassNotes = b.notes;
    bassConf = b.confidence;
    pitchDetail.push(`bass ${b.notes.length}`);
    emit('pitch', 0.45);
    await yieldToEventLoop();
    checkAbort('pitch');
    const o = transcribePolyphonicSignal(analysisMono(stems.other), sr, { minPitch: 36, maxPitch: 96, maxPolyphony: 5, signal: opts.signal });
    otherNotes = o.notes;
    otherConf = o.confidence;
    pitchDetail.push(`other ${o.notes.length}`);
    emit('pitch', 0.8);
    await yieldToEventLoop();
    checkAbort('pitch');
    const d = transcribeDrums(stems.drums, { skipHpss: separationMethod !== 'none (failed)' });
    drumHits = d.hits;
    drumConf = d.confidence;
    pitchDetail.push(`drum hits ${d.hits.length}`);
    const pc = mean([vocalConf * sepConf.vocals, bassConf * sepConf.bass, otherConf * sepConf.other, drumConf * sepConf.drums].map((v) => Math.sqrt(Math.max(0, v))));
    finish('pitch', pc, pitchDetail.join(', '));
  } catch (e) {
    fail('pitch', e);
  }

  // ---- 6. instruments -----------------------------------------------------------------------------------------
  await begin('instruments');
  let otherClass: StemClassification | undefined;
  try {
    otherClass = classifyStem(stems.other, { candidates: [...OTHER_CANDIDATES], maxSeconds: 40 });
    const vocalPresent = vocalVoiced >= 0.12 && vocalNotes.length >= 3;
    if (!vocalPresent) warnings.push('No clear lead vocal was found; the vocal melody track was omitted.');
    finish('instruments', otherClass.confidence, `other → ${otherClass.instrumentId} (${Math.round(otherClass.confidence * 100)}%), vocal ${vocalPresent ? 'present' : 'not detected'}`);
  } catch (e) {
    fail('instruments', e);
  }
  const otherInstrument = otherClass?.instrumentId ?? 'piano';

  // ---- 7. MIDI reconstruction ------------------------------------------------------------------------------------
  await begin('midi');
  const ids = new IdFactory(seed, `rebuild-${audioFingerprint(mixMono).toString(36)}`);
  const firstEvent = Math.min(vocalNotes[0]?.startSeconds ?? Infinity, bassNotes[0]?.startSeconds ?? Infinity, otherNotes[0]?.startSeconds ?? Infinity, drumHits[0]?.time ?? Infinity);
  const offset = gridOrigin({ bpm, downbeats: tempo.downbeats, meter }, Number.isFinite(firstEvent) ? firstEvent : 0);
  const ppq = PPQ;
  const barTicks = Math.round((ppq * 4 * meter.numerator) / meter.denominator);
  const q = opts.quantizeBeats ?? 0.25;
  const tracks: Track[] = [];
  const trackConfidence: Record<string, number> = {};
  const lowConfidenceRegions: RebuildReport['lowConfidenceRegions'] = [];
  const mixSettings = new Map<string, { pan: number; volumeDb: number }>();
  const correct = (notes: Note[], info: { range: [number, number]; mono: boolean; snapLowConfidence: boolean; maxPoly?: number }): Note[] => {
    let out = notes.filter((n) => !(n.duration < ppq / 8 && (n.confidence ?? 1) < 0.5));
    if (info.snapLowConfidence) {
      out = out.map((n) => {
        if ((n.confidence ?? 1) < 0.45 && !isInScale(n.pitch, key)) return { ...n, pitch: snapToScale(n.pitch, key), confidence: round3((n.confidence ?? 0) * 0.85) };
        return n;
      });
    }
    if (info.mono) out = enforceMonophony(out);
    if (info.maxPoly) {
      const byTick = new Map<number, Note[]>();
      for (const n of out) {
        const l = byTick.get(n.tick);
        if (l) l.push(n);
        else byTick.set(n.tick, [n]);
      }
      out = [];
      for (const l of byTick.values()) out.push(...l.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, info.maxPoly));
    }
    return sortNotes(out);
  };
  const addTrack = (spec: {
    key: string;
    instrumentId: string;
    role: TrackRole;
    notes: Note[];
    stemConfidence: number;
    channel: number;
    pan: number;
    volumeDb: number;
    fn: Track['constraints']['function'];
    vocal?: boolean;
    name?: string;
  }): void => {
    const info = INSTRUMENT_INFO[spec.instrumentId] ?? INSTRUMENT_INFO.piano;
    const id = ids.next(`trk-${spec.key}`);
    const notes = spec.notes;
    const noteConf = notes.length ? mean(notes.map((n) => n.confidence ?? 0)) : 0;
    const conf = round3(Math.sqrt(noteConf * clamp01(spec.stemConfidence / 0.7)));
    // the IR notes carry the combined confidence (transcription × separation reliability)
    const scale = clamp01(0.55 + 0.45 * clamp01(spec.stemConfidence / 0.6));
    for (const n of notes) n.confidence = round3((n.confidence ?? 0) * scale);
    const track: Track = {
      id,
      name: spec.name ?? info.name,
      kind: 'midi',
      role: spec.role,
      instrumentId: spec.instrumentId,
      constraints: { lowest: info.range[0], highest: info.range[1], function: spec.fn },
      notes,
      clips: [],
      color: info.color,
      stemGroup: info.stemGroup,
      midiChannel: spec.channel,
      generator: { id: 'rebuild', seed, params: { stem: spec.key, separation: separationMethod } },
      ...(spec.vocal ? { vocal: { mode: 'melody-only' as const } } : {}),
    };
    tracks.push(track);
    trackConfidence[id] = conf;
    mixSettings.set(id, { pan: spec.pan, volumeDb: spec.volumeDb });
    // low-confidence regions per bar
    if (notes.length) {
      const lastTick = Math.max(...notes.map((n) => n.tick + n.duration));
      const bars = Math.ceil(lastTick / barTicks);
      let open: { start: number; end: number; confs: number[] } | null = null;
      const flush = (): void => {
        if (open) lowConfidenceRegions.push({ trackId: id, startTick: open.start, endTick: open.end, confidence: round3(mean(open.confs)) });
        open = null;
      };
      for (let b = 0; b < bars; b++) {
        const a = b * barTicks;
        const e = a + barTicks;
        const inBar = notes.filter((n) => n.tick >= a && n.tick < e);
        if (!inBar.length) {
          flush();
          continue;
        }
        const c = mean(inBar.map((n) => n.confidence ?? 0));
        if (c < 0.5) {
          if (open) {
            open.end = e;
            open.confs.push(c);
          } else open = { start: a, end: e, confs: [c] };
        } else flush();
      }
      flush();
    }
  };
  // instrument-aware cross-stem corrections (seconds domain)
  const kicks = drumHits.filter((h) => h.drum === 36 || h.drum === 35).map((h) => h.time);
  const bassEnv = onsetEnvelopeFromSignal(analysisMono(stems.bass), sr);
  const bassOnsets = pickOnsetPeaks(bassEnv.envelope, bassEnv.hopSeconds, { delta: 0.05, floor: 0.03 }).map((f) => f * bassEnv.hopSeconds);
  bassNotes = removeKickBleed(bassNotes, kicks, bassOnsets);
  vocalNotes = removeDoubling(vocalNotes, bassNotes, true);
  otherNotes = penalizeDoubling(otherNotes, vocalNotes);
  try {
    const toNotes = (src: TranscribedNote[], prefix: string, range: [number, number]): Note[] =>
      transcribedToNotes(src, { bpm, quantizeBeats: q, offsetSeconds: offset, idPrefix: prefix, seed, lowest: range[0], highest: range[1], key });
    if (drumHits.length >= 4) {
      addTrack({
        key: 'drums',
        instrumentId: 'drum-kit',
        role: 'drums',
        notes: drumHitsToNotes(drumHits, { bpm, quantizeBeats: q, offsetSeconds: offset, idPrefix: 'dn', seed }),
        stemConfidence: sepConf.drums,
        channel: 9,
        pan: 0,
        volumeDb: -4,
        fn: 'rhythm',
      });
    } else warnings.push('No drum part was detected.');
    if (bassNotes.length >= 3) {
      addTrack({
        key: 'bass',
        instrumentId: 'electric-bass',
        role: 'bass',
        notes: correct(toNotes(bassNotes, 'bn', INSTRUMENT_INFO['electric-bass'].range), { range: INSTRUMENT_INFO['electric-bass'].range, mono: true, snapLowConfidence: true }),
        stemConfidence: sepConf.bass,
        channel: 0,
        pan: 0,
        volumeDb: -5,
        fn: 'bass-line',
      });
    } else warnings.push('No bass line was detected.');
    if (vocalVoiced >= 0.12 && vocalNotes.length >= 3) {
      addTrack({
        key: 'vocals',
        instrumentId: 'lead-vocal',
        role: 'vocal',
        notes: correct(toNotes(vocalNotes, 'vn', INSTRUMENT_INFO['lead-vocal'].range), { range: INSTRUMENT_INFO['lead-vocal'].range, mono: true, snapLowConfidence: true }),
        stemConfidence: sepConf.vocals,
        channel: 1,
        pan: 0,
        volumeDb: -3,
        fn: 'melody',
        vocal: true,
      });
    }
    if (otherNotes.length >= 3) {
      const info = INSTRUMENT_INFO[otherInstrument];
      addTrack({
        key: 'other',
        instrumentId: otherInstrument,
        role: otherClass?.role ?? 'keys',
        notes: correct(toNotes(otherNotes, 'on', info.range), { range: info.range, mono: otherInstrument === 'synth-lead', snapLowConfidence: true, maxPoly: 6 }),
        stemConfidence: sepConf.other * (otherClass ? 0.6 + 0.4 * otherClass.confidence : 0.6),
        channel: 2,
        pan: stereo ? 0.2 : 0,
        volumeDb: -8,
        fn: otherInstrument === 'synth-pad' || otherInstrument === 'string-ensemble' ? 'pad' : 'accompaniment',
      });
    } else warnings.push('No accompaniment (other) part was detected.');
    const allNotes = tracks.flatMap((t) => t.notes);
    finish('midi', allNotes.length ? mean(allNotes.map((n) => n.confidence ?? 0)) : 0, `${tracks.length} tracks, ${allNotes.length} notes, grid ${q > 0 ? `1/${Math.round(4 / q)}` : 'off'}, tick 0 = ${offset.toFixed(3)} s`);
  } catch (e) {
    fail('midi', e);
  }

  // ---- 8. structure --------------------------------------------------------------------------------------------------
  await begin('structure');
  const totalTicksAudio = Math.max(0, Math.round(secondsToTicks(duration - offset, bpm, ppq)));
  const lastNoteTick = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.tick + n.duration)));
  const totalBars = Math.max(1, Math.ceil(Math.max(totalTicksAudio, lastNoteTick) / barTicks));
  let sections: Section[] = [];
  let structSegs: StructureSegment[] = [];
  try {
    structSegs = segmentStructure(work, { beats: tempo.beats, downbeats: tempo.downbeats, bpm, beatsPerBar: meter.numerator, chroma, signal: opts.signal }).segments;
    const barSec = (60 / bpm) * meter.numerator;
    const starts = structSegs.map((s) => Math.max(0, Math.round((s.startSeconds - offset) / barSec)));
    // contiguous sections from bar 0 covering the whole song
    const pieces: { start: number; seg: StructureSegment }[] = [];
    structSegs.forEach((s, i) => {
      const st = i === 0 ? 0 : starts[i];
      if (pieces.length && st <= pieces[pieces.length - 1].start) return;
      if (st >= totalBars) return;
      pieces.push({ start: st, seg: s });
    });
    if (!pieces.length && structSegs[0]) pieces.push({ start: 0, seg: structSegs[0] });
    const counters = new Map<SectionKind, number>();
    const totals = new Map<SectionKind, number>();
    pieces.forEach((p) => totals.set(p.seg.kind, (totals.get(p.seg.kind) ?? 0) + 1));
    const firstOfLabel = new Map<string, string>();
    sections = pieces.map((p, i) => {
      const end = i + 1 < pieces.length ? pieces[i + 1].start : totalBars;
      const n = (counters.get(p.seg.kind) ?? 0) + 1;
      counters.set(p.seg.kind, n);
      const id = ids.next('sec');
      const sec: Section = {
        id,
        name: sectionName(p.seg.kind, n, totals.get(p.seg.kind) ?? 1),
        kind: p.seg.kind,
        bars: Math.max(1, end - p.start),
        energy: Math.round(30 + 65 * p.seg.energy),
        purpose: `Detected section ${p.seg.label} (${Math.round(p.seg.confidence * 100)}% confidence)`,
      };
      const first = firstOfLabel.get(p.seg.label);
      if (first) sec.repeatOf = first;
      else firstOfLabel.set(p.seg.label, id);
      return sec;
    });
    const conf = structSegs.length ? mean(structSegs.map((s) => s.confidence)) : 0;
    finish('structure', conf * (tempo.confidence > 0 ? 1 : 0.5), sections.map((s) => `${s.name} (${s.bars})`).join(', '));
  } catch (e) {
    fail('structure', e);
  }
  if (!sections.length) sections = [{ id: ids.next('sec'), name: 'Section 1', kind: 'verse', bars: totalBars, energy: 60 }];
  // make sure sections cover every note
  const sectionBars = sections.reduce((a, s) => a + s.bars, 0);
  if (sectionBars < totalBars) sections[sections.length - 1].bars += totalBars - sectionBars;

  // ---- Song assembly ------------------------------------------------------------------------------------------------
  const song = createEmptySong({
    title: opts.title ?? 'Rebuilt Song',
    bpm,
    meter: { numerator: meter.numerator, denominator: meter.denominator },
    key,
    seed,
    id: ids.next('song'),
  });
  song.generation = { seed, variation: 0, engineVersion: ENGINE_VERSION };
  song.sections = sections;
  song.tracks = tracks;
  for (const t of tracks) {
    const m = mixSettings.get(t.id) ?? { pan: 0, volumeDb: -6 };
    song.mixer.channels[t.id] = defaultChannelStrip({ ...m, reverbSend: t.role === 'vocal' ? 0.25 : t.role === 'drums' || t.role === 'bass' ? 0.05 : 0.2 });
  }
  // chords on a half-beat grid, clipped to the song, without overlaps
  const songEndTick = song.sections.reduce((a, s) => a + s.bars, 0) * barTicks;
  const half = ppq / 2;
  const chordEvents: ChordEvent[] = [];
  for (const c of chordSegs) {
    const tick = Math.max(0, Math.round(secondsToTicks(c.start - offset, bpm, ppq) / half) * half);
    const end = Math.min(songEndTick, Math.max(tick + half, Math.round(secondsToTicks(c.end - offset, bpm, ppq) / half) * half));
    if (end <= tick || tick >= songEndTick) continue;
    const spec = { root: c.root, quality: c.quality };
    const prev = chordEvents[chordEvents.length - 1];
    if (prev && tick <= prev.tick) continue;
    if (prev && prev.root === spec.root && prev.quality === spec.quality && prev.tick + prev.duration >= tick) {
      prev.duration = Math.max(prev.duration, end - prev.tick);
      continue;
    }
    if (prev && prev.tick + prev.duration > tick) prev.duration = tick - prev.tick;
    chordEvents.push({ id: ids.next('ch'), tick, duration: end - tick, root: spec.root, quality: spec.quality, symbol: formatChordSymbol(spec, key), roman: chordToRoman(spec, key) });
  }
  song.chords = chordEvents;

  // ---- report --------------------------------------------------------------------------------------------------------
  const weights: Record<RebuildStageId, number> = { separation: 1, tempo: 1.5, key: 1, chords: 1, pitch: 1.5, instruments: 0.5, midi: 1.5, structure: 0.7 };
  let wsum = 0;
  let csum = 0;
  for (const s of stages) {
    const w = weights[s.id];
    wsum += w;
    csum += w * (s.status === 'done' ? s.confidence : 0);
  }
  const overall = round3(wsum > 0 ? csum / wsum : 0);
  const report: RebuildReport = {
    stages: stages.map((s) => ({ ...s })),
    overallConfidence: overall,
    bpm,
    key,
    durationSeconds: round3(duration),
    warnings,
    trackConfidence,
    lowConfidenceRegions,
    offsetSeconds: round3(offset),
    meter: { ...meter },
    separationMethod,
  };
  return { song, report };
}
