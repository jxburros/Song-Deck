/**
 * Worker-thread pool for render jobs: `size` workers (default max(1, cpus - 1)), a bounded FIFO
 * queue (full → `PoolBusyError`, answered with 429), cancellation (a running job's worker is
 * terminated and replaced), crash isolation and idle-worker reaping. Falls back to inline
 * rendering on the main thread if workers cannot boot (e.g. no TypeScript loader available).
 */
import { Worker } from 'node:worker_threads';
import type { Logger } from '../logger';
import type { RenderKind, RenderResult, WorkerResponse } from './worker';

export class PoolBusyError extends Error {
  constructor() {
    super('All render workers are busy and the queue is full');
    this.name = 'PoolBusyError';
  }
}

export class JobFailedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JobFailedError';
  }
}

interface Job {
  id: number;
  payload: Uint8Array;
  resolve: (r: RenderResult) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  worker?: PoolWorker;
  settled: boolean;
}

interface PoolWorker {
  worker: Worker;
  ready: boolean;
  job?: Job;
  idleTimer?: NodeJS.Timeout;
  dead: boolean;
}

export interface RenderPoolOptions {
  size: number;
  maxQueue: number;
  inline?: boolean;
  logger: Logger;
  workerUrl?: URL;
  /** Terminate workers idle for this long (default 5 min). */
  idleMs?: number;
  /** Inline executor (defaults to worker.ts's runRenderJob). */
  runInline?: (payload: Uint8Array) => Promise<RenderResult>;
}

function abortError(): Error {
  const e = new Error('Render cancelled');
  e.name = 'AbortError';
  return e;
}

/** A fresh, exactly-sized ArrayBuffer that can be transferred without touching shared pools. */
function transferable(payload: Uint8Array): Uint8Array {
  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  return copy;
}

export class RenderPool {
  private readonly workers: PoolWorker[] = [];
  private readonly queue: Job[] = [];
  private readonly running = new Set<Job>();
  private nextId = 1;
  private inlineMode: boolean;
  private bootFailures = 0;
  private consecutiveBootFailures = 0;
  private everReady = false;
  private closed = false;
  /** Kinds reported by the first worker that booted. */
  kinds?: RenderKind[];

  constructor(private readonly opts: RenderPoolOptions) {
    this.inlineMode = Boolean(opts.inline);
  }

  get size(): number {
    return this.inlineMode ? 1 : Math.max(1, this.opts.size);
  }

  get busyJobs(): number {
    return this.running.size;
  }

  get queuedJobs(): number {
    return this.queue.length;
  }

  get maxQueue(): number {
    return this.opts.maxQueue;
  }

  get mode(): 'workers' | 'inline' {
    return this.inlineMode ? 'inline' : 'workers';
  }

  get liveWorkers(): number {
    return this.workers.length;
  }

  /** True when a new job would be rejected with PoolBusyError. */
  isFull(): boolean {
    return this.running.size >= this.size && this.queue.length >= this.opts.maxQueue;
  }

  run(payload: Uint8Array, signal?: AbortSignal): Promise<RenderResult> {
    if (this.closed)
      return Promise.reject(new JobFailedError(503, 'shutting-down', 'Render node is shutting down'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.isFull()) return Promise.reject(new PoolBusyError());
    return new Promise<RenderResult>((resolve, reject) => {
      const job: Job = { id: this.nextId++, payload, resolve, reject, signal, settled: false };
      if (signal) {
        job.onAbort = () => this.cancel(job);
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private settle(
    job: Job,
    outcome: { ok: true; result: RenderResult } | { ok: false; error: unknown },
  ): void {
    if (job.settled) return;
    job.settled = true;
    this.running.delete(job);
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    if (outcome.ok) job.resolve(outcome.result);
    else job.reject(outcome.error);
  }

  private cancel(job: Job): void {
    const qi = this.queue.indexOf(job);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.settle(job, { ok: false, error: abortError() });
      return;
    }
    if (job.worker && !job.settled) {
      // Synchronous DSP cannot be interrupted cooperatively: replace the worker.
      const w = job.worker;
      this.settle(job, { ok: false, error: abortError() });
      this.retire(w);
      void w.worker.terminate();
      this.pump();
    }
  }

  private retire(w: PoolWorker): void {
    w.dead = true;
    clearTimeout(w.idleTimer);
    const i = this.workers.indexOf(w);
    if (i >= 0) this.workers.splice(i, 1);
  }

  private spawn(): PoolWorker {
    const url = this.opts.workerUrl ?? new URL('./worker-entry.mjs', import.meta.url);
    const worker = new Worker(url, { execArgv: [], stdout: false, stderr: false });
    const w: PoolWorker = { worker, ready: false, dead: false };
    worker.on('message', (msg: WorkerResponse | { type: 'boot-error'; message: string }) => {
      if (msg.type === 'ready') {
        w.ready = true;
        this.everReady = true;
        this.consecutiveBootFailures = 0;
        this.kinds ??= msg.kinds;
        this.markIdle(w);
        this.pump();
      } else if (msg.type === 'boot-error') {
        this.opts.logger.warn(`render worker: ${msg.message}`);
      } else if (msg.type === 'result') {
        const job = w.job;
        w.job = undefined;
        if (job && job.id === msg.id) {
          if (msg.ok) this.settle(job, { ok: true, result: msg.result });
          else
            this.settle(job, {
              ok: false,
              error: new JobFailedError(msg.error.status, msg.error.code, msg.error.message),
            });
        }
        this.markIdle(w);
        this.pump();
      }
    });
    worker.on('error', (err) => {
      this.opts.logger.warn(`render worker error: ${err.message}`);
      this.onWorkerGone(w, err);
    });
    worker.on('exit', (code) => {
      if (!w.dead) this.onWorkerGone(w, new Error(`render worker exited with code ${code}`));
    });
    this.workers.push(w);
    return w;
  }

  private onWorkerGone(w: PoolWorker, err: Error): void {
    if (w.dead) return;
    const wasReady = w.ready;
    this.retire(w);
    const job = w.job;
    w.job = undefined;
    if (job)
      this.settle(job, {
        ok: false,
        error: new JobFailedError(500, 'render-crashed', `Render worker crashed: ${err.message}`),
      });
    if (!wasReady && !this.closed) {
      this.bootFailures++;
      this.consecutiveBootFailures++;
      if (!this.everReady && this.bootFailures >= 2) {
        this.opts.logger.warn(
          `render workers could not start (${err.message}); rendering on the main thread instead`,
        );
        this.inlineMode = true;
      } else if (this.everReady && this.consecutiveBootFailures >= 3 && !this.workers.length) {
        // Workers worked before but now keep failing to boot: fail the waiting jobs instead of re-spawning forever.
        this.opts.logger.error(`render workers keep failing to start (${err.message})`);
        for (const job of this.queue.splice(0))
          this.settle(job, {
            ok: false,
            error: new JobFailedError(
              503,
              'render-unavailable',
              `Render workers failed to start: ${err.message}`,
            ),
          });
        this.consecutiveBootFailures = 0;
        return;
      }
    }
    if (!this.closed) setImmediate(() => this.pump());
  }

  private markIdle(w: PoolWorker): void {
    clearTimeout(w.idleTimer);
    w.idleTimer = setTimeout(
      () => {
        if (!w.job && !w.dead) {
          this.retire(w);
          void w.worker.terminate();
        }
      },
      this.opts.idleMs ?? 5 * 60_000,
    );
    w.idleTimer.unref();
  }

  private pump(): void {
    if (this.closed) return;
    if (this.inlineMode) {
      while (this.queue.length && this.running.size < this.size) {
        const job = this.queue.shift() as Job;
        this.running.add(job);
        void this.runInline(job);
      }
      return;
    }
    // Dispatch to idle workers…
    while (this.queue.length) {
      const w = this.workers.find((x) => x.ready && !x.job && !x.dead);
      if (!w) break;
      const job = this.queue.shift() as Job;
      this.running.add(job);
      clearTimeout(w.idleTimer);
      w.job = job;
      job.worker = w;
      const payload = transferable(job.payload);
      w.worker.postMessage({ type: 'job', id: job.id, payload }, [payload.buffer as ArrayBuffer]);
    }
    // …and boot more workers for what is still waiting (they call pump() when ready).
    const booting = this.workers.filter((x) => !x.ready && !x.dead).length;
    let needed = Math.min(this.queue.length - booting, this.size - this.workers.length);
    while (needed-- > 0) this.spawn();
  }

  private async runInline(job: Job): Promise<void> {
    // Yield first so the HTTP layer can flush; then render synchronously.
    await new Promise((r) => setImmediate(r));
    if (job.settled) return;
    try {
      const run =
        this.opts.runInline ??
        (async (payload: Uint8Array) => (await import('./worker')).runRenderJob(payload));
      const result = await run(job.payload);
      this.settle(job, { ok: true, result });
    } catch (err) {
      const { serializeError } = await import('./worker');
      const e = serializeError(err);
      this.settle(job, { ok: false, error: new JobFailedError(e.status, e.code, e.message) });
    } finally {
      this.pump();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0))
      this.settle(job, {
        ok: false,
        error: new JobFailedError(503, 'shutting-down', 'Render node is shutting down'),
      });
    for (const job of [...this.running])
      this.settle(job, {
        ok: false,
        error: new JobFailedError(503, 'shutting-down', 'Render node is shutting down'),
      });
    const workers = this.workers.splice(0);
    for (const w of workers) {
      w.dead = true;
      clearTimeout(w.idleTimer);
    }
    await Promise.all(workers.map((w) => w.worker.terminate().catch(() => undefined)));
  }
}
