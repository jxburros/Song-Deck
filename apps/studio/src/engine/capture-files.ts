/** Small browser file helpers for the capture modes (download, read, names). */

export function downloadBytes(
  bytes: Uint8Array | string,
  filename: string,
  mime = 'application/octet-stream',
) {
  const part: BlobPart = typeof bytes === 'string' ? bytes : (bytes as Uint8Array<ArrayBuffer>);
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function slugify(text: string, fallback = 'untitled'): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

/** "My Song (final).mp3" → "My Song (final)". */
export function baseName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, '').trim() || fileName;
}

export function extensionFor(mime: string, fallback = 'bin'): string {
  if (/wav/.test(mime)) return 'wav';
  if (/flac/.test(mime)) return 'flac';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  if (/ogg/.test(mime)) return 'ogg';
  if (/webm/.test(mime)) return 'webm';
  if (/mp4|aac|m4a/.test(mime)) return 'm4a';
  return fallback;
}

export const AUDIO_ACCEPT = 'audio/*,.wav,.wave,.mp3,.flac,.ogg,.oga,.m4a,.aac,.webm,.opus';
