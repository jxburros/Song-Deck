/**
 * "Connect a service": validate a pasted key against the provider and list what the account can
 * use, without saving anything. The same code runs in the browser (DirectTransport, subject to
 * the provider's CORS policy) and in the local server (`POST /api/connect/probe`, no CORS).
 *
 * Endpoints used (all with the key injected by the transport):
 *  - OpenAI-compatible presets: `GET {base}/models`                       (documented)
 *  - Anthropic: `GET /v1/models` through the official SDK                  (documented)
 *  - Gemini:    `GET /v1beta/models` (Lyria models are reported as music)  (documented)
 *  - ElevenLabs: `GET /v1/models` — validates the key; it lists speech models, so a music model is
 *    taken from it only if one is listed, otherwise the known `music_v1` is presented. A key
 *    restricted to music may lack the "models" permission: ElevenLabs then answers 401 with
 *    `detail.status = "missing_permissions"`, which proves the key itself is valid.
 *  - Stability AI: `GET https://api.stability.ai/v1/user/balance` → `{ credits }`; Stability has
 *    no audio model list, so the preset's known Stable Audio models are presented.
 * The ElevenLabs and Stability response shapes come from their API references as found by search;
 * the official pages could not be fetched from this environment, so parsing is tolerant.
 */
import { type ProviderConfig, defaultCredentialRef } from './config';
import { ProviderError, toProviderError } from './errors';
import { createProvider } from './factory';
import { createHttpClient } from './adapters/common';
import { ELEVENLABS_MUSIC_CAPABILITIES } from './adapters/elevenlabs';
import { isGeminiMusicModel } from './adapters/gemini';
import { STABILITY_AUDIO_CAPABILITIES } from './adapters/stability';
import { compareModelsForRecommendation, modelUses, recommendModels } from './connect-models';
import { configFromPreset, getPreset } from './presets';
import type { ModelInfo, Transport } from './types';
import { joinUrl } from './util';

export interface ConnectProbeResult {
  presetId: string;
  /** Every model the key can see (usable or not), best first. */
  models: ModelInfo[];
  /** False when the provider has no model list and the models are Song Deck's known ones. */
  listed: boolean;
  /** Extra account facts worth showing (e.g. Stability credits). Never secrets or personal data. */
  account?: { label: string; value: string }[];
  note?: string;
}

export interface ConnectProbeOptions {
  /** Transport whose credential store resolves `credentialRef` to the key under test. */
  transport: Transport;
  /** Credential reference the transport resolves (default `provider:<presetId>`). */
  credentialRef?: string;
  signal?: AbortSignal;
}

/** Temporary config used only for probing (never persisted). */
function probeConfig(presetId: string, credentialRef: string): ProviderConfig {
  const config = configFromPreset(presetId, { id: `connect-${presetId}`, credentialRef });
  // One attempt and a short timeout: the user is waiting for a yes/no.
  return { ...config, timeoutMs: Math.min(config.timeoutMs, 30_000) };
}

const deps = (transport: Transport) => ({ transport, retry: { retries: 0 } });

export async function probeProvider(
  presetId: string,
  opts: ConnectProbeOptions,
): Promise<ConnectProbeResult> {
  const preset = getPreset(presetId);
  if (!preset) throw new ProviderError('bad-request', `Unknown provider "${presetId}"`);
  const config = probeConfig(presetId, opts.credentialRef ?? defaultCredentialRef(presetId));
  if (preset.adapter === 'elevenlabs-music') return probeElevenLabs(config, opts);
  if (preset.adapter === 'stability-audio') return probeStability(config, opts);
  const inst = createProvider(config, deps(opts.transport));
  if (!inst.llm)
    throw new ProviderError(
      'unsupported',
      `${preset.name} cannot be connected with a key here — use Advanced`,
    );
  const models = [...(await inst.llm.listModels(opts.signal)), ...(inst.llm.skippedModels ?? [])];
  const note =
    presetId === 'gemini' && models.some((m) => isGeminiMusicModel(m.id))
      ? 'This key can also use Lyria music models.'
      : undefined;
  return {
    presetId,
    models: [...models].sort(compareModelsForRecommendation),
    listed: true,
    ...(note ? { note } : {}),
  };
}

async function probeElevenLabs(
  config: ProviderConfig,
  opts: ConnectProbeOptions,
): Promise<ConnectProbeResult> {
  const http = createHttpClient(config, deps(opts.transport));
  const known: ModelInfo = {
    id: 'music_v1',
    name: 'Eleven Music',
    capabilities: [...ELEVENLABS_MUSIC_CAPABILITIES],
    qualityTier: 5,
  };
  try {
    const list = await http.json<unknown>({
      url: joinUrl(config.baseUrl, 'models'),
      method: 'GET',
      signal: opts.signal,
    });
    const rows = (Array.isArray(list) ? list : []) as {
      model_id?: string;
      name?: string;
      description?: string;
    }[];
    const music = rows
      .filter((r) => typeof r.model_id === 'string' && /music/i.test(r.model_id))
      .map(
        (r) =>
          ({
            id: r.model_id!,
            ...(r.name ? { name: r.name } : {}),
            capabilities: [...ELEVENLABS_MUSIC_CAPABILITIES],
            qualityTier: 5,
          }) as ModelInfo,
      );
    const speech = rows
      .filter((r) => typeof r.model_id === 'string' && !/music/i.test(r.model_id))
      .map(
        (r) =>
          ({
            id: r.model_id!,
            ...(r.name ? { name: r.name } : {}),
            capabilities: [],
            meta: { kind: 'speech' },
          }) as ModelInfo,
      );
    return {
      presetId: config.presetId!,
      models: [...(music.length ? music : [known]), ...speech],
      listed: music.length > 0,
      ...(music.length
        ? {}
        : {
            note: 'ElevenLabs lists speech models only; Eleven Music (music_v1) is available on plans that include music.',
          }),
    };
  } catch (err) {
    const pe = toProviderError(err, config.id);
    const detail = (pe.details as { detail?: { status?: string } } | undefined)?.detail;
    if (pe.status === 401 && detail?.status === 'missing_permissions') {
      return {
        presetId: config.presetId!,
        models: [known],
        listed: false,
        note: 'The key is valid but may not list models; Eleven Music is assumed.',
      };
    }
    throw pe;
  }
}

async function probeStability(
  config: ProviderConfig,
  opts: ConnectProbeOptions,
): Promise<ConnectProbeResult> {
  const http = createHttpClient(config, deps(opts.transport));
  const origin = new URL(config.baseUrl).origin;
  const balance = await http.json<{ credits?: number }>({
    url: `${origin}/v1/user/balance`,
    method: 'GET',
    signal: opts.signal,
  });
  const preset = getPreset(config.presetId)!;
  const ids = [
    ...new Set([...(preset.suggestedModels ?? []), ...(preset.defaultModel ? [preset.defaultModel] : [])]),
  ];
  const models: ModelInfo[] = ids.map((id) => ({
    id,
    name: id.replace(/^stable-audio-/, 'Stable Audio '),
    capabilities: [...STABILITY_AUDIO_CAPABILITIES],
    qualityTier: 4,
  }));
  const credits = typeof balance?.credits === 'number' ? balance.credits : undefined;
  return {
    presetId: config.presetId!,
    models: models.sort(compareModelsForRecommendation),
    listed: false,
    ...(credits !== undefined ? { account: [{ label: 'Credits', value: credits.toFixed(2) }] } : {}),
    note: 'Stability AI has no audio model list; these are the Stable Audio models Song Deck supports.',
  };
}

export type ConnectErrorKind =
  'invalid-key' | 'forbidden' | 'quota' | 'network' | 'unavailable' | 'unsupported' | 'unknown';

/** Turn a probe failure into a short, actionable message. */
export function describeConnectError(
  err: unknown,
  providerName: string,
  opts: { browserOnly?: boolean } = {},
): { kind: ConnectErrorKind; message: string } {
  const pe = toProviderError(err);
  const msg = pe.message || '';
  if (pe.kind === 'auth' && (pe.status === 401 || /invalid|incorrect|unauthori[sz]ed/i.test(msg)))
    return {
      kind: 'invalid-key',
      message: `${providerName} rejected this key — check that it was copied completely and has not been revoked.`,
    };
  if (pe.kind === 'bad-request' && /api[ _-]?key/i.test(msg))
    return { kind: 'invalid-key', message: `${providerName} rejected this key (${msg}).` };
  if (pe.status === 402 || /quota|billing|credit|insufficient|exceeded|RESOURCE_EXHAUSTED/i.test(msg)) {
    return {
      kind: 'quota',
      message: `${providerName} accepted the key but the account is out of quota or credits (${msg}). Check billing on the provider's site.`,
    };
  }
  if (pe.kind === 'auth')
    return {
      kind: 'forbidden',
      message: `${providerName} refused access (${msg || `HTTP ${pe.status}`}). The key may lack permissions or the API may not be enabled for it.`,
    };
  if (pe.kind === 'rate-limit')
    return {
      kind: 'quota',
      message: `${providerName} is rate limiting this key right now — wait a minute and try again.`,
    };
  if (pe.kind === 'network' || pe.kind === 'timeout') {
    return {
      kind: 'network',
      message: opts.browserOnly
        ? `Could not reach ${providerName} from this page. Check your connection; some providers also block requests made directly from web pages (CORS) — start the Song Deck server (npx tsx apps/server/src/cli.ts) and try again.`
        : `Could not reach ${providerName} (${msg}). Check your internet connection, VPN or firewall.`,
    };
  }
  if (pe.kind === 'unavailable')
    return {
      kind: 'unavailable',
      message: `${providerName} is having problems (HTTP ${pe.status ?? '5xx'}). Try again shortly.`,
    };
  if (pe.kind === 'unsupported') return { kind: 'unsupported', message: msg };
  return { kind: 'unknown', message: `${providerName}: ${msg || 'unexpected error'}` };
}

export interface ConnectConfigOptions {
  /** Provider id (default: the preset id). */
  id?: string;
  /** Models the user ticked. */
  selected: string[];
  /** Probe result the selection came from (models, whether they were listed). */
  probe: Pick<ConnectProbeResult, 'models' | 'listed'>;
  /** Existing config to update (keeps the user's other settings). */
  existing?: ProviderConfig;
}

/**
 * The provider config for a connected service: enabled, with the chosen models (as `enabledModels`
 * for providers that list models, as manual models for those that do not) and a sensible default.
 */
export function connectedConfig(presetId: string, opts: ConnectConfigOptions): ProviderConfig {
  const base = opts.existing ?? configFromPreset(presetId, { id: opts.id ?? presetId });
  const chosen = opts.probe.models.filter((m) => opts.selected.includes(m.id));
  const rec = recommendModels(chosen);
  const writing = chosen.filter((m) => modelUses(m).includes('composition'));
  const defaultModel =
    base.defaultModel &&
    opts.selected.includes(base.defaultModel) &&
    (writing.length === 0 || writing.some((m) => m.id === base.defaultModel))
      ? base.defaultModel
      : (rec.defaultModel ?? opts.selected[0]);
  const config: ProviderConfig = {
    ...base,
    enabled: true,
    credentialRef: base.credentialRef ?? defaultCredentialRef(base.id),
    modelCatalog: chosen.map(({ id, name, capabilities, capabilitiesInferred, qualityTier }) => ({
      id,
      name,
      capabilities,
      capabilitiesInferred,
      qualityTier,
    })),
  };
  delete config.enabledModels;
  if (opts.probe.listed && opts.selected.length) config.enabledModels = [...opts.selected];
  if (!opts.probe.listed && chosen.length)
    config.models = chosen.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }));
  if (defaultModel) config.defaultModel = defaultModel;
  return config;
}
