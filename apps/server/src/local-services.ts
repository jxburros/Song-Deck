/**
 * "Connect a service" support for the studio:
 *
 *  - `GET /api/local-services` — which local AI servers are running on this machine (Ollama,
 *    LM Studio, llama.cpp, vLLM, the Song Deck bridges, a custom audio bridge) and their models.
 *    Parallel probes with short timeouts, loopback addresses only. The server is not subject to
 *    CORS, so this sees servers the browser cannot.
 *
 *  - `POST /api/connect/probe` `{ presetId, secret }` — validate a pasted API key against a cloud
 *    provider and list the account's models, before anything is saved. Only the preset's own base
 *    URL is contacted (the caller cannot choose a URL), the key lives in memory for the duration
 *    of the request and is never logged or stored. Answers `200 { ok: true, result }` or
 *    `200 { ok: false, error: { kind, status?, message } }` (an upstream rejection is not a
 *    failure of this endpoint).
 */
import {
  CONNECTABLE_PRESET_IDS,
  detectLocalServices,
  DirectTransport,
  isLoopbackUrl,
  MemoryCredentialStore,
  probeProvider,
  toProviderError,
  type DetectedLocalService,
  type LocalServiceTarget,
} from '@songdeck/ai';
import { badRequest, isPlainObject, readJson, sendJson } from './http-util';
import type { Router } from './router';

export interface LocalServicesOptions {
  ollamaUrl: string | false;
  lmStudioUrl: string | false;
  /** Further targets (llama.cpp, vLLM, bridges…). */
  extra: LocalServiceTarget[];
  timeoutMs: number;
  fetch: typeof fetch;
}

/** Every target to probe, in display order (Ollama and LM Studio from their own settings). */
export function localServiceTargets(
  opts: Pick<LocalServicesOptions, 'ollamaUrl' | 'lmStudioUrl' | 'extra'>,
): LocalServiceTarget[] {
  const out: LocalServiceTarget[] = [];
  if (opts.ollamaUrl) out.push({ presetId: 'ollama', baseUrl: opts.ollamaUrl, kind: 'ollama' });
  if (opts.lmStudioUrl) out.push({ presetId: 'lm-studio', baseUrl: opts.lmStudioUrl, kind: 'openai' });
  out.push(...opts.extra);
  return out.filter((t) => isLoopbackUrl(t.baseUrl));
}

export class LocalServices {
  constructor(private readonly opts: LocalServicesOptions) {}

  get targets(): LocalServiceTarget[] {
    return localServiceTargets(this.opts);
  }

  async scan(): Promise<{ services: DetectedLocalService[]; scannedAt: string }> {
    // Local servers answer in milliseconds; keep the scan snappy even when a port hangs.
    const services = await detectLocalServices(this.targets, {
      fetch: this.opts.fetch,
      timeoutMs: Math.min(this.opts.timeoutMs, 1500),
    });
    return { services, scannedAt: new Date().toISOString() };
  }
}

export interface ConnectProbeDeps {
  /** fetch used to reach the provider (the proxy's, so tests can mock upstreams). */
  fetch: typeof fetch;
  jsonLimit: number;
}

export function registerLocalServiceRoutes(
  router: Router,
  services: LocalServices,
  connect: ConnectProbeDeps,
): void {
  router.get('/api/local-services', async ({ res }) => {
    sendJson(res, 200, await services.scan());
  });

  router.post('/api/connect/probe', async ({ req, res, signal }) => {
    const body = await readJson<unknown>(req, connect.jsonLimit);
    if (!isPlainObject(body)) throw badRequest('Body must be a JSON object');
    const presetId = body.presetId;
    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    if (typeof presetId !== 'string' || !CONNECTABLE_PRESET_IDS.includes(presetId))
      throw badRequest(`presetId must be one of ${CONNECTABLE_PRESET_IDS.join(', ')}`);
    if (!secret || secret.length > 4096) throw badRequest('secret is required');
    const ref = `connect-probe:${presetId}`;
    const transport = new DirectTransport(new MemoryCredentialStore({ [ref]: secret }), {
      fetch: connect.fetch,
    });
    try {
      const result = await probeProvider(presetId, { transport, credentialRef: ref, signal });
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      const pe = toProviderError(err);
      sendJson(res, 200, {
        ok: false,
        error: { kind: pe.kind, ...(pe.status ? { status: pe.status } : {}), message: pe.message },
      });
    }
  });
}
