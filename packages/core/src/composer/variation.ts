/**
 * Variation system (spec §24) and branch templates (spec §53).
 *
 *  ornament         — fills, ornaments, velocities, articulations; pitches & rhythms preserved
 *  variation        — harmony, motifs and structure preserved; accompaniment details change
 *  reinterpretation — main melody, motifs and broad structure preserved; arrangement & feel change
 *  mutation         — only the Song DNA is preserved (composeFromDNA), merged back around locks
 *
 * `amount` (0..1) scales how many track × section cells change. Every level respects locks.
 */
import type { BlueprintTrack, DrumStyle, GenreProfile, GenreWeight, InstrumentProfile, Note, Phrase, Song, Track, TrackRole, VariationLevel } from '../ir/types';
import { cloneSong, sortNotes } from '../ir/song-utils';
import { LockKeys, isChordSectionLocked, isLocked, isLyricsSectionLocked, isTrackSectionLocked } from '../locks';
import { barToTick, createTimeMap, sectionLayout, type SectionSpan } from '../timing';
import { composeInternal } from './compose';
import { blueprintFromDNA, extractSongDNA } from './dna';
import { getInstrument } from './instruments';
import { defaultChannelFor, trackColor } from './mixer';
import { genreForSong, songTags } from './tags';
import { planComposition } from './planner';
import { regenerateCore } from './regenerate';
import { clamp01, unitHash } from './util';
import { resolveFunction } from './arrangement';

export interface VariationOptions {
  seed: number;
  amount: number;
  /** Project-bundled custom profiles (optional). */
  customInstruments?: InstrumentProfile[];
  customGenres?: GenreProfile[];
}

function protectedSection(song: Song, sectionId: string, span: SectionSpan): boolean {
  if (isChordSectionLocked(song, sectionId)) return true;
  return song.tracks.some((t) => isTrackSectionLocked(song, t.id, sectionId) || t.notes.some((n) => n.locked && n.tick >= span.startTick && n.tick < span.endTick));
}

function overlaps(a: { tick: number; duration: number }, b: { tick: number; duration: number }): boolean {
  return a.tick < b.tick + b.duration && b.tick < a.tick + a.duration;
}

/** Mutation: compose from the song's DNA, then merge the new material around everything locked. */
function mutate(song: Song, seed: number, amount: number, custom: { customInstruments?: InstrumentProfile[]; customGenres?: GenreProfile[] } = {}): Song {
  const spans = sectionLayout(song);
  if (!spans.length) return cloneSong(song);
  const dna = extractSongDNA(song);
  const midi = song.tracks.filter((t) => t.kind === 'midi');
  const instrumentation: BlueprintTrack[] = midi.map((t) => {
    const bt: BlueprintTrack = { name: t.name, instrumentId: t.instrumentId, role: t.role, constraints: cloneSong(t.constraints ?? {}) };
    if (t.constraints?.function) bt.function = t.constraints.function;
    return bt;
  });
  const bp = blueprintFromDNA(dna, { seed, title: song.title, genreBlend: song.genreBlend, instrumentation, tempo: song.tempoMap[0]?.bpm, tags: songTags(song) });
  bp.macros = { ...bp.macros, ...song.macros };
  const lead = midi.find((t) => t.role === 'vocal' && t.vocal?.voiceType);
  if (lead?.vocal?.voiceType) bp.vocal = { voiceType: lead.vocal.voiceType, mode: lead.vocal.mode ?? 'melody-only' };
  bp.structure = bp.structure.map((s, i) => {
    const orig = song.sections[i];
    if (!orig) return s;
    const out = { ...s, name: orig.name, energy: orig.energy };
    if (orig.energyEnd !== undefined) out.energyEnd = orig.energyEnd;
    if (orig.mood) out.mood = [...orig.mood];
    return out;
  });
  const plan = planComposition(bp, { seed, customGenres: custom.customGenres });
  const keepChords = new Set(spans.filter((sp) => protectedSection(song, sp.section.id, sp)).map((sp) => sp.section.id));
  const mutated = composeInternal(bp, plan, { seed, songId: song.id, ...custom }, {
    motifs: song.motifs,
    trackIds: midi.map((t) => t.id),
    sectionIds: song.sections.map((s) => s.id),
    beforeNotes: (draft) => {
      draft.lyrics = cloneSong(song.lyrics);
      const dSpans = sectionLayout(draft);
      for (const sp of dSpans) {
        if (!keepChords.has(sp.section.id)) continue;
        draft.chords = [...draft.chords.filter((c) => c.tick < sp.startTick || c.tick >= sp.endTick), ...song.chords.filter((c) => c.tick >= sp.startTick && c.tick < sp.endTick).map((c) => ({ ...c }))].sort(
          (a, b) => a.tick - b.tick,
        );
      }
    },
  });
  const mSpans = sectionLayout(mutated);
  const aligned = mSpans.length === spans.length && mSpans.every((s, i) => s.startTick === spans[i].startTick && s.endTick === spans[i].endTick);
  if (!aligned) return regenerateCore(song, { seed, level: 'mutation', ...custom }, { amount }).song;

  // Cells that take the mutated material.
  const eligible: string[] = [];
  for (const t of midi) {
    if (isLocked(song.locks, LockKeys.track(t.id))) continue;
    for (const sp of spans) if (!isTrackSectionLocked(song, t.id, sp.section.id)) eligible.push(`${t.id}|${sp.section.id}`);
  }
  const chosen = new Set(amount >= 1 ? eligible : eligible.filter((k) => unitHash(`${seed}|mutate|${k}`) < amount));
  if (!chosen.size && eligible.length && amount > 0) chosen.add(eligible[Math.floor(unitHash(`${seed}|mutate-pick`) * eligible.length)]);

  const result = cloneSong(song);
  // Harmony follows the mutated song wherever nothing protected lives and some cell changes.
  for (const sp of spans) {
    const id = sp.section.id;
    if (keepChords.has(id) || isLocked(song.locks, LockKeys.chords)) continue;
    if (!midi.some((t) => chosen.has(`${t.id}|${id}`))) continue;
    result.chords = [...result.chords.filter((c) => c.tick < sp.startTick || c.tick >= sp.endTick), ...mutated.chords.filter((c) => c.tick >= sp.startTick && c.tick < sp.endTick)];
    if (!isLocked(song.locks, LockKeys.structure)) {
      const ms = mutated.sections.find((s) => s.id === id);
      const rs = result.sections.find((s) => s.id === id);
      if (ms && rs && ms.progression) rs.progression = [...ms.progression];
    }
  }
  result.chords.sort((a, b) => a.tick - b.tick);
  for (const t of result.tracks) {
    const mt = mutated.tracks.find((x) => x.id === t.id);
    if (!mt) continue;
    let phrases: Phrase[] = result.phrases;
    let touched = false;
    for (const sp of spans) {
      if (!chosen.has(`${t.id}|${sp.section.id}`)) continue;
      touched = true;
      const inSpan = (n: { tick: number }) => n.tick >= sp.startTick && n.tick < sp.endTick;
      const lockedNotes = t.notes.filter((n) => inSpan(n) && n.locked);
      const mono = getInstrument(t.instrumentId).polyphony === 'mono';
      const used = new Set(t.notes.filter((n) => !inSpan(n) || n.locked).map((n) => n.id));
      const fresh: Note[] = [];
      for (const n of mt.notes.filter(inSpan)) {
        if (lockedNotes.some((l) => (mono ? overlaps(l, n) : l.pitch === n.pitch && overlaps(l, n)))) continue;
        let id = n.id;
        let k = 1;
        while (used.has(id)) id = `${n.id}~m${k++}`;
        used.add(id);
        fresh.push({ ...n, id });
      }
      t.notes = sortNotes([...t.notes.filter((n) => !inSpan(n) || n.locked), ...fresh]);
      const keptPhraseIds = new Set(lockedNotes.map((n) => n.phraseId).filter(Boolean) as string[]);
      phrases = [
        ...phrases.filter((p) => p.trackId !== t.id || !inSpan({ tick: p.startTick }) || keptPhraseIds.has(p.id)),
        ...mutated.phrases.filter((p) => p.trackId === t.id && inSpan({ tick: p.startTick }) && !phrases.some((q) => q.id === p.id)),
      ];
    }
    if (!touched) continue;
    result.phrases = phrases.sort((a, b) => a.startTick - b.startTick || a.trackId.localeCompare(b.trackId));
    t.generator = { id: `composer/${t.role}`, seed };
  }
  // The mutated material was arranged with the new seed.
  result.generation = { ...result.generation, seed };
  return result;
}

/** Create a variation of a song at a given level (spec §24). Locks are always respected. */
export function createVariation(song: Song, level: VariationLevel, opts: VariationOptions): Song {
  const amount = clamp01(opts.amount);
  const seed = Math.floor(Math.abs(opts.seed));
  if (amount <= 0) return cloneSong(song);
  let next: Song;
  const custom = { customInstruments: opts.customInstruments, customGenres: opts.customGenres };
  switch (level) {
    case 'ornament':
      next = regenerateCore(song, { seed, level: 'ornament', ...custom }, { amount }).song;
      break;
    case 'variation':
      next = regenerateCore(song, { seed, level: 'variation', ...custom }, { amount }).song;
      break;
    case 'reinterpretation':
      next = regenerateCore(song, { seed, level: 'reinterpretation', ...custom }, { amount }).song;
      break;
    case 'mutation':
      next = mutate(song, seed, amount, custom);
      break;
    default:
      next = cloneSong(song);
  }
  next.generation = { ...next.generation, variation: amount };
  return next;
}

// ---------------------------------------------------------------------------
// Branch templates (spec §53)
// ---------------------------------------------------------------------------

export interface ComposerBranchTemplate {
  id: 'heavy' | 'acoustic' | 'synth' | 'radio-edit';
  name: string;
  description: string;
  apply(song: Song, seed: number): Song;
}

interface Swap {
  instrumentId: string;
  role?: TrackRole;
  fn?: Track['constraints']['function'];
  name?: string;
}

function blendToward(blend: GenreWeight[], genreId: string, share: number): GenreWeight[] {
  const total = blend.reduce((t, g) => t + g.weight, 0) || 1;
  const out = blend.filter((g) => g.genreId !== genreId).map((g) => ({ genreId: g.genreId, weight: Math.round(((g.weight / total) * (1 - share)) * 1000) / 1000 }));
  return [{ genreId, weight: share }, ...out].filter((g) => g.weight > 0);
}

/** Re-orchestrate: swap instruments of unlocked tracks, shift genre/energy, regenerate everything but the main melody. */
function reorchestrate(song: Song, seed: number, cfg: { genre: string; share: number; energyShift: number; drumStyle?: DrumStyle; swap: (t: Track) => Swap | null; titleSuffix: string; macros?: Partial<Song['macros']> }): Song {
  const next = cloneSong(song);
  next.genreBlend = blendToward(next.genreBlend.length ? next.genreBlend : [{ genreId: 'pop', weight: 1 }], cfg.genre, cfg.share);
  const genre = genreForSong(next);
  if (cfg.macros) next.macros = { ...next.macros, ...cfg.macros };
  for (const t of next.tracks) {
    if (t.kind !== 'midi' || isLocked(next.locks, LockKeys.track(t.id))) continue;
    // Locked notes keep sounding on the instrument they were locked with.
    if (t.notes.some((n) => n.locked) || next.sections.some((sec) => isTrackSectionLocked(next, t.id, sec.id))) continue;
    const sw = cfg.swap(t);
    if (!sw) continue;
    const inst = getInstrument(sw.instrumentId);
    t.instrumentId = inst.id;
    if (sw.role) t.role = sw.role;
    if (sw.fn) t.constraints = { ...t.constraints, function: sw.fn };
    if (sw.name) t.name = sw.name;
    t.stemGroup = inst.stemGroup;
    t.color = trackColor(t.role);
    t.midiChannel = inst.isDrumKit ? 9 : t.midiChannel === 9 ? 0 : t.midiChannel;
    if (!isLocked(next.locks, LockKeys.mixer(t.id))) {
      const pan = next.mixer.channels[t.id]?.pan;
      next.mixer.channels[t.id] = defaultChannelFor(t, inst, genre, 0, 1, pan);
    }
  }
  if (cfg.energyShift && !isLocked(next.locks, LockKeys.structure)) {
    next.sections = next.sections.map((s) => {
      if (isLocked(next.locks, LockKeys.section(s.id))) return s;
      const u = { ...s, energy: Math.max(5, Math.min(100, s.energy + cfg.energyShift)) };
      if (s.energyEnd !== undefined) u.energyEnd = Math.max(5, Math.min(100, s.energyEnd + cfg.energyShift));
      return u;
    });
  }
  const g = next.tracks.find((t) => t.kind === 'midi' && t.role === 'vocal' && resolveFunction(t, getInstrument(t.instrumentId)) === 'melody');
  const trackIds = next.tracks.filter((t) => t.kind === 'midi' && t.id !== g?.id).map((t) => t.id);
  const out = regenerateCore(next, { seed, trackIds }, { overrides: cfg.drumStyle ? { drumStyle: cfg.drumStyle } : undefined }).song;
  out.title = `${song.title} (${cfg.titleSuffix})`;
  return out;
}

/** Radio edit: a ~3 minute structure keeping every hook (choruses), trimming intro/outro/solos/bridge. */
function radioEdit(song: Song, seed: number): Song {
  void seed;
  const next = cloneSong(song);
  if (isLocked(song.locks, LockKeys.structure) || !song.sections.length) {
    next.title = `${song.title} (Radio Edit)`;
    return next;
  }
  const spans = sectionLayout(song);
  const tm = createTimeMap(song);
  const target = 180;
  // Sections holding locked material (cells, notes, chords, lyrics) keep every bar.
  const lyricsLocked = (id: string) => song.lyrics.some((l) => l.sectionId === id) && isLyricsSectionLocked(song, id);
  const fixed = new Set(
    spans
      .filter((sp) => protectedSection(song, sp.section.id, sp) || lyricsLocked(sp.section.id) || song.tracks.some((t) => isLocked(song.locks, LockKeys.track(t.id)) && t.notes.some((n) => n.tick >= sp.startTick && n.tick < sp.endTick)))
      .map((sp) => sp.section.id),
  );
  const entries = spans.map((sp) => ({ sp, keep: sp.section.bars, fromEnd: false }));
  const adjustable = () => entries.filter((e) => !fixed.has(e.sp.section.id));
  const barSeconds = (e: (typeof entries)[number]) => (tm.tickToSeconds(e.sp.endTick) - tm.tickToSeconds(e.sp.startTick)) / Math.max(1, e.sp.section.bars);
  const duration = () => entries.reduce((t, e) => t + e.keep * barSeconds(e), 0);
  const of = (kind: string) => adjustable().filter((e) => e.sp.section.kind === kind);
  const steps: (() => void)[] = [
    () => of('intro').filter((e) => e.keep > 4).forEach((e) => ((e.keep = 4), (e.fromEnd = true))),
    () => of('outro').filter((e) => e.keep > 2).forEach((e) => ((e.keep = 2), (e.fromEnd = true))),
    () => adjustable().filter((e) => ['solo', 'interlude', 'breakdown'].includes(e.sp.section.kind)).forEach((e) => (e.keep = 0)),
    () => of('final-chorus').filter((e) => e.keep > 8).forEach((e) => (e.keep = Math.ceil(e.keep / 2))),
    () => of('post-chorus').slice(0, -1).forEach((e) => (e.keep = 0)),
    () => of('bridge').filter((e) => e.keep > 4).forEach((e) => ((e.keep = 4), (e.fromEnd = true))),
    () => of('pre-chorus').slice(1).forEach((e) => (e.keep = 0)),
    () => of('intro').filter((e) => e.keep > 2).forEach((e) => (e.keep = 2)),
    () => of('verse').slice(1).forEach((e) => (e.keep = Math.max(4, Math.ceil(e.keep / 2)))),
  ];
  // Always tighten intro/outro; continue only while the edit is longer than ~3 minutes.
  steps[0]();
  steps[1]();
  for (let i = 2; i < steps.length && duration() > target; i++) steps[i]();
  const kept = entries.filter((e) => e.keep > 0);
  const removed = new Set(entries.filter((e) => e.keep === 0).map((e) => e.sp.section.id));
  // New sections (same ids, trimmed bars).
  next.sections = kept.map((e) => ({ ...cloneSong(e.sp.section), bars: e.keep }));
  for (const s of next.sections) {
    if (s.repeatOf && removed.has(s.repeatOf)) delete s.repeatOf;
  }
  // Bars first (meter/key events are bar-based), then ticks under the remapped meter map.
  let accBars = 0;
  const barWindows = kept.map((e) => {
    const w = { srcStartBar: e.fromEnd ? e.sp.endBar - e.keep : e.sp.startBar, keepBars: e.keep, dstBar: accBars };
    accBars += e.keep;
    return w;
  });
  const mapBar = (bar: number): number | null => {
    for (const w of barWindows) if (bar >= w.srcStartBar && bar < w.srcStartBar + w.keepBars) return bar - w.srcStartBar + w.dstBar;
    return null;
  };
  next.meterMap = song.meterMap.flatMap((m) => {
    if (m.bar === 0) return [{ ...m }];
    const b = mapBar(m.bar);
    return b === null ? [] : [{ ...m, bar: b }];
  });
  next.keyMap = song.keyMap.flatMap((k) => {
    if (k.bar === 0) return [{ ...k, key: { ...k.key } }];
    const b = mapBar(k.bar);
    return b === null ? [] : [{ ...k, bar: b, key: { ...k.key } }];
  });
  const newSpans = sectionLayout(next);
  const windows = barWindows.map((w, i) => ({
    srcStart: barToTick(song, w.srcStartBar),
    srcEnd: barToTick(song, w.srcStartBar + w.keepBars),
    dst: newSpans[i].startTick,
  }));
  const map = (tick: number): number | null => {
    for (const w of windows) if (tick >= w.srcStart && tick < w.srcEnd) return tick - w.srcStart + w.dst;
    return null;
  };
  const windowEnd = (tick: number): number => {
    for (const w of windows) if (tick >= w.srcStart && tick < w.srcEnd) return w.srcEnd;
    return tick;
  };
  for (const t of next.tracks) {
    const src = song.tracks.find((x) => x.id === t.id)!;
    t.notes = sortNotes(
      src.notes.flatMap((n) => {
        const nt = map(n.tick);
        if (nt === null) return [];
        return [{ ...n, tick: nt, duration: Math.max(1, Math.min(n.duration, windowEnd(n.tick) - n.tick)) }];
      }),
    );
  }
  next.chords = [];
  for (const w of windows) {
    for (const c of song.chords) {
      const s = Math.max(c.tick, w.srcStart);
      const e = Math.min(c.tick + c.duration, w.srcEnd);
      if (e <= s) continue;
      next.chords.push({ ...c, id: s === c.tick ? c.id : `${c.id}~${s}`, tick: s - w.srcStart + w.dst, duration: e - s });
    }
  }
  next.chords.sort((a, b) => a.tick - b.tick);
  next.phrases = song.phrases.flatMap((p) => {
    const nt = map(p.startTick);
    return nt === null ? [] : [{ ...p, startTick: nt, endTick: nt + Math.min(p.endTick, windowEnd(p.startTick)) - p.startTick }];
  });
  next.lyrics = song.lyrics.filter((l) => !removed.has(l.sectionId));
  next.automation = song.automation.map((lane) => ({ ...lane, points: lane.points.flatMap((pt) => {
    const nt = map(pt.tick);
    return nt === null ? [] : [{ ...pt, tick: nt }];
  }) }));
  next.tempoMap = song.tempoMap.flatMap((te) => {
    if (te.tick === 0) return [{ ...te }];
    const nt = map(te.tick);
    return nt === null ? [] : [{ ...te, tick: nt }];
  });
  const locks = { ...next.locks };
  for (const k of Object.keys(locks)) for (const id of removed) if (k.includes(id)) delete locks[k];
  next.locks = locks;
  if (next.plan && next.plan.sections.length === song.sections.length) {
    next.plan = { ...next.plan, sections: entries.filter((e) => e.keep > 0).map((e) => ({ ...next.plan!.sections[e.sp.index], bars: e.keep })) };
  }
  next.title = `${song.title} (Radio Edit)`;
  return next;
}

const isGuitar = (t: Track) => t.role === 'rhythm-guitar' || t.role === 'lead-guitar';

export const BRANCH_TEMPLATES: ComposerBranchTemplate[] = [
  {
    id: 'heavy',
    name: 'Heavy Version',
    description: 'Distorted double-tracked guitars, harder drums and higher energy; vocal melody and harmony preserved.',
    apply: (song, seed) =>
      reorchestrate(song, seed, {
        genre: 'metal',
        share: 0.55,
        energyShift: 10,
        drumStyle: 'metal',
        titleSuffix: 'Heavy Version',
        macros: { energy: 0.88, density: 0.7 },
        swap: (t) => {
          const id = t.instrumentId;
          if (t.role === 'rhythm-guitar' && id !== 'electric-guitar-distorted') return { instrumentId: 'electric-guitar-distorted', fn: 'rhythm' };
          if (t.role === 'lead-guitar' && id !== 'electric-guitar-lead') return { instrumentId: 'electric-guitar-lead' };
          if (t.role === 'bass' && id !== 'electric-bass') return { instrumentId: 'electric-bass' };
          if (t.role === 'drums' && id === 'electronic-kit') return { instrumentId: 'drum-kit' };
          if (t.role === 'synth-arp' || t.role === 'synth-seq') return { instrumentId: 'electric-guitar-distorted', role: 'rhythm-guitar', fn: 'rhythm', name: `${t.name} (Guitar)` };
          if ((t.role === 'keys' && (id === 'piano' || id === 'electric-piano')) || t.role === 'synth-pad') return { instrumentId: 'organ', role: 'keys', fn: 'pad' };
          return null;
        },
      }),
  },
  {
    id: 'acoustic',
    name: 'Acoustic Version',
    description: 'Acoustic guitars, piano, upright bass, strings and light percussion at lower energy; vocal melody and harmony preserved.',
    apply: (song, seed) =>
      reorchestrate(song, seed, {
        genre: 'folk',
        share: 0.6,
        energyShift: -15,
        drumStyle: 'folk',
        titleSuffix: 'Acoustic Version',
        macros: { energy: 0.35, density: 0.42, humanization: 0.5 },
        swap: (t) => {
          const id = t.instrumentId;
          if (isGuitar(t) && id !== 'acoustic-guitar') return { instrumentId: 'acoustic-guitar', fn: t.role === 'lead-guitar' ? 'counter-melody' : 'accompaniment' };
          if (t.role === 'bass' && id !== 'upright-bass') return { instrumentId: 'upright-bass' };
          if (t.role === 'drums') return { instrumentId: 'drum-kit' };
          if (t.role === 'synth-pad') return { instrumentId: 'string-ensemble', role: 'strings', fn: 'pad', name: 'Strings' };
          if (t.role === 'synth-arp' || t.role === 'synth-seq') return { instrumentId: 'acoustic-guitar', role: 'rhythm-guitar', fn: 'accompaniment', name: `${t.name} (Acoustic)` };
          if (t.role === 'synth-lead') return { instrumentId: 'violin', role: 'strings', fn: 'counter-melody', name: 'Violin' };
          if (t.role === 'keys' && (id === 'electric-piano' || id === 'organ')) return { instrumentId: 'piano' };
          return null;
        },
      }),
  },
  {
    id: 'synth',
    name: 'Synth Version',
    description: 'Synth bass, drum machine, pads, arpeggios and leads in place of band instruments; vocal melody and harmony preserved.',
    apply: (song, seed) => {
      let rgCount = 0;
      return reorchestrate(song, seed, {
        genre: 'synth-pop',
        share: 0.6,
        energyShift: 0,
        drumStyle: 'synth-pop',
        titleSuffix: 'Synth Version',
        macros: { humanization: 0.06 },
        swap: (t) => {
          const id = t.instrumentId;
          if (t.role === 'rhythm-guitar') return rgCount++ % 2 === 0 ? { instrumentId: 'synth-seq', role: 'synth-seq', fn: 'rhythm', name: `${t.name} (Seq)` } : { instrumentId: 'synth-arp', role: 'synth-arp', fn: 'texture', name: `${t.name} (Arp)` };
          if (t.role === 'lead-guitar') return { instrumentId: 'synth-lead', role: 'synth-lead', fn: 'hook', name: 'Synth Lead' };
          if (t.role === 'bass' && id !== 'synth-bass') return { instrumentId: 'synth-bass' };
          if (t.role === 'drums' && id !== 'electronic-kit') return { instrumentId: 'electronic-kit' };
          if (t.role === 'keys' && id === 'piano') return { instrumentId: 'electric-piano' };
          if (t.role === 'strings' && getInstrument(id).polyphony === 'poly') return { instrumentId: 'synth-pad', role: 'synth-pad', fn: 'pad', name: 'Synth Pad' };
          if (t.role === 'strings') return { instrumentId: 'synth-lead', role: 'synth-lead', fn: t.constraints?.function ?? 'counter-melody', name: `${t.name} (Synth)` };
          return null;
        },
      });
    },
  },
  {
    id: 'radio-edit',
    name: 'Radio Edit',
    description: 'A ~3 minute structure that keeps every hook: shorter intro/outro, no solos or interludes, trimmed bridge and final chorus.',
    apply: (song, seed) => radioEdit(song, seed),
  },
];
