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
import { type Clock, RequestGate, type RetryOptions } from '../transport/limiter';
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
    capabilities: config.capabilities?.length ? [...config.capabilities] : unionCapabilities(preset?.capabilities ?? adapterDefaults),
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
export function createHttpClient(config: ProviderConfig, deps: CreateProviderDeps, gate?: RequestGate): HttpClient {
  const headers: Record<string, string> = {};
  return new HttpClient({
    providerId: config.id,
    transport: deps.transport,
    auth: authForConfig(config),
    timeoutMs: config.timeoutMs,
    gate: gate ?? new RequestGate({ concurrency: config.concurrency, requestsPerMinute: config.requestsPerMinute, clock: deps.clock }),
    retry: { ...(deps.clock ? { clock: deps.clock } : {}), ...(deps.retry ?? {}) },
    headers,
  });
}

/** Merge discovered models with manual ones from the config (manual entries win). */
export function mergeManualModels(discovered: ModelInfo[], config: ProviderConfig, fallbackCaps: Capability[]): ModelInfo[] {
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
export function structuredMode(config: ProviderConfig, fallback: StructuredOutputMode = 'json_schema'): StructuredOutputMode {
  return config.structuredOutput ?? getPreset(config.presetId)?.structuredOutput ?? fallback;
}

/** Errors that mean "this endpoint does not support that structured-output feature". */
export function isStructuredOutputRejection(err: unknown): boolean {
  return err instanceof ProviderError && err.kind === 'bad-request' && /response_format|json_schema|json schema|schema|structured|json_object|output_config|format|grammar|guided/i.test(err.message);
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

export function costFor(config: ProviderConfig, model: string, usage: TokenUsage | undefined): number | undefined {
  return llmCostUsd(pricingFor(config), model, usage);
}

/** Truncated structured output → ProviderError('truncated') carrying the partial text. */
export function truncatedError(providerId: string, text: string): ProviderError {
  return new ProviderError('truncated', 'The model hit its output token limit before finishing the JSON answer', { providerId, partialText: text });
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

export function audioFromResponse(data: Uint8Array, contentType: string | undefined, fallbackFormat?: string): EncodedAudio {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const mimeType = ct.startsWith('audio/') ? ct : audioMimeType(fallbackFormat, 'audio/wav');
  return { mimeType, data };
}

export function notSupported(providerId: string, what: string): ProviderError {
  return new ProviderError('unsupported', `${what} is not supported by this provider`, { providerId });
}
