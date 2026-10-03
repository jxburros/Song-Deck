/**
 * Song Deck generic local-model HTTP contracts (spec §31, §34, §26, §36, §42).
 *
 * Bridge scripts wrap local engines — ACE-Step (music), DiffSinger (singing), Demucs (separation),
 * Basic Pitch (transcription), RVC (voice conversion), Matchering-style mastering — behind these
 * small JSON/HTTP contracts so the orchestrator never depends on a specific engine.
 *
 * General rules for every bridge
 * ------------------------------
 * - Base URL is configurable (presets use http://127.0.0.1:8810-8815). All paths are relative to it.
 * - Requests are `application/json`, UTF-8. Audio inside JSON is base64 (standard alphabet, no data:
 *   prefix) of a complete WAV file (PCM 16/24-bit or 32-bit float; any sample rate, mono or stereo).
 * - Endpoints documented as returning audio respond `200` with `Content-Type: audio/wav` and the
 *   WAV bytes. Bridges MAY add `X-Seed: <int>` and `X-Model: <id>` response headers.
 * - Errors: non-2xx status with JSON `{ "error": "<message>" }`. Use 400 for invalid input, 404 for
 *   unknown voice/model ids, 409 when busy and not queueing, 501 for unsupported operations, 503 when
 *   the model is still loading. 429/5xx are retried by Song Deck (max 2) — they must be idempotent.
 * - Optional bearer auth: if the bridge is started with a token, it checks `Authorization: Bearer <token>`.
 * - Long jobs: requests may take minutes; Song Deck aborts the HTTP request on cancel (bridges should
 *   stop work when the client disconnects) and may additionally call `POST /cancel`.
 * - Times are seconds (floats); pitches are MIDI note numbers (60 = C4); velocities 1..127;
 *   expression values 0..1 unless noted.
 */
import type { Capability } from './capabilities';

// ---------------------------------------------------------------------------
// Music generation bridge (ACE-Step, custom audio models)
// ---------------------------------------------------------------------------

export const MUSIC_BRIDGE_PATHS = {
  /** GET → MusicBridgeInfo */
  info: '/info',
  /** POST MusicBridgeGenerateRequest → audio/wav */
  generate: '/generate',
  /** POST MusicBridgeTransformRequest → audio/wav (audio-to-audio) */
  transform: '/transform',
  /** POST MusicBridgeInpaintRequest → audio/wav (regenerate a time range) */
  inpaint: '/inpaint',
  /** POST MusicBridgeExtendRequest → audio/wav (OPTIONAL; only if OUTPAINTING is advertised) */
  extend: '/extend',
  /** POST { job_id?: string } → 204 (best-effort cancel of the running job) */
  cancel: '/cancel',
} as const;

export interface MusicBridgeInfo {
  name: string;
  version: string;
  models: { id: string; name: string }[];
  /** Song Deck capability names, e.g. ["TEXT_TO_MUSIC","LYRIC_CONDITIONING","AUDIO_TO_AUDIO","INPAINTING"]. */
  capabilities: Capability[] | string[];
  hardware?: { min_vram_gb: number };
}

export interface MusicBridgeSection {
  name: string;
  start_seconds: number;
  end_seconds: number;
  prompt?: string;
}

export interface MusicBridgeGenerateRequest {
  prompt: string;
  negative_prompt?: string;
  /** Lyrics with section tags allowed, e.g. "[verse]\nline one\nline two\n\n[chorus]\n…". */
  lyrics?: string;
  duration_seconds: number;
  seed?: number;
  bpm?: number;
  /** e.g. "E minor" */
  key?: string;
  sections?: MusicBridgeSection[];
  reference_audio_base64?: string;
  /** Guide render the output should follow (spec §28). */
  guide_audio_base64?: string;
  /** 0..1 how far the output may depart from guide/reference audio. */
  strength?: number;
  instrumental?: boolean;
  /** Optional model id from /info. */
  model?: string;
}

export interface MusicBridgeTransformRequest {
  audio_base64: string;
  prompt: string;
  strength: number;
  seed?: number;
  model?: string;
}

export interface MusicBridgeInpaintRequest {
  audio_base64: string;
  start_seconds: number;
  end_seconds: number;
  prompt: string;
  seed?: number;
  model?: string;
}

export interface MusicBridgeExtendRequest {
  audio_base64: string;
  prompt: string;
  /** Seconds to add at the end. */
  duration_seconds: number;
  seed?: number;
  model?: string;
}

// ---------------------------------------------------------------------------
// Singing synthesis bridge (DiffSinger / OpenVPI)
// ---------------------------------------------------------------------------

export const SINGING_BRIDGE_PATHS = {
  /** GET → SingingBridgeVoice[] */
  voices: '/voices',
  /** POST SingingBridgeRequest → audio/wav covering 0 … end of last note */
  synthesize: '/synthesize',
  /** POST SingingBridgePhraseRequest → audio/wav covering ONLY [start_seconds, end_seconds] */
  regeneratePhrase: '/regenerate_phrase',
} as const;

export interface SingingBridgeVoice {
  id: string;
  name: string;
  /** soprano | mezzo | alto | tenor | baritone | bass */
  voice_type: string;
  /** BCP-47 language, e.g. "en", "ja", "zh". */
  language: string;
  /** stock | user-trained | imported | third-party (spec §36). */
  kind: string;
}

export interface SingingBridgeExpression {
  breathiness?: number;
  tension?: number;
  /** vibrato depth 0..1 */
  vibrato?: number;
  /** Hz */
  vibrato_rate?: number;
  /** soft | normal | hard | scoop */
  onset?: string;
  /** normal | falling | rising | breathy | cut */
  release?: string;
  energy?: number;
}

export interface SingingBridgeNote {
  pitch: number;
  start_seconds: number;
  duration_seconds: number;
  /** Syllable; "-" marks word continuation, "_" a melisma continuation (sustain previous vowel). */
  lyric: string;
  /** ARPAbet-like phonemes when known (bridge falls back to its own G2P). */
  phonemes?: string[];
  velocity: number;
  expression?: SingingBridgeExpression;
}

export interface SingingBridgeRequest {
  voice_id: string;
  tempo_bpm: number;
  sample_rate: number;
  seed: number;
  notes: SingingBridgeNote[];
  language?: string;
}

export interface SingingBridgePhraseRequest extends SingingBridgeRequest {
  start_seconds: number;
  end_seconds: number;
}

// ---------------------------------------------------------------------------
// Transcription bridge (Basic Pitch)
// ---------------------------------------------------------------------------

export const TRANSCRIPTION_BRIDGE_PATHS = {
  /** POST TranscriptionBridgeRequest → TranscriptionBridgeResponse */
  transcribe: '/transcribe',
} as const;

export interface TranscriptionBridgeRequest {
  audio_base64: string;
  /** What the audio is: mix | vocals | bass | drums | piano | guitar | melody | other */
  source: string;
}

export interface TranscriptionBridgeResponse {
  notes: { pitch: number; start: number; end: number; velocity: number; confidence: number }[];
  tempo?: number;
  key?: string;
  chords?: { symbol: string; start: number; end: number; confidence?: number }[];
}

// ---------------------------------------------------------------------------
// Separation bridge (Demucs)
// ---------------------------------------------------------------------------

export const SEPARATION_BRIDGE_PATHS = {
  /** POST SeparationBridgeRequest → SeparationBridgeResponse */
  separate: '/separate',
} as const;

export interface SeparationBridgeRequest {
  audio_base64: string;
  /** Requested stems, default ["drums","bass","vocals","other"] (htdemucs_6s adds "guitar","piano"). */
  stems: string[];
}

export interface SeparationBridgeResponse {
  /** stem name → base64 WAV */
  stems: Record<string, string>;
  /** e.g. "htdemucs_ft" */
  model: string;
}

// ---------------------------------------------------------------------------
// Voice conversion bridge (RVC) — consent is enforced by Song Deck before calling (spec §36)
// ---------------------------------------------------------------------------

export const VOICE_CONVERSION_BRIDGE_PATHS = {
  /** POST VoiceConversionBridgeRequest → audio/wav */
  convert: '/convert',
  /** GET → SingingBridgeVoice[] (OPTIONAL) */
  voices: '/voices',
} as const;

export interface VoiceConversionBridgeRequest {
  audio_base64: string;
  target_voice_id: string;
  /** Semitones (e.g. +12 male → female). */
  pitch_shift?: number;
}

// ---------------------------------------------------------------------------
// Mastering bridge
// ---------------------------------------------------------------------------

export const MASTERING_BRIDGE_PATHS = {
  /** POST MasteringBridgeRequest → audio/wav */
  master: '/master',
} as const;

export interface MasteringBridgeRequest {
  audio_base64: string;
  /** streaming | cd | loud-rock | dynamic | podcast | demo */
  target: string;
  reference_audio_base64?: string;
}
