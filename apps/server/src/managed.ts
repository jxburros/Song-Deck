/**
 * Managed "Automatic" gateway (spec §8): `POST /api/managed/{llm,audio,models}` mount
 * `createManagedGatewayHandler` of `@songdeck/ai` over an Orchestrator built from the server's
 * provider configs (`PUT /api/providers`). Credentials are read from the vault by a
 * DirectTransport running here, so keys never reach the browser.
 *
 * Privacy: the client's `privacy.neverUpload` and `privacy.localOnly` (also accepted as
 * `offline: true`) are honoured by the router — data kinds listed in `neverUpload` are never sent
 * to cloud providers and offline requests only use local providers. When no configured provider
 * can serve a request the gateway answers `503 { code: 'no-compatible-provider', reasons }` — 503 (not 409)
 * so managed clients treat it as "unavailable here" and fall back to another provider (e.g. on-device).
 *
 * `GET /api/managed/status` reports which task roles can currently be served (and whether they
 * can be served offline).
 */
import {
  CapabilityRouter,
  createManagedGatewayHandler,
  DEFAULT_ROUTING_SETTINGS,
  DirectTransport,
  type ManagedGatewayHandler,
  type ManagedGatewayResponse,
  NoCompatibleProviderError,
  Orchestrator,
  type ProviderConfig,
  ProviderRegistry,
  ROLE_INFO,
  type RoutingSettings,
  TASK_ROLES,
  type TaskRole,
} from '@songdeck/ai';
import { HttpError, isPlainObject, readJson, sendBytes, sendJson } from './http-util';
import type { Logger } from './logger';
import type { ProviderStore, StoredProviderConfig } from './providers';
import { isAllowlisted } from './proxy';
import type { Router } from './router';
import { vaultCredentialReader } from './vault';
import type { CredentialVault } from './vault/types';

export interface ManagedGatewayOptions {
  providers: ProviderStore;
  getVault(): CredentialVault;
  logger: Logger;
  jsonLimit: number;
  fetch?: typeof fetch;
}

export interface RoleStatus {
  available: boolean;
  providerId?: string;
  providerName?: string;
  location?: string;
  modelId?: string;
  /** Can also be served with `privacy.localOnly` / offline. */
  localAvailable: boolean;
  reason?: string;
}

const STATUS_CODES: Record<number, string> = {
  400: 'bad-request',
  402: 'budget-exceeded',
  403: 'forbidden',
  404: 'not-found',
  422: 'refusal',
  429: 'rate-limited',
  499: 'cancelled',
  501: 'unsupported',
  502: 'provider-error',
  503: 'provider-unavailable',
  504: 'provider-timeout',
};

/** Server-side routing defaults: the client already confirmed the data flow (spec §50). */
const SERVER_ROUTING: RoutingSettings = { ...DEFAULT_ROUTING_SETTINGS, privacyConfirm: 'never' };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Headers that may follow a cross-origin redirect (everything else may carry a credential). */
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'user-agent']);

/**
 * fetch for the gateway's DirectTransport: same-origin redirects are followed as usual; a
 * cross-origin redirect is followed only to an allowlisted URL and without the request's
 * (possibly credential-bearing) custom headers.
 */
export function guardedFetch(base: typeof fetch, isAllowed: (url: URL) => boolean): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    let url = new URL(input);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    let headers = new Headers(init.headers);
    for (let hop = 0; hop <= 5; hop++) {
      const res = await base(url.toString(), { ...init, method, body, headers, redirect: 'manual' });
      const location = res.headers.get('location');
      if (!REDIRECTS.has(res.status) || !location) return res;
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        if (!isAllowed(next)) throw new TypeError(`fetch failed: redirect to ${next.origin} refused (not in the provider allowlist)`);
        const safe = new Headers();
        headers.forEach((value, key) => {
          if (CROSS_ORIGIN_SAFE_HEADERS.has(key.toLowerCase())) safe.set(key, value);
        });
        headers = safe;
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = method === 'HEAD' ? 'HEAD' : 'GET';
        body = undefined;
        headers.delete('content-type');
      }
      url = next;
    }
    throw new TypeError('fetch failed: too many redirects');
  };
}

export class ManagedGateway {
  readonly registry: ProviderRegistry;
  readonly router: CapabilityRouter;
  readonly orchestrator: Orchestrator;
  readonly handler: ManagedGatewayHandler;
  private configureErrors: { id: string; error: string }[] = [];

  constructor(private readonly opts: ManagedGatewayOptions) {
    const credentials = vaultCredentialReader(opts.getVault);
    const baseFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const isAllowed = (url: URL) => isAllowlisted(url, opts.providers.allowlist());
    const transport = new DirectTransport(credentials, { fetch: guardedFetch(baseFetch, isAllowed) });
    this.registry = new ProviderRegistry({ deps: { transport, credentials } });
    this.router = new CapabilityRouter(this.registry, { settings: () => SERVER_ROUTING });
    this.orchestrator = new Orchestrator({
      registry: this.registry,
      router: this.router,
      settings: () => SERVER_ROUTING,
      onEvent: (e) => {
        if (e.type === 'failed') opts.logger.debug(`managed: ${e.role} via ${e.providerId} failed: ${e.error}`);
        else if (e.type === 'fallback') opts.logger.debug(`managed: ${e.role} fell back from ${e.from} to ${e.to}: ${e.reason}`);
      },
    });
    this.handler = createManagedGatewayHandler(this.orchestrator);
    opts.providers.onChange((configs) => this.configure(configs));
  }

  get available(): boolean {
    return true;
  }

  async init(): Promise<void> {
    this.configure(this.opts.providers.list());
  }

  /** (Re)build the provider registry from the stored configs (managed adapters excluded: no loops). */
  configure(configs: readonly StoredProviderConfig[]): void {
    const usable = configs.filter((c) => c.adapter !== 'managed') as unknown as ProviderConfig[];
    const result = this.registry.configure(usable);
    this.configureErrors = result.errors;
    for (const e of result.errors) this.opts.logger.warn(`managed gateway: provider ${e.id} unusable: ${e.error}`);
  }

  private managedIds(): string[] {
    return this.registry
      .allEntries()
      .filter((e) => e.instance.descriptor.adapter === 'managed')
      .map((e) => e.instance.descriptor.id);
  }

  roleStatus(role: TaskRole): RoleStatus {
    const excludeProviderIds = this.managedIds();
    const pick = (offline: boolean) => this.router.select({ role, excludeProviderIds, settings: { offline } });
    let localAvailable = false;
    try {
      pick(true);
      localAvailable = true;
    } catch {
      /* not offline-capable */
    }
    try {
      const d = pick(false);
      return { available: true, providerId: d.providerId, providerName: d.providerName, location: d.location, ...(d.modelId ? { modelId: d.modelId } : {}), localAvailable };
    } catch (err) {
      return { available: false, localAvailable, reason: err instanceof NoCompatibleProviderError ? err.message : (err as Error).message };
    }
  }

  status() {
    const skip = new Set(this.managedIds());
    const roles: Record<string, RoleStatus> = {};
    for (const role of TASK_ROLES) roles[role] = this.roleStatus(role);
    return {
      available: true,
      providers: this.registry
        .list()
        .filter((p) => !skip.has(p.id))
        .map((p) => ({ id: p.id, name: p.name, location: p.location, adapter: p.adapter, enabled: p.enabled, status: p.status, ...(p.error ? { error: p.error } : {}), capabilities: p.capabilities })),
      roles,
      roleLabels: Object.fromEntries(TASK_ROLES.map((r) => [r, ROLE_INFO[r].label])),
      ...(this.configureErrors.length ? { errors: this.configureErrors } : {}),
    };
  }
}

/** Accept `offline: true` (top level or inside privacy) as an alias of `privacy.localOnly`. */
function normalizeBody(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const privacy = isPlainObject(body.privacy) ? { ...body.privacy } : {};
  if (body.offline === true || privacy.offline === true) privacy.localOnly = true;
  return { ...body, privacy };
}

function toHttp(out: ManagedGatewayResponse): ManagedGatewayResponse {
  // "No compatible provider" stays 503 (the AI client's fallback signal); tag it with a stable code.
  const json = isPlainObject(out.json) ? (out.json as Record<string, unknown>) : undefined;
  if (out.status === 503 && json && Array.isArray(json.reasons) && json.kind === undefined) {
    return { ...out, json: { ...json, code: 'no-compatible-provider' } };
  }
  if (out.status >= 400 && json && typeof json.code !== 'string') {
    return { ...out, json: { ...json, error: String(json.error ?? 'Managed gateway error'), code: STATUS_CODES[out.status] ?? (out.status >= 500 ? 'provider-error' : 'bad-request') } };
  }
  return out;
}

export function registerManagedRoutes(router: Router, gateway: ManagedGateway, jsonLimit: number): void {
  router.get('/api/managed/status', ({ res }) => {
    sendJson(res, 200, gateway.status());
  });

  for (const name of ['llm', 'audio', 'models'] as const) {
    router.post(`/api/managed/${name}`, async ({ req, res, url, signal }) => {
      const body = normalizeBody(await readJson<unknown>(req, jsonLimit));
      if (!isPlainObject(body)) throw new HttpError(400, 'bad-request', 'Body must be a JSON object');
      const out = toHttp(await gateway.handler(url.pathname, body, signal));
      if (signal.aborted) return; // client went away
      const headers = { ...(out.headers ?? {}), 'cache-control': 'no-store' };
      if (out.bytes) sendBytes(res, out.status, out.bytes, out.contentType ?? 'application/octet-stream', headers);
      else sendJson(res, out.status, out.json ?? {}, headers);
    });
  }
}
