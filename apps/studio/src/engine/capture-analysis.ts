import type { AudioData, RebuildReport } from '@songdeck/audio';
import type { Song } from '@songdeck/core';
import type { CaptureWorkerRequest, CaptureWorkerResponse } from './capture-analysis.worker';

/** Client for `capture-analysis.worker.ts` (Rebuild with provider-separated stems). */

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number, stage?: string, detail?: unknown) => void;
}

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./capture-analysis.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<CaptureWorkerResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if ('progress' in msg) {
      p.onProgress?.(msg.progress, msg.stage, msg.detail);
      return;
    }
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error(msg.error), msg.aborted ? { name: 'AbortError' } : {}));
  };
  w.onerror = (ev) => {
    for (const [id, p] of pending) {
      p.reject(new Error(ev.message || 'Analysis worker crashed'));
      pending.delete(id);
    }
    worker = null;
  };
  worker = w;
  return w;
}

export type FourStems = { drums: AudioData; bass: AudioData; vocals: AudioData; other: AudioData };

export function rebuildWithStems(
  audio: AudioData,
  title: string,
  stems: FourStems,
  opts: { signal?: AbortSignal; onProgress?: (p: number, stage?: string, detail?: unknown) => void } = {},
): Promise<{ song: Song; report: RebuildReport }> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress });
    opts.signal?.addEventListener(
      'abort',
      () => {
        w.postMessage({ id: 0, method: 'cancel', args: { target: id } } satisfies CaptureWorkerRequest);
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          p.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
        }
      },
      { once: true },
    );
    w.postMessage({
      id,
      method: 'rebuildWithStems',
      args: { audio, title, stems },
    } satisfies CaptureWorkerRequest);
  });
}
