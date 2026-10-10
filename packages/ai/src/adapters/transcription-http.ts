/**
 * Transcription bridge adapter (Basic Pitch via the Song Deck transcription contract):
 * POST /transcribe `{ audio_base64, source }` → `{ notes, tempo?, key?, chords? }`.
 */
import type { ProviderConfig } from '../config';
import {
  TRANSCRIPTION_BRIDGE_PATHS,
  type TranscriptionBridgeRequest,
  type TranscriptionBridgeResponse,
} from '../contracts';
import type { HttpClient } from '../transport/http';
import type {
  ProviderInstance,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from '../types';
import { bytesToBase64, clamp, joinUrl } from '../util';
import { buildDescriptor, createHttpClient, type CreateProviderDeps } from './common';

export class TranscriptionBridge implements TranscriptionProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async transcribeNotes(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const body: TranscriptionBridgeRequest = {
      audio_base64: bytesToBase64(req.audio.data),
      source:
        (
          { humming: 'vocals', singing: 'vocals', 'full-mix': 'mix', isolated: 'other' } as Record<
            string,
            string
          >
        )[req.source ?? 'mix'] ??
        req.source ??
        'mix',
    };
    const json = await this.http.json<TranscriptionBridgeResponse>({
      url: joinUrl(this.config.baseUrl, TRANSCRIPTION_BRIDGE_PATHS.transcribe),
      json: body,
      signal: req.signal,
    });
    const notes = (Array.isArray(json?.notes) ? json.notes : [])
      .filter(
        (n) =>
          n &&
          typeof n === 'object' &&
          Number.isFinite(n.pitch) &&
          Number.isFinite(n.start) &&
          Number.isFinite(n.end) &&
          n.end > Math.max(0, n.start),
      )
      .map((n) => ({
        pitch: Math.round(clamp(n.pitch, 0, 127)),
        start: Math.max(0, n.start),
        end: n.end,
        velocity: Math.round(clamp(Number.isFinite(n.velocity) ? n.velocity! : 80, 1, 127)),
        confidence: clamp(Number.isFinite(n.confidence) ? n.confidence! : 0.5, 0, 1),
      }));
    const res: TranscriptionResult = { notes };
    if (Number.isFinite(json?.tempo) && json.tempo! > 0) res.tempo = json.tempo;
    if (typeof json?.key === 'string') res.key = json.key;
    if (Array.isArray(json?.chords))
      res.chords = json.chords.filter(
        (c) =>
          c &&
          typeof c.symbol === 'string' &&
          Number.isFinite(c.start) &&
          Number.isFinite(c.end) &&
          c.end > c.start,
      );
    if (notes.length) res.confidence = notes.reduce((a, n) => a + n.confidence, 0) / notes.length;
    if (req.model ?? this.config.defaultModel) res.model = req.model ?? this.config.defaultModel;
    return res;
  }
}

export function createTranscriptionHttpProvider(
  config: ProviderConfig,
  deps: CreateProviderDeps,
): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, ['AUDIO_TRANSCRIPTION', 'AUDIO_TO_MIDI']),
    config,
    transcription: new TranscriptionBridge(config, http),
  };
}
