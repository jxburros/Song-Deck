import {
  barToTick,
  cloneSong,
  createTimeMap,
  deriveRng,
  fnv1a,
  sectionLayout,
  songLengthBars,
  stableStringify,
  type ProductionCandidate,
  type ProductionStrategy,
  type Project,
  type Revision,
  type Song,
  type StemGroup,
  type Track,
  type TrackProductionMethod,
} from '@songdeck/core';
import type { Capability, DataKind } from '@songdeck/ai';
import { mixHash } from './mix-render';

/**
 * Production model (spec §28 guide rendering, §29 production engine, §38 strategies, §39 selective
 * regeneration, §54 A/B generation): pure helpers shared by the Produce mode UI and the production
 * task handlers. Nothing here touches audio or the network.
 *
 * Rule of the house: the composition is canonical; audio is a rendering of it. Produced audio
 * tracks are therefore marked (generator id) so every production step can recover the composition
 * they were rendered from (`productionSourceSong`).
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Generator id of audio tracks that carry a produced stem ("Use produced stems in the mix"). */
export const PRODUCED_STEM_GENERATOR = 'song-deck-production-stem';
/** Generator id of an audio track carrying a full produced mix (Strategy A candidates). */
export const PRODUCED_MIX_GENERATOR = 'song-deck-production-mix';
/** Provider id recorded for on-device guide renders (spec §28). */
export const GUIDE_RENDERER_ID = 'song-deck-guide-renderer';

export type GuideRenderer = 'builtin' | 'external' | 'sampled';

export const GUIDE_RENDERERS: Record<
  GuideRenderer,
  { label: string; providerName: string; description: string }
> = {
  builtin: {
    label: 'Built-in instrument library',
    providerName: 'Built-in instrument library (guide renderer)',
    description:
      'Song Deck’s deterministic synth & drum patches — the same engine as playback. Works offline, instantly.',
  },
  external: {
    label: 'External DAW rendering',
    providerName: 'External DAW rendering (imported stems)',
    description:
      'Export per-stem MIDI, render it with your own instruments (VST, Kontakt, a hardware rig…), then import the WAVs.',
  },
  sampled: {
    label: 'User sample instruments',
    providerName: 'User sample instruments (SFZ / plugin instruments)',
    description:
      'Render chosen tracks with sample instruments (SFZ sample libraries, plugin instruments); the rest uses built-in patches.',
  },
};

export const GUIDE_MIX_FILE = 'guide_mix.wav';

/** Reference stems by stem group (spec §28 output names). */
export const GUIDE_STEM_FILES: Record<StemGroup, { file: string; label: string }> = {
  drums: { file: 'drums_reference.wav', label: 'Drums' },
  bass: { file: 'bass_reference.wav', label: 'Bass' },
  guitars: { file: 'guitar_reference.wav', label: 'Guitars' },
  keys: { file: 'keys_reference.wav', label: 'Keys' },
  strings: { file: 'strings_reference.wav', label: 'Strings' },
  vocals: { file: 'vocal_melody_reference.wav', label: 'Vocal melody' },
  others: { file: 'other_reference.wav', label: 'Other (synths, brass, FX)' },
};

export const STEM_GROUP_ORDER: StemGroup[] = [
  'drums',
  'bass',
  'guitars',
  'keys',
  'strings',
  'vocals',
  'others',
];

/** Parameters stored on produced audio tracks (Track.generator.params). */
export interface ProducedTrackParams {
  candidateId?: string;
  candidateLabel?: string;
  /** Mute state of the source MIDI track before it was replaced by the produced stem. */
  sourceMuted?: boolean;
  /** Tracks muted when a full produced mix replaced the arrangement. */
  mutedTrackIds?: string[];
}

export function isProducedTrack(t: Pick<Track, 'kind' | 'generator'>): boolean {
  return (
    t.kind === 'audio' &&
    (t.generator?.id === PRODUCED_STEM_GENERATOR || t.generator?.id === PRODUCED_MIX_GENERATOR)
  );
}

/**
 * The composition as production sees it: produced audio tracks removed and the MIDI tracks they
 * replaced audible again. Guide renders, prompts and references are built from this, so adopting a
 * candidate never feeds produced audio back into the next production.
 */
export function productionSourceSong(song: Song): Song {
  const produced = song.tracks.filter(isProducedTrack);
  if (!produced.length) return song;
  const unmute = new Set<string>();
  for (const t of produced) {
    const params = (t.generator?.params ?? {}) as ProducedTrackParams;
    if (t.generator?.id === PRODUCED_STEM_GENERATOR && t.sourceTrackId && params.sourceMuted === false)
      unmute.add(t.sourceTrackId);
    if (t.generator?.id === PRODUCED_MIX_GENERATOR)
      for (const id of params.mutedTrackIds ?? []) unmute.add(id);
  }
  const ids = new Set(produced.map((t) => t.id));
  const channels = { ...song.mixer.channels };
  for (const id of unmute) if (channels[id]?.mute) channels[id] = { ...channels[id], mute: false };
  for (const id of ids) delete channels[id];
  return {
    ...song,
    tracks: song.tracks.filter((t) => !ids.has(t.id)),
    mixer: { ...song.mixer, channels },
    automation: song.automation.filter((l) => !ids.has(l.target)),
  };
}

export function hasContent(t: Track): boolean {
  return t.kind === 'audio' ? t.clips.some((c) => !c.muted) : t.notes.length > 0;
}

export function isVocalTrack(t: Pick<Track, 'role' | 'stemGroup'>): boolean {
  return t.role === 'vocal' || t.stemGroup === 'vocals';
}

/** A vocal MIDI track whose vocal mode is "No vocal" is silent (spec §33). */
function silencedVocal(song: Song, t: Track): boolean {
  return t.kind === 'midi' && t.role === 'vocal' && (t.vocal?.mode ?? song.vocals?.mode) === 'none';
}

/** Tracks that sound in the composition (not muted, with notes or clips). */
export function audibleSourceTracks(song: Song): Track[] {
  return song.tracks.filter(
    (t) =>
      !isProducedTrack(t) && hasContent(t) && !song.mixer.channels[t.id]?.mute && !silencedVocal(song, t),
  );
}

/** The song has a sung lead vocal: a vocal track with notes plus lyrics (or syllables). */
export function hasSungVocals(song: Song): boolean {
  if (song.vocals?.mode === 'none') return false;
  const vocal = audibleSourceTracks(song).filter((t) => t.kind === 'midi' && t.role === 'vocal');
  return vocal.length > 0 && (song.lyrics.length > 0 || vocal.some((t) => t.notes.some((n) => !!n.syllable)));
}

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

/**
 * Hash of the composition itself (tempo, meter, key, form, harmony, lyrics, notes, recorded clips).
 * Equal hashes ⇒ the same composition, whatever production settings or revisions came in between.
 */
export function compositionHash(song: Song): string {
  const s = productionSourceSong(song);
  return hex(
    fnv1a(
      stableStringify({
        ppq: s.ppq,
        tempoMap: s.tempoMap,
        meterMap: s.meterMap,
        keyMap: s.keyMap,
        sections: s.sections.map((x) => [x.id, x.bars]),
        chords: s.chords.map((c) => [c.tick, c.duration, c.symbol]),
        lyrics: s.lyrics.map((l) => [l.sectionId, l.text]),
        tracks: s.tracks.map((t) => ({
          id: t.id,
          kind: t.kind,
          instrumentId: t.instrumentId,
          notes: t.notes.map((n) => [n.tick, n.duration, n.pitch, n.velocity, n.syllable ?? '']),
          clips: t.clips.map((c) => [
            c.assetId,
            c.tick,
            c.offsetSeconds,
            c.durationSeconds,
            c.gainDb,
            c.muted ? 1 : 0,
          ]),
        })),
      }),
    ),
  );
}

/** Hash of everything that changes a guide render (composition + mixer + automation + vocal mode). */
export function guideHash(song: Song): string {
  const s = productionSourceSong(song);
  return hex(fnv1a(`${mixHash(s)}|${s.vocals?.mode ?? ''}`));
}

// ---------------------------------------------------------------------------
// Strategies (spec §38) and per-track methods (Strategy C)
// ---------------------------------------------------------------------------

export interface StrategyInfo {
  id: ProductionStrategy;
  letter: 'A' | 'B' | 'C';
  title: string;
  flow: string;
  traits: { label: string; tone: 'success' | 'warning' | 'ai' | 'accent' }[];
  description: string;
}

export const STRATEGIES: StrategyInfo[] = [
  {
    id: 'full',
    letter: 'A',
    title: 'Full Generation',
    flow: 'Guide mix → generative music model → finished song',
    traits: [
      { label: 'Fastest', tone: 'success' },
      { label: 'Least precise', tone: 'warning' },
    ],
    description:
      'One generation per candidate from the whole guide mix. The model may reinterpret parts; you cannot fix one instrument without regenerating everything.',
  },
  {
    id: 'stems',
    letter: 'B',
    title: 'Stem Production',
    flow: 'guitar MIDI → guitar reference → produced guitar · bass MIDI → bass reference → produced bass … then mixed',
    traits: [
      { label: 'Much more controllable', tone: 'success' },
      { label: 'One generation per stem', tone: 'accent' },
    ],
    description:
      'Each instrument reference is transformed separately, then the produced stems are mixed with your mixer settings. Stems can be adopted into Mix & Master.',
  },
  {
    id: 'hybrid',
    letter: 'C',
    title: 'Hybrid Production',
    flow: 'Drums — sampled kit · Bass — VST · Guitar — AI-produced · Violin — orchestral library · Vocal — singing synthesis',
    traits: [
      { label: 'Most professional workflow', tone: 'success' },
      { label: 'Per-track method', tone: 'ai' },
    ],
    description:
      'Choose per track: conventional instruments (built-in, sampled, external), generative AI, singing synthesis or recorded audio.',
  },
];

export function strategyInfo(id: ProductionStrategy): StrategyInfo {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[1];
}

export const METHOD_INFO: Record<
  TrackProductionMethod,
  { label: string; short: string; description: string }
> = {
  guide: {
    label: 'Built-in instrument',
    short: 'Built-in',
    description: 'Rendered by the built-in instrument library (conventional virtual instrument).',
  },
  sampled: {
    label: 'Sample instrument',
    short: 'Sampled',
    description:
      'Rendered with an assigned sample instrument (SFZ / plugin library); built-in patch when none is assigned.',
  },
  external: {
    label: 'External render',
    short: 'External',
    description: 'Uses the stem you rendered in your DAW (imported in Guide render).',
  },
  ai: {
    label: 'Generative AI',
    short: 'AI',
    description: 'The production provider transforms this track’s reference into a produced stem.',
  },
  singing: {
    label: 'Singing synthesis',
    short: 'Singing',
    description: 'The singing engine performs the vocal MIDI with lyrics and expression.',
  },
  recorded: {
    label: 'Recorded audio',
    short: 'Recorded',
    description: 'Uses recorded audio (audio-track clips or the active vocal take) as-is.',
  },
  off: { label: 'Off', short: 'Off', description: 'Excluded from production.' },
};

export const METHOD_ORDER: TrackProductionMethod[] = [
  'guide',
  'sampled',
  'external',
  'ai',
  'singing',
  'recorded',
  'off',
];

/** Spec §38 Strategy C example: sampled/VST rhythm section, AI guitars, sung vocal. */
export function defaultHybridMethod(track: Track): TrackProductionMethod {
  if (track.kind === 'audio') return 'recorded';
  if (track.role === 'vocal' || track.stemGroup === 'vocals') return 'singing';
  if (track.role === 'rhythm-guitar' || track.role === 'lead-guitar' || track.stemGroup === 'guitars')
    return 'ai';
  return 'guide';
}

/** Methods that make sense for a track (audio tracks can only be used as recorded or switched off). */
export function methodsFor(track: Track): TrackProductionMethod[] {
  if (track.kind === 'audio') return ['recorded', 'off'];
  const vocal = track.role === 'vocal' || track.stemGroup === 'vocals';
  return METHOD_ORDER.filter((m) => (m === 'singing' ? vocal : m === 'recorded' ? vocal : true));
}

/** How a track is produced under a strategy (B: AI for MIDI tracks; C: the per-track table). */
export function methodFor(
  track: Track,
  strategy: ProductionStrategy,
  methods: Record<string, TrackProductionMethod>,
): TrackProductionMethod {
  const stored = methods[track.id];
  if (stored === 'off') return 'off';
  if (track.kind === 'audio') return 'recorded';
  if (strategy === 'hybrid')
    return stored && methodsFor(track).includes(stored) ? stored : defaultHybridMethod(track);
  return 'ai';
}

export interface ProductionUnit {
  track: Track;
  method: TrackProductionMethod;
}

/** Production units of a (source) song: one per audible track, in track order. */
export function productionUnits(
  song: Song,
  strategy: ProductionStrategy,
  methods: Record<string, TrackProductionMethod>,
): ProductionUnit[] {
  return audibleSourceTracks(song)
    .map((track) => ({ track, method: methodFor(track, strategy, methods) }))
    .filter((u) => u.method !== 'off');
}

// ---------------------------------------------------------------------------
// Candidate labels (spec §54: Production A, B, C…; regenerated versions B2, B3…)
// ---------------------------------------------------------------------------

export function labelAt(i: number): string {
  let s = '';
  let x = i;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

export function baseLabel(label: string): string {
  return label.replace(/\d+$/, '') || label;
}

/** The next `n` unused letters (a regenerated "B2" keeps "B" in use). */
export function nextLabels(candidates: Pick<ProductionCandidate, 'label'>[], n: number): string[] {
  const used = new Set(candidates.map((c) => baseLabel(c.label)));
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 26 * 27; i++) {
    const l = labelAt(i);
    if (!used.has(l)) out.push(l);
  }
  return out;
}

export function nextVersionLabel(
  candidates: Pick<ProductionCandidate, 'label'>[],
  parentLabel: string,
): string {
  const base = baseLabel(parentLabel);
  let max = 1;
  for (const c of candidates) {
    if (!c.label.startsWith(base)) continue;
    const rest = c.label.slice(base.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${base}${max + 1}`;
}

// ---------------------------------------------------------------------------
// Performer (spec §72): a seeded interpretation of the same notes
// ---------------------------------------------------------------------------

/**
 * A render-only performance of the composition: micro-timing, feel and dynamics vary with the
 * seed; pitches, durations, structure and lyrics never change, and nothing is committed. This is
 * what makes on-device candidates A/B/C differ while the composition stays identical (spec §54).
 */
export function performSong(song: Song, seed: number, amount: number): Song {
  const a = Math.max(0, Math.min(1, amount));
  if (a <= 0) return song;
  const out = cloneSong(song);
  const ppq = out.ppq || 480;
  for (const t of out.tracks) {
    if (t.kind !== 'midi' || !t.notes.length) continue;
    const rng = deriveRng(seed >>> 0, 'performance', t.id);
    const drums = t.role === 'drums' || t.role === 'percussion' || t.midiChannel === 9;
    const feel = rng.range(-1, 1) * a * (ppq / 80);
    const sigma = a * (ppq / (drums ? 110 : 70));
    const dynamics = 1 + rng.range(-0.1, 0.1) * a;
    t.notes = t.notes
      .map((n) => {
        const dt = Math.round(feel + rng.gaussian(0, sigma));
        const tick = Math.max(0, n.tick + dt);
        const velocity = Math.round(
          Math.min(127, Math.max(1, n.velocity * dynamics + rng.gaussian(0, 7 * a))),
        );
        return { ...n, tick, velocity };
      })
      .sort((x, y) => x.tick - y.tick || x.pitch - y.pitch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Regions (spec §39 "Regenerate bars 33–41")
// ---------------------------------------------------------------------------

export interface RegionSpan {
  /** 1-based, inclusive. */
  startBar: number;
  endBar: number;
  startTick: number;
  endTick: number;
  startSeconds: number;
  endSeconds: number;
}

export function regionSpan(song: Song, startBar: number, endBar: number): RegionSpan {
  const total = Math.max(1, songLengthBars(song));
  const s = Math.max(1, Math.min(total, Math.round(startBar) || 1));
  const e = Math.max(s, Math.min(total, Math.round(endBar) || s));
  const tm = createTimeMap(song);
  const startTick = barToTick(song, s - 1);
  const endTick = barToTick(song, e);
  return {
    startBar: s,
    endBar: e,
    startTick,
    endTick,
    startSeconds: tm.tickToSeconds(startTick),
    endSeconds: tm.tickToSeconds(endTick),
  };
}

export function regionLabel(r: Pick<RegionSpan, 'startBar' | 'endBar'>): string {
  return r.startBar === r.endBar ? `bar ${r.startBar}` : `bars ${r.startBar}–${r.endBar}`;
}

/** Sections overlapping [startTick, endTick). */
export function sectionsInRegion(song: Song, startTick: number, endTick: number) {
  return sectionLayout(song).filter((s) => s.startTick < endTick && s.endTick > startTick);
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

export function headRevisionOf(project: Project): Revision | undefined {
  const branch = project.history.branches.find((b) => b.id === project.history.currentBranchId);
  return project.history.revisions.find((r) => r.id === branch?.headRevisionId);
}

export function revisionById(project: Project, id: string | undefined): Revision | undefined {
  return id ? project.history.revisions.find((r) => r.id === id) : undefined;
}

/** The composition a candidate was produced from (its source revision), or the working copy. */
export function candidateSourceSong(
  project: Project,
  candidate: Pick<ProductionCandidate, 'sourceRevisionId'>,
): Song {
  return revisionById(project, candidate.sourceRevisionId)?.snapshot ?? project.song;
}

// ---------------------------------------------------------------------------
// Capabilities (spec §30) and how a provider is used for a strategy
// ---------------------------------------------------------------------------

export const PRODUCTION_CAPABILITIES: Capability[] = [
  'TEXT_TO_MUSIC',
  'AUDIO_TO_AUDIO',
  'REFERENCE_AUDIO',
  'STEM_CONDITIONING',
  'LYRIC_CONDITIONING',
  'VOCAL_GENERATION',
  'INSTRUMENTAL_ONLY',
  'SECTION_GENERATION',
  'INPAINTING',
  'OUTPAINTING',
  'STEM_OUTPUT',
];

/**
 * How the provider performs one generation:
 *  - render-song      the provider performs the composition from MIDI (on-device producer)
 *  - generate-guided  text-to-music conditioned on the guide (audio-to-audio / stem conditioning)
 *  - transform        audio-to-audio: reference render → produced audio
 *  - generate-text    text-to-music only (tempo, key, sections, lyrics — not the exact notes)
 */
export type ProductionOp = 'render-song' | 'generate-guided' | 'transform' | 'generate-text';

export interface OpPlan {
  op: ProductionOp;
  /** Capabilities requested from the router for this generation. */
  caps: Capability[];
  /** Send lyrics so the model sings them. */
  sing: boolean;
  /** Send the reference audio. */
  reference: boolean;
}

export interface PlanWarning {
  level: 'info' | 'warning' | 'danger';
  text: string;
}

export interface WantedCapability {
  cap: Capability;
  why: string;
  have: boolean;
  required?: boolean;
}

export interface StrategyPlan {
  ok: boolean;
  plan?: OpPlan;
  /** Selective regeneration path for candidates of this provider. */
  region: 'inpaint' | 'reproduce';
  warnings: PlanWarning[];
  wanted: WantedCapability[];
}

export interface PlanContext {
  /** The song has a sung vocal (lyrics + vocal track). */
  vocals: boolean;
  /** Reference audio is attached AND may be sent to this provider. */
  reference: boolean;
  /** Units the provider must produce (Strategy B/C); 0 = provider unused. */
  aiUnits: number;
  /** Units that are vocals and produced by the AI provider. */
  aiVocalUnits: number;
  /** The provider instance implements inpaintAudio(). */
  hasInpaint: boolean;
}

export function planStrategy(
  strategy: ProductionStrategy,
  caps: readonly Capability[],
  ctx: PlanContext,
): StrategyPlan {
  const has = (c: Capability) => caps.includes(c);
  const warnings: PlanWarning[] = [];
  const wanted: WantedCapability[] = [];
  const want = (cap: Capability, why: string, required = false) =>
    wanted.push({ cap, why, have: has(cap), required });
  let plan: OpPlan | undefined;

  if (strategy === 'full') {
    want('AUDIO_TO_AUDIO', 'follow the guide mix (perform this composition, not a lookalike)');
    want('STEM_CONDITIONING', 'condition generation on the guide render');
    want('SECTION_GENERATION', 'respect the song’s sections and durations');
    if (ctx.vocals) {
      want('LYRIC_CONDITIONING', 'sing your lyrics');
      want('VOCAL_GENERATION', 'generate the lead vocal');
    }
    if (ctx.reference) want('REFERENCE_AUDIO', 'use your reference audio for sound/style');
    if (has('MIDI_CONDITIONING') && !has('TEXT_TO_MUSIC') && !has('AUDIO_TO_AUDIO'))
      plan = { op: 'render-song', caps: ['MIDI_CONDITIONING'], sing: false, reference: false };
    else if (has('TEXT_TO_MUSIC') && (has('AUDIO_TO_AUDIO') || has('STEM_CONDITIONING')))
      plan = {
        op: 'generate-guided',
        caps: ['TEXT_TO_MUSIC', has('AUDIO_TO_AUDIO') ? 'AUDIO_TO_AUDIO' : 'STEM_CONDITIONING'],
        sing: false,
        reference: false,
      };
    else if (has('AUDIO_TO_AUDIO'))
      plan = { op: 'transform', caps: ['AUDIO_TO_AUDIO'], sing: false, reference: false };
    else if (has('TEXT_TO_MUSIC')) {
      plan = { op: 'generate-text', caps: ['TEXT_TO_MUSIC'], sing: false, reference: false };
      warnings.push({
        level: 'danger',
        text: 'Text-to-music only: the result follows tempo, key, structure and lyrics, but not your exact notes — expect a reinterpretation of the song.',
      });
    } else if (has('MIDI_CONDITIONING'))
      plan = { op: 'render-song', caps: ['MIDI_CONDITIONING'], sing: false, reference: false };
    if (plan && plan.op !== 'render-song' && plan.op !== 'transform') {
      if (ctx.vocals) {
        if (has('LYRIC_CONDITIONING') && has('VOCAL_GENERATION')) {
          plan.sing = true;
          plan.caps.push('LYRIC_CONDITIONING', 'VOCAL_GENERATION');
        } else {
          warnings.push({
            level: 'warning',
            text: 'This provider cannot sing lyrics — the vocal will be left out. Use Hybrid (C) with singing synthesis for the vocal.',
          });
          if (has('INSTRUMENTAL_ONLY')) plan.caps.push('INSTRUMENTAL_ONLY');
        }
      } else if (has('INSTRUMENTAL_ONLY')) plan.caps.push('INSTRUMENTAL_ONLY');
      if (ctx.reference) {
        if (has('REFERENCE_AUDIO')) {
          plan.reference = true;
          plan.caps.push('REFERENCE_AUDIO');
        } else
          warnings.push({
            level: 'info',
            text: 'Reference audio is attached but this provider cannot use it.',
          });
      }
      if (!has('SECTION_GENERATION'))
        warnings.push({
          level: 'info',
          text: 'No section awareness: section prompts are folded into the global prompt.',
        });
    }
    if (plan?.op === 'render-song') {
      warnings.push({
        level: 'info',
        text: 'Non-neural: performs your exact MIDI with production presets. Candidates differ by seeded performance (timing, dynamics, per-note variation).',
      });
      if (ctx.reference)
        warnings.push({ level: 'info', text: 'Reference audio is not used by the on-device producer.' });
    }
    if (plan?.op === 'transform') {
      if (ctx.vocals && !has('VOCAL_GENERATION'))
        warnings.push({
          level: 'warning',
          text: 'Audio-to-audio without vocal generation: the guide vocal is a placeholder and may come out unsung.',
        });
      if (ctx.reference)
        warnings.push({
          level: 'info',
          text: 'Audio-to-audio transforms the guide; the reference audio is not sent.',
        });
    }
  } else {
    const units = ctx.aiUnits;
    want('AUDIO_TO_AUDIO', 'transform each instrument reference into a produced stem', units > 0);
    want('STEM_CONDITIONING', 'condition each stem on its reference render');
    want('INSTRUMENTAL_ONLY', 'keep instrument stems free of vocals');
    if (ctx.aiVocalUnits > 0)
      want('VOCAL_GENERATION', 'produce the vocal stem (or use singing synthesis in Hybrid)');
    if (ctx.reference) want('REFERENCE_AUDIO', 'use your reference audio for sound/style');
    if (units > 0) {
      if (has('AUDIO_TO_AUDIO'))
        plan = { op: 'transform', caps: ['AUDIO_TO_AUDIO'], sing: false, reference: false };
      else if (has('TEXT_TO_MUSIC') && has('STEM_CONDITIONING'))
        plan = {
          op: 'generate-guided',
          caps: ['TEXT_TO_MUSIC', 'STEM_CONDITIONING'],
          sing: false,
          reference: false,
        };
      else if (has('STEM_CONDITIONING') || has('STEM_GENERATION'))
        plan = {
          op: 'transform',
          caps: [has('STEM_CONDITIONING') ? 'STEM_CONDITIONING' : 'STEM_GENERATION'],
          sing: false,
          reference: false,
        };
      else if (has('TEXT_TO_MUSIC')) {
        plan = { op: 'generate-text', caps: ['TEXT_TO_MUSIC'], sing: false, reference: false };
        warnings.push({
          level: 'danger',
          text: 'Text-to-music only: each stem is generated from a description and will not follow your notes. Prefer an audio-to-audio provider for stem production.',
        });
      }
      if (plan && (plan.op === 'generate-guided' || plan.op === 'generate-text')) {
        if (has('INSTRUMENTAL_ONLY')) plan.caps.push('INSTRUMENTAL_ONLY');
        if (ctx.reference && has('REFERENCE_AUDIO')) {
          plan.reference = true;
          plan.caps.push('REFERENCE_AUDIO');
        }
      }
      if (plan && ctx.aiVocalUnits > 0 && !has('VOCAL_GENERATION')) {
        warnings.push({
          level: 'warning',
          text: `The vocal is transformed by a provider without vocal generation — use Hybrid (C) with singing synthesis for a sung vocal.`,
        });
      }
      if (plan && ctx.reference && !plan.reference)
        warnings.push({
          level: 'info',
          text: 'Reference audio is not used for stem transforms by this provider.',
        });
      if (plan?.op === 'transform' && !has('AUDIO_TO_AUDIO')) {
        warnings.push({
          level: 'info',
          text: 'Non-neural DSP production chain (glue compression, tone, width) per stem. Candidates differ by seeded performance; stems are level-matched to keep your mix balance.',
        });
      }
    } else {
      warnings.push({
        level: 'info',
        text: 'No track uses generative AI — the production provider will not be called.',
      });
    }
  }
  want('INPAINTING', 'regenerate a bar range in place (selective regeneration)');
  const region = has('INPAINTING') && ctx.hasInpaint ? 'inpaint' : 'reproduce';
  const needsProvider = strategy === 'full' || ctx.aiUnits > 0;
  if (needsProvider && !plan) {
    warnings.unshift({
      level: 'danger',
      text:
        strategy === 'full'
          ? 'This provider cannot produce a full song (needs text-to-music, audio-to-audio or MIDI conditioning).'
          : 'This provider cannot produce stems (needs audio-to-audio or stem conditioning).',
    });
  }
  return { ok: !needsProvider || !!plan, plan, region, warnings, wanted };
}

/** Data kinds a generation sends (privacy indicator, spec §50). */
export function opDataKinds(plan: OpPlan, scope: 'mix' | 'stem' | 'region'): DataKind[] {
  const kinds = new Set<DataKind>(['song-description']);
  if (plan.op === 'render-song') {
    kinds.add('midi');
    kinds.add('chord-progression');
    kinds.add('lyrics');
  }
  if (plan.op === 'generate-guided' || plan.op === 'generate-text') kinds.add('chord-progression');
  if (plan.op === 'generate-guided' || plan.op === 'transform')
    kinds.add(scope === 'region' ? 'stems' : 'guide-audio');
  if (plan.sing) kinds.add('lyrics');
  if (plan.reference) kinds.add('reference-audio');
  return [...kinds];
}

// ---------------------------------------------------------------------------
// Rough wall-clock estimates for on-device production (display only)
// ---------------------------------------------------------------------------

/** Seconds of processing per second of audio, measured on a mid-range laptop CPU. */
const ON_DEVICE_RATE = { render: 0.016, transform: 0.035, mix: 0.03 };

export function estimateOnDeviceSeconds(
  strategy: ProductionStrategy,
  songSeconds: number,
  units: number,
  aiUnits: number,
  candidates: number,
): number {
  const perCandidate =
    strategy === 'full'
      ? songSeconds * (ON_DEVICE_RATE.render * 4 + ON_DEVICE_RATE.mix)
      : songSeconds *
        (units * ON_DEVICE_RATE.render + aiUnits * ON_DEVICE_RATE.transform + ON_DEVICE_RATE.mix);
  const parallel = Math.min(2, Math.max(1, candidates));
  return (perCandidate * candidates) / parallel + 2;
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r ? `${m} min ${r} s` : `${m} min`;
}

export function slug(name: string, fallback = 'track'): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}
