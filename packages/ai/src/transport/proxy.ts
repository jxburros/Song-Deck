/**
 * ServerProxyTransport — routes every provider request through the local Song Deck server so API
 * keys never reach the browser (spec §7: keys live in the OS keychain via the server vault).
 *
 * ## Proxy contract (implemented by apps/server)
 *
 * `POST {serverUrl}/api/proxy` with JSON body:
 * ```json
 * {
 *   "url": "https://api.anthropic.com/v1/messages",   // absolute upstream URL
 *   "method": "POST",
 *   "headers": { "content-type": "application/json", "anthropic-version": "2023-06-01" },
 *   "body": "<string>",                                  // optional
 *   "bodyEncoding": "utf8" | "base64",                   // base64 for binary bodies (multipart, audio)
 *   "credentialRef": "provider:anthropic",               // optional vault reference
 *   "auth": { "type": "bearer" | "header" | "query" | "none", "name": "x-api-key", "prefix": "" }
 * }
 * ```
 * The server resolves `credentialRef` in its vault and injects the secret according to `auth`
 * (bearer → `Authorization: <prefix ?? "Bearer ">secret`; header → `<name>: <prefix>secret`
 * (overwriting any placeholder such as the SDK's `x-api-key: proxy-managed`); query →
 * `?<name>=secret`), performs the upstream request, and passes the upstream status, headers and
 * body back unchanged (binary-safe; it must drop `content-encoding`/`content-length` when it
 * relays a decompressed body). Failures of the proxy itself (vault miss, upstream unreachable,
 * invalid envelope) are answered with `502 {"error": "<message>"}` and the header
 * `x-songdeck-proxy-error: 1`. The server should abort the upstream request when the client
 * disconnects (cancellation).
 */
import { ProviderError } from '../errors';
import type { Transport, TransportAuth } from '../types';
import { bytesToBase64, joinUrl, toArrayBufferBytes, utf8Decode } from '../util';
import type { FetchLike } from './direct';

export interface ProxyEnvelope {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
  credentialRef?: string;
  auth?: { type: TransportAuth['type']; name?: string; prefix?: string };
}

export const PROXY_ERROR_HEADER = 'x-songdeck-proxy-error';

export interface ServerProxyTransportOptions {
  fetch?: FetchLike;
  /** Extra headers for the server itself (e.g. a local session token). */
  headers?: Record<string, string>;
  /** Proxy path (default '/api/proxy'). */
  path?: string;
}

const DROP_REQUEST_HEADERS = new Set(['content-length', 'host', 'connection', 'transfer-encoding']);

/** Serialize a fetch body for the proxy envelope (string → utf8, everything else → base64). */
export async function encodeBodyForEnvelope(
  body: RequestInit['body'] | undefined | null,
): Promise<{ body?: string; bodyEncoding?: 'utf8' | 'base64'; contentType?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') return { body, bodyEncoding: 'utf8' };
  if (body instanceof Uint8Array) return { body: bytesToBase64(body), bodyEncoding: 'base64' };
  if (body instanceof ArrayBuffer)
    return { body: bytesToBase64(new Uint8Array(body)), bodyEncoding: 'base64' };
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return {
      body: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
      bodyEncoding: 'base64',
    };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      bodyEncoding: 'utf8',
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  // Blob, FormData, ReadableStream: let Response serialize it (also yields the multipart boundary).
  const r = new Response(body as ConstructorParameters<typeof Response>[0]);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return {
    body: bytesToBase64(bytes),
    bodyEncoding: 'base64',
    contentType: r.headers.get('content-type') ?? undefined,
  };
}

function headersToRecord(h: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((value, key) => {
    if (!DROP_REQUEST_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  });
  return out;
}

export async function buildProxyEnvelope(
  url: string,
  init: RequestInit = {},
  auth?: TransportAuth,
): Promise<ProxyEnvelope> {
  const headers = headersToRecord(init.headers);
  const encoded = await encodeBodyForEnvelope(init.body);
  if (encoded.contentType && !headers['content-type']) headers['content-type'] = encoded.contentType;
  const envelope: ProxyEnvelope = {
    url,
    method: (init.method ?? 'GET').toUpperCase(),
    headers,
  };
  if (encoded.body !== undefined) {
    envelope.body = encoded.body;
    envelope.bodyEncoding = encoded.bodyEncoding;
  }
  if (auth && auth.type !== 'none') {
    envelope.credentialRef = auth.credentialRef;
    envelope.auth = {
      type: auth.type,
      ...(auth.name ? { name: auth.name } : {}),
      ...(auth.prefix !== undefined ? { prefix: auth.prefix } : {}),
    };
  } else if (auth) {
    envelope.auth = { type: 'none' };
  }
  return envelope;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export class ServerProxyTransport implements Transport {
  readonly kind = 'proxy';
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;

  constructor(
    readonly serverUrl: string,
    private readonly opts: ServerProxyTransportOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.endpoint = joinUrl(serverUrl.replace(/\/+$/, ''), opts.path ?? '/api/proxy');
  }

  async fetch(url: string, init: RequestInit = {}, auth?: TransportAuth): Promise<Response> {
    const envelope = await buildProxyEnvelope(url, init, auth);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.headers ?? {}) },
        body: JSON.stringify(envelope),
        signal: init.signal ?? undefined,
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw err;
      throw new ProviderError(
        'network',
        `Song Deck server unreachable at ${this.endpoint}: ${e?.message ?? String(err)}`,
        { cause: err },
      );
    }
    if (res.headers.get(PROXY_ERROR_HEADER)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      let message = `Proxy error (HTTP ${res.status})`;
      try {
        const parsed = JSON.parse(utf8Decode(bytes)) as { error?: string };
        if (parsed?.error) message = `Proxy error: ${parsed.error}`;
      } catch {
        /* not JSON */
      }
      throw new ProviderError(/credential|secret|vault/i.test(message) ? 'auth' : 'network', message, {
        status: res.status,
      });
    }
    // Rebuild a standalone Response so callers can read the (binary) body regardless of runtime.
    const bytes = NULL_BODY_STATUS.has(res.status)
      ? null
      : toArrayBufferBytes(new Uint8Array(await res.arrayBuffer()));
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(bytes, { status: res.status, statusText: res.statusText, headers });
  }
}
