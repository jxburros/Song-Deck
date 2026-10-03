import { MASTERING_PRESETS, type LoudnessReport } from '@songdeck/audio';
import type { AudioAssetMeta, MasteringSettings, MasteringTarget, Project, ProvenanceRecord, Song } from '@songdeck/core';
import { mixHash } from './mix-render';

/**
 * Mastering targets & helpers shared by the Mix & Master and Export modes (spec §42).
 * Numbers come from the audio engine's MASTERING_PRESETS; the descriptions are UI copy.
 */

export interface TargetInfo {
  id: MasteringTarget;
  label: string;
  description: string;
  lufs: number;
  truePeakDb: number;
}

const COPY: Record<MasteringTarget, { label: string; description: string; lufs: number; truePeakDb: number }> = {
  streaming: { label: 'Streaming', description: 'Spotify, Apple Music, YouTube normalization', lufs: -14, truePeakDb: -1 },
  cd: { label: 'CD', description: 'Competitive full-scale CD master', lufs: -9, truePeakDb: -0.3 },
  'loud-rock': { label: 'Loud rock', description: 'Dense, aggressive, maximized', lufs: -8, truePeakDb: -0.5 },
  dynamic: { label: 'Dynamic', description: 'Preserves transients and dynamic range', lufs: -18, truePeakDb: -1 },
  podcast: { label: 'Podcast', description: 'Speech-friendly broadcast loudness', lufs: -16, truePeakDb: -1 },
  demo: { label: 'Demo', description: 'Quick, safe level for sharing drafts', lufs: -12, truePeakDb: -1 },
};

export const TARGET_ORDER: MasteringTarget[] = ['streaming', 'cd', 'loud-rock', 'dynamic', 'podcast', 'demo'];

/** Target LUFS / true-peak ceiling for a profile (from the audio engine's MASTERING_PRESETS). */
export function targetInfo(target: MasteringTarget): TargetInfo {
  const p = MASTERING_PRESETS[target];
  const base = COPY[target] ?? COPY.streaming;
  return {
    id: target,
    label: p?.name ?? base.label,
    description: base.description,
    lufs: p?.targetLufs ?? base.lufs,
    truePeakDb: p?.truePeakDb ?? base.truePeakDb,
  };
}

export function allTargets(): TargetInfo[] {
  return TARGET_ORDER.map(targetInfo);
}

export const METHOD_LABELS: Record<MasteringSettings['method'], string> = {
  builtin: 'Built-in DSP',
  'local-ai': 'Local AI',
  cloud: 'Cloud',
  external: 'External provider',
  none: 'None (user export)',
};

export const BUILTIN_MASTERING = { id: 'internal-mastering', name: 'Built-in DSP mastering' } as const;

export function fmtLufs(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v) || v <= -120) return '−∞';
  return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
}

export function fmtSignedDb(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v) || v <= -120) return '−∞';
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return `0.${'0'.repeat(digits)}`.replace(/\.$/, '');
  return `${v < 0 ? '−' : '+'}${s}`;
}

export function loudnessSummary(r: LoudnessReport): string {
  return `${fmtLufs(r.integratedLufs)} LUFS · ${fmtLufs(r.truePeakDb)} dBTP · LRA ${r.lra.toFixed(1)} LU`;
}

/** The current master asset of the song, with the provenance that produced it. */
export function currentMaster(project: Project | null, song: Song | null): { meta: AudioAssetMeta; provenance?: ProvenanceRecord; stale: boolean; report?: LoudnessReport } | null {
  if (!project || !song) return null;
  const id = song.mastering.lastMasterAssetId;
  if (!id) return null;
  const meta = project.meta.assets.find((a) => a.id === id);
  if (!meta) return null;
  const provenance = project.meta.provenance.find((p) => p.artifactId === id);
  const params = (provenance?.parameters ?? {}) as Record<string, unknown>;
  const stale = typeof params.mixHash === 'string' ? params.mixHash !== mixHash(song) : false;
  const report = (params.loudnessAfter ?? undefined) as LoudnessReport | undefined;
  return { meta, provenance, stale, report };
}

/** Latest persisted loudness analysis of the unmastered mix (and whether it matches the current mix). */
export function latestMixAnalysis(project: Project | null, song: Song | null): { report: LoudnessReport; hash: string; createdAt: string; current: boolean } | null {
  if (!project || !song) return null;
  const recs = project.analysis.filter((a) => a.kind === 'loudness' && (a.data as { scope?: string } | null)?.scope === 'mix');
  const last = recs[recs.length - 1];
  if (!last) return null;
  const data = last.data as { hash: string; report: LoudnessReport };
  return { report: data.report, hash: data.hash, createdAt: last.createdAt, current: data.hash === mixHash(song) };
}
