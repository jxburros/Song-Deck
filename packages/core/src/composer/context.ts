/**
 * Generation context: everything a role generator needs to write one track × section "cell".
 * Randomness is derived per (seed, track, section group) so regenerating one cell never perturbs
 * another, and repeated sections (Chorus 2 → Chorus 1) start from the same musical material.
 */
import type {
  AvoidRule,
  ChordEvent,
  DrumStyle,
  GenreProfile,
  InstrumentProfile,
  KeySignature,
  MacroSettings,
  MusicalFunction,
  Note,
  Section,
  SectionFeel,
  SectionKind,
  Song,
  Track,
  VariationLevel,
  SingerProfile,
  VoiceType,
} from '../ir/types';
import { PPQ } from '../ir/types';
import {
  bpmAtTick,
  keyAtBar,
  meterAtBar,
  sectionLayout,
  tickToBar,
  barToTick,
  type SectionSpan,
} from '../timing';
import { deriveRng, type Rng } from '../util/random';
import { singerForTrack } from '../singers';
import { arrangementFor, isLeadVocal, resolveFunction } from './arrangement';
import { genreForSong } from './tags';
import { getInstrument, instrumentRange } from './instruments';
import {
  barsOfSpan,
  chordsForSpan,
  clamp,
  clamp01,
  effectiveMacros,
  lerp,
  meterInfo,
  sectionGroupId,
  type BarInfo,
  type MeterInfo,
  type PitchRange,
} from './util';

export interface StyleOverrides {
  drumStyle?: DrumStyle;
  /** Section ids that use a half-time feel regardless of the plan. */
  halfTime?: Set<string>;
  /** Preferred accompaniment texture for keys/guitars. */
  accompaniment?: 'arp' | 'block' | 'pulse' | 'sustain' | 'stabs';
  /** −0.3 … +0.3 shift of section energies. */
  energyBias?: number;
  /** −1 … +1 arrangement density bias. */
  densityBias?: number;
  /** Rhythm-guitar / accompaniment subdivision preference. */
  subdivision?: 8 | 16;
}

export interface GenSettings {
  seed: number;
  /** Seed for arrangement tie-breaks (defaults to the song's composition seed). */
  arrangementSeed?: number;
  level?: VariationLevel;
  customInstruments?: InstrumentProfile[];
  customGenres?: GenreProfile[];
  overrides?: StyleOverrides;
}

export interface SongGen {
  song: Song;
  settings: GenSettings;
  spans: SectionSpan[];
  genre: GenreProfile;
  arrangement: Record<string, string[]>;
  drumStyle: DrumStyle;
  songEnd: number;
  principalMelodyId?: string;
  instrumentOf(track: Track): InstrumentProfile;
  plays(trackId: string, sectionId: string): boolean;
}

export const VOICE_RANGES: Record<VoiceType, PitchRange> = {
  soprano: { low: 60, high: 84, comfortableLow: 62, comfortableHigh: 79 },
  mezzo: { low: 57, high: 81, comfortableLow: 59, comfortableHigh: 76 },
  alto: { low: 53, high: 74, comfortableLow: 55, comfortableHigh: 72 },
  tenor: { low: 48, high: 72, comfortableLow: 50, comfortableHigh: 69 },
  baritone: { low: 45, high: 65, comfortableLow: 47, comfortableHigh: 62 },
  bass: { low: 40, high: 64, comfortableLow: 43, comfortableHigh: 60 },
};

function resolveDrumStyle(genre: GenreProfile, song: Song): DrumStyle {
  const d = genre.rhythm.drumStyle;
  if (d === 'hip-hop') {
    const styles = (song.blueprint?.styles ?? []).join(' ').toLowerCase();
    if (styles.includes('trap') || bpmAtTick(song, 0) >= 125) return 'trap';
  }
  return d;
}

export function buildSongGen(song: Song, settings: GenSettings): SongGen {
  const genre = genreForSong(song, settings.customGenres);
  const cache = new Map<string, InstrumentProfile>();
  const instrumentOf = (t: Track): InstrumentProfile => {
    let p = cache.get(t.instrumentId);
    if (!p) {
      p = getInstrument(t.instrumentId, settings.customInstruments);
      cache.set(t.instrumentId, p);
    }
    return p;
  };
  const spans = sectionLayout(song);
  const arrangement = arrangementFor(song, {
    seed: settings.arrangementSeed ?? song.generation?.seed ?? settings.seed,
    genre,
    instrumentOf,
    densityBias: settings.overrides?.densityBias,
  });
  const sets = new Map(Object.entries(arrangement).map(([k, v]) => [k, new Set(v)]));
  const midi = song.tracks.filter((t) => t.kind === 'midi');
  const lead =
    midi.find((t) => isLeadVocal(t, instrumentOf(t))) ??
    midi.find((t) => resolveFunction(t, instrumentOf(t)) === 'melody');
  return {
    song,
    settings,
    spans,
    genre,
    arrangement,
    drumStyle: settings.overrides?.drumStyle ?? resolveDrumStyle(genre, song),
    songEnd: spans.length ? spans[spans.length - 1].endTick : 0,
    principalMelodyId: lead?.id,
    instrumentOf,
    plays: (trackId, sectionId) => sets.get(trackId)?.has(sectionId) ?? false,
  };
}

export interface Cell {
  g: SongGen;
  song: Song;
  track: Track;
  inst: InstrumentProfile;
  fn: MusicalFunction;
  span: SectionSpan;
  section: Section;
  kind: SectionKind;
  index: number;
  prev?: SectionSpan;
  next?: SectionSpan;
  key: KeySignature;
  chords: ChordEvent[];
  bars: BarInfo[];
  /** Meter at the section's first bar. */
  meter: MeterInfo;
  macros: MacroSettings;
  range: PitchRange;
  avoid: Set<AvoidRule>;
  /** Energy 0..1 at the start / end of the section (plan energy shifted by the energy macro). */
  e0: number;
  e1: number;
  intensity: number;
  energyAt(tick: number): number;
  /** Content randomness (shared by repeats of the same section group). */
  rng: Rng;
  /** Section-specific randomness (fills, transitions, repeat variations). */
  vrng: Rng;
  groupId: string;
  isRepeat: boolean;
  /** Bars of the group's first section (repeats longer than it cycle its content). */
  rootBars: number;
  /** Index/count among tracks with the same role & instrument (L/R doubling). */
  roleIndex: number;
  roleCount: number;
  feel: SectionFeel;
  bpm: number;
  swing8: number;
  swing16: number;
  meterAt(tick: number): { meter: MeterInfo; barStart: number };
  /** Principal melody notes (lead vocal or melody instrument) inside this section. */
  melodyNotes(): Note[];
  /** Kick-drum onsets of drum tracks playing in this section. */
  kickTicks(): number[];
  /** Whether any track with this role plays in the section. */
  rolePlays(role: Track['role']): boolean;
  isLast: boolean;
}

function trackRange(
  track: Track,
  inst: InstrumentProfile,
  voiceType?: VoiceType,
  singer?: SingerProfile,
): PitchRange {
  const ir = instrumentRange(inst);
  let base = ir;
  if (singer) {
    // A real singer: write inside their full voice, mostly in the easy zone (falsetto is left to
    // the user).
    base = {
      low: singer.lowest,
      high: singer.highest,
      comfortableLow: singer.comfortableLow,
      comfortableHigh: singer.comfortableHigh,
    };
  } else if (track.role === 'vocal' && inst.id !== 'choir') {
    // The singer's tessitura, kept inside the instrument profile's absolute range.
    const v = VOICE_RANGES[voiceType ?? 'tenor'] ?? ir;
    const low = Math.max(v.low, ir.low);
    const high = Math.min(v.high, ir.high);
    if (high - low >= 12)
      base = {
        low,
        high,
        comfortableLow: clamp(v.comfortableLow, low, high),
        comfortableHigh: clamp(v.comfortableHigh, low, high),
      };
  }
  const r: PitchRange = { ...base };
  const c = track.constraints ?? {};
  if (c.lowest !== undefined && c.lowest > r.low) r.low = Math.min(c.lowest, r.high);
  if (c.highest !== undefined && c.highest < r.high) r.high = Math.max(c.highest, r.low);
  if (c.avoid?.includes('high-register'))
    r.high = Math.max(r.low + 12, Math.min(r.high, r.comfortableHigh - 3));
  if (c.avoid?.includes('low-register')) r.low = Math.min(r.high - 12, Math.max(r.low, r.comfortableLow + 3));
  r.comfortableLow = clamp(r.comfortableLow, r.low, r.high);
  r.comfortableHigh = clamp(r.comfortableHigh, r.comfortableLow, r.high);
  if (r.comfortableHigh - r.comfortableLow < 7) {
    r.comfortableLow = r.low;
    r.comfortableHigh = r.high;
  }
  return r;
}

export function makeCell(g: SongGen, track: Track, spanIndex: number, seed: number): Cell {
  const song = g.song;
  const span = g.spans[spanIndex];
  const section = span.section;
  const inst = g.instrumentOf(track);
  const fn = resolveFunction(track, inst);
  const key = keyAtBar(song, span.startBar);
  const chords = chordsForSpan(song, span, key);
  const bars = barsOfSpan(song, span);
  const meter = bars[0]?.meter ?? meterInfo(meterAtBar(song, span.startBar), song.ppq);
  const macros = effectiveMacros(song, track);
  const bias = g.settings.overrides?.energyBias ?? 0;
  const shift = (macros.energy - 0.5) * 0.3 + bias;
  const e0 = clamp01((section.energy ?? 50) / 100 + shift);
  const e1 = clamp01((section.energyEnd ?? section.energy ?? 50) / 100 + shift);
  const groupId = sectionGroupId(song, section);
  const root = song.sections.find((s) => s.id === groupId);
  const sameRole = song.tracks.filter(
    (t) => t.kind === 'midi' && t.role === track.role && t.instrumentId === track.instrumentId,
  );
  const roleIndex = Math.max(
    0,
    sameRole.findIndex((t) => t.id === track.id),
  );
  const half = g.settings.overrides?.halfTime?.has(section.id);
  const feel: SectionFeel = half ? 'half-time' : (section.feel ?? 'normal');
  const swing = clamp01(g.genre.rhythm.swing);
  const sub = g.genre.rhythm.subdivision;
  const len = Math.max(1, span.endTick - span.startTick);
  const meterCache = new Map<number, { meter: MeterInfo; barStart: number }>();
  const cell: Cell = {
    g,
    song,
    track,
    inst,
    fn,
    span,
    section,
    kind: section.kind,
    index: spanIndex,
    prev: g.spans[spanIndex - 1],
    next: g.spans[spanIndex + 1],
    key,
    chords,
    bars,
    meter,
    macros,
    range: trackRange(track, inst, track.vocal?.voiceType, singerForTrack(song, track)),
    avoid: new Set(track.constraints?.avoid ?? []),
    e0,
    e1,
    intensity: (e0 + e1) / 2,
    energyAt: (tick: number) => lerp(e0, e1, clamp01((tick - span.startTick) / len)),
    rng: deriveRng(seed, 'gen', track.id, groupId),
    vrng: deriveRng(seed, 'gen', track.id, section.id, 'v'),
    groupId,
    isRepeat: groupId !== section.id,
    rootBars: Math.max(1, root?.bars ?? section.bars),
    roleIndex,
    roleCount: sameRole.length,
    feel,
    bpm: bpmAtTick(song, span.startTick),
    swing8: sub === 16 ? 0 : swing,
    swing16: sub === 16 ? swing : 0,
    meterAt: (tick: number) => {
      const b = tickToBar(song, tick).bar;
      let m = meterCache.get(b);
      if (!m) {
        m = { meter: meterInfo(meterAtBar(song, b), song.ppq), barStart: barToTick(song, b) };
        meterCache.set(b, m);
      }
      return m;
    },
    melodyNotes: () => {
      const id = g.principalMelodyId;
      if (!id || id === track.id || !g.plays(id, section.id)) return [];
      const t = song.tracks.find((x) => x.id === id);
      return t ? t.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick) : [];
    },
    kickTicks: () => {
      const out = new Set<number>();
      for (const t of song.tracks) {
        if (t.kind !== 'midi' || t.role !== 'drums' || !g.plays(t.id, section.id)) continue;
        for (const n of t.notes)
          if ((n.pitch === 36 || n.pitch === 35) && n.tick >= span.startTick && n.tick < span.endTick)
            out.add(n.tick);
      }
      return [...out].sort((a, b) => a - b);
    },
    rolePlays: (role) =>
      song.tracks.some((t) => t.kind === 'midi' && t.role === role && g.plays(t.id, section.id)),
    isLast: spanIndex === g.spans.length - 1,
  };
  return cell;
}

/** Ticks per felt beat at a tick (convenience). */
export function beatAt(c: Cell, tick: number): number {
  return c.meterAt(tick).meter.beatTicks;
}

export const QUARTER = PPQ;
export const EIGHTH = PPQ / 2;
export const SIXTEENTH = PPQ / 4;
