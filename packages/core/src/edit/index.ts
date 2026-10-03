/**
 * Structured operations, Validation Engine, diffs and proposals (spec §21, §46, §48).
 *
 *   AI output → MusicOperation[] → applyOperations (validated, applied to a clone)
 *             → createProposal (diff + validation) → user accepts → new revision.
 */
export { applyOperations } from './apply';
export type { ApplyOptions, ApplyResult, RegenerateOperation } from './apply';
export { validateSong, validateChange } from './validate';
export type { ValidateOptions, ValidateChangeOptions } from './validate';
export { diffSongs, diffTrackNotes } from './diff';
export {
  createProposal,
  proposalFromSongs,
  modifyProposal,
  acceptProposal,
  acceptProposalOnto,
  rejectProposal,
  setProposalStatus,
  repairInvalidNotes,
} from './proposal';
export { rebaseProposal } from './rebase';
export type { RebaseResult } from './rebase';
export type { ProposalMeta } from './proposal';
export { noteToOpNote, opNoteToNote } from './op-context';
export { restoreLockedMaterial } from './locks-check';
export type { InstrumentResolver } from './instruments';
