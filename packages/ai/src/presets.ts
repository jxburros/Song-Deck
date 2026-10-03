/**
 * Provider presets (spec §3, §4, §7, §30, §31): defaults for every supported provider. Presets
 * are data — base URLs, paths, model ids and prices are editable in the provider config.
 * `suggestedModels` are UI hints only; routing always uses discovered/configured models.
 */
import { type Capability, LLM_BASE_CAPABILITIES } from './capabilities';
import {
  defaultCredentialRef,
  type ProviderConfig,
  type ProviderExtra,
  type StructuredOutputMode,
} from './config';
import { ConfigurationError } from './errors';
import type { AdapterKind, AuthSpec, PricingInfo } from './types';

export type PresetCategory =
  'llm' | 'music' | 'singing' | 'transcription' | 'separation' | 'voice-conversion' | 'mastering' | 'managed';

export interface ProviderPreset {
  id: string;
  name: string;
  category: PresetCategory;
  adapter: AdapterKind;
  location: 'cloud' | 'local';
  description: string;
  baseUrl: string;
  auth: AuthSpec;
  /** Whether a credential (API key / token) is needed. */
  requiresCredential: boolean;
  /** Label for the credential field ("API key", "OAuth access token"). */
  credentialLabel?: string;
  capabilities: Capability[];
  defaultModel?: string;
  /** UI suggestions only — never used for routing. */
  suggestedModels?: string[];
  structuredOutput?: StructuredOutputMode;
  timeoutMs: number;
  concurrency: number;
  contextLength?: number;
  /** 1..5 */
  qualityTier: number;
  /** Undefined = unknown cost (UI shows "unknown cost"). */
  pricing?: PricingInfo;
  extra?: ProviderExtra;
  docsUrl?: string;
  setupNotes: string[];
}

const LLM: Capability[] = [...LLM_BASE_CAPABILITIES];
const LLM_CLOUD: Capability[] = [...LLM, 'STRUCTURED_JSON', 'TOOL_CALLING', 'LONG_CONTEXT'];
const LLM_LOCAL: Capability[] = [...LLM, 'STRUCTURED_JSON'];

const BEARER: AuthSpec = { type: 'bearer' };
const NONE: AuthSpec = { type: 'none' };

const PRICE_NOTE = 'List prices (USD per million tokens) as last checked; edit if they changed.';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // -------------------------------------------------------------------------
  // Cloud language / reasoning (spec §3.1)
  // -------------------------------------------------------------------------
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'llm',
    adapter: 'openai-compatible',
    location: 'cloud',
    description:
      'OpenAI chat models via the Chat Completions API with strict JSON-schema structured outputs.',
    baseUrl: 'https://api.openai.com/v1',
    auth: BEARER,
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: [...LLM_CLOUD],
    suggestedModels: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    structuredOutput: 'json_schema',
    timeoutMs: 180_000,
    concurrency: 4,
    qualityTier: 5,
    pricing: {
      currency: 'USD',
      note: PRICE_NOTE,
      asOf: '2025-08',
      models: {
        'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
        'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 },
        'gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4 },
        'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
        'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
        'gpt-4.1-nano': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
        'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
        'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
        o3: { inputPerMTok: 2, outputPerMTok: 8 },
        'o4-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
      },
    },
    extra: { maxTokensParam: 'max_completion_tokens', schemaDialect: 'openai-strict' },
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    setupNotes: [
      'Create an API key at platform.openai.com → API keys and paste it into the key field (stored in the OS keychain via the Song Deck server).',
      'Optional: set Organization / Project ids if your key belongs to several.',
      'Click "Discover models" to list the models your key can use.',
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'llm',
    adapter: 'anthropic',
    location: 'cloud',
    description:
      'Claude models through the official Anthropic SDK (structured outputs via output_config, effort control, refusal fallbacks).',
    baseUrl: 'https://api.anthropic.com',
    auth: { type: 'header', name: 'x-api-key' },
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: [...LLM_CLOUD],
    defaultModel: 'claude-opus-5-5',
    suggestedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    structuredOutput: 'json_schema',
    timeoutMs: 300_000,
    concurrency: 4,
    qualityTier: 5,
    pricing: {
      currency: 'USD',
      note: PRICE_NOTE,
      models: {
        'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
        'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
        'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
        'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
        'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
        'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
        'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
        'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
      },
    },
    extra: { effort: 'medium', refusalFallback: true },
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    setupNotes: [
      'Create an API key in the Claude Console (console.anthropic.com → API keys).',
      'Effort (low … max) trades depth for speed and cost; "medium" is the default.',
      'Refusal fallbacks retry declined requests on a fallback model server-side (first-party API only).',
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    category: 'llm',
    adapter: 'gemini',
    location: 'cloud',
    description: 'Gemini models via the Gemini API; accepts audio input for music analysis.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: { type: 'header', name: 'x-goog-api-key' },
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: [...LLM_CLOUD, 'AUDIO_INPUT', 'AUDIO_UNDERSTANDING'],
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    structuredOutput: 'json_schema',
    timeoutMs: 180_000,
    concurrency: 4,
    qualityTier: 5,
    pricing: {
      currency: 'USD',
      note: PRICE_NOTE,
      asOf: '2025-08',
      models: {
        'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
        'gemini-2.5-flash-lite': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
        'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
        'gemini-2.0-flash': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
      },
    },
    docsUrl: 'https://ai.google.dev/api/generate-content',
    setupNotes: [
      'Create an API key in Google AI Studio (aistudio.google.com → Get API key).',
      'Audio analysis sends the audio inline (WAV) — check the data-flow indicator.',
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI (Kimi)',
    category: 'llm',
    adapter: 'openai-compatible',
    location: 'cloud',
    description: "Kimi models through Moonshot's OpenAI-compatible API.",
    baseUrl: 'https://api.moonshot.ai/v1',
    auth: BEARER,
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: [...LLM_CLOUD],
    suggestedModels: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview'],
    structuredOutput: 'json_object',
    timeoutMs: 180_000,
    concurrency: 4,
    qualityTier: 4,
    pricing: {
      currency: 'USD',
      note: PRICE_NOTE,
      asOf: '2025-08',
      models: { 'kimi-k2': { inputPerMTok: 0.6, outputPerMTok: 2.5 } },
    },
    extra: { maxTokensParam: 'max_tokens', schemaDialect: 'openai-strict' },
    docsUrl: 'https://platform.moonshot.ai/docs/api/chat',
    setupNotes: [
      'Create an API key at platform.moonshot.ai.',
      'JSON mode (json_object) is used; the schema is described in the prompt.',
    ],
  },
  {
    id: 'llama-api',
    name: 'Meta Llama API',
    category: 'llm',
    adapter: 'openai-compatible',
    location: 'cloud',
    description: 'Meta-hosted Llama models via the Llama API OpenAI-compatibility endpoint.',
    baseUrl: 'https://api.llama.com/compat/v1',
    auth: BEARER,
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: [...LLM_CLOUD],
    suggestedModels: ['Llama-4-Maverick-17B-128E-Instruct-FP8', 'Llama-3.3-70B-Instruct'],
    structuredOutput: 'json_schema',
    timeoutMs: 180_000,
    concurrency: 4,
    qualityTier: 4,
    extra: { maxTokensParam: 'max_completion_tokens', schemaDialect: 'openai-strict' },
    docsUrl: 'https://llama.developer.meta.com/docs/features/compatibility',
    setupNotes: ['Create an API key at llama.developer.meta.com.'],
  },
  {
    id: 'together',
    name: 'Together AI',
    category: 'llm',
    adapter: 'openai-compatible',
    location: 'cloud',
    description: 'Open-weight models (Llama, Qwen, DeepSeek, Mistral…) hosted by Together AI.',
    baseUrl: 'https://api.together.xyz/v1',
    auth: BEARER,
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: [...LLM, 'STRUCTURED_JSON', 'TOOL_CALLING'],
    suggestedModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    structuredOutput: 'json_object',
    timeoutMs: 180_000,
    concurrency: 4,
    qualityTier: 3,
    pricing: {
      currency: 'USD',
      note: PRICE_NOTE,
      asOf: '2025-08',
      models: { 'meta-llama/Llama-3.3-70B-Instruct-Turbo': { inputPerMTok: 0.88, outputPerMTok: 0.88 } },
    },
    extra: { maxTokensParam: 'max_tokens', schemaDialect: 'openai-strict' },
    docsUrl: 'https://docs.together.ai/docs/openai-api-compatibility',
    setupNotes: ['Create an API key at api.together.ai/settings/api-keys.'],
  },
  {
    id: 'groq',
    name: 'Groq',
    category: 'llm',
    adapter: 'openai-compatible',
    location: 'cloud',
    description:
      "Very fast inference of open models on Groq's OpenAI-compatible API — good for cheap drafts.",
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: BEARER,
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: [...LLM, 'STRUCTURED_JSON', 'TOOL_CALLING'],
    suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    structuredOutput: 'json_object',
    timeoutMs: 120_000,
    concurrency: 4,
    qualityTier: 3,
    pricing: {
      currency: 'USD',
      note: PRICE_NOTE,
      asOf: '2025-08',
      models: {
        'llama-3.3-70b-versatile': { inputPerMTok: 0.59, outputPerMTok: 0.79 },
        'llama-3.1-8b-instant': { inputPerMTok: 0.05, outputPerMTok: 0.08 },
      },
    },
    extra: { maxTokensParam: 'max_completion_tokens', schemaDialect: 'openai-strict' },
    docsUrl: 'https://console.groq.com/docs/openai',
    setupNotes: ['Create an API key at console.groq.com/keys.'],
  },

  // -------------------------------------------------------------------------
  // Local LLM servers (spec §4.1)
  // -------------------------------------------------------------------------
  {
    id: 'ollama',
    name: 'Ollama',
    category: 'llm',
    adapter: 'ollama',
    location: 'local',
    description: 'Local models through Ollama\'s native API (JSON-schema constrained output via "format").',
    baseUrl: 'http://localhost:11434',
    auth: NONE,
    requiresCredential: false,
    capabilities: [...LLM_LOCAL],
    suggestedModels: ['llama3.1:8b', 'qwen3:8b', 'gemma3:12b', 'mistral-small3.2', 'phi4-mini'],
    structuredOutput: 'json_schema',
    timeoutMs: 600_000,
    concurrency: 1,
    contextLength: 8192,
    qualityTier: 2,
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
    setupNotes: [
      'Install Ollama (ollama.com) and pull a model, e.g. `ollama pull llama3.1:8b`.',
      'Browsers need CORS: start Ollama with OLLAMA_ORIGINS set to the Song Deck origin, or use the server proxy.',
      'Raise "Context length" (num_ctx) for long songs if your hardware allows.',
    ],
  },
  {
    id: 'llama-cpp',
    name: 'llama.cpp server',
    category: 'llm',
    adapter: 'openai-compatible',
    location: 'local',
    description: "llama.cpp's llama-server (OpenAI-compatible, grammar-constrained JSON schema).",
    baseUrl: 'http://localhost:8080/v1',
    auth: NONE,
    requiresCredential: false,
    capabilities: [...LLM_LOCAL],
    structuredOutput: 'json_schema',
    timeoutMs: 600_000,
    concurrency: 1,
    contextLength: 8192,
    qualityTier: 2,
    extra: { maxTokensParam: 'max_tokens', schemaDialect: 'json-schema' },
    docsUrl: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
    setupNotes: [
      'Start `llama-server -m model.gguf --port 8080 -c 8192`.',
      'If you start it with --api-key, switch auth to Bearer and store the key.',
    ],
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    category: 'llm',
    adapter: 'openai-compatible',
    location: 'local',
    description: "Models served by LM Studio's local OpenAI-compatible server.",
    baseUrl: 'http://localhost:1234/v1',
    auth: NONE,
    requiresCredential: false,
    capabilities: [...LLM_LOCAL],
    structuredOutput: 'json_schema',
    timeoutMs: 600_000,
    concurrency: 1,
    qualityTier: 2,
    extra: { maxTokensParam: 'max_tokens', schemaDialect: 'json-schema' },
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    setupNotes: [
      'In LM Studio open the Developer tab and start the server (default port 1234).',
      'Load a model before generating.',
    ],
  },
  {
    id: 'vllm',
    name: 'vLLM',
    category: 'llm',
    adapter: 'openai-compatible',
    location: 'local',
    description: 'vLLM OpenAI-compatible server (guided JSON decoding).',
    baseUrl: 'http://localhost:8000/v1',
    auth: NONE,
    requiresCredential: false,
    capabilities: [...LLM_LOCAL],
    structuredOutput: 'json_schema',
    timeoutMs: 600_000,
    concurrency: 4,
    qualityTier: 3,
    extra: { maxTokensParam: 'max_tokens', schemaDialect: 'json-schema' },
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    setupNotes: [
      'Start `vllm serve <model> --port 8000`.',
      'If you pass --api-key, switch auth to Bearer and store the key.',
    ],
  },
  {
    id: 'custom-llm-http',
    name: 'Custom HTTP LLM',
    category: 'llm',
    adapter: 'custom-http',
    location: 'local',
    description: 'Any HTTP endpoint described by a request template and a response text path.',
    baseUrl: 'http://localhost:9000/generate',
    auth: NONE,
    requiresCredential: false,
    capabilities: [...LLM],
    structuredOutput: 'prompt',
    timeoutMs: 300_000,
    concurrency: 1,
    qualityTier: 2,
    extra: {
      customTemplate: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"{{model}}","messages":{{messages_json}},"max_tokens":{{max_tokens}}}',
        responseTextPath: 'choices[0].message.content',
        inputTokensPath: 'usage.prompt_tokens',
        outputTokensPath: 'usage.completion_tokens',
      },
    },
    setupNotes: [
      'Body placeholders: {{system}} {{prompt}} {{model}} (JSON-escaped, put them inside quotes), {{messages_json}} {{schema_json}} (raw JSON), {{max_tokens}} {{temperature}}.',
      'Response text path uses dots and [index], e.g. choices[0].message.content or results[0].text.',
      'Set location to "cloud" if the endpoint is not on this machine (affects privacy indicators and offline mode).',
    ],
  },

  // -------------------------------------------------------------------------
  // Production providers (spec §30)
  // -------------------------------------------------------------------------
  {
    id: 'elevenlabs-music',
    name: 'ElevenLabs Music',
    category: 'music',
    adapter: 'elevenlabs-music',
    location: 'cloud',
    description: 'Full-song generation with composition plans (sections, durations, lyrics, styles).',
    baseUrl: 'https://api.elevenlabs.io/v1',
    auth: { type: 'header', name: 'xi-api-key' },
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: [
      'TEXT_TO_MUSIC',
      'LYRIC_CONDITIONING',
      'VOCAL_GENERATION',
      'SECTION_GENERATION',
      'INSTRUMENTAL_ONLY',
    ],
    defaultModel: 'music_v1',
    timeoutMs: 600_000,
    concurrency: 2,
    qualityTier: 5,
    extra: { outputFormat: 'mp3_44100_128' },
    docsUrl: 'https://elevenlabs.io/docs/api-reference/music/compose',
    setupNotes: [
      'Create an API key at elevenlabs.io → Developers → API keys (music access depends on your plan).',
      'Song Deck sends a composition plan built from your sections, tempo map and lyrics.',
    ],
  },
  {
    id: 'stability-audio',
    name: 'Stability AI — Stable Audio',
    category: 'music',
    adapter: 'stability-audio',
    location: 'cloud',
    description: 'Stable Audio text-to-audio and audio-to-audio (guide render → produced audio).',
    baseUrl: 'https://api.stability.ai/v2beta',
    auth: BEARER,
    requiresCredential: true,
    credentialLabel: 'API key',
    capabilities: ['TEXT_TO_MUSIC', 'AUDIO_TO_AUDIO', 'STEM_CONDITIONING', 'INSTRUMENTAL_ONLY'],
    defaultModel: 'stable-audio-2',
    suggestedModels: ['stable-audio-2', 'stable-audio-2.5'],
    timeoutMs: 600_000,
    concurrency: 2,
    qualityTier: 4,
    pricing: {
      currency: 'USD',
      perGenerationUsd: 0.2,
      note: '20 credits ($0.01 each) per generation; verify current pricing.',
      asOf: '2025-08',
    },
    extra: { outputFormat: 'wav' },
    docsUrl: 'https://platform.stability.ai/docs/api-reference#tag/Text-to-Audio',
    setupNotes: [
      'Create an API key at platform.stability.ai/account/keys.',
      'Audio-to-audio uses the guide render as input; "strength" controls how far it may depart.',
    ],
  },
  {
    id: 'google-lyria',
    name: 'Google Lyria (Vertex AI)',
    category: 'music',
    adapter: 'google-lyria',
    location: 'cloud',
    description: 'Lyria instrumental music generation on Vertex AI (~30-second clips).',
    baseUrl: 'https://{location}-aiplatform.googleapis.com/v1',
    auth: BEARER,
    requiresCredential: true,
    credentialLabel: 'OAuth access token',
    capabilities: ['TEXT_TO_MUSIC', 'INSTRUMENTAL_ONLY'],
    defaultModel: 'lyria-002',
    timeoutMs: 300_000,
    concurrency: 2,
    qualityTier: 4,
    pricing: {
      currency: 'USD',
      perClipUsd: 0.06,
      clipSeconds: 30,
      note: '$0.06 per 30-second clip; verify current pricing.',
      asOf: '2025-08',
    },
    extra: { vertexProject: '', vertexLocation: 'us-central1' },
    docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/lyria-music-generation',
    setupNotes: [
      'Enable the Vertex AI API in your Google Cloud project and set the project id and location.',
      'Authentication is OAuth: store an access token (e.g. from `gcloud auth print-access-token`); the Song Deck server can refresh it.',
      'Lyria returns ~30 s instrumental clips; longer songs are produced section by section.',
    ],
  },

  // -------------------------------------------------------------------------
  // Local production / vocals / analysis bridges (spec §31, §34, §26)
  // -------------------------------------------------------------------------
  {
    id: 'ace-step-local',
    name: 'ACE-Step (local)',
    category: 'music',
    adapter: 'local-music',
    location: 'local',
    description:
      'ACE-Step local music generation through the Song Deck music bridge (lyrics + audio conditioning).',
    baseUrl: 'http://127.0.0.1:8810',
    auth: NONE,
    requiresCredential: false,
    capabilities: [
      'TEXT_TO_MUSIC',
      'AUDIO_TO_AUDIO',
      'LYRIC_CONDITIONING',
      'VOCAL_GENERATION',
      'INSTRUMENTAL_ONLY',
      'SECTION_GENERATION',
      'REFERENCE_AUDIO',
      'STEM_CONDITIONING',
      'INPAINTING',
      'OUTPAINTING',
      'REGION_GENERATION',
    ],
    timeoutMs: 900_000,
    concurrency: 1,
    qualityTier: 3,
    docsUrl: 'https://github.com/ace-step/ACE-Step',
    setupNotes: [
      'Install ACE-Step and run the Song Deck bridge script (implements the music bridge contract) on port 8810.',
      'Needs ~4 GB+ VRAM (see Model Manager for compatibility).',
    ],
  },
  {
    id: 'diffsinger-local',
    name: 'DiffSinger (local)',
    category: 'singing',
    adapter: 'singing-http',
    location: 'local',
    description:
      'OpenVPI DiffSinger singing synthesis (lyrics + MIDI + expression) through the Song Deck singing bridge.',
    baseUrl: 'http://127.0.0.1:8811',
    auth: NONE,
    requiresCredential: false,
    capabilities: ['SINGING_SYNTHESIS', 'MIDI_CONDITIONING', 'LYRIC_CONDITIONING', 'REGION_GENERATION'],
    timeoutMs: 600_000,
    concurrency: 1,
    qualityTier: 4,
    docsUrl: 'https://github.com/openvpi/DiffSinger',
    setupNotes: [
      'Install DiffSinger (OpenVPI) with a voicebank and run the Song Deck singing bridge on port 8811.',
    ],
  },
  {
    id: 'demucs-local',
    name: 'Demucs (local)',
    category: 'separation',
    adapter: 'separation-http',
    location: 'local',
    description: 'Demucs htdemucs source separation through the Song Deck separation bridge.',
    baseUrl: 'http://127.0.0.1:8812',
    auth: NONE,
    requiresCredential: false,
    capabilities: ['SOURCE_SEPARATION', 'VOCAL_ISOLATION', 'STEM_OUTPUT'],
    timeoutMs: 900_000,
    concurrency: 1,
    qualityTier: 4,
    docsUrl: 'https://github.com/adefossez/demucs',
    setupNotes: [
      '`pip install demucs` and run the Song Deck separation bridge on port 8812.',
      'Runs on CPU (slow) or GPU.',
    ],
  },
  {
    id: 'basic-pitch-local',
    name: 'Basic Pitch (local)',
    category: 'transcription',
    adapter: 'transcription-http',
    location: 'local',
    description: 'Spotify Basic Pitch polyphonic audio-to-MIDI through the Song Deck transcription bridge.',
    baseUrl: 'http://127.0.0.1:8813',
    auth: NONE,
    requiresCredential: false,
    capabilities: ['AUDIO_TRANSCRIPTION', 'AUDIO_TO_MIDI', 'PITCH_TRACKING'],
    timeoutMs: 600_000,
    concurrency: 1,
    qualityTier: 3,
    docsUrl: 'https://github.com/spotify/basic-pitch',
    setupNotes: [
      '`pip install basic-pitch` and run the Song Deck transcription bridge on port 8813 (CPU is fine).',
    ],
  },
  {
    id: 'rvc-local',
    name: 'RVC voice conversion (local)',
    category: 'voice-conversion',
    adapter: 'voice-conversion-http',
    location: 'local',
    description:
      'Retrieval-based Voice Conversion to an AUTHORIZED target voice (consent required, spec §36).',
    baseUrl: 'http://127.0.0.1:8814',
    auth: NONE,
    requiresCredential: false,
    capabilities: ['VOICE_CONVERSION'],
    timeoutMs: 600_000,
    concurrency: 1,
    qualityTier: 3,
    docsUrl: 'https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI',
    setupNotes: [
      'Run the Song Deck voice-conversion bridge on port 8814 with your RVC models.',
      'Only use voices you are authorized to use; Song Deck records consent and voice provenance.',
    ],
  },
  {
    id: 'mastering-local',
    name: 'Local mastering engine',
    category: 'mastering',
    adapter: 'mastering-http',
    location: 'local',
    description: 'Reference-based mastering (Matchering-style) through the Song Deck mastering bridge.',
    baseUrl: 'http://127.0.0.1:8815',
    auth: NONE,
    requiresCredential: false,
    capabilities: ['MASTERING', 'REFERENCE_AUDIO'],
    timeoutMs: 600_000,
    concurrency: 1,
    qualityTier: 3,
    docsUrl: 'https://github.com/sergree/matchering',
    setupNotes: ['Run the Song Deck mastering bridge on port 8815.'],
  },
  {
    id: 'custom-audio-http',
    name: 'Custom audio model (HTTP)',
    category: 'music',
    adapter: 'local-music',
    location: 'local',
    description:
      'Any music model that implements the Song Deck music bridge contract (GET /info, POST /generate …).',
    baseUrl: 'http://127.0.0.1:8820',
    auth: NONE,
    requiresCredential: false,
    capabilities: ['TEXT_TO_MUSIC'],
    timeoutMs: 900_000,
    concurrency: 1,
    qualityTier: 3,
    setupNotes: [
      'The bridge reports its capabilities from GET /info; they override the defaults.',
      'Set location to "cloud" if the server is remote.',
    ],
  },

  // -------------------------------------------------------------------------
  // Managed "Automatic" (spec §8)
  // -------------------------------------------------------------------------
  {
    id: 'managed',
    name: 'Automatic (managed)',
    category: 'managed',
    adapter: 'managed',
    location: 'cloud',
    description:
      'Let the Song Deck service choose models by quality, cost, latency, availability, task and your privacy settings.',
    baseUrl: '',
    auth: NONE,
    requiresCredential: false,
    capabilities: [
      ...LLM_CLOUD,
      'AUDIO_INPUT',
      'AUDIO_UNDERSTANDING',
      'TEXT_TO_MUSIC',
      'AUDIO_TO_AUDIO',
      'LYRIC_CONDITIONING',
      'VOCAL_GENERATION',
      'INSTRUMENTAL_ONLY',
      'SECTION_GENERATION',
      'SINGING_SYNTHESIS',
      'AUDIO_TRANSCRIPTION',
      'AUDIO_TO_MIDI',
      'SOURCE_SEPARATION',
      'MASTERING',
    ],
    timeoutMs: 900_000,
    concurrency: 4,
    qualityTier: 4,
    setupNotes: [
      'Base URL is the Song Deck server ("" = same origin). The server routes among its own configured providers.',
    ],
  },
];

export function getPreset(id: string | undefined): ProviderPreset | undefined {
  return id ? PROVIDER_PRESETS.find((p) => p.id === id) : undefined;
}

export function presetsByCategory(category: PresetCategory): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((p) => p.category === category);
}

/** A fresh ProviderConfig from a preset (no secrets; credentialRef defaults to `provider:<id>`). */
export function configFromPreset(presetId: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const preset = getPreset(presetId);
  if (!preset) throw new ConfigurationError(`Unknown provider preset "${presetId}"`);
  const id = overrides.id ?? preset.id;
  const config: ProviderConfig = {
    id,
    presetId: preset.id,
    name: preset.name,
    adapter: preset.adapter,
    enabled: true,
    location: preset.location,
    baseUrl: preset.baseUrl,
    auth: { ...preset.auth },
    timeoutMs: preset.timeoutMs,
    concurrency: preset.concurrency,
    qualityTier: preset.qualityTier,
    ...(preset.requiresCredential ? { credentialRef: defaultCredentialRef(id) } : {}),
    ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
    ...(preset.structuredOutput ? { structuredOutput: preset.structuredOutput } : {}),
    ...(preset.contextLength ? { contextLength: preset.contextLength } : {}),
    ...(preset.extra ? { extra: structuredClone(preset.extra) } : {}),
    ...overrides,
  };
  // `extra` is merged key by key so overriding one adapter setting keeps the preset's others.
  if (preset.extra && overrides.extra)
    config.extra = { ...structuredClone(preset.extra), ...overrides.extra };
  return config;
}
