/**
 * Provider profiles (spec §6). Assignments reference provider ids OR preset ids (resolved against
 * the registry), 'internal' (the deterministic on-device engine) or 'disabled'. When an assigned
 * provider is not installed, routing falls back to the internal engine where it can do the task.
 */
import type { TaskRole } from './types';

export type RoleAssignment = { providerId: string; modelId?: string } | 'internal' | 'disabled';

export interface ProviderProfile {
  id: string;
  name: string;
  description: string;
  assignments: Partial<Record<TaskRole, RoleAssignment>>;
  builtIn?: boolean;
}

export const BUILTIN_PROFILES: ProviderProfile[] = [
  {
    id: 'cloud-quality',
    name: 'Cloud Quality',
    description: 'Best cloud models: OpenAI for composition, Gemini for music analysis, the managed service for production and vocals.',
    builtIn: true,
    assignments: {
      composition: { providerId: 'openai' },
      harmony: { providerId: 'openai' },
      'midi-editing': { providerId: 'openai' },
      lyrics: { providerId: 'openai' },
      chat: { providerId: 'openai' },
      analysis: { providerId: 'gemini' },
      production: { providerId: 'managed' },
      vocals: { providerId: 'managed' },
      transcription: 'internal',
      separation: 'internal',
      'voice-conversion': 'disabled',
      mixing: 'internal',
      mastering: 'internal',
    },
  },
  {
    id: 'local-only',
    name: 'Local Only',
    description: 'Nothing leaves this machine: local Llama for composition, the deterministic engine for MIDI, local transcription, DiffSinger vocals and a local music model.',
    builtIn: true,
    assignments: {
      composition: { providerId: 'ollama' },
      harmony: { providerId: 'ollama' },
      lyrics: { providerId: 'ollama' },
      chat: { providerId: 'ollama' },
      'midi-editing': 'internal',
      analysis: 'internal',
      transcription: { providerId: 'basic-pitch-local' },
      separation: { providerId: 'demucs-local' },
      vocals: { providerId: 'diffsinger-local' },
      production: { providerId: 'ace-step-local' },
      'voice-conversion': { providerId: 'rvc-local' },
      mixing: 'internal',
      mastering: 'internal',
    },
  },
  {
    id: 'cheap-draft',
    name: 'Cheap Draft',
    description: 'Inexpensive cloud model for composition, local generator for production, vocals disabled.',
    builtIn: true,
    assignments: {
      composition: { providerId: 'groq' },
      harmony: { providerId: 'groq' },
      'midi-editing': { providerId: 'groq' },
      lyrics: { providerId: 'groq' },
      chat: { providerId: 'groq' },
      analysis: 'internal',
      production: { providerId: 'ace-step-local' },
      vocals: 'disabled',
      'voice-conversion': 'disabled',
      transcription: 'internal',
      separation: 'internal',
      mixing: 'internal',
      mastering: 'internal',
    },
  },
  {
    id: 'final-production',
    name: 'Final Production',
    description: 'High-reasoning model for composition, premium cloud generator for production, a high-quality singing synthesizer for vocals.',
    builtIn: true,
    assignments: {
      composition: { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
      harmony: { providerId: 'anthropic' },
      'midi-editing': { providerId: 'anthropic' },
      lyrics: { providerId: 'anthropic' },
      chat: { providerId: 'anthropic' },
      analysis: { providerId: 'gemini' },
      production: { providerId: 'elevenlabs-music' },
      vocals: { providerId: 'diffsinger-local' },
      'voice-conversion': { providerId: 'rvc-local' },
      transcription: { providerId: 'basic-pitch-local' },
      separation: { providerId: 'demucs-local' },
      mixing: 'internal',
      mastering: { providerId: 'mastering-local' },
    },
  },
];

export function getProfile(id: string | undefined, custom: readonly ProviderProfile[] = []): ProviderProfile | undefined {
  if (!id) return undefined;
  return custom.find((p) => p.id === id) ?? BUILTIN_PROFILES.find((p) => p.id === id);
}

export function describeAssignment(a: RoleAssignment | undefined): string {
  if (!a) return 'automatic';
  if (a === 'internal') return 'internal engine';
  if (a === 'disabled') return 'disabled';
  return a.modelId ? `${a.providerId} (${a.modelId})` : a.providerId;
}
