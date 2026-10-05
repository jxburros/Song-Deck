/**
 * Shared adapter plumbing: descriptors from config + preset, HTTP clients with per-provider
 * concurrency/rate gates, audio (de)serialization for JSON bridges, LLM helpers.
 */
import { type Capability, unionCapabilities } from '../capabilities';
import { authForConfig, type ProviderConfig, type StructuredOutputMode } from '../config';
import { llmCostUsd } from '../cost';
import { ProviderError } from '../errors';
import { getPreset } from '../presets';
import { extractJson } from '../schemas/extract';
import { HttpClient } from '../transport/http';
import { type Clock, RequestGate, type RetryOptions, systemClock } from '../transport/limiter';
import type {
  ChatMessage,
  CredentialStore,
  EncodedAudio,
  LLMRequest,
  ModelInfo,
  PricingInfo,
  ProviderDescriptor,
  Transport,
  TokenUsage,
} from '../types';
import { audioMimeType, base64ToBytes, bytesToBase64 } from '../util';

export interface CreateProviderDeps {
  transport: Transport;
  credentials?: CredentialStore;
  clock?: Clock;
  /** Retry policy override (tests use `{ baseDelayMs: 0 }`). */
  retry?: RetryOptions;
}

export function pricingFor(config: ProviderConfig): PricingInfo | undefined {
  return config.pricing ?? getPreset(config.presetId)?.pricing;
}

/** Descriptor = config, completed with preset defaults and adapter defaults. */
export function buildDescriptor(config: ProviderConfig, adapterDefaults: Capability[]): ProviderDescriptor {
  const preset = getPreset(config.presetId);
  const d: ProviderDescriptor = {
    id: config.id,
    name: config.name,
    adapter: config.adapter,
    location: config.location,
    capabilities: config.capabilities?.length
      ? [...config.capabilities]
      : unionCapabilities(preset?.capabilities ?? adapterDefaults),
    qualityTier: config.qualityTier ?? preset?.qualityTier ?? 3,
  };
  if (config.presetId) d.presetId = config.presetId;
  const pricing = pricingFor(config);
  if (pricing) d.pricing = pricing;
  if (preset?.docsUrl) d.docsUrl = preset.docsUrl;
  if (preset?.description) d.description = preset.description;
  const model = config.defaultModel ?? preset?.defaultModel;
  if (model) d.defaultModel = model;
  return d;
}

/** HttpClient with the provider's auth, timeout and concurrency/rate gate. */
export function createHttpClient(
  config: ProviderConfig,
  deps: CreateProviderDeps,
  gate?: RequestGate,
): HttpClient {
  const headers: Record<string, string> = {};
  return new HttpClient({
    providerId: config.id,
    transport: deps.transport,
    auth: authForConfig(config),
    timeoutMs: config.timeoutMs,
    gate:
      gate ??
      new RequestGate({
        concurrency: config.concurrency,
        requestsPerMinute: config.requestsPerMinute,
        clock: deps.clock,
      }),
    retry: { ...(deps.clock ? { clock: deps.clock } : {}), ...(deps.retry ?? {}) },
    headers,
  });
}

/** Merge discovered models with manual ones from the config (manual entries win). */
export function mergeManualModels(
  discovered: ModelInfo[],
  config: ProviderConfig,
  fallbackCaps: Capability[],
): ModelInfo[] {
  const byId = new Map(discovered.map((m) => [m.id, m]));
  for (const m of config.models ?? []) {
    const existing = byId.get(m.id);
    byId.set(m.id, {
      ...(existing ?? { id: m.id, capabilities: fallbackCaps }),
      ...(m.name ? { name: m.name } : {}),
      ...(m.capabilities?.length ? { capabilities: [...m.capabilities], capabilitiesInferred: false } : {}),
      ...(m.contextLength ? { contextLength: m.contextLength } : {}),
      ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(m.qualityTier ? { qualityTier: m.qualityTier } : {}),
      manual: true,
    });
  }
  return [...byId.values()];
}

/** Effective structured-output mode, honoring downgrades learned from provider errors. */
export function structuredMode(
  config: ProviderConfig,
  fallback: StructuredOutputMode = 'json_schema',
): StructuredOutputMode {
  return config.structuredOutput ?? getPreset(config.presetId)?.structuredOutput ?? fallback;
}

/** Errors that mean "this endpoint does not support that structured-output feature". */
export function isStructuredOutputRejection(err: unknown): boolean {
  return (
    err instanceof ProviderError &&
    err.kind === 'bad-request' &&
    /response_format|json_schema|json schema|schema|structured|json_object|output_config|format|grammar|guided/i.test(
      err.message,
    )
  );
}

export const STRUCTURED_DOWNGRADE: Record<StructuredOutputMode, StructuredOutputMode | undefined> = {
  json_schema: 'json_object',
  json_object: 'prompt',
  prompt: undefined,
};

/** Text of a message (audio parts are skipped). */
export function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function hasAudio(req: LLMRequest): boolean {
  return req.messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'audio'));
}

/** Parse JSON from model text when a schema was requested. */
export function jsonFromText(text: string, wanted: boolean): unknown {
  if (!wanted) return undefined;
  const ex = extractJson(text);
  return ex.ok ? ex.value : undefined;
}

export function costFor(
  config: ProviderConfig,
  model: string,
  usage: TokenUsage | undefined,
): number | undefined {
  return llmCostUsd(pricingFor(config), model, usage);
}

/** Truncated structured output → ProviderError('truncated') carrying the partial text. */
export function truncatedError(providerId: string, text: string): ProviderError {
  return new ProviderError(
    'truncated',
    'The model hit its output token limit before finishing the JSON answer',
    { providerId, partialText: text },
  );
}

// ---------------------------------------------------------------------------
// Audio in JSON
// ---------------------------------------------------------------------------

export interface EncodedAudioJson {
  mimeType: string;
  /** base64 */
  data: string;
  sampleRate?: number;
  channels?: number;
  durationSeconds?: number;
}

export function audioToJson(a: EncodedAudio): EncodedAudioJson {
  const out: EncodedAudioJson = { mimeType: a.mimeType, data: bytesToBase64(a.data) };
  if (a.sampleRate) out.sampleRate = a.sampleRate;
  if (a.channels) out.channels = a.channels;
  if (a.durationSeconds) out.durationSeconds = a.durationSeconds;
  return out;
}

export function audioFromJson(j: EncodedAudioJson | { mimeType?: string; data: string }): EncodedAudio {
  return { ...(j as EncodedAudioJson), mimeType: j.mimeType ?? 'audio/wav', data: base64ToBytes(j.data) };
}

export function audioFromBase64(b64: string, mimeType = 'audio/wav'): EncodedAudio {
  return { mimeType, data: base64ToBytes(b64) };
}

export function audioFromResponse(
  data: Uint8Array,
  contentType: string | undefined,
  fallbackFormat?: string,
): EncodedAudio {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const mimeType = ct.startsWith('audio/') ? ct : audioMimeType(fallbackFormat, 'audio/wav');
  return { mimeType, data };
}

export function notSupported(providerId: string, what: string): ProviderError {
  return new ProviderError('unsupported', `${what} is not supported by this provider`, { providerId });
}

// ---------------------------------------------------------------------------
// Asynchronous jobs (submit → poll → download)
// ---------------------------------------------------------------------------

export interface PollOptions {
  clock?: Clock;
  /** Delay between polls (default 3 s). */
  intervalMs?: number;
  /** Give up after this long (default: the provider timeout). */
  timeoutMs: number;
  signal?: AbortSignal;
  providerId: string;
  /** What is being waited for, for the timeout message. */
  what: string;
}

/**
 * Poll `check` until it returns a value (not `undefined`). `check` throws to fail the job.
 * Honours cancellation between polls and gives up with a `timeout` error.
 */
export async function pollUntil<T>(check: () => Promise<T | undefined>, opts: PollOptions): Promise<T> {
  const clock = opts.clock ?? systemClock;
  const started = clock.now();
  const interval = Math.max(0, opts.intervalMs ?? 3000);
  for (;;) {
    if (opts.signal?.aborted)
      throw new ProviderError('cancelled', 'Request cancelled', { providerId: opts.providerId });
    const v = await check();
    if (v !== undefined) return v;
    if (clock.now() - started >= opts.timeoutMs)
      throw new ProviderError(
        'timeout',
        `${opts.what} did not finish in ${Math.round(opts.timeoutMs / 1000)} s`,
        {
          providerId: opts.providerId,
        },
      );
    await clock.sleep(interval, opts.signal);
  }
}

/**
 * Download a generated file from the URL a provider returned. No credentials are sent (result URLs
 * are pre-signed and often live on another host); through the server proxy the host must be one of
 * the provider's `extra.downloadHosts`.
 */
export async function downloadResult(
  http: HttpClient,
  url: string,
  signal: AbortSignal | undefined,
  fallbackFormat = 'mp3',
): Promise<EncodedAudio> {
  const r = await http.bytes({ url, method: 'GET', auth: null, accept: 'audio/*,*/*', signal });
  return audioFromResponse(r.data, r.contentType, fallbackFormat.replace(/^.*\./, ''));
}

/** File extension of a URL path (`…/song.flac?sig=…` → `flac`). */
export function urlExtension(url: string): string | undefined {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
