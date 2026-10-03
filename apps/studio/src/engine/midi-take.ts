import { createTimeMap, isNoteLocked, quantizeTick, type Note, type Song, type Track } from '@songdeck/core';

/** A note played on a MIDI keyboard, timed in song seconds. */
export interface CapturedNote {
  pitch: number;
  velocity: number;
  start: number;
  end: number;
}

export interface TakeOptions {
  /** Grid (ticks) that note onsets snap to; 0 or 1 keeps the performed timing. */
  grid?: number;
  /** Quantize strength 0..1 (default 1). */
  strength?: number;
  /** Shortest note kept, in ticks (default a 64th note). */
  minTicks?: number;
}

export interface TakeResult {
  /** Notes to add, sorted by time. */
  notes: Note[];
  /** Notes dropped because they start in locked material (spec §22). */
  blocked: number;
}

/**
 * Turn a captured keyboard performance into notes on the song's tick grid (spec §27 "play an
 * instrument → MIDI"). Onsets snap to the grid with the given strength; performed lengths are
 * kept. Notes landing in locked material are dropped, never written.
 */
export function takeToNotes(song: Song, track: Track, take: CapturedNote[], newId: () => string, opts: TakeOptions = {}): TakeResult {
  const tm = createTimeMap(song);
  const grid = opts.grid ?? 0;
  const strength = Math.min(1, Math.max(0, opts.strength ?? 1));
  const minTicks = Math.max(1, opts.minTicks ?? Math.round(song.ppq / 16));
  const notes: Note[] = [];
  let blocked = 0;
  for (const c of take) {
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.pitch < 0 || c.pitch > 127) continue;
    const performed = Math.max(0, Math.round(tm.secondsToTick(Math.max(0, c.start))));
    const length = Math.round(tm.secondsToTick(Math.max(c.start, c.end))) - performed;
    const tick = grid > 1 ? Math.max(0, quantizeTick(performed, grid, strength)) : performed;
    const note: Note = {
      id: newId(),
      pitch: Math.round(c.pitch),
      tick,
      duration: Math.max(minTicks, length),
      velocity: Math.round(Math.min(127, Math.max(1, c.velocity))),
      origin: 'performance',
    };
    if (isNoteLocked(song, track, note)) {
      blocked++;
      continue;
    }
    notes.push(note);
  }
  notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  return { notes, blocked };
}
