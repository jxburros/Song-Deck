import { create } from 'zustand';
import type { Song } from '@songdeck/core';

/**
 * Delivery of exported files (spec §55: "users should always be able to export their work").
 *
 * Every export ends here: the bytes become a Blob, the browser downloads it through a temporary
 * anchor, and the file stays in a small in-memory "Recent exports" list so it can be downloaded
 * again (e.g. when the browser blocked an automatic download) without re-rendering.
 */

export interface ExportedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  blob: Blob;
  createdAt: string;
  /** What produced it, e.g. "Stems.zip · 7 stems · 24-bit". */
  detail?: string;
}

interface ExportFilesState {
  files: ExportedFile[];
}

/** Keep at most this many recent files (and this many bytes) in memory. */
const MAX_FILES = 12;
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

export const useExportFiles = create<ExportFilesState>(() => ({ files: [] }));

let seq = 0;

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

/** File-system-safe name: no path separators/reserved characters, collapsed whitespace, ≤ 80 chars. */
export function sanitizeFileName(name: string, fallback = 'Song'): string {
  const cleaned = (name ?? '')
    .normalize('NFC')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  if (!cleaned || reserved.test(cleaned)) return fallback;
  return cleaned;
}

/** Base name for files exported from a song ("Paper Lanterns"). */
export function songFileBase(song: Pick<Song, 'title'> | null | undefined, fallback = 'Song'): string {
  return sanitizeFileName(song?.title ?? '', fallback);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Trigger a browser download of a stored export. */
export function downloadFile(file: Pick<ExportedFile, 'blob' | 'name'>): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start reading the blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Store bytes as a recent export and (by default) download them immediately.
 * Strings are encoded as UTF-8.
 */
export function deliverFile(
  name: string,
  data: Uint8Array | string,
  mime: string,
  opts: { download?: boolean; detail?: string } = {},
): ExportedFile {
  const part: BlobPart = typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>);
  const blob = new Blob([part], { type: mime });
  const file: ExportedFile = {
    id: `exp_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    name,
    size: blob.size,
    mime,
    blob,
    createdAt: new Date().toISOString(),
    detail: opts.detail,
  };
  const files = [file, ...useExportFiles.getState().files];
  // Trim by count and total size (newest first).
  let total = 0;
  const kept: ExportedFile[] = [];
  for (const f of files) {
    if (kept.length >= MAX_FILES) break;
    if (kept.length > 0 && total + f.size > MAX_BYTES) continue;
    total += f.size;
    kept.push(f);
  }
  useExportFiles.setState({ files: kept });
  if (opts.download !== false) downloadFile(file);
  return file;
}

export function removeExportedFile(id: string): void {
  useExportFiles.setState({ files: useExportFiles.getState().files.filter((f) => f.id !== id) });
}

export function clearExportedFiles(): void {
  useExportFiles.setState({ files: [] });
}

export const MIME = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  zip: 'application/zip',
  midi: 'audio/midi',
  musicxml: 'application/vnd.recordare.musicxml+xml',
  pdf: 'application/pdf',
  text: 'text/plain;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  songproject: 'application/zip',
  dawproject: 'application/zip',
  rpp: 'text/plain;charset=utf-8',
} as const;
