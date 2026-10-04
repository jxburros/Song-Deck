/**
 * Request scheduling primitives: per-provider concurrency semaphore, requests-per-minute
 * limiter, timeouts with AbortController, cancellation, and retry with backoff (max 2 retries on
 * 429/5xx/network by default).
 */
import { ProviderError, toProviderError } from '../errors';
import { abortReason, sleep } from '../util';

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, signal),
};

/** Counting semaphore with abortable waits (FIFO). */
export class Semaphore {
  private active = 0;
  private readonly queue: {
    resolve: () => void;
    reject: (e: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }[] = [];

  constructor(private max: number) {
    if (!(max >= 1)) this.max = 1;
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  setMax(max: number): void {
    this.max = Math.max(1, Math.floor(max));
    this.drain();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const entry: (typeof this.queue)[number] = { resolve, reject, signal };
      if (signal) {
        entry.onAbort = () => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.queue.push(entry);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.max && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.active++;
      next.resolve();
    }
  }
}

/** Sliding-window requests-per-minute limiter. */
export class RateLimiter {
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly requestsPerMinute: number,
    private readonly clock: Clock = systemClock,
    private readonly windowMs = 60_000,
  ) {}

  /** Resolves when a request may start (serialized so bursts queue fairly). */
  acquire(signal?: AbortSignal): Promise<void> {
    const run = async () => {
      for (;;) {
        if (signal?.aborted) throw abortReason(signal);
        const now = this.clock.now();
        this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
        if (this.stamps.length < this.requestsPerMinute) {
          this.stamps.push(now);
          return;
        }
        const wait = this.windowMs - (now - this.stamps[0]) + 1;
        await this.clock.sleep(wait, signal);
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export interface RequestGateOptions {
  concurrency?: number;
  requestsPerMinute?: number;
  clock?: Clock;
}

/** Concurrency + rate limit for one provider. */
export class RequestGate {
  readonly semaphore: Semaphore;
  private readonly limiter?: RateLimiter;

  constructor(opts: RequestGateOptions = {}) {
    this.semaphore = new Semaphore(opts.concurrency ?? 4);
    if (opts.requestsPerMinute && opts.requestsPerMinute > 0)
      this.limiter = new RateLimiter(opts.requestsPerMinute, opts.clock);
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.semaphore.acquire(signal);
    try {
      if (this.limiter) await this.limiter.acquire(signal);
      return await fn();
    } finally {
      release();
    }
  }
}

export interface RetryOptions {
  /** Max retries after the first attempt (default 2). */
  retries?: number;
  /** First backoff delay (default 500 ms), doubled each retry. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  clock?: Clock;
  /** Default: ProviderError.retryable (429, 5xx, network, timeout). */
  isRetryable?(err: ProviderError): boolean;
  onRetry?(err: ProviderError, attempt: number, delayMs: number): void;
}

/** Run `fn` with retry + exponential backoff (honors Retry-After). Errors are normalized to ProviderError. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
  signal?: AbortSignal,
  providerId?: string,
): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 20_000;
  const clock = opts.clock ?? systemClock;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (raw) {
      const err = toProviderError(raw, providerId);
      if (signal?.aborted)
        throw err.kind === 'cancelled' || err.kind === 'timeout'
          ? err
          : toProviderError(abortReason(signal), providerId);
      const retryable = opts.isRetryable ? opts.isRetryable(err) : err.retryable;
      if (!retryable || attempt >= retries) throw err;
      const backoff = Math.min(maxDelay, base * 2 ** attempt);
      const delay = Math.min(maxDelay, Math.max(backoff, err.retryAfterMs ?? 0));
      opts.onRetry?.(err, attempt + 1, delay);
      await clock.sleep(delay, signal);
    }
  }
}

export interface TimeoutHandle {
  signal: AbortSignal;
  dispose(): void;
  timedOut(): boolean;
}

/**
 * Combine an optional caller signal with a timeout. When the timeout fires, the returned signal
 * aborts with a `TimeoutError`.
 */
export function withTimeout(parent: AbortSignal | undefined, timeoutMs: number | undefined): TimeoutHandle {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = () => controller.abort(parent?.reason ?? abortReason(parent));
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason ?? abortReason(parent));
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  if (timeoutMs && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      timedOut = true;
      const e = new Error(`Timed out after ${timeoutMs} ms`);
      e.name = 'TimeoutError';
      controller.abort(e);
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Race a promise against a signal (for operations that do not accept a signal themselves). */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
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

/** Normalize an abort caused by a timeout handle into the right ProviderError kind. */
export function abortError(handle: TimeoutHandle, providerId?: string, timeoutMs?: number): ProviderError {
  if (handle.timedOut())
    return new ProviderError('timeout', `Request timed out after ${timeoutMs ?? '?'} ms`, { providerId });
  return new ProviderError('cancelled', 'Request cancelled', { providerId });
}
