import type {
  Articulation,
  DrumStyle,
  InstrumentFamily,
  MasteringTarget,
  ModeName,
  MusicalFunction,
  SectionKind,
  StemGroup,
  TrackRole,
} from '@songdeck/core';
import type { AdapterKind, PresetCategory, ProviderPreset, StructuredOutputMode } from '@songdeck/ai';

/** Enumerations used by the settings editors (kept here so Settings does not import other modes). */

export const SECTION_KINDS: SectionKind[] = ['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'bridge', 'breakdown', 'build', 'drop', 'solo', 'interlude', 'final-chorus', 'outro', 'custom'];

export const TRACK_ROLES: TrackRole[] = ['drums', 'percussion', 'bass', 'rhythm-guitar', 'lead-guitar', 'keys', 'strings', 'synth-pad', 'synth-arp', 'synth-lead', 'synth-seq', 'vocal', 'custom'];

export const FUNCTIONS: MusicalFunction[] = ['melody', 'counter-melody', 'harmony', 'accompaniment', 'bass-line', 'rhythm', 'pad', 'hook', 'fills', 'solo', 'texture'];

export const MODES: ModeName[] = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic-minor', 'melodic-minor'];

export const DRUM_STYLES: DrumStyle[] = [
  'rock',
  'punk',
  'pop-punk',
  'emo',
  'metal',
  'indie',
  'pop',
  'synth-pop',
  'four-on-floor',
  'trance',
  'hip-hop',
  'trap',
  'rnb',
  'jazz-swing',
  'folk',
  'country',
  'orchestral',
  'cinematic',
  'funk',
  'disco',
  'soul',
  'gospel',
  'shuffle',
  'boom-bap',
  'one-drop',
  'ska',
  'dembow',
  'bossa-nova',
  'samba',
  'salsa',
  'cumbia',
  'afrobeats',
  'amapiano',
  'drum-and-bass',
  'breakbeat',
  'dubstep',
  'techno',
  'two-step',
  'drill',
  'phonk',
  'jersey-club',
  'footwork',
  'baile-funk',
  'flamenco',
  'celtic',
  'bhangra',
  'ambient',
];

export const MASTERING_TARGETS: MasteringTarget[] = ['streaming', 'cd', 'loud-rock', 'dynamic', 'podcast', 'demo'];

export const FAMILIES: InstrumentFamily[] = ['drums', 'percussion', 'bass', 'guitar', 'keys', 'organ', 'strings', 'brass', 'woodwind', 'synth', 'vocal', 'fx', 'other'];

export const STEM_GROUPS: StemGroup[] = ['vocals', 'drums', 'bass', 'guitars', 'keys', 'strings', 'others'];

export const ARTICULATIONS: Articulation[] = ['normal', 'staccato', 'legato', 'accent', 'marcato', 'tenuto', 'palm-mute', 'pizzicato', 'tremolo', 'ghost', 'slide', 'bend', 'harmonic', 'dead'];

export const CLEFS = ['treble', 'bass', 'treble-8vb', 'percussion', 'grand'] as const;

export const STRUCTURED_MODES: { value: StructuredOutputMode; label: string; hint: string }[] = [
  { value: 'json_schema', label: 'JSON schema (native)', hint: 'Provider-enforced schema: OpenAI json_schema, Anthropic output_config, Gemini responseSchema, Ollama format, llama.cpp grammars.' },
  { value: 'json_object', label: 'JSON mode', hint: 'The model must answer JSON; the schema is described in the prompt.' },
  { value: 'prompt', label: 'Prompt only', hint: 'No API-level constraint — the schema is described in the prompt and the answer is repaired if needed.' },
];

export const ADAPTER_LABELS: Record<AdapterKind, string> = {
  'openai-compatible': 'OpenAI-compatible',
  anthropic: 'Anthropic Messages',
  gemini: 'Gemini API',
  ollama: 'Ollama',
  'custom-http': 'Custom HTTP template',
  'elevenlabs-music': 'ElevenLabs Music',
  'stability-audio': 'Stable Audio',
  'google-lyria': 'Vertex AI Lyria',
  'local-music': 'Music bridge',
  'singing-http': 'Singing bridge',
  'transcription-http': 'Transcription bridge',
  'separation-http': 'Separation bridge',
  'voice-conversion-http': 'Voice conversion bridge',
  'mastering-http': 'Mastering bridge',
  managed: 'Managed gateway',
  internal: 'On-device engine',
};

/** Gallery groups (spec §3, §4, §8, §30). */
export interface GalleryGroup {
  id: string;
  label: string;
  description: string;
  match: (p: ProviderPreset) => boolean;
}

const LOCAL_LLM_SERVERS = new Set(['ollama', 'llama-cpp', 'lm-studio', 'vllm']);
const CUSTOM_PRESETS = new Set(['custom-llm-http', 'custom-audio-http']);

export const GALLERY_GROUPS: GalleryGroup[] = [
  { id: 'llm-cloud', label: 'Cloud language models', description: 'Bring your own API key (spec §3, §7).', match: (p) => p.category === 'llm' && p.location === 'cloud' },
  { id: 'llm-local', label: 'Local LLM servers', description: 'Models on this machine — nothing leaves it (spec §4).', match: (p) => LOCAL_LLM_SERVERS.has(p.id) },
  { id: 'custom', label: 'Custom endpoints', description: 'Any compatible server, without waiting for an app update (spec §4.1).', match: (p) => CUSTOM_PRESETS.has(p.id) },
  { id: 'music', label: 'Music generation', description: 'Production providers (spec §30, §31).', match: (p) => p.category === 'music' && !CUSTOM_PRESETS.has(p.id) },
  { id: 'singing', label: 'Singing synthesis', description: 'Lyrics + vocal MIDI → sung vocals (spec §34).', match: (p) => p.category === 'singing' },
  { id: 'transcription', label: 'Transcription', description: 'Audio → notes (spec §26).', match: (p) => p.category === 'transcription' },
  { id: 'separation', label: 'Source separation', description: 'Mix → stems (spec §25 Rebuild).', match: (p) => p.category === 'separation' },
  { id: 'voice-conversion', label: 'Voice conversion', description: 'Authorized target voices only (spec §36).', match: (p) => p.category === 'voice-conversion' },
  { id: 'mastering', label: 'Mastering', description: 'Reference or target mastering (spec §42).', match: (p) => p.category === 'mastering' },
  { id: 'managed', label: 'Managed “Automatic”', description: 'Let the Song Deck service route for you (spec §8).', match: (p) => p.category === 'managed' },
];

export const PRESET_CATEGORY_LABEL: Record<PresetCategory, string> = {
  llm: 'Language model',
  music: 'Music generation',
  singing: 'Singing',
  transcription: 'Transcription',
  separation: 'Separation',
  'voice-conversion': 'Voice conversion',
  mastering: 'Mastering',
  managed: 'Managed',
};

export const PRIVACY_CONFIRM_OPTIONS = [
  { value: 'always', label: 'Always ask', hint: 'Confirm every AI request, even ones handled on this device.' },
  { value: 'cloud', label: 'Before data leaves this device', hint: 'Recommended: confirm every request to a cloud provider, with the data-flow indicator.' },
  { value: 'audio', label: 'Before audio leaves this device', hint: 'Only confirm cloud requests that contain recordings, stems or reference audio.' },
  { value: 'never', label: 'Never ask', hint: 'No confirmations. Never-upload rules and offline mode still apply.' },
] as const;
