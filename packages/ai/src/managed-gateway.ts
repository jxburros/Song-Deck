/**
 * Server-side managed "Automatic" gateway (spec §8). The local/managed server mounts the handler:
 *
 * ```ts
 * const handle = createManagedGatewayHandler(serverOrchestrator);
 * app.post('/api/managed/*', async (req, res) => {
 *   const out = await handle(req.path, req.body, abortSignalFor(req));
 *   res.status(out.status);
 *   for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
 *   if (out.bytes) res.type(out.contentType!).send(Buffer.from(out.bytes)); else res.json(out.json);
 * });
 * ```
 * It routes each task among the SERVER's configured providers by quality, cost, latency,
 * availability, task type and the user's privacy settings (`privacy.neverUpload`, `localOnly`).
 */
import { type Capability, unionCapabilities } from './capabilities';
import { audioToJson } from './adapters/common';
import { deserializeAudioParams, deserializeLLMRequest, type ManagedAudioOp, MANAGED_OP_ROLES, MANAGED_PATHS, type ManagedPrivacy, type SerializedLLMRequest } from './adapters/managed';
import { ConfigurationError, ConsentRequiredError, BudgetExceededError, NoCompatibleProviderError, PrivacyDeclinedError, ProviderError } from './errors';
import type { Orchestrator, RunOptions, RunProvenance } from './orchestrator';
import { ROLE_INFO } from './roles';
import type { RoutingSettings } from './router';
import {
  DATA_KINDS,
  TASK_ROLES,
  type AudioExtendRequest,
  type AudioGenerationResult,
  type AudioInpaintRequest,
  type AudioTransformRequest,
  type DataKind,
  type EncodedAudio,
  type MasteringRequest,
  type MusicGenerationRequest,
  type PhraseRegenerationRequest,
  type QualityLevel,
  type SeparationRequest,
  type SingingRequest,
  type TaskRole,
  type TranscriptionRequest,
  type VoiceConversionRequest,
  type VoiceInfo,
} from './types';
import { isPlainObject } from './util';

export interface ManagedGatewayResponse {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
}

export type ManagedGatewayHandler = (path: string, body: unknown, signal?: AbortSignal) => Promise<ManagedGatewayResponse>;

export interface ManagedGatewayOptions {
  /** Providers the gateway must never use (managed adapters are always excluded to avoid loops). */
  excludeProviderIds?: string[];
  /** Routing priorities per requested quality. */
  priorities?: Partial<Record<QualityLevel, RoutingSettings['priorities']>>;
}

export const MANAGED_QUALITY_PRIORITIES: Record<QualityLevel, RoutingSettings['priorities']> = {
  draft: { quality: 0.2, cost: 0.5, latency: 0.3 },
  standard: { quality: 0.5, cost: 0.3, latency: 0.2 },
  final: { quality: 0.8, cost: 0.1, latency: 0.1 },
};

const QUALITIES: QualityLevel[] = ['draft', 'standard', 'final'];

function parsePrivacy(v: unknown): ManagedPrivacy {
  const p = isPlainObject(v) ? v : {};
  const kinds = (x: unknown): DataKind[] => (Array.isArray(x) ? x.filter((k): k is DataKind => typeof k === 'string' && (DATA_KINDS as readonly string[]).includes(k)) : []);
  return { neverUpload: kinds(p.neverUpload), dataKinds: kinds(p.dataKinds), localOnly: p.localOnly === true };
}

function audioResponse(audio: EncodedAudio, prov: RunProvenance, seed?: number): ManagedGatewayResponse {
  const headers: Record<string, string> = { 'x-songdeck-provider': prov.providerId };
  if (prov.modelId) headers['x-songdeck-model'] = prov.modelId;
  if (prov.costUsd !== undefined) headers['x-songdeck-cost-usd'] = String(prov.costUsd);
  if (seed !== undefined) headers['x-songdeck-seed'] = String(seed);
  return { status: 200, bytes: audio.data, contentType: audio.mimeType, headers };
}

/** Map orchestrator errors to HTTP responses. */
export function gatewayErrorResponse(err: unknown): ManagedGatewayResponse {
  if (err instanceof NoCompatibleProviderError) return { status: 503, json: { error: err.message, reasons: err.excluded } };
  if (err instanceof BudgetExceededError) return { status: 402, json: { error: err.message, reasons: err.reasons } };
  if (err instanceof ConsentRequiredError) return { status: 403, json: { error: err.message, code: 'consent-required' } };
  if (err instanceof PrivacyDeclinedError) return { status: 403, json: { error: err.message, code: 'privacy-declined' } };
  if (err instanceof ConfigurationError) return { status: 500, json: { error: err.message } };
  if (err instanceof ProviderError) {
    const status: Record<string, number> = {
      'bad-request': 400,
      refusal: 422,
      'rate-limit': 429,
      auth: 502,
      unavailable: 503,
      network: 503,
      timeout: 504,
      cancelled: 499,
      truncated: 502,
      parse: 502,
      unsupported: 501,
      unknown: 500,
    };
    return { status: status[err.kind] ?? 500, json: { error: err.message, kind: err.kind, ...(err.category ? { category: err.category } : {}) } };
  }
  return { status: 500, json: { error: (err as Error)?.message ?? String(err) } };
}

export function createManagedGatewayHandler(orchestrator: Orchestrator, opts: ManagedGatewayOptions = {}): ManagedGatewayHandler {
  const excluded = (): string[] => [
    ...orchestrator.registry
      .allEntries()
      .filter((e) => e.instance.descriptor.adapter === 'managed')
      .map((e) => e.instance.descriptor.id),
    ...(opts.excludeProviderIds ?? []),
  ];

  const runOptions = (quality: QualityLevel, privacy: ManagedPrivacy, signal?: AbortSignal, dataKinds?: DataKind[]): RunOptions & { excludeProviderIds: string[] } => {
    const base = orchestrator.settings();
    const routing: Partial<RoutingSettings> = {
      mode: base.mode === 'rules' ? 'rules' : 'automatic',
      profileId: undefined,
      priorities: opts.priorities?.[quality] ?? MANAGED_QUALITY_PRIORITIES[quality],
      privacyConfirm: 'never',
      offline: base.offline || privacy.localOnly === true,
      neverUpload: [...new Set([...base.neverUpload, ...privacy.neverUpload])],
    };
    const out: RunOptions & { excludeProviderIds: string[] } = { quality, routing, excludeProviderIds: excluded(), skipConfirm: true };
    if (signal) out.signal = signal;
    if (dataKinds?.length) out.dataKinds = dataKinds;
    return out;
  };

  const handleLlm = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<ManagedGatewayResponse> => {
    if (!isPlainObject(body.request) || !Array.isArray((body.request as Record<string, unknown>).messages)) return { status: 400, json: { error: 'request.messages is required' } };
    const role: TaskRole = TASK_ROLES.includes(body.role as TaskRole) ? (body.role as TaskRole) : 'composition';
    const quality: QualityLevel = QUALITIES.includes(body.quality as QualityLevel) ? (body.quality as QualityLevel) : 'standard';
    const privacy = parsePrivacy(body.privacy);
    const request = deserializeLLMRequest(body.request as unknown as SerializedLLMRequest);
    const hasAudio = request.messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'audio'));
    const base = ROLE_INFO[role].interface === 'composition' ? ROLE_INFO[role].capabilities : ['TEXT_REASONING' as Capability];
    const capabilities: Capability[] = unionCapabilities(base, hasAudio ? ['AUDIO_INPUT', 'AUDIO_UNDERSTANDING'] : []);
    const o = runOptions(quality, privacy, signal);
    const result = await orchestrator.run({
      role,
      capabilities,
      interface: 'llm',
      dataKinds: privacy.dataKinds.length ? privacy.dataKinds : ROLE_INFO[role].dataKinds,
      quality,
      routing: o.routing,
      excludeProviderIds: o.excludeProviderIds,
      skipConfirm: true,
      estimateInput: { kind: 'llm', role, inputChars: JSON.stringify(body.request).length },
      signal,
      execute: (inst, model, s) => inst.llm!.complete({ ...request, model, signal: s }),
    });
    return { status: 200, json: { ...result.result, provenance: result.provenance } };
  };

  const handleAudio = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<ManagedGatewayResponse> => {
    const request = isPlainObject(body.request) ? body.request : undefined;
    const op = request?.op as ManagedAudioOp | undefined;
    if (!request || !op || !(op in MANAGED_OP_ROLES)) return { status: 400, json: { error: `Unknown or missing op ${JSON.stringify(request?.op ?? null)}` } };
    const params = deserializeAudioParams(isPlainObject(request.params) ? request.params : {});
    const quality: QualityLevel = QUALITIES.includes(body.quality as QualityLevel) ? (body.quality as QualityLevel) : 'standard';
    const privacy = parsePrivacy(body.privacy);
    const o = runOptions(quality, privacy, signal, privacy.dataKinds);
    const role = MANAGED_OP_ROLES[op];
    const common = {
      role,
      quality,
      routing: o.routing,
      excludeProviderIds: o.excludeProviderIds,
      skipConfirm: true,
      signal,
      dataKinds: privacy.dataKinds.length ? privacy.dataKinds : ROLE_INFO[role].dataKinds,
    } as const;
    switch (op) {
      case 'generateMusic': {
        const req = params as unknown as MusicGenerationRequest;
        const caps: Capability[] = ['TEXT_TO_MUSIC'];
        if (req.lyrics && !req.instrumental) caps.push('LYRIC_CONDITIONING', 'VOCAL_GENERATION');
        if (req.instrumental) caps.push('INSTRUMENTAL_ONLY');
        if (req.guideAudio) caps.push('AUDIO_TO_AUDIO');
        if (req.referenceAudio) caps.push('REFERENCE_AUDIO');
        const r = await orchestrator.run<AudioGenerationResult>({
          ...common,
          capabilities: caps,
          estimateInput: { kind: 'audio', durationSeconds: req.durationSeconds ?? 30, generations: req.samples ?? 1 },
          execute: (inst, model, s) => inst.audioGeneration!.generateMusic({ ...req, model, signal: s }),
        });
        return audioResponse(r.result.audio, r.provenance, r.result.seed);
      }
      case 'transformAudio':
      case 'extendAudio':
      case 'inpaintAudio': {
        const cap: Capability = op === 'transformAudio' ? 'AUDIO_TO_AUDIO' : op === 'extendAudio' ? 'OUTPAINTING' : 'INPAINTING';
        const r = await orchestrator.run<AudioGenerationResult>({
          ...common,
          capabilities: [cap],
          estimateInput: { kind: 'audio', durationSeconds: Number((params as { durationSeconds?: number }).durationSeconds ?? 30) },
          execute: async (inst, model, s) => {
            const g = inst.audioGeneration!;
            if (op === 'transformAudio') return g.transformAudio({ ...(params as unknown as AudioTransformRequest), model, signal: s });
            if (op === 'extendAudio') {
              if (!g.extendAudio) throw new ProviderError('unsupported', 'extend not supported', { providerId: inst.descriptor.id });
              return g.extendAudio({ ...(params as unknown as AudioExtendRequest), model, signal: s });
            }
            if (!g.inpaintAudio) throw new ProviderError('unsupported', 'inpaint not supported', { providerId: inst.descriptor.id });
            return g.inpaintAudio({ ...(params as unknown as AudioInpaintRequest), model, signal: s });
          },
        });
        return audioResponse(r.result.audio, r.provenance, r.result.seed);
      }
      case 'synthesizeSinging':
      case 'regeneratePhrase': {
        const req = params as unknown as SingingRequest;
        const r =
          op === 'synthesizeSinging'
            ? await orchestrator.synthesizeSinging(req, { ...o, ...common })
            : await orchestrator.regeneratePhrase(params as unknown as PhraseRegenerationRequest, { ...o, ...common });
        return audioResponse(r.result.audio, r.provenance, r.result.seed);
      }
      case 'listVoices': {
        const r = await orchestrator.run<VoiceInfo[]>({ ...common, capabilities: ['SINGING_SYNTHESIS'], interface: 'singing', execute: (inst, _m, s) => inst.singing!.listVoices(s) });
        return { status: 200, json: { voices: r.result } };
      }
      case 'transcribeNotes': {
        const r = await orchestrator.transcribe(params as unknown as TranscriptionRequest, { ...o, ...common });
        return { status: 200, json: { ...r.result, provenance: r.provenance } };
      }
      case 'separateStems': {
        const r = await orchestrator.separate(params as unknown as SeparationRequest, { ...o, ...common });
        const stems: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r.result.stems)) stems[k] = audioToJson(v);
        return { status: 200, json: { stems, ...(r.result.model ? { model: r.result.model } : {}), provenance: r.provenance } };
      }
      case 'master': {
        const r = await orchestrator.master(params as unknown as MasteringRequest, { ...o, ...common });
        return audioResponse(r.result.audio, r.provenance);
      }
      case 'convertVoice': {
        const r = await orchestrator.convertVoice(params as unknown as VoiceConversionRequest, { ...o, ...common });
        return audioResponse(r.result.audio, r.provenance);
      }
    }
    return { status: 400, json: { error: `Unsupported op ${op}` } };
  };

  const handleModels = (): ManagedGatewayResponse => {
    const skip = new Set(excluded());
    const providers = orchestrator.registry
      .list()
      .filter((p) => p.enabled && p.status === 'ready' && !skip.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, location: p.location, capabilities: p.capabilities }));
    return { status: 200, json: { capabilities: unionCapabilities(...providers.map((p) => p.capabilities)), providers } };
  };

  return async (path, body, signal) => {
    const p = path.split('?')[0].replace(/\/+$/, '');
    try {
      const b = isPlainObject(body) ? body : {};
      if (p.endsWith(MANAGED_PATHS.llm)) return await handleLlm(b, signal);
      if (p.endsWith(MANAGED_PATHS.audio)) return await handleAudio(b, signal);
      if (p.endsWith(MANAGED_PATHS.models)) return handleModels();
      return { status: 404, json: { error: `Unknown managed endpoint ${p}` } };
    } catch (err) {
      return gatewayErrorResponse(err);
    }
  };
}
