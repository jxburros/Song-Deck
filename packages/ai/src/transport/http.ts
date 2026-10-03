/**
 * HttpClient — the request pipeline shared by all HTTP adapters:
 * concurrency/rate gate → timeout (AbortController) → transport (direct or proxy, auth injection)
 * → normalized ProviderError for non-2xx → retry with backoff on 429/5xx/network (max 2).
 */
import { errorFromStatus, ProviderError, toProviderError } from '../errors';
import type { Transport, TransportAuth } from '../types';
import { toArrayBufferBytes, utf8Decode } from '../util';
import { abortError, type RequestGate, type RetryOptions, withRetry, withTimeout } from './limiter';

export interface HttpClientOptions {
  providerId: string;
  transport: Transport;
  /** Default auth for requests (credentialRef + spec). */
  auth?: TransportAuth;
  timeoutMs?: number;
  gate?: RequestGate;
  retry?: RetryOptions;
  /** Headers added to every request. */
  headers?: Record<string, string>;
}

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  /** JSON body (sets content-type). */
  json?: unknown;
  /** Raw body (string or bytes). */
  body?: Uint8Array | string;
  contentType?: string;
  accept?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Set false to disable retries (e.g. non-idempotent expensive generations). Default true. */
  retry?: boolean;
  /** Override auth; `null` sends no credentials. */
  auth?: TransportAuth | null;
}

export interface BytesResult {
  data: Uint8Array;
  contentType: string;
  headers: Headers;
  status: number;
}

/** Default retry predicate for HTTP: rate limits, 5xx and network failures — not timeouts (expensive calls). */
export function isRetryableHttpError(err: ProviderError): boolean {
  return err.kind === 'rate-limit' || err.kind === 'unavailable' || err.kind === 'network';
}

async function readErrorBody(res: Response): Promise<unknown> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

export class HttpClient {
  constructor(readonly opts: HttpClientOptions) {}

  get providerId(): string {
    return this.opts.providerId;
  }

  /** Perform a request and hand the successful Response to `read` (inside the timeout scope). */
  async send<T>(req: HttpRequestOptions, read: (res: Response) => Promise<T>): Promise<T> {
    const providerId = this.opts.providerId;
    const timeoutMs = req.timeoutMs ?? this.opts.timeoutMs;
    const headers: Record<string, string> = { ...(this.opts.headers ?? {}), ...(req.headers ?? {}) };
    let body: RequestInit['body'] | undefined;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] = req.contentType ?? 'application/json';
    } else if (req.body !== undefined) {
      body = typeof req.body === 'string' ? req.body : toArrayBufferBytes(req.body);
      if (req.contentType) headers['content-type'] = req.contentType;
    }
    if (req.accept) headers.accept = req.accept;
    const auth = req.auth === null ? undefined : (req.auth ?? this.opts.auth);
    const attempt = async (): Promise<T> => {
      const run = async () => {
        const t = withTimeout(req.signal, timeoutMs);
        try {
          const res = await this.opts.transport.fetch(req.url, { method: req.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body, signal: t.signal }, auth);
          if (!res.ok) {
            const errBody = await readErrorBody(res);
            throw errorFromStatus(res.status, errBody, { providerId, retryAfter: res.headers.get('retry-after') });
          }
          return await read(res);
        } catch (err) {
          if (t.signal.aborted && !(err instanceof ProviderError && err.status)) throw abortError(t, providerId, timeoutMs);
          throw toProviderError(err, providerId);
        } finally {
          t.dispose();
        }
      };
      return this.opts.gate ? this.opts.gate.run(run, req.signal) : run();
    };
    if (req.retry === false) return attempt();
    return withRetry(attempt, { isRetryable: isRetryableHttpError, ...(this.opts.retry ?? {}) }, req.signal, providerId);
  }

  async json<T = unknown>(req: HttpRequestOptions): Promise<T> {
    return this.send(req, async (res) => {
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ProviderError('parse', `Invalid JSON from ${this.opts.providerId}: ${text.slice(0, 200)}`, { providerId: this.opts.providerId, status: res.status });
      }
    });
  }

  async text(req: HttpRequestOptions): Promise<string> {
    return this.send(req, (res) => res.text());
  }

  /** Binary response (audio). A JSON body on a binary endpoint is treated as an error report. */
  async bytes(req: HttpRequestOptions): Promise<BytesResult> {
    return this.send(req, async (res) => {
      const data = new Uint8Array(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      if (/json/i.test(contentType) && data.length < 1_000_000) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(utf8Decode(data));
        } catch {
          parsed = undefined;
        }
        const p = parsed as Record<string, unknown> | undefined;
        if (p && (p.error || p.errors || p.detail || p.message)) {
          throw errorFromStatus(422, p, { providerId: this.opts.providerId });
        }
      }
      return { data, contentType, headers: res.headers, status: res.status };
    });
  }
}
