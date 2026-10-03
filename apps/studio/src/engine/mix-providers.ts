import type { MasteringSettings, MasteringTarget } from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import type { ProviderLocation, RunProvenance } from '@songdeck/ai';
import { decodeAudioBytes } from '../state/assets';
import { aiAudio, getRegistry, initAi } from './ai';

/**
 * External mastering providers (spec §42 "local AI / cloud / external provider", §58
 * MasteringProvider). Candidates come from the AI runtime's registry (configured providers and
 * plugins); calls go through the orchestrator, which shows the data-flow confirmation (§50),
 * applies budgets (§60) and returns provenance (§64). When nothing fits, callers fall back to
 * built-in DSP mastering and record why.
 */

type Method = MasteringSettings['method'];

export interface MasteringCandidate {
  id: string;
  name: string;
  location: ProviderLocation;
  ready: boolean;
}

export interface ExternalMasteringProvider {
  id: string;
  name: string;
  cloud: boolean;
  master(req: { wav: Uint8Array; sampleRate: number; durationSeconds: number; target: MasteringTarget; signal?: AbortSignal }): Promise<{
    audio: AudioData;
    report?: Record<string, unknown>;
    model?: string;
    provenance: RunProvenance;
  }>;
}

const METHOD_WORDS: Record<Method, string> = {
  builtin: 'built-in',
  'local-ai': 'local AI mastering',
  cloud: 'cloud mastering',
  external: 'external mastering',
  none: 'no mastering',
};

function locationsFor(method: Method): ProviderLocation[] {
  if (method === 'local-ai') return ['local'];
  if (method === 'cloud') return ['cloud'];
  return ['local', 'cloud'];
}

/** Non-internal providers implementing MasteringProvider that fit a mastering method. */
export function masteringCandidates(method: Method): MasteringCandidate[] {
  try {
    initAi();
    return getRegistry()
      .findCompatible(['MASTERING'], { interface: 'mastering', includeUnavailable: true, locations: locationsFor(method) })
      .filter((c) => c.location !== 'internal')
      .map((c) => ({ id: c.providerId, name: c.providerName, location: c.location, ready: c.status === 'ready' }));
  } catch {
    return [];
  }
}

/** Pick the provider for a mastering method (or explain why there is none). */
export async function resolveExternalMastering(method: Method, choice?: string): Promise<{ provider?: ExternalMasteringProvider; reason: string }> {
  if (choice === 'internal') return { reason: 'The on-device engine was chosen as the mastering provider.' };
  const all = masteringCandidates(method);
  const ready = all.filter((c) => c.ready);
  let pick = choice && choice !== 'auto' ? ready.find((c) => c.id === choice) : undefined;
  if (choice && choice !== 'auto' && !pick) {
    const named = all.find((c) => c.id === choice);
    if (named) return { reason: `${named.name} is not ready (check its configuration in Settings → Providers).` };
  }
  pick ??= ready[0];
  if (!pick) {
    return {
      reason: all.length
        ? `No ${METHOD_WORDS[method]} provider is ready (${all.map((c) => c.name).join(', ')}).`
        : `No mastering provider is configured for ${METHOD_WORDS[method]}. Add one in Settings → Providers (e.g. a mastering HTTP bridge) or enable a plugin.`,
    };
  }
  const chosen = pick;
  return {
    reason: '',
    provider: {
      id: chosen.id,
      name: chosen.name,
      cloud: chosen.location === 'cloud',
      async master({ wav, sampleRate, durationSeconds, target, signal }) {
        const r = await aiAudio.master(
          { audio: { mimeType: 'audio/wav', data: wav, sampleRate, channels: 2, durationSeconds }, target },
          { providerChoice: chosen.id, signal, quality: 'final' },
        );
        const audio = await decodeAudioBytes(r.result.audio.data);
        return { audio, report: r.result.report, model: r.result.model ?? r.provenance.modelId, provenance: r.provenance };
      },
    },
  };
}
