import { randomId, type Song } from '@songdeck/core';
import type { CapabilityRouter, ProviderRegistry, DataKind } from '@songdeck/ai';
import { useStudio } from '../state/store';
import { useSettings } from '../state/settings';
import { getRegistry, getRouter } from './ai';
import {
  headRevisionOf,
  nextLabels,
  opDataKinds,
  planStrategy,
  hasSungVocals,
  productionSourceSong,
} from './produce-model';
import { startTask } from './mix-tasks';
import type { CandidateInput, CandidateOutput } from './handlers/production';

export interface PrototypeTarget {
  value: string;
  label: string;
  providerId: string;
  modelId?: string;
  score: number;
  guided: boolean;
}

/** Connected audio models only; text models and the built-in preview renderer are not prototypes. */
export function prototypeTargets(
  registry: ProviderRegistry = getRegistry(),
  router: CapabilityRouter = getRouter(),
  song?: Song,
): PrototypeTarget[] {
  const targets: PrototypeTarget[] = [];
  for (const provider of registry.list()) {
    if (
      provider.location === 'internal' ||
      provider.status !== 'ready' ||
      !provider.interfaces.includes('audioGeneration')
    )
      continue;
    const models = provider.models.length ? provider.models : [{ id: provider.config?.defaultModel }];
    for (const model of models) {
      const plan = planStrategy('full', registry.capabilitiesOf(provider.id, model.id), {
        vocals: song ? hasSungVocals(productionSourceSong(song)) : false,
        reference: false,
        aiUnits: 0,
        aiVocalUnits: 0,
        hasInpaint: false,
      });
      if (!plan.ok || !plan.plan) continue;
      try {
        const decision = router.select({
          role: 'production',
          providerId: provider.id,
          modelId: model.id,
          capabilities: plan.plan.caps,
          dataKinds: opDataKinds(plan.plan, 'mix'),
          neverUpload: useStudio.getState().project?.meta.settings.neverUpload as DataKind[] | undefined,
        });
        targets.push({
          value: JSON.stringify([provider.id, model.id ?? null]),
          label: `${provider.name}${model.id ? ` · ${model.id}` : ''}`,
          providerId: provider.id,
          modelId: model.id,
          score: decision.score,
          guided: plan.plan.op !== 'generate-text',
        });
      } catch {
        /* Offline, privacy rules, and incompatible models are not offered. */
      }
    }
  }
  return targets.sort(
    (a, b) => Number(b.guided) - Number(a.guided) || b.score - a.score || a.label.localeCompare(b.label),
  );
}

/** Save the composition first, then queue one production with automatic adoption on success. */
export function queuePrototype(projectId: string, target: string, seed: number): string {
  const st = useStudio.getState();
  const project = st.project;
  if (!project || project.meta.id !== projectId)
    throw new Error('The active project changed. Your MIDI has been saved.');
  const targets = prototypeTargets(getRegistry(), getRouter(), project.song);
  const selected = target === 'auto' ? targets[0] : targets.find((t) => t.value === target);
  if (!selected)
    throw new Error(
      'No compatible connected audio model is available. Your MIDI is saved; connect an audio model and produce it when ready.',
    );
  const production = {
    ...project.song.production,
    strategy: 'full' as const,
    providerId: selected.providerId,
    modelId: selected.modelId,
  };
  st.commit({ ...project.song, production }, 'Set up quick audio prototype', 'production');
  const current = useStudio.getState().project!;
  const prefs = useSettings.getState().exportPrefs;
  return startTask<CandidateInput, CandidateOutput>(
    'produce.candidate',
    `Audio version — ${selected.label}`,
    {
      projectId,
      sourceRevisionId: headRevisionOf(current)?.id,
      batchId: randomId('prototype'),
      label: nextLabels(production.candidates, 1)[0],
      seed,
      strategy: 'full',
      providerChoice: selected.providerId,
      modelId: selected.modelId,
      prompt: production.prompt,
      negativePrompt: production.negativePrompt,
      sectionPrompts: production.sectionPrompts,
      trackMethods: {},
      strength: 0.5,
      variation: 0.2,
      levelMatch: true,
      allowReferenceUpload: false,
      sampleRate: prefs.sampleRate,
      bitDepth: prefs.bitDepth,
      autoAdopt: true,
    },
    { providerId: selected.providerId },
  ).id;
}
