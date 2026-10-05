/**
 * ElevenLabs Music adapter (`https://api.elevenlabs.io/v1`, header `xi-api-key`).
 *
 * `POST /music?output_format=mp3_44100_128` with either `{ prompt, music_length_ms }` or
 * `{ composition_plan: { positive_global_styles, negative_global_styles, sections: [{ section_name,
 * positive_local_styles, negative_local_styles, duration_ms, lines }] } }` (+ optional `model_id`)
 * → audio bytes. `buildElevenLabsCompositionPlan(song)` turns the composition into a plan: one
 * section per song section, durations from the tempo map (summing exactly to the song length),
 * lyric lines per section, styles from genre/moods/instrumentation/production prompt.
 */
import {
  createTimeMap,
  keyAtTick,
  keyName,
  sectionLayout,
  songDurationSeconds,
  type Song,
} from '@songdeck/core';
import type { Capability } from '../capabilities';
import type { ProviderConfig } from '../config';
import { audioCostUsd } from '../cost';
import { energyDescriptor, sectionLyricLines, songStyleTags } from '../production';
import type { HttpClient } from '../transport/http';
import { ElevenLabsStemSeparation } from './cloud-stems';
import { ElevenLabsSpeechToText } from './lyrics';
import type {
  AudioGenerationProvider,
  AudioGenerationResult,
  AudioTransformRequest,
  GenerationSection,
  ModelInfo,
  MusicGenerationRequest,
  ProviderInstance,
} from '../types';
import { audioMimeType, clamp, joinUrl, round, uniq, withQuery } from '../util';
import {
  audioFromResponse,
  buildDescriptor,
  createHttpClient,
  type CreateProviderDeps,
  notSupported,
  pricingFor,
} from './common';

export interface ElevenLabsPlanSection {
  section_name: string;
  positive_local_styles: string[];
  negative_local_styles: string[];
  duration_ms: number;
  lines: string[];
}

export interface ElevenLabsCompositionPlan {
  positive_global_styles: string[];
  negative_global_styles: string[];
  sections: ElevenLabsPlanSection[];
}

export interface CompositionPlanOptions {
  /** Sections shorter than this are merged into a neighbour (default 3000 ms, the API minimum). */
  minSectionMs?: number;
  /** Sections longer than this are split (default 120000 ms, the API maximum). */
  maxSectionMs?: number;
  /** Extra positive global styles. */
  extraStyles?: string[];
  /** Extra negative global styles. */
  negativeStyles?: string[];
}

export const ELEVENLABS_MUSIC_CAPABILITIES: Capability[] = [
  'TEXT_TO_MUSIC',
  'LYRIC_CONDITIONING',
  'VOCAL_GENERATION',
  'SECTION_GENERATION',
  'INSTRUMENTAL_ONLY',
];
const MIN_SONG_MS = 10_000;
const MAX_SONG_MS = 300_000;

const pretty = (s: string) => s.replace(/[-_]+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function splitStyles(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergeSections(a: ElevenLabsPlanSection, b: ElevenLabsPlanSection): ElevenLabsPlanSection {
  return {
    section_name: clip(`${a.section_name} + ${b.section_name}`, 100),
    positive_local_styles: uniq([...a.positive_local_styles, ...b.positive_local_styles]),
    negative_local_styles: uniq([...a.negative_local_styles, ...b.negative_local_styles]).filter(
      (s) => !(s === 'vocals' && (a.lines.length || b.lines.length)),
    ),
    duration_ms: a.duration_ms + b.duration_ms,
    lines: [...a.lines, ...b.lines],
  };
}

/** Enforce per-section duration limits while preserving the total duration exactly. */
function normalizeDurations(
  sections: ElevenLabsPlanSection[],
  minMs: number,
  maxMs: number,
): ElevenLabsPlanSection[] {
  let out = [...sections];
  // Merge too-short sections into the following (or previous) one.
  let i = 0;
  while (i < out.length && out.length > 1) {
    if (out[i].duration_ms < minMs) {
      if (i + 1 < out.length) out.splice(i, 2, mergeSections(out[i], out[i + 1]));
      else out.splice(i - 1, 2, mergeSections(out[i - 1], out[i]));
      i = Math.max(0, i - 1);
      continue;
    }
    i++;
  }
  // Split too-long sections into equal parts (lines distributed in order).
  const split: ElevenLabsPlanSection[] = [];
  for (const s of out) {
    if (s.duration_ms <= maxMs) {
      split.push(s);
      continue;
    }
    const parts = Math.ceil(s.duration_ms / maxMs);
    let used = 0;
    let lineIdx = 0;
    for (let p = 0; p < parts; p++) {
      const dur = p === parts - 1 ? s.duration_ms - used : Math.floor(s.duration_ms / parts);
      used += dur;
      const take =
        p === parts - 1 ? s.lines.length - lineIdx : Math.round(((p + 1) * s.lines.length) / parts) - lineIdx;
      split.push({
        ...s,
        section_name: clip(`${s.section_name} (${p + 1}/${parts})`, 100),
        duration_ms: dur,
        lines: s.lines.slice(lineIdx, lineIdx + take),
      });
      lineIdx += take;
    }
  }
  out = split;
  return out;
}

/**
 * Build an ElevenLabs composition plan from a Song. Durations come from the tempo map; their sum
 * equals the song length in ms (rounded once, distributed by cumulative boundaries).
 */
export function buildElevenLabsCompositionPlan(
  song: Song,
  opts: CompositionPlanOptions = {},
): ElevenLabsCompositionPlan {
  const tm = createTimeMap(song);
  const layout = sectionLayout(song);
  const tags = songStyleTags(song);
  const instrumental = tags.vocals.includes('instrumental');
  const positive = uniq([
    ...tags.genres,
    ...tags.moods,
    ...tags.instruments,
    ...tags.vocals,
    ...tags.production,
    `${round(tm.bpmAt(0), 1)} bpm`,
    keyName(keyAtTick(song, 0)),
    ...(opts.extraStyles ?? []),
  ]).map((s) => clip(s, 100));
  const negative = uniq([
    ...splitStyles(song.production.negativePrompt),
    ...(instrumental ? ['vocals'] : []),
    ...(opts.negativeStyles ?? []),
  ]).map((s) => clip(s, 100));

  const totalMs = Math.round(songDurationSeconds(song) * 1000);
  const boundaries = layout.map((s) => Math.round(tm.tickToSeconds(s.startTick) * 1000));
  boundaries.push(totalMs);
  const sections: ElevenLabsPlanSection[] = layout.map((span, i) => {
    const s = span.section;
    const lines = instrumental ? [] : sectionLyricLines(song, s.id).map((l) => clip(l, 200));
    const local = [pretty(s.kind)];
    if (s.purpose) local.push(s.purpose);
    local.push(energyDescriptor(s.energyEnd !== undefined ? (s.energy + s.energyEnd) / 2 : s.energy));
    if (s.feel && s.feel !== 'normal') local.push(pretty(s.feel));
    local.push(...(s.mood ?? []));
    local.push(...splitStyles(song.production.sectionPrompts[s.id]));
    return {
      section_name: clip(s.name || pretty(s.kind), 100),
      positive_local_styles: uniq(local).map((x) => clip(x, 100)),
      negative_local_styles: !instrumental && lines.length === 0 ? ['vocals'] : [],
      duration_ms: boundaries[i + 1] - boundaries[i],
      lines,
    };
  });
  return {
    positive_global_styles: positive,
    negative_global_styles: negative,
    sections: normalizeDurations(
      sections.filter((s, i) => s.duration_ms > 0 || i === sections.length - 1),
      opts.minSectionMs ?? 3000,
      opts.maxSectionMs ?? 120_000,
    ),
  };
}

/** Composition plan from generic generation sections (when no Song is supplied). */
export function compositionPlanFromSections(
  req: MusicGenerationRequest,
): ElevenLabsCompositionPlan | undefined {
  const sections = req.sections ?? [];
  if (!sections.length) return undefined;
  const totalMs = Math.round(req.durationSeconds * 1000);
  const plan = sections.map((s: GenerationSection, i) => {
    const start = Math.round(s.startSeconds * 1000);
    const end = i === sections.length - 1 ? totalMs : Math.round(sections[i + 1].startSeconds * 1000);
    return {
      section_name: clip(s.name, 100),
      positive_local_styles: uniq([
        pretty(s.kind ?? s.name),
        ...(s.energy !== undefined ? [energyDescriptor(s.energy)] : []),
        ...splitStyles(s.prompt),
      ]),
      negative_local_styles: splitStyles(s.negativePrompt),
      duration_ms: Math.max(0, end - start),
      lines: req.instrumental ? [] : (s.lines ?? []).map((l) => clip(l, 200)),
    };
  });
  return {
    positive_global_styles: splitStyles(req.prompt),
    negative_global_styles: uniq([
      ...splitStyles(req.negativePrompt),
      ...(req.instrumental ? ['vocals'] : []),
    ]),
    sections: normalizeDurations(plan, 3000, 120_000),
  };
}

export class ElevenLabsMusicProvider implements AudioGenerationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  async discoverModels(): Promise<ModelInfo[]> {
    const caps = this.config.capabilities?.length ? this.config.capabilities : ELEVENLABS_MUSIC_CAPABILITIES;
    const manual = (this.config.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      capabilities: m.capabilities ?? [...caps],
      manual: true,
    }));
    if (manual.length) return manual;
    return [{ id: this.config.defaultModel ?? 'music_v1', name: 'Eleven Music', capabilities: [...caps] }];
  }

  async getCapabilities(): Promise<Capability[]> {
    return [...(this.config.capabilities?.length ? this.config.capabilities : ELEVENLABS_MUSIC_CAPABILITIES)];
  }

  /** Request body for a generation (exported for tests). */
  buildBody(req: MusicGenerationRequest): Record<string, unknown> {
    const model = req.model ?? this.config.defaultModel;
    const planFromExtra = req.extra?.compositionPlan as ElevenLabsCompositionPlan | undefined;
    const plan =
      planFromExtra ??
      (req.song ? buildElevenLabsCompositionPlan(req.song) : compositionPlanFromSections(req));
    const body: Record<string, unknown> = {};
    if (plan) body.composition_plan = plan;
    else {
      body.prompt = req.lyrics && !req.instrumental ? `${req.prompt}\n\nLyrics:\n${req.lyrics}` : req.prompt;
      body.music_length_ms = Math.round(clamp(req.durationSeconds * 1000, MIN_SONG_MS, MAX_SONG_MS));
      if (req.instrumental) body.force_instrumental = true;
    }
    if (model) body.model_id = model;
    return body;
  }

  async generateMusic(req: MusicGenerationRequest): Promise<AudioGenerationResult> {
    const outputFormat =
      (req.extra?.outputFormat as string | undefined) ??
      this.config.extra?.outputFormat ??
      (req.outputFormat === 'wav' ? 'pcm_44100' : 'mp3_44100_128');
    const url = withQuery(joinUrl(this.config.baseUrl, 'music'), { output_format: outputFormat });
    const body = this.buildBody(req);
    const r = await this.http.bytes({ url, json: body, accept: 'audio/*', signal: req.signal });
    const plan = body.composition_plan as ElevenLabsCompositionPlan | undefined;
    const durationSeconds = plan
      ? plan.sections.reduce((a, s) => a + s.duration_ms, 0) / 1000
      : (body.music_length_ms as number) / 1000;
    const res: AudioGenerationResult = {
      audio: audioFromResponse(r.data, r.contentType, outputFormat),
      durationSeconds,
    };
    if (!res.audio.mimeType.startsWith('audio/')) res.audio.mimeType = audioMimeType(outputFormat);
    const model = (body.model_id as string | undefined) ?? undefined;
    if (model) res.model = model;
    const cost = audioCostUsd(pricingFor(this.config), model, durationSeconds);
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }

  async transformAudio(_req: AudioTransformRequest): Promise<AudioGenerationResult> {
    throw notSupported(this.config.id, 'Audio-to-audio');
  }
}

export function createElevenLabsProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  const descriptor = buildDescriptor(config, ELEVENLABS_MUSIC_CAPABILITIES);
  const instance: ProviderInstance = {
    descriptor,
    config,
    audioGeneration: new ElevenLabsMusicProvider(config, http),
  };
  // The same key reaches Scribe (speech-to-text) for lyrics.
  if (descriptor.capabilities.includes('LYRIC_TRANSCRIPTION'))
    instance.lyricTranscription = new ElevenLabsSpeechToText(config, http);
  // …and stem separation (two or six stems).
  if (descriptor.capabilities.includes('SOURCE_SEPARATION'))
    instance.separation = new ElevenLabsStemSeparation(config, http);
  return instance;
}
