import { create } from 'zustand';
import {
  TRACK_NEUTRAL,
  TRACK_PALETTE,
  randomId,
  unpackProject,
  type Project,
  type Revision,
  type Song,
} from '@songdeck/core';
import { serverBase, useSettings } from '../state/settings';
import { setLinearHistoryProbe, subscribeCommits, useStudio } from '../state/store';
import { useRuntime } from './runtime';

/**
 * Real-time collaboration client (spec §70 Phase 5 "collaboration", apps/server README
 * "Collaboration — WS /api/collab").
 *
 * One WebSocket per open project; the room is keyed by `project.meta.id`, so everyone who opened
 * the same shared `.songproject` lands in the same room.
 *
 *  - Local commits (`subscribeCommits`, plus a history watcher for revisions created outside
 *    `commit()`, e.g. restores) are sent as full-snapshot `commit` messages and kept in an outbox
 *    until the server acknowledges them, so nothing is lost across reconnects.
 *  - Remote commits go through `useStudio.applyRemoteRevision`, which fast-forwards when the
 *    collaborator built on our branch head and otherwise forks onto a collaborator branch — local
 *    work is never overwritten (merge later with History → Merge).
 *  - On (re)connect the client pulls the room revisions it is missing (`request-revision`) and pushes
 *    local revisions that descend from the room's history but never reached it.
 *  - Presence (current view / track / selection), comments anchored to section/track/bar, chat,
 *    ping/pong heartbeats and exponential-backoff reconnects.
 *
 * Wire extension: a revision sent by Song Deck carries `branchName` (the sender's branch display
 * name) so peers can name forks; it is stripped before the revision enters the project.
 */

// ---------------------------------------------------------------------------
// Protocol (mirrors apps/server/src/collab/protocol.ts)
// ---------------------------------------------------------------------------

export interface CollabUser {
  id: string;
  name: string;
  color: string;
}

export interface CollabPresenceInfo {
  view: string;
  trackId?: string;
  tick?: number;
  selection?: unknown;
}

export interface CollabPeer {
  peerId: string;
  user: CollabUser;
  presence?: CollabPresenceInfo;
  joinedAt: string;
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
  /** Local only: sent, not yet acknowledged by the server. */
  pending?: boolean;
}

export interface CollabChatEntry {
  peerId: string;
  user: CollabUser;
  text: string;
  at: string;
  mine?: boolean;
}

export interface RoomRevisionMeta {
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

/** A revision on the wire (Song Deck adds the sender's branch name). */
export type WireRevision = Revision & { branchName?: string };

type ReqId = string | number;

type ServerMessage =
  | {
      type: 'welcome';
      projectId: string;
      you: { peerId: string };
      peers: CollabPeer[];
      revisions: RoomRevisionMeta[];
      branches: Record<string, string>;
      comments: CollabComment[];
      chat: Omit<CollabChatEntry, 'mine'>[];
      reqId?: ReqId;
    }
  | { type: 'peer-joined'; peer: CollabPeer }
  | { type: 'peer-left'; peerId: string; user?: CollabUser }
  | { type: 'presence'; peerId: string; user: CollabUser; presence: CollabPresenceInfo }
  | { type: 'commit'; branchId: string; revision: WireRevision; from?: { peerId: string; user: CollabUser } }
  | { type: 'ack'; revisionId?: string; commentId?: string; duplicate?: boolean; reqId?: ReqId }
  | { type: 'revision'; revision: WireRevision; reqId?: ReqId }
  | { type: 'comment'; comment: CollabComment; from?: { peerId: string; user: CollabUser } }
  | { type: 'resolve-comment'; id: string; resolved: boolean; by?: CollabUser }
  | { type: 'chat'; peerId: string; user: CollabUser; text: string; at: string }
  | { type: 'error'; code: string; error: string; reqId?: ReqId }
  | { type: 'pong'; reqId?: ReqId };

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type CollabStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface CollabActivity {
  id: string;
  at: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export interface CollabState {
  status: CollabStatus;
  /** Project (room) the client is connected or connecting to. */
  projectId: string | null;
  projectName: string | null;
  peerId: string | null;
  peers: CollabPeer[];
  comments: CollabComment[];
  chat: CollabChatEntry[];
  /** Revisions stored in the room. */
  roomRevisions: number;
  /** Local commits waiting for the server's acknowledgement. */
  outbox: number;
  sent: number;
  received: number;
  error: string | null;
  /** Epoch ms of the next reconnect attempt. */
  retryAt: number | null;
  activity: CollabActivity[];
  // Preferences (display name = Settings → user name)
  clientId: string;
  color: string;
  autoConnect: boolean;
  /** Server access token (only needed for servers started with --token). Session-only. */
  token: string;
}

/** Collaborator colours: the track palette minus the brand pink, which marks your own selection. */
export const PEER_COLORS = [2, 8, 5, 3, 10, 1, 9, 11].map((i) => TRACK_PALETTE[i]);

const PREFS_KEY = 'songdeck:collab';
const TOKEN_KEY = 'songdeck:collab-token';

interface Prefs {
  clientId: string;
  color: string;
  autoConnect: boolean;
}

function loadPrefs(): Prefs {
  let p: Partial<Prefs> = {};
  try {
    p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
  } catch {
    /* storage unavailable */
  }
  const prefs: Prefs = {
    clientId:
      typeof p.clientId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(p.clientId)
        ? p.clientId
        : randomId('user'),
    color:
      typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color)
        ? p.color
        : PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
    autoConnect: p.autoConnect === true,
  };
  savePrefs(prefs);
  return prefs;
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

const hasWindow = typeof window !== 'undefined';
const initialPrefs: Prefs = hasWindow
  ? loadPrefs()
  : { clientId: 'user_node', color: PEER_COLORS[0], autoConnect: false };

export const useCollab = create<CollabState>(() => ({
  status: 'disconnected',
  projectId: null,
  projectName: null,
  peerId: null,
  peers: [],
  comments: [],
  chat: [],
  roomRevisions: 0,
  outbox: 0,
  sent: 0,
  received: 0,
  error: null,
  retryAt: null,
  activity: [],
  ...initialPrefs,
  token: hasWindow ? loadToken() : '',
}));

export function setCollabPrefs(patch: Partial<Pick<CollabState, 'color' | 'autoConnect' | 'token'>>): void {
  useCollab.setState(patch);
  const s = useCollab.getState();
  savePrefs({ clientId: s.clientId, color: s.color, autoConnect: s.autoConnect });
  if (patch.token !== undefined) {
    try {
      if (patch.token) sessionStorage.setItem(TOKEN_KEY, patch.token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
  if (patch.color !== undefined) client.refreshIdentity();
}

function log(tone: CollabActivity['tone'], text: string): void {
  const entry: CollabActivity = { id: randomId('act'), at: new Date().toISOString(), tone, text };
  useCollab.setState((s) => ({ activity: [entry, ...s.activity].slice(0, 60) }));
}

// ---------------------------------------------------------------------------
// URLs & HTTP helpers (shared projects)
// ---------------------------------------------------------------------------

/** WebSocket URL of the collaboration hub, derived from the server URL setting (or this page's origin). */
export function collabUrl(token = useCollab.getState().token): string {
  const base = serverBase();
  let url: string;
  if (base && /^https?:\/\//i.test(base)) url = `${base.replace(/^http/i, 'ws')}/api/collab`;
  else if (hasWindow)
    url = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${base}/api/collab`;
  else url = 'ws://127.0.0.1:7788/api/collab';
  return token ? `${url}?access_token=${encodeURIComponent(token)}` : url;
}

export function collabAuthHeaders(): Record<string, string> {
  const token = useCollab.getState().token;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function serverError(res: Response): Promise<Error> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    /* not JSON */
  }
  return new Error(message);
}

export interface SharedProjectInfo {
  name: string;
  file: string;
  size: number;
  mtime: string;
}

/** Upload the open project (packed .songproject, no secrets) to the server's shared project store. */
export async function shareProject(name?: string): Promise<SharedProjectInfo> {
  const st = useStudio.getState();
  if (!st.project) throw new Error('Open a project first');
  const bytes = await st.exportProjectBytes();
  const target = (name ?? st.project.meta.name).trim() || 'Untitled project';
  const res = await fetch(`${serverBase()}/api/projects/${encodeURIComponent(target)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', ...collabAuthHeaders() },
    body: new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
  });
  if (!res.ok) throw await serverError(res);
  const info = (await res.json()) as SharedProjectInfo;
  log('success', `Shared “${st.project.meta.name}” as ${info.file}`);
  return info;
}

export async function listSharedProjects(): Promise<SharedProjectInfo[]> {
  const res = await fetch(`${serverBase()}/api/projects`, { headers: collabAuthHeaders() });
  if (!res.ok) throw await serverError(res);
  const data = (await res.json()) as { projects?: SharedProjectInfo[] };
  return data.projects ?? [];
}

export async function fetchSharedProject(name: string): Promise<Uint8Array> {
  const res = await fetch(`${serverBase()}/api/projects/${encodeURIComponent(name)}`, {
    headers: collabAuthHeaders(),
  });
  if (!res.ok) throw await serverError(res);
  return new Uint8Array(await res.arrayBuffer());
}

/** Peek at a shared package without importing it (id/name/revisions). */
export function inspectSharedProject(bytes: Uint8Array): {
  id: string;
  name: string;
  revisions: number;
  title: string;
} {
  const { project } = unpackProject(bytes);
  return {
    id: project.meta.id,
    name: project.meta.name,
    revisions: project.history.revisions.length,
    title: project.song.title,
  };
}

/** Download and open a shared project (replaces a local copy with the same id). */
export async function openSharedProject(name: string, bytes?: Uint8Array): Promise<void> {
  const data = bytes ?? (await fetchSharedProject(name));
  await useStudio.getState().importProjectBytes(data);
  log('info', `Opened shared project ${name}`);
}

export async function deleteSharedProject(name: string): Promise<void> {
  const res = await fetch(`${serverBase()}/api/projects/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: collabAuthHeaders(),
  });
  if (!res.ok && res.status !== 404) throw await serverError(res);
}

export interface RoomSummary {
  projectId: string;
  peers: number;
  revisions: number;
}

export async function listRooms(): Promise<RoomSummary[]> {
  const res = await fetch(`${serverBase()}/api/collab/rooms`, { headers: collabAuthHeaders() });
  if (!res.ok) throw await serverError(res);
  const data = (await res.json()) as RoomSummary[] | { rooms?: RoomSummary[] };
  return Array.isArray(data) ? data : (data.rooms ?? []);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
/** The handshake + welcome must complete within this time (proxies without upstream can hang). */
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const PRESENCE_THROTTLE_MS = 300;
/** The hub accepts messages up to 32 MB; stay below it so an oversized revision cannot loop reconnects. */
const MAX_MESSAGE_CHARS = 30 * 1024 * 1024;
/** Close codes after which reconnecting is pointless. */
const FATAL_CLOSE = new Set([4003]);

interface PendingRequest {
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OutgoingCommit {
  revision: Revision;
  branchName: string;
}

function isSongLike(v: unknown): v is Song {
  const s = v as Song | undefined;
  return (
    !!s &&
    typeof s === 'object' &&
    Array.isArray(s.tracks) &&
    Array.isArray(s.sections) &&
    Array.isArray(s.tempoMap) &&
    Array.isArray(s.meterMap) &&
    !!s.mixer
  );
}

function stripWire(wire: WireRevision): Revision {
  const { branchName: _b, ...rest } = wire;
  void _b;
  return rest as Revision;
}

function displayName(): string {
  const n = (useSettings.getState().userName ?? '').trim();
  return (n || 'Me').slice(0, 100);
}

class CollabClient {
  private ws: WebSocket | null = null;
  /** Project the user wants to be connected to (null = stay disconnected). */
  wanted: string | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private requests = new Map<string, PendingRequest>();
  private outbox = new Map<string, OutgoingCommit>();
  private commitReqs = new Map<string, string>();
  private roomIds = new Set<string>();
  private knownLocal = new Set<string>();
  private synced = false;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresence = '';

  // -- lifecycle ------------------------------------------------------------------------------

  connect(projectId: string): void {
    if (this.wanted === projectId && this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    if (this.wanted && this.wanted !== projectId) this.disconnect('switching project', true);
    this.wanted = projectId;
    this.attempt = 0;
    this.outbox.clear();
    this.roomIds.clear();
    this.synced = false;
    const project = useStudio.getState().project;
    useCollab.setState({
      projectId,
      projectName: project?.meta.id === projectId ? project.meta.name : null,
      error: null,
      peers: [],
      comments: [],
      chat: [],
      roomRevisions: 0,
      outbox: 0,
      sent: 0,
      received: 0,
    });
    this.open();
  }

  disconnect(reason = 'disconnected', quiet = false): void {
    const was = this.wanted;
    this.wanted = null;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000, reason.slice(0, 100));
      } catch {
        /* already closed */
      }
    }
    this.rejectAll(new Error('Disconnected'));
    this.outbox.clear();
    this.commitReqs.clear();
    useCollab.setState({
      status: 'disconnected',
      peerId: null,
      peers: [],
      retryAt: null,
      outbox: 0,
      projectId: null,
      projectName: null,
    });
    if (was && !quiet) log('info', `Left the room (${reason})`);
  }

  /** Reconnect now (e.g. after the server came back). */
  retryNow(): void {
    if (!this.wanted || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.open();
  }

  private identityTimer: ReturnType<typeof setTimeout> | null = null;

  /** Name/colour changed: rejoin (debounced) so peers see the new identity. */
  refreshIdentity(): void {
    if (this.identityTimer) clearTimeout(this.identityTimer);
    this.identityTimer = setTimeout(() => {
      this.identityTimer = null;
      if (this.wanted && this.ws?.readyState === WebSocket.OPEN) {
        const id = this.wanted;
        this.disconnect('identity changed', true);
        this.connect(id);
      }
    }, 800);
  }

  private open(): void {
    const projectId = this.wanted;
    if (!projectId) return;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    useCollab.setState({ status: this.attempt > 0 ? 'reconnecting' : 'connecting', retryAt: null });
    let ws: WebSocket;
    try {
      ws = new WebSocket(collabUrl());
    } catch (err) {
      useCollab.setState({ error: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.ws === ws && useCollab.getState().status !== 'connected')
        this.dropSocket(ws, 4000, 'connection timed out');
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      const s = useCollab.getState();
      this.raw({ type: 'hello', projectId, user: { id: s.clientId, name: displayName(), color: s.color } });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMessage;
      } catch {
        return;
      }
      try {
        this.handle(msg);
      } catch (err) {
        log(
          'error',
          `Could not process ${msg?.type ?? 'message'}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    ws.onclose = (ev) => this.onSocketClosed(ws, ev.code, ev.reason);
    ws.onerror = () => {
      useCollab.setState({
        error:
          useRuntime.getState().server.status === 'offline'
            ? 'The local server is not running'
            : 'Could not reach the collaboration server',
      });
    };
  }

  /** Abandon a socket at once (dead or hanging connections never finish a closing handshake). */
  private dropSocket(ws: WebSocket, code: number, reason: string): void {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    this.onSocketClosed(ws, code, reason);
  }

  private onSocketClosed(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.clearTimers();
    this.rejectAll(new Error('Connection closed'));
    const wasConnected = useCollab.getState().status === 'connected';
    useCollab.setState({ peers: [], peerId: null });
    if (!this.wanted) {
      useCollab.setState({ status: 'disconnected' });
      return;
    }
    if (FATAL_CLOSE.has(code)) {
      const why = reason || 'the room is full';
      useCollab.setState({ status: 'disconnected', error: why, projectId: null });
      log('error', `Disconnected: ${why}`);
      this.wanted = null;
      return;
    }
    if (wasConnected) log('warning', `Connection lost${reason ? ` (${reason})` : ''} — reconnecting…`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.wanted) return;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
    useCollab.setState({ status: 'reconnecting', retryAt: Date.now() + delay });
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.heartbeat = null;
    this.pongTimer = null;
    this.presenceTimer = null;
    this.connectTimer = null;
  }

  private rejectAll(err: Error): void {
    for (const r of this.requests.values()) {
      clearTimeout(r.timer);
      r.reject(err);
    }
    this.requests.clear();
  }

  // -- sending --------------------------------------------------------------------------------

  private raw(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private nextReq(): string {
    return `r${++this.seq}`;
  }

  private request(msg: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ServerMessage> {
    const reqId = this.nextReq();
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(reqId);
        reject(new Error(`${String(msg.type)} timed out`));
      }, timeoutMs);
      this.requests.set(reqId, { resolve, reject, timer });
      if (!this.raw({ ...msg, reqId })) {
        clearTimeout(timer);
        this.requests.delete(reqId);
        reject(new Error('Not connected'));
      }
    });
  }

  private settle(msg: { reqId?: ReqId }, err?: Error): boolean {
    if (msg.reqId === undefined) return false;
    const key = String(msg.reqId);
    const pending = this.requests.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.requests.delete(key);
    if (err) pending.reject(err);
    else pending.resolve(msg as ServerMessage);
    return true;
  }

  get connected(): boolean {
    return useCollab.getState().status === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  private sendCommit(c: OutgoingCommit): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = this.nextReq();
    const wire: WireRevision = { ...c.revision, branchName: c.branchName };
    const text = JSON.stringify({ type: 'commit', reqId, branchId: c.revision.branchId, revision: wire });
    if (text.length > MAX_MESSAGE_CHARS) {
      this.outbox.delete(c.revision.id);
      useCollab.setState({ outbox: this.outbox.size });
      log(
        'error',
        `“${c.revision.message}” is too large to share live (${Math.round(text.length / 1048576)} MB) — share the project file instead`,
      );
      return;
    }
    this.commitReqs.set(reqId, c.revision.id);
    this.ws.send(text);
    useCollab.setState((s) => ({ sent: s.sent + 1 }));
  }

  /** Queue a local revision for the room (sent now when connected, else after reconnecting). */
  queueRevision(project: Project, revision: Revision): void {
    if (!this.wanted || project.meta.id !== this.wanted) return;
    this.knownLocal.add(revision.id);
    if (this.roomIds.has(revision.id) || this.outbox.has(revision.id)) return;
    const branchName = project.history.branches.find((b) => b.id === revision.branchId)?.name ?? 'Main';
    const c: OutgoingCommit = { revision, branchName };
    this.outbox.set(revision.id, c);
    useCollab.setState({ outbox: this.outbox.size });
    if (this.connected && this.synced) this.sendCommit(c);
  }

  /** Revisions created without commit() (restore, merge…) are picked up from the history. */
  watchHistory(project: Project | null): void {
    if (!project || !this.wanted || project.meta.id !== this.wanted || !this.synced) return;
    for (const r of project.history.revisions) {
      if (this.knownLocal.has(r.id) || this.roomIds.has(r.id)) continue;
      this.queueRevision(project, r);
    }
  }

  private currentPresence(): CollabPresenceInfo | null {
    const st = useStudio.getState();
    if (!st.project || st.project.meta.id !== this.wanted) return null;
    const sel = st.selection;
    return {
      view: st.mode === 'workbench' ? `workbench/${st.workbenchView}` : st.mode,
      ...(st.selectedTrackId ? { trackId: st.selectedTrackId } : {}),
      ...(sel.startTick !== undefined ? { tick: Math.max(0, Math.round(sel.startTick)) } : {}),
      selection: {
        notes: sel.noteIds.length,
        ...(sel.sectionIds?.length ? { sectionIds: sel.sectionIds.slice(0, 16) } : {}),
        ...(sel.startTick !== undefined && sel.endTick !== undefined
          ? { startTick: sel.startTick, endTick: sel.endTick }
          : {}),
      },
    };
  }

  private flushPresence(always: boolean): void {
    const p = this.currentPresence();
    if (!p) return;
    const key = JSON.stringify(p);
    if (!always && key === this.lastPresence) return;
    this.lastPresence = key;
    this.raw({ type: 'presence', ...p });
  }

  /** Send our presence (view, track, selection) — throttled unless `immediate`. */
  sendPresence(immediate = false): void {
    if (!this.connected) return;
    if (immediate) {
      if (this.presenceTimer) clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
      this.flushPresence(true);
      return;
    }
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (this.connected) this.flushPresence(false);
    }, PRESENCE_THROTTLE_MS);
  }

  async comment(
    text: string,
    anchor: { sectionId?: string; trackId?: string; tick?: number },
  ): Promise<CollabComment> {
    if (!this.connected) throw new Error('Connect to the room first');
    const comment: CollabComment = {
      id: randomId('cmt'),
      author: displayName(),
      text: text.slice(0, 10_000),
      at: new Date().toISOString(),
      ...(anchor.sectionId ? { sectionId: anchor.sectionId } : {}),
      ...(anchor.trackId ? { trackId: anchor.trackId } : {}),
      ...(anchor.tick !== undefined && Number.isFinite(anchor.tick)
        ? { tick: Math.max(0, Math.round(anchor.tick)) }
        : {}),
    };
    useCollab.setState((s) => ({ comments: [...s.comments, { ...comment, pending: true }] }));
    try {
      await this.request({ type: 'comment', comment });
      useCollab.setState((s) => ({
        comments: s.comments.map((c) => (c.id === comment.id ? { ...c, pending: false } : c)),
      }));
    } catch (err) {
      useCollab.setState((s) => ({ comments: s.comments.filter((c) => c.id !== comment.id) }));
      throw err;
    }
    return comment;
  }

  async resolve(id: string, resolved: boolean): Promise<void> {
    if (!this.connected) throw new Error('Connect to the room first');
    const before = useCollab.getState().comments.find((c) => c.id === id);
    useCollab.setState((s) => ({ comments: s.comments.map((c) => (c.id === id ? { ...c, resolved } : c)) }));
    try {
      await this.request({ type: 'resolve-comment', id, resolved });
    } catch (err) {
      useCollab.setState((s) => ({
        comments: s.comments.map((c) => (c.id === id ? { ...c, resolved: before?.resolved } : c)),
      }));
      throw err;
    }
  }

  chat(text: string): void {
    const t = text.trim().slice(0, 4000);
    if (!t) return;
    if (!this.connected) throw new Error('Connect to the room first');
    const s = useCollab.getState();
    this.raw({ type: 'chat', text: t });
    useCollab.setState({
      chat: [
        ...s.chat,
        {
          peerId: s.peerId ?? 'me',
          user: { id: s.clientId, name: displayName(), color: s.color },
          text: t,
          at: new Date().toISOString(),
          mine: true,
        },
      ].slice(-100),
    });
  }

  // -- receiving ------------------------------------------------------------------------------

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome': {
        this.attempt = 0;
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.settle(msg);
        const me = useCollab.getState().clientId;
        this.roomIds = new Set(msg.revisions.map((r) => r.id));
        useCollab.setState({
          status: 'connected',
          error: null,
          retryAt: null,
          peerId: msg.you.peerId,
          peers: msg.peers,
          comments: msg.comments,
          chat: (msg.chat ?? []).map((c) => ({ ...c, mine: c.user?.id === me })),
          roomRevisions: msg.revisions.length,
        });
        log(
          'success',
          `Connected · ${msg.peers.length} other ${msg.peers.length === 1 ? 'person' : 'people'} in the room · ${msg.revisions.length} shared revision${msg.revisions.length === 1 ? '' : 's'}`,
        );
        this.startHeartbeat();
        void this.sync(msg.revisions);
        return;
      }
      case 'peer-joined':
        useCollab.setState((s) => ({
          peers: [...s.peers.filter((p) => p.peerId !== msg.peer.peerId), msg.peer],
        }));
        log('info', `${msg.peer.user.name} joined`);
        return;
      case 'peer-left': {
        const peer = useCollab.getState().peers.find((p) => p.peerId === msg.peerId);
        useCollab.setState((s) => ({ peers: s.peers.filter((p) => p.peerId !== msg.peerId) }));
        log('info', `${peer?.user.name ?? msg.user?.name ?? 'A collaborator'} left`);
        return;
      }
      case 'presence':
        useCollab.setState((s) => ({
          peers: s.peers.map((p) =>
            p.peerId === msg.peerId ? { ...p, user: msg.user ?? p.user, presence: msg.presence } : p,
          ),
        }));
        return;
      case 'commit':
        this.receive(msg.revision, msg.from?.user, true);
        useCollab.setState((s) => ({ roomRevisions: s.roomRevisions + 1 }));
        return;
      case 'ack': {
        const revId =
          msg.revisionId ?? (msg.reqId !== undefined ? this.commitReqs.get(String(msg.reqId)) : undefined);
        if (msg.reqId !== undefined) this.commitReqs.delete(String(msg.reqId));
        if (revId && this.outbox.has(revId)) {
          const sentMsg = this.outbox.get(revId)?.revision.message;
          if (!msg.duplicate && sentMsg !== undefined) log('success', `Shared “${sentMsg}” with the room`);
          this.outbox.delete(revId);
          this.roomIds.add(revId);
          useCollab.setState((s) => ({
            outbox: this.outbox.size,
            roomRevisions: msg.duplicate ? s.roomRevisions : s.roomRevisions + 1,
          }));
        }
        this.settle(msg);
        return;
      }
      case 'revision':
        this.settle(msg);
        return;
      case 'comment':
        useCollab.setState((s) => ({
          comments: [...s.comments.filter((c) => c.id !== msg.comment.id), msg.comment],
        }));
        log(
          'info',
          `${msg.from?.user.name ?? msg.comment.author} commented: “${msg.comment.text.slice(0, 80)}”`,
        );
        return;
      case 'resolve-comment':
        useCollab.setState((s) => ({
          comments: s.comments.map((c) => (c.id === msg.id ? { ...c, resolved: msg.resolved } : c)),
        }));
        return;
      case 'chat': {
        const me = useCollab.getState().clientId;
        useCollab.setState((s) => ({
          chat: [
            ...s.chat,
            { peerId: msg.peerId, user: msg.user, text: msg.text, at: msg.at, mine: msg.user?.id === me },
          ].slice(-100),
        }));
        return;
      }
      case 'error': {
        const commitRev = msg.reqId !== undefined ? this.commitReqs.get(String(msg.reqId)) : undefined;
        if (commitRev) {
          this.commitReqs.delete(String(msg.reqId));
          this.outbox.delete(commitRev);
          useCollab.setState({ outbox: this.outbox.size });
          log('error', `The server rejected a revision: ${msg.error}`);
          return;
        }
        if (this.settle(msg, new Error(msg.error))) return;
        useCollab.setState({ error: msg.error });
        log('error', msg.error);
        return;
      }
      case 'pong':
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        this.settle(msg);
        return;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.raw({ type: 'ping' })) return;
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        log('warning', 'No answer from the server — reconnecting');
        if (this.ws) this.dropSocket(this.ws, 4000, 'heartbeat timeout');
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  /** Apply a revision from the room (live commit or catch-up). */
  private receive(wire: WireRevision, from: CollabUser | undefined, live: boolean): void {
    if (!wire || typeof wire.id !== 'string') return;
    this.roomIds.add(wire.id);
    this.knownLocal.add(wire.id);
    const st = useStudio.getState();
    const project = st.project;
    if (!project || project.meta.id !== this.wanted) return;
    if (project.history.revisions.some((r) => r.id === wire.id)) return;
    if (!isSongLike(wire.snapshot)) {
      log('error', `Ignored revision “${wire.message}”: its snapshot is not a valid song`);
      return;
    }
    const revision = stripWire(wire);
    const who = from?.name ?? revision.author ?? 'A collaborator';
    const localBranch = project.history.branches.find((b) => b.id === revision.branchId);
    const branchName = localBranch?.name ?? wire.branchName ?? `${who}'s branch`;
    st.applyRemoteRevision(revision, branchName);
    const after = useStudio.getState().project;
    const landed = after?.history.revisions.find((r) => r.id === revision.id);
    const onCurrent = !!landed && landed.branchId === after?.history.currentBranchId;
    useCollab.setState((s) => ({ received: s.received + 1 }));
    const branch = after?.history.branches.find((b) => b.id === landed?.branchId);
    log('info', `${who}: “${revision.message}”${onCurrent ? '' : ` → branch ${branch?.name ?? branchName}`}`);
    if (live && onCurrent) st.toast('info', `${who} committed “${revision.message}”`);
  }

  /** Catch up with the room after (re)connecting, then push our pending work. */
  private async sync(roomRevisions: RoomRevisionMeta[]): Promise<void> {
    const projectId = this.wanted;
    const project = useStudio.getState().project;
    if (!projectId || !project || project.meta.id !== projectId) return;
    const local = new Set(project.history.revisions.map((r) => r.id));
    const missing = roomRevisions.filter((r) => !local.has(r.id));
    if (missing.length)
      log('info', `Fetching ${missing.length} revision${missing.length === 1 ? '' : 's'} from the room…`);
    for (const meta of missing) {
      if (this.wanted !== projectId || !this.connected) return;
      try {
        const reply = await this.request({ type: 'request-revision', id: meta.id });
        if (reply.type === 'revision')
          this.receive(
            reply.revision,
            meta.committedBy
              ? { id: meta.committedBy.id, name: meta.committedBy.name, color: TRACK_NEUTRAL }
              : undefined,
            false,
          );
      } catch (err) {
        log(
          'warning',
          `Could not fetch revision “${meta.message}”: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (this.wanted !== projectId) return;
    // Push local revisions that build on the room's history but never reached it (made offline,
    // or while the connection was down), oldest first.
    const current = useStudio.getState().project;
    if (current && current.meta.id === projectId) {
      const byId = new Map(current.history.revisions.map((r) => [r.id, r]));
      const memo = new Map<string, boolean>();
      const reaches = (id: string, depth: number): boolean => {
        if (this.roomIds.has(id)) return true;
        if (depth > 200) return false;
        const known = memo.get(id);
        if (known !== undefined) return known;
        memo.set(id, false);
        const r = byId.get(id);
        const ok = !!r && r.parents.some((p) => reaches(p, depth + 1));
        memo.set(id, ok);
        return ok;
      };
      for (const r of current.history.revisions) {
        this.knownLocal.add(r.id);
        if (!this.roomIds.has(r.id) && !this.outbox.has(r.id) && reaches(r.id, 0)) {
          const branchName = current.history.branches.find((b) => b.id === r.branchId)?.name ?? 'Main';
          this.outbox.set(r.id, { revision: r, branchName });
        }
      }
    }
    this.synced = true;
    useCollab.setState({ outbox: this.outbox.size });
    if (this.outbox.size)
      log(
        'info',
        `Sending ${this.outbox.size} local revision${this.outbox.size === 1 ? '' : 's'} to the room`,
      );
    for (const c of this.outbox.values()) this.sendCommit(c);
    this.sendPresence(true);
  }
}

const client = new CollabClient();

// While connected to the open project's room, undo/redo are committed as revisions so peers
// receive them (the store asks at undo time).
setLinearHistoryProbe(() => {
  const s = useCollab.getState();
  return s.status === 'connected' && !!s.projectId && s.projectId === useStudio.getState().project?.meta.id;
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Join the collaboration room of a project (default: the open project). */
export function connectCollab(projectId = useStudio.getState().project?.meta.id): void {
  if (!projectId) throw new Error('Open a project to collaborate on it');
  client.connect(projectId);
}

export function disconnectCollab(reason?: string): void {
  client.disconnect(reason ?? 'you disconnected');
}

export function retryCollabNow(): void {
  client.retryNow();
}

export function addCollabComment(
  text: string,
  anchor: { sectionId?: string; trackId?: string; tick?: number } = {},
): Promise<CollabComment> {
  return client.comment(text, anchor);
}

export function resolveCollabComment(id: string, resolved = true): Promise<void> {
  return client.resolve(id, resolved);
}

export function sendCollabChat(text: string): void {
  client.chat(text);
}

/** Human-readable presence ("Piano Roll · Bass"). */
export function describePresence(p: CollabPresenceInfo | undefined, song?: Song | null): string {
  if (!p) return 'Just joined';
  const VIEW: Record<string, string> = {
    home: 'Projects',
    compose: 'Compose',
    generate: 'Generate MIDI',
    transcribe: 'Transcribe',
    rebuild: 'Rebuild',
    produce: 'Produce',
    vocals: 'Vocals',
    mix: 'Mix & Master',
    export: 'Export',
    settings: 'Settings',
    'workbench/arrangement': 'Arrangement',
    'workbench/piano-roll': 'Piano Roll',
    'workbench/pattern': 'Pattern View',
    'workbench/chords': 'Chord View',
    'workbench/structure': 'Structure View',
    'workbench/theory': 'Theory View',
  };
  const parts = [VIEW[p.view] ?? p.view];
  const track = p.trackId ? song?.tracks.find((t) => t.id === p.trackId) : undefined;
  if (track) parts.push(track.name);
  const sel = p.selection as { notes?: number } | undefined;
  if (sel?.notes) parts.push(`${sel.notes} note${sel.notes === 1 ? '' : 's'} selected`);
  return parts.join(' · ');
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// Wiring: commits, project lifecycle, presence, server status
// ---------------------------------------------------------------------------

if (hasWindow) {
  subscribeCommits((project, revision) => client.queueRevision(project, revision));

  useStudio.subscribe((s, prev) => {
    const id = s.project?.meta.id ?? null;
    const prevId = prev.project?.meta.id ?? null;
    if (id !== prevId) {
      // Clean disconnect when the project closes or another project opens.
      if (client.wanted && client.wanted !== id)
        client.disconnect(id ? 'opened another project' : 'project closed');
      if (id && useCollab.getState().autoConnect && useRuntime.getState().server.status === 'online')
        client.connect(id);
      return;
    }
    if (s.project && s.project !== prev.project) {
      client.watchHistory(s.project);
      if (s.project.meta.name !== prev.project?.meta.name && client.wanted === id)
        useCollab.setState({ projectName: s.project.meta.name });
    }
    if (
      s.mode !== prev.mode ||
      s.workbenchView !== prev.workbenchView ||
      s.selectedTrackId !== prev.selectedTrackId ||
      s.selection !== prev.selection
    )
      client.sendPresence();
  });

  useSettings.subscribe((s, prev) => {
    if (s.userName !== prev.userName) client.refreshIdentity();
    // Another server: rejoin the room there.
    if (s.serverUrl !== prev.serverUrl && client.wanted) {
      const id = client.wanted;
      client.disconnect('server changed', true);
      client.connect(id);
    }
  });

  useRuntime.subscribe((r, prev) => {
    if (r.server.status === 'online' && prev.server.status !== 'online') {
      if (client.wanted) client.retryNow();
      else {
        const id = useStudio.getState().project?.meta.id;
        if (id && useCollab.getState().autoConnect) client.connect(id);
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    if (client.wanted) client.disconnect('page closed', true);
  });

  // Auto-connect at startup once the server answered.
  const startId = useStudio.getState().project?.meta.id;
  if (startId && useCollab.getState().autoConnect && useRuntime.getState().server.status === 'online')
    client.connect(startId);
}
