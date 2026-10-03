/**
 * Managed "Automatic" adapter (spec §8): instead of configuring providers, the user selects
 * Automatic and the Song Deck service routes each task among ITS configured providers by quality,
 * cost, latency, availability, task type and the user's privacy settings.
 *
 * ## Gateway contract (served by `createManagedGatewayHandler`, mounted by apps/server)
 * - `POST {serverUrl}/api/managed/llm`   `{ role, quality, request: SerializedLLMRequest, privacy }`
 *     → `200` JSON `LLMResponse & { provenance }`
 * - `POST {serverUrl}/api/managed/audio` `{ role, quality, request: { op, params }, privacy }`
 *     → `200` audio bytes (`content-type: audio/*`, headers `x-songdeck-provider`, `x-songdeck-model`,
 *        `x-songdeck-cost-usd`, `x-songdeck-seed`) for generate/transform/extend/inpaint/singing/
 *        master/convert ops, or JSON for `separateStems` / `transcribeNotes` / `listVoices`.
 * - `POST {serverUrl}/api/managed/models` `{}` → `{ capabilities: Capability[], providers: [...] }`
 * - errors: `4xx/5xx {error, reasons?}` (503 = no compatible provider, 402 = budget, 403 = privacy).
 * Audio inside JSON is `{ mimeType, data: base64 }`. `privacy = { neverUpload: DataKind[],
 * dataKinds: DataKind[], localOnly?: boolean }` — the gateway never routes data kinds listed in
 * `neverUpload` to third-party cloud providers.
 */
import { type Capability, normalizeCapabilities } from '../capabilities';
import type { ProviderConfig } from '../config';
import { assertVoiceConsent } from '../consent';
import { ProviderError } from '../errors';
import { getPreset } from '../presets';
import type { HttpClient } from '../transport/http';
import type {
  AudioExtendRequest,
  AudioGenerationProvider,
  AudioGenerationResult,
  AudioInpaintRequest,
  AudioTransformRequest,
  ChatMessage,
  DataKind,
  EncodedAudio,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  MasteringProvider,
  MasteringRequest,
  MasteringResult,
  ModelInfo,
  MusicGenerationRequest,
  PhraseRegenerationRequest,
  ProviderInstance,
  QualityLevel,
  RequestHints,
  SeparationProvider,
  SeparationRequest,
  SeparationResult,
  SingingProvider,
  SingingRequest,
  SingingResult,
  TaskRole,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
  VoiceConversionProvider,
  VoiceConversionRequest,
  VoiceConversionResult,
  VoiceInfo,
} from '../types';
import { isPlainObject, joinUrl } from '../util';
import { audioFromJson, audioFromResponse, audioToJson, buildDescriptor, createHttpClient, type CreateProviderDeps, type EncodedAudioJson } from './common';

export const MANAGED_PATHS = {
  llm: '/api/managed/llm',
  audio: '/api/managed/audio',
  models: '/api/managed/models',
} as const;

export interface ManagedPrivacy {
  neverUpload: DataKind[];
  dataKinds: DataKind[];
  /** Only providers running on the gateway's own machine may be used. */
  localOnly?: boolean;
}

export type SerializedContentPart = { type: 'text'; text: string } | { type: 'audio'; audio: EncodedAudioJson; label?: string };

export interface SerializedLLMRequest {
  model?: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string | SerializedContentPart[] }[];
  responseSchema?: LLMRequest['responseSchema'];
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ManagedLLMBody {
  role: TaskRole;
  quality: QualityLevel;
  request: SerializedLLMRequest;
  privacy: ManagedPrivacy;
}

export type ManagedAudioOp =
  | 'generateMusic'
  | 'transformAudio'
  | 'extendAudio'
  | 'inpaintAudio'
  | 'synthesizeSinging'
  | 'regeneratePhrase'
  | 'listVoices'
  | 'transcribeNotes'
  | 'separateStems'
  | 'master'
  | 'convertVoice';

export interface ManagedAudioBody {
  role: TaskRole;
  quality: QualityLevel;
  request: { op: ManagedAudioOp; params: Record<string, unknown> };
  privacy: ManagedPrivacy;
}

export const MANAGED_OP_ROLES: Record<ManagedAudioOp, TaskRole> = {
  generateMusic: 'production',
  transformAudio: 'production',
  extendAudio: 'production',
  inpaintAudio: 'production',
  synthesizeSinging: 'vocals',
  regeneratePhrase: 'vocals',
  listVoices: 'vocals',
  transcribeNotes: 'transcription',
  separateStems: 'separation',
  master: 'mastering',
  convertVoice: 'voice-conversion',
};

export function serializeLLMRequest(req: LLMRequest): SerializedLLMRequest {
  const out: SerializedLLMRequest = {
    messages: req.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p : { type: 'audio' as const, audio: audioToJson(p.audio), ...(p.label ? { label: p.label } : {}) })),
    })),
  };
  if (req.model) out.model = req.model;
  if (req.system) out.system = req.system;
  if (req.responseSchema) out.responseSchema = req.responseSchema;
  if (req.schemaName) out.schemaName = req.schemaName;
  if (req.maxTokens) out.maxTokens = req.maxTokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  return out;
}

export function deserializeLLMRequest(s: SerializedLLMRequest): LLMRequest {
  const messages: ChatMessage[] = (s.messages ?? []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'audio' ? { type: 'audio' as const, audio: audioFromJson(p.audio), ...(p.label ? { label: p.label } : {}) } : { type: 'text' as const, text: String(p.text ?? '') })),
  }));
  const req: LLMRequest = { messages };
  if (s.model) req.model = s.model;
  if (s.system) req.system = s.system;
  if (s.responseSchema) req.responseSchema = s.responseSchema;
  if (s.schemaName) req.schemaName = s.schemaName;
  if (s.maxTokens) req.maxTokens = s.maxTokens;
  if (s.temperature !== undefined) req.temperature = s.temperature;
  return req;
}

const AUDIO_KEYS = new Set(['audio', 'referenceAudio', 'guideAudio', 'reference']);
const DROP_KEYS = new Set(['signal', 'hints']);

/** Serialize request params for the audio gateway (EncodedAudio → base64 JSON; signal/hints dropped). */
export function serializeAudioParams(params: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || DROP_KEYS.has(k)) continue;
    if (AUDIO_KEYS.has(k) && v && typeof v === 'object' && (v as EncodedAudio).data instanceof Uint8Array) out[k] = audioToJson(v as EncodedAudio);
    else out[k] = v;
  }
  return out;
}

export function deserializeAudioParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (AUDIO_KEYS.has(k) && isPlainObject(v) && typeof v.data === 'string') out[k] = audioFromJson(v as unknown as EncodedAudioJson);
    else out[k] = v;
  }
  return out;
}

function privacyFrom(hints: RequestHints | undefined, fallbackKinds: DataKind[]): ManagedPrivacy {
  return { neverUpload: [...(hints?.neverUpload ?? [])], dataKinds: [...(hints?.dataKinds ?? fallbackKinds)] };
}

class ManagedClient {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  url(path: string): string {
    return joinUrl(this.config.baseUrl.replace(/\/+$/, ''), path);
  }

  async llm(req: LLMRequest): Promise<LLMResponse> {
    const body: ManagedLLMBody = {
      role: req.hints?.role ?? 'composition',
      quality: req.hints?.quality ?? 'standard',
      request: serializeLLMRequest(req),
      privacy: privacyFrom(req.hints, ['song-description']),
    };
    const json = await this.http.json<LLMResponse & { provenance?: { modelId?: string; costUsd?: number } }>({ url: this.url(MANAGED_PATHS.llm), json: body, signal: req.signal });
    if (!json || typeof json.text !== 'string') throw new ProviderError('parse', 'Managed gateway returned no text', { providerId: this.config.id });
    const res: LLMResponse = { text: json.text, model: json.model ?? json.provenance?.modelId ?? 'auto', stopReason: json.stopReason ?? 'end_turn' };
    if (json.json !== undefined) res.json = json.json;
    if (json.usage) res.usage = json.usage;
    const cost = json.costUsd ?? json.provenance?.costUsd;
    if (cost !== undefined) res.costUsd = cost;
    if (json.structured) res.structured = json.structured;
    return res;
  }

  async audioOp(op: ManagedAudioOp, params: { signal?: AbortSignal; hints?: RequestHints } & object, dataKinds: DataKind[]): Promise<{ audio?: EncodedAudio; json?: unknown; headers: Headers }> {
    const body: ManagedAudioBody = {
      role: params.hints?.role ?? MANAGED_OP_ROLES[op],
      quality: params.hints?.quality ?? 'standard',
      request: { op, params: serializeAudioParams(params) },
      privacy: privacyFrom(params.hints, dataKinds),
    };
    return this.http.send({ url: this.url(MANAGED_PATHS.audio), json: body, signal: params.signal, accept: 'audio/*, application/json' }, async (res) => {
      const ct = res.headers.get('content-type') ?? '';
      if (/json/i.test(ct)) return { json: await res.json(), headers: res.headers };
      return { audio: audioFromResponse(new Uint8Array(await res.arrayBuffer()), ct, 'wav'), headers: res.headers };
    });
  }

  async models(signal?: AbortSignal): Promise<{ capabilities: Capability[] }> {
    const json = await this.http.json<{ capabilities?: string[] }>({ url: this.url(MANAGED_PATHS.models), json: {}, signal });
    return { capabilities: normalizeCapabilities(json?.capabilities ?? []) };
  }
}

function audioMeta(headers: Headers): { model?: string; costUsd?: number; seed?: number } {
  const out: { model?: string; costUsd?: number; seed?: number } = {};
  const model = headers.get('x-songdeck-model');
  if (model) out.model = model;
  const cost = Number(headers.get('x-songdeck-cost-usd'));
  if (headers.get('x-songdeck-cost-usd') !== null && Number.isFinite(cost)) out.costUsd = cost;
  const seed = Number(headers.get('x-songdeck-seed'));
  if (headers.get('x-songdeck-seed') !== null && Number.isFinite(seed)) out.seed = seed;
  return out;
}

function requireAudio(r: { audio?: EncodedAudio }, providerId: string): EncodedAudio {
  if (!r.audio) throw new ProviderError('parse', 'Managed gateway returned no audio', { providerId });
  return r.audio;
}

export function createManagedProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  const client = new ManagedClient(config, http);
  const id = config.id;
  const descriptor = buildDescriptor(config, getPreset('managed')?.capabilities ?? []);

  const llm: LLMProvider = {
    async listModels(signal) {
      let caps = descriptor.capabilities;
      try {
        const m = await client.models(signal);
        if (m.capabilities.length) caps = m.capabilities;
      } catch {
        /* gateway may not expose /models */
      }
      const model: ModelInfo = { id: 'auto', name: 'Automatic', capabilities: caps.filter((c) => !['TEXT_TO_MUSIC', 'AUDIO_TO_AUDIO', 'SINGING_SYNTHESIS', 'SOURCE_SEPARATION', 'MASTERING', 'AUDIO_TRANSCRIPTION'].includes(c)) };
      return [model];
    },
    complete: (req) => client.llm(req),
  };

  const audioResult = async (op: ManagedAudioOp, req: { signal?: AbortSignal; hints?: RequestHints; seed?: number } & object, kinds: DataKind[], durationSeconds?: number): Promise<AudioGenerationResult> => {
    const r = await client.audioOp(op, req, kinds);
    const meta = audioMeta(r.headers);
    const res: AudioGenerationResult = { audio: requireAudio(r, id), ...meta };
    if (res.seed === undefined && req.seed !== undefined) res.seed = req.seed;
    if (durationSeconds !== undefined) res.durationSeconds = durationSeconds;
    return res;
  };

  const audioGeneration: AudioGenerationProvider = {
    discoverModels: async () => [{ id: 'auto', name: 'Automatic', capabilities: descriptor.capabilities.filter((c) => !['TEXT_REASONING', 'MUSIC_THEORY_REASONING'].includes(c)) }],
    getCapabilities: async () => [...descriptor.capabilities],
    generateMusic: (req: MusicGenerationRequest) => audioResult('generateMusic', req, ['song-description', 'chord-progression', ...(req.lyrics ? (['lyrics'] as DataKind[]) : []), ...(req.guideAudio ? (['guide-audio'] as DataKind[]) : []), ...(req.referenceAudio ? (['reference-audio'] as DataKind[]) : [])], req.durationSeconds),
    transformAudio: (req: AudioTransformRequest) => audioResult('transformAudio', req, ['guide-audio'], req.durationSeconds),
    extendAudio: (req: AudioExtendRequest) => audioResult('extendAudio', req, ['guide-audio'], req.durationSeconds),
    inpaintAudio: (req: AudioInpaintRequest) => audioResult('inpaintAudio', req, ['guide-audio'], req.endSeconds - req.startSeconds),
  };

  const singing: SingingProvider = {
    async listVoices(signal) {
      const r = await client.audioOp('listVoices', { signal }, []);
      const list = Array.isArray(r.json) ? r.json : ((r.json as { voices?: unknown[] } | undefined)?.voices ?? []);
      return list as VoiceInfo[];
    },
    async synthesizeSinging(req: SingingRequest): Promise<SingingResult> {
      const r = await client.audioOp('synthesizeSinging', req, ['midi', 'lyrics']);
      return { audio: requireAudio(r, id), voiceId: req.voiceId, ...audioMeta(r.headers) };
    },
    async regeneratePhrase(req: PhraseRegenerationRequest): Promise<SingingResult> {
      const r = await client.audioOp('regeneratePhrase', req, ['midi', 'lyrics']);
      return { audio: requireAudio(r, id), voiceId: req.voiceId, ...audioMeta(r.headers) };
    },
  };

  const transcription: TranscriptionProvider = {
    async transcribeNotes(req: TranscriptionRequest): Promise<TranscriptionResult> {
      const r = await client.audioOp('transcribeNotes', req, ['reference-audio']);
      const json = r.json as TranscriptionResult | undefined;
      if (!json || !Array.isArray(json.notes)) throw new ProviderError('parse', 'Managed gateway returned no transcription', { providerId: id });
      return json;
    },
  };

  const separation: SeparationProvider = {
    async separateStems(req: SeparationRequest): Promise<SeparationResult> {
      const r = await client.audioOp('separateStems', req, ['reference-audio']);
      const json = r.json as { stems?: Record<string, EncodedAudioJson>; model?: string } | undefined;
      if (!json?.stems) throw new ProviderError('parse', 'Managed gateway returned no stems', { providerId: id });
      const stems: Record<string, EncodedAudio> = {};
      for (const [k, v] of Object.entries(json.stems)) stems[k] = audioFromJson(v);
      return { stems, ...(json.model ? { model: json.model } : {}) };
    },
  };

  const mastering: MasteringProvider = {
    async master(req: MasteringRequest): Promise<MasteringResult> {
      const r = await client.audioOp('master', req, ['stems']);
      const meta = audioMeta(r.headers);
      return { audio: requireAudio(r, id), ...(meta.model ? { model: meta.model } : {}) };
    },
  };

  const voiceConversion: VoiceConversionProvider = {
    async convertVoice(req: VoiceConversionRequest): Promise<VoiceConversionResult> {
      assertVoiceConsent(req.targetVoice, req.consent);
      const r = await client.audioOp('convertVoice', req, ['recorded-vocals']);
      const meta = audioMeta(r.headers);
      return { audio: requireAudio(r, id), voiceId: req.targetVoice.id, ...(meta.model ? { model: meta.model } : {}) };
    },
  };

  return { descriptor, config, llm, audioGeneration, singing, transcription, separation, mastering, voiceConversion };
}
