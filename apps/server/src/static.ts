/**
 * Static serving of the built studio (`apps/studio/dist`) with SPA fallback, so
 * `songdeck-server` is a complete local app. Path-traversal safe (lexical + realpath checks),
 * correct MIME types, immutable caching for hashed assets.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { isWithin, mimeFor, resolveInside, sendJson } from './http-util';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

async function statFile(file: string): Promise<import('node:fs').Stats | undefined> {
  try {
    const st = await fsp.stat(file);
    return st;
  } catch {
    return undefined;
  }
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  size: number,
  cache: string,
): Promise<void> {
  res.writeHead(200, {
    'content-type': mimeFor(file),
    'content-length': String(size),
    'cache-control': cache,
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') {
    res.end();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const stream = createReadStream(file);
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
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'Not found', code: 'not-found' });
}

export function createStaticHandler(
  root: string,
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> {
  const rootResolved = path.resolve(root);
  let realRoot: string | undefined;
  const getRealRoot = async () => (realRoot ??= await fsp.realpath(rootResolved).catch(() => rootResolved));

  const serveIndex = async (req: IncomingMessage, res: ServerResponse) => {
    const index = path.join(rootResolved, 'index.html');
    const st = await statFile(index);
    if (!st?.isFile()) return notFound(res);
    return send(req, res, index, st.size, 'no-cache');
  };

  return async (req, res, url) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed', code: 'method-not-allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    let segments: string[];
    try {
      segments = url.pathname
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s));
    } catch {
      return notFound(res);
    }
    if (segments.some((s) => s.startsWith('.'))) return notFound(res); // no dotfiles
    const file = segments.length ? resolveInside(rootResolved, segments) : rootResolved;
    if (!file) return notFound(res);
    let st = await statFile(file);
    let target = file;
    if (st?.isDirectory()) {
      target = path.join(file, 'index.html');
      st = await statFile(target);
    }
    if (st?.isFile()) {
      const real = await fsp.realpath(target).catch(() => undefined);
      if (!real || !isWithin(await getRealRoot(), real)) return notFound(res);
      const immutable = segments[0] === 'assets' && /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(target);
      const cache =
        path.basename(target) === 'index.html'
          ? 'no-cache'
          : immutable
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=300';
      return send(req, res, real, st.size, cache);
    }
    // SPA fallback: client-side routes (no file extension, or an HTML navigation) get index.html.
    const last = segments[segments.length - 1] ?? '';
    const accept = String(req.headers.accept ?? '');
    if (!path.extname(last) || accept.includes('text/html')) return serveIndex(req, res);
    return notFound(res);
  };
}
