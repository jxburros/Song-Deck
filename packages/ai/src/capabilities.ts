/**
 * Capability taxonomy (spec §5, §30, §59).
 *
 * Providers advertise capabilities; workflows request capabilities; the router selects a
 * configured provider (and model) that satisfies ALL requested capabilities. Vendor names
 * never appear in routing logic.
 */

export const CAPABILITIES = [
  // Reasoning / symbolic music (spec §5)
  'TEXT_REASONING',
  'STRUCTURED_JSON',
  'MUSIC_THEORY_REASONING',
  'MIDI_GENERATION',
  'MIDI_EDITING',
  'LYRIC_GENERATION',
  // Audio analysis (spec §5)
  'AUDIO_UNDERSTANDING',
  'AUDIO_TRANSCRIPTION',
  'SOURCE_SEPARATION',
  'PITCH_TRACKING',
  'AUDIO_TO_MIDI',
  'CONTENT_IDENTIFICATION',
  // Production (spec §5, §30)
  'TEXT_TO_MUSIC',
  'AUDIO_TO_AUDIO',
  'STEM_GENERATION',
  'REFERENCE_AUDIO',
  'STEM_CONDITIONING',
  'LYRIC_CONDITIONING',
  'VOCAL_GENERATION',
  'INSTRUMENTAL_ONLY',
  'SECTION_GENERATION',
  'INPAINTING',
  'OUTPAINTING',
  'STEM_OUTPUT',
  'MIDI_CONDITIONING',
  'REGION_GENERATION',
  // Vocals (spec §34)
  'SINGING_SYNTHESIS',
  'VOICE_CONVERSION',
  'VOCAL_ISOLATION',
  // Post-production (spec §40-§42)
  'MIXING',
  'MASTERING',
  // Model I/O traits (spec §3.1 example: text_input, structured_output, tool_calling, audio_input, long_context)
  'TEXT_INPUT',
  'TOOL_CALLING',
  'AUDIO_INPUT',
  'LONG_CONTEXT',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityGroup =
  'reasoning' | 'audio-analysis' | 'production' | 'vocals' | 'post-production' | 'model-io';

export interface CapabilityInfo {
  label: string;
  description: string;
  group: CapabilityGroup;
}

export const CAPABILITY_GROUPS: Record<CapabilityGroup, { label: string; description: string }> = {
  reasoning: {
    label: 'Reasoning & composition',
    description: 'Language-model reasoning over the symbolic song (plans, MIDI edits, lyrics).',
  },
  'audio-analysis': {
    label: 'Audio analysis',
    description: 'Understanding, transcribing and separating audio.',
  },
  production: { label: 'Production', description: 'Generating or transforming audio from the composition.' },
  vocals: { label: 'Vocals', description: 'Singing synthesis and voice conversion.' },
  'post-production': { label: 'Mixing & mastering', description: 'Mix assistance and mastering.' },
  'model-io': {
    label: 'Model inputs & features',
    description: 'Input modalities and API features of a model.',
  },
};

export const CAPABILITY_INFO: Record<Capability, CapabilityInfo> = {
  TEXT_REASONING: {
    label: 'Text reasoning',
    description: 'General natural-language reasoning and conversation.',
    group: 'reasoning',
  },
  STRUCTURED_JSON: {
    label: 'Structured JSON',
    description: 'Native schema-constrained JSON output (otherwise JSON is requested through the prompt).',
    group: 'reasoning',
  },
  MUSIC_THEORY_REASONING: {
    label: 'Music theory reasoning',
    description: 'Reasons about keys, chords, voice leading and form well enough to plan or explain music.',
    group: 'reasoning',
  },
  MIDI_GENERATION: {
    label: 'MIDI generation',
    description: 'Writes new notes as structured operations (never binary MIDI).',
    group: 'reasoning',
  },
  MIDI_EDITING: {
    label: 'MIDI editing',
    description: 'Edits existing material through structured operations.',
    group: 'reasoning',
  },
  LYRIC_GENERATION: {
    label: 'Lyric generation',
    description: 'Writes or revises lyrics to a syllable/line plan.',
    group: 'reasoning',
  },
  AUDIO_UNDERSTANDING: {
    label: 'Audio understanding',
    description: 'Listens to audio and describes or analyzes it.',
    group: 'audio-analysis',
  },
  AUDIO_TRANSCRIPTION: {
    label: 'Audio transcription',
    description: 'Transcribes audio into notes (and optionally tempo/key/chords).',
    group: 'audio-analysis',
  },
  SOURCE_SEPARATION: {
    label: 'Source separation',
    description: 'Splits a mix into stems (drums, bass, vocals, other…).',
    group: 'audio-analysis',
  },
  PITCH_TRACKING: {
    label: 'Pitch tracking',
    description: 'Tracks the fundamental frequency of monophonic audio.',
    group: 'audio-analysis',
  },
  AUDIO_TO_MIDI: {
    label: 'Audio to MIDI',
    description: 'Converts audio performances to MIDI notes.',
    group: 'audio-analysis',
  },
  CONTENT_IDENTIFICATION: {
    label: 'Content identification',
    description:
      'Identifies a recording from its audio fingerprint (e.g. AcoustID) to warn about known releases.',
    group: 'audio-analysis',
  },
  TEXT_TO_MUSIC: {
    label: 'Text to music',
    description: 'Generates music audio from a text prompt.',
    group: 'production',
  },
  AUDIO_TO_AUDIO: {
    label: 'Audio to audio',
    description: 'Transforms an input recording (guide render, stem) into produced audio.',
    group: 'production',
  },
  STEM_GENERATION: {
    label: 'Stem generation',
    description: 'Generates individual instrument stems.',
    group: 'production',
  },
  REFERENCE_AUDIO: {
    label: 'Reference audio',
    description: 'Accepts reference audio to steer style or sound.',
    group: 'production',
  },
  STEM_CONDITIONING: {
    label: 'Stem conditioning',
    description: 'Conditions generation on supplied stems or a guide render.',
    group: 'production',
  },
  LYRIC_CONDITIONING: {
    label: 'Lyric conditioning',
    description: 'Accepts lyrics that should be sung.',
    group: 'production',
  },
  VOCAL_GENERATION: {
    label: 'Vocal generation',
    description: 'Can generate sung vocals as part of the output.',
    group: 'production',
  },
  INSTRUMENTAL_ONLY: {
    label: 'Instrumental only',
    description: 'Can be told to produce instrumental music without vocals.',
    group: 'production',
  },
  SECTION_GENERATION: {
    label: 'Section generation',
    description: 'Understands song sections (intro, verse, chorus…) with durations.',
    group: 'production',
  },
  INPAINTING: {
    label: 'Inpainting',
    description: 'Regenerates a time range inside existing audio.',
    group: 'production',
  },
  OUTPAINTING: {
    label: 'Outpainting / extend',
    description: 'Continues or extends existing audio.',
    group: 'production',
  },
  STEM_OUTPUT: {
    label: 'Stem output',
    description: 'Returns separate stems in addition to (or instead of) a mix.',
    group: 'production',
  },
  MIDI_CONDITIONING: {
    label: 'MIDI conditioning',
    description: 'Follows a supplied MIDI melody/score exactly.',
    group: 'production',
  },
  REGION_GENERATION: {
    label: 'Region generation',
    description: 'Regenerates only a selected region (bars, phrase).',
    group: 'production',
  },
  SINGING_SYNTHESIS: {
    label: 'Singing synthesis',
    description: 'Sings lyrics + MIDI melody with expression (spec §34).',
    group: 'vocals',
  },
  VOICE_CONVERSION: {
    label: 'Voice conversion',
    description: 'Converts a vocal performance to an authorized target voice.',
    group: 'vocals',
  },
  VOCAL_ISOLATION: {
    label: 'Vocal isolation',
    description: 'Extracts the vocal from a mix.',
    group: 'vocals',
  },
  MIXING: {
    label: 'Mixing',
    description: 'Mix assistance: translates requests into mixer changes or mixes stems.',
    group: 'post-production',
  },
  MASTERING: {
    label: 'Mastering',
    description: 'Masters a mix to a loudness/tonal target.',
    group: 'post-production',
  },
  TEXT_INPUT: { label: 'Text input', description: 'Accepts text prompts.', group: 'model-io' },
  TOOL_CALLING: { label: 'Tool calling', description: 'Supports function/tool calling.', group: 'model-io' },
  AUDIO_INPUT: { label: 'Audio input', description: 'Accepts audio in the prompt.', group: 'model-io' },
  LONG_CONTEXT: {
    label: 'Long context',
    description: 'Context window of 100k tokens or more.',
    group: 'model-io',
  },
};

const CAPABILITY_SET = new Set<string>(CAPABILITIES);

const CAPABILITY_ALIASES: Record<string, Capability> = {
  STRUCTURED_OUTPUT: 'STRUCTURED_JSON',
  STRUCTURED_OUTPUTS: 'STRUCTURED_JSON',
  JSON: 'STRUCTURED_JSON',
  JSON_MODE: 'STRUCTURED_JSON',
  REASONING: 'TEXT_REASONING',
  TOOLS: 'TOOL_CALLING',
  FUNCTION_CALLING: 'TOOL_CALLING',
  AUDIO: 'AUDIO_INPUT',
  TRANSCRIPTION: 'AUDIO_TRANSCRIPTION',
  SEPARATION: 'SOURCE_SEPARATION',
  SINGING: 'SINGING_SYNTHESIS',
  EXTEND: 'OUTPAINTING',
  CONTINUATION: 'OUTPAINTING',
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

/**
 * Normalize capability names reported by providers/bridges ("structured_output", "text-input",
 * "AUDIO_INPUT"…) to the taxonomy. Unknown names are dropped.
 */
export function normalizeCapabilities(list: readonly unknown[] | undefined | null): Capability[] {
  const out: Capability[] = [];
  for (const raw of list ?? []) {
    if (typeof raw !== 'string') continue;
    const key = raw
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    const cap = CAPABILITY_SET.has(key) ? (key as Capability) : CAPABILITY_ALIASES[key];
    if (cap && !out.includes(cap)) out.push(cap);
  }
  return out;
}

export function missingCapabilities(have: readonly Capability[], need: readonly Capability[]): Capability[] {
  const set = new Set(have);
  return need.filter((c) => !set.has(c));
}

export function hasCapabilities(have: readonly Capability[], need: readonly Capability[]): boolean {
  return missingCapabilities(have, need).length === 0;
}

export function unionCapabilities(...lists: (readonly Capability[] | undefined)[]): Capability[] {
  const out: Capability[] = [];
  for (const l of lists) for (const c of l ?? []) if (!out.includes(c)) out.push(c);
  return out;
}

/** Capabilities every general instruction-following LLM gets through Song Deck's structured-operation layer. */
export const LLM_BASE_CAPABILITIES: readonly Capability[] = [
  'TEXT_INPUT',
  'TEXT_REASONING',
  'MUSIC_THEORY_REASONING',
  'MIDI_GENERATION',
  'MIDI_EDITING',
  'LYRIC_GENERATION',
  'MIXING',
];

export function capabilityLabel(cap: Capability): string {
  return CAPABILITY_INFO[cap]?.label ?? cap;
}
