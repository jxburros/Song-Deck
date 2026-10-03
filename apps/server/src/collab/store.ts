/**
 * Durable room state in `<dataDir>/collab/<projectId>/`:
 *   revisions.jsonl          append-only RevisionMeta lines (in commit order)
 *   snapshots/<revId>.json   the full Revision (with snapshot), written once per revision id
 *   comments.jsonl           append-only comment events (upsert / resolve)
 * A snapshot is written before its metadata line, so every listed revision can be served.
 * Truncated trailing lines (crash mid-append) are ignored on load.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Revision } from '@songdeck/core';
import { writeFileAtomic } from '../http-util';
import { type CollabComment, type RevisionMeta, SAFE_ID } from './protocol';

type CommentEvent = { t: 'upsert'; comment: CollabComment } | { t: 'resolve'; id: string; resolved: boolean; by?: string; at: string };

export interface RoomState {
  revisions: RevisionMeta[];
  branches: Record<string, string>;
  comments: Map<string, CollabComment>;
}

async function readLines(file: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* truncated or corrupt line: skip */
    }
  }
  return out;
}

export class RoomStore {
  readonly dir: string;
  private readonly revisionsFile: string;
  private readonly commentsFile: string;
  private readonly snapshotsDir: string;

  constructor(collabDir: string, readonly projectId: string) {
    if (!SAFE_ID.test(projectId)) throw new Error('unsafe project id');
    this.dir = path.join(collabDir, projectId);
    this.revisionsFile = path.join(this.dir, 'revisions.jsonl');
    this.commentsFile = path.join(this.dir, 'comments.jsonl');
    this.snapshotsDir = path.join(this.dir, 'snapshots');
  }

  async load(): Promise<RoomState> {
    const revisions: RevisionMeta[] = [];
    const ids = new Set<string>();
    const branches: Record<string, string> = {};
    for (const line of await readLines(this.revisionsFile)) {
      const meta = line as RevisionMeta;
      if (!meta || typeof meta.id !== 'string' || ids.has(meta.id)) continue;
      ids.add(meta.id);
      revisions.push(meta);
      if (typeof meta.branchId === 'string') branches[meta.branchId] = meta.id;
    }
    const comments = new Map<string, CollabComment>();
    for (const line of await readLines(this.commentsFile)) {
      const ev = line as CommentEvent;
      if (ev?.t === 'upsert' && ev.comment && typeof ev.comment.id === 'string') comments.set(ev.comment.id, ev.comment);
      else if (ev?.t === 'resolve' && typeof ev.id === 'string') {
        const c = comments.get(ev.id);
        if (c) comments.set(ev.id, { ...c, resolved: ev.resolved });
      }
    }
    return { revisions, branches, comments };
  }

  private snapshotFile(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('unsafe revision id');
    return path.join(this.snapshotsDir, `${id}.json`);
  }

  async appendRevision(meta: RevisionMeta, revision: Revision): Promise<void> {
    await fsp.mkdir(this.snapshotsDir, { recursive: true, mode: 0o700 });
    const file = this.snapshotFile(meta.id);
    const exists = await fsp
      .stat(file)
      .then(() => true)
      .catch(() => false);
    if (!exists) await writeFileAtomic(file, JSON.stringify(revision), 0o600);
    await fsp.appendFile(this.revisionsFile, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  }

  async readRevision(id: string): Promise<Revision | undefined> {
    if (!SAFE_ID.test(id)) return undefined;
    try {
      return JSON.parse(await fsp.readFile(this.snapshotFile(id), 'utf8')) as Revision;
    } catch {
      return undefined;
    }
  }

  async appendComment(event: CommentEvent): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fsp.appendFile(this.commentsFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  /** Revision count without loading the room (REST listing). */
  async revisionCount(): Promise<number> {
    const ids = new Set<string>();
    for (const line of await readLines(this.revisionsFile)) {
      const id = (line as { id?: unknown })?.id;
      if (typeof id === 'string') ids.add(id);
    }
    return ids.size;
  }
}

/** Project ids that have persisted rooms. */
export async function listRoomIds(collabDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(collabDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && SAFE_ID.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}
