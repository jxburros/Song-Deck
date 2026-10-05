/**
 * Provider proxy — `POST /api/proxy` — lets the browser call cloud and local AI providers without
 * ever holding an API key (spec §7). Implements the contract documented in
 * `packages/ai/src/transport/proxy.ts` (ServerProxyTransport):
 *
 *   { url, method, headers, body?, bodyEncoding?: 'utf8'|'base64', credentialRef?, auth? }
 *
 * Security model:
 *  - Only URLs inside the allowlist are forwarded: the base URLs (origin + path prefix) of the
 *    providers registered with `PUT /api/providers`, plus loopback hosts (local model servers).
 *  - A credential is injected only into URLs that belong to a provider configured with that very
 *    `credentialRef` — a key can never be sent to another provider or to an arbitrary local port.
 *  - Cookies are stripped both ways; hop-by-hop headers are dropped; redirects are followed only
 *    to allowlisted URLs and credentials are dropped when a redirect leaves the provider's scope.
 *  - Failures of the proxy itself carry `x-songdeck-proxy-error: 1` so the client can tell them
 *    apart from upstream responses (which are relayed unchanged, binary-safe, streaming).
 */
import type { ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isLoopbackHost } from './config';
import { HttpError, isPlainObject, readJson } from './http-util';
import type { Logger } from './logger';
import { type AllowRule, type ProviderStore, ruleMatches } from './providers';
import type { Router } from './router';
import type { CredentialVault } from './vault/types';

export const PROXY_ERROR_HEADER = 'x-songdeck-proxy-error';

export interface ProxyEnvelope {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
  credentialRef?: string;
  auth?: { type: 'bearer' | 'header' | 'query' | 'none'; name?: string; prefix?: string };
}

export interface ProxyDeps {
  getVault(): CredentialVault;
  providers: ProviderStore;
  fetch: typeof fetch;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  logger: Logger;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Request headers never forwarded upstream. */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length',
  'expect',
  'cookie',
  'cookie2',
  'origin',
  'referer',
  'accept-encoding',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

/** Response headers never relayed to the browser. */
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
  // fetch() already decoded the body, so the original encoding/length no longer apply.
  'content-encoding',
  'content-length',
  'alt-svc',
  'clear-site-data',
  'strict-transport-security',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
]);

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const MAX_REDIRECTS = 5;

function proxyError(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message, { headers: { [PROXY_ERROR_HEADER]: '1' } });
}

function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/_-]*={0,2}$/.test(s.replace(/\s+/g, ''));
}

export function validateEnvelope(body: unknown): ProxyEnvelope {
  if (!isPlainObject(body)) throw proxyError(400, 'invalid-envelope', 'Proxy body must be a JSON object');
  const e = body as Record<string, unknown>;
  if (typeof e.url !== 'string' || !e.url) throw proxyError(400, 'invalid-envelope', 'url is required');
  if (e.method !== undefined && (typeof e.method !== 'string' || !METHODS.has(e.method.toUpperCase()))) {
    throw proxyError(400, 'invalid-envelope', `method must be one of ${[...METHODS].join(', ')}`);
  }
  if (e.headers !== undefined && e.headers !== null) {
    if (!isPlainObject(e.headers))
      throw proxyError(400, 'invalid-envelope', 'headers must be an object of strings');
    for (const v of Object.values(e.headers))
      if (typeof v !== 'string') throw proxyError(400, 'invalid-envelope', 'header values must be strings');
  }
  if (e.body !== undefined && e.body !== null && typeof e.body !== 'string')
    throw proxyError(400, 'invalid-envelope', 'body must be a string');
  if (e.bodyEncoding !== undefined && e.bodyEncoding !== 'utf8' && e.bodyEncoding !== 'base64') {
    throw proxyError(400, 'invalid-envelope', "bodyEncoding must be 'utf8' or 'base64'");
  }
  if (e.credentialRef !== undefined && e.credentialRef !== null && typeof e.credentialRef !== 'string') {
    throw proxyError(400, 'invalid-envelope', 'credentialRef must be a string');
  }
  if (e.auth !== undefined && e.auth !== null) {
    const a = e.auth as Record<string, unknown>;
    if (!isPlainObject(a) || !['bearer', 'header', 'query', 'none'].includes(String(a.type))) {
      throw proxyError(400, 'invalid-envelope', 'auth.type must be bearer, header, query or none');
    }
    if (a.name !== undefined && typeof a.name !== 'string')
      throw proxyError(400, 'invalid-envelope', 'auth.name must be a string');
    if (a.prefix !== undefined && typeof a.prefix !== 'string')
      throw proxyError(400, 'invalid-envelope', 'auth.prefix must be a string');
  }
  return {
    url: e.url,
    method: typeof e.method === 'string' ? e.method.toUpperCase() : 'GET',
    headers: (e.headers as Record<string, string> | undefined) ?? {},
    body: typeof e.body === 'string' ? e.body : undefined,
    bodyEncoding: (e.bodyEncoding as ProxyEnvelope['bodyEncoding']) ?? 'utf8',
    credentialRef: typeof e.credentialRef === 'string' && e.credentialRef ? e.credentialRef : undefined,
    auth: (e.auth as ProxyEnvelope['auth']) ?? undefined,
  };
}

/** Whether `url` may be contacted at all (loopback, or inside a registered provider's base URL). */
export function isAllowlisted(url: URL, rules: readonly AllowRule[], method = 'GET'): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (isLoopbackHost(url.hostname)) return true;
  const download = method === 'GET' || method === 'HEAD';
  return rules.some((r) => (download || !r.downloadHost) && ruleMatches(r, url));
}

/** Whether the secret behind `credentialRef` may be sent to `url` (never to download hosts). */
export function credentialInScope(url: URL, credentialRef: string, rules: readonly AllowRule[]): boolean {
  return rules.some((r) => !r.downloadHost && r.credentialRef === credentialRef && ruleMatches(r, url));
}

interface Prepared {
  url: string;
  headers: Headers;
}

/** Sanitized client headers + injected credential (when in scope for `target`). */
function prepareRequest(
  target: URL,
  clientHeaders: Record<string, string>,
  auth: ProxyEnvelope['auth'],
  credential: { ref: string; secret: string } | undefined,
  rules: readonly AllowRule[],
): Prepared {
  const headers = new Headers();
  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (
      DROP_REQUEST_HEADERS.has(lower) ||
      lower.startsWith('proxy-') ||
      lower.startsWith('sec-') ||
      lower.startsWith('x-songdeck-')
    )
      continue;
    try {
      headers.set(lower, value);
    } catch {
      throw proxyError(400, 'invalid-envelope', `Invalid header ${JSON.stringify(name)}`);
    }
  }
  const url = new URL(target.toString());
  if (credential && auth?.type === 'query' && !credentialInScope(target, credential.ref, rules)) {
    // A redirect left the provider's scope: never carry an echoed query credential along.
    const name = auth.name ?? 'key';
    if (url.searchParams.getAll(name).includes(`${auth.prefix ?? ''}${credential.secret}`))
      url.searchParams.delete(name);
  }
  if (credential && auth && auth.type !== 'none' && credentialInScope(target, credential.ref, rules)) {
    switch (auth.type) {
      case 'bearer':
        headers.set(
          (auth.name ?? 'authorization').toLowerCase(),
          `${auth.prefix ?? 'Bearer '}${credential.secret}`,
        );
        break;
      case 'header':
        // Overrides placeholders such as the Anthropic SDK's `x-api-key: proxy-managed`.
        headers.set((auth.name ?? 'authorization').toLowerCase(), `${auth.prefix ?? ''}${credential.secret}`);
        break;
      case 'query':
        url.searchParams.set(auth.name ?? 'key', `${auth.prefix ?? ''}${credential.secret}`);
        break;
    }
  }
  return { url: url.toString(), headers };
}

function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause;
  if (cause?.code || cause?.message) return [cause.code, cause.message].filter(Boolean).join(': ');
  return e?.message ?? String(err);
}

async function relay(
  res: ServerResponse,
  upstream: Response,
  method: string,
  maxBytes: number,
): Promise<void> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-')) return;
    headers[lower] = value;
  });
  headers['cache-control'] ??= 'no-store';
  const status = upstream.status >= 200 && upstream.status <= 599 ? upstream.status : 502;
  const hasBody = upstream.body && method !== 'HEAD' && !NULL_BODY.has(status);
  res.writeHead(status, headers);
  if (!hasBody || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    res.end();
    return;
  }
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) cb(new Error(`Upstream response exceeds ${maxBytes} bytes`));
      else cb(null, chunk);
    },
  });
  const source = Readable.fromWeb(
    upstream.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
  );
  try {
    await pipeline(source, limiter, res);
  } catch {
    // Headers are already sent: the only way to signal failure is to abort the response.
    if (!res.destroyed) res.destroy();
  }
}

export function registerProxyRoutes(router: Router, deps: ProxyDeps): void {
  router.post('/api/proxy', async ({ req, res, signal }) => {
    let envelope: ProxyEnvelope;
    try {
      envelope = validateEnvelope(await readJson<unknown>(req, deps.maxRequestBytes));
    } catch (err) {
      if (err instanceof HttpError && !err.headers?.[PROXY_ERROR_HEADER]) {
        throw new HttpError(err.status, err.code, err.message, {
          headers: { ...(err.headers ?? {}), [PROXY_ERROR_HEADER]: '1' },
        });
      }
      throw err;
    }

    let target: URL;
    try {
      target = new URL(envelope.url);
    } catch {
      throw proxyError(400, 'invalid-url', 'url must be an absolute http(s) URL');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:')
      throw proxyError(400, 'invalid-url', 'Only http and https URLs can be proxied');
    if (target.username || target.password)
      throw proxyError(400, 'invalid-url', 'URLs with embedded credentials are not proxied');

    const rules = deps.providers.allowlist();
    if (!isAllowlisted(target, rules, (envelope.method ?? 'GET').toUpperCase())) {
      throw proxyError(
        403,
        'not-allowlisted',
        `${target.origin}${target.pathname} is not in the proxy allowlist (register the provider's base URL with PUT /api/providers)`,
      );
    }

    const method = envelope.method ?? 'GET';
    const auth = envelope.auth ?? (envelope.credentialRef ? { type: 'bearer' as const } : undefined);
    let credential: { ref: string; secret: string } | undefined;
    if (auth && auth.type !== 'none') {
      if (!envelope.credentialRef)
        throw proxyError(
          502,
          'credential-missing',
          'No credential configured for this provider (add an API key in Settings → Providers)',
        );
      if (!credentialInScope(target, envelope.credentialRef, rules)) {
        throw proxyError(
          403,
          'credential-scope',
          `Credential "${envelope.credentialRef}" is not bound to a registered provider whose base URL covers ${target.origin}${target.pathname}`,
        );
      }
      let secret: string | undefined;
      try {
        secret = await deps.getVault().get(envelope.credentialRef);
      } catch (err) {
        throw proxyError(
          502,
          'vault-error',
          `The credential vault could not be read: ${(err as Error).message}`,
        );
      }
      if (secret === undefined || secret === '') {
        throw proxyError(
          502,
          'credential-missing',
          `No secret stored for credential "${envelope.credentialRef}" in the vault`,
        );
      }
      credential = { ref: envelope.credentialRef, secret };
    }

    let body: Buffer | undefined;
    if (envelope.body !== undefined) {
      if (method === 'GET' || method === 'HEAD')
        throw proxyError(400, 'invalid-envelope', `${method} requests cannot have a body`);
      if (envelope.bodyEncoding === 'base64') {
        if (!isBase64(envelope.body)) throw proxyError(400, 'invalid-envelope', 'body is not valid base64');
        body = Buffer.from(envelope.body, 'base64');
      } else {
        body = Buffer.from(envelope.body, 'utf8');
      }
    }

    const timeout = AbortSignal.timeout(deps.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const started = Date.now();
    let current = target;
    let currentMethod = method;
    let currentBody = body;
    let clientHeaders = envelope.headers ?? {};
    let upstream: Response;
    for (let hop = 0; ; hop++) {
      const prepared = prepareRequest(current, clientHeaders, auth, credential, rules);
      try {
        upstream = await deps.fetch(prepared.url, {
          method: currentMethod,
          headers: prepared.headers,
          body: currentBody
            ? new Uint8Array(currentBody.buffer, currentBody.byteOffset, currentBody.byteLength)
            : undefined,
          redirect: 'manual',
          signal: combined,
        });
      } catch (err) {
        if (signal.aborted) return; // client went away; nothing to answer
        if (timeout.aborted || (err as Error)?.name === 'TimeoutError') {
          throw proxyError(
            504,
            'upstream-timeout',
            `Upstream ${current.origin} did not respond within ${Math.round(deps.timeoutMs / 1000)} s`,
          );
        }
        throw proxyError(
          502,
          'upstream-error',
          `Upstream request to ${current.origin} failed: ${describeFetchError(err)}`,
        );
      }
      const location = upstream.headers.get('location');
      if (!REDIRECTS.has(upstream.status) || !location) break;
      await upstream.body?.cancel().catch(() => undefined);
      if (hop + 1 > MAX_REDIRECTS)
        throw proxyError(502, 'too-many-redirects', `Upstream ${target.origin} redirected too many times`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw proxyError(502, 'bad-redirect', 'Upstream sent an invalid redirect location');
      }
      if (next.username || next.password)
        throw proxyError(502, 'bad-redirect', 'Redirect URLs with embedded credentials are not proxied');
      if (!isAllowlisted(next, rules, currentMethod)) {
        throw proxyError(
          502,
          'redirect-not-allowlisted',
          `Upstream redirected to ${next.origin}${next.pathname}, which is not in the proxy allowlist`,
        );
      }
      // Client-supplied secrets need the same boundary as vault credentials. Drop them
      // permanently after leaving the origin (or the configured credential's path scope).
      if (next.origin !== current.origin || (credential && !credentialInScope(next, credential.ref, rules))) {
        const sensitive = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']);
        if (auth?.type === 'bearer' || auth?.type === 'header')
          sensitive.add((auth.name ?? 'authorization').toLowerCase());
        clientHeaders = Object.fromEntries(
          Object.entries(clientHeaders).filter(([name]) => !sensitive.has(name.toLowerCase())),
        );
      }
      if (
        upstream.status === 303 ||
        ((upstream.status === 301 || upstream.status === 302) && currentMethod === 'POST')
      ) {
        currentMethod = currentMethod === 'HEAD' ? 'HEAD' : 'GET';
        currentBody = undefined;
        clientHeaders = Object.fromEntries(
          Object.entries(clientHeaders).filter(([k]) => !/^content-/i.test(k)),
        );
      }
      current = next;
    }
    deps.logger.debug(
      `proxy ${method} ${current.origin}${current.pathname} → ${upstream.status} (${Date.now() - started} ms)`,
    );
    await relay(res, upstream, currentMethod, deps.maxResponseBytes);
  });
}
