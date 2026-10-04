import type { AudioData } from '@songdeck/audio';
import { jobs } from './jobs';
import type { EncodeArgs, ExportMethod, ExportRequest, ExportResponse, ZipArgs } from './export.worker';
import { MIME } from './export-files';
import { abortable, abortError } from './mix-render';

/**
 * Audio encoding & packaging for exports (spec §55): WAV / FLAC through the job worker,
 * MP3 / AAC / ZIP through the dedicated export worker.
 */

export type AudioFormat = 'wav' | 'flac' | 'mp3' | 'aac';

export const AUDIO_FORMATS: {
  value: AudioFormat;
  label: string;
  ext: string;
  mime: string;
  lossy: boolean;
}[] = [
  { value: 'wav', label: 'WAV', ext: 'wav', mime: MIME.wav, lossy: false },
  { value: 'flac', label: 'FLAC', ext: 'flac', mime: MIME.flac, lossy: false },
  { value: 'mp3', label: 'MP3', ext: 'mp3', mime: MIME.mp3, lossy: true },
  { value: 'aac', label: 'AAC', ext: 'aac', mime: MIME.aac, lossy: true },
];

export function formatInfo(f: AudioFormat) {
  return AUDIO_FORMATS.find((x) => x.value === f)!;
}

export type WavBits = 16 | 24 | 32;
export type FlacBits = 16 | 24;

export interface EncodeOptions {
  format: AudioFormat;
  /** WAV: 16 / 24 / 32 (32 = IEEE float). */
  wavBits?: WavBits;
  /** FLAC: 16 / 24. */
  flacBits?: FlacBits;
  /** MP3 / AAC bitrate. */
  kbps?: number;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
  /** Transfer (detach) the input buffers instead of copying them. Default false. */
  consume?: boolean;
}

/** Human description of an encoding, e.g. "WAV 24-bit · 44.1 kHz". */
export function describeEncoding(
  opts: Pick<EncodeOptions, 'format' | 'wavBits' | 'flacBits' | 'kbps'>,
  sampleRate?: number,
): string {
  const sr = sampleRate ? ` · ${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz` : '';
  switch (opts.format) {
    case 'wav':
      return `WAV ${opts.wavBits === 32 ? '32-bit float' : `${opts.wavBits ?? 24}-bit`}${sr}`;
    case 'flac':
      return `FLAC ${opts.flacBits ?? 24}-bit${sr}`;
    case 'mp3':
      return `MP3 ${opts.kbps ?? 256} kbps${sr}`;
    case 'aac':
      return `AAC ${opts.kbps ?? 256} kbps${sr}`;
  }
}

function channelTransfer(audio: AudioData): Transferable[] {
  const out: Transferable[] = [];
  for (const c of audio.channels)
    if (c.buffer instanceof ArrayBuffer && !out.includes(c.buffer)) out.push(c.buffer);
  return out;
}

export async function encodeAudio(audio: AudioData, opts: EncodeOptions): Promise<Uint8Array> {
  if (opts.signal?.aborted) throw abortError();
  const transfer = opts.consume ? channelTransfer(audio) : undefined;
  switch (opts.format) {
    case 'wav':
      return abortable(
        jobs.call<Uint8Array>(
          'encodeWav',
          { audio, bitDepth: opts.wavBits ?? 24 },
          { signal: opts.signal, transfer },
        ),
        opts.signal,
      );
    case 'flac':
      return abortable(
        jobs.call<Uint8Array>(
          'encodeFlac',
          { audio, bitDepth: opts.flacBits ?? 24 },
          { signal: opts.signal, transfer },
        ),
        opts.signal,
      );
    case 'mp3':
    case 'aac': {
      const args: EncodeArgs = {
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        kbps: opts.kbps ?? 256,
      };
      return exportWorker.call<Uint8Array>(opts.format, args, {
        signal: opts.signal,
        onProgress: opts.onProgress,
        transfer,
      });
    }
  }
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
  /** Deflate the entry (text, MIDI, XML). Audio and nested archives are stored as-is. */
  compress?: boolean;
}

/** Build a ZIP off the main thread. Entry buffers are transferred (detached) to the worker. */
export async function zipEntries(entries: ZipEntry[], signal?: AbortSignal): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const files: ZipArgs['files'] = entries.map((e) => {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    return { name: e.name, data, level: e.compress === false ? 0 : 6 };
  });
  const transfer: Transferable[] = [];
  for (const f of files) {
    const buf = f.data.buffer;
    if (
      buf instanceof ArrayBuffer &&
      f.data.byteOffset === 0 &&
      f.data.byteLength === buf.byteLength &&
      !transfer.includes(buf)
    )
      transfer.push(buf);
  }
  return exportWorker.call<Uint8Array>('zip', { files, mtime: Date.now() } satisfies ZipArgs, {
    signal,
    transfer,
  });
}

// ---------------------------------------------------------------------------
// AAC capability (WebCodecs)
// ---------------------------------------------------------------------------

export interface CodecSupport {
  supported: boolean;
  reason?: string;
}

const aacCache = new Map<string, Promise<CodecSupport>>();

/** Whether this browser can encode AAC-LC with WebCodecs at the given rate/bitrate. */
export function aacSupport(sampleRate: number, kbps: number): Promise<CodecSupport> {
  const key = `${sampleRate}:${kbps}`;
  let p = aacCache.get(key);
  if (!p) {
    p = (async (): Promise<CodecSupport> => {
      const Enc = (globalThis as unknown as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
      if (!Enc)
        return {
          supported: false,
          reason:
            'This browser has no WebCodecs AudioEncoder, so AAC cannot be encoded on-device. Use MP3, FLAC or WAV.',
        };
      try {
        const r = await Enc.isConfigSupported({
          codec: 'mp4a.40.2',
          sampleRate,
          numberOfChannels: 2,
          bitrate: kbps * 1000,
        });
        return r.supported
          ? { supported: true }
          : {
              supported: false,
              reason:
                'This browser’s WebCodecs build has no AAC encoder (common in open-source Chromium and Firefox builds). Use MP3, FLAC or WAV.',
            };
      } catch (err) {
        return {
          supported: false,
          reason: `AAC encoder check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    })();
    aacCache.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Export worker client (with a main-thread fallback)
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number) => void;
}

type CallOpts = { signal?: AbortSignal; onProgress?: (p: number) => void; transfer?: Transferable[] };

const PING_ID = -1;

class ExportWorkerClient {
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  /**
   * Start the worker and wait for it to answer a ping BEFORE any audio is transferred to it:
   * if the module cannot load, nothing has been detached and the main thread can do the work.
   */
  private ensureReady(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.ready = new Promise<boolean>((resolve) => {
      let w: Worker;
      try {
        w = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        w.terminate();
        resolve(false);
      }, 20_000);
      w.onmessage = (ev: MessageEvent<ExportResponse>) => {
        if (ev.data?.id !== PING_ID) return;
        clearTimeout(timer);
        this.attach(w);
        resolve(true);
      };
      w.onerror = (ev) => {
        ev.preventDefault?.();
        clearTimeout(timer);
        w.terminate();
        resolve(false);
      };
      w.postMessage({ id: PING_ID, method: 'ping', args: null } satisfies ExportRequest);
    });
    return this.ready;
  }

  private attach(w: Worker) {
    this.worker = w;
    w.onmessage = (ev: MessageEvent<ExportResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if ('progress' in msg) {
        p.onProgress?.(msg.progress);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = new Error(msg.error);
        if (msg.aborted) err.name = 'AbortError';
        p.reject(err);
      }
    };
    w.onerror = (ev) => {
      const err = new Error(ev.message || 'Export worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      w.terminate();
      this.worker = null;
      this.ready = null; // re-probe on the next call
    };
  }

  async call<T>(
    method: Exclude<ExportMethod, 'cancel' | 'ping'>,
    args: unknown,
    opts: CallOpts = {},
  ): Promise<T> {
    if (opts.signal?.aborted) throw abortError();
    const ok = await this.ensureReady();
    if (!ok || !this.worker) return this.callMainThread<T>(method, args, opts);
    const worker = this.worker;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress });
      opts.signal?.addEventListener(
        'abort',
        () => {
          worker.postMessage({ id: 0, method: 'cancel', args: { target: id } } satisfies ExportRequest);
          // Reject right away; the worker stops at its next checkpoint.
          if (this.pending.delete(id)) reject(abortError());
        },
        { once: true },
      );
      worker.postMessage({ id, method, args } satisfies ExportRequest, opts.transfer ?? []);
    });
  }

  /** Same codecs on the main thread (yielding between blocks) when workers are unavailable. */
  private async callMainThread<T>(
    method: Exclude<ExportMethod, 'cancel' | 'ping'>,
    args: unknown,
    opts: CallOpts,
  ): Promise<T> {
    const codecs = await import('./export-codecs');
    const ctl = {
      onProgress: opts.onProgress,
      checkpoint: async () => {
        await codecs.tick();
        if (opts.signal?.aborted) throw abortError();
      },
    };
    if (method === 'mp3') return (await codecs.encodeMp3(args as EncodeArgs, ctl)) as T;
    if (method === 'aac') return (await codecs.encodeAac(args as EncodeArgs, ctl)) as T;
    const z = args as ZipArgs;
    return codecs.buildZip(z.files, z.mtime) as T;
  }
}

export const exportWorker = new ExportWorkerClient();
