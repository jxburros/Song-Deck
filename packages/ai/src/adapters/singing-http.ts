/**
 * Singing synthesis bridge adapter (DiffSinger/OpenVPI via the Song Deck singing contract):
 * GET /voices, POST /synthesize, POST /regenerate_phrase (see contracts.ts).
 */
import type { VoiceKind, VoiceType } from '@songdeck/core';
import type { ProviderConfig } from '../config';
import { SINGING_BRIDGE_PATHS, type SingingBridgeNote, type SingingBridgeRequest, type SingingBridgeVoice } from '../contracts';
import type { HttpClient } from '../transport/http';
import type { PhraseRegenerationRequest, ProviderInstance, SingingProvider, SingingRequest, SingingResult, VoiceInfo } from '../types';
import { joinUrl } from '../util';
import { audioFromResponse, buildDescriptor, createHttpClient, type CreateProviderDeps } from './common';

const VOICE_KINDS: VoiceKind[] = ['stock', 'user-trained', 'imported', 'third-party'];
const VOICE_TYPES: VoiceType[] = ['soprano', 'mezzo', 'alto', 'tenor', 'baritone', 'bass'];

export function voiceFromBridge(v: SingingBridgeVoice): VoiceInfo {
  const info: VoiceInfo = { id: v.id, name: v.name || v.id, kind: VOICE_KINDS.includes(v.kind as VoiceKind) ? (v.kind as VoiceKind) : 'imported' };
  if (VOICE_TYPES.includes(v.voice_type as VoiceType)) info.voiceType = v.voice_type as VoiceType;
  if (v.language) info.language = v.language;
  return info;
}

/** Convert a SingingRequest to the bridge wire format (exported for tests). */
export function singingBody(req: SingingRequest): SingingBridgeRequest {
  const body: SingingBridgeRequest = {
    voice_id: req.voiceId,
    tempo_bpm: req.tempoBpm,
    sample_rate: req.sampleRate ?? 44100,
    seed: req.seed ?? 0,
    notes: req.notes.map((n) => {
      const note: SingingBridgeNote = {
        pitch: n.pitch,
        start_seconds: n.startSeconds,
        duration_seconds: n.durationSeconds,
        lyric: n.lyric,
        velocity: n.velocity,
      };
      if (n.phonemes?.length) note.phonemes = [...n.phonemes];
      const e = n.expression;
      if (e) {
        const expr: NonNullable<SingingBridgeNote['expression']> = {};
        if (e.breathiness !== undefined) expr.breathiness = e.breathiness;
        if (e.tension !== undefined) expr.tension = e.tension;
        if (e.vibrato !== undefined) expr.vibrato = e.vibrato;
        if (e.vibratoRate !== undefined) expr.vibrato_rate = e.vibratoRate;
        if (e.onset !== undefined) expr.onset = e.onset;
        if (e.release !== undefined) expr.release = e.release;
        if (e.energy !== undefined) expr.energy = e.energy;
        if (Object.keys(expr).length) note.expression = expr;
      }
      return note;
    }),
  };
  if (req.language) body.language = req.language;
  return body;
}

export class SingingBridge implements SingingProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  private url(path: string): string {
    return joinUrl(this.config.baseUrl, path);
  }

  async listVoices(signal?: AbortSignal): Promise<VoiceInfo[]> {
    const json = await this.http.json<SingingBridgeVoice[] | { voices?: SingingBridgeVoice[] }>({ url: this.url(SINGING_BRIDGE_PATHS.voices), method: 'GET', signal });
    const list = Array.isArray(json) ? json : (json?.voices ?? []);
    return list.map(voiceFromBridge);
  }

  async synthesizeSinging(req: SingingRequest): Promise<SingingResult> {
    const r = await this.http.bytes({ url: this.url(SINGING_BRIDGE_PATHS.synthesize), json: singingBody(req), accept: 'audio/wav', signal: req.signal });
    return this.result(r.data, r.contentType, r.headers, req);
  }

  async regeneratePhrase(req: PhraseRegenerationRequest): Promise<SingingResult> {
    const body = { ...singingBody(req), start_seconds: req.startSeconds, end_seconds: req.endSeconds };
    const r = await this.http.bytes({ url: this.url(SINGING_BRIDGE_PATHS.regeneratePhrase), json: body, accept: 'audio/wav', signal: req.signal });
    return this.result(r.data, r.contentType, r.headers, req);
  }

  private result(data: Uint8Array, contentType: string, headers: Headers, req: SingingRequest): SingingResult {
    const res: SingingResult = { audio: audioFromResponse(data, contentType, 'wav'), voiceId: req.voiceId, seed: req.seed ?? 0 };
    const model = headers.get('x-model') ?? req.model;
    if (model) res.model = model;
    if (this.config.location === 'local') res.costUsd = 0;
    return res;
  }
}

export function createSingingHttpProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return { descriptor: buildDescriptor(config, ['SINGING_SYNTHESIS', 'MIDI_CONDITIONING', 'LYRIC_CONDITIONING']), config, singing: new SingingBridge(config, http) };
}
