import type {
  Branch,
  ChordEvent,
  Note,
  Project,
  Revision,
  RevisionKind,
  Song,
  SongDiff,
  Track,
  ValidationReport,
} from '../ir/types';
import { cloneSong, sortNotes } from '../ir/song-utils';
import { randomId } from '../util/ids';
import { keyAtTick, sectionLayout } from '../timing';
import { chordToRoman } from '../theory/roman';
import { diffSongs } from '../edit/diff';
import { chordsProtected, lyricsProtected, noteProtected, parseLocks } from '../edit/locks-check';
import { IdAllocator, IssueList, SectionLocator } from '../edit/util';

/**
 * Version history (spec §52) and branching (spec §53).
 *
 * Model: every revision stores a full song snapshot and its parent revision ids; each branch
 * points at its head revision; `project.song` is the working copy (equal to the head snapshot
 * after every commit). All functions are pure and return a new Project.
 *
 * Undo/redo semantics: undo moves the current branch's head back to the head's first parent
 * and loads that snapshot; redo moves it forward again. Revisions are never deleted — undone
 * revisions stay in `history.revisions`. The redo target is the newest revision (highest
 * number) on the same branch whose first parent is the current head, so redo after
 * "undo, commit, undo" returns to the newer commit and older undone work is no longer redoable.
 * Undo never moves a branch behind the revision it was created from.
 */

export interface HistoryOptions {
  /** Timestamp override (ISO); default now. */
  now?: string;
  /** Id override for the created revision/branch/project. */
  id?: string;
}

const nowIso = (opts?: HistoryOptions) => opts?.now ?? new Date().toISOString();

export function getRevision(project: Project, revisionId: string): Revision | undefined {
  return project.history.revisions.find((r) => r.id === revisionId);
}

function requireRevision(project: Project, revisionId: string): Revision {
  const r = getRevision(project, revisionId);
  if (!r) throw new Error(`Unknown revision "${revisionId}".`);
  return r;
}

export function currentBranch(project: Project): Branch {
  const b = project.history.branches.find((x) => x.id === project.history.currentBranchId);
  if (!b) throw new Error('Project history is inconsistent: the current branch does not exist.');
  return b;
}

export function headRevision(project: Project, branchId?: string): Revision {
  const branch = branchId ? project.history.branches.find((b) => b.id === branchId) : currentBranch(project);
  if (!branch) throw new Error(`Unknown branch "${branchId}".`);
  return requireRevision(project, branch.headRevisionId);
}

/** First-parent chain from a branch head (newest first): the branch's visible history. */
export function branchLog(project: Project, branchId?: string): Revision[] {
  const out: Revision[] = [];
  const seen = new Set<string>();
  let cur: Revision | undefined = headRevision(project, branchId);
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.parents[0] ? getRevision(project, cur.parents[0]) : undefined;
  }
  return out;
}

function nextNumber(project: Project): number {
  return project.history.revisions.reduce((m, r) => Math.max(m, r.number), 0) + 1;
}

function withRevision(project: Project, rev: Revision, working: Song, now: string): Project {
  return {
    ...project,
    meta: { ...project.meta, updatedAt: now },
    song: working,
    history: {
      ...project.history,
      revisions: [...project.history.revisions, rev],
      branches: project.history.branches.map((b) =>
        b.id === rev.branchId ? { ...b, headRevisionId: rev.id } : b,
      ),
    },
  };
}

/** New revision on the current branch (parents = [head]); the song becomes the working copy. */
export function commitRevision(
  project: Project,
  song: Song,
  message: string,
  kind: RevisionKind,
  author?: string,
  opts?: HistoryOptions,
): Project {
  const head = headRevision(project);
  const now = nowIso(opts);
  const rev: Revision = {
    id: opts?.id ?? randomId('rev'),
    number: nextNumber(project),
    parents: [head.id],
    branchId: project.history.currentBranchId,
    message,
    kind,
    createdAt: now,
    snapshot: cloneSong(song),
  };
  if (author) rev.author = author;
  return withRevision(project, rev, song, now);
}

/** Restore: a NEW revision (kind "restore") whose snapshot equals an earlier revision's. */
export function restoreRevision(
  project: Project,
  revisionId: string,
  message?: string,
  opts?: HistoryOptions & { author?: string },
): Project {
  const target = requireRevision(project, revisionId);
  return commitRevision(
    project,
    cloneSong(target.snapshot),
    message ?? `Restored v${target.number}`,
    'restore',
    opts?.author,
    opts,
  );
}

function uniqueBranchName(project: Project, name: string): string {
  const names = new Set(project.history.branches.map((b) => b.name.toLowerCase()));
  const base = name.trim() || 'Branch';
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}

/** Create a branch at a revision (default: current head) and switch to it. */
export function createBranch(
  project: Project,
  name: string,
  fromRevisionId?: string,
  description?: string,
  opts?: HistoryOptions,
): Project {
  const from = fromRevisionId ? requireRevision(project, fromRevisionId) : headRevision(project);
  const now = nowIso(opts);
  const branch: Branch = {
    id: opts?.id ?? randomId('br'),
    name: uniqueBranchName(project, name),
    headRevisionId: from.id,
    baseRevisionId: from.id,
    createdAt: now,
  };
  if (description) branch.description = description;
  return {
    ...project,
    meta: { ...project.meta, updatedAt: now },
    song: cloneSong(from.snapshot),
    history: {
      ...project.history,
      branches: [...project.history.branches, branch],
      currentBranchId: branch.id,
    },
  };
}

/** Switch branches; the working copy becomes the branch head's snapshot. */
export function switchBranch(project: Project, branchId: string): Project {
  const branch = project.history.branches.find((b) => b.id === branchId);
  if (!branch) throw new Error(`Unknown branch "${branchId}".`);
  if (branchId === project.history.currentBranchId) return project;
  return {
    ...project,
    song: cloneSong(requireRevision(project, branch.headRevisionId).snapshot),
    history: { ...project.history, currentBranchId: branchId },
  };
}

export function renameBranch(
  project: Project,
  branchId: string,
  name: string,
  opts?: HistoryOptions,
): Project {
  const branch = project.history.branches.find((b) => b.id === branchId);
  if (!branch) throw new Error(`Unknown branch "${branchId}".`);
  const others = {
    ...project,
    history: { ...project.history, branches: project.history.branches.filter((b) => b.id !== branchId) },
  };
  const unique = uniqueBranchName(others, name);
  return {
    ...project,
    meta: { ...project.meta, updatedAt: nowIso(opts) },
    history: {
      ...project.history,
      branches: project.history.branches.map((b) => (b.id === branchId ? { ...b, name: unique } : b)),
    },
  };
}

function ancestors(project: Project, startIds: string[]): Set<string> {
  const byId = new Map(project.history.revisions.map((r) => [r.id, r] as const));
  const seen = new Set<string>();
  const stack = [...startIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of byId.get(id)?.parents ?? []) stack.push(p);
  }
  return seen;
}

/**
 * Delete a branch (never the current or the last one). Revisions created on that branch that
 * no remaining branch can reach are removed with it.
 */
export function deleteBranch(project: Project, branchId: string, opts?: HistoryOptions): Project {
  const { branches, currentBranchId } = project.history;
  if (!branches.some((b) => b.id === branchId)) throw new Error(`Unknown branch "${branchId}".`);
  if (branches.length <= 1) throw new Error('Cannot delete the last branch.');
  if (branchId === currentBranchId)
    throw new Error('Cannot delete the current branch; switch to another branch first.');
  const remaining = branches.filter((b) => b.id !== branchId);
  const reachable = ancestors(
    project,
    remaining.map((b) => b.headRevisionId),
  );
  // Keep undone (redoable) revisions of other branches; drop only the deleted branch's orphans.
  const revisions = project.history.revisions.filter((r) => r.branchId !== branchId || reachable.has(r.id));
  return {
    ...project,
    meta: { ...project.meta, updatedAt: nowIso(opts) },
    history: { ...project.history, branches: remaining, revisions },
  };
}

/** Structured diff between two revisions. */
export function compareRevisions(project: Project, aId: string, bId: string): SongDiff {
  return diffSongs(requireRevision(project, aId).snapshot, requireRevision(project, bId).snapshot);
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

export function undoTarget(project: Project): Revision | undefined {
  const branch = currentBranch(project);
  const head = getRevision(project, branch.headRevisionId);
  if (!head || head.branchId !== branch.id || head.id === branch.baseRevisionId || !head.parents.length)
    return undefined;
  return getRevision(project, head.parents[0]);
}

export function redoTarget(project: Project): Revision | undefined {
  const branch = currentBranch(project);
  let best: Revision | undefined;
  for (const r of project.history.revisions) {
    if (r.branchId !== branch.id || r.parents[0] !== branch.headRevisionId) continue;
    if (!best || r.number > best.number) best = r;
  }
  return best;
}

export function canUndo(project: Project): boolean {
  return !!undoTarget(project);
}

export function canRedo(project: Project): boolean {
  return !!redoTarget(project);
}

/** Move the current branch head to its parent (undo) or newest child (redo); the working copy follows. */
export function stepHistory(project: Project, direction: 'undo' | 'redo'): Project {
  const target = direction === 'undo' ? undoTarget(project) : redoTarget(project);
  if (!target) return project;
  const branchId = project.history.currentBranchId;
  return {
    ...project,
    song: cloneSong(target.snapshot),
    history: {
      ...project.history,
      branches: project.history.branches.map((b) =>
        b.id === branchId ? { ...b, headRevisionId: target.id } : b,
      ),
    },
  };
}

export function undoRevision(project: Project): Project {
  return stepHistory(project, 'undo');
}

export function redoRevision(project: Project): Project {
  return stepHistory(project, 'redo');
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

/** Independent copy of a project with new project/branch/revision/song ids (asset ids are kept). */
export function duplicateProject(project: Project, newName: string, opts?: HistoryOptions): Project {
  const now = nowIso(opts);
  const revMap = new Map(project.history.revisions.map((r) => [r.id, randomId('rev')] as const));
  const brMap = new Map(project.history.branches.map((b) => [b.id, randomId('br')] as const));
  const songMap = new Map<string, string>();
  const remapSong = (s: Song): Song => {
    const copy = cloneSong(s);
    if (!songMap.has(copy.id)) songMap.set(copy.id, randomId('song'));
    copy.id = songMap.get(copy.id)!;
    for (const c of copy.production?.candidates ?? [])
      if (c.sourceRevisionId && revMap.has(c.sourceRevisionId))
        c.sourceRevisionId = revMap.get(c.sourceRevisionId);
    return copy;
  };
  const rev = (id: string | undefined) => (id && revMap.has(id) ? revMap.get(id)! : id);
  return {
    meta: {
      ...cloneSong(project.meta),
      id: opts?.id ?? randomId('proj'),
      name: newName,
      createdAt: now,
      updatedAt: now,
    },
    song: remapSong(project.song),
    history: {
      revisions: project.history.revisions.map((r) => ({
        ...r,
        id: revMap.get(r.id)!,
        parents: r.parents.map((p) => revMap.get(p) ?? p),
        branchId: brMap.get(r.branchId) ?? r.branchId,
        snapshot: remapSong(r.snapshot),
      })),
      branches: project.history.branches.map((b) => ({
        ...b,
        id: brMap.get(b.id)!,
        headRevisionId: rev(b.headRevisionId)!,
        baseRevisionId: rev(b.baseRevisionId),
      })),
      currentBranchId: brMap.get(project.history.currentBranchId) ?? project.history.currentBranchId,
    },
    analysis: cloneSong(project.analysis),
    generations: project.generations.map((g) => ({ ...cloneSong(g), revisionId: rev(g.revisionId) })),
  };
}

// ---------------------------------------------------------------------------
// Merge selected changes
// ---------------------------------------------------------------------------

export interface MergeSelection {
  /** Whole tracks (or, with `sectionIds`, those tracks within the sections). Matched by id, then name. */
  trackIds?: string[];
  /** Sections (matched by id, then name): all track material + chords within them. */
  sectionIds?: string[];
  chords?: boolean;
  lyrics?: boolean;
  mixer?: boolean;
  /** Tempo map and key map. */
  tempoKey?: boolean;
}

export interface MergeResult {
  song: Song;
  report: ValidationReport;
  /** Human-readable list of what was merged. */
  merged: string[];
}

/**
 * Bring selected material from `from` into `base` (the "merge selected changes" of spec §52).
 * Locked material in `base` is left untouched (reported as `lock.violated` warnings) unless
 * `respectLocks` is false.
 */
export function mergeSongs(
  base: Song,
  from: Song,
  selection: MergeSelection,
  opts: { respectLocks?: boolean } = {},
): MergeResult {
  const out = cloneSong(base);
  const issues = new IssueList();
  const merged: string[] = [];
  const respect = opts.respectLocks !== false;
  const locks = parseLocks(base.locks ?? {});
  const ids = new IdAllocator(out);
  const locator = new SectionLocator(out);
  const findIn = (song: Song, ref: string): Track | undefined =>
    song.tracks.find((t) => t.id === ref) ?? song.tracks.find((t) => t.name === ref);
  const counterpart = (t: Track): Track | undefined =>
    out.tracks.find((x) => x.id === t.id) ?? out.tracks.find((x) => x.name === t.name);
  const usedNoteIds = new Set(out.tracks.flatMap((t) => t.notes.map((n) => n.id)));
  const importNote = (n: Note, tick = n.tick): Note => {
    const copy: Note = { ...cloneSong(n), tick };
    if (usedNoteIds.has(copy.id)) copy.id = ids.next('n');
    usedNoteIds.add(copy.id);
    return copy;
  };
  const isProtected = (t: Track, n: Note) =>
    respect && noteProtected(locks, t.id, n, locator.sectionIdAt(n.tick));
  const fromTracks = selection.trackIds?.length
    ? selection.trackIds
        .map((ref) => {
          const t = findIn(from, ref);
          if (!t) issues.warn('merge.track-missing', `Track "${ref}" does not exist in the source revision.`);
          return t;
        })
        .filter((t): t is Track => !!t)
    : undefined;
  const touchedTracks = new Set<Track>();

  if (selection.sectionIds?.length) {
    const baseSpans = sectionLayout(out);
    const fromSpans = sectionLayout(from);
    for (const ref of selection.sectionIds) {
      const fs = fromSpans.find((s) => s.section.id === ref) ?? fromSpans.find((s) => s.section.name === ref);
      const bs = fs
        ? (baseSpans.find((s) => s.section.id === fs.section.id) ??
          baseSpans.find((s) => s.section.name === fs.section.name))
        : undefined;
      if (!fs || !bs) {
        issues.warn('merge.section-missing', `Section "${ref}" was not found in both versions.`);
        continue;
      }
      const len = Math.min(fs.endTick - fs.startTick, bs.endTick - bs.startTick);
      if (fs.endTick - fs.startTick !== bs.endTick - bs.startTick) {
        issues.info(
          'merge.section-length',
          `"${bs.section.name}" has a different length in the two versions; only the overlapping bars were merged.`,
          { sectionId: bs.section.id },
        );
      }
      const inFrom = (tick: number) => tick >= fs.startTick && tick < fs.startTick + len;
      const inBase = (tick: number) => tick >= bs.startTick && tick < bs.startTick + len;
      const shift = bs.startTick - fs.startTick;
      for (const ft of fromTracks ?? from.tracks) {
        let bt = counterpart(ft);
        if (!bt) {
          if (!fromTracks) continue; // unknown tracks are only added when explicitly selected
          bt = {
            ...cloneSong(ft),
            id: out.tracks.some((t) => t.id === ft.id) ? ids.next('trk') : ft.id,
            notes: [],
          };
          out.tracks.push(bt);
          merged.push(`added track "${bt.name}"`);
        }
        const target = bt;
        if (
          target.notes.some((n) => inBase(n.tick) && isProtected(target, n)) ||
          (respect &&
            (locks.tracks.has(target.id) ||
              locks.sections.has(bs.section.id) ||
              locks.trackSections.get(target.id)?.has(bs.section.id)))
        ) {
          issues.warn(
            'lock.violated',
            `"${target.name}" in "${bs.section.name}" is locked and was not merged.`,
            { trackId: target.id, sectionId: bs.section.id },
          );
          continue;
        }
        const incoming = ft.notes.filter((n) => inFrom(n.tick)).map((n) => importNote(n, n.tick + shift));
        for (const n of incoming) n.duration = Math.max(1, Math.min(n.duration, bs.startTick + len - n.tick));
        target.notes = [...target.notes.filter((n) => !inBase(n.tick)), ...incoming];
        touchedTracks.add(target);
      }
      // Chords within the section.
      if (respect && chordsProtected(locks, bs.section.id)) {
        issues.warn('lock.violated', `Chords in "${bs.section.name}" are locked and were not merged.`, {
          sectionId: bs.section.id,
        });
      } else {
        const incoming: ChordEvent[] = from.chords
          .filter((c) => inFrom(c.tick))
          .map((c) => ({
            ...cloneSong(c),
            id: out.chords.some((x) => x.id === c.id) ? ids.next('ch') : c.id,
            tick: c.tick + shift,
            duration: Math.max(1, Math.min(c.duration, bs.startTick + len - (c.tick + shift))),
          }));
        // Chords sounding into the section from before are cut at its start.
        out.chords = out.chords
          .filter((c) => !inBase(c.tick))
          .map((c) =>
            c.tick < bs.startTick && c.tick + c.duration > bs.startTick
              ? { ...c, duration: bs.startTick - c.tick }
              : c,
          )
          .concat(incoming)
          .sort((a, b) => a.tick - b.tick);
      }
      if (selection.lyrics) {
        if (respect && lyricsProtected(locks, bs.section.id)) {
          issues.warn('lock.violated', `Lyrics of "${bs.section.name}" are locked and were not merged.`, {
            sectionId: bs.section.id,
          });
        } else {
          const lines = from.lyrics
            .filter((l) => l.sectionId === fs.section.id)
            .map((l) => ({ ...cloneSong(l), sectionId: bs.section.id }));
          out.lyrics = [...out.lyrics.filter((l) => l.sectionId !== bs.section.id), ...lines];
        }
      }
      merged.push(
        `section "${bs.section.name}"${fromTracks ? ` (${fromTracks.map((t) => t.name).join(', ')})` : ''}`,
      );
    }
  } else if (fromTracks) {
    for (const ft of fromTracks) {
      const bt = counterpart(ft);
      if (bt) {
        if (respect && (locks.tracks.has(bt.id) || bt.notes.some((n) => isProtected(bt, n)))) {
          issues.warn('lock.violated', `Track "${bt.name}" has locked material and was not merged.`, {
            trackId: bt.id,
          });
          continue;
        }
        const replacement: Track = { ...cloneSong(ft), id: bt.id, notes: ft.notes.map((n) => importNote(n)) };
        out.tracks = out.tracks.map((t) => (t === bt ? replacement : t));
        touchedTracks.add(replacement);
        merged.push(`track "${replacement.name}"`);
      } else {
        const id = out.tracks.some((t) => t.id === ft.id) ? ids.next('trk') : ft.id;
        const added: Track = { ...cloneSong(ft), id, notes: ft.notes.map((n) => importNote(n)) };
        out.tracks.push(added);
        if (from.mixer.channels[ft.id]) out.mixer.channels[id] = cloneSong(from.mixer.channels[ft.id]);
        out.automation.push(
          ...from.automation
            .filter((l) => l.target === ft.id)
            .map((l) => ({ ...cloneSong(l), id: ids.next('auto'), target: id })),
        );
        touchedTracks.add(added);
        merged.push(`added track "${added.name}"`);
      }
    }
  }

  if (selection.chords && !selection.sectionIds?.length) {
    if (respect && locks.chords)
      issues.warn('lock.violated', 'The chord progression is locked and was not merged.');
    else {
      out.chords = cloneSong(from.chords);
      merged.push('chords');
    }
  }
  if (selection.lyrics && !selection.sectionIds?.length) {
    if (respect && locks.lyrics) issues.warn('lock.violated', 'Lyrics are locked and were not merged.');
    else {
      const sectionIds = new Set(out.sections.map((s) => s.id));
      out.lyrics = from.lyrics.filter((l) => sectionIds.has(l.sectionId)).map((l) => cloneSong(l));
      const dropped = from.lyrics.length - out.lyrics.length;
      if (dropped)
        issues.info(
          'merge.lyrics-skipped',
          `${dropped} lyric line(s) belong to sections that do not exist here.`,
        );
      merged.push('lyrics');
    }
  }
  if (selection.mixer) {
    const targets = fromTracks ?? from.tracks;
    for (const ft of targets) {
      const bt = counterpart(ft);
      if (!bt) continue;
      if (respect && locks.mixers.has(bt.id)) {
        issues.warn('lock.violated', `The mixer channel of "${bt.name}" is locked and was not merged.`, {
          trackId: bt.id,
        });
        continue;
      }
      if (from.mixer.channels[ft.id]) out.mixer.channels[bt.id] = cloneSong(from.mixer.channels[ft.id]);
      out.automation = [
        ...out.automation.filter((l) => l.target !== bt.id),
        ...from.automation.filter((l) => l.target === ft.id).map((l) => ({ ...cloneSong(l), target: bt.id })),
      ];
    }
    if (!fromTracks) {
      if (respect && locks.mixers.has('master'))
        issues.warn('lock.violated', 'The master bus is locked and was not merged.');
      else {
        out.mixer.master = cloneSong(from.mixer.master);
        out.mixer.reverb = cloneSong(from.mixer.reverb);
        out.mixer.delay = cloneSong(from.mixer.delay);
        out.automation = [
          ...out.automation.filter((l) => l.target !== 'master'),
          ...cloneSong(from.automation.filter((l) => l.target === 'master')),
        ];
      }
    }
    merged.push('mixer');
  }
  if (selection.tempoKey) {
    if (respect && locks.tempo) issues.warn('lock.violated', 'Tempo is locked and was not merged.');
    else out.tempoMap = cloneSong(from.tempoMap);
    if (respect && locks.key) issues.warn('lock.violated', 'The key is locked and was not merged.');
    else {
      out.keyMap = cloneSong(from.keyMap);
      out.chords = out.chords.map((c) => ({ ...c, roman: chordToRoman(c, keyAtTick(out, c.tick)) }));
    }
    merged.push('tempo & key');
  }
  for (const t of touchedTracks) sortNotes(t.notes);
  return { song: out, report: issues.report(), merged };
}

/**
 * Merge selected material from another revision (any branch) into the working copy and commit
 * a merge revision with parents [head, from].
 */
export function mergeSelected(
  project: Project,
  fromRevisionId: string,
  selection: MergeSelection,
  message?: string,
  opts?: HistoryOptions & { author?: string; respectLocks?: boolean },
): Project {
  const from = requireRevision(project, fromRevisionId);
  const head = headRevision(project);
  const result = mergeSongs(project.song, from.snapshot, selection, { respectLocks: opts?.respectLocks });
  const now = nowIso(opts);
  const rev: Revision = {
    id: opts?.id ?? randomId('rev'),
    number: nextNumber(project),
    parents: [head.id, from.id],
    branchId: project.history.currentBranchId,
    message:
      message ??
      `Merged ${result.merged.length ? result.merged.join(', ') : 'selected changes'} from v${from.number}`,
    kind: 'merge',
    createdAt: now,
    snapshot: cloneSong(result.song),
  };
  if (opts?.author) rev.author = opts.author;
  return withRevision(project, rev, result.song, now);
}
