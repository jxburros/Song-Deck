/**
 * "Generate MIDI" mode (spec §25): a single musical asset — a melody, bass line, drum pattern,
 * chord part… — as a one-track mini-song over the requested progression (symbols or roman
 * numerals) or a genre-appropriate one.
 */
import type {
  AssetRequest,
  BlueprintSection,
  GenreProfile,
  InstrumentProfile,
  MacroSettings,
  SectionKind,
  Song,
  TrackRole,
} from '../ir/types';
import { defaultBlueprint } from './blueprint';
import { composeSong } from './compose';
import { blendGenres } from './genres';
import { getInstrument } from './instruments';
import { clamp, clamp01 } from './util';

const HIGH_ENERGY = [
  'aggressive',
  'angry',
  'energetic',
  'epic',
  'huge',
  'driving',
  'intense',
  'triumphant',
  'euphoric',
  'fast',
  'heavy',
  'anthemic',
  'powerful',
];
const LOW_ENERGY = [
  'sad',
  'melancholy',
  'melancholic',
  'calm',
  'chill',
  'gentle',
  'soft',
  'dreamy',
  'peaceful',
  'lonely',
  'somber',
  'slow',
  'intimate',
  'reflective',
];

export interface GenerateAssetOptions {
  /** Custom genre profiles (Settings, plugins, project) the request may name. */
  customGenres?: GenreProfile[];
  /** Custom instrument profiles the request may name. */
  customInstruments?: InstrumentProfile[];
}

/** Generate one asset track. The returned song has exactly one track. */
export function generateAsset(
  request: AssetRequest,
  seed: number,
  opts: GenerateAssetOptions = {},
): { song: Song; trackId: string } {
  const inst = getInstrument(request.instrumentId, opts.customInstruments);
  const role: TrackRole = request.role ?? inst.defaultRole;
  const fn = request.function ?? (role === 'vocal' ? 'melody' : inst.defaultFunction);
  const genreIds = request.genreIds && request.genreIds.length ? request.genreIds : ['pop'];
  const genreBlend = genreIds.map((genreId) => ({ genreId, weight: 1 }));
  const genre = blendGenres(genreBlend, opts.customGenres);
  const bars = clamp(Math.round(request.bars || 8), 1, 256);
  const moods = (request.moods ?? []).map((m) => m.toLowerCase());
  const text = `${moods.join(' ')} ${request.description ?? ''}`.toLowerCase();
  const hi = HIGH_ENERGY.some((w) => text.includes(w));
  const lo = LOW_ENERGY.some((w) => text.includes(w));
  const rhythmic = role === 'drums' || role === 'percussion';
  let energy = rhythmic ? 78 : 58;
  if (hi) energy += 18;
  if (lo) energy -= 22;
  energy = clamp(energy, 15, 100);
  const kind: SectionKind = energy >= 75 ? 'chorus' : 'verse';
  // Long melodic assets get an A/B shape (statement, then a lifted answer).
  let structure: BlueprintSection[];
  const melodic =
    fn === 'melody' || fn === 'counter-melody' || fn === 'hook' || fn === 'solo' || role === 'vocal';
  if (melodic && bars >= 16) {
    const a = Math.floor(bars / 2);
    structure = [
      { name: 'A', kind: 'verse', bars: a, energy: clamp(energy - 8, 10, 100) },
      { name: 'B', kind: 'chorus', bars: bars - a, energy: clamp(energy + 8, 10, 100) },
    ];
  } else {
    structure = [{ name: 'Asset', kind, bars, energy }];
  }
  if (request.progression && request.progression.length)
    structure = structure.map((s) => ({ ...s, harmony: [...request.progression!] }));
  const macros: Partial<MacroSettings> = {};
  if (request.complexity)
    macros.complexity = request.complexity === 'low' ? 0.22 : request.complexity === 'high' ? 0.85 : 0.5;
  if (hi) macros.energy = 0.8;
  if (lo) macros.energy = clamp01(0.3);
  const name = request.description?.trim() ? request.description.trim().slice(0, 60) : `${inst.name} asset`;
  const bp = defaultBlueprint({
    title: name,
    prompt: request.description,
    tempo: clamp(Math.round(request.tempo || genre.tempo.typical), 30, 300),
    meter: request.meter ?? { numerator: 4, denominator: 4 },
    key: request.key,
    genreBlend,
    moods: request.moods ?? [],
    instrumentation: [
      {
        name: inst.name,
        instrumentId: inst.id,
        role,
        function: fn,
        constraints: {
          function: fn,
          sectionKinds: [...new Set(structure.map((s) => s.kind))],
          ...(request.complexity ? { complexity: request.complexity } : {}),
        },
      },
    ],
    structure,
    macros: { ...defaultBlueprint({ genreBlend }).macros, ...macros },
    seed: request.seed ?? seed,
  });
  if (role === 'vocal') bp.vocal = { voiceType: 'tenor', mode: 'melody-only' };
  else delete bp.vocal;
  const song = composeSong(bp, undefined, {
    seed: request.seed ?? seed,
    customGenres: opts.customGenres,
    customInstruments: opts.customInstruments,
  });
  return { song, trackId: song.tracks[0].id };
}
