/**
 * Arrangement engine (spec §16-§17 orchestration density): which tracks play in which sections.
 *
 * Intro sparse, verses restrained, choruses full, bridges contrast, the final chorus maximal and the
 * outro thinning — driven by section energy, the genre's density curve and rests, track priorities
 * per section kind, and the user's InstrumentConstraints (sectionIds / sectionKinds always win).
 */
import type {
  GenreProfile,
  InstrumentProfile,
  MusicalFunction,
  SectionKind,
  Song,
  Track,
  TrackRole,
} from '../ir/types';
import { getInstrument } from './instruments';
import { genreForSong } from './tags';
import { clamp01, effectiveMacros, lerp, unitHash } from './util';

/** Section kinds in which a lead vocal sings. */
export const VOCAL_KINDS: SectionKind[] = [
  'verse',
  'pre-chorus',
  'chorus',
  'post-chorus',
  'bridge',
  'final-chorus',
  'custom',
];

export function resolveFunction(track: Track, inst: InstrumentProfile): MusicalFunction {
  return track.constraints?.function ?? inst.defaultFunction ?? 'accompaniment';
}

export function isLeadVocal(track: Track, inst: InstrumentProfile): boolean {
  return track.role === 'vocal' && resolveFunction(track, inst) === 'melody';
}

const BASE_PRIORITY: Record<TrackRole, number> = {
  drums: 9,
  bass: 8.5,
  'rhythm-guitar': 8,
  keys: 7,
  'synth-pad': 6,
  strings: 6,
  'synth-seq': 5.5,
  'synth-arp': 5,
  'lead-guitar': 4.5,
  'synth-lead': 4.5,
  percussion: 4,
  vocal: 5,
  custom: 5,
};

const KIND_ADJUST: Partial<
  Record<SectionKind, Partial<Record<TrackRole | 'hook' | 'counter' | 'pad', number>>>
> = {
  intro: {
    drums: -3,
    bass: -2,
    keys: 2,
    'synth-pad': 2,
    'synth-arp': 2,
    hook: 4,
    percussion: -1,
    strings: 1,
  },
  verse: { 'lead-guitar': -3, 'synth-lead': -3, counter: -1, percussion: -1, strings: -1, hook: -2 },
  'pre-chorus': { strings: 1, 'synth-arp': 1, 'synth-pad': 1, counter: 1 },
  chorus: { 'lead-guitar': 2, strings: 1, counter: 2, hook: 2 },
  'final-chorus': { 'lead-guitar': 2, strings: 1, counter: 2, hook: 2 },
  'post-chorus': { hook: 4, 'synth-lead': 2 },
  drop: { hook: 4, 'synth-lead': 3, 'synth-seq': 2, 'synth-arp': 1 },
  bridge: { drums: -1, 'lead-guitar': 2, keys: 1, 'synth-pad': 2, 'rhythm-guitar': -1, counter: 2, pad: 1 },
  breakdown: { drums: -6, bass: -3, 'synth-pad': 3, keys: 2, 'rhythm-guitar': -3, 'synth-arp': 1, pad: 2 },
  build: { 'synth-arp': 3, 'synth-seq': 3, 'synth-pad': 1, drums: 1 },
  solo: { 'lead-guitar': 6, 'synth-lead': 4, hook: 2 },
  outro: { drums: -2, keys: 2, 'synth-pad': 2, hook: 1, bass: -1 },
  interlude: { 'lead-guitar': 1, keys: 1, hook: 2, drums: -1 },
};

const HARMONIC_ROLES: TrackRole[] = ['rhythm-guitar', 'keys', 'synth-pad', 'strings', 'synth-arp'];

interface Unit {
  key: string;
  tracks: Track[];
  role: TrackRole;
  fn: MusicalFunction;
  inst: InstrumentProfile;
  explicitIds?: Set<string>;
  explicitKinds?: Set<SectionKind>;
}

export interface ArrangementOptions {
  seed: number;
  genre?: GenreProfile;
  instrumentOf?: (t: Track) => InstrumentProfile;
  /** −1 (sparser) … +1 (denser). */
  densityBias?: number;
}

function priorityOf(u: Unit, kind: SectionKind, energy: number, hasLeadVocal: boolean): number {
  let p = BASE_PRIORITY[u.role] ?? 5;
  const adj = KIND_ADJUST[kind] ?? {};
  p += adj[u.role] ?? 0;
  if (u.fn === 'hook') p += adj.hook ?? 0;
  if (u.fn === 'counter-melody' || u.fn === 'fills') p += adj.counter ?? 0;
  if (u.fn === 'pad' || u.fn === 'texture') p += (adj.pad ?? 0) + (energy < 0.4 ? 1 : 0);
  if (u.fn === 'solo') p += kind === 'solo' || kind === 'bridge' ? 4 : -2;
  if (u.fn === 'melody' && !hasLeadVocal) p += 3;
  if (u.fn === 'bass-line' && u.role !== 'bass') p += 2;
  if (u.role === 'vocal' && u.fn === 'pad')
    p += kind === 'chorus' || kind === 'final-chorus' || kind === 'bridge' ? 2 : -1;
  if (u.role === 'percussion' && u.inst.id === 'timpani') p += energy > 0.7 ? 2 : -1;
  return p;
}

/** Arrangement with explicit options (seed for tie-breaking, density bias). */
export function arrangementFor(song: Song, opts: ArrangementOptions): Record<string, string[]> {
  const genre = opts.genre ?? genreForSong(song);
  const instOf = opts.instrumentOf ?? ((t: Track) => getInstrument(t.instrumentId));
  const midi = song.tracks.filter((t) => t.kind === 'midi');
  const result: Record<string, string[]> = {};
  for (const t of song.tracks) result[t.id] = [];
  const hasLeadVocal = midi.some((t) => isLeadVocal(t, instOf(t)));

  // Units: tracks with the same role, function, instrument and constraints move together (L/R pairs).
  const units = new Map<string, Unit>();
  for (const t of midi) {
    const inst = instOf(t);
    const fn = resolveFunction(t, inst);
    const c = t.constraints ?? {};
    const sig = `${(c.sectionIds ?? []).join(',')}|${(c.sectionKinds ?? []).join(',')}`;
    const key = `${t.role}|${fn}|${inst.id}|${sig}`;
    const u = units.get(key);
    if (u) u.tracks.push(t);
    else {
      units.set(key, {
        key,
        tracks: [t],
        role: t.role,
        fn,
        inst,
        explicitIds: c.sectionIds && c.sectionIds.length ? new Set(c.sectionIds) : undefined,
        explicitKinds: c.sectionKinds && c.sectionKinds.length ? new Set(c.sectionKinds) : undefined,
      });
    }
  }
  const density = clamp01(effectiveMacros(song).density);
  const bias = (density - 0.5) * 0.3 + (opts.densityBias ?? 0) * 0.25;

  for (const section of song.sections) {
    const kind = section.kind;
    const e = clamp01(((section.energy ?? 50) + (section.energyEnd ?? section.energy ?? 50)) / 200);
    const rests = new Set(genre.arrangement.restsBySection?.[kind] ?? []);
    const active = new Set<Unit>();
    const flexible: Unit[] = [];
    for (const u of units.values()) {
      if (u.explicitIds) {
        if (u.explicitIds.has(section.id)) active.add(u);
        continue;
      }
      if (u.explicitKinds) {
        if (u.explicitKinds.has(kind)) active.add(u);
        continue;
      }
      if (u.role === 'vocal' && u.fn === 'melody') {
        if (VOCAL_KINDS.includes(kind)) active.add(u);
        continue;
      }
      if (u.role === 'vocal' && u.fn === 'harmony' && hasLeadVocal) {
        const chorusy = kind === 'chorus' || kind === 'final-chorus' || kind === 'post-chorus';
        if (
          chorusy ||
          ((kind === 'pre-chorus' || kind === 'bridge') && e >= 0.6) ||
          (kind === 'verse' && e >= 0.78)
        )
          active.add(u);
        continue;
      }
      if (u.fn === 'melody' && u.role !== 'vocal' && !hasLeadVocal) {
        // Principal melody of an instrumental piece: states the themes, takes the solos.
        if (
          VOCAL_KINDS.includes(kind) ||
          kind === 'solo' ||
          (kind === 'intro' && e >= 0.35) ||
          kind === 'drop'
        )
          active.add(u);
        continue;
      }
      if (rests.has(u.role)) continue;
      flexible.push(u);
    }
    // How many flexible units play: the genre's density curve at this energy, biased by macros.
    let frac = clamp01(
      lerp(genre.arrangement.densityAtLowEnergy, genre.arrangement.densityAtHighEnergy, e) + bias,
    );
    if (kind === 'final-chorus' || ((kind === 'chorus' || kind === 'drop') && e >= 0.8)) frac = 1;
    const target = flexible.length
      ? Math.max(1, Math.min(flexible.length, Math.round(frac * flexible.length + 0.3)))
      : 0;
    const ranked = flexible
      .map((u) => ({
        u,
        p: priorityOf(u, kind, e, hasLeadVocal) + unitHash(`${opts.seed}|${u.key}|${section.id}`) * 0.5,
      }))
      .sort((a, b) => b.p - a.p);
    for (let i = 0; i < target; i++) active.add(ranked[i].u);
    // Every section keeps some harmony underneath.
    const harmonic = (u: Unit) =>
      HARMONIC_ROLES.includes(u.role) || u.fn === 'pad' || u.fn === 'harmony' || u.fn === 'accompaniment';
    if (![...active].some(harmonic)) {
      const h = ranked.find((r) => harmonic(r.u));
      if (h) active.add(h.u);
    }
    // Bass locks with the drums once the groove is established.
    const drumsOn = [...active].some((u) => u.role === 'drums');
    if (drumsOn && e >= 0.35)
      for (const r of ranked) if (r.u.role === 'bass' || r.u.fn === 'bass-line') active.add(r.u);
    for (const u of active) for (const t of u.tracks) result[t.id].push(section.id);
  }
  return result;
}

/** trackId → section ids where it plays (deterministic for a song + seed). */
export function computeArrangement(song: Song): Record<string, string[]> {
  return arrangementFor(song, { seed: song.generation?.seed ?? 1 });
}
