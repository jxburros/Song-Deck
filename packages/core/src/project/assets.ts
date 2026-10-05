import type {
  AnalysisRecord,
  AssetKind,
  AudioAssetMeta,
  GenerationRecord,
  Project,
  ProvenanceRecord,
  RightsMetadata,
} from '../ir/types';

/** Folder of each asset kind inside a .songproject package (spec §9 layout). */
export const ASSET_FOLDERS: Record<AssetKind, string> = {
  reference: 'audio/references',
  'guide-render': 'audio/guide-renders',
  generation: 'audio/generations',
  vocal: 'audio/vocals',
  master: 'audio/masters',
  stem: 'stems',
  recording: 'audio/recordings',
  import: 'audio/imports',
  analysis: 'analysis/files',
  'plugin-render': 'audio/plugin-renders',
  'plugin-state': 'plugins/states',
};

/** Safe file name: no directories, control characters or reserved characters. */
export function sanitizeAssetFileName(name: string, fallback = 'asset'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || fallback).slice(0, 120);
}

/** Package path for an asset, e.g. assetPathFor('guide-render', 'guide_mix.wav') → "audio/guide-renders/guide_mix.wav". */
export function assetPathFor(kind: AssetKind, fileName: string): string {
  return `${ASSET_FOLDERS[kind] ?? 'audio/other'}/${sanitizeAssetFileName(fileName)}`;
}

/** A package-relative path that cannot escape the package root ("" when unusable). */
export function safePackagePath(path: string): string {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.map((p) => sanitizeAssetFileName(p, '_')).join('/');
}

function touch(project: Project, now?: string): Project['meta'] {
  return { ...project.meta, updatedAt: now ?? new Date().toISOString() };
}

function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const out = list.slice();
  out[i] = item;
  return out;
}

/** Register (or replace) an audio asset's metadata. Bytes live in the caller's asset store. */
export function addAsset(project: Project, meta: AudioAssetMeta, now?: string): Project {
  const path = safePackagePath(meta.path) || assetPathFor(meta.kind, meta.name || meta.id);
  return {
    ...project,
    meta: { ...touch(project, now), assets: upsert(project.meta.assets, { ...meta, path }) },
  };
}

export function removeAsset(project: Project, assetId: string, now?: string): Project {
  if (!project.meta.assets.some((a) => a.id === assetId)) return project;
  return {
    ...project,
    meta: { ...touch(project, now), assets: project.meta.assets.filter((a) => a.id !== assetId) },
  };
}

/** Record how an artifact was created (spec §64). */
export function addProvenance(project: Project, record: ProvenanceRecord, now?: string): Project {
  return {
    ...project,
    meta: { ...touch(project, now), provenance: upsert(project.meta.provenance, record) },
  };
}

/** Provenance records for an artifact (asset id, revision id, …). */
export function provenanceFor(project: Project, artifactId: string): ProvenanceRecord[] {
  return project.meta.provenance.filter((p) => p.artifactId === artifactId);
}

/** Note that a provider produced something for this project (informational; projects never depend on providers). */
export function recordProviderUse(
  project: Project,
  providerId: string,
  providerName: string,
  at?: string,
): Project {
  const when = at ?? new Date().toISOString();
  const list = project.meta.providersUsed.filter((p) => p.providerId !== providerId);
  list.push({ providerId, providerName, lastUsedAt: when });
  list.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return { ...project, meta: { ...touch(project, when), providersUsed: list } };
}

export function addAnalysisRecord(project: Project, record: AnalysisRecord, now?: string): Project {
  return { ...project, meta: touch(project, now), analysis: upsert(project.analysis, record) };
}

export function addGenerationRecord(project: Project, record: GenerationRecord, now?: string): Project {
  return { ...project, meta: touch(project, now), generations: upsert(project.generations, record) };
}

/** Update rights & attribution metadata (spec §65). */
export function updateRights(project: Project, rights: Partial<RightsMetadata>, now?: string): Project {
  return { ...project, meta: { ...touch(project, now), rights: { ...project.meta.rights, ...rights } } };
}
