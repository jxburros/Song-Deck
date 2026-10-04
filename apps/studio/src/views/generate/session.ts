import { create } from 'zustand';
import { randomSeed, type AssetRequest } from '@songdeck/core';
import type { Alternative } from './AlternativeCard';

/** Generate MIDI session — survives switching modes (e.g. to review an insert proposal). */
interface GenerateSession {
  prompt: string;
  parsedPrompt: string | null;
  request: AssetRequest | null;
  seed: number;
  alternatives: Alternative[];
  note: string | null;
  set(patch: Partial<Omit<GenerateSession, 'set'>>): void;
}

const createSession = () =>
  create<GenerateSession>((set) => ({
    prompt: '',
    parsedPrompt: null,
    request: null,
    seed: randomSeed(),
    alternatives: [],
    note: null,
    set: (patch) => set(patch),
  }));

export const useGenerateSession = createSession();
export const useSingleGenerateSession = createSession();
