import type { KeyEvent, KeySignature, MeterEvent, Note, Section, Song, TempoEvent } from '../ir/types';
import { barLengthTicks, barToTick, bpmAtTick, keyAtBar, meterAtBar, songLengthBars, tickToBar } from '../timing';
import type { IdAllocator } from './util';

/**
 * Generic structure-edit engine.
 *
 * A structure edit is described as the new sequence of bars, built from segments:
 *   - `old`   — bars [startBar, endBar) of the current song move here (material keeps its ids),
 *   - `copy`  — material of bars [startBar, endBar) is duplicated here (new ids, looped to fill `bars`),
 *   - `empty` — `bars` new empty bars that take meter/key/tempo from `contextBar`.
 * Old bars not covered by an `old` segment are deleted together with their material; material
 * past the last section always follows the new last section. Notes/chords that would sound
 * across a cut (a point where the new bar sequence stops being contiguous in the old song) are
 * trimmed at the cut. Meter, key and tempo maps are rebuilt so every bar keeps the meter, key
 * and tempo it had before. Segments are handled run-length (never bar by bar), so extreme
 * positions cannot blow up memory.
 */
export type Segment =
  | { kind: 'old'; startBar: number; endBar: number }
  | { kind: 'copy'; startBar: number; endBar: number; bars: number }
  | { kind: 'empty'; bars: number; contextBar: number };

export interface RestructureOptions {
  ids: IdAllocator;
  /** Old section id → new section id, for phrases copied by `copy` segments. */
  copySectionIds?: Map<string, string>;
  /** Old lyric line id → copied lyric line id (notes copied by `copy` segments are re-pointed). */
  copyLyricLineIds?: Map<string, string>;
}

export interface RestructureStats {
  droppedNotes: number;
  droppedChords: number;
  droppedClips: number;
  trimmedNotes: number;
}

interface Run {
  kind: 'old' | 'copy' | 'empty';
  /** New bar range [ns, ne). */
  ns: number;
  ne: number;
  /** Old source bars [srcStart, srcEnd) (old/copy). */
  srcStart: number;
  srcEnd: number;
  /** Loop length for copies. */
  len: number;
  contextBar: number;
  /** `old` runs move material; repeated old ranges and copies duplicate it. */
  move: boolean;
}

interface Target {
  newBar: number;
  mode: 'move' | 'copy';
}

export function restructure(song: Song, segments: Segment[], sections: Section[], opts: RestructureOptions): { song: Song; stats: RestructureStats } {
  const stats: RestructureStats = { droppedNotes: 0, droppedChords: 0, droppedClips: 0, trimmedNotes: 0 };
  const oldLen = songLengthBars(song);

  // ---- runs ------------------------------------------------------------------------------
  const runs: Run[] = [];
  const moved: [number, number][] = [];
  let nb = 0;
  for (const seg of segments) {
    if (seg.kind === 'old') {
      const a = Math.max(0, seg.startBar);
      const b = Math.max(a, seg.endBar);
      if (b === a) continue;
      const overlaps = moved.some(([x, y]) => a < y && x < b);
      runs.push({ kind: 'old', ns: nb, ne: nb + (b - a), srcStart: a, srcEnd: b, len: b - a, contextBar: a, move: !overlaps });
      if (!overlaps) moved.push([a, b]);
      nb += b - a;
    } else if (seg.kind === 'copy') {
      const len = Math.max(0, seg.endBar - seg.startBar);
      const bars = Math.max(0, seg.bars);
      if (!bars) continue;
      if (!len) runs.push({ kind: 'empty', ns: nb, ne: nb + bars, srcStart: 0, srcEnd: 0, len: 0, contextBar: Math.max(0, seg.startBar), move: false });
      else runs.push({ kind: 'copy', ns: nb, ne: nb + bars, srcStart: seg.startBar, srcEnd: seg.endBar, len, contextBar: seg.startBar, move: false });
      nb += bars;
    } else if (seg.bars > 0) {
      runs.push({ kind: 'empty', ns: nb, ne: nb + seg.bars, srcStart: 0, srcEnd: 0, len: 0, contextBar: Math.max(0, seg.contextBar), move: false });
      nb += seg.bars;
    }
  }
  const newLen = nb;
  // Material past the old last section follows the new last section (unbounded tail).
  const tail: Run = { kind: 'old', ns: newLen, ne: Infinity, srcStart: oldLen, srcEnd: Infinity, len: Infinity, contextBar: oldLen, move: true };
  runs.push(tail);
  const hasTail = hasMaterialFrom(song, barToTick(song, oldLen));

  const runAtNew = (bar: number): Run | undefined => runs.find((r) => bar >= r.ns && bar < r.ne);
  const sourceOf = (bar: number): { old: number | null; meter: number } => {
    const r = runAtNew(bar);
    if (!r || r.kind === 'empty') return { old: null, meter: r?.contextBar ?? Math.max(0, oldLen - 1) };
    const old = r.kind === 'old' ? r.srcStart + (bar - r.ns) : r.srcStart + ((bar - r.ns) % r.len);
    return { old, meter: old };
  };
  const targetsFor = (oldBar: number): Target[] => {
    const out: Target[] = [];
    for (const r of runs) {
      if (r.kind === 'empty' || oldBar < r.srcStart || oldBar >= r.srcEnd) continue;
      const off = oldBar - r.srcStart;
      if (r.kind === 'old') out.push({ newBar: r.ns + off, mode: r.move ? 'move' : 'copy' });
      else for (let b = r.ns + off; b < r.ne; b += r.len) out.push({ newBar: b, mode: 'copy' });
    }
    return out;
  };

  // ---- meter & key maps ---------------------------------------------------------------------
  const sortedMeters = [...song.meterMap].sort((a, b) => a.bar - b.bar);
  const sortedKeys = [...song.keyMap].sort((a, b) => a.bar - b.bar);
  const meterEvents: MeterEvent[] = [];
  const keyEvents: KeyEvent[] = [];
  const pushMeterAndKey = (newBar: number, oldBar: number) => {
    const m = meterAtBar(song, oldBar);
    meterEvents.push({ bar: newBar, numerator: m.numerator, denominator: m.denominator });
    keyEvents.push({ bar: newBar, key: { ...keyAtBar(song, oldBar) } });
  };
  const pushInnerEvents = (start: number, srcStart: number, srcEnd: number, limit: number) => {
    for (const m of sortedMeters) {
      if (m.bar <= srcStart || m.bar >= srcEnd) continue;
      const bar = start + (m.bar - srcStart);
      if (bar < limit) meterEvents.push({ bar, numerator: m.numerator, denominator: m.denominator });
    }
    for (const k of sortedKeys) {
      if (k.bar <= srcStart || k.bar >= srcEnd) continue;
      const bar = start + (k.bar - srcStart);
      if (bar < limit) keyEvents.push({ bar, key: { ...k.key } });
    }
  };
  const loopStarts = (r: Run): number[] => {
    const out: number[] = [];
    for (let s = r.ns; s < r.ne; s += r.len) out.push(s);
    return out;
  };
  for (const r of runs) {
    if (r === tail && !hasTail) continue;
    if (r.kind === 'empty') pushMeterAndKey(r.ns, r.contextBar);
    else if (r.kind === 'old') {
      pushMeterAndKey(r.ns, r.srcStart);
      pushInnerEvents(r.ns, r.srcStart, r.srcEnd, r.ne);
    } else {
      for (const s of loopStarts(r)) {
        pushMeterAndKey(s, r.srcStart);
        pushInnerEvents(s, r.srcStart, r.srcEnd, r.ne);
      }
    }
  }
  const meterMap = compressBarEvents(meterEvents, (a, b) => a.numerator === b.numerator && a.denominator === b.denominator);
  const keyMap = compressBarEvents(keyEvents, (a, b) => sameKey(a.key, b.key));
  if (!meterMap.length || meterMap[0].bar !== 0) {
    const m = meterAtBar(song, 0);
    meterMap.unshift({ bar: 0, numerator: m.numerator, denominator: m.denominator });
  }
  if (!keyMap.length || keyMap[0].bar !== 0) keyMap.unshift({ bar: 0, key: { ...keyAtBar(song, 0) } });

  const nt = { ppq: song.ppq, meterMap, tempoMap: song.tempoMap };
  const newStart = (bar: number) => barToTick(nt, bar);
  const oldStart = (bar: number) => barToTick(song, bar);

  /** New end tick for an extent starting in old bar `oldBar` placed at `newBar` (cut where contiguity breaks). */
  const contiguousEnd = (oldBar: number, newBar: number, oldEndTick: number): number => {
    let curOld = oldBar;
    let curNew = newBar;
    for (let guard = 0; guard < 256; guard++) {
      const r = runAtNew(curNew);
      if (!r) return newStart(curNew);
      const runEndNew = r.kind === 'copy' ? Math.min(r.ne, r.ns + (Math.floor((curNew - r.ns) / r.len) + 1) * r.len) : r.ne;
      const runEndOld = runEndNew === Infinity ? Infinity : curOld + (runEndNew - curNew);
      if (runEndOld === Infinity || oldEndTick <= oldStart(runEndOld)) return newStart(curNew) + (oldEndTick - oldStart(curOld));
      const next = sourceOf(runEndNew);
      if (next.old !== runEndOld) return newStart(runEndNew);
      curOld = runEndOld;
      curNew = runEndNew;
    }
    return newStart(curNew);
  };

  const lyricMap = opts.copyLyricLineIds;
  const out: Song = { ...song, sections, meterMap, keyMap };

  // ---- notes & clips -----------------------------------------------------------------------
  out.tracks = song.tracks.map((track) => {
    const notes: Note[] = [];
    for (const n of track.notes) {
      const pos = tickToBar(song, n.tick);
      const targets = targetsFor(pos.bar);
      if (!targets.length) {
        stats.droppedNotes++;
        continue;
      }
      for (const tg of targets) {
        const start = newStart(tg.newBar) + pos.tickInBar;
        const end = contiguousEnd(pos.bar, tg.newBar, n.tick + n.duration);
        const duration = Math.max(1, end - start);
        if (duration < n.duration) stats.trimmedNotes++;
        if (tg.mode === 'move') {
          notes.push(start === n.tick && duration === n.duration ? n : { ...n, tick: start, duration });
        } else {
          const copy: Note = { ...n, id: opts.ids.next('n'), tick: start, duration };
          delete copy.locked;
          if (copy.lyricLineId && lyricMap?.has(copy.lyricLineId)) copy.lyricLineId = lyricMap.get(copy.lyricLineId);
          notes.push(copy);
        }
      }
    }
    notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch || a.id.localeCompare(b.id));
    const clips = [];
    for (const c of track.clips) {
      const pos = tickToBar(song, c.tick);
      const mv = targetsFor(pos.bar).find((p) => p.mode === 'move');
      if (!mv) {
        stats.droppedClips++;
        continue;
      }
      clips.push({ ...c, tick: newStart(mv.newBar) + pos.tickInBar });
    }
    return { ...track, notes, clips };
  });

  // ---- chords ------------------------------------------------------------------------------
  const chords = [];
  for (const c of song.chords) {
    const pos = tickToBar(song, c.tick);
    const targets = targetsFor(pos.bar);
    if (!targets.length) {
      stats.droppedChords++;
      continue;
    }
    for (const tg of targets) {
      const start = newStart(tg.newBar) + pos.tickInBar;
      const end = contiguousEnd(pos.bar, tg.newBar, c.tick + c.duration);
      chords.push({ ...c, id: tg.mode === 'move' ? c.id : opts.ids.next('ch'), tick: start, duration: Math.max(1, end - start) });
    }
  }
  chords.sort((a, b) => a.tick - b.tick);
  out.chords = chords;

  // ---- tempo -------------------------------------------------------------------------------
  const tempos: TempoEvent[] = [];
  for (const r of runs) {
    if (r === tail && !hasTail) continue;
    const starts = r.kind === 'copy' ? loopStarts(r) : [r.ns];
    const src = r.kind === 'empty' ? r.contextBar : r.srcStart;
    for (const s of starts) tempos.push({ tick: newStart(s), bpm: bpmAtTick(song, oldStart(src)) });
  }
  for (const t of song.tempoMap) {
    const pos = tickToBar(song, t.tick);
    for (const tg of targetsFor(pos.bar)) tempos.push({ tick: newStart(tg.newBar) + pos.tickInBar, bpm: t.bpm });
  }
  out.tempoMap = compressTempo(tempos, song);

  // ---- automation --------------------------------------------------------------------------
  out.automation = song.automation.map((lane) => {
    const points = [];
    for (const p of lane.points) {
      const pos = tickToBar(song, p.tick);
      for (const tg of targetsFor(pos.bar)) points.push({ ...p, tick: newStart(tg.newBar) + pos.tickInBar });
    }
    points.sort((a, b) => a.tick - b.tick);
    return { ...lane, points };
  });

  // ---- phrases -----------------------------------------------------------------------------
  const phrases = [];
  for (const ph of song.phrases) {
    const pos = tickToBar(song, ph.startTick);
    for (const tg of targetsFor(pos.bar)) {
      const start = newStart(tg.newBar) + pos.tickInBar;
      const end = contiguousEnd(pos.bar, tg.newBar, ph.endTick);
      if (tg.mode === 'move') phrases.push({ ...ph, startTick: start, endTick: Math.max(start, end) });
      else {
        const copy = { ...ph, id: opts.ids.next('ph'), startTick: start, endTick: Math.max(start, end) };
        if (copy.sectionId && opts.copySectionIds?.has(copy.sectionId)) copy.sectionId = opts.copySectionIds.get(copy.sectionId);
        if (copy.lyricLineId && lyricMap?.has(copy.lyricLineId)) copy.lyricLineId = lyricMap.get(copy.lyricLineId);
        phrases.push(copy);
      }
    }
  }
  out.phrases = phrases;

  // ---- vocal renders (kept only when they move intact) ------------------------------------------
  if (song.vocals?.renders?.length) {
    const renders = [];
    for (const r of song.vocals.renders) {
      const pos = tickToBar(song, r.startTick);
      const mv = targetsFor(pos.bar).find((p) => p.mode === 'move');
      if (!mv) continue;
      const start = newStart(mv.newBar) + pos.tickInBar;
      const end = contiguousEnd(pos.bar, mv.newBar, r.endTick);
      if (end - start !== r.endTick - r.startTick) continue;
      renders.push({ ...r, startTick: start, endTick: end });
    }
    out.vocals = { ...song.vocals, renders };
  }
  return { song: out, stats };
}

/** Whether any material (notes, clips, chords, automation, tempo changes) starts at or after `tick`. */
function hasMaterialFrom(song: Song, tick: number): boolean {
  if (song.chords.some((c) => c.tick >= tick)) return true;
  if (song.tempoMap.some((t) => t.tick >= tick && t.tick > 0)) return true;
  if (song.automation.some((l) => l.points.some((p) => p.tick >= tick))) return true;
  return song.tracks.some((t) => t.notes.some((n) => n.tick >= tick) || t.clips.some((c) => c.tick >= tick));
}

function sameKey(a: KeySignature, b: KeySignature): boolean {
  return a.tonic === b.tonic && a.mode === b.mode;
}

/** Sort bar events (stable), keep the last event per bar, drop events equal to their predecessor. */
function compressBarEvents<T extends { bar: number }>(events: T[], same: (a: T, b: T) => boolean): T[] {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.bar - b.e.bar || a.i - b.i).map((x) => x.e);
  const byBar: T[] = [];
  for (const e of sorted) {
    if (byBar.length && byBar[byBar.length - 1].bar === e.bar) byBar[byBar.length - 1] = e;
    else byBar.push(e);
  }
  const out: T[] = [];
  for (const e of byBar) {
    if (out.length && same(out[out.length - 1], e)) continue;
    out.push(e);
  }
  return out;
}

function compressTempo(events: TempoEvent[], song: Song): TempoEvent[] {
  const sorted = events
    .filter((e) => Number.isFinite(e.tick) && Number.isFinite(e.bpm) && e.bpm > 0)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.tick - b.e.tick || a.i - b.i)
    .map((x) => x.e);
  const byTick: TempoEvent[] = [];
  for (const e of sorted) {
    const last = byTick[byTick.length - 1];
    if (last && last.tick === e.tick) byTick[byTick.length - 1] = { tick: e.tick, bpm: e.bpm };
    else byTick.push({ tick: e.tick, bpm: e.bpm });
  }
  const out: TempoEvent[] = [];
  for (const e of byTick) {
    const last = out[out.length - 1];
    if (last && last.bpm === e.bpm) continue;
    out.push(e);
  }
  if (!out.length || out[0].tick !== 0) out.unshift({ tick: 0, bpm: out[0]?.bpm ?? bpmAtTick(song, 0) });
  return out;
}

/**
 * Re-bar the song for a new meter map: every item keeps its (bar, position-in-bar). Notes and
 * chords whose onset falls beyond the end of a (shorter) bar are dropped; other events are
 * clamped to the end of their bar.
 */
export function rebar(song: Song, meterMap: MeterEvent[]): { song: Song; droppedNotes: number; droppedChords: number } {
  const nt = { ppq: song.ppq, meterMap, tempoMap: song.tempoMap };
  let droppedNotes = 0;
  let droppedChords = 0;
  const barLenNew = new Map<number, number>();
  const lenOf = (bar: number) => {
    let v = barLenNew.get(bar);
    if (v === undefined) {
      v = barLengthTicks(meterAtBar(nt, bar), song.ppq);
      barLenNew.set(bar, v);
    }
    return v;
  };
  /** Map a position; returns null when beyond the new bar (and !clamp). */
  const map = (tick: number, clamp: boolean): number | null => {
    const p = tickToBar(song, tick);
    const len = lenOf(p.bar);
    if (p.tickInBar >= len) return clamp ? barToTick(nt, p.bar + 1) : null;
    return barToTick(nt, p.bar) + p.tickInBar;
  };
  const out: Song = { ...song, meterMap };
  out.tracks = song.tracks.map((t) => {
    const notes: Note[] = [];
    for (const n of t.notes) {
      const s = map(n.tick, false);
      if (s === null) {
        droppedNotes++;
        continue;
      }
      const e = map(n.tick + n.duration, true)!;
      notes.push({ ...n, tick: s, duration: Math.max(1, e - s) });
    }
    return { ...t, notes, clips: t.clips.map((c) => ({ ...c, tick: map(c.tick, true)! })) };
  });
  const chords = [];
  for (const c of song.chords) {
    const s = map(c.tick, false);
    if (s === null) {
      droppedChords++;
      continue;
    }
    const e = map(c.tick + c.duration, true)!;
    chords.push({ ...c, tick: s, duration: Math.max(1, e - s) });
  }
  chords.sort((a, b) => a.tick - b.tick);
  for (let i = 0; i + 1 < chords.length; i++) {
    const end = chords[i].tick + chords[i].duration;
    if (end > chords[i + 1].tick) chords[i].duration = Math.max(1, chords[i + 1].tick - chords[i].tick);
  }
  out.chords = chords;
  out.tempoMap = compressTempo(
    song.tempoMap.map((t) => ({ tick: map(t.tick, true)!, bpm: t.bpm })),
    song,
  );
  out.automation = song.automation.map((l) => ({ ...l, points: l.points.map((p) => ({ ...p, tick: map(p.tick, true)! })) }));
  out.phrases = song.phrases.map((p) => {
    const s = map(p.startTick, true)!;
    const e = map(p.endTick, true)!;
    return { ...p, startTick: s, endTick: Math.max(s, e) };
  });
  if (song.vocals?.renders?.length) {
    out.vocals = {
      ...song.vocals,
      renders: song.vocals.renders.map((r) => {
        const s = map(r.startTick, true)!;
        return { ...r, startTick: s, endTick: Math.max(s, map(r.endTick, true)!) };
      }),
    };
  }
  return { song: out, droppedNotes, droppedChords };
}
