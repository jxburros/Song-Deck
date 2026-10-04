/**
 * Composition planning (spec §15): an abstract plan (sections, bars, harmony, energy, purpose)
 * produced before any MIDI. Every generator consumes the same plan.
 */
import type {
  Blueprint,
  BlueprintSection,
  ChordSpec,
  CompositionPlan,
  GenreProfile,
  PlanSection,
  SectionFeel,
  SectionKind,
} from '../ir/types';
import { defaultMacros } from '../ir/defaults';
import { deriveRng } from '../util/random';
import { keyName } from '../theory/scales';
import { applyTagsToMacros, blendForBlueprint, genreForBlueprint, tagMeter } from './tags';
import { defaultBlueprint } from './blueprint';
import {
  chooseProgression,
  colorProgression,
  expandHarmony,
  flavorFor,
  moodDarkness,
  globalMoodDarkness,
  snapHarmonicRhythm,
  type PlannedHarmony,
} from './harmony';
import { clamp, parseHarmonyToken } from './util';

export type HarmonyGroup =
  'verse' | 'chorus' | 'pre' | 'bridge' | 'breakdown' | 'solo' | 'post' | 'intro' | 'outro' | 'interlude';

export function harmonyGroupOf(kind: SectionKind): HarmonyGroup {
  switch (kind) {
    case 'chorus':
    case 'final-chorus':
    case 'drop':
      return 'chorus';
    case 'post-chorus':
      return 'post';
    case 'pre-chorus':
    case 'build':
      return 'pre';
    case 'bridge':
      return 'bridge';
    case 'breakdown':
      return 'breakdown';
    case 'solo':
      return 'solo';
    case 'intro':
      return 'intro';
    case 'outro':
      return 'outro';
    case 'interlude':
      return 'interlude';
    default:
      return 'verse';
  }
}

const GROUP_ORDER: HarmonyGroup[] = [
  'verse',
  'chorus',
  'pre',
  'bridge',
  'breakdown',
  'solo',
  'post',
  'intro',
  'outro',
  'interlude',
];

/** Musical purpose of a section in context (the "Purpose" column of §15). */
export function purposeFor(
  kind: SectionKind,
  occurrence: number,
  energy: number,
  energyEnd: number | undefined,
  isFirst: boolean,
): string {
  const rising = energyEnd !== undefined && energyEnd > energy + 8;
  switch (kind) {
    case 'intro':
      return isFirst ? 'Establish motif' : 'Re-introduce motif';
    case 'verse':
      if (occurrence === 1) return energy < 55 ? 'Restrained' : 'Set the scene';
      return occurrence === 2 ? 'Develop the story' : 'Final verse';
    case 'pre-chorus':
      return 'Rising tension';
    case 'chorus':
      return occurrence === 1 ? 'Emotional release' : 'Release (hook returns)';
    case 'post-chorus':
      return 'Hook reprise';
    case 'bridge':
      return rising ? 'Build' : 'Contrast';
    case 'breakdown':
      return 'Strip back';
    case 'build':
      return 'Build tension';
    case 'drop':
      return occurrence === 1 ? 'Peak energy' : 'Peak energy (reprise)';
    case 'solo':
      return 'Instrumental feature';
    case 'interlude':
      return 'Breathe';
    case 'final-chorus':
      return 'Maximum release';
    case 'outro':
      return energyEnd !== undefined && energyEnd < energy ? 'Wind down' : 'Resolve';
    default:
      return 'Develop';
  }
}

function parseExplicitHarmony(tokens: readonly string[], key: Blueprint['key']): ChordSpec[] {
  const out: ChordSpec[] = [];
  for (const t of tokens) {
    const c = parseHarmonyToken(t, key);
    if (c)
      out.push(
        c.bass !== undefined
          ? { root: c.root, quality: c.quality, bass: c.bass }
          : { root: c.root, quality: c.quality },
      );
  }
  return out;
}

export interface PlanOptions {
  seed?: number;
  customGenres?: GenreProfile[];
}

/**
 * Build the abstract plan: per-section harmony (chord symbols in key), energy (with ramps),
 * purpose and feel. Choruses lift away from verses, pre-choruses lean on dominant-function
 * chords, darker moods borrow from the parallel minor, harmonic tension adds extensions,
 * secondary dominants and suspensions. Repeated sections reuse their group's harmony.
 */
export function planComposition(blueprint: Blueprint, opts: PlanOptions = {}): CompositionPlan {
  const seed = opts.seed ?? blueprint.seed ?? 1;
  const blend = blendForBlueprint(blueprint);
  const genre = genreForBlueprint({ genreBlend: blend, tags: blueprint.tags }, opts.customGenres);
  const key = { ...blueprint.key };
  const meter = tagMeter(blueprint.tags) ?? {
    numerator: blueprint.meter?.numerator ?? 4,
    denominator: blueprint.meter?.denominator ?? 4,
  };
  const tempo = clamp(Math.round(blueprint.tempo || genre.tempo.typical), 20, 400);
  const macros = applyTagsToMacros({ ...defaultMacros(), ...(blueprint.macros ?? {}) }, blueprint.tags);
  const sections: BlueprintSection[] = (
    blueprint.structure && blueprint.structure.length
      ? blueprint.structure
      : defaultBlueprint({ genreBlend: blend }).structure
  ).filter((s) => s.bars > 0);
  const globalDark = globalMoodDarkness(blueprint.moods ?? []);
  const flavor = flavorFor(genre);
  const hrBase = snapHarmonicRhythm(genre.harmony.harmonicRhythm);
  const powerChords = genre.harmony.powerChords === true;

  // 1. Choose one progression per harmony group, in musical dependency order.
  const raw: PlannedHarmony = {};
  const colored = new Map<HarmonyGroup, ChordSpec[]>();
  for (const grp of GROUP_ORDER) {
    const members = sections.filter((s) => harmonyGroupOf(s.kind) === grp);
    if (!members.length) continue;
    const explicit = members.find((s) => s.harmony && s.harmony.length);
    const rng = deriveRng(seed, 'plan', 'harmony', grp);
    const kind = members[0].kind;
    if (explicit) {
      const chords = parseExplicitHarmony(explicit.harmony!, key);
      if (chords.length) {
        colored.set(grp, chords);
        if (grp === 'verse') raw.verse = chords;
        if (grp === 'chorus') raw.chorus = chords;
        if (grp === 'pre') raw.pre = chords;
        if (grp === 'bridge') raw.bridge = chords;
        continue;
      }
    }
    const reuse = (from: HarmonyGroup | undefined): ChordSpec[] | undefined =>
      from ? colored.get(from)?.map((c) => ({ ...c })) : undefined;
    let chords: ChordSpec[] | undefined;
    let needsColor = true;
    switch (grp) {
      case 'verse':
        chords = chooseProgression(genre, key, kind, raw, rng);
        raw.verse = chords;
        break;
      case 'chorus':
        chords = chooseProgression(genre, key, kind, raw, rng);
        raw.chorus = chords;
        break;
      case 'pre':
        chords = chooseProgression(genre, key, kind, raw, rng);
        raw.pre = chords;
        break;
      case 'bridge':
        chords = chooseProgression(genre, key, kind, raw, rng);
        raw.bridge = chords;
        break;
      case 'breakdown':
        if (colored.has('chorus') && rng.chance(0.5)) {
          chords = reuse('chorus');
          needsColor = false;
        } else chords = chooseProgression(genre, key, kind, raw, rng);
        break;
      case 'solo':
        if (colored.has('verse') && rng.chance(0.6)) chords = reuse('verse');
        else if (colored.has('chorus')) chords = reuse('chorus');
        else chords = chooseProgression(genre, key, kind, raw, rng);
        needsColor = !chords || !colored.has('verse');
        break;
      case 'post':
        chords = reuse('chorus') ?? chooseProgression(genre, key, kind, raw, rng);
        needsColor = !colored.has('chorus');
        break;
      case 'intro':
        chords =
          (rng.chance(0.55) ? reuse('chorus') : reuse('verse')) ??
          reuse('chorus') ??
          chooseProgression(genre, key, 'verse', raw, rng);
        needsColor = !colored.has('chorus') && !colored.has('verse');
        break;
      case 'outro':
        chords =
          (rng.chance(0.65) ? reuse('chorus') : reuse('verse')) ??
          reuse('verse') ??
          chooseProgression(genre, key, 'verse', raw, rng);
        needsColor = !colored.has('chorus') && !colored.has('verse');
        break;
      case 'interlude':
        chords = reuse('verse')?.slice(0, 2) ?? chooseProgression(genre, key, kind, raw, rng);
        needsColor = !colored.has('verse');
        break;
    }
    if (!chords || !chords.length) continue;
    if (needsColor) {
      const groupMoods = members.flatMap((s) => s.mood ?? []);
      const darkness = groupMoods.length ? moodDarkness(groupMoods) * 0.7 + globalDark * 0.3 : globalDark;
      chords = colorProgression(
        chords,
        key,
        {
          extensionRate: genre.harmony.extensionRate,
          borrowedRate: genre.harmony.borrowedChordRate,
          tension: macros.harmonicTension,
          darkness,
          powerChords,
          flavor,
          protectFirst: grp === 'chorus' || grp === 'verse',
        },
        deriveRng(seed, 'plan', 'color', grp),
      );
    }
    colored.set(grp, chords);
  }

  // 2. Realize each section.
  const occurrences = new Map<SectionKind, number>();
  const planSections: PlanSection[] = sections.map((s, i) => {
    const occ = (occurrences.get(s.kind) ?? 0) + 1;
    occurrences.set(s.kind, occ);
    const grp = harmonyGroupOf(s.kind);
    const energy = clamp(Math.round(s.energy ?? genre.dynamics.energyBySection[s.kind] ?? 55), 0, 100);
    const energyEnd = s.energyEnd !== undefined ? clamp(Math.round(s.energyEnd), 0, 100) : undefined;
    const isLast = i === sections.length - 1;
    let harmony: string[];
    const own = s.harmony && s.harmony.length ? parseExplicitHarmony(s.harmony, key) : null;
    const rng = deriveRng(seed, 'plan', 'section', grp, s.kind);
    if (own && own.length) {
      harmony = s
        .harmony!.filter((t) => parseHarmonyToken(t, key))
        .map((t) => {
          const c = parseHarmonyToken(t, key)!;
          return expandHarmony([c], 1, 1, key)[0];
        });
    } else {
      const chords = colored.get(grp) ?? colored.get('verse') ?? colored.get('chorus') ?? [];
      let hr = hrBase;
      if (hr >= 2 && tempo >= 150) hr = 1;
      if (
        (s.kind === 'intro' || s.kind === 'outro' || s.kind === 'breakdown') &&
        energy < 45 &&
        chords.length <= 4 &&
        rng.chance(0.5)
      )
        hr = 0.5;
      if (s.kind === 'build' && hr > 1) hr = 1;
      const susResolve =
        (s.kind === 'pre-chorus' || s.kind === 'build') &&
        !powerChords &&
        macros.harmonicTension >= 0.4 &&
        rng.chance(0.35 + macros.harmonicTension * 0.4);
      harmony = expandHarmony(chords, s.bars, hr, key, {
        endOnTonic: isLast && (s.kind === 'outro' || s.kind === 'final-chorus' || sections.length > 1),
        susResolve,
      });
    }
    let feel: SectionFeel | undefined = s.feel;
    if (!feel) {
      const ht = genre.rhythm.halfTimeChance ?? 0;
      const frng = deriveRng(seed, 'plan', 'feel', grp);
      if (
        (s.kind === 'bridge' || s.kind === 'breakdown') &&
        frng.chance(ht * (s.kind === 'breakdown' ? 1.6 : 1))
      )
        feel = 'half-time';
    }
    const purpose = s.purpose ?? purposeFor(s.kind, occ, energy, energyEnd, i === 0);
    const ps: PlanSection = {
      name: s.name || `Section ${i + 1}`,
      kind: s.kind,
      bars: Math.max(1, Math.round(s.bars)),
      harmony,
      energy,
      purpose,
    };
    if (energyEnd !== undefined) ps.energyEnd = energyEnd;
    if (feel) ps.feel = feel;
    return ps;
  });

  return {
    key,
    tempo,
    meter,
    sections: planSections,
    notes: `${keyName(key)} · ${tempo} BPM · ${meter.numerator}/${meter.denominator} · ${genre.name}`,
    source: 'internal',
  };
}
