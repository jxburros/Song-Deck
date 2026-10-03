/**
 * Render jobs (Phase 5 "distributed/local render nodes"). Runs inside a worker thread (see
 * `worker-entry.mjs`) so long renders never block the server's event loop; the same code runs
 * inline when worker threads are unavailable.
 *
 * Input: the raw JSON request body (parsed here, off the main thread):
 *   { kind: 'mix'|'stems'|'track'|'master'|'loudness', song?, trackId?,
 *     options?: { sampleRate?, applyMaster?, trackIds?, by?: 'stemGroup'|'track', startTick?, endTick?,
 *                 tailSeconds?, includeSends?, ignoreMuteSolo?, seed?, vocalVoiceId?, patchOverrides?,
 *                 instruments?, bitDepth?: 16|24|32 },
 *     assets?: Record<assetId, wavBase64>, audio?: wavBase64, mastering?: MasteringSettings }
 * WAV output defaults to 24-bit PCM (deterministic; stems from several nodes can be summed).
 */
import type { MessagePort } from 'node:worker_threads';
import { createTimeMap, type InstrumentProfile, type MasteringSettings, type Song, songDurationSeconds } from '@songdeck/core';
import {
  type AudioData,
  decodeWav,
  encodeWav,
  masterAudio,
  measureLoudness,
  type RenderOptions,
  renderSong,
  renderStems,
  renderTrack,
  type WavEncodeOptions,
} from '@songdeck/audio';

export type RenderKind = 'mix' | 'stems' | 'track' | 'master' | 'loudness';
export const RENDER_KINDS: RenderKind[] = ['mix', 'stems', 'track', 'master', 'loudness'];

/** Longest render a node accepts (seconds of output). */
export const MAX_RENDER_SECONDS = 30 * 60;
/** Memory guard: sample frames per output buffer (30 min at 48 kHz ≈ 690 MB of stereo float32). */
export const MAX_RENDER_FRAMES = MAX_RENDER_SECONDS * 48_000;
/** Memory guard for stems: frames × stem count. */
export const MAX_STEM_FRAMES = MAX_RENDER_FRAMES * 4;
const DEFAULT_TAIL_SECONDS = 2;
const DEFAULT_SAMPLE_RATE = 44_100;

export interface RenderResult {
  kind: RenderKind;
  contentType: string;
  /** Binary body (WAV); otherwise `json` is the body. For `master`, `json` is the report. */
  bytes?: Uint8Array;
  json?: unknown;
  durationSeconds?: number;
  renderMs: number;
}

export class RenderJobError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RenderJobError';
  }
}

/** Which render kinds the installed audio engine supports (all of them when it loaded). */
export function availableKinds(): RenderKind[] {
  const fns = [renderSong, renderStems, renderTrack, masterAudio, measureLoudness, encodeWav, decodeWav];
  return fns.every((f) => typeof f === 'function') ? [...RENDER_KINDS] : [];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (message: string, code = 'bad-request') => new RenderJobError(400, code, message);

function validateSong(v: unknown): Song {
  if (!isObj(v) || !Array.isArray(v.tracks) || !Array.isArray(v.sections) || !Array.isArray(v.tempoMap) || !v.tempoMap.length || !Array.isArray(v.meterMap) || !v.meterMap.length) {
    throw bad('song must be a Song (tracks, sections, tempoMap, meterMap)', 'invalid-song');
  }
  if (typeof v.ppq !== 'number' || !(v.ppq > 0)) throw bad('song.ppq must be a positive number', 'invalid-song');
  if (!isObj(v.mixer)) throw bad('song.mixer is required', 'invalid-song');
  for (const t of v.tempoMap as unknown[]) {
    if (!isObj(t) || typeof t.bpm !== 'number' || !(t.bpm > 0) || t.bpm > 1000 || typeof t.tick !== 'number') throw bad('song.tempoMap entries need tick and a bpm in (0, 1000]', 'invalid-song');
  }
  for (const t of v.tracks as unknown[]) {
    if (!isObj(t) || typeof t.id !== 'string' || !Array.isArray(t.notes ?? []) || !Array.isArray(t.clips ?? [])) throw bad('song.tracks entries need an id, notes and clips', 'invalid-song');
  }
  return v as unknown as Song;
}

/** Output length in seconds: sections, notes and clips that ring past them, plus the tail. */
export function estimateRenderSeconds(song: Song, opts: { startTick?: number; endTick?: number; tailSeconds?: number } = {}): number {
  try {
    const map = createTimeMap(song);
    const tail = opts.tailSeconds ?? DEFAULT_TAIL_SECONDS;
    const start = opts.startTick !== undefined ? map.tickToSeconds(opts.startTick) : 0;
    if (opts.endTick !== undefined) return Math.max(0, map.tickToSeconds(opts.endTick) - start) + tail;
    let seconds = songDurationSeconds(song);
    let lastTick = 0;
    for (const t of song.tracks) {
      for (const n of t.notes ?? []) lastTick = Math.max(lastTick, n.tick + n.duration);
      for (const c of t.clips ?? []) seconds = Math.max(seconds, map.tickToSeconds(c.tick) + (c.durationSeconds ?? 0));
    }
    seconds = Math.max(seconds, map.tickToSeconds(lastTick));
    return Math.max(0, seconds - start) + tail;
  } catch {
    throw bad('song timing (tempo map / sections) is invalid', 'invalid-song');
  }
}

function decodeBase64Wav(b64: unknown, what: string): AudioData {
  if (typeof b64 !== 'string' || !b64) throw bad(`${what} must be a base64-encoded WAV`, 'invalid-audio');
  const bytes = Buffer.from(b64, 'base64');
  try {
    const buf = decodeWav(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (!buf.channels.length) throw new Error('no audio channels');
    return buf;
  } catch (err) {
    throw bad(`${what} is not a readable WAV file: ${(err as Error).message}`, 'invalid-audio');
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

const durationOf = (buf: AudioData) => (buf.channels[0]?.length ?? 0) / buf.sampleRate;

interface ParsedOptions {
  render: RenderOptions & { by?: 'stemGroup' | 'track' };
  wav: WavEncodeOptions;
}

interface ParsedJob {
  kind: RenderKind;
  song?: Song;
  trackId?: string;
  options: ParsedOptions;
  assets: Record<string, string>;
  audio?: string;
  mastering?: MasteringSettings;
}

function parseOptions(raw: unknown): ParsedOptions {
  const o = raw === undefined || raw === null ? {} : raw;
  if (!isObj(o)) throw bad('options must be an object');
  const render: ParsedOptions['render'] = {};
  const wav: WavEncodeOptions = { bitDepth: 24 };
  const int = (key: string, min: number, max: number): number | undefined => {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`options.${key} must be an integer ${min}..${max}`);
    return v;
  };
  const bool = (key: string): boolean | undefined => {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') throw bad(`options.${key} must be a boolean`);
    return v;
  };
  const sampleRate = int('sampleRate', 8000, 192000);
  if (sampleRate !== undefined) render.sampleRate = sampleRate;
  const startTick = int('startTick', 0, Number.MAX_SAFE_INTEGER);
  if (startTick !== undefined) render.startTick = startTick;
  const endTick = int('endTick', 0, Number.MAX_SAFE_INTEGER);
  if (endTick !== undefined) render.endTick = endTick;
  if (startTick !== undefined && endTick !== undefined && endTick <= startTick) throw bad('options.endTick must be greater than options.startTick');
  const seed = int('seed', -(2 ** 31), 2 ** 32);
  if (seed !== undefined) render.seed = seed;
  if (o.tailSeconds !== undefined) {
    if (typeof o.tailSeconds !== 'number' || !(o.tailSeconds >= 0) || o.tailSeconds > 60) throw bad('options.tailSeconds must be 0..60');
    render.tailSeconds = o.tailSeconds;
  }
  for (const key of ['applyMaster', 'includeSends', 'ignoreMuteSolo'] as const) {
    const v = bool(key);
    if (v !== undefined) render[key] = v;
  }
  if (o.trackIds !== undefined) {
    if (!Array.isArray(o.trackIds) || o.trackIds.some((t) => typeof t !== 'string')) throw bad('options.trackIds must be an array of track ids');
    render.trackIds = o.trackIds as string[];
  }
  if (o.by !== undefined) {
    if (o.by !== 'stemGroup' && o.by !== 'track') throw bad("options.by must be 'stemGroup' or 'track'");
    render.by = o.by;
  }
  if (o.vocalVoiceId !== undefined) {
    if (typeof o.vocalVoiceId !== 'string') throw bad('options.vocalVoiceId must be a string');
    render.vocalVoiceId = o.vocalVoiceId;
  }
  if (o.patchOverrides !== undefined) {
    if (!isObj(o.patchOverrides) || Object.values(o.patchOverrides).some((v) => typeof v !== 'string')) throw bad('options.patchOverrides must map track ids to patch ids');
    render.patchOverrides = o.patchOverrides as Record<string, string>;
  }
  if (o.instruments !== undefined) {
    if (!Array.isArray(o.instruments) || o.instruments.some((i) => !isObj(i) || typeof i.id !== 'string')) throw bad('options.instruments must be InstrumentProfile[]');
    render.instruments = o.instruments as unknown as InstrumentProfile[];
  }
  if (o.bitDepth !== undefined) {
    if (o.bitDepth !== 16 && o.bitDepth !== 24 && o.bitDepth !== 32) throw bad('options.bitDepth must be 16, 24 or 32');
    wav.bitDepth = o.bitDepth;
  }
  return { render, wav };
}

export function parseJob(body: unknown): ParsedJob {
  if (!isObj(body)) throw bad('Render request must be a JSON object');
  const kind = body.kind;
  if (typeof kind !== 'string' || !(RENDER_KINDS as string[]).includes(kind)) throw bad(`kind must be one of ${RENDER_KINDS.join(', ')}`, 'invalid-kind');
  const assets = body.assets === undefined || body.assets === null ? {} : body.assets;
  if (!isObj(assets) || Object.values(assets).some((v) => typeof v !== 'string')) throw bad('assets must map asset ids to base64 WAV strings');
  const job: ParsedJob = { kind: kind as RenderKind, options: parseOptions(body.options), assets: assets as Record<string, string> };
  const needsSong = kind === 'mix' || kind === 'stems' || kind === 'track' || (kind === 'loudness' && body.audio === undefined);
  if (needsSong) {
    job.song = validateSong(body.song);
    const seconds = estimateRenderSeconds(job.song, job.options.render);
    if (seconds > MAX_RENDER_SECONDS) throw new RenderJobError(413, 'render-too-long', `Render would be ${Math.round(seconds)} s long; render nodes accept up to ${MAX_RENDER_SECONDS} s`);
    const known = new Set(job.song.tracks.map((t) => t.id));
    for (const id of job.options.render.trackIds ?? []) if (!known.has(id)) throw bad(`Unknown track id ${id}`, 'unknown-track');
    const frames = seconds * (job.options.render.sampleRate ?? DEFAULT_SAMPLE_RATE);
    if (frames > MAX_RENDER_FRAMES) throw new RenderJobError(413, 'render-too-large', 'Render is too large for this node (lower the sample rate or render a shorter range)');
    if (kind === 'stems') {
      const wanted = job.options.render.trackIds ? new Set(job.options.render.trackIds) : undefined;
      const tracks = job.song.tracks.filter((t) => !wanted || wanted.has(t.id));
      const stems = job.options.render.by === 'track' ? tracks.length : new Set(tracks.map((t) => t.stemGroup || 'others')).size;
      if (frames * stems > MAX_STEM_FRAMES) throw new RenderJobError(413, 'render-too-large', `Too many stems for one request (${stems}); split them across requests or nodes with options.trackIds`);
    }
  }
  if (kind === 'track') {
    if (typeof body.trackId !== 'string' || !job.song?.tracks.some((t) => t.id === body.trackId)) throw bad('trackId must name a track of the song', 'unknown-track');
    job.trackId = body.trackId;
  }
  if (kind === 'master' || (kind === 'loudness' && body.audio !== undefined)) {
    if (typeof body.audio !== 'string' || !body.audio) throw bad('audio (base64 WAV) is required', 'invalid-audio');
    job.audio = body.audio;
  }
  if (kind === 'master') {
    const m = body.mastering ?? job.song?.mastering;
    if (m !== undefined && !isObj(m)) throw bad('mastering must be MasteringSettings');
    job.mastering = { method: 'builtin', target: 'streaming', tone: 0, width: 1, ...((m as Partial<MasteringSettings> | undefined) ?? {}) };
  }
  return job;
}

function renderOptions(job: ParsedJob): RenderOptions & { by?: 'stemGroup' | 'track' } {
  const decoded = new Map<string, AudioData>();
  // Decode eagerly so invalid assets fail fast with a 400 instead of mid-render.
  for (const [id, b64] of Object.entries(job.assets)) decoded.set(id, decodeBase64Wav(b64, `assets.${id}`));
  return { ...job.options.render, assets: (assetId: string) => decoded.get(assetId) };
}

function engineError(err: unknown): never {
  if (err instanceof RenderJobError) throw err;
  const e = err as Error;
  if (e instanceof RangeError) throw new RenderJobError(413, 'render-too-large', `Render exceeded memory limits: ${e.message}`);
  throw new RenderJobError(422, 'render-failed', `The audio engine could not render this request: ${e?.message ?? String(err)}`);
}

/** Execute one render job from its raw JSON body. */
export function runRenderJob(payload: Uint8Array): RenderResult {
  const started = Date.now();
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8'));
  } catch (err) {
    throw bad(`Invalid JSON: ${(err as Error).message}`, 'invalid-json');
  }
  const job = parseJob(body);
  const done = (r: Omit<RenderResult, 'renderMs' | 'kind'>): RenderResult => ({ kind: job.kind, ...r, renderMs: Date.now() - started });
  try {
    switch (job.kind) {
      case 'mix': {
        const buf = renderSong(job.song as Song, renderOptions(job));
        return done({ contentType: 'audio/wav', bytes: encodeWav(buf, job.options.wav), durationSeconds: durationOf(buf) });
      }
      case 'track': {
        const buf = renderTrack(job.song as Song, job.trackId as string, renderOptions(job));
        return done({ contentType: 'audio/wav', bytes: encodeWav(buf, job.options.wav), durationSeconds: durationOf(buf) });
      }
      case 'stems': {
        const stems = renderStems(job.song as Song, renderOptions(job));
        const out: Record<string, string> = {};
        for (const [name, buf] of Object.entries(stems)) out[name] = toBase64(encodeWav(buf, job.options.wav));
        return done({ contentType: 'application/json', json: { stems: out } });
      }
      case 'master': {
        const input = decodeBase64Wav(job.audio, 'audio');
        if (durationOf(input) > MAX_RENDER_SECONDS) throw new RenderJobError(413, 'render-too-long', `Audio is longer than ${MAX_RENDER_SECONDS} s`);
        const { output, report } = masterAudio(input, job.mastering as MasteringSettings);
        return done({ contentType: 'audio/wav', bytes: encodeWav(output, job.options.wav), json: report, durationSeconds: durationOf(output) });
      }
      case 'loudness': {
        const buf = job.audio ? decodeBase64Wav(job.audio, 'audio') : renderSong(job.song as Song, renderOptions(job));
        return done({ contentType: 'application/json', json: { ...measureLoudness(buf), durationSeconds: durationOf(buf), sampleRate: buf.sampleRate }, durationSeconds: durationOf(buf) });
      }
    }
  } catch (err) {
    engineError(err);
  }
  throw bad('Unsupported render kind');
}

// ---------------------------------------------------------------------------
// Worker message loop (started by worker-entry.mjs)
// ---------------------------------------------------------------------------

export type WorkerRequest = { type: 'job'; id: number; payload: Uint8Array };
export type WorkerResponse =
  | { type: 'ready'; kinds: RenderKind[] }
  | { type: 'result'; id: number; ok: true; result: RenderResult }
  | { type: 'result'; id: number; ok: false; error: { status: number; code: string; message: string } };

export function serializeError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof RenderJobError) return { status: err.status, code: err.code, message: err.message };
  const e = err as Error;
  if (e instanceof RangeError) return { status: 413, code: 'render-too-large', message: `Render exceeded memory limits: ${e.message}` };
  return { status: 500, code: 'render-failed', message: `Render failed: ${e?.message ?? String(err)}` };
}

export function startWorkerLoop(port: MessagePort): void {
  port.on('message', (msg: WorkerRequest) => {
    if (msg?.type !== 'job') return;
    let response: WorkerResponse;
    const transfer: ArrayBuffer[] = [];
    try {
      const result = runRenderJob(msg.payload);
      const b = result.bytes;
      if (b && b.buffer instanceof ArrayBuffer && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) transfer.push(b.buffer);
      response = { type: 'result', id: msg.id, ok: true, result };
    } catch (err) {
      response = { type: 'result', id: msg.id, ok: false, error: serializeError(err) };
    }
    port.postMessage(response, transfer);
  });
  port.postMessage({ type: 'ready', kinds: availableKinds() } satisfies WorkerResponse);
}
