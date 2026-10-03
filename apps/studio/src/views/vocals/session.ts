import { create } from 'zustand';
import { randomSeed, type LyricAlignmentEntry } from '@songdeck/core';
import type { VocalTab } from '../../engine/vocal-model';

/** Vocals mode session — survives switching modes (tasks keep running in the queue). */

export interface AlignmentView {
  at: string;
  mode: 'assign' | 'fit-rhythm';
  report: LyricAlignmentEntry[];
  warnings: string[];
  issues: string[];
  applied: boolean;
}

export interface LyricsRun {
  source: string;
  placeholder: boolean;
  notes?: string;
  sections: number;
  lines: number;
}

export interface InstructionResult {
  text: string;
  explanation: string;
  understood: boolean;
  proposalId?: string;
  error?: string;
}

export interface RecordingPrefs {
  countInBars: number;
  latencyMs: number;
  startSectionId: string | null;
  stopAtSectionEnd: boolean;
  guide: boolean;
  deviceId: string;
}

interface VocalSession {
  tab: VocalTab;
  trackId: string | null;
  lyricsProvider: string;
  lyricsTheme: string;
  lyricsScope: 'empty' | 'all';
  lastLyrics: LyricsRun | null;
  autoAlign: boolean;
  alignment: AlignmentView | null;
  singerProvider: string;
  renderSeed: number;
  phraseId: string | null;
  instruction: string;
  lastInstruction: InstructionResult | null;
  conversionProvider: string;
  conversionTarget: string | null;
  pitchShift: number;
  conversionBlocked: string | null;
  conversionError: string | null;
  recording: RecordingPrefs;
  tasks: { render?: string; convert?: string; transcribe?: string; resing?: string[] };
  set(patch: Partial<Omit<VocalSession, 'set'>>): void;
}

export const useVocalSession = create<VocalSession>((set) => ({
  tab: 'lyrics',
  trackId: null,
  lyricsProvider: 'auto',
  lyricsTheme: '',
  lyricsScope: 'empty',
  lastLyrics: null,
  autoAlign: true,
  alignment: null,
  singerProvider: 'auto',
  renderSeed: randomSeed(),
  phraseId: null,
  instruction: '',
  lastInstruction: null,
  conversionProvider: 'auto',
  conversionTarget: null,
  pitchShift: 0,
  conversionBlocked: null,
  conversionError: null,
  recording: { countInBars: 1, latencyMs: 20, startSectionId: null, stopAtSectionEnd: true, guide: true, deviceId: '' },
  tasks: {},
  set: (patch) => set(patch),
}));
