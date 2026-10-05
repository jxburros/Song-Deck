import { create } from 'zustand';
import {
  parseLyricSheet,
  randomSeed,
  type BlueprintLyrics,
  type BuilderChoices,
  type BuilderGenre,
  type BuilderInstrument,
  type BuilderMood,
  type MacroSettings,
  type ModeName,
  type SectionKind,
  type Song,
  type TempoFeel,
  type VocalMode,
  type VoiceType,
} from '@songdeck/core';

/**
 * Start-a-song session: the starting material (lyrics, prompt; recordings and MIDI live in
 * ./inputs) and the structured choices (instruments, genres, moods, tags, settings, feel) the user
 * is assembling. Survives switching modes; the four starts on the Songs home screen open it on the
 * Material step with that material ready.
 */

/** Material → Shape, then (when "Review the blueprint and plan" is on) Blueprint → Plan. */
export type ComposeStep = 'material' | 'shape' | 'blueprint' | 'plan';
/** Which start the user picked on the Songs home screen. */
export type StartFocus = 'lyrics' | 'audio' | 'midi' | 'prompt';
export type LyricsMode = 'provided' | 'generate' | 'placeholder' | 'instrumental';

export interface ComposeDraft {
  instruments: BuilderInstrument[];
  genres: BuilderGenre[];
  moods: BuilderMood[];
  tags: string[];
  tempo: 'auto' | TempoFeel | 'bpm';
  bpm: number;
  tonic: 'auto' | number;
  mode: 'auto' | ModeName;
  meter: 'auto' | string;
  length: 'standard' | 'short' | 'long' | 'minutes';
  minutes: number;
  structure: string;
  vocal: 'auto' | 'none' | VoiceType;
  /** 'default': an AI singer when there are lyrics, else the vocal melody only. */
  vocalMode: 'default' | VocalMode;
  title: string;
  lyricsTheme: string;
  /** Lyrics pasted up front (lyrics-first). */
  lyricsText: string;
  /** User overrides of detected section kinds, by section index. */
  lyricKinds: Record<number, SectionKind>;
  lockLyrics: boolean;
  /** "Describe it in your own words" (only used when a model is attached). */
  describe: string;
  /** Feel sliders (0–1) the user moved; the rest keep the genre's defaults. */
  macros: Partial<MacroSettings>;
}

export const EMPTY_DRAFT: ComposeDraft = {
  instruments: [],
  genres: [],
  moods: [],
  tags: [],
  tempo: 'auto',
  bpm: 120,
  tonic: 'auto',
  mode: 'auto',
  meter: 'auto',
  length: 'standard',
  minutes: 3,
  structure: '',
  vocal: 'auto',
  vocalMode: 'default',
  title: '',
  lyricsTheme: '',
  lyricsText: '',
  lyricKinds: {},
  lockLyrics: true,
  describe: '',
  macros: {},
};

interface ComposeSession {
  draft: ComposeDraft;
  step: ComposeStep;
  /** The lyrics and prompt cards on the Material step. */
  lyricsOn: boolean;
  promptOn: boolean;
  /** The start picked on the Songs home screen (scrolls to / opens that material). */
  focus: StartFocus | null;
  /** Review the blueprint and the plan before composing. */
  review: boolean;
  /** No vocal at all: lyrics options are hidden and ignored, and the song has no vocal track. */
  instrumental: boolean;
  /** The user chose to skip material and compose from the style settings alone. */
  fromStyle: boolean;
  seed: number;
  planner: string;
  lyricsMode: LyricsMode;
  lyricsProvider: string;
  patch(p: Partial<ComposeDraft>): void;
  set(
    p: Partial<
      Omit<ComposeSession, 'set' | 'patch' | 'reset' | 'start' | 'startFromStyle' | 'setInstrumental'>
    >,
  ): void;
  /** Open Start a song on the Material step with one start ready. */
  start(focus: StartFocus | null): void;
  /** Skip material: open Shape, where a style preset and a few basics are enough. */
  startFromStyle(): void;
  setInstrumental(on: boolean): void;
  reset(): void;
}

/** The lyrics workflow that applies: Instrumental overrides whatever the lyrics card says. */
export function activeLyricsMode(s: Pick<ComposeSession, 'instrumental' | 'lyricsMode'>): LyricsMode {
  return s.instrumental ? 'instrumental' : s.lyricsMode;
}

/** Lyrics take part in the song: the lyrics card is on and the song is not instrumental. */
export function lyricsActive(s: Pick<ComposeSession, 'instrumental' | 'lyricsOn'>): boolean {
  return s.lyricsOn && !s.instrumental;
}

export const useComposeSession = create<ComposeSession>((set) => ({
  draft: EMPTY_DRAFT,
  step: 'material',
  lyricsOn: false,
  promptOn: false,
  focus: null,
  review: false,
  instrumental: false,
  fromStyle: false,
  seed: randomSeed(),
  planner: 'auto',
  lyricsMode: 'provided',
  lyricsProvider: 'auto',
  patch: (p) =>
    set((s) => {
      // Instrumental stays instrumental whatever a starting point says.
      if (s.instrumental) return { draft: { ...s.draft, ...p, vocal: 'none' } };
      const draft = withSinger(s.draft, { ...s.draft, ...p }, p);
      if (draft.vocal !== 'none') return { draft };
      // Lyrics of any kind (yours, written for you, placeholders) keep a singer…
      if (s.lyricsOn) return { draft: { ...draft, vocal: 'auto', vocalMode: 'default' } };
      // …otherwise an instrumental starting point makes the song instrumental.
      return { draft, instrumental: true };
    }),
  start: (focus) =>
    set((s) => ({
      step: 'material',
      focus,
      fromStyle: false,
      instrumental: focus === 'lyrics' ? false : s.instrumental,
      lyricsOn: s.lyricsOn || focus === 'lyrics',
      promptOn: s.promptOn || focus === 'prompt',
    })),
  startFromStyle: () => set({ step: 'shape', focus: null, fromStyle: true }),
  setInstrumental: (on) =>
    set((s) => ({
      instrumental: on,
      draft: on
        ? { ...s.draft, vocal: 'none' }
        : s.draft.vocal === 'none'
          ? { ...s.draft, vocal: 'auto', vocalMode: 'default' }
          : s.draft,
    })),
  set: (p) => set(p),
  reset: () =>
    set({
      draft: EMPTY_DRAFT,
      step: 'material',
      lyricsOn: false,
      promptOn: false,
      focus: null,
      instrumental: false,
      fromStyle: false,
    }),
}));

/**
 * Lyrics need a singer: pasting lyrics, or applying a starting point (a whole sound, which may be
 * instrumental) while lyrics are present, turns an instrumental setting back to an automatic vocal.
 * Choosing "Instrumental" on its own is respected.
 */
export function withSinger(prev: ComposeDraft, next: ComposeDraft, p: Partial<ComposeDraft>): ComposeDraft {
  if (!next.lyricsText.trim() || next.vocal !== 'none') return next;
  const lyricsAdded = !prev.lyricsText.trim();
  const soundOverLyrics = 'genres' in p && 'vocal' in p;
  return lyricsAdded || soundOverLyrics ? { ...next, vocal: 'auto', vocalMode: 'default' } : next;
}

/** Parsed lyrics with the user's section-kind overrides applied (undefined when there are none). */
export function draftLyrics(
  d: Pick<ComposeDraft, 'lyricsText' | 'lyricKinds' | 'lockLyrics'>,
): BlueprintLyrics | undefined {
  if (!d.lyricsText.trim()) return undefined;
  const parsed = parseLyricSheet(d.lyricsText);
  if (!parsed.sections.some((s) => s.lines.length)) return undefined;
  const sections = parsed.sections.map((s, i) => {
    const kind = d.lyricKinds[i];
    return kind && kind !== s.kind ? { ...s, kind } : s;
  });
  return { ...parsed, sections, ...(d.lockLyrics ? {} : { lock: false }) };
}

/** The builder draft as core builder choices. */
export function choicesFromDraft(d: ComposeDraft, lyrics = draftLyrics(d)): BuilderChoices {
  const c: BuilderChoices = {
    instruments: d.instruments.filter((i) => i.count > 0),
    genres: d.genres.filter((g) => g.weight > 0),
    moods: d.moods,
    tags: d.tags,
  };
  if (d.tempo === 'bpm') c.tempo = d.bpm;
  else if (d.tempo !== 'auto') c.tempo = d.tempo;
  if (d.tonic !== 'auto' || d.mode !== 'auto')
    c.key = {
      ...(d.tonic !== 'auto' ? { tonic: d.tonic } : {}),
      ...(d.mode !== 'auto' ? { mode: d.mode } : {}),
    };
  if (d.meter !== 'auto') {
    const [n, den] = d.meter.split('/').map(Number);
    if (n > 0 && den > 0) c.meter = { numerator: n, denominator: den };
  }
  if (d.length === 'minutes') c.length = { minutes: d.minutes };
  else if (d.length !== 'standard') c.length = d.length;
  if (d.structure) c.structure = d.structure;
  const mode: VocalMode = d.vocalMode === 'default' ? (lyrics ? 'ai-singer' : 'melody-only') : d.vocalMode;
  if (d.vocal === 'none') c.vocal = 'none';
  else if (d.vocal !== 'auto') c.vocal = { voiceType: d.vocal, mode };
  else if (lyrics) c.vocal = { voiceType: 'tenor', mode };
  if (Object.keys(d.macros ?? {}).length) c.macros = { ...d.macros };
  if (d.title.trim()) c.title = d.title.trim();
  if (d.lyricsTheme.trim()) c.lyricsTheme = d.lyricsTheme.trim();
  if (lyrics) c.lyrics = lyrics;
  return c;
}

/** Shared preview/generation choices, including source timing and the selected lyrics workflow. */
export function choicesForStart(draft: ComposeDraft, lyricsMode: LyricsMode, anchor?: Song): BuilderChoices {
  const choices = choicesFromDraft(draft);
  if (lyricsMode !== 'provided') delete choices.lyrics;
  if (lyricsMode === 'instrumental') choices.vocal = 'none';
  else if (lyricsMode === 'placeholder') choices.vocal = { voiceType: 'tenor', mode: 'placeholder' };
  // "With vocals" means a vocal, even for a genre that is usually instrumental.
  else if (!choices.vocal || choices.vocal === 'none')
    choices.vocal = { voiceType: 'tenor', mode: choices.lyrics ? 'ai-singer' : 'melody-only' };
  if (anchor) {
    if (draft.tempo === 'auto') choices.tempo = anchor.tempoMap[0]?.bpm;
    if (draft.tonic === 'auto' && draft.mode === 'auto') choices.key = anchor.keyMap[0]?.key;
    if (draft.meter === 'auto' && anchor.meterMap[0])
      choices.meter = {
        numerator: anchor.meterMap[0].numerator,
        denominator: anchor.meterMap[0].denominator,
      };
  }
  return choices;
}

/** Ready-made starting points: fill the builder in one click (and then adjust). */
export interface Starter {
  id: string;
  label: string;
  draft: Partial<ComposeDraft>;
}

export const STARTERS: Starter[] = [
  {
    id: 'alt-rock',
    label: 'Alt-rock band',
    draft: {
      genres: [{ genreId: 'alternative-rock', weight: 1 }],
      instruments: [
        { instrumentId: 'drum-kit', count: 1 },
        { instrumentId: 'electric-bass', count: 1 },
        { instrumentId: 'electric-guitar-distorted', count: 2 },
        { instrumentId: 'piano', count: 1 },
        { instrumentId: 'violin', count: 1 },
      ],
      moods: [
        { tagId: 'melancholy', section: 'verse' },
        { tagId: 'cathartic', section: 'chorus' },
      ],
      tempo: 'fast',
      vocal: 'tenor',
      vocalMode: 'melody-only',
    },
  },
  {
    id: 'emo-pop-punk',
    label: 'Emo pop-punk',
    draft: {
      genres: [
        { genreId: 'emo', weight: 0.6 },
        { genreId: 'pop-punk', weight: 0.4 },
      ],
      instruments: [
        { instrumentId: 'drum-kit', count: 1 },
        { instrumentId: 'electric-bass', count: 1 },
        { instrumentId: 'electric-guitar-distorted', count: 1 },
        { instrumentId: 'electric-guitar-lead', count: 1 },
        { instrumentId: 'piano', count: 1 },
      ],
      moods: [
        { tagId: 'melancholy', section: 'verse' },
        { tagId: 'cathartic', section: 'chorus' },
      ],
      tempo: 'bpm',
      bpm: 164,
      tonic: 4,
      mode: 'minor',
      vocal: 'tenor',
      vocalMode: 'melody-only',
    },
  },
  {
    id: 'synth-pop',
    label: 'Dreamy synth-pop',
    draft: {
      genres: [{ genreId: 'synth-pop', weight: 1 }],
      instruments: [
        { instrumentId: 'electronic-kit', count: 1 },
        { instrumentId: 'synth-bass', count: 1 },
        { instrumentId: 'synth-pad', count: 1 },
        { instrumentId: 'synth-arp', count: 1 },
      ],
      moods: [{ tagId: 'dreamy' }, { tagId: 'warm' }],
      tempo: 'bpm',
      bpm: 108,
      tonic: 2,
      mode: 'major',
      vocal: 'mezzo',
      vocalMode: 'melody-only',
    },
  },
  {
    id: 'cinematic',
    label: 'Cinematic orchestral',
    draft: {
      genres: [
        { genreId: 'orchestral', weight: 0.6 },
        { genreId: 'cinematic', weight: 0.4 },
      ],
      instruments: [
        { instrumentId: 'string-ensemble', count: 1 },
        { instrumentId: 'brass-section', count: 1 },
        { instrumentId: 'piano', count: 1 },
        { instrumentId: 'timpani', count: 1 },
      ],
      moods: [{ tagId: 'epic' }],
      tempo: 'slow',
      tonic: 0,
      mode: 'minor',
      vocal: 'none',
    },
  },
  {
    id: 'lofi-hiphop',
    label: 'Laid-back hip-hop',
    draft: {
      genres: [{ genreId: 'hip-hop', weight: 1 }],
      instruments: [
        { instrumentId: 'electronic-kit', count: 1 },
        { instrumentId: 'upright-bass', count: 1 },
        { instrumentId: 'piano', count: 1 },
      ],
      tags: ['lo-fi'],
      moods: [{ tagId: 'chill' }],
      tempo: 'bpm',
      bpm: 88,
      vocal: 'none',
    },
  },
  {
    id: 'folk-country',
    label: 'Folk & country',
    draft: {
      genres: [
        { genreId: 'folk', weight: 0.5 },
        { genreId: 'country', weight: 0.3 },
        { genreId: 'indie-rock', weight: 0.2 },
      ],
      instruments: [
        { instrumentId: 'acoustic-guitar', count: 2 },
        { instrumentId: 'upright-bass', count: 1 },
        { instrumentId: 'drum-kit', count: 1 },
        { instrumentId: 'violin', count: 1 },
      ],
      moods: [{ tagId: 'warm' }],
      vocal: 'baritone',
      vocalMode: 'melody-only',
    },
  },
];
