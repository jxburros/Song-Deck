/**
 * Credential storage (spec §7).
 *
 * - `MemoryCredentialStore`: session-only secrets (browser without a local server, tests).
 * - `ServerVaultClient`: manages secrets in the local server's vault (OS keychain where available).
 *   Secrets are WRITE-ONLY from the browser: the client can list references and set/delete
 *   secrets, but never read them back.
 *
 * ## Vault contract (implemented by apps/server)
 * - `GET    {server}/api/vault`        → `{ backend: 'keychain' | 'encrypted-file' | 'memory', refs: [{ ref, label?, updatedAt }] }`
 * - `PUT    {server}/api/vault/:ref`   body `{ secret: string, label?: string }` → `204` (or `200 {ok:true}`)
 * - `DELETE {server}/api/vault/:ref`   → `204`
 * `:ref` is URL-encoded. Errors: `4xx/5xx {error}`.
 */
import { errorFromStatus, ProviderError } from '../errors';
import type { CredentialStore } from '../types';
import { joinUrl } from '../util';
import type { FetchLike } from './direct';

export class MemoryCredentialStore implements CredentialStore {
  private readonly secrets = new Map<string, { secret: string; label?: string; updatedAt: string }>();

  constructor(initial?: Record<string, string>) {
    for (const [ref, secret] of Object.entries(initial ?? {})) this.secrets.set(ref, { secret, updatedAt: new Date().toISOString() });
  }

  async get(ref: string): Promise<string | undefined> {
    return this.secrets.get(ref)?.secret;
  }

  async set(ref: string, secret: string, label?: string): Promise<void> {
    this.secrets.set(ref, { secret, label, updatedAt: new Date().toISOString() });
  }

  async delete(ref: string): Promise<void> {
    this.secrets.delete(ref);
  }

  async list(): Promise<{ ref: string; label?: string; updatedAt?: string }[]> {
    return [...this.secrets.entries()].map(([ref, v]) => ({ ref, label: v.label, updatedAt: v.updatedAt }));
  }

  has(ref: string): boolean {
    return this.secrets.has(ref);
  }

  clear(): void {
    this.secrets.clear();
  }
}

export type VaultBackend = 'keychain' | 'encrypted-file' | 'memory';

export interface VaultStatus {
  backend: VaultBackend;
  refs: { ref: string; label?: string; updatedAt: string }[];
}

export interface ServerVaultClientOptions {
  fetch?: FetchLike;
  headers?: Record<string, string>;
}

export class ServerVaultClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    readonly serverUrl: string,
    private readonly opts: ServerVaultClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private url(path: string): string {
    return joinUrl(this.serverUrl.replace(/\/+$/, ''), path);
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { ...init, headers: { ...(this.opts.headers ?? {}), ...((init.headers as Record<string, string>) ?? {}) } });
    } catch (err) {
      throw new ProviderError('network', `Song Deck server unreachable: ${(err as Error)?.message ?? String(err)}`, { cause: err });
    }
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      throw errorFromStatus(res.status, body);
    }
    return res;
  }

  async status(): Promise<VaultStatus> {
    const res = await this.call('/api/vault', { method: 'GET' });
    const json = (await res.json()) as VaultStatus;
    return { backend: json.backend, refs: Array.isArray(json.refs) ? json.refs : [] };
  }

  async has(ref: string): Promise<boolean> {
    return (await this.status()).refs.some((r) => r.ref === ref);
  }

  async setSecret(ref: string, secret: string, label?: string): Promise<void> {
    if (!secret) throw new ProviderError('bad-request', 'Secret must not be empty');
    await this.call(`/api/vault/${encodeURIComponent(ref)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(label === undefined ? { secret } : { secret, label }),
    });
  }

  async deleteSecret(ref: string): Promise<void> {
    await this.call(`/api/vault/${encodeURIComponent(ref)}`, { method: 'DELETE' });
  }

  /**
   * A write-only CredentialStore view (for UIs that treat stores uniformly). `get` always resolves
   * undefined because the browser can never read secrets back; use ServerProxyTransport to use them.
   */
  asCredentialStore(): CredentialStore {
    return {
      get: async () => undefined,
      set: (ref, secret, label) => this.setSecret(ref, secret, label),
      delete: (ref) => this.deleteSecret(ref),
      list: async () => (await this.status()).refs,
    };
  }
}
