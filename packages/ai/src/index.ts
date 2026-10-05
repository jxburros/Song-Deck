/**
 * @songdeck/ai — AI Orchestrator and Model Runtime (spec §3-§8, §30-§31, §45-§46, §49-§50, §58-§62).
 *
 * Core rule: no core feature depends permanently on one AI provider. Providers are selected by
 * CAPABILITY; users can bring their own keys, run local models, or go fully offline; the
 * deterministic internal engine (registered by the apps) is always a fallback.
 */

// Taxonomy & shared types
export * from './capabilities';
export * from './types';
export * from './roles';
export * from './errors';

// Configuration, presets, factory
export * from './config';
export * from './presets';
export * from './factory';
export * from './model-heuristics';

// Connecting services: key formats, validation probes, model → app use, local services
export * from './connect-keys';
export * from './connect-models';
export * from './connect-probe';
export * from './local-services';

// Transports & credentials
export * from './transport/direct';
export * from './transport/proxy';
export * from './transport/vault';
export * from './transport/encrypted-store';
export * from './transport/multipart';
export * from './transport/limiter';
export * from './transport/http';

// Registry, routing, profiles, privacy, cost, budgets, orchestration
export * from './registry';
export * from './router';
export * from './profiles';
export * from './privacy';
export * from './cost';
export * from './budget';
export * from './orchestrator';
export * from './managed-gateway';
export * from './consent';

// Musical context, structured output, prompts, composition
export * from './context';
export * from './schemas/canonical';
export * from './schemas/dialects';
export * from './schemas/validate';
export * from './schemas/extract';
export * from './operations-parse';
export * from './prompts/conventions';
export * from './prompts/templates';
export * from './composition';

// Production, hardware, local models, bridge contracts
export * from './production';
export * from './hardware';
export * from './catalog';
export * from './contracts';

// Adapters
export * from './adapters/openai-compatible';
export * from './adapters/anthropic';
export * from './adapters/gemini';
export * from './adapters/ollama';
export * from './adapters/custom-http';
export * from './adapters/elevenlabs';
export * from './adapters/stability';
export * from './adapters/lyria';
export * from './adapters/local-music';
export * from './adapters/singing-http';
export * from './adapters/transcription-http';
export * from './adapters/separation-http';
export * from './adapters/voice-conversion-http';
export * from './adapters/mastering-http';
export * from './adapters/managed';
export * from './adapters/acoustid';
export * from './adapters/lyrics';
export * from './adapters/cloud-music';
export * from './adapters/cloud-stems';
export * from './adapters/plugin-host';
export {
  audioFromJson,
  audioToJson,
  audioFromBase64,
  buildDescriptor,
  createHttpClient,
  mergeManualModels,
  type EncodedAudioJson,
} from './adapters/common';

// Utilities useful to apps
export {
  base64ToBytes,
  bytesToBase64,
  estimateTokens,
  getPath,
  utf8Decode,
  utf8Encode,
  audioMimeType,
  audioExtension,
} from './util';
