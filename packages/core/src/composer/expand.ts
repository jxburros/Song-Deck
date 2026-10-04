/** Section-aware, deterministic expansion. The source is never mutated. */
import type { Blueprint, KeySignature, SectionKind, Song, Track } from '../ir/types';
import { cloneSong, sortNotes } from '../ir/song-utils';
import { barToTick, bpmAtTick, keyAtBar, meterAtBar, sectionLayout } from '../timing';
import { IdFactory } from '../util/ids';
import { LockKeys } from '../locks';
import { deriveRng } from '../util/random';
import { pitchToScaleIndex } from '../theory/scales';
import { chordPitchClasses, formatChordSymbol, diatonicChord } from '../theory/chords';
import { composeInternal, type ComposeOptions } from './compose';
import { defaultBlueprint } from './blueprint';
import { writePlanChords } from './structure';
import { extractSongDNA } from './dna';
import { getInstrument } from './instruments';
import { planComposition } from './planner';
import { MODE_INTERVALS } from '../theory/scales';
import { buildSongGen } from './context';
import { writeCells } from './engine';

export type ExpansionKind = SectionKind | 'hook';
export interface ExpansionRegion {
  id: string;
  /** Zero-based, end-exclusive bar range. Regions may overlap (e.g. a hook within a chorus). */
  startBar: number;
  endBar: number;
  kind: ExpansionKind;
}
export interface ExpansionSection {
  kind: ExpansionKind;
  bars: number;
  /** Source region to preserve or develop. Omit to use the first region as inspiration. */
  sourceRegionId?: string;
  preserve?: boolean;
}
export interface ExpansionRequest {
  regions: ExpansionRegion[];
  arrangement: ExpansionSection[];
  seed: number;
  /** 0 = retain source motif; 1 = allow more phrase development. */
  variation: number;
  genreBlend?: Blueprint['genreBlend'];
  tags?: string[];
  /** User correction for ambiguous imported key estimates; never transposes preserved notes. */
  key?: KeySignature;
}
export interface ExpansionResult {
  song: Song;
  warnings: string[];
  preservedSectionIds: string[];
}
const kindOf = (kind: ExpansionKind): SectionKind => (kind === 'hook' ? 'chorus' : kind);
const validKinds = new Set([
  'intro',
  'verse',
  'pre-chorus',
  'chorus',
  'post-chorus',
  'bridge',
  'breakdown',
  'build',
  'drop',
  'solo',
  'interlude',
  'final-chorus',
  'outro',
  'custom',
  'hook',
]);

function pitched(track: Track, opts: ComposeOptions): boolean {
  return (
    track.role !== 'drums' &&
    track.role !== 'percussion' &&
    track.midiChannel !== 9 &&
    !getInstrument(track.instrumentId, opts.customInstruments).isDrumKit
  );
}

/** Conservative bar-level harmony fallback. These are suggestions, never corrections to source notes. */
function harmonyFor(
  source: Song,
  region: ExpansionRegion,
  key: KeySignature,
  opts: ComposeOptions,
): string[] {
  const notes = source.tracks.filter((t) => pitched(t, opts)).flatMap((t) => t.notes);
  return Array.from({ length: region.endBar - region.startBar }, (_, i) => {
    const start = barToTick(source, region.startBar + i);
    const end = barToTick(source, region.startBar + i + 1);
    const explicit = source.chords.find((c) => c.tick <= start && c.tick + c.duration > start);
    if (explicit) return formatChordSymbol(explicit, key);
    const active = notes.filter((n) => n.tick < end && n.tick + n.duration > start);
    const candidates = Array.from({ length: 7 }, (_, degree) => diatonicChord(key, degree));
    const score = (c: (typeof candidates)[number]) =>
      active.reduce((sum, n) => {
        const duration = Math.min(end, n.tick + n.duration) - Math.max(start, n.tick);
        const pc = n.pitch % 12;
        return (
          sum +
          duration * (chordPitchClasses(c).includes(pc) ? 1 : -0.5) +
          (pc === c.root ? duration * 0.1 : 0)
        );
      }, 0);
    candidates.sort((a, b) => score(b) - score(a));
    return formatChordSymbol(candidates[0], key);
  });
}

export function expandSong(
  source: Song,
  request: ExpansionRequest,
  opts: ComposeOptions = {},
): ExpansionResult {
  if (
    request.key &&
    (!Number.isInteger(request.key.tonic) ||
      request.key.tonic < 0 ||
      request.key.tonic > 11 ||
      !(request.key.mode in MODE_INTERVALS))
  )
    throw new Error('Choose a valid tonic and mode.');
  const totalBars = source.sections.reduce((sum, s) => sum + s.bars, 0);
  if (!source.tracks.some((t) => t.kind === 'midi' && t.notes.length))
    throw new Error('Import or transcribe some MIDI notes first.');
  if (!Number.isSafeInteger(request.seed) || request.seed < 0)
    throw new Error('Seed must be a non-negative safe integer.');
  if (!Number.isFinite(request.variation) || request.variation < 0 || request.variation > 1)
    throw new Error('Variation must be between 0 and 1.');
  if (!request.regions.length || new Set(request.regions.map((r) => r.id)).size !== request.regions.length)
    throw new Error('Label at least one source region with a unique id.');
  for (const r of request.regions) {
    if (
      !r.id ||
      !validKinds.has(r.kind) ||
      !Number.isInteger(r.startBar) ||
      !Number.isInteger(r.endBar) ||
      r.startBar < 0 ||
      r.endBar <= r.startBar ||
      r.endBar > totalBars
    )
      throw new Error('Source regions must be valid bar ranges inside the clip.');
  }
  if (
    !request.arrangement.length ||
    request.arrangement.length > 64 ||
    request.arrangement.reduce((sum, s) => sum + s.bars, 0) > 512
  )
    throw new Error('Choose an arrangement of 1–64 sections and at most 512 bars.');
  for (const s of request.arrangement) {
    const region = request.regions.find((r) => r.id === s.sourceRegionId);
    if (!validKinds.has(s.kind) || !Number.isInteger(s.bars) || s.bars < 1 || s.bars > 128)
      throw new Error('Each section needs a valid kind and 1–128 whole bars.');
    if (s.sourceRegionId && !region) throw new Error('A section refers to a missing source region.');
    if (s.preserve && (!region || s.bars !== region.endBar - region.startBar))
      throw new Error('Preserved sections must match their source region length.');
  }
  const warnings = new Set<string>();
  if (!source.chords.length)
    warnings.add(
      'Harmony is estimated from notes. Check the key and chord suggestions, especially for short or monophonic clips.',
    );
  if (source.tracks.some((t) => t.clips.length))
    warnings.add('Expansion includes MIDI only; audio clips remain in the source project.');
  if (source.automation.length)
    warnings.add('Source mixer automation is not copied into the new arrangement.');
  const tracks = source.tracks.filter((t) => t.kind === 'midi');
  const first = request.regions[0];
  const key = request.key ?? keyAtBar(source, first.startBar);
  const regionFor = (s: ExpansionSection) => request.regions.find((r) => r.id === s.sourceRegionId) ?? first;
  const blueprint = defaultBlueprint({
    genreBlend: request.genreBlend ?? source.genreBlend,
    seed: request.seed,
  });
  blueprint.title = `${source.title} — Expanded`;
  blueprint.tags = request.tags ?? source.tags;
  blueprint.key = key;
  blueprint.tempo = bpmAtTick(source, barToTick(source, first.startBar));
  blueprint.meter = meterAtBar(source, first.startBar);
  blueprint.instrumentation = tracks.map((t) => {
    const notes = sortNotes([...t.notes]);
    const monophonic = notes.every(
      (n, i) => i === 0 || n.tick >= notes[i - 1].tick + notes[i - 1].duration - source.ppq / 16,
    );
    return {
      instrumentId: t.instrumentId,
      role: t.role,
      name: t.name,
      constraints: {
        ...t.constraints,
        sectionIds: undefined,
        ...(!t.constraints.function && ['keys', 'custom'].includes(t.role) && pitched(t, opts) && monophonic
          ? { function: 'melody' as const }
          : {}),
      },
    };
  });
  blueprint.structure = request.arrangement.map((s) => {
    const r = regionFor(s);
    const related = kindOf(s.kind) === kindOf(r.kind);
    return {
      kind: kindOf(s.kind),
      name: s.kind === 'hook' ? 'Hook' : s.kind.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      bars: s.bars,
      ...(related
        ? { harmony: harmonyFor(source, r, request.key ?? keyAtBar(source, r.startBar), opts) }
        : {}),
    };
  });
  const preservedSectionIds: string[] = [];
  const song = composeInternal(
    blueprint,
    undefined,
    { ...opts, seed: request.seed },
    {
      trackIds: tracks.map((t) => t.id),
      skipNotes: true,
      beforeNotes: (draft) => {
        // Preserve non-default PPQ and map changes before generating any absolute event positions.
        const ratio = source.ppq / draft.ppq;
        draft.ppq = source.ppq;
        for (const motif of draft.motifs) {
          motif.lengthTicks = Math.round(motif.lengthTicks * ratio);
          for (const n of motif.notes) {
            n.offset = Math.round(n.offset * ratio);
            n.duration = Math.max(1, Math.round(n.duration * ratio));
          }
        }
        for (const track of draft.tracks) {
          const original = tracks.find((t) => t.id === track.id)!;
          track.midiChannel = original.midiChannel;
          if (source.mixer.channels[track.id])
            draft.mixer.channels[track.id] = cloneSong(source.mixer.channels[track.id]);
        }
        draft.meterMap = [];
        draft.keyMap = [];
        let bar = 0;
        request.arrangement.forEach((s) => {
          const r = regionFor(s);
          draft.meterMap.push({ ...meterAtBar(source, r.startBar), bar });
          draft.keyMap.push({ bar, key: request.key ?? keyAtBar(source, r.startBar) });
          if (s.preserve) {
            for (const m of source.meterMap.filter((m) => m.bar > r.startBar && m.bar < r.endBar))
              draft.meterMap.push({ ...m, bar: bar + m.bar - r.startBar });
            if (!request.key)
              for (const k of source.keyMap.filter((k) => k.bar > r.startBar && k.bar < r.endBar))
                draft.keyMap.push({ ...cloneSong(k), bar: bar + k.bar - r.startBar });
          }
          bar += s.bars;
        });
        draft.tempoMap = [];
        const spans = sectionLayout(draft);
        spans.forEach((span, i) => {
          const s = request.arrangement[i],
            r = regionFor(s);
          const start = barToTick(source, r.startBar),
            end = barToTick(source, r.endBar);
          draft.tempoMap.push({ tick: span.startTick, bpm: bpmAtTick(source, start) });
          if (s.preserve)
            for (const t of source.tempoMap.filter((t) => t.tick > start && t.tick < end))
              draft.tempoMap.push({ ...t, tick: span.startTick + t.tick - start });
        });
        // Each developed section follows its selected region's local key, even across modulations.
        draft.plan!.sections = request.arrangement.map((s, i) => {
          const r = regionFor(s);
          return planComposition(
            { ...blueprint, key: request.key ?? keyAtBar(source, r.startBar) },
            { seed: request.seed, customGenres: opts.customGenres },
          ).sections[i];
        });
        spans.forEach((span, i) => {
          const previous = spans.findIndex((s) => s.section.id === span.section.repeatOf);
          if (
            previous >= 0 &&
            regionFor(request.arrangement[previous]).id !== regionFor(request.arrangement[i]).id
          )
            delete span.section.repeatOf;
        });
        writePlanChords(draft, draft.plan!, request.seed);
        // Seed melodic templates with real source contours and onset patterns. Only phrase endings
        // develop; the opening cell remains recognizable at every variation setting.
        const templates = draft.motifs;
        draft.motifs = request.regions
          .filter((region) => request.arrangement.some((s) => regionFor(s).id === region.id))
          .flatMap((region) =>
            templates.map((template) => {
              const motif = cloneSong(template);
              motif.id = `${template.id}/${region.id}`;
              motif.sectionIds = spans
                .filter((_, i) => regionFor(request.arrangement[i]).id === region.id)
                .map((s) => s.section.id);
              return motif;
            }),
          );
        for (const motif of draft.motifs) {
          const track =
            tracks.find((t) => t.id === motif.sourceTrackId) ?? tracks.find((t) => pitched(t, opts));
          if (!track || !pitched(track, opts)) continue;
          const region = regionFor(
            request.arrangement[spans.findIndex((s) => motif.sectionIds?.includes(s.section.id))] ??
              request.arrangement[0],
          );
          const start = barToTick(source, region.startBar);
          const end = barToTick(source, Math.min(region.endBar, region.startBar + 2));
          // Top voice at simultaneous attacks; preserve polyphonic source events separately below.
          const attacks = new Map<number, (typeof track.notes)[number]>();
          for (const n of track.notes.filter((n) => n.tick >= start && n.tick < end))
            if (!attacks.has(n.tick) || attacks.get(n.tick)!.pitch < n.pitch) attacks.set(n.tick, n);
          const notes = sortNotes([...attacks.values()]);
          if (!notes.length) continue;
          const localKey = request.key ?? keyAtBar(source, region.startBar);
          const anchor = pitchToScaleIndex(notes[0].pitch, localKey).index;
          const rng = deriveRng(request.seed, 'expand-motif', motif.id, region.id);
          motif.lengthTicks = end - start;
          motif.notes = notes.map((n, i) => {
            const p = pitchToScaleIndex(n.pitch, localKey);
            const develop = i >= Math.ceil(notes.length / 2) && rng.chance(request.variation * 0.65);
            return {
              offset: n.tick - start,
              duration: Math.min(n.duration, end - n.tick),
              degree: p.index - anchor + (develop ? rng.pick([-1, 1]) : 0),
              alteration: p.alteration,
              velocity: n.velocity,
            };
          });
        }
        spans.forEach((span, i) => {
          const s = request.arrangement[i];
          if (!s.preserve) return;
          preservedSectionIds.push(span.section.id);
          const r = regionFor(s),
            start = barToTick(source, r.startBar),
            end = barToTick(source, r.endBar);
          const ids = new IdFactory(request.seed, `expand-source/${i}`);
          draft.locks[LockKeys.section(span.section.id)] = true;
          const noteRefs = tracks.flatMap((t) =>
            t.notes.filter((n) => n.tick < end && n.tick + n.duration > start),
          );
          const lineIds = new Map<string, string>();
          for (const line of source.lyrics.filter((line) =>
            noteRefs.some((n) => n.lyricLineId === line.id),
          )) {
            const id = ids.next('line');
            lineIds.set(line.id, id);
            draft.lyrics.push({ ...cloneSong(line), id, sectionId: span.section.id });
          }
          const motifIds = new Map<string, string>();
          for (const motif of source.motifs.filter((m) => noteRefs.some((n) => n.motifId === m.id))) {
            const id = ids.next('motif');
            motifIds.set(motif.id, id);
            draft.motifs.push({ ...cloneSong(motif), id, sectionIds: [span.section.id] });
          }
          const phraseIds = new Map<string, string>();
          for (const phrase of source.phrases.filter(
            (p) => p.startTick < end && p.endTick > start && noteRefs.some((n) => n.phraseId === p.id),
          )) {
            const id = ids.next('phrase');
            phraseIds.set(phrase.id, id);
            draft.phrases.push({
              ...cloneSong(phrase),
              id,
              startTick: span.startTick + Math.max(start, phrase.startTick) - start,
              endTick: span.startTick + Math.min(end, phrase.endTick) - start,
              sectionId: span.section.id,
              motifId: phrase.motifId ? motifIds.get(phrase.motifId) : undefined,
              lyricLineId: phrase.lyricLineId ? lineIds.get(phrase.lyricLineId) : undefined,
            });
          }
          for (const track of draft.tracks) {
            const original = tracks.find((t) => t.id === track.id)!;
            track.notes = original.notes
              .filter((n) => n.tick < end && n.tick + n.duration > start)
              .map((n) => {
                const clippedStart = Math.max(start, n.tick),
                  clippedEnd = Math.min(end, n.tick + n.duration);
                if (clippedStart !== n.tick || clippedEnd !== n.tick + n.duration)
                  warnings.add(
                    'Notes crossing selected source boundaries are trimmed to the selected region.',
                  );
                const copy = cloneSong(n);
                if (copy.phraseId) copy.phraseId = phraseIds.get(copy.phraseId);
                if (copy.lyricLineId) copy.lyricLineId = lineIds.get(copy.lyricLineId);
                if (copy.motifId) copy.motifId = motifIds.get(copy.motifId);
                return {
                  ...copy,
                  id: ids.next('note'),
                  tick: span.startTick + clippedStart - start,
                  duration: clippedEnd - clippedStart,
                };
              })
              .concat(track.notes);
          }
          // Exact source chord timing takes precedence over the fallback bar-level analysis.
          const chords = source.chords.filter((c) => c.tick < end && c.tick + c.duration > start);
          if (chords.length) {
            draft.chords = draft.chords.filter((c) => c.tick < span.startTick || c.tick >= span.endTick);
            draft.chords.push(
              ...chords.map((c) => ({
                ...cloneSong(c),
                id: ids.next('ch'),
                tick: span.startTick + Math.max(start, c.tick) - start,
                duration: Math.min(end, c.tick + c.duration) - Math.max(start, c.tick),
              })),
            );
          }
        });
        draft.chords.sort((a, b) => a.tick - b.tick);
      },
    },
  );
  // Generate only new cells. Source cells (including rests) never enter a generator.
  const generatedIds = new Set(
    song.sections.filter((s) => !preservedSectionIds.includes(s.id)).map((s) => s.id),
  );
  const conditionedGrooves = new Set<string>();
  // Percussion has no pitched contour: carry its actual attack grid and drum identities forward.
  for (const [index, span] of sectionLayout(song).entries()) {
    if (!generatedIds.has(span.section.id)) continue;
    const region = regionFor(request.arrangement[index]);
    for (const track of song.tracks) {
      const original = tracks.find((t) => t.id === track.id)!;
      if (pitched(original, opts)) continue;
      const ids = new IdFactory(request.seed, `expand-groove/${track.id}/${span.section.id}`);
      const rng = deriveRng(request.seed, 'expand-groove', track.id, span.section.id);
      const pattern = original.notes.filter(
        (n) => n.tick >= barToTick(source, region.startBar) && n.tick < barToTick(source, region.endBar),
      );
      if (!pattern.length) continue;
      conditionedGrooves.add(`${track.id}/${span.section.id}`);
      track.notes = track.notes.filter((n) => n.tick < span.startTick || n.tick >= span.endTick);
      for (let bar = span.startBar; bar < span.endBar; bar++) {
        const srcBar = region.startBar + ((bar - span.startBar) % (region.endBar - region.startBar));
        const srcStart = barToTick(source, srcBar),
          srcEnd = barToTick(source, srcBar + 1);
        const destStart = barToTick(song, bar),
          destEnd = barToTick(song, bar + 1);
        const ratio = (destEnd - destStart) / (srcEnd - srcStart);
        for (const n of pattern.filter((n) => n.tick >= srcStart && n.tick < srcEnd)) {
          const tick = destStart + Math.round((n.tick - srcStart) * ratio);
          const velocity = Math.max(
            1,
            Math.min(127, n.velocity + Math.round(rng.gaussian(0, request.variation * 6))),
          );
          track.notes.push({
            id: ids.next('note'),
            pitch: n.pitch,
            tick,
            duration: Math.max(1, Math.min(destEnd - tick, Math.round(n.duration * ratio))),
            velocity,
            origin: 'composer/expand-groove',
          });
          // Occasional quiet offbeat response; never replace a structural kick/snare attack.
          const offbeat = tick + Math.round(song.ppq / 4);
          if (
            bar === span.endBar - 1 &&
            rng.chance(request.variation * 0.35) &&
            n.duration * ratio <= song.ppq / 4 &&
            offbeat < destEnd &&
            !pattern.some(
              (p) =>
                p.pitch === n.pitch &&
                Math.abs((p.tick - srcStart) * ratio + destStart - offbeat) < song.ppq / 4,
            )
          ) {
            track.notes.push({
              id: ids.next('note'),
              pitch: n.pitch,
              tick: offbeat,
              duration: Math.min(Math.round(song.ppq / 8), destEnd - offbeat),
              velocity: Math.max(1, Math.round(velocity * 0.65)),
              origin: 'composer/expand-groove',
            });
          }
        }
      }
    }
  }
  writeCells(
    buildSongGen(song, {
      seed: request.seed,
      customGenres: opts.customGenres,
      customInstruments: opts.customInstruments,
    }),
    request.seed,
    {
      sectionIds: generatedIds,
      respectLocks: false,
      filter: (track, sectionId) => !conditionedGrooves.has(`${track.id}/${sectionId}`),
    },
  );
  for (const track of song.tracks) track.notes = sortNotes(track.notes);
  song.generation.variation = request.variation;
  song.dna = extractSongDNA(song);
  return { song, warnings: [...warnings], preservedSectionIds };
}
