/**
 * Collaboration hub (Phase 5): rooms keyed by projectId on the `/api/collab` WebSocket, with
 * presence, full-snapshot revision commits (durable, append-only), comments and chat.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { isPlainObject, Mutex } from '../http-util';
import type { Logger } from '../logger';
import {
  type ChatEntry,
  type CollabComment,
  type CollabUser,
  type PeerInfo,
  type Presence,
  ProtocolError,
  revisionMeta,
  type RevisionMeta,
  SAFE_ID,
  validateComment,
  validatePresence,
  validateProjectId,
  validateRevision,
  validateUser,
} from './protocol';
import { listRoomIds, RoomStore, type RoomState } from './store';

interface Peer {
  peerId: string;
  ws: WebSocket;
  alive: boolean;
  user?: CollabUser;
  room?: Room;
  presence?: Presence;
  joinedAt?: string;
  queue: Promise<void>;
  helloTimer?: NodeJS.Timeout;
}

interface Room {
  projectId: string;
  store: RoomStore;
  state: RoomState;
  peers: Map<string, Peer>;
  mutex: Mutex;
  chat: ChatEntry[];
}

export interface CollabHubOptions {
  dataDir: string;
  maxMessageBytes: number;
  logger: Logger;
  heartbeatMs?: number;
  helloTimeoutMs?: number;
  maxPeersPerRoom?: number;
}

type Outgoing = Record<string, unknown> & { type: string };

const CHAT_HISTORY = 50;

export class CollabHub {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room>>();
  private readonly peers = new Set<Peer>();
  private readonly heartbeat: NodeJS.Timeout;
  readonly collabDir: string;

  constructor(private readonly opts: CollabHubOptions) {
    this.collabDir = path.join(opts.dataDir, 'collab');
    this.wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxMessageBytes, perMessageDeflate: false });
    this.heartbeat = setInterval(() => this.ping(), opts.heartbeatMs ?? 30_000);
    this.heartbeat.unref();
  }

  get connectionCount(): number {
    return this.peers.size;
  }

  /** Complete an (already authorized) upgrade request. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    const peer: Peer = { peerId: `peer_${randomBytes(6).toString('hex')}`, ws, alive: true, queue: Promise.resolve() };
    this.peers.add(peer);
    peer.helloTimer = setTimeout(() => {
      if (!peer.room) ws.close(4001, 'hello timeout');
    }, this.opts.helloTimeoutMs ?? 15_000);
    peer.helloTimer.unref();
    ws.on('pong', () => {
      peer.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      // Process one connection's messages strictly in order (handlers are async).
      peer.queue = peer.queue.then(() => this.onMessage(peer, data, isBinary)).catch((err) => {
        this.opts.logger.warn(`collab: message handling failed: ${(err as Error).message}`);
      });
    });
    ws.on('close', () => {
      clearTimeout(peer.helloTimer);
      this.peers.delete(peer);
      peer.queue = peer.queue
        .then(() => this.leave(peer))
        .catch((err) => this.opts.logger.warn(`collab: leaving failed: ${(err as Error).message}`));
    });
    ws.on('error', (err) => this.opts.logger.debug(`collab: socket error: ${err.message}`));
  }

  private ping(): void {
    for (const peer of this.peers) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      peer.alive = false;
      try {
        peer.ws.ping();
      } catch {
        /* closed */
      }
    }
  }

  private send(peer: Peer, msg: Outgoing): void {
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(msg));
  }

  private broadcast(room: Room, msg: Outgoing, except?: Peer): void {
    const text = JSON.stringify(msg);
    for (const p of room.peers.values()) {
      if (p !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(text);
    }
  }

  private error(peer: Peer, code: string, error: string, reqId?: unknown): void {
    this.send(peer, { type: 'error', code, error, ...(reqId !== undefined ? { reqId } : {}) });
  }

  private async loadRoom(projectId: string): Promise<Room> {
    const existing = this.rooms.get(projectId);
    if (existing) return existing;
    let pending = this.loading.get(projectId);
    if (!pending) {
      pending = (async () => {
        const store = new RoomStore(this.collabDir, projectId);
        const state = await store.load();
        const room: Room = { projectId, store, state, peers: new Map(), mutex: new Mutex(), chat: [] };
        this.rooms.set(projectId, room);
        return room;
      })().finally(() => this.loading.delete(projectId));
      this.loading.set(projectId, pending);
    }
    return pending;
  }

  private peerInfo(p: Peer): PeerInfo {
    return { peerId: p.peerId, user: p.user as CollabUser, ...(p.presence ? { presence: p.presence } : {}), joinedAt: p.joinedAt ?? '' };
  }

  private async onMessage(peer: Peer, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) return this.error(peer, 'binary-not-supported', 'Messages must be JSON text frames');
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isPlainObject(parsed) || typeof parsed.type !== 'string') return this.error(peer, 'invalid-message', 'Messages must be objects with a "type"');
      msg = parsed;
    } catch {
      return this.error(peer, 'invalid-json', 'Message is not valid JSON');
    }
    const reqId = typeof msg.reqId === 'string' || typeof msg.reqId === 'number' ? msg.reqId : undefined;
    try {
      if (msg.type === 'ping') return this.send(peer, { type: 'pong', ...(reqId !== undefined ? { reqId } : {}) });
      if (msg.type === 'hello') return await this.onHello(peer, msg, reqId);
      const room = peer.room;
      if (!room || !peer.user) throw new ProtocolError('not-joined', 'Send hello before other messages');
      switch (msg.type) {
        case 'presence':
          return this.onPresence(peer, room, msg);
        case 'commit':
          return await this.onCommit(peer, room, msg, reqId);
        case 'request-revision':
          return await this.onRequestRevision(peer, room, msg, reqId);
        case 'comment':
          return await this.onComment(peer, room, msg, reqId);
        case 'resolve-comment':
          return await this.onResolveComment(peer, room, msg, reqId);
        case 'chat':
          return this.onChat(peer, room, msg);
        default:
          throw new ProtocolError('unknown-type', `Unknown message type "${msg.type}"`);
      }
    } catch (err) {
      if (err instanceof ProtocolError) return this.error(peer, err.code, err.message, reqId);
      this.opts.logger.error(`collab: ${msg.type} failed: ${(err as Error).stack ?? String(err)}`);
      return this.error(peer, 'internal', 'The server could not process this message', reqId);
    }
  }

  private async onHello(peer: Peer, msg: Record<string, unknown>, reqId: unknown): Promise<void> {
    if (peer.room) throw new ProtocolError('already-joined', 'hello was already received on this connection');
    const projectId = validateProjectId(msg.projectId);
    const user = validateUser(msg.user);
    let room: Room;
    // Join atomically with respect to room unloading (the instance must still be the live one).
    for (;;) {
      room = await this.loadRoom(projectId);
      if (this.rooms.get(projectId) === room) break;
    }
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (room.peers.size >= (this.opts.maxPeersPerRoom ?? 64)) {
      this.error(peer, 'room-full', 'This collaboration room is full', reqId);
      peer.ws.close(4003, 'room full');
      return;
    }
    clearTimeout(peer.helloTimer);
    peer.user = user;
    peer.room = room;
    peer.joinedAt = new Date().toISOString();
    room.peers.set(peer.peerId, peer);
    this.send(peer, {
      type: 'welcome',
      projectId,
      you: { peerId: peer.peerId },
      peers: [...room.peers.values()].filter((p) => p !== peer).map((p) => this.peerInfo(p)),
      revisions: room.state.revisions,
      branches: room.state.branches,
      comments: [...room.state.comments.values()],
      chat: room.chat,
      ...(reqId !== undefined ? { reqId } : {}),
    });
    this.broadcast(room, { type: 'peer-joined', peer: this.peerInfo(peer) }, peer);
    this.opts.logger.debug(`collab: ${user.name} joined ${projectId} (${room.peers.size} peers)`);
  }

  private onPresence(peer: Peer, room: Room, msg: Record<string, unknown>): void {
    peer.presence = validatePresence(msg);
    this.broadcast(room, { type: 'presence', peerId: peer.peerId, user: peer.user, presence: peer.presence }, peer);
  }

  private async onCommit(peer: Peer, room: Room, msg: Record<string, unknown>, reqId: unknown): Promise<void> {
    const revision = validateRevision(msg.revision);
    const branchId = msg.branchId === undefined ? revision.branchId : msg.branchId;
    if (typeof branchId !== 'string' || !branchId || branchId.length > 128) throw new ProtocolError('invalid-commit', 'branchId must be a string');
    await room.mutex.run(async () => {
      if (room.state.revisions.some((r) => r.id === revision.id)) {
        this.send(peer, { type: 'ack', revisionId: revision.id, duplicate: true, ...(reqId !== undefined ? { reqId } : {}) });
        return;
      }
      const meta: RevisionMeta = revisionMeta(revision, peer.user, new Date().toISOString(), branchId);
      await room.store.appendRevision(meta, revision);
      room.state.revisions.push(meta);
      room.state.branches[branchId] = revision.id;
      this.broadcast(room, { type: 'commit', branchId, revision, from: { peerId: peer.peerId, user: peer.user } }, peer);
      this.send(peer, { type: 'ack', revisionId: revision.id, ...(reqId !== undefined ? { reqId } : {}) });
    });
  }

  private async onRequestRevision(peer: Peer, room: Room, msg: Record<string, unknown>, reqId: unknown): Promise<void> {
    if (typeof msg.id !== 'string' || !SAFE_ID.test(msg.id)) throw new ProtocolError('invalid-request', 'id must be a revision id');
    const revision = await room.store.readRevision(msg.id);
    if (!revision) throw new ProtocolError('not-found', `Revision ${msg.id} not found`);
    this.send(peer, { type: 'revision', revision, ...(reqId !== undefined ? { reqId } : {}) });
  }

  private async onComment(peer: Peer, room: Room, msg: Record<string, unknown>, reqId: unknown): Promise<void> {
    const comment: CollabComment = validateComment(msg.comment);
    await room.mutex.run(async () => {
      await room.store.appendComment({ t: 'upsert', comment });
      room.state.comments.set(comment.id, comment);
      this.broadcast(room, { type: 'comment', comment, from: { peerId: peer.peerId, user: peer.user } }, peer);
      this.send(peer, { type: 'ack', commentId: comment.id, ...(reqId !== undefined ? { reqId } : {}) });
    });
  }

  private async onResolveComment(peer: Peer, room: Room, msg: Record<string, unknown>, reqId: unknown): Promise<void> {
    if (typeof msg.id !== 'string' || !SAFE_ID.test(msg.id)) throw new ProtocolError('invalid-request', 'id must be a comment id');
    if (msg.resolved !== undefined && typeof msg.resolved !== 'boolean') throw new ProtocolError('invalid-request', 'resolved must be a boolean');
    const id = msg.id;
    const resolved = msg.resolved !== false;
    await room.mutex.run(async () => {
      const existing = room.state.comments.get(id);
      if (!existing) throw new ProtocolError('not-found', `Comment ${id} not found`);
      await room.store.appendComment({ t: 'resolve', id, resolved, by: peer.user?.id, at: new Date().toISOString() });
      room.state.comments.set(id, { ...existing, resolved });
      this.broadcast(room, { type: 'resolve-comment', id, resolved, by: peer.user }, peer);
      this.send(peer, { type: 'ack', commentId: id, ...(reqId !== undefined ? { reqId } : {}) });
    });
  }

  private onChat(peer: Peer, room: Room, msg: Record<string, unknown>): void {
    if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 4000) throw new ProtocolError('invalid-chat', 'text must be 1..4000 characters');
    const entry: ChatEntry = { peerId: peer.peerId, user: peer.user as CollabUser, text: msg.text, at: new Date().toISOString() };
    room.chat.push(entry);
    if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
    this.broadcast(room, { type: 'chat', ...entry }, peer);
  }

  private async leave(peer: Peer): Promise<void> {
    const room = peer.room;
    if (!room) return;
    room.peers.delete(peer.peerId);
    peer.room = undefined;
    this.broadcast(room, { type: 'peer-left', peerId: peer.peerId, user: peer.user });
    // Unload idle rooms once their pending writes are done (state lives on disk).
    await room.mutex.run(() => {
      if (room.peers.size === 0 && this.rooms.get(room.projectId) === room) this.rooms.delete(room.projectId);
    });
  }

  // -------------------------------------------------------------------------
  // REST helpers
  // -------------------------------------------------------------------------

  async listRooms(): Promise<{ projectId: string; peers: number; revisions: number }[]> {
    const ids = new Set([...(await listRoomIds(this.collabDir)), ...this.rooms.keys()]);
    const out: { projectId: string; peers: number; revisions: number }[] = [];
    for (const projectId of [...ids].sort()) {
      const room = this.rooms.get(projectId);
      out.push({
        projectId,
        peers: room?.peers.size ?? 0,
        revisions: room ? room.state.revisions.length : await new RoomStore(this.collabDir, projectId).revisionCount(),
      });
    }
    return out;
  }

  async roomSummary(projectId: string): Promise<
    | { projectId: string; peers: PeerInfo[]; revisions: RevisionMeta[]; branches: Record<string, string>; comments: CollabComment[] }
    | undefined
  > {
    if (!SAFE_ID.test(projectId)) return undefined;
    const room = this.rooms.get(projectId);
    const state = room ? room.state : await new RoomStore(this.collabDir, projectId).load();
    if (!room && !state.revisions.length && !state.comments.size) return undefined;
    return {
      projectId,
      peers: room ? [...room.peers.values()].map((p) => this.peerInfo(p)) : [],
      revisions: state.revisions,
      branches: state.branches,
      comments: [...state.comments.values()],
    };
  }

  async getRevision(projectId: string, revisionId: string) {
    if (!SAFE_ID.test(projectId) || !SAFE_ID.test(revisionId)) return undefined;
    return new RoomStore(this.collabDir, projectId).readRevision(revisionId);
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const peer of this.peers) {
      try {
        peer.ws.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    // Give close frames a moment, then drop whatever is left.
    await new Promise((r) => setTimeout(r, 50));
    for (const peer of this.peers) peer.ws.terminate();
    await Promise.all([...this.rooms.values()].map((room) => room.mutex.run(() => undefined)));
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
