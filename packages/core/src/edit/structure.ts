import type { KeyEvent, MeterEvent, Note, Section, Song, TempoEvent } from '../ir/types';
import { barLengthTicks, barToTick, bpmAtTick, keyAtBar, meterAtBar, songLengthBars, tickToBar } from '../timing';
import type { IdAllocator } from './util';

/**
 * Generic structure-edit engine.
 *
 * A structure edit is described as the new sequence of bars, built from segments:
 *   - `old`   — bars [startBar, endBar) of the current song move here (material keeps its ids),
 *   - `copy`  — material of bars [startBar, endBar) is duplicated here (new ids, looped to fill `bars`),
 *   - `empty` — `bars` new empty bars that take meter/key/tempo from `contextBar`.
 * Old bars not covered by an `old` segment are deleted together with their material.
 * Notes/chords that would sound across a cut (a point where the new bar sequence is no longer
 * contiguous in the old song) are trimmed at the cut. Meter, key and tempo maps are rebuilt so
 * every bar keeps the meter/key/tempo it had before.
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

interface NewBar {
  src: number | null;
  mode: 'move' | 'copy' | 'none';
  meterSrc: number;
  seg: number;
}

function lastMaterialBar(song: Song): number {
  let maxTick = 0;
  for (const t of song.tracks) {
    for (const n of t.notes) maxTick = Math.max(maxTick, n.tick + Math.max(1, n.duration));
    for (const c of t.clips) maxTick = Math.max(maxTick, c.tick + 1);
  }
  for (const c of song.chords) maxTick = Math.max(maxTick, c.tick + Math.max(1, c.duration));
  for (const l of song.automation) for (const p of l.points) maxTick = Math.max(maxTick, p.tick + 1);
  for (const t of song.tempoMap) maxTick = Math.max(maxTick, t.tick + 1);
  if (maxTick <= 0) return 0;
  return tickToBar(song, maxTick - 1).bar + 1;
}

export function restructure(song: Song, segments: Segment[], sections: Section[], opts: RestructureOptions): { song: Song; stats: RestructureStats } {
  const stats: RestructureStats = { droppedNotes: 0, droppedChords: 0, droppedClips: 0, trimmedNotes: 0 };
  const oldLen = songLengthBars(song);
  const segs = segments.slice();
  // Material past the last section stays past the (new) last section.
  const tailEnd = lastMaterialBar(song);
  if (tailEnd > oldLen) segs.push({ kind: 'old', startBar: oldLen, endBar: tailEnd });

  const bars: NewBar[] = [];
  const movedOld = new Set<number>();
  segs.forEach((seg, si) => {
    if (seg.kind === 'old') {
      for (let b = seg.startBar; b < seg.endBar; b++) {
        const mode = movedOld.has(b) ? 'copy' : 'move';
        movedOld.add(b);
        bars.push({ src: b, mode, meterSrc: b, seg: si });
      }
    } else if (seg.kind === 'copy') {
      const len = seg.endBar - seg.startBar;
      for (let i = 0; i < seg.bars; i++) {
        const b = len > 0 ? seg.startBar + (i % len) : null;
        bars.push({ src: b, mode: b === null ? 'none' : 'copy', meterSrc: b ?? Math.max(0, seg.startBar), seg: si });
      }
    } else {
      for (let i = 0; i < seg.bars; i++) bars.push({ src: null, mode: 'none', meterSrc: Math.max(0, seg.contextBar), seg: si });
    }
  });

  // --- meter & key maps ------------------------------------------------------
  const meterMap: MeterEvent[] = [];
  const keyMap: KeyEvent[] = [];
  bars.forEach((nb, i) => {
    const m = meterAtBar(song, nb.meterSrc);
    const lm = meterMap[meterMap.length - 1];
    if (!lm || lm.numerator !== m.numerator || lm.denominator !== m.denominator) meterMap.push({ bar: i, numerator: m.numerator, denominator: m.denominator });
    const k = keyAtBar(song, nb.meterSrc);
    const lk = keyMap[keyMap.length - 1];
    if (!lk || lk.key.tonic !== k.tonic || lk.key.mode !== k.mode) keyMap.push({ bar: i, key: { ...k } });
  });
  if (!meterMap.length) {
    const m = meterAtBar(song, 0);
    meterMap.push({ bar: 0, numerator: m.numerator, denominator: m.denominator });
  }
  if (!keyMap.length) keyMap.push({ bar: 0, key: { ...keyAtBar(song, 0) } });

  const nt = { ppq: song.ppq, meterMap, tempoMap: song.tempoMap };
  const newBarStart: number[] = [];
  for (let i = 0; i <= bars.length; i++) newBarStart.push(barToTick(nt, i));
  const oldBarStartCache = new Map<number, number>();
  const oldBarStart = (b: number) => {
    let v = oldBarStartCache.get(b);
    if (v === undefined) {
      v = barToTick(song, b);
      oldBarStartCache.set(b, v);
    }
    return v;
  };

  const placements = new Map<number, { newBar: number; mode: 'move' | 'copy' }[]>();
  bars.forEach((nb, i) => {
    if (nb.src === null || nb.mode === 'none') return;
    const list = placements.get(nb.src) ?? [];
    list.push({ newBar: i, mode: nb.mode });
    placements.set(nb.src, list);
  });

  /** New end tick for an extent starting in old bar `oldBar` placed at `newBar`. */
  const contiguousEnd = (oldBar: number, newBar: number, oldEndTick: number): number => {
    let k = oldBar;
    let nb = newBar;
    for (let guard = 0; guard < 100000; guard++) {
      const oldEndOfBar = oldBarStart(k + 1);
      if (oldEndTick <= oldEndOfBar) return newBarStart[nb] + (oldEndTick - oldBarStart(k));
      const next = bars[nb + 1];
      if (!next || next.src !== k + 1) return newBarStart[nb + 1] ?? newBarStart[nb] + barLengthTicks(meterAtBar(nt, nb), song.ppq);
      k++;
      nb++;
    }
    return newBarStart[nb];
  };

  const lyricMap = opts.copyLyricLineIds;
  const out: Song = { ...song, sections, meterMap, keyMap };

  // --- notes -------------------------------------------------------------------
  out.tracks = song.tracks.map((track) => {
    const notes: Note[] = [];
    for (const n of track.notes) {
      const pos = tickToBar(song, n.tick);
      const targets = placements.get(pos.bar);
      if (!targets) {
        stats.droppedNotes++;
        continue;
      }
      for (const tg of targets) {
        const start = newBarStart[tg.newBar] + pos.tickInBar;
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
      const mv = placements.get(pos.bar)?.find((p) => p.mode === 'move');
      if (!mv) {
        stats.droppedClips++;
        continue;
      }
      clips.push({ ...c, tick: newBarStart[mv.newBar] + pos.tickInBar });
    }
    return { ...track, notes, clips };
  });

  // --- chords ------------------------------------------------------------------
  const chords = [];
  for (const c of song.chords) {
    const pos = tickToBar(song, c.tick);
    const targets = placements.get(pos.bar);
    if (!targets) {
      stats.droppedChords++;
      continue;
    }
    for (const tg of targets) {
      const start = newBarStart[tg.newBar] + pos.tickInBar;
      const end = contiguousEnd(pos.bar, tg.newBar, c.tick + c.duration);
      chords.push({ ...c, id: tg.mode === 'move' ? c.id : opts.ids.next('ch'), tick: start, duration: Math.max(1, end - start) });
    }
  }
  chords.sort((a, b) => a.tick - b.tick);
  out.chords = chords;

  // --- tempo -------------------------------------------------------------------
  const tempos: TempoEvent[] = [];
  bars.forEach((nb, i) => {
    if (i > 0 && bars[i - 1].seg === nb.seg && bars[i - 1].src !== null && nb.src === bars[i - 1].src! + 1) return;
    tempos.push({ tick: newBarStart[i], bpm: bpmAtTick(song, oldBarStart(nb.meterSrc)) });
  });
  for (const t of song.tempoMap) {
    const pos = tickToBar(song, t.tick);
    for (const tg of placements.get(pos.bar) ?? []) tempos.push({ tick: newBarStart[tg.newBar] + pos.tickInBar, bpm: t.bpm });
  }
  out.tempoMap = compressTempo(tempos, song);

  // --- automation ----------------------------------------------------------------
  out.automation = song.automation.map((lane) => {
    const points = [];
    for (const p of lane.points) {
      const pos = tickToBar(song, p.tick);
      for (const tg of placements.get(pos.bar) ?? []) points.push({ ...p, tick: newBarStart[tg.newBar] + pos.tickInBar });
    }
    points.sort((a, b) => a.tick - b.tick);
    return { ...lane, points };
  });

  // --- phrases -------------------------------------------------------------------
  const phrases = [];
  for (const ph of song.phrases) {
    const pos = tickToBar(song, ph.startTick);
    for (const tg of placements.get(pos.bar) ?? []) {
      const start = newBarStart[tg.newBar] + pos.tickInBar;
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

  // --- vocal renders (kept only when they move intact) ------------------------------
  if (song.vocals?.renders?.length) {
    const renders = [];
    for (const r of song.vocals.renders) {
      const pos = tickToBar(song, r.startTick);
      const mv = placements.get(pos.bar)?.find((p) => p.mode === 'move');
      if (!mv) continue;
      const start = newBarStart[mv.newBar] + pos.tickInBar;
      const end = contiguousEnd(pos.bar, mv.newBar, r.endTick);
      if (end - start !== r.endTick - r.startTick) continue;
      renders.push({ ...r, startTick: start, endTick: end });
    }
    out.vocals = { ...song.vocals, renders };
  }
  return { song: out, stats };
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
