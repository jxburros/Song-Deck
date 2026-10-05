/**
 * Cloud full-song generators that take lyrics with section tags.
 *
 * MiniMax Music (`https://api.minimax.io/v1`, `Authorization: Bearer`):
 *   `POST /music_generation` `{ model, prompt, lyrics?, is_instrumental?, audio_setting: { sample_rate,
 *   bitrate, format }, output_format: 'hex' }` → `{ data: { audio: <hex>, status }, extra_info:
 *   { music_duration (ms), music_sample_rate, … }, base_resp: { status_code, status_msg } }`.
 *   The audio comes back inline (hex), so no download host is involved. Prompt ≤ 2000 characters,
 *   lyrics ≤ 3500 characters with `[Verse]` / `[Chorus]` … tags; the model picks the length.
 *
 * Mureka (`https://api.mureka.ai`, `Authorization: Bearer`):
 *   `POST /v1/song/generate` `{ lyrics, model, prompt? }` or `POST /v1/instrumental/generate`
 *   `{ model, prompt }` → `{ id, status }`; poll `GET /v1/song/query/{id}` (or
 *   `/v1/instrumental/query/{id}`) until `status` is `succeeded` (`failed`, `timeouted`, `cancelled`
 *   end the job) and download `choices[].url` (signed URLs; `extra.downloadHosts` lets the server
 *   proxy fetch them without credentials). Lyrics ≤ 5000 characters.
 *
 * These shapes follow the providers' public API references as found by search (the reference pages
 * could not be fetched from the build environment), so parsing is tolerant and the paths are
 * overridable in `extra`.
 */
import type { Capability } from '../capabilities';
import type { ProviderConfig } from '../config';
import { audioCostUsd } from '../cost';
import { ProviderError } from '../errors';
import type { HttpClient } from '../transport/http';
import type { Clock } from '../transport/limiter';
import type {
  AudioGenerationProvider,
  AudioGenerationResult,
  AudioTransformRequest,
  GenerationSection,
  ModelInfo,
  MusicGenerationRequest,
  ProviderInstance,
} from '../types';
import { audioMimeType, joinUrl } from '../util';
import {
  buildDescriptor,
  createHttpClient,
  type CreateProviderDeps,
  downloadResult,
  notSupported,
  pollUntil,
  pricingFor,
  urlExtension,
} from './common';

// ---------------------------------------------------------------------------
// Shared: prompts and tagged lyrics
// ---------------------------------------------------------------------------

const SECTION_TAGS: Record<string, string> = {
  intro: 'Intro',
  verse: 'Verse',
  'pre-chorus': 'Pre Chorus',
  prechorus: 'Pre Chorus',
  chorus: 'Chorus',
  'post-chorus': 'Post Chorus',
  hook: 'Hook',
  bridge: 'Bridge',
  breakdown: 'Break',
  break: 'Break',
  solo: 'Solo',
  interlude: 'Interlude',
  instrumental: 'Inst',
  outro: 'Outro',
};

/** "Chorus 2" → "Chorus" (a linear scan; no backtracking regex on user text). */
function withoutTrailingNumber(text: string): string {
  let i = text.length;
  while (i > 0 && text.charCodeAt(i - 1) >= 48 && text.charCodeAt(i - 1) <= 57) i--;
  return text.slice(0, i).trim();
}

function tagFor(s: Pick<GenerationSection, 'kind' | 'name'>): string {
  const kind = (s.kind ?? '').toLowerCase();
  if (SECTION_TAGS[kind]) return SECTION_TAGS[kind];
  const word = withoutTrailingNumber(s.name.toLowerCase());
  return SECTION_TAGS[word] ?? (withoutTrailingNumber(s.name) || 'Verse');
}

/** `[verse]` / `[CHORUS 2]` → `[Verse]` / `[Chorus]`. */
export function normalizeLyricTags(lyrics: string): string {
  return lyrics
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!(t.startsWith('[') && t.endsWith(']')) || t.length < 3 || t.slice(1, -1).includes(']'))
        return line;
      const raw = t.slice(1, -1);
      return `[${SECTION_TAGS[withoutTrailingNumber(raw.toLowerCase())] ?? raw.trim()}]`;
    })
    .join('\n');
}

/**
 * Lyrics with section tags from the request: from the sections' lyric lines when they carry any
 * (instrumental sections become bare tags so the arrangement keeps its shape), else the request's
 * lyrics text. Empty when nothing is sung.
 */
export function taggedLyrics(req: MusicGenerationRequest, maxChars: number): string {
  let text = '';
  const sections = req.sections ?? [];
  if (sections.some((s) => (s.lines ?? []).length)) {
    text = sections.map((s) => [`[${tagFor(s)}]`, ...(s.lines ?? [])].join('\n')).join('\n\n');
  } else if (req.lyrics?.trim()) text = normalizeLyricTags(req.lyrics.trim());
  if (text.length <= maxChars) return text;
  // Keep whole lines within the limit.
  const out: string[] = [];
  let n = 0;
  for (const line of text.split('\n')) {
    if (n + line.length + 1 > maxChars) break;
    out.push(line);
    n += line.length + 1;
  }
  return out.join('\n');
}

/** Prompt + tempo/key/meter hints, trimmed to `maxChars`. */
export function stylePrompt(req: MusicGenerationRequest, maxChars: number): string {
  const parts = [req.prompt.trim()];
  const hints = [
    req.bpm ? `${Math.round(req.bpm)} BPM` : '',
    req.key ? `key of ${req.key}` : '',
    req.meter && req.meter !== '4/4' ? `${req.meter} time` : '',
  ].filter(Boolean);
  if (hints.length) parts.push(hints.join(', '));
  if (req.negativePrompt?.trim()) parts.push(`avoid: ${req.negativePrompt.trim()}`);
  const prompt = parts.filter(Boolean).join('. ');
  return prompt.length > maxChars ? prompt.slice(0, maxChars).replace(/\s+\S*$/, '') : prompt;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// MiniMax Music
// ---------------------------------------------------------------------------

export const MINIMAX_MUSIC_CAPABILITIES: Capability[] = [
  'TEXT_TO_MUSIC',
  'LYRIC_CONDITIONING',
  'VOCAL_GENERATION',
  'INSTRUMENTAL_ONLY',
  'SECTION_GENERATION',
];
export const MINIMAX_DEFAULT_MODEL = 'music-2.6';
const MINIMAX_PROMPT_MAX = 2000;
const MINIMAX_LYRICS_MAX = 3500;

interface MiniMaxResponse {
  data?: { audio?: string; status?: number } | null;
  extra_info?: { music_duration?: number; music_sample_rate?: number; music_channel?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

/** MiniMax `base_resp.status_code` → ProviderError (0 = success). */
export function miniMaxError(code: number, msg: string | undefined, providerId: string): ProviderError {
  const message = msg || `MiniMax error ${code}`;
  if (code === 1002 || code === 1039) return new ProviderError('rate-limit', message, { providerId });
  if (code === 1004 || code === 2049) return new ProviderError('auth', message, { providerId });
  if (code === 1008)
    return new ProviderError('bad-request', `${message} (insufficient balance)`, { providerId });
  if (code === 1026 || code === 1027) return new ProviderError('refusal', message, { providerId });
  if (code === 1000 || code === 1001 || code === 1024 || code === 1033)
    return new ProviderError('unavailable', message, { providerId });
  return new ProviderError('bad-request', message, { providerId });
}

export class MiniMaxMusicProvider implements AudioGenerationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  private get format(): 'mp3' | 'wav' {
    return this.config.extra?.outputFormat === 'wav' ? 'wav' : 'mp3';
  }

  async discoverModels(): Promise<ModelInfo[]> {
    const caps = this.config.capabilities?.length ? this.config.capabilities : MINIMAX_MUSIC_CAPABILITIES;
    const manual = (this.config.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      capabilities: m.capabilities ?? [...caps],
      manual: true,
    }));
    if (manual.length) return manual;
    return ['music-2.6', 'music-3.0'].map((id) => ({ id, name: `MiniMax ${id}`, capabilities: [...caps] }));
  }

  async getCapabilities(): Promise<Capability[]> {
    return [...(this.config.capabilities?.length ? this.config.capabilities : MINIMAX_MUSIC_CAPABILITIES)];
  }

  /** Request body (exported for tests). */
  body(req: MusicGenerationRequest): Record<string, unknown> {
    const lyrics = req.instrumental ? '' : taggedLyrics(req, MINIMAX_LYRICS_MAX);
    const body: Record<string, unknown> = {
      model: req.model ?? this.config.defaultModel ?? MINIMAX_DEFAULT_MODEL,
      prompt: stylePrompt(req, MINIMAX_PROMPT_MAX),
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: this.format },
      output_format: 'hex',
    };
    if (lyrics) body.lyrics = lyrics;
    else body.is_instrumental = true;
    return body;
  }

  async generateMusic(req: MusicGenerationRequest): Promise<AudioGenerationResult> {
    const body = this.body(req);
    const path = (this.config.extra?.generatePath as string | undefined) ?? 'music_generation';
    const json = await this.http.json<MiniMaxResponse>({
      url: joinUrl(this.config.baseUrl, path),
      json: body,
      signal: req.signal,
      retry: false,
    });
    const code = json?.base_resp?.status_code ?? 0;
    if (code !== 0) throw miniMaxError(code, json?.base_resp?.status_msg, this.config.id);
    const hex = json?.data?.audio;
    if (!hex) throw new ProviderError('parse', 'MiniMax returned no audio', { providerId: this.config.id });
    let data: Uint8Array;
    try {
      data = hexToBytes(hex);
    } catch {
      throw new ProviderError('parse', 'MiniMax returned audio that is not hex', {
        providerId: this.config.id,
      });
    }
    const durationSeconds = json?.extra_info?.music_duration
      ? json.extra_info.music_duration / 1000
      : undefined;
    const model = String(body.model);
    const res: AudioGenerationResult = {
      audio: {
        mimeType: audioMimeType(this.format, 'audio/mpeg'),
        data,
        ...(json?.extra_info?.music_sample_rate ? { sampleRate: json.extra_info.music_sample_rate } : {}),
        ...(durationSeconds ? { durationSeconds } : {}),
      },
      model,
    };
    if (durationSeconds) res.durationSeconds = durationSeconds;
    const cost = audioCostUsd(pricingFor(this.config), model, durationSeconds ?? req.durationSeconds);
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }

  async transformAudio(_req: AudioTransformRequest): Promise<AudioGenerationResult> {
    void _req;
    throw notSupported(this.config.id, 'Audio-to-audio');
  }
}

export function createMiniMaxMusicProvider(
  config: ProviderConfig,
  deps: CreateProviderDeps,
): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, MINIMAX_MUSIC_CAPABILITIES),
    config,
    audioGeneration: new MiniMaxMusicProvider(config, http),
  };
}

// ---------------------------------------------------------------------------
// Mureka
// ---------------------------------------------------------------------------

export const MUREKA_CAPABILITIES: Capability[] = [
  'TEXT_TO_MUSIC',
  'LYRIC_CONDITIONING',
  'VOCAL_GENERATION',
  'INSTRUMENTAL_ONLY',
  'SECTION_GENERATION',
];
export const MUREKA_DEFAULT_MODEL = 'auto';
const MUREKA_LYRICS_MAX = 5000;
const MUREKA_PROMPT_MAX = 1000;

interface MurekaTask {
  id?: string;
  status?: string;
  failed_reason?: string;
  model?: string;
  choices?: { url?: string; flac_url?: string; wav_url?: string; duration?: number; index?: number }[];
}

const MUREKA_FAILED = new Set(['failed', 'timeouted', 'timeout', 'cancelled', 'canceled', 'deleted']);

export class MurekaProvider implements AudioGenerationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
    private readonly clock?: Clock,
  ) {}

  async discoverModels(): Promise<ModelInfo[]> {
    const caps = this.config.capabilities?.length ? this.config.capabilities : MUREKA_CAPABILITIES;
    const manual = (this.config.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      capabilities: m.capabilities ?? [...caps],
      manual: true,
    }));
    if (manual.length) return manual;
    return [{ id: MUREKA_DEFAULT_MODEL, name: 'Mureka (latest)', capabilities: [...caps] }];
  }

  async getCapabilities(): Promise<Capability[]> {
    return [...(this.config.capabilities?.length ? this.config.capabilities : MUREKA_CAPABILITIES)];
  }

  async generateMusic(req: MusicGenerationRequest): Promise<AudioGenerationResult> {
    const model = req.model ?? this.config.defaultModel ?? MUREKA_DEFAULT_MODEL;
    const lyrics = req.instrumental ? '' : taggedLyrics(req, MUREKA_LYRICS_MAX);
    const kind = lyrics ? 'song' : 'instrumental';
    const body: Record<string, unknown> = { model, prompt: stylePrompt(req, MUREKA_PROMPT_MAX) };
    if (lyrics) body.lyrics = lyrics;
    if (req.samples && req.samples > 1) body.n = Math.min(3, Math.round(req.samples));
    const created = await this.http.json<MurekaTask>({
      url: joinUrl(this.config.baseUrl, `v1/${kind}/generate`),
      json: body,
      signal: req.signal,
      retry: false,
    });
    if (!created?.id)
      throw new ProviderError('parse', 'Mureka returned no task id', { providerId: this.config.id });
    const done = await pollUntil(
      async () => {
        const t = await this.http.json<MurekaTask>({
          url: joinUrl(this.config.baseUrl, `v1/${kind}/query/${encodeURIComponent(created.id!)}`),
          method: 'GET',
          signal: req.signal,
        });
        const status = (t?.status ?? '').toLowerCase();
        if (MUREKA_FAILED.has(status))
          throw new ProviderError(
            'unavailable',
            `Mureka ${kind} generation ${status}${t?.failed_reason ? `: ${t.failed_reason}` : ''}`,
            {
              providerId: this.config.id,
            },
          );
        return status === 'succeeded' || status === 'completed' ? t! : undefined;
      },
      {
        clock: this.clock,
        intervalMs: (this.config.extra?.pollIntervalMs as number | undefined) ?? 5000,
        timeoutMs: this.config.timeoutMs,
        signal: req.signal,
        providerId: this.config.id,
        what: `Mureka ${kind} task ${created.id}`,
      },
    );
    const choices = (done.choices ?? []).filter((c) => c.url || c.flac_url || c.wav_url);
    if (!choices.length)
      throw new ProviderError('parse', 'Mureka finished without audio', { providerId: this.config.id });
    const fetchChoice = async (c: (typeof choices)[number]) => {
      const url =
        (this.config.extra?.outputFormat === 'flac' && c.flac_url) || c.url || c.flac_url || c.wav_url!;
      const audio = await downloadResult(this.http, url, req.signal, urlExtension(url) ?? 'mp3');
      if (c.duration) audio.durationSeconds = c.duration / 1000;
      return audio;
    };
    const audio = await fetchChoice(choices[0]);
    const res: AudioGenerationResult = { audio, model: done.model ?? model, jobId: created.id };
    if (choices.length > 1) res.alternatives = await Promise.all(choices.slice(1).map(fetchChoice));
    if (audio.durationSeconds) res.durationSeconds = audio.durationSeconds;
    const cost = audioCostUsd(
      pricingFor(this.config),
      model,
      audio.durationSeconds ?? req.durationSeconds,
      1,
    );
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }

  async transformAudio(_req: AudioTransformRequest): Promise<AudioGenerationResult> {
    void _req;
    throw notSupported(this.config.id, 'Audio-to-audio');
  }
}

export function createMurekaProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, MUREKA_CAPABILITIES),
    config,
    audioGeneration: new MurekaProvider(config, http, deps.clock),
  };
}
