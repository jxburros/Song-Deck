/// <reference lib="webworker" />
/**
 * Export worker: lossy encoders and packaging that the main job worker does not provide
 * (MP3 via LAME, AAC via WebCodecs + ADTS, ZIP via fflate). The codecs live in
 * `export-codecs.ts`, shared with the main-thread fallback.
 */
import { buildZip, encodeAac, encodeMp3, tick, type PcmInput, type ZipFileInput } from './export-codecs';

declare const self: DedicatedWorkerGlobalScope;

export type ExportMethod = 'mp3' | 'aac' | 'zip' | 'cancel' | 'ping';

export interface ExportRequest {
  id: number;
  method: ExportMethod;
  args: unknown;
}

export type ExportResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; aborted?: boolean }
  | { id: number; progress: number };

export type EncodeArgs = PcmInput;

export interface ZipArgs {
  files: ZipFileInput[];
  /** Modification time stamped on every entry (ms since epoch). */
  mtime?: number;
}

const cancelled = new Set<number>();

function abortError(): Error {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

function transferOf(v: unknown): Transferable[] {
  if (v instanceof Uint8Array && v.buffer instanceof ArrayBuffer) return [v.buffer];
  return [];
}

self.onmessage = async (ev: MessageEvent<ExportRequest>) => {
  const req = ev.data;
  if (req.method === 'cancel') {
    cancelled.add((req.args as { target: number }).target);
    return;
  }
  if (req.method === 'ping') {
    self.postMessage({ id: req.id, ok: true, result: 'pong' } satisfies ExportResponse);
    return;
  }
  const ctl = {
    onProgress: (p: number) => self.postMessage({ id: req.id, progress: p } satisfies ExportResponse),
    checkpoint: async () => {
      await tick();
      if (cancelled.has(req.id)) throw abortError();
    },
  };
  try {
    let result: unknown;
    switch (req.method) {
      case 'mp3':
        result = await encodeMp3(req.args as EncodeArgs, ctl);
        break;
      case 'aac':
        result = await encodeAac(req.args as EncodeArgs, ctl);
        break;
      case 'zip': {
        const a = req.args as ZipArgs;
        result = buildZip(a.files, a.mtime);
        break;
      }
      default:
        throw new Error(`Unknown export method: ${req.method}`);
    }
    self.postMessage({ id: req.id, ok: true, result } satisfies ExportResponse, transferOf(result));
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err), aborted } satisfies ExportResponse);
  } finally {
    cancelled.delete(req.id);
  }
};
