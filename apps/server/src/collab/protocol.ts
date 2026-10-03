/**
 * Collaboration protocol (Phase 5 "collaboration"): JSON messages over the `/api/collab`
 * WebSocket. Flat messages with a `type` discriminator; requests may carry a `reqId` that is
 * echoed in the direct reply (`ack`, `revision`, `error`).
 *
 * client → server
 *   hello            { projectId, user: { id, name, color } }
 *   presence         { view, trackId?, tick?, selection? }
 *   commit           { branchId, revision: Revision }            (full snapshot)
 *   request-revision { id }
 *   comment          { comment: { id, author, text, at, sectionId?, trackId?, tick?, resolved? } }
 *   resolve-comment  { id, resolved? = true }
 *   chat             { text }
 *   ping             {}
 *
 * server → client
 *   welcome          { projectId, you: { peerId }, peers, revisions: RevisionMeta[], branches, comments, chat }
 *   peer-joined      { peer }
 *   peer-left        { peerId, user }
 *   presence         { peerId, user, presence }
 *   commit           { branchId, revision, from }
 *   ack              { revisionId? | commentId?, duplicate? }
 *   revision         { revision }
 *   comment          { comment, from }
 *   resolve-comment  { id, resolved, by }
 *   chat             { peerId, user, text, at }
 *   error            { code, error }
 *   pong             {}
 */
import type { Revision } from '@songdeck/core';
import { isPlainObject } from '../http-util';

export interface CollabUser {
  id: string;
  name: string;
  color: string;
}

export interface Presence {
  view: string;
  trackId?: string;
  tick?: number;
  selection?: unknown;
}

export interface PeerInfo {
  peerId: string;
  user: CollabUser;
  presence?: Presence;
  joinedAt: string;
}

/** Revision metadata without the snapshot (what `welcome` lists). */
export interface RevisionMeta {
  id: string;
  number: number;
  parents: string[];
  branchId: string;
  message: string;
  kind: string;
  createdAt: string;
  author?: string;
  committedBy?: { id: string; name: string };
  receivedAt: string;
}

export interface CollabComment {
  id: string;
  author: string;
  text: string;
  at: string;
  sectionId?: string;
  trackId?: string;
  tick?: number;
  resolved?: boolean;
}

export interface ChatEntry {
  peerId: string;
  user: CollabUser;
  text: string;
  at: string;
}

/** Ids that are also used as file/directory names. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isStr = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.length >= min && v.length <= max;

export function validateUser(v: unknown): CollabUser {
  if (!isPlainObject(v)) throw new ProtocolError('invalid-user', 'user must be { id, name, color }');
  if (!isStr(v.id, 128)) throw new ProtocolError('invalid-user', 'user.id must be a non-empty string (max 128)');
  if (!isStr(v.name, 100)) throw new ProtocolError('invalid-user', 'user.name must be a non-empty string (max 100)');
  const color = typeof v.color === 'string' && v.color.length <= 32 && /^[#a-zA-Z0-9(),.%\s-]+$/.test(v.color) ? v.color : '#888888';
  return { id: v.id, name: v.name, color };
}

export function validateProjectId(v: unknown): string {
  if (typeof v !== 'string' || !SAFE_ID.test(v)) throw new ProtocolError('invalid-project', 'projectId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}');
  return v;
}

export function validatePresence(m: Record<string, unknown>): Presence {
  if (!isStr(m.view, 64)) throw new ProtocolError('invalid-presence', 'presence.view must be a non-empty string');
  const p: Presence = { view: m.view };
  if (m.trackId !== undefined && m.trackId !== null) {
    if (!isStr(m.trackId, 128)) throw new ProtocolError('invalid-presence', 'trackId must be a string');
    p.trackId = m.trackId;
  }
  if (m.tick !== undefined && m.tick !== null) {
    if (typeof m.tick !== 'number' || !Number.isFinite(m.tick) || m.tick < 0) throw new ProtocolError('invalid-presence', 'tick must be a non-negative number');
    p.tick = m.tick;
  }
  if (m.selection !== undefined) {
    const size = JSON.stringify(m.selection)?.length ?? 0;
    if (size > 64 * 1024) throw new ProtocolError('invalid-presence', 'selection is too large');
    p.selection = m.selection;
  }
  return p;
}

/** Validate the shape of a full-snapshot revision (structure only; the snapshot is stored as-is). */
export function validateRevision(v: unknown): Revision {
  if (!isPlainObject(v)) throw new ProtocolError('invalid-revision', 'revision must be an object');
  if (typeof v.id !== 'string' || !SAFE_ID.test(v.id)) throw new ProtocolError('invalid-revision', 'revision.id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}');
  if (typeof v.number !== 'number' || !Number.isInteger(v.number) || v.number < 0) throw new ProtocolError('invalid-revision', 'revision.number must be a non-negative integer');
  if (!Array.isArray(v.parents) || v.parents.length > 16 || v.parents.some((p) => typeof p !== 'string' || !SAFE_ID.test(p))) {
    throw new ProtocolError('invalid-revision', 'revision.parents must be an array of revision ids');
  }
  if (!isStr(v.branchId, 128)) throw new ProtocolError('invalid-revision', 'revision.branchId must be a string');
  if (!isStr(v.message, 4000, 0)) throw new ProtocolError('invalid-revision', 'revision.message must be a string');
  if (!isStr(v.kind, 64)) throw new ProtocolError('invalid-revision', 'revision.kind must be a string');
  if (!isStr(v.createdAt, 64)) throw new ProtocolError('invalid-revision', 'revision.createdAt must be a string');
  if (v.author !== undefined && v.author !== null && !isStr(v.author, 200, 0)) throw new ProtocolError('invalid-revision', 'revision.author must be a string');
  const s = v.snapshot;
  if (!isPlainObject(s) || !Array.isArray(s.tracks) || !Array.isArray(s.sections)) {
    throw new ProtocolError('invalid-revision', 'revision.snapshot must be a full Song (with tracks and sections)');
  }
  return v as unknown as Revision;
}

export function validateComment(v: unknown): CollabComment {
  if (!isPlainObject(v)) throw new ProtocolError('invalid-comment', 'comment must be an object');
  if (typeof v.id !== 'string' || !SAFE_ID.test(v.id)) throw new ProtocolError('invalid-comment', 'comment.id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}');
  if (!isStr(v.author, 200)) throw new ProtocolError('invalid-comment', 'comment.author must be a non-empty string');
  if (!isStr(v.text, 10_000)) throw new ProtocolError('invalid-comment', 'comment.text must be 1..10000 characters');
  if (!isStr(v.at, 64)) throw new ProtocolError('invalid-comment', 'comment.at must be a timestamp string');
  const c: CollabComment = { id: v.id, author: v.author, text: v.text, at: v.at };
  for (const key of ['sectionId', 'trackId'] as const) {
    const val = v[key];
    if (val === undefined || val === null) continue;
    if (!isStr(val, 128)) throw new ProtocolError('invalid-comment', `comment.${key} must be a string`);
    c[key] = val;
  }
  if (v.tick !== undefined && v.tick !== null) {
    if (typeof v.tick !== 'number' || !Number.isFinite(v.tick) || v.tick < 0) throw new ProtocolError('invalid-comment', 'comment.tick must be a non-negative number');
    c.tick = v.tick;
  }
  if (v.resolved !== undefined) {
    if (typeof v.resolved !== 'boolean') throw new ProtocolError('invalid-comment', 'comment.resolved must be a boolean');
    c.resolved = v.resolved;
  }
  return c;
}

export function revisionMeta(rev: Revision, committedBy: CollabUser | undefined, receivedAt: string, branchId?: string): RevisionMeta {
  return {
    id: rev.id,
    number: rev.number,
    parents: [...rev.parents],
    branchId: branchId ?? rev.branchId,
    message: rev.message,
    kind: rev.kind,
    createdAt: rev.createdAt,
    ...(rev.author ? { author: rev.author } : {}),
    ...(committedBy ? { committedBy: { id: committedBy.id, name: committedBy.name } } : {}),
    receivedAt,
  };
}
