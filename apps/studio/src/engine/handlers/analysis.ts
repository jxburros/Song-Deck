import { create } from 'zustand';
import { parseKey, type KeySignature, type Song, type TaskHandler } from '@songdeck/core';
import {
  enforceMonophony,
  gridOrigin,
  resample,
  toMono,
  transcribedToNotes,
  type AudioData,
  type KeyResult,
  type RebuildReport,
  type TempoResult,
  type TranscribeAudioResult,
  type TranscribedNote,
  type TranscriptionSource,
} from '@songdeck/audio';
import type { DataKind, LyricSegment, RunProvenance } from '@songdeck/ai';
import { jobs } from '../jobs';
import { getOrchestrator, getRouter, initAi } from '../ai';
import { INTERNAL_FOR_ROLE } from '../internalDescriptors';
import { rebuildWithStems, type FourStems } from '../capture-analysis';
import { decodeAudioBytes } from '../../state/assets';
import { useStudio } from '../../state/store';

/**
 * Analysis tasks for Transcribe / Rebuild (spec §25-§27) on the generation queue (spec §63):
 * cancellable (ctx.signal → job worker abort), progress + log lines, retryable from the task
 * drawer. The built-in providers are the on-device DSP jobs in `jobs.worker.ts`; when the user (or
 * Auto routing) picks another transcription / separation provider (spec §30, §49, §59) the work goes
 * through the AI orchestrator (privacy confirmation, budgets, fallbacks, provenance) instead.
 *
 *   analysis.transcribe  audio → notes (+ tempo / key / confidence)
 *   analysis.separate    audio → drums / bass / vocals / other stems (WAV-encoded for storage)
 *   analysis.rebuild     audio → editable Song + RebuildReport (staged pipeline)
 */

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export type TranscribeSource = TranscriptionSource;

export interface TranscribeTaskInput {
  /** Client-generated id so the view can follow live updates across retries. */
  runId: string;
  audio: AudioData;
  source: TranscribeSource;
  bpm?: number;
  key?: KeySignature;
  /** Quantize grid in beats (0.5 = 1/8, 0.25 = 1/16, 1/3 = 1/8 triplet); 0/undefined = off. */
  quantizeBeats?: number;
  snapToKey?: boolean;
  label?: string;
  /** Provider choice for the 'transcription' role: 'auto' | 'internal' | provider id. */
  provider?: string;
  /** Also transcribe the sung words (lyrics transcription provider: 'auto' | provider id). */
  lyrics?: { provider?: string; language?: string; prompt?: string };
}

/** Words recognised in the recording (seconds on the recording's clock). */
export interface TranscribedLyrics {
  segments: LyricSegment[];
  text: string;
  language?: string;
  wordTimestamps: boolean;
  method: string;
  provenance?: RunProvenance;
}

export interface SeparateTaskInput {
  runId: string;
  audio: AudioData;
  /** Also return 16-bit WAV bytes per stem (for storing stems as project assets). */
  encode?: boolean;
  /** Provider choice for the 'separation' role. */
  provider?: string;
}

export interface RebuildTaskInput {
  runId: string;
  audio: AudioData;
  title: string;
  /** Provider choice for the separation stage ('auto' | 'internal' | provider id). */
  separationProvider?: string;
}

export type TranscribeTaskOutput = TranscribeAudioResult & {
  provenance?: RunProvenance;
  lyrics?: TranscribedLyrics;
};

export interface RebuildTaskOutput {
  song: Song;
  report: RebuildReport;
  /** Stems from an external separator (re-used for "keep stems" instead of separating twice). */
  stems?: EncodedStem[];
  separation?: { method: string; confidence?: number; provenance?: RunProvenance };
}

export interface EncodedStem {
  name: string;
  audio: AudioData;
  wav?: Uint8Array;
  confidence?: number;
}

export interface SeparateTaskOutput {
  stems: EncodedStem[];
  method: string;
  confidence?: number;
  /** Set when an orchestrated provider (not the on-device engine) produced the stems. */
  provenance?: RunProvenance;
}

// ---------------------------------------------------------------------------------------------
// Live stage reporting (rebuild pipeline visualisation)
// ---------------------------------------------------------------------------------------------

export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface LiveStage {
  id: string;
  label: string;
  status: StageStatus;
  progress: number;
  confidence?: number;
  detail?: string;
}

/** The Rebuild pipeline exactly as the spec lists it (§25). */
export const REBUILD_PIPELINE: { id: string; label: string; match: RegExp }[] = [
  { id: 'audio', label: 'Audio', match: /^(audio|input|load|decode)/i },
  { id: 'separation', label: 'Source separation', match: /separ|stem/i },
  { id: 'tempo', label: 'Tempo / beat detection', match: /tempo|beat/i },
  { id: 'key', label: 'Key detection', match: /^key|key[-_ ]?det|tonal/i },
  { id: 'chords', label: 'Chord analysis', match: /chord|harmon/i },
  { id: 'transcription', label: 'Pitch transcription', match: /pitch|transcri|notes/i },
  { id: 'classification', label: 'Instrument classification', match: /classif|instrument/i },
  { id: 'midi', label: 'MIDI reconstruction', match: /midi|reconstruct(?!.*struct)|quantiz/i },
  { id: 'structure', label: 'Song structure reconstruction', match: /structure|section|segment/i },
  { id: 'project', label: 'Editable project', match: /project|song|assembl|final/i },
];

export function pipelineStageFor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const exact = REBUILD_PIPELINE.find((s) => s.id === raw);
  if (exact) return exact.id;
  return REBUILD_PIPELINE.find((s) => s.match.test(raw))?.id;
}

interface LiveRun {
  stages: Record<string, LiveStage>;
  current?: string;
  progress: number;
  updatedAt: number;
}

interface LiveState {
  runs: Record<string, LiveRun>;
}

export const useAnalysisLive = create<LiveState>(() => ({ runs: {} }));

function initialStages(): Record<string, LiveStage> {
  const out: Record<string, LiveStage> = {};
  for (const s of REBUILD_PIPELINE) out[s.id] = { id: s.id, label: s.label, status: 'pending', progress: 0 };
  out.audio = { ...out.audio, status: 'done', progress: 1 };
  return out;
}

export function resetLiveRun(runId: string) {
  useAnalysisLive.setState((s) => ({
    runs: { ...s.runs, [runId]: { stages: initialStages(), progress: 0, updatedAt: Date.now() } },
  }));
}

function updateLive(runId: string, fn: (run: LiveRun) => LiveRun) {
  useAnalysisLive.setState((s) => {
    const run = s.runs[runId] ?? { stages: initialStages(), progress: 0, updatedAt: 0 };
    return { runs: { ...s.runs, [runId]: { ...fn(run), updatedAt: Date.now() } } };
  });
}

/** Normalise whatever stage records the rebuild job reports into the spec's pipeline. */
export function mergeStageDetail(
  run: LiveRun,
  stage: string | undefined,
  p: number,
  detail: unknown,
): LiveRun {
  const stages = { ...run.stages };
  const list = Array.isArray(detail)
    ? detail
    : detail && typeof detail === 'object' && Array.isArray((detail as { stages?: unknown }).stages)
      ? (detail as { stages: unknown[] }).stages
      : null;
  if (list) {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const id = pipelineStageFor(String(r.id ?? r.stage ?? r.name ?? r.label ?? ''));
      if (!id) continue;
      const statusRaw = String(r.status ?? r.state ?? '');
      const status: StageStatus = /done|complete|success|ok|finish/i.test(statusRaw)
        ? 'done'
        : /run|active|progress|working/i.test(statusRaw)
          ? 'running'
          : /skip/i.test(statusRaw)
            ? 'skipped'
            : /fail|error/i.test(statusRaw)
              ? 'failed'
              : stages[id].status;
      const prog = typeof r.progress === 'number' ? r.progress : status === 'done' ? 1 : stages[id].progress;
      const finished = status === 'done' || status === 'skipped';
      stages[id] = {
        ...stages[id],
        status,
        progress: prog,
        confidence: finished && typeof r.confidence === 'number' ? r.confidence : stages[id].confidence,
        detail:
          typeof r.detail === 'string'
            ? r.detail
            : typeof r.message === 'string'
              ? r.message
              : typeof r.summary === 'string'
                ? r.summary
                : stages[id].detail,
      };
    }
  }
  const cur = pipelineStageFor(stage);
  if (cur && !list) {
    // Without a stage list: everything before the current stage is done.
    let reached = false;
    for (const s of REBUILD_PIPELINE) {
      if (s.id === cur) {
        reached = true;
        stages[s.id] = { ...stages[s.id], status: 'running' };
      } else if (!reached && stages[s.id].status !== 'skipped')
        stages[s.id] = { ...stages[s.id], status: 'done', progress: 1 };
    }
  }
  return { ...run, stages, current: cur ?? run.current, progress: Math.max(run.progress, p) };
}

function finishLive(runId: string, ok: boolean) {
  updateLive(runId, (run) => {
    const stages = { ...run.stages };
    for (const s of REBUILD_PIPELINE) {
      const st = stages[s.id];
      if (ok && (st.status === 'pending' || st.status === 'running'))
        stages[s.id] = {
          ...st,
          status: s.id === 'project' ? 'pending' : 'done',
          progress: s.id === 'project' ? 0 : 1,
        };
      if (!ok && st.status === 'running') stages[s.id] = { ...st, status: 'failed' };
    }
    return { ...run, stages, progress: ok ? 1 : run.progress };
  });
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

function assertAudio(audio: unknown): asserts audio is AudioData {
  const a = audio as AudioData | undefined;
  if (
    !a ||
    typeof a !== 'object' ||
    !Array.isArray(a.channels) ||
    !a.channels.length ||
    !(a.channels[0] instanceof Float32Array)
  ) {
    throw new Error(
      'The source audio for this task is no longer in memory (the page was reloaded). Open the recording again and re-run.',
    );
  }
}

function describe(audio: AudioData): string {
  const sec = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
  return `${sec.toFixed(1)} s · ${audio.sampleRate} Hz · ${audio.channels.length === 1 ? 'mono' : 'stereo'}`;
}

const SOURCE_LABEL: Record<TranscribeSource, string> = {
  humming: 'humming',
  singing: 'singing',
  guitar: 'guitar',
  bass: 'bass',
  piano: 'piano',
  drums: 'drums / claps',
  isolated: 'isolated instrument',
  'full-mix': 'full mix',
};

/** Reject as soon as the task is cancelled, even if the worker finishes the computation anyway. */
function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Provider choice
// ---------------------------------------------------------------------------------------------

/**
 * Resolve a provider choice for a role. `null` = the on-device engine, which is called directly
 * (richest results: IR notes, per-stage confidence). Otherwise the orchestrator runs it (auto
 * routing when `providerId` is undefined).
 */
export function externalProvider(
  role: 'transcription' | 'separation',
  choice: string | undefined,
): { providerId?: string; name: string } | null {
  if (!choice || choice === 'internal' || choice === INTERNAL_FOR_ROLE[role]) return null;
  try {
    initAi();
    const d = getRouter().select({ role, providerId: choice === 'auto' ? undefined : choice });
    if (d.location === 'internal') return null;
    return { providerId: choice === 'auto' ? undefined : choice, name: d.providerName };
  } catch {
    return choice === 'auto' ? null : { providerId: choice, name: choice };
  }
}

function neverUpload(): DataKind[] {
  return (useStudio.getState().project?.meta.settings.neverUpload ?? []) as DataKind[];
}

async function toWav(audio: AudioData, signal: AbortSignal) {
  const data = await jobs.call<Uint8Array>('encodeWav', { audio, bitDepth: 16 }, { signal });
  return {
    mimeType: 'audio/wav',
    data,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    durationSeconds: (audio.channels[0]?.length ?? 0) / audio.sampleRate,
  };
}

const VOICE_SOURCES = new Set<TranscribeSource>(['humming', 'singing']);
const DEFAULT_INSTRUMENT: Record<TranscribeSource, [string, TranscribeAudioResult['suggestedRole']]> = {
  humming: ['lead-vocal', 'vocal'],
  singing: ['lead-vocal', 'vocal'],
  guitar: ['electric-guitar-clean', 'rhythm-guitar'],
  bass: ['electric-bass', 'bass'],
  piano: ['piano', 'keys'],
  drums: ['drum-kit', 'drums'],
  isolated: ['synth-lead', 'synth-lead'],
  'full-mix': ['lead-vocal', 'vocal'],
};

/** Provider transcription (seconds-based notes) → the same result shape as the on-device engine. */
async function transcribeWithProvider(
  ctx: Parameters<TaskHandler<TranscribeTaskInput, TranscribeTaskOutput>>[0],
  ext: { providerId?: string; name: string },
): Promise<TranscribeTaskOutput> {
  const { audio, source, bpm, key, quantizeBeats, snapToKey } = ctx.input;
  ctx.progress(0.05, `Encoding audio for ${ext.name}…`);
  const encoded = await toWav(audio, ctx.signal);
  ctx.progress(0.15, `Transcribing with ${ext.name}…`);
  const run = await getOrchestrator().transcribe(
    { audio: encoded, source },
    {
      providerId: ext.providerId,
      signal: ctx.signal,
      dataKinds: [VOICE_SOURCES.has(source) ? 'recorded-vocals' : 'reference-audio'],
      neverUpload: neverUpload(),
    },
  );
  ctx.log(
    'info',
    `Provider: ${run.provenance.providerName}${run.provenance.modelId ? ` · ${run.provenance.modelId}` : ''} (${run.provenance.location})`,
  );
  const r = run.result;
  const warnings: string[] = [];
  // Tempo / key: request → provider → on-device analysis.
  let tempoRes: TempoResult | null = null;
  let keyRes: KeyResult | null = null;
  const providerKey = r.key ? parseKey(r.key) : null;
  if (!bpm && !r.tempo) {
    ctx.progress(0.75, 'Detecting tempo and key on-device…');
    const a = await jobs.call<{ tempo: TempoResult; key: KeyResult }>(
      'analyze',
      { audio },
      { signal: ctx.signal },
    );
    tempoRes = a.tempo;
    keyRes = a.key;
  } else if (!key && !providerKey && source !== 'drums') {
    const a = await jobs.call<{ tempo: TempoResult; key: KeyResult }>(
      'analyze',
      { audio },
      { signal: ctx.signal },
    );
    keyRes = a.key;
  }
  const finalBpm = bpm ?? r.tempo ?? (tempoRes && tempoRes.beats.length >= 4 ? tempoRes.bpm : 120);
  const bpmConfidence = bpm ? 1 : r.tempo ? (r.confidence ?? 0.7) : (tempoRes?.confidence ?? 0);
  const finalKey: KeySignature = key ?? providerKey ?? keyRes?.key ?? { tonic: 0, mode: 'major' };
  const keyConfidence = key ? 1 : providerKey ? (r.confidence ?? 0.7) : (keyRes?.confidence ?? 0);
  const transcribed: TranscribedNote[] = r.notes.map((n) => ({
    pitch: Math.round(n.pitch),
    startSeconds: n.start,
    endSeconds: n.end,
    velocity: n.velocity,
    confidence: n.confidence,
  }));
  const first = transcribed.reduce((m, n) => Math.min(m, n.startSeconds), Infinity);
  const offset = bpm
    ? 0
    : tempoRes && tempoRes.confidence >= 0.35 && Number.isFinite(first)
      ? gridOrigin(tempoRes, first)
      : Number.isFinite(first)
        ? first
        : 0;
  if (!bpm && bpmConfidence < 0.35)
    warnings.push(
      `Tempo is uncertain (${Math.round(finalBpm)} BPM): set the tempo or record with the count-in for a reliable grid.`,
    );
  let notes = transcribedToNotes(transcribed, {
    bpm: finalBpm,
    quantizeBeats: quantizeBeats ?? 0,
    offsetSeconds: offset,
    key: finalKey,
    snapToKey,
    origin: `transcription:${run.provenance.providerId}`,
  });
  if (VOICE_SOURCES.has(source) || source === 'bass') notes = enforceMonophony(notes);
  const [instrumentId, role] = DEFAULT_INSTRUMENT[source];
  return {
    notes,
    bpm: Math.round(finalBpm * 100) / 100,
    bpmConfidence,
    key: finalKey,
    keyConfidence,
    confidence:
      r.confidence ??
      (notes.length ? notes.reduce((a, n) => a + (n.confidence ?? 0.6), 0) / notes.length : 0),
    method: `${run.provenance.providerName}${r.model ? ` · ${r.model}` : ''}`,
    suggestedInstrumentId: instrumentId,
    suggestedRole: role,
    warnings,
    offsetSeconds: offset,
    transcribed,
    provenance: run.provenance,
  };
}

const transcribe: TaskHandler<TranscribeTaskInput, TranscribeTaskOutput> = async (ctx) => {
  const { audio, runId: _runId, label: _label, provider, ...opts } = ctx.input;
  void _runId;
  void _label;
  assertAudio(audio);
  const ext = externalProvider('transcription', provider);
  ctx.log(
    'info',
    `Transcribing ${SOURCE_LABEL[opts.source] ?? opts.source} (${describe(audio)}) with ${ext ? ext.name : 'the on-device engine'}`,
  );
  ctx.log(
    'info',
    `Options: tempo ${opts.bpm ? `${Math.round(opts.bpm)} BPM` : 'detect'}, key ${opts.key ? `${opts.key.tonic}/${opts.key.mode}` : 'detect'}, quantize ${opts.quantizeBeats ? `${Math.round(opts.quantizeBeats * 1000) / 1000} beat` : 'off'}${opts.snapToKey ? ', snap to key' : ''}`,
  );
  const started = performance.now();
  let result: TranscribeTaskOutput;
  if (ext) result = await transcribeWithProvider(ctx, ext);
  else {
    ctx.progress(0.08, 'Analysing pitch and rhythm…');
    // quantizeBeats: 0 means "off" (the engine's default would be 1/16).
    const args = { audio, ...opts, quantizeBeats: opts.quantizeBeats ?? 0 };
    result = await withAbort(
      jobs.call<TranscribeAudioResult>('transcribe', args, { signal: ctx.signal }),
      ctx.signal,
    );
  }
  ctx.log(
    'info',
    `${result.notes.length} ${opts.source === 'drums' ? 'hits' : 'notes'} in ${((performance.now() - started) / 1000).toFixed(1)} s · ${result.method} · ${Math.round(result.bpm)} BPM (${Math.round(result.bpmConfidence * 100)}%) · confidence ${Math.round(result.confidence * 100)}%`,
  );
  if (ctx.input.lyrics && opts.source !== 'drums') {
    try {
      result = { ...result, lyrics: await transcribeLyricsStep(ctx, audio, ctx.input.lyrics) };
      ctx.log(
        'info',
        `Lyrics: ${result.lyrics!.segments.length} phrase(s) · ${result.lyrics!.method}${result.lyrics!.wordTimestamps ? '' : ' (no word timings)'}`,
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError' || ctx.signal.aborted) throw err;
      const msg = `Lyrics could not be transcribed: ${err instanceof Error ? err.message : String(err)}`;
      result = { ...result, warnings: [...(result.warnings ?? []), msg] };
    }
  }
  for (const w of result.warnings ?? []) ctx.log('warn', w);
  ctx.progress(1, 'Done');
  return result;
};

/** Speech-ready audio: mono 16 kHz 16-bit WAV keeps uploads small (25 MB limits) and models happy. */
async function speechWav(audio: AudioData, signal: AbortSignal) {
  const mono = resample(toMono(audio), 16_000);
  return toWav(mono, signal);
}

async function transcribeLyricsStep(
  ctx: Parameters<TaskHandler<TranscribeTaskInput, TranscribeTaskOutput>>[0],
  audio: AudioData,
  opts: NonNullable<TranscribeTaskInput['lyrics']>,
): Promise<TranscribedLyrics> {
  initAi();
  ctx.progress(0.9, 'Transcribing the lyrics…');
  const encoded = await speechWav(audio, ctx.signal);
  const run = await getOrchestrator().transcribeLyrics(
    { audio: encoded, language: opts.language, prompt: opts.prompt, wordTimestamps: true },
    {
      providerId: !opts.provider || opts.provider === 'auto' ? undefined : opts.provider,
      signal: ctx.signal,
      dataKinds: ['recorded-vocals'],
      neverUpload: neverUpload(),
    },
  );
  const r = run.result;
  return {
    segments: r.segments,
    text: r.text,
    language: r.language,
    wordTimestamps: r.wordTimestamps,
    method: `${run.provenance.providerName}${r.model ? ` · ${r.model}` : ''}`,
    provenance: run.provenance,
  };
}

/** Stems from an orchestrated provider (any names) → the four-stem layout of the Rebuild pipeline. */
async function separateWithProvider(
  audio: AudioData,
  ext: { providerId?: string; name: string },
  signal: AbortSignal,
  progress: (p: number, msg: string) => void,
) {
  progress(0.05, `Encoding audio for ${ext.name}…`);
  const encoded = await toWav(audio, signal);
  progress(0.12, `Separating stems with ${ext.name}…`);
  const run = await getOrchestrator().separate(
    { audio: encoded, stems: ['drums', 'bass', 'vocals', 'other'] },
    { providerId: ext.providerId, signal, neverUpload: neverUpload() },
  );
  const decoded: { name: string; audio: AudioData; wav: Uint8Array }[] = [];
  for (const [name, enc] of Object.entries(run.result.stems)) {
    decoded.push({ name, audio: await decodeAudioBytes(enc.data), wav: enc.data });
  }
  return {
    decoded,
    method: `${run.provenance.providerName}${run.result.model ? ` · ${run.result.model}` : ''}`,
    confidence: run.result.confidence,
    provenance: run.provenance,
  };
}

function mixInto(target: AudioData | undefined, add: AudioData): AudioData {
  if (!target) return { sampleRate: add.sampleRate, channels: add.channels.map((c) => c.slice()) };
  const out = { sampleRate: target.sampleRate, channels: target.channels.map((c) => c.slice()) };
  out.channels.forEach((c, ci) => {
    const src = add.channels[Math.min(ci, add.channels.length - 1)];
    for (let i = 0; i < Math.min(c.length, src.length); i++) c[i] += src[i];
  });
  return out;
}

/** Map arbitrary stem names (e.g. 6-stem models) onto drums / bass / vocals / other. */
function toFourStems(list: { name: string; audio: AudioData }[], fallback: AudioData): FourStems {
  const silent = (): AudioData => ({
    sampleRate: fallback.sampleRate,
    channels: fallback.channels.map((c) => new Float32Array(c.length)),
  });
  let drums: AudioData | undefined;
  let bass: AudioData | undefined;
  let vocals: AudioData | undefined;
  let other: AudioData | undefined;
  // Complements ("instrumental", "no_vocals") overlap the other stems: use them only as "other"
  // when nothing finer was returned.
  const isComplement = (n: string) => /^no[_-]/.test(n) || /instrumental|accompan|backing|karaoke/.test(n);
  const complements = list.filter((s) => isComplement(s.name.toLowerCase()));
  for (const s of list) {
    const n = s.name.toLowerCase();
    if (isComplement(n)) continue;
    if (/drum|perc/.test(n)) drums = mixInto(drums, s.audio);
    else if (/bass/.test(n)) bass = mixInto(bass, s.audio);
    else if (/voc|voice|sing/.test(n)) vocals = mixInto(vocals, s.audio);
    else other = mixInto(other, s.audio);
  }
  if (!other && !drums && !bass && complements.length) other = complements[0].audio;
  else if (!other && (drums || bass || vocals)) {
    // Providers that isolate single stems (LALAL.AI…): "other" is what remains of the mix.
    const parts = [drums, bass, vocals].filter((x): x is AudioData => !!x);
    if (parts.every((p) => p.sampleRate === fallback.sampleRate)) {
      other = mixInto(undefined, fallback);
      for (const p of parts)
        other.channels.forEach((c, ci) => {
          const src = p.channels[Math.min(ci, p.channels.length - 1)];
          for (let i = 0; i < Math.min(c.length, src.length); i++) c[i] -= src[i];
        });
    }
  }
  return {
    drums: drums ?? silent(),
    bass: bass ?? silent(),
    vocals: vocals ?? silent(),
    other: other ?? silent(),
  };
}

const separate: TaskHandler<SeparateTaskInput, SeparateTaskOutput> = async (ctx) => {
  const { audio, encode, provider } = ctx.input;
  assertAudio(audio);
  const ext = externalProvider('separation', provider);
  if (ext) {
    ctx.log('info', `Separating stems (${describe(audio)}) with ${ext.name}`);
    const r = await separateWithProvider(audio, ext, ctx.signal, (p, m) => ctx.progress(p, m));
    ctx.log('info', `${r.decoded.length} stems from ${r.method}`);
    ctx.progress(1, 'Done');
    return {
      stems: r.decoded.map((d) => ({
        name: d.name,
        audio: d.audio,
        wav: encode ? d.wav : undefined,
        confidence: r.confidence,
      })),
      method: r.method,
      confidence: r.confidence,
      provenance: r.provenance,
    };
  }
  ctx.log(
    'info',
    `Separating stems (${describe(audio)}) with the built-in DSP separator (HPSS + spectral masks)`,
  );
  ctx.progress(0.02, 'Separating stems…');
  const res = await jobs.call<{
    stems: Record<string, AudioData> | { name: string; audio: AudioData; confidence?: number }[];
    method?: string;
    confidence?: number | Record<string, number>;
  }>(
    'separate',
    { audio },
    {
      signal: ctx.signal,
      onProgress: (p) => ctx.progress(0.02 + p * (encode ? 0.78 : 0.96), 'Separating stems…'),
    },
  );
  const perStem =
    res.confidence && typeof res.confidence === 'object' ? (res.confidence as Record<string, number>) : {};
  const list: EncodedStem[] = Array.isArray(res.stems)
    ? res.stems.map((s) => ({ name: s.name, audio: s.audio, confidence: s.confidence ?? perStem[s.name] }))
    : Object.entries(res.stems).map(([name, a]) => ({ name, audio: a, confidence: perStem[name] }));
  if (encode) {
    for (let i = 0; i < list.length; i++) {
      if (ctx.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      ctx.progress(0.8 + (i / list.length) * 0.2, `Encoding ${list[i].name}…`);
      list[i].wav = await jobs.call<Uint8Array>(
        'encodeWav',
        { audio: list[i].audio, bitDepth: 16 },
        { signal: ctx.signal },
      );
    }
  }
  const values = list.map((s) => s.confidence).filter((v): v is number => typeof v === 'number');
  const overall =
    typeof res.confidence === 'number'
      ? res.confidence
      : values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : undefined;
  ctx.log(
    'info',
    `${list.length} stems: ${list.map((s) => `${s.name}${s.confidence !== undefined ? ` ${Math.round(s.confidence * 100)}%` : ''}`).join(', ')}`,
  );
  ctx.progress(1, 'Done');
  return { stems: list, method: res.method ?? 'On-device DSP separation', confidence: overall };
};

const rebuild: TaskHandler<RebuildTaskInput, RebuildTaskOutput> = async (ctx) => {
  const { audio, title, runId, separationProvider } = ctx.input;
  assertAudio(audio);
  resetLiveRun(runId);
  const ext = externalProvider('separation', separationProvider);
  ctx.log(
    'info',
    `Rebuilding “${title}” (${describe(audio)}) — separation: ${ext ? ext.name : 'on-device DSP'} (attempt ${ctx.attempt ?? 1})`,
  );
  let lastStage: string | undefined;
  const onProgress = (scale: (p: number) => number) => (p: number, stage?: string, detail?: unknown) => {
    const id = pipelineStageFor(stage);
    const label = REBUILD_PIPELINE.find((s) => s.id === id)?.label ?? stage ?? 'Working';
    ctx.progress(Math.max(0, Math.min(0.99, scale(p))), `${label}…`);
    if (id && id !== lastStage) {
      lastStage = id;
      ctx.log('info', `Stage: ${label}`);
    }
    updateLive(runId, (run) => mergeStageDetail(run, stage, p, detail));
  };
  try {
    let result: RebuildTaskOutput;
    if (ext) {
      updateLive(runId, (run) => ({
        ...run,
        current: 'separation',
        stages: {
          ...run.stages,
          separation: { ...run.stages.separation, status: 'running', detail: `Separating with ${ext.name}…` },
        },
      }));
      const sep = await separateWithProvider(audio, ext, ctx.signal, (p, m) => ctx.progress(p * 0.4, m));
      ctx.log('info', `Stems from ${sep.method}: ${sep.decoded.map((d) => d.name).join(', ')}`);
      const stems = toFourStems(sep.decoded, audio);
      const r = await rebuildWithStems(audio, title, stems, {
        signal: ctx.signal,
        onProgress: onProgress((p) => 0.4 + p * 0.6),
      });
      result = {
        ...r,
        stems: sep.decoded.map((d) => ({
          name: d.name,
          audio: d.audio,
          wav: d.wav,
          confidence: sep.confidence,
        })),
        separation: { method: sep.method, confidence: sep.confidence, provenance: sep.provenance },
      };
    } else {
      result = await jobs.call<RebuildTaskOutput>(
        'rebuild',
        { audio, title },
        { signal: ctx.signal, onProgress: onProgress((p) => p) },
      );
    }
    for (const w of result.report?.warnings ?? []) ctx.log('warn', w);
    finishLive(runId, true);
    ctx.progress(1, 'Done');
    return result;
  } catch (err) {
    finishLive(runId, false);
    throw err;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = {
  'analysis.transcribe': transcribe,
  'analysis.separate': separate,
  'analysis.rebuild': rebuild,
};
