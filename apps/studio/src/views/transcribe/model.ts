import {
  createEmptySong,
  PPQ,
  randomId,
  timedSyllables,
  type KeySignature,
  type Note,
  type TimedLyricPhrase,
  type TrackRole,
} from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import type { RunProvenance } from '@songdeck/ai';
import type { PendingAttestation } from '../../engine/rights';
import type { TranscribeSource } from '../../engine/handlers/analysis';

/** View model shared by the Transcribe panels. */

export type CaptureOrigin = 'upload' | 'mic' | 'clap' | 'taps';

export interface Capture {
  id: string;
  name: string;
  origin: CaptureOrigin;
  /** Original bytes (uploads) or the encoded recording (MediaRecorder output). */
  bytes?: Uint8Array;
  mimeType?: string;
  audio?: AudioData;
  durationSeconds: number;
  /** Tap times in seconds from the first tap. */
  taps?: number[];
  /** Tempo of the count-in the take was recorded against. */
  countInBpm?: number;
  createdAt: string;
  /** Rights attestation of an uploaded file (uploads only; docs/RIGHTS.md). */
  attestation?: PendingAttestation;
}

export type TempoMode = 'detect' | 'project' | 'manual';
export type KeyMode = 'detect' | 'project';
export type GridChoice = 'off' | '1/8' | '1/16' | '1/8T';

export const GRID_BEATS: Record<GridChoice, number> = { off: 0, '1/8': 0.5, '1/16': 0.25, '1/8T': 1 / 3 };

export interface TranscribeOptions {
  /** Transcription provider: 'auto' | 'internal' | provider id (spec §49, §59). */
  provider: string;
  source: TranscribeSource;
  tempoMode: TempoMode;
  manualBpm: number;
  grid: GridChoice;
  snapToKey: boolean;
  keyMode: KeyMode;
  /** Also transcribe the sung words and attach them to the notes. */
  lyrics?: boolean;
  /** Lyrics transcription provider: 'auto' | provider id. */
  lyricsProvider?: string;
  /** Language hint ("en"); empty = detect. */
  lyricsLanguage?: string;
}

/** Sung words recognised in the take (times on the recording's clock). */
export interface TranscribedLyricsView {
  phrases: TimedLyricPhrase[];
  text: string;
  language?: string;
  method: string;
  wordTimestamps: boolean;
  matchedWords: number;
  unmatchedWords: string[];
  provenance?: RunProvenance;
}

export interface TranscriptionView {
  notes: Note[];
  drums: boolean;
  ppq: number;
  bpm: number;
  bpmConfidence?: number;
  bpmSource: 'detected' | 'project' | 'manual' | 'count-in' | 'taps';
  key?: KeySignature;
  keyConfidence?: number;
  keySource: 'detected' | 'project' | 'none';
  meter: { numerator: number; denominator: number };
  confidence: number;
  method: string;
  warnings: string[];
  suggestedInstrumentId: string;
  role: TrackRole;
  bars: number;
  /** Audio time (s) of tick 0 / bar 1. */
  offsetSeconds: number;
  /** Raw detail kept for the analysis record. */
  raw?: unknown;
  /** Set when an orchestrated provider (not the on-device engine) transcribed the audio. */
  provenance?: RunProvenance;
  /** Lyrics transcription (syllables are already on `notes`). */
  lyrics?: TranscribedLyricsView;
}

export const SOURCES: { value: TranscribeSource; label: string; hint: string }[] = [
  { value: 'humming', label: 'Humming', hint: 'Monophonic pitch tracking tuned for breathy, soft voices.' },
  { value: 'singing', label: 'Singing', hint: 'Monophonic pitch tracking with vibrato tolerance.' },
  { value: 'guitar', label: 'Guitar', hint: 'Polyphonic — chords and single lines.' },
  { value: 'bass', label: 'Bass', hint: 'Monophonic, low register.' },
  { value: 'piano', label: 'Piano', hint: 'Polyphonic — chords, both hands.' },
  { value: 'drums', label: 'Drums', hint: 'Drum hits → kick / snare / hats / toms / cymbals.' },
  {
    value: 'isolated',
    label: 'Isolated instrument',
    hint: 'A single instrument recorded on its own — it is classified first.',
  },
  {
    value: 'full-mix',
    label: 'Full mix',
    hint: 'Whole song: the lead melody is extracted after separation — expect lower confidence; consider Rebuild.',
  },
];

export const DEFAULT_INSTRUMENT: Record<TranscribeSource, string> = {
  humming: 'lead-vocal',
  singing: 'lead-vocal',
  guitar: 'electric-guitar-clean',
  bass: 'electric-bass',
  piano: 'piano',
  drums: 'drum-kit',
  isolated: 'synth-lead',
  'full-mix': 'lead-vocal',
};

export const DEFAULT_ROLE: Record<TranscribeSource, TrackRole> = {
  humming: 'vocal',
  singing: 'vocal',
  guitar: 'rhythm-guitar',
  bass: 'bass',
  piano: 'keys',
  drums: 'drums',
  isolated: 'synth-lead',
  'full-mix': 'vocal',
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function pickKey(v: unknown): KeySignature | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const k = v as Record<string, unknown>;
  if (typeof k.tonic === 'number' && typeof k.mode === 'string')
    return { tonic: k.tonic, mode: k.mode as KeySignature['mode'] };
  if (k.key && typeof k.key === 'object') return pickKey(k.key);
  return undefined;
}

/** Seconds → ticks on a constant-tempo grid starting at `offset`. */
export function secondsToGridTick(seconds: number, bpm: number, offset: number, ppq = PPQ): number {
  return ((seconds - offset) * bpm * ppq) / 60;
}

function quantize(tick: number, gridTicks: number): number {
  return gridTicks > 0 ? Math.round(tick / gridTicks) * gridTicks : Math.round(tick);
}

/** Convert seconds-based notes / drum hits to IR notes (fallback when the job returned seconds). */
export function secondsNotesToTicks(
  items: { pitch: number; start: number; end: number; velocity: number; confidence?: number }[],
  o: {
    bpm: number;
    offset: number;
    gridBeats: number;
    ppq?: number;
    minDurationTicks?: number;
    origin: string;
  },
): Note[] {
  const ppq = o.ppq ?? PPQ;
  const grid = o.gridBeats > 0 ? Math.round(o.gridBeats * ppq) : 0;
  const out: Note[] = [];
  for (const it of items) {
    let tick = quantize(secondsToGridTick(it.start, o.bpm, o.offset, ppq), grid);
    let end = quantize(secondsToGridTick(it.end, o.bpm, o.offset, ppq), grid);
    if (tick < 0) tick = 0;
    if (end <= tick) end = tick + Math.max(1, grid || o.minDurationTicks || ppq / 4);
    out.push({
      id: randomId('n'),
      pitch: Math.max(0, Math.min(127, Math.round(it.pitch))),
      tick,
      duration: end - tick,
      velocity: Math.max(1, Math.min(127, Math.round(it.velocity))),
      confidence: it.confidence,
      origin: o.origin,
    });
  }
  return out.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}

function asIrNotes(list: unknown[], origin: string): Note[] | null {
  if (!list.length) return [];
  const first = list[0] as Record<string, unknown>;
  if (typeof first.tick === 'number' && typeof first.duration === 'number') {
    return (list as Note[]).map((n) => ({ ...n, id: n.id ?? randomId('n'), origin: n.origin ?? origin }));
  }
  return null;
}

/**
 * Normalise the transcription job's result into the view model. Tolerates IR notes (ticks),
 * seconds-based notes (`startSeconds`/`endSeconds`) and drum hits (`time`/`drum`).
 */
export function normalizeTranscription(
  raw: unknown,
  ctx: {
    source: TranscribeSource;
    requestedBpm?: number;
    bpmSource: TranscriptionView['bpmSource'];
    requestedKey?: KeySignature;
    gridBeats: number;
    durationSeconds: number;
    meter?: { numerator: number; denominator: number };
  },
): TranscriptionView {
  const r = (raw ?? {}) as Record<string, unknown>;
  const origin = `transcription:${ctx.source}`;
  const tempo = (r.tempo ?? {}) as Record<string, unknown>;
  const bpm = num(r.bpm) ?? num(tempo.bpm) ?? ctx.requestedBpm ?? 120;
  const bpmConfidence = num(r.bpmConfidence) ?? num(r.tempoConfidence) ?? num(tempo.confidence);
  const keyObj = r.key ?? r.keySignature;
  const key = pickKey(keyObj) ?? ctx.requestedKey;
  const keyConfidence =
    num(r.keyConfidence) ??
    (keyObj && typeof keyObj === 'object' ? num((keyObj as Record<string, unknown>).confidence) : undefined);
  const offset = num(r.offsetSeconds) ?? num(r.startOffsetSeconds) ?? num(r.downbeatSeconds) ?? 0;
  const meterRaw = (r.meter ?? {}) as Record<string, unknown>;
  const meter = {
    numerator: num(meterRaw.numerator) ?? ctx.meter?.numerator ?? 4,
    denominator: num(meterRaw.denominator) ?? ctx.meter?.denominator ?? 4,
  };
  const drums =
    ctx.source === 'drums' ||
    r.suggestedRole === 'drums' ||
    r.suggestedInstrumentId === 'drum-kit' ||
    Array.isArray(r.hits) ||
    r.kind === 'drums';

  let notes: Note[] = [];
  const list = Array.isArray(r.notes) ? (r.notes as unknown[]) : [];
  const ir = asIrNotes(list, origin);
  if (ir) notes = ir;
  else if (list.length) {
    notes = secondsNotesToTicks(
      (list as Record<string, number>[]).map((n) => ({
        pitch: n.pitch,
        start: n.startSeconds ?? n.start ?? n.time ?? 0,
        end: n.endSeconds ?? n.end ?? (n.startSeconds ?? n.start ?? 0) + 0.1,
        velocity: n.velocity ?? 96,
        confidence: n.confidence,
      })),
      { bpm, offset, gridBeats: ctx.gridBeats, origin },
    );
  }
  if (!notes.length && Array.isArray(r.hits)) {
    notes = secondsNotesToTicks(
      (r.hits as Record<string, number>[]).map((h) => ({
        pitch: h.drum ?? h.pitch ?? 38,
        start: h.time ?? h.startSeconds ?? 0,
        end: (h.time ?? 0) + 0.05,
        velocity: h.velocity ?? 100,
        confidence: h.confidence,
      })),
      { bpm, offset, gridBeats: ctx.gridBeats || 0.25, origin, minDurationTicks: PPQ / 4 },
    ).map((n) => ({ ...n, duration: Math.min(n.duration, PPQ / 4) }));
  }
  const confidence =
    num(r.confidence) ??
    (typeof r.confidence === 'object' && r.confidence
      ? num((r.confidence as Record<string, unknown>).overall)
      : undefined) ??
    (notes.length ? notes.reduce((a, n) => a + (n.confidence ?? 0.7), 0) / notes.length : 0);
  const warnings = Array.isArray(r.warnings) ? (r.warnings as unknown[]).map(String) : [];
  const barTicks = (meter.numerator * 4 * PPQ) / meter.denominator;
  const last = notes.reduce((m, n) => Math.max(m, n.tick + n.duration), 0);
  const audioBars = Math.ceil(
    ((ctx.durationSeconds - offset) * bpm) / 60 / (meter.numerator * (4 / meter.denominator)) - 1e-6,
  );
  const bars = Math.max(
    1,
    Math.ceil(last / barTicks - 1e-9),
    Math.min(audioBars, Math.ceil(last / barTicks) + 1),
  );
  const suggested =
    typeof r.suggestedInstrumentId === 'string'
      ? r.suggestedInstrumentId
      : typeof r.instrumentId === 'string'
        ? r.instrumentId
        : DEFAULT_INSTRUMENT[ctx.source];
  const role = (
    typeof r.suggestedRole === 'string'
      ? r.suggestedRole
      : typeof r.role === 'string'
        ? r.role
        : DEFAULT_ROLE[ctx.source]
  ) as TrackRole;
  if (!notes.length) {
    const i = warnings.findIndex((w) => /no notes/i.test(w));
    if (i >= 0) warnings.splice(i, 1);
    warnings.push(
      'No notes were detected. Try a louder, cleaner take, a different source type, or turn quantization off.',
    );
  }
  const lyrics = drums ? undefined : lyricsFromRaw(r.lyrics);
  if (lyrics) {
    // Recording second s sits at song second s − offset (tick 0 = the transcription's bar 1).
    const timing = createEmptySong({ title: 'timing', bpm, meter });
    const words = lyrics.phrases.flatMap((p) => p.words ?? []);
    const assigned = timedSyllables(timing, notes, words, { offsetSeconds: -offset });
    notes = notes.map((n) => {
      const syl = assigned.syllables.get(n.id);
      return syl ? { ...n, syllable: syl } : n;
    });
    lyrics.matchedWords = assigned.matchedWords;
    lyrics.unmatchedWords = assigned.unmatchedWords;
    if (words.length && assigned.unmatchedWords.length)
      warnings.push(
        `${assigned.unmatchedWords.length} sung word${assigned.unmatchedWords.length === 1 ? '' : 's'} had no detected note under ${assigned.unmatchedWords.length === 1 ? 'it' : 'them'}.`,
      );
    if (!lyrics.wordTimestamps)
      warnings.push(
        'The lyrics provider returned no word timings: the words are kept as lyric lines; use Vocals → Lyrics → Align to place them on notes.',
      );
  }
  return {
    lyrics,
    notes,
    drums,
    ppq: PPQ,
    bpm,
    bpmConfidence,
    bpmSource: ctx.requestedBpm ? ctx.bpmSource : 'detected',
    key: drums ? undefined : key,
    keyConfidence,
    keySource: drums ? 'none' : ctx.requestedKey ? 'project' : key ? 'detected' : 'none',
    meter,
    confidence: Math.max(0, Math.min(1, confidence)),
    method:
      typeof r.method === 'string'
        ? r.method
        : drums
          ? 'On-device drum transcription'
          : 'On-device pitch tracking',
    warnings,
    suggestedInstrumentId: suggested,
    role,
    bars,
    offsetSeconds: offset,
    raw,
    provenance:
      r.provenance && typeof r.provenance === 'object' ? (r.provenance as RunProvenance) : undefined,
  };
}

function lyricsFromRaw(raw: unknown): TranscribedLyricsView | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const l = raw as Record<string, unknown>;
  const segs = Array.isArray(l.segments) ? (l.segments as Record<string, unknown>[]) : [];
  const phrases: TimedLyricPhrase[] = segs
    .map((sg) => {
      const words = Array.isArray(sg.words)
        ? (sg.words as Record<string, unknown>[])
            .filter(
              (w) => typeof w.word === 'string' && num(w.start) !== undefined && num(w.end) !== undefined,
            )
            .map((w) => ({
              word: String(w.word),
              startSeconds: num(w.start)!,
              endSeconds: num(w.end)!,
              ...(num(w.confidence) !== undefined ? { confidence: num(w.confidence) } : {}),
            }))
        : [];
      const p: TimedLyricPhrase = {
        text: typeof sg.text === 'string' ? sg.text.trim() : words.map((w) => w.word).join(' '),
        startSeconds: num(sg.start) ?? words[0]?.startSeconds ?? 0,
        endSeconds: num(sg.end) ?? words[words.length - 1]?.endSeconds ?? 0,
      };
      if (words.length) p.words = words;
      return p;
    })
    .filter((p) => p.text);
  if (!phrases.length) return undefined;
  return {
    phrases,
    text: typeof l.text === 'string' ? l.text : phrases.map((p) => p.text).join('\n'),
    language: typeof l.language === 'string' ? l.language : undefined,
    method: typeof l.method === 'string' ? l.method : 'Lyrics transcription',
    wordTimestamps: l.wordTimestamps === true,
    matchedWords: 0,
    unmatchedWords: [],
    provenance:
      l.provenance && typeof l.provenance === 'object' ? (l.provenance as RunProvenance) : undefined,
  };
}

/** Median-interval tempo of a list of tap times (seconds), folded into 60–200 BPM. */
export function tapTempo(taps: number[]): number | null {
  if (taps.length < 2) return null;
  const iv: number[] = [];
  for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
  const recent = iv.slice(-8).sort((a, b) => a - b);
  const med = recent[Math.floor(recent.length / 2)];
  if (!(med > 0)) return null;
  let bpm = 60 / med;
  while (bpm < 60) bpm *= 2;
  while (bpm > 200) bpm /= 2;
  return bpm;
}

/** Contiguous bar ranges (1-based, inclusive) where low-confidence notes cluster ("check these bars"). */
export function lowConfidenceRegions(
  notes: Note[],
  barTicks: number,
  threshold = 0.6,
): { from: number; to: number; count: number }[] {
  const perBar = new Map<number, number>();
  for (const n of notes) {
    if (n.confidence === undefined || n.confidence >= threshold) continue;
    const b = Math.floor(n.tick / barTicks);
    perBar.set(b, (perBar.get(b) ?? 0) + 1);
  }
  const runs: { first: number; last: number; count: number }[] = [];
  for (const b of [...perBar.keys()].sort((a, c) => a - c)) {
    const run = runs[runs.length - 1];
    if (run && b === run.last + 1) {
      run.last = b;
      run.count += perBar.get(b)!;
    } else runs.push({ first: b, last: b, count: perBar.get(b)! });
  }
  return runs.map((r) => ({ from: r.first + 1, to: r.last + 1, count: r.count }));
}
