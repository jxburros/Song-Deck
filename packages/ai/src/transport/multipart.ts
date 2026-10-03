/**
 * multipart/form-data encoding to bytes, so multipart requests (Stability audio, file uploads)
 * work identically through DirectTransport and ServerProxyTransport (the proxy carries the bytes
 * base64-encoded with the original boundary in the content-type header).
 */
import { concatBytes, utf8Decode, utf8Encode } from '../util';

export type MultipartPart =
  | { name: string; value: string | number | boolean }
  | { name: string; data: Uint8Array; filename: string; contentType?: string };

export interface EncodedMultipart {
  body: Uint8Array;
  contentType: string;
  boundary: string;
}

function randomBoundary(): string {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `----SongDeckFormBoundary${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function escapeQuoted(s: string): string {
  return s.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
}

export function encodeMultipart(parts: readonly MultipartPart[], boundary: string = randomBoundary()): EncodedMultipart {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if ('data' in part) {
      chunks.push(
        utf8Encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(part.name)}"; filename="${escapeQuoted(part.filename)}"\r\n` +
            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      chunks.push(part.data);
      chunks.push(utf8Encode('\r\n'));
    } else {
      chunks.push(utf8Encode(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(part.name)}"\r\n\r\n${String(part.value)}\r\n`));
    }
  }
  chunks.push(utf8Encode(`--${boundary}--\r\n`));
  return { body: concatBytes(chunks), contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}

export interface DecodedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
  /** UTF-8 text of the part (for fields). */
  text: string;
}

/** Parse a multipart body (used by tests and the local server). */
export function decodeMultipart(body: Uint8Array, contentType: string): DecodedPart[] {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  if (!m) throw new Error('No multipart boundary in content-type');
  const boundary = utf8Encode(`--${m[2]}`);
  const parts: DecodedPart[] = [];
  const indexOf = (needle: Uint8Array, from: number) => {
    outer: for (let i = from; i <= body.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (body[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  let pos = indexOf(boundary, 0);
  while (pos >= 0) {
    let start = pos + boundary.length;
    if (body[start] === 45 && body[start + 1] === 45) break; // "--" terminator
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const next = indexOf(boundary, start);
    if (next < 0) break;
    let end = next;
    if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2;
    const chunk = body.subarray(start, end);
    const sep = (() => {
      for (let i = 0; i < chunk.length - 3; i++) if (chunk[i] === 13 && chunk[i + 1] === 10 && chunk[i + 2] === 13 && chunk[i + 3] === 10) return i;
      return -1;
    })();
    if (sep >= 0) {
      const headerText = utf8Decode(chunk.subarray(0, sep));
      const data = chunk.subarray(sep + 4);
      const name = /name="([^"]*)"/i.exec(headerText)?.[1] ?? '';
      const filename = /filename="([^"]*)"/i.exec(headerText)?.[1];
      const ct = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim();
      parts.push({ name, filename, contentType: ct, data, text: utf8Decode(data) });
    }
    pos = next;
  }
  return parts;
}
