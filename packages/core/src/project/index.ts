/**
 * Project manager (spec §9, §52-§53, §64-§65): .songproject packages, version history,
 * branches, restore/compare/merge, undo/redo, assets, provenance and rights metadata.
 */
export { packProject, unpackProject, scrubSecrets, PROJECT_PACKAGE_FORMAT } from './package';
export type { PackOptions } from './package';
export {
  headRevision,
  currentBranch,
  getRevision,
  branchLog,
  commitRevision,
  restoreRevision,
  createBranch,
  switchBranch,
  renameBranch,
  deleteBranch,
  duplicateProject,
  compareRevisions,
  mergeSongs,
  mergeSelected,
  undoTarget,
  redoTarget,
  canUndo,
  canRedo,
  stepHistory,
  undoRevision,
  redoRevision,
} from './history';
export type { HistoryOptions, MergeSelection, MergeResult } from './history';
export {
  ASSET_FOLDERS,
  assetPathFor,
  sanitizeAssetFileName,
  addAsset,
  removeAsset,
  addProvenance,
  provenanceFor,
  recordProviderUse,
  addAnalysisRecord,
  addGenerationRecord,
  updateRights,
} from './assets';
export {
  ATTESTATION_BASIS_LABEL,
  ATTESTATION_BASIS_SHORT,
  addAttestation,
  attestationNeedsCare,
  attestationRightsLine,
  attestationRightsList,
  attestationSummaryLines,
  attestationsNeedingCare,
  projectAttestations,
  rightsSummaryText,
} from './rights';
