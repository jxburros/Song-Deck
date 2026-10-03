/**
 * "Connect a service": what each discovered model can do in Song Deck, grouped by app use, and
 * which models to tick by default (the best one per use — not every model the account can see).
 *
 * Uses are defined over the capability taxonomy and the task roles (roles.ts), so a model is only
 * shown where the router would actually route that role to it.
 */
import { type Capability, hasCapabilities } from './capabilities';
import { ROLE_INFO } from './roles';
import type { ModelInfo, TaskRole } from './types';

/**
 * Capability sets that can serve a role, in order of preference (default: the role's own
 * requirements). Production can generate from text, or perform the composition (MIDI or stem
 * conditioning, audio to audio).
 */
export const ROLE_CAPABILITY_ALTERNATIVES: Partial<Record<TaskRole, Capability[][]>> = {
  production: [['TEXT_TO_MUSIC'], ['MIDI_CONDITIONING'], ['STEM_CONDITIONING'], ['AUDIO_TO_AUDIO']],
};

export function roleCapabilitySets(role: TaskRole): Capability[][] {
  return ROLE_CAPABILITY_ALTERNATIVES[role] ?? [ROLE_INFO[role].capabilities];
}

export type AppUseId =
  | 'composition'
  | 'lyrics'
  | 'midi-editing'
  | 'theory'
  | 'mixing'
  | 'audio-understanding'
  | 'music'
  | 'singing'
  | 'voice-conversion'
  | 'transcription'
  | 'separation'
  | 'mastering';

export type ModelGroupId = 'writing' | 'music' | 'vocals' | 'analysis' | 'mastering';

export interface AppUse {
  id: AppUseId;
  label: string;
  /** Roles this use stands for (empty = a capability other features ask for, e.g. audio understanding). */
  roles: TaskRole[];
  /** A model serves the use when it has every capability of ANY of these sets. */
  capabilitySets: Capability[][];
  group: ModelGroupId;
}

export const APP_USES: AppUse[] = [
  {
    id: 'composition',
    label: 'Composition planning',
    roles: ['composition', 'harmony'],
    capabilitySets: [['TEXT_REASONING', 'MUSIC_THEORY_REASONING']],
    group: 'writing',
  },
  {
    id: 'lyrics',
    label: 'Lyrics',
    roles: ['lyrics'],
    capabilitySets: roleCapabilitySets('lyrics'),
    group: 'writing',
  },
  {
    id: 'midi-editing',
    label: 'MIDI edits in plain words',
    roles: ['midi-editing'],
    capabilitySets: roleCapabilitySets('midi-editing'),
    group: 'writing',
  },
  {
    id: 'theory',
    label: 'Theory Q&A & assistant',
    roles: ['analysis', 'chat'],
    capabilitySets: [['TEXT_REASONING', 'MUSIC_THEORY_REASONING']],
    group: 'writing',
  },
  {
    id: 'mixing',
    label: 'Mix assistant',
    roles: ['mixing'],
    capabilitySets: [['TEXT_REASONING', 'MIXING']],
    group: 'writing',
  },
  {
    id: 'audio-understanding',
    label: 'Listens to audio',
    roles: [],
    capabilitySets: [['AUDIO_UNDERSTANDING']],
    group: 'writing',
  },
  {
    id: 'music',
    label: 'Music generation',
    roles: ['production'],
    capabilitySets: roleCapabilitySets('production'),
    group: 'music',
  },
  {
    id: 'singing',
    label: 'Singing',
    roles: ['vocals'],
    capabilitySets: roleCapabilitySets('vocals'),
    group: 'vocals',
  },
  {
    id: 'voice-conversion',
    label: 'Voice conversion',
    roles: ['voice-conversion'],
    capabilitySets: roleCapabilitySets('voice-conversion'),
    group: 'vocals',
  },
  {
    id: 'transcription',
    label: 'Transcription',
    roles: ['transcription'],
    capabilitySets: roleCapabilitySets('transcription'),
    group: 'analysis',
  },
  {
    id: 'separation',
    label: 'Stem separation',
    roles: ['separation'],
    capabilitySets: roleCapabilitySets('separation'),
    group: 'analysis',
  },
  {
    id: 'mastering',
    label: 'Mastering',
    roles: ['mastering'],
    capabilitySets: roleCapabilitySets('mastering'),
    group: 'mastering',
  },
];

export const MODEL_GROUPS: { id: ModelGroupId; label: string; description: string }[] = [
  {
    id: 'writing',
    label: 'Writing, arranging & theory',
    description: 'Plans songs, writes lyrics, edits MIDI from plain words, answers theory questions.',
  },
  { id: 'music', label: 'Music generation', description: 'Produces audio from the composition or a prompt.' },
  { id: 'vocals', label: 'Singing & voices', description: 'Sings lyrics on a melody or converts a vocal.' },
  { id: 'analysis', label: 'Transcription & separation', description: 'Turns audio into notes or stems.' },
  { id: 'mastering', label: 'Mastering', description: 'Finishes a mix to a loudness target.' },
];

/** Every app use a model can serve. */
export function modelUses(model: Pick<ModelInfo, 'capabilities'>): AppUseId[] {
  return APP_USES.filter((u) => u.capabilitySets.some((set) => hasCapabilities(model.capabilities, set))).map(
    (u) => u.id,
  );
}

/** Pre-release / pinned snapshots rank below the stable alias of the same tier. */
const UNSTABLE =
  /(preview|experimental|-exp\b|-exp-|beta|alpha|-latest\b|-\d{4}-\d{2}-\d{2}\b|-\d{8}\b|-\d{4}\b|-\d{2}-\d{2}\b)/i;

/** Leading version number in an id ("gpt-5" → 5, "gemini-2.5-pro" → 2.5, "claude-opus-5-5" → 5.5). */
export function modelVersion(id: string): number {
  const m = /(\d+(?:[.-]\d)?)/.exec(id.replace(/^[a-z]+\//i, ''));
  return m ? Number(m[1].replace('-', '.')) : 0;
}

/** Ordering for "best model": quality tier, then stable over preview, newer version, shorter id. */
export function compareModelsForRecommendation(a: ModelInfo, b: ModelInfo): number {
  return (
    (b.qualityTier ?? 3) - (a.qualityTier ?? 3) ||
    Number(UNSTABLE.test(a.id)) - Number(UNSTABLE.test(b.id)) ||
    modelVersion(b.id) - modelVersion(a.id) ||
    a.id.length - b.id.length ||
    a.id.localeCompare(b.id)
  );
}

export interface ModelGroup {
  id: ModelGroupId;
  label: string;
  description: string;
  models: { model: ModelInfo; uses: AppUseId[] }[];
}

export interface GroupedModels {
  groups: ModelGroup[];
  /** Models Song Deck cannot use (embeddings, image, speech… — shown behind "show all"). */
  unusable: ModelInfo[];
}

/** Group models by their primary app use (each model appears once, best models first). */
export function groupModels(models: ModelInfo[]): GroupedModels {
  const groups = MODEL_GROUPS.map((g) => ({ ...g, models: [] as ModelGroup['models'] }));
  const unusable: ModelInfo[] = [];
  for (const model of [...models].sort(compareModelsForRecommendation)) {
    const uses = modelUses(model);
    if (!uses.length) {
      unusable.push(model);
      continue;
    }
    const primary = APP_USES.find((u) => u.id === uses[0])!.group;
    groups.find((g) => g.id === primary)!.models.push({ model, uses });
  }
  return { groups: groups.filter((g) => g.models.length), unusable };
}

export interface Recommendation {
  /** Model ids to tick by default. */
  selected: string[];
  /** Best model per use. */
  byUse: Partial<Record<AppUseId, string>>;
  /** Suggested provider default model (the best writing model, else the first pick). */
  defaultModel?: string;
}

/** The best model for each use; a use already covered by an earlier pick adds no extra model. */
export function recommendModels(models: ModelInfo[]): Recommendation {
  const ranked = [...models].sort(compareModelsForRecommendation);
  const byUse: Recommendation['byUse'] = {};
  const selected: string[] = [];
  for (const use of APP_USES) {
    const best = ranked.find((m) => modelUses(m).includes(use.id));
    if (!best) continue;
    byUse[use.id] = best.id;
    // A pick that already serves this use at the same tier is enough.
    const covered = selected.some((id) => {
      const m = ranked.find((x) => x.id === id)!;
      return modelUses(m).includes(use.id) && (m.qualityTier ?? 3) >= (best.qualityTier ?? 3);
    });
    if (!covered) selected.push(best.id);
  }
  const defaultModel = byUse.composition ?? selected[0];
  return { selected, byUse, ...(defaultModel ? { defaultModel } : {}) };
}
