/**
 * Provider configurations (spec §4.1, §7) as registered by the studio: `GET|PUT /api/providers`.
 *
 * Configs never contain secrets (they reference vault entries through `credentialRef`); anything
 * that looks like a secret is rejected. The configs drive two things on the server:
 *  - the proxy allowlist (origin + path prefix of each provider's base URL), and which
 *    credential may be injected for which URL (a key is only ever sent to its own provider);
 *  - the provider registry of the managed "Automatic" gateway.
 */
import path from 'node:path';
import { HttpError, isPlainObject, readJson, readJsonFile, sendJson, writeFileAtomic } from './http-util';
import type { Logger } from './logger';
import type { Router } from './router';
import { isValidRef } from './vault/types';

/** Structural view of `@songdeck/ai` ProviderConfig (the server stores the full object). */
export interface StoredProviderConfig {
  id: string;
  name: string;
  adapter: string;
  enabled?: boolean;
  location: 'cloud' | 'local';
  baseUrl: string;
  credentialRef?: string;
  auth: { type: 'bearer' | 'header' | 'query' | 'none'; name?: string; prefix?: string };
  region?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AllowRule {
  /** e.g. https://api.openai.com */
  origin: string;
  /** e.g. /v1 ('' = any path) */
  pathPrefix: string;
  providerId: string;
  credentialRef?: string;
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const AUTH_TYPES = new Set(['bearer', 'header', 'query', 'none']);
const MAX_PROVIDERS = 200;

const SECRET_KEY_RE =
  /^(api[-_]?key|apikey|secret|client[-_]?secret|password|passwd|token|access[-_]?token|refresh[-_]?token|bearer|authorization|x-api-key|xi-api-key|x-goog-api-key|private[-_]?key)$/i;
const SECRET_VALUE_RE =
  /^(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_.-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*)$/;

/** Dotted paths of fields that look like secrets (mirrors `findSecretsInConfig` of @songdeck/ai). */
export function findSecrets(value: unknown, at = ''): string[] {
  const found: string[] = [];
  const visit = (v: unknown, p: string) => {
    if (typeof v === 'string') {
      if (SECRET_VALUE_RE.test(v.trim())) found.push(p);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${p}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const kp = p ? `${p}.${k}` : k;
        if (k === 'credentialRef') continue;
        if (
          SECRET_KEY_RE.test(k) &&
          typeof val === 'string' &&
          val.length > 0 &&
          !/^\{\{.*\}\}$/.test(val) &&
          val !== 'proxy-managed'
        ) {
          found.push(kp);
          continue;
        }
        visit(val, kp);
      }
    }
  };
  visit(value, at);
  return found;
}

/** Validate one config; returns problems (empty = ok). */
export function validateConfig(c: unknown, index: number): string[] {
  const at = `providers[${index}]`;
  if (!isPlainObject(c)) return [`${at} must be an object`];
  const p: string[] = [];
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) p.push(`${at}.id must match ${ID_RE}`);
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 200)
    p.push(`${at}.name is required (max 200 chars)`);
  if (typeof c.adapter !== 'string' || !c.adapter.trim()) p.push(`${at}.adapter is required`);
  if (c.location !== 'cloud' && c.location !== 'local') p.push(`${at}.location must be 'cloud' or 'local'`);
  if (c.baseUrl !== undefined && typeof c.baseUrl !== 'string') p.push(`${at}.baseUrl must be a string`);
  if (typeof c.baseUrl === 'string' && c.baseUrl.trim()) {
    if (c.baseUrl.startsWith('/')) {
      /* same-origin relative URL (managed provider served by this server) */
    } else {
      try {
        const u = new URL(c.baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') p.push(`${at}.baseUrl must be http(s)`);
        if (u.username || u.password) p.push(`${at}.baseUrl must not contain credentials`);
      } catch {
        p.push(`${at}.baseUrl is not a valid URL`);
      }
    }
  }
  if (c.auth !== undefined) {
    if (!isPlainObject(c.auth) || !AUTH_TYPES.has(String(c.auth.type)))
      p.push(`${at}.auth.type must be bearer, header, query or none`);
    else if (
      (c.auth.type === 'header' || c.auth.type === 'query') &&
      (typeof c.auth.name !== 'string' || !c.auth.name)
    ) {
      p.push(`${at}.auth.name is required for auth type ${String(c.auth.type)}`);
    }
  }
  if (
    c.credentialRef !== undefined &&
    c.credentialRef !== null &&
    c.credentialRef !== '' &&
    !isValidRef(c.credentialRef)
  )
    p.push(`${at}.credentialRef is not a valid reference`);
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') p.push(`${at}.enabled must be a boolean`);
  for (const s of findSecrets(c, at))
    p.push(`possible secret at ${s} (store it in the vault and use credentialRef)`);
  return p;
}

function normalizeConfig(c: Record<string, unknown>): StoredProviderConfig {
  const out = { ...c } as StoredProviderConfig;
  out.baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl.trim() : '';
  out.auth = isPlainObject(c.auth) ? (c.auth as StoredProviderConfig['auth']) : { type: 'none' };
  out.enabled = c.enabled !== false;
  if (c.credentialRef === null || c.credentialRef === '') delete out.credentialRef;
  return out;
}

function splitBase(url: string): { origin: string; pathPrefix: string } | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return { origin: u.origin, pathPrefix: u.pathname.replace(/\/+$/, '') };
  } catch {
    return undefined;
  }
}

/** Allowlist rules derived from provider configs (origin + path prefix, owning provider, credential). */
export function computeAllowlist(configs: readonly StoredProviderConfig[]): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const c of configs) {
    const credentialRef = c.auth?.type && c.auth.type !== 'none' ? c.credentialRef : undefined;
    const add = (origin: string, pathPrefix: string) =>
      rules.push({ origin, pathPrefix, providerId: c.id, ...(credentialRef ? { credentialRef } : {}) });
    const extra = (c.extra ?? {}) as Record<string, unknown>;
    // Vertex AI (Lyria) base URLs may contain a {location} placeholder.
    const location = String(extra.vertexLocation ?? c.region ?? 'us-central1')
      .trim()
      .replace(/[^a-z0-9-]/gi, '');
    const baseUrl = c.baseUrl ? c.baseUrl.replace(/\{location\}/g, location) : '';
    const base = baseUrl ? splitBase(baseUrl) : undefined;
    if (base) {
      add(base.origin, base.pathPrefix);
      // Gemini uploads audio through the sibling /upload/<version>/files endpoint.
      if (c.adapter === 'gemini') add(base.origin, '/upload');
    }
    if (c.adapter === 'google-lyria' && !base && location)
      add(`https://${location}-aiplatform.googleapis.com`, '/v1');
  }
  return rules;
}

export function ruleMatches(rule: AllowRule, url: URL): boolean {
  if (url.origin !== rule.origin) return false;
  if (!rule.pathPrefix) return true;
  return url.pathname === rule.pathPrefix || url.pathname.startsWith(`${rule.pathPrefix}/`);
}

export class ProviderStore {
  private configs: StoredProviderConfig[] = [];
  private rules: AllowRule[] = [];
  private readonly listeners = new Set<(configs: StoredProviderConfig[]) => void>();
  readonly file: string;

  constructor(
    dataDir: string,
    private readonly logger?: Logger,
  ) {
    this.file = path.join(dataDir, 'providers.json');
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<{ providers?: unknown } | unknown[]>(this.file);
      const list = Array.isArray(data) ? data : Array.isArray(data?.providers) ? data.providers : [];
      const ok: StoredProviderConfig[] = [];
      list.forEach((c, i) => {
        const problems = validateConfig(c, i);
        if (problems.length)
          this.logger?.warn(`providers.json: skipping invalid entry ${i}: ${problems.join('; ')}`);
        else ok.push(normalizeConfig(c as Record<string, unknown>));
      });
      this.set(ok);
    } catch (err) {
      this.logger?.warn(`providers.json could not be read: ${(err as Error).message}`);
    }
  }

  list(): StoredProviderConfig[] {
    return this.configs;
  }

  get(id: string): StoredProviderConfig | undefined {
    return this.configs.find((c) => c.id === id);
  }

  allowlist(): AllowRule[] {
    return this.rules;
  }

  onChange(fn: (configs: StoredProviderConfig[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(configs: StoredProviderConfig[]): void {
    this.configs = configs;
    this.rules = computeAllowlist(configs);
    for (const l of this.listeners) {
      try {
        l(configs);
      } catch (err) {
        this.logger?.warn(`provider change listener failed: ${(err as Error).message}`);
      }
    }
  }

  /** Validate, persist and activate a complete provider list. */
  async replace(input: unknown): Promise<StoredProviderConfig[]> {
    if (!Array.isArray(input))
      throw new HttpError(400, 'bad-request', 'Body must be { providers: ProviderConfig[] }');
    if (input.length > MAX_PROVIDERS)
      throw new HttpError(400, 'bad-request', `At most ${MAX_PROVIDERS} providers`);
    const problems = input.flatMap((c, i) => validateConfig(c, i));
    const ids = new Set<string>();
    input.forEach((c, i) => {
      const id = isPlainObject(c) ? c.id : undefined;
      if (typeof id === 'string') {
        if (ids.has(id)) problems.push(`providers[${i}].id "${id}" is duplicated`);
        ids.add(id);
      }
    });
    if (problems.length) {
      const secret = problems.some((p) => p.startsWith('possible secret'));
      throw new HttpError(
        400,
        secret ? 'secret-in-config' : 'invalid-provider-config',
        `Invalid provider configuration: ${problems.join('; ')}`,
        {
          details: problems,
        },
      );
    }
    const configs = input.map((c) => normalizeConfig(c as Record<string, unknown>));
    await writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), providers: configs }, null, 2),
      0o600,
    );
    this.set(configs);
    return configs;
  }
}

export function registerProviderRoutes(router: Router, store: ProviderStore, jsonLimit: number): void {
  router.get('/api/providers', ({ res }) => {
    sendJson(res, 200, { providers: store.list() });
  });

  router.put('/api/providers', async ({ req, res }) => {
    const body = await readJson<unknown>(req, jsonLimit);
    const list = Array.isArray(body) ? body : isPlainObject(body) ? body.providers : undefined;
    const providers = await store.replace(list);
    sendJson(res, 200, { providers });
  });
}
