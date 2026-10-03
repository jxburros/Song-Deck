/**
 * Custom HTTP LLM adapter (spec §4.1 "custom HTTP endpoint"): the user describes the request with
 * a template (method, URL, headers, body with placeholders) and where the generated text is in the
 * response (`choices[0].message.content`, `results[0].text`…). JSON output is requested through
 * the prompt (and `{{schema_json}}` for endpoints that accept a schema).
 */
import { LLM_BASE_CAPABILITIES } from '../capabilities';
import type { CustomHttpTemplate, ProviderConfig } from '../config';
import { ConfigurationError, ProviderError } from '../errors';
import { compileSchema, schemaInstructions } from '../schemas/dialects';
import type { HttpClient } from '../transport/http';
import type { LLMProvider, LLMRequest, LLMResponse, ModelInfo, ProviderInstance } from '../types';
import { getPath } from '../util';
import { buildDescriptor, costFor, createHttpClient, type CreateProviderDeps, jsonFromText, messageText, truncatedError } from './common';

export interface TemplateVars {
  system: string;
  prompt: string;
  model: string;
  messages: { role: string; content: string }[];
  schema?: unknown;
  maxTokens: number;
  temperature?: number;
}

const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1);

/**
 * Render a body/URL template. In bodies, string placeholders are JSON-escaped (place them inside
 * quotes); `*_json` placeholders insert raw JSON; numbers insert as numbers. In URLs
 * (`json: false`) string placeholders are URL-encoded.
 */
export function renderTemplate(template: string, vars: TemplateVars, opts: { json?: boolean } = {}): string {
  const esc = opts.json === false ? encodeURIComponent : jsonEscape;
  const map: Record<string, string> = {
    system: esc(vars.system),
    prompt: esc(vars.prompt),
    model: esc(vars.model),
    system_json: JSON.stringify(vars.system),
    prompt_json: JSON.stringify(vars.prompt),
    messages_json: JSON.stringify(vars.messages),
    schema_json: vars.schema === undefined ? 'null' : JSON.stringify(vars.schema),
    max_tokens: String(vars.maxTokens),
    temperature: vars.temperature === undefined ? 'null' : String(vars.temperature),
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, key: string) => (key in map ? map[key] : all));
}

export class CustomHttpLLM implements LLMProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  private get template(): CustomHttpTemplate {
    const t = this.config.extra?.customTemplate;
    if (!t?.body || !t.responseTextPath) throw new ConfigurationError(`Custom HTTP provider "${this.config.id}" needs extra.customTemplate.body and responseTextPath`);
    return t;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const t = this.config.extra?.customTemplate;
    const fallbackCaps = this.config.capabilities?.length ? this.config.capabilities : [...LLM_BASE_CAPABILITIES];
    const manual: ModelInfo[] = (this.config.models ?? []).map((m) => ({ id: m.id, name: m.name, capabilities: m.capabilities ?? [...fallbackCaps], contextLength: m.contextLength, manual: true }));
    if (!t?.modelsUrl) {
      if (manual.length) return manual;
      return this.config.defaultModel ? [{ id: this.config.defaultModel, capabilities: [...fallbackCaps], manual: true }] : [];
    }
    const json = await this.http.json<unknown>({ url: t.modelsUrl, method: 'GET', signal });
    const list = getPath(json, t.modelsPath ?? 'data');
    const ids = (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : ((x as { id?: string; name?: string })?.id ?? (x as { name?: string })?.name))).filter((x): x is string => !!x);
    const discovered: ModelInfo[] = ids.map((id) => ({ id, capabilities: [...fallbackCaps] }));
    const manualIds = new Set(manual.map((m) => m.id));
    return [...manual, ...discovered.filter((m) => !manualIds.has(m.id))];
  }

  /** Render the HTTP request for an LLM request (exported for tests/UI preview). */
  render(req: LLMRequest): { url: string; method: string; headers: Record<string, string>; body?: string } {
    const t = this.template;
    const schema = req.responseSchema;
    const system = [req.system ?? '', schema ? schemaInstructions(schema, req.schemaName) : ''].filter(Boolean).join('\n\n');
    const convo = req.messages.map((m) => ({ role: m.role, content: messageText(m) }));
    const prompt = convo.length === 1 ? convo[0].content : convo.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');
    const vars: TemplateVars = {
      system,
      prompt,
      model: req.model ?? this.config.defaultModel ?? '',
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...convo],
      schema: schema ? compileSchema(schema, 'json-schema') : undefined,
      maxTokens: req.maxTokens ?? this.config.extra?.maxOutputTokens ?? 4096,
      temperature: req.temperature,
    };
    const url = renderTemplate(t.url ?? this.config.baseUrl, vars, { json: false });
    const method = t.method ?? 'POST';
    const headers = { ...(t.headers ?? {}) };
    if (method === 'GET') return { url, method, headers };
    return { url, method, headers, body: renderTemplate(t.body, vars) };
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const t = this.template;
    const r = this.render(req);
    const lower = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const json = await this.http.json<unknown>({
      url: r.url,
      method: r.method as 'GET' | 'POST' | 'PUT',
      headers: r.headers,
      body: r.body,
      contentType: lower['content-type'] ?? 'application/json',
      signal: req.signal,
    });
    const value = getPath(json, t.responseTextPath);
    if (typeof value !== 'string') {
      throw new ProviderError('parse', `No text at "${t.responseTextPath}" in the response`, { providerId: this.config.id, details: json });
    }
    const finish = getPath(json, 'choices[0].finish_reason') ?? getPath(json, 'done_reason');
    if (finish === 'length' && req.responseSchema) throw truncatedError(this.config.id, value);
    const res: LLMResponse = { text: value, model: req.model ?? this.config.defaultModel ?? 'custom', stopReason: typeof finish === 'string' ? finish : 'stop', structured: req.responseSchema ? 'prompt' : undefined };
    const inTok = t.inputTokensPath ? Number(getPath(json, t.inputTokensPath)) : NaN;
    const outTok = t.outputTokensPath ? Number(getPath(json, t.outputTokensPath)) : NaN;
    if (Number.isFinite(inTok) || Number.isFinite(outTok)) res.usage = { inputTokens: Number.isFinite(inTok) ? inTok : 0, outputTokens: Number.isFinite(outTok) ? outTok : 0 };
    const parsed = jsonFromText(value, !!req.responseSchema);
    if (parsed !== undefined) res.json = parsed;
    const cost = this.config.location === 'local' ? 0 : costFor(this.config, res.model, res.usage);
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }
}

export function createCustomHttpProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return { descriptor: buildDescriptor(config, [...LLM_BASE_CAPABILITIES]), config, llm: new CustomHttpLLM(config, http) };
}
