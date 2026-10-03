/**
 * Stability AI Stable Audio adapter
 * (`https://api.stability.ai/v2beta/audio/stable-audio-2/{text-to-audio|audio-to-audio}`).
 *
 * multipart/form-data fields: `prompt, duration (s), seed, steps, cfg_scale, output_format
 * ('wav'|'mp3'), model, audio (file, audio-to-audio), strength`; headers `authorization: Bearer`
 * (via the transport) and `accept: audio/*`; returns audio bytes.
 */
import type { Capability } from '../capabilities';
import type { ProviderConfig } from '../config';
import { audioCostUsd } from '../cost';
import type { HttpClient } from '../transport/http';
import { encodeMultipart, type MultipartPart } from '../transport/multipart';
import type { AudioGenerationProvider, AudioGenerationResult, AudioTransformRequest, ModelInfo, MusicGenerationRequest, ProviderInstance } from '../types';
import { audioExtension, clamp, joinUrl } from '../util';
import { audioFromResponse, buildDescriptor, createHttpClient, type CreateProviderDeps, pricingFor } from './common';

export const STABILITY_AUDIO_CAPABILITIES: Capability[] = ['TEXT_TO_MUSIC', 'AUDIO_TO_AUDIO', 'STEM_CONDITIONING', 'INSTRUMENTAL_ONLY'];
/** Stable Audio 2.x maximum duration in seconds. */
export const STABILITY_MAX_DURATION = 190;

export class StabilityAudioProvider implements AudioGenerationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  private path(kind: 'text-to-audio' | 'audio-to-audio'): string {
    const custom = kind === 'text-to-audio' ? this.config.extra?.textToAudioPath : this.config.extra?.audioToAudioPath;
    return joinUrl(this.config.baseUrl, typeof custom === 'string' && custom ? custom : `audio/stable-audio-2/${kind}`);
  }

  private get outputFormat(): 'wav' | 'mp3' {
    return this.config.extra?.outputFormat === 'mp3' ? 'mp3' : 'wav';
  }

  async discoverModels(): Promise<ModelInfo[]> {
    const caps = this.config.capabilities?.length ? this.config.capabilities : STABILITY_AUDIO_CAPABILITIES;
    const manual = (this.config.models ?? []).map((m) => ({ id: m.id, name: m.name, capabilities: m.capabilities ?? [...caps], manual: true }));
    if (manual.length) return manual;
    return [{ id: this.config.defaultModel ?? 'stable-audio-2', name: 'Stable Audio 2', capabilities: [...caps] }];
  }

  async getCapabilities(): Promise<Capability[]> {
    return [...(this.config.capabilities?.length ? this.config.capabilities : STABILITY_AUDIO_CAPABILITIES)];
  }

  /** Multipart fields for a request (exported for tests). */
  fields(req: { prompt: string; durationSeconds?: number; seed?: number; model?: string; outputFormat?: 'wav' | 'mp3' }): MultipartPart[] {
    const parts: MultipartPart[] = [{ name: 'prompt', value: req.prompt }];
    if (req.durationSeconds !== undefined) parts.push({ name: 'duration', value: Math.round(clamp(req.durationSeconds, 1, STABILITY_MAX_DURATION)) });
    if (req.seed !== undefined) parts.push({ name: 'seed', value: req.seed >>> 0 });
    const steps = this.config.extra?.steps;
    if (steps !== undefined) parts.push({ name: 'steps', value: steps });
    const cfg = this.config.extra?.cfgScale;
    if (cfg !== undefined) parts.push({ name: 'cfg_scale', value: cfg });
    parts.push({ name: 'output_format', value: req.outputFormat ?? this.outputFormat });
    const model = req.model ?? this.config.defaultModel;
    if (model) parts.push({ name: 'model', value: model });
    return parts;
  }

  private async post(url: string, parts: MultipartPart[], signal: AbortSignal | undefined, durationSeconds: number | undefined, model: string | undefined, seed?: number): Promise<AudioGenerationResult> {
    const mp = encodeMultipart(parts);
    const r = await this.http.bytes({ url, body: mp.body, contentType: mp.contentType, accept: 'audio/*', signal });
    const res: AudioGenerationResult = { audio: audioFromResponse(r.data, r.contentType, this.outputFormat) };
    const seedHeader = r.headers.get('seed');
    if (seedHeader && Number.isFinite(Number(seedHeader))) res.seed = Number(seedHeader);
    else if (seed !== undefined) res.seed = seed;
    if (model) res.model = model;
    if (durationSeconds !== undefined) res.durationSeconds = durationSeconds;
    const cost = audioCostUsd(pricingFor(this.config), model, durationSeconds ?? 0);
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }

  async generateMusic(req: MusicGenerationRequest): Promise<AudioGenerationResult> {
    const prompt = req.negativePrompt ? `${req.prompt}. Avoid: ${req.negativePrompt}` : req.prompt;
    const model = req.model ?? this.config.defaultModel;
    const duration = clamp(req.durationSeconds, 1, STABILITY_MAX_DURATION);
    if (req.guideAudio) {
      return this.transformAudio({ audio: req.guideAudio, prompt, strength: req.strength, seed: req.seed, durationSeconds: duration, model, signal: req.signal });
    }
    const parts = this.fields({ prompt, durationSeconds: duration, seed: req.seed, model, outputFormat: req.outputFormat });
    return this.post(this.path('text-to-audio'), parts, req.signal, duration, model, req.seed);
  }

  async transformAudio(req: AudioTransformRequest): Promise<AudioGenerationResult> {
    const model = req.model ?? this.config.defaultModel;
    const parts = this.fields({ prompt: req.prompt, durationSeconds: req.durationSeconds, seed: req.seed, model });
    parts.push({ name: 'audio', data: req.audio.data, filename: `input.${audioExtension(req.audio.mimeType)}`, contentType: req.audio.mimeType });
    parts.push({ name: 'strength', value: clamp(req.strength ?? 0.6, 0, 1) });
    return this.post(this.path('audio-to-audio'), parts, req.signal, req.durationSeconds, model, req.seed);
  }
}

export function createStabilityProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return { descriptor: buildDescriptor(config, STABILITY_AUDIO_CAPABILITIES), config, audioGeneration: new StabilityAudioProvider(config, http) };
}
