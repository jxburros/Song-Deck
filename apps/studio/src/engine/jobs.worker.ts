/// <reference lib="webworker" />
/**
 * Offline job worker: guide renders, stems, mastering, loudness, codecs, singing synthesis,
 * transcription, source separation and the Rebuild pipeline — all on-device (spec §51).
 */
import * as audio from '@songdeck/audio';
import type { AudioData } from '@songdeck/audio';
import {
  expandSong,
  type ExpansionRequest,
  type ComposeSongOptions,
  type MasteringSettings,
  type Song,
} from '@songdeck/core';
import type { RenderInstrumentConfig } from './render-config';

declare const self: DedicatedWorkerGlobalScope;

export interface JobRequest {
  id: number;
  method: JobMethod;
  args: unknown;
}

export type JobMethod =
  | 'renderMix'
  | 'renderStems'
  | 'renderTrack'
  | 'master'
  | 'loudness'
  | 'encodeWav'
  | 'encodeFlac'
  | 'synthesizeVocal'
  | 'transcribe'
  | 'rebuild'
  | 'expand'
  | 'separate'
  | 'analyze'
  | 'fingerprint'
  | 'cancel'
  | 'configure';

export type JobResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; aborted?: boolean }
  | { id: number; progress: number; stage?: string; detail?: unknown };

const controllers = new Map<number, AbortController>();
/** Custom and sampled instruments for renders (set by the pool's `configure`). */
let instrumentConfig: RenderInstrumentConfig = { instruments: [], sampleInstruments: {} };

function collectTransfer(
  value: unknown,
  out: Transferable[] = [],
  seen = new Set<unknown>(),
): Transferable[] {
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

function resolverFrom(assets?: Record<string, AudioData>) {
  return (id: string) => assets?.[id];
}

async function run(req: JobRequest, signal: AbortSignal): Promise<unknown> {
  const progress = (p: number, stage?: string, detail?: unknown) =>
    self.postMessage({ id: req.id, progress: p, stage, detail } satisfies JobResponse);
  switch (req.method) {
    case 'renderMix': {
      const a = req.args as {
        song: Song;
        assets?: Record<string, AudioData>;
        sampleRate?: number;
        applyMaster?: boolean;
        trackIds?: string[];
        seed?: number;
      };
      return audio.renderSong(a.song, {
        ...instrumentConfig,
        sampleRate: a.sampleRate ?? 44100,
        assets: resolverFrom(a.assets),
        applyMaster: a.applyMaster,
        trackIds: a.trackIds,
        seed: a.seed,
      });
    }
    case 'renderStems': {
      const a = req.args as {
        song: Song;
        assets?: Record<string, AudioData>;
        sampleRate?: number;
        by?: 'stemGroup' | 'track';
      };
      return audio.renderStems(a.song, {
        ...instrumentConfig,
        sampleRate: a.sampleRate ?? 44100,
        assets: resolverFrom(a.assets),
        by: a.by ?? 'stemGroup',
        applyMaster: false,
      });
    }
    case 'renderTrack': {
      const a = req.args as {
        song: Song;
        trackId: string;
        assets?: Record<string, AudioData>;
        sampleRate?: number;
      };
      return audio.renderTrack(a.song, a.trackId, {
        ...instrumentConfig,
        sampleRate: a.sampleRate ?? 44100,
        assets: resolverFrom(a.assets),
        applyMaster: false,
      });
    }
    case 'master': {
      const a = req.args as { audio: AudioData; settings: MasteringSettings };
      return audio.masterAudio(a.audio, a.settings, { onProgress: (p: number) => progress(p, 'mastering') });
    }
    case 'loudness':
      return audio.measureLoudness(req.args as AudioData);
    case 'encodeWav': {
      const a = req.args as { audio: AudioData; bitDepth?: 16 | 24 | 32 };
      return audio.encodeWav(a.audio, { bitDepth: a.bitDepth ?? 24 });
    }
    case 'encodeFlac': {
      const a = req.args as { audio: AudioData; bitDepth?: 16 | 24 };
      return audio.encodeFlac(a.audio, { bitDepth: a.bitDepth ?? 24 });
    }
    case 'synthesizeVocal': {
      const a = req.args as {
        song: Song;
        trackId: string;
        voiceId?: string;
        startTick?: number;
        endTick?: number;
        sampleRate?: number;
        seed?: number;
      };
      return audio.synthesizeVocal(a.song, a.trackId, a);
    }
    case 'transcribe': {
      const a = req.args as { audio: AudioData } & Parameters<typeof audio.transcribeAudio>[1];
      const { audio: buf, ...opts } = a;
      return audio.transcribeAudio(buf, { ...opts, signal });
    }
    case 'separate': {
      const a = req.args as { audio: AudioData };
      return audio.separateSources(a.audio, { onProgress: (p: number) => progress(p, 'separation'), signal });
    }
    case 'analyze': {
      const buf = (req.args as { audio: AudioData }).audio;
      progress(0.1, 'tempo');
      const tempo = audio.detectTempo(buf);
      progress(0.5, 'key');
      const key = audio.detectKey(buf);
      progress(0.8, 'loudness');
      const loudness = audio.measureLoudness(buf);
      return { tempo, key, loudness };
    }
    case 'fingerprint': {
      // Chromaprint fingerprint for the opt-in content check (docs/RIGHTS.md); the audio never leaves.
      const fp = audio.chromaprintFingerprint((req.args as { audio: AudioData }).audio);
      return { fingerprint: fp.fingerprint, durationSeconds: fp.durationSeconds };
    }
    case 'expand': {
      const a = req.args as { source: Song; request: ExpansionRequest; options: ComposeSongOptions };
      return expandSong(a.source, a.request, a.options);
    }
    case 'rebuild': {
      const a = req.args as { audio: AudioData; title?: string };
      return audio.rebuildProject(a.audio, {
        title: a.title,
        signal,
        onProgress: (stage, p, stages) => progress(p, stage, stages),
      });
    }
    default:
      throw new Error(`Unknown job method: ${req.method}`);
  }
}

self.onmessage = async (ev: MessageEvent<JobRequest>) => {
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
    self.postMessage({ id: req.id, ok: true, result } satisfies JobResponse, collectTransfer(result));
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    self.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      aborted,
    } satisfies JobResponse);
  } finally {
    controllers.delete(req.id);
  }
};
