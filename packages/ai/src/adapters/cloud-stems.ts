/**
 * Cloud source separation (capability SOURCE_SEPARATION).
 *
 * - ElevenLabs (same key as ElevenLabs Music): `POST {base}/music/stem-separation?output_format=…`
 *   multipart `file`, `stem_variation_id` (`two_stems_v1` | `six_stems_v1`) → a ZIP archive with
 *   one audio file per stem. Stem names come from the file names inside the archive.
 * - AudioShake (`https://api.audioshake.ai`, `x-api-key`): `POST /assets` (multipart `file`) →
 *   `{ id }`; `POST /tasks` `{ assetId, targets: [{ model, formats: ['wav'] }] }` → `{ id }`; poll
 *   `GET /tasks/{id}` until every target is `completed` (or `error`) and download
 *   `targets[].output[].link` (signed, valid for an hour).
 * - LALAL.AI (`https://www.lalal.ai/api/v1`, `X-License-Key`): `POST /upload/` (raw body,
 *   `Content-Disposition: attachment; filename="…"`) → `{ id }`; one `POST /split/stem_separator/`
 *   `{ source_id, presets: { stem, extraction_level, splitter } }` per stem → `{ task_id }`; poll
 *   `POST /check/` `{ task_ids }` → `{ result: { <task_id>: { status: 'progress'|'success'|…,
 *   result: { tracks: [{ label, url }] } } } }` and download each stem track.
 *
 * Request shapes follow each provider's public reference/examples (LALAL.AI: its official examples
 * repository); responses are parsed tolerantly. Result downloads carry no credentials; through the
 * server proxy their hosts must be listed in `extra.downloadHosts`.
 */
import { unzipSync } from 'fflate';
import type { Capability } from '../capabilities';
import type { ProviderConfig } from '../config';
import { ProviderError } from '../errors';
import type { HttpClient } from '../transport/http';
import type { Clock } from '../transport/limiter';
import { encodeMultipart } from '../transport/multipart';
import type {
  EncodedAudio,
  ProviderInstance,
  SeparationProvider,
  SeparationRequest,
  SeparationResult,
} from '../types';
import { audioExtension, audioMimeType, joinUrl, withQuery } from '../util';
import {
  buildDescriptor,
  createHttpClient,
  type CreateProviderDeps,
  downloadResult,
  pollUntil,
  urlExtension,
} from './common';

export const CLOUD_STEM_CAPABILITIES: Capability[] = ['SOURCE_SEPARATION', 'VOCAL_ISOLATION', 'STEM_OUTPUT'];

const DEFAULT_STEMS = ['drums', 'bass', 'vocals', 'other'];

/** A stem name from a file name or label ("Vocals.mp3", "no_vocals", "drum") — Song Deck vocabulary. */
export function stemNameFrom(raw: string): string {
  const base = raw
    .split('/')
    .pop()!
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .toLowerCase();
  if (/(^|[^a-z])(no|without|minus)[_ -]?voc|instrumental|accompan|backing|karaoke/.test(base))
    return 'instrumental';
  if (/voc|voice|sing/.test(base)) return 'vocals';
  if (/drum|perc/.test(base)) return 'drums';
  if (/bass/.test(base)) return 'bass';
  if (/guitar/.test(base)) return 'guitar';
  if (/piano|keys/.test(base)) return 'piano';
  if (/string/.test(base)) return 'strings';
  if (/wind|brass/.test(base)) return 'wind';
  if (/synth/.test(base)) return 'synth';
  if (/other|rest|remain/.test(base)) return 'other';
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stem';
}

function uniqueName(stems: Record<string, EncodedAudio>, name: string): string {
  if (!stems[name]) return name;
  let i = 2;
  while (stems[`${name}-${i}`]) i++;
  return `${name}-${i}`;
}

// ---------------------------------------------------------------------------
// ElevenLabs stem separation
// ---------------------------------------------------------------------------

export class ElevenLabsStemSeparation implements SeparationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  /** two stems when only vocals / accompaniment are asked for, else six. */
  variation(stems: string[] | undefined): string {
    const want = (stems?.length ? stems : DEFAULT_STEMS).map((s) => s.toLowerCase());
    return want.every((s) => /voc|instrumental|other|accomp/.test(s)) ? 'two_stems_v1' : 'six_stems_v1';
  }

  async separateStems(req: SeparationRequest): Promise<SeparationResult> {
    const variation = this.variation(req.stems);
    const format = (this.config.extra?.stemOutputFormat as string | undefined) ?? 'mp3_44100_192';
    const mp = encodeMultipart([
      {
        name: 'file',
        data: req.audio.data,
        filename: `mix.${audioExtension(req.audio.mimeType)}`,
        contentType: req.audio.mimeType,
      },
      { name: 'stem_variation_id', value: variation },
    ]);
    const r = await this.http.bytes({
      url: withQuery(joinUrl(this.config.baseUrl, 'music/stem-separation'), { output_format: format }),
      body: mp.body,
      contentType: mp.contentType,
      accept: 'application/zip',
      signal: req.signal,
      retry: false,
    });
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(r.data);
    } catch {
      throw new ProviderError('parse', 'ElevenLabs stem separation did not return a ZIP archive', {
        providerId: this.config.id,
      });
    }
    const stems: Record<string, EncodedAudio> = {};
    for (const [path, data] of Object.entries(files)) {
      if (!data.length || path.endsWith('/') || /(^|\/)(\.|__MACOSX)/.test(path)) continue;
      const ext = urlExtension(`https://x/${path}`) ?? format.split('_')[0];
      stems[uniqueName(stems, stemNameFrom(path))] = { mimeType: audioMimeType(ext, 'audio/mpeg'), data };
    }
    if (!Object.keys(stems).length)
      throw new ProviderError('parse', 'The stem archive was empty', { providerId: this.config.id });
    return { stems, model: variation };
  }
}

// ---------------------------------------------------------------------------
// AudioShake
// ---------------------------------------------------------------------------

interface AudioShakeTask {
  id?: string;
  targets?: {
    model?: string;
    status?: string;
    error?: string;
    output?: { name?: string; format?: string; link?: string; url?: string }[];
  }[];
}

const AUDIOSHAKE_MODELS: Record<string, string> = {
  vocals: 'vocals',
  vocal: 'vocals',
  instrumental: 'instrumental',
  drums: 'drums',
  bass: 'bass',
  guitar: 'guitar',
  piano: 'piano',
  strings: 'strings',
  wind: 'wind',
  other: 'other',
};

export class AudioShakeSeparation implements SeparationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
    private readonly clock?: Clock,
  ) {}

  async separateStems(req: SeparationRequest): Promise<SeparationResult> {
    const models = [
      ...new Set(
        (req.stems?.length ? req.stems : DEFAULT_STEMS).map((s) => AUDIOSHAKE_MODELS[s.toLowerCase()] ?? s),
      ),
    ];
    const mp = encodeMultipart([
      {
        name: 'file',
        data: req.audio.data,
        filename: `mix.${audioExtension(req.audio.mimeType)}`,
        contentType: req.audio.mimeType,
      },
    ]);
    const asset = await this.http.json<{ id?: string }>({
      url: joinUrl(this.config.baseUrl, 'assets'),
      body: mp.body,
      contentType: mp.contentType,
      signal: req.signal,
      retry: false,
    });
    if (!asset?.id)
      throw new ProviderError('parse', 'AudioShake returned no asset id', { providerId: this.config.id });
    const task = await this.http.json<AudioShakeTask>({
      url: joinUrl(this.config.baseUrl, 'tasks'),
      json: { assetId: asset.id, targets: models.map((model) => ({ model, formats: ['wav'] })) },
      signal: req.signal,
      retry: false,
    });
    if (!task?.id)
      throw new ProviderError('parse', 'AudioShake returned no task id', { providerId: this.config.id });
    const done = await pollUntil(
      async () => {
        const t = await this.http.json<AudioShakeTask>({
          url: joinUrl(this.config.baseUrl, `tasks/${encodeURIComponent(task.id!)}`),
          method: 'GET',
          signal: req.signal,
        });
        const targets = t?.targets ?? [];
        const failed = targets.find((x) => /error|fail/i.test(x.status ?? ''));
        if (failed)
          throw new ProviderError(
            'unavailable',
            `AudioShake ${failed.model ?? 'stem'} failed${failed.error ? `: ${failed.error}` : ''}`,
            {
              providerId: this.config.id,
            },
          );
        return targets.length && targets.every((x) => /complete|success|done/i.test(x.status ?? ''))
          ? t!
          : undefined;
      },
      {
        clock: this.clock,
        intervalMs: (this.config.extra?.pollIntervalMs as number | undefined) ?? 5000,
        timeoutMs: this.config.timeoutMs,
        signal: req.signal,
        providerId: this.config.id,
        what: `AudioShake task ${task.id}`,
      },
    );
    const stems: Record<string, EncodedAudio> = {};
    for (const target of done.targets ?? []) {
      const out = (target.output ?? []).find((o) => (o.format ?? 'wav') === 'wav') ?? target.output?.[0];
      const link = out?.link ?? out?.url;
      if (!link) continue;
      const audio = await downloadResult(
        this.http,
        link,
        req.signal,
        out?.format ?? urlExtension(link) ?? 'wav',
      );
      stems[uniqueName(stems, stemNameFrom(target.model ?? out?.name ?? 'stem'))] = audio;
    }
    if (!Object.keys(stems).length)
      throw new ProviderError('parse', 'AudioShake finished without stem files', {
        providerId: this.config.id,
      });
    const res: SeparationResult = { stems, model: models.join('+') };
    return res;
  }
}

// ---------------------------------------------------------------------------
// LALAL.AI
// ---------------------------------------------------------------------------

const LALAL_STEMS: Record<string, string> = {
  vocals: 'vocals',
  vocal: 'vocals',
  drums: 'drum',
  drum: 'drum',
  bass: 'bass',
  piano: 'piano',
  guitar: 'guitar',
  'electric-guitar': 'electric_guitar',
  'acoustic-guitar': 'acoustic_guitar',
  synth: 'synthesizer',
  synthesizer: 'synthesizer',
  strings: 'strings',
  wind: 'wind',
};

interface LalalCheck {
  result?: Record<
    string,
    {
      status?: string;
      error?: string;
      progress?: number;
      result?: { tracks?: { label?: string; type?: string; url?: string }[] };
    }
  >;
}

export class LalalSeparation implements SeparationProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
    private readonly clock?: Clock,
  ) {}

  async separateStems(req: SeparationRequest): Promise<SeparationResult> {
    const wanted = (req.stems?.length ? req.stems : DEFAULT_STEMS).map((s) => s.toLowerCase());
    // LALAL.AI isolates one stem per task; "other" is what remains (the studio derives it).
    const stems = [...new Set(wanted.map((s) => LALAL_STEMS[s]).filter(Boolean))];
    if (!stems.length)
      throw new ProviderError('unsupported', `LALAL.AI cannot isolate ${wanted.join(', ')}`, {
        providerId: this.config.id,
      });
    const filename = `mix.${audioExtension(req.audio.mimeType)}`;
    const upload = await this.http.json<{ id?: string }>({
      url: joinUrl(this.config.baseUrl, 'upload/'),
      body: req.audio.data,
      contentType: req.audio.mimeType,
      headers: { 'content-disposition': `attachment; filename="${filename}"` },
      signal: req.signal,
      retry: false,
    });
    if (!upload?.id)
      throw new ProviderError('parse', 'LALAL.AI returned no source id', { providerId: this.config.id });
    const splitter =
      (this.config.extra?.splitter as string | undefined) ?? this.config.defaultModel ?? 'auto';
    const level = (this.config.extra?.extractionLevel as string | undefined) ?? 'deep_extraction';
    const taskIds = new Map<string, string>();
    for (const stem of stems) {
      const t = await this.http.json<{ task_id?: string }>({
        url: joinUrl(this.config.baseUrl, 'split/stem_separator/'),
        json: { source_id: upload.id, presets: { stem, extraction_level: level, splitter } },
        signal: req.signal,
        retry: false,
      });
      if (!t?.task_id)
        throw new ProviderError('parse', `LALAL.AI returned no task id for ${stem}`, {
          providerId: this.config.id,
        });
      taskIds.set(t.task_id, stem);
    }
    const done = await pollUntil(
      async () => {
        const c = await this.http.json<LalalCheck>({
          url: joinUrl(this.config.baseUrl, 'check/'),
          json: { task_ids: [...taskIds.keys()] },
          signal: req.signal,
        });
        const results = c?.result ?? {};
        for (const [id, stem] of taskIds) {
          const st = (results[id]?.status ?? '').toLowerCase();
          if (st === 'error' || st === 'cancelled' || st === 'failed')
            throw new ProviderError(
              'unavailable',
              `LALAL.AI ${stem} task ${st}${results[id]?.error ? `: ${results[id].error}` : ''}`,
              {
                providerId: this.config.id,
              },
            );
        }
        return [...taskIds.keys()].every((id) => results[id]?.status === 'success') ? results : undefined;
      },
      {
        clock: this.clock,
        intervalMs: (this.config.extra?.pollIntervalMs as number | undefined) ?? 5000,
        timeoutMs: this.config.timeoutMs,
        signal: req.signal,
        providerId: this.config.id,
        what: 'LALAL.AI separation',
      },
    );
    const out: Record<string, EncodedAudio> = {};
    for (const [id, stem] of taskIds) {
      const tracks = done[id]?.result?.tracks ?? [];
      // Each split returns the stem and its complement ("back"); keep the stem itself.
      const track =
        tracks.find((t) => /stem/i.test(t.type ?? '')) ??
        tracks.find((t) => stemNameFrom(t.label ?? '') === stemNameFrom(stem)) ??
        tracks[0];
      if (!track?.url) continue;
      out[uniqueName(out, stemNameFrom(stem))] = await downloadResult(
        this.http,
        track.url,
        req.signal,
        urlExtension(track.url) ?? 'wav',
      );
      if (stems.length === 1) {
        const back = tracks.find((t) => t !== track && t.url);
        if (back?.url)
          out[`no_${stemNameFrom(stem)}`] = await downloadResult(
            this.http,
            back.url,
            req.signal,
            urlExtension(back.url) ?? 'wav',
          );
      }
    }
    if (!Object.keys(out).length)
      throw new ProviderError('parse', 'LALAL.AI finished without stem files', {
        providerId: this.config.id,
      });
    return { stems: out, model: splitter };
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createAudioShakeProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, CLOUD_STEM_CAPABILITIES),
    config,
    separation: new AudioShakeSeparation(config, http, deps.clock),
  };
}

export function createLalalProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, CLOUD_STEM_CAPABILITIES),
    config,
    separation: new LalalSeparation(config, http, deps.clock),
  };
}
