/**
 * Ollama native adapter (`http://localhost:11434`).
 *
 * - `GET  /api/tags`  → installed models
 * - `POST /api/show`  `{ model }` → details (context length, capabilities)
 * - `POST /api/chat`  `{ model, messages, stream: false, format: <json schema> | 'json',
 *   options: { temperature?, num_ctx, num_predict } }` → `message.content`
 */
import { LLM_BASE_CAPABILITIES } from '../capabilities';
import type { ProviderConfig, StructuredOutputMode } from '../config';
import { ProviderError } from '../errors';
import { inferModelCapabilities } from '../model-heuristics';
import { compileSchema, schemaInstructions } from '../schemas/dialects';
import type { HttpClient } from '../transport/http';
import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo, ProviderInstance } from '../types';
import { joinUrl } from '../util';
import {
  buildDescriptor,
  createHttpClient,
  type CreateProviderDeps,
  isStructuredOutputRejection,
  jsonFromText,
  mergeManualModels,
  messageText,
  STRUCTURED_DOWNGRADE,
  structuredMode,
  truncatedError,
} from './common';

interface OllamaTag {
  name: string;
  model?: string;
  size?: number;
  modified_at?: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    format?: string;
  };
}

interface OllamaShow {
  model_info?: Record<string, unknown>;
  capabilities?: string[];
  details?: OllamaTag['details'];
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaOptions {
  /** Call /api/show per model during discovery (context length, capabilities). Default true. */
  showDetails?: boolean;
}

export class OllamaLLM implements LLMProvider {
  private mode: StructuredOutputMode;
  private models = new Map<string, ModelInfo>();

  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
    private readonly opts: OllamaOptions = {},
  ) {
    this.mode = structuredMode(config, 'json_schema');
  }

  private get base(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  async show(model: string, signal?: AbortSignal): Promise<OllamaShow> {
    // `name` is accepted by older Ollama versions, `model` by current ones.
    return this.http.json<OllamaShow>({
      url: joinUrl(this.base, 'api/show'),
      json: { model, name: model },
      signal,
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const tags = await this.http.json<{ models?: OllamaTag[] }>({
      url: joinUrl(this.base, 'api/tags'),
      method: 'GET',
      signal,
    });
    const out: ModelInfo[] = [];
    for (const t of tags?.models ?? []) {
      let contextLength: number | undefined;
      let serverCaps: string[] | undefined;
      if (this.opts.showDetails !== false) {
        try {
          const info = await this.show(t.name, signal);
          const ctxKey = Object.keys(info?.model_info ?? {}).find((k) => k.endsWith('.context_length'));
          if (ctxKey) contextLength = Number(info.model_info![ctxKey]) || undefined;
          if (Array.isArray(info?.capabilities)) serverCaps = info.capabilities;
        } catch {
          /* details are optional */
        }
      }
      const inferred = inferModelCapabilities(t.name, {
        contextLength,
        parameterSize: t.details?.parameter_size,
        structuredOutput: this.mode !== 'prompt',
        serverCapabilities: serverCaps,
      });
      if (!inferred) continue;
      const m: ModelInfo = {
        id: t.name,
        ...inferred,
        meta: {
          size: t.size,
          family: t.details?.family,
          parameterSize: t.details?.parameter_size,
          quantization: t.details?.quantization_level,
        },
      };
      out.push(m);
    }
    const merged = mergeManualModels(out, this.config, [...LLM_BASE_CAPABILITIES]);
    this.models = new Map(merged.map((m) => [m.id, m]));
    return merged;
  }

  buildBody(req: LLMRequest, model: string, mode: StructuredOutputMode): Record<string, unknown> {
    const schema = req.responseSchema;
    let system = req.system ?? '';
    if (schema) system = [system, schemaInstructions(schema, req.schemaName)].filter(Boolean).join('\n\n');
    const messages: { role: string; content: string }[] = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const m of req.messages) {
      if (typeof m.content !== 'string' && m.content.some((p) => p.type === 'audio')) {
        throw new ProviderError('unsupported', 'Ollama chat models do not accept audio input', {
          providerId: this.config.id,
        });
      }
      messages.push({ role: m.role, content: messageText(m) });
    }
    const options: Record<string, unknown> = {};
    const ctx = this.config.contextLength ?? this.models.get(model)?.contextLength;
    if (ctx) options.num_ctx = ctx;
    const maxTokens = req.maxTokens ?? this.config.extra?.maxOutputTokens;
    if (maxTokens) options.num_predict = maxTokens;
    if (req.temperature !== undefined) options.temperature = req.temperature;
    const body: Record<string, unknown> = { model, messages, stream: false };
    if (schema && mode === 'json_schema') body.format = compileSchema(schema, 'json-schema');
    else if (schema && mode === 'json_object') body.format = 'json';
    if (Object.keys(options).length) body.options = options;
    return body;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    let model = req.model ?? this.config.defaultModel ?? this.config.models?.[0]?.id;
    if (!model) {
      const models = this.models.size
        ? [...this.models.values()]
        : await this.listModels(req.signal).catch(() => []);
      model = [...models].sort(
        (a, b) => (b.qualityTier ?? 0) - (a.qualityTier ?? 0) || a.id.localeCompare(b.id),
      )[0]?.id;
      if (!model)
        throw new ProviderError('bad-request', 'No Ollama model installed (run `ollama pull <model>`)', {
          providerId: this.config.id,
        });
    }
    let mode: StructuredOutputMode = req.responseSchema ? this.mode : 'prompt';
    for (;;) {
      try {
        return await this.send(req, model, mode);
      } catch (err) {
        const next = STRUCTURED_DOWNGRADE[mode];
        if (req.responseSchema && next && isStructuredOutputRejection(err)) {
          mode = next;
          this.mode = next;
          continue;
        }
        throw err;
      }
    }
  }

  private async send(req: LLMRequest, model: string, mode: StructuredOutputMode): Promise<LLMResponse> {
    const json = await this.http.json<OllamaChatResponse>({
      url: joinUrl(this.base, 'api/chat'),
      json: this.buildBody(req, model, mode),
      signal: req.signal,
    });
    const text = json?.message?.content ?? '';
    if (json?.done_reason === 'length' && req.responseSchema) throw truncatedError(this.config.id, text);
    const res: LLMResponse = {
      text,
      model: json?.model ?? model,
      stopReason: json?.done_reason === 'length' ? 'max_tokens' : (json?.done_reason ?? 'stop'),
      structured: !req.responseSchema
        ? undefined
        : mode === 'json_schema'
          ? 'native'
          : mode === 'json_object'
            ? 'json-mode'
            : 'prompt',
      costUsd: 0,
    };
    if (json?.prompt_eval_count !== undefined || json?.eval_count !== undefined)
      res.usage = { inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 };
    const parsed = jsonFromText(text, !!req.responseSchema);
    if (parsed !== undefined) res.json = parsed;
    return res;
  }
}

export function createOllamaProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, [...LLM_BASE_CAPABILITIES, 'STRUCTURED_JSON']),
    config,
    llm: new OllamaLLM(config, http),
  };
}
