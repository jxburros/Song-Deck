/**
 * Plan → song structure: sections (with repeat relations) and contiguous chord events.
 * `applyPlanToSong` applies a (possibly AI-produced or user-edited) plan to an existing song,
 * moving existing material with its sections and honouring structure/chord/tempo/key/meter locks.
 */
import type {
  ChordEvent,
  ChordSpec,
  CompositionPlan,
  KeySignature,
  Note,
  PlanSection,
  Section,
  Song,
} from '../ir/types';
import { cloneSong, sortNotes } from '../ir/song-utils';
import { IdFactory } from '../util/ids';
import { barToTick, keyAtBar, meterAtBar, sectionLayout, type SectionSpan } from '../timing';
import { LockKeys, isChordSectionLocked, isLocked } from '../locks';
import { formatChordSymbol } from '../theory/chords';
import { chordToRoman } from '../theory/roman';
import { harmonyGroupOf } from './planner';
import { slotsPerBarFor } from './harmony';
import { parseHarmonyToken, sameChord, tonicChordSpec } from './util';

/** Chord specs per slot for a plan section's harmony list (see expandHarmony). */
function harmonyToSpecs(harmony: readonly string[], key: KeySignature): ChordSpec[] {
  const out: ChordSpec[] = [];
  for (const h of harmony) {
    const c = parseHarmonyToken(h, key);
    if (c)
      out.push(
        c.bass !== undefined
          ? { root: c.root, quality: c.quality, bass: c.bass }
          : { root: c.root, quality: c.quality },
      );
  }
  return out;
}

/**
 * Chord events for one section: one harmony entry per slot (1 slot per bar unless the list is
 * longer than the section), cycling to fill, merging consecutive identical chords.
 */
export function chordsForPlanSection(
  song: Pick<Song, 'ppq' | 'meterMap' | 'tempoMap'>,
  span: { startBar: number; endBar: number },
  harmony: readonly string[],
  key: KeySignature,
  ids: IdFactory,
): ChordEvent[] {
  const bars = span.endBar - span.startBar;
  let specs = harmonyToSpecs(harmony, key);
  if (!specs.length) specs = [tonicChordSpec(key)];
  const perBar = slotsPerBarFor(specs.length, bars);
  const raw: { spec: ChordSpec; tick: number; duration: number }[] = [];
  let slot = 0;
  for (let b = span.startBar; b < span.endBar; b++) {
    const barStart = barToTick(song, b);
    const barEnd = barToTick(song, b + 1);
    const len = barEnd - barStart;
    for (let k = 0; k < perBar; k++) {
      const t0 = barStart + Math.round((len * k) / perBar);
      const t1 = barStart + Math.round((len * (k + 1)) / perBar);
      const spec = specs[slot % specs.length];
      slot++;
      const prev = raw[raw.length - 1];
      if (prev && sameChord(prev.spec, spec) && prev.tick + prev.duration === t0) prev.duration += t1 - t0;
      else raw.push({ spec, tick: t0, duration: t1 - t0 });
    }
  }
  return raw.map((r) => {
    const ev: ChordEvent = {
      id: ids.next('ch'),
      tick: r.tick,
      duration: r.duration,
      root: r.spec.root,
      quality: r.spec.quality,
      symbol: formatChordSymbol(r.spec, key),
      roman: chordToRoman(r.spec, key),
    };
    if (r.spec.bass !== undefined) ev.bass = r.spec.bass;
    return ev;
  });
}

/** Distinct romans of a harmony list (consecutive duplicates removed) for Section.progression. */
function progressionRomans(harmony: readonly string[], key: KeySignature): string[] {
  const out: string[] = [];
  for (const spec of harmonyToSpecs(harmony, key)) {
    const r = chordToRoman(spec, key);
    if (out[out.length - 1] !== r) out.push(r);
  }
  return out;
}

function harmonicRhythmOf(events: number, bars: number): number {
  if (bars <= 0) return 1;
  const v = events / bars;
  const opts = [0.25, 0.5, 1, 2, 4];
  return opts.reduce((best, o) => (Math.abs(o - v) < Math.abs(best - v) ? o : best), 1);
}

/** Build Section records from plan sections (ids from the factory; repeats point to their first occurrence). */
export function sectionsFromPlan(
  planSections: readonly PlanSection[],
  nextId: () => string,
  existingIds?: (string | undefined)[],
  moods?: (string[] | undefined)[],
): Section[] {
  const out: Section[] = [];
  planSections.forEach((ps, i) => {
    const id = existingIds?.[i] ?? nextId();
    const s: Section = {
      id,
      name: ps.name,
      kind: ps.kind,
      bars: Math.max(1, Math.round(ps.bars)),
      energy: ps.energy,
      purpose: ps.purpose,
    };
    if (ps.energyEnd !== undefined) s.energyEnd = ps.energyEnd;
    if (ps.feel) s.feel = ps.feel;
    if (moods?.[i]?.length) s.mood = [...moods[i]!];
    // Repeat relation: the first earlier section of the same harmony group with the same harmony.
    const grp = harmonyGroupOf(ps.kind);
    for (let j = 0; j < i; j++) {
      const prev = planSections[j];
      if (harmonyGroupOf(prev.kind) !== grp) continue;
      if (prev.harmony.join('|') !== ps.harmony.join('|')) continue;
      if (out[j].repeatOf) s.repeatOf = out[j].repeatOf;
      else s.repeatOf = out[j].id;
      break;
    }
    out.push(s);
  });
  return out;
}

/** Fill song.chords for the given sections from the plan harmony (other sections untouched). */
export function writePlanChords(
  song: Song,
  plan: CompositionPlan,
  seed: number,
  onlySectionIds?: Set<string>,
): void {
  const spans = sectionLayout(song);
  const keep = song.chords.filter((c) => {
    const span = spans.find((s) => c.tick >= s.startTick && c.tick < s.endTick);
    return span ? onlySectionIds !== undefined && !onlySectionIds.has(span.section.id) : false;
  });
  const fresh: ChordEvent[] = [];
  spans.forEach((span, i) => {
    if (onlySectionIds && !onlySectionIds.has(span.section.id)) return;
    const ps = plan.sections[i];
    const key = keyAtBar(song, span.startBar);
    const harmony = ps?.harmony?.length ? ps.harmony : [formatChordSymbol(tonicChordSpec(key), key)];
    const evs = chordsForPlanSection(
      song,
      span,
      harmony,
      key,
      new IdFactory(seed, `chords/${span.section.id}`),
    );
    fresh.push(...evs);
    span.section.progression = progressionRomans(harmony, key);
    span.section.harmonicRhythm = harmonicRhythmOf(evs.length, span.section.bars);
  });
  song.chords = [...keep, ...fresh].sort((a, b) => a.tick - b.tick);
}

function shiftForStructure(song: Song, oldSpans: SectionSpan[], newSpans: SectionSpan[]): void {
  const byId = new Map(newSpans.map((s) => [s.section.id, s]));
  const unchanged =
    oldSpans.length === newSpans.length &&
    oldSpans.every(
      (o, i) =>
        o.section.id === newSpans[i].section.id &&
        o.startTick === newSpans[i].startTick &&
        o.endTick === newSpans[i].endTick,
    );
  if (unchanged) return;
  const remap = (tick: number): number | null => {
    const os = oldSpans.find((s) => tick >= s.startTick && tick < s.endTick);
    if (!os) return null;
    const ns = byId.get(os.section.id);
    if (!ns) return null;
    const t = tick - os.startTick + ns.startTick;
    return t < ns.endTick ? t : null;
  };
  const songEnd = newSpans.length ? newSpans[newSpans.length - 1].endTick : 0;
  for (const track of song.tracks) {
    const notes: Note[] = [];
    for (const n of track.notes) {
      const t = remap(n.tick);
      if (t === null) continue;
      notes.push({ ...n, tick: t, duration: Math.max(1, Math.min(n.duration, songEnd - t)) });
    }
    track.notes = sortNotes(notes);
  }
  song.phrases = song.phrases.flatMap((p) => {
    const t = remap(p.startTick);
    if (t === null) return [];
    return [{ ...p, startTick: t, endTick: t + (p.endTick - p.startTick) }];
  });
  song.chords = song.chords.flatMap((c) => {
    const t = remap(c.tick);
    return t === null ? [] : [{ ...c, tick: t }];
  });
  song.automation = song.automation.map((lane) => ({
    ...lane,
    points: lane.points.flatMap((pt) => {
      const t = remap(pt.tick);
      return t === null ? [] : [{ ...pt, tick: t }];
    }),
  }));
  const validSections = new Set(newSpans.map((s) => s.section.id));
  song.lyrics = song.lyrics.filter((l) => validSections.has(l.sectionId));
}

/**
 * Apply a composition plan to a song: tempo/key/meter (unless locked), sections (reusing ids by
 * position so locks and lyrics stay attached; material moves with its section) and chords (sections
 * with locked harmony keep theirs). Notes are not regenerated — call `regenerateUnlocked` for that.
 */
export function applyPlanToSong(song: Song, plan: CompositionPlan): Song {
  const next = cloneSong(song);
  const seed = song.generation?.seed ?? 1;
  const locks = song.locks ?? {};
  if (!isLocked(locks, LockKeys.tempo) && plan.tempo > 0) {
    next.tempoMap = next.tempoMap.length
      ? next.tempoMap.map((t, i) => (i === 0 ? { ...t, tick: 0, bpm: plan.tempo } : t))
      : [{ tick: 0, bpm: plan.tempo }];
  }
  if (!isLocked(locks, LockKeys.key) && plan.key) next.keyMap = [{ bar: 0, key: { ...plan.key } }];
  if (!isLocked(locks, LockKeys.meter) && plan.meter)
    next.meterMap = [{ bar: 0, numerator: plan.meter.numerator, denominator: plan.meter.denominator }];

  const oldSpans = sectionLayout(song);
  const structureLocked = isLocked(locks, LockKeys.structure);
  const planSections = plan.sections.filter((s) => s.bars > 0);
  if (!structureLocked) {
    const ids = new IdFactory(seed, 'structure');
    // Reuse existing ids (keeps locks, lyrics and note ownership): by name first, then by the
    // n-th occurrence of the same kind. Ids of removed sections are never handed out again.
    const taken = new Set<string>();
    const existing: (string | undefined)[] = planSections.map((ps) => {
      const m =
        song.sections.find((s) => !taken.has(s.id) && s.name === ps.name && s.kind === ps.kind) ??
        song.sections.find((s) => !taken.has(s.id) && s.name === ps.name);
      if (m) taken.add(m.id);
      return m?.id;
    });
    planSections.forEach((ps, i) => {
      if (existing[i]) return;
      const m = song.sections.find((s) => !taken.has(s.id) && s.kind === ps.kind);
      if (m) {
        taken.add(m.id);
        existing[i] = m.id;
      }
    });
    const used = new Set(song.sections.map((s) => s.id));
    const nextId = () => {
      let id = ids.next('sec');
      while (used.has(id)) id = ids.next('sec');
      used.add(id);
      return id;
    };
    const fresh = sectionsFromPlan(
      planSections,
      nextId,
      existing,
      existing.map((id) => song.sections.find((x) => x.id === id)?.mood),
    );
    next.sections = fresh;
  } else {
    next.sections = next.sections.map((s, i) => {
      const ps = planSections[i];
      if (!ps || ps.kind !== s.kind || ps.bars !== s.bars) return s;
      const u: Section = { ...s, energy: ps.energy, purpose: ps.purpose };
      if (ps.energyEnd !== undefined) u.energyEnd = ps.energyEnd;
      else delete u.energyEnd;
      if (ps.feel) u.feel = ps.feel;
      return u;
    });
  }
  const newSpans = sectionLayout(next);
  shiftForStructure(next, oldSpans, newSpans);

  // Harmony: sections whose chords are locked keep their (moved) chords; the rest follow the plan.
  const lockedChordSections = new Set(
    next.sections.filter((s) => isChordSectionLocked(next, s.id)).map((s) => s.id),
  );
  const planIndexById = new Map(next.sections.map((s, i) => [s.id, i]));
  const unlocked = new Set(next.sections.filter((s) => !lockedChordSections.has(s.id)).map((s) => s.id));
  const alignedPlan: CompositionPlan = {
    ...plan,
    sections: next.sections.map(
      (s) =>
        planSections[planIndexById.get(s.id) ?? -1] ?? {
          name: s.name,
          kind: s.kind,
          bars: s.bars,
          harmony: [],
          energy: s.energy,
          purpose: s.purpose ?? '',
        },
    ),
  };
  writePlanChords(next, alignedPlan, seed, unlocked);
  // Drop chord events that no longer fall inside the song (e.g. after shortening).
  const end = newSpans.length ? newSpans[newSpans.length - 1].endTick : 0;
  next.chords = next.chords
    .filter((c) => c.tick < end)
    .map((c) => (c.tick + c.duration > end ? { ...c, duration: end - c.tick } : c));
  next.plan = JSON.parse(JSON.stringify(plan)) as CompositionPlan;
  return next;
}

/** Meter at a section's first bar (for generators that need it before a song exists). */
export function meterOfSpan(
  song: Pick<Song, 'ppq' | 'meterMap' | 'tempoMap'>,
  span: SectionSpan,
): { numerator: number; denominator: number } {
  const m = meterAtBar(song, span.startBar);
  return { numerator: m.numerator, denominator: m.denominator };
}
