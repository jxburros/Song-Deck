import { useMemo, type ReactNode } from 'react';
import {
  FLAT_NAMES,
  SHARP_NAMES,
  getInstrument,
  keyPrefersFlats,
  scalePitchClasses,
  type InstrumentProfile,
  type KeySignature,
  type ModeName,
  type Song,
} from '@songdeck/core';
import { useElementSize } from '../../hooks';

/**
 * Notation preview (spec §25 "Generate MIDI → notation preview").
 *
 * A compact, dependency-free engraver that renders quantized material as standard notation in SVG:
 * clef, key signature, time signature, spelled accidentals (with bar-scoped memory), notes split
 * into notatable values and tied across beats/bars, beams (per beat group) or flags, rests, dots,
 * ledger lines, bar lines, system breaks, grand staff for keyboards and chord symbols. Drum parts
 * are shown as a step grid (one row per drum sound), which reads better than a percussion staff at
 * preview size. It is a preview, not a publishing engraver: tuplets are approximated on a 1/16 grid.
 */

export interface NotationNote {
  pitch: number;
  tick: number;
  duration: number;
  velocity?: number;
  /** 0..1 — low-confidence notes (transcriptions) are tinted. */
  confidence?: number;
}

export type NotationClef = 'treble' | 'bass' | 'treble-8vb' | 'percussion' | 'grand';

export interface NotationPreviewProps {
  notes: readonly NotationNote[];
  ppq?: number;
  meter?: { numerator: number; denominator: number };
  keySignature?: KeySignature;
  /** 'auto' picks treble/bass/grand from the material. */
  clef?: NotationClef | 'auto';
  /** Written = sounding + transpose (InstrumentProfile.notationTranspose, e.g. +12 for guitar/bass). */
  transpose?: number;
  /** Tick of the first bar shown (default 0). */
  startTick?: number;
  /** Number of bars (default: enough to hold the notes). */
  bars?: number;
  /** Cap on rendered bars (rest is summarized). */
  maxBars?: number;
  chords?: readonly { tick: number; symbol: string }[];
  /** Render as a drum step grid. */
  drums?: boolean;
  /** Fixed width in px (default: fill the container). */
  width?: number;
  /** Staff space in px (default 7). */
  staffSpace?: number;
  /** Confidence below which notes are highlighted (default 0.6). */
  lowConfidence?: number;
  /** 1-based number of the first bar (for bar numbers). */
  firstBarNumber?: number;
  ariaLabel?: string;
}

// ---------------------------------------------------------------------------------------------
// Pitch spelling
// ---------------------------------------------------------------------------------------------

const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const mod12 = (n: number) => ((n % 12) + 12) % 12;
const letterIndex = (name: string) => 'CDEFGAB'.indexOf(name[0]);

const MODE_PARENT_OFFSET: Record<ModeName, number> = {
  major: 0,
  dorian: 2,
  phrygian: 4,
  lydian: 5,
  mixolydian: 7,
  minor: 9,
  'harmonic-minor': 9,
  'melodic-minor': 9,
  locrian: 11,
};
const FIFTHS_BY_PC: Record<number, number> = {
  0: 0,
  7: 1,
  2: 2,
  9: 3,
  4: 4,
  11: 5,
  6: 6,
  1: -5,
  8: -4,
  3: -3,
  10: -2,
  5: -1,
};
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B (letter indices)
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

/** Sharps (>0) or flats (<0) in the key signature. */
export function keySignatureFifths(key: KeySignature): number {
  const parent = mod12(key.tonic - MODE_PARENT_OFFSET[key.mode]);
  let n = FIFTHS_BY_PC[parent];
  if (parent === 6 && keyPrefersFlats(key)) n = -6;
  return n;
}

interface Spelled {
  midi: number;
  letter: number;
  acc: number;
  /** Diatonic staff index: octave * 7 + letter (C4 = 28). */
  pos: number;
}

class Speller {
  private map = new Map<number, { letter: number; acc: number }>();
  private flats: boolean;
  readonly keyAcc: number[] = [0, 0, 0, 0, 0, 0, 0];

  constructor(key: KeySignature) {
    this.flats = keyPrefersFlats(key);
    const fifths = keySignatureFifths(key);
    if (fifths > 0) for (let i = 0; i < fifths; i++) this.keyAcc[SHARP_ORDER[i]] = 1;
    else for (let i = 0; i < -fifths; i++) this.keyAcc[FLAT_ORDER[i]] = -1;
    const tonicName = (this.flats ? FLAT_NAMES : SHARP_NAMES)[mod12(key.tonic)];
    const l0 = letterIndex(tonicName);
    const set = (pc: number, letter: number, force = false) => {
      let acc = pc - LETTER_PC[letter];
      if (acc > 6) acc -= 12;
      if (acc < -6) acc += 12;
      if (Math.abs(acc) > 2) return;
      if (force || !this.map.has(pc)) this.map.set(pc, { letter, acc });
    };
    const pcs = scalePitchClasses(key);
    if (pcs.length === 7) pcs.forEach((pc, i) => set(pc, (l0 + i) % 7, true));
    // Conventional chromatic spellings relative to the tonic (raised 6/7 in minor, b7/#4 in major…).
    const t = mod12(key.tonic);
    const minorish =
      key.mode === 'minor' ||
      key.mode === 'dorian' ||
      key.mode === 'phrygian' ||
      key.mode.includes('minor') ||
      key.mode === 'locrian';
    const extras: [number, number][] = minorish
      ? [
          [11, 6],
          [9, 5],
          [6, 3],
          [1, 1],
          [4, 2],
        ]
      : [
          [10, 6],
          [6, 3],
          [3, 2],
          [8, 5],
          [1, 1],
        ];
    for (const [semi, deg] of extras) set(mod12(t + semi), (l0 + deg) % 7);
  }

  spell(midi: number): Spelled {
    const pc = mod12(midi);
    let sp = this.map.get(pc);
    if (!sp) {
      const name = (this.flats ? FLAT_NAMES : SHARP_NAMES)[pc];
      sp = { letter: letterIndex(name), acc: name.length > 1 ? (name[1] === '#' ? 1 : -1) : 0 };
    }
    const natural = midi - sp.acc;
    const octave = Math.floor(natural / 12) - 1;
    return { midi, letter: sp.letter, acc: sp.acc, pos: octave * 7 + sp.letter };
  }
}

// ---------------------------------------------------------------------------------------------
// Rhythm model
// ---------------------------------------------------------------------------------------------

interface MeterInfo {
  num: number;
  den: number;
  ppq: number;
  grid: number;
  beat: number;
  barLen: number;
  compound: boolean;
  groupStarts: number[];
}

function meterInfo(meter: { numerator: number; denominator: number }, ppq: number): MeterInfo {
  const num = Math.max(1, Math.round(meter.numerator || 4));
  const den = [1, 2, 4, 8, 16].includes(meter.denominator) ? meter.denominator : 4;
  const beat = (4 * ppq) / den;
  const barLen = num * beat;
  const compound = den === 8 && num % 3 === 0 && num >= 6;
  const groupStarts: number[] = [];
  if (compound) for (let p = 0; p < barLen; p += 3 * beat) groupStarts.push(p);
  else if (den === 8) {
    if (num <= 3) groupStarts.push(0);
    else {
      const sizes: number[] = [];
      let left = num;
      while (left > 0) {
        const s = left === 3 ? 3 : 2;
        sizes.push(Math.min(s, left));
        left -= s;
      }
      let p = 0;
      for (const s of sizes) {
        groupStarts.push(p);
        p += s * beat;
      }
    }
  } else if (den === 16) for (let p = 0; p < barLen; p += ppq) groupStarts.push(p);
  else for (let p = 0; p < barLen; p += beat) groupStarts.push(p);
  return { num, den, ppq, grid: ppq / 4, beat, barLen, compound, groupStarts };
}

interface DurValue {
  t: number;
  /** 1 = whole, 2 = half, 4 = quarter, 8 = eighth, 16, 32. */
  base: number;
  dots: number;
}

function durValues(ppq: number): DurValue[] {
  return [
    { t: 4 * ppq, base: 1, dots: 0 },
    { t: 3 * ppq, base: 2, dots: 1 },
    { t: 2 * ppq, base: 2, dots: 0 },
    { t: 1.5 * ppq, base: 4, dots: 1 },
    { t: ppq, base: 4, dots: 0 },
    { t: 0.75 * ppq, base: 8, dots: 1 },
    { t: ppq / 2, base: 8, dots: 0 },
    { t: 0.375 * ppq, base: 16, dots: 1 },
    { t: ppq / 4, base: 16, dots: 0 },
    { t: ppq / 8, base: 32, dots: 0 },
  ];
}

interface Piece extends DurValue {
  pos: number;
}

function groupIndexAt(m: MeterInfo, pos: number): number {
  let gi = 0;
  for (let i = 0; i < m.groupStarts.length; i++) if (m.groupStarts[i] <= pos) gi = i;
  return gi;
}

function allowed(m: MeterInfo, pos: number, v: DurValue, rest: boolean): boolean {
  const end = pos + v.t;
  if (end > m.barLen) return false;
  if (pos === 0 && v.t === m.barLen) return !(rest && v.dots && !m.compound);
  if (rest && v.dots && !m.compound) return false;
  const gi = groupIndexAt(m, pos);
  const gStart = m.groupStarts[gi];
  const gEnd = m.groupStarts[gi + 1] ?? m.barLen;
  if (end <= gEnd) return true; // fits inside its beat group
  const halfBar = m.num === 4 && m.den === 4 ? 2 * m.ppq : 0;
  const crossesHalf = halfBar > 0 && pos < halfBar && end > halfBar;
  if (pos !== gStart) {
    // Syncopated beat-long note on an off-beat ("eighth – quarter – eighth").
    return !rest && !m.compound && v.dots === 0 && v.t === m.beat && pos % (m.beat / 2) === 0 && !crossesHalf;
  }
  if (crossesHalf) return pos === 0 || (!rest && pos === m.ppq && v.t === 2 * m.ppq && v.dots === 0);
  if (m.compound && v.t % (3 * m.beat) !== 0) return false;
  return true;
}

function splitDuration(
  m: MeterInfo,
  values: DurValue[],
  pos: number,
  len: number,
  rest: boolean,
  depth = 0,
): Piece[] {
  if (len <= 0) return [];
  if (depth > 24) return [{ pos, t: len, base: 16, dots: 0 }];
  for (const v of values) if (v.t === len && allowed(m, pos, v, rest)) return [{ pos, ...v }];
  const end = pos + len;
  const levels: ((p: number) => number | null)[] = [];
  if (m.num === 4 && m.den === 4) levels.push((p) => (p < 2 * m.ppq && end > 2 * m.ppq ? 2 * m.ppq : null));
  levels.push((p) => m.groupStarts.find((g) => g > p && g < end) ?? null);
  for (const step of [m.beat, m.beat / 2, m.grid]) {
    levels.push((p) => {
      const nb = (Math.floor(p / step) + 1) * step;
      return nb > p && nb < end ? nb : null;
    });
  }
  for (const level of levels) {
    const b = level(pos);
    if (b !== null)
      return [
        ...splitDuration(m, values, pos, b - pos, rest, depth + 1),
        ...splitDuration(m, values, b, end - b, rest, depth + 1),
      ];
  }
  for (const v of values)
    if (v.t < len && allowed(m, pos, v, rest))
      return [{ pos, ...v }, ...splitDuration(m, values, pos + v.t, len - v.t, rest, depth + 1)];
  return [
    { pos, t: m.grid, base: 16, dots: 0 },
    ...splitDuration(m, values, pos + m.grid, len - m.grid, rest, depth + 1),
  ];
}

interface Head extends Spelled {
  showAcc: number | null;
  accCol: number;
  displaced: boolean;
}

interface El {
  pos: number;
  t: number;
  base: number;
  dots: number;
  rest: boolean;
  fullBar?: boolean;
  heads: Head[];
  tieIn: boolean;
  tieOut: boolean;
  conf?: number;
  stemUp: boolean;
  beam: number; // -1 = none (flag), otherwise beam group id within the bar
}

interface Ev {
  s: number;
  e: number;
  pitches: number[];
  conf?: number;
}

function buildEvents(notes: readonly NotationNote[], grid: number, total: number): Ev[] {
  const byStart = new Map<number, Ev>();
  for (const n of notes) {
    const s = Math.max(0, Math.round(n.tick / grid) * grid);
    if (s >= total) continue;
    let e = Math.round((n.tick + n.duration) / grid) * grid;
    if (e <= s) e = s + grid;
    e = Math.min(e, total);
    const ev = byStart.get(s);
    if (ev) {
      ev.e = Math.max(ev.e, e);
      if (!ev.pitches.includes(n.pitch)) ev.pitches.push(n.pitch);
      if (n.confidence !== undefined) ev.conf = Math.min(ev.conf ?? 1, n.confidence);
    } else byStart.set(s, { s, e, pitches: [n.pitch], conf: n.confidence });
  }
  const evs = [...byStart.values()].sort((a, b) => a.s - b.s);
  for (let i = 0; i < evs.length; i++) {
    const next = evs[i + 1];
    if (next && evs[i].e > next.s) evs[i].e = next.s;
    // Close tiny gaps (legato reading of detached notes) so previews are not littered with 16th rests.
    if (next && next.s - evs[i].e > 0 && next.s - evs[i].e <= grid) evs[i].e = next.s;
    evs[i].pitches.sort((a, b) => a - b);
  }
  return evs;
}

function buildBar(m: MeterInfo, values: DurValue[], evs: Ev[], barIdx: number, speller: Speller): El[] {
  const b0 = barIdx * m.barLen;
  const b1 = b0 + m.barLen;
  const els: El[] = [];
  let cursor = b0;
  const pushRest = (from: number, to: number) => {
    for (const p of splitDuration(m, values, from - b0, to - from, true))
      els.push({ ...p, rest: true, heads: [], tieIn: false, tieOut: false, stemUp: true, beam: -1 });
  };
  for (const ev of evs) {
    if (ev.e <= b0 || ev.s >= b1) continue;
    const s = Math.max(ev.s, b0);
    const e = Math.min(ev.e, b1);
    if (s > cursor) pushRest(cursor, s);
    const pieces = splitDuration(m, values, s - b0, e - s, false);
    pieces.forEach((p, i) => {
      els.push({
        ...p,
        rest: false,
        heads: ev.pitches.map((midi) => ({
          ...speller.spell(midi),
          showAcc: null,
          accCol: 0,
          displaced: false,
        })),
        tieIn: i > 0 || ev.s < b0,
        tieOut: i < pieces.length - 1 || ev.e > b1,
        conf: ev.conf,
        stemUp: true,
        beam: -1,
      });
    });
    cursor = e;
  }
  if (cursor < b1) pushRest(cursor, b1);
  if (els.every((e) => e.rest))
    return [
      {
        pos: 0,
        t: m.barLen,
        base: 1,
        dots: 0,
        rest: true,
        fullBar: true,
        heads: [],
        tieIn: false,
        tieOut: false,
        stemUp: true,
        beam: -1,
      },
    ];
  return els;
}

function applyAccidentals(els: El[], keyAcc: number[]) {
  const memory = new Map<number, number>();
  for (const el of els) {
    for (const h of el.heads) {
      const current = memory.get(h.pos) ?? keyAcc[h.letter];
      if (el.tieIn) {
        h.showAcc = null;
        continue;
      }
      if (h.acc !== current) {
        h.showAcc = h.acc;
        memory.set(h.pos, h.acc);
      } else h.showAcc = null;
    }
    // Stack accidentals of a chord in columns so they do not collide.
    const withAcc = el.heads.filter((h) => h.showAcc !== null).sort((a, b) => b.pos - a.pos);
    const cols: number[][] = [];
    for (const h of withAcc) {
      let c = 0;
      while (cols[c]?.some((p) => Math.abs(p - h.pos) < 6)) c++;
      (cols[c] ??= []).push(h.pos);
      h.accCol = c;
    }
  }
}

function assignStemsAndBeams(els: El[], m: MeterInfo, middle: number) {
  const dirFor = (heads: Head[]) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (const h of heads) {
      hi = Math.max(hi, h.pos);
      lo = Math.min(lo, h.pos);
    }
    return hi - middle > middle - lo ? false : true; // farthest note from the middle line decides
  };
  let group: El[] = [];
  let groupIdx = -1;
  let beamId = 0;
  const flush = () => {
    if (group.length >= 2) {
      const up = dirFor(group.flatMap((e) => e.heads));
      for (const e of group) {
        e.beam = beamId;
        e.stemUp = up;
      }
      beamId++;
    }
    group = [];
  };
  for (const el of els) {
    if (el.rest) {
      flush();
      continue;
    }
    el.stemUp = dirFor(el.heads);
    const gi = groupIndexAt(m, el.pos);
    if (el.base >= 8) {
      if (gi !== groupIdx) flush();
      group.push(el);
      groupIdx = gi;
    } else flush();
  }
  flush();
  // Second-interval displacement inside chords.
  for (const el of els) {
    if (el.heads.length < 2) continue;
    const sorted = [...el.heads].sort((a, b) => a.pos - b.pos);
    if (el.stemUp) {
      for (let i = 1; i < sorted.length; i++)
        if (sorted[i].pos - sorted[i - 1].pos === 1 && !sorted[i - 1].displaced) sorted[i].displaced = true;
    } else {
      for (let i = sorted.length - 2; i >= 0; i--)
        if (sorted[i + 1].pos - sorted[i].pos === 1 && !sorted[i + 1].displaced) sorted[i].displaced = true;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Staff geometry and glyphs (designed in a 10-unit staff space, scaled by S / 10)
// ---------------------------------------------------------------------------------------------

interface StaffDef {
  clef: 'treble' | 'bass' | 'treble-8vb';
  /** Diatonic index of the top line (treble F5 = 38, bass A3 = 26). */
  topPos: number;
}

const TREBLE: StaffDef = { clef: 'treble', topPos: 38 };
const TREBLE_8VB: StaffDef = { clef: 'treble-8vb', topPos: 38 };
const BASS: StaffDef = { clef: 'bass', topPos: 26 };

const TREBLE_CLEF_PATH =
  'M15.6 33.4C10.6 35.4 6.6 30.6 9.6 26.6C13 22.6 20 25.4 20 31C20 37.6 12.6 40.6 7.6 37C1.6 33 2 24 8.6 18C14 13 19.6 8 19.6 0C19.6 -7 16 -12.4 13.6 -12.4C10.6 -12.4 9.6 -6 10.6 0L16 47C16.6 53 9 55.4 7.4 50.4';
const BASS_CLEF_PATH = 'M3.2 9C3 2.6 9.6 -0.8 15 1.4C21.2 4.2 21.8 13 17.2 20C13.4 25.8 7.6 30.6 1.4 33.6';

function sharpPath(cx: number, cy: number, k: number) {
  const v = (x: number, y1: number, y2: number) =>
    `M${cx + x * k} ${cy + y1 * k}L${cx + x * k} ${cy + y2 * k}`;
  const bar = (c: number) =>
    `M${cx - 4.6 * k} ${cy + (c + 1.1) * k}L${cx + 4.6 * k} ${cy + (c - 1.1) * k}L${cx + 4.6 * k} ${cy + (c + 1.3) * k}L${cx - 4.6 * k} ${cy + (c + 3.5) * k}Z`;
  return { lines: `${v(-2.1, -10.5, 9.5)}${v(2.1, -11.5, 8.5)}`, fill: `${bar(-4.2)}${bar(2.6)}` };
}

function flatPath(cx: number, cy: number, k: number) {
  const x = cx - 2.4 * k;
  return {
    lines: `M${x} ${cy - 13 * k}L${x} ${cy + 4 * k}`,
    fill: `M${x} ${cy + 4 * k}C${x + 4 * k} ${cy + 1.8 * k} ${x + 7.6 * k} ${cy - 1.4 * k} ${x + 6.2 * k} ${cy - 4 * k}C${x + 5 * k} ${cy - 6.4 * k} ${x + 1.6 * k} ${cy - 5 * k} ${x} ${cy - 2.6 * k}L${x} ${cy - 1 * k}C${x + 1.8 * k} ${cy - 3.2 * k} ${x + 4.4 * k} ${cy - 3.8 * k} ${x + 4.6 * k} ${cy - 2.2 * k}C${x + 4.8 * k} ${cy - 0.4 * k} ${x + 2.6 * k} ${cy + 1.6 * k} ${x} ${cy + 2.6 * k}Z`,
  };
}

function naturalPath(cx: number, cy: number, k: number) {
  const l = cx - 2.3 * k;
  const r = cx + 2.3 * k;
  const bar = (c: number) =>
    `M${l} ${cy + (c + 1) * k}L${r} ${cy + (c - 1) * k}L${r} ${cy + (c + 1.4) * k}L${l} ${cy + (c + 3.4) * k}Z`;
  return {
    lines: `M${l} ${cy - 11 * k}L${l} ${cy + 5 * k}M${r} ${cy - 5 * k}L${r} ${cy + 11 * k}`,
    fill: `${bar(-4.4)}${bar(1.6)}`,
  };
}

function accidentalGlyph(
  acc: number,
  cx: number,
  cy: number,
  k: number,
  key: string,
  color?: string,
): ReactNode {
  const stroke = 1.15 * k;
  if (acc === 2) {
    const s = 2.6 * k;
    return (
      <path
        key={key}
        d={`M${cx - s} ${cy - s}L${cx + s} ${cy + s}M${cx + s} ${cy - s}L${cx - s} ${cy + s}`}
        stroke={color ?? 'currentColor'}
        strokeWidth={2 * k}
        strokeLinecap="round"
      />
    );
  }
  if (acc === -2) {
    const a = flatPath(cx - 2.6 * k, cy, k);
    const b = flatPath(cx + 2.6 * k, cy, k);
    return (
      <g key={key} fill={color ?? 'currentColor'} stroke={color ?? 'currentColor'}>
        <path d={a.lines + b.lines} strokeWidth={stroke} fill="none" />
        <path d={a.fill + b.fill} stroke="none" />
      </g>
    );
  }
  const g = acc > 0 ? sharpPath(cx, cy, k) : acc < 0 ? flatPath(cx, cy, k) : naturalPath(cx, cy, k);
  return (
    <g key={key} fill={color ?? 'currentColor'} stroke={color ?? 'currentColor'}>
      <path d={g.lines} strokeWidth={stroke} fill="none" />
      <path d={g.fill} stroke="none" />
    </g>
  );
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number) {
  return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
}

/** Full ellipse rotated by `deg` around its centre, as a single closed sub-path. */
function rotatedEllipsePath(cx: number, cy: number, rx: number, ry: number, deg: number) {
  const t = (deg * Math.PI) / 180;
  const dx = rx * Math.cos(t);
  const dy = rx * Math.sin(t);
  return `M${cx + dx} ${cy + dy}A${rx} ${ry} ${deg} 1 0 ${cx - dx} ${cy - dy}A${rx} ${ry} ${deg} 1 0 ${cx + dx} ${cy + dy}Z`;
}

function noteheadGlyph(
  base: number,
  cx: number,
  cy: number,
  S: number,
  key: string,
  color?: string,
): ReactNode {
  const fill = color ?? 'currentColor';
  if (base === 1) {
    return (
      <path
        key={key}
        d={`${ellipsePath(cx, cy, 0.78 * S, 0.5 * S)}${rotatedEllipsePath(cx, cy, 0.38 * S, 0.27 * S, 55)}`}
        fill={fill}
        fillRule="evenodd"
      />
    );
  }
  const rx = 0.62 * S;
  const ry = 0.44 * S;
  if (base === 2) {
    return (
      <g key={key} transform={`translate(${cx} ${cy}) rotate(-22)`}>
        <path
          d={`${ellipsePath(0, 0, rx, ry)}${ellipsePath(0, 0, 0.5 * S, 0.2 * S)}`}
          fill={fill}
          fillRule="evenodd"
        />
      </g>
    );
  }
  return (
    <g key={key} transform={`translate(${cx} ${cy}) rotate(-22)`}>
      <path d={ellipsePath(0, 0, rx, ry)} fill={fill} />
    </g>
  );
}

function restGlyph(base: number, x: number, staffTop: number, S: number, key: string): ReactNode {
  const k = S / 10;
  const mid = staffTop + 2 * S;
  if (base <= 1)
    return (
      <rect key={key} x={x - 0.6 * S} y={staffTop + S} width={1.2 * S} height={0.5 * S} fill="currentColor" />
    );
  if (base === 2)
    return (
      <rect
        key={key}
        x={x - 0.6 * S}
        y={mid - 0.5 * S}
        width={1.2 * S}
        height={0.5 * S}
        fill="currentColor"
      />
    );
  if (base === 4) {
    const p = (dx: number, dy: number) => `${x + dx * k} ${mid + dy * k}`;
    return (
      <path
        key={key}
        d={`M${p(-2, -12)}L${p(3.4, -6)}L${p(-1.4, -0.6)}L${p(3.6, 5.6)}C${p(-1, 3.4)} ${p(-3, 7.6)} ${p(0.6, 11.4)}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4 * k}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    );
  }
  const flags = base >= 32 ? 3 : base >= 16 ? 2 : 1;
  const parts: ReactNode[] = [];
  for (let i = 0; i < flags; i++) {
    const cy = mid - 5 * k + i * 7.5 * k;
    const cx = x - 1.6 * k - i * 1.4 * k;
    parts.push(<circle key={`d${i}`} cx={cx} cy={cy} r={2.3 * k} fill="currentColor" />);
    parts.push(
      <path
        key={`c${i}`}
        d={`M${cx} ${cy + 1.2 * k}C${cx + 2.4 * k} ${cy + 3 * k} ${cx + 5 * k} ${cy + 1.6 * k} ${cx + 6.2 * k} ${cy - 1.8 * k}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4 * k}
      />,
    );
  }
  const top = mid - 6.8 * k;
  parts.push(
    <path
      key="stem"
      d={`M${x + 4.6 * k} ${top}L${x - 0.6 * k - (flags - 1) * 1.6 * k} ${mid + 8 * k + (flags - 1) * 7.5 * k}`}
      stroke="currentColor"
      strokeWidth={1.5 * k}
    />,
  );
  return <g key={key}>{parts}</g>;
}

function flagGlyph(
  x: number,
  y: number,
  up: boolean,
  count: number,
  S: number,
  key: string,
  color?: string,
): ReactNode {
  const k = S / 10;
  const d = up ? 1 : -1;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const y0 = y + d * i * 7 * k;
    parts.push(
      `M${x} ${y0}C${x + 0.8 * k} ${y0 + d * 7 * k} ${x + 10.5 * k} ${y0 + d * 10 * k} ${x + 8.6 * k} ${y0 + d * 23 * k}C${x + 8.2 * k} ${y0 + d * 25 * k} ${x + 7.4 * k} ${y0 + d * 26.4 * k} ${x + 6.8 * k} ${y0 + d * 27.2 * k}C${x + 8.6 * k} ${y0 + d * 19 * k} ${x + 4.4 * k} ${y0 + d * 13.4 * k} ${x} ${y0 + d * 11.6 * k}Z`,
    );
  }
  return <path key={key} d={parts.join('')} fill={color ?? 'currentColor'} />;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

interface BarLayout {
  index: number;
  staves: El[][];
  cols: number[]; // bar-relative onset positions
  accRoom: number[];
  space: number[];
  minWidth: number;
}

interface HeadAnchor {
  x: number;
  y: number;
  midi: number;
  stemUp: boolean;
  system: number;
  rx: number;
}

const FALLBACK_KEY: KeySignature = { tonic: 0, mode: 'major' };

/** Grand staff: split the hands at the widest pitch gap around middle C (default C4). */
function handSplit(notes: readonly NotationNote[]): number {
  const ps = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
  let best = 60;
  let bestGap = 2;
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1];
    const b = ps[i];
    if (b < 52 || a > 74) continue;
    const gap = b - a;
    // Prefer gaps close to middle C when equally wide.
    const score = gap - Math.abs((a + b) / 2 - 60) * 0.05;
    if (gap >= 3 && score > bestGap) {
      bestGap = score;
      best = b;
    }
  }
  return best;
}

function chooseClef(notes: readonly NotationNote[], transpose: number): NotationClef {
  if (!notes.length) return 'treble';
  const ps = notes.map((n) => n.pitch + transpose).sort((a, b) => a - b);
  const lo = ps[Math.floor(ps.length * 0.1)];
  const hi = ps[Math.floor(ps.length * 0.9)];
  const median = ps[Math.floor(ps.length / 2)];
  if (lo < 52 && hi > 69) return 'grand';
  return median >= 58 ? 'treble' : 'bass';
}

export function NotationPreview(props: NotationPreviewProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const width = props.width ?? Math.max(240, size.width || 560);
  return (
    <div
      ref={ref}
      className="notation-preview"
      style={{ width: props.width ? props.width : '100%', overflow: 'hidden' }}
    >
      {props.drums ? <DrumGrid {...props} width={width} /> : <Staves {...props} width={width} />}
    </div>
  );
}

function Staves(props: NotationPreviewProps & { width: number }) {
  const ppq = props.ppq ?? 480;
  // Staff space grows a little in wide containers so previews stay readable.
  const S = props.staffSpace ?? Math.max(7, Math.min(9, props.width / 105));
  const k = S / 10;
  const meter = props.meter ?? { numerator: 4, denominator: 4 };
  const key = props.keySignature ?? FALLBACK_KEY;
  const transpose = props.transpose ?? 0;
  const lowConf = props.lowConfidence ?? 0.6;
  const startTick = props.startTick ?? 0;
  const W = props.width;

  const model = useMemo(() => {
    const m = meterInfo(meter, ppq);
    const values = durValues(ppq);
    const speller = new Speller(key);
    const rel = props.notes
      .filter((n) => n.tick + n.duration > startTick)
      .map((n) => ({
        ...n,
        tick: Math.max(0, n.tick - startTick),
        pitch: Math.max(0, Math.min(127, n.pitch + transpose)),
      }));
    const lastEnd = rel.reduce((mx, n) => Math.max(mx, n.tick + n.duration), 0);
    const neededBars = Math.max(1, Math.ceil(lastEnd / m.barLen - 1e-9));
    const totalBars = props.bars ?? neededBars;
    const shownBars = Math.max(1, Math.min(totalBars, props.maxBars ?? totalBars));
    const total = shownBars * m.barLen;

    let clef: NotationClef =
      props.clef && props.clef !== 'auto' ? props.clef : chooseClef(props.notes, transpose);
    if (clef === 'percussion') clef = 'treble';
    if (clef === 'bass' && rel.length) {
      const high = rel.filter((n) => n.pitch >= 64).length / rel.length;
      if (high > 0.6) clef = 'treble';
    } else if (clef === 'treble' && rel.length) {
      const low = rel.filter((n) => n.pitch < 55).length / rel.length;
      if (low > 0.6) clef = 'bass';
    }
    const staffDefs: StaffDef[] =
      clef === 'grand'
        ? [TREBLE, BASS]
        : clef === 'bass'
          ? [BASS]
          : clef === 'treble-8vb'
            ? [TREBLE_8VB]
            : [TREBLE];
    const split = staffDefs.length === 2 ? handSplit(rel) : 60;
    const parts: NotationNote[][] =
      staffDefs.length === 2
        ? [rel.filter((n) => n.pitch >= split), rel.filter((n) => n.pitch < split)]
        : [rel];

    const bars: BarLayout[] = [];
    const evsPerStaff = parts.map((p) => buildEvents(p, m.grid, total));
    for (let b = 0; b < shownBars; b++) {
      const staves = evsPerStaff.map((evs, si) => {
        const els = buildBar(m, values, evs, b, speller);
        applyAccidentals(els, speller.keyAcc);
        assignStemsAndBeams(els, m, staffDefs[si].topPos - 4);
        return els;
      });
      const colSet = new Set<number>();
      for (const els of staves) for (const e of els) if (!e.fullBar) colSet.add(e.pos);
      const cols = [...colSet].sort((a, b2) => a - b2);
      const accRoom: number[] = [];
      const space: number[] = [];
      cols.forEach((pos, i) => {
        const next = cols[i + 1] ?? m.barLen;
        let accCols = 0;
        let dotted = false;
        for (const els of staves)
          for (const e of els)
            if (e.pos === pos) {
              for (const h of e.heads) if (h.showAcc !== null) accCols = Math.max(accCols, h.accCol + 1);
              if (e.dots) dotted = true;
            }
        accRoom.push(accCols ? accCols * 0.95 * S + 0.25 * S : 0);
        space.push(S * (1.45 + 1.3 * Math.log2(1 + (next - pos) / m.grid)) + (dotted ? 0.4 * S : 0));
      });
      const content = accRoom.reduce((a, v) => a + v, 0) + space.reduce((a, v) => a + v, 0);
      bars.push({
        index: b,
        staves,
        cols,
        accRoom,
        space,
        minWidth: Math.max(6 * S, 1.1 * S + content + 0.4 * S),
      });
    }
    return { m, bars, staffDefs, clef, totalBars, shownBars };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.notes,
    ppq,
    meter.numerator,
    meter.denominator,
    key.tonic,
    key.mode,
    transpose,
    startTick,
    props.bars,
    props.maxBars,
    props.clef,
  ]);

  const { m, bars, staffDefs } = model;
  const fifths = keySignatureFifths(key);
  const keyW = Math.abs(fifths) * 1.0 * S + (fifths ? 0.6 * S : 0);
  const clefW = 3.4 * S;
  const timeW = 2.6 * S;
  const header = (first: boolean) => 0.4 * S + clefW + keyW + (first ? timeW : 0) + 0.4 * S;
  const leftMargin = staffDefs.length > 1 ? 1.4 * S : 0.2 * S;
  const avail = W - leftMargin - 1;

  // System breaking (greedy) and justification.
  const systems: { bars: BarLayout[]; scale: number; header: number }[] = [];
  {
    let cur: BarLayout[] = [];
    let used = header(true);
    for (const bar of bars) {
      if (cur.length && used + bar.minWidth > avail) {
        systems.push({ bars: cur, scale: 1, header: header(systems.length === 0) });
        cur = [];
        used = header(false);
      }
      cur.push(bar);
      used += bar.minWidth;
    }
    if (cur.length) systems.push({ bars: cur, scale: 1, header: header(systems.length === 0) });
    systems.forEach((sys, i) => {
      const contentMin = sys.bars.reduce((a, b) => a + b.minWidth, 0);
      const stretch = (avail - sys.header) / contentMin;
      const last = i === systems.length - 1;
      sys.scale = Math.max(1, last && systems.length > 1 ? Math.min(stretch, 1.25) : stretch);
    });
  }

  // Chord symbols by bar.
  const chordsByBar = new Map<number, { pos: number; symbol: string }[]>();
  for (const c of props.chords ?? []) {
    const rel = c.tick - startTick;
    if (rel < 0) continue;
    const b = Math.floor(rel / m.barLen);
    if (b >= bars.length) continue;
    const list = chordsByBar.get(b) ?? [];
    if (!list.length || list[list.length - 1].symbol !== c.symbol)
      list.push({ pos: rel - b * m.barLen, symbol: c.symbol });
    chordsByBar.set(b, list);
  }
  const hasChords = chordsByBar.size > 0;

  // Vertical extents per system and staff (ledger notes only push their own system apart).
  const chordBand = hasChords ? 1.6 * S : 0;
  const layoutFor = (sysBars: BarLayout[]) => {
    const extents = staffDefs.map((def, si) => {
      let hi = def.topPos;
      let lo = def.topPos - 8;
      for (const bar of sysBars)
        for (const e of bar.staves[si])
          for (const h of e.heads) {
            hi = Math.max(hi, h.pos);
            lo = Math.min(lo, h.pos);
          }
      const inner = staffDefs.length > 1;
      return {
        above: Math.max(inner && si > 0 ? 2.4 * S : 3.4 * S, (hi - def.topPos) * (S / 2) + 3.8 * S),
        below: Math.max(
          inner && si < staffDefs.length - 1 ? 2.4 * S : 3.4 * S,
          (def.topPos - 8 - lo) * (S / 2) + 3.8 * S,
        ),
      };
    });
    const offsets: number[] = [];
    let y = chordBand + extents[0].above;
    offsets.push(y);
    for (let si = 1; si < staffDefs.length; si++) {
      y += 4 * S + extents[si - 1].below + extents[si].above;
      offsets.push(y);
    }
    return { offsets, height: offsets[offsets.length - 1] + 4 * S + extents[extents.length - 1].below };
  };

  const out: ReactNode[] = [];
  const beamsOut: ReactNode[] = [];
  const tieAnchors: {
    from: HeadAnchor;
    staff: number;
    nextEl: El | undefined;
    nextBar: number;
    midi: number;
  }[] = [];
  const anchorByEl = new Map<El, HeadAnchor[]>();
  const elSystem = new Map<El, number>();
  const systemEdges: { x0: number; x1: number; y: number }[] = [];
  const flat: { el: El; staff: number }[][] = staffDefs.map(() => []);
  for (const bar of bars)
    bar.staves.forEach((els, si) => els.forEach((el) => flat[si].push({ el, staff: si })));

  let sysY = 0;
  systems.forEach((sys, sysIdx) => {
    const vert = layoutFor(sys.bars);
    const staffTops = vert.offsets.map((o) => sysY + o);
    const x0 = leftMargin;
    const x1 = leftMargin + sys.header + sys.bars.reduce((a, b) => a + b.minWidth * sys.scale, 0);
    systemEdges.push({ x0, x1, y: sysY });
    const lineColor = 'var(--notation-line, var(--text-muted))';

    staffDefs.forEach((def, si) => {
      const top = staffTops[si];
      for (let l = 0; l < 5; l++)
        out.push(
          <line
            key={`sl${sysIdx}-${si}-${l}`}
            x1={x0}
            x2={x1}
            y1={top + l * S}
            y2={top + l * S}
            stroke={lineColor}
            strokeWidth={0.09 * S}
          />,
        );
      // Clef
      const cx = x0 + 0.4 * S;
      if (def.clef === 'bass') {
        out.push(
          <g key={`clef${sysIdx}-${si}`} transform={`translate(${cx} ${top}) scale(${k})`}>
            <circle cx={5} cy={10} r={3.3} fill="currentColor" />
            <path
              d={BASS_CLEF_PATH}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.6}
              strokeLinecap="round"
            />
            <circle cx={24.5} cy={5} r={1.8} fill="currentColor" />
            <circle cx={24.5} cy={15} r={1.8} fill="currentColor" />
          </g>,
        );
      } else {
        out.push(
          <g key={`clef${sysIdx}-${si}`} transform={`translate(${cx} ${top}) scale(${k})`}>
            <path
              d={TREBLE_CLEF_PATH}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx={9.2} cy={49.4} r={3} fill="currentColor" />
            {def.clef === 'treble-8vb' && (
              <text
                x={13}
                y={66}
                fontSize={12}
                textAnchor="middle"
                fill="currentColor"
                fontFamily="Georgia, 'Times New Roman', serif"
              >
                8
              </text>
            )}
          </g>,
        );
      }
      // Key signature
      const ks = Math.abs(fifths);
      const order = fifths > 0 ? [38, 35, 39, 36, 33, 37, 34] : [34, 37, 33, 36, 32, 35, 31];
      const shift = def.clef === 'bass' ? -14 : 0;
      for (let i = 0; i < ks; i++) {
        const pos = order[i] + shift;
        const ky = top + (def.topPos - pos) * (S / 2);
        out.push(
          accidentalGlyph(
            fifths > 0 ? 1 : -1,
            cx + clefW + 0.1 * S + i * S + 0.45 * S,
            ky,
            k,
            `ks${sysIdx}-${si}-${i}`,
          ),
        );
      }
      // Time signature (first system)
      if (sysIdx === 0) {
        const tx = cx + clefW + keyW + 1.1 * S;
        const font = {
          fontSize: 2.35 * S,
          fontWeight: 700,
          textAnchor: 'middle' as const,
          fontFamily: "Georgia, 'Times New Roman', serif",
          fill: 'currentColor',
        };
        out.push(
          <text key={`tsn${si}`} x={tx} y={top + 1.85 * S} {...font}>
            {m.num}
          </text>,
          <text key={`tsd${si}`} x={tx} y={top + 3.85 * S} {...font}>
            {m.den}
          </text>,
        );
      }
    });

    // Left edge: system line (and brace for grand staff).
    const firstTop = staffTops[0];
    const lastBottom = staffTops[staffTops.length - 1] + 4 * S;
    out.push(
      <line
        key={`sys${sysIdx}`}
        x1={x0}
        x2={x0}
        y1={firstTop}
        y2={lastBottom}
        stroke={lineColor}
        strokeWidth={0.12 * S}
      />,
    );
    if (staffDefs.length > 1) {
      const bx = x0 - 0.35 * S;
      const midY = (firstTop + lastBottom) / 2;
      out.push(
        <path
          key={`brace${sysIdx}`}
          d={`M${bx} ${firstTop}C${bx - 1.1 * S} ${firstTop + 1.5 * S} ${bx + 0.2 * S} ${midY - 2 * S} ${bx - 0.9 * S} ${midY}C${bx + 0.2 * S} ${midY + 2 * S} ${bx - 1.1 * S} ${lastBottom - 1.5 * S} ${bx} ${lastBottom}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.28 * S}
          strokeLinecap="round"
        />,
      );
    }
    // Bar number
    out.push(
      <text
        key={`bn${sysIdx}`}
        x={x0 + 0.1 * S}
        y={firstTop - 1.2 * S - (hasChords ? 0.2 * S : 0)}
        fontSize={1.05 * S}
        fill="var(--text-dim)"
      >
        {(props.firstBarNumber ?? 1) + sys.bars[0].index}
      </text>,
    );

    let bx = x0 + sys.header;
    sys.bars.forEach((bar) => {
      const bw = bar.minWidth * sys.scale;
      const colX: number[] = [];
      const free = bw - (1.1 * S + 0.4 * S) - bar.accRoom.reduce((a, v) => a + v, 0);
      const spaceTotal = bar.space.reduce((a, v) => a + v, 0) || 1;
      let cxPos = bx + 1.1 * S;
      bar.cols.forEach((_, i) => {
        colX.push(cxPos + bar.accRoom[i]);
        cxPos += bar.accRoom[i] + (bar.space[i] / spaceTotal) * Math.max(free, spaceTotal);
      });
      const headX = (pos: number) => {
        const i = bar.cols.indexOf(pos);
        return (i >= 0 ? colX[i] : bx + bw / 2) + 0.62 * S;
      };

      // Chord symbols
      if (hasChords) {
        let lastRight = -Infinity;
        for (const c of chordsByBar.get(bar.index) ?? []) {
          let x = bx + 1.1 * S;
          if (bar.cols.length) {
            let i = 0;
            while (i + 1 < bar.cols.length && bar.cols[i + 1] <= c.pos) i++;
            const p0 = bar.cols[i];
            const p1 = bar.cols[i + 1] ?? m.barLen;
            const x0c = colX[i];
            const x1c = i + 1 < colX.length ? colX[i + 1] : bx + bw;
            x = x0c + ((c.pos - p0) / Math.max(1, p1 - p0)) * (x1c - x0c);
            if (c.pos < p0) x = bx + 1.1 * S;
          }
          x = Math.max(x, lastRight + 0.5 * S);
          out.push(
            <text
              key={`ch${bar.index}-${c.pos}`}
              x={x}
              y={sysY + 1.5 * S}
              fontSize={1.3 * S}
              fontWeight={600}
              fill="var(--accent-text)"
            >
              {c.symbol}
            </text>,
          );
          lastRight = x + c.symbol.length * 0.8 * S;
        }
      }

      bar.staves.forEach((els, si) => {
        const def = staffDefs[si];
        const top = staffTops[si];
        const yOf = (pos: number) => top + (def.topPos - pos) * (S / 2);
        const midY = top + 2 * S;
        const bottomPos = def.topPos - 8;
        const rx = 0.62 * S;

        // Per-element geometry
        const geo = new Map<El, { stemX: number; yTop: number; yBot: number; up: boolean }>();
        for (const el of els) {
          elSystem.set(el, sysIdx);
          if (el.fullBar) {
            out.push(restGlyph(1, bx + bw / 2, top, S, `fr${bar.index}-${si}`));
            continue;
          }
          const x = headX(el.pos);
          if (el.rest) {
            out.push(restGlyph(el.base, x, top, S, `r${bar.index}-${si}-${el.pos}`));
            if (el.dots)
              out.push(
                <circle
                  key={`rd${bar.index}-${si}-${el.pos}`}
                  cx={x + 1.1 * S}
                  cy={top + 1.5 * S}
                  r={0.18 * S}
                  fill="currentColor"
                />,
              );
            continue;
          }
          const low = el.conf !== undefined && el.conf < lowConf;
          const color = low ? (el.conf! < lowConf * 0.6 ? 'var(--danger)' : 'var(--warning)') : undefined;
          const anchors: HeadAnchor[] = [];
          let yTop = Infinity;
          let yBot = -Infinity;
          const up = el.stemUp;
          for (const h of el.heads) {
            const hx = x + (h.displaced ? (up ? 1.18 * S : -1.18 * S) : 0);
            const hy = yOf(h.pos);
            yTop = Math.min(yTop, hy);
            yBot = Math.max(yBot, hy);
            // Ledger lines
            if (h.pos >= def.topPos + 2) {
              for (let p = def.topPos + 2; p <= h.pos; p += 2)
                out.push(
                  <line
                    key={`lg${bar.index}-${si}-${el.pos}-${h.midi}-${p}`}
                    x1={hx - rx - 0.4 * S}
                    x2={hx + rx + 0.4 * S}
                    y1={yOf(p)}
                    y2={yOf(p)}
                    stroke={lineColor}
                    strokeWidth={0.1 * S}
                  />,
                );
            }
            if (h.pos <= bottomPos - 2) {
              for (let p = bottomPos - 2; p >= h.pos; p -= 2)
                out.push(
                  <line
                    key={`lg${bar.index}-${si}-${el.pos}-${h.midi}-${p}`}
                    x1={hx - rx - 0.4 * S}
                    x2={hx + rx + 0.4 * S}
                    y1={yOf(p)}
                    y2={yOf(p)}
                    stroke={lineColor}
                    strokeWidth={0.1 * S}
                  />,
                );
            }
            if (h.showAcc !== null)
              out.push(
                accidentalGlyph(
                  h.showAcc,
                  x - rx - 0.75 * S - h.accCol * 0.95 * S,
                  hy,
                  k,
                  `ac${bar.index}-${si}-${el.pos}-${h.midi}`,
                  color,
                ),
              );
            out.push(noteheadGlyph(el.base, hx, hy, S, `nh${bar.index}-${si}-${el.pos}-${h.midi}`, color));
            if (el.dots) {
              // Lines sit on even offsets from the top line: dots of line notes move into the space above.
              const onLine = (def.topPos - h.pos) % 2 === 0;
              out.push(
                <circle
                  key={`dt${bar.index}-${si}-${el.pos}-${h.midi}`}
                  cx={hx + rx + 0.55 * S}
                  cy={hy - (onLine ? S / 2 : 0)}
                  r={0.18 * S}
                  fill={color ?? 'currentColor'}
                />,
              );
            }
            anchors.push({ x: hx, y: hy, midi: h.midi, stemUp: up, system: sysIdx, rx });
          }
          anchorByEl.set(el, anchors);
          if (el.base >= 2)
            geo.set(el, { stemX: up ? x + rx - 0.06 * S : x - rx + 0.06 * S, yTop, yBot, up });
          if (el.tieOut)
            for (const a of anchors) {
              const seq = flat[si];
              const idx = seq.findIndex((f) => f.el === el);
              const nextEl = seq[idx + 1]?.el;
              tieAnchors.push({ from: a, staff: si, nextEl, nextBar: bar.index, midi: a.midi });
            }
          // Stems & flags for unbeamed notes
          if (el.base >= 2 && el.beam < 0) {
            const g = geo.get(el)!;
            const flags = el.base >= 32 ? 3 : el.base >= 16 ? 2 : el.base >= 8 ? 1 : 0;
            const extra = flags > 1 ? (flags - 1) * 0.7 * S : 0;
            const end = up
              ? Math.min(g.yTop - 3.4 * S - extra, midY)
              : Math.max(g.yBot + 3.4 * S + extra, midY);
            const startY = up ? g.yBot : g.yTop;
            out.push(
              <line
                key={`st${bar.index}-${si}-${el.pos}`}
                x1={g.stemX}
                x2={g.stemX}
                y1={startY}
                y2={end}
                stroke={color ?? 'currentColor'}
                strokeWidth={0.13 * S}
              />,
            );
            if (flags)
              out.push(flagGlyph(g.stemX, end, up, flags, S, `fl${bar.index}-${si}-${el.pos}`, color));
          }
        }

        // Beams
        const groups = new Map<number, El[]>();
        for (const el of els) if (el.beam >= 0) groups.set(el.beam, [...(groups.get(el.beam) ?? []), el]);
        for (const [gid, g] of groups) {
          const gs = g.map((e) => ({ e, ...geo.get(e)! }));
          const up = gs[0].up;
          const d = up ? 1 : -1; // beams stack toward the noteheads
          const levels = Math.max(...g.map((e) => (e.base >= 32 ? 3 : e.base >= 16 ? 2 : 1)));
          const minStem = 2.6 * S + (levels - 1) * 0.75 * S;
          const ideal = gs.map((q) =>
            up ? Math.min(q.yTop - 3.4 * S, midY) : Math.max(q.yBot + 3.4 * S, midY),
          );
          const xFirst = gs[0].stemX;
          const xLast = gs[gs.length - 1].stemX;
          const span = Math.max(1, xLast - xFirst);
          const first = gs[0].e.heads.reduce((a, h) => a + h.pos, 0) / gs[0].e.heads.length;
          const last =
            gs[gs.length - 1].e.heads.reduce((a, h) => a + h.pos, 0) / gs[gs.length - 1].e.heads.length;
          const inner = gs
            .slice(1, -1)
            .map((q) => q.e.heads.reduce((a, h) => a + h.pos, 0) / q.e.heads.length);
          const monotonic = inner.every((p) =>
            last >= first
              ? p >= Math.min(first, last) && p <= Math.max(first, last)
              : p <= Math.max(first, last) && p >= Math.min(first, last),
          );
          let slope = monotonic ? (ideal[ideal.length - 1] - ideal[0]) / span : 0;
          slope = Math.max(-S / span, Math.min(S / span, slope));
          let b0 = ideal[0];
          const at = (x: number) => b0 + slope * (x - xFirst);
          let fix = 0;
          for (const q of gs) {
            const by = at(q.stemX);
            if (up) fix = Math.max(fix, by - (q.yTop - minStem));
            else fix = Math.max(fix, q.yBot + minStem - by);
          }
          b0 += up ? -fix : fix;
          const anyLow = g.some((e) => e.conf !== undefined && e.conf < lowConf);
          const beamColor = anyLow ? 'var(--warning)' : 'currentColor';
          for (const q of gs) {
            const startY = up ? q.yBot : q.yTop;
            beamsOut.push(
              <line
                key={`bst${bar.index}-${si}-${gid}-${q.e.pos}`}
                x1={q.stemX}
                x2={q.stemX}
                y1={startY}
                y2={at(q.stemX)}
                stroke={beamColor}
                strokeWidth={0.13 * S}
              />,
            );
          }
          const thick = 0.5 * S;
          const beamPoly = (xa: number, xb: number, off: number, key2: string) => {
            const ya = at(xa) + d * off;
            const yb = at(xb) + d * off;
            beamsOut.push(
              <path
                key={key2}
                d={`M${xa} ${ya}L${xb} ${yb}L${xb} ${yb + d * thick}L${xa} ${ya + d * thick}Z`}
                fill={beamColor}
              />,
            );
          };
          beamPoly(xFirst - 0.06 * S, xLast + 0.06 * S, 0, `bm${bar.index}-${si}-${gid}`);
          for (let lv = 2; lv <= levels; lv++) {
            const need = lv === 2 ? 16 : 32;
            let i = 0;
            while (i < gs.length) {
              if (gs[i].e.base < need) {
                i++;
                continue;
              }
              let j = i;
              while (j + 1 < gs.length && gs[j + 1].e.base >= need) j++;
              const off = (lv - 1) * 0.75 * S;
              if (j > i)
                beamPoly(
                  gs[i].stemX - 0.06 * S,
                  gs[j].stemX + 0.06 * S,
                  off,
                  `bm${bar.index}-${si}-${gid}-${lv}-${i}`,
                );
              else {
                const stub = 1.1 * S;
                const left = i === gs.length - 1 || (i > 0 && gs[i - 1].e.t > gs[i].e.t);
                beamPoly(
                  left ? gs[i].stemX - stub : gs[i].stemX,
                  left ? gs[i].stemX : gs[i].stemX + stub,
                  off,
                  `bm${bar.index}-${si}-${gid}-${lv}-${i}s`,
                );
              }
              i = j + 1;
            }
          }
        }
      });

      // Bar line
      const isLast = bar.index === bars.length - 1;
      const by0 = staffTops[0];
      const by1 = staffTops[staffTops.length - 1] + 4 * S;
      bx += bw;
      if (isLast && model.shownBars >= model.totalBars) {
        out.push(
          <line
            key={`blt${bar.index}`}
            x1={bx - 0.55 * S}
            x2={bx - 0.55 * S}
            y1={by0}
            y2={by1}
            stroke="currentColor"
            strokeWidth={0.13 * S}
          />,
        );
        out.push(
          <rect
            key={`blk${bar.index}`}
            x={bx - 0.45 * S}
            y={by0}
            width={0.45 * S}
            height={by1 - by0}
            fill="currentColor"
          />,
        );
      } else {
        out.push(
          <line
            key={`bl${bar.index}`}
            x1={bx}
            x2={bx}
            y1={by0}
            y2={by1}
            stroke={lineColor}
            strokeWidth={0.13 * S}
          />,
        );
      }
    });
    sysY += vert.height;
  });

  // Ties (resolved after all heads are placed so they can cross bars and systems).
  const ties: ReactNode[] = [];
  tieAnchors.forEach((t, i) => {
    const target = t.nextEl ? anchorByEl.get(t.nextEl)?.find((a) => a.midi === t.midi) : undefined;
    const dir = t.from.stemUp ? 1 : -1;
    const arc = (xa: number, ya: number, xb: number, yb: number, key2: string) => {
      const dx = xb - xa;
      if (dx <= 0.5) return;
      const h = Math.min(1.5 * S, 0.45 * S + dx * 0.08);
      const th = 0.22 * S;
      ties.push(
        <path
          key={key2}
          d={`M${xa} ${ya}C${xa + dx * 0.25} ${ya + dir * h} ${xb - dx * 0.25} ${yb + dir * h} ${xb} ${yb}C${xb - dx * 0.25} ${yb + dir * (h - th)} ${xa + dx * 0.25} ${ya + dir * (h - th)} ${xa} ${ya}Z`}
          fill="currentColor"
        />,
      );
    };
    const ya = t.from.y + dir * 0.55 * S;
    if (target && target.system === t.from.system)
      arc(t.from.x + t.from.rx * 0.6, ya, target.x - target.rx * 0.6, target.y + dir * 0.55 * S, `tie${i}`);
    else {
      const edge = systemEdges[t.from.system];
      arc(t.from.x + t.from.rx * 0.6, ya, Math.min(edge.x1 - 0.2 * S, t.from.x + 3 * S), ya, `tie${i}a`);
      if (target)
        arc(
          Math.max(target.x - 3 * S, leftMargin + header(false) - 0.6 * S),
          target.y + dir * 0.55 * S,
          target.x - target.rx * 0.6,
          target.y + dir * 0.55 * S,
          `tie${i}b`,
        );
    }
  });

  const height = Math.ceil(sysY + 2);
  const truncated = model.totalBars > model.shownBars;
  return (
    <svg
      width={W}
      height={height}
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={props.ariaLabel ?? `Notation preview, ${model.shownBars} bars`}
      data-testid="notation"
      style={{ display: 'block', color: 'var(--text)', overflow: 'visible' }}
    >
      {out}
      {beamsOut}
      {ties}
      {truncated && (
        <text x={W - 4} y={height - 4} textAnchor="end" fontSize={1.2 * S} fill="var(--text-dim)">
          + {model.totalBars - model.shownBars} more bars
        </text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Drums: step grid
// ---------------------------------------------------------------------------------------------

const DRUM_ROWS: { pitches: number[]; label: string }[] = [
  { pitches: [49, 57, 55, 52], label: 'Crash' },
  { pitches: [51, 59, 53], label: 'Ride' },
  { pitches: [46], label: 'Open hat' },
  { pitches: [42, 44], label: 'Hi-hat' },
  { pitches: [50, 48], label: 'High tom' },
  { pitches: [47, 45], label: 'Mid tom' },
  { pitches: [43, 41], label: 'Floor tom' },
  { pitches: [38, 40], label: 'Snare' },
  { pitches: [37], label: 'Side stick' },
  { pitches: [39], label: 'Clap' },
  { pitches: [54, 82, 70, 69], label: 'Shaker' },
  { pitches: [56, 75, 76, 77], label: 'Perc' },
  { pitches: [36, 35], label: 'Kick' },
];

function drumRowFor(pitch: number): number {
  const i = DRUM_ROWS.findIndex((r) => r.pitches.includes(pitch));
  return i >= 0 ? i : DRUM_ROWS.length - 2;
}

function DrumGrid(props: NotationPreviewProps & { width: number }) {
  const ppq = props.ppq ?? 480;
  const meter = props.meter ?? { numerator: 4, denominator: 4 };
  const m = meterInfo(meter, ppq);
  const startTick = props.startTick ?? 0;
  const lowConf = props.lowConfidence ?? 0.6;
  const steps = Math.max(1, Math.round(m.barLen / m.grid));
  const rel = props.notes.filter((n) => n.tick >= startTick).map((n) => ({ ...n, tick: n.tick - startTick }));
  const lastEnd = rel.reduce((mx, n) => Math.max(mx, n.tick + 1), 0);
  const totalBars = props.bars ?? Math.max(1, Math.ceil(lastEnd / m.barLen));
  const shown = Math.max(1, Math.min(totalBars, props.maxBars ?? totalBars));
  const rowsUsed = [...new Set(rel.map((n) => drumRowFor(n.pitch)))].sort((a, b) => a - b);
  const rows = rowsUsed.length ? rowsUsed : [7, 12];
  const labelW = 62;
  const W = props.width;
  const minCell = 13;
  const barsPerLine = Math.max(1, Math.min(shown, Math.floor((W - labelW - 4) / (steps * minCell))));
  const cell = Math.min(24, (W - labelW - 4) / (barsPerLine * steps));
  const rowH = Math.max(13, Math.min(17, cell));
  const lines = Math.ceil(shown / barsPerLine);
  const lineH = rows.length * rowH + 22;
  const height = lines * lineH + 4;
  const hits = new Map<string, { vel: number; conf?: number }>();
  for (const n of rel) {
    const step = Math.round(n.tick / m.grid);
    const bar = Math.floor(step / steps);
    if (bar >= shown) continue;
    const k = `${drumRowFor(n.pitch)}:${step}`;
    const prev = hits.get(k);
    if (!prev || prev.vel < n.velocity!) hits.set(k, { vel: n.velocity ?? 100, conf: n.confidence });
  }
  const out: ReactNode[] = [];
  for (let line = 0; line < lines; line++) {
    const y0 = line * lineH + 16;
    const firstBar = line * barsPerLine;
    const nBars = Math.min(barsPerLine, shown - firstBar);
    rows.forEach((r, ri) => {
      out.push(
        <text
          key={`lbl${line}-${r}`}
          x={labelW - 8}
          y={y0 + ri * rowH + rowH * 0.7}
          fontSize={11}
          textAnchor="end"
          fill="var(--text-muted)"
        >
          {DRUM_ROWS[r].label}
        </text>,
      );
    });
    for (let b = 0; b < nBars; b++) {
      const bar = firstBar + b;
      const bx = labelW + b * steps * cell;
      out.push(
        <text key={`bn${bar}`} x={bx + 2} y={y0 - 5} fontSize={9.5} fill="var(--text-dim)">
          {(props.firstBarNumber ?? 1) + bar}
        </text>,
      );
      for (let s = 0; s < steps; s++) {
        const x = bx + s * cell;
        const onBeat = (s * m.grid) % m.beat === 0;
        rows.forEach((r, ri) => {
          const hit = hits.get(`${r}:${bar * steps + s}`);
          const y = y0 + ri * rowH;
          if (hit) {
            const low = hit.conf !== undefined && hit.conf < lowConf;
            out.push(
              <rect
                key={`h${bar}-${s}-${r}`}
                x={x + 1}
                y={y + 1}
                width={Math.max(2, cell - 2)}
                height={rowH - 2}
                rx={2}
                fill={low ? 'var(--warning)' : 'var(--accent)'}
                opacity={0.35 + (hit.vel / 127) * 0.65}
              />,
            );
          } else {
            out.push(
              <rect
                key={`e${bar}-${s}-${r}`}
                x={x + 1}
                y={y + 1}
                width={Math.max(2, cell - 2)}
                height={rowH - 2}
                rx={2}
                fill={onBeat ? 'var(--bg-elev-3)' : 'var(--bg-input)'}
              />,
            );
          }
        });
      }
      out.push(
        <line
          key={`bl${bar}`}
          x1={bx}
          x2={bx}
          y1={y0 - 2}
          y2={y0 + rows.length * rowH + 2}
          stroke="var(--grid-bar)"
          strokeWidth={1.2}
        />,
      );
    }
  }
  return (
    <svg
      width={W}
      height={height}
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={props.ariaLabel ?? `Drum pattern, ${shown} bars`}
      data-testid="drum-grid"
      style={{ display: 'block' }}
    >
      {out}
      {totalBars > shown && (
        <text x={W - 4} y={height - 2} textAnchor="end" fontSize={10} fill="var(--text-dim)">
          + {totalBars - shown} more bars
        </text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Convenience: notation for one track of a song
// ---------------------------------------------------------------------------------------------

export function SongTrackNotation({
  song,
  trackId,
  maxBars,
  width,
  customInstruments,
  lowConfidence,
}: {
  song: Song;
  trackId: string;
  maxBars?: number;
  width?: number;
  customInstruments?: InstrumentProfile[];
  lowConfidence?: number;
}) {
  const track = song.tracks.find((t) => t.id === trackId) ?? song.tracks[0];
  const chords = useMemo(() => song.chords.map((c) => ({ tick: c.tick, symbol: c.symbol })), [song.chords]);
  if (!track) return null;
  const inst = getInstrument(track.instrumentId, customInstruments);
  const drums = !!inst.isDrumKit || track.role === 'drums' || track.role === 'percussion';
  const meter = song.meterMap[0] ?? { numerator: 4, denominator: 4 };
  const totalBars = song.sections.reduce((a, s) => a + s.bars, 0);
  return (
    <NotationPreview
      notes={track.notes}
      ppq={song.ppq}
      meter={meter}
      keySignature={song.keyMap[0]?.key}
      clef={drums ? 'percussion' : inst.clef}
      transpose={drums ? 0 : (inst.notationTranspose ?? 0)}
      chords={drums ? undefined : chords}
      drums={drums}
      bars={totalBars > 0 ? totalBars : undefined}
      maxBars={maxBars}
      width={width}
      lowConfidence={lowConfidence}
      ariaLabel={`${track.name} notation`}
    />
  );
}
