import { describe, expect, it } from 'vitest';
import { TaskQueue, createMemoryPersistence, createStoragePersistence, type TaskContext } from '../src/tasks';
import type { TaskRecord } from '../src/ir/types';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Resolves when the signal aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

function clockFactory() {
  let t = 0;
  return () => new Date(Date.UTC(2026, 9, 3, 0, 0, 0, t++)).toISOString();
}

function idsFactory() {
  let n = 0;
  return () => `task_${++n}`;
}

describe('TaskQueue basics', () => {
  it('runs tasks, clamps progress, captures logs and notifies listeners', async () => {
    const q = new TaskQueue({ now: clockFactory(), ids: idsFactory() });
    const updates: TaskRecord[][] = [];
    const unsubscribe = q.subscribe((tasks) => updates.push(tasks));
    q.register<{ n: number }, number>('double', async (ctx) => {
      ctx.progress(-2, 'starting');
      ctx.log('info', 'doubling');
      ctx.progress(0.5);
      ctx.progress(7);
      ctx.progress(Number.NaN, 'almost');
      ctx.addCost(0.0125);
      return ctx.input.n * 2;
    });
    const rec = q.enqueue({
      type: 'double',
      title: 'Double 21',
      input: { n: 21 },
      providerId: 'internal',
      runner: 'local',
    });
    expect(rec).toMatchObject({
      id: 'task_1',
      status: 'queued',
      progress: 0,
      attempts: 0,
      maxAttempts: 1,
      priority: 0,
      dependsOn: [],
      providerId: 'internal',
      runner: 'local',
    });
    const done = await q.waitFor(rec.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: 42,
      progress: 1,
      attempts: 1,
      message: 'almost',
      costUsd: 0.0125,
    });
    expect(done.startedAt && done.finishedAt).toBeTruthy();
    expect(done.logs.map((l) => [l.level, l.message])).toEqual([
      ['info', 'Queued'],
      ['info', 'Started (attempt 1/1)'],
      ['info', 'doubling'],
      ['info', 'Succeeded'],
    ]);
    expect(done.logs.every((l) => /^2026-10-03T/.test(l.t))).toBe(true);
    await flush();
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1][0].status).toBe('succeeded');
    unsubscribe();
    const count = updates.length;
    q.enqueue({ type: 'double', title: 'again', input: { n: 1 } });
    await flush();
    expect(updates.length).toBe(count);
    // snapshots are copies
    const snap = q.get(rec.id)!;
    snap.logs.push({ t: 'x', level: 'info', message: 'tampered' });
    snap.status = 'failed';
    expect(q.get(rec.id)!.status).toBe('succeeded');
    expect(q.get(rec.id)!.logs.some((l) => l.message === 'tampered')).toBe(false);
  });

  it('fails clearly on handler errors and unknown task types', async () => {
    const q = new TaskQueue();
    q.register('boom', async () => {
      throw new Error('model offline');
    });
    q.register('sync-boom', (() => {
      throw new Error('sync failure');
    }) as never);
    const a = q.enqueue({ type: 'boom', title: 'Boom', input: null });
    const b = q.enqueue({ type: 'nope', title: 'Unknown', input: null });
    const c = q.enqueue({ type: 'sync-boom', title: 'Sync', input: null });
    expect(await q.waitFor(a.id)).toMatchObject({ status: 'failed', error: 'model offline' });
    expect((await q.waitFor(b.id)).error).toMatch(/No handler registered for task type "nope"/);
    expect(await q.waitFor(c.id)).toMatchObject({ status: 'failed', error: 'sync failure' });
    await expect(q.waitFor('missing')).rejects.toThrow(/Unknown task/);
    expect(() => q.enqueue({ type: '', title: 'x', input: 1 })).toThrow();
  });

  it('with awaitHandlers, keeps tasks queued until their handler is registered', async () => {
    const q = new TaskQueue({ awaitHandlers: true });
    q.register<number, number>('ready', async (ctx) => ctx.input + 1);
    const early = q.enqueue({ type: 'late', title: 'Early bird', input: 20 });
    const other = q.enqueue({ type: 'ready', title: 'Ready', input: 1 });
    expect((await q.waitFor(other.id)).result).toBe(2);
    expect(q.get(early.id)!.status).toBe('queued');
    q.register<number, number>('late', async (ctx) => ctx.input * 2);
    expect(await q.waitFor(early.id)).toMatchObject({ status: 'succeeded', result: 40 });
  });
});

describe('scheduling', () => {
  it('respects the concurrency limit and priority ordering', async () => {
    const q = new TaskQueue({ concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    const gates = new Map<string, { promise: Promise<void>; resolve: (v?: void) => void }>();
    q.register<string, string>('work', async (ctx) => {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(ctx.input);
      const gate = deferred<void>();
      gates.set(ctx.input, gate as { promise: Promise<void>; resolve: (v?: void) => void });
      await gate.promise;
      active--;
      return ctx.input;
    });
    const ids = ['a', 'b'].map((name) => q.enqueue({ type: 'work', title: name, input: name }).id);
    await flush();
    expect(started).toEqual(['a', 'b']);
    ids.push(
      ...['c', 'd', 'e'].map(
        (name, i) => q.enqueue({ type: 'work', title: name, input: name, priority: i === 2 ? 10 : 0 }).id,
      ),
    );
    await flush();
    expect(started).toEqual(['a', 'b']);
    expect(q.list().filter((t) => t.status === 'running')).toHaveLength(2);
    gates.get('a')!.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'e']); // highest priority next
    gates.get('b')!.resolve();
    gates.get('e')!.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'e', 'c', 'd']);
    q.setConcurrency(1);
    gates.get('c')!.resolve();
    gates.get('d')!.resolve();
    await q.idle();
    expect(maxActive).toBe(2);
    expect(q.list().every((t) => t.status === 'succeeded')).toBe(true);
    q.clearFinished();
    expect(q.list()).toEqual([]);
    expect(ids).toHaveLength(5);
    // With everything queued before the first scheduling pass, priority wins immediately.
    const q2 = new TaskQueue({ concurrency: 1 });
    const seen: string[] = [];
    q2.register<string, void>('w', async (ctx) => void seen.push(ctx.input));
    for (const [name, priority] of [
      ['low', 0],
      ['high', 5],
      ['mid', 1],
      ['low2', 0],
    ] as const)
      q2.enqueue({ type: 'w', title: name, input: name, priority });
    await q2.idle();
    expect(seen).toEqual(['high', 'mid', 'low', 'low2']);
  });

  it('gates on dependencies and fails dependents of failed tasks', async () => {
    const q = new TaskQueue({ concurrency: 4, ids: idsFactory() });
    const order: string[] = [];
    let failSeparation = true;
    q.register<string, string>('step', async (ctx) => {
      order.push(ctx.input);
      if (ctx.input === 'separate' && failSeparation) throw new Error('separation crashed');
      return ctx.input;
    });
    const sep = q.enqueue({ type: 'step', title: 'Separate reference stems', input: 'separate' });
    const trans = q.enqueue({
      type: 'step',
      title: 'Transcribe bass',
      input: 'transcribe',
      dependsOn: [sep.id],
    });
    const regen = q.enqueue({
      type: 'step',
      title: 'Regenerate guitar',
      input: 'regen',
      dependsOn: [trans.id],
    });
    const other = q.enqueue({ type: 'step', title: 'Render guide', input: 'render' });
    expect((await q.waitFor(trans.id)).error).toMatch(/dependency failed/i);
    expect((await q.waitFor(regen.id)).error).toMatch(/dependency failed/i);
    expect((await q.waitFor(other.id)).status).toBe('succeeded');
    expect(order).toEqual(['separate', 'render']);
    // Retrying the dependency re-queues its failed dependents.
    failSeparation = false;
    q.retry(sep.id);
    expect(await q.waitFor(regen.id)).toMatchObject({ status: 'succeeded' });
    expect(order).toEqual(['separate', 'render', 'separate', 'transcribe', 'regen']);
    expect(q.get(sep.id)!.attempts).toBe(2);
    const orphan = q.enqueue({ type: 'step', title: 'Orphan', input: 'x', dependsOn: ['does-not-exist'] });
    expect((await q.waitFor(orphan.id)).error).toMatch(/dependency failed.*does not exist/i);
    const c1 = q.enqueue({ type: 'step', title: 'c1', input: 'c1', id: 'c1', dependsOn: ['c2'] });
    q.enqueue({ type: 'step', title: 'c2', input: 'c2', id: 'c2', dependsOn: ['c1'] });
    expect((await q.waitFor(c1.id)).error).toMatch(/circular/);
  });
});

describe('cancel, retry, pause/resume', () => {
  it('cancels running tasks via AbortSignal and queued tasks without running them', async () => {
    const q = new TaskQueue({ concurrency: 1 });
    const runs: string[] = [];
    const finish = deferred<string>();
    q.register<string, string>('slow', async (ctx) => {
      runs.push(ctx.input);
      if (ctx.input === 'stubborn') return finish.promise; // ignores the signal
      await aborted(ctx.signal);
      throw ctx.signal.reason;
    });
    const a = q.enqueue({ type: 'slow', title: 'A', input: 'a' });
    const b = q.enqueue({ type: 'slow', title: 'B', input: 'b' });
    await flush();
    expect(q.get(a.id)!.status).toBe('running');
    q.cancel(b.id);
    q.cancel(a.id);
    expect(q.get(a.id)!.status).toBe('cancelled');
    expect((await q.waitFor(b.id)).status).toBe('cancelled');
    await flush();
    expect(runs).toEqual(['a']);
    // A handler that ignores the signal cannot resurrect a cancelled task, and its slot is freed.
    const s = q.enqueue({ type: 'slow', title: 'S', input: 'stubborn' });
    await flush();
    q.cancel(s.id);
    const next = q.enqueue({ type: 'slow', title: 'N', input: 'next' });
    await flush();
    expect(q.get(next.id)!.status).toBe('running');
    finish.resolve('late result');
    await flush();
    expect(q.get(s.id)).toMatchObject({ status: 'cancelled' });
    expect(q.get(s.id)!.result).toBeUndefined();
    q.remove(next.id);
    expect(q.get(next.id)).toBeUndefined();
    // cancel is idempotent and ignores finished tasks
    q.cancel(s.id);
    expect(q.get(s.id)!.logs.filter((l) => l.message === 'Cancelled')).toHaveLength(1);
  });

  it('retries automatically with the last checkpoint, then manually', async () => {
    const q = new TaskQueue();
    const seen: { attempt: number; previous: unknown }[] = [];
    q.register<null, string>('flaky', async (ctx) => {
      seen.push({ attempt: ctx.attempt, previous: ctx.previousCheckpoint });
      ctx.checkpoint({ step: ctx.attempt * 10 });
      if (ctx.attempt < 3) throw new Error(`timeout ${ctx.attempt}`);
      return 'ok';
    });
    const t = q.enqueue({ type: 'flaky', title: 'Flaky', input: null, maxAttempts: 3 });
    const done = await q.waitFor(t.id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 3, result: 'ok', checkpoint: { step: 30 } });
    expect(seen).toEqual([
      { attempt: 1, previous: undefined },
      { attempt: 2, previous: { step: 10 } },
      { attempt: 3, previous: { step: 20 } },
    ]);
    expect(done.logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      'Attempt 1 failed: timeout 1; retrying from the last checkpoint',
      'Attempt 2 failed: timeout 2; retrying from the last checkpoint',
    ]);
    // Manual retry after a final failure keeps the attempt count and checkpoint.
    let fail = true;
    q.register<null, string>('once', async (ctx) => {
      ctx.checkpoint({ attempt: ctx.attempt, resumedFrom: ctx.previousCheckpoint ?? null });
      if (fail) throw new Error('nope');
      return 'recovered';
    });
    const o = q.enqueue({ type: 'once', title: 'Once', input: null });
    expect((await q.waitFor(o.id)).status).toBe('failed');
    fail = false;
    q.retry(o.id);
    expect(q.get(o.id)!.status).toBe('queued');
    const again = await q.waitFor(o.id);
    expect(again).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      maxAttempts: 2,
      checkpoint: { attempt: 2, resumedFrom: { attempt: 1, resumedFrom: null } },
    });
    q.retry(o.id); // no effect on succeeded tasks
    expect(q.get(o.id)!.status).toBe('succeeded');
  });

  it('pause aborts a running task keeping its checkpoint; resume continues from it', async () => {
    const q = new TaskQueue();
    const calls: { attempt: number; previous: unknown }[] = [];
    const stage2 = deferred();
    q.register<null, string>('render', async (ctx) => {
      calls.push({ attempt: ctx.attempt, previous: ctx.previousCheckpoint });
      const start = (ctx.previousCheckpoint as { block: number } | undefined)?.block ?? 0;
      ctx.checkpoint({ block: start + 5 });
      ctx.progress(0.5);
      if (!ctx.previousCheckpoint) {
        await aborted(ctx.signal);
        ctx.checkpoint({ block: 999 }); // ignored: the run is no longer active
        throw ctx.signal.reason;
      }
      await stage2.promise;
      return `rendered from block ${start}`;
    });
    const t = q.enqueue({ type: 'render', title: 'Render guide mix', input: null });
    await flush();
    q.pause(t.id);
    const paused = q.get(t.id)!;
    expect(paused).toMatchObject({ status: 'paused', checkpoint: { block: 5 }, attempts: 0, progress: 0.5 });
    await flush();
    expect(q.get(t.id)!.checkpoint).toEqual({ block: 5 });
    q.resume(t.id);
    await flush();
    expect(q.get(t.id)!.status).toBe('running');
    stage2.resolve();
    const done = await q.waitFor(t.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: 'rendered from block 5',
      attempts: 1,
      checkpoint: { block: 10 },
    });
    expect(calls).toEqual([
      { attempt: 1, previous: undefined },
      { attempt: 1, previous: { block: 5 } },
    ]);
    // queued tasks can be paused too
    const q2 = new TaskQueue({ concurrency: 1 });
    const gate = deferred();
    q2.register('w', async () => gate.promise);
    const first = q2.enqueue({ type: 'w', title: '1', input: 1 });
    const second = q2.enqueue({ type: 'w', title: '2', input: 2 });
    q2.pause(second.id);
    gate.resolve();
    await q2.waitFor(first.id);
    await flush();
    expect(q2.get(second.id)!.status).toBe('paused');
    await q2.idle();
  });
});

describe('persistence', () => {
  it('persists tasks and resumes interrupted ones from their checkpoint after restore()', async () => {
    const persistence = createMemoryPersistence();
    const q1 = new TaskQueue({ persistence, ids: idsFactory() });
    const never = deferred();
    q1.register<{ file: string }, string>('transcribe', async (ctx) => {
      ctx.checkpoint({ chunk: 3 });
      ctx.progress(0.3, 'chunk 3/10');
      await never.promise; // the "app" closes while this runs
      return 'unreachable';
    });
    q1.register('quick', async () => 'done');
    const quick = q1.enqueue({ type: 'quick', title: 'Quick', input: null });
    await q1.waitFor(quick.id);
    const long = q1.enqueue({
      type: 'transcribe',
      title: 'Transcribe bass',
      input: { file: 'bass.wav' },
      maxAttempts: 2,
    });
    await flush();
    await flush();
    const saved = persistence.saved.find((t) => t.id === long.id)!;
    expect(saved).toMatchObject({ status: 'running', checkpoint: { chunk: 3 }, progress: 0.3, attempts: 1 });

    // A new session restores the queue.
    const q2 = new TaskQueue({ persistence });
    const resumedFrom: unknown[] = [];
    q2.register<{ file: string }, string>('transcribe', async (ctx) => {
      resumedFrom.push(ctx.previousCheckpoint);
      return `transcribed ${ctx.input.file}`;
    });
    await q2.restore();
    expect(q2.get(quick.id)).toMatchObject({ status: 'succeeded', result: 'done' });
    const done = await q2.waitFor(long.id);
    expect(done).toMatchObject({ status: 'succeeded', result: 'transcribed bass.wav', attempts: 1 });
    expect(resumedFrom).toEqual([{ chunk: 3 }]);
    expect(done.logs.some((l) => /Restored after restart/.test(l.message))).toBe(true);
    await flush();
    expect(persistence.saved.find((t) => t.id === long.id)!.status).toBe('succeeded');
    // restore() does not duplicate tasks already present
    await q2.restore();
    expect(q2.list()).toHaveLength(2);
  });

  it('storage persistence and persistence errors never break the queue', async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const errors: unknown[] = [];
    const q = new TaskQueue({
      persistence: createStoragePersistence(storage, 'tasks'),
      onError: (e) => errors.push(e),
    });
    q.register('noop', async (ctx: TaskContext) => ctx.input);
    await q.waitFor(q.enqueue({ type: 'noop', title: 'Noop', input: 7 }).id);
    await flush();
    expect(JSON.parse(mem.get('tasks')!)[0]).toMatchObject({ status: 'succeeded', result: 7 });
    const broken = new TaskQueue({
      persistence: { load: async () => [], save: async () => Promise.reject(new Error('disk full')) },
      onError: (e) => errors.push(e),
    });
    broken.register('noop', async () => 1);
    expect((await broken.waitFor(broken.enqueue({ type: 'noop', title: 'x', input: null }).id)).status).toBe(
      'succeeded',
    );
    await flush();
    expect(errors.some((e) => e instanceof Error && e.message === 'disk full')).toBe(true);
    mem.set('bad', '{not json');
    expect(await createStoragePersistence(storage, 'bad').load()).toEqual([]);
  });
});
