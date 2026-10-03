/**
 * Tag catalog: lightweight style, mood, era, production, vocal, region and rhythm tags that nudge a
 * song without being full genre profiles. A style tag names parent genres (so "midwest emo" pulls
 * the blend toward emo) and an effect that overrides or shifts traits of the blended profile; mood
 * and other tags only carry an effect. Every shipped tag changes the composed output (see
 * `test/composer.tags.test.ts`). The catalog itself lives in `tag-catalog.ts`.
 *
 * Contract used by the composer, the prompt parser, the studio's Compose builder and the AI layer:
 *   listTags(kind?) · getTag(id) · findTags(text) · applyTagsToGenre(genre, ids) ·
 *   applyTagsToMacros(macros, ids) · genreForBlueprint(bp, custom) · tagParents(ids)
 * plus helpers: songTags(song) · genreForSong(song, custom) · blendForBlueprint(bp) ·
 *   normalizeTagIds(ids) · tagGroups(kind?) · tagCatalogSummary(opts?)
 *
 * Macros: a blueprint's (and a song's) `macros` are the user's base. Tag macro deltas are applied on
 * top at generation time (`effectiveMacros` in util.ts), never baked into `song.macros`, so
 * regeneration and variations never apply them twice. The parser and `defaultBlueprint` take the
 * base macros from the untagged genre blend for the same reason.
 */
import type {
  BassPattern,
  Blueprint,
  CompStyle,
  DrumStyle,
  GenreProfile,
  GenreWeight,
  MacroSettings,
  MasteringTarget,
  ModeName,
  MusicalFunction,
  Song,
  TrackRole,
} from '../ir/types';
import { genreForBlend } from './genres';
import { TAG_CATALOG } from './tag-catalog';

export type TagKind = 'style' | 'mood' | 'era' | 'production' | 'vocal' | 'region' | 'rhythm';

export const TAG_KINDS: readonly TagKind[] = ['style', 'mood', 'era', 'production', 'vocal', 'region', 'rhythm'];

/** How a tag changes the blended genre profile and macros. All fields optional. */
export interface TagEffect {
  /** Absolute tempo window (overrides the genre's; missing bounds are kept) and/or a relative shift in BPM. */
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
    /** Idiomatic bass pattern (e.g. "octave" for disco, "reggae" for dub). */
    bassStyle?: BassPattern;
    /** Idiomatic keys/guitar comping (e.g. "skank", "funk", "montuno"). */
    compStyle?: CompStyle;
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

/** The built-in catalog (see tag-catalog.ts). Ids are kebab-case and stable. */
export const BUILTIN_TAGS: StyleTag[] = TAG_CATALOG;

const BY_ID = new Map(BUILTIN_TAGS.map((t) => [t.id, t]));

const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

let byName: Map<string, StyleTag> | undefined;
let namesLongestFirst: { t: StyleTag; n: string }[] | undefined;

/** Normalized id / name / alias → tag (built lazily). */
function nameIndex(): Map<string, StyleTag> {
  if (!byName) {
    byName = new Map();
    for (const t of BUILTIN_TAGS) for (const n of [t.id, t.name, ...(t.aliases ?? [])]) if (norm(n) && !byName.has(norm(n))) byName.set(norm(n), t);
  }
  return byName;
}

/** All tags, optionally of one kind. */
export function listTags(kind?: TagKind): StyleTag[] {
  return kind ? BUILTIN_TAGS.filter((t) => t.kind === kind) : [...BUILTIN_TAGS];
}

/** Tag by id or alias. */
export function getTag(id: string): StyleTag | undefined {
  if (!id) return undefined;
  return BY_ID.get(id) ?? nameIndex().get(norm(id));
}

/** Tags whose name or alias appears in free text (longest names first, no overlaps). */
export function findTags(text: string): StyleTag[] {
  const hay = ` ${norm(text ?? '')} `;
  const found: StyleTag[] = [];
  if (!namesLongestFirst) {
    namesLongestFirst = BUILTIN_TAGS.flatMap((t) => [t.name, ...(t.aliases ?? [])].map((n) => ({ t, n: norm(n) })))
      .filter((e) => e.n)
      .sort((a, b) => b.n.length - a.n.length);
  }
  let rest = hay;
  for (const { t, n } of namesLongestFirst) {
    const needle = ` ${n} `;
    if (!rest.includes(needle)) continue;
    rest = rest.split(needle).join(' ');
    if (!found.includes(t)) found.push(t);
  }
  return found;
}

/** Canonical ids for ids/aliases, in order, without duplicates or unknown entries. */
export function normalizeTagIds(ids: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    const t = getTag(id);
    if (t && !out.includes(t.id)) out.push(t.id);
  }
  return out;
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
  const tags = normalizeTagIds(ids).map((id) => BY_ID.get(id)!);
  if (!tags.length) return genre;
  const g = JSON.parse(JSON.stringify(genre)) as GenreProfile;
  for (const { effect: e } of tags) {
    if (e.tempo) {
      const { min, max, typical, shift } = e.tempo;
      if (min !== undefined) g.tempo.min = min;
      if (max !== undefined) g.tempo.max = max;
      if (typical !== undefined) g.tempo.typical = typical;
      else if (min !== undefined || max !== undefined) g.tempo.typical = Math.round((g.tempo.min + g.tempo.max) / 2);
      if (shift) {
        g.tempo.min += shift;
        g.tempo.max += shift;
        g.tempo.typical += shift;
      }
      g.tempo.min = Math.max(30, Math.round(g.tempo.min));
      g.tempo.max = Math.max(g.tempo.min, Math.round(g.tempo.max));
      g.tempo.typical = Math.min(g.tempo.max, Math.max(g.tempo.min, Math.round(g.tempo.typical)));
    }
    if (e.modes?.length) {
      const total = g.modes.reduce((s, m) => s + m.weight, 0) || 1;
      for (const m of e.modes) {
        const prev = g.modes.find((x) => x.mode === m.mode);
        if (prev) prev.weight += m.weight * total;
        else g.modes.push({ mode: m.mode, weight: m.weight * total });
      }
      g.modes.sort((a, b) => b.weight - a.weight);
    }
    if (e.meters?.length) {
      const total = g.meters.reduce((s, m) => s + m.weight, 0) || 1;
      for (const m of e.meters) {
        const prev = g.meters.find((x) => x.numerator === m.numerator && x.denominator === m.denominator);
        if (prev) prev.weight += m.weight * total;
        else g.meters.push({ numerator: m.numerator, denominator: m.denominator, weight: m.weight * total });
      }
      g.meters.sort((a, b) => b.weight - a.weight);
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
  for (const id of normalizeTagIds(ids)) {
    const d = BY_ID.get(id)!.effect.macros;
    if (!d) continue;
    for (const [k, v] of Object.entries(d) as [keyof MacroSettings, number][]) out[k] = clamp01(out[k] + v);
  }
  return out;
}

/**
 * The time signature explicitly requested by meter tags ("waltz", "7/8 time"…), if any: the last tag
 * whose effect weights one meter at 2 or more. The planner uses it over the blueprint's meter.
 */
export function tagMeter(ids: readonly string[] | undefined): { numerator: number; denominator: number } | undefined {
  let out: { numerator: number; denominator: number } | undefined;
  for (const id of normalizeTagIds(ids)) {
    const m = BY_ID.get(id)!.effect.meters?.find((x) => x.weight >= 2);
    if (m) out = { numerator: m.numerator, denominator: m.denominator };
  }
  return out;
}

/** The genre blend a blueprint composes with: its own, else its style tags' parents, else pop. */
export function blendForBlueprint(bp: Pick<Blueprint, 'genreBlend' | 'tags'>): GenreWeight[] {
  if (bp.genreBlend?.length) return bp.genreBlend.map((g) => ({ ...g }));
  const parents = tagParents(bp.tags);
  return parents.length ? parents : [{ genreId: 'pop', weight: 1 }];
}

/** The genre profile a blueprint composes with: its blend (or its style tags' parents), then its tags. */
export function genreForBlueprint(bp: Pick<Blueprint, 'genreBlend' | 'tags'>, custom?: GenreProfile[]): GenreProfile {
  const blend = bp.genreBlend?.length ? bp.genreBlend : tagParents(bp.tags);
  return applyTagsToGenre(genreForBlend(blend, custom), bp.tags);
}

/** A song's tag ids (`song.tags`, else its blueprint's). */
export function songTags(song: Pick<Song, 'tags' | 'blueprint'>): string[] {
  return normalizeTagIds(song.tags ?? song.blueprint?.tags);
}

/** The genre profile a song generates with: its blend plus its tags. */
export function genreForSong(song: Pick<Song, 'genreBlend' | 'tags' | 'blueprint'>, custom?: GenreProfile[]): GenreProfile {
  return applyTagsToGenre(genreForBlend(song.genreBlend, custom), songTags(song));
}

/** Tags of one kind (or all) grouped for pickers, in catalog order. */
export function tagGroups(kind?: TagKind): { group: string; tags: StyleTag[] }[] {
  const groups = new Map<string, StyleTag[]>();
  for (const t of listTags(kind)) {
    const g = t.group ?? 'Other';
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  return [...groups.entries()].map(([group, tags]) => ({ group, tags }));
}

/**
 * Compact text listing of the catalog for LLM prompts ("STYLE TAGS — Rock & alternative:
 * post-punk, midwest-emo…"). `kinds` limits the kinds; `maxPerGroup` trims long groups.
 */
export function tagCatalogSummary(opts: { kinds?: TagKind[]; maxPerGroup?: number } = {}): string {
  const lines: string[] = [];
  for (const kind of opts.kinds ?? TAG_KINDS) {
    const groups = tagGroups(kind);
    if (!groups.length) continue;
    lines.push(`${kind.toUpperCase()} TAGS:`);
    for (const { group, tags } of groups) {
      const ids = tags.map((t) => t.id);
      const shown = opts.maxPerGroup && ids.length > opts.maxPerGroup ? [...ids.slice(0, opts.maxPerGroup), '…'] : ids;
      lines.push(`  ${group}: ${shown.join(', ')}`);
    }
  }
  return lines.join('\n');
}
