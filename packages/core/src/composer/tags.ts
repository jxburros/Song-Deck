/**
 * Tag catalog: lightweight style, mood, era, production, vocal and region tags that nudge a song
 * without being full genre profiles. A style tag names parent genres (so "midwest emo" pulls the
 * blend toward emo) and an effect that overrides or shifts traits of the blended profile; mood and
 * other tags only carry an effect. Every shipped tag must change the composed output.
 *
 * Contract used by the composer, the prompt parser, the studio's Compose builder and the AI layer:
 *   listTags(kind?) · getTag(id) · findTags(text) · applyTagsToGenre(genre, ids) ·
 *   applyTagsToMacros(macros, ids) · genreForBlueprint(bp, custom) · tagParents(ids)
 */
import type {
  Blueprint,
  DrumStyle,
  GenreProfile,
  GenreWeight,
  MacroSettings,
  MasteringTarget,
  ModeName,
  MusicalFunction,
  TrackRole,
} from '../ir/types';
import { genreForBlend } from './genres';

export type TagKind = 'style' | 'mood' | 'era' | 'production' | 'vocal' | 'region' | 'rhythm';

/** How a tag changes the blended genre profile and macros. All fields optional. */
export interface TagEffect {
  /** Absolute tempo window (clamped into the genre's) or a relative shift in BPM. */
  tempo?: { min?: number; max?: number; typical?: number; shift?: number };
  /** Mode weights mixed into the genre's mode pool (weights are relative to the pool). */
  modes?: { mode: ModeName; weight: number }[];
  meters?: { numerator: number; denominator: number; weight: number }[];
  rhythm?: {
    drumStyle?: DrumStyle;
    swing?: number;
    syncopation?: number;
    subdivision?: 8 | 12 | 16;
    halfTimeChance?: number;
  };
  harmony?: {
    borrowedChordRate?: number;
    extensionRate?: number;
    harmonicRhythm?: number;
    powerChords?: boolean;
    /** Extra weighted roman-numeral progressions. */
    progressions?: { roman: string[]; weight: number }[];
  };
  instruments?: {
    add?: { instrumentId: string; role: TrackRole; function?: MusicalFunction; weight: number; essential?: boolean }[];
    /** Instrument ids to drop from the pool. */
    remove?: string[];
  };
  /** Added to the macros (each result clamped to 0..1). */
  macros?: Partial<MacroSettings>;
  /** Added to every section's energy (-100..100). */
  energyShift?: number;
  production?: { keywords?: string[]; reverb?: number; masteringTarget?: MasteringTarget };
}

export interface StyleTag {
  id: string;
  name: string;
  kind: TagKind;
  /** UI grouping, e.g. "Electronic", "Rock & alternative", "Feelings". */
  group?: string;
  description?: string;
  aliases?: string[];
  /** Style tags: the genre(s) the style belongs to, used when the blend does not already name one. */
  parents?: GenreWeight[];
  effect: TagEffect;
}

/** The built-in catalog. Extended by the genre/tag expansion; keep ids kebab-case and stable. */
export const BUILTIN_TAGS: StyleTag[] = [
  {
    id: 'lo-fi',
    name: 'Lo-fi',
    kind: 'production',
    group: 'Production',
    description: 'Dusty, laid-back and slightly behind the beat',
    aliases: ['lofi', 'lo fi'],
    effect: {
      tempo: { shift: -8 },
      rhythm: { swing: 0.35 },
      harmony: { extensionRate: 0.6 },
      macros: { humanization: 0.2, energy: -0.15, density: -0.1 },
      production: { keywords: ['lo-fi', 'tape hiss', 'vinyl crackle', 'warm'], reverb: 0.3 },
    },
  },
  {
    id: 'warm',
    name: 'Warm',
    kind: 'mood',
    group: 'Feelings',
    description: 'Comforting, round and major-leaning',
    effect: {
      modes: [{ mode: 'major', weight: 0.5 }],
      harmony: { extensionRate: 0.4 },
      macros: { harmonicTension: -0.1, energy: -0.05 },
      production: { keywords: ['warm'] },
    },
  },
];

const BY_ID = new Map(BUILTIN_TAGS.map((t) => [t.id, t]));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** All tags, optionally of one kind. */
export function listTags(kind?: TagKind): StyleTag[] {
  return kind ? BUILTIN_TAGS.filter((t) => t.kind === kind) : [...BUILTIN_TAGS];
}

/** Tag by id or alias. */
export function getTag(id: string): StyleTag | undefined {
  if (!id) return undefined;
  const direct = BY_ID.get(id);
  if (direct) return direct;
  const n = norm(id);
  return BUILTIN_TAGS.find((t) => norm(t.id) === n || norm(t.name) === n || t.aliases?.some((a) => norm(a) === n));
}

/** Tags whose name or alias appears in free text (longest names first, no overlaps). */
export function findTags(text: string): StyleTag[] {
  const hay = ` ${norm(text)} `;
  const found: StyleTag[] = [];
  const names = BUILTIN_TAGS.flatMap((t) => [t.name, ...(t.aliases ?? [])].map((n) => ({ t, n: norm(n) })))
    .filter((e) => e.n)
    .sort((a, b) => b.n.length - a.n.length);
  let rest = hay;
  for (const { t, n } of names) {
    const needle = ` ${n} `;
    if (!rest.includes(needle)) continue;
    rest = rest.replace(needle, ' ');
    if (!found.includes(t)) found.push(t);
  }
  return found;
}

/** Parent genres contributed by style tags (for when the user picked a style but no genre). */
export function tagParents(ids: readonly string[] | undefined): GenreWeight[] {
  const out: GenreWeight[] = [];
  for (const id of ids ?? []) for (const p of getTag(id)?.parents ?? []) out.push({ ...p });
  return out;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Apply tag effects (in order) to a copy of a genre profile. */
export function applyTagsToGenre(genre: GenreProfile, ids: readonly string[] | undefined): GenreProfile {
  const tags = (ids ?? []).map(getTag).filter((t): t is StyleTag => !!t);
  if (!tags.length) return genre;
  const g = JSON.parse(JSON.stringify(genre)) as GenreProfile;
  for (const { effect: e } of tags) {
    if (e.tempo) {
      const { min, max, typical, shift } = e.tempo;
      if (min !== undefined) g.tempo.min = min;
      if (max !== undefined) g.tempo.max = max;
      if (typical !== undefined) g.tempo.typical = typical;
      if (shift) {
        g.tempo.min += shift;
        g.tempo.max += shift;
        g.tempo.typical += shift;
      }
      g.tempo.min = Math.max(30, g.tempo.min);
      g.tempo.max = Math.max(g.tempo.min, g.tempo.max);
      g.tempo.typical = Math.min(g.tempo.max, Math.max(g.tempo.min, g.tempo.typical));
    }
    if (e.modes?.length) {
      const total = g.modes.reduce((s, m) => s + m.weight, 0) || 1;
      for (const m of e.modes) {
        const prev = g.modes.find((x) => x.mode === m.mode);
        if (prev) prev.weight += m.weight * total;
        else g.modes.push({ mode: m.mode, weight: m.weight * total });
      }
    }
    if (e.meters?.length) {
      const total = g.meters.reduce((s, m) => s + m.weight, 0) || 1;
      for (const m of e.meters) {
        const prev = g.meters.find((x) => x.numerator === m.numerator && x.denominator === m.denominator);
        if (prev) prev.weight += m.weight * total;
        else g.meters.push({ numerator: m.numerator, denominator: m.denominator, weight: m.weight * total });
      }
    }
    if (e.rhythm) Object.assign(g.rhythm, e.rhythm);
    if (e.harmony) {
      const { progressions, ...rest } = e.harmony;
      Object.assign(g.harmony, rest);
      if (progressions) g.harmony.progressions.push(...progressions.map((p) => ({ roman: [...p.roman], weight: p.weight })));
    }
    if (e.instruments) {
      const drop = new Set(e.instruments.remove ?? []);
      g.instruments = g.instruments.filter((i) => !drop.has(i.instrumentId));
      for (const add of e.instruments.add ?? []) {
        if (!g.instruments.some((i) => i.instrumentId === add.instrumentId && i.role === add.role)) g.instruments.push({ ...add });
      }
    }
    if (e.energyShift) {
      for (const k of Object.keys(g.dynamics.energyBySection) as (keyof typeof g.dynamics.energyBySection)[]) {
        g.dynamics.energyBySection[k] = Math.max(0, Math.min(100, (g.dynamics.energyBySection[k] ?? 50) + e.energyShift));
      }
    }
    if (e.macros) {
      const m: Partial<MacroSettings> = { ...(g.macros ?? {}) };
      for (const [k, v] of Object.entries(e.macros) as [keyof MacroSettings, number][]) m[k] = clamp01((m[k] ?? 0.5) + v);
      g.macros = m;
    }
    if (e.production) {
      if (e.production.keywords) g.production.keywords = [...new Set([...g.production.keywords, ...e.production.keywords])];
      if (e.production.reverb !== undefined) g.production.reverb = e.production.reverb;
      if (e.production.masteringTarget) g.production.masteringTarget = e.production.masteringTarget;
    }
  }
  g.tags = [...new Set([...(g.tags ?? []), ...tags.map((t) => t.id)])];
  return g;
}

/** Shift macros by the tags' macro deltas (clamped to 0..1). */
export function applyTagsToMacros(macros: MacroSettings, ids: readonly string[] | undefined): MacroSettings {
  const out = { ...macros };
  for (const id of ids ?? []) {
    const d = getTag(id)?.effect.macros;
    if (!d) continue;
    for (const [k, v] of Object.entries(d) as [keyof MacroSettings, number][]) out[k] = clamp01(out[k] + v);
  }
  return out;
}

/** The genre profile a blueprint composes with: its blend (or its style tags' parents), then its tags. */
export function genreForBlueprint(bp: Pick<Blueprint, 'genreBlend' | 'tags'>, custom?: GenreProfile[]): GenreProfile {
  const blend = bp.genreBlend?.length ? bp.genreBlend : tagParents(bp.tags);
  return applyTagsToGenre(genreForBlend(blend, custom), bp.tags);
}
