import type { SampleInstrument } from '@songdeck/audio';
import type { AudioData } from '@songdeck/audio';
import type { ProvenanceSource, Song, StemGroup, TaskHandler } from '@songdeck/core';
import { useSettings } from '../../state/settings';
import { ProgressMix, collectAssets, renderableSong } from '../mix-render';
import { accumulate, conformAudio, masterSum, producePool, renderProduction } from '../produce-jobs';
import {
  GUIDE_MIX_FILE,
  GUIDE_RENDERERS,
  GUIDE_RENDERER_ID,
  GUIDE_STEM_FILES,
  STEM_GROUP_ORDER,
  audibleSourceTracks,
  compositionHash,
  formatSeconds,
  guideHash,
  productionSourceSong,
  type GuideRenderer,
} from '../produce-model';
import {
  audioSeconds,
  commitProduction,
  headRevisionNumber,
  releaseStagedStems,
  requireProject,
  stagedExternalStems,
  storeAudio,
  supersedeGuidePaths,
  throwIfAborted,
  type StagedStem,
} from '../produce-assets';
import { sampleRenderOptions } from '../produce-samples';

/**
 * Guide rendering tasks (spec §28, §63): "Before generative audio production, MIDI should be
 * rendered into a reference track." Output: guide_mix.wav plus one reference per stem group
 * (drums_reference.wav, bass_reference.wav, guitar_reference.wav, keys_reference.wav,
 * strings_reference.wav, vocal_melody_reference.wav …) as `guide-render` assets with provenance,
 * recorded in song.production.guideMixAssetId / guideStemAssetIds by a new revision.
 *
 *  - `produce.guide`        built-in instrument library or user sample instruments (resumable per file)
 *  - `produce.guideImport`  stems rendered in an external DAW, mapped to stem groups
 */

export interface GuideInput {
  projectId: string;
  renderer: Extract<GuideRenderer, 'builtin' | 'sampled'>;
  sampleRate?: number;
  bitDepth?: 16 | 24 | 32;
  /** Vocal melody reference voiced by the built-in singer (default) or a clean melody tone. */
  vocalTone?: 'singer' | 'melody';
  /** trackId → sample instrument id (renderer 'sampled'). */
  assignments?: Record<string, string>;
}

export interface GuideOutput {
  mixAssetId: string;
  stemAssetIds: Record<string, string>;
  summary: string;
}

interface GuideCheckpoint {
  hash: string;
  /** 'mix' | stem group → asset id */
  assets: Record<string, string>;
}

/** Run async jobs with at most `limit` in flight; the first error is rethrown after all settle. */
export async function runLimited(jobs: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const lane = async () => {
    while (next < jobs.length && !failure) {
      const i = next++;
      try {
        await jobs[i]();
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, lane));
  if (failure) throw failure;
}

function trackSources(song: Song, trackIds: string[], revision: number | undefined): ProvenanceSource[] {
  return trackIds.map((id) => {
    const t = song.tracks.find((x) => x.id === id);
    return { kind: t?.kind === 'audio' ? 'audio' : 'midi', ref: t ? `${t.name} (${t.id})` : id, revision };
  });
}

const renderGuide: TaskHandler<GuideInput, GuideOutput> = async (ctx) => {
  const { input, signal } = ctx;
  const project = requireProject(input.projectId);
  const song = project.song;
  const source = renderableSong(productionSourceSong(song));
  const tracks = audibleSourceTracks(source);
  if (!tracks.length) throw new Error('Nothing to render — the song has no audible tracks.');
  const hash = guideHash(song);
  const composition = compositionHash(song);
  const prefs = useSettings.getState().exportPrefs;
  const sampleRate = input.sampleRate ?? prefs.sampleRate;
  const bitDepth = input.bitDepth ?? 16;
  const renderer: GuideRenderer = input.renderer === 'sampled' ? 'sampled' : 'builtin';
  const prev = ctx.previousCheckpoint as GuideCheckpoint | undefined;
  const done: Record<string, string> =
    prev?.hash === hash ? Object.fromEntries(Object.entries(prev.assets).filter(([, id]) => project.meta.assets.some((a) => a.id === id))) : {};
  if (Object.keys(done).length) ctx.log('info', `Resuming: ${Object.keys(done).length} file(s) were rendered by the previous attempt`);

  const groups = STEM_GROUP_ORDER.map((group) => ({ group, tracks: tracks.filter((t) => (t.stemGroup || 'others') === group) })).filter((g) => g.tracks.length);

  const patchOverrides: Record<string, string> = {};
  let sampleInstruments: Record<string, SampleInstrument> = {};
  let usedSamples: { trackId: string; name: string }[] = [];
  if (renderer === 'sampled') {
    const o = sampleRenderOptions(input.assignments ?? {}, tracks.map((t) => t.id));
    Object.assign(patchOverrides, o.patchOverrides);
    sampleInstruments = o.sampleInstruments;
    usedSamples = o.used;
    if (o.missing.length) ctx.log('warn', `${o.missing.length} assigned sample instrument(s) are no longer loaded — those tracks use built-in instruments`);
    if (!o.used.length) ctx.log('warn', 'No sample instruments are assigned — every track uses the built-in instrument library');
    for (const u of o.used) ctx.log('info', `${source.tracks.find((t) => t.id === u.trackId)?.name ?? u.trackId}: sample instrument “${u.name}”`);
  }
  if (input.vocalTone === 'melody') {
    for (const t of tracks) if (t.kind === 'midi' && t.role === 'vocal' && !patchOverrides[t.id]) patchOverrides[t.id] = 'flute';
  }

  ctx.progress(0.02, 'Collecting audio clips');
  const assets = await collectAssets(source);
  throwIfAborted(signal);
  supersedeGuidePaths(input.projectId, new Set(Object.values(done)));
  const revision = headRevisionNumber(project);

  const jobs = [
    { key: 'mix', fileName: GUIDE_MIX_FILE, trackIds: tracks.map((t) => t.id), applyMaster: true, label: 'guide mix' },
    ...groups.map((g) => ({ key: g.group as string, fileName: GUIDE_STEM_FILES[g.group].file, trackIds: g.tracks.map((t) => t.id), applyMaster: false, label: GUIDE_STEM_FILES[g.group].label.toLowerCase() })),
  ];
  ctx.log('info', `${GUIDE_RENDERERS[renderer].label}: ${GUIDE_MIX_FILE} + ${groups.length} reference stems at ${sampleRate} Hz / ${bitDepth}-bit`);
  const progress = new ProgressMix((p, m) => ctx.progress(0.04 + p * 0.93, m));
  const parts = jobs.map((j) => progress.part(j.key, j.key === 'mix' ? 1.4 : 1, `Rendering ${j.label}`));
  const results: Record<string, string> = { ...done };

  await runLimited(
    jobs.map((j, i) => async () => {
      if (results[j.key]) {
        progress.done(j.key);
        return;
      }
      const audio = await renderProduction(
        { song: source, assets, sampleRate, trackIds: j.trackIds, applyMaster: j.applyMaster, ignoreMuteSolo: true, tailSeconds: 2, patchOverrides, sampleInstruments },
        { signal, onProgress: parts[i] },
      );
      throwIfAborted(signal);
      const meta = await storeAudio({
        projectId: input.projectId,
        audio,
        fileName: j.fileName,
        kind: 'guide-render',
        bitDepth,
        signal,
        provenance: {
          providerId: GUIDE_RENDERER_ID,
          providerName: GUIDE_RENDERERS[renderer].providerName,
          artifactKind: j.key === 'mix' ? 'mix' : 'audio',
          sources: [{ kind: 'song', ref: song.id, revision }, ...trackSources(source, j.trackIds, revision)],
          parameters: {
            renderer,
            stemGroup: j.key === 'mix' ? undefined : j.key,
            trackIds: j.trackIds,
            sampleRate,
            bitDepth,
            vocalTone: input.vocalTone ?? 'singer',
            sampleInstruments: usedSamples.filter((u) => j.trackIds.includes(u.trackId)).map((u) => u.name),
            guideHash: hash,
            compositionHash: composition,
            master: j.applyMaster,
          },
        },
      });
      results[j.key] = meta.id;
      ctx.checkpoint({ hash, assets: { ...results } } satisfies GuideCheckpoint);
      ctx.log('info', `${j.fileName}: ${formatSeconds(audioSeconds(audio))}`);
      progress.done(j.key);
    }),
    producePool.size,
  );

  const stemAssetIds: Record<string, string> = Object.fromEntries(groups.map((g) => [g.group, results[g.group]]));
  commitProduction(
    input.projectId,
    (prod) => ({ ...prod, guideMixAssetId: results.mix, guideStemAssetIds: stemAssetIds }),
    `Rendered guide (${GUIDE_RENDERERS[renderer].label.toLowerCase()}): ${GUIDE_MIX_FILE} + ${groups.length} reference stems`,
  );
  ctx.progress(1, 'Done');
  return { mixAssetId: results.mix, stemAssetIds, summary: `${GUIDE_MIX_FILE} + ${groups.map((g) => GUIDE_STEM_FILES[g.group].file).join(', ')}` };
};

export interface GuideImportInput {
  projectId: string;
  /** Staged decoded uploads (produce-assets.stageExternalStems). */
  stageId: string;
  sampleRate?: number;
  bitDepth?: 16 | 24 | 32;
}

const importGuide: TaskHandler<GuideImportInput, GuideOutput> = async (ctx) => {
  const { input, signal } = ctx;
  const project = requireProject(input.projectId);
  const stems = stagedExternalStems(input.stageId);
  if (!stems?.length) throw new Error('The imported files are no longer in memory (the app was reloaded). Import the rendered stems again.');
  const song = project.song;
  const source = renderableSong(productionSourceSong(song));
  const hash = guideHash(song);
  const composition = compositionHash(song);
  const prefs = useSettings.getState().exportPrefs;
  const sampleRate = input.sampleRate ?? prefs.sampleRate;
  const bitDepth = input.bitDepth ?? prefs.bitDepth;
  const revision = headRevisionNumber(project);
  const byGroup = new Map<StemGroup, StagedStem[]>();
  for (const s of stems) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  const groups = STEM_GROUP_ORDER.filter((g) => byGroup.has(g));
  supersedeGuidePaths(input.projectId, new Set());

  let sum: AudioData | null = null;
  const stemAssetIds: Record<string, string> = {};
  const stemSources: ProvenanceSource[] = [];
  let i = 0;
  for (const group of groups) {
    const files = byGroup.get(group)!;
    ctx.progress(0.05 + (0.75 * i) / groups.length, `Importing ${GUIDE_STEM_FILES[group].label.toLowerCase()}`);
    let groupAudio: AudioData | null = null;
    for (const f of files) groupAudio = accumulate(groupAudio, await conformAudio(f.audio, sampleRate, { signal }));
    throwIfAborted(signal);
    const meta = await storeAudio({
      projectId: input.projectId,
      audio: groupAudio!,
      fileName: GUIDE_STEM_FILES[group].file,
      kind: 'guide-render',
      bitDepth,
      signal,
      provenance: {
        providerId: 'external-daw',
        providerName: GUIDE_RENDERERS.external.providerName,
        sources: [{ kind: 'song', ref: song.id, revision }, ...files.map((f) => ({ kind: 'file', ref: f.fileName }))],
        parameters: { renderer: 'external', stemGroup: group, files: files.map((f) => f.fileName), sampleRate, bitDepth, guideHash: hash, compositionHash: composition },
      },
    });
    stemAssetIds[group] = meta.id;
    stemSources.push({ kind: 'audio', ref: meta.id });
    sum = accumulate(sum, groupAudio!);
    ctx.log('info', `${GUIDE_STEM_FILES[group].file} ← ${files.map((f) => f.fileName).join(' + ')}`);
    i++;
  }
  ctx.progress(0.82, 'Mixing the imported stems through the master bus');
  const mix = await masterSum({ song: source, audio: sum!, sampleRate, applyMaster: true }, { signal });
  throwIfAborted(signal);
  const mixMeta = await storeAudio({
    projectId: input.projectId,
    audio: mix,
    fileName: GUIDE_MIX_FILE,
    kind: 'guide-render',
    bitDepth,
    signal,
    provenance: {
      providerId: 'external-daw',
      providerName: GUIDE_RENDERERS.external.providerName,
      artifactKind: 'mix',
      sources: [{ kind: 'song', ref: song.id, revision }, ...stemSources],
      parameters: { renderer: 'external', sampleRate, bitDepth, guideHash: hash, compositionHash: composition, master: true },
    },
  });
  commitProduction(
    input.projectId,
    (prod) => ({ ...prod, guideMixAssetId: mixMeta.id, guideStemAssetIds: stemAssetIds }),
    `Imported externally rendered guide: ${GUIDE_MIX_FILE} + ${groups.length} reference stems`,
  );
  releaseStagedStems(input.stageId);
  ctx.progress(1, 'Done');
  return { mixAssetId: mixMeta.id, stemAssetIds, summary: `${groups.length} stems imported` };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = {
  'produce.guide': renderGuide,
  'produce.guideImport': importGuide,
};
