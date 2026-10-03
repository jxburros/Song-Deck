import { createEmptySong } from '@songdeck/core';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { json, startServer, type TestServer } from './helpers';

let srv: TestServer | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await srv?.close();
  srv = undefined;
});

type Msg = Record<string, any> & { type: string };

/** A test client that buffers messages and lets tests await specific ones. */
class Client {
  readonly messages: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Msg;
      this.messages.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  }

  static async connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/collab`, { headers });
    sockets.push(ws);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    return client;
  }

  send(msg: Msg): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(type: string, pred: (m: Msg) => boolean = () => true, timeoutMs = 3000): Promise<Msg> {
    const seen = this.messages.find(
      (m) => m.type === type && pred(m) && !(m as { __taken?: boolean }).__taken,
    );
    if (seen) {
      (seen as { __taken?: boolean }).__taken = true;
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for ${type}; got ${JSON.stringify(this.messages.map((m) => m.type))}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        pred: (m) => m.type === type && pred(m),
        resolve: (m) => {
          clearTimeout(timer);
          (m as { __taken?: boolean }).__taken = true;
          resolve(m);
        },
      });
    });
  }

  async join(projectId: string, user: { id: string; name: string; color: string }): Promise<Msg> {
    this.send({ type: 'hello', projectId, user });
    return this.next('welcome');
  }
}

const ALICE = { id: 'u-alice', name: 'Alice', color: '#e5484d' };
const BOB = { id: 'u-bob', name: 'Bob', color: '#3e63dd' };

function revision(id: string, number: number, parents: string[] = [], branchId = 'br_main') {
  const snapshot = createEmptySong({ title: `Song ${id}`, id: 'song_1' });
  snapshot.sections.push({
    id: 'sec_verse',
    name: 'Verse 1',
    kind: 'verse',
    bars: 8,
    energy: 50,
  } as (typeof snapshot.sections)[number]);
  return {
    id,
    number,
    parents,
    branchId,
    message: `Revision ${number}`,
    kind: 'edit',
    createdAt: new Date().toISOString(),
    author: 'Alice',
    snapshot,
  };
}

describe('collaboration hub', () => {
  it('joins rooms and broadcasts presence, commits, comments and chat', async () => {
    srv = await startServer();
    const alice = await Client.connect(srv.url);
    const welcomeA = await alice.join('proj_1', ALICE);
    expect(welcomeA).toMatchObject({
      projectId: 'proj_1',
      peers: [],
      revisions: [],
      comments: [],
      branches: {},
    });
    const bob = await Client.connect(srv.url);
    const welcomeB = await bob.join('proj_1', BOB);
    expect(welcomeB.peers).toEqual([expect.objectContaining({ user: ALICE, peerId: welcomeA.you.peerId })]);
    const joined = await alice.next('peer-joined');
    expect(joined.peer).toMatchObject({ user: BOB, peerId: welcomeB.you.peerId });

    bob.send({
      type: 'presence',
      view: 'piano-roll',
      trackId: 'trk_bass',
      tick: 1920,
      selection: { noteIds: ['n1'] },
    });
    const presence = await alice.next('presence');
    expect(presence).toMatchObject({
      peerId: welcomeB.you.peerId,
      user: BOB,
      presence: { view: 'piano-roll', trackId: 'trk_bass', tick: 1920, selection: { noteIds: ['n1'] } },
    });

    const rev = revision('rev_1', 1);
    alice.send({ type: 'commit', branchId: 'br_main', revision: rev, reqId: 'c1' });
    expect(await alice.next('ack')).toMatchObject({ revisionId: 'rev_1', reqId: 'c1' });
    const commit = await bob.next('commit');
    expect(commit).toMatchObject({
      branchId: 'br_main',
      revision: { id: 'rev_1', snapshot: { title: 'Song rev_1' } },
      from: { user: ALICE },
    });
    // Re-committing the same revision id is idempotent.
    alice.send({ type: 'commit', branchId: 'br_main', revision: rev });
    expect(await alice.next('ack', (m) => m.duplicate === true)).toMatchObject({ revisionId: 'rev_1' });

    bob.send({ type: 'request-revision', id: 'rev_1', reqId: 7 });
    expect(await bob.next('revision')).toMatchObject({
      reqId: 7,
      revision: { id: 'rev_1', number: 1, snapshot: { sections: [{ id: 'sec_verse' }] } },
    });

    const comment = {
      id: 'cm_1',
      author: 'Bob',
      text: 'Chorus needs more lift',
      at: new Date().toISOString(),
      sectionId: 'sec_chorus',
      tick: 3840,
    };
    bob.send({ type: 'comment', comment });
    expect(await bob.next('ack')).toMatchObject({ commentId: 'cm_1' });
    expect((await alice.next('comment')).comment).toEqual(comment);
    alice.send({ type: 'resolve-comment', id: 'cm_1' });
    expect(await bob.next('resolve-comment')).toMatchObject({ id: 'cm_1', resolved: true, by: ALICE });

    alice.send({ type: 'chat', text: 'nice!' });
    expect(await bob.next('chat')).toMatchObject({ text: 'nice!', user: ALICE });

    const rooms = await json(await fetch(`${srv.url}/api/collab/rooms`));
    expect(rooms).toEqual([{ projectId: 'proj_1', peers: 2, revisions: 1 }]);
    const fetched = await json(await fetch(`${srv.url}/api/collab/rooms/proj_1/revisions/rev_1`));
    expect(fetched).toMatchObject({ id: 'rev_1', snapshot: { title: 'Song rev_1' } });
    expect((await fetch(`${srv.url}/api/collab/rooms/proj_1/revisions/rev_404`)).status).toBe(404);

    bob.ws.close();
    expect(await alice.next('peer-left')).toMatchObject({ peerId: welcomeB.you.peerId, user: BOB });
  });

  it('answers malformed messages with errors and keeps the connection', async () => {
    srv = await startServer();
    const c = await Client.connect(srv.url);
    c.ws.send('not json');
    expect((await c.next('error')).code).toBe('invalid-json');
    c.send({ type: 'presence', view: 'x' });
    expect((await c.next('error', (m) => m.code === 'not-joined')).code).toBe('not-joined');
    c.send({ type: 'hello', projectId: '../etc', user: ALICE });
    expect((await c.next('error', (m) => m.code === 'invalid-project')).code).toBe('invalid-project');
    await c.join('proj_2', ALICE);
    c.send({ type: 'commit', branchId: 'br_main', revision: { id: 'rev_x', number: 1 }, reqId: 'bad' });
    expect(await c.next('error', (m) => m.reqId === 'bad')).toMatchObject({ code: 'invalid-revision' });
    c.send({ type: 'commit', branchId: 'br_main', revision: { ...revision('../../evil', 1) } });
    expect((await c.next('error', (m) => m.code === 'invalid-revision')).error).toMatch(/revision.id/);
    c.send({ type: 'comment', comment: { id: 'c', author: 'A', text: '', at: 'now' } });
    expect((await c.next('error', (m) => m.code === 'invalid-comment')).code).toBe('invalid-comment');
    c.send({ type: 'resolve-comment', id: 'missing' });
    expect((await c.next('error', (m) => m.code === 'not-found')).code).toBe('not-found');
    c.send({ type: 'warp-drive' });
    expect((await c.next('error', (m) => m.code === 'unknown-type')).code).toBe('unknown-type');
    c.send({ type: 'ping' });
    await c.next('pong');
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('persists revisions and comments across restarts', async () => {
    srv = await startServer();
    const dataDir = srv.dataDir;
    const a = await Client.connect(srv.url);
    await a.join('proj_persist', ALICE);
    a.send({ type: 'commit', branchId: 'br_main', revision: revision('rev_1', 1) });
    await a.next('ack');
    a.send({ type: 'commit', branchId: 'br_alt', revision: revision('rev_2', 2, ['rev_1'], 'br_alt') });
    await a.next('ack');
    a.send({
      type: 'comment',
      comment: {
        id: 'cm_1',
        author: 'Alice',
        text: 'Keep this riff',
        at: '2026-10-03T10:00:00Z',
        trackId: 'trk_gtr',
      },
    });
    await a.next('ack');
    a.send({ type: 'resolve-comment', id: 'cm_1' });
    await a.next('ack', (m) => m.commentId === 'cm_1');
    a.ws.close();
    await srv.close({ keepData: true });

    srv = await startServer({ dataDir });
    const b = await Client.connect(srv.url);
    const welcome = await b.join('proj_persist', BOB);
    expect(welcome.revisions.map((r: { id: string }) => r.id)).toEqual(['rev_1', 'rev_2']);
    expect(welcome.revisions[0]).toMatchObject({
      number: 1,
      branchId: 'br_main',
      committedBy: { id: 'u-alice', name: 'Alice' },
    });
    expect(welcome.revisions[0].snapshot).toBeUndefined(); // metadata only
    expect(welcome.branches).toEqual({ br_main: 'rev_1', br_alt: 'rev_2' });
    expect(welcome.comments).toEqual([
      {
        id: 'cm_1',
        author: 'Alice',
        text: 'Keep this riff',
        at: '2026-10-03T10:00:00Z',
        trackId: 'trk_gtr',
        resolved: true,
      },
    ]);
    b.send({ type: 'request-revision', id: 'rev_2' });
    expect((await b.next('revision')).revision).toMatchObject({
      id: 'rev_2',
      parents: ['rev_1'],
      snapshot: { title: 'Song rev_2' },
    });
    const summary = await json(await fetch(`${srv.url}/api/collab/rooms/proj_persist`));
    expect(summary).toMatchObject({
      projectId: 'proj_persist',
      revisions: [{ id: 'rev_1' }, { id: 'rev_2' }],
    });
  });

  it('checks the Origin and the token on WebSocket upgrades', async () => {
    srv = await startServer({ token: 'sekret' });
    await expect(Client.connect(srv.url)).rejects.toThrow(/401/);
    await expect(
      Client.connect(`${srv.url}`, { authorization: 'Bearer sekret', origin: 'https://evil.example' }),
    ).rejects.toThrow(/403/);
    const ok = await Client.connect(srv.url, {
      authorization: 'Bearer sekret',
      origin: 'http://localhost:5173',
    });
    await ok.join('proj_3', ALICE);
    const viaQuery = new WebSocket(`${srv.url.replace(/^http/, 'ws')}/api/collab?access_token=sekret`);
    sockets.push(viaQuery);
    await new Promise<void>((resolve, reject) => {
      viaQuery.once('open', () => resolve());
      viaQuery.once('error', reject);
    });
  });

  it('enforces the maximum message size', async () => {
    srv = await startServer({ limits: { wsMessageBytes: 64 * 1024 } });
    const c = await Client.connect(srv.url);
    await c.join('proj_big', ALICE);
    const closed = new Promise<number>((resolve) => c.ws.once('close', (code) => resolve(code)));
    c.send({ type: 'chat', text: 'x'.repeat(100 * 1024) });
    expect(await closed).toBe(1009);
  });
});
