/**
 * Source separation bridge adapter (Demucs via the Song Deck separation contract):
 * POST /separate `{ audio_base64, stems }` → `{ stems: { name: wav_base64 }, model }`.
 */
import type { ProviderConfig } from '../config';
import { ProviderError } from '../errors';
import { SEPARATION_BRIDGE_PATHS, type SeparationBridgeRequest, type SeparationBridgeResponse } from '../contracts';
import type { HttpClient } from '../transport/http';
import type { EncodedAudio, ProviderInstance, SeparationProvider, SeparationRequest, SeparationResult } from '../types';
import { bytesToBase64, joinUrl } from '../util';
import { audioFromBase64, buildDescriptor, createHttpClient, type CreateProviderDeps } from './common';

export const DEFAULT_STEMS = ['drums', 'bass', 'vocals', 'other'];

export class SeparationBridge implements SeparationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async separateStems(req: SeparationRequest): Promise<SeparationResult> {
    const body: SeparationBridgeRequest = { audio_base64: bytesToBase64(req.audio.data), stems: req.stems?.length ? [...req.stems] : [...DEFAULT_STEMS] };
    const json = await this.http.json<SeparationBridgeResponse>({ url: joinUrl(this.config.baseUrl, SEPARATION_BRIDGE_PATHS.separate), json: body, signal: req.signal });
    if (!json || typeof json.stems !== 'object') throw new ProviderError('parse', 'Separation bridge returned no stems', { providerId: this.config.id });
    const stems: Record<string, EncodedAudio> = {};
    for (const [name, b64] of Object.entries(json.stems)) if (typeof b64 === 'string' && b64) stems[name] = audioFromBase64(b64, 'audio/wav');
    const res: SeparationResult = { stems };
    if (json.model) res.model = json.model;
    return res;
  }
}

export function createSeparationHttpProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return { descriptor: buildDescriptor(config, ['SOURCE_SEPARATION', 'STEM_OUTPUT']), config, separation: new SeparationBridge(config, http) };
}
