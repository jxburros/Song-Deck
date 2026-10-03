import type { JobMethod, JobRequest, JobResponse } from './jobs.worker';
import type { RenderInstrumentConfig } from './render-config';

/**
 * Promise-based client for the job worker. A small pool lets independent jobs
 * (e.g. stem renders and an analysis) run in parallel on multi-core machines.
 */

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number, stage?: string, detail?: unknown) => void;
  worker: Worker;
}

const POOL_SIZE = Math.max(1, Math.min(3, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2) - 1));

class JobPool {
  private workers: Worker[] = [];
  private load = new Map<Worker, number>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private config: RenderInstrumentConfig | null = null;

  /** Instruments every render job needs (sent to current and future workers). */
  configure(config: RenderInstrumentConfig) {
    this.config = config;
    for (const w of this.workers) w.postMessage({ id: 0, method: 'configure', args: config } satisfies JobRequest);
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./jobs.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<JobResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if ('progress' in msg) {
        p.onProgress?.(msg.progress, msg.stage, msg.detail);
        return;
      }
      this.pending.delete(msg.id);
      this.load.set(p.worker, Math.max(0, (this.load.get(p.worker) ?? 1) - 1));
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = new Error(msg.error);
        if (msg.aborted) err.name = 'AbortError';
        p.reject(err);
      }
    };
    w.onerror = (ev) => {
      for (const [id, p] of this.pending) {
        if (p.worker === w) {
          p.reject(new Error(ev.message || 'Job worker crashed'));
          this.pending.delete(id);
        }
      }
    };
    if (this.config) w.postMessage({ id: 0, method: 'configure', args: this.config } satisfies JobRequest);
    this.workers.push(w);
    this.load.set(w, 0);
    return w;
  }

  private pick(): Worker {
    if (this.workers.length < POOL_SIZE) {
      const idle = this.workers.find((w) => (this.load.get(w) ?? 0) === 0);
      if (idle) return idle;
      return this.spawn();
    }
    let best = this.workers[0];
    for (const w of this.workers) if ((this.load.get(w) ?? 0) < (this.load.get(best) ?? 0)) best = w;
    return best;
  }

  call<T>(
    method: JobMethod,
    args: unknown,
    opts: { onProgress?: (p: number, stage?: string, detail?: unknown) => void; signal?: AbortSignal; transfer?: Transferable[] } = {},
  ): Promise<T> {
    const worker = this.pick();
    const id = this.nextId++;
    this.load.set(worker, (this.load.get(worker) ?? 0) + 1);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress, worker });
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
          return;
        }
        opts.signal.addEventListener('abort', () => worker.postMessage({ id: 0, method: 'cancel', args: { target: id } } satisfies JobRequest), {
          once: true,
        });
      }
      worker.postMessage({ id, method, args } satisfies JobRequest, opts.transfer ?? []);
    });
  }
}

export const jobs = new JobPool();

// One worker pool per page: reload instead of hot-swapping.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
