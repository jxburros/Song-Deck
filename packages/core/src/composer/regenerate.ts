/**
 * "Regenerate unlocked material" (spec §22) and selective regeneration (§39).
 *
 * Guarantee: song-level locks (tempo, key, meter, structure, chords, lyrics, motifs), track locks,
 * track×section locks, section locks, chords:section locks and note-level locks leave the locked
 * material byte-identical. With a region only notes lying entirely inside it change.
 */
import type {
  ChordEvent,
  ChordSpec,
  DrumStyle,
  GenreProfile,
  InstrumentProfile,
  Song,
  Track,
  VariationLevel,
} from '../ir/types';
import { cloneSong } from '../ir/song-utils';
import { IdFactory } from '../util/ids';
import { deriveRng } from '../util/random';
import { LockKeys, isChordSectionLocked, isLocked, isNoteLocked } from '../locks';
import { keyAtTick, sectionLayout } from '../timing';
import { chordFunction } from '../theory/analysis';
import { diatonicChord, formatChordSymbol } from '../theory/chords';
import { chordDegree, chordToRoman } from '../theory/roman';
import { buildSongGen, type StyleOverrides } from './context';
import { writeCells, type CellChange } from './engine';
import { genreForBlend } from './genres';
import { chooseProgression, colorProgression, expandHarmony, flavorFor, moodDarkness, snapHarmonicRhythm, type PlannedHarmony } from './harmony';
import { buildSongMotifs } from './motifs';
import { ornamentSong } from './ornament';
import { harmonyGroupOf, type HarmonyGroup } from './planner';
import { chordsForPlanSection } from './structure';
import { effectiveMacros, meterInfo, unitHash } from './util';

export interface RegenerateOptions {
  seed?: number;
  trackIds?: string[];
  sectionIds?: string[];
  startTick?: number;
  endTick?: number;
  level?: VariationLevel;
  includeChords?: boolean;
  customInstruments?: InstrumentProfile[];
  customGenres?: GenreProfile[];
}

export interface RegenerateResult {
  song: Song;
  changed: { trackId: string; sectionIds: string[] }[];
}

interface CoreExtras {
  /** Fraction of eligible cells to regenerate (variation amount). */
  amount?: number;
  overrides?: StyleOverrides;
}

// ---------------------------------------------------------------------------
// Harmony regeneration
// ---------------------------------------------------------------------------

function substituteChord(c: ChordEvent, key: Song['keyMap'][number]['key'], rng: ReturnType<typeof deriveRng>): ChordSpec {
  const fn = chordFunction(c, key);
  const families: Record<string, number[]> = { tonic: [0, 5, 2], predominant: [3, 1, 5], dominant: [4, 6], chromatic: [3, 4, 5] };
  const own = chordDegree(c, key);
  const options = (families[fn] ?? families.tonic).filter((d) => d !== own);
  const deg = options.length ? rng.pick(options) : own >= 0 ? own : 0;
  const spec = diatonicChord(key, deg, rng.chance(0.25));
  return spec.quality === 'dim' && rng.chance(0.7) ? diatonicChord(key, own >= 0 ? own : 0) : spec;
}

/** Re-plan (or substitute, inside a region) chords of unlocked sections. Returns changed section ids. */
export function regenerateChords(song: Song, seed: number, scope: { sectionIds?: Set<string>; region?: { start: number; end: number } }, customGenres?: GenreProfile[]): Set<string> {
  const changed = new Set<string>();
  if (isLocked(song.locks, LockKeys.chords)) return changed;
  const spans = sectionLayout(song);
  const structureLocked = isLocked(song.locks, LockKeys.structure);
  if (scope.region) {
    const { start, end } = scope.region;
    const ids = new IdFactory(seed, `chords/region/${start}-${end}`);
    song.chords = song.chords.map((c) => {
      if (c.tick < start || c.tick + c.duration > end) return c;
      const span = spans.find((s) => c.tick >= s.startTick && c.tick < s.endTick);
      if (!span || (scope.sectionIds && !scope.sectionIds.has(span.section.id)) || isChordSectionLocked(song, span.section.id)) return c;
      const key = keyAtTick(song, c.tick);
      const spec = substituteChord(c, key, deriveRng(seed, 'chord-sub', c.tick));
      changed.add(span.section.id);
      const ev: ChordEvent = { id: ids.next('ch'), tick: c.tick, duration: c.duration, root: spec.root, quality: spec.quality, symbol: formatChordSymbol(spec, key), roman: chordToRoman(spec, key) };
      return ev;
    });
    return changed;
  }
  const genre = genreForBlend(song.genreBlend, customGenres);
  const macros = effectiveMacros(song);
  const planned: PlannedHarmony = {};
  const groupChords = new Map<HarmonyGroup, ChordSpec[]>();
  const darkness = moodDarkness([...(song.blueprint?.moods ?? []), ...song.sections.flatMap((s) => s.mood ?? [])]);
  let chords = song.chords.slice();
  spans.forEach((sp, i) => {
    const s = sp.section;
    if (scope.sectionIds && !scope.sectionIds.has(s.id)) return;
    if (isChordSectionLocked(song, s.id)) return;
    const key = keyAtTick(song, sp.startTick);
    const grp = harmonyGroupOf(s.kind);
    let prog = groupChords.get(grp);
    if (!prog) {
      const rng = deriveRng(seed, 'regen', 'harmony', grp);
      prog = chooseProgression(genre, key, s.kind, planned, rng);
      if (grp === 'verse') planned.verse = prog;
      if (grp === 'chorus') planned.chorus = prog;
      if (grp === 'pre') planned.pre = prog;
      if (grp === 'bridge') planned.bridge = prog;
      prog = colorProgression(
        prog,
        key,
        {
          extensionRate: genre.harmony.extensionRate,
          borrowedRate: genre.harmony.borrowedChordRate,
          tension: macros.harmonicTension,
          darkness,
          powerChords: genre.harmony.powerChords === true,
          flavor: flavorFor(genre),
        },
        deriveRng(seed, 'regen', 'color', grp),
      );
      groupChords.set(grp, prog);
    }
    const hr = s.harmonicRhythm && s.harmonicRhythm > 0 ? snapHarmonicRhythm(s.harmonicRhythm) : snapHarmonicRhythm(genre.harmony.harmonicRhythm);
    const harmony = expandHarmony(prog, s.bars, hr, key, { endOnTonic: i === spans.length - 1 });
    const events = chordsForPlanSection(song, sp, harmony, key, new IdFactory(seed, `chords/${s.id}/regen`));
    chords = [...chords.filter((c) => c.tick < sp.startTick || c.tick >= sp.endTick), ...events];
    if (!structureLocked) {
      const romans: string[] = [];
      for (const e of events) if (romans[romans.length - 1] !== e.roman) romans.push(e.roman ?? '');
      s.progression = romans;
    }
    if (song.plan && song.plan.sections.length === song.sections.length) song.plan.sections[i] = { ...song.plan.sections[i], harmony };
    changed.add(s.id);
  });
  song.chords = chords.sort((a, b) => a.tick - b.tick);
  return changed;
}

// ---------------------------------------------------------------------------
// Motifs
// ---------------------------------------------------------------------------

/**
 * Replace motif contents with freshly generated ones when nothing protected depends on them: the
 * motif and song.motifs are unlocked, its source track is fully in scope, and every note tagged
 * with it will be regenerated.
 */
function refreshMotifs(song: Song, seed: number, scope: { trackIds?: Set<string>; partial: boolean }, customGenres?: GenreProfile[]): void {
  if (isLocked(song.locks, LockKeys.motifs) || scope.partial || !song.motifs.length) return;
  const genre = genreForBlend(song.genreBlend, customGenres);
  const macros = effectiveMacros(song);
  const meter = meterInfo(song.meterMap[0] ?? { numerator: 4, denominator: 4 }, song.ppq);
  const fresh = buildSongMotifs({
    seed,
    meter,
    bpm: song.tempoMap[0]?.bpm ?? 120,
    density: macros.density,
    syncopation: macros.syncopation,
    movement: macros.melodicMovement,
    riff: song.motifs.some((m) => m.role === 'riff'),
    flatVocal: genre.rhythm.drumStyle === 'hip-hop' || genre.rhythm.drumStyle === 'trap',
    sources: {},
  });
  song.motifs = song.motifs.map((m) => {
    if (isLocked(song.locks, LockKeys.motif(m.id))) return m;
    if (scope.trackIds && (!m.sourceTrackId || !scope.trackIds.has(m.sourceTrackId))) return m;
    for (const t of song.tracks) {
      const refs = t.notes.filter((n) => n.motifId === m.id);
      if (!refs.length) continue;
      if (scope.trackIds && !scope.trackIds.has(t.id)) return m;
      if (refs.some((n) => isNoteLocked(song, t, n))) return m;
    }
    const replacement = fresh.find((f) => f.description === m.description) ?? fresh.find((f) => f.name === m.name);
    if (!replacement) return m;
    return { ...m, notes: replacement.notes.map((n) => ({ ...n })), lengthTicks: replacement.lengthTicks };
  });
}

// ---------------------------------------------------------------------------
// Reinterpretation styles
// ---------------------------------------------------------------------------

const RELATED_DRUMS: Partial<Record<DrumStyle, DrumStyle[]>> = {
  rock: ['indie', 'pop-punk', 'emo'],
  'pop-punk': ['punk', 'rock', 'emo'],
  punk: ['pop-punk', 'rock'],
  emo: ['rock', 'pop-punk', 'indie'],
  metal: ['rock'],
  indie: ['rock', 'pop', 'folk'],
  pop: ['synth-pop', 'rnb', 'indie'],
  'synth-pop': ['pop', 'four-on-floor'],
  'four-on-floor': ['trance', 'synth-pop'],
  trance: ['four-on-floor'],
  'hip-hop': ['trap', 'rnb'],
  trap: ['hip-hop'],
  rnb: ['hip-hop', 'pop'],
  folk: ['country', 'indie'],
  country: ['folk', 'rock'],
  orchestral: ['cinematic'],
  cinematic: ['orchestral'],
};

/** Seeded arrangement/feel changes for a reinterpretation pass. */
export function reinterpretationOverrides(song: Song, seed: number, customGenres?: GenreProfile[]): StyleOverrides {
  const rng = deriveRng(seed, 'reinterpret');
  const genre = genreForBlend(song.genreBlend, customGenres);
  const o: StyleOverrides = {
    accompaniment: rng.pick(['arp', 'sustain', 'block', 'pulse', 'stabs'] as const),
    densityBias: rng.pick([-0.7, -0.4, 0.4, 0.7]),
    energyBias: rng.pick([-0.08, 0, 0.08]),
  };
  const related = RELATED_DRUMS[genre.rhythm.drumStyle];
  if (related && rng.chance(0.6)) o.drumStyle = rng.pick(related);
  if (rng.chance(0.5)) {
    const kinds = rng.pick([['verse'], ['bridge', 'breakdown'], ['verse', 'bridge']]);
    o.halfTime = new Set(song.sections.filter((s) => kinds.includes(s.kind)).map((s) => s.id));
  }
  return o;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

function principalId(song: Song, custom?: InstrumentProfile[]): string | undefined {
  const g = buildSongGen(song, { seed: 1, customInstruments: custom });
  return g.principalMelodyId;
}

function carriesMotifs(t: Track): boolean {
  return t.notes.some((n) => n.motifId);
}

/** Shared implementation of regenerateUnlocked / createVariation. */
export function regenerateCore(song: Song, opts: RegenerateOptions, extras: CoreExtras = {}): RegenerateResult {
  const next = cloneSong(song);
  const seed = Math.floor(Math.abs(opts.seed ?? song.generation?.seed ?? 1));
  const spans = sectionLayout(next);
  const songEnd = spans.length ? spans[spans.length - 1].endTick : 0;
  const hasRegion = opts.startTick !== undefined || opts.endTick !== undefined;
  const region = hasRegion ? { start: Math.max(0, Math.floor(opts.startTick ?? 0)), end: Math.min(songEnd, Math.ceil(opts.endTick ?? songEnd)) } : undefined;
  if (region && region.end <= region.start) return { song: next, changed: [] };
  const trackIds = opts.trackIds ? new Set(opts.trackIds) : undefined;
  const sectionIds = opts.sectionIds ? new Set(opts.sectionIds) : undefined;
  const level = opts.level;
  const settings = { customInstruments: opts.customInstruments, customGenres: opts.customGenres };

  if (level === 'ornament') {
    const changed = ornamentSong(next, seed, extras.amount ?? 1, { trackIds, sectionIds, region }, settings);
    return { song: next, changed };
  }

  // 1. Harmony (explicit, or implied by mutation).
  const includeChords = opts.includeChords ?? level === 'mutation';
  if (includeChords) regenerateChords(next, seed, { sectionIds, region }, opts.customGenres);

  // 2. Motifs: a fresh pass re-writes motifs nothing protected depends on. Every variation level
  // keeps them (they are part of the song's identity / DNA).
  if (level === undefined) {
    refreshMotifs(next, seed, { trackIds, partial: Boolean(sectionIds || region) }, opts.customGenres);
  }

  // 3. Notes. A full-scope pass (or a reinterpretation) also re-rolls the arrangement; the song's
  // generation seed follows so computeArrangement() keeps describing the generated material.
  const principal = principalId(next, opts.customInstruments);
  let overrides = extras.overrides;
  const fullScope = !trackIds && !sectionIds && !region && level === undefined && extras.amount === undefined;
  let arrangementSeed = fullScope ? seed : song.generation?.seed ?? seed;
  let filter: ((t: Track, sid: string) => boolean) | undefined;
  if (level === 'variation') filter = (t) => t.id !== principal && !carriesMotifs(t);
  if (level === 'reinterpretation') {
    filter = (t) => t.id !== principal;
    overrides = overrides ?? reinterpretationOverrides(next, seed, opts.customGenres);
    arrangementSeed = seed;
  }
  const amount = extras.amount;
  if (amount !== undefined && amount < 1) {
    // Pick ~amount of the eligible cells (at least one) deterministically.
    const eligible: string[] = [];
    for (const t of next.tracks) {
      if (t.kind !== 'midi' || (trackIds && !trackIds.has(t.id))) continue;
      for (const s of next.sections) {
        if (sectionIds && !sectionIds.has(s.id)) continue;
        if (filter && !filter(t, s.id)) continue;
        eligible.push(`${t.id}|${s.id}`);
      }
    }
    const chosen = new Set(eligible.filter((k) => unitHash(`${seed}|amount|${k}`) < amount));
    if (!chosen.size && eligible.length && amount > 0) chosen.add(eligible.reduce((best, k) => (unitHash(`${seed}|pick|${k}`) < unitHash(`${seed}|pick|${best}`) ? k : best), eligible[0]));
    const base = filter;
    filter = (t, sid) => (!base || base(t, sid)) && chosen.has(`${t.id}|${sid}`);
  }
  const g = buildSongGen(next, { seed, arrangementSeed, level, overrides, ...settings });
  const changed: CellChange[] = writeCells(g, seed, { trackIds, sectionIds, region, filter, respectLocks: true });

  // 4. Generation info.
  next.generation = { ...next.generation, seed: arrangementSeed };
  return { song: next, changed };
}

/**
 * Regenerate unlocked material with a (new) seed: optionally restricted to tracks, sections or a
 * tick region, at a variation level, optionally re-planning unlocked chords. Locked material is
 * guaranteed byte-identical.
 */
export function regenerateUnlocked(song: Song, opts: RegenerateOptions = {}): RegenerateResult {
  return regenerateCore(song, opts);
}
