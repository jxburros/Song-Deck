/**
 * Canonical JSON schemas for structured AI output (spec §46).
 *
 * Convention: properties listed in `required` are mandatory; every other property is optional
 * ("nullable" in LLM dialects). Dialect compilers (dialects.ts) turn these into OpenAI-strict,
 * Anthropic, Gemini (OpenAPI subset), plain JSON-schema or prompt-only descriptions.
 *
 * Operations use a FLAT item schema (`op` enum + every other field optional/nullable) that
 * `parseOperations` converts into typed `MusicOperation`s.
 */
import type {
  Articulation,
  AutomationParam,
  AvoidRule,
  MixerChange,
  ModeName,
  MusicalFunction,
  MusicOperation,
  SectionFeel,
  SectionKind,
  TrackRole,
  VariationLevel,
  VocalMode,
  VoiceType,
} from '@songdeck/core';
import type { JsonSchema } from '../types';

// ---------------------------------------------------------------------------
// Enumerations mirrored from the Music IR (compile-time checked for completeness)
// ---------------------------------------------------------------------------

type Complete<T, A extends readonly unknown[]> = [Exclude<T, A[number]>] extends [never] ? A : never;

const MODES_ = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic-minor', 'melodic-minor'] as const;
export const MODE_NAMES: Complete<ModeName, typeof MODES_> = MODES_;

const SECTION_KINDS_ = [
  'intro',
  'verse',
  'pre-chorus',
  'chorus',
  'post-chorus',
  'bridge',
  'breakdown',
  'build',
  'drop',
  'solo',
  'interlude',
  'final-chorus',
  'outro',
  'custom',
] as const;
export const SECTION_KINDS: Complete<SectionKind, typeof SECTION_KINDS_> = SECTION_KINDS_;

const FEELS_ = ['normal', 'half-time', 'double-time'] as const;
export const SECTION_FEELS: Complete<SectionFeel, typeof FEELS_> = FEELS_;

const ARTICULATIONS_ = [
  'normal',
  'staccato',
  'legato',
  'accent',
  'marcato',
  'tenuto',
  'palm-mute',
  'pizzicato',
  'tremolo',
  'ghost',
  'slide',
  'bend',
  'harmonic',
  'dead',
] as const;
export const ARTICULATIONS: Complete<Articulation, typeof ARTICULATIONS_> = ARTICULATIONS_;

const TRACK_ROLES_ = [
  'drums',
  'percussion',
  'bass',
  'rhythm-guitar',
  'lead-guitar',
  'keys',
  'strings',
  'synth-pad',
  'synth-arp',
  'synth-lead',
  'synth-seq',
  'vocal',
  'custom',
] as const;
export const TRACK_ROLE_NAMES: Complete<TrackRole, typeof TRACK_ROLES_> = TRACK_ROLES_;

const FUNCTIONS_ = ['melody', 'counter-melody', 'harmony', 'accompaniment', 'bass-line', 'rhythm', 'pad', 'hook', 'fills', 'solo', 'texture'] as const;
export const MUSICAL_FUNCTIONS: Complete<MusicalFunction, typeof FUNCTIONS_> = FUNCTIONS_;

const AUTOMATION_PARAMS_ = [
  'volumeDb',
  'pan',
  'reverbSend',
  'delaySend',
  'width',
  'drive',
  'eq.lowShelfDb',
  'eq.lowMidDb',
  'eq.highMidDb',
  'eq.highShelfDb',
  'eq.lowpassHz',
  'eq.highpassHz',
] as const;
export const AUTOMATION_PARAMS: Complete<AutomationParam, typeof AUTOMATION_PARAMS_> = AUTOMATION_PARAMS_;

const VARIATION_LEVELS_ = ['ornament', 'variation', 'reinterpretation', 'mutation'] as const;
export const VARIATION_LEVELS: Complete<VariationLevel, typeof VARIATION_LEVELS_> = VARIATION_LEVELS_;

const VOICE_TYPES_ = ['soprano', 'mezzo', 'alto', 'tenor', 'baritone', 'bass'] as const;
export const VOICE_TYPES: Complete<VoiceType, typeof VOICE_TYPES_> = VOICE_TYPES_;

const VOCAL_MODES_ = ['none', 'melody-only', 'placeholder', 'ai-singer', 'voice-conversion', 'recorded'] as const;
export const VOCAL_MODES: Complete<VocalMode, typeof VOCAL_MODES_> = VOCAL_MODES_;

const AVOID_RULES_ = ['double-vocal', 'parallel-fifths', 'busy-verses', 'high-register', 'low-register', 'chromaticism', 'syncopation', 'large-leaps'] as const;
export const AVOID_RULES: Complete<AvoidRule, typeof AVOID_RULES_> = AVOID_RULES_;

const MIXER_PARAMS_ = [
  'volumeDb',
  'pan',
  'mute',
  'solo',
  'reverbSend',
  'delaySend',
  'width',
  'drive',
  'eq.enabled',
  'eq.highpassHz',
  'eq.lowShelfHz',
  'eq.lowShelfDb',
  'eq.lowMidHz',
  'eq.lowMidDb',
  'eq.lowMidQ',
  'eq.highMidHz',
  'eq.highMidDb',
  'eq.highMidQ',
  'eq.highShelfHz',
  'eq.highShelfDb',
  'eq.lowpassHz',
  'compressor.enabled',
  'compressor.thresholdDb',
  'compressor.ratio',
  'compressor.attackMs',
  'compressor.releaseMs',
  'compressor.makeupDb',
] as const;
export const MIXER_PARAMS: Complete<keyof MixerChange, typeof MIXER_PARAMS_> = MIXER_PARAMS_;
export const BOOLEAN_MIXER_PARAMS: readonly (keyof MixerChange)[] = ['mute', 'solo', 'eq.enabled', 'compressor.enabled'];

const OP_NAMES_ = [
  'replace_notes',
  'add_notes',
  'delete_notes',
  'transform_notes',
  'set_chords',
  'set_tempo',
  'set_key',
  'set_meter',
  'update_section',
  'insert_section',
  'remove_section',
  'move_section',
  'set_lyrics',
  'set_mixer',
  'set_automation',
  'set_expression',
  'add_track',
  'remove_track',
  'set_instrument',
  'set_macros',
  'set_lock',
  'regenerate',
] as const;
export const OPERATION_NAMES: Complete<MusicOperation['op'], typeof OP_NAMES_> = OP_NAMES_;

export const ONSETS = ['soft', 'normal', 'hard', 'scoop'] as const;
export const RELEASES = ['normal', 'falling', 'rising', 'breathy', 'cut'] as const;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const str = (description?: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const num = (description?: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'number', ...(description ? { description } : {}), ...extra });
const int = (description?: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
const bool = (description?: string): JsonSchema => ({ type: 'boolean', ...(description ? { description } : {}) });
const enm = (values: readonly string[], description?: string): JsonSchema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) });
const arr = (items: JsonSchema, description?: string, extra: JsonSchema = {}): JsonSchema => ({
  type: 'array',
  items,
  ...(description ? { description } : {}),
  ...extra,
});
const obj = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...(description ? { description } : {}),
});
const keep = (s: JsonSchema): JsonSchema => ({ ...s, 'x-keep': true });

const CONFIDENCE = num('Your confidence that this answer is musically correct and complete, 0..1', { minimum: 0, maximum: 1 });

// ---------------------------------------------------------------------------
// Composition plan (spec §15) and blueprint (spec §10)
// ---------------------------------------------------------------------------

const KEY_SCHEMA = obj(
  {
    tonic: str('Tonic note name without octave, e.g. "E", "F#", "Bb"'),
    mode: enm(MODE_NAMES),
  },
  ['tonic', 'mode'],
);

const METER_SCHEMA = obj(
  {
    numerator: int('Beats per bar', { minimum: 1, maximum: 32 }),
    denominator: int('Beat unit (4 = quarter note, 8 = eighth note)', { enum: [1, 2, 4, 8, 16] }),
  },
  ['numerator', 'denominator'],
);

export const COMPOSITION_PLAN_SCHEMA: JsonSchema = obj(
  {
    key: KEY_SCHEMA,
    tempo: num('Tempo in BPM (quarter notes per minute)', { minimum: 30, maximum: 300 }),
    meter: METER_SCHEMA,
    sections: arr(
      obj(
        {
          name: str('Display name, e.g. "Verse 1", "Final Chorus"'),
          kind: enm(SECTION_KINDS),
          bars: int('Length in bars', { minimum: 1, maximum: 128 }),
          harmony: arr(str('Chord symbol such as "Em", "C", "G/B", "D7sus4"'), 'Chord symbols in order, one per harmonic-rhythm slot (they repeat to fill the section)', {
            minItems: 1,
          }),
          energy: num('Energy 0..100 at the start of the section', { minimum: 0, maximum: 100 }),
          energy_end: num('Energy 0..100 at the end (for ramps)', { minimum: 0, maximum: 100 }),
          purpose: str('Musical purpose, e.g. "Rising tension"'),
          feel: enm(SECTION_FEELS),
        },
        ['name', 'kind', 'bars', 'harmony', 'energy', 'purpose'],
      ),
      'Sections in playing order',
      { minItems: 1 },
    ),
    notes: str('Short notes about the plan (motifs, contrast, arrangement ideas)'),
    confidence: CONFIDENCE,
  },
  ['key', 'tempo', 'meter', 'sections'],
);

const MACRO_PROPS: Record<string, JsonSchema> = {
  complexity: num('Simple 0 ↔ 1 complex', { minimum: 0, maximum: 1 }),
  energy: num('Calm 0 ↔ 1 aggressive', { minimum: 0, maximum: 1 }),
  density: num('Sparse 0 ↔ 1 busy', { minimum: 0, maximum: 1 }),
  humanization: num('Mechanical 0 ↔ 1 loose', { minimum: 0, maximum: 1 }),
  melodic_movement: num('Static 0 ↔ 1 active', { minimum: 0, maximum: 1 }),
  harmonic_tension: num('Stable 0 ↔ 1 dissonant', { minimum: 0, maximum: 1 }),
  repetition: num('Predictable 0 ↔ 1 varied', { minimum: 0, maximum: 1 }),
  syncopation: num('Straight 0 ↔ 1 syncopated', { minimum: 0, maximum: 1 }),
  dynamics: num('Flat 0 ↔ 1 expressive', { minimum: 0, maximum: 1 }),
};

export const BLUEPRINT_SCHEMA: JsonSchema = obj(
  {
    title: str('Working title'),
    tempo: num('Tempo in BPM', { minimum: 30, maximum: 300 }),
    meter: METER_SCHEMA,
    key: KEY_SCHEMA,
    styles: arr(str(), 'Style labels, e.g. ["Emo", "Pop-punk"]'),
    genre_blend: arr(
      obj({ genre_id: str('Genre profile id (use the provided ids when given)'), weight: num('Relative weight', { minimum: 0 }) }, ['genre_id', 'weight']),
      'Genre blend, e.g. 50% pop-punk / 30% emo / 20% cinematic',
    ),
    moods: arr(str(), 'Mood statements, e.g. "Melancholy verses", "Cathartic chorus"'),
    instrumentation: arr(
      obj(
        {
          name: str('Track name'),
          instrument_id: str('Instrument profile id (use the provided ids when given)'),
          role: enm(TRACK_ROLE_NAMES),
          function: enm(MUSICAL_FUNCTIONS),
          lowest: str('Lowest allowed note, e.g. "E2"'),
          highest: str('Highest allowed note, e.g. "A5"'),
          complexity: enm(['low', 'medium', 'high']),
          avoid: arr(enm(AVOID_RULES)),
        },
        ['name', 'instrument_id', 'role'],
      ),
      'Tracks of the arrangement',
      { minItems: 1 },
    ),
    structure: arr(
      obj(
        {
          name: str('Section name'),
          kind: enm(SECTION_KINDS),
          bars: int('Length in bars', { minimum: 1, maximum: 128 }),
          energy: num('Energy 0..100', { minimum: 0, maximum: 100 }),
          energy_end: num('Energy at the end 0..100', { minimum: 0, maximum: 100 }),
          purpose: str('Musical purpose'),
          mood: arr(str()),
          harmony: arr(str(), 'Chord symbols or roman numerals for the progression'),
          feel: enm(SECTION_FEELS),
        },
        ['name', 'kind', 'bars'],
      ),
      'Song structure in order',
      { minItems: 1 },
    ),
    vocal: obj({ voice_type: enm(VOICE_TYPES), mode: enm(VOCAL_MODES), description: str() }, ['voice_type', 'mode']),
    lyrics_theme: str('What the lyrics are about'),
    tags: arr(str(), 'Tag ids (style, mood, era, production…) from the available tag ids'),
    macros: obj(MACRO_PROPS, [], 'Macro controls 0..1'),
    explanation: str('One or two sentences explaining the choices'),
    confidence: CONFIDENCE,
  },
  ['title', 'tempo', 'meter', 'key', 'styles', 'genre_blend', 'moods', 'instrumentation', 'structure'],
);

// ---------------------------------------------------------------------------
// Flat operation item (spec §46)
// ---------------------------------------------------------------------------

export const NOTE_ITEM_SCHEMA: JsonSchema = obj(
  {
    pitch: str('Note name with octave ("E2", "F#4"; C4 = middle C = MIDI 60) or a MIDI number as text'),
    bar: int('1-based bar', { minimum: 1 }),
    beat: num('1-based beat within the bar; fractions allowed (1.5 = the "and" of beat 1)', { minimum: 1 }),
    duration_beats: num('Duration in beats', { exclusiveMinimum: 0 }),
    velocity: int('1..127', { minimum: 1, maximum: 127 }),
    articulation: enm(ARTICULATIONS),
    syllable: str('Lyric syllable sung on this note (vocal tracks)'),
  },
  ['pitch', 'bar', 'beat', 'duration_beats'],
);

const CHORD_ITEM_SCHEMA = obj(
  {
    bar: int('1-based bar', { minimum: 1 }),
    beat: num('1-based beat', { minimum: 1 }),
    symbol: str('Chord symbol, e.g. "Em", "G/B", "Cmaj7"'),
    duration_beats: num('Duration in beats', { exclusiveMinimum: 0 }),
  },
  ['bar', 'beat', 'symbol', 'duration_beats'],
);

const MIXER_CHANGE_ITEM = obj(
  {
    param: enm(MIXER_PARAMS, 'Mixer parameter'),
    value: num('New value (dB, -1..1 pan, 0..1 sends; booleans as 1 = on / 0 = off)'),
  },
  ['param', 'value'],
);

const AUTOMATION_POINT_ITEM = obj(
  {
    bar: int('1-based bar', { minimum: 1 }),
    beat: num('1-based beat', { minimum: 1 }),
    value: num(),
  },
  ['bar', 'beat', 'value'],
);

const EXPRESSION_SCHEMA = obj(
  {
    breathiness: num('0..1', { minimum: 0, maximum: 1 }),
    tension: num('0..1', { minimum: 0, maximum: 1 }),
    vibrato: num('Vibrato depth 0..1', { minimum: 0, maximum: 1 }),
    vibrato_rate: num('Vibrato rate in Hz', { minimum: 0, maximum: 12 }),
    onset: enm(ONSETS),
    release: enm(RELEASES),
    energy: num('0..1', { minimum: 0, maximum: 1 }),
  },
  [],
  'Vocal expression (set_expression)',
);

const TRANSFORM_SCHEMA = obj(
  {
    transpose: int('Chromatic semitones'),
    transpose_diatonic: int('Scale steps (key-aware)'),
    velocity_scale: num('Multiply velocities'),
    velocity_add: int('Add to velocities'),
    time_shift_beats: num('Shift in beats (may be negative)'),
    duration_scale: num('Multiply durations'),
    quantize_beats: num('Quantize grid in beats (0.25 = 16ths in 4/4)'),
    quantize_strength: num('0..1', { minimum: 0, maximum: 1 }),
    humanize: num('0..1', { minimum: 0, maximum: 1 }),
    articulation: enm(ARTICULATIONS),
  },
  [],
  'Note transform (transform_notes)',
);

/** Flat operation item: `op` + every other field optional (nullable in strict dialects). */
export const OPERATION_ITEM_SCHEMA: JsonSchema = obj(
  {
    op: enm(OPERATION_NAMES, 'Operation type'),
    track: keep(str('Target track: id, exact name, or role (e.g. "bass"); "master" for master-bus mixer ops')),
    section: keep(str('Target section id or name (update_section, remove_section, move_section, set_lyrics)')),
    start_bar: keep(int('Region start, 1-based inclusive', { minimum: 1 })),
    end_bar: keep(int('Region end, 1-based inclusive', { minimum: 1 })),
    notes: keep(arr(NOTE_ITEM_SCHEMA, 'Notes (replace_notes, add_notes)')),
    note_ids: keep(arr(str(), 'Existing note ids (delete/transform/set_expression)')),
    chords: keep(arr(CHORD_ITEM_SCHEMA, 'Chords (set_chords)')),
    lines: keep(arr(str(), 'Lyric lines (set_lyrics)')),
    mixer: keep(arr(MIXER_CHANGE_ITEM, 'Mixer changes (set_mixer)')),
    points: keep(arr(AUTOMATION_POINT_ITEM, 'Automation points (set_automation)')),
    pitch_low: str('Lowest pitch to delete (delete_notes), e.g. "C2"'),
    pitch_high: str('Highest pitch to delete (delete_notes)'),
    bpm: num('Tempo (set_tempo)', { minimum: 20, maximum: 400 }),
    tonic: str('Key tonic (set_key), e.g. "D"'),
    mode: enm(MODE_NAMES, 'Key mode (set_key)'),
    transpose_notes: bool('set_key: also transpose existing notes'),
    numerator: int('Meter numerator (set_meter)', { minimum: 1, maximum: 32 }),
    denominator: int('Meter denominator (set_meter)', { enum: [1, 2, 4, 8, 16] }),
    at_bar: int('1-based bar where a tempo/key/meter change starts', { minimum: 1 }),
    name: str('New section name (update_section/insert_section) or track name (add_track)'),
    kind: enm(SECTION_KINDS, 'Section kind (update_section/insert_section)'),
    bars: int('Section length in bars (update_section/insert_section)', { minimum: 1, maximum: 128 }),
    energy: num('Section energy 0..100', { minimum: 0, maximum: 100 }),
    energy_end: num('Section energy at the end 0..100', { minimum: 0, maximum: 100 }),
    purpose: str('Section purpose'),
    mood: arr(str(), 'Section mood words'),
    feel: enm(SECTION_FEELS),
    progression: arr(str(), 'Roman-numeral progression for update_section'),
    after: str('insert_section: id or name of the section to insert after'),
    copy_from: str('insert_section: section to copy material from'),
    to_index: int('move_section: new 0-based position in the section list', { minimum: 0 }),
    param: enm(AUTOMATION_PARAMS, 'Automated parameter (set_automation)'),
    expression: EXPRESSION_SCHEMA,
    transform: TRANSFORM_SCHEMA,
    instrument_id: str('Instrument profile id (add_track, set_instrument)'),
    role: enm(TRACK_ROLE_NAMES, 'Track role (add_track)'),
    function: enm(MUSICAL_FUNCTIONS, 'Musical function (add_track)'),
    macros: obj(MACRO_PROPS, [], 'Macro values 0..1 (set_macros)'),
    key: str('Lock key (set_lock), e.g. "track:<id>" or "song.chords"'),
    locked: bool('set_lock value'),
    sections: arr(str(), 'Sections to regenerate'),
    level: enm(VARIATION_LEVELS, 'Variation level for regenerate'),
    seed: int('Seed for regenerate'),
    reason: keep(str('Why this change (one short sentence)')),
  },
  ['op'],
);

export const OPERATIONS_SCHEMA: JsonSchema = obj(
  {
    explanation: str('What you changed and why, for the user (1-3 sentences)'),
    confidence: CONFIDENCE,
    operations: arr(OPERATION_ITEM_SCHEMA, 'Minimal list of operations implementing the request'),
  },
  ['explanation', 'confidence', 'operations'],
);

/** Mix assistant output: ordinary mixer changes instead of regeneration (spec §41). */
export const MIX_OPERATION_ITEM_SCHEMA: JsonSchema = obj(
  {
    op: enm(['set_mixer', 'set_automation'], 'Operation type'),
    track: str('Track id, name or role, or "master"'),
    mixer: arr(MIXER_CHANGE_ITEM, 'Mixer changes (set_mixer)'),
    param: enm(AUTOMATION_PARAMS, 'Automated parameter (set_automation)'),
    points: arr(AUTOMATION_POINT_ITEM, 'Automation points (set_automation)'),
    reason: str('Why'),
  },
  ['op', 'track'],
);

export const MIX_SCHEMA: JsonSchema = obj(
  {
    explanation: str('What the changes do, in mixing terms'),
    confidence: CONFIDENCE,
    operations: arr(MIX_OPERATION_ITEM_SCHEMA),
  },
  ['explanation', 'confidence', 'operations'],
);

// ---------------------------------------------------------------------------
// Lyrics, chat, analysis, explanation
// ---------------------------------------------------------------------------

export const LYRICS_SCHEMA: JsonSchema = obj(
  {
    title: str('Suggested title'),
    sections: arr(
      obj({ section: str('Section name exactly as requested'), lines: arr(str(), 'Lyric lines in order') }, ['section', 'lines']),
      'One entry per requested section',
    ),
    notes: str('Notes on rhyme, imagery or syllable fitting'),
    confidence: CONFIDENCE,
  },
  ['sections'],
);

export const CHAT_SCHEMA: JsonSchema = obj(
  {
    answer: str('Answer in terms of the actual project (sections, bars, chords, tracks)'),
    suggestions: arr(str(), 'Optional short follow-up suggestions'),
    operations: arr(OPERATION_ITEM_SCHEMA, 'Edits to PROPOSE only if the user asked for a change; otherwise empty'),
    confidence: CONFIDENCE,
  },
  ['answer', 'suggestions', 'operations', 'confidence'],
);

export const ANALYSIS_SCHEMA: JsonSchema = obj(
  {
    summary: str('Overall analysis'),
    observations: arr(obj({ topic: str('e.g. "harmony", "energy", "arrangement"'), detail: str(), section: str('Section name, if specific') }, ['topic', 'detail'])),
    key: str('Detected/confirmed key, e.g. "E minor"'),
    tempo: num('Tempo in BPM'),
    genre: str('Genre / style'),
    confidence: CONFIDENCE,
  },
  ['summary', 'observations', 'confidence'],
);

export const EXPLANATION_SCHEMA: JsonSchema = obj(
  {
    explanation: str('Explanation for a musician who is learning (Theory View, spec §43)'),
    harmony: arr(
      obj(
        {
          section: str('Section name'),
          chords: arr(str(), 'Chord symbols'),
          romans: arr(str(), 'Roman numerals in the key'),
          comment: str('Function / effect of the progression'),
        },
        ['section', 'chords', 'romans'],
      ),
    ),
    suggestions: arr(str(), 'Ideas such as "make darker", "increase tension"'),
    confidence: CONFIDENCE,
  },
  ['explanation', 'harmony', 'suggestions'],
);

export const CANONICAL_SCHEMAS = {
  composition_plan: COMPOSITION_PLAN_SCHEMA,
  blueprint: BLUEPRINT_SCHEMA,
  operations: OPERATIONS_SCHEMA,
  mix_operations: MIX_SCHEMA,
  lyrics: LYRICS_SCHEMA,
  chat_answer: CHAT_SCHEMA,
  music_analysis: ANALYSIS_SCHEMA,
  music_explanation: EXPLANATION_SCHEMA,
} as const satisfies Record<string, JsonSchema>;

export type CanonicalSchemaName = keyof typeof CANONICAL_SCHEMAS;
