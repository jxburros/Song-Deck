import { create } from 'zustand';
import type { AudioData, LoudnessReport } from '@songdeck/audio';
import { useStudio } from '../state/store';

/**
 * In-memory audio kept for A/B listening in Mix & Master (spec §42): the latest unmastered mix
 * render and the latest master, keyed by the mix hash / master asset id so stale buffers are
 * never compared against a changed mix. Loudness reports themselves are persisted in the
 * project (analysis records & provenance); only the large buffers live here.
 */

export interface CachedMix {
  projectId: string;
  hash: string;
  audio: AudioData;
  report?: LoudnessReport;
}

export interface CachedMaster {
  projectId: string;
  assetId: string;
  hash: string;
  audio: AudioData;
  report?: LoudnessReport;
}

interface MixCacheState {
  mix: CachedMix | null;
  master: CachedMaster | null;
}

export const useMixCache = create<MixCacheState>(() => ({ mix: null, master: null }));

export function cacheMix(entry: CachedMix): void {
  useMixCache.setState({ mix: entry });
}

export function cacheMaster(entry: CachedMaster): void {
  useMixCache.setState({ master: entry });
}

export function clearMixCache(): void {
  useMixCache.setState({ mix: null, master: null });
}

// Free the (large) buffers as soon as another project is opened or the project is closed.
useStudio.subscribe((s, prev) => {
  if (s.project?.meta.id !== prev.project?.meta.id) clearMixCache();
});
