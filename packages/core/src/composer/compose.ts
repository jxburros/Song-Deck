/**
 * Full deterministic composition pipeline (spec §1, §12):
 * Blueprint → Plan → sections & chords → tracks & mixer → motifs → role generators → Song.
 * Same blueprint + plan + seed + ENGINE_VERSION ⇒ identical song (songHash).
 */
import type {
  Blueprint,
  CompositionPlan,
  GenreProfile,
  InstrumentConstraints,
  InstrumentProfile,
  Motif,
  Song,
  Track,
  VoiceType,
} from '../ir/types';
import { ENGINE_VERSION, createEmptySong, defaultMacros } from '../ir/defaults';
import { cloneSong } from '../ir/song-utils';
import { IdFactory } from '../util/ids';
import { resolveFunction } from './arrangement';
import { buildSongGen, type StyleOverrides } from './context';
import { writeCells } from './engine';
import { blendGenres } from './genres';
import { getInstrument } from './instruments';
import { placeBlueprintLyrics } from './lyrics-first';
import { fillMixer, mixerForGenre, trackColor } from './mixer';
import { buildSongMotifs } from './motifs';
import { planComposition } from './planner';
import { sectionsFromPlan, writePlanChords } from './structure';
import { extractSongDNA } from './dna';
import { meterInfo } from './util';

export interface ComposeOptions {
  seed?: number;
  customGenres?: GenreProfile[];
  customInstruments?: InstrumentProfile[];
  songId?: string;
}

/** Internal knobs used by DNA composition, mutation and branch templates. */
export interface ComposeInternals {
  motifs?: Motif[];
  trackIds?: (string | undefined)[];
  sectionIds?: (string | undefined)[];
  overrides?: StyleOverrides;
  /** Skip note generation (structure, tracks, mixer and motifs only). */
  skipNotes?: boolean;
  /** Hook to adjust the draft (e.g. restore locked chords, copy lyrics) right before notes are generated. */
  beforeNotes?: (draft: Song) => void;
}

const RIFF_STYLES = ['rock', 'metal', 'punk', 'pop-punk', 'emo'];

/** Song tracks for a blueprint's instrumentation (deterministic ids, MIDI channels, colours, vocal ranges). */
export function tracksFromBlueprint(bp: Blueprint, seed: number, custom?: InstrumentProfile[], presetIds?: (string | undefined)[]): Track[] {
  const ids = new IdFactory(seed, 'tracks');
  let channel = 0;
  const leadVoice: VoiceType = bp.vocal?.voiceType ?? 'tenor';
  const used = new Set<string>();
  return bp.instrumentation.map((bt, i) => {
    const inst = getInstrument(bt.instrumentId, custom);
    let id = presetIds?.[i] ?? ids.next('trk');
    while (used.has(id)) id = ids.next('trk');
    used.add(id);
    const constraints: InstrumentConstraints = { ...(bt.constraints ?? {}) };
    if (!constraints.function && bt.function) constraints.function = bt.function;
    let midiChannel: number;
    if (inst.isDrumKit) midiChannel = 9;
    else {
      if (channel === 9) channel++;
      midiChannel = channel % 16;
      channel++;
    }
    const track: Track = {
      id,
      name: bt.name || inst.name,
      kind: 'midi',
      role: bt.role,
      instrumentId: inst.id,
      constraints,
      notes: [],
      clips: [],
      color: trackColor(bt.role),
      stemGroup: inst.stemGroup,
      midiChannel,
      generator: { id: `composer/${bt.role}`, seed },
    };
    if (bt.role === 'vocal' && inst.id !== 'choir') {
      track.vocal = { voiceType: leadVoice, mode: bp.vocal?.mode ?? 'melody-only' };
    }
    return track;
  });
}

export function composeInternal(blueprint: Blueprint, planIn: CompositionPlan | undefined, opts: ComposeOptions, internal: ComposeInternals): Song {
  const seed = Math.floor(Math.abs(opts.seed ?? blueprint.seed ?? 1));
  const plan = planIn ?? planComposition(blueprint, { seed, customGenres: opts.customGenres });
  const blend = blueprint.genreBlend && blueprint.genreBlend.length ? blueprint.genreBlend : [{ genreId: 'pop', weight: 1 }];
  const genre = blendGenres(blend, opts.customGenres);
  const songId = opts.songId ?? new IdFactory(seed, 'song').next('song');
  const song = createEmptySong({ id: songId, title: blueprint.title || 'Untitled', bpm: plan.tempo, meter: plan.meter, key: plan.key, seed });
  song.genreBlend = blend.map((g) => ({ ...g }));
  song.macros = { ...defaultMacros(), ...(blueprint.macros ?? {}) };
  song.blueprint = cloneSong(blueprint);
  song.plan = cloneSong(plan);
  song.generation = { seed, variation: 0, engineVersion: ENGINE_VERSION };

  // Structure & harmony.
  const planSections = plan.sections.filter((s) => s.bars > 0);
  const structureIds = new IdFactory(seed, 'structure');
  const moods = planSections.map((ps, i) => (blueprint.structure?.[i]?.kind === ps.kind ? blueprint.structure[i].mood : undefined));
  song.sections = sectionsFromPlan(planSections, () => structureIds.next('sec'), internal.sectionIds, moods);
  writePlanChords(song, { ...plan, sections: planSections }, seed);

  // Tracks, mixer.
  song.tracks = tracksFromBlueprint(blueprint, seed, opts.customInstruments, internal.trackIds);
  const instOf = (t: Track) => getInstrument(t.instrumentId, opts.customInstruments);
  song.mixer = mixerForGenre(genre);
  const pans = new Map<string, number>();
  blueprint.instrumentation.forEach((bt, i) => {
    if (bt.pan !== undefined && song.tracks[i]) pans.set(song.tracks[i].id, bt.pan);
  });
  fillMixer(song, genre, instOf, pans);

  // Motifs: who sings/plays them.
  const melodyTrack = song.tracks.find((t) => t.role === 'vocal' && resolveFunction(t, instOf(t)) === 'melody') ?? song.tracks.find((t) => resolveFunction(t, instOf(t)) === 'melody');
  const hookTrack = song.tracks.find((t) => (t.role === 'lead-guitar' || t.role === 'synth-lead') && resolveFunction(t, instOf(t)) !== 'counter-melody') ?? song.tracks.find((t) => resolveFunction(t, instOf(t)) === 'hook');
  const answerTrack = song.tracks.find((t) => resolveFunction(t, instOf(t)) === 'counter-melody');
  const riffTrack = song.tracks.find((t) => t.role === 'rhythm-guitar');
  const sources: { vocal?: string; hook?: string; answer?: string; riff?: string } = {};
  if (melodyTrack) sources.vocal = melodyTrack.id;
  if (hookTrack) sources.hook = hookTrack.id;
  if (answerTrack) sources.answer = answerTrack.id;
  if (riffTrack) sources.riff = riffTrack.id;
  const firstVerse = song.sections.find((s) => s.kind === 'verse') ?? song.sections[0];
  void firstVerse;
  song.motifs = internal.motifs
    ? cloneSong(internal.motifs)
    : buildSongMotifs({
        seed,
        meter: meterInfo(plan.meter, song.ppq),
        bpm: plan.tempo,
        density: song.macros.density,
        syncopation: song.macros.syncopation,
        movement: song.macros.melodicMovement,
        riff: RIFF_STYLES.includes(genre.rhythm.drumStyle) && Boolean(riffTrack),
        flatVocal: genre.rhythm.drumStyle === 'hip-hop' || genre.rhythm.drumStyle === 'trap',
        sources,
      });

  // Vocal, production and mastering settings.
  song.vocals.mode = melodyTrack && melodyTrack.role === 'vocal' ? blueprint.vocal?.mode ?? 'melody-only' : 'none';
  const moodText = (blueprint.moods ?? []).join(', ');
  song.production.prompt = `${genre.production.description}. ${genre.production.keywords.join(', ')}${moodText ? `. Mood: ${moodText}` : ''}`;
  song.mastering.target = genre.production.masteringTarget ?? 'streaming';

  // Lyrics supplied up front (lyrics-first): the user's words, sung by the lead vocal and locked.
  if (blueprint.lyrics?.sections?.length) placeBlueprintLyrics(song, blueprint.lyrics, seed);
  internal.beforeNotes?.(song);
  if (!internal.skipNotes) {
    const g = buildSongGen(song, { seed, customInstruments: opts.customInstruments, customGenres: opts.customGenres, overrides: internal.overrides });
    writeCells(g, seed, { respectLocks: false });
  }
  song.dna = extractSongDNA(song);
  return song;
}

/**
 * Compose a complete song from a blueprint (and optionally a plan produced by an AI planner or
 * edited by the user). Deterministic for blueprint + plan + seed + ENGINE_VERSION.
 */
export function composeSong(blueprint: Blueprint, plan?: CompositionPlan, opts: ComposeOptions = {}): Song {
  return composeInternal(blueprint, plan, opts, {});
}
