/**
 * Task roles (spec §2.2, §6): what each role needs (capabilities + provider interface) and which
 * data it usually sends (privacy indicator defaults, spec §50).
 */
import type { Capability } from './capabilities';
import type { DataKind, ProviderInterfaceName, TaskRole } from './types';

export interface RoleInfo {
  label: string;
  description: string;
  /** Provider interface that performs the role. */
  interface: ProviderInterfaceName;
  /** Default capability requirements. */
  capabilities: Capability[];
  /** Data usually sent for this role. */
  dataKinds: DataKind[];
}

export const ROLE_INFO: Record<TaskRole, RoleInfo> = {
  composition: {
    label: 'Composition planner',
    description: 'Blueprints and composition plans (spec §10, §15).',
    interface: 'composition',
    capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING'],
    dataKinds: ['song-description', 'project-metadata'],
  },
  harmony: {
    label: 'Harmony assistant',
    description: 'Chord progressions, reharmonization, theory controls.',
    interface: 'composition',
    capabilities: ['MUSIC_THEORY_REASONING'],
    dataKinds: ['song-description', 'chord-progression'],
  },
  'midi-editing': {
    label: 'MIDI editor',
    description: 'Natural-language MIDI edits as structured operations (spec §20).',
    interface: 'composition',
    capabilities: ['MIDI_EDITING'],
    dataKinds: ['song-description', 'chord-progression', 'midi'],
  },
  lyrics: {
    label: 'Lyricist',
    description: 'Lyrics fitted to sections and syllable counts.',
    interface: 'composition',
    capabilities: ['LYRIC_GENERATION'],
    dataKinds: ['song-description', 'lyrics'],
  },
  analysis: {
    label: 'Music analysis',
    description: 'Theory explanations and analysis of MIDI or audio (spec §43).',
    interface: 'composition',
    capabilities: ['MUSIC_THEORY_REASONING'],
    dataKinds: ['song-description', 'chord-progression', 'midi'],
  },
  chat: {
    label: 'Project assistant',
    description: 'Conversation about the project (spec §44).',
    interface: 'composition',
    capabilities: ['TEXT_REASONING'],
    dataKinds: ['song-description', 'chord-progression', 'midi', 'lyrics'],
  },
  transcription: {
    label: 'Transcription',
    description: 'Audio → notes/tempo/key/chords (spec §26).',
    interface: 'transcription',
    capabilities: ['AUDIO_TRANSCRIPTION'],
    dataKinds: ['reference-audio'],
  },
  separation: {
    label: 'Source separation',
    description: 'Mix → stems (spec §25 Rebuild).',
    interface: 'separation',
    capabilities: ['SOURCE_SEPARATION'],
    dataKinds: ['reference-audio'],
  },
  production: {
    label: 'Production',
    description: 'Perform and produce the composition as audio (spec §29).',
    interface: 'audioGeneration',
    capabilities: ['TEXT_TO_MUSIC'],
    dataKinds: ['song-description', 'chord-progression', 'lyrics'],
  },
  vocals: {
    label: 'Singing voice',
    description: 'Singing synthesis from lyrics + vocal MIDI (spec §34).',
    interface: 'singing',
    capabilities: ['SINGING_SYNTHESIS'],
    dataKinds: ['midi', 'lyrics'],
  },
  'voice-conversion': {
    label: 'Voice conversion',
    description: 'Convert a vocal to an authorized target voice (spec §36).',
    interface: 'voiceConversion',
    capabilities: ['VOICE_CONVERSION'],
    dataKinds: ['guide-audio'],
  },
  mixing: {
    label: 'Mix assistant',
    description: 'Requests → mixer changes (spec §41).',
    interface: 'composition',
    capabilities: ['MIXING'],
    dataKinds: ['project-metadata'],
  },
  mastering: {
    label: 'Mastering',
    description: 'Master the mix to a target (spec §42).',
    interface: 'mastering',
    capabilities: ['MASTERING'],
    dataKinds: ['stems'],
  },
  'lyric-transcription': {
    label: 'Lyrics transcription',
    description: 'Sung or spoken audio → words with timings, to attach lyrics to vocal notes.',
    interface: 'lyricTranscription',
    capabilities: ['LYRIC_TRANSCRIPTION'],
    dataKinds: ['recorded-vocals'],
  },
  'instrument-rendering': {
    label: 'Instrument plugins',
    description: 'Render MIDI tracks through installed instrument plugins (VST3, AU, CLAP, LV2, SF2…).',
    interface: 'instrumentHost',
    capabilities: ['INSTRUMENT_PLUGIN_HOST'],
    dataKinds: ['midi'],
  },
};
