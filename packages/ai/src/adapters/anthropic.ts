/**
 * Anthropic adapter — official SDK (`@anthropic-ai/sdk`) with a custom `fetch` routed through the
 * Song Deck Transport. The SDK gets a placeholder key ('proxy-managed'); the transport injects the
 * real `x-api-key` (DirectTransport from the credential store, ServerProxyTransport in the server
 * vault), so secrets never live in configs.
 *
 * Requests: `messages.create({ model, max_tokens, system, messages, output_config: { format:
 * { type: 'json_schema', schema }, effort } })`. No temperature/top_p/top_k, no `thinking`.
 * Refusal fallbacks (default on for supported models, first-party API only):
 * `beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })`.
 * `stop_reason === 'refusal'` is checked before reading content; `max_tokens` with JSON → 'truncated'.
 */
import Anthropic from '@anthropic-ai/sdk';
import { type Capability, LLM_BASE_CAPABILITIES } from '../capabilities';
import type { ProviderConfig } from '../config';
import { ProviderError, toProviderError } from '../errors';
import { inferQualityTier } from '../model-heuristics';
import { compileSchema, schemaInstructions } from '../schemas/dialects';
import { isRetryableHttpError } from '../transport/http';
import { RequestGate, withRetry, withTimeout } from '../transport/limiter';
import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo, ProviderInstance, Transport, TransportAuth } from '../types';
import { buildDescriptor, costFor, type CreateProviderDeps, jsonFromText, mergeManualModels, structuredMode, truncatedError } from './common';

export const ANTHROPIC_FIRST_PARTY_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Models for which server-side refusal fallbacks are enabled by default. */
export const ANTHROPIC_REFUSAL_FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_PLACEHOLDER_KEY = 'proxy-managed';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** SDK baseURL (no trailing slash, no /v1 — the SDK appends /v1/messages). */
export function anthropicSdkBaseUrl(baseUrl: string | undefined): string {
  const b = (baseUrl || ANTHROPIC_FIRST_PARTY_BASE_URL).trim().replace(/\/+$/, '');
  return b.replace(/\/v1$/, '');
}

export function isAnthropicFirstParty(baseUrl: string | undefined): boolean {
  return anthropicSdkBaseUrl(baseUrl) === ANTHROPIC_FIRST_PARTY_BASE_URL;
}

export function supportsRefusalFallback(model: string): boolean {
  return ANTHROPIC_REFUSAL_FALLBACK_MODELS.some((m) => model === m || model.startsWith(`${m}-`));
}

/** fetch for the SDK that routes through a Song Deck Transport. */
export function transportFetch(transport: Transport, auth: TransportAuth | undefined) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' || input instanceof URL) return transport.fetch(String(input), init ?? {}, auth);
    const req = input as Request;
    const body = req.body ? new Uint8Array(await req.arrayBuffer()) : undefined;
    return transport.fetch(req.url, { method: req.method, headers: req.headers, body, signal: req.signal, ...(init ?? {}) }, auth);
  };
}

/** Map SDK errors (typed classes) to normalized ProviderErrors. */
export function mapAnthropicError(err: unknown, providerId: string, timedOut = false): ProviderError {
  if (err instanceof ProviderError) return err;
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  if (cause instanceof ProviderError) return cause;
  if (err instanceof Anthropic.APIUserAbortError) {
    return timedOut ? new ProviderError('timeout', 'Anthropic request timed out', { providerId }) : new ProviderError('cancelled', 'Request cancelled', { providerId });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'Anthropic request timed out', { providerId, cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', err.message || 'Could not reach the Anthropic API', { providerId, cause: err });
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const retryAfter = err.headers?.get?.('retry-after');
    const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : undefined;
    const opts = { providerId, status, retryAfterMs, details: err.error, cause: err };
    const message = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', message, opts);
    if (err instanceof Anthropic.RateLimitError) return new ProviderError('rate-limit', message, opts);
    if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError || err instanceof Anthropic.ConflictError) {
      return new ProviderError('bad-request', message, opts);
    }
    if (err instanceof Anthropic.InternalServerError || (status !== undefined && status >= 500)) return new ProviderError('unavailable', message, opts);
    if (status === 408) return new ProviderError('timeout', message, opts);
    return new ProviderError('unknown', message, opts);
  }
  return toProviderError(err, providerId);
}

interface ContentBlockLike {
  type: string;
  text?: string;
  to?: { model?: string };
}

interface MessageLike {
  model: string;
  content: ContentBlockLike[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
}

/** Map the models API's capability object to the Song Deck taxonomy. */
export function anthropicModelInfo(m: { id: string; display_name?: string; max_input_tokens?: number | null; max_tokens?: number | null; capabilities?: unknown }): ModelInfo {
  const caps = (m.capabilities ?? null) as Record<string, { supported?: boolean } & Record<string, { supported?: boolean } | boolean | null>> | null;
  const supported = (k: string) => caps?.[k]?.supported === true;
  const capabilities: Capability[] = [...LLM_BASE_CAPABILITIES, 'TOOL_CALLING'];
  if (!caps || supported('structured_outputs')) capabilities.push('STRUCTURED_JSON');
  if ((m.max_input_tokens ?? 200_000) >= 100_000) capabilities.push('LONG_CONTEXT');
  const effortLevels = caps?.effort ? (['low', 'medium', 'high', 'xhigh', 'max'] as const).filter((l) => (caps.effort?.[l] as { supported?: boolean } | null | undefined)?.supported === true) : [];
  const info: ModelInfo = {
    id: m.id,
    capabilities,
    qualityTier: inferQualityTier(m.id),
    meta: {
      structuredOutputs: caps ? supported('structured_outputs') : undefined,
      effort: caps ? supported('effort') : undefined,
      effortLevels,
      thinking: caps ? supported('thinking') : undefined,
      imageInput: caps ? supported('image_input') : undefined,
      pdfInput: caps ? supported('pdf_input') : undefined,
    },
  };
  if (m.display_name) info.name = m.display_name;
  if (m.max_input_tokens) info.contextLength = m.max_input_tokens;
  if (m.max_tokens) info.maxOutputTokens = m.max_tokens;
  return info;
}

export interface AnthropicLLMOptions {
  transport: Transport;
  gate?: RequestGate;
  retry?: CreateProviderDeps['retry'];
  /** Override the SDK client (tests). */
  client?: Anthropic;
}

export class AnthropicLLM implements LLMProvider {
  readonly client: Anthropic;
  private readonly gate: RequestGate;
  private models = new Map<string, ModelInfo>();
  /** Features the API rejected for a model (learned at runtime). */
  private readonly noEffort = new Set<string>();
  private readonly noFormat = new Set<string>();
  private fallbackDisabled = false;

  constructor(
    readonly config: ProviderConfig,
    private readonly opts: AnthropicLLMOptions,
  ) {
    const auth: TransportAuth = { ...config.auth, credentialRef: config.auth.type === 'none' ? undefined : config.credentialRef };
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: ANTHROPIC_PLACEHOLDER_KEY,
        authToken: null,
        baseURL: anthropicSdkBaseUrl(config.baseUrl),
        fetch: transportFetch(opts.transport, auth),
        dangerouslyAllowBrowser: true,
        maxRetries: 0,
        timeout: config.timeoutMs,
        logLevel: 'off',
      });
    this.gate = opts.gate ?? new RequestGate({ concurrency: config.concurrency, requestsPerMinute: config.requestsPerMinute });
  }

  private async call<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withRetry(
      () =>
        this.gate.run(async () => {
          const t = withTimeout(signal, this.config.timeoutMs);
          try {
            return await fn(t.signal);
          } catch (err) {
            throw mapAnthropicError(err, this.config.id, t.timedOut());
          } finally {
            t.dispose();
          }
        }, signal),
      { isRetryable: isRetryableHttpError, ...(this.opts.retry ?? {}) },
      signal,
      this.config.id,
    );
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models = await this.call(async (s) => {
      const out: ModelInfo[] = [];
      for await (const m of this.client.models.list({ limit: 100 }, { signal: s })) out.push(anthropicModelInfo(m));
      return out;
    }, signal);
    const merged = mergeManualModels(models, this.config, [...LLM_BASE_CAPABILITIES, 'STRUCTURED_JSON']);
    this.models = new Map(merged.map((m) => [m.id, m]));
    return merged;
  }

  private effortFor(model: string): AnthropicEffort | undefined {
    const configured = this.config.extra?.effort;
    if (this.noEffort.has(model)) return undefined;
    const info = this.models.get(model);
    if (info?.meta?.effort === false) return undefined;
    const level: AnthropicEffort = configured ?? 'medium';
    const levels = info?.meta?.effortLevels as string[] | undefined;
    if (levels?.length && !levels.includes(level)) return levels.includes('medium') ? 'medium' : (levels[0] as AnthropicEffort);
    return level;
  }

  private nativeFormat(model: string): boolean {
    if (structuredMode(this.config) !== 'json_schema') return false;
    if (this.noFormat.has(model)) return false;
    return this.models.get(model)?.meta?.structuredOutputs !== false;
  }

  /** Build Messages API params (exported for inspection in tests). */
  buildParams(req: LLMRequest, model: string): Record<string, unknown> {
    const schema = req.responseSchema;
    const native = !!schema && this.nativeFormat(model);
    let system = req.system ?? '';
    if (schema && !native) system = [system, schemaInstructions(schema, req.schemaName)].filter(Boolean).join('\n\n');
    const messages = req.messages.map((m) => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: m.content.map((p) => {
          if (p.type === 'audio') throw new ProviderError('unsupported', 'Claude models do not accept audio input', { providerId: this.config.id });
          return { type: 'text' as const, text: p.text };
        }),
      };
    });
    const params: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? this.config.extra?.maxOutputTokens ?? 8192,
      messages,
    };
    if (system) params.system = system;
    const outputConfig: Record<string, unknown> = {};
    if (native && schema) outputConfig.format = { type: 'json_schema', schema: compileSchema(schema, 'anthropic') };
    const effort = this.effortFor(model);
    if (effort) outputConfig.effort = effort;
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;
    return params;
  }

  private useFallbacks(model: string): boolean {
    return !this.fallbackDisabled && (this.config.extra?.refusalFallback ?? true) && isAnthropicFirstParty(this.config.baseUrl) && supportsRefusalFallback(model);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = req.model ?? this.config.defaultModel ?? ANTHROPIC_DEFAULT_MODEL;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.send(req, model);
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'bad-request') throw err;
        const msg = err.message;
        // Learn unsupported features once and retry without them.
        if (/effort/i.test(msg) && this.effortFor(model)) {
          this.noEffort.add(model);
          continue;
        }
        if (/fallback|beta/i.test(msg) && this.useFallbacks(model)) {
          this.fallbackDisabled = true;
          continue;
        }
        if (req.responseSchema && /output_config|format|schema|structured/i.test(msg) && this.nativeFormat(model)) {
          this.noFormat.add(model);
          continue;
        }
        throw err;
      }
    }
    throw new ProviderError('bad-request', 'Anthropic request failed after adjusting unsupported options', { providerId: this.config.id });
  }

  private async send(req: LLMRequest, model: string): Promise<LLMResponse> {
    const params = this.buildParams(req, model);
    const fallbacks = this.useFallbacks(model);
    const native = !!(params.output_config as { format?: unknown } | undefined)?.format;
    const msg = (await this.call(async (signal) => {
      if (fallbacks) {
        const betaParams = { ...params, betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: 'default' } as unknown as Parameters<Anthropic['beta']['messages']['create']>[0];
        return (await this.client.beta.messages.create(betaParams as never, { signal })) as unknown as MessageLike;
      }
      const p = params as unknown as Anthropic.MessageCreateParamsNonStreaming;
      return (await this.client.messages.create(p, { signal })) as unknown as MessageLike;
    }, req.signal)) as MessageLike;

    // Refusal is checked BEFORE reading content.
    if (msg.stop_reason === 'refusal') {
      throw new ProviderError('refusal', msg.stop_details?.explanation || 'The model declined this request', {
        providerId: this.config.id,
        category: msg.stop_details?.category ?? null,
        details: msg.stop_details,
      });
    }
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const fallbackBlock = msg.content.filter((b) => b.type === 'fallback').pop();
    if (msg.stop_reason === 'max_tokens' && req.responseSchema) throw truncatedError(this.config.id, text);
    const usage = msg.usage
      ? {
          inputTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0),
          outputTokens: msg.usage.output_tokens ?? 0,
        }
      : undefined;
    const usedModel = fallbackBlock?.to?.model ?? msg.model ?? model;
    const res: LLMResponse = {
      text,
      model: msg.model ?? model,
      stopReason: msg.stop_reason ?? 'end_turn',
      structured: req.responseSchema ? (native ? 'native' : 'prompt') : undefined,
    };
    if (fallbackBlock?.to?.model) res.fallbackModel = fallbackBlock.to.model;
    const parsed = jsonFromText(text, !!req.responseSchema);
    if (parsed !== undefined) res.json = parsed;
    if (usage) res.usage = usage;
    const cost = costFor(this.config, usedModel, usage);
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }
}

export function createAnthropicProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const gate = new RequestGate({ concurrency: config.concurrency, requestsPerMinute: config.requestsPerMinute, clock: deps.clock });
  const llm = new AnthropicLLM(config, { transport: deps.transport, gate, retry: { ...(deps.clock ? { clock: deps.clock } : {}), ...(deps.retry ?? {}) } });
  return { descriptor: buildDescriptor(config, [...LLM_BASE_CAPABILITIES, 'STRUCTURED_JSON', 'TOOL_CALLING', 'LONG_CONTEXT']), config, llm };
}
