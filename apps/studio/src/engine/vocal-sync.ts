import { create } from 'zustand';
import { randomId, sectionLayout, type MusicOperation, type Proposal, type Song, type TaskRecord } from '@songdeck/core';
import { useStudio } from '../state/store';
import { taskQueue } from './runtime';
import { buildProposal, type ProposalMeta } from './proposals';
import { activeRender, formatBars, resolveVoice, staleSections } from './vocal-model';
import type { ConvertInput, RenderInput, ResingInput } from './vocal-render';
import type { TranscribeTakeInput } from './vocal-takes';

/**
 * Keeps the vocal render in step with the symbolic vocal (spec §37): proposals made in Vocals
 * mode are watched, and when one is accepted — here or in the Workbench's Proposals panel — only
 * the changed range is re-sung and spliced into the render. Also: queue helpers.
 */

export type VocalProposalKind = 'instruction' | 'fit-rhythm' | 'transcription';

export interface VocalProposalInfo {
  proposalId: string;
  projectId: string;
  trackId: string;
  kind: VocalProposalKind;
  title: string;
  /** Range to re-sing after acceptance. */
  range?: { startTick: number; endTick: number };
  /** The changed notes as separate clusters (e.g. a word sung in two choruses). */
  ranges?: { startTick: number; endTick: number }[];
  label?: string;
  reason?: string;
  createdAt: string;
}

export interface VocalActivity {
  id: string;
  at: string;
  kind: 'render' | 'resing' | 'convert' | 'instruction' | 'take' | 'transcribe' | 'lyrics' | 'melody' | 'expression';
  text: string;
  taskId?: string;
}

interface VocalJobsState {
  proposals: VocalProposalInfo[];
  activity: VocalActivity[];
  /** Re-sing changed ranges automatically after accepted vocal edits (when a render exists). */
  autoResing: boolean;
}

export const useVocalJobs = create<VocalJobsState>(() => ({ proposals: [], activity: [], autoResing: true }));

export function logVocalActivity(kind: VocalActivity['kind'], text: string, taskId?: string) {
  const entry: VocalActivity = { id: randomId('va'), at: new Date().toISOString(), kind, text, taskId };
  useVocalJobs.setState((s) => ({ activity: [entry, ...s.activity].slice(0, 40) }));
}

export function setAutoResing(on: boolean) {
  useVocalJobs.setState({ autoResing: on });
}

// ---------------------------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------------------------

function enqueue<I>(type: string, title: string, input: I, runner = 'local'): TaskRecord<I> {
  return taskQueue.enqueue({ type, title, input, runner, maxAttempts: 1 }) as TaskRecord<I>;
}

export function enqueueRender(input: RenderInput, title: string): TaskRecord<RenderInput> {
  const t = enqueue('vocals.render', title, input);
  logVocalActivity('render', title, t.id);
  return t;
}

export function enqueueConvert(input: ConvertInput, title: string): TaskRecord<ConvertInput> {
  const t = enqueue('vocals.convert', title, input);
  logVocalActivity('convert', title, t.id);
  return t;
}

export function enqueueTranscribeTake(input: TranscribeTakeInput, title: string): TaskRecord<TranscribeTakeInput> {
  const t = enqueue('vocals.transcribe-take', title, input);
  logVocalActivity('transcribe', title, t.id);
  return t;
}

/** Re-sing [startTick, endTick) into the current render. Returns the task id, or null when there is no render to splice into. */
export function requestResing(input: ResingInput): string | null {
  const project = useStudio.getState().project;
  if (!project || project.meta.id !== input.projectId) return null;
  const current = activeRender(project, input.trackId);
  if (!current) return null;
  if ((current.provenance?.parameters as { renderKind?: unknown } | undefined)?.renderKind === 'conversion') {
    logVocalActivity('resing', `${input.label ?? 'A range'} changed — the vocal render is a voice conversion; run “Render & convert” again to update it`);
    return null;
  }
  const title = `Re-sing ${input.label ?? 'vocal range'} only`;
  const t = enqueue('vocals.resing', title, input);
  logVocalActivity('resing', `${title}${input.reason ? ` — “${input.reason}”` : ''}`, t.id);
  return t.id;
}

/** Re-sing every section whose vocal changed since the active render. */
export function resingStaleSections(projectId: string, trackId: string): string[] {
  const project = useStudio.getState().project;
  if (!project || project.meta.id !== projectId) return [];
  const track = project.song.tracks.find((t) => t.id === trackId);
  const current = activeRender(project, trackId);
  if (!track || !current) return [];
  const voiceKey = current.render?.voiceId ?? current.rendered?.voiceKey ?? resolveVoice(project, project.song.vocals.voiceId, track).key;
  const st = staleSections(project.song, track, current.rendered, voiceKey);
  const ids: string[] = [];
  for (const span of st.sections) {
    const id = requestResing({ projectId, trackId, startTick: span.startTick, endTick: span.endTick, label: span.section.name, reason: 'changed since the last render' });
    if (id) ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------------------------

export function trackVocalProposal(info: Omit<VocalProposalInfo, 'createdAt'>) {
  ensureWatch();
  const entry: VocalProposalInfo = { ...info, createdAt: new Date().toISOString() };
  useVocalJobs.setState((s) => ({ proposals: [entry, ...s.proposals.filter((p) => p.proposalId !== info.proposalId)].slice(0, 30) }));
}

export function vocalProposalInfo(id: string): VocalProposalInfo | undefined {
  return useVocalJobs.getState().proposals.find((p) => p.proposalId === id);
}

/** Create, register and surface a reviewable proposal (spec §21) from Vocals mode. */
export function proposeVocal(song: Song, ops: MusicOperation[], meta: ProposalMeta, info: Omit<VocalProposalInfo, 'proposalId' | 'createdAt'>): Proposal | { error: string } {
  if (!ops.length) return { error: meta.explanation ?? 'No change was proposed.' };
  const p = buildProposal(song, ops, meta);
  const changed =
    p.diff.tracks.some((t) => t.added.length || t.removed.length || t.modified.length) ||
    p.diff.lyricsChanged ||
    p.diff.mixerChanged.length > 0 ||
    p.diff.tracksAdded.length > 0;
  if (!changed) {
    const reasons = p.validation.issues.filter((i) => i.severity !== 'info').map((i) => i.message);
    return { error: reasons.length ? `The change had no effect: ${reasons.slice(0, 2).join('; ')}` : 'The change had no effect (locked or already applied).' };
  }
  // What to re-sing after acceptance: the notes the proposal touches, clustered so that changes
  // far apart (a word sung in two choruses) are re-sung separately instead of everything between.
  let range = info.range;
  let ranges: { startTick: number; endTick: number }[] | undefined;
  if (info.kind !== 'transcription') {
    const d = p.diff.tracks.find((t) => t.trackId === info.trackId);
    const touched = d ? [...d.added, ...d.removed, ...d.modified.flatMap((m) => [m.before, m.after])] : [];
    if (touched.length) {
      ranges = clusterRanges(song, touched);
      range = range ?? { startTick: ranges[0].startTick, endTick: ranges[ranges.length - 1].endTick };
      if (info.range) ranges = ranges.filter((r) => r.endTick > info.range!.startTick && r.startTick < info.range!.endTick);
      if (!ranges.length) ranges = undefined;
    }
  }
  let label = info.label;
  if (ranges && ranges.length > 1) {
    const where = ranges.map((r) => formatBars(song, r.startTick, r.endTick));
    label = `${ranges.length} places (${where.slice(0, 4).join(', ')}${where.length > 4 ? ', …' : ''})`;
  }
  trackVocalProposal({ ...info, range, ranges, label, proposalId: p.id });
  useStudio.getState().addProposal(p);
  return p;
}

/**
 * Accept a proposal. The store rebases it onto the current song (only what it changed is applied),
 * so accepting never reverts later commits such as a render that finished meanwhile.
 * `reported` = the store already told the user why it failed (e.g. locked material).
 */
export function acceptVocalProposal(id: string): { ok: boolean; error?: string; reported?: boolean } {
  const st = useStudio.getState();
  const prop = st.proposals.find((p) => p.id === id);
  if (!prop || prop.status !== 'pending' || !st.project) return { ok: false, error: 'This proposal is no longer pending.' };
  st.acceptProposal(id);
  const status = useStudio.getState().proposals.find((p) => p.id === id)?.status;
  return status === 'accepted' ? { ok: true } : { ok: false, reported: true };
}

export function rejectVocalProposal(id: string) {
  useStudio.getState().rejectProposal(id);
}

let watching = false;

/** When a watched vocal proposal is accepted (anywhere), re-sing only its range. */
function ensureWatch() {
  if (watching) return;
  watching = true;
  useStudio.subscribe((s, prev) => {
    if (s.proposals === prev.proposals) return;
    const infos = useVocalJobs.getState().proposals;
    if (!infos.length) return;
    const done: string[] = [];
    for (const info of infos) {
      const p = s.proposals.find((x) => x.id === info.proposalId);
      if (!p) continue;
      if (p.status === 'accepted') {
        done.push(info.proposalId);
        logVocalActivity(info.kind === 'transcription' ? 'transcribe' : 'instruction', `Accepted: ${info.title}`);
        if (info.range && useVocalJobs.getState().autoResing) {
          // Let the accept commit land first.
          setTimeout(() => {
            requestResing({ projectId: info.projectId, trackId: info.trackId, startTick: info.range!.startTick, endTick: info.range!.endTick, ranges: info.ranges, label: info.label, reason: info.reason });
          }, 0);
        }
      } else if (p.status !== 'pending') done.push(info.proposalId);
    }
    if (done.length) useVocalJobs.setState((st) => ({ proposals: st.proposals.filter((x) => !done.includes(x.proposalId)) }));
  });
}

/** Group notes into ranges separated by more than two bars of silence. */
export function clusterRanges(song: Song, notes: { tick: number; duration: number }[]): { startTick: number; endTick: number }[] {
  const meter = song.meterMap[0] ?? { numerator: 4, denominator: 4 };
  const gap = ((song.ppq * 4) / meter.denominator) * meter.numerator * 2;
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const out: { startTick: number; endTick: number }[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n.tick - last.endTick <= gap) last.endTick = Math.max(last.endTick, n.tick + n.duration);
    else out.push({ startTick: n.tick, endTick: n.tick + n.duration });
  }
  return out;
}

/** Range of a section (for "regenerate this section" + re-sing). */
export function sectionRange(song: Song, sectionId: string): { startTick: number; endTick: number; label: string } | null {
  const span = sectionLayout(song).find((s) => s.section.id === sectionId);
  return span ? { startTick: span.startTick, endTick: span.endTick, label: span.section.name } : null;
}
