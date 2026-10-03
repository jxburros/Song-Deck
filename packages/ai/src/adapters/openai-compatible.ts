/**
 * OpenAI-compatible Chat Completions adapter — OpenAI, Moonshot, Meta Llama API, Together, Groq,
 * LM Studio, vLLM, llama.cpp server (spec §3.1, §4.1).
 *
 * - `GET  {base}/models`
 * - `POST {base}/chat/completions` `{ model, messages, max_tokens | max_completion_tokens,
 *   temperature?, response_format }` where response_format follows `structuredOutput`:
 *   `json_schema` → `{type:'json_schema', json_schema:{name, schema, strict:true}}`,
 *   `json_object` → `{type:'json_object'}` (schema described in the prompt), `prompt` → none.
 * - Auth `Authorization: Bearer` (via the transport), optional `OpenAI-Organization` /
 *   `OpenAI-Project` headers.
 * If the endpoint rejects the structured-output feature, the adapter downgrades
 * json_schema → json_object → prompt once and remembers it.
 */
import { LLM_BASE_CAPABILITIES } from '../capabilities';
import type { ProviderConfig, SchemaDialect, StructuredOutputMode } from '../config';
import { ProviderError } from '../errors';
import { inferModelCapabilities } from '../model-heuristics';
import { compileSchema, sanitizeSchemaName, schemaInstructions } from '../schemas/dialects';
import type { HttpClient } from '../transport/http';
import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo, ProviderInstance } from '../types';
import { audioExtension, bytesToBase64, joinUrl } from '../util';
import {
  buildDescriptor,
  costFor,
  createHttpClient,
  type CreateProviderDeps,
  isStructuredOutputRejection,
  jsonFromText,
  mergeManualModels,
  STRUCTURED_DOWNGRADE,
  structuredMode,
  truncatedError,
} from './common';

interface OpenAIModelEntry {
  id?: string;
  name?: string;
  display_name?: string;
  type?: string;
  context_length?: number;
  context_window?: number;
  max_model_len?: number;
  meta?: { n_ctx_train?: number; n_ctx?: number };
  owned_by?: string;
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    finish_reason?: string | null;
    message?: { role?: string; content?: string | null | { type?: string; text?: string }[]; refusal?: string | null };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class OpenAICompatibleLLM implements LLMProvider {
  private mode: StructuredOutputMode;
  private modelsCache?: ModelInfo[];

  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {
    this.mode = structuredMode(config, 'json_schema');
  }

  private get base(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  private extraHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.organization) h['OpenAI-Organization'] = this.config.organization;
    if (this.config.project) h['OpenAI-Project'] = this.config.project;
    return h;
  }

  private get dialect(): SchemaDialect {
    return this.config.extra?.schemaDialect ?? (this.config.location === 'local' ? 'json-schema' : 'openai-strict');
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const json = await this.http.json<unknown>({ url: joinUrl(this.base, 'models'), method: 'GET', headers: this.extraHeaders(), signal });
    const record = json as { data?: unknown; models?: unknown } | undefined;
    const list: OpenAIModelEntry[] = Array.isArray(json) ? json : Array.isArray(record?.data) ? (record!.data as OpenAIModelEntry[]) : Array.isArray(record?.models) ? (record!.models as OpenAIModelEntry[]) : [];
    const structured = this.mode !== 'prompt';
    const models: ModelInfo[] = [];
    for (const entry of list) {
      const id = entry.id ?? entry.name;
      if (!id) continue;
      if (entry.type && !/^(chat|language|text|llm)$/i.test(entry.type)) continue;
      const contextLength = entry.context_length ?? entry.context_window ?? entry.max_model_len ?? entry.meta?.n_ctx ?? entry.meta?.n_ctx_train;
      const inferred = inferModelCapabilities(id, { contextLength, structuredOutput: structured });
      if (!inferred) continue;
      const model: ModelInfo = { id, ...inferred };
      const name = entry.display_name ?? (entry.name && entry.name !== id ? entry.name : undefined);
      if (name) model.name = name;
      if (entry.owned_by) model.meta = { ownedBy: entry.owned_by };
      models.push(model);
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    this.modelsCache = mergeManualModels(models, this.config, [...LLM_BASE_CAPABILITIES]);
    return this.modelsCache;
  }

  private async resolveModel(req: LLMRequest): Promise<string> {
    const explicit = req.model ?? this.config.defaultModel;
    if (explicit) return explicit;
    const manual = this.config.models?.[0]?.id;
    if (manual) return manual;
    const models = this.modelsCache ?? (await this.listModels(req.signal).catch(() => []));
    const pick = [...models].sort((a, b) => (b.qualityTier ?? 0) - (a.qualityTier ?? 0) || a.id.localeCompare(b.id))[0];
    if (!pick) throw new ProviderError('bad-request', 'No model configured or available on this endpoint', { providerId: this.config.id });
    return pick.id;
  }

  /** Build the Chat Completions body for a mode (exported for tests via buildBody). */
  buildBody(req: LLMRequest, model: string, mode: StructuredOutputMode): Record<string, unknown> {
    const schema = req.responseSchema;
    let system = req.system ?? '';
    if (schema && mode !== 'json_schema') system = [system, schemaInstructions(schema, req.schemaName)].filter(Boolean).join('\n\n');
    const messages: Record<string, unknown>[] = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const m of req.messages) {
      if (typeof m.content === 'string') {
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      messages.push({
        role: m.role,
        content: m.content.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'input_audio', input_audio: { data: bytesToBase64(p.audio.data), format: audioExtension(p.audio.mimeType) === 'mp3' ? 'mp3' : 'wav' } },
        ),
      });
    }
    const body: Record<string, unknown> = { model, messages };
    const maxTokens = req.maxTokens ?? this.config.extra?.maxOutputTokens;
    if (maxTokens) body[this.config.extra?.maxTokensParam ?? 'max_tokens'] = maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (schema && mode === 'json_schema') {
      const dialect = this.dialect;
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: sanitizeSchemaName(req.schemaName), schema: compileSchema(schema, dialect), strict: dialect === 'openai-strict' },
      };
    } else if (schema && mode === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = await this.resolveModel(req);
    let mode: StructuredOutputMode = req.responseSchema ? this.mode : 'prompt';
    for (;;) {
      try {
        return await this.send(req, model, mode);
      } catch (err) {
        const next = STRUCTURED_DOWNGRADE[mode];
        if (req.responseSchema && next && isStructuredOutputRejection(err)) {
          mode = next;
          this.mode = next; // remember for this provider instance
          continue;
        }
        throw err;
      }
    }
  }

  private async send(req: LLMRequest, model: string, mode: StructuredOutputMode): Promise<LLMResponse> {
    const body = this.buildBody(req, model, mode);
    const json = await this.http.json<ChatCompletion>({ url: joinUrl(this.base, 'chat/completions'), json: body, headers: this.extraHeaders(), signal: req.signal });
    const choice = json?.choices?.[0];
    const msg = choice?.message;
    if (msg?.refusal) throw new ProviderError('refusal', msg.refusal, { providerId: this.config.id });
    if (choice?.finish_reason === 'content_filter') throw new ProviderError('refusal', 'The response was blocked by the provider\'s content filter', { providerId: this.config.id });
    const content = msg?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : '';
    if (choice?.finish_reason === 'length' && req.responseSchema) throw truncatedError(this.config.id, text);
    const usage = json?.usage ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 } : undefined;
    const usedModel = json?.model ?? model;
    const res: LLMResponse = {
      text,
      model: usedModel,
      stopReason: choice?.finish_reason === 'length' ? 'max_tokens' : (choice?.finish_reason ?? 'stop'),
      structured: !req.responseSchema ? undefined : mode === 'json_schema' ? 'native' : mode === 'json_object' ? 'json-mode' : 'prompt',
    };
    const parsed = jsonFromText(text, !!req.responseSchema);
    if (parsed !== undefined) res.json = parsed;
    if (usage) res.usage = usage;
    const cost = costFor(this.config, usedModel, usage);
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }
}

export function createOpenAICompatibleProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  const llm = new OpenAICompatibleLLM(config, http);
  return { descriptor: buildDescriptor(config, [...LLM_BASE_CAPABILITIES, 'STRUCTURED_JSON']), config, llm };
}
