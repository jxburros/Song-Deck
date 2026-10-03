/**
 * Composition Engine (spec §10-§24): genres, instruments, blueprint parsing, planning, role
 * generators, arrangement, macros, lock-safe regeneration, variation, Song DNA and branch templates.
 */
export { BUILTIN_GENRES, getGenre, blendGenres } from './genres';
export { BUILTIN_INSTRUMENTS, getInstrument, instrumentForGmProgram } from './instruments';
export { parsePromptToBlueprint, defaultBlueprint } from './blueprint';
export { planComposition, type PlanOptions as PlanCompositionOptions } from './planner';
export { composeSong, type ComposeOptions as ComposeSongOptions } from './compose';
export { applyPlanToSong } from './structure';
export { computeArrangement } from './arrangement';
export { applyMacroTransforms } from './macros';
export { regenerateUnlocked, type RegenerateOptions, type RegenerateResult } from './regenerate';
export { createVariation, BRANCH_TEMPLATES, type ComposerBranchTemplate, type VariationOptions as CreateVariationOptions } from './variation';
export { extractSongDNA, composeFromDNA, type ComposeFromDnaOptions } from './dna';
export { generateAsset, type GenerateAssetOptions } from './asset';
export {
  blueprintFromChoices,
  applyBuilderConstraints,
  normalizeGenreWeights,
  resolveTagIds,
  builderTagIds,
  builderBlend,
  builderGenre,
  tempoForFeel,
  tempoBand,
  structureTemplateNames,
  genreExpectsVocal,
  suggestInstruments,
  titleFromLyrics,
  type BuilderChoices,
  type BuilderInstrument,
  type BuilderGenre,
  type BuilderMood,
  type BuilderVocal,
  type BuilderOptions,
  type TempoFeel,
  type SongLength,
} from './builder';
export {
  structureFromLyrics,
  lyricSectionBars,
  syllablesPerBar,
  matchLyricsToSections,
  placeBlueprintLyrics,
  leadVocalTrack,
  creditLyricWriter,
  INSTRUMENTAL_KINDS,
  type LyricsStructureOptions,
} from './lyrics-first';
export {
  BUILTIN_TAGS,
  listTags,
  getTag,
  findTags,
  tagParents,
  applyTagsToGenre,
  applyTagsToMacros,
  genreForBlueprint,
  type StyleTag,
  type TagKind,
  type TagEffect,
} from './tags';
