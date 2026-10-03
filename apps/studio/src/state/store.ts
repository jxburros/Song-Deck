import { create } from 'zustand';
import {
  createBranch as coreCreateBranch,
  createProject,
  commitRevision,
  deleteBranch as coreDeleteBranch,
  keyAtBar,
  keyName,
  mergeSelected as coreMergeSelected,
  packProject,
  renameBranch as coreRenameBranch,
  restoreRevision as coreRestoreRevision,
  setLock,
  stepHistory,
  switchBranch as coreSwitchBranch,
  unpackProject,
  addAsset as coreAddAsset,
  addProvenance as coreAddProvenance,
  recordProviderUse,
  acceptProposalOnto,
  type AudioAssetMeta,
  type EditSelection,
  type Project,
  type Proposal,
  type ProvenanceRecord,
  type Revision,
  type RevisionKind,
  type Song,
} from '@songdeck/core';
import { assetStore } from './assets';
import { deleteProject as dbDeleteProject, listProjectSummaries, loadProject, saveProject, type ProjectSummary } from './persistence';
import { player } from '../engine/player';

/** What a proposal touches (tracks, mixer targets, song-level parts), from its diff. */
export function proposalScope(p: Proposal): Set<string> {
  const d = p.diff;
  const scope = new Set<string>();
  for (const t of d.tracks) if (t.added.length || t.removed.length || t.modified.length) scope.add(`track:${t.trackId}`);
  for (const id of [...d.tracksAdded, ...d.tracksRemoved]) scope.add(`track:${id}`);
  if (d.chords.added.length || d.chords.removed.length) scope.add('chords');
  if (d.sectionsChanged) scope.add('sections');
  if (d.tempoChanged) scope.add('tempo');
  if (d.keyChanged) scope.add('key');
  if (d.meterChanged) scope.add('meter');
  if (d.lyricsChanged) scope.add('lyrics');
  for (const m of d.mixerChanged) scope.add(`mixer:${m.target}`);
  if (d.automationChanged) scope.add('automation');
  return scope;
}

export type Mode =
  | 'home'
  | 'compose'
  | 'workbench'
  | 'generate'
  | 'transcribe'
  | 'rebuild'
  | 'produce'
  | 'vocals'
  | 'mix'
  | 'export'
  | 'settings';

export type WorkbenchView = 'arrangement' | 'piano-roll' | 'pattern' | 'chords' | 'structure' | 'theory';

export type RightPanel = 'ai-edit' | 'assistant' | 'proposals' | 'macros' | 'locks' | 'variation' | 'history' | 'inspector';

export interface Selection extends EditSelection {
  noteIds: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  provider?: string;
  proposalId?: string;
  at: string;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

/** A pending confirmation (privacy data-flow / cost) shown as a modal; resolved by the UI. */
export interface PendingConfirm {
  id: string;
  title: string;
  body: unknown;
  kind: 'dataflow' | 'cost' | 'generic' | 'consent';
  resolve: (ok: boolean) => void;
}

interface StudioState {
  project: Project | null;
  projects: ProjectSummary[];
  saving: boolean;
  lastSavedAt: string | null;

  proposals: Proposal[];
  activeProposalId: string | null;

  mode: Mode;
  workbenchView: WorkbenchView;
  rightPanel: RightPanel;
  selectedTrackId: string | null;
  selection: Selection;
  view: { pxPerBeat: number; keyHeight: number; trackHeight: number };

  chat: ChatMessage[];
  toasts: Toast[];
  taskDrawerOpen: boolean;
  confirm: PendingConfirm | null;
  transport: { playing: boolean; loop: { enabled: boolean; startTick: number; endTick: number }; metronome: boolean; follow: boolean };

  // project lifecycle
  refreshProjects(): Promise<void>;
  newProject(name: string, song?: Song): Promise<Project>;
  openProject(id: string): Promise<void>;
  closeProject(): void;
  deleteProject(id: string): Promise<void>;
  importProjectBytes(bytes: Uint8Array): Promise<void>;
  exportProjectBytes(): Promise<Uint8Array>;
  setProject(project: Project, opts?: { save?: boolean }): void;

  // song edits & history
  commit(song: Song, message: string, kind?: RevisionKind): void;
  /** Merge a collaborator's revision into the history DAG (spec Phase 5 collaboration). */
  applyRemoteRevision(revision: Revision, branchName: string): void;
  undo(): void;
  redo(): void;
  createBranch(name: string, fromRevisionId?: string, description?: string): void;
  switchBranch(branchId: string): void;
  renameBranch(branchId: string, name: string): void;
  deleteBranch(branchId: string): void;
  restoreRevision(revisionId: string): void;
  mergeSelected(fromRevisionId: string, selection: Parameters<typeof coreMergeSelected>[2], message?: string): void;
  toggleLock(key: string, message?: string): void;

  // proposals (spec §21)
  addProposal(p: Proposal): void;
  acceptProposal(id: string): void;
  rejectProposal(id: string): void;
  updateProposal(id: string, after: Song): void;
  setActiveProposal(id: string | null): void;

  // project meta
  updateProject(fn: (p: Project) => Project): void;
  addAsset(meta: AudioAssetMeta, bytes: Uint8Array): Promise<void>;
  addProvenance(record: ProvenanceRecord): void;

  // ui
  setMode(mode: Mode): void;
  setWorkbenchView(v: WorkbenchView): void;
  setRightPanel(p: RightPanel): void;
  selectTrack(id: string | null): void;
  setSelection(sel: Partial<Selection>): void;
  setView(v: Partial<StudioState['view']>): void;
  toast(kind: Toast['kind'], message: string): void;
  dismissToast(id: string): void;
  setTaskDrawer(open: boolean): void;
  pushChat(m: Omit<ChatMessage, 'id' | 'at'>): void;
  clearChat(): void;
  requestConfirm(c: Omit<PendingConfirm, 'id' | 'resolve'>): Promise<boolean>;
  resolveConfirm(ok: boolean): void;

  // transport
  togglePlay(): void;
  stop(): void;
  seek(seconds: number): void;
  setLoop(loop: Partial<StudioState['transport']['loop']>): void;
  toggleMetronome(): void;
  setFollow(v: boolean): void;
}

let uid = 0;
const nextId = (p: string) => `${p}_${Date.now().toString(36)}${(uid++).toString(36)}`;

function summarize(project: Project): ProjectSummary {
  const song = project.song;
  const branch = project.history.branches.find((b) => b.id === project.history.currentBranchId);
  return {
    id: project.meta.id,
    name: project.meta.name,
    title: song.title,
    updatedAt: project.meta.updatedAt,
    createdAt: project.meta.createdAt,
    tracks: song.tracks.length,
    sections: song.sections.length,
    bpm: song.tempoMap[0]?.bpm ?? 120,
    keyName: keyName(keyAtBar(song, 0)),
    revisions: project.history.revisions.length,
    branch: branch?.name ?? 'Main',
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Listeners notified after every local commit (collaboration, analytics). */
type CommitListener = (project: Project, revision: Revision) => void;
const commitListeners = new Set<CommitListener>();
export function subscribeCommits(fn: CommitListener): () => void {
  commitListeners.add(fn);
  return () => commitListeners.delete(fn);
}

/** Tell commit listeners about the new head revision of the current branch. */
function notifyHeadCommit(project: Project): void {
  const branch = project.history.branches.find((b) => b.id === project.history.currentBranchId);
  const rev = project.history.revisions.find((r) => r.id === branch?.headRevisionId);
  if (rev) for (const l of commitListeners) l(project, rev);
}

/*
 * Linear undo while collaborating. Normally undo/redo move the branch head locally; peers never
 * see that, and the next commit forks. While collaborating, undo commits the previous state as
 * a new revision ("Undo: …") and redo re-commits the undone one, so history stays shared. The
 * cursor walks the original chain, so repeated undos keep going back instead of undoing the undo.
 */
let linearHistoryProbe: () => boolean = () => false;
/** Collaboration registers a probe; while it returns true, undo/redo are committed as revisions. */
export function setLinearHistoryProbe(fn: () => boolean): void {
  linearHistoryProbe = fn;
}
const linear: { projectId: string | null; cursor: string | null; redo: string[] } = { projectId: null, cursor: null, redo: [] };
function resetLinear(projectId: string | null = null) {
  linear.projectId = projectId;
  linear.cursor = null;
  linear.redo = [];
}

export const useStudio = create<StudioState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    set({ saving: true });
    saveTimer = setTimeout(async () => {
      const p = get().project;
      if (!p) return;
      try {
        await saveProject(p, summarize(p));
        set({ saving: false, lastSavedAt: new Date().toISOString() });
      } catch (err) {
        set({ saving: false });
        get().toast('error', `Could not save project: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 400);
  };

  const applyProject = (project: Project, save = true) => {
    set({ project });
    player.setSong(project.song);
    if (save) scheduleSave();
  };

  return {
    project: null,
    projects: [],
    saving: false,
    lastSavedAt: null,
    proposals: [],
    activeProposalId: null,
    mode: 'home',
    workbenchView: 'arrangement',
    rightPanel: 'ai-edit',
    selectedTrackId: null,
    selection: { noteIds: [] },
    view: { pxPerBeat: 28, keyHeight: 12, trackHeight: 56 },
    chat: [],
    toasts: [],
    taskDrawerOpen: false,
    confirm: null,
    transport: { playing: false, loop: { enabled: false, startTick: 0, endTick: 0 }, metronome: false, follow: true },

    async refreshProjects() {
      set({ projects: await listProjectSummaries() });
    },

    async newProject(name, song) {
      const project = createProject(name, song);
      assetStore.reset(project.meta.id);
      set({ proposals: [], activeProposalId: null, chat: [], selectedTrackId: song?.tracks[0]?.id ?? null, selection: { noteIds: [] } });
      applyProject(project);
      await saveProject(project, summarize(project));
      await get().refreshProjects();
      return project;
    },

    async openProject(id) {
      const project = await loadProject(id);
      if (!project) {
        get().toast('error', 'Project not found');
        return;
      }
      player.stop();
      assetStore.reset(project.meta.id);
      set({
        proposals: [],
        activeProposalId: null,
        chat: [],
        selectedTrackId: project.song.tracks[0]?.id ?? null,
        selection: { noteIds: [] },
        mode: project.song.tracks.length ? 'workbench' : 'compose',
      });
      applyProject(project, false);
    },

    closeProject() {
      player.stop();
      assetStore.reset(null);
      set({ project: null, proposals: [], activeProposalId: null, chat: [], mode: 'home', selectedTrackId: null });
      void get().refreshProjects();
    },

    async deleteProject(id) {
      await dbDeleteProject(id);
      if (get().project?.meta.id === id) get().closeProject();
      await get().refreshProjects();
    },

    async importProjectBytes(bytes) {
      const { project, assets } = unpackProject(bytes);
      assetStore.reset(project.meta.id);
      for (const meta of project.meta.assets) {
        const b = assets.get(meta.id);
        if (b) await assetStore.add(meta, b);
      }
      set({ proposals: [], activeProposalId: null, chat: [], mode: 'workbench', selectedTrackId: project.song.tracks[0]?.id ?? null });
      applyProject(project, false);
      await saveProject(project, summarize(project));
      await get().refreshProjects();
    },

    async exportProjectBytes() {
      const p = get().project;
      if (!p) throw new Error('No project open');
      const bytes = await assetStore.allBytes(p.meta.assets);
      return packProject(p, bytes);
    },

    setProject(project, opts) {
      applyProject(project, opts?.save ?? true);
    },

    commit(song, message, kind = 'edit') {
      const p = get().project;
      if (!p) return;
      resetLinear(p.meta.id); // a new edit ends any linear undo/redo sequence
      const next = commitRevision(p, song, message, kind, useAuthor());
      applyProject(next);
      notifyHeadCommit(next);
    },

    applyRemoteRevision(revision, branchName) {
      const p = get().project;
      if (!p || p.history.revisions.some((r) => r.id === revision.id)) return;
      // Fast-forward when the collaborator built on our branch head; otherwise fork onto a
      // collaborator branch so concurrent work never overwrites local edits (merge later, spec §52).
      let history = p.history;
      let branch = history.branches.find((b) => b.id === revision.branchId) ?? history.branches.find((b) => b.name === branchName);
      const parentIsHead = !!branch && revision.parents[0] === branch.headRevisionId;
      if (!branch || !parentIsHead) {
        const name = branch ? `${branchName} — ${revision.author ?? 'collaborator'}` : branchName;
        const existing = history.branches.find((b) => b.name === name);
        branch = existing ?? { id: `br_remote_${revision.id}`, name, headRevisionId: revision.id, baseRevisionId: revision.parents[0], createdAt: revision.createdAt, description: 'Collaborator branch' };
        if (!existing) history = { ...history, branches: [...history.branches, branch] };
      }
      const number = Math.max(0, ...history.revisions.map((r) => r.number)) + 1;
      const rev: Revision = { ...revision, number, branchId: branch.id };
      const targetId = branch.id;
      history = {
        ...history,
        revisions: [...history.revisions, rev],
        branches: history.branches.map((b) => (b.id === targetId ? { ...b, headRevisionId: rev.id } : b)),
      };
      const onCurrent = targetId === p.history.currentBranchId;
      applyProject({ ...p, history, song: onCurrent ? rev.snapshot : p.song });
      if (!onCurrent) get().toast('info', `${revision.author ?? 'A collaborator'} committed “${revision.message}” on branch ${branch.name}`);
    },

    undo() {
      const p = get().project;
      if (!p) return;
      if (linearHistoryProbe()) {
        if (linear.projectId !== p.meta.id) resetLinear(p.meta.id);
        const branch = p.history.branches.find((b) => b.id === p.history.currentBranchId);
        const from = p.history.revisions.find((r) => r.id === (linear.cursor ?? branch?.headRevisionId));
        const target = from && p.history.revisions.find((r) => r.id === from.parents[0]);
        if (!from || !target) return;
        const next = commitRevision(p, target.snapshot, `Undo: ${from.message}`, 'restore', useAuthor());
        applyProject(next);
        linear.redo.push(from.id);
        linear.cursor = target.id;
        notifyHeadCommit(next);
        return;
      }
      const next = stepHistory(p, 'undo');
      if (next === p) return;
      applyProject(next);
    },

    redo() {
      const p = get().project;
      if (!p) return;
      if (linearHistoryProbe()) {
        if (linear.projectId !== p.meta.id) return;
        const rev = p.history.revisions.find((r) => r.id === linear.redo[linear.redo.length - 1]);
        if (!rev) return;
        const next = commitRevision(p, rev.snapshot, `Redo: ${rev.message}`, 'restore', useAuthor());
        applyProject(next);
        linear.redo.pop();
        linear.cursor = rev.id;
        notifyHeadCommit(next);
        return;
      }
      const next = stepHistory(p, 'redo');
      if (next === p) return;
      applyProject(next);
    },

    createBranch(name, fromRevisionId, description) {
      const p = get().project;
      if (!p) return;
      applyProject(coreCreateBranch(p, name, fromRevisionId, description));
      get().toast('success', `Created branch “${name}”`);
    },

    switchBranch(branchId) {
      const p = get().project;
      if (!p) return;
      applyProject(coreSwitchBranch(p, branchId));
    },

    renameBranch(branchId, name) {
      const p = get().project;
      if (!p) return;
      applyProject(coreRenameBranch(p, branchId, name));
    },

    deleteBranch(branchId) {
      const p = get().project;
      if (!p) return;
      try {
        applyProject(coreDeleteBranch(p, branchId));
      } catch (err) {
        get().toast('error', err instanceof Error ? err.message : String(err));
      }
    },

    restoreRevision(revisionId) {
      const p = get().project;
      if (!p) return;
      resetLinear(p.meta.id);
      const next = coreRestoreRevision(p, revisionId);
      applyProject(next);
      notifyHeadCommit(next);
      get().toast('success', 'Revision restored as a new version');
    },

    mergeSelected(fromRevisionId, selection, message) {
      const p = get().project;
      if (!p) return;
      resetLinear(p.meta.id);
      const next = coreMergeSelected(p, fromRevisionId, selection, message);
      applyProject(next);
      notifyHeadCommit(next);
      get().toast('success', 'Merged selected changes');
    },

    toggleLock(key, message) {
      const p = get().project;
      if (!p) return;
      const locked = !p.song.locks[key];
      const song: Song = { ...p.song, locks: setLock(p.song.locks, key, locked) };
      get().commit(song, message ?? `${locked ? 'Locked' : 'Unlocked'} ${key}`, 'edit');
    },

    addProposal(proposal) {
      // A new proposal replaces pending ones about the same material; unrelated ones stay pending
      // (accepting rebases onto the current song, so they cannot undo each other).
      const scope = proposalScope(proposal);
      const overlaps = (x: Proposal) => {
        const other = proposalScope(x);
        return !scope.size || !other.size || [...other].some((k) => scope.has(k));
      };
      const others = get().proposals.map((x) => (x.status === 'pending' && overlaps(x) ? { ...x, status: 'superseded' as const } : x));
      set({ proposals: [proposal, ...others].slice(0, 30), activeProposalId: proposal.id });
    },

    acceptProposal(id) {
      const prop = get().proposals.find((x) => x.id === id);
      const p = get().project;
      if (!prop || !p) return;
      let song: Song;
      let conflicts: string[];
      try {
        // Apply only what the proposal changed, keeping edits made while it was pending.
        ({ song, conflicts } = acceptProposalOnto(prop, p.song));
      } catch (err) {
        // The proposal would change locked material (locks may have changed since it was made).
        get().toast('error', err instanceof Error ? err.message : String(err));
        return;
      }
      get().commit(song, prop.title, 'ai-proposal');
      if (conflicts.length) {
        get().toast('warning', `Accepted “${prop.title}”. It replaced changes made since it was proposed: ${conflicts.slice(0, 4).join('; ')}${conflicts.length > 4 ? '…' : ''}. Undo restores them.`);
      }
      set({
        proposals: get().proposals.map((x) => (x.id === id ? { ...x, status: 'accepted' as const } : x)),
        activeProposalId: null,
      });
    },

    rejectProposal(id) {
      set({
        proposals: get().proposals.map((x) => (x.id === id ? { ...x, status: 'rejected' as const } : x)),
        activeProposalId: get().activeProposalId === id ? null : get().activeProposalId,
      });
    },

    updateProposal(id, after) {
      set({ proposals: get().proposals.map((x) => (x.id === id ? { ...x, after } : x)) });
    },

    setActiveProposal(id) {
      set({ activeProposalId: id });
    },

    updateProject(fn) {
      const p = get().project;
      if (!p) return;
      const next = fn(p);
      applyProject({ ...next, meta: { ...next.meta, updatedAt: new Date().toISOString() } });
    },

    async addAsset(meta, bytes) {
      await assetStore.add(meta, bytes);
      get().updateProject((p) => coreAddAsset(p, meta));
    },

    addProvenance(record) {
      get().updateProject((p) => recordProviderUse(coreAddProvenance(p, record), record.providerId, record.providerName));
    },

    setMode(mode) {
      set({ mode });
    },
    setWorkbenchView(workbenchView) {
      set({ workbenchView, mode: 'workbench' });
    },
    setRightPanel(rightPanel) {
      set({ rightPanel });
    },
    selectTrack(selectedTrackId) {
      set({ selectedTrackId });
    },
    setSelection(sel) {
      set({ selection: { ...get().selection, ...sel, noteIds: sel.noteIds ?? get().selection.noteIds } });
    },
    setView(v) {
      set({ view: { ...get().view, ...v } });
    },
    toast(kind, message) {
      const id = nextId('t');
      set({ toasts: [...get().toasts, { id, kind, message }].slice(-5) });
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4500);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
    setTaskDrawer(taskDrawerOpen) {
      set({ taskDrawerOpen });
    },
    pushChat(m) {
      set({ chat: [...get().chat, { ...m, id: nextId('m'), at: new Date().toISOString() }] });
    },
    clearChat() {
      set({ chat: [] });
    },
    requestConfirm(c) {
      return new Promise<boolean>((resolve) => {
        set({ confirm: { ...c, id: nextId('c'), resolve } });
      });
    },
    resolveConfirm(ok) {
      const c = get().confirm;
      set({ confirm: null });
      c?.resolve(ok);
    },

    togglePlay() {
      if (player.playing) player.pause();
      else void player.play();
      set({ transport: { ...get().transport, playing: player.playing || !get().transport.playing } });
    },
    stop() {
      player.stop();
      set({ transport: { ...get().transport, playing: false } });
    },
    seek(seconds) {
      player.seek(seconds);
    },
    setLoop(loop) {
      const next = { ...get().transport.loop, ...loop };
      set({ transport: { ...get().transport, loop: next } });
    },
    toggleMetronome() {
      const metronome = !get().transport.metronome;
      player.setMetronome(metronome);
      set({ transport: { ...get().transport, metronome } });
    },
    setFollow(follow) {
      set({ transport: { ...get().transport, follow } });
    },
  };
});

function useAuthor(): string | undefined {
  try {
    return JSON.parse(localStorage.getItem('songdeck:settings') ?? '{}').userName;
  } catch {
    return undefined;
  }
}

/** Keep transport.playing in sync with the player (end of song, errors). */
player.subscribe(() => {
  const s = useStudio.getState();
  if (s.transport.playing !== player.playing) useStudio.setState({ transport: { ...s.transport, playing: player.playing } });
});

/** Convenience selector: the working song (or null). */
export const useSong = () => useStudio((s) => s.project?.song ?? null);
