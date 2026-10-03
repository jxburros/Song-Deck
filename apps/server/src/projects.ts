/**
 * Project storage: `.songproject` packages in `<dataDir>/projects` (moving projects between
 * machines, seeding collaboration rooms). Projects never contain secrets (spec §7).
 *
 *   GET    /api/projects          → { projects: [{ name, file, size, mtime }] }
 *   GET    /api/projects/:name    → bytes (application/octet-stream)
 *   PUT    /api/projects/:name    ← bytes → { name, file, size, mtime }
 *   DELETE /api/projects/:name    → 204
 */
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, payloadTooLarge, sendJson, sendNoContent } from './http-util';
import type { Router } from './router';

export const PROJECT_EXT = '.songproject';
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Sanitize a user-supplied project name into a safe file stem (throws 400 when nothing is left). */
export function sanitizeProjectName(input: string): string {
  let name = input.normalize('NFC');
  if (name.toLowerCase().endsWith(PROJECT_EXT)) name = name.slice(0, -PROJECT_EXT.length);
  name = name
    .replace(/\.{2,}/g, '_')
    .replace(/[^\p{L}\p{N} ._()&,'+-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
    .replace(/[\s.]+$/g, '');
  if (!name || name === '_' || RESERVED.test(name)) throw new HttpError(400, 'invalid-name', 'Invalid project name');
  return name;
}

export interface ProjectInfo {
  name: string;
  file: string;
  size: number;
  mtime: string;
}

export class ProjectStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'projects');
  }

  fileFor(name: string): string {
    return path.join(this.dir, `${sanitizeProjectName(name)}${PROJECT_EXT}`);
  }

  async list(): Promise<ProjectInfo[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: ProjectInfo[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(PROJECT_EXT) || e.name.startsWith('.')) continue;
      const st = await fsp.stat(path.join(this.dir, e.name)).catch(() => undefined);
      if (!st) continue;
      out.push({ name: e.name.slice(0, -PROJECT_EXT.length), file: e.name, size: st.size, mtime: st.mtime.toISOString() });
    }
    return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  async info(name: string): Promise<ProjectInfo | undefined> {
    const file = this.fileFor(name);
    const st = await fsp.stat(file).catch(() => undefined);
    if (!st?.isFile()) return undefined;
    const base = path.basename(file);
    return { name: base.slice(0, -PROJECT_EXT.length), file: base, size: st.size, mtime: st.mtime.toISOString() };
  }

  /** Stream a request body into the project file (atomic replace, bounded, ZIP signature checked). */
  async write(name: string, req: IncomingMessage, limit: number): Promise<{ info: ProjectInfo; created: boolean }> {
    const file = this.fileFor(name);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      throw payloadTooLarge(limit);
    }
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const existed = Boolean(await fsp.stat(file).catch(() => undefined));
    const tmp = path.join(this.dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.upload`);
    const out = createWriteStream(tmp, { mode: 0o600 });
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      await new Promise<void>((resolve, reject) => {
        let failed = false;
        const fail = (err: unknown) => {
          if (failed) return;
          failed = true;
          req.unpipe(out);
          req.resume();
          out.destroy();
          reject(err);
        };
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
          if (size > limit) fail(payloadTooLarge(limit));
        });
        req.on('aborted', () => fail(new HttpError(400, 'aborted', 'Upload aborted')));
        req.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => {
          if (!failed) resolve();
        });
        req.pipe(out);
      });
      if (size === 0) throw new HttpError(400, 'empty-body', 'Request body is empty');
      // .songproject packages are ZIP archives (local file header or empty-archive signature).
      const sig = head.toString('binary');
      if (sig !== 'PK\u0003\u0004' && sig !== 'PK\u0005\u0006') {
        throw new HttpError(400, 'not-a-songproject', 'Body is not a .songproject package (expected a ZIP archive)');
      }
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    const info = await this.info(name);
    if (!info) throw new HttpError(500, 'internal', 'Project was not stored');
    return { info, created: !existed };
  }

  async remove(name: string): Promise<boolean> {
    try {
      await fsp.unlink(this.fileFor(name));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}

export function registerProjectRoutes(router: Router, store: ProjectStore, limit: number): void {
  router.get('/api/projects', async ({ res }) => {
    sendJson(res, 200, { projects: await store.list() });
  });

  router.get('/api/projects/:name', async ({ req, res, params }) => {
    const info = await store.info(params.name);
    if (!info) throw new HttpError(404, 'not-found', 'Project not found');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(info.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.file)}`,
      'last-modified': new Date(info.mtime).toUTCString(),
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise<void>((resolve) => {
      const stream = createReadStream(store.fileFor(params.name));
      stream.on('error', () => {
        res.destroy();
        resolve();
      });
      stream.on('end', () => resolve());
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  });

  router.put('/api/projects/:name', async ({ req, res, params }) => {
    const { info, created } = await store.write(params.name, req, limit);
    sendJson(res, created ? 201 : 200, info);
  });

  router.delete('/api/projects/:name', async ({ res, params }) => {
    if (!(await store.remove(params.name))) throw new HttpError(404, 'not-found', 'Project not found');
    sendNoContent(res);
  });
}
