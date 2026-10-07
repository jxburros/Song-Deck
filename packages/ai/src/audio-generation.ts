/**
 * AI audio generation catalog: what each kind of audio engine can make, which inputs Song Deck
 * sends to it (and which it ignores), and which of its own settings can be changed.
 *
 * This is the single readable description of the audio pipeline the studio's AI Audio area shows.
 * It mirrors what the adapters really do (adapters/*.ts) — when an adapter changes the inputs it
 * sends, update its profile here. Self-describing engines (local music bridges, the managed
 * gateway) are resolved against the capabilities they report, so the table matches the connected
 * model rather than the preset's defaults.
 */
import type { Capability } from './capabilities';
import type { ProviderConfig } from './config';
import { getPreset } from './presets';
import type { AdapterKind, DataKind } from './types';

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** One kind of audio an engine can produce. */
export type AudioProcessId =
  | 'text-to-music'
  | 'song-with-vocals'
  | 'follow-guide'
  | 'transform'
  | 'extend'
  | 'inpaint'
  | 'render-composition'
  | 'singing'
  | 'voice-conversion'
  | 'instrument-render';

export interface AudioProcessInfo {
  id: AudioProcessId;
  label: string;
  description: string;
  /** Where in Song Deck this process is used. */
  usedIn: string;
  /** The engine qualifies when it has every capability of any one of these sets. */
  requires: Capability[][];
}

export const AUDIO_PROCESSES: readonly AudioProcessInfo[] = [
  {
    id: 'follow-guide',
    label: 'Perform your composition',
    description:
      'Produces audio that follows the guide render of your song (its notes, chords and timing), not a lookalike.',
    usedIn: 'Sound → Make an audio version; More tools → Production (strategies A and B)',
    requires: [['AUDIO_TO_AUDIO'], ['TEXT_TO_MUSIC', 'STEM_CONDITIONING']],
  },
  {
    id: 'song-with-vocals',
    label: 'Full song with sung lyrics',
    description: 'Generates a whole song, singing your lyrics section by section.',
    usedIn: 'Sound → Make an audio version; More tools → Production (strategy A)',
    requires: [['TEXT_TO_MUSIC', 'LYRIC_CONDITIONING', 'VOCAL_GENERATION']],
  },
  {
    id: 'text-to-music',
    label: 'Music from a description',
    description:
      'Generates music from style words, tempo, key and structure. It will not follow your exact notes.',
    usedIn: 'More tools → Production when no guided engine is connected',
    requires: [['TEXT_TO_MUSIC']],
  },
  {
    id: 'transform',
    label: 'Restyle a recording or stem',
    description: 'Turns an input recording (a reference stem from the guide render) into produced audio.',
    usedIn: 'More tools → Production (strategies B and C, one stem at a time)',
    requires: [['AUDIO_TO_AUDIO']],
  },
  {
    id: 'inpaint',
    label: 'Regenerate a region',
    description: 'Replaces only the selected bars inside an existing take and keeps the rest.',
    usedIn: 'More tools → Production → Regenerate region',
    requires: [['INPAINTING']],
  },
  {
    id: 'extend',
    label: 'Extend audio',
    description: 'Continues existing audio for a number of seconds.',
    usedIn: 'Available to the production pipeline when the engine offers it',
    requires: [['OUTPAINTING']],
  },
  {
    id: 'render-composition',
    label: 'Render the MIDI as audio',
    description: 'Plays your exact MIDI with production presets. No neural model; deterministic by seed.',
    usedIn: 'More tools → Production (fallback when nothing else is connected)',
    requires: [['MIDI_CONDITIONING', 'STEM_OUTPUT']],
  },
  {
    id: 'singing',
    label: 'Sing a vocal part',
    description: 'Sings the vocal melody with your lyrics, syllable by syllable, in a chosen voice.',
    usedIn: 'More tools → Vocals → Render; Production strategy C (“Singing synthesis” tracks)',
    requires: [['SINGING_SYNTHESIS']],
  },
  {
    id: 'voice-conversion',
    label: 'Change the voice of a vocal',
    description: 'Converts a sung vocal to another authorized voice, keeping the performance.',
    usedIn: 'More tools → Vocals → Conversion',
    requires: [['VOICE_CONVERSION']],
  },
  {
    id: 'instrument-render',
    label: 'Play MIDI through instrument plugins',
    description: 'Renders a track through an installed VST3, AU, CLAP, LV2, SF2 or SFZ instrument.',
    usedIn: 'More tools → Inspector → Instrument; Production strategy C (sampled tracks)',
    requires: [['INSTRUMENT_PLUGIN_HOST']],
  },
];

export function audioProcessInfo(id: AudioProcessId): AudioProcessInfo {
  return AUDIO_PROCESSES.find((p) => p.id === id)!;
}

/** Processes an engine qualifies for from its capabilities (before adapter limits). */
export function processesForCapabilities(caps: readonly Capability[]): AudioProcessId[] {
  const set = new Set(caps);
  return AUDIO_PROCESSES.filter((p) => p.requires.some((need) => need.every((c) => set.has(c)))).map(
    (p) => p.id,
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** An input Song Deck can send with an audio generation. */
export type AudioInputId =
  | 'prompt'
  | 'negative-prompt'
  | 'lyrics'
  | 'sections'
  | 'duration'
  | 'tempo-key'
  | 'seed'
  | 'guide-audio'
  | 'reference-audio'
  | 'strength'
  | 'instrumental'
  | 'takes'
  | 'composition'
  | 'input-audio'
  | 'region'
  | 'melody'
  | 'voice'
  | 'expression'
  | 'pitch-shift'
  | 'midi-performance'
  | 'plugin-state';

export type AudioInputGroup = 'music' | 'vocals' | 'instruments';

export interface AudioInputInfo {
  id: AudioInputId;
  label: string;
  /** What Song Deck fills it with. */
  source: string;
  group: AudioInputGroup;
  /** Project data that leaves the device when this input is sent (privacy indicator). */
  dataKind?: DataKind;
}

export const AUDIO_INPUTS: readonly AudioInputInfo[] = [
  {
    id: 'prompt',
    label: 'Style prompt',
    source: 'Genre, moods, instruments and production words from the song, plus any prompt you add.',
    group: 'music',
    dataKind: 'song-description',
  },
  {
    id: 'negative-prompt',
    label: 'Avoid list',
    source: 'The production “avoid” words (and “vocals” for instrumental takes).',
    group: 'music',
    dataKind: 'song-description',
  },
  {
    id: 'lyrics',
    label: 'Lyrics',
    source: 'The song’s lyrics, tagged by section ([Verse], [Chorus]…).',
    group: 'music',
    dataKind: 'lyrics',
  },
  {
    id: 'sections',
    label: 'Sections and timing',
    source: 'Each section’s name, start and end time, energy and its own section prompt.',
    group: 'music',
    dataKind: 'project-metadata',
  },
  {
    id: 'duration',
    label: 'Length',
    source: 'The song (or region) length in seconds.',
    group: 'music',
  },
  {
    id: 'tempo-key',
    label: 'Tempo, key and meter',
    source: 'Tempo, key and time signature at the start of the song or region.',
    group: 'music',
    dataKind: 'project-metadata',
  },
  {
    id: 'seed',
    label: 'Seed',
    source: 'The candidate’s seed, so a take can be reproduced.',
    group: 'music',
  },
  {
    id: 'guide-audio',
    label: 'Guide render',
    source: 'Your composition played by on-device instruments (whole mix, or one stem).',
    group: 'music',
    dataKind: 'guide-audio',
  },
  {
    id: 'reference-audio',
    label: 'Reference audio',
    source: 'A recording you attach in Production to steer the sound (only if you allow upload).',
    group: 'music',
    dataKind: 'reference-audio',
  },
  {
    id: 'strength',
    label: 'Strength',
    source: 'Production → Strength: how far the result may depart from the guide (0–1).',
    group: 'music',
  },
  {
    id: 'instrumental',
    label: 'Instrumental switch',
    source: 'On for instrumental songs and for every non-vocal stem.',
    group: 'music',
  },
  {
    id: 'takes',
    label: 'Several takes per request',
    source: 'Extra takes returned by one request become additional candidates.',
    group: 'music',
  },
  {
    id: 'composition',
    label: 'Full composition',
    source: 'The whole song (MIDI tracks, sections, tempo map, lyrics).',
    group: 'music',
    dataKind: 'midi',
  },
  {
    id: 'input-audio',
    label: 'Audio to transform',
    source: 'A reference stem or an existing take.',
    group: 'music',
    dataKind: 'guide-audio',
  },
  {
    id: 'region',
    label: 'Region',
    source: 'Start and end of the bars you chose to regenerate.',
    group: 'music',
  },
  {
    id: 'melody',
    label: 'Vocal melody and syllables',
    source: 'The vocal track’s notes, each with its lyric syllable (and phonemes when known).',
    group: 'vocals',
    dataKind: 'midi',
  },
  {
    id: 'voice',
    label: 'Voice',
    source: 'The singer or target voice you picked (consent is required for custom voices).',
    group: 'vocals',
  },
  {
    id: 'expression',
    label: 'Expression',
    source: 'Vibrato, breathiness, dynamics and other per-note expression from Vocals → Expression.',
    group: 'vocals',
  },
  {
    id: 'pitch-shift',
    label: 'Pitch shift',
    source: 'Semitones to move the converted vocal.',
    group: 'vocals',
  },
  {
    id: 'midi-performance',
    label: 'MIDI performance',
    source: 'The track’s notes and controllers as timed MIDI events.',
    group: 'instruments',
    dataKind: 'midi',
  },
  {
    id: 'plugin-state',
    label: 'Plugin preset and parameters',
    source: 'The plugin state saved in the project (preset, parameters).',
    group: 'instruments',
  },
];

export function audioInputInfo(id: AudioInputId): AudioInputInfo {
  return AUDIO_INPUTS.find((i) => i.id === id)!;
}

/** How an engine treats an input. */
export type InputSupport = 'used' | 'partial' | 'ignored';

export interface InputUse {
  support: InputSupport;
  /** How it is sent or why it is not. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AudioSettingInfo {
  /** `config.extra` key, or a top-level config field prefixed with `config.` (e.g. `config.defaultModel`). */
  key: string;
  label: string;
  description: string;
  /** Value used when nothing is set. */
  defaultValue?: string | number;
  /** Known choices (free text otherwise). */
  options?: string[];
}

export interface AudioSettingValue extends AudioSettingInfo {
  /** Current value from the provider config (undefined = default). */
  value?: string | number | boolean | string[];
}

// ---------------------------------------------------------------------------
// Engine profiles
// ---------------------------------------------------------------------------

export interface AudioEngineProfile {
  /** One-line summary of the engine's role in the pipeline. */
  summary: string;
  /** Processes the adapter implements (narrowed by the engine's capabilities). */
  processes: AudioProcessId[];
  /** Inputs per group; inputs not listed are not part of this engine's request. */
  inputs: Partial<Record<AudioInputId, InputUse>>;
  /** Adapter settings that can be changed in Settings → AI services. */
  settings: AudioSettingInfo[];
  /** What comes back. */
  output: string;
  /** Hard limits worth knowing before generating. */
  limits: string[];
  /** Inputs and processes depend on what the connected model reports. */
  selfDescribing?: boolean;
}

const MODEL_SETTING: AudioSettingInfo = {
  key: 'config.defaultModel',
  label: 'Model',
  description: 'Model used unless Production picks another one.',
};

const IGNORED_SEED: InputUse = {
  support: 'ignored',
  note: 'The service has no seed: takes are not reproducible.',
};
const NO_GUIDE: InputUse = {
  support: 'ignored',
  note: 'Cannot listen to audio: the result follows the description, not your notes.',
};
const NO_REFERENCE: InputUse = { support: 'ignored', note: 'Reference audio is never sent to this engine.' };

const MUSIC_PROFILES: Partial<Record<AdapterKind, AudioEngineProfile>> = {
  'elevenlabs-music': {
    summary:
      'Generates a full song from a composition plan built from your sections, lyrics and styles. It does not hear the guide.',
    processes: ['text-to-music', 'song-with-vocals'],
    inputs: {
      prompt: { support: 'used', note: 'Becomes the plan’s global styles (with tempo and key words).' },
      'negative-prompt': { support: 'used', note: 'Becomes negative global styles.' },
      lyrics: { support: 'used', note: 'Lines are placed in their sections (up to 200 characters a line).' },
      sections: {
        support: 'used',
        note: 'One plan section per song section with its duration, energy and section prompt (3 s – 120 s each).',
      },
      duration: { support: 'used', note: 'Section durations add up to the song length (10 s – 5 min).' },
      'tempo-key': {
        support: 'partial',
        note: 'Sent as style words (“92 bpm”, “E minor”); meter is not sent.',
      },
      instrumental: {
        support: 'used',
        note: 'Forces an instrumental (adds “vocals” to the negative styles).',
      },
      seed: IGNORED_SEED,
      'guide-audio': NO_GUIDE,
      'reference-audio': NO_REFERENCE,
      strength: { support: 'ignored', note: 'Nothing to depart from: no audio input.' },
      takes: { support: 'ignored', note: 'One take per request.' },
    },
    settings: [
      MODEL_SETTING,
      {
        key: 'outputFormat',
        label: 'Output format',
        description: 'ElevenLabs output_format: codec, sample rate and bitrate of the returned audio.',
        defaultValue: 'mp3_44100_128',
        options: ['mp3_44100_128', 'mp3_44100_192', 'pcm_44100'],
      },
    ],
    output: 'One stereo mix (MP3 by default, PCM WAV when chosen).',
    limits: ['10 seconds to 5 minutes per song', 'Billed per minute generated'],
  },
  'stability-audio': {
    summary:
      'Stable Audio: text-to-audio, or audio-to-audio from the guide render so the result follows your composition.',
    processes: ['text-to-music', 'follow-guide', 'transform'],
    inputs: {
      prompt: { support: 'used' },
      'negative-prompt': { support: 'partial', note: 'Appended to the prompt as “Avoid: …”.' },
      duration: { support: 'used', note: '1 – 190 seconds.' },
      seed: { support: 'used' },
      'guide-audio': { support: 'used', note: 'Sent as the audio-to-audio input (guide mix or one stem).' },
      'input-audio': { support: 'used', note: 'Audio-to-audio input for stem production.' },
      strength: { support: 'used', note: '0 keeps the guide, 1 ignores it (default 0.6).' },
      lyrics: { support: 'ignored', note: 'Cannot sing lyrics; use a singing engine for the vocal.' },
      sections: { support: 'partial', note: 'Section prompts are folded into the one prompt.' },
      'tempo-key': { support: 'ignored', note: 'Follows the guide’s tempo and key when one is sent.' },
      instrumental: { support: 'partial', note: 'Always instrumental.' },
      'reference-audio': NO_REFERENCE,
      takes: { support: 'ignored', note: 'One take per request.' },
    },
    settings: [
      MODEL_SETTING,
      {
        key: 'outputFormat',
        label: 'Output format',
        description: 'Format of the returned audio.',
        defaultValue: 'wav',
        options: ['wav', 'mp3'],
      },
      { key: 'steps', label: 'Diffusion steps', description: 'More steps: slower, sometimes cleaner.' },
      { key: 'cfgScale', label: 'CFG scale', description: 'How strictly the prompt is followed.' },
      {
        key: 'textToAudioPath',
        label: 'Text-to-audio path',
        description: 'Override the endpoint path (for new model versions).',
        defaultValue: 'audio/stable-audio-2/text-to-audio',
      },
      {
        key: 'audioToAudioPath',
        label: 'Audio-to-audio path',
        description: 'Override the endpoint path (for new model versions).',
        defaultValue: 'audio/stable-audio-2/audio-to-audio',
      },
    ],
    output: 'One stereo clip (WAV by default).',
    limits: ['Up to 190 seconds per generation', 'No vocals'],
  },
  'google-lyria': {
    summary: 'Google Lyria on Vertex AI: short instrumental clips from a description.',
    processes: ['text-to-music'],
    inputs: {
      prompt: { support: 'used' },
      'negative-prompt': { support: 'used', note: 'Sent as negative_prompt.' },
      seed: { support: 'used', note: 'With a seed, only one take is returned.' },
      takes: { support: 'used', note: 'Up to 4 takes per request when no seed is set.' },
      duration: {
        support: 'ignored',
        note: 'Always about 30 seconds; longer songs are made section by section.',
      },
      lyrics: { support: 'ignored', note: 'Instrumental only.' },
      sections: { support: 'partial', note: 'Section prompts are folded into the one prompt.' },
      'tempo-key': { support: 'partial', note: 'Only as words inside the prompt.' },
      instrumental: { support: 'partial', note: 'Always instrumental.' },
      'guide-audio': NO_GUIDE,
      'reference-audio': NO_REFERENCE,
      strength: { support: 'ignored' },
    },
    settings: [
      MODEL_SETTING,
      {
        key: 'vertexProject',
        label: 'Google Cloud project',
        description: 'Project id with the Vertex AI API enabled (required).',
      },
      {
        key: 'vertexLocation',
        label: 'Vertex location',
        description: 'Region that serves Lyria.',
        defaultValue: 'us-central1',
      },
    ],
    output: 'WAV clips of about 30 seconds.',
    limits: ['~30 s per clip', 'Instrumental only'],
  },
  'minimax-music': {
    summary: 'MiniMax Music: full songs with vocals from tagged lyrics and a style prompt.',
    processes: ['text-to-music', 'song-with-vocals'],
    inputs: {
      prompt: { support: 'used', note: 'Up to 2,000 characters.' },
      'negative-prompt': { support: 'partial', note: 'Appended to the prompt as “avoid: …”.' },
      lyrics: {
        support: 'used',
        note: 'Tagged [Verse]/[Chorus]… from your sections, up to 3,500 characters.',
      },
      sections: { support: 'partial', note: 'Only as lyric tags; section lengths are not sent.' },
      'tempo-key': { support: 'partial', note: 'Added to the prompt (“92 BPM, key of E minor, 6/8 time”).' },
      instrumental: { support: 'used', note: 'Sent as is_instrumental when there are no lyrics.' },
      duration: { support: 'ignored', note: 'MiniMax decides the length (up to about 5 minutes).' },
      seed: IGNORED_SEED,
      'guide-audio': NO_GUIDE,
      'reference-audio': NO_REFERENCE,
      strength: { support: 'ignored' },
      takes: { support: 'ignored', note: 'One take per request.' },
    },
    settings: [
      MODEL_SETTING,
      {
        key: 'outputFormat',
        label: 'Output format',
        description: 'Format of the returned audio (44.1 kHz).',
        defaultValue: 'mp3',
        options: ['mp3', 'wav'],
      },
      {
        key: 'generatePath',
        label: 'Endpoint path',
        description: 'Override the generation path.',
        defaultValue: 'music_generation',
      },
    ],
    output: 'One mix (MP3 by default).',
    limits: ['Length chosen by the model', 'Lyrics up to 3,500 characters'],
  },
  mureka: {
    summary: 'Mureka: songs with vocals from lyrics, or instrumentals from a prompt; several takes at once.',
    processes: ['text-to-music', 'song-with-vocals'],
    inputs: {
      prompt: { support: 'used', note: 'Up to 1,000 characters.' },
      'negative-prompt': { support: 'partial', note: 'Appended to the prompt as “avoid: …”.' },
      lyrics: { support: 'used', note: 'Tagged by section, up to 5,000 characters.' },
      sections: { support: 'partial', note: 'Only as lyric tags; section lengths are not sent.' },
      'tempo-key': { support: 'partial', note: 'Added to the prompt.' },
      instrumental: { support: 'used', note: 'Uses the instrumental endpoint.' },
      takes: { support: 'used', note: 'Up to 3 takes per request.' },
      duration: { support: 'ignored', note: 'Mureka decides the length.' },
      seed: IGNORED_SEED,
      'guide-audio': NO_GUIDE,
      'reference-audio': NO_REFERENCE,
      strength: { support: 'ignored' },
    },
    settings: [
      MODEL_SETTING,
      {
        key: 'outputFormat',
        label: 'Preferred download',
        description: 'Download the FLAC version when Mureka offers one.',
        defaultValue: 'mp3',
        options: ['mp3', 'flac'],
      },
      {
        key: 'pollIntervalMs',
        label: 'Poll interval (ms)',
        description: 'How often a running task is checked.',
        defaultValue: 5000,
      },
      {
        key: 'downloadHosts',
        label: 'Download hosts',
        description: 'Hosts the local server may download finished audio from.',
        defaultValue: '*.mureka.ai',
      },
    ],
    output: 'Up to 3 mixes per request (MP3, or FLAC when preferred).',
    limits: ['Asynchronous: may take several minutes', 'Length chosen by the model'],
  },
  managed: {
    summary:
      'Automatic: the Song Deck server picks one of its own audio engines per request; the inputs are forwarded as is.',
    processes: ['text-to-music', 'song-with-vocals', 'follow-guide', 'transform', 'singing'],
    selfDescribing: true,
    inputs: {},
    settings: [],
    output: 'Whatever the chosen engine returns.',
    limits: ['Choice depends on the server’s configured engines and your privacy settings'],
  },
  'local-music': {
    summary:
      'A local model behind the Song Deck music bridge (ACE-Step, YuE, DiffRhythm, MusicGen, Stable Audio Open or your own).',
    processes: ['text-to-music', 'song-with-vocals', 'follow-guide', 'transform', 'inpaint', 'extend'],
    selfDescribing: true,
    inputs: {},
    settings: [
      MODEL_SETTING,
      {
        key: 'config.baseUrl',
        label: 'Bridge address',
        description: 'Where the bridge listens (GET /info reports what it supports).',
      },
    ],
    output: 'WAV from the bridge; the seed and model used come back in headers.',
    limits: ['Runs on your hardware: speed and length depend on the GPU'],
  },
};

const SINGING_PROFILE: AudioEngineProfile = {
  summary: 'Sings the vocal track: one request per vocal part, phrase by phrase when regenerating.',
  processes: ['singing'],
  inputs: {
    melody: { support: 'used', note: 'Pitch, timing, velocity and lyric (with phonemes) for every note.' },
    voice: { support: 'used', note: 'One of the voices the engine lists.' },
    expression: { support: 'used', note: 'Per-note expression curves.' },
    'tempo-key': { support: 'partial', note: 'Tempo only.' },
    seed: { support: 'used' },
    region: { support: 'used', note: 'Phrase regeneration sends the phrase’s start and end.' },
  },
  settings: [MODEL_SETTING],
  output: 'One dry vocal (WAV), aligned to the song.',
  limits: ['Language depends on the voice bank'],
};

const ENGINE_PROFILES: Partial<Record<AdapterKind, AudioEngineProfile>> = {
  ...MUSIC_PROFILES,
  'singing-http': SINGING_PROFILE,
  'voice-conversion-http': {
    summary: 'Converts a sung vocal to another voice (RVC and compatible bridges).',
    processes: ['voice-conversion'],
    inputs: {
      'input-audio': { support: 'used', note: 'The vocal recording or rendered vocal.' },
      voice: { support: 'used', note: 'Target voice; custom voices need recorded consent.' },
      'pitch-shift': { support: 'used', note: 'In semitones.' },
    },
    settings: [MODEL_SETTING],
    output: 'The converted vocal (WAV), same length as the input.',
    limits: ['Only voices you are authorized to use'],
  },
  'plugin-host-http': {
    summary: 'Plays MIDI tracks through your installed instrument plugins and freezes them to audio.',
    processes: ['instrument-render'],
    inputs: {
      'midi-performance': { support: 'used', note: 'Notes and controllers in seconds.' },
      'plugin-state': { support: 'used', note: 'Preset and parameters saved in the project.' },
      duration: { support: 'used', note: 'Track length plus the plugin’s tail.' },
    },
    settings: [
      { key: 'config.baseUrl', label: 'Host address', description: 'Where the plugin host listens.' },
    ],
    output: 'One stereo stem per track (latency compensated).',
    limits: ['Plugin editors open on the computer running the host'],
  },
};

/** Profiles of Song Deck's own on-device audio engines, by provider id. */
const INTERNAL_PROFILES: Record<string, AudioEngineProfile> = {
  'internal-producer': {
    summary:
      'Song Deck’s own DSP producer: performs your exact MIDI with production presets. Offline, free, deterministic.',
    processes: ['render-composition', 'transform'],
    inputs: {
      composition: { support: 'used', note: 'Renders the song itself, including audio clips.' },
      seed: { support: 'used', note: 'Varies timing, dynamics and per-note detail.' },
      'input-audio': { support: 'used', note: 'Stem polish: glue compression, tone and width.' },
      prompt: { support: 'ignored', note: 'Not a neural model: style words are not used.' },
      lyrics: { support: 'ignored', note: 'Use a singing engine for the vocal.' },
      'reference-audio': { support: 'ignored' },
    },
    settings: [],
    output: 'A mastered stereo mix or per-stem WAVs.',
    limits: ['Placeholder quality compared to neural models'],
  },
  'internal-singer': {
    ...SINGING_PROFILE,
    summary: 'Built-in formant singer: placeholder-quality vocals from the melody and lyrics, offline.',
    settings: [],
  },
};

// ---------------------------------------------------------------------------
// Resolution against a connected engine
// ---------------------------------------------------------------------------

/** Inputs of a self-describing music engine, from the capabilities it reports. */
export function inputsFromCapabilities(
  caps: readonly Capability[],
  adapter: AdapterKind,
): Partial<Record<AudioInputId, InputUse>> {
  const has = (c: Capability) => caps.includes(c);
  const guided = has('AUDIO_TO_AUDIO') || has('STEM_CONDITIONING');
  const lyricNote = 'Sent with [section] tags.';
  const inputs: Partial<Record<AudioInputId, InputUse>> = {
    prompt: { support: 'used' },
    'negative-prompt': { support: 'used' },
    duration: { support: 'used' },
    seed: { support: 'used' },
    'tempo-key': { support: 'used', note: 'Tempo and key; the meter is not sent.' },
    sections: has('SECTION_GENERATION')
      ? { support: 'used', note: 'Name, start, end and section prompt.' }
      : { support: 'partial', note: 'Sent, but the model reports no section awareness.' },
    lyrics: has('LYRIC_CONDITIONING')
      ? { support: 'used', note: lyricNote }
      : { support: 'ignored', note: 'The model cannot sing lyrics.' },
    instrumental: has('INSTRUMENTAL_ONLY')
      ? { support: 'used' }
      : { support: 'partial', note: 'Sent; the model does not report an instrumental mode.' },
    'guide-audio': guided
      ? { support: 'used', note: 'Base64 WAV of the guide (mix or stem).' }
      : { support: 'ignored', note: 'The model does not report audio conditioning.' },
    strength: guided ? { support: 'used' } : { support: 'ignored' },
    'reference-audio': has('REFERENCE_AUDIO')
      ? { support: 'used', note: 'Only when you allow reference upload.' }
      : { support: 'ignored', note: 'The model does not report reference audio.' },
    'input-audio': has('AUDIO_TO_AUDIO') ? { support: 'used' } : { support: 'ignored' },
    region: has('INPAINTING')
      ? { support: 'used', note: 'Start and end in seconds.' }
      : { support: 'ignored' },
    takes: { support: 'ignored', note: 'One take per request.' },
  };
  if (adapter === 'managed') {
    // The gateway forwards the whole request; the server's engine decides what it uses.
    for (const k of Object.keys(inputs) as AudioInputId[])
      if (inputs[k]!.support === 'used')
        inputs[k] = { support: 'used', note: 'Forwarded to the chosen engine.' };
  }
  return inputs;
}

export interface AudioEngineView {
  id: string;
  name: string;
  adapter: AdapterKind;
  location: 'cloud' | 'local' | 'internal';
  summary: string;
  processes: AudioProcessId[];
  inputs: { input: AudioInputInfo; use: InputUse }[];
  settings: AudioSettingValue[];
  output: string;
  limits: string[];
  selfDescribing: boolean;
}

export interface AudioEngineSource {
  id: string;
  name: string;
  adapter: AdapterKind;
  location: 'cloud' | 'local' | 'internal';
  capabilities: readonly Capability[];
  config?: ProviderConfig;
}

/** Whether a provider produces audio at all (music, vocals or instruments). */
export function isAudioEngine(source: Pick<AudioEngineSource, 'id' | 'adapter' | 'capabilities'>): boolean {
  if (source.adapter === 'internal') return !!INTERNAL_PROFILES[source.id];
  if (!ENGINE_PROFILES[source.adapter]) return false;
  return processesForCapabilities(source.capabilities).length > 0 || source.adapter === 'managed';
}

function settingValue(config: ProviderConfig | undefined, key: string): AudioSettingValue['value'] {
  if (!config) return undefined;
  if (key.startsWith('config.')) {
    const v = (config as unknown as Record<string, unknown>)[key.slice(7)];
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
  }
  const v = config.extra?.[key];
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

/**
 * Describe one audio engine as connected: processes narrowed to what it reports, every input it
 * receives (or ignores) and its settings with their current values. Undefined for non-audio providers.
 */
export function describeAudioEngine(source: AudioEngineSource): AudioEngineView | undefined {
  const profile =
    source.adapter === 'internal' ? INTERNAL_PROFILES[source.id] : ENGINE_PROFILES[source.adapter];
  if (!profile) return undefined;
  const capable = new Set(processesForCapabilities(source.capabilities));
  // The managed gateway reports production capabilities generically; trust them as reported.
  const processes = profile.processes.filter((p) => capable.has(p));
  if (!processes.length && source.adapter !== 'managed') return undefined;
  const inputMap = profile.selfDescribing
    ? inputsFromCapabilities(source.capabilities, source.adapter)
    : { ...profile.inputs };
  // Fixed profiles assume the preset's capabilities; a user who removed one loses that input.
  if (!profile.selfDescribing) {
    const caps = new Set(source.capabilities);
    if (inputMap.lyrics?.support === 'used' && !caps.has('LYRIC_CONDITIONING'))
      inputMap.lyrics = { support: 'ignored', note: 'Lyric conditioning is turned off for this engine.' };
  }
  const inputs = AUDIO_INPUTS.filter((i) => inputMap[i.id]).map((i) => ({ input: i, use: inputMap[i.id]! }));
  return {
    id: source.id,
    name: source.name,
    adapter: source.adapter,
    location: source.location,
    // A bridge or gateway is described by what is behind it (ACE-Step, YuE…) when the preset says so.
    summary: (profile.selfDescribing && getPreset(source.config?.presetId)?.description) || profile.summary,
    processes,
    inputs,
    settings: profile.settings.map((s) => {
      const value = settingValue(source.config, s.key);
      return value === undefined ? { ...s } : { ...s, value };
    }),
    output: profile.output,
    limits: [...profile.limits],
    selfDescribing: !!profile.selfDescribing,
  };
}

/** The adapter-level profile (for engines not connected yet, e.g. the presets gallery). */
export function audioEngineProfile(
  adapter: AdapterKind,
  internalId?: string,
): AudioEngineProfile | undefined {
  return adapter === 'internal' && internalId ? INTERNAL_PROFILES[internalId] : ENGINE_PROFILES[adapter];
}
