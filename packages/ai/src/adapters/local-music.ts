/**
 * Local music bridge adapter (ACE-Step and any model implementing the Song Deck music contract —
 * see contracts.ts): GET /info, POST /generate, /transform, /inpaint, /extend (optional), /cancel.
 */
import { type Capability, normalizeCapabilities } from '../capabilities';
import type { ProviderConfig } from '../config';
import { audioCostUsd } from '../cost';
import {
  MUSIC_BRIDGE_PATHS,
  type MusicBridgeExtendRequest,
  type MusicBridgeGenerateRequest,
  type MusicBridgeInfo,
  type MusicBridgeInpaintRequest,
  type MusicBridgeTransformRequest,
} from '../contracts';
import type { HttpClient } from '../transport/http';
import type {
  AudioExtendRequest,
  AudioGenerationProvider,
  AudioGenerationResult,
  AudioInpaintRequest,
  AudioTransformRequest,
  ModelInfo,
  MusicGenerationRequest,
  ProviderInstance,
} from '../types';
import { bytesToBase64, joinUrl } from '../util';
import { audioFromResponse, buildDescriptor, createHttpClient, type CreateProviderDeps, notSupported, pricingFor } from './common';

/** Lyrics text with section tags for bridges ("[chorus]\nline…"). */
export function lyricsWithSectionTags(req: MusicGenerationRequest): string | undefined {
  if (req.lyrics) return req.lyrics;
  const parts = (req.sections ?? []).filter((s) => s.lines?.length).map((s) => `[${(s.kind ?? s.name).toLowerCase()}]\n${s.lines!.join('\n')}`);
  return parts.length ? parts.join('\n\n') : undefined;
}

export class LocalMusicBridge implements AudioGenerationProvider {
  private info?: MusicBridgeInfo;

  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  private url(path: string): string {
    return joinUrl(this.config.baseUrl, path);
  }

  async getInfo(signal?: AbortSignal, force = false): Promise<MusicBridgeInfo> {
    if (!this.info || force) this.info = await this.http.json<MusicBridgeInfo>({ url: this.url(MUSIC_BRIDGE_PATHS.info), method: 'GET', signal });
    return this.info;
  }

  async discoverModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const info = await this.getInfo(signal, true);
    const caps = this.config.capabilities?.length ? this.config.capabilities : normalizeCapabilities(info.capabilities);
    const models = (info.models ?? []).map((m) => ({ id: m.id, name: m.name, capabilities: [...caps], meta: { bridge: info.name, version: info.version, minVramGb: info.hardware?.min_vram_gb } }) as ModelInfo);
    return models.length ? models : [{ id: info.name || 'default', name: info.name, capabilities: [...caps] }];
  }

  async getCapabilities(): Promise<Capability[]> {
    if (this.config.capabilities?.length) return [...this.config.capabilities];
    try {
      return normalizeCapabilities((await this.getInfo()).capabilities);
    } catch {
      return [];
    }
  }

  private result(data: Uint8Array, contentType: string, headers: Headers, req: { seed?: number; model?: string }, durationSeconds?: number): AudioGenerationResult {
    const seedHeader = Number(headers.get('x-seed'));
    const res: AudioGenerationResult = { audio: audioFromResponse(data, contentType, 'wav') };
    const seed = Number.isFinite(seedHeader) && headers.get('x-seed') !== null ? seedHeader : req.seed;
    if (seed !== undefined) res.seed = seed;
    const model = headers.get('x-model') ?? req.model;
    if (model) res.model = model;
    if (durationSeconds !== undefined) {
      res.durationSeconds = durationSeconds;
      const cost = this.config.location === 'local' ? 0 : audioCostUsd(pricingFor(this.config), model ?? undefined, durationSeconds);
      if (cost !== undefined) res.costUsd = cost;
    }
    return res;
  }

  /** Build the /generate body (exported for tests). */
  generateBody(req: MusicGenerationRequest): MusicBridgeGenerateRequest {
    const body: MusicBridgeGenerateRequest = { prompt: req.prompt, duration_seconds: req.durationSeconds };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    const lyrics = req.instrumental ? undefined : lyricsWithSectionTags(req);
    if (lyrics) body.lyrics = lyrics;
    if (req.seed !== undefined) body.seed = req.seed;
    if (req.bpm !== undefined) body.bpm = req.bpm;
    if (req.key) body.key = req.key;
    if (req.sections?.length) {
      body.sections = req.sections.map((s) => ({ name: s.name, start_seconds: s.startSeconds, end_seconds: s.endSeconds, ...(s.prompt ? { prompt: s.prompt } : {}) }));
    }
    if (req.referenceAudio) body.reference_audio_base64 = bytesToBase64(req.referenceAudio.data);
    if (req.guideAudio) body.guide_audio_base64 = bytesToBase64(req.guideAudio.data);
    if (req.strength !== undefined) body.strength = req.strength;
    if (req.instrumental !== undefined) body.instrumental = req.instrumental;
    const model = req.model ?? this.config.defaultModel;
    if (model) body.model = model;
    return body;
  }

  async generateMusic(req: MusicGenerationRequest): Promise<AudioGenerationResult> {
    const r = await this.http.bytes({ url: this.url(MUSIC_BRIDGE_PATHS.generate), json: this.generateBody(req), accept: 'audio/wav', signal: req.signal });
    return this.result(r.data, r.contentType, r.headers, req, req.durationSeconds);
  }

  async transformAudio(req: AudioTransformRequest): Promise<AudioGenerationResult> {
    const body: MusicBridgeTransformRequest = { audio_base64: bytesToBase64(req.audio.data), prompt: req.prompt, strength: req.strength ?? 0.5 };
    if (req.seed !== undefined) body.seed = req.seed;
    const model = req.model ?? this.config.defaultModel;
    if (model) body.model = model;
    const r = await this.http.bytes({ url: this.url(MUSIC_BRIDGE_PATHS.transform), json: body, accept: 'audio/wav', signal: req.signal });
    return this.result(r.data, r.contentType, r.headers, req, req.durationSeconds);
  }

  async inpaintAudio(req: AudioInpaintRequest): Promise<AudioGenerationResult> {
    const body: MusicBridgeInpaintRequest = { audio_base64: bytesToBase64(req.audio.data), start_seconds: req.startSeconds, end_seconds: req.endSeconds, prompt: req.prompt };
    if (req.seed !== undefined) body.seed = req.seed;
    const model = req.model ?? this.config.defaultModel;
    if (model) body.model = model;
    const r = await this.http.bytes({ url: this.url(MUSIC_BRIDGE_PATHS.inpaint), json: body, accept: 'audio/wav', signal: req.signal });
    return this.result(r.data, r.contentType, r.headers, req, req.endSeconds - req.startSeconds);
  }

  async extendAudio(req: AudioExtendRequest): Promise<AudioGenerationResult> {
    const caps = await this.getCapabilities();
    if (caps.length && !caps.includes('OUTPAINTING')) throw notSupported(this.config.id, 'Extending audio');
    const body: MusicBridgeExtendRequest = { audio_base64: bytesToBase64(req.audio.data), prompt: req.prompt, duration_seconds: req.durationSeconds };
    if (req.seed !== undefined) body.seed = req.seed;
    const model = req.model ?? this.config.defaultModel;
    if (model) body.model = model;
    const r = await this.http.bytes({ url: this.url(MUSIC_BRIDGE_PATHS.extend), json: body, accept: 'audio/wav', signal: req.signal });
    return this.result(r.data, r.contentType, r.headers, req, req.durationSeconds);
  }

  async cancel(jobId?: string): Promise<void> {
    await this.http.send({ url: this.url(MUSIC_BRIDGE_PATHS.cancel), json: jobId ? { job_id: jobId } : {}, retry: false }, async () => undefined);
  }
}

export function createLocalMusicProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return { descriptor: buildDescriptor(config, ['TEXT_TO_MUSIC']), config, audioGeneration: new LocalMusicBridge(config, http) };
}
