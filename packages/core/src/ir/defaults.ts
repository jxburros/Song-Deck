import type {
  ChannelStrip,
  CompressorSettings,
  EqSettings,
  HistoryState,
  KeySignature,
  MacroSettings,
  MasterBus,
  MasteringSettings,
  MixerState,
  ProductionSettings,
  Project,
  ProjectMeta,
  RightsMetadata,
  Song,
  VocalSettings,
} from './types';
import { PPQ, SONG_SCHEMA_VERSION } from './types';
import { randomId } from '../util/ids';

/** Version of the deterministic generation engine (spec §23). Bump when generator output changes. */
export const ENGINE_VERSION = '1.1.0';

export const PROJECT_FORMAT_VERSION = 1;

export function defaultMacros(): MacroSettings {
  return {
    complexity: 0.5,
    energy: 0.5,
    density: 0.5,
    humanization: 0.35,
    melodicMovement: 0.5,
    harmonicTension: 0.35,
    repetition: 0.5,
    syncopation: 0.4,
    dynamics: 0.5,
  };
}

export function defaultEq(): EqSettings {
  return {
    enabled: true,
    highpassHz: 0,
    lowShelfHz: 120,
    lowShelfDb: 0,
    lowMidHz: 400,
    lowMidDb: 0,
    lowMidQ: 1,
    highMidHz: 2500,
    highMidDb: 0,
    highMidQ: 1,
    highShelfHz: 8000,
    highShelfDb: 0,
    lowpassHz: 0,
  };
}

export function defaultCompressor(): CompressorSettings {
  return { enabled: false, thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, kneeDb: 6, makeupDb: 0 };
}

export function defaultChannelStrip(overrides: Partial<ChannelStrip> = {}): ChannelStrip {
  return {
    volumeDb: -6,
    pan: 0,
    mute: false,
    solo: false,
    eq: defaultEq(),
    compressor: defaultCompressor(),
    reverbSend: 0.15,
    delaySend: 0,
    width: 1,
    drive: 0,
    ...overrides,
  };
}

export function defaultMasterBus(): MasterBus {
  return {
    volumeDb: 0,
    eq: defaultEq(),
    compressor: {
      enabled: true,
      thresholdDb: -14,
      ratio: 2,
      attackMs: 25,
      releaseMs: 200,
      kneeDb: 6,
      makeupDb: 1,
    },
    limiter: { enabled: true, ceilingDb: -1, releaseMs: 80 },
    width: 1,
  };
}

export function defaultMixer(): MixerState {
  return {
    channels: {},
    master: defaultMasterBus(),
    reverb: { type: 'hall', size: 0.6, decaySeconds: 2.2, damping: 0.45, preDelayMs: 20, returnDb: -4 },
    delay: { timeBeats: 0.75, feedback: 0.3, highCutHz: 6000, lowCutHz: 200, pingPong: true, returnDb: -8 },
  };
}

export function defaultProduction(): ProductionSettings {
  return {
    strategy: 'stems',
    prompt: '',
    negativePrompt: '',
    sectionPrompts: {},
    trackMethods: {},
    candidates: [],
    allowReferenceUpload: false,
    guideStemAssetIds: {},
  };
}

export function defaultVocals(): VocalSettings {
  return {
    mode: 'melody-only',
    language: 'en',
    renders: [],
    takes: [],
    defaultExpression: {
      breathiness: 0.2,
      tension: 0.4,
      vibrato: 0.3,
      vibratoRate: 5.5,
      onset: 'normal',
      release: 'normal',
    },
  };
}

export function defaultMastering(): MasteringSettings {
  return { method: 'builtin', target: 'streaming', tone: 0, width: 1 };
}

export interface EmptySongOptions {
  title?: string;
  bpm?: number;
  meter?: { numerator: number; denominator: number };
  key?: KeySignature;
  seed?: number;
  id?: string;
}

/** A valid, empty song (no sections, no tracks). */
export function createEmptySong(opts: EmptySongOptions = {}): Song {
  return {
    schemaVersion: SONG_SCHEMA_VERSION,
    id: opts.id ?? randomId('song'),
    title: opts.title ?? 'Untitled',
    ppq: PPQ,
    tempoMap: [{ tick: 0, bpm: opts.bpm ?? 120 }],
    meterMap: [{ bar: 0, numerator: opts.meter?.numerator ?? 4, denominator: opts.meter?.denominator ?? 4 }],
    keyMap: [{ bar: 0, key: opts.key ?? { tonic: 0, mode: 'major' } }],
    sections: [],
    chords: [],
    tracks: [],
    motifs: [],
    phrases: [],
    lyrics: [],
    automation: [],
    mixer: defaultMixer(),
    macros: defaultMacros(),
    locks: {},
    genreBlend: [],
    generation: { seed: opts.seed ?? 1, variation: 0.2, engineVersion: ENGINE_VERSION },
    production: defaultProduction(),
    vocals: defaultVocals(),
    mastering: defaultMastering(),
  };
}

export function emptyRights(): RightsMetadata {
  return {
    humanComposers: [],
    lyricWriters: [],
    performers: [],
    aiAssistance: '',
    voiceModels: [],
    modelProviders: [],
    sourceReferences: [],
    samples: [],
    licensedAssets: [],
  };
}

export function createProjectMeta(name: string, id: string = randomId('proj')): ProjectMeta {
  const now = new Date().toISOString();
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    rights: emptyRights(),
    assets: [],
    provenance: [],
    voices: [],
    providersUsed: [],
    customGenres: [],
    customInstruments: [],
    settings: { neverUpload: [] },
  };
}

/** A new project whose history starts with a single "create" revision on branch "Main". */
export function createProject(name: string, song: Song = createEmptySong({ title: name })): Project {
  const meta = createProjectMeta(name);
  const branchId = randomId('br');
  const revId = randomId('rev');
  const now = meta.createdAt;
  const history: HistoryState = {
    revisions: [
      {
        id: revId,
        number: 1,
        parents: [],
        branchId,
        message: 'Project created',
        kind: 'create',
        createdAt: now,
        snapshot: song,
      },
    ],
    branches: [{ id: branchId, name: 'Main', headRevisionId: revId, createdAt: now }],
    currentBranchId: branchId,
  };
  return { meta, song, history, analysis: [], generations: [] };
}
