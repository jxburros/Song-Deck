/**
 * Google Gemini adapter (Gemini API, `https://generativelanguage.googleapis.com/v1beta`).
 *
 * - `GET  /models` → `models[]` with `supportedGenerationMethods`, `inputTokenLimit`, `outputTokenLimit`
 * - `POST /models/{model}:generateContent` (header `x-goog-api-key` via the transport) with
 *   `{ contents: [{ role: 'user'|'model', parts: [{ text } | { inline_data: { mime_type, data } }] }],
 *      systemInstruction: { parts: [{ text }] },
 *      generationConfig: { responseMimeType: 'application/json', responseSchema, maxOutputTokens, temperature? } }`
 *   → `candidates[0].content.parts[].text`.
 * Audio parts (AUDIO_UNDERSTANDING) are sent inline (base64 WAV).
 *
 * Lyria music models listed by the same API key (e.g. `lyria-3-clip-preview`) are reported as
 * music models (TEXT_TO_MUSIC). When a config chooses one (`enabledModels`), the instance also gets
 * an `audioGeneration` interface that calls `POST /models/{lyria}:generateContent` with the text
 * prompt and reads the first `inlineData` audio part of the answer. That response shape follows
 * Google's published REST example but could not be verified against the docs from this
 * environment, so parsing is deliberately tolerant (camelCase and snake_case, any audio/* part).
 * Real-time Lyria (`lyria-realtime-*`, WebSocket only) is not supported. Lyria on Vertex AI (OAuth)
 * stays a separate provider (`google-lyria`).
 */
import { type Capability, LLM_BASE_CAPABILITIES, unionCapabilities } from '../capabilities';
import type { ProviderConfig, StructuredOutputMode } from '../config';
import { ProviderError } from '../errors';
import { inferQualityTier } from '../model-heuristics';
import { compileSchema, schemaInstructions } from '../schemas/dialects';
import type { HttpClient } from '../transport/http';
import type {
  AudioGenerationProvider,
  AudioGenerationResult,
  AudioTransformRequest,
  ChatMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ModelInfo,
  MusicGenerationRequest,
  ProviderInstance,
} from '../types';
import { bytesToBase64, joinUrl, withQuery } from '../util';
import {
  audioFromBase64,
  buildDescriptor,
  costFor,
  createHttpClient,
  type CreateProviderDeps,
  isStructuredOutputRejection,
  jsonFromText,
  mergeManualModels,
  notSupported,
  STRUCTURED_DOWNGRADE,
  structuredMode,
  truncatedError,
} from './common';

interface GeminiModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiResponse {
  candidates?: {
    content?: { role?: string; parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
    finishMessage?: string;
  }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
}

const NON_TEXT_MODELS =
  /(embedding|aqa|imagen|veo|tts|image-generation|image-preview|-image|live|native-audio|lyria|learnlm)/i;
const REFUSAL_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'LANGUAGE',
]);

const LYRIA = /lyria/i;
const LYRIA_REALTIME = /lyria.*realtime|realtime.*lyria/i;

export function isGeminiMusicModel(id: string): boolean {
  return LYRIA.test(id) && !LYRIA_REALTIME.test(id);
}

/** Capabilities of a Lyria model served by the Gemini API (Lyria 3 also sings). */
export function geminiMusicCapabilities(id: string): Capability[] {
  return /lyria-3/i.test(id)
    ? ['TEXT_TO_MUSIC', 'VOCAL_GENERATION', 'INSTRUMENTAL_ONLY']
    : ['TEXT_TO_MUSIC', 'INSTRUMENTAL_ONLY'];
}

export function geminiModelInfo(m: GeminiModel): ModelInfo | undefined {
  const id = m.name.replace(/^models\//, '');
  if (!(m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent')) return undefined;
  if (LYRIA.test(id)) {
    if (!isGeminiMusicModel(id)) return undefined;
    const music: ModelInfo = {
      id,
      capabilities: geminiMusicCapabilities(id),
      qualityTier: 4,
      capabilitiesInferred: true,
      meta: { music: true },
    };
    if (m.displayName) music.name = m.displayName;
    if (m.description) music.description = m.description;
    return music;
  }
  if (NON_TEXT_MODELS.test(id)) return undefined;
  const gemma = /gemma/i.test(id);
  const caps: Capability[] = [...LLM_BASE_CAPABILITIES];
  if (!gemma) caps.push('STRUCTURED_JSON', 'TOOL_CALLING', 'AUDIO_INPUT', 'AUDIO_UNDERSTANDING');
  if ((m.inputTokenLimit ?? 0) >= 100_000) caps.push('LONG_CONTEXT');
  const info: ModelInfo = { id, capabilities: caps, qualityTier: inferQualityTier(id) };
  if (m.displayName) info.name = m.displayName;
  if (m.description) info.description = m.description;
  if (m.inputTokenLimit) info.contextLength = m.inputTokenLimit;
  if (m.outputTokenLimit) info.maxOutputTokens = m.outputTokenLimit;
  return info;
}

export class GeminiLLM implements LLMProvider {
  private mode: StructuredOutputMode;
  private modelsCache?: ModelInfo[];
  skippedModels: ModelInfo[] = [];

  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {
    this.mode = structuredMode(config, 'json_schema');
  }

  private get base(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    const skipped: ModelInfo[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const json = await this.http.json<{ models?: GeminiModel[]; nextPageToken?: string }>({
        url: withQuery(joinUrl(this.base, 'models'), { pageSize: 1000, pageToken }),
        method: 'GET',
        signal,
      });
      for (const m of json?.models ?? []) {
        const info = geminiModelInfo(m);
        if (info) out.push(info);
        else if (m.name)
          skipped.push({
            id: m.name.replace(/^models\//, ''),
            ...(m.displayName ? { name: m.displayName } : {}),
            capabilities: [],
          });
      }
      pageToken = json?.nextPageToken;
      if (!pageToken) break;
    }
    this.skippedModels = skipped;
    this.modelsCache = mergeManualModels(out, this.config, [...LLM_BASE_CAPABILITIES, 'STRUCTURED_JSON']);
    return this.modelsCache;
  }

  private async resolveModel(req: LLMRequest): Promise<string> {
    const explicit = req.model ?? this.config.defaultModel ?? this.config.models?.[0]?.id;
    if (explicit) return explicit;
    const models = (this.modelsCache ?? (await this.listModels(req.signal).catch(() => []))).filter(
      (m) => !isGeminiMusicModel(m.id),
    );
    const pick = [...models].sort(
      (a, b) => (b.qualityTier ?? 0) - (a.qualityTier ?? 0) || a.id.localeCompare(b.id),
    )[0];
    if (!pick)
      throw new ProviderError('bad-request', 'No Gemini model configured', { providerId: this.config.id });
    return pick.id;
  }

  private contents(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts:
        typeof m.content === 'string'
          ? [{ text: m.content }]
          : m.content.map((p) =>
              p.type === 'text'
                ? { text: p.text }
                : { inline_data: { mime_type: p.audio.mimeType, data: bytesToBase64(p.audio.data) } },
            ),
    }));
  }

  buildBody(req: LLMRequest, mode: StructuredOutputMode): Record<string, unknown> {
    const schema = req.responseSchema;
    let system = req.system ?? '';
    if (schema && mode !== 'json_schema')
      system = [system, schemaInstructions(schema, req.schemaName)].filter(Boolean).join('\n\n');
    const generationConfig: Record<string, unknown> = {};
    if (schema && mode !== 'prompt') generationConfig.responseMimeType = 'application/json';
    if (schema && mode === 'json_schema') generationConfig.responseSchema = compileSchema(schema, 'gemini');
    const maxTokens = req.maxTokens ?? this.config.extra?.maxOutputTokens;
    if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    const body: Record<string, unknown> = { contents: this.contents(req.messages) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
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
          this.mode = next;
          continue;
        }
        throw err;
      }
    }
  }

  private async send(req: LLMRequest, model: string, mode: StructuredOutputMode): Promise<LLMResponse> {
    const url = joinUrl(
      this.base,
      `models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`,
    );
    const json = await this.http.json<GeminiResponse>({
      url,
      json: this.buildBody(req, mode),
      signal: req.signal,
    });
    if (json?.promptFeedback?.blockReason) {
      throw new ProviderError(
        'refusal',
        json.promptFeedback.blockReasonMessage ?? `Blocked: ${json.promptFeedback.blockReason}`,
        { providerId: this.config.id, category: json.promptFeedback.blockReason },
      );
    }
    const cand = json?.candidates?.[0];
    const reason = cand?.finishReason ?? 'STOP';
    if (REFUSAL_REASONS.has(reason))
      throw new ProviderError('refusal', cand?.finishMessage ?? `Generation stopped: ${reason}`, {
        providerId: this.config.id,
        category: reason,
      });
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (reason === 'MAX_TOKENS' && req.responseSchema) throw truncatedError(this.config.id, text);
    const u = json?.usageMetadata;
    const usage = u
      ? {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        }
      : undefined;
    const res: LLMResponse = {
      text,
      model: json?.modelVersion ?? model,
      stopReason: reason === 'MAX_TOKENS' ? 'max_tokens' : reason.toLowerCase(),
      structured: !req.responseSchema
        ? undefined
        : mode === 'json_schema'
          ? 'native'
          : mode === 'json_object'
            ? 'json-mode'
            : 'prompt',
    };
    const parsed = jsonFromText(text, !!req.responseSchema);
    if (parsed !== undefined) res.json = parsed;
    if (usage) res.usage = usage;
    const cost = costFor(this.config, model, usage);
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }
}

interface GeminiAudioPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

/** Lyria music generation through the Gemini API key (see the header comment). */
export class GeminiMusic implements AudioGenerationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
    /** Lyria models chosen for this provider (first = default). */
    readonly musicModels: string[],
  ) {}

  async discoverModels(): Promise<ModelInfo[]> {
    // The LLM listing already reports Lyria models; nothing extra to fetch.
    return [];
  }

  async getCapabilities(modelId?: string): Promise<Capability[]> {
    return geminiMusicCapabilities(modelId && isGeminiMusicModel(modelId) ? modelId : this.musicModels[0]);
  }

  async generateMusic(req: MusicGenerationRequest): Promise<AudioGenerationResult> {
    // The router may hand over the provider's default (text) model: use a chosen Lyria model then.
    const model = req.model && isGeminiMusicModel(req.model) ? req.model : this.musicModels[0];
    const extras = [
      req.bpm ? `${Math.round(req.bpm)} BPM` : '',
      req.key ?? '',
      req.meter ? `${req.meter} time` : '',
      req.instrumental ? 'instrumental, no vocals' : '',
    ].filter(Boolean);
    let prompt = [req.prompt, extras.join(', ')].filter(Boolean).join('. ');
    if (req.negativePrompt) prompt += `. Avoid: ${req.negativePrompt}`;
    if (req.lyrics && !req.instrumental) prompt += `\n\nLyrics:\n${req.lyrics}`;
    const url = joinUrl(
      this.config.baseUrl.replace(/\/+$/, ''),
      `models/${encodeURIComponent(model)}:generateContent`,
    );
    const json = await this.http.json<{ candidates?: { content?: { parts?: GeminiAudioPart[] } }[] }>({
      url,
      json: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
      signal: req.signal,
      retry: false,
    });
    const parts = (json?.candidates ?? []).flatMap((c) => c.content?.parts ?? []);
    const clips = parts
      .map((p) =>
        p.inlineData
          ? { mime: p.inlineData.mimeType, data: p.inlineData.data }
          : p.inline_data
            ? { mime: p.inline_data.mime_type, data: p.inline_data.data }
            : undefined,
      )
      .filter((p): p is { mime: string; data: string } => !!p?.data && /^audio\//i.test(p.mime ?? 'audio/'))
      .map((p) => audioFromBase64(p.data, p.mime || 'audio/mpeg'));
    if (!clips.length)
      throw new ProviderError('parse', 'Lyria returned no audio', {
        providerId: this.config.id,
        details: json,
      });
    const res: AudioGenerationResult = { audio: clips[0], model };
    if (clips.length > 1) res.alternatives = clips.slice(1);
    return res;
  }

  async transformAudio(_req: AudioTransformRequest): Promise<AudioGenerationResult> {
    throw notSupported(this.config.id, 'Audio-to-audio');
  }
}

/** Lyria models a Gemini config uses: chosen in `enabledModels` or entered as manual models. */
export function geminiMusicModelsOf(config: ProviderConfig): string[] {
  const ids = [...(config.enabledModels ?? []), ...(config.models ?? []).map((m) => m.id)];
  return [...new Set(ids.filter(isGeminiMusicModel))];
}

export function createGeminiProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  const music = geminiMusicModelsOf(config);
  const caps: Capability[] = [
    ...LLM_BASE_CAPABILITIES,
    'STRUCTURED_JSON',
    'AUDIO_INPUT',
    'AUDIO_UNDERSTANDING',
    'LONG_CONTEXT',
  ];
  const instance: ProviderInstance = {
    descriptor: buildDescriptor(config, caps),
    config,
    llm: new GeminiLLM(config, http),
  };
  if (music.length) {
    instance.audioGeneration = new GeminiMusic(config, http, music);
    if (!config.capabilities?.length)
      instance.descriptor.capabilities = unionCapabilities(
        instance.descriptor.capabilities,
        ...music.map(geminiMusicCapabilities),
      );
  }
  return instance;
}
