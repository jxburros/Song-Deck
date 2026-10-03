import {
  CapabilityRouter,
  createInternalProvider,
  LLM_BASE_CAPABILITIES,
  ProviderRegistry,
  type AudioGenerationProvider,
  type Capability,
  type CompositionProvider,
  type LLMRequest,
  type ModelInfo,
  type PricingInfo,
  type ProviderInstance,
  type ProviderLocation,
  type RoutingSettings,
} from '../src';
import { FAKE_WAV, FakeLLM } from './helpers';

/** A valid reply for whichever canonical schema was requested. */
export function defaultReply(req: LLMRequest): string {
  switch (req.schemaName) {
    case 'chat_answer':
      return '{"answer":"ok","suggestions":[],"operations":[],"confidence":0.9}';
    case 'music_explanation':
      return '{"explanation":"ok","harmony":[],"suggestions":[],"confidence":0.9}';
    case 'music_analysis':
      return '{"summary":"ok","observations":[],"confidence":0.9}';
    case 'lyrics':
      return '{"sections":[],"confidence":0.9}';
    default:
      return '{"explanation":"ok","confidence":0.9,"operations":[]}';
  }
}

export function llmProvider(
  id: string,
  location: ProviderLocation,
  opts: { caps?: Capability[]; tier?: number; pricing?: PricingInfo; presetId?: string; models?: ModelInfo[]; replies?: (string | ((req: LLMRequest) => string))[]; name?: string } = {},
): ProviderInstance & { fake: FakeLLM } {
  const fake = new FakeLLM(opts.replies ?? [defaultReply], opts.models ?? []);
  return {
    descriptor: {
      id,
      name: opts.name ?? id,
      adapter: location === 'cloud' ? 'openai-compatible' : 'ollama',
      location,
      capabilities: opts.caps ?? [...LLM_BASE_CAPABILITIES, 'STRUCTURED_JSON'],
      qualityTier: opts.tier ?? 3,
      ...(opts.pricing ? { pricing: opts.pricing } : {}),
      ...(opts.presetId ? { presetId: opts.presetId } : {}),
    },
    llm: fake,
    fake,
  };
}

export function musicProvider(id: string, location: ProviderLocation, caps: Capability[], opts: { tier?: number; pricing?: PricingInfo; presetId?: string; fail?: Error } = {}): ProviderInstance & { calls: number } {
  const state = { calls: 0 };
  const gen: AudioGenerationProvider = {
    discoverModels: async () => [],
    getCapabilities: async () => caps,
    generateMusic: async (req) => {
      state.calls++;
      if (opts.fail) throw opts.fail;
      return { audio: { mimeType: 'audio/wav', data: FAKE_WAV }, durationSeconds: req.durationSeconds, seed: req.seed, model: `${id}-model` };
    },
    transformAudio: async () => ({ audio: { mimeType: 'audio/wav', data: FAKE_WAV } }),
  };
  const inst = {
    descriptor: { id, name: id, adapter: location === 'cloud' ? 'elevenlabs-music' : 'local-music', location, capabilities: caps, qualityTier: opts.tier ?? 3, ...(opts.pricing ? { pricing: opts.pricing } : {}), ...(opts.presetId ? { presetId: opts.presetId } : {}) },
    audioGeneration: gen,
  } as ProviderInstance;
  return Object.defineProperty(inst, 'calls', { get: () => state.calls }) as ProviderInstance & { calls: number };
}

export function internalProvider(composition?: Partial<CompositionProvider>): ProviderInstance {
  const comp: CompositionProvider = {
    planSong: async () => ({ plan: { key: { tonic: 0, mode: 'major' }, tempo: 120, meter: { numerator: 4, denominator: 4 }, sections: [] }, confidence: 1 }),
    designBlueprint: async () => {
      throw new Error('not implemented');
    },
    modifyComposition: async () => ({ operations: [], explanation: 'internal', errors: [], confidence: 0.5 }),
    analyzeMusic: async () => ({ summary: 'internal', observations: [] }),
    explainMusic: async () => ({ explanation: 'internal', harmony: [], suggestions: [] }),
    generateLyrics: async () => ({ sections: [] }),
    chat: async () => ({ answer: 'internal', suggestions: [], operations: [], errors: [] }),
    mixAssist: async () => ({ operations: [], explanation: 'internal', errors: [] }),
    ...composition,
  };
  return createInternalProvider({
    capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING', 'MIDI_EDITING', 'MIDI_GENERATION', 'LYRIC_GENERATION', 'MIXING', 'AUDIO_TRANSCRIPTION', 'SOURCE_SEPARATION', 'MASTERING'],
    composition: comp,
    transcription: { transcribeNotes: async () => ({ notes: [], confidence: 0.6 }) },
    separation: { separateStems: async () => ({ stems: {} }) },
    mastering: { master: async (req) => ({ audio: req.audio }) },
  });
}

export const PRICING_ANTHROPIC: PricingInfo = { models: { 'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 } }, inputPerMTok: 4, outputPerMTok: 20 };
export const PRICING_GEMINI: PricingInfo = { inputPerMTok: 1.25, outputPerMTok: 10 };
export const PRICING_ELEVEN: PricingInfo = { perMinuteUsd: 0.5 };

export interface World {
  registry: ProviderRegistry;
  router: CapabilityRouter;
  settings: RoutingSettings;
  ollama: ReturnType<typeof llmProvider>;
  gemini: ReturnType<typeof llmProvider>;
  anthropic: ReturnType<typeof llmProvider>;
  eleven: ReturnType<typeof musicProvider>;
  ace: ReturnType<typeof musicProvider>;
}

export function makeWorld(settings: Partial<RoutingSettings> = {}): World {
  const registry = new ProviderRegistry();
  const s: RoutingSettings = {
    mode: 'automatic',
    rules: [],
    offline: false,
    neverUpload: [],
    priorities: { quality: 0.5, cost: 0.3, latency: 0.2 },
    privacyConfirm: 'never',
    ...settings,
  };
  const ollama = llmProvider('ollama', 'local', { tier: 2, presetId: 'ollama', name: 'Ollama' });
  const gemini = llmProvider('gemini', 'cloud', { tier: 5, presetId: 'gemini', name: 'Google Gemini', pricing: PRICING_GEMINI, caps: [...LLM_BASE_CAPABILITIES, 'STRUCTURED_JSON', 'AUDIO_INPUT', 'AUDIO_UNDERSTANDING'] });
  const anthropic = llmProvider('anthropic', 'cloud', { tier: 5, presetId: 'anthropic', name: 'Anthropic', pricing: PRICING_ANTHROPIC });
  const eleven = musicProvider('elevenlabs-music', 'cloud', ['TEXT_TO_MUSIC', 'LYRIC_CONDITIONING', 'VOCAL_GENERATION', 'SECTION_GENERATION', 'INSTRUMENTAL_ONLY'], { tier: 5, pricing: PRICING_ELEVEN, presetId: 'elevenlabs-music' });
  const ace = musicProvider('ace-step-local', 'local', ['TEXT_TO_MUSIC', 'LYRIC_CONDITIONING', 'VOCAL_GENERATION', 'INSTRUMENTAL_ONLY', 'AUDIO_TO_AUDIO'], { tier: 3, presetId: 'ace-step-local' });
  registry.register(internalProvider());
  registry.register(ollama);
  registry.register(gemini);
  registry.register(anthropic);
  registry.register(eleven);
  registry.register(ace);
  const router = new CapabilityRouter(registry, { settings: () => s });
  return { registry, router, settings: s, ollama, gemini, anthropic, eleven, ace };
}
