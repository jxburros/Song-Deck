import type { AudioData, LoudnessReport } from '@songdeck/audio';
import type {
  MasterSumArgs,
  MatchLoudnessResult,
  PrintStemArgs,
  ProduceJobMethod,
  ProduceJobRequest,
  ProduceJobResponse,
  RenderArgs,
} from './produce-render.worker';
import type { RenderInstrumentConfig } from './render-config';
import { currentRenderInstruments } from './render-instruments';

/**
 * Promise client for the production render worker (`produce-render.worker.ts`). A small pool lets
 * independent renders (guide stems, references of different tracks / candidates) run in parallel.
 * Every call accepts an AbortSignal: the worker stops between render chunks.
 */

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number) => void;
  worker: Worker;
}

const POOL_SIZE = Math.max(
  1,
  Math.min(3, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2) - 1),
);

function abortError(message = 'Cancelled'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

class ProducePool {
  private workers: Worker[] = [];
  private load = new Map<Worker, number>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private config: RenderInstrumentConfig | null = null;
  private configKey = '';

  get size(): number {
    return POOL_SIZE;
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./produce-render.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<ProduceJobResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if ('progress' in msg) {
        p.onProgress?.(msg.progress);
        return;
      }
      this.pending.delete(msg.id);
      this.load.set(p.worker, Math.max(0, (this.load.get(p.worker) ?? 1) - 1));
      if (msg.ok) p.resolve(msg.result);
      else p.reject(msg.aborted ? abortError() : new Error(msg.error));
    };
    w.onerror = (ev) => {
      for (const [id, p] of this.pending) {
        if (p.worker !== w) continue;
        p.reject(new Error(ev.message || 'Production render worker crashed'));
        this.pending.delete(id);
      }
      this.load.set(w, 0);
    };
    if (this.config)
      w.postMessage({ id: 0, method: 'configure', args: this.config } satisfies ProduceJobRequest);
    this.workers.push(w);
    this.load.set(w, 0);
    return w;
  }

  /**
   * Keep the workers' instruments in step with playback/export (custom profiles, plugin sample
   * sets): renders of tracks using plugin instruments sound the same everywhere.
   */
  private syncInstruments() {
    let cfg: RenderInstrumentConfig;
    try {
      cfg = currentRenderInstruments();
    } catch {
      return;
    }
    const key = cfg.instruments.map((i) => `${i.id}=${i.patchId}`).join('|');
    if (this.config && key === this.configKey && cfg.sampleInstruments === this.config.sampleInstruments)
      return;
    this.config = cfg;
    this.configKey = key;
    for (const w of this.workers)
      w.postMessage({ id: 0, method: 'configure', args: cfg } satisfies ProduceJobRequest);
  }

  private pick(): Worker {
    const idle = this.workers.find((w) => (this.load.get(w) ?? 0) === 0);
    if (idle) return idle;
    if (this.workers.length < POOL_SIZE) return this.spawn();
    let best = this.workers[0];
    for (const w of this.workers) if ((this.load.get(w) ?? 0) < (this.load.get(best) ?? 0)) best = w;
    return best;
  }

  call<T>(
    method: Exclude<ProduceJobMethod, 'cancel' | 'configure'>,
    args: unknown,
    opts: { onProgress?: (p: number) => void; signal?: AbortSignal; transfer?: Transferable[] } = {},
  ): Promise<T> {
    if (opts.signal?.aborted) return Promise.reject(abortError());
    if (method === 'render' || method === 'printStem' || method === 'masterSum') this.syncInstruments();
    const worker = this.pick();
    const id = this.nextId++;
    this.load.set(worker, (this.load.get(worker) ?? 0) + 1);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress: opts.onProgress,
        worker,
      });
      if (opts.signal) {
        opts.signal.addEventListener(
          'abort',
          () => {
            worker.postMessage({ id: 0, method: 'cancel', args: { target: id } } satisfies ProduceJobRequest);
          },
          { once: true },
        );
      }
      worker.postMessage({ id, method, args } satisfies ProduceJobRequest, opts.transfer ?? []);
    });
  }
}

export const producePool = new ProducePool();

type Opts = { signal?: AbortSignal; onProgress?: (p: number) => void };

/** Offline render (whole song, a region, or some tracks) with production options. */
export function renderProduction(args: RenderArgs, opts: Opts = {}): Promise<AudioData> {
  return producePool.call<AudioData>('render', args, opts);
}

/** Dry audio → through a track's channel strip, automation and sends (a "printed" stem). */
export function printStem(args: PrintStemArgs, opts: Opts = {}): Promise<AudioData> {
  return producePool.call<AudioData>('printStem', args, opts);
}

/** Summed stems → the song's master bus. */
export function masterSum(args: MasterSumArgs, opts: Opts = {}): Promise<AudioData> {
  return producePool.call<AudioData>('masterSum', args, opts);
}

export function conformAudio(audio: AudioData, sampleRate: number, opts: Opts = {}): Promise<AudioData> {
  if (Math.round(audio.sampleRate) === Math.round(sampleRate) && audio.channels.length === 2)
    return Promise.resolve(audio);
  return producePool.call<AudioData>('conform', { audio, sampleRate }, opts);
}

export function spliceAudio(
  base: AudioData,
  insert: AudioData,
  atSeconds: number,
  crossfadeSeconds: number,
  opts: Opts = {},
): Promise<AudioData> {
  return producePool.call<AudioData>('splice', { base, insert, atSeconds, crossfadeSeconds }, opts);
}

export function sliceAudioJob(
  audio: AudioData,
  startSeconds: number,
  endSeconds?: number,
  opts: Opts = {},
): Promise<AudioData> {
  return producePool.call<AudioData>('slice', { audio, startSeconds, endSeconds }, opts);
}

export function matchLoudness(
  audio: AudioData,
  reference: AudioData,
  opts: Opts & { maxGainDb?: number } = {},
): Promise<MatchLoudnessResult> {
  return producePool.call<MatchLoudnessResult>(
    'matchLoudness',
    { audio, reference, maxGainDb: opts.maxGainDb },
    opts,
  );
}

export function loudnessOf(audio: AudioData, opts: Opts = {}): Promise<LoudnessReport> {
  return producePool.call<LoudnessReport>('loudness', audio, opts);
}

export function encodeWavBytes(
  audio: AudioData,
  bitDepth: 16 | 24 | 32 = 24,
  opts: Opts = {},
): Promise<Uint8Array> {
  return producePool.call<Uint8Array>('encodeWav', { audio, bitDepth }, opts);
}

/** Add `src` into the stereo accumulator `acc` (same sample rate), growing it when needed. */
export function accumulate(acc: AudioData | null, src: AudioData): AudioData {
  const n = src.channels[0]?.length ?? 0;
  if (!acc)
    return {
      sampleRate: src.sampleRate,
      channels: [
        Float32Array.from(src.channels[0] ?? []),
        Float32Array.from(src.channels[1] ?? src.channels[0] ?? []),
      ],
    };
  let out = acc;
  if ((acc.channels[0]?.length ?? 0) < n) {
    out = {
      sampleRate: acc.sampleRate,
      channels: acc.channels.map((c) => {
        const grown = new Float32Array(n);
        grown.set(c);
        return grown;
      }),
    };
  }
  for (let c = 0; c < 2; c++) {
    const s = src.channels[Math.min(c, src.channels.length - 1)];
    const d = out.channels[c];
    for (let i = 0; i < s.length; i++) d[i] += s[i];
  }
  return out;
}
