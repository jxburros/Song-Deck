/**
 * DirectTransport — calls providers with the runtime's global `fetch` (browser or Node 20+),
 * injecting the secret from a CredentialStore according to the auth spec.
 *
 * In the browser this exposes the key to the page; prefer `ServerProxyTransport` (keys stay in
 * the server vault / OS keychain, spec §7) whenever the local server is available.
 */
import { ProviderError } from '../errors';
import type { CredentialStore, Transport, TransportAuth } from '../types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DirectTransportOptions {
  /** Fetch implementation (default: globalThis.fetch). */
  fetch?: FetchLike;
}

/** Apply an auth spec + secret to a URL and headers (shared by DirectTransport and server proxies). */
export function applyAuth(
  url: string,
  headers: Headers,
  auth: TransportAuth | undefined,
  secret: string | undefined,
): string {
  if (!auth || auth.type === 'none' || secret === undefined) return url;
  switch (auth.type) {
    case 'bearer':
      headers.set(auth.name ?? 'Authorization', `${auth.prefix ?? 'Bearer '}${secret}`);
      return url;
    case 'header':
      headers.set(auth.name ?? 'Authorization', `${auth.prefix ?? ''}${secret}`);
      return url;
    case 'query': {
      const u = new URL(url);
      u.searchParams.set(auth.name ?? 'key', `${auth.prefix ?? ''}${secret}`);
      return u.toString();
    }
    default:
      return url;
  }
}

export class DirectTransport implements Transport {
  readonly kind = 'direct';
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly credentials?: CredentialStore,
    opts: DirectTransportOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async fetch(url: string, init: RequestInit = {}, auth?: TransportAuth): Promise<Response> {
    const headers = new Headers(init.headers);
    let finalUrl = url;
    if (auth && auth.type !== 'none') {
      if (!auth.credentialRef) {
        throw new ProviderError(
          'auth',
          'No credential configured for this provider (add an API key in Settings → Providers)',
        );
      }
      const secret = this.credentials ? await this.credentials.get(auth.credentialRef) : undefined;
      if (secret === undefined || secret === '') {
        throw new ProviderError('auth', `No secret stored for credential "${auth.credentialRef}"`);
      }
      finalUrl = applyAuth(url, headers, auth, secret);
    }
    return this.fetchImpl(finalUrl, { ...init, headers });
  }
}
