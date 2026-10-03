import {
  createProposal,
  getInstrument,
  findSection,
  findTrack,
  randomSeed,
  regenerateUnlocked,
  regionToTicks,
  type MusicOperation,
  type Proposal,
  type Song,
} from '@songdeck/core';
import { useStudio } from '../state/store';
import { allCustomInstruments } from './plugins';

type RegenerateOp = Extract<MusicOperation, { op: 'regenerate' }>;

/** Executes `regenerate` operations with the deterministic composer, honoring locks. */
export function regenerateForOp(song: Song, op: RegenerateOp): Song {
  const customInstruments = allCustomInstruments(useStudio.getState().project?.meta.customInstruments);
  const track = op.track ? findTrack(song, op.track) : undefined;
  const sectionIds = (op.sections ?? []).map((s) => findSection(song, s)?.id).filter((x): x is string => !!x);
  const range = op.region ? regionToTicks(song, op.region) : undefined;
  return regenerateUnlocked(song, {
    seed: op.seed ?? randomSeed(),
    trackIds: track ? [track.id] : undefined,
    sectionIds: sectionIds.length ? sectionIds : undefined,
    startTick: range?.startTick,
    endTick: range?.endTick,
    level: op.level,
    customInstruments,
  }).song;
}

export interface ProposalMeta {
  title: string;
  source: string;
  modelId?: string;
  instruction?: string;
  explanation?: string;
}

/** Build a validated proposal from operations against `song` (spec §21, §46, §48). */
export function buildProposal(song: Song, ops: MusicOperation[], meta: ProposalMeta): Proposal {
  const project = useStudio.getState().project;
  const head = project?.history.branches.find((b) => b.id === project.history.currentBranchId)?.headRevisionId;
  const customInstruments = allCustomInstruments(project?.meta.customInstruments);
  return createProposal(song, ops, {
    ...meta,
    baseRevisionId: head,
    regenerate: regenerateForOp,
    customInstruments,
    resolveInstrument: (id: string) => getInstrument(id, customInstruments),
  });
}

/** Create a proposal and surface it for review (visual diff in the piano roll + Proposals panel). */
export function propose(song: Song, ops: MusicOperation[], meta: ProposalMeta, opts: { openPianoRoll?: boolean } = {}): Proposal | null {
  const st = useStudio.getState();
  if (!ops.length) {
    st.toast('info', meta.explanation ?? 'No changes were proposed.');
    return null;
  }
  const proposal = buildProposal(song, ops, meta);
  const changedTracks = proposal.diff.tracks.filter((t) => t.added.length || t.removed.length || t.modified.length);
  const anyChange =
    changedTracks.length ||
    proposal.diff.chords.added.length ||
    proposal.diff.chords.removed.length ||
    proposal.diff.sectionsChanged ||
    proposal.diff.tempoChanged ||
    proposal.diff.keyChanged ||
    proposal.diff.lyricsChanged ||
    proposal.diff.mixerChanged.length ||
    proposal.diff.automationChanged ||
    proposal.diff.tracksAdded.length ||
    proposal.diff.tracksRemoved.length;
  if (!anyChange) {
    const reasons = proposal.validation.issues.filter((i) => i.severity !== 'info').map((i) => i.message);
    st.toast('warning', reasons.length ? `Proposal had no effect: ${reasons.slice(0, 2).join('; ')}` : 'Proposal produced no changes.');
    return null;
  }
  st.addProposal(proposal);
  if (opts.openPianoRoll && changedTracks.length === 1) {
    st.selectTrack(changedTracks[0].trackId);
    st.setWorkbenchView('piano-roll');
  }
  // Other modes (Mix, Vocals…) show their own proposal UI; leave the workbench layout alone.
  if (st.mode === 'workbench') st.setRightPanel('proposals');
  return proposal;
}
