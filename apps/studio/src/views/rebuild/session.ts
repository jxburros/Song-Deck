import { create } from 'zustand';
import type { RebuildSource } from './openProject';

/**
 * Rebuild session state lives outside the view so a long rebuild keeps its file, task and
 * result while the user visits other modes (the task itself runs in the generation queue).
 */
interface RebuildSession {
  source: RebuildSource | null;
  title: string;
  keepStems: boolean;
  /** Separation provider choice: 'auto' | 'internal' | provider id. */
  separationProvider: string;
  taskId: string | null;
  runId: string | null;
  stemsTaskId: string | null;
  opened: { projectId: string; name: string } | null;
  set(patch: Partial<Omit<RebuildSession, 'set'>>): void;
}

export const useRebuildSession = create<RebuildSession>((set) => ({
  source: null,
  title: '',
  keepStems: true,
  separationProvider: 'auto',
  taskId: null,
  runId: null,
  stemsTaskId: null,
  opened: null,
  set: (patch) => set(patch),
}));
