import { create } from 'zustand';
import { randomSeed } from '@songdeck/core';
import type { GuideRenderer } from '../../engine/produce-model';

/**
 * Produce-mode session state (survives switching modes; not part of the project). Everything that
 * belongs to the song — strategy, prompts, track methods, provider, candidates, guide assets — is
 * stored in `song.production` through revisions instead.
 */

export type ProduceTab = 'guide' | 'production' | 'candidates' | 'regenerate';

interface ProduceUiState {
  tab: ProduceTab;
  guideRenderer: GuideRenderer;
  vocalTone: 'singer' | 'melody';
  guideTaskId: string | null;
  candidateCount: number;
  baseSeed: number;
  variation: number;
  strength: number;
  levelMatch: boolean;
  singingChoice: string;
  /** Task ids of the last production batch. */
  batchTaskIds: string[];
  /** Comparison: active source key, loudness-matched playback. */
  compareActive: string | null;
  compareLevelMatch: boolean;
  regionCandidateId: string | null;
  startBar: number;
  endBar: number;
  regionScope: string;
  regionChoice: string | null;
  regionSeed: number;
  crossfadeMs: number;
  regionPrompt: string;
  regionTaskId: string | null;
  set(patch: Partial<Omit<ProduceUiState, 'set'>>): void;
}

export const useProduceUi = create<ProduceUiState>((set) => ({
  tab: 'guide',
  guideRenderer: 'builtin',
  vocalTone: 'singer',
  guideTaskId: null,
  candidateCount: 2,
  baseSeed: randomSeed(),
  variation: 0.35,
  strength: 0.5,
  levelMatch: true,
  singingChoice: 'internal',
  batchTaskIds: [],
  compareActive: null,
  compareLevelMatch: true,
  regionCandidateId: null,
  startBar: 1,
  endBar: 4,
  regionScope: 'all',
  regionChoice: null,
  regionSeed: randomSeed(),
  crossfadeMs: 30,
  regionPrompt: '',
  regionTaskId: null,
  set: (patch) => set(patch),
}));
