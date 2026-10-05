/**
 * Lyrics transcription (capability LYRIC_TRANSCRIPTION): sung or spoken audio → words with timings.
 *
 * - `LyricsBridge` — the Song Deck lyrics bridge contract (Whisper / faster-whisper / WhisperX):
 *   POST /transcribe_lyrics `{ audio_base64, language?, prompt?, word_timestamps? }`
 *   → `{ text, language?, segments: [{ start, end, text, words?: [{ word, start, end, confidence? }] }] }`.
 * - `OpenAITranscription` — OpenAI-style `POST {base}/audio/transcriptions` (multipart: `file`,
 *   `model`, `response_format`, `timestamp_granularities[]`, `language`, `prompt`). Whisper models
 *   (`whisper-1`, Groq's `whisper-large-v3[-turbo]`, local servers such as Speaches or whisper.cpp's
 *   server) answer `verbose_json` with top-level `words: [{ word, start, end }]` and `segments`;
 *   `gpt-4o(-mini)-transcribe` only answer `json` (`{ text }`, no timings).
 * - `ElevenLabsSpeechToText` — ElevenLabs Scribe: `POST {base}/speech-to-text` (multipart:
 *   `model_id`, `file`, `language_code?`, `timestamps_granularity=word`) →
 *   `{ language_code, text, words: [{ text, start, end, type: 'word'|'spacing'|'audio_event', logprob? }] }`.
 *
 * Uploads are size-limited by the services (OpenAI: 25 MB), so callers should send mono 16 kHz WAV
 * (the studio does); larger inputs fail fast with a clear message instead of a provider 413.
 */
import type { Capability } from '../capabilities';
import type { ProviderConfig } from '../config';
import { LYRICS_BRIDGE_PATHS, type LyricsBridgeRequest, type LyricsBridgeResponse } from '../contracts';
import { audioCostUsd } from '../cost';
import { ProviderError } from '../errors';
import type { HttpClient } from '../transport/http';
import { encodeMultipart, type MultipartPart } from '../transport/multipart';
import type {
  LyricSegment,
  LyricTranscriptionProvider,
  LyricTranscriptionRequest,
  LyricTranscriptionResult,
  LyricWord,
  ProviderInstance,
} from '../types';
import { audioExtension, bytesToBase64, clamp, joinUrl } from '../util';
import { buildDescriptor, createHttpClient, type CreateProviderDeps, pricingFor } from './common';

export const LYRIC_TRANSCRIPTION_CAPABILITIES: Capability[] = ['LYRIC_TRANSCRIPTION'];

/** OpenAI's documented upload limit for /audio/transcriptions. */
export const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

/** Gap (seconds) between words that starts a new phrase when a provider returns only words. */
const PHRASE_GAP_SECONDS = 0.8;

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function cleanWord(w: string): string {
  return w.replace(/\s+/g, ' ').trim();
}

/** Valid, time-ordered words (drops empty text and non-finite or reversed times). */
export function normalizeWords(words: readonly LyricWord[]): LyricWord[] {
  return words
    .map((w) => ({ ...w, word: cleanWord(w.word ?? '') }))
    .filter((w) => w.word && finite(w.start) && finite(w.end) && w.end >= w.start && w.start >= 0)
    .map((w) => {
      const out: LyricWord = { word: w.word, start: w.start, end: Math.max(w.end, w.start + 0.01) };
      if (finite(w.confidence)) out.confidence = clamp(w.confidence, 0, 1);
      return out;
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Group words into phrases at pauses longer than `gap` seconds or after sentence punctuation. */
export function groupWordsIntoSegments(
  words: readonly LyricWord[],
  gap = PHRASE_GAP_SECONDS,
): LyricSegment[] {
  const out: LyricSegment[] = [];
  let cur: LyricWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      text: cur.map((w) => w.word).join(' '),
      words: cur,
    });
    cur = [];
  };
  for (const w of normalizeWords(words)) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > gap || /[.!?]$/.test(prev.word))) flush();
    cur.push(w);
  }
  flush();
  return out;
}

/** Put top-level words into the segments whose time span contains their midpoint. */
export function attachWords(segments: readonly LyricSegment[], words: readonly LyricWord[]): LyricSegment[] {
  const ws = normalizeWords(words);
  if (!segments.length) return groupWordsIntoSegments(ws);
  const segs = segments.map((s) => ({ ...s, words: [] as LyricWord[] }));
  for (const w of ws) {
    const mid = (w.start + w.end) / 2;
    let best = 0;
    let bestDist = Infinity;
    segs.forEach((s, i) => {
      const d = mid < s.start ? s.start - mid : mid > s.end ? mid - s.end : 0;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    segs[best].words.push(w);
  }
  return segs;
}

/** Common clean-up: drop empty segments, sort, fill `text`, flag whether word timings exist. */
export function finalizeLyrics(
  segments: readonly LyricSegment[],
  extra: { text?: string; language?: string; model?: string; costUsd?: number } = {},
): LyricTranscriptionResult {
  const segs = segments
    .map((s) => {
      const words = s.words ? normalizeWords(s.words) : undefined;
      const text = cleanWord(s.text ?? '') || (words ?? []).map((w) => w.word).join(' ');
      const start = finite(s.start) ? s.start : (words?.[0]?.start ?? 0);
      const end = finite(s.end) ? s.end : (words?.[words.length - 1]?.end ?? start);
      const seg: LyricSegment = { start, end: Math.max(end, start), text };
      if (words?.length) seg.words = words;
      return seg;
    })
    .filter((s) => s.text)
    .sort((a, b) => a.start - b.start);
  const res: LyricTranscriptionResult = {
    text: cleanWord(extra.text ?? '') || segs.map((s) => s.text).join('\n'),
    segments: segs,
    wordTimestamps: segs.length > 0 && segs.every((s) => (s.words?.length ?? 0) > 0),
  };
  if (extra.language) res.language = extra.language;
  if (extra.model) res.model = extra.model;
  if (extra.costUsd !== undefined) res.costUsd = extra.costUsd;
  return res;
}

/** `en-US` → `en` (speech-to-text APIs take ISO-639-1 codes). */
export function baseLanguage(lang: string | undefined): string | undefined {
  const l = lang?.trim().toLowerCase().split(/[-_]/)[0];
  return l || undefined;
}

function durationOf(req: LyricTranscriptionRequest, fallback?: number): number {
  return req.audio.durationSeconds ?? fallback ?? 0;
}

// ---------------------------------------------------------------------------
// Song Deck lyrics bridge
// ---------------------------------------------------------------------------

export class LyricsBridge implements LyricTranscriptionProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async transcribeLyrics(req: LyricTranscriptionRequest): Promise<LyricTranscriptionResult> {
    const body: LyricsBridgeRequest = {
      audio_base64: bytesToBase64(req.audio.data),
      word_timestamps: req.wordTimestamps ?? true,
    };
    const language = baseLanguage(req.language);
    if (language) body.language = language;
    if (req.prompt) body.prompt = req.prompt;
    const model = req.model ?? this.config.defaultModel;
    if (model) body.model = model;
    const json = await this.http.json<LyricsBridgeResponse>({
      url: joinUrl(this.config.baseUrl, LYRICS_BRIDGE_PATHS.transcribe),
      json: body,
      signal: req.signal,
    });
    if (!json || !Array.isArray(json.segments))
      throw new ProviderError('parse', 'Lyrics bridge returned no segments', { providerId: this.config.id });
    return finalizeLyrics(json.segments, {
      text: json.text,
      language: json.language,
      model: json.model ?? model,
    });
  }
}

export function createLyricsHttpProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, LYRIC_TRANSCRIPTION_CAPABILITIES),
    config,
    lyricTranscription: new LyricsBridge(config, http),
  };
}

// ---------------------------------------------------------------------------
// OpenAI-style /audio/transcriptions (OpenAI, Groq, Speaches, whisper.cpp server…)
// ---------------------------------------------------------------------------

interface OpenAIVerboseTranscription {
  text?: string;
  language?: string;
  duration?: number;
  segments?: { start?: number; end?: number; text?: string; avg_logprob?: number }[];
  words?: { word?: string; start?: number; end?: number; probability?: number }[];
}

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh',
  dutch: 'nl',
  russian: 'ru',
  swedish: 'sv',
  polish: 'pl',
  turkish: 'tr',
  hindi: 'hi',
  arabic: 'ar',
};

/** Whisper-family models return word timings; gpt-4o(-mini)-transcribe return only text. */
export function supportsWordTimestamps(model: string): boolean {
  return /whisper|distil/i.test(model);
}

export class OpenAITranscription implements LyricTranscriptionProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  /** The model used when the request names none. */
  get defaultModel(): string {
    const configured = this.config.extra?.transcriptionModel;
    if (typeof configured === 'string' && configured) return configured;
    if (this.config.adapter === 'openai-transcription' && this.config.defaultModel)
      return this.config.defaultModel;
    return /groq\.com/.test(this.config.baseUrl) ? 'whisper-large-v3-turbo' : 'whisper-1';
  }

  /** Multipart fields (exported for tests). */
  parts(req: LyricTranscriptionRequest, model: string): MultipartPart[] {
    const words = (req.wordTimestamps ?? true) && supportsWordTimestamps(model);
    const parts: MultipartPart[] = [
      {
        name: 'file',
        data: req.audio.data,
        filename: `vocals.${audioExtension(req.audio.mimeType)}`,
        contentType: req.audio.mimeType,
      },
      { name: 'model', value: model },
      { name: 'response_format', value: supportsWordTimestamps(model) ? 'verbose_json' : 'json' },
    ];
    if (words) {
      parts.push({ name: 'timestamp_granularities[]', value: 'word' });
      parts.push({ name: 'timestamp_granularities[]', value: 'segment' });
    }
    const language = baseLanguage(req.language);
    if (language) parts.push({ name: 'language', value: language });
    if (req.prompt) parts.push({ name: 'prompt', value: req.prompt.slice(0, 800) });
    return parts;
  }

  async transcribeLyrics(req: LyricTranscriptionRequest): Promise<LyricTranscriptionResult> {
    if (req.audio.data.length > OPENAI_TRANSCRIPTION_MAX_BYTES)
      throw new ProviderError(
        'bad-request',
        `Audio is ${(req.audio.data.length / 1048576).toFixed(1)} MB; transcription uploads are limited to 25 MB — send a shorter or mono 16 kHz clip`,
        { providerId: this.config.id },
      );
    // Routing may hand over the provider's chat default (gpt-5…): only speech models are used as is.
    const model =
      req.model && /whisper|transcri|distil|stt|speech/i.test(req.model) ? req.model : this.defaultModel;
    const mp = encodeMultipart(this.parts(req, model));
    const json = await this.http.json<OpenAIVerboseTranscription>({
      url: joinUrl(this.config.baseUrl, 'audio/transcriptions'),
      body: mp.body,
      contentType: mp.contentType,
      accept: 'application/json',
      signal: req.signal,
    });
    if (!json || typeof json.text !== 'string')
      throw new ProviderError('parse', 'Transcription response had no text', { providerId: this.config.id });
    const words: LyricWord[] = (json.words ?? []).map((w) => {
      const out: LyricWord = { word: w.word ?? '', start: w.start ?? NaN, end: w.end ?? NaN };
      if (finite(w.probability)) out.confidence = w.probability;
      return out;
    });
    let segments: LyricSegment[] = (json.segments ?? []).map((s) => ({
      start: s.start ?? NaN,
      end: s.end ?? NaN,
      text: s.text ?? '',
    }));
    if (words.length) segments = attachWords(segments, words);
    if (!segments.length) segments = [{ start: 0, end: json.duration ?? durationOf(req), text: json.text }];
    const lang = json.language
      ? (LANGUAGE_CODES[json.language.toLowerCase()] ?? json.language)
      : req.language;
    const cost = audioCostUsd(pricingFor(this.config), model, durationOf(req, json.duration));
    return finalizeLyrics(segments, { text: json.text, language: lang, model, costUsd: cost });
  }
}

export function createOpenAITranscriptionProvider(
  config: ProviderConfig,
  deps: CreateProviderDeps,
): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, LYRIC_TRANSCRIPTION_CAPABILITIES),
    config,
    lyricTranscription: new OpenAITranscription(config, http),
  };
}

// ---------------------------------------------------------------------------
// ElevenLabs Scribe
// ---------------------------------------------------------------------------

interface ElevenLabsSttResponse {
  language_code?: string;
  text?: string;
  words?: { text?: string; start?: number; end?: number; type?: string; logprob?: number }[];
}

export const ELEVENLABS_STT_DEFAULT_MODEL = 'scribe_v1';

export class ElevenLabsSpeechToText implements LyricTranscriptionProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async transcribeLyrics(req: LyricTranscriptionRequest): Promise<LyricTranscriptionResult> {
    const configured = this.config.extra?.transcriptionModel;
    const model =
      req.model && /^scribe/i.test(req.model)
        ? req.model
        : typeof configured === 'string' && configured
          ? configured
          : ELEVENLABS_STT_DEFAULT_MODEL;
    const parts: MultipartPart[] = [
      { name: 'model_id', value: model },
      {
        name: 'file',
        data: req.audio.data,
        filename: `vocals.${audioExtension(req.audio.mimeType)}`,
        contentType: req.audio.mimeType,
      },
      { name: 'timestamps_granularity', value: 'word' },
      { name: 'tag_audio_events', value: 'false' },
    ];
    const language = baseLanguage(req.language);
    if (language) parts.push({ name: 'language_code', value: language });
    const mp = encodeMultipart(parts);
    const json = await this.http.json<ElevenLabsSttResponse>({
      url: joinUrl(this.config.baseUrl, 'speech-to-text'),
      body: mp.body,
      contentType: mp.contentType,
      accept: 'application/json',
      signal: req.signal,
    });
    if (!json || typeof json.text !== 'string')
      throw new ProviderError('parse', 'ElevenLabs speech-to-text returned no text', {
        providerId: this.config.id,
      });
    const words: LyricWord[] = (json.words ?? [])
      .filter((w) => (w.type ?? 'word') === 'word')
      .map((w) => {
        const out: LyricWord = { word: w.text ?? '', start: w.start ?? NaN, end: w.end ?? NaN };
        if (finite(w.logprob)) out.confidence = Math.exp(Math.min(0, w.logprob));
        return out;
      });
    const segments = words.length
      ? groupWordsIntoSegments(words)
      : [{ start: 0, end: durationOf(req), text: json.text }];
    return finalizeLyrics(segments, { text: json.text, language: json.language_code ?? req.language, model });
  }
}
