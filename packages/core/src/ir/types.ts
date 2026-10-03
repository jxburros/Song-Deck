/**
 * Music IR — the canonical, editable symbolic representation of a song (spec §2.1, §47).
 *
 * MIDI, MusicXML, audio renders, etc. are serialization/render targets of this IR.
 *
 * Conventions (IMPORTANT — every package relies on these):
 *  - Time is measured in integer ticks. `PPQ` ticks = one quarter note.
 *  - Bars and beats are 0-based internally. AI-facing structured operations and the UI
 *    display bars/beats 1-based (musician convention) — conversion happens at those edges.
 *  - Tempo (`bpm`) is always quarter-notes per minute (MIDI convention), whatever the meter.
 *  - Pitches are MIDI note numbers (60 = C4, 69 = A4 = 440 Hz).
 *  - Pitch classes are 0..11 with 0 = C.
 *  - Notes are stored per track at absolute tick positions. Structure edits shift notes.
 *  - All "amount" style controls (macros, expression) are normalized 0..1.
 */

export const PPQ = 480;
export const SONG_SCHEMA_VERSION = 1;

export type Id = string;
export type Ticks = number;
export type MidiPitch = number;
export type PitchClass = number;

// ---------------------------------------------------------------------------
// Keys, modes, meter, tempo
// ---------------------------------------------------------------------------

export type ModeName =
  | 'major'
  | 'minor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian'
  | 'harmonic-minor'
  | 'melodic-minor';

export interface KeySignature {
  tonic: PitchClass;
  mode: ModeName;
}

export interface TempoEvent {
  tick: Ticks;
  bpm: number;
}

export interface MeterEvent {
  /** 0-based bar index where this meter starts. */
  bar: number;
  numerator: number;
  denominator: number;
}

export interface KeyEvent {
  /** 0-based bar index where this key starts. */
  bar: number;
  key: KeySignature;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export type SectionKind =
  | 'intro'
  | 'verse'
  | 'pre-chorus'
  | 'chorus'
  | 'post-chorus'
  | 'bridge'
  | 'breakdown'
  | 'build'
  | 'drop'
  | 'solo'
  | 'interlude'
  | 'final-chorus'
  | 'outro'
  | 'custom';

export type SectionFeel = 'normal' | 'half-time' | 'double-time';

export interface Section {
  id: Id;
  /** Display name, e.g. "Verse 1", "Final Chorus". */
  name: string;
  kind: SectionKind;
  /** Length in bars. Sections are contiguous, in array order; start positions are derived (see timing.sectionLayout). */
  bars: number;
  /** Energy 0..100 at the start of the section. */
  energy: number;
  /** Optional energy at the end of the section for ramps (e.g. Bridge 70→95). */
  energyEnd?: number;
  /** Musical purpose from the composition plan, e.g. "Rising tension". */
  purpose?: string;
  /** Mood words for this section, e.g. ["melancholy"]. */
  mood?: string[];
  /** Harmony plan as roman numerals relative to the key at this section, e.g. ["i","VI","III","VII"]. */
  progression?: string[];
  /** Chords per bar (0.5 = one chord every two bars, 1, 2...). */
  harmonicRhythm?: number;
  /** Id of an earlier section this one repeats (e.g. Chorus 2 repeats Chorus 1) — drives repetition patterns. */
  repeatOf?: Id;
  feel?: SectionFeel;
}

// ---------------------------------------------------------------------------
// Harmony
// ---------------------------------------------------------------------------

export type ChordQuality =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | '5'
  | '6'
  | 'min6'
  | '7'
  | 'maj7'
  | 'min7'
  | 'minmaj7'
  | 'm7b5'
  | 'dim7'
  | '7sus4'
  | 'add9'
  | 'minadd9'
  | '9'
  | 'maj9'
  | 'min9'
  | '11'
  | 'min11'
  | '13'
  | 'maj13'
  | 'aug7'
  | '7b9'
  | '7#9';

export interface ChordSpec {
  root: PitchClass;
  quality: ChordQuality;
  /** Slash-chord bass pitch class (e.g. G/B → bass 11). */
  bass?: PitchClass;
}

export interface ChordEvent extends ChordSpec {
  id: Id;
  tick: Ticks;
  duration: Ticks;
  /** Display symbol, e.g. "Em", "G/B", "Cmaj7". Must agree with root/quality/bass. */
  symbol: string;
  /** Roman numeral relative to the key in effect, e.g. "vi", "bVII", "V/V". */
  roman?: string;
}

// ---------------------------------------------------------------------------
// Notes, expression, lyrics
// ---------------------------------------------------------------------------

export type Articulation =
  | 'normal'
  | 'staccato'
  | 'legato'
  | 'accent'
  | 'marcato'
  | 'tenuto'
  | 'palm-mute'
  | 'pizzicato'
  | 'tremolo'
  | 'ghost'
  | 'slide'
  | 'bend'
  | 'harmonic'
  | 'dead';

/** Vocal expression data (spec §35). Providers ignore what they do not support. */
export interface VocalExpression {
  /** 0..1 */
  breathiness?: number;
  /** 0..1 (vocal effort / spectral brightness) */
  tension?: number;
  /** 0..1 vibrato depth */
  vibrato?: number;
  /** Vibrato rate in Hz (default ~5.5) */
  vibratoRate?: number;
  onset?: 'soft' | 'normal' | 'hard' | 'scoop';
  release?: 'normal' | 'falling' | 'rising' | 'breathy' | 'cut';
  /** 0..1 */
  energy?: number;
}

export interface Note {
  id: Id;
  pitch: MidiPitch;
  tick: Ticks;
  duration: Ticks;
  /** 1..127 */
  velocity: number;
  articulation?: Articulation;
  /** Lyric syllable sung on this note (vocal tracks). "-" suffix/prefix marks word continuation; "_" marks a melisma continuation. */
  syllable?: string;
  /** Optional explicit phonemes (ARPAbet-like) for singing synthesis. */
  phonemes?: string[];
  /** Lyric line this note's syllable belongs to. */
  lyricLineId?: Id;
  expression?: VocalExpression;
  /** Note-level lock (spec §22: every component lockable). */
  locked?: boolean;
  motifId?: Id;
  phraseId?: Id;
  /** Transcription / generation confidence 0..1 (spec §25: communicate uncertainty). */
  confidence?: number;
  /** What created the note: generator id, "user", "transcription", provider id... */
  origin?: string;
}

export interface LyricLine {
  id: Id;
  sectionId: Id;
  text: string;
  /** Vocal track this line is sung on. */
  trackId?: Id;
  /** Who wrote it (rights metadata) — "human", provider id, or "placeholder". */
  author?: string;
}

/** Derived view of a lyric syllable aligned to a vocal note (spec §47 LyricSyllable). */
export interface LyricSyllable {
  text: string;
  noteId: Id;
  lineId?: Id;
  wordIndex: number;
  syllableIndex: number;
  phonemes?: string[];
}

// ---------------------------------------------------------------------------
// Motifs and phrases
// ---------------------------------------------------------------------------

export interface MotifNote {
  /** Offset from motif start in ticks. */
  offset: Ticks;
  duration: Ticks;
  /** Scale-degree steps relative to the motif anchor (0 = anchor, +1 = next scale step, -2 ...). */
  degree: number;
  /** Chromatic alteration in semitones applied after diatonic placement. */
  alteration?: number;
  velocity: number;
}

export type MotifRole = 'vocal-hook' | 'instrumental-hook' | 'riff' | 'answer' | 'rhythmic' | 'bass-figure' | 'other';

export interface Motif {
  id: Id;
  /** e.g. "Motif A" */
  name: string;
  /** e.g. "Verse vocal motif" */
  description?: string;
  role: MotifRole;
  lengthTicks: Ticks;
  notes: MotifNote[];
  sourceTrackId?: Id;
  /** Section kinds where the motif is primarily used. */
  sectionKinds?: SectionKind[];
}

export interface Phrase {
  id: Id;
  trackId: Id;
  startTick: Ticks;
  endTick: Ticks;
  label?: string;
  sectionId?: Id;
  motifId?: Id;
  lyricLineId?: Id;
}

// ---------------------------------------------------------------------------
// Instruments and tracks
// ---------------------------------------------------------------------------

export type InstrumentFamily =
  | 'drums'
  | 'percussion'
  | 'bass'
  | 'guitar'
  | 'keys'
  | 'organ'
  | 'strings'
  | 'brass'
  | 'woodwind'
  | 'synth'
  | 'vocal'
  | 'fx'
  | 'other';

/** Which generator produces the track's material (spec §16). */
export type TrackRole =
  | 'drums'
  | 'percussion'
  | 'bass'
  | 'rhythm-guitar'
  | 'lead-guitar'
  | 'keys'
  | 'strings'
  | 'synth-pad'
  | 'synth-arp'
  | 'synth-lead'
  | 'synth-seq'
  | 'vocal'
  | 'custom';

/** Musical function within the arrangement (spec §17 "Role: Counter-melody"). */
export type MusicalFunction =
  | 'melody'
  | 'counter-melody'
  | 'harmony'
  | 'accompaniment'
  | 'bass-line'
  | 'rhythm'
  | 'pad'
  | 'hook'
  | 'fills'
  | 'solo'
  | 'texture';

export type Complexity = 'low' | 'medium' | 'high';

export type AvoidRule =
  | 'double-vocal'
  | 'parallel-fifths'
  | 'busy-verses'
  | 'high-register'
  | 'low-register'
  | 'chromaticism'
  | 'syncopation'
  | 'large-leaps';

export interface InstrumentConstraints {
  lowest?: MidiPitch;
  highest?: MidiPitch;
  complexity?: Complexity;
  function?: MusicalFunction;
  /** Section ids where this track may play. Empty/undefined = arrangement engine decides. */
  sectionIds?: Id[];
  /** Section kinds where this track may play (used by blueprints before ids exist). */
  sectionKinds?: SectionKind[];
  avoid?: AvoidRule[];
}

export type StemGroup = 'vocals' | 'drums' | 'bass' | 'guitars' | 'keys' | 'strings' | 'others';

/** Instrument profile (spec §17). Built-in profiles live in composer/instruments; users may add custom ones. */
export interface InstrumentProfile {
  id: string;
  name: string;
  family: InstrumentFamily;
  /** General MIDI program 0..127 (ignored for drum kits, which use channel 10). */
  gmProgram: number;
  isDrumKit?: boolean;
  range: { low: MidiPitch; high: MidiPitch; comfortableLow?: MidiPitch; comfortableHigh?: MidiPitch };
  polyphony: 'mono' | 'poly';
  defaultRole: TrackRole;
  defaultFunction: MusicalFunction;
  articulations: Articulation[];
  /** Guide-render synth patch id (audio package). */
  patchId: string;
  clef: 'treble' | 'bass' | 'treble-8vb' | 'percussion' | 'grand';
  /** Written-vs-sounding transposition in semitones for notation (guitar = +12 written). */
  notationTranspose?: number;
  stemGroup: StemGroup;
  custom?: boolean;
}

export interface AudioClip {
  id: Id;
  assetId: Id;
  /** Timeline start position. */
  tick: Ticks;
  /** Offset into the asset where playback starts, seconds. */
  offsetSeconds: number;
  durationSeconds: number;
  gainDb: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  name?: string;
  /** Recording take id (user-recorded vocals). */
  takeId?: Id;
  muted?: boolean;
}

export type VocalMode = 'none' | 'melody-only' | 'placeholder' | 'ai-singer' | 'voice-conversion' | 'recorded';

export type VoiceType = 'soprano' | 'mezzo' | 'alto' | 'tenor' | 'baritone' | 'bass';

export interface Track {
  id: Id;
  name: string;
  kind: 'midi' | 'audio';
  role: TrackRole;
  /** InstrumentProfile id. */
  instrumentId: string;
  constraints: InstrumentConstraints;
  /** MIDI material (midi tracks). Kept sorted by tick then pitch. */
  notes: Note[];
  /** Audio material (audio tracks: stems, recordings, produced audio). */
  clips: AudioClip[];
  color: string;
  stemGroup: StemGroup;
  /** Per-track macro overrides (spec §19). */
  macros?: Partial<MacroSettings>;
  /** MIDI channel 0..15 (drums → 9). */
  midiChannel?: number;
  vocal?: { voiceType?: VoiceType; voiceId?: string; mode?: VocalMode };
  /** For audio tracks produced from a MIDI track (produced stem ↔ source). */
  sourceTrackId?: Id;
  /** Generation parameters for reproducibility. */
  generator?: { id: string; seed?: number; params?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Macros, locks, generation seeds
// ---------------------------------------------------------------------------

/** Macro controls (spec §19). All 0..1. */
export interface MacroSettings {
  /** Simple ↔ Complex */
  complexity: number;
  /** Calm ↔ Aggressive */
  energy: number;
  /** Sparse ↔ Busy */
  density: number;
  /** Mechanical ↔ Loose */
  humanization: number;
  /** Static ↔ Active */
  melodicMovement: number;
  /** Stable ↔ Dissonant */
  harmonicTension: number;
  /** Predictable ↔ Varied */
  repetition: number;
  /** Straight ↔ Syncopated */
  syncopation: number;
  /** Flat ↔ Expressive */
  dynamics: number;
}

/**
 * Lock map (spec §22). Keys are built with the helpers in `locks.ts`:
 *   song.tempo | song.key | song.meter | song.structure | song.chords | song.lyrics | song.motifs
 *   track:<trackId>                       whole track
 *   track:<trackId>:section:<sectionId>   one track within one section
 *   section:<sectionId>                   all material within a section
 *   chords:section:<sectionId>            harmony within one section
 *   lyrics:section:<sectionId>            lyrics within one section
 *   motif:<motifId>
 *   mixer:<trackId>                       mixer strip
 * Note-level locks use Note.locked.
 */
export type LockMap = Record<string, boolean>;

export type VariationLevel = 'ornament' | 'variation' | 'reinterpretation' | 'mutation';

export interface GenerationInfo {
  /** Composition seed (spec §23). */
  seed: number;
  /** Variation amount 0..1 (e.g. 0.2 = 20%). */
  variation: number;
  /** Version of the deterministic generation engine. Same inputs + seed + version → same output. */
  engineVersion: string;
  /** Provider configuration fingerprint used for AI-assisted parts (if any). */
  providerFingerprint?: string;
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Genre profiles (spec §14)
// ---------------------------------------------------------------------------

export interface GenreWeight {
  genreId: string;
  /** Relative weight; blends are normalized. */
  weight: number;
}

export type DrumStyle =
  | 'rock'
  | 'punk'
  | 'pop-punk'
  | 'emo'
  | 'metal'
  | 'indie'
  | 'pop'
  | 'synth-pop'
  | 'four-on-floor'
  | 'trance'
  | 'hip-hop'
  | 'trap'
  | 'rnb'
  | 'jazz-swing'
  | 'folk'
  | 'country'
  | 'orchestral'
  | 'cinematic'
  // Groove families added with the genre expansion (see composer/styles.ts for their traits).
  | 'funk'
  | 'disco'
  | 'soul'
  | 'gospel'
  | 'shuffle'
  | 'boom-bap'
  | 'one-drop'
  | 'ska'
  | 'dembow'
  | 'bossa-nova'
  | 'samba'
  | 'salsa'
  | 'cumbia'
  | 'afrobeats'
  | 'amapiano'
  | 'drum-and-bass'
  | 'breakbeat'
  | 'dubstep'
  | 'techno'
  | 'two-step'
  | 'drill'
  | 'phonk'
  | 'jersey-club'
  | 'footwork'
  | 'baile-funk'
  | 'flamenco'
  | 'celtic'
  | 'bhangra'
  | 'ambient';

/**
 * Idiomatic bass-line patterns a genre (or tag) can ask for. Without one the bass generator picks a
 * pattern from the drum style.
 */
export type BassPattern =
  | 'kick-lock'
  | 'eighths'
  | 'root-fifth'
  | 'walking'
  | 'offbeat'
  | 'rolling'
  | 'sustain'
  | 'eight-o-eight'
  | 'pulse'
  | 'octave'
  | 'funk'
  | 'boogie'
  | 'reggae'
  | 'tumbao'
  | 'bossa'
  | 'samba'
  | 'log-drum'
  | 'wobble';

/**
 * Idiomatic accompaniment (keys and rhythm guitar) a genre (or tag) can ask for: reggae/ska skank,
 * funk scratch, salsa montuno, bossa nova comping, bluegrass chop and banjo roll, flamenco
 * rasgueado, blues boogie, highlife picking, house stabs, arpeggios or sustained chords.
 */
export type CompStyle = 'skank' | 'funk' | 'montuno' | 'bossa' | 'chop' | 'roll' | 'rasgueado' | 'boogie' | 'highlife' | 'stabs' | 'arpeggio' | 'sustain';

export interface GenreProfile {
  id: string;
  name: string;
  description?: string;
  builtIn?: boolean;
  tags?: string[];
  tempo: { min: number; max: number; typical: number };
  meters: { numerator: number; denominator: number; weight: number }[];
  modes: { mode: ModeName; weight: number }[];
  harmony: {
    /** Weighted roman-numeral progressions; optionally restricted to section kinds. */
    progressions: { roman: string[]; weight: number; sectionKinds?: SectionKind[] }[];
    /** 0..1 probability of borrowed / modal-interchange chords. */
    borrowedChordRate: number;
    /** 0..1 probability of 7ths/9ths/extensions. */
    extensionRate: number;
    /** Typical chords per bar. */
    harmonicRhythm: number;
    /** Prefer power chords for guitars. */
    powerChords?: boolean;
  };
  structure: {
    templates: { name: string; weight: number; sections: { kind: SectionKind; bars: number; name?: string }[] }[];
  };
  instruments: { instrumentId: string; role: TrackRole; function?: MusicalFunction; weight: number; essential?: boolean }[];
  rhythm: {
    drumStyle: DrumStyle;
    /** 0 = straight, 1 = full triplet swing. */
    swing: number;
    /** 0..1 */
    syncopation: number;
    /** Base subdivision of grooves: 8ths, 16ths, or 12 (triplet 8ths). */
    subdivision: 8 | 12 | 16;
    halfTimeChance?: number;
    /** Idiomatic bass pattern (overrides the drum style's default). */
    bassStyle?: BassPattern;
    /** Idiomatic keys/guitar accompaniment (overrides the drum style's default). */
    compStyle?: CompStyle;
  };
  dynamics: {
    /** Typical energy (0..100) per section kind. */
    energyBySection: Partial<Record<SectionKind, number>>;
    /** 0..1 how wide dynamics are. */
    dynamicRange: number;
  };
  arrangement: {
    /** Number of active tracks at energy 0 and at energy 100, as fraction of the instrumentation (0..1). */
    densityAtLowEnergy: number;
    densityAtHighEnergy: number;
    /** Roles that typically sit out in given section kinds. */
    restsBySection?: Partial<Record<SectionKind, TrackRole[]>>;
    conventions: string[];
  };
  production: {
    description: string;
    reverb: number;
    /** Production prompt keywords for audio-generation providers. */
    keywords: string[];
    masteringTarget?: MasteringTarget;
  };
  macros?: Partial<MacroSettings>;
}

// ---------------------------------------------------------------------------
// Blueprint, plan, DNA (spec §10, §11, §15)
// ---------------------------------------------------------------------------

export interface BlueprintTrack {
  name: string;
  instrumentId: string;
  role: TrackRole;
  function?: MusicalFunction;
  constraints?: InstrumentConstraints;
  pan?: number;
}

export interface BlueprintSection {
  name: string;
  kind: SectionKind;
  bars: number;
  energy?: number;
  energyEnd?: number;
  purpose?: string;
  mood?: string[];
  /** Chord symbols ("Em","C") or roman numerals ("i","VI") for the section's progression. */
  harmony?: string[];
  feel?: SectionFeel;
}

export interface Blueprint {
  title: string;
  /** Original natural-language prompt, if any. */
  prompt?: string;
  tempo: number;
  meter: { numerator: number; denominator: number };
  key: KeySignature;
  /** Free-text style labels, e.g. ["Emo","Pop-punk","Alternative rock"]. */
  styles: string[];
  genreBlend: GenreWeight[];
  /** Mood statements, e.g. "Melancholy verses", "Cathartic chorus", "Defiant ending". */
  moods: string[];
  instrumentation: BlueprintTrack[];
  structure: BlueprintSection[];
  vocal?: { voiceType: VoiceType; mode: VocalMode; description?: string };
  lyricsTheme?: string;
  /**
   * Style, mood, era, production and other tag ids from the tag catalog (`composer/tags.ts`).
   * Tags nudge the blended genre profile and the macros; unknown ids are ignored.
   */
  tags?: string[];
  /** User-supplied lyrics the song is built from (lyrics-first composition). */
  lyrics?: BlueprintLyrics;
  macros: MacroSettings;
  seed: number;
}

/** Lyrics supplied up front, parsed into sections (see `musician/lyrics/sheet.ts`). */
export interface BlueprintLyrics {
  /** The text exactly as the user entered it. */
  text: string;
  /** Parsed stanzas in song order; repeated stanzas (e.g. a chorus) appear once per occurrence. */
  sections: { name: string; kind: SectionKind; lines: string[] }[];
  /** Lock the lyrics in the composed song (default true: they are the user's words). */
  lock?: boolean;
}

export interface PlanSection {
  name: string;
  kind: SectionKind;
  bars: number;
  /** Realized chord symbols for the section, in order (one per harmonic-rhythm slot, repeating to fill). */
  harmony: string[];
  energy: number;
  energyEnd?: number;
  purpose: string;
  feel?: SectionFeel;
}

/** Abstract composition plan produced before any MIDI (spec §15). */
export interface CompositionPlan {
  key: KeySignature;
  tempo: number;
  meter: { numerator: number; denominator: number };
  sections: PlanSection[];
  notes?: string;
  /** Who produced it: "internal" or provider id/model. */
  source?: string;
}

export interface SongDNA {
  tonalCenter: KeySignature;
  tempo: number;
  meter: { numerator: number; denominator: number };
  harmonicLanguage: {
    mode: ModeName;
    /** Roman numeral → relative frequency. */
    chordVocabulary: Record<string, number>;
    borrowedChordRate: number;
    extensionRate: number;
  };
  /** Principal chord movement per section kind. */
  principalProgressions: { sectionKind: SectionKind; roman: string[] }[];
  /** Snapshots of core motifs (copied so DNA survives motif deletion). */
  motifs: Motif[];
  /** Per role: 16-step onset histogram (normalized) + syncopation index. */
  rhythmicIdentity: { role: TrackRole; onsetGrid: number[]; syncopation: number; density: number }[];
  /** Per section kind: normalized 16-point contour of the main melody and its range in semitones. */
  melodicContour: { sectionKind: SectionKind; contour: number[]; range: number }[];
  instrumentation: { instrumentId: string; role: TrackRole }[];
  /** Structure as kinds and relative proportions. */
  structure: { kind: SectionKind; bars: number; proportion: number }[];
  energyCurve: number[];
  repetition: { pattern: string; repeatRatio: number };
  genreBlend: GenreWeight[];
  /** Tag ids of the song (style, mood, era…), carried into DNA compositions. */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Mixer, automation, mastering (spec §40, §42)
// ---------------------------------------------------------------------------

export interface EqSettings {
  enabled: boolean;
  /** High-pass cutoff Hz (0 = off). */
  highpassHz: number;
  lowShelfHz: number;
  lowShelfDb: number;
  lowMidHz: number;
  lowMidDb: number;
  lowMidQ: number;
  highMidHz: number;
  highMidDb: number;
  highMidQ: number;
  highShelfHz: number;
  highShelfDb: number;
  /** Low-pass cutoff Hz (0 = off). */
  lowpassHz: number;
}

export interface CompressorSettings {
  enabled: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeDb: number;
  makeupDb: number;
}

export interface ChannelStrip {
  volumeDb: number;
  /** -1 (L) .. +1 (R) */
  pan: number;
  mute: boolean;
  solo: boolean;
  eq: EqSettings;
  compressor: CompressorSettings;
  /** Send levels 0..1 to the shared reverb/delay buses. */
  reverbSend: number;
  delaySend: number;
  /** Stereo width 0 (mono) .. 1 (unchanged) .. 2 (wide). */
  width: number;
  /** Saturation / drive 0..1. */
  drive: number;
  phaseInvert?: boolean;
}

export interface ReverbSettings {
  type: 'room' | 'hall' | 'plate' | 'chamber';
  /** 0..1 */
  size: number;
  decaySeconds: number;
  /** 0..1 high-frequency damping */
  damping: number;
  preDelayMs: number;
  returnDb: number;
}

export interface DelaySettings {
  /** Delay time in beats (quarter notes), e.g. 0.75 = dotted eighth. */
  timeBeats: number;
  feedback: number;
  highCutHz: number;
  lowCutHz: number;
  pingPong: boolean;
  returnDb: number;
}

export interface MasterBus {
  volumeDb: number;
  eq: EqSettings;
  compressor: CompressorSettings;
  limiter: { enabled: boolean; ceilingDb: number; releaseMs: number };
  width: number;
}

export interface MixerState {
  /** Channel strip per track id. Missing entries use defaults. */
  channels: Record<Id, ChannelStrip>;
  master: MasterBus;
  reverb: ReverbSettings;
  delay: DelaySettings;
}

export type AutomationParam =
  | 'volumeDb'
  | 'pan'
  | 'reverbSend'
  | 'delaySend'
  | 'width'
  | 'drive'
  | 'eq.lowShelfDb'
  | 'eq.lowMidDb'
  | 'eq.highMidDb'
  | 'eq.highShelfDb'
  | 'eq.lowpassHz'
  | 'eq.highpassHz';

export interface AutomationPoint {
  tick: Ticks;
  value: number;
  /** Interpolation from this point to the next. */
  curve?: 'linear' | 'step';
}

export interface AutomationLane {
  id: Id;
  /** Track id or "master". */
  target: Id | 'master';
  param: AutomationParam;
  points: AutomationPoint[];
  enabled: boolean;
}

export type MasteringTarget = 'streaming' | 'cd' | 'loud-rock' | 'dynamic' | 'podcast' | 'demo';

export interface MasteringSettings {
  method: 'builtin' | 'local-ai' | 'cloud' | 'external' | 'none';
  target: MasteringTarget;
  providerId?: string;
  /** Extra tonal shaping -1..1 (dark ↔ bright). */
  tone: number;
  /** Stereo width 0..2 applied at mastering. */
  width: number;
  lastMasterAssetId?: Id;
}

// ---------------------------------------------------------------------------
// Production & vocals (spec §29-§38, Phase 3/4)
// ---------------------------------------------------------------------------

export type ProductionStrategy = 'full' | 'stems' | 'hybrid';

/** Per-track production method for hybrid production (spec §38 Strategy C). */
export type TrackProductionMethod = 'guide' | 'sampled' | 'external' | 'ai' | 'singing' | 'recorded' | 'off';

export interface ProductionCandidate {
  id: Id;
  /** "A", "B", "C"… */
  label: string;
  providerId: string;
  modelId?: string;
  seed: number;
  /** Full mix asset. */
  mixAssetId?: Id;
  /** Produced stems by track id. */
  stemAssetIds: Record<Id, Id>;
  createdAt: string;
  costUsd?: number;
  rating?: number;
  notes?: string;
  strategy: ProductionStrategy;
  /** Revision of the composition this candidate was produced from (composition identical across A/B). */
  sourceRevisionId?: Id;
}

export interface ProductionSettings {
  strategy: ProductionStrategy;
  /** Global production instructions (spec §29 "production instructions"). */
  prompt: string;
  negativePrompt: string;
  /** Per-section production instructions by section id. */
  sectionPrompts: Record<Id, string>;
  trackMethods: Record<Id, TrackProductionMethod>;
  providerId?: string;
  modelId?: string;
  candidates: ProductionCandidate[];
  selectedCandidateId?: Id;
  referenceAudioAssetId?: Id;
  /** Explicit permission to send reference audio to cloud providers. */
  allowReferenceUpload: boolean;
  /** Guide render assets. */
  guideMixAssetId?: Id;
  guideStemAssetIds: Record<string, Id>;
}

export interface VocalTake {
  id: Id;
  assetId: Id;
  trackId: Id;
  createdAt: string;
  name: string;
  /** Selected/comped take. */
  active: boolean;
}

export interface VocalRender {
  id: Id;
  trackId: Id;
  assetId: Id;
  /** Section or phrase the render covers (whole track if both undefined). */
  sectionId?: Id;
  phraseId?: Id;
  startTick: Ticks;
  endTick: Ticks;
  providerId: string;
  voiceId: string;
  seed: number;
  createdAt: string;
}

export interface VocalSettings {
  mode: VocalMode;
  /** Voice model id (see VoiceModelRecord in project meta). */
  voiceId?: string;
  /** Target voice for voice conversion. */
  conversionVoiceId?: string;
  language: string;
  renders: VocalRender[];
  takes: VocalTake[];
  /** Global default expression for the lead vocal. */
  defaultExpression: VocalExpression;
}

// ---------------------------------------------------------------------------
// The Song (song.json)
// ---------------------------------------------------------------------------

export interface Song {
  schemaVersion: number;
  id: Id;
  title: string;
  ppq: number;
  tempoMap: TempoEvent[];
  meterMap: MeterEvent[];
  keyMap: KeyEvent[];
  sections: Section[];
  chords: ChordEvent[];
  tracks: Track[];
  motifs: Motif[];
  phrases: Phrase[];
  lyrics: LyricLine[];
  automation: AutomationLane[];
  mixer: MixerState;
  macros: MacroSettings;
  locks: LockMap;
  genreBlend: GenreWeight[];
  /**
   * Tag ids from the tag catalog (`composer/tags.ts`) the song was composed with. They shape the
   * blended genre profile and shift `macros` (the user's base) at generation time, so
   * regeneration and variations keep them. Falls back to `blueprint.tags` when absent.
   */
  tags?: string[];
  blueprint?: Blueprint;
  plan?: CompositionPlan;
  dna?: SongDNA;
  generation: GenerationInfo;
  production: ProductionSettings;
  vocals: VocalSettings;
  mastering: MasteringSettings;
}

// ---------------------------------------------------------------------------
// Structured musical operations (spec §46) — produced by AI providers or the
// internal engine, validated and applied by the Music Engine. Bars/beats here
// are 1-BASED (musician convention); pitches may be MIDI numbers or names ("E2").
// ---------------------------------------------------------------------------

export interface OpRegion {
  /** 1-based first bar (inclusive). */
  start_bar: number;
  /** 1-based last bar (inclusive). */
  end_bar: number;
}

export interface OpNote {
  pitch: number | string;
  /** 1-based bar. */
  bar: number;
  /** 1-based beat within the bar; fractional allowed (1.5 = the "and" of 1 in 4/4). */
  beat: number;
  /** Duration in beats (quarter notes in x/4; eighths in x/8). */
  duration_beats: number;
  velocity?: number;
  articulation?: Articulation;
  syllable?: string;
  expression?: VocalExpression;
}

export interface OpChord {
  bar: number;
  beat: number;
  symbol: string;
  duration_beats: number;
}

/** Track reference: track id, exact track name, or role (first match). */
export type TrackRef = string;

export interface NoteTransform {
  /** Chromatic transposition in semitones. */
  transpose?: number;
  /** Diatonic transposition in scale steps (key-aware). */
  transpose_diatonic?: number;
  velocity_scale?: number;
  velocity_add?: number;
  /** Shift in beats (may be negative). */
  time_shift_beats?: number;
  duration_scale?: number;
  /** Quantize grid in beats (0.25 = 16ths in 4/4). */
  quantize_beats?: number;
  /** Quantize strength 0..1 (default 1). */
  quantize_strength?: number;
  /** Humanize amount 0..1. */
  humanize?: number;
  articulation?: Articulation;
}

export type MusicOperation =
  | { op: 'replace_notes'; track: TrackRef; region: OpRegion; notes: OpNote[]; reason?: string }
  | { op: 'add_notes'; track: TrackRef; notes: OpNote[]; reason?: string }
  | { op: 'delete_notes'; track: TrackRef; region?: OpRegion; note_ids?: Id[]; pitch_range?: [number, number]; reason?: string }
  | { op: 'transform_notes'; track: TrackRef; region?: OpRegion; note_ids?: Id[]; transform: NoteTransform; reason?: string }
  | { op: 'set_chords'; region: OpRegion; chords: OpChord[]; reason?: string }
  | { op: 'set_tempo'; bpm: number; at_bar?: number; reason?: string }
  | { op: 'set_key'; tonic: string; mode: ModeName; at_bar?: number; transpose_notes?: boolean; reason?: string }
  | { op: 'set_meter'; numerator: number; denominator: number; at_bar?: number; reason?: string }
  | {
      op: 'update_section';
      section: Id | string;
      changes: Partial<Pick<Section, 'name' | 'kind' | 'energy' | 'energyEnd' | 'purpose' | 'mood' | 'feel' | 'progression'>> & { bars?: number };
      reason?: string;
    }
  | {
      op: 'insert_section';
      after?: Id | string;
      section: { name: string; kind: SectionKind; bars: number; energy?: number; purpose?: string };
      copy_from?: Id | string;
      reason?: string;
    }
  | { op: 'remove_section'; section: Id | string; reason?: string }
  | { op: 'move_section'; section: Id | string; to_index: number; reason?: string }
  | { op: 'set_lyrics'; section: Id | string; lines: string[]; reason?: string }
  | { op: 'set_mixer'; track: TrackRef | 'master'; changes: MixerChange; reason?: string }
  | { op: 'set_automation'; track: TrackRef | 'master'; param: AutomationParam; points: { bar: number; beat: number; value: number }[]; reason?: string }
  | { op: 'set_expression'; track: TrackRef; region?: OpRegion; note_ids?: Id[]; expression: VocalExpression; reason?: string }
  | { op: 'add_track'; name: string; instrument_id: string; role: TrackRole; function?: MusicalFunction; reason?: string }
  | { op: 'remove_track'; track: TrackRef; reason?: string }
  | { op: 'set_instrument'; track: TrackRef; instrument_id: string; reason?: string }
  | { op: 'set_macros'; track?: TrackRef; macros: Partial<MacroSettings>; reason?: string }
  | { op: 'set_lock'; key: string; locked: boolean; reason?: string }
  | {
      op: 'regenerate';
      track?: TrackRef;
      region?: OpRegion;
      sections?: (Id | string)[];
      level?: VariationLevel;
      seed?: number;
      reason?: string;
    };

/** Flattened mixer change for set_mixer (dot paths for nested EQ/compressor fields). */
export type MixerChange = Partial<{
  volumeDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  reverbSend: number;
  delaySend: number;
  width: number;
  drive: number;
  'eq.enabled': boolean;
  'eq.highpassHz': number;
  'eq.lowShelfHz': number;
  'eq.lowShelfDb': number;
  'eq.lowMidHz': number;
  'eq.lowMidDb': number;
  'eq.lowMidQ': number;
  'eq.highMidHz': number;
  'eq.highMidDb': number;
  'eq.highMidQ': number;
  'eq.highShelfHz': number;
  'eq.highShelfDb': number;
  'eq.lowpassHz': number;
  'compressor.enabled': boolean;
  'compressor.thresholdDb': number;
  'compressor.ratio': number;
  'compressor.attackMs': number;
  'compressor.releaseMs': number;
  'compressor.makeupDb': number;
}>;

// ---------------------------------------------------------------------------
// Validation (spec §48) and proposals (spec §21)
// ---------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: IssueSeverity;
  /** Stable machine code, e.g. "note.out-of-range", "lock.violated", "region.outside". */
  code: string;
  message: string;
  trackId?: Id;
  noteId?: Id;
  sectionId?: Id;
  opIndex?: number;
  /** True when the engine auto-fixed the problem (e.g. octave-shifted into range). */
  fixed?: boolean;
}

export interface ValidationReport {
  /** False if any unfixed error remains. */
  ok: boolean;
  issues: ValidationIssue[];
}

export interface NoteChange {
  before: Note;
  after: Note;
}

export interface TrackDiff {
  trackId: Id;
  trackName: string;
  added: Note[];
  removed: Note[];
  modified: NoteChange[];
}

export interface SongDiff {
  tracks: TrackDiff[];
  chords: { added: ChordEvent[]; removed: ChordEvent[] };
  sectionsChanged: boolean;
  tempoChanged: boolean;
  keyChanged: boolean;
  meterChanged: boolean;
  lyricsChanged: boolean;
  mixerChanged: { target: Id | 'master'; field: string; before: unknown; after: unknown }[];
  automationChanged: boolean;
  tracksAdded: Id[];
  tracksRemoved: Id[];
  /** Human-readable summary lines. */
  summary: string[];
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface Proposal {
  id: Id;
  title: string;
  instruction?: string;
  /** "internal" (deterministic engine) or a provider id. */
  source: string;
  modelId?: string;
  createdAt: string;
  baseRevisionId?: Id;
  operations: MusicOperation[];
  /** The song the proposal was computed against. */
  before: Song;
  /** The proposed song (editable while pending — "Modify"). */
  after: Song;
  diff: SongDiff;
  validation: ValidationReport;
  status: ProposalStatus;
  /** Natural-language explanation from the proposer. */
  explanation?: string;
}

// ---------------------------------------------------------------------------
// Project-level metadata (project.json) — spec §9, §36, §52, §64, §65
// ---------------------------------------------------------------------------

export type AssetKind =
  | 'reference'
  | 'guide-render'
  | 'generation'
  | 'vocal'
  | 'master'
  | 'stem'
  | 'recording'
  | 'import'
  | 'analysis';

export interface AudioAssetMeta {
  id: Id;
  name: string;
  kind: AssetKind;
  /** Path inside the .songproject package, e.g. "audio/guide-renders/guide_mix.wav". */
  path: string;
  mimeType: string;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  bytes: number;
  createdAt: string;
  provenanceId?: Id;
}

export interface ProvenanceSource {
  /** e.g. "midi", "lyrics", "audio", "song", "voice" */
  kind: string;
  /** e.g. "vocal.mid", track id, asset id */
  ref: string;
  /** Revision number of the source (e.g. vocal.mid v8). */
  revision?: number;
}

/** How an artifact was created (spec §64). */
export interface ProvenanceRecord {
  id: Id;
  artifactId: Id;
  /** e.g. "chorus-vocal-v4.wav" */
  artifactName: string;
  artifactKind: 'midi' | 'audio' | 'lyrics' | 'plan' | 'analysis' | 'mix' | 'master' | 'song';
  sources: ProvenanceSource[];
  providerId: string;
  providerName: string;
  modelId?: string;
  seed?: number;
  parameters?: Record<string, unknown>;
  engineVersion?: string;
  taskId?: Id;
  generatedAt: string;
  /** Whether any data left the device to produce this artifact. */
  cloud: boolean;
  costUsd?: number;
}

export type VoiceKind = 'stock' | 'user-trained' | 'imported' | 'third-party';

export interface VoiceConsent {
  /** Person attesting authorization. */
  attestedBy: string;
  /** Rights holder / person whose voice it is. */
  rightsHolder: string;
  basis: 'own-voice' | 'written-permission' | 'license' | 'stock' | 'public-domain';
  evidence?: string;
  scope?: string;
  attestedAt: string;
}

/** Voice model with provenance (spec §36). */
export interface VoiceModelRecord {
  id: Id;
  name: string;
  kind: VoiceKind;
  providerId: string;
  /** Provider-specific voice/model reference. */
  modelRef: string;
  voiceType?: VoiceType;
  language?: string;
  description?: string;
  /** Required for anything other than stock voices before cloning/conversion. */
  consent?: VoiceConsent;
  createdAt: string;
}

/** Rights and attribution metadata (spec §65). */
export interface RightsMetadata {
  humanComposers: string[];
  lyricWriters: string[];
  performers: string[];
  aiAssistance: string;
  voiceModels: string[];
  modelProviders: string[];
  sourceReferences: string[];
  samples: string[];
  licensedAssets: string[];
  copyrightNotice?: string;
  notes?: string;
}

export interface Branch {
  id: Id;
  name: string;
  headRevisionId: Id;
  /** Revision the branch was created from. */
  baseRevisionId?: Id;
  createdAt: string;
  description?: string;
}

export type RevisionKind =
  | 'create'
  | 'generate'
  | 'regenerate'
  | 'variation'
  | 'edit'
  | 'ai-proposal'
  | 'structure'
  | 'harmony'
  | 'lyrics'
  | 'mix'
  | 'production'
  | 'vocals'
  | 'import'
  | 'restore'
  | 'merge'
  | 'branch';

export interface Revision {
  id: Id;
  /** Display number (v12, v13…), monotonically increasing per project. */
  number: number;
  /** Parent revision ids (2 for merges). */
  parents: Id[];
  branchId: Id;
  message: string;
  kind: RevisionKind;
  createdAt: string;
  author?: string;
  /** Full song snapshot at this revision. */
  snapshot: Song;
}

export interface HistoryState {
  revisions: Revision[];
  branches: Branch[];
  currentBranchId: Id;
}

export interface ProjectMeta {
  formatVersion: number;
  id: Id;
  name: string;
  createdAt: string;
  updatedAt: string;
  rights: RightsMetadata;
  assets: AudioAssetMeta[];
  provenance: ProvenanceRecord[];
  voices: VoiceModelRecord[];
  /** Provider ids that have produced artifacts in this project (informational; project never depends on them). */
  providersUsed: { providerId: string; providerName: string; lastUsedAt: string }[];
  /** Custom genre/instrument profiles bundled with the project so it stays portable. */
  customGenres: GenreProfile[];
  customInstruments: InstrumentProfile[];
  settings: {
    providerProfileId?: string;
    /** Data kinds that must never leave the device for this project. */
    neverUpload: string[];
  };
}

/** In-memory project. Audio asset bytes are kept in an AssetStore keyed by asset id. */
export interface Project {
  meta: ProjectMeta;
  /** Working copy (equals the head revision snapshot after each commit). */
  song: Song;
  history: HistoryState;
  /** Analysis results (rebuild/transcription reports) stored under analysis/. */
  analysis: AnalysisRecord[];
  /** Generation records (requests, proposals history) stored under generations/. */
  generations: GenerationRecord[];
}

export interface AnalysisRecord {
  id: Id;
  kind: 'transcription' | 'rebuild' | 'loudness' | 'separation' | 'chords' | 'key' | 'tempo' | 'structure';
  createdAt: string;
  sourceAssetId?: Id;
  summary: string;
  /** Overall confidence 0..1. */
  confidence?: number;
  data: unknown;
}

export interface GenerationRecord {
  id: Id;
  kind: string;
  createdAt: string;
  providerId: string;
  modelId?: string;
  seed?: number;
  instruction?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  revisionId?: Id;
  proposalId?: Id;
  costUsd?: number;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Task engine (spec §63)
// ---------------------------------------------------------------------------

export type TaskStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface TaskLogEntry {
  t: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface TaskRecord<I = unknown, O = unknown> {
  id: Id;
  type: string;
  title: string;
  status: TaskStatus;
  /** 0..1 */
  progress: number;
  message?: string;
  input: I;
  result?: O;
  error?: string;
  attempts: number;
  maxAttempts: number;
  /** Opaque resumable state saved by the handler. */
  checkpoint?: unknown;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  dependsOn: Id[];
  priority: number;
  logs: TaskLogEntry[];
  providerId?: string;
  costUsd?: number;
  /** Where it runs: "local", a render-node id, or a provider id. */
  runner?: string;
}

// ---------------------------------------------------------------------------
// Shared request shapes used across engine, AI orchestrator and UI
// ---------------------------------------------------------------------------

/** What the user has selected in the workbench (for AI edits, regeneration, vocal commands). */
export interface EditSelection {
  trackIds?: Id[];
  noteIds?: Id[];
  /** Selected time range [startTick, endTick). */
  startTick?: Ticks;
  endTick?: Ticks;
  sectionIds?: Id[];
}

/** "Generate MIDI" mode request (spec §25): an individual musical asset. */
export interface AssetRequest {
  /** Original prompt, e.g. "Create a melancholy 16-bar cello melody in D minor". */
  description: string;
  instrumentId: string;
  role: TrackRole;
  function?: MusicalFunction;
  bars: number;
  key: KeySignature;
  tempo: number;
  meter: { numerator: number; denominator: number };
  moods: string[];
  genreIds: string[];
  /** Number of alternatives to generate ("four alternative bass lines"). */
  count: number;
  /** Chord progression (symbols or roman numerals) to generate over, if given. */
  progression?: string[];
  complexity?: Complexity;
  seed?: number;
}
