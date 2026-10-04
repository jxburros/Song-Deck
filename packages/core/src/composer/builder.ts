/**
 * The Compose builder: structured choices (instruments with counts, genres with influence, mood
 * and style tags, tempo/key/meter/length/structure, vocal, lyrics) → a Song Blueprint.
 *
 * `blueprintFromChoices` is pure and deterministic (same choices + seed ⇒ same blueprint) and
 * honours every choice exactly: the instruments and counts asked for are the tracks you get, the
 * genre weights are the blend (normalised), tags land in `bp.tags`, moods become section moods.
 * Whatever is left open is filled from the blended genre profile (tempo range, meters, modes,
 * structure templates, typical instrumentation), adjusted by the chosen tags.
 *
 * `applyBuilderConstraints` re-imposes the same choices on a blueprint designed by a language
 * model, so a model can add detail but never override what the user picked.
 */
import type {
  Blueprint,
  BlueprintLyrics,
  BlueprintSection,
  BlueprintTrack,
  GenreProfile,
  GenreWeight,
  InstrumentConstraints,
  InstrumentProfile,
  KeySignature,
  MacroSettings,
  ModeName,
  MusicalFunction,
  SectionKind,
  TrackRole,
  VocalMode,
  VoiceType,
} from '../ir/types';
import { defaultMacros } from '../ir/defaults';
import { deriveRng } from '../util/random';
import { KIND_LABEL, fitStructure, nameBlueprintTracks, nameSections, shapeEnergies } from './blueprint';
import { genreForBlend, getGenre } from './genres';
import { findInstrumentProfile } from './instruments';
import { structureFromLyrics } from './lyrics-first';
import { genreForBlueprint, getTag, type StyleTag } from './tags';
import { clamp, lerp } from './util';

export type TempoFeel = 'slow' | 'mid' | 'fast';
export type SongLength = 'short' | 'standard' | 'long';

export interface BuilderInstrument {
  instrumentId: string;
  /** How many tracks of this instrument (1..8). Two identical rhythm guitars become an L/R pair. */
  count: number;
  role?: TrackRole;
  function?: MusicalFunction;
}

export interface BuilderGenre {
  genreId: string;
  /** Influence 0..1 (normalised across the chosen genres). */
  weight: number;
}

export interface BuilderMood {
  /** A mood tag id from the tag catalog. */
  tagId: string;
  /** Only this kind of section ("chorus: cathartic"); the whole song when omitted. */
  section?: SectionKind;
}

export interface BuilderVocal {
  voiceType: VoiceType;
  mode: VocalMode;
  description?: string;
}

export interface BuilderChoices {
  title?: string;
  /** Exact line-up. Empty → suggested from the genres. */
  instruments?: BuilderInstrument[];
  genres?: BuilderGenre[];
  moods?: BuilderMood[];
  /** Other tag ids (style, era, production, vocal, region, rhythm). Unknown ids are ignored. */
  tags?: string[];
  /** BPM, or a feel resolved against the genre's tempo range. Omitted → the genre's typical tempo. */
  tempo?: number | TempoFeel;
  /** Omitted parts are chosen from the genre and moods. */
  key?: { tonic?: number; mode?: ModeName };
  meter?: { numerator: number; denominator: number };
  length?: SongLength | { minutes: number };
  /** Name of one of the blended genre's structure templates. */
  structure?: string;
  /** 'none' = instrumental; omitted = a lead vocal when the genre expects one (or lyrics are given). */
  vocal?: BuilderVocal | 'none';
  lyricsTheme?: string;
  /** Lyrics supplied up front: the structure is built around them and they are sung and locked. */
  lyrics?: BlueprintLyrics;
  macros?: Partial<MacroSettings>;
}

export interface BuilderOptions {
  seed: number;
  customGenres?: GenreProfile[];
  customInstruments?: InstrumentProfile[];
}

// ---------------------------------------------------------------------------------------------
// Helpers (exported for the UI)
// ---------------------------------------------------------------------------------------------

/** Chosen genres → a normalised blend (unknown genres and zero weights dropped; weights sum to 1). */
export function normalizeGenreWeights(
  genres: readonly BuilderGenre[] | undefined,
  custom?: GenreProfile[],
): GenreWeight[] {
  const seen = new Map<string, number>();
  for (const g of genres ?? []) {
    const p = getGenre(g.genreId, custom);
    const w = Number(g.weight);
    if (!p || !(w > 0)) continue;
    seen.set(p.id, (seen.get(p.id) ?? 0) + w);
  }
  const total = [...seen.values()].reduce((a, b) => a + b, 0);
  return total > 0 ? [...seen.entries()].map(([genreId, w]) => ({ genreId, weight: w / total })) : [];
}

/** Resolve tag ids (or aliases) to canonical catalog ids, dropping unknown ones and duplicates. */
export function resolveTagIds(ids: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    const t = getTag(id);
    if (t && !out.includes(t.id)) out.push(t.id);
  }
  return out;
}

function moodTags(choices: BuilderChoices): { tag: StyleTag; section?: SectionKind }[] {
  const out: { tag: StyleTag; section?: SectionKind }[] = [];
  for (const m of choices.moods ?? []) {
    const tag = getTag(m.tagId);
    if (tag && !out.some((o) => o.tag.id === tag.id && o.section === m.section))
      out.push(m.section ? { tag, section: m.section } : { tag });
  }
  return out;
}

/** All tag ids a set of choices puts on the blueprint: the chosen tags plus whole-song moods. */
export function builderTagIds(choices: BuilderChoices): string[] {
  return resolveTagIds([
    ...(choices.tags ?? []),
    ...moodTags(choices)
      .filter((m) => !m.section)
      .map((m) => m.tag.id),
  ]);
}

/** The genre blend the choices compose with (chosen genres, else style tags' parents, else pop). */
export function builderBlend(choices: BuilderChoices, custom?: GenreProfile[]): GenreWeight[] {
  const blend = normalizeGenreWeights(choices.genres, custom);
  if (blend.length) return blend;
  const parents = normalizeGenreWeights(
    builderTagIds(choices)
      .flatMap((id) => getTag(id)?.parents ?? [])
      .map((p) => ({ genreId: p.genreId, weight: p.weight })),
    custom,
  );
  return parents.length ? parents : [{ genreId: 'pop', weight: 1 }];
}

/** The blended, tag-adjusted genre profile the builder fills defaults from. */
export function builderGenre(choices: BuilderChoices, custom?: GenreProfile[]): GenreProfile {
  return genreForBlueprint(
    { genreBlend: builderBlend(choices, custom), tags: builderTagIds(choices) },
    custom,
  );
}

/** A tempo feel resolved against a genre's tempo range. */
export function tempoForFeel(feel: TempoFeel, genre: GenreProfile): number {
  const t = genre.tempo;
  const bpm =
    feel === 'slow'
      ? lerp(t.typical, t.min, 0.7)
      : feel === 'fast'
        ? lerp(t.typical, t.max, 0.75)
        : t.typical;
  return clamp(Math.round(bpm), 30, 300);
}

/** Tempo band [lo, hi] a feel stands for in a genre (used to check a model's tempo against the feel). */
export function tempoBand(feel: TempoFeel, genre: GenreProfile): [number, number] {
  const t = genre.tempo;
  const lowMid = (t.min + t.typical) / 2;
  const highMid = (t.typical + t.max) / 2;
  if (feel === 'slow') return [Math.max(30, t.min - 20), lowMid];
  if (feel === 'fast') return [highMid, Math.min(300, t.max + 30)];
  return [lowMid, highMid];
}

/** Names of the structure templates the blended genre offers. */
export function structureTemplateNames(genre: GenreProfile): string[] {
  return [...new Set(genre.structure.templates.map((t) => t.name))];
}

/** Whether the genre expects a lead vocal (essential or common). */
export function genreExpectsVocal(genre: GenreProfile): boolean {
  const v = genre.instruments.find((i) => i.instrumentId === 'lead-vocal');
  return Boolean(v && (v.essential || v.weight >= 0.5));
}

/**
 * A sensible line-up for genres when the user has not picked instruments: the genre's essential
 * and common instruments (no lead vocal — that is the vocal setting), identical entries counted.
 */
export function suggestInstruments(genre: GenreProfile, max = 7): BuilderInstrument[] {
  const out: BuilderInstrument[] = [];
  for (const i of genre.instruments) {
    if (i.instrumentId === 'lead-vocal') continue;
    if (!(i.essential || i.weight >= 0.55)) continue;
    const prev = out.find((o) => o.instrumentId === i.instrumentId && o.role === i.role);
    if (prev) prev.count++;
    else if (out.length < max)
      out.push({
        instrumentId: i.instrumentId,
        count: 1,
        role: i.role,
        ...(i.function ? { function: i.function } : {}),
      });
  }
  return out;
}

/** A working title from lyrics: the first line of the first chorus (else the first line), up to six words. */
export function titleFromLyrics(lyrics: Pick<BlueprintLyrics, 'sections'> | undefined): string | undefined {
  const sections = lyrics?.sections ?? [];
  const src =
    sections.find((s) => (s.kind === 'chorus' || s.kind === 'final-chorus') && s.lines.length) ??
    sections.find((s) => s.lines.length);
  const line = src?.lines[0]
    ?.replace(/[^\p{L}\p{N}'’\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return undefined;
  const words = line.split(' ').slice(0, 6);
  return words
    .map((w, i) =>
      i > 0 && /^(a|an|the|of|in|on|and|to|for|at|by|or)$/i.test(w)
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ');
}

// Preferred tonics (pitch class → weight) by instrument family of the genre.
const TONIC_PREFS: Record<
  'guitar' | 'electronic' | 'keys',
  { major: Record<number, number>; minor: Record<number, number> }
> = {
  guitar: { major: { 7: 4, 4: 3, 9: 3, 2: 3, 0: 2 }, minor: { 4: 6, 9: 3, 11: 2, 2: 2, 7: 1 } },
  electronic: { major: { 0: 2, 5: 2, 7: 2, 2: 1.5 }, minor: { 9: 3, 5: 2.5, 7: 2, 0: 2, 2: 2 } },
  keys: {
    major: { 0: 3, 7: 3, 2: 2, 5: 2, 9: 2, 10: 2, 3: 1.5 },
    minor: { 9: 4, 4: 2, 2: 2, 0: 2, 7: 1.5, 11: 1.5 },
  },
};

function tonicFamily(genre: GenreProfile): keyof typeof TONIC_PREFS {
  const s = genre.rhythm.drumStyle;
  if (['rock', 'punk', 'pop-punk', 'emo', 'metal', 'indie', 'country', 'folk'].includes(s)) return 'guitar';
  if (['four-on-floor', 'trance', 'synth-pop', 'hip-hop', 'trap'].includes(s)) return 'electronic';
  return 'keys';
}

const MAJORISH: ModeName[] = ['major', 'lydian', 'mixolydian'];

function chooseKey(choices: BuilderChoices, genre: GenreProfile, seed: number): KeySignature {
  const rng = deriveRng(seed, 'builder', 'key');
  let mode = choices.key?.mode;
  if (!mode) {
    const modes = genre.modes.length ? genre.modes : [{ mode: 'major' as ModeName, weight: 1 }];
    mode = rng.weighted(
      modes.map((m) => m.mode),
      modes.map((m) => Math.max(0, m.weight)),
    );
  }
  let tonic = choices.key?.tonic;
  if (tonic === undefined || !Number.isInteger(tonic) || tonic < 0 || tonic > 11) {
    const table = TONIC_PREFS[tonicFamily(genre)][MAJORISH.includes(mode) ? 'major' : 'minor'];
    const pcs = Object.keys(table).map(Number);
    tonic = rng.weighted(
      pcs,
      pcs.map((p) => table[p]),
    );
  }
  return { tonic, mode };
}

function topMeter(genre: GenreProfile): { numerator: number; denominator: number } {
  const m = [...genre.meters].sort((a, b) => b.weight - a.weight)[0];
  return { numerator: m?.numerator ?? 4, denominator: m?.denominator ?? 4 };
}

function templateStructure(genre: GenreProfile, name: string | undefined): BlueprintSection[] {
  const templates = genre.structure.templates;
  const pick =
    (name ? templates.find((t) => t.name.toLowerCase() === name.toLowerCase()) : undefined) ??
    [...templates].sort((a, b) => b.weight - a.weight)[0];
  if (!pick) {
    return nameSections(
      (
        ['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'final-chorus', 'outro'] as SectionKind[]
      ).map((kind) => ({ kind, bars: kind === 'intro' || kind === 'outro' ? 4 : 8 })),
    );
  }
  return nameSections(
    pick.sections.map((s) => ({ kind: s.kind, bars: s.bars, ...(s.name ? { name: s.name } : {}) })),
  );
}

const sectionMatches = (target: SectionKind, kind: SectionKind) =>
  target === kind || (target === 'chorus' && (kind === 'final-chorus' || kind === 'post-chorus'));

const MELODY_ORDER = [
  'violin',
  'flute',
  'saxophone',
  'trumpet',
  'synth-lead',
  'electric-guitar-lead',
  'clarinet',
  'french-horn',
  'cello',
  'electric-guitar-clean',
  'piano',
  'electric-piano',
  'marimba',
  'acoustic-guitar',
];

type Item = {
  instrumentId: string;
  role: TrackRole;
  function?: MusicalFunction;
  constraints?: InstrumentConstraints;
};

/** Exact tracks for the chosen instruments (count × each), with vocal and melody duties settled. */
function instrumentItems(
  list: readonly BuilderInstrument[],
  vocal: BuilderVocal | undefined,
  custom?: InstrumentProfile[],
): Item[] {
  const items: Item[] = [];
  for (const entry of list) {
    const inst = findInstrumentProfile(entry.instrumentId, custom);
    if (!inst) continue;
    const count = clamp(Math.round(entry.count || 1), 1, 8);
    const role = entry.role ?? inst.defaultRole;
    for (let k = 0; k < count; k++) {
      const it: Item = { instrumentId: inst.id, role };
      let fn = entry.function;
      // Extra copies of a melodic instrument harmonise instead of doubling the line.
      if (!fn && k > 0 && ['melody', 'hook', 'counter-melody', 'solo'].includes(inst.defaultFunction))
        fn = 'harmony';
      if (!fn && inst.id === 'lead-vocal') fn = k === 0 ? 'melody' : 'harmony';
      if (fn) it.function = fn;
      items.push(it);
    }
  }
  const fnOf = (it: Item) =>
    it.function ?? findInstrumentProfile(it.instrumentId, custom)?.defaultFunction ?? 'accompaniment';
  if (vocal && !items.some((i) => i.role === 'vocal' && fnOf(i) === 'melody' && i.instrumentId !== 'choir'))
    items.unshift({ instrumentId: 'lead-vocal', role: 'vocal', function: 'melody' });
  // Cello is the bass when nothing else is.
  const hasBass = items.some((i) => i.role === 'bass' || fnOf(i) === 'bass-line');
  if (!hasBass) {
    const cello = items.find((i) => i.instrumentId === 'cello' && !i.function);
    if (cello) cello.function = 'bass-line';
  }
  // Instrumental pieces: someone carries the melody.
  if (!items.some((i) => fnOf(i) === 'melody')) {
    const band = items.some((i) => i.role === 'drums' || i.role === 'rhythm-guitar');
    for (const id of MELODY_ORDER) {
      const it = items.find(
        (i) =>
          i.instrumentId === id &&
          !(i.function && i.function !== 'counter-melody' && i.function !== 'hook') &&
          (i.role !== 'keys' || !band || items.length <= 2),
      );
      if (it) {
        it.function = 'melody';
        break;
      }
    }
  }
  return items;
}

function resolveVocal(choices: BuilderChoices, genre: GenreProfile): BuilderVocal | undefined {
  if (choices.vocal === 'none') return undefined;
  if (choices.vocal) return { ...choices.vocal };
  const lyrics = Boolean(choices.lyrics?.sections.some((s) => s.lines.length));
  const listed = (choices.instruments ?? []).some((i) => i.instrumentId === 'lead-vocal');
  if (lyrics || listed || genreExpectsVocal(genre))
    return { voiceType: 'tenor', mode: lyrics ? 'ai-singer' : 'melody-only' };
  return undefined;
}

function targetBarsFor(
  length: BuilderChoices['length'],
  structure: readonly BlueprintSection[],
  tempo: number,
  meter: { numerator: number; denominator: number },
): number | null {
  if (!length || length === 'standard') return null;
  const total = structure.reduce((n, s) => n + s.bars, 0);
  if (length === 'short') return Math.round(total * 0.6);
  if (length === 'long') return Math.round(total * 1.4);
  const minutes = Number(length.minutes);
  if (!(minutes > 0)) return null;
  const beatsPerBar = (meter.numerator * 4) / meter.denominator;
  return Math.max(4, Math.round((minutes * 60 * tempo) / 60 / beatsPerBar));
}

function moodStatement(tag: StyleTag, section?: SectionKind): string {
  if (!section) return tag.name;
  const label = (KIND_LABEL[section] ?? section).toLowerCase();
  return `${tag.name} ${label}`;
}

function applyMoods(structure: BlueprintSection[], choices: BuilderChoices): BlueprintSection[] {
  const moods = moodTags(choices);
  const global = moods.filter((m) => !m.section).map((m) => m.tag.name.toLowerCase());
  const targeted = moods.filter((m) => m.section);
  return structure.map((s) => {
    const mine = targeted.filter((m) => sectionMatches(m.section!, s.kind));
    const out: BlueprintSection = { ...s };
    const words = mine.length ? mine.map((m) => m.tag.name.toLowerCase()) : global;
    if (words.length) out.mood = [...new Set(words)];
    if (mine.length) {
      // A section mood nudges that section's energy by the tag's energy character.
      const delta = mine.reduce(
        (t, m) => t + (m.tag.effect.energyShift ?? Math.round((m.tag.effect.macros?.energy ?? 0) * 40)),
        0,
      );
      if (delta && out.energy !== undefined) out.energy = Math.round(clamp(out.energy + delta, 5, 100));
      if (delta && out.energyEnd !== undefined)
        out.energyEnd = Math.round(clamp(out.energyEnd + delta, 5, 100));
    }
    return out;
  });
}

const PC_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * The choices the user fixed, as plain-language lines (for a language model's prompt and for
 * summaries). Open choices are not listed.
 */
export function describeChoices(choices: BuilderChoices, opts: Omit<BuilderOptions, 'seed'> = {}): string[] {
  const out: string[] = [];
  const inst = (choices.instruments ?? [])
    .map((i) => {
      const p = findInstrumentProfile(i.instrumentId, opts.customInstruments);
      if (!p || !(i.count > 0)) return '';
      const extra = [i.role ? `role ${i.role}` : '', i.function ? `plays ${i.function}` : '']
        .filter(Boolean)
        .join(', ');
      return `${p.name} (${p.id}) × ${Math.round(i.count)}${extra ? ` [${extra}]` : ''}`;
    })
    .filter(Boolean);
  if (inst.length) out.push(`Instruments, exactly these tracks and counts: ${inst.join('; ')}`);
  const blend = normalizeGenreWeights(choices.genres, opts.customGenres);
  if (blend.length)
    out.push(`Genre blend: ${blend.map((g) => `${g.genreId} ${Math.round(g.weight * 100)}%`).join(', ')}`);
  const moods = moodTags(choices);
  if (moods.length)
    out.push(
      `Moods: ${moods.map((m) => (m.section ? `${m.tag.id} (${m.section} only)` : m.tag.id)).join(', ')}`,
    );
  const tags = resolveTagIds(choices.tags);
  if (tags.length) out.push(`Tags: ${tags.join(', ')}`);
  if (typeof choices.tempo === 'number') out.push(`Tempo: ${Math.round(choices.tempo)} BPM`);
  else if (choices.tempo) out.push(`Tempo feel: ${choices.tempo}`);
  if (choices.key?.tonic !== undefined || choices.key?.mode)
    out.push(
      `Key: ${choices.key.tonic !== undefined ? (PC_NAMES[choices.key.tonic] ?? '') : 'any tonic'} ${choices.key.mode ?? ''}`.trim(),
    );
  if (choices.meter) out.push(`Meter: ${choices.meter.numerator}/${choices.meter.denominator}`);
  if (choices.length && choices.length !== 'standard')
    out.push(
      `Length: ${typeof choices.length === 'string' ? choices.length : `${choices.length.minutes} minutes`}`,
    );
  if (choices.structure) out.push(`Structure template: ${choices.structure}`);
  if (choices.vocal === 'none') out.push('Vocal: none (instrumental)');
  else if (choices.vocal) out.push(`Vocal: ${choices.vocal.voiceType}, ${choices.vocal.mode}`);
  if (choices.title?.trim()) out.push(`Title: ${choices.title.trim()}`);
  if (choices.lyricsTheme?.trim()) out.push(`Lyrics theme: ${choices.lyricsTheme.trim()}`);
  if (choices.lyrics?.sections.length)
    out.push(`Structure follows the user's lyrics: ${choices.lyrics.sections.map((s) => s.name).join(', ')}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Builder → Blueprint
// ---------------------------------------------------------------------------------------------

/**
 * Turn builder choices into a complete Blueprint. Pure and deterministic for (choices, seed,
 * custom profiles). Every explicit choice is used exactly; open choices come from the genre blend.
 */
export function blueprintFromChoices(choices: BuilderChoices, opts: BuilderOptions): Blueprint {
  const custom = opts.customGenres;
  const seed = Math.floor(Math.abs(opts.seed ?? 1));
  const blend = builderBlend(choices, custom);
  const tags = builderTagIds(choices);
  const genre = genreForBlueprint({ genreBlend: blend, tags }, custom);

  // Tempo, meter, key.
  let tempo: number;
  if (typeof choices.tempo === 'number' && Number.isFinite(choices.tempo))
    tempo = clamp(Math.round(choices.tempo), 30, 300);
  else if (typeof choices.tempo === 'string') tempo = tempoForFeel(choices.tempo, genre);
  else tempo = clamp(Math.round(genre.tempo.typical), 30, 300);
  const meter =
    choices.meter && choices.meter.numerator > 0 && [2, 4, 8, 16].includes(choices.meter.denominator)
      ? { numerator: Math.round(choices.meter.numerator), denominator: choices.meter.denominator }
      : topMeter(genre);
  const key = chooseKey(choices, genre, seed);

  // Vocal and instrumentation.
  const vocal = resolveVocal(choices, genre);
  const chosen = (choices.instruments ?? []).filter(
    (i) => findInstrumentProfile(i.instrumentId, opts.customInstruments) && i.count > 0,
  );
  const lineup = chosen.length ? chosen : suggestInstruments(genre);
  const instrumentation = nameBlueprintTracks(instrumentItems(lineup, vocal, opts.customInstruments));

  // Structure.
  const lyrics = choices.lyrics && choices.lyrics.sections.length ? choices.lyrics : undefined;
  let structure: BlueprintSection[];
  if (lyrics) structure = structureFromLyrics(lyrics, { tempo, meter });
  else {
    structure = templateStructure(genre, choices.structure);
    const target = targetBarsFor(choices.length, structure, tempo, meter);
    if (target !== null) structure = fitStructure(structure, target);
  }
  structure = applyMoods(shapeEnergies(structure, genre), choices);

  // Moods, styles, macros.
  const moods = moodTags(choices);
  const statements = [
    ...new Set([
      ...moods.filter((m) => !m.section).map((m) => moodStatement(m.tag)),
      ...moods.filter((m) => m.section).map((m) => moodStatement(m.tag, m.section)),
    ]),
  ];
  const styleNames = tags
    .map((id) => getTag(id)!)
    .filter((t) => t.kind === 'style')
    .map((t) => t.name);
  const genreNames = [...blend]
    .sort((a, b) => b.weight - a.weight)
    .map((g) => getGenre(g.genreId, custom)?.name ?? g.genreId);
  // Tag macro nudges are applied where the song is composed (genreForBlueprint / applyTagsToMacros), not baked in here.
  const macros: MacroSettings = {
    ...defaultMacros(),
    ...(genreForBlend(blend, custom).macros ?? {}),
    ...(choices.macros ?? {}),
  };

  const bp: Blueprint = {
    title: choices.title?.trim() || titleFromLyrics(lyrics) || 'Untitled',
    tempo,
    meter,
    key,
    styles: [...new Set([...genreNames, ...styleNames])],
    genreBlend: blend,
    moods: statements,
    instrumentation,
    structure,
    tags,
    macros,
    seed,
  };
  if (vocal) bp.vocal = vocal;
  if (choices.lyricsTheme?.trim()) bp.lyricsTheme = choices.lyricsTheme.trim();
  if (lyrics)
    bp.lyrics = {
      text: lyrics.text,
      sections: lyrics.sections.map((s) => ({ name: s.name, kind: s.kind, lines: [...s.lines] })),
      ...(lyrics.lock === false ? { lock: false } : {}),
    };
  return bp;
}

/**
 * Re-impose the user's choices on a blueprint designed elsewhere (a language model): chosen
 * instruments/counts, genres, tags (the model's unknown tags are dropped, known ones kept), moods,
 * tempo (or tempo feel), key, meter, structure/length/lyrics, vocal, title and theme.
 */
export function applyBuilderConstraints(
  bp: Blueprint,
  choices: BuilderChoices,
  opts: BuilderOptions,
): Blueprint {
  const base = blueprintFromChoices(choices, opts);
  const out: Blueprint = { ...bp, seed: base.seed };
  const custom = opts.customGenres;

  if (
    (choices.instruments ?? []).some(
      (i) => i.count > 0 && findInstrumentProfile(i.instrumentId, opts.customInstruments),
    )
  ) {
    // Keep the model's per-track detail (ranges, complexity…) where it chose the same instrument.
    const pool = [...(bp.instrumentation ?? [])];
    out.instrumentation = base.instrumentation.map((t) => {
      const j = pool.findIndex((m) => m.instrumentId === t.instrumentId && m.role === t.role);
      if (j < 0) return t;
      const m = pool.splice(j, 1)[0];
      const merged: BlueprintTrack = { ...t };
      if (m.constraints)
        merged.constraints = { ...m.constraints, ...(t.function ? { function: t.function } : {}) };
      return merged;
    });
  } else if (choices.vocal === 'none') {
    out.instrumentation = (bp.instrumentation ?? []).filter(
      (t) => !(t.role === 'vocal' && t.instrumentId === 'lead-vocal'),
    );
    if (!out.instrumentation.length) out.instrumentation = base.instrumentation;
  } else if (choices.vocal && !(bp.instrumentation ?? []).some((t) => t.instrumentId === 'lead-vocal')) {
    out.instrumentation = nameBlueprintTracks([
      { instrumentId: 'lead-vocal', role: 'vocal', function: 'melody' },
      ...(bp.instrumentation ?? []),
    ]);
  }

  if (normalizeGenreWeights(choices.genres, custom).length) {
    out.genreBlend = base.genreBlend;
    out.styles = [
      ...new Set([
        ...base.styles,
        ...(bp.styles ?? []).filter(
          (s) => !(bp.genreBlend ?? []).some((g) => getGenre(g.genreId, custom)?.name === s),
        ),
      ]),
    ];
  } else if (!out.genreBlend?.length) out.genreBlend = base.genreBlend;

  out.tags = resolveTagIds([...(base.tags ?? []), ...(bp.tags ?? [])]);

  if (typeof choices.tempo === 'number') out.tempo = base.tempo;
  else if (typeof choices.tempo === 'string') {
    const [lo, hi] = tempoBand(choices.tempo, builderGenre(choices, custom));
    if (!(out.tempo >= lo && out.tempo <= hi)) out.tempo = base.tempo;
  }
  if (choices.key?.tonic !== undefined || choices.key?.mode) {
    out.key = {
      tonic: choices.key.tonic ?? bp.key?.tonic ?? base.key.tonic,
      mode: choices.key.mode ?? bp.key?.mode ?? base.key.mode,
    };
  }
  if (choices.meter) out.meter = base.meter;

  if (
    choices.lyrics?.sections.length ||
    choices.structure ||
    (choices.length && choices.length !== 'standard') ||
    !out.structure?.length
  )
    out.structure = base.structure;
  else if (moodTags(choices).length) out.structure = applyMoods(out.structure, choices);
  if (base.lyrics) out.lyrics = base.lyrics;
  else delete out.lyrics;

  const userMoods = base.moods;
  out.moods = [
    ...new Set([
      ...userMoods,
      ...(bp.moods ?? []).filter((m) => !userMoods.some((u) => u.toLowerCase() === m.toLowerCase())),
    ]),
  ];

  if (choices.vocal === 'none') delete out.vocal;
  else if (choices.vocal || (base.vocal && !out.vocal)) out.vocal = base.vocal;
  if (choices.title?.trim()) out.title = base.title;
  else if (!out.title || out.title === 'Untitled') out.title = base.title;
  if (choices.lyricsTheme?.trim()) out.lyricsTheme = base.lyricsTheme;
  if (choices.macros) out.macros = { ...defaultMacros(), ...(bp.macros ?? {}), ...choices.macros };
  if (!out.macros) out.macros = base.macros;
  return out;
}
