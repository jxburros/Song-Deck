/**
 * Internal helpers shared by the composer modules. Nothing here is exported from the package.
 */
import type {
  Articulation,
  ChordEvent,
  ChordQuality,
  KeySignature,
  MacroSettings,
  Note,
  Section,
  Song,
  Track,
  VocalExpression,
} from '../ir/types';
import { PPQ } from '../ir/types';
import { defaultMacros } from '../ir/defaults';
import { barToTick, meterAtBar, type SectionSpan } from '../timing';
import { chordToRoman, romanToChord } from '../theory/roman';
import { formatChordSymbol, parseChordSymbol } from '../theory/chords';
import { mod12 } from '../theory/pitch';
import { isMinorMode } from '../theory/scales';
import type { Rng } from '../util/random';
import { applyTagsToMacros, songTags } from './tags';

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(Number.isFinite(v) ? v : 0, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function toVelocity(v: number): number {
  if (!Number.isFinite(v)) return 64;
  return clamp(Math.round(v), 1, 127);
}

/** Weighted average of numbers (ignores non-finite values). */
export function weightedAverage(pairs: readonly [number, number][]): number {
  let s = 0;
  let w = 0;
  for (const [v, wt] of pairs) {
    if (!Number.isFinite(v) || !(wt > 0)) continue;
    s += v * wt;
    w += wt;
  }
  return w > 0 ? s / w : 0;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Raw notes (before ids are assigned)
// ---------------------------------------------------------------------------

export interface RawNote {
  pitch: number;
  tick: number;
  duration: number;
  velocity: number;
  articulation?: Articulation;
  motifId?: string;
  phraseId?: string;
  syllable?: string;
  lyricLineId?: string;
  expression?: VocalExpression;
}

export interface PitchRange {
  low: number;
  high: number;
  comfortableLow: number;
  comfortableHigh: number;
}

/** Fold a pitch into a range by octaves (clamps when the range is narrower than an octave). */
export function fitToRange(pitch: number, low: number, high: number): number {
  let p = Math.round(pitch);
  if (high - low < 12) return clamp(p, low, high);
  while (p < low) p += 12;
  while (p > high) p -= 12;
  return p;
}

export interface FinalizeOptions {
  low: number;
  high: number;
  start: number;
  end: number;
  mono?: boolean;
  drum?: boolean;
}

/**
 * Make raw generator output valid: integer ticks inside [start, end), durations clipped to the
 * section end, pitches folded into the playable range, velocities 1..127, no duplicates, and
 * no overlaps for monophonic instruments.
 */
export function finalizeNotes(raw: RawNote[], opts: FinalizeOptions): RawNote[] {
  const out: RawNote[] = [];
  for (const n of raw) {
    if (!Number.isFinite(n.tick) || !Number.isFinite(n.pitch) || !Number.isFinite(n.duration)) continue;
    const tick = Math.round(n.tick);
    if (tick < opts.start || tick >= opts.end) continue;
    let pitch = Math.round(n.pitch);
    if (opts.drum) {
      if (pitch < 0 || pitch > 127) continue;
    } else {
      if (pitch < opts.low || pitch > opts.high) pitch = fitToRange(pitch, opts.low, opts.high);
      if (pitch < opts.low || pitch > opts.high || pitch < 0 || pitch > 127) continue;
    }
    const duration = clamp(Math.round(n.duration), 1, opts.end - tick);
    if (!opts.drum && duration < 24) continue;
    out.push({ ...n, tick, pitch, duration, velocity: toVelocity(n.velocity) });
  }
  out.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch || b.velocity - a.velocity);
  // Dedupe identical (tick, pitch).
  const dedup: RawNote[] = [];
  for (const n of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.tick === n.tick && prev.pitch === n.pitch) continue;
    dedup.push(n);
  }
  if (opts.mono) {
    const mono: RawNote[] = [];
    for (const n of dedup) {
      const prev = mono[mono.length - 1];
      // Attacks closer than a 64th: keep the first.
      if (prev && n.tick - prev.tick < 24) continue;
      if (prev && prev.tick + prev.duration > n.tick) prev.duration = Math.max(1, n.tick - prev.tick);
      mono.push(n);
    }
    return mono;
  }
  // Polyphonic (and drums): a sounding note must not overlap the next attack of the same pitch,
  // or MIDI note-offs become ambiguous.
  const lastByPitch = new Map<number, RawNote>();
  for (const n of dedup) {
    const prev = lastByPitch.get(n.pitch);
    if (prev && prev.tick + prev.duration > n.tick) prev.duration = Math.max(1, n.tick - prev.tick);
    lastByPitch.set(n.pitch, n);
  }
  return dedup;
}

/** Deterministic timing/velocity jitter ("Mechanical ↔ Loose"). Notes never leave [start, end). */
export function humanize(
  notes: RawNote[],
  amount: number,
  rng: Rng,
  opts: { start: number; end: number; maxTicks: number; maxVelocity: number },
): void {
  const a = clamp01(amount);
  if (a <= 0) return;
  for (const n of notes) {
    const dt = Math.round(clamp(rng.gaussian(0, 0.5), -1, 1) * a * opts.maxTicks);
    const dv = Math.round(clamp(rng.gaussian(0, 0.5), -1, 1) * a * opts.maxVelocity);
    const t = clamp(n.tick + dt, opts.start, opts.end - 1);
    if (t !== n.tick) {
      n.duration = Math.max(1, n.duration - (t - n.tick));
      n.tick = t;
    }
    n.velocity = toVelocity(n.velocity + dv);
  }
}

/** Swing: remap a position inside each `unit` (quarter for 8th swing, 8th for 16th swing). */
export function applySwing(offset: number, unit: number, swing: number): number {
  if (swing <= 0 || unit <= 0) return offset;
  const base = Math.floor(offset / unit) * unit;
  const p = offset - base;
  const half = unit / 2;
  const split = half + clamp01(swing) * (unit / 6);
  const mapped = p < half ? p * (split / half) : split + (p - half) * ((unit - split) / half);
  return Math.round(base + mapped);
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

export interface MeterInfo {
  numerator: number;
  denominator: number;
  barTicks: number;
  /** One notated beat unit (quarter in x/4, eighth in x/8). */
  unitTicks: number;
  /** Felt beats as offsets within the bar (dotted quarters in compound meters). */
  beats: number[];
  /** Group starts (strong beats). */
  strong: number[];
  /** Typical felt-beat length. */
  beatTicks: number;
  compound: boolean;
  /** 4/4 or 2/2: the 16-step drum template grid applies. */
  common: boolean;
  /** 16th-note grid. */
  stepTicks: number;
  steps: number;
}

/** Beat grouping in notated units: 4/4 → [2,2], 6/8 → [3,3], 7/8 → [2,2,3], 5/4 → [3,2]. */
export function unitGroups(num: number, den: number): number[] {
  if (num <= 0) return [1];
  if (den >= 8 && num % 3 === 0 && num >= 6) return Array.from({ length: num / 3 }, () => 3);
  if (num <= 3) return [num];
  if (num === 4) return [2, 2];
  if (num === 5) return [3, 2];
  if (den <= 4 && num === 6) return [3, 3];
  if (den <= 4 && num === 7) return [4, 3];
  if (den <= 4 && num === 8) return [4, 4];
  const groups: number[] = [];
  let rest = num;
  while (rest > 0) {
    if (rest === 3) {
      groups.push(3);
      rest = 0;
    } else {
      groups.push(2);
      rest -= 2;
    }
  }
  return groups;
}

export function meterInfo(meter: { numerator: number; denominator: number }, ppq = PPQ): MeterInfo {
  const num = Math.max(1, Math.round(meter.numerator || 4));
  const den = [1, 2, 4, 8, 16, 32].includes(meter.denominator) ? meter.denominator : 4;
  const unitTicks = (ppq * 4) / den;
  const barTicks = num * unitTicks;
  const groups = unitGroups(num, den);
  const compound = den >= 8 && num % 3 === 0 && num >= 6;
  const strong: number[] = [];
  let acc = 0;
  for (const g of groups) {
    strong.push(acc * unitTicks);
    acc += g;
  }
  const beats = den <= 4 ? Array.from({ length: num }, (_, i) => i * unitTicks) : strong.slice();
  const beatTicks = den <= 4 ? unitTicks : compound ? unitTicks * 3 : unitTicks * 2;
  const stepTicks = ppq / 4;
  return {
    numerator: num,
    denominator: den,
    barTicks,
    unitTicks,
    beats,
    strong,
    beatTicks,
    compound,
    common: (num === 4 && den === 4) || (num === 2 && den === 2),
    stepTicks,
    steps: Math.max(1, Math.round(barTicks / stepTicks)),
  };
}

/** Metric strength of an offset within a bar (1 = downbeat … 0.15 = off-grid). */
export function metricWeight(offset: number, m: MeterInfo): number {
  const o = ((offset % m.barTicks) + m.barTicks) % m.barTicks;
  if (o === 0) return 1;
  if (m.strong.includes(o)) return 0.9;
  if (m.beats.includes(o)) return 0.75;
  const eighth =
    m.compound || m.denominator >= 8 ? m.unitTicks * (m.denominator >= 16 ? 2 : 1) : m.beatTicks / 2;
  if (eighth > 0 && o % eighth === 0) return 0.5;
  if (o % m.stepTicks === 0) return 0.3;
  return 0.15;
}

export interface BarInfo {
  /** 0-based absolute bar. */
  bar: number;
  /** Index of the bar inside its section. */
  index: number;
  tick: number;
  meter: MeterInfo;
}

export function barsOfSpan(song: Pick<Song, 'ppq' | 'meterMap' | 'tempoMap'>, span: SectionSpan): BarInfo[] {
  const out: BarInfo[] = [];
  for (let b = span.startBar; b < span.endBar; b++) {
    const m = meterAtBar(song, b);
    out.push({ bar: b, index: b - span.startBar, tick: barToTick(song, b), meter: meterInfo(m, song.ppq) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Harmony helpers
// ---------------------------------------------------------------------------

export function tonicChordSpec(key: KeySignature): { root: number; quality: ChordQuality } {
  return { root: key.tonic, quality: isMinorMode(key.mode) ? 'min' : 'maj' };
}

/** Chords covering a section, clipped to it, with gaps filled by the tonic chord. */
export function chordsForSpan(
  song: Pick<Song, 'chords'>,
  span: { startTick: number; endTick: number },
  key: KeySignature,
): ChordEvent[] {
  const evs = song.chords
    .filter((c) => c.tick < span.endTick && c.tick + c.duration > span.startTick)
    .sort((a, b) => a.tick - b.tick);
  const tonic = tonicChordSpec(key);
  const filler = (tick: number, duration: number): ChordEvent => ({
    id: `tonic@${tick}`,
    tick,
    duration,
    ...tonic,
    symbol: formatChordSymbol(tonic, key),
    roman: isMinorMode(key.mode) ? 'i' : 'I',
  });
  const out: ChordEvent[] = [];
  let cursor = span.startTick;
  for (const c of evs) {
    const s = Math.max(c.tick, span.startTick);
    const e = Math.min(c.tick + c.duration, span.endTick);
    if (e <= cursor) continue;
    if (s > cursor) out.push(filler(cursor, s - cursor));
    const s2 = Math.max(s, cursor);
    out.push({ ...c, tick: s2, duration: e - s2 });
    cursor = e;
  }
  if (cursor < span.endTick) out.push(filler(cursor, span.endTick - cursor));
  return out;
}

export function chordAtIn(chords: readonly ChordEvent[], tick: number): ChordEvent {
  for (let i = chords.length - 1; i >= 0; i--) if (chords[i].tick <= tick) return chords[i];
  return chords[0];
}

/** Parse a chord symbol or roman numeral relative to a key. */
export function parseHarmonyToken(
  token: string,
  key: KeySignature,
): { root: number; quality: ChordQuality; bass?: number } | null {
  const t = token.trim();
  if (!t) return null;
  // Roman numerals first when the token looks like one (I, ii, bVII, V/V…), else a chord symbol.
  if (/^(b|#|♭|♯)?(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(?![a-z])/.test(t) || /^(b|#)?[ivIV]+/.test(t)) {
    const r = romanToChord(t, key);
    if (r) return r;
  }
  return parseChordSymbol(t) ?? romanToChord(t, key);
}

export function chordSymbolIn(
  spec: { root: number; quality: ChordQuality; bass?: number },
  key: KeySignature,
): string {
  return formatChordSymbol(spec, key);
}

export function romanIn(
  spec: { root: number; quality: ChordQuality; bass?: number },
  key: KeySignature,
): string {
  return chordToRoman(spec, key);
}

/** Same chord (root, quality, bass). */
export function sameChord(
  a: { root: number; quality: string; bass?: number },
  b: { root: number; quality: string; bass?: number },
): boolean {
  return a.root === b.root && a.quality === b.quality && (a.bass ?? a.root) === (b.bass ?? b.root);
}

export function pcDistance(a: number, b: number): number {
  const d = mod12(a - b);
  return Math.min(d, 12 - d);
}

// ---------------------------------------------------------------------------
// Song helpers
// ---------------------------------------------------------------------------

/** Root of a repeat chain (Chorus 2 → Chorus 1). Guards against cycles. */
export function sectionGroupId(song: Pick<Song, 'sections'>, section: Section): string {
  let cur: Section = section;
  const seen = new Set<string>([cur.id]);
  while (cur.repeatOf) {
    const next = song.sections.find((s) => s.id === cur.repeatOf);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    cur = next;
  }
  return cur.id;
}

const COMPLEXITY_VALUE: Record<string, number> = { low: 0.2, medium: 0.5, high: 0.85 };

/**
 * Song macros (the user's base) + the song's tag deltas ← track overrides ← constraints
 * (complexity, avoid syncopation). Tag deltas are applied here, at generation time, and never
 * stored in `song.macros`.
 */
export function effectiveMacros(
  song: Pick<Song, 'macros'> & Partial<Pick<Song, 'tags' | 'blueprint'>>,
  track?: Track,
): MacroSettings {
  const base = applyTagsToMacros({ ...defaultMacros(), ...(song.macros ?? {}) }, songTags(song));
  const m: MacroSettings = { ...base, ...(track?.macros ?? {}) };
  if (track?.constraints?.complexity)
    m.complexity = COMPLEXITY_VALUE[track.constraints.complexity] ?? m.complexity;
  if (track?.constraints?.avoid?.includes('syncopation')) m.syncopation = Math.min(m.syncopation, 0.05);
  for (const k of Object.keys(m) as (keyof MacroSettings)[]) m[k] = clamp01(m[k]);
  return m;
}

export function notesInSpan(track: Pick<Track, 'notes'>, start: number, end: number): Note[] {
  return track.notes.filter((n) => n.tick >= start && n.tick < end);
}

/** Simple stable hash → [0, 1). */
export function unitHash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Remove same-pitch overlaps from a track's notes (sorted). Earlier notes that are free get
 * shortened; a note overlapping a protected earlier note is either dropped (`drop`) or moved to
 * start when the protected one ends (`shift`). Protected notes are never modified.
 */
export function resolveSamePitchOverlaps<
  T extends { id: string; pitch: number; tick: number; duration: number },
>(notes: T[], isProtected: (n: T) => boolean, mode: 'drop' | 'shift', limit = Infinity): T[] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const last = new Map<number, T>();
  const out: T[] = [];
  for (const n0 of sorted) {
    let n = n0;
    const prev = last.get(n.pitch);
    if (prev && prev.tick + prev.duration > n.tick) {
      if (!isProtected(prev) && n.tick > prev.tick) {
        prev.duration = Math.max(1, n.tick - prev.tick);
      } else if (!isProtected(n)) {
        if (mode === 'drop') continue;
        const delta = prev.tick + prev.duration - n.tick;
        if (n.duration - delta < 1 || prev.tick + prev.duration >= limit) continue;
        n = { ...n, tick: n.tick + delta, duration: n.duration - delta };
      }
    }
    last.set(n.pitch, n);
    out.push(n);
  }
  return out.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch || a.id.localeCompare(b.id));
}
