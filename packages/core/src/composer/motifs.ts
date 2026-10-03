/**
 * Motifs and phrases (spec §11 Song DNA "core motifs", §16 vocal melody / hooks / riffs).
 *
 * Motifs are stored as scale-degree MotifNotes relative to an anchor so they can be re-placed over
 * any chord or key. This module generates abstract phrases (rhythm + scale-degree contour) and
 * realizes them over the harmony: chord tones on strong beats, scale tones in between, stepwise
 * motion with occasional leaps that are filled in, and register management.
 */
import type { ChordEvent, KeySignature, Motif, MotifNote, MotifRole, SectionKind, Song } from '../ir/types';
import { PPQ } from '../ir/types';
import { chordPitchClasses } from '../theory/chords';
import { mod12 } from '../theory/pitch';
import { isInScale, nearestPitchWithClass, snapToScale, transposeDiatonic } from '../theory/scales';
import { IdFactory } from '../util/ids';
import { deriveRng, type Rng } from '../util/random';
import { chordAtIn, clamp, clamp01, lerp, metricWeight, type MeterInfo, type RawNote } from './util';

export type Contour = 'arch' | 'descending' | 'ascending' | 'wave' | 'hook' | 'answer' | 'flat';

export interface RhythmSlot {
  offset: number;
  duration: number;
}

/** Phrase length in bars for vocal-like lines: ~2–4 s phrases with room to breathe. */
export function phraseBarsFor(meter: MeterInfo, bpm: number): number {
  const barSec = (meter.barTicks / PPQ) * (60 / Math.max(20, bpm));
  if (barSec >= 3.2) return 1;
  if (barSec >= 1.1) return 2;
  return 4;
}

/** Rhythmic grid for sung lines: 8ths at moderate/fast tempi, 16ths when slow. */
export function vocalGrid(meter: MeterInfo, bpm: number): number {
  if (meter.denominator >= 8) return meter.unitTicks >= PPQ / 2 ? PPQ / 2 : meter.unitTicks;
  return bpm < 96 ? PPQ / 4 : PPQ / 2;
}

export interface RhythmOptions {
  /** Sung span: the last note ends here. */
  lengthTicks: number;
  /** Offset of the phrase start within its bar (for metric weights). */
  barOffset: number;
  meter: MeterInfo;
  grid: number;
  count?: number;
  /** 0..1 */
  density: number;
  /** 0..1 */
  syncopation: number;
  /** Minimum length of the phrase-final note. */
  minFinal?: number;
  /** Probability of starting off the downbeat. */
  lateStart?: number;
}

function weightedSampleWithoutReplacement<T>(rng: Rng, items: T[], weights: number[], k: number): T[] {
  const pool = items.slice();
  const w = weights.slice();
  const out: T[] = [];
  for (let i = 0; i < k && pool.length; i++) {
    const idx = rng.weighted(
      pool.map((_, j) => j),
      w,
    );
    out.push(pool[idx]);
    pool.splice(idx, 1);
    w.splice(idx, 1);
  }
  return out;
}

/** Syllable-friendly phrase rhythm: onsets weighted by metric strength, a long note on a strong beat at the end. */
export function phraseRhythm(rng: Rng, o: RhythmOptions): RhythmSlot[] {
  const grid = Math.max(30, o.grid);
  const slots = Math.max(1, Math.floor(o.lengthTicks / grid));
  if (slots <= 1 || (o.count !== undefined && o.count <= 1)) return [{ offset: 0, duration: Math.max(grid, o.lengthTicks) }];
  const w = (s: number) => metricWeight(o.barOffset + s * grid, o.meter);
  const minFinal = Math.min(o.minFinal ?? o.meter.beatTicks, Math.floor(o.lengthTicks / 2));
  // Final onset: a strong position leaving at least `minFinal`.
  const finals: number[] = [];
  for (let s = slots - 1; s >= 1; s--) {
    if (o.lengthTicks - s * grid < minFinal) continue;
    if (w(s) >= 0.75) finals.push(s);
    if (finals.length >= 2) break;
  }
  let f = finals.length ? (finals.length > 1 && rng.chance(0.35) ? finals[1] : finals[0]) : Math.max(1, slots - Math.ceil(minFinal / grid));
  const want = o.count !== undefined ? o.count : Math.round(f * (0.32 + 0.42 * clamp01(o.density))) + 1;
  let n = clamp(want, 2, o.count !== undefined ? Math.max(2, o.count) : f + 1);
  if (n > f + 1 && o.count === undefined) n = f + 1;
  const first = rng.chance(o.lateStart ?? 0.15) && f > 2 ? 1 : 0;
  const candidates: number[] = [];
  const weights: number[] = [];
  for (let s = first + 1; s < f; s++) {
    let wt = Math.pow(w(s), 1.2);
    if (w(s) <= 0.5 && s + 1 <= f && w(s + 1) >= 0.75) wt *= 1 + 2 * clamp01(o.syncopation); // anticipation
    if (w(s) <= 0.3) wt *= 0.6 + o.density * 0.6;
    candidates.push(s);
    weights.push(wt);
  }
  const chosen = weightedSampleWithoutReplacement(rng, candidates, weights, Math.max(0, Math.min(n - 2, candidates.length)));
  const onsets = [first, ...chosen, f].sort((a, b) => a - b);
  const out: RhythmSlot[] = onsets.map((s, i) => {
    const offset = s * grid;
    const nextOffset = i + 1 < onsets.length ? onsets[i + 1] * grid : o.lengthTicks;
    const gap = nextOffset - offset;
    const duration = i + 1 < onsets.length ? Math.max(30, gap - Math.min(24, Math.round(gap * 0.08))) : gap;
    return { offset, duration };
  });
  // Too many syllables for the grid: split the longest notes.
  if (o.count !== undefined) return adjustSlotCount(out, o.count, o.lengthTicks);
  return out;
}

function adjustSlotCount(slots: RhythmSlot[], count: number, lengthTicks: number): RhythmSlot[] {
  const out = slots.map((s) => ({ ...s }));
  let guard = 0;
  while (out.length < count && guard++ < 256) {
    let li = 0;
    for (let i = 1; i < out.length; i++) if (out[i].duration > out[li].duration) li = i;
    const s = out[li];
    if (s.duration < 60) break;
    const half = Math.round(s.duration / 2);
    out.splice(li, 1, { offset: s.offset, duration: half }, { offset: s.offset + half, duration: s.duration - half });
  }
  while (out.length > count && out.length > 1) {
    // Merge the shortest interior note into its predecessor.
    let si = out.length > 2 ? 1 : out.length - 1;
    for (let i = 1; i < out.length - 1; i++) if (out[i].duration < out[si].duration) si = i;
    const prev = out[si - 1];
    prev.duration = out[si].offset + out[si].duration - prev.offset;
    out.splice(si, 1);
  }
  void lengthTicks;
  return out;
}

export interface DegreeOptions {
  contour: Contour;
  /** 0..1 */
  movement: number;
  /** Max distance from the anchor in scale steps. */
  span: number;
  /** Final degree relative to the anchor (cadence target). */
  endDegree?: number;
  /** Narrow, repetitive (rap/chant). */
  flat?: boolean;
  avoidLeaps?: boolean;
}

function contourTarget(c: Contour, t: number, a: number): number {
  switch (c) {
    case 'arch':
      return a * Math.sin(Math.PI * t);
    case 'descending':
      return -a * t;
    case 'ascending':
      return a * t;
    case 'wave':
      return a * 0.6 * Math.sin(2 * Math.PI * t);
    case 'hook':
      return t < 0.18 ? (a * t) / 0.18 : a * (1 - 0.55 * ((t - 0.18) / 0.82));
    case 'answer':
      return a * 0.35 * Math.sin(Math.PI * t) - a * 0.5 * t;
    case 'flat':
      return 0;
  }
}

/** Scale-degree contour: steps with occasional leaps (filled in by contrary motion), shaped by the contour. */
export function phraseDegrees(rng: Rng, n: number, o: DegreeOptions): number[] {
  if (n <= 0) return [];
  const span = Math.max(1, o.span);
  const amp = o.flat ? 1 : span * (0.55 + 0.45 * clamp01(o.movement));
  const maxStep = o.avoidLeaps ? 2 : o.flat ? 1 : 2 + (o.movement > 0.6 ? 1 : 0);
  const out = [0];
  let prevStep = 0;
  let repeats = 0;
  for (let i = 1; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    let target = contourTarget(o.contour, t, amp);
    if (o.endDegree !== undefined && t > 0.65) target = lerp(target, o.endDegree, (t - 0.65) / 0.35);
    const prev = out[i - 1];
    let step: number;
    if (Math.abs(prevStep) >= 3) {
      step = -Math.sign(prevStep) * (rng.chance(0.4) ? 2 : 1);
    } else {
      // Mostly stepwise: the noise widens with the melodic-movement macro.
      const noise = rng.gaussian(0, o.flat ? 0.45 : 0.35 + clamp01(o.movement) * 0.45);
      step = Math.round(target - prev + noise);
      step = clamp(step, -maxStep, maxStep);
      if (!o.avoidLeaps && !o.flat && Math.abs(step) <= 1 && rng.chance(0.03 + clamp01(o.movement) * 0.1)) step = (step >= 0 ? 1 : -1) * rng.int(3, 4);
    }
    if (step === 0) {
      repeats++;
      if (repeats >= (o.flat ? 4 : 2)) {
        step = target >= prev ? 1 : -1;
        repeats = 0;
      }
    } else repeats = 0;
    let d = prev + step;
    if (d > span) d = span - (d - span);
    if (d < -span) d = -span + (-span - d);
    out.push(d);
    prevStep = d - prev;
  }
  if (o.endDegree !== undefined) out[n - 1] = o.endDegree;
  return out;
}

/** An abstract phrase (motif notes relative to the phrase start and anchor). */
export function abstractPhrase(rng: Rng, r: RhythmOptions, d: DegreeOptions, velocity = 90): MotifNote[] {
  const rhythm = phraseRhythm(rng.fork('rhythm'), r);
  const degrees = phraseDegrees(rng.fork('degrees'), rhythm.length, d);
  return rhythm.map((s, i) => {
    // Phrase arc: a little louder toward the middle, accents on strong beats.
    const t = rhythm.length > 1 ? i / (rhythm.length - 1) : 0;
    const accent = metricWeight(r.barOffset + s.offset, r.meter) >= 0.75 ? 6 : 0;
    return { offset: s.offset, duration: s.duration, degree: degrees[i], velocity: Math.round(velocity - 6 + 10 * Math.sin(Math.PI * t) + accent) };
  });
}

/** Change the number of notes (lyric syllables) keeping rhythm character and contour. */
export function adaptMotifToCount(notes: readonly MotifNote[], count: number): MotifNote[] {
  let out = notes.map((n) => ({ ...n }));
  if (count <= 0 || !out.length) return out;
  let guard = 0;
  while (out.length < count && guard++ < 256) {
    let li = 0;
    for (let i = 1; i < out.length; i++) if (out[i].duration > out[li].duration) li = i;
    const s = out[li];
    if (s.duration < 60) break;
    const half = Math.round(s.duration / 2);
    const nextDeg = out[li + 1]?.degree ?? s.degree;
    const passing = s.degree + Math.sign(nextDeg - s.degree);
    out.splice(li, 1, { ...s, duration: half }, { ...s, offset: s.offset + half, duration: s.duration - half, degree: passing, velocity: s.velocity - 4 });
  }
  while (out.length > count && out.length > 1) {
    let si = out.length > 2 ? 1 : out.length - 1;
    for (let i = 1; i < out.length - 1; i++) if (out[i].duration < out[si].duration) si = i;
    const prev = out[si - 1];
    prev.duration = out[si].offset + out[si].duration - prev.offset;
    out.splice(si, 1);
  }
  out = out.sort((a, b) => a.offset - b.offset);
  return out;
}

/**
 * Re-time a phrase so stressed lyric syllables land on strong beats and unstressed ones avoid them
 * (prosody). Each note keeps its scale degree and order; onsets move along the grid by a dynamic
 * program that trades metric fit against distance from the original rhythm. The phrase end stays
 * where it was. Returns the input unchanged when it already fits or there is no room to move.
 */
export function alignStressToMeter(
  notes: readonly MotifNote[],
  stress: readonly number[],
  o: { grid: number; barOffset: number; meter: MeterInfo; lengthTicks: number },
): MotifNote[] {
  const n = notes.length;
  const grid = Math.max(30, Math.round(o.grid));
  const slots = Math.floor(o.lengthTicks / grid);
  if (n < 2 || stress.length !== n || slots < n || !stress.some((s) => s > 0)) return notes.map((x) => ({ ...x }));
  const fitAt = (i: number, ticks: number) => {
    const wt = metricWeight(o.barOffset + ticks, o.meter);
    return stress[i] > 0 ? wt : -0.6 * Math.max(0, wt - 0.5);
  };
  const fit = (i: number, s: number) => fitAt(i, s * grid);
  const orig = notes.map((x) => clamp(Math.round(x.offset / grid), 0, slots - 1));
  const end = notes[n - 1].offset + notes[n - 1].duration;
  const lastMax = Math.max(0, Math.min(slots - 1, Math.floor((end - grid) / grid)));
  const score = (i: number, s: number) => fit(i, s) - 0.12 * Math.abs(s - orig[i]);
  // best[i][s]: best total for notes 0..i with note i at slot s; prev pointers for backtracking.
  const best: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    best.push(new Float64Array(slots).fill(-Infinity));
    from.push(new Int32Array(slots).fill(-1));
  }
  for (let s = 0; s <= slots - n; s++) best[0][s] = score(0, s);
  for (let i = 1; i < n; i++) {
    let runMax = -Infinity;
    let runArg = -1;
    const hi = i === n - 1 ? lastMax : slots - (n - i);
    for (let s = i; s <= hi; s++) {
      if (best[i - 1][s - 1] > runMax) {
        runMax = best[i - 1][s - 1];
        runArg = s - 1;
      }
      if (runArg < 0 || runMax === -Infinity) continue;
      best[i][s] = runMax + score(i, s);
      from[i][s] = runArg;
    }
  }
  let at = -1;
  let top = -Infinity;
  for (let s = 0; s < slots; s++) {
    if (best[n - 1][s] > top) {
      top = best[n - 1][s];
      at = s;
    }
  }
  if (at < 0) return notes.map((x) => ({ ...x }));
  const pos: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    pos[i] = at;
    at = from[i][at];
  }
  const fitOf = (p: readonly number[]) => p.reduce((t, s, i) => t + fit(i, s), 0);
  const origFit = notes.reduce((t, x, i) => t + fitAt(i, x.offset), 0);
  if (fitOf(pos) <= origFit + 0.25 || pos.every((s, i) => s * grid === notes[i].offset)) return notes.map((x) => ({ ...x }));
  return notes.map((x, i) => {
    const offset = pos[i] * grid;
    const next = i + 1 < n ? pos[i + 1] * grid : end;
    const gap = next - offset;
    const duration = i + 1 < n ? Math.max(30, gap - Math.min(24, Math.round(gap * 0.08))) : Math.max(grid, end - offset);
    const accent = stress[i] > 0 ? 4 : -3;
    return { ...x, offset, duration, velocity: clamp(Math.round(x.velocity + accent), 1, 127) };
  });
}

export interface RealizeOptions {
  start: number;
  anchor: number;
  key: KeySignature;
  chords: readonly ChordEvent[];
  low: number;
  high: number;
  meterAt: (tick: number) => { meter: MeterInfo; barStart: number };
  /** Pull strong-beat / long notes onto chord tones. */
  strongFit?: boolean;
  /** Keep everything on the key's scale (no chromatic alterations). */
  diatonicOnly?: boolean;
  /** Pitches to avoid at given ticks (e.g. vocal notes for counter-melodies) → returns avoided pitch or null. */
  avoid?: (tick: number, duration: number, pitch: number) => boolean;
  motifId?: string;
}

function nearestChordTone(pitch: number, pcs: readonly number[], preferDir: number, prev: number | null, keepMoving = false): number {
  let best = pitch;
  let bestScore = Infinity;
  for (let d = -4; d <= 4; d++) {
    const p = pitch + d;
    if (!pcs.includes(mod12(p))) continue;
    let score = Math.abs(d) + (Math.sign(d) === preferDir || d === 0 ? 0 : 0.4);
    if (prev !== null) {
      // Singable intervals: avoid tritone and seventh-or-wider leaps from the previous note.
      const leap = Math.abs(p - prev);
      if (leap === 6 || leap === 10 || leap === 11 || leap > 12) score += 2.5;
      // The line was meant to move: don't flatten it into a repeated note.
      if (keepMoving && p === prev) score += 1.6;
    }
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** Realize abstract notes over the harmony into concrete pitches. */
export function realizePhrase(notes: readonly MotifNote[], o: RealizeOptions): RawNote[] {
  const out: RawNote[] = [];
  let prevPitch: number | null = null;
  let prevDegree: number | null = null;
  for (const mn of notes) {
    const tick = o.start + mn.offset;
    let pitch = transposeDiatonic(o.anchor, mn.degree, o.key) + (o.diatonicOnly ? 0 : mn.alteration ?? 0);
    const chord = chordAtIn(o.chords, tick);
    const pcs = chord ? chordPitchClasses(chord) : [];
    const { meter, barStart } = o.meterAt(tick);
    const w = metricWeight(tick - barStart, meter);
    // Chord tones on strong beats and sustained notes; passing/neighbour scale tones elsewhere.
    const strong = w >= 0.9 || (w >= 0.75 && mn.duration >= meter.beatTicks) || mn.duration >= meter.beatTicks * 1.5;
    if (o.strongFit !== false && strong && pcs.length && !pcs.includes(mod12(pitch))) {
      const dir = prevPitch === null ? 0 : Math.sign(pitch - prevPitch);
      pitch = nearestChordTone(pitch, pcs, dir, prevPitch, prevDegree !== null && prevDegree !== mn.degree);
    } else if (!isInScale(pitch, o.key) && !(mn.alteration && !o.diatonicOnly) && !pcs.includes(mod12(pitch))) {
      pitch = snapToScale(pitch, o.key);
    }
    // A scale tone a semitone from a chromatic chord tone (F over B major, C over A major) clashes:
    // take the chord's own note instead.
    for (const pc of pcs) {
      if (isInScale(pc, o.key) || pcs.includes(mod12(pitch))) continue;
      const d = mod12(pc - pitch);
      if (d === 1) pitch += 1;
      else if (d === 11) pitch -= 1;
    }
    if (o.avoid && o.avoid(tick, mn.duration, pitch) && pcs.length) {
      // Step to another chord tone (a third away) instead of doubling.
      const alts = [pitch + 3, pitch - 3, pitch + 4, pitch - 4, pitch + 5, pitch - 5, pitch + 7, pitch - 7].filter((p) => pcs.includes(mod12(p)) && !o.avoid!(tick, mn.duration, p));
      if (alts.length) pitch = alts[0];
    }
    out.push({ pitch, tick, duration: mn.duration, velocity: mn.velocity, ...(o.motifId ? { motifId: o.motifId } : {}) });
    prevPitch = pitch;
    prevDegree = mn.degree;
  }
  // Register: shift the whole phrase by octaves to fit, then fold stragglers.
  if (out.length) {
    let lo = Math.min(...out.map((n) => n.pitch));
    let hi = Math.max(...out.map((n) => n.pitch));
    // Only big excursions move the whole phrase an octave; small overshoots are flattened below.
    let guard = 0;
    while (hi - o.high > 5 && lo - 12 >= o.low - 2 && guard++ < 6) {
      for (const n of out) n.pitch -= 12;
      lo -= 12;
      hi -= 12;
    }
    guard = 0;
    while (o.low - lo > 5 && hi + 12 <= o.high + 2 && guard++ < 6) {
      for (const n of out) n.pitch += 12;
      lo += 12;
      hi += 12;
    }
    // Stragglers flatten against the range edge (nearest chord/scale tone inside) instead of
    // jumping an octave, which would break the contour.
    for (const n of out) {
      if (n.pitch >= o.low && n.pitch <= o.high) continue;
      const pcs = chordPitchClasses(chordAtIn(o.chords, n.tick));
      const dir = n.pitch > o.high ? -1 : 1;
      let p = n.pitch > o.high ? o.high : o.low;
      let guard = 0;
      while (guard++ < 12 && !(pcs.includes(mod12(p)) || isInScale(p, o.key))) p += dir;
      n.pitch = Math.min(o.high, Math.max(o.low, p));
    }
  }
  return out;
}

/** A chord tone of `chord` near `target` (anchor for a phrase). */
export function anchorNear(chord: ChordEvent | undefined, target: number, key: KeySignature, prefer: 'root' | 'third' | 'any' = 'any'): number {
  if (!chord) return nearestPitchWithClass(key.tonic, target);
  const pcs = chordPitchClasses(chord);
  const candidates = prefer === 'root' ? [chord.root] : prefer === 'third' ? [pcs[1] ?? chord.root] : pcs.slice(0, 3);
  let best = nearestPitchWithClass(candidates[0], target);
  for (const pc of candidates) {
    const p = nearestPitchWithClass(pc, target);
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Song motifs
// ---------------------------------------------------------------------------

export interface MotifPlanOptions {
  seed: number;
  meter: MeterInfo;
  bpm: number;
  /** 0..1 macros */
  density: number;
  syncopation: number;
  movement: number;
  /** Riff-driven genre (rock/metal/punk): create a guitar riff motif. */
  riff: boolean;
  /** Narrow rhythmic vocal (hip-hop). */
  flatVocal: boolean;
  sources: { vocal?: string; hook?: string; answer?: string; riff?: string };
}

export const MOTIF_DESCRIPTIONS = {
  verse: 'Verse vocal motif',
  hook: 'Chorus hook',
  answer: 'Answering phrase',
  chorusVocal: 'Chorus vocal hook',
  riff: 'Main riff',
} as const;

/**
 * Create the song's core motifs: A verse vocal motif, B chorus (instrumental) hook, C answering
 * phrase, D chorus vocal hook, and E a riff for riff-driven genres.
 */
export function buildSongMotifs(o: MotifPlanOptions): Motif[] {
  const ids = new IdFactory(o.seed, 'motifs');
  const m = o.meter;
  const phraseBars = phraseBarsFor(m, o.bpm);
  const phraseTicks = phraseBars * m.barTicks;
  const grid = vocalGrid(m, o.bpm);
  const motifs: Motif[] = [];
  const mk = (name: string, description: string, role: MotifRole, kinds: SectionKind[], notes: MotifNote[], lengthTicks: number, source?: string): Motif => {
    const motif: Motif = { id: ids.next('motif'), name, description, role, lengthTicks, notes, sectionKinds: kinds };
    if (source) motif.sourceTrackId = source;
    return motif;
  };

  // A — verse vocal motif: conversational rhythm, arch/descending contour, moderate span.
  const rA = deriveRng(o.seed, 'motif', 'A');
  const breathA = m.beatTicks * (rA.chance(0.5) ? 1.5 : 2);
  const lenA = Math.max(m.beatTicks * 2, phraseTicks - breathA);
  const notesA = abstractPhrase(
    rA,
    { lengthTicks: lenA, barOffset: 0, meter: m, grid, density: clamp01(o.density * 0.9 + 0.1), syncopation: o.syncopation, lateStart: 0.3 },
    { contour: rA.chance(0.55) ? 'arch' : 'descending', movement: o.movement * 0.85, span: o.flatVocal ? 2 : 4, flat: o.flatVocal, endDegree: rA.pick([0, -2, 2]) },
    84,
  );
  motifs.push(mk('Motif A', MOTIF_DESCRIPTIONS.verse, 'vocal-hook', ['verse'], notesA, lenA, o.sources.vocal));

  // B — chorus hook (instrumental): a repeating riff-like cell, 8ths (16ths when slow).
  const rB = deriveRng(o.seed, 'motif', 'B');
  const hookBars = o.bpm < 90 ? 1 : phraseBars >= 2 ? 2 : 1;
  const cellLen = m.barTicks;
  const hookGrid = o.bpm < 100 ? PPQ / 4 : PPQ / 2;
  const cell = abstractPhrase(
    rB,
    { lengthTicks: cellLen, barOffset: 0, meter: m, grid: hookGrid, density: clamp01(0.55 + o.density * 0.35), syncopation: o.syncopation, minFinal: hookGrid * 2, lateStart: 0.1 },
    { contour: rB.pick(['arch', 'wave', 'descending'] as Contour[]), movement: clamp01(o.movement + 0.15), span: 5 },
    96,
  );
  const notesB: MotifNote[] = [];
  for (let b = 0; b < hookBars; b++) {
    const last = b === hookBars - 1;
    cell.forEach((n, i) => {
      // Second bar answers the first: same rhythm, ending a step lower/higher.
      const deg = last && hookBars > 1 && i >= cell.length - 2 ? n.degree + rB.pick([-1, -2, 1]) : n.degree;
      notesB.push({ ...n, offset: n.offset + b * cellLen, degree: deg });
    });
  }
  motifs.push(mk('Motif B', MOTIF_DESCRIPTIONS.hook, 'instrumental-hook', ['chorus', 'final-chorus', 'intro', 'drop', 'post-chorus'], notesB, hookBars * cellLen, o.sources.hook));

  // C — answering phrase: enters after the vocal stops, a short line that resolves on a long note.
  const rC = deriveRng(o.seed, 'motif', 'C');
  const lenC = Math.max(m.beatTicks * 2, Math.round(m.barTicks * (phraseBars >= 2 ? 1.5 : 1)));
  const notesC = abstractPhrase(
    rC,
    { lengthTicks: lenC, barOffset: m.beatTicks % m.barTicks, meter: m, grid: o.bpm < 100 ? PPQ / 4 : PPQ / 2, density: 0.45, syncopation: o.syncopation * 0.7, minFinal: m.beatTicks * 1.5 },
    { contour: 'answer', movement: o.movement, span: 4, endDegree: rC.pick([-2, 0, -4]) },
    80,
  );
  motifs.push(mk('Motif C', MOTIF_DESCRIPTIONS.answer, 'answer', ['verse', 'chorus', 'bridge', 'final-chorus'], notesC, lenC, o.sources.answer));

  // D — chorus vocal hook: longer notes, an early leap up, repeated pitches that stick.
  const rD = deriveRng(o.seed, 'motif', 'D');
  const breathD = m.beatTicks;
  const lenD = Math.max(m.beatTicks * 2, phraseTicks - breathD);
  const notesD = abstractPhrase(
    rD,
    { lengthTicks: lenD, barOffset: 0, meter: m, grid, density: clamp01(o.density * 0.7), syncopation: o.syncopation * 0.8, minFinal: m.beatTicks * 2, lateStart: 0.1 },
    { contour: o.flatVocal ? 'arch' : 'hook', movement: clamp01(o.movement + 0.1), span: o.flatVocal ? 3 : 5, endDegree: rD.pick([0, 2, -1]) },
    98,
  );
  motifs.push(mk('Motif D', MOTIF_DESCRIPTIONS.chorusVocal, 'vocal-hook', ['chorus', 'final-chorus'], notesD, lenD, o.sources.vocal));

  // E — riff: low, root-centred one-bar figure for riff-driven genres.
  if (o.riff) {
    const rE = deriveRng(o.seed, 'motif', 'E');
    const riffGrid = o.bpm >= 150 ? PPQ / 2 : PPQ / 4;
    const steps = Math.max(2, Math.floor(m.barTicks / riffGrid));
    const notesE: MotifNote[] = [];
    const vocab = [0, 0, 0, 0, 2, -1, 3, 4, -2, 0, 7];
    for (let s = 0; s < steps; s++) {
      const strong = metricWeight(s * riffGrid, m) >= 0.5;
      if (!strong && !rE.chance(0.55)) continue;
      const deg = s === 0 ? 0 : strong ? rE.pick([0, 0, 0, 4, 2]) : rE.pick(vocab);
      notesE.push({ offset: s * riffGrid, duration: riffGrid, degree: deg, velocity: strong ? 104 : 92 });
    }
    for (let i = 0; i < notesE.length; i++) {
      const nextOff = i + 1 < notesE.length ? notesE[i + 1].offset : m.barTicks;
      notesE[i].duration = Math.max(riffGrid / 2, nextOff - notesE[i].offset - 10);
    }
    motifs.push(mk('Motif E', MOTIF_DESCRIPTIONS.riff, 'riff', ['intro', 'verse', 'solo', 'outro'], notesE, m.barTicks, o.sources.riff));
  }
  return motifs;
}

/** Find a song motif by its description role (falls back to names A–E). */
export function findSongMotif(song: Pick<Song, 'motifs'>, which: keyof typeof MOTIF_DESCRIPTIONS): Motif | undefined {
  const desc = MOTIF_DESCRIPTIONS[which];
  const byDesc = song.motifs.find((m) => m.description === desc);
  if (byDesc) return byDesc;
  const name = { verse: 'Motif A', hook: 'Motif B', answer: 'Motif C', chorusVocal: 'Motif D', riff: 'Motif E' }[which];
  return song.motifs.find((m) => m.name === name);
}
