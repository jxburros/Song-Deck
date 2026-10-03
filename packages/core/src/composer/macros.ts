/**
 * Non-regenerating macro controls (spec §19): Humanization (Mechanical ↔ Loose) and Dynamics
 * (Flat ↔ Expressive) reshape existing notes deterministically instead of re-composing them.
 * All macro values are stored (song-wide or on one track) so later regenerations use them.
 *
 * Raising humanization adds per-note timing/velocity jitter proportional to the increase; lowering
 * it pulls notes back toward the grid. Dynamics expands or compresses velocities around each
 * section's mean and adds crescendos through rising sections. Locked notes never move.
 */
import type { MacroSettings, Note, Song, Track } from '../ir/types';
import { PPQ } from '../ir/types';
import { cloneSong, sortNotes } from '../ir/song-utils';
import { LockKeys, isLocked, isNoteLocked } from '../locks';
import { deriveRng, hashSeed } from '../util/random';
import { sectionLayout, tickToBar } from '../timing';
import { getInstrument } from './instruments';
import { clamp, clamp01, effectiveMacros, resolveSamePitchOverlaps, toVelocity } from './util';

function nearestGrid(tick: number, barStart: number): number {
  const rel = tick - barStart;
  const grids = [PPQ / 4, PPQ / 3];
  let best = tick;
  let bestD = Infinity;
  for (const g of grids) {
    const q = barStart + Math.round(rel / g) * g;
    const d = Math.abs(q - tick);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return bestD <= PPQ / 8 ? best : tick;
}

function transformTrack(song: Song, track: Track, before: MacroSettings, after: MacroSettings, seed: number): void {
  const spans = sectionLayout(song);
  const inst = getInstrument(track.instrumentId);
  const maxTicks = inst.isDrumKit ? 8 : inst.family === 'synth' ? 3 : 12;
  const dh = after.humanization - before.humanization;
  const dd = after.dynamics - before.dynamics;
  if (Math.abs(dh) < 1e-6 && Math.abs(dd) < 1e-6) return;
  const factor = (0.4 + after.dynamics * 1.2) / (0.4 + before.dynamics * 1.2);
  const notes: Note[] = [];
  for (const span of spans) {
    const inSpan = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
    const free = inSpan.filter((n) => !isNoteLocked(song, track, n));
    const mean = free.length ? free.reduce((t, n) => t + n.velocity, 0) / free.length : 80;
    const rising = (span.section.energyEnd ?? span.section.energy) > span.section.energy + 5;
    const len = Math.max(1, span.endTick - span.startTick);
    for (const n of inSpan) {
      if (!free.includes(n)) {
        notes.push(n);
        continue;
      }
      const out: Note = { ...n };
      const r = deriveRng(seed, 'macro', track.id, n.id);
      // Timing.
      if (dh > 0) {
        const dt = Math.round(clamp(r.gaussian(0, 0.5), -1, 1) * dh * maxTicks);
        const t = clamp(n.tick + dt, span.startTick, span.endTick - 1);
        out.duration = Math.max(1, n.duration - (t - n.tick));
        out.tick = t;
        out.velocity = toVelocity(out.velocity + Math.round(clamp(r.gaussian(0, 0.5), -1, 1) * dh * 10));
      } else if (dh < 0) {
        const strength = clamp01(-dh / Math.max(0.05, before.humanization));
        const barStart = n.tick - tickToBar(song, n.tick).tickInBar;
        const q = nearestGrid(n.tick, barStart);
        const t = clamp(Math.round(n.tick + (q - n.tick) * strength), span.startTick, span.endTick - 1);
        out.duration = Math.max(1, n.duration - (t - n.tick));
        out.tick = t;
        out.velocity = toVelocity(out.velocity + (mean - out.velocity) * strength * 0.3);
      }
      // Dynamics: expand/compress around the section mean, crescendo through rising sections.
      if (Math.abs(dd) > 1e-6) {
        let v = mean + (out.velocity - mean) * factor;
        if (rising && dd > 0) v += ((n.tick - span.startTick) / len) * 14 * dd;
        out.velocity = toVelocity(v);
      }
      notes.push(out);
    }
  }
  const outside = track.notes.filter((n) => !spans.some((s) => n.tick >= s.startTick && n.tick < s.endTick));
  let all = sortNotes([...outside, ...notes]);
  if (inst.polyphony === 'mono' && !inst.isDrumKit) {
    // Jitter must not make a single line overlap or reorder: free notes yield to their neighbours.
    const original = new Map(track.notes.map((n) => [n.id, n]));
    const free = (n: Note) => !isNoteLocked(song, track, original.get(n.id) ?? n);
    all = all.map((n) => ({ ...n }));
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      if (cur.tick <= prev.tick && free(cur)) {
        const shift = prev.tick + 1 - cur.tick;
        cur.tick += shift;
        cur.duration = Math.max(1, cur.duration - shift);
      }
      if (prev.tick + prev.duration > cur.tick) {
        if (free(prev)) prev.duration = Math.max(1, cur.tick - prev.tick);
        else if (free(cur)) {
          const shift = prev.tick + prev.duration - cur.tick;
          cur.tick += shift;
          cur.duration = Math.max(1, cur.duration - shift);
        }
      }
    }
    all = sortNotes(all);
  }
  // Jitter must not create same-pitch overlaps either (drums, chords); locked notes never move.
  const original = new Map(track.notes.map((n) => [n.id, n]));
  track.notes = resolveSamePitchOverlaps(all, (n) => isNoteLocked(song, track, original.get(n.id) ?? n), 'shift', spans.length ? spans[spans.length - 1].endTick : Infinity);
}

/**
 * Apply macro settings without regenerating: humanization and dynamics transform existing notes;
 * every given macro is stored (on the track when `trackId` is set, otherwise song-wide).
 */
export function applyMacroTransforms(song: Song, macros: Partial<MacroSettings>, trackId?: string): Song {
  const next = cloneSong(song);
  const clean: Partial<MacroSettings> = {};
  for (const [k, v] of Object.entries(macros) as [keyof MacroSettings, number][]) if (Number.isFinite(v)) clean[k] = clamp01(v);
  const seed = hashSeed(next.generation?.seed ?? 1, 'macros');
  const targets = trackId ? next.tracks.filter((t) => t.id === trackId) : next.tracks;
  const befores = new Map(targets.map((t) => [t.id, effectiveMacros(next, t)]));
  if (trackId) {
    for (const t of targets) {
      if (isLocked(next.locks, LockKeys.track(t.id))) continue;
      t.macros = { ...(t.macros ?? {}), ...clean };
    }
  } else {
    next.macros = { ...next.macros, ...clean };
  }
  for (const t of targets) {
    if (t.kind !== 'midi' || isLocked(next.locks, LockKeys.track(t.id))) continue;
    transformTrack(next, t, befores.get(t.id)!, effectiveMacros(next, t), seed);
  }
  return next;
}
