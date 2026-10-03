/**
 * Voice conversion bridge adapter (RVC via the Song Deck voice-conversion contract):
 * POST /convert `{ audio_base64, target_voice_id, pitch_shift? }` → audio/wav; GET /voices (optional).
 * Consent is enforced BEFORE any audio leaves the app (spec §36).
 */
import type { ProviderConfig } from '../config';
import { assertVoiceConsent } from '../consent';
import { SINGING_BRIDGE_PATHS, VOICE_CONVERSION_BRIDGE_PATHS, type SingingBridgeVoice, type VoiceConversionBridgeRequest } from '../contracts';
import type { HttpClient } from '../transport/http';
import type { ProviderInstance, VoiceConversionProvider, VoiceConversionRequest, VoiceConversionResult, VoiceInfo } from '../types';
import { bytesToBase64, joinUrl } from '../util';
import { audioFromResponse, buildDescriptor, createHttpClient, type CreateProviderDeps } from './common';
import { voiceFromBridge } from './singing-http';

export class VoiceConversionBridge implements VoiceConversionProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async listVoices(signal?: AbortSignal): Promise<VoiceInfo[]> {
    const json = await this.http.json<SingingBridgeVoice[] | { voices?: SingingBridgeVoice[] }>({ url: joinUrl(this.config.baseUrl, SINGING_BRIDGE_PATHS.voices), method: 'GET', signal });
    return (Array.isArray(json) ? json : (json?.voices ?? [])).map(voiceFromBridge);
  }

  async convertVoice(req: VoiceConversionRequest): Promise<VoiceConversionResult> {
    assertVoiceConsent(req.targetVoice, req.consent);
    const body: VoiceConversionBridgeRequest = { audio_base64: bytesToBase64(req.audio.data), target_voice_id: req.targetVoice.id };
    if (req.pitchShift !== undefined) body.pitch_shift = req.pitchShift;
    const r = await this.http.bytes({ url: joinUrl(this.config.baseUrl, VOICE_CONVERSION_BRIDGE_PATHS.convert), json: body, accept: 'audio/wav', signal: req.signal });
    const res: VoiceConversionResult = { audio: audioFromResponse(r.data, r.contentType, 'wav'), voiceId: req.targetVoice.id };
    const model = r.headers.get('x-model') ?? req.model;
    if (model) res.model = model;
    return res;
  }
}

export function createVoiceConversionHttpProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return { descriptor: buildDescriptor(config, ['VOICE_CONVERSION']), config, voiceConversion: new VoiceConversionBridge(config, http) };
}
