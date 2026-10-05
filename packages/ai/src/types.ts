/**
 * Shared types of the AI Orchestrator and Model Runtime (spec §3-§8, §30-§31, §34, §58).
 *
 * Audio crosses this package only as `EncodedAudio` (encoded bytes + MIME type); decoding and
 * DSP live in `@songdeck/audio`, which this package never imports (ARCHITECTURE §1).
 */
import type {
  Blueprint,
  CompositionPlan,
  MasteringTarget,
  MusicOperation,
  SectionKind,
  Song,
  VocalExpression,
  VoiceConsent,
  VoiceKind,
  VoiceType,
} from '@songdeck/core';
import type { Capability } from './capabilities';
import type { ProviderConfig } from './config';
import type { MusicContext } from './context';
import type { OperationParseError } from './operations-parse';

// ---------------------------------------------------------------------------
// Roles, data kinds, locations
// ---------------------------------------------------------------------------

/** Task roles a profile assigns providers to (spec §2.2, §6, §49). */
export type TaskRole =
  | 'composition'
  | 'harmony'
  | 'midi-editing'
  | 'lyrics'
  | 'analysis'
  | 'transcription'
  | 'separation'
  | 'production'
  | 'vocals'
  | 'voice-conversion'
  | 'mixing'
  | 'mastering'
  | 'chat'
  | 'lyric-transcription'
  | 'instrument-rendering';

export const TASK_ROLES: readonly TaskRole[] = [
  'composition',
  'harmony',
  'midi-editing',
  'lyrics',
  'analysis',
  'chat',
  'transcription',
  'separation',
  'production',
  'vocals',
  'voice-conversion',
  'mixing',
  'mastering',
  'lyric-transcription',
  'instrument-rendering',
];

/** Kinds of project data that may be sent to a provider (spec §50 data-flow indicator). */
export type DataKind =
  | 'song-description'
  | 'chord-progression'
  | 'midi'
  | 'lyrics'
  | 'recorded-vocals'
  | 'reference-audio'
  | 'guide-audio'
  | 'stems'
  | 'project-metadata'
  | 'analysis';

export const DATA_KINDS: readonly DataKind[] = [
  'song-description',
  'chord-progression',
  'midi',
  'lyrics',
  'recorded-vocals',
  'reference-audio',
  'guide-audio',
  'stems',
  'project-metadata',
  'analysis',
];

/** Where a provider runs. `internal` = Song Deck's deterministic engine (always offline, zero cost). */
export type ProviderLocation = 'cloud' | 'local' | 'internal';

export type ProviderStatus = 'ready' | 'unconfigured' | 'error' | 'offline';

/** Requested quality level of a task (drives routing priorities and cloud-only-for-final rules). */
export type QualityLevel = 'draft' | 'standard' | 'final';

export type AdapterKind =
  | 'openai-compatible'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'custom-http'
  | 'elevenlabs-music'
  | 'stability-audio'
  | 'google-lyria'
  | 'local-music'
  | 'singing-http'
  | 'transcription-http'
  | 'separation-http'
  | 'voice-conversion-http'
  | 'mastering-http'
  | 'lyrics-http'
  | 'openai-transcription'
  | 'plugin-host-http'
  | 'minimax-music'
  | 'mureka'
  | 'audioshake'
  | 'lalal'
  | 'managed'
  | 'internal';

// ---------------------------------------------------------------------------
// Models, pricing, descriptors
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Encoded audio bytes (WAV, MP3, FLAC…). Decoding happens in `@songdeck/audio`. */
export interface EncodedAudio {
  mimeType: string;
  data: Uint8Array;
  sampleRate?: number;
  channels?: number;
  durationSeconds?: number;
}

/** Per-model token pricing (USD per million tokens). */
export interface ModelPricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  perGenerationUsd?: number;
  perSecondUsd?: number;
  perMinuteUsd?: number;
  perClipUsd?: number;
  clipSeconds?: number;
}

/**
 * Pricing data (editable; presets ship defaults). Unknown pricing is `undefined` and the UI shows
 * "unknown cost" (spec §60).
 */
export interface PricingInfo extends ModelPricing {
  currency?: 'USD';
  /** Per-model overrides. Keys match a model id exactly, otherwise the longest matching prefix. */
  models?: Record<string, ModelPricing>;
  /** Free-form note, e.g. "List price; verify with the provider". */
  note?: string;
  /** When the defaults were last checked (ISO date). */
  asOf?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  capabilities: Capability[];
  contextLength?: number;
  maxOutputTokens?: number;
  /** 1 (draft) .. 5 (best). */
  qualityTier?: number;
  pricing?: ModelPricing;
  /** True when capabilities were inferred heuristically (OpenAI-compatible endpoints report little metadata). */
  capabilitiesInferred?: boolean;
  /** Entered manually in the provider config rather than discovered. */
  manual?: boolean;
  /** Adapter-specific metadata (e.g. raw Anthropic capability flags, Ollama details). */
  meta?: Record<string, unknown>;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  adapter: AdapterKind;
  location: ProviderLocation;
  /** Provider-level capabilities (union of what its models can do). */
  capabilities: Capability[];
  presetId?: string;
  /** 1..5, used by automatic routing. */
  qualityTier?: number;
  pricing?: PricingInfo;
  docsUrl?: string;
  description?: string;
  defaultModel?: string;
}

// ---------------------------------------------------------------------------
// JSON schema subset (structured output, spec §46)
// ---------------------------------------------------------------------------

export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  anyOf?: JsonSchema[];
  /** OpenAPI-style nullability (Gemini dialect). */
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  /** Gemini: output property order. */
  propertyOrdering?: string[];
  /** Song Deck annotation: keep this optional property at top level when a dialect must fold optional fields. */
  'x-keep'?: boolean;
}

// ---------------------------------------------------------------------------
// LLM providers
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'assistant';

export type ContentPart =
  { type: 'text'; text: string } | { type: 'audio'; audio: EncodedAudio; label?: string };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
}

/**
 * Routing hints carried with a request. Only gateway-style adapters (the managed "Automatic"
 * service, spec §8) use them to route server-side by task, quality and the user's privacy settings.
 */
export interface RequestHints {
  role?: TaskRole;
  quality?: QualityLevel;
  /** Data kinds contained in this request. */
  dataKinds?: DataKind[];
  /** Data kinds that must not be sent to third-party clouds. */
  neverUpload?: DataKind[];
}

export interface LLMRequest {
  model?: string;
  system?: string;
  messages: ChatMessage[];
  /** Canonical JSON schema of the expected output; adapters compile it to their dialect. */
  responseSchema?: JsonSchema;
  schemaName?: string;
  maxTokens?: number;
  /** Sent only when explicitly set (several current models reject sampling parameters). */
  temperature?: number;
  signal?: AbortSignal;
  hints?: RequestHints;
}

export interface LLMResponse {
  text: string;
  /** Parsed JSON when a responseSchema was requested and the text parsed. */
  json?: unknown;
  usage?: TokenUsage;
  model: string;
  /** Provider stop reason (normalized where possible: 'end_turn' | 'max_tokens' | 'refusal' | …). */
  stopReason: string;
  costUsd?: number;
  /** How JSON was obtained: provider-native schema constraint or prompt instructions. */
  structured?: 'native' | 'json-mode' | 'prompt';
  /** Set when a server-side refusal fallback produced (part of) the answer. */
  fallbackModel?: string;
}

export interface LLMProvider {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /**
   * Models the last `listModels()` saw but left out because they are not chat models (embeddings,
   * images, speech…), with no capabilities — for "show all models" views. Optional.
   */
  readonly skippedModels?: ModelInfo[];
  complete(req: LLMRequest): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// Composition providers (spec §58: plan_song / modify_composition / analyze_music / explain_music)
// ---------------------------------------------------------------------------

export interface CallMeta {
  providerId?: string;
  model?: string;
  usage?: TokenUsage;
  costUsd?: number;
  /** Number of LLM calls (2 when the automatic JSON repair retry ran). */
  calls?: number;
  repaired?: boolean;
  structured?: 'native' | 'json-mode' | 'prompt';
}

interface BaseCompositionRequest {
  model?: string;
  signal?: AbortSignal;
  hints?: RequestHints;
}

export interface PlanSongRequest extends BaseCompositionRequest {
  /** Natural-language idea ("melancholy emo song in E minor"). */
  prompt?: string;
  /** Blueprint to plan from (spec §10 → §15). */
  blueprint?: Blueprint;
  /** Existing song context when re-planning. */
  context?: MusicContext;
  /** Extra constraints ("keep the chorus 8 bars"). */
  constraints?: string[];
}

export interface PlanSongResult {
  plan: CompositionPlan;
  explanation?: string;
  confidence?: number;
  meta?: CallMeta;
}

export interface DesignBlueprintRequest extends BaseCompositionRequest {
  prompt: string;
  /** Values to fall back on (seed, macros, defaults chosen by the UI). */
  defaults?: Partial<Blueprint>;
  /** Known genre profiles the model may reference in genre_blend. */
  genres?: { id: string; name: string }[];
  /** Known instrument profiles the model may reference. */
  instruments?: { id: string; name: string; family?: string }[];
  /** Tag catalog entries (style, mood, era, production…) the model may put in `tags`. */
  tags?: { id: string; name: string; kind?: string }[];
  /** Choices the user fixed in the Compose builder, in plain language: the model must keep them. */
  constraints?: string[];
  /** The user's own lyrics: the song is built around them and the words are never changed. */
  lyrics?: string;
}

export interface DesignBlueprintResult {
  blueprint: Blueprint;
  explanation?: string;
  confidence?: number;
  meta?: CallMeta;
}

export interface ModifyCompositionRequest extends BaseCompositionRequest {
  context: MusicContext;
  /** Overrides `context.instruction`. */
  instruction?: string;
  /** Restrict allowed operation types. */
  allowedOps?: MusicOperation['op'][];
}

export interface ModifyCompositionResult {
  operations: MusicOperation[];
  explanation: string;
  /** Per-operation problems (invalid ops are dropped, never applied). */
  errors: OperationParseError[];
  confidence?: number;
  meta?: CallMeta;
}

export interface AnalyzeMusicRequest extends BaseCompositionRequest {
  context?: MusicContext;
  question?: string;
  /** Audio to analyze (requires AUDIO_UNDERSTANDING / AUDIO_INPUT). */
  audio?: EncodedAudio;
}

export interface AnalysisObservation {
  topic: string;
  detail: string;
  section?: string;
}

export interface AnalyzeMusicResult {
  summary: string;
  observations: AnalysisObservation[];
  key?: string;
  tempo?: number;
  genre?: string;
  confidence?: number;
  meta?: CallMeta;
}

export interface ExplainMusicRequest extends BaseCompositionRequest {
  context: MusicContext;
  sectionId?: string;
  question?: string;
}

export interface HarmonyExplanation {
  section: string;
  chords: string[];
  romans: string[];
  comment?: string;
}

export interface ExplainMusicResult {
  explanation: string;
  harmony: HarmonyExplanation[];
  suggestions: string[];
  confidence?: number;
  meta?: CallMeta;
}

export interface LyricSectionRequest {
  /** Section name or id (e.g. "Chorus 1"). */
  name: string;
  kind?: SectionKind;
  /** Number of lines wanted. */
  lines: number;
  /** Target syllable count per line (from the vocal melody), when known. */
  syllables?: number[];
  /** Existing lines (revision) — kept when `locked`. */
  existing?: string[];
  locked?: boolean;
}

export interface GenerateLyricsRequest extends BaseCompositionRequest {
  context?: MusicContext;
  theme?: string;
  style?: string;
  language?: string;
  rhymeScheme?: string;
  instruction?: string;
  sections: LyricSectionRequest[];
}

export interface GenerateLyricsResult {
  title?: string;
  sections: { section: string; lines: string[] }[];
  notes?: string;
  confidence?: number;
  meta?: CallMeta;
}

export interface ChatRequest extends BaseCompositionRequest {
  context: MusicContext;
  /** Prior conversation. */
  history?: ChatMessage[];
  question: string;
}

export interface ChatResult {
  answer: string;
  suggestions: string[];
  /** Proposed edits (become a Proposal, never applied directly — spec §21). */
  operations: MusicOperation[];
  errors: OperationParseError[];
  confidence?: number;
  meta?: CallMeta;
}

export interface MixAssistRequest extends BaseCompositionRequest {
  context: MusicContext;
  instruction: string;
}

export interface MixAssistResult {
  /** Only set_mixer / set_automation operations (spec §41: prefer mixer changes over regeneration). */
  operations: MusicOperation[];
  explanation: string;
  errors: OperationParseError[];
  confidence?: number;
  meta?: CallMeta;
}

export interface CompositionProvider {
  planSong(req: PlanSongRequest): Promise<PlanSongResult>;
  designBlueprint(req: DesignBlueprintRequest): Promise<DesignBlueprintResult>;
  modifyComposition(req: ModifyCompositionRequest): Promise<ModifyCompositionResult>;
  analyzeMusic(req: AnalyzeMusicRequest): Promise<AnalyzeMusicResult>;
  explainMusic(req: ExplainMusicRequest): Promise<ExplainMusicResult>;
  generateLyrics(req: GenerateLyricsRequest): Promise<GenerateLyricsResult>;
  chat(req: ChatRequest): Promise<ChatResult>;
  mixAssist(req: MixAssistRequest): Promise<MixAssistResult>;
}

// ---------------------------------------------------------------------------
// Audio generation (spec §30-§31, §58)
// ---------------------------------------------------------------------------

export interface GenerationSection {
  name: string;
  kind?: SectionKind;
  startSeconds: number;
  endSeconds: number;
  prompt?: string;
  negativePrompt?: string;
  /** Lyric lines sung in this section (empty for instrumental sections). */
  lines?: string[];
  energy?: number;
}

export interface MusicGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  lyrics?: string;
  durationSeconds: number;
  seed?: number;
  bpm?: number;
  /** Key name, e.g. "E minor". */
  key?: string;
  /** Meter, e.g. "4/4". */
  meter?: string;
  sections?: GenerationSection[];
  referenceAudio?: EncodedAudio;
  /** Guide render / stem the output should follow (spec §28, §38). */
  guideAudio?: EncodedAudio;
  /** 0..1 how far the output may depart from guide/reference audio. */
  strength?: number;
  instrumental?: boolean;
  model?: string;
  outputFormat?: 'wav' | 'mp3';
  /** The composition, for providers that build their own plans (ElevenLabs composition plans). */
  song?: Song;
  /** Number of samples/candidates (providers that support it). */
  samples?: number;
  signal?: AbortSignal;
  hints?: RequestHints;
  /** Adapter-specific parameters. */
  extra?: Record<string, unknown>;
}

export interface AudioGenerationResult {
  audio: EncodedAudio;
  /** Additional samples when the provider returns several. */
  alternatives?: EncodedAudio[];
  model?: string;
  seed?: number;
  costUsd?: number;
  durationSeconds?: number;
  jobId?: string;
  confidence?: number;
}

export interface AudioTransformRequest {
  audio: EncodedAudio;
  prompt: string;
  negativePrompt?: string;
  /** 0..1: 0 = keep input, 1 = ignore input. */
  strength?: number;
  seed?: number;
  durationSeconds?: number;
  bpm?: number;
  key?: string;
  model?: string;
  signal?: AbortSignal;
  hints?: RequestHints;
}

export interface AudioExtendRequest {
  audio: EncodedAudio;
  prompt: string;
  /** Seconds to add. */
  durationSeconds: number;
  seed?: number;
  model?: string;
  signal?: AbortSignal;
  hints?: RequestHints;
}

export interface AudioInpaintRequest {
  audio: EncodedAudio;
  startSeconds: number;
  endSeconds: number;
  prompt: string;
  seed?: number;
  model?: string;
  signal?: AbortSignal;
  hints?: RequestHints;
}

/** Spec §31 AudioModelProvider: discover_models / get_capabilities / generate / transform / continue / inpaint / cancel. */
export interface AudioGenerationProvider {
  discoverModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  getCapabilities(modelId?: string): Promise<Capability[]>;
  generateMusic(req: MusicGenerationRequest): Promise<AudioGenerationResult>;
  transformAudio(req: AudioTransformRequest): Promise<AudioGenerationResult>;
  extendAudio?(req: AudioExtendRequest): Promise<AudioGenerationResult>;
  inpaintAudio?(req: AudioInpaintRequest): Promise<AudioGenerationResult>;
  cancel?(jobId?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Singing (spec §32-§37)
// ---------------------------------------------------------------------------

export interface VoiceInfo {
  id: string;
  name: string;
  voiceType?: VoiceType;
  language?: string;
  kind: VoiceKind;
  description?: string;
}

export interface SingingNote {
  /** MIDI pitch. */
  pitch: number;
  startSeconds: number;
  durationSeconds: number;
  lyric: string;
  phonemes?: string[];
  /** 1..127 */
  velocity: number;
  expression?: VocalExpression;
}

export interface SingingRequest {
  voiceId: string;
  tempoBpm: number;
  sampleRate?: number;
  seed?: number;
  notes: SingingNote[];
  language?: string;
  model?: string;
  signal?: AbortSignal;
  hints?: RequestHints;
}

export interface PhraseRegenerationRequest extends SingingRequest {
  startSeconds: number;
  endSeconds: number;
}

export interface SingingResult {
  audio: EncodedAudio;
  voiceId: string;
  seed?: number;
  model?: string;
  costUsd?: number;
}

export interface SingingProvider {
  listVoices(signal?: AbortSignal): Promise<VoiceInfo[]>;
  synthesizeSinging(req: SingingRequest): Promise<SingingResult>;
  regeneratePhrase?(req: PhraseRegenerationRequest): Promise<SingingResult>;
}

// ---------------------------------------------------------------------------
// Transcription, separation, voice conversion, mastering (spec §26, §36, §42, §58)
// ---------------------------------------------------------------------------

export interface TranscribedNote {
  pitch: number;
  /** Seconds. */
  start: number;
  end: number;
  velocity: number;
  confidence: number;
}

export interface TranscribedChord {
  symbol: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface AudioInputRequest {
  audio: EncodedAudio;
  model?: string;
  signal?: AbortSignal;
  hints?: RequestHints;
}

export interface TranscriptionRequest extends AudioInputRequest {
  /** What the audio is: "mix", "vocals", "bass", "drums", "piano", "guitar", "melody"… */
  source?: string;
}

export interface TranscriptionResult {
  notes: TranscribedNote[];
  tempo?: number;
  key?: string;
  chords?: TranscribedChord[];
  confidence?: number;
  model?: string;
}

export interface TranscriptionProvider {
  detectTempo?(req: AudioInputRequest): Promise<{ bpm: number; confidence: number }>;
  detectKey?(req: AudioInputRequest): Promise<{ key: string; confidence: number }>;
  transcribeNotes(req: TranscriptionRequest): Promise<TranscriptionResult>;
  transcribeChords?(req: AudioInputRequest): Promise<{ chords: TranscribedChord[]; confidence?: number }>;
}

export interface SeparationRequest extends AudioInputRequest {
  /** Default: ['drums', 'bass', 'vocals', 'other']. */
  stems?: string[];
}

export interface SeparationResult {
  stems: Record<string, EncodedAudio>;
  model?: string;
  confidence?: number;
}

export interface SeparationProvider {
  separateStems(req: SeparationRequest): Promise<SeparationResult>;
}

/** Target voice of a conversion (spec §36). */
export interface VoiceTarget {
  id: string;
  kind: VoiceKind;
  name?: string;
  /** Consent recorded on the voice model (VoiceModelRecord.consent). */
  consent?: VoiceConsent;
}

export interface VoiceConversionRequest extends AudioInputRequest {
  targetVoice: VoiceTarget;
  /** Consent attestation for this conversion (required unless the voice is stock or carries consent). */
  consent?: VoiceConsent;
  /** Semitones. */
  pitchShift?: number;
}

export interface VoiceConversionResult {
  audio: EncodedAudio;
  voiceId: string;
  model?: string;
}

export interface VoiceConversionProvider {
  /** MUST throw ConsentRequiredError unless the target voice is stock or consent is supplied (spec §36). */
  convertVoice(req: VoiceConversionRequest): Promise<VoiceConversionResult>;
  listVoices?(signal?: AbortSignal): Promise<VoiceInfo[]>;
}

export interface MasteringRequest extends AudioInputRequest {
  target: MasteringTarget;
  reference?: EncodedAudio;
}

export interface MasteringResult {
  audio: EncodedAudio;
  report?: Record<string, unknown>;
  model?: string;
}

export interface MasteringProvider {
  master(req: MasteringRequest): Promise<MasteringResult>;
}

// ---------------------------------------------------------------------------
// Lyrics transcription (speech-to-text with word timings)
// ---------------------------------------------------------------------------

export interface LyricTranscriptionRequest extends AudioInputRequest {
  /** BCP-47 / ISO-639-1 language hint ("en"); omitted = auto-detect. */
  language?: string;
  /** Expected lyrics or vocabulary to bias recognition. */
  prompt?: string;
  /** Ask for per-word timings (default true). Some models only return text. */
  wordTimestamps?: boolean;
}

export interface LyricWord {
  word: string;
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  /** 0..1 */
  confidence?: number;
}

export interface LyricSegment {
  start: number;
  end: number;
  text: string;
  words?: LyricWord[];
}

export interface LyricTranscriptionResult {
  text: string;
  language?: string;
  /** Phrases in time order; `words` are present when the provider returned word timings. */
  segments: LyricSegment[];
  /** True when every segment carries word timings. */
  wordTimestamps: boolean;
  model?: string;
  costUsd?: number;
}

export interface LyricTranscriptionProvider {
  transcribeLyrics(req: LyricTranscriptionRequest): Promise<LyricTranscriptionResult>;
}

// ---------------------------------------------------------------------------
// Instrument plugin hosts (VST3 / AU / CLAP / LV2 / SF2 / SFZ / WAM)
// ---------------------------------------------------------------------------

export type InstrumentPluginFormat = 'vst3' | 'au' | 'vst2' | 'clap' | 'lv2' | 'sf2' | 'sfz' | 'wam';

export interface InstrumentPluginFormatInfo {
  format: InstrumentPluginFormat;
  available: boolean;
  backend?: string;
  note?: string;
}

export interface InstrumentPluginInfo {
  /** Host-specific id (stable on one machine). */
  id: string;
  name: string;
  format: InstrumentPluginFormat;
  vendor?: string;
  version?: string;
  /** 'instrument' | 'effect' | 'unknown' */
  category?: string;
  path?: string;
  loadable?: boolean;
}

export interface InstrumentPluginParameter {
  id: string;
  name: string;
  value: number;
  min?: number;
  max?: number;
  default?: number;
  label?: string;
}

export interface InstrumentPluginDescription extends InstrumentPluginInfo {
  parameters: InstrumentPluginParameter[];
  presets?: string[];
  hasEditor?: boolean;
  latencySamples?: number;
}

/** Plugin state as the host returns it (opaque base64 + readable parameters). */
export interface InstrumentPluginState {
  stateBase64?: string;
  parameters: Record<string, number>;
  preset?: string;
}

export interface InstrumentHostStatus {
  name: string;
  version?: string;
  formats: InstrumentPluginFormatInfo[];
  /** Native editor windows can be opened (they appear on the machine running the host). */
  editor: boolean;
  searchPaths?: string[];
}

export interface MidiEventSeconds {
  /** Seconds from the start of the render. */
  time: number;
  /** Raw MIDI bytes, status first. */
  data: number[];
}

export interface InstrumentRenderRequest {
  pluginId: string;
  state?: InstrumentPluginState;
  sampleRate: number;
  channels?: number;
  durationSeconds: number;
  events: MidiEventSeconds[];
  blockSize?: number;
  signal?: AbortSignal;
  hints?: RequestHints;
}

export interface InstrumentRenderResult {
  audio: EncodedAudio;
  /** Output latency the host reported (frames) — already compensated when `latencyCompensated`. */
  latencySamples?: number;
  latencyCompensated?: boolean;
  pluginId: string;
}

export interface InstrumentHostProvider {
  status(signal?: AbortSignal): Promise<InstrumentHostStatus>;
  listPlugins(opts?: {
    rescan?: boolean;
    paths?: string[];
    signal?: AbortSignal;
  }): Promise<InstrumentPluginInfo[]>;
  describePlugin(pluginId: string, signal?: AbortSignal): Promise<InstrumentPluginDescription>;
  renderInstrument(req: InstrumentRenderRequest): Promise<InstrumentRenderResult>;
  /** Apply state/parameters/preset and read the resulting state back. */
  captureState?(
    pluginId: string,
    state?: InstrumentPluginState,
    signal?: AbortSignal,
  ): Promise<InstrumentPluginState>;
  /** Open the plugin's own editor; resolves with the edited state when the window closes. */
  openEditor?(
    pluginId: string,
    state?: InstrumentPluginState,
    signal?: AbortSignal,
  ): Promise<InstrumentPluginState>;
}

// ---------------------------------------------------------------------------
// Provider instances
// ---------------------------------------------------------------------------

export type ProviderInterfaceName =
  | 'llm'
  | 'composition'
  | 'audioGeneration'
  | 'singing'
  | 'transcription'
  | 'separation'
  | 'voiceConversion'
  | 'mastering'
  | 'lyricTranscription'
  | 'instrumentHost';

/**
 * A usable provider. Apps register INTERNAL providers (location 'internal', zero cost, offline)
 * implementing the same interfaces with the deterministic engine. LLM providers get
 * `composition` auto-derived (LLMCompositionProvider).
 */
export interface ProviderInstance {
  descriptor: ProviderDescriptor;
  /** Persisted configuration this instance was created from (absent for internal providers). */
  config?: ProviderConfig;
  llm?: LLMProvider;
  composition?: CompositionProvider;
  audioGeneration?: AudioGenerationProvider;
  singing?: SingingProvider;
  transcription?: TranscriptionProvider;
  separation?: SeparationProvider;
  voiceConversion?: VoiceConversionProvider;
  mastering?: MasteringProvider;
  lyricTranscription?: LyricTranscriptionProvider;
  instrumentHost?: InstrumentHostProvider;
  dispose?(): void;
}

// ---------------------------------------------------------------------------
// Transport & credentials (spec §7)
// ---------------------------------------------------------------------------

export type AuthType = 'bearer' | 'header' | 'query' | 'none';

/** How a secret is attached to requests. `bearer` → `Authorization: Bearer <secret>`. */
export interface AuthSpec {
  type: AuthType;
  /** Header name (type 'header') or query parameter name (type 'query'). */
  name?: string;
  /** Prefix before the secret (default 'Bearer ' for bearer, '' otherwise). */
  prefix?: string;
}

export interface TransportAuth extends AuthSpec {
  /** Vault reference of the secret. The secret itself never appears in configs or projects. */
  credentialRef?: string;
}

/** Network abstraction: direct fetch (browser/Node) or the local server's proxy. */
export interface Transport {
  readonly kind: string;
  fetch(url: string, init?: RequestInit, auth?: TransportAuth): Promise<Response>;
}

/** Where secrets live: the server vault (OS keychain) or an in-memory session store. */
export interface CredentialStore {
  get(ref: string): Promise<string | undefined>;
  set?(ref: string, secret: string, label?: string): Promise<void>;
  delete?(ref: string): Promise<void>;
  list?(): Promise<{ ref: string; label?: string; updatedAt?: string }[]>;
}
