import { create } from 'zustand';
import type { KeySignature } from '@songdeck/core';
import type { Capture, TranscribeOptions, TranscriptionView } from './model';

export type InputTab = 'record' | 'upload' | 'tap' | 'clap';

export interface RunContext {
  source: TranscribeOptions['source'];
  requestedBpm?: number;
  bpmSource: TranscriptionView['bpmSource'];
  requestedKey?: KeySignature;
  gridBeats: number;
  durationSeconds: number;
  meter: { numerator: number; denominator: number };
}

/** Transcribe session — the capture and its task survive switching modes. */
interface TranscribeSession {
  options: TranscribeOptions | null;
  inputTab: InputTab;
  capture: Capture | null;
  taskId: string | null;
  runCtx: RunContext | null;
  tapView: TranscriptionView | null;
  tapSound: string;
  set(patch: Partial<Omit<TranscribeSession, 'set'>>): void;
}

export const useTranscribeSession = create<TranscribeSession>((set) => ({
  options: null,
  inputTab: 'record',
  capture: null,
  taskId: null,
  runCtx: null,
  tapView: null,
  tapSound: 'clap',
  set: (patch) => set(patch),
}));
