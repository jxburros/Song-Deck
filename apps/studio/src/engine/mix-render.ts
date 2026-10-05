import {
  pluginRenderIsCurrent,
  songDurationSeconds,
  stableStringify,
  type MasteringSettings,
  type Project,
  type Song,
  type Track,
} from '@songdeck/core';
import type { AudioData, LoudnessReport } from '@songdeck/audio';
import { jobs } from './jobs';
import { assetStore } from '../state/assets';
import { useStudio } from '../state/store';
import { songAudioAssetIds } from './clip-assets';

/**
 * Offline rendering helpers shared by Mix & Master and Export: asset collection for audio
 * tracks (stems, recordings, produced audio), abortable job calls with progress estimation,
 * loudness measurement, mastering, and a content hash used to detect stale masters.
 *
 * The renderer is the same deterministic engine used for playback (what you hear is what you export).
 */

export function abortError(message = 'Cancelled'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Race a job against an abort signal. Synchronous renders in a worker cannot be interrupted
 * mid-way, so cancellation resolves immediately here and the worker finishes in the background.
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Run `promise` while reporting an estimated progress curve (0 → 0.95, then 1 on completion)
 * for jobs that do not report progress themselves.
 */
export async function withEstimatedProgress<T>(
  promise: Promise<T>,
  estimateSeconds: number,
  onProgress?: (p: number) => void,
): Promise<T> {
  if (!onProgress) return promise;
  const t0 = performance.now();
  const tau = Math.max(0.4, estimateSeconds) * 0.6;
  onProgress(0);
  const timer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    onProgress(0.95 * (1 - Math.exp(-t / tau)));
  }, 400);
  try {
    const v = await promise;
    onProgress(1);
    return v;
  } finally {
    clearInterval(timer);
  }
}

/** Map a 0..1 sub-progress into [from, to] of an outer progress callback. */
export function subProgress(
  onProgress: ((p: number, msg?: string) => void) | undefined,
  from: number,
  to: number,
  msg?: string,
) {
  return (p: number) => onProgress?.(from + (to - from) * Math.max(0, Math.min(1, p)), msg);
}

// ---------------------------------------------------------------------------
// Songs prepared for offline rendering
// ---------------------------------------------------------------------------

/**
 * Solo is a monitoring control: offline renders (exports, analysis, mastering, stems) ignore it.
 * Mutes are honored — a muted track stays out of the mix.
 */
export function renderableSong(song: Song): Song {
  let changed = false;
  const channels = { ...song.mixer.channels };
  for (const [id, ch] of Object.entries(channels)) {
    if (ch.solo) {
      channels[id] = { ...ch, solo: false };
      changed = true;
    }
  }
  return changed ? { ...song, mixer: { ...song.mixer, channels } } : song;
}

export function isVocalTrack(t: Pick<Track, 'role' | 'stemGroup'>): boolean {
  return t.role === 'vocal' || t.stemGroup === 'vocals';
}

/** Tracks that actually produce sound (MIDI notes or audio clips) and are not muted. */
export function audibleTracks(song: Song): Track[] {
  return song.tracks.filter(
    (t) =>
      !song.mixer.channels[t.id]?.mute &&
      (t.kind === 'audio' ? t.clips.some((c) => !c.muted) : t.notes.length > 0),
  );
}

export function vocalTrackIds(song: Song): string[] {
  return song.tracks.filter(isVocalTrack).map((t) => t.id);
}

export function instrumentalTrackIds(song: Song): string[] {
  return song.tracks.filter((t) => !isVocalTrack(t)).map((t) => t.id);
}

/** Decoded audio for every clip of every audio track and every instrument-plugin render. */
export async function collectAssets(
  song: Song,
  project: Project | null = useStudio.getState().project,
): Promise<Record<string, AudioData>> {
  const out: Record<string, AudioData> = {};
  if (!project) return out;
  for (const assetId of songAudioAssetIds(song)) {
    if (out[assetId]) continue;
    const meta = project.meta.assets.find((a) => a.id === assetId);
    if (!meta) continue;
    const audio = await assetStore.audio(meta);
    if (audio) out[assetId] = audio;
  }
  return out;
}

/** Rough wall-clock estimate of an offline render (used only for progress display). */
export function estimateRenderSeconds(song: Song, trackCount = song.tracks.length): number {
  const dur = Math.max(1, songDurationSeconds(song));
  return 0.4 + dur * (0.012 + 0.006 * Math.max(1, trackCount));
}

// ---------------------------------------------------------------------------
// Renders (job worker)
// ---------------------------------------------------------------------------

export interface RenderOpts {
  sampleRate: number;
  /** Only these tracks (Instrumental / Acapella / single track). */
  trackIds?: string[];
  /** Run the master bus (EQ, glue compressor, limiter, width, volume). Default true. */
  applyMaster?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
  /** Pre-collected clip assets (saves decoding twice in multi-render exports). */
  assets?: Record<string, AudioData>;
}

export async function renderMixAudio(song: Song, opts: RenderOpts): Promise<AudioData> {
  throwIfAborted(opts.signal);
  const s = renderableSong(song);
  const assets = opts.assets ?? (await collectAssets(s));
  throwIfAborted(opts.signal);
  const job = jobs.call<AudioData>(
    'renderMix',
    {
      song: s,
      assets,
      sampleRate: opts.sampleRate,
      applyMaster: opts.applyMaster ?? true,
      trackIds: opts.trackIds,
    },
    { signal: opts.signal },
  );
  return withEstimatedProgress(
    abortable(job, opts.signal),
    estimateRenderSeconds(s, opts.trackIds?.length),
    opts.onProgress,
  );
}

export async function renderStemsAudio(
  song: Song,
  opts: Omit<RenderOpts, 'trackIds' | 'applyMaster'> & { by: 'stemGroup' | 'track' },
): Promise<Record<string, AudioData>> {
  throwIfAborted(opts.signal);
  const s = renderableSong(song);
  const assets = opts.assets ?? (await collectAssets(s));
  throwIfAborted(opts.signal);
  const job = jobs.call<Record<string, AudioData>>(
    'renderStems',
    { song: s, assets, sampleRate: opts.sampleRate, by: opts.by },
    { signal: opts.signal },
  );
  return withEstimatedProgress(abortable(job, opts.signal), estimateRenderSeconds(s) * 1.3, opts.onProgress);
}

export async function renderTrackAudio(
  song: Song,
  trackId: string,
  opts: Omit<RenderOpts, 'trackIds' | 'applyMaster'>,
): Promise<AudioData> {
  throwIfAborted(opts.signal);
  const s = renderableSong(song);
  const assets = opts.assets ?? (await collectAssets(s));
  const job = jobs.call<AudioData>(
    'renderTrack',
    { song: s, trackId, assets, sampleRate: opts.sampleRate },
    { signal: opts.signal },
  );
  return withEstimatedProgress(abortable(job, opts.signal), estimateRenderSeconds(s, 1), opts.onProgress);
}

/** EBU R128 / BS.1770 loudness (integrated, true peak, LRA, short-term max…). The input is copied. */
export async function measureAudioLoudness(audio: AudioData, signal?: AbortSignal): Promise<LoudnessReport> {
  return abortable(jobs.call<LoudnessReport>('loudness', audio, { signal }), signal);
}

/** Free-form mastering report from the DSP chain (gain, limiter reduction, before/after loudness…). */
export type MasterReport = Record<string, unknown>;

/** Built-in DSP mastering of a mix. The input is copied (kept for A/B). */
export async function masterAudioBuffer(
  audio: AudioData,
  settings: MasteringSettings,
  opts: { signal?: AbortSignal; onProgress?: (p: number) => void } = {},
): Promise<{ output: AudioData; report: MasterReport }> {
  const job = jobs.call<{ output: AudioData; report: MasterReport }>(
    'master',
    { audio, settings },
    { signal: opts.signal, onProgress: (p) => opts.onProgress?.(p) },
  );
  return abortable(job, opts.signal);
}

export function copyAudio(a: AudioData): AudioData {
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => c.slice()) };
}

export function audioSeconds(a: AudioData | null | undefined): number {
  return a ? (a.channels[0]?.length ?? 0) / a.sampleRate : 0;
}

// ---------------------------------------------------------------------------
// Mix content hash (stale-master detection)
// ---------------------------------------------------------------------------

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const hashCache = new WeakMap<Song, string>();

/**
 * Hash of everything that changes the rendered mix: notes, clips, mixer, automation, tempo, meter,
 * form. Songs are immutable snapshots, so the result is cached per song object.
 */
export function mixHash(song: Song): string {
  const cached = hashCache.get(song);
  if (cached) return cached;
  const h = computeMixHash(song);
  hashCache.set(song, h);
  return h;
}

function computeMixHash(song: Song): string {
  const s = renderableSong(song);
  return fnv1a(
    stableStringify({
      ppq: s.ppq,
      tempoMap: s.tempoMap,
      meterMap: s.meterMap,
      sections: s.sections.map((x) => x.bars),
      tracks: s.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        instrumentId: t.instrumentId,
        notes: t.notes,
        clips: t.clips,
        plugin: t.instrumentPlugin
          ? {
              render: pluginRenderIsCurrent(s, t) ? t.instrumentPlugin.render?.assetId : null,
              bypass: !!t.instrumentPlugin.bypass,
            }
          : undefined,
        stemGroup: t.stemGroup,
        macros: t.macros,
      })),
      mixer: s.mixer,
      automation: s.automation,
      macros: s.macros,
    }),
  );
}

// ---------------------------------------------------------------------------
// Progress composition
// ---------------------------------------------------------------------------

/** Combine weighted, possibly concurrent sub-steps into one task progress value. */
export class ProgressMix {
  private parts = new Map<string, { w: number; p: number }>();
  private label = '';

  constructor(private readonly report: (p: number, msg?: string) => void) {}

  part(name: string, weight: number, label?: string): (p: number) => void {
    this.parts.set(name, { w: weight, p: 0 });
    return (p: number) => {
      const e = this.parts.get(name);
      if (!e) return;
      e.p = Math.max(e.p, Math.min(1, Math.max(0, p)));
      if (label) this.label = label;
      this.emit();
    };
  }

  done(name: string): void {
    const e = this.parts.get(name);
    if (e) e.p = 1;
    this.emit();
  }

  setLabel(label: string): void {
    this.label = label;
    this.emit();
  }

  private emit(): void {
    let tw = 0;
    let acc = 0;
    for (const { w, p } of this.parts.values()) {
      tw += w;
      acc += w * p;
    }
    this.report(tw > 0 ? Math.min(0.995, acc / tw) : 0, this.label || undefined);
  }
}
