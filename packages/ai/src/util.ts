/**
 * Small runtime-neutral helpers (browser + Node 20+; no Node-only APIs such as Buffer).
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  // URL-safe alphabet too.
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** Standard base64 (RFC 4648) encoding of bytes. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const n = bytes.length;
  let i = 0;
  const parts: string[] = [];
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (out.length > 32768) {
      parts.push(out);
      out = '';
    }
  }
  const rem = n - i;
  if (rem === 1) {
    const v = bytes[i] << 16;
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + '==';
  } else if (rem === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '=';
  }
  parts.push(out);
  return parts.join('');
}

/** Decode standard or URL-safe base64 (whitespace and missing padding tolerated). */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s=]/g, '');
  const n = clean.length;
  const outLen = Math.floor((n * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)];
    if (v < 0) throw new Error(`Invalid base64 character at ${i}`);
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return o === outLen ? out : out.subarray(0, o);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Copy bytes into a fresh ArrayBuffer-backed Uint8Array (safe for Blob/Response bodies in every runtime). */
export function toArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * Read a value at a path like `choices[0].message.content`, `candidates.0.content`,
 * or `data["audio-url"]`. Returns undefined when any segment is missing.
 */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const segments: (string | number)[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\[["']([^"']+)["']\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) segments.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
    else if (m[2] !== undefined) segments.push(Number(m[2]));
    else if (m[3] !== undefined) segments.push(m[3]);
  }
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Estimated tokens for text (≈ 4 characters per token). */
export function estimateTokens(text: string | number): number {
  const chars = typeof text === 'number' ? text : text.length;
  return Math.ceil(chars / 4);
}

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortReason(signal?: AbortSignal): Error {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  const e = new Error(typeof r === 'string' ? r : 'Aborted');
  e.name = 'AbortError';
  return e;
}

/** FNV-1a 32-bit hash → 8 hex chars. */
export function fnvHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Guess an audio MIME type from a format/extension/codec string. */
export function audioMimeType(format: string | undefined, fallback = 'audio/wav'): string {
  const f = (format ?? '').toLowerCase();
  if (!f) return fallback;
  if (f.includes('/')) return f;
  if (f.startsWith('mp3') || f === 'mpeg') return 'audio/mpeg';
  if (f.startsWith('wav') || f === 'wave') return 'audio/wav';
  if (f.startsWith('flac')) return 'audio/flac';
  if (f.startsWith('ogg') || f.startsWith('opus')) return 'audio/ogg';
  if (f.startsWith('pcm')) return 'audio/L16';
  if (f.startsWith('ulaw') || f.startsWith('mulaw')) return 'audio/basic';
  if (f.startsWith('aac') || f.startsWith('m4a')) return 'audio/aac';
  return fallback;
}

/** File extension for an audio MIME type. */
export function audioExtension(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('flac')) return 'flac';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('aac') || m.includes('mp4')) return 'm4a';
  return 'wav';
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Join a base URL and a path with exactly one slash. */
export function joinUrl(base: string, path: string): string {
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function withQuery(
  url: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return url;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return url + (url.includes('?') ? '&' : '?') + qs;
}
