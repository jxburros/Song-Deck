/// <reference lib="webworker" />
/**
 * Production render worker (spec §28 guide rendering, §38 stem production, §39 selective
 * regeneration). Unlike the generic job worker it renders in chunks, reports progress and yields
 * between chunks so a cancel message can interrupt a long render. It also supports the render
 * options production needs: time ranges (regions), seeds (performance interpretation), patch
 * overrides and user sample instruments, plus the buffer operations used to assemble productions
 * (printing a stem through its channel strip, mastering a stem sum, crossfaded splices, loudness
 * matching, WAV encoding and waveform peaks).
 */
import {
  SongRenderer,
  createAudio,
  encodeWav,
  gainAudio,
  measureLoudness,
  resample,
  sliceAudio,
  spliceWithCrossfade,
  toStereo,
  type AudioData,
  type SampleInstrument,
} from '@songdeck/audio';
import { TRACK_NEUTRAL, defaultChannelStrip, type Song, type Track } from '@songdeck/core';
import type { RenderInstrumentConfig } from './render-config';

declare const self: DedicatedWorkerGlobalScope;

export type ProduceJobMethod =
  | 'render'
  | 'printStem'
  | 'masterSum'
  | 'conform'
  | 'splice'
  | 'slice'
  | 'matchLoudness'
  | 'loudness'
  | 'encodeWav'
  | 'cancel'
  | 'configure';

export interface ProduceJobRequest {
  id: number;
  method: ProduceJobMethod;
  args: unknown;
}

export type ProduceJobResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; aborted?: boolean }
  | { id: number; progress: number };

/** Options of a (partial) song render. */
export interface RenderArgs {
  song: Song;
  /** Audio-track clip assets by asset id. */
  assets?: Record<string, AudioData>;
  sampleRate?: number;
  /** Only these tracks. */
  trackIds?: string[];
  /** Master bus (default false: references and stems are unmastered). */
  applyMaster?: boolean;
  /** Reverb/delay sends (default true). */
  includeSends?: boolean;
  ignoreMuteSolo?: boolean;
  startTick?: number;
  endTick?: number;
  tailSeconds?: number;
  seed?: number;
  patchOverrides?: Record<string, string>;
  sampleInstruments?: Record<string, SampleInstrument>;
}

export interface PrintStemArgs {
  /** Song whose channel strip / automation / sends are applied. */
  song: Song;
  trackId: string;
  audio: AudioData;
  sampleRate?: number;
  /** Seconds where the audio starts on the timeline (default 0). */
  atSeconds?: number;
}

export interface MasterSumArgs {
  /** Song providing tempo, sections and the master bus. */
  song: Song;
  audio: AudioData;
  sampleRate?: number;
  applyMaster?: boolean;
}

export interface MatchLoudnessResult {
  audio: AudioData;
  gainDb: number;
  referenceLufs: number;
  inputLufs: number;
}

const controllers = new Map<number, AbortController>();
/** Custom instrument profiles and plugin sample sets (set by the pool's `configure`), as in playback. */
let instrumentConfig: RenderInstrumentConfig = { instruments: [], sampleInstruments: {} };

function abortError(): Error {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

function collectTransfer(value: unknown, out: Transferable[] = [], seen = new Set<unknown>()): Transferable[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    const buf = (value as ArrayBufferView).buffer;
    if (buf instanceof ArrayBuffer && !out.includes(buf)) out.push(buf);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectTransfer(v, out, seen);
    return out;
  }
  for (const v of Object.values(value as Record<string, unknown>)) collectTransfer(v, out, seen);
  return out;
}

const frames = (a: AudioData) => a.channels[0]?.length ?? 0;
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

/** Chunked offline render with progress; yields every ~150 ms so cancel messages are handled. */
async function renderChunked(args: RenderArgs, signal: AbortSignal, progress: (p: number) => void): Promise<AudioData> {
  const assets = args.assets ?? {};
  const r = new SongRenderer(args.song, {
    sampleRate: args.sampleRate ?? 44100,
    trackIds: args.trackIds,
    applyMaster: args.applyMaster ?? false,
    includeSends: args.includeSends,
    ignoreMuteSolo: args.ignoreMuteSolo,
    startTick: args.startTick,
    endTick: args.endTick,
    tailSeconds: args.tailSeconds,
    seed: args.seed,
    patchOverrides: args.patchOverrides,
    instruments: instrumentConfig.instruments,
    sampleInstruments: { ...instrumentConfig.sampleInstruments, ...(args.sampleInstruments ?? {}) },
    assets: (id) => assets[id],
  });
  const total = r.totalFrames;
  const out = createAudio(r.sampleRate, total, 2);
  const L = out.channels[0];
  const R = out.channels[1];
  const chunk = 8192;
  let last = performance.now();
  for (let f = 0; f < total; f += chunk) {
    const n = Math.min(chunk, total - f);
    r.process(L.subarray(f, f + n), R.subarray(f, f + n), n);
    if (performance.now() - last > 150) {
      progress(total ? f / total : 0);
      await yieldNow();
      if (signal.aborted) throw abortError();
      last = performance.now();
    }
  }
  progress(1);
  return out;
}

function audioTrackFor(base: Track | undefined, id: string, clipSeconds: number, atTick = 0): Track {
  return {
    id,
    name: base?.name ?? id,
    kind: 'audio',
    role: base?.role ?? 'custom',
    instrumentId: 'audio',
    constraints: {},
    notes: [],
    clips: [{ id: `${id}_clip`, assetId: `${id}_audio`, tick: atTick, offsetSeconds: 0, durationSeconds: clipSeconds, gainDb: 0, fadeInSeconds: 0, fadeOutSeconds: 0 }],
    color: base?.color ?? TRACK_NEUTRAL,
    stemGroup: base?.stemGroup ?? 'others',
  };
}

/** Run dry audio (singing synthesis, an external render) through a track's channel strip, automation and sends. */
async function printStem(a: PrintStemArgs, signal: AbortSignal, progress: (p: number) => void): Promise<AudioData> {
  const base = a.song.tracks.find((t) => t.id === a.trackId);
  const seconds = frames(a.audio) / a.audio.sampleRate;
  const startTick = 0;
  const track = audioTrackFor(base, a.trackId, seconds, startTick);
  const song: Song = { ...a.song, tracks: a.song.tracks.map((t) => (t.id === a.trackId ? track : t)) };
  if (!base) song.tracks = [...song.tracks, track];
  const offset = Math.max(0, a.atSeconds ?? 0);
  // A clip that starts later than 0 s is expressed by padding the audio (clips are tick-placed).
  const audio = offset > 0 ? padStart(a.audio, offset) : a.audio;
  if (offset > 0) track.clips[0].durationSeconds = frames(audio) / audio.sampleRate;
  return renderChunked(
    { song, assets: { [`${a.trackId}_audio`]: audio }, sampleRate: a.sampleRate ?? audio.sampleRate, trackIds: [a.trackId], applyMaster: false, ignoreMuteSolo: true, tailSeconds: 2 },
    signal,
    progress,
  );
}

function padStart(a: AudioData, seconds: number): AudioData {
  const pad = Math.round(seconds * a.sampleRate);
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => {
    const out = new Float32Array(pad + c.length);
    out.set(c, pad);
    return out;
  }) };
}

/** Apply the song's master bus to a summed stem buffer (unity strip, no sends): equals mixing the stems as audio tracks. */
async function masterSum(a: MasterSumArgs, signal: AbortSignal, progress: (p: number) => void): Promise<AudioData> {
  const seconds = frames(a.audio) / a.audio.sampleRate;
  const id = '__production_sum';
  const track = audioTrackFor(undefined, id, seconds);
  const song: Song = {
    ...a.song,
    tracks: [track],
    automation: a.song.automation.filter((l) => l.target === 'master'),
    mixer: { ...a.song.mixer, channels: { [id]: defaultChannelStrip({ volumeDb: 0, reverbSend: 0, delaySend: 0 }) } },
  };
  const out = await renderChunked(
    { song, assets: { [`${id}_audio`]: a.audio }, sampleRate: a.sampleRate ?? a.audio.sampleRate, applyMaster: a.applyMaster ?? true, includeSends: false, tailSeconds: 0.5 },
    signal,
    progress,
  );
  // Keep exactly the input length (the renderer appends a short tail for the limiter).
  return frames(out) > frames(a.audio) + Math.round(0.5 * out.sampleRate) ? sliceAudio(out, 0, seconds + 0.5) : out;
}

/** Resample / convert to stereo so buffers can be summed sample by sample. */
function conform(a: { audio: AudioData; sampleRate: number }): AudioData {
  let out = Math.round(a.audio.sampleRate) === Math.round(a.sampleRate) ? a.audio : resample(a.audio, a.sampleRate);
  if (out.channels.length < 2) out = toStereo(out);
  else if (out.channels.length > 2) out = { sampleRate: out.sampleRate, channels: out.channels.slice(0, 2) };
  return out;
}

function matchLoudness(a: { audio: AudioData; reference: AudioData; maxGainDb?: number }): MatchLoudnessResult {
  const ref = measureLoudness(a.reference).integratedLufs;
  const inp = measureLoudness(a.audio).integratedLufs;
  const max = a.maxGainDb ?? 24;
  if (!Number.isFinite(ref) || !Number.isFinite(inp) || ref < -70 || inp < -70) return { audio: a.audio, gainDb: 0, referenceLufs: ref, inputLufs: inp };
  const gainDb = Math.max(-max, Math.min(max, ref - inp));
  return { audio: Math.abs(gainDb) < 0.01 ? a.audio : gainAudio(a.audio, gainDb), gainDb, referenceLufs: ref, inputLufs: inp };
}

async function run(req: ProduceJobRequest, signal: AbortSignal): Promise<unknown> {
  const progress = (p: number) => self.postMessage({ id: req.id, progress: p } satisfies ProduceJobResponse);
  switch (req.method) {
    case 'render':
      return renderChunked(req.args as RenderArgs, signal, progress);
    case 'printStem':
      return printStem(req.args as PrintStemArgs, signal, progress);
    case 'masterSum':
      return masterSum(req.args as MasterSumArgs, signal, progress);
    case 'conform':
      return conform(req.args as { audio: AudioData; sampleRate: number });
    case 'splice': {
      const a = req.args as { base: AudioData; insert: AudioData; atSeconds: number; crossfadeSeconds?: number };
      return spliceWithCrossfade(a.base, a.insert, a.atSeconds, a.crossfadeSeconds ?? 0.03);
    }
    case 'slice': {
      const a = req.args as { audio: AudioData; startSeconds: number; endSeconds?: number };
      return sliceAudio(a.audio, a.startSeconds, a.endSeconds);
    }
    case 'matchLoudness':
      return matchLoudness(req.args as { audio: AudioData; reference: AudioData; maxGainDb?: number });
    case 'loudness':
      return measureLoudness(req.args as AudioData);
    case 'encodeWav': {
      const a = req.args as { audio: AudioData; bitDepth?: 16 | 24 | 32 };
      return encodeWav(a.audio, { bitDepth: a.bitDepth ?? 24 });
    }
    default:
      throw new Error(`Unknown production job: ${req.method}`);
  }
}

self.onmessage = async (ev: MessageEvent<ProduceJobRequest>) => {
  const req = ev.data;
  if (req.method === 'cancel') {
    controllers.get((req.args as { target: number }).target)?.abort();
    return;
  }
  if (req.method === 'configure') {
    instrumentConfig = req.args as RenderInstrumentConfig;
    return;
  }
  const controller = new AbortController();
  controllers.set(req.id, controller);
  try {
    const result = await run(req, controller.signal);
    self.postMessage({ id: req.id, ok: true, result } satisfies ProduceJobResponse, collectTransfer(result));
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err), aborted } satisfies ProduceJobResponse);
  } finally {
    controllers.delete(req.id);
  }
};
