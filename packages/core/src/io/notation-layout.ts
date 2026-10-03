import type { ChordEvent, KeySignature, Note, Song } from '../ir/types';
import {
  barLengthTicks,
  barToTick,
  bpmAtTick,
  keyAtBar,
  meterAtBar,
  sectionLayout,
  songLengthBars,
  ticksPerBeat,
  tickToBar,
} from '../timing';
import { keyPrefersFlats, mod12, spellPitchClass } from '../theory/pitch';
import { scalePitchClasses } from '../theory/scales';
import { keyFifths } from './util';

/**
 * Notation layout shared by the MusicXML exporter and the PDF lead sheet:
 * measures (meter/key/tempo/section info), quantization to a 16th grid, voice assignment,
 * splitting into notatable durations with ties across beats/barlines, rests, pitch spelling,
 * accidentals and lyric syllabics.
 */

export type NoteType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd';

export interface MeasureInfo {
  index: number;
  startTick: number;
  endTick: number;
  numerator: number;
  denominator: number;
  key: KeySignature;
  fifths: number;
  meterChange: boolean;
  keyChange: boolean;
  /** Section starting at this measure. */
  section?: { id: string; name: string };
  /** Last measure of a section (double bar line). */
  sectionEnd: boolean;
  /** Tempo changes inside this measure (including one at its start). */
  tempos: { tick: number; bpm: number }[];
}

/** Grid used for quantization: a 16th note (32nd for x/32 meters). */
export function notationGrid(song: Song): number {
  let grid = song.ppq / 4;
  for (const m of song.meterMap) grid = Math.min(grid, ticksPerBeat(m.denominator, song.ppq) / 2);
  return Math.max(1, Math.floor(grid));
}

/** Notes far past the last section are not notated beyond this many extra bars. */
const MAX_EXTRA_BARS = 64;
const MAX_MEASURES = 4000;

export function buildMeasures(song: Song, minEndTick = 0): MeasureInfo[] {
  const structural = songLengthBars(song);
  let total = structural;
  if (minEndTick > 0)
    total = Math.max(total, Math.min(tickToBar(song, minEndTick - 1).bar + 1, structural + MAX_EXTRA_BARS));
  total = Math.max(1, Math.min(total, Math.max(structural, MAX_MEASURES)));
  const spans = sectionLayout(song);
  const sectionStarts = new Map(
    spans.filter((s) => s.endBar > s.startBar).map((s) => [s.startBar, s.section] as const),
  );
  const sectionEnds = new Set(spans.filter((s) => s.endBar > s.startBar).map((s) => s.endBar - 1));
  const tempos = [...song.tempoMap].sort((a, b) => a.tick - b.tick);
  const out: MeasureInfo[] = [];
  for (let i = 0; i < total; i++) {
    const meter = meterAtBar(song, i);
    const key = keyAtBar(song, i);
    const startTick = barToTick(song, i);
    const endTick = startTick + barLengthTicks(meter, song.ppq);
    const prev = out[i - 1];
    const s = sectionStarts.get(i);
    const inMeasure = tempos.filter((t) => t.tick >= startTick && t.tick < endTick);
    if (i === 0 && !inMeasure.some((t) => t.tick === 0))
      inMeasure.unshift({ tick: 0, bpm: bpmAtTick(song, 0) });
    out.push({
      index: i,
      startTick,
      endTick,
      numerator: meter.numerator,
      denominator: meter.denominator,
      key,
      fifths: keyFifths(key),
      meterChange: !prev || prev.numerator !== meter.numerator || prev.denominator !== meter.denominator,
      keyChange: !prev || prev.key.tonic !== key.tonic || prev.key.mode !== key.mode,
      section: s ? { id: s.id, name: s.name } : undefined,
      sectionEnd: sectionEnds.has(i),
      tempos: inMeasure.map((t) => ({ tick: t.tick, bpm: t.bpm })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

export interface DurationPiece {
  ticks: number;
  type: NoteType;
  dots: number;
}

function noteValues(ppq: number, grid: number): DurationPiece[] {
  const base: [NoteType, number][] = [
    ['whole', ppq * 4],
    ['half', ppq * 2],
    ['quarter', ppq],
    ['eighth', ppq / 2],
    ['16th', ppq / 4],
    ['32nd', ppq / 8],
  ];
  const out: DurationPiece[] = [];
  for (const [type, ticks] of base) {
    if (ticks < grid) continue;
    if (Number.isInteger(ticks * 1.5) && ticks / 2 >= grid) out.push({ ticks: ticks * 1.5, type, dots: 1 });
    out.push({ ticks, type, dots: 0 });
  }
  return out.sort((a, b) => b.ticks - a.ticks);
}

/** Split a note duration into notatable pieces (largest first). */
export function splitNoteDuration(ticks: number, ppq: number, grid: number): DurationPiece[] {
  const values = noteValues(ppq, grid);
  const out: DurationPiece[] = [];
  let rest = ticks;
  while (rest >= grid) {
    const v = values.find((x) => x.ticks <= rest);
    if (!v) break;
    out.push(v);
    rest -= v.ticks;
  }
  if (!out.length) out.push(values[values.length - 1]);
  return out;
}

/** Split a rest aligned to the beat grid (rests do not straddle beats unless they start on a larger value). */
export function splitRest(
  pos: number,
  ticks: number,
  ppq: number,
  grid: number,
  meter: { numerator: number; denominator: number },
): DurationPiece[] {
  const values = noteValues(ppq, grid).filter((v) => v.dots === 0);
  const compound = meter.denominator === 8 && meter.numerator % 3 === 0 && meter.numerator > 3;
  const dottedQuarter = ppq * 1.5;
  const out: DurationPiece[] = [];
  let p = pos;
  let rest = ticks;
  while (rest >= grid) {
    if (compound && rest >= dottedQuarter && p % dottedQuarter === 0) {
      out.push({ ticks: dottedQuarter, type: 'quarter', dots: 1 });
      p += dottedQuarter;
      rest -= dottedQuarter;
      continue;
    }
    const v = values.find((x) => x.ticks <= rest && p % x.ticks === 0) ?? values[values.length - 1];
    out.push(v);
    p += v.ticks;
    rest -= v.ticks;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

export type Syllabic = 'single' | 'begin' | 'middle' | 'end';

export interface LyricMark {
  text: string;
  syllabic: Syllabic;
  /** A melisma ("_") follows this syllable. */
  extend: boolean;
}

/** One notated note/chord/rest inside a measure. */
export interface NotatedEvent {
  /** Ticks from the measure start. */
  start: number;
  duration: number;
  type: NoteType;
  dots: number;
  rest: boolean;
  /** Whole-measure rest. */
  measureRest?: boolean;
  /** Invisible spacer (secondary voices). */
  hidden?: boolean;
  /** Sounding MIDI pitches (ascending). */
  pitches: number[];
  tieStart: boolean;
  tieStop: boolean;
  lyric?: LyricMark;
  /** Source notes (articulations/velocity of the first). */
  notes: Note[];
}

interface Candidate {
  start: number;
  end: number;
  pitches: number[];
  notes: Note[];
}

/** Syllabic info for every note carrying a syllable (by note id), from "-"/"_" conventions. */
export function computeSyllabics(notes: readonly Note[]): Map<string, LyricMark> {
  const out = new Map<string, LyricMark>();
  const sung = [...notes].filter((n) => n.syllable).sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
  let prevContinues = false;
  let prev: LyricMark | undefined;
  for (const n of sung) {
    const raw = n.syllable!.trim();
    if (raw === '_' || raw === '') {
      if (prev) prev.extend = true;
      continue;
    }
    const continuesNext = raw.endsWith('-');
    const startsMid = prevContinues || raw.startsWith('-');
    const text = raw.replace(/^-+|-+$/g, '') || raw;
    const syllabic: Syllabic = startsMid
      ? continuesNext
        ? 'middle'
        : 'end'
      : continuesNext
        ? 'begin'
        : 'single';
    const mark: LyricMark = { text, syllabic, extend: false };
    out.set(n.id, mark);
    prev = mark;
    prevContinues = continuesNext;
  }
  return out;
}

export interface VoiceLayoutOptions {
  ppq: number;
  grid: number;
  /** Maximum simultaneous voices; extra material is truncated (default 4). */
  maxVoices?: number;
  /** Lead-sheet mode: a single voice, top note only. */
  monophonic?: boolean;
  /** Show rests in secondary voices instead of invisible spacers. */
  visibleRestsInAllVoices?: boolean;
}

function quantize(notes: readonly Note[], grid: number): Candidate[] {
  const groups = new Map<string, Candidate>();
  for (const n of notes) {
    if (!(n.duration > 0) || !Number.isFinite(n.tick)) continue;
    const start = Math.round(n.tick / grid) * grid;
    const end = Math.max(start + grid, Math.round((n.tick + n.duration) / grid) * grid);
    const key = `${start}|${end}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { start, end, pitches: [], notes: [] }));
    if (!g.pitches.includes(n.pitch)) g.pitches.push(n.pitch);
    g.notes.push(n);
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.pitches.sort((a, b) => a - b);
    g.notes.sort((a, b) => b.pitch - a.pitch);
  }
  return list.sort((a, b) => a.start - b.start || b.end - a.end);
}

function assignVoices(cands: Candidate[], maxVoices: number, monophonic: boolean): Candidate[][] {
  if (monophonic) {
    // Skyline: at each onset keep the highest note; cut at the next onset.
    const byStart = new Map<number, Candidate>();
    for (const c of cands) {
      const top = c.pitches[c.pitches.length - 1];
      const cur = byStart.get(c.start);
      if (
        !cur ||
        top > cur.pitches[cur.pitches.length - 1] ||
        (top === cur.pitches[cur.pitches.length - 1] && c.end > cur.end)
      ) {
        byStart.set(c.start, {
          start: c.start,
          end: c.end,
          pitches: [top],
          notes: c.notes.filter((n) => n.pitch === top).concat(c.notes.filter((n) => n.pitch !== top)),
        });
      }
    }
    const line = [...byStart.values()].sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < line.length; i++) line[i].end = Math.min(line[i].end, line[i + 1].start);
    return [line];
  }
  const voices: Candidate[][] = [];
  for (const c of cands) {
    let v = voices.findIndex((list) => list[list.length - 1].end <= c.start);
    if (v < 0 && voices.length < maxVoices) {
      voices.push([]);
      v = voices.length - 1;
    }
    if (v < 0) {
      // Too many voices: cut the voice that frees up first.
      let best = 0;
      for (let i = 1; i < voices.length; i++)
        if (voices[i][voices[i].length - 1].end < voices[best][voices[best].length - 1].end) best = i;
      const last = voices[best][voices[best].length - 1];
      if (last.start >= c.start) continue;
      last.end = c.start;
      v = best;
    }
    voices[v].push({ ...c, pitches: c.pitches.slice(), notes: c.notes.slice() });
  }
  return voices;
}

/**
 * Lay out notes as notated events: result[voice][measure] = events in time order, each measure
 * fully covered (rests or hidden spacers fill gaps). Voice 0 always exists.
 */
export function layoutVoices(
  notes: readonly Note[],
  measures: MeasureInfo[],
  opts: VoiceLayoutOptions,
): NotatedEvent[][][] {
  const { ppq, grid } = opts;
  const syllabics = computeSyllabics(notes);
  const voices = assignVoices(quantize(notes, grid), opts.maxVoices ?? 4, !!opts.monophonic);
  if (!voices.length) voices.push([]);
  return voices.map((cands, vi) => {
    const primary = vi === 0 || !!opts.visibleRestsInAllVoices;
    return measures.map((m) => {
      const events: NotatedEvent[] = [];
      const len = m.endTick - m.startTick;
      const half = m.numerator % 2 === 0 && (m.denominator === 4 || m.denominator === 2) ? len / 2 : -1;
      const beat = ticksPerBeat(m.denominator, ppq);
      let pos = 0;
      const pushRest = (from: number, to: number) => {
        if (to <= from) return;
        if (from === 0 && to === len && primary) {
          events.push({
            start: 0,
            duration: len,
            type: 'whole',
            dots: 0,
            rest: true,
            measureRest: true,
            pitches: [],
            tieStart: false,
            tieStop: false,
            notes: [],
          });
          return;
        }
        let p = from;
        for (const piece of splitRest(from, to - from, ppq, grid, m)) {
          events.push({
            start: p,
            duration: piece.ticks,
            type: piece.type,
            dots: piece.dots,
            rest: true,
            hidden: !primary,
            pitches: [],
            tieStart: false,
            tieStop: false,
            notes: [],
          });
          p += piece.ticks;
        }
      };
      for (const c of cands) {
        if (c.end <= m.startTick || c.start >= m.endTick) continue;
        const s = Math.max(c.start, m.startTick) - m.startTick;
        const e = Math.min(c.end, m.endTick) - m.startTick;
        if (s < pos) continue; // overlap inside a voice cannot happen; defensive
        pushRest(pos, s);
        // Split points: beat-aligned notes keep long values; others break at the half bar.
        const segments: [number, number][] = [];
        if (half > 0 && s < half && e > half && s % beat !== 0) segments.push([s, half], [half, e]);
        else segments.push([s, e]);
        const startsHere = c.start >= m.startTick;
        const endsHere = c.end <= m.endTick;
        let first = true;
        for (const [a, b] of segments) {
          let p = a;
          const pieces = splitNoteDuration(b - a, ppq, grid);
          pieces.forEach((piece, i) => {
            const isFirst = first && i === 0;
            const isLastPiece = i === pieces.length - 1 && b === e;
            const ev: NotatedEvent = {
              start: p,
              duration: piece.ticks,
              type: piece.type,
              dots: piece.dots,
              rest: false,
              pitches: c.pitches.slice(),
              tieStop: !(isFirst && startsHere),
              tieStart: !(isLastPiece && endsHere),
              notes: c.notes,
            };
            if (isFirst && startsHere) {
              const withSyllable = c.notes.find((n) => syllabics.has(n.id));
              if (withSyllable) ev.lyric = syllabics.get(withSyllable.id);
            }
            events.push(ev);
            p += piece.ticks;
          });
          first = false;
        }
        pos = e;
      }
      pushRest(pos, len);
      return events;
    });
  });
}

// ---------------------------------------------------------------------------
// Pitch spelling & accidentals
// ---------------------------------------------------------------------------

export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

export interface SpelledPitch {
  step: (typeof LETTERS)[number];
  /** 0..6 (C..B) */
  letter: number;
  alter: number;
  octave: number;
  /** Diatonic step number (octave * 7 + letter), for staff positions. */
  diatonic: number;
}

function makeSpelled(midi: number, letter: number, alter: number): SpelledPitch {
  const octave = Math.floor((midi - alter) / 12) - 1;
  return { step: LETTERS[letter], letter, alter, octave, diatonic: octave * 7 + letter };
}

/** Spell a MIDI pitch in a key (scale tones by scale letter; chromatic tones by the key's sharp/flat preference). */
export function spellPitch(midi: number, key: KeySignature): SpelledPitch {
  const pc = mod12(midi);
  const scale = scalePitchClasses(key);
  const tonicLetter = LETTERS.indexOf(spellPitchClass(key.tonic, key)[0] as (typeof LETTERS)[number]);
  const deg = scale.indexOf(pc);
  if (deg >= 0) {
    const letter = (tonicLetter + deg) % 7;
    let alter = pc - LETTER_PC[letter];
    if (alter > 6) alter -= 12;
    if (alter < -6) alter += 12;
    if (Math.abs(alter) <= 2) return makeSpelled(midi, letter, alter);
  }
  const white = LETTER_PC.indexOf(pc);
  if (white >= 0) return makeSpelled(midi, white, 0);
  if (keyPrefersFlats(key)) return makeSpelled(midi, LETTER_PC.indexOf(mod12(pc + 1)), -1);
  return makeSpelled(midi, LETTER_PC.indexOf(mod12(pc - 1)), 1);
}

const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

/** Default alteration of each letter (C..B) for a key signature. */
export function keySignatureAlters(fifths: number): number[] {
  const alters = [0, 0, 0, 0, 0, 0, 0];
  if (fifths > 0) for (let i = 0; i < Math.min(7, fifths); i++) alters[SHARP_ORDER[i]] = 1;
  if (fifths < 0) for (let i = 0; i < Math.min(7, -fifths); i++) alters[FLAT_ORDER[i]] = -1;
  return alters;
}

export function keySignatureLetters(fifths: number): { letter: number; alter: number }[] {
  if (fifths > 0) return SHARP_ORDER.slice(0, Math.min(7, fifths)).map((letter) => ({ letter, alter: 1 }));
  if (fifths < 0) return FLAT_ORDER.slice(0, Math.min(7, -fifths)).map((letter) => ({ letter, alter: -1 }));
  return [];
}

export type AccidentalName = 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'flat-flat';

/** Per-measure accidental state machine (reset each measure). */
export class AccidentalState {
  private state = new Map<number, number>();
  constructor(private readonly keyAlters: number[]) {}

  /** Accidental to display for a note (undefined when implied); ties never show one. */
  accidentalFor(p: SpelledPitch, tied: boolean): AccidentalName | undefined {
    const current = this.state.get(p.diatonic) ?? this.keyAlters[p.letter];
    this.state.set(p.diatonic, p.alter);
    if (tied || current === p.alter) return undefined;
    switch (p.alter) {
      case 0:
        return 'natural';
      case 1:
        return 'sharp';
      case -1:
        return 'flat';
      case 2:
        return 'double-sharp';
      case -2:
        return 'flat-flat';
      default:
        return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Chords in measures
// ---------------------------------------------------------------------------

export interface MeasureChord {
  /** Ticks from the measure start (quantized). */
  offset: number;
  chord: ChordEvent;
}

export function chordsByMeasure(song: Song, measures: MeasureInfo[], grid: number): MeasureChord[][] {
  const out: MeasureChord[][] = measures.map(() => []);
  for (const c of [...song.chords].sort((a, b) => a.tick - b.tick)) {
    const tick = Math.round(c.tick / grid) * grid;
    const m = measures.find((x) => tick >= x.startTick && tick < x.endTick);
    if (!m) continue;
    const list = out[m.index];
    const offset = tick - m.startTick;
    if (list.length && list[list.length - 1].offset === offset) list[list.length - 1] = { offset, chord: c };
    else list.push({ offset, chord: c });
  }
  return out;
}

/** Latest end tick of a set of notes. */
export function notesEnd(notes: readonly Note[]): number {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.tick + n.duration);
  return end;
}

// ---------------------------------------------------------------------------
// Drum notation
// ---------------------------------------------------------------------------

/** Standard drum-set display positions (step/octave on a 5-line percussion staff) and noteheads. */
export const DRUM_DISPLAY: Record<
  number,
  { step: string; octave: number; notehead?: string; feet?: boolean }
> = {
  35: { step: 'E', octave: 4, feet: true },
  36: { step: 'F', octave: 4, feet: true },
  37: { step: 'C', octave: 5, notehead: 'x' },
  38: { step: 'C', octave: 5 },
  39: { step: 'C', octave: 5, notehead: 'x' },
  40: { step: 'C', octave: 5 },
  41: { step: 'G', octave: 4 },
  42: { step: 'G', octave: 5, notehead: 'x' },
  43: { step: 'A', octave: 4 },
  44: { step: 'D', octave: 4, notehead: 'x', feet: true },
  45: { step: 'B', octave: 4 },
  46: { step: 'G', octave: 5, notehead: 'circle-x' },
  47: { step: 'D', octave: 5 },
  48: { step: 'D', octave: 5 },
  49: { step: 'A', octave: 5, notehead: 'x' },
  50: { step: 'E', octave: 5 },
  51: { step: 'F', octave: 5, notehead: 'x' },
  52: { step: 'A', octave: 5, notehead: 'x' },
  53: { step: 'F', octave: 5, notehead: 'diamond' },
  54: { step: 'E', octave: 5, notehead: 'x' },
  55: { step: 'B', octave: 5, notehead: 'x' },
  56: { step: 'E', octave: 5, notehead: 'triangle' },
  57: { step: 'A', octave: 5, notehead: 'x' },
  59: { step: 'F', octave: 5, notehead: 'x' },
};

export function drumDisplay(pitch: number) {
  return DRUM_DISPLAY[pitch] ?? { step: 'C', octave: 5, notehead: 'x' };
}
