import type {
  ChordEvent,
  Id,
  KeySignature,
  MeterEvent,
  OpRegion,
  Section,
  Song,
  TempoEvent,
  Ticks,
} from './ir/types';

/**
 * Timing helpers: bars/beats ↔ ticks ↔ seconds.
 *
 * Internal bars and beats are 0-based. `musicalToTick` / `tickToMusical` use the
 * 1-based convention of structured AI operations and the UI.
 */

type TimingSource = Pick<Song, 'ppq' | 'meterMap' | 'tempoMap'> & Partial<Pick<Song, 'sections' | 'keyMap' | 'chords'>>;

export interface SectionSpan {
  section: Section;
  index: number;
  /** 0-based first bar. */
  startBar: number;
  /** 0-based bar after the last bar (exclusive). */
  endBar: number;
  startTick: Ticks;
  endTick: Ticks;
}

const DEFAULT_METER: MeterEvent = { bar: 0, numerator: 4, denominator: 4 };

export function ticksPerBeat(denominator: number, ppq: number): number {
  return (ppq * 4) / denominator;
}

export function barLengthTicks(meter: { numerator: number; denominator: number }, ppq: number): number {
  return meter.numerator * ticksPerBeat(meter.denominator, ppq);
}

function sortedMeters(song: TimingSource): MeterEvent[] {
  const m = song.meterMap.length ? [...song.meterMap].sort((a, b) => a.bar - b.bar) : [DEFAULT_METER];
  if (m[0].bar !== 0) m.unshift({ ...m[0], bar: 0 });
  return m;
}

function sortedTempos(song: TimingSource): TempoEvent[] {
  const t = song.tempoMap.length ? [...song.tempoMap].sort((a, b) => a.tick - b.tick) : [{ tick: 0, bpm: 120 }];
  if (t[0].tick !== 0) t.unshift({ tick: 0, bpm: t[0].bpm });
  return t;
}

export function meterAtBar(song: TimingSource, bar: number): MeterEvent {
  const meters = sortedMeters(song);
  let cur = meters[0];
  for (const m of meters) {
    if (m.bar <= bar) cur = m;
    else break;
  }
  return cur;
}

/** Absolute tick at the start of 0-based `bar` (bar may exceed the song; meter continues). */
export function barToTick(song: TimingSource, bar: number): Ticks {
  const meters = sortedMeters(song);
  let tick = 0;
  for (let i = 0; i < meters.length; i++) {
    const m = meters[i];
    const nextBar = i + 1 < meters.length ? meters[i + 1].bar : Infinity;
    if (bar <= m.bar) break;
    const barsInSeg = Math.min(bar, nextBar) - m.bar;
    tick += barsInSeg * barLengthTicks(m, song.ppq);
    if (bar <= nextBar) break;
  }
  return Math.round(tick);
}

export interface BarPosition {
  /** 0-based bar. */
  bar: number;
  /** 0-based beat within the bar (fractional). */
  beat: number;
  tickInBar: Ticks;
  meter: MeterEvent;
}

export function tickToBar(song: TimingSource, tick: Ticks): BarPosition {
  const meters = sortedMeters(song);
  let segStartTick = 0;
  for (let i = 0; i < meters.length; i++) {
    const m = meters[i];
    const barLen = barLengthTicks(m, song.ppq);
    const nextBar = i + 1 < meters.length ? meters[i + 1].bar : Infinity;
    const segTicks = (nextBar - m.bar) * barLen;
    if (tick < segStartTick + segTicks || nextBar === Infinity) {
      const rel = Math.max(0, tick - segStartTick);
      const barsIn = Math.floor(rel / barLen);
      const tickInBar = rel - barsIn * barLen;
      return {
        bar: m.bar + barsIn,
        beat: tickInBar / ticksPerBeat(m.denominator, song.ppq),
        tickInBar,
        meter: m,
      };
    }
    segStartTick += segTicks;
  }
  return { bar: 0, beat: 0, tickInBar: 0, meter: meters[0] };
}

/** 0-based bar + 0-based fractional beat → tick. */
export function barBeatToTick(song: TimingSource, bar: number, beat: number): Ticks {
  const m = meterAtBar(song, bar);
  return Math.round(barToTick(song, bar) + beat * ticksPerBeat(m.denominator, song.ppq));
}

/** 1-based bar + 1-based fractional beat (AI operation / UI convention) → tick. */
export function musicalToTick(song: TimingSource, bar1: number, beat1: number): Ticks {
  return barBeatToTick(song, bar1 - 1, beat1 - 1);
}

/** Tick → 1-based bar and beat. */
export function tickToMusical(song: TimingSource, tick: Ticks): { bar: number; beat: number } {
  const p = tickToBar(song, tick);
  return { bar: p.bar + 1, beat: p.beat + 1 };
}

/** Beats (in the meter's beat unit at `atTick`) → ticks. */
export function beatsToTicks(song: TimingSource, beats: number, atTick: Ticks = 0): Ticks {
  const m = tickToBar(song, atTick).meter;
  return Math.round(beats * ticksPerBeat(m.denominator, song.ppq));
}

export function ticksToBeats(song: TimingSource, ticks: Ticks, atTick: Ticks = 0): number {
  const m = tickToBar(song, atTick).meter;
  return ticks / ticksPerBeat(m.denominator, song.ppq);
}

/** Inclusive 1-based region → [startTick, endTick). */
export function regionToTicks(song: TimingSource, region: OpRegion): { startTick: Ticks; endTick: Ticks } {
  const start = Math.max(1, Math.floor(region.start_bar));
  const end = Math.max(start, Math.floor(region.end_bar));
  return { startTick: barToTick(song, start - 1), endTick: barToTick(song, end) };
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

export function bpmAtTick(song: TimingSource, tick: Ticks): number {
  let bpm = sortedTempos(song)[0].bpm;
  for (const t of sortedTempos(song)) {
    if (t.tick <= tick) bpm = t.bpm;
    else break;
  }
  return bpm;
}

export interface TimeMap {
  tickToSeconds(tick: Ticks): number;
  secondsToTick(seconds: number): Ticks;
  bpmAt(tick: Ticks): number;
}

/** Precomputed tempo map — use in hot loops (audio rendering). */
export function createTimeMap(song: TimingSource): TimeMap {
  const tempos = sortedTempos(song);
  const ppq = song.ppq;
  const segStartSec: number[] = [];
  let acc = 0;
  for (let i = 0; i < tempos.length; i++) {
    segStartSec.push(acc);
    if (i + 1 < tempos.length) acc += ((tempos[i + 1].tick - tempos[i].tick) / ppq) * (60 / tempos[i].bpm);
  }
  return {
    tickToSeconds(tick) {
      let i = tempos.length - 1;
      while (i > 0 && tempos[i].tick > tick) i--;
      return segStartSec[i] + ((tick - tempos[i].tick) / ppq) * (60 / tempos[i].bpm);
    },
    secondsToTick(seconds) {
      let i = tempos.length - 1;
      while (i > 0 && segStartSec[i] > seconds) i--;
      return tempos[i].tick + ((seconds - segStartSec[i]) * tempos[i].bpm * ppq) / 60;
    },
    bpmAt(tick) {
      let i = tempos.length - 1;
      while (i > 0 && tempos[i].tick > tick) i--;
      return tempos[i].bpm;
    },
  };
}

export function tickToSeconds(song: TimingSource, tick: Ticks): number {
  return createTimeMap(song).tickToSeconds(tick);
}

export function secondsToTick(song: TimingSource, seconds: number): Ticks {
  return createTimeMap(song).secondsToTick(seconds);
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export function sectionLayout(song: TimingSource & Pick<Song, 'sections'>): SectionSpan[] {
  const spans: SectionSpan[] = [];
  let bar = 0;
  song.sections.forEach((section, index) => {
    const startBar = bar;
    const endBar = bar + Math.max(0, section.bars);
    spans.push({
      section,
      index,
      startBar,
      endBar,
      startTick: barToTick(song, startBar),
      endTick: barToTick(song, endBar),
    });
    bar = endBar;
  });
  return spans;
}

export function songLengthBars(song: Pick<Song, 'sections'>): number {
  return song.sections.reduce((n, s) => n + Math.max(0, s.bars), 0);
}

export function songLengthTicks(song: TimingSource & Pick<Song, 'sections'>): Ticks {
  return barToTick(song, songLengthBars(song));
}

export function songDurationSeconds(song: TimingSource & Pick<Song, 'sections'>): number {
  return tickToSeconds(song, songLengthTicks(song));
}

export function sectionSpanById(song: TimingSource & Pick<Song, 'sections'>, sectionId: Id): SectionSpan | undefined {
  return sectionLayout(song).find((s) => s.section.id === sectionId);
}

export function sectionAtTick(song: TimingSource & Pick<Song, 'sections'>, tick: Ticks): SectionSpan | undefined {
  return sectionLayout(song).find((s) => tick >= s.startTick && tick < s.endTick);
}

/** Resolve a section reference (id, exact name, or case-insensitive name). */
export function findSection(song: Pick<Song, 'sections'>, ref: string): Section | undefined {
  return (
    song.sections.find((s) => s.id === ref) ??
    song.sections.find((s) => s.name === ref) ??
    song.sections.find((s) => s.name.toLowerCase() === ref.toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// Key & chords
// ---------------------------------------------------------------------------

export function keyAtBar(song: Pick<Song, 'keyMap'>, bar: number): KeySignature {
  const keys = [...song.keyMap].sort((a, b) => a.bar - b.bar);
  let key: KeySignature = keys[0]?.key ?? { tonic: 0, mode: 'major' };
  for (const k of keys) {
    if (k.bar <= bar) key = k.key;
    else break;
  }
  return key;
}

export function keyAtTick(song: TimingSource & Pick<Song, 'keyMap'>, tick: Ticks): KeySignature {
  return keyAtBar(song, tickToBar(song, tick).bar);
}

export function chordAtTick(song: Pick<Song, 'chords'>, tick: Ticks): ChordEvent | undefined {
  let found: ChordEvent | undefined;
  for (const c of song.chords) {
    if (c.tick <= tick && tick < c.tick + c.duration) {
      if (!found || c.tick > found.tick) found = c;
    }
  }
  return found;
}

export function chordsInRange(song: Pick<Song, 'chords'>, startTick: Ticks, endTick: Ticks): ChordEvent[] {
  return song.chords
    .filter((c) => c.tick < endTick && c.tick + c.duration > startTick)
    .sort((a, b) => a.tick - b.tick);
}

/** Snap a tick to a grid (in ticks), optionally with strength 0..1. */
export function quantizeTick(tick: Ticks, grid: Ticks, strength = 1): Ticks {
  if (grid <= 0) return tick;
  const target = Math.round(tick / grid) * grid;
  return Math.round(tick + (target - tick) * strength);
}
