/**
 * Render node (Phase 5 "distributed/local render nodes"): `GET /api/node/info` and
 * `POST /api/render`. The studio splits stem renders across several nodes (this machine and
 * others started with `--host 0.0.0.0 --token …`).
 *
 * Responses: mix / track / master → `audio/wav` bytes (master adds an `x-songdeck-report` JSON
 * header); stems → `{ stems: Record<name, wavBase64> }`; loudness → JSON report.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HttpError, readBody, readJsonFile, sendBytes, sendJson, writeFileAtomic } from '../http-util';
import type { Logger } from '../logger';
import type { Router } from '../router';
import { JobFailedError, PoolBusyError, RenderPool } from './pool';
import type { RenderKind } from './worker';

const CAPABILITY_BY_KIND: Record<RenderKind, string> = {
  mix: 'render-mix',
  stems: 'render-stems',
  track: 'render-track',
  master: 'master',
  loudness: 'loudness',
};

export interface RenderNodeOptions {
  dataDir: string;
  name: string;
  version: string;
  workers: number;
  maxQueue: number;
  inline: boolean;
  logger: Logger;
}

export interface NodeInfo {
  id: string;
  name: string;
  version: string;
  engineVersion?: string;
  cpuCores: number;
  loadAvg: number[];
  busyJobs: number;
  queuedJobs: number;
  maxJobs: number;
  maxQueue: number;
  capabilities: string[];
  mode: 'workers' | 'inline';
  platform: string;
  arch: string;
  totalMemGb: number;
  freeMemGb: number;
}

/** JSON in a header must be ASCII (Node rejects other characters). */
function asciiJson(value: unknown): string {
  return JSON.stringify(value ?? {}).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export class RenderNode {
  id = '';
  readonly pool: RenderPool;
  private kinds: RenderKind[] = [];
  private engineVersion?: string;

  constructor(private readonly opts: RenderNodeOptions) {
    this.pool = new RenderPool({ size: opts.workers, maxQueue: opts.maxQueue, inline: opts.inline, logger: opts.logger });
  }

  async init(): Promise<void> {
    const file = path.join(this.opts.dataDir, 'node.json');
    const saved = await readJsonFile<{ id?: string }>(file).catch(() => undefined);
    if (saved?.id && /^node_[a-f0-9]{12,}$/.test(saved.id)) this.id = saved.id;
    else {
      this.id = `node_${randomBytes(8).toString('hex')}`;
      await writeFileAtomic(file, JSON.stringify({ id: this.id }, null, 2), 0o600).catch(() => undefined);
    }
    try {
      const worker = await import('./worker');
      this.kinds = worker.availableKinds();
    } catch (err) {
      this.opts.logger.warn(`render node: audio engine unavailable (${(err as Error).message})`);
      this.kinds = [];
    }
    try {
      const core = await import('@songdeck/core');
      this.engineVersion = core.ENGINE_VERSION;
    } catch {
      /* optional */
    }
  }

  /** Whether at least one render kind is available. */
  get available(): boolean {
    return this.kinds.length > 0;
  }

  info(): NodeInfo {
    return {
      id: this.id,
      name: this.opts.name,
      version: this.opts.version,
      ...(this.engineVersion ? { engineVersion: this.engineVersion } : {}),
      cpuCores: os.availableParallelism?.() ?? os.cpus().length,
      loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      busyJobs: this.pool.busyJobs,
      queuedJobs: this.pool.queuedJobs,
      maxJobs: this.pool.size,
      maxQueue: this.pool.maxQueue,
      capabilities: this.kinds.map((k) => CAPABILITY_BY_KIND[k]),
      mode: this.pool.mode,
      platform: process.platform,
      arch: process.arch,
      totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      freeMemGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    };
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}

export function registerRenderRoutes(router: Router, node: RenderNode, limit: number): void {
  router.get('/api/node/info', ({ res }) => {
    sendJson(res, 200, node.info());
  });

  router.post('/api/render', async ({ req, res, signal }) => {
    if (!node.available) {
      req.resume();
      throw new HttpError(503, 'render-unavailable', 'The audio engine is not available on this render node');
    }
    if (node.pool.isFull()) {
      req.resume();
      throw new HttpError(429, 'busy', 'Render node is busy; retry later or use another node', { headers: { 'retry-after': '2', connection: 'close' } });
    }
    const body = await readBody(req, limit);
    let result;
    try {
      result = await node.pool.run(body, signal);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // client disconnected
      if (err instanceof PoolBusyError) throw new HttpError(429, 'busy', err.message, { headers: { 'retry-after': '2' } });
      if (err instanceof JobFailedError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
    const headers: Record<string, string> = {
      'x-songdeck-node': node.id,
      'x-songdeck-render-ms': String(result.renderMs),
      'cache-control': 'no-store',
      ...(result.durationSeconds !== undefined ? { 'x-songdeck-duration': result.durationSeconds.toFixed(3) } : {}),
    };
    if (result.kind === 'master' && result.json !== undefined) headers['x-songdeck-report'] = asciiJson(result.json);
    if (result.bytes) sendBytes(res, 200, result.bytes, result.contentType, headers);
    else sendJson(res, 200, result.json ?? {}, headers);
  });
}
