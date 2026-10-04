import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/logger';
import { PoolBusyError, RenderPool } from '../src/render/pool';
import type { RenderResult } from '../src/render/worker';

const result = (n: number): RenderResult => ({
  kind: 'loudness',
  contentType: 'application/json',
  json: { n },
  renderMs: 0,
});

describe('render pool', () => {
  it('falls back to inline rendering when workers cannot boot', async () => {
    const pool = new RenderPool({
      size: 2,
      maxQueue: 4,
      logger: silentLogger,
      workerUrl: new URL('data:text/javascript,throw new Error("no TypeScript loader")'),
      runInline: async (payload) => result(payload.length),
    });
    const out = await pool.run(new Uint8Array([1, 2, 3]));
    expect(out.json).toEqual({ n: 3 });
    expect(pool.mode).toBe('inline');
    expect(pool.size).toBe(1);
    await pool.close();
  });

  it('bounds the queue and cancels queued jobs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pool = new RenderPool({
      size: 1,
      maxQueue: 1,
      inline: true,
      logger: silentLogger,
      runInline: async (payload) => {
        await gate;
        return result(payload.length);
      },
    });
    const first = pool.run(new Uint8Array(1));
    await new Promise((r) => setImmediate(r));
    const ctrl = new AbortController();
    const second = pool.run(new Uint8Array(2), ctrl.signal);
    expect(pool.busyJobs).toBe(1);
    expect(pool.queuedJobs).toBe(1);
    expect(pool.isFull()).toBe(true);
    await expect(pool.run(new Uint8Array(3))).rejects.toBeInstanceOf(PoolBusyError);
    ctrl.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.queuedJobs).toBe(0);
    release();
    expect((await first).json).toEqual({ n: 1 });
    expect((await pool.run(new Uint8Array(4))).json).toEqual({ n: 4 });
    await pool.close();
    await expect(pool.run(new Uint8Array(1))).rejects.toMatchObject({ code: 'shutting-down' });
  });
});
