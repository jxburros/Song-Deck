/**
 * Provider factory: ProviderConfig (persisted, secret-free) → ProviderInstance.
 * LLM providers get `composition` auto-derived; voice conversion is always consent-guarded.
 */
import type { Capability } from './capabilities';
import { LLMCompositionProvider } from './composition';
import { assertNoSecrets, type ProviderConfig, validateProviderConfig } from './config';
import { withConsentGuard } from './consent';
import { ConfigurationError } from './errors';
import { createAnthropicProvider } from './adapters/anthropic';
import type { CreateProviderDeps } from './adapters/common';
import { createCustomHttpProvider } from './adapters/custom-http';
import { createElevenLabsProvider } from './adapters/elevenlabs';
import { createGeminiProvider } from './adapters/gemini';
import { createLocalMusicProvider } from './adapters/local-music';
import { createLyriaProvider } from './adapters/lyria';
import { createManagedProvider } from './adapters/managed';
import { createMasteringHttpProvider } from './adapters/mastering-http';
import { createOllamaProvider } from './adapters/ollama';
import { createOpenAICompatibleProvider } from './adapters/openai-compatible';
import { createSeparationHttpProvider } from './adapters/separation-http';
import { createSingingHttpProvider } from './adapters/singing-http';
import { createStabilityProvider } from './adapters/stability';
import { createTranscriptionHttpProvider } from './adapters/transcription-http';
import { createVoiceConversionHttpProvider } from './adapters/voice-conversion-http';
import type {
  AudioGenerationProvider,
  CompositionProvider,
  LLMProvider,
  MasteringProvider,
  PricingInfo,
  ProviderInstance,
  SeparationProvider,
  SingingProvider,
  TranscriptionProvider,
  VoiceConversionProvider,
} from './types';

export type { CreateProviderDeps } from './adapters/common';

const GUARDED = Symbol.for('songdeck.consentGuarded');

/** Derive composition from llm and wrap voice conversion with the consent guard (idempotent). */
export function finalizeInstance(instance: ProviderInstance): ProviderInstance {
  if (instance.llm && !instance.composition) {
    instance.composition = new LLMCompositionProvider(instance.llm, {
      providerId: instance.descriptor.id,
      model: instance.config?.defaultModel ?? instance.descriptor.defaultModel,
    });
  }
  if (
    instance.voiceConversion &&
    !(instance.voiceConversion as unknown as Record<symbol, boolean>)[GUARDED]
  ) {
    const guarded = withConsentGuard(instance.voiceConversion);
    (guarded as unknown as Record<symbol, boolean>)[GUARDED] = true;
    instance.voiceConversion = guarded;
  }
  return instance;
}

export function createProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  assertNoSecrets(config);
  const problems = validateProviderConfig(config);
  if (problems.length) throw new ConfigurationError(`Invalid provider config "${config.id}"`, problems);
  let instance: ProviderInstance;
  switch (config.adapter) {
    case 'openai-compatible':
      instance = createOpenAICompatibleProvider(config, deps);
      break;
    case 'anthropic':
      instance = createAnthropicProvider(config, deps);
      break;
    case 'gemini':
      instance = createGeminiProvider(config, deps);
      break;
    case 'ollama':
      instance = createOllamaProvider(config, deps);
      break;
    case 'custom-http':
      instance = createCustomHttpProvider(config, deps);
      break;
    case 'elevenlabs-music':
      instance = createElevenLabsProvider(config, deps);
      break;
    case 'stability-audio':
      instance = createStabilityProvider(config, deps);
      break;
    case 'google-lyria':
      instance = createLyriaProvider(config, deps);
      break;
    case 'local-music':
      instance = createLocalMusicProvider(config, deps);
      break;
    case 'singing-http':
      instance = createSingingHttpProvider(config, deps);
      break;
    case 'transcription-http':
      instance = createTranscriptionHttpProvider(config, deps);
      break;
    case 'separation-http':
      instance = createSeparationHttpProvider(config, deps);
      break;
    case 'voice-conversion-http':
      instance = createVoiceConversionHttpProvider(config, deps);
      break;
    case 'mastering-http':
      instance = createMasteringHttpProvider(config, deps);
      break;
    case 'managed':
      instance = createManagedProvider(config, deps);
      break;
    case 'internal':
      throw new ConfigurationError(
        'Internal providers are registered by the app (createInternalProvider), not configured',
      );
    default:
      throw new ConfigurationError(`Unknown adapter "${String((config as { adapter?: unknown }).adapter)}"`);
  }
  return finalizeInstance(instance);
}

export interface InternalProviderSpec {
  /** Default 'internal'. */
  id?: string;
  /** Default 'Song Deck engine'. */
  name?: string;
  capabilities: Capability[];
  /** Default 2 (deterministic engine: reliable but simpler than large models). */
  qualityTier?: number;
  description?: string;
  llm?: LLMProvider;
  composition?: CompositionProvider;
  audioGeneration?: AudioGenerationProvider;
  singing?: SingingProvider;
  transcription?: TranscriptionProvider;
  separation?: SeparationProvider;
  voiceConversion?: VoiceConversionProvider;
  mastering?: MasteringProvider;
}

const FREE: PricingInfo = {
  currency: 'USD',
  inputPerMTok: 0,
  outputPerMTok: 0,
  perGenerationUsd: 0,
  note: 'Runs on this device',
};

/**
 * An INTERNAL provider (location 'internal', zero cost, works offline) — apps implement the
 * provider interfaces with the deterministic engine (core composer/musician, audio DSP) and
 * register them so the orchestrator stays provider-agnostic (ARCHITECTURE §1).
 */
export function createInternalProvider(spec: InternalProviderSpec): ProviderInstance {
  const {
    id = 'internal',
    name = 'Song Deck engine',
    capabilities,
    qualityTier = 2,
    description,
    ...interfaces
  } = spec;
  return finalizeInstance({
    descriptor: {
      id,
      name,
      adapter: 'internal',
      location: 'internal',
      capabilities: [...capabilities],
      qualityTier,
      pricing: FREE,
      description: description ?? 'Deterministic on-device engine (offline, free).',
    },
    ...interfaces,
  });
}
