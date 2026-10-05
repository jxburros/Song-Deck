/**
 * Musician — the deterministic, offline musical intelligence layer (spec §20, §25, §33-§37, §41,
 * §43, §44, §48). Interprets natural-language requests into structured `MusicOperation`s (§46),
 * explains music theory, handles lyrics and answers questions about the project — the same jobs
 * cloud LLM providers do, but rule-based, seeded and fast. Nothing here mutates a song: the edit
 * module validates and applies the returned operations as a Proposal (§21).
 */
export type {
  EditInterpretation,
  ExplainedChord,
  SectionExplanation,
  SongExplanation,
  TheoryControl,
  ChordSuggestion,
  LyricAlignmentStatus,
  LyricAlignmentEntry,
  LyricAlignmentResult,
  AlignLyricsOptions,
  PlaceholderLyricsOptions,
  VocalInterpretation,
  AssistantAnswer,
} from './types';

// §20 AI MIDI editing
export { interpretEditInstruction, EDIT_HELP as MUSICIAN_EDIT_HELP } from './edit-interpreter';
export type { EditIntentId, EditInterpreterOptions } from './edit-interpreter';

// §43 Theory View
export { explainSection, explainSong } from './theory-explain';
export { applyTheoryControl, suggestChordSubstitutions } from './theory-controls';

// Lyrics (§33-§35, §48)
export { syllabify, syllabifyText, countSyllables, lyricTokens } from './lyrics/syllables';
export { textToPhonemes, syllableToPhonemes, wordsToPhonemes, wordStress, lyricStress } from './lyrics/g2p';
export { alignLyrics, validateLyricAlignment } from './lyrics/align';
export {
  applyTimedLyrics,
  timedSyllables,
  type TimedLyricWord,
  type TimedLyricPhrase,
  type TimedLyricsOptions,
  type TimedLyricsResult,
} from './lyrics/timed';
export { generatePlaceholderLyrics } from './lyrics/placeholder';
export {
  parseLyricSheet,
  parseSectionHeader,
  isChordLine,
  stanzaSimilarity,
  lyricLineCount,
  type LyricSheetSection,
} from './lyrics/sheet';
export { suggestMoodsFromLyrics, type LyricMoodReading } from './lyrics/mood';

// §37 vocal regeneration commands
export { interpretVocalInstruction } from './vocal-commands';

// §41 AI mix assistant
export { interpretMixInstruction } from './mix-assistant';

// §44 project-aware offline assistant
export { answerQuestion } from './assistant';

// §25 Generate MIDI mode
export { parseAssetPrompt, keyFromChords } from './asset-prompt';
