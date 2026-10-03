/**
 * Production helpers (spec §29 "Perform and produce this composition", §38 strategies,
 * §54 A/B generation): production prompts from the song's structured data, deterministic
 * candidate seeds, and request builders for audio-generation and singing providers.
 */
import {
  bpmAtTick,
  createTimeMap,
  getTag,
  hashSeed,
  keyAtTick,
  keyName,
  meterAtBar,
  sectionLayout,
  songLengthTicks,
  songTags,
  type Song,
  type Track,
} from '@songdeck/core';
import type { EncodedAudio, GenerationSection, MusicGenerationRequest, SingingNote, SingingRequest } from './types';
import { round, uniq } from './util';

export interface ProductionPromptOptions {
  /** Produce only this section (adds its purpose/energy/mood and section prompt). */
  sectionId?: string;
  /** Produce only this track (stem production, spec §38 Strategy B). */
  trackId?: string;
  /** Additional free-text instructions. */
  extra?: string;
  /** Max prompt length in characters (default 1000). */
  maxLength?: number;
}

export interface ProductionPrompt {
  prompt: string;
  negativePrompt: string;
  /** The individual phrases (deduplicated) that make up the prompt. */
  tags: string[];
}

const pretty = (s: string) => s.replace(/[-_]+/g, ' ').trim();

function splitList(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function energyDescriptor(energy: number): string {
  if (energy >= 85) return 'peak energy, full arrangement';
  if (energy >= 65) return 'high energy';
  if (energy >= 40) return 'medium energy';
  if (energy >= 20) return 'low energy, sparse';
  return 'very quiet, minimal';
}

function audibleTracks(song: Song): Track[] {
  return song.tracks.filter((t) => {
    if (song.production.trackMethods[t.id] === 'off') return false;
    return !song.mixer.channels[t.id]?.mute;
  });
}

function hasVocals(song: Song): boolean {
  if (song.vocals.mode === 'none') return false;
  return song.tracks.some((t) => t.role === 'vocal') || song.lyrics.length > 0;
}

/**
 * Genre, mood, instrument and production style tags for a song. Catalog tags join in by kind:
 * style tags with the genres, mood tags with the moods, vocal tags with the vocals and era,
 * production, region and rhythm tags with the production words.
 */
export function songStyleTags(song: Song): { genres: string[]; moods: string[]; instruments: string[]; production: string[]; vocals: string[] } {
  const catalog = songTags(song).map((id) => getTag(id)).filter((t) => t !== undefined);
  const uniqCi = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
  const named = (kinds: string[]) => catalog.filter((t) => kinds.includes(t.kind)).map((t) => t.name.toLowerCase());
  const genres = uniqCi([...(song.blueprint?.styles?.length ? [...song.blueprint.styles] : song.genreBlend.map((g) => pretty(g.genreId))), ...named(['style'])]);
  const moods = uniqCi([...(song.blueprint?.moods ?? []), ...named(['mood'])]);
  const instruments = uniq(audibleTracks(song).filter((t) => t.role !== 'vocal').map((t) => t.name || pretty(t.instrumentId)));
  const production = uniqCi([...splitList(song.production.prompt), ...named(['era', 'production', 'region', 'rhythm'])]);
  const vocals: string[] = [];
  if (hasVocals(song)) {
    const vt = song.tracks.find((t) => t.role === 'vocal')?.vocal?.voiceType ?? song.blueprint?.vocal?.voiceType;
    vocals.push(vt ? `${vt} lead vocal` : 'lead vocal');
    vocals.push(...named(['vocal']));
  } else vocals.push('instrumental');
  return { genres, moods, instruments, production, vocals };
}

/** Build a production prompt + negative prompt from the composition (spec §29 inputs). */
export function buildProductionPrompt(song: Song, opts: ProductionPromptOptions = {}): ProductionPrompt {
  const layout = sectionLayout(song);
  const span = opts.sectionId ? layout.find((s) => s.section.id === opts.sectionId) : undefined;
  const atTick = span?.startTick ?? 0;
  const tags = songStyleTags(song);
  const track = opts.trackId ? song.tracks.find((t) => t.id === opts.trackId) : undefined;
  const meter = meterAtBar(song, span?.startBar ?? 0);
  const parts: string[] = [];
  parts.push(...tags.genres);
  if (track) {
    parts.push(`solo ${track.name || pretty(track.instrumentId)} stem`, `isolated ${pretty(track.instrumentId)}`);
  } else {
    parts.push(...tags.instruments);
    parts.push(...tags.vocals);
  }
  parts.push(...tags.moods);
  parts.push(`${round(bpmAtTick(song, atTick), 1)} BPM`, keyName(keyAtTick(song, atTick)));
  if (meter.numerator !== 4 || meter.denominator !== 4) parts.push(`${meter.numerator}/${meter.denominator} time`);
  if (span) {
    const s = span.section;
    parts.push(pretty(s.kind));
    if (s.purpose) parts.push(s.purpose);
    parts.push(energyDescriptor(s.energyEnd !== undefined ? (s.energy + s.energyEnd) / 2 : s.energy));
    if (s.energyEnd !== undefined && s.energyEnd - s.energy >= 15) parts.push('building intensity');
    if (s.energyEnd !== undefined && s.energy - s.energyEnd >= 15) parts.push('winding down');
    if (s.feel && s.feel !== 'normal') parts.push(pretty(s.feel));
    parts.push(...(s.mood ?? []));
    parts.push(...splitList(song.production.sectionPrompts[s.id]));
  }
  parts.push(...tags.production);
  parts.push(...splitList(opts.extra));
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(p);
    }
  }
  const max = opts.maxLength ?? 1000;
  let prompt = '';
  const used: string[] = [];
  for (const p of deduped) {
    const next = prompt ? `${prompt}, ${p}` : p;
    if (next.length > max) break;
    prompt = next;
    used.push(p);
  }
  const negative = splitList(song.production.negativePrompt);
  if (!track && !hasVocals(song)) negative.push('vocals');
  if (track) {
    if (track.role !== 'vocal') negative.push('vocals');
    if (track.role !== 'drums' && track.role !== 'percussion') negative.push('drums');
    negative.push('other instruments');
  }
  return { prompt, negativePrompt: uniq(negative).join(', '), tags: used };
}

export interface ProductionCandidatePlan {
  /** "A", "B", "C"… */
  label: string;
  seed: number;
}

/** Deterministic A/B/C candidate seeds (spec §54): same composition, different interpretation. */
export function planCandidates(n: number, baseSeed: number): ProductionCandidatePlan[] {
  const count = Math.max(1, Math.min(26, Math.floor(n)));
  return Array.from({ length: count }, (_, i) => ({ label: String.fromCharCode(65 + i), seed: i === 0 ? baseSeed >>> 0 : hashSeed(baseSeed, 'production-candidate', i) }));
}

/** Lyric lines of a section (in song order). */
export function sectionLyricLines(song: Song, sectionId: string): string[] {
  return song.lyrics.filter((l) => l.sectionId === sectionId).map((l) => l.text.trim()).filter(Boolean);
}

/** Sections with absolute times from the tempo map (seconds). */
export function generationSections(song: Song, sectionIds?: string[]): GenerationSection[] {
  const tm = createTimeMap(song);
  const vocals = hasVocals(song);
  return sectionLayout(song)
    .filter((s) => !sectionIds?.length || sectionIds.includes(s.section.id))
    .map((s) => {
      const out: GenerationSection = {
        name: s.section.name,
        kind: s.section.kind,
        startSeconds: round(tm.tickToSeconds(s.startTick), 3),
        endSeconds: round(tm.tickToSeconds(s.endTick), 3),
        energy: s.section.energy,
      };
      const lines = vocals ? sectionLyricLines(song, s.section.id) : [];
      out.lines = lines;
      const sp = song.production.sectionPrompts[s.section.id];
      if (sp) out.prompt = sp;
      return out;
    });
}

export interface MusicRequestOptions {
  sectionIds?: string[];
  trackId?: string;
  seed?: number;
  guideAudio?: EncodedAudio;
  referenceAudio?: EncodedAudio;
  strength?: number;
  model?: string;
  outputFormat?: 'wav' | 'mp3';
  extraPrompt?: string;
  samples?: number;
}

/** A MusicGenerationRequest that describes the composition (spec §29: perform THIS composition). */
export function buildMusicGenerationRequest(song: Song, opts: MusicRequestOptions = {}): MusicGenerationRequest {
  const tm = createTimeMap(song);
  const sections = generationSections(song, opts.sectionIds);
  const start = sections.length ? sections[0].startSeconds : 0;
  const end = sections.length ? sections[sections.length - 1].endSeconds : tm.tickToSeconds(songLengthTicks(song));
  const pp = buildProductionPrompt(song, { sectionId: opts.sectionIds?.length === 1 ? opts.sectionIds[0] : undefined, trackId: opts.trackId, extra: opts.extraPrompt });
  const shifted = sections.map((s) => ({ ...s, startSeconds: round(s.startSeconds - start, 3), endSeconds: round(s.endSeconds - start, 3) }));
  const lyrics = shifted
    .filter((s) => s.lines?.length)
    .map((s) => `[${(s.kind ?? s.name).toLowerCase()}]\n${s.lines!.join('\n')}`)
    .join('\n\n');
  const instrumental = !!opts.trackId || !hasVocals(song) || !lyrics;
  const req: MusicGenerationRequest = {
    prompt: pp.prompt,
    durationSeconds: round(end - start, 3),
    bpm: round(bpmAtTick(song, 0), 2),
    key: keyName(keyAtTick(song, 0)),
    meter: `${meterAtBar(song, 0).numerator}/${meterAtBar(song, 0).denominator}`,
    sections: shifted,
    instrumental,
  };
  if (pp.negativePrompt) req.negativePrompt = pp.negativePrompt;
  if (!instrumental) req.lyrics = lyrics;
  if (opts.seed !== undefined) req.seed = opts.seed;
  if (opts.guideAudio) req.guideAudio = opts.guideAudio;
  if (opts.referenceAudio) req.referenceAudio = opts.referenceAudio;
  if (opts.strength !== undefined) req.strength = opts.strength;
  if (opts.model) req.model = opts.model;
  if (opts.outputFormat) req.outputFormat = opts.outputFormat;
  if (opts.samples) req.samples = opts.samples;
  if (!opts.sectionIds?.length && !opts.trackId) req.song = song;
  return req;
}

export interface SingingRequestOptions {
  voiceId: string;
  seed?: number;
  sampleRate?: number;
  /** Only notes starting in [startTick, endTick) (phrase regeneration, spec §37). */
  startTick?: number;
  endTick?: number;
  language?: string;
  /** Lyric used for notes without a syllable (default "la"). */
  defaultSyllable?: string;
}

/** Convert a vocal track to a SingingRequest (times in seconds from the tempo map). */
export function buildSingingRequest(song: Song, trackId: string, opts: SingingRequestOptions): SingingRequest {
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const tm = createTimeMap(song);
  const defaults = song.vocals.defaultExpression ?? {};
  const notes: SingingNote[] = track.notes
    .filter((n) => (opts.startTick === undefined || n.tick >= opts.startTick) && (opts.endTick === undefined || n.tick < opts.endTick))
    .sort((a, b) => a.tick - b.tick)
    .map((n) => {
      const startSeconds = tm.tickToSeconds(n.tick);
      const note: SingingNote = {
        pitch: n.pitch,
        startSeconds: round(startSeconds, 4),
        durationSeconds: round(tm.tickToSeconds(n.tick + n.duration) - startSeconds, 4),
        lyric: n.syllable ?? opts.defaultSyllable ?? 'la',
        velocity: n.velocity,
      };
      if (n.phonemes?.length) note.phonemes = [...n.phonemes];
      const expression = { ...defaults, ...(n.expression ?? {}) };
      if (Object.keys(expression).length) note.expression = expression;
      return note;
    });
  const req: SingingRequest = {
    voiceId: opts.voiceId,
    tempoBpm: round(bpmAtTick(song, opts.startTick ?? 0), 3),
    notes,
    sampleRate: opts.sampleRate ?? 44100,
    language: opts.language ?? song.vocals.language,
  };
  if (opts.seed !== undefined) req.seed = opts.seed;
  return req;
}
