import {
  ENGINE_VERSION,
  assetPathFor,
  randomId,
  type AssetKind,
  type AudioAssetMeta,
  type Project,
  type ProvenanceRecord,
  type ProvenanceSource,
  type Song,
  type StemGroup,
} from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import type { EncodedAudio, RunProvenance } from '@songdeck/ai';
import { useStudio } from '../state/store';
import { assetStore } from '../state/assets';
import { recordProvenance } from './ai';
import { encodeWavBytes } from './produce-jobs';
import { GUIDE_STEM_FILES, GUIDE_MIX_FILE, headRevisionOf } from './produce-model';

/**
 * Production artifacts: WAV assets inside the project package (spec §9) with a provenance record
 * each (spec §64), plus small helpers shared by the production task handlers.
 */

export function abortError(message = 'Cancelled'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function requireProject(projectId: string): Project {
  const project = useStudio.getState().project;
  if (!project || project.meta.id !== projectId)
    throw new Error('The project for this task is not open. Open it and retry the task.');
  return project;
}

export function headRevisionNumber(project: Project): number | undefined {
  return headRevisionOf(project)?.number;
}

export function revisionNumber(project: Project, revisionId: string | undefined): number | undefined {
  return revisionId ? project.history.revisions.find((r) => r.id === revisionId)?.number : undefined;
}

export function assetMeta(
  project: Project | null | undefined,
  id: string | undefined,
): AudioAssetMeta | undefined {
  return id && project ? project.meta.assets.find((a) => a.id === id) : undefined;
}

export function provenanceOfAsset(
  project: Project | null | undefined,
  id: string | undefined,
): ProvenanceRecord | undefined {
  if (!project || !id) return undefined;
  const meta = assetMeta(project, id);
  return (
    (meta?.provenanceId ? project.meta.provenance.find((p) => p.id === meta.provenanceId) : undefined) ??
    project.meta.provenance.find((p) => p.artifactId === id)
  );
}

/** Decoded audio of a project asset (throws when the bytes are missing). */
export async function loadAssetAudio(projectId: string, assetId: string): Promise<AudioData> {
  const project = requireProject(projectId);
  const meta = assetMeta(project, assetId);
  if (!meta) throw new Error(`Audio asset ${assetId} is missing from the project`);
  const audio = await assetStore.audio(meta);
  if (!audio) throw new Error(`The audio of “${meta.name}” could not be loaded`);
  return audio;
}

export function audioSeconds(a: AudioData | null | undefined): number {
  return a ? (a.channels[0]?.length ?? 0) / a.sampleRate : 0;
}

/** A package path for `fileName` that no other asset uses (packages store one file per path). */
export function uniqueAssetPath(
  project: Project,
  kind: AssetKind,
  fileName: string,
  exceptId?: string,
): string {
  const taken = new Set(project.meta.assets.filter((a) => a.id !== exceptId).map((a) => a.path));
  let path = assetPathFor(kind, fileName);
  if (!taken.has(path)) return path;
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    path = assetPathFor(kind, `${stem} (${i})${ext}`);
    if (!taken.has(path)) return path;
  }
  return assetPathFor(kind, `${stem}-${randomId('v')}${ext}`);
}

export async function wavOf(
  audio: AudioData,
  bitDepth: 16 | 24 | 32 = 16,
  signal?: AbortSignal,
): Promise<EncodedAudio> {
  const data = await encodeWavBytes(audio, bitDepth, { signal });
  return {
    mimeType: 'audio/wav',
    data,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    durationSeconds: audioSeconds(audio),
  };
}

export type ProvenanceSpec = {
  sources: ProvenanceSource[];
  seed?: number;
  parameters?: Record<string, unknown>;
  artifactKind?: ProvenanceRecord['artifactKind'];
} & (
  | { run: RunProvenance; costUsd?: number }
  | { providerId: string; providerName: string; modelId?: string; cloud?: boolean; costUsd?: number }
);

export interface StoreAudioOptions {
  projectId: string;
  audio: AudioData;
  /** File (and display) name, e.g. "guide_mix.wav". */
  fileName: string;
  kind: AssetKind;
  bitDepth: 16 | 24 | 32;
  provenance: ProvenanceSpec;
  signal?: AbortSignal;
}

/** Encode → asset (unique package path) → provenance record linked from the asset. */
export async function storeAudio(o: StoreAudioOptions): Promise<AudioAssetMeta> {
  const bytes = await encodeWavBytes(o.audio, o.bitDepth, { signal: o.signal });
  throwIfAborted(o.signal);
  const project = requireProject(o.projectId);
  const now = new Date().toISOString();
  const assetId = randomId('asset');
  const provenanceId = randomId('prov');
  const meta: AudioAssetMeta = {
    id: assetId,
    name: o.fileName,
    kind: o.kind,
    path: uniqueAssetPath(project, o.kind, o.fileName),
    mimeType: 'audio/wav',
    sampleRate: o.audio.sampleRate,
    channels: o.audio.channels.length,
    durationSeconds: audioSeconds(o.audio),
    bytes: bytes.length,
    createdAt: now,
    provenanceId,
  };
  await useStudio.getState().addAsset(meta, bytes);
  const p = o.provenance;
  const artifactKind = p.artifactKind ?? 'audio';
  if ('run' in p) {
    recordProvenance(p.run, {
      id: provenanceId,
      artifactId: assetId,
      artifactName: o.fileName,
      artifactKind,
      sources: p.sources,
      seed: p.seed,
      parameters: p.parameters,
      engineVersion: ENGINE_VERSION,
    });
  } else {
    const rec: ProvenanceRecord = {
      id: provenanceId,
      artifactId: assetId,
      artifactName: o.fileName,
      artifactKind,
      sources: p.sources,
      providerId: p.providerId,
      providerName: p.providerName,
      generatedAt: now,
      cloud: !!p.cloud,
      engineVersion: ENGINE_VERSION,
    };
    if (p.modelId) rec.modelId = p.modelId;
    if (p.seed !== undefined) rec.seed = p.seed;
    if (p.parameters) rec.parameters = p.parameters;
    if (p.costUsd !== undefined) rec.costUsd = p.costUsd;
    useStudio.getState().addProvenance(rec);
  }
  return meta;
}

/** Commit a change to `song.production` on top of the LATEST working copy (tasks run concurrently). */
export function commitProduction(
  projectId: string,
  change: (production: Song['production'], song: Song) => Song['production'],
  message: string,
): void {
  const st = useStudio.getState();
  const cur = st.project;
  if (!cur || cur.meta.id !== projectId) throw new Error('The project was closed during production.');
  st.commit({ ...cur.song, production: change(cur.song.production, cur.song) }, message, 'production');
}

/**
 * The canonical guide files (guide_mix.wav, drums_reference.wav …) always belong to the current
 * guide: earlier renders at those paths are renamed "… (v12).wav" (bytes and ids unchanged, so
 * candidates and old revisions that reference them keep working).
 */
export function supersedeGuidePaths(projectId: string, keepIds: Set<string>): void {
  const st = useStudio.getState();
  const project = requireProject(projectId);
  const canonical = new Set(
    [GUIDE_MIX_FILE, ...Object.values(GUIDE_STEM_FILES).map((f) => f.file)].map((f) =>
      assetPathFor('guide-render', f),
    ),
  );
  const stale = project.meta.assets.filter(
    (a) => a.kind === 'guide-render' && canonical.has(a.path) && !keepIds.has(a.id),
  );
  if (!stale.length) return;
  st.updateProject((p) => {
    let assets = p.meta.assets;
    for (const old of stale) {
      const prov = provenanceOfAsset(p, old.id);
      const rev = prov?.sources.find((s) => s.kind === 'song')?.revision;
      const dot = old.name.lastIndexOf('.');
      const name = `${dot > 0 ? old.name.slice(0, dot) : old.name} (${rev ? `v${rev}` : old.createdAt.slice(0, 10)})${dot > 0 ? old.name.slice(dot) : ''}`;
      const path = uniqueAssetPath({ ...p, meta: { ...p.meta, assets } }, 'guide-render', name, old.id);
      assets = assets.map((a) => (a.id === old.id ? { ...a, name, path } : a));
    }
    return { ...p, meta: { ...p.meta, assets } };
  });
}

// ---------------------------------------------------------------------------
// Staged external renders (spec §28 "external DAW rendering"): decoded uploads waiting for the
// import task. Kept in memory only; a restarted import asks for the files again.
// ---------------------------------------------------------------------------

export interface StagedStem {
  fileName: string;
  group: StemGroup;
  audio: AudioData;
}

const staged = new Map<string, StagedStem[]>();

export function stageExternalStems(stems: StagedStem[]): string {
  const id = randomId('stage');
  staged.set(id, stems);
  return id;
}

export function stagedExternalStems(id: string): StagedStem[] | undefined {
  return staged.get(id);
}

export function releaseStagedStems(id: string): void {
  staged.delete(id);
}
