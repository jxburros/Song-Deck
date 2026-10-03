import type { MusicOperation, Proposal, ProposalStatus, Song, ValidationIssue, ValidationReport } from '../ir/types';
import { cloneSong, sortNotes } from '../ir/song-utils';
import { randomId } from '../util/ids';
import { applyOperations } from './apply';
import { diffSongs } from './diff';
import type { ApplyOptions } from './op-context';
import { foldMidi } from './op-context';
import { lockViolations, restoreLockedMaterial } from './locks-check';
import { IssueList, makeReport, mergeReports } from './util';
import { validateChange, validateSong, type ValidateOptions } from './validate';

export interface ProposalMeta {
  title: string;
  /** "internal" (deterministic engine) or a provider id. */
  source: string;
  modelId?: string;
  instruction?: string;
  explanation?: string;
  baseRevisionId?: string;
  /** Explicit proposal id (default: random). */
  id?: string;
  /** ISO timestamp (default: now). */
  createdAt?: string;
}

function issueKey(i: ValidationIssue): string {
  return `${i.severity}|${i.code}|${i.trackId ?? ''}|${i.noteId ?? ''}|${i.sectionId ?? ''}|${i.message}`;
}

/** Issues present in `after` but not in `before` (pre-existing problems are not blamed on a proposal). */
function newIssues(before: ValidationReport, after: ValidationReport): ValidationReport {
  const seen = new Set(before.issues.map(issueKey));
  return makeReport(after.issues.filter((i) => !seen.has(issueKey(i))));
}

function safeCloneOps(ops: unknown): MusicOperation[] {
  if (!Array.isArray(ops)) return [];
  try {
    return JSON.parse(JSON.stringify(ops)) as MusicOperation[];
  } catch {
    return [];
  }
}

function validateOpts(opts: ApplyOptions): ValidateOptions {
  return { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument };
}

/**
 * Proposed Change System (spec §21): apply operations to a copy of `before`, validate, diff.
 * The user then accepts (→ new revision), rejects, or modifies the proposal.
 */
export function createProposal(before: Song, ops: MusicOperation[], meta: ProposalMeta & ApplyOptions): Proposal {
  const { song: after, report } = applyOperations(before, ops, meta);
  const vopts = validateOpts(meta);
  const validation = mergeReports(report, newIssues(validateSong(before, vopts), validateSong(after, vopts)));
  return buildProposal(before, after, safeCloneOps(ops), validation, meta);
}

function buildProposal(before: Song, after: Song, operations: MusicOperation[], validation: ValidationReport, meta: ProposalMeta): Proposal {
  const p: Proposal = {
    id: meta.id ?? randomId('prop'),
    title: meta.title,
    source: meta.source,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    operations,
    before: cloneSong(before),
    after,
    diff: diffSongs(before, after),
    validation,
    status: 'pending',
  };
  if (meta.instruction !== undefined) p.instruction = meta.instruction;
  if (meta.modelId !== undefined) p.modelId = meta.modelId;
  if (meta.baseRevisionId !== undefined) p.baseRevisionId = meta.baseRevisionId;
  if (meta.explanation !== undefined) p.explanation = meta.explanation;
  return p;
}

/**
 * Repair MIDI-invalid data in a whole song (proposals from providers that return full songs):
 * non-finite notes removed, pitches folded into 0–127, velocities clamped, durations ≥ 1, notes sorted.
 */
export function sanitizeSong(song: Song, issues: IssueList): Song {
  for (const t of song.tracks ?? []) {
    if (!Array.isArray(t.notes)) {
      t.notes = [];
      continue;
    }
    let removed = 0;
    let fixed = 0;
    t.notes = t.notes.filter((n) => {
      if (!n || typeof n.id !== 'string' || ![n.pitch, n.tick, n.duration, n.velocity].every((v) => typeof v === 'number' && Number.isFinite(v)) || n.tick < 0) {
        removed++;
        return false;
      }
      const pitch = n.pitch < 0 || n.pitch > 127 || !Number.isInteger(n.pitch) ? foldMidi(n.pitch) : n.pitch;
      const velocity = Math.round(Math.min(127, Math.max(1, n.velocity)));
      const duration = Math.max(1, Math.round(n.duration));
      const tick = Math.round(n.tick);
      if (pitch !== n.pitch || velocity !== n.velocity || duration !== n.duration || tick !== n.tick) {
        fixed++;
        n.pitch = pitch;
        n.velocity = velocity;
        n.duration = duration;
        n.tick = tick;
      }
      return true;
    });
    sortNotes(t.notes);
    if (removed) issues.warn('note.invalid', `${removed} invalid note(s) removed from "${t.name}".`, { trackId: t.id, fixed: true });
    if (fixed) issues.warn('note.invalid', `${fixed} note(s) on "${t.name}" had invalid MIDI values and were repaired.`, { trackId: t.id, fixed: true });
  }
  return song;
}

/**
 * Proposal from a complete edited song (e.g. a provider that returns a whole song, or a manual
 * edit). With `autoFix` (default) MIDI-invalid data is repaired and locked material is restored
 * from `before` when the layouts match; remaining lock violations are reported as errors.
 */
export function proposalFromSongs(
  before: Song,
  after: Song,
  meta: ProposalMeta & Pick<ApplyOptions, 'respectLocks' | 'autoFix' | 'customInstruments' | 'resolveInstrument'>,
): Proposal {
  const issues = new IssueList();
  let candidate = cloneSong(after);
  const autoFix = meta.autoFix !== false;
  const respectLocks = meta.respectLocks !== false;
  if (autoFix) candidate = sanitizeSong(candidate, issues);
  if (respectLocks && autoFix) {
    const r = restoreLockedMaterial(before, candidate);
    if (r.restored) {
      candidate = r.song;
      issues.warn('lock.violated', `${r.restored} locked component(s) were changed by the proposal and have been restored.`, { fixed: true });
    }
  }
  const vopts = validateOpts(meta);
  const validation = mergeReports(
    issues.report(),
    respectLocks ? validateChange(before, candidate) : undefined,
    newIssues(validateSong(before, vopts), validateSong(candidate, vopts)),
  );
  return buildProposal(before, candidate, [], validation, meta);
}

/** "Modify": replace the proposed song while pending; diff and validation are recomputed. */
export function modifyProposal(p: Proposal, after: Song, opts: Pick<ApplyOptions, 'respectLocks' | 'autoFix' | 'customInstruments' | 'resolveInstrument'> = {}): Proposal {
  const next = proposalFromSongs(p.before, after, {
    ...opts,
    id: p.id,
    title: p.title,
    source: p.source,
    createdAt: p.createdAt,
    modelId: p.modelId,
    instruction: p.instruction,
    explanation: p.explanation,
    baseRevisionId: p.baseRevisionId,
  });
  return { ...next, operations: p.operations };
}

/**
 * Accept: returns the song to commit as a new revision. Refuses (throws) when the proposed song
 * would change material that was locked when the proposal was made, unless `force` is set.
 */
export function acceptProposal(p: Proposal, opts: { force?: boolean } = {}): Song {
  if (!opts.force) {
    const violations = lockViolations(p.before, p.after);
    if (violations.length) throw new Error(`Proposal "${p.title}" changes locked material: ${violations.map((v) => v.message).join(' ')}`);
  }
  return cloneSong(p.after);
}

export function rejectProposal(p: Proposal): Proposal {
  return setProposalStatus(p, 'rejected');
}

export function setProposalStatus(p: Proposal, status: ProposalStatus): Proposal {
  return { ...p, status };
}
