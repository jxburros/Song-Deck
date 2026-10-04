/**
 * Mastering bridge adapter (local AI / reference mastering via the Song Deck mastering contract):
 * POST /master `{ audio_base64, target, reference_audio_base64? }` → audio/wav.
 */
import type { ProviderConfig } from '../config';
import { MASTERING_BRIDGE_PATHS, type MasteringBridgeRequest } from '../contracts';
import type { HttpClient } from '../transport/http';
import type { MasteringProvider, MasteringRequest, MasteringResult, ProviderInstance } from '../types';
import { bytesToBase64, joinUrl } from '../util';
import { audioFromResponse, buildDescriptor, createHttpClient, type CreateProviderDeps } from './common';

export class MasteringBridge implements MasteringProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async master(req: MasteringRequest): Promise<MasteringResult> {
    const body: MasteringBridgeRequest = { audio_base64: bytesToBase64(req.audio.data), target: req.target };
    if (req.reference) body.reference_audio_base64 = bytesToBase64(req.reference.data);
    const r = await this.http.bytes({
      url: joinUrl(this.config.baseUrl, MASTERING_BRIDGE_PATHS.master),
      json: body,
      accept: 'audio/wav',
      signal: req.signal,
    });
    const res: MasteringResult = { audio: audioFromResponse(r.data, r.contentType, 'wav') };
    const model = r.headers.get('x-model') ?? req.model;
    if (model) res.model = model;
    return res;
  }
}

export function createMasteringHttpProvider(
  config: ProviderConfig,
  deps: CreateProviderDeps,
): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, ['MASTERING']),
    config,
    mastering: new MasteringBridge(config, http),
  };
}
