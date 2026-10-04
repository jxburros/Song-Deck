/**
 * HTTP helpers: uniform JSON errors (`{ error, code }`), size-limited body parsing, MIME types,
 * atomic file writes and small security utilities.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers?: Record<string, string>;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { headers?: Record<string, string>; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = opts.headers;
    this.details = opts.details;
  }
}

export const badRequest = (message: string, code = 'bad-request', details?: unknown) =>
  new HttpError(400, code, message, { details });
export const notFound = (message = 'Not found', code = 'not-found') => new HttpError(404, code, message);

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(204, { 'cache-control': 'no-store', ...headers });
  res.end();
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  bytes: Uint8Array,
  contentType: string,
  headers: Record<string, string> = {},
  headOnly = false,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(bytes.byteLength),
    ...headers,
  });
  if (headOnly) res.end();
  else res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/** Map anything thrown by a handler to the uniform `{ error, code }` response. */
export function errorPayload(err: unknown): {
  status: number;
  body: { error: string; code: string; details?: unknown };
  headers: Record<string, string>;
} {
  if (err instanceof HttpError) {
    const body: { error: string; code: string; details?: unknown } = { error: err.message, code: err.code };
    if (err.details !== undefined) body.details = err.details;
    return { status: err.status, body, headers: err.headers ?? {} };
  }
  return { status: 500, body: { error: 'Internal server error', code: 'internal' }, headers: {} };
}

export function sendError(res: ServerResponse, err: unknown): void {
  const { status, body, headers } = errorPayload(err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, body, headers);
}

function contentLength(req: IncomingMessage): number | undefined {
  const raw = req.headers['content-length'];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function payloadTooLarge(limit: number): HttpError {
  return new HttpError(413, 'payload-too-large', `Request body exceeds the limit of ${formatBytes(limit)}`, {
    headers: { connection: 'close' },
  });
}

/** Read the whole request body (bounded). */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = contentLength(req);
    if (declared !== undefined && declared > limit) {
      req.resume();
      reject(payloadTooLarge(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const onData = (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        req.removeListener('data', onData);
        req.resume();
        reject(payloadTooLarge(limit));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => {
      if (done) return;
      done = true;
      resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size));
    });
    req.once('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
    req.once('aborted', () => {
      if (done) return;
      done = true;
      reject(new HttpError(400, 'aborted', 'Request aborted by the client'));
    });
  });
}

export function parseJsonBuffer<T = unknown>(buf: Buffer | Uint8Array): T {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : Buffer.from(buf).toString('utf8');
  if (!text.trim()) throw badRequest('Request body must be JSON', 'invalid-json');
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw badRequest(`Invalid JSON: ${(err as Error).message}`, 'invalid-json');
  }
}

/** Read and parse a JSON body (bounded). */
export async function readJson<T = unknown>(req: IncomingMessage, limit: number): Promise<T> {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (type && !type.includes('json') && !type.startsWith('text/plain')) {
    req.resume();
    throw new HttpError(415, 'unsupported-media-type', `Expected application/json, got ${type}`);
  }
  return parseJsonBuffer<T>(await readBody(req, limit));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
  );
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${+(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${+(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Constant-time string comparison (token checks). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against itself to keep timing independent of where the mismatch is.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Request path for logs, with credentials in the query string redacted. */
export function redactPath(rawUrl: string | undefined): string {
  if (!rawUrl) return '/';
  return rawUrl.replace(/([?&](?:access_token|token|key|api_key|apikey)=)[^&#]*/gi, '$1[redacted]');
}

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
  '.mxl': 'application/vnd.recordare.musicxml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.sf2': 'application/octet-stream',
  '.sfz': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.songproject': 'application/octet-stream',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Write a file atomically (temp file in the same directory + rename). */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fsp.open(tmp, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
}

/** Serializes async work (one writer at a time). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** A path segment that is safe to use as a single file or directory name. */
export function isSafeSegment(seg: string): boolean {
  return (
    seg.length > 0 &&
    seg.length <= 255 &&
    seg !== '.' &&
    seg !== '..' &&
    !seg.includes('/') &&
    !seg.includes('\\') &&
    !seg.includes('\0') &&
    !/^[a-zA-Z]:/.test(seg)
  );
}

/** Resolve `segments` under `root`, refusing anything that escapes it (lexically). */
export function resolveInside(root: string, segments: string[]): string | undefined {
  for (const s of segments) if (!isSafeSegment(s)) return undefined;
  const resolved = path.resolve(root, ...segments);
  const rel = path.relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
  return undefined;
}

/** True when `child` (a real path) is `parent` or inside it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
