/**
 * Local AI services on this machine (spec §4, §31): which well-known local servers are running,
 * and what models they serve. Used by the local server (`GET /api/local-services`, no CORS limits)
 * and, without a server, by the studio straight from the page (works only for servers that allow
 * the page's origin: Song Deck bridges, llama.cpp and vLLM do by default; Ollama needs
 * OLLAMA_ORIGINS, LM Studio its "Enable CORS" switch).
 *
 * Probes are parallel GETs with short timeouts against loopback addresses only.
 */
import { type Capability, normalizeCapabilities } from './capabilities';
import { inferModelCapabilities } from './model-heuristics';
import { getPreset } from './presets';
import type { FetchLike } from './transport/direct';

export type LocalProbeKind = 'ollama' | 'openai' | 'bridge';

export interface LocalServiceTarget {
  presetId: string;
  /** Base URL as the provider config uses it (OpenAI-compatible servers include `/v1`). */
  baseUrl: string;
  kind: LocalProbeKind;
}

export const DEFAULT_LOCAL_SERVICE_TARGETS: readonly LocalServiceTarget[] = [
  { presetId: 'ollama', baseUrl: 'http://127.0.0.1:11434', kind: 'ollama' },
  { presetId: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'openai' },
  { presetId: 'llama-cpp', baseUrl: 'http://127.0.0.1:8080/v1', kind: 'openai' },
  { presetId: 'vllm', baseUrl: 'http://127.0.0.1:8000/v1', kind: 'openai' },
  { presetId: 'ace-step-local', baseUrl: 'http://127.0.0.1:8810', kind: 'bridge' },
  { presetId: 'diffsinger-local', baseUrl: 'http://127.0.0.1:8811', kind: 'bridge' },
  { presetId: 'demucs-local', baseUrl: 'http://127.0.0.1:8812', kind: 'bridge' },
  { presetId: 'basic-pitch-local', baseUrl: 'http://127.0.0.1:8813', kind: 'bridge' },
  { presetId: 'rvc-local', baseUrl: 'http://127.0.0.1:8814', kind: 'bridge' },
  { presetId: 'mastering-local', baseUrl: 'http://127.0.0.1:8815', kind: 'bridge' },
  { presetId: 'whisper-local', baseUrl: 'http://127.0.0.1:8816', kind: 'bridge' },
  { presetId: 'plugin-host-local', baseUrl: 'http://127.0.0.1:8817', kind: 'bridge' },
  { presetId: 'custom-audio-http', baseUrl: 'http://127.0.0.1:8820', kind: 'bridge' },
  { presetId: 'yue-local', baseUrl: 'http://127.0.0.1:8821', kind: 'bridge' },
  { presetId: 'diffrhythm-local', baseUrl: 'http://127.0.0.1:8822', kind: 'bridge' },
  { presetId: 'stable-audio-open-local', baseUrl: 'http://127.0.0.1:8823', kind: 'bridge' },
  { presetId: 'musicgen-local', baseUrl: 'http://127.0.0.1:8824', kind: 'bridge' },
];

export interface LocalServiceModel {
  id: string;
  name?: string;
  capabilities: Capability[];
}

export interface DetectedLocalService {
  presetId: string;
  name: string;
  baseUrl: string;
  /** found = answered; absent = nothing listening (or, from a browser, blocked by CORS). */
  status: 'found' | 'absent' | 'error';
  models: LocalServiceModel[];
  /** Capabilities reported by a bridge's `/info`. */
  capabilities?: Capability[];
  version?: string;
  error?: string;
  ms?: number;
}

export interface LocalProbeOptions {
  fetch?: FetchLike;
  /** Per-request timeout (default 1200 ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Hosts that only reach this machine (probes never leave it). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
  } catch {
    return false;
  }
}

const trim = (u: string) => u.replace(/\/+$/, '');

async function getJson(fetchImpl: FetchLike, url: string, opts: LocalProbeOptions): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1200);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function llmModel(
  id: string,
  parameterSize?: string,
  serverCapabilities?: string[],
  contextLength?: number,
): LocalServiceModel | undefined {
  const inferred = inferModelCapabilities(id, { parameterSize, serverCapabilities, contextLength });
  return inferred ? { id, capabilities: inferred.capabilities } : undefined;
}

/** Probe one target. Never throws: failures come back as `absent` / `error`. */
export async function probeLocalService(
  target: LocalServiceTarget,
  opts: LocalProbeOptions = {},
): Promise<DetectedLocalService> {
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = trim(target.baseUrl);
  const name = getPreset(target.presetId)?.name ?? target.presetId;
  const out: DetectedLocalService = {
    presetId: target.presetId,
    name,
    baseUrl: base,
    status: 'absent',
    models: [],
  };
  if (!isLoopbackUrl(base))
    return { ...out, status: 'error', error: 'Only addresses on this machine are probed' };
  const t0 = Date.now();
  try {
    if (target.kind === 'ollama') {
      const data = (await getJson(fetchImpl, `${base.replace(/\/(api|v1)$/, '')}/api/tags`, opts)) as {
        models?: {
          name?: string;
          model?: string;
          details?: { parameter_size?: string };
          capabilities?: string[];
        }[];
      };
      for (const m of data?.models ?? []) {
        const id = m.name ?? m.model;
        const model = id ? llmModel(id, m.details?.parameter_size, m.capabilities) : undefined;
        if (model) out.models.push(model);
      }
    } else if (target.kind === 'openai') {
      const data = (await getJson(fetchImpl, `${base}/models`, opts)) as {
        data?: { id?: string; context_length?: number; max_model_len?: number }[];
      };
      for (const m of data?.data ?? []) {
        const model = m.id
          ? llmModel(m.id, undefined, undefined, m.context_length ?? m.max_model_len)
          : undefined;
        if (model) out.models.push(model);
      }
    } else {
      const info = (await getJson(fetchImpl, `${base}/info`, opts)) as {
        name?: string;
        version?: string;
        capabilities?: unknown[];
        models?: { id?: string; name?: string; capabilities?: unknown[] }[];
      };
      const caps = normalizeCapabilities(info?.capabilities);
      const fallback = getPreset(target.presetId)?.capabilities ?? [];
      out.capabilities = caps.length ? caps : [...fallback];
      if (typeof info?.version === 'string') out.version = info.version;
      if (typeof info?.name === 'string' && info.name.trim()) out.name = `${name} — ${info.name.trim()}`;
      const models =
        Array.isArray(info?.models) && info.models.length
          ? info.models
          : [{ id: info?.name ?? target.presetId, name: info?.name }];
      for (const m of models) {
        if (!m || typeof m !== 'object') continue;
        const own = normalizeCapabilities(m.capabilities);
        out.models.push({
          id: String(m.id ?? m.name ?? 'model'),
          ...(m.name ? { name: String(m.name) } : {}),
          capabilities: own.length ? own : out.capabilities,
        });
      }
    }
    return { ...out, status: 'found', ms: Date.now() - t0 };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    // Something answered with an error: the port is taken by a server, but not one we understand.
    if (status !== undefined)
      return { ...out, status: 'error', error: `HTTP ${status}`, ms: Date.now() - t0 };
    return { ...out, status: 'absent', ms: Date.now() - t0 };
  }
}

/** Probe every target in parallel. */
export async function detectLocalServices(
  targets: readonly LocalServiceTarget[] = DEFAULT_LOCAL_SERVICE_TARGETS,
  opts: LocalProbeOptions = {},
): Promise<DetectedLocalService[]> {
  return Promise.all(targets.map((t) => probeLocalService(t, opts)));
}
