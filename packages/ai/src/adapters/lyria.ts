/**
 * Google Lyria on Vertex AI.
 *
 * `POST https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:predict`
 * with `Authorization: Bearer <OAuth access token>` (BYOK "OAuth where supported", spec §7) and
 * body `{ instances: [{ prompt, negative_prompt, seed }], parameters: { sample_count } }`
 * → `predictions[].bytesBase64Encoded` (WAV, ~30 s clips). `seed` and `sample_count` are mutually
 * exclusive on Lyria: `sample_count` is only sent when no seed is given.
 */
import type { Capability } from '../capabilities';
import type { ProviderConfig } from '../config';
import { audioCostUsd } from '../cost';
import { ConfigurationError, ProviderError } from '../errors';
import type { HttpClient } from '../transport/http';
import type {
  AudioGenerationProvider,
  AudioGenerationResult,
  AudioTransformRequest,
  ModelInfo,
  MusicGenerationRequest,
  ProviderInstance,
} from '../types';
import {
  audioFromBase64,
  buildDescriptor,
  createHttpClient,
  type CreateProviderDeps,
  notSupported,
  pricingFor,
} from './common';

export const LYRIA_CAPABILITIES: Capability[] = ['TEXT_TO_MUSIC', 'INSTRUMENTAL_ONLY'];
export const LYRIA_DEFAULT_MODEL = 'lyria-002';
export const LYRIA_CLIP_SECONDS = 30;

export function lyriaPredictUrl(config: ProviderConfig, model: string): string {
  const project = (config.extra?.vertexProject ?? config.project ?? '').trim();
  const location = (config.extra?.vertexLocation ?? config.region ?? 'us-central1').trim();
  if (!project)
    throw new ConfigurationError(
      `Lyria provider "${config.id}" needs a Google Cloud project id (extra.vertexProject)`,
    );
  const base = (config.baseUrl || 'https://{location}-aiplatform.googleapis.com/v1')
    .replace(/\{location\}/g, location)
    .replace(/\/+$/, '');
  return `${base}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
}

export class LyriaProvider implements AudioGenerationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async discoverModels(): Promise<ModelInfo[]> {
    const caps = this.config.capabilities?.length ? this.config.capabilities : LYRIA_CAPABILITIES;
    const manual = (this.config.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      capabilities: m.capabilities ?? [...caps],
      manual: true,
    }));
    return manual.length
      ? manual
      : [
          {
            id: this.config.defaultModel ?? LYRIA_DEFAULT_MODEL,
            name: 'Lyria 2',
            capabilities: [...caps],
            meta: { clipSeconds: LYRIA_CLIP_SECONDS },
          },
        ];
  }

  async getCapabilities(): Promise<Capability[]> {
    return [...(this.config.capabilities?.length ? this.config.capabilities : LYRIA_CAPABILITIES)];
  }

  /** Predict body (exported for tests). */
  buildBody(req: MusicGenerationRequest): {
    instances: Record<string, unknown>[];
    parameters: Record<string, unknown>;
  } {
    const instance: Record<string, unknown> = { prompt: req.prompt };
    if (req.negativePrompt) instance.negative_prompt = req.negativePrompt;
    if (req.seed !== undefined) instance.seed = req.seed >>> 0;
    const parameters: Record<string, unknown> = {};
    if (req.seed === undefined) parameters.sample_count = Math.max(1, Math.min(4, req.samples ?? 1));
    return { instances: [instance], parameters };
  }

  async generateMusic(req: MusicGenerationRequest): Promise<AudioGenerationResult> {
    const model = req.model ?? this.config.defaultModel ?? LYRIA_DEFAULT_MODEL;
    const json = await this.http.json<{ predictions?: { bytesBase64Encoded?: string; mimeType?: string }[] }>(
      { url: lyriaPredictUrl(this.config, model), json: this.buildBody(req), signal: req.signal },
    );
    const clips = (json?.predictions ?? [])
      .filter((p) => typeof p.bytesBase64Encoded === 'string' && p.bytesBase64Encoded)
      .map((p) => audioFromBase64(p.bytesBase64Encoded!, p.mimeType ?? 'audio/wav'));
    if (!clips.length)
      throw new ProviderError('parse', 'Lyria returned no audio', {
        providerId: this.config.id,
        details: json,
      });
    const res: AudioGenerationResult = { audio: clips[0], model, durationSeconds: LYRIA_CLIP_SECONDS };
    if (clips.length > 1) res.alternatives = clips.slice(1);
    if (req.seed !== undefined) res.seed = req.seed;
    const cost = audioCostUsd(pricingFor(this.config), model, LYRIA_CLIP_SECONDS, clips.length);
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }

  async transformAudio(_req: AudioTransformRequest): Promise<AudioGenerationResult> {
    throw notSupported(this.config.id, 'Audio-to-audio');
  }
}

export function createLyriaProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, LYRIA_CAPABILITIES),
    config,
    audioGeneration: new LyriaProvider(config, http),
  };
}
