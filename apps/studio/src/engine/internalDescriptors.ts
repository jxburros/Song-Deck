import type { ProviderDescriptor, TaskRole } from '@songdeck/ai';

/**
 * Song Deck's own on-device engines, registered as ordinary providers with capabilities so the
 * router treats them exactly like any other provider (spec §2.2, §51 offline mode, §59).
 * They are deterministic, free, and never send data anywhere.
 */
export const INTERNAL_DESCRIPTORS = {
  composer: {
    id: 'internal-composer',
    name: 'On-device composer (deterministic theory engine)',
    adapter: 'internal',
    location: 'internal',
    capabilities: ['MUSIC_THEORY_REASONING', 'MIDI_GENERATION', 'MIDI_EDITING', 'LYRIC_GENERATION', 'MIXING', 'STRUCTURED_JSON'],
    qualityTier: 2,
    description: 'Rule-based composition, natural-language MIDI edits, theory explanations, placeholder lyrics and mix assistant. Works offline.',
  },
  analysis: {
    id: 'internal-analysis',
    name: 'On-device analysis (DSP)',
    adapter: 'internal',
    location: 'internal',
    capabilities: ['AUDIO_TRANSCRIPTION', 'PITCH_TRACKING', 'AUDIO_TO_MIDI', 'SOURCE_SEPARATION', 'VOCAL_ISOLATION'],
    qualityTier: 2,
    description: 'YIN pitch tracking, onset/tempo/key/chord detection, polyphonic & drum transcription, HPSS source separation.',
  },
  singer: {
    id: 'internal-singer',
    name: 'Built-in formant singer',
    adapter: 'internal',
    location: 'internal',
    capabilities: ['SINGING_SYNTHESIS', 'LYRIC_CONDITIONING', 'MIDI_CONDITIONING', 'REGION_GENERATION'],
    qualityTier: 1,
    description: 'Source-filter singing synthesis from vocal MIDI, lyrics/phonemes and expression. Placeholder quality.',
  },
  producer: {
    id: 'internal-producer',
    name: 'Built-in DSP producer (non-neural)',
    adapter: 'internal',
    location: 'internal',
    capabilities: ['STEM_GENERATION', 'STEM_CONDITIONING', 'MIDI_CONDITIONING', 'SECTION_GENERATION', 'INSTRUMENTAL_ONLY', 'STEM_OUTPUT'],
    qualityTier: 1,
    description: 'Renders the composition with production presets (layered synthesis, saturation, bus processing). Deterministic.',
  },
  mastering: {
    id: 'internal-mastering',
    name: 'Built-in DSP mastering',
    adapter: 'internal',
    location: 'internal',
    capabilities: ['MASTERING'],
    qualityTier: 3,
    description: 'EQ, glue compression, width, true-peak limiting and EBU R128 loudness targeting.',
  },
} satisfies Record<string, ProviderDescriptor>;

/** Which on-device engine serves each task role when routing picks "on-device". */
export const INTERNAL_FOR_ROLE: Partial<Record<TaskRole, string>> = {
  composition: 'internal-composer',
  harmony: 'internal-composer',
  'midi-editing': 'internal-composer',
  lyrics: 'internal-composer',
  analysis: 'internal-composer',
  chat: 'internal-composer',
  mixing: 'internal-composer',
  transcription: 'internal-analysis',
  separation: 'internal-analysis',
  vocals: 'internal-singer',
  production: 'internal-producer',
  mastering: 'internal-mastering',
};
