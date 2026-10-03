import { mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSongDeckServer, type SongDeckServer } from '../src/server';
import type { ServerOptions } from '../src/config';

export function tempDir(prefix = 'songdeck-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestServer {
  app: SongDeckServer;
  url: string;
  dataDir: string;
  close(opts?: { keepData?: boolean }): Promise<void>;
}

/** Start a server on an ephemeral port with an isolated data dir and no local discovery. */
export async function startServer(opts: ServerOptions = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? tempDir();
  const app = createSongDeckServer({
    port: 0,
    vault: 'memory',
    logLevel: 'silent',
    pluginDirs: [],
    discovery: { ollamaUrl: false, lmStudioUrl: false, localServices: false, ...(opts.discovery ?? {}) },
    ...opts,
    dataDir,
  });
  const { url } = await app.listen();
  return {
    app,
    url,
    dataDir,
    async close(o = {}) {
      await app.close();
      if (!o.keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface MockServer {
  url: string;
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }[];
  close(): Promise<void>;
}

/** A local HTTP server for upstream mocks (providers, Ollama, bridges). */
export async function startMock(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => unknown,
): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body });
      void Promise.resolve(handler(req, res, body)).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Raw HTTP request (lets tests set Host/Origin headers that fetch() forbids). */
export function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; path?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method: opts.method ?? 'GET',
        path: opts.path ?? `${u.pathname}${u.search}`,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
