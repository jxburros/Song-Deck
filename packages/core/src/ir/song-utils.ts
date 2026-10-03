import type { ChannelStrip, Id, Note, Song, Track } from './types';
import { defaultChannelStrip } from './defaults';

/** Deep clone (songs are plain JSON data). */
export function cloneSong<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sortNotes(notes: Note[]): Note[] {
  return notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch || a.id.localeCompare(b.id));
}

/** Resolve a track reference: id, exact name, case-insensitive name, then role. */
export function findTrack(song: Pick<Song, 'tracks'>, ref: string): Track | undefined {
  const r = ref.trim();
  return (
    song.tracks.find((t) => t.id === r) ??
    song.tracks.find((t) => t.name === r) ??
    song.tracks.find((t) => t.name.toLowerCase() === r.toLowerCase()) ??
    song.tracks.find((t) => t.role === r) ??
    song.tracks.find((t) => t.instrumentId === r) ??
    song.tracks.find((t) => t.name.toLowerCase().includes(r.toLowerCase()))
  );
}

export function getTrack(song: Pick<Song, 'tracks'>, id: Id): Track | undefined {
  return song.tracks.find((t) => t.id === id);
}

export function channelFor(song: Pick<Song, 'mixer'>, trackId: Id): ChannelStrip {
  return song.mixer.channels[trackId] ?? defaultChannelStrip();
}

export function notesInRange(track: Track, startTick: number, endTick: number): Note[] {
  return track.notes.filter((n) => n.tick >= startTick && n.tick < endTick);
}

/** Stable JSON stringify with sorted keys — for hashing/determinism checks. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a hash of a song's musical content (for reproducibility tests and change detection). */
export function songHash(song: Song): string {
  const s = stableStringify(song);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
