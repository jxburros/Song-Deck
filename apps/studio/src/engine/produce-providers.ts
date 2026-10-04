import { create } from 'zustand';
import {
  COMPATIBILITY_LABELS,
  LOCAL_MODEL_CATALOG,
  DEFAULT_ROUTING_SETTINGS,
  ProviderError,
  describeDataFlow,
  isProviderError,
  needsPrivacyConfirmation,
  classifyCompatibility,
  estimateCost,
  type Capability,
  type CompatibilityResult,
  type CostEstimate,
  type DataKind,
  type HardwareInfo,
  type LocalModelEntry,
  type OrchestratorResult,
  type PricingInfo,
  type ProviderInstance,
  type ProviderLocation,
} from '@songdeck/ai';
import type { ProductionStrategy } from '@songdeck/core';
import { getOrchestrator, getRegistry, getRouter } from './ai';
import { INTERNAL_FOR_ROLE } from './internalDescriptors';
import { useRuntime } from './runtime';
import { serverBase, useSettings } from '../state/settings';
import { useStudio } from '../state/store';
import { planStrategy, type PlanContext, type StrategyPlan } from './produce-model';
import { dataFlowRightsWarning } from './rights';

/**
 * Production providers (spec §30, §31, §59-§61): which provider a production uses, what it can do
 * for the chosen strategy, what it will cost, what hardware it needs, and the orchestrated call
 * itself (privacy confirmation, budgets, cost recording and provenance stay in the orchestrator).
 */

export interface ResolvedProvider {
  id: string;
  name: string;
  location: ProviderLocation;
  status: string;
  error?: string;
  modelId?: string;
  capabilities: Capability[];
  description?: string;
  presetId?: string;
  pricing?: PricingInfo;
  defaultModel?: string;
  qualityTier?: number;
  /** The adapter implements inpaintAudio(). */
  hasInpaint: boolean;
  internal: boolean;
  models: { id: string; name?: string }[];
  /** Router explanation when chosen automatically. */
  reasons?: string[];
}

export interface ProductionResolution {
  provider?: ResolvedProvider;
  plan: StrategyPlan;
  error?: string;
}

export function providerIdForChoice(choice: string | undefined): string | undefined {
  if (!choice || choice === 'auto') return undefined;
  if (choice === 'internal') return INTERNAL_FOR_ROLE.production;
  return choice;
}

export function describeProvider(id: string, modelId?: string): ResolvedProvider | undefined {
  const reg = getRegistry();
  const entry = reg.getEntry(id);
  if (!entry) return undefined;
  const d = entry.instance.descriptor;
  const model = modelId ?? entry.config?.defaultModel ?? d.defaultModel;
  return {
    id,
    name: d.name,
    location: d.location,
    status: entry.status,
    error: entry.error,
    modelId: model,
    capabilities: reg.capabilitiesOf(id, modelId),
    description: d.description,
    presetId: entry.config?.presetId ?? d.presetId,
    pricing: entry.config?.pricing ?? d.pricing,
    defaultModel: entry.config?.defaultModel ?? d.defaultModel,
    qualityTier: d.qualityTier,
    hasInpaint: typeof entry.instance.audioGeneration?.inpaintAudio === 'function',
    internal: d.location === 'internal',
    models: (entry.models ?? []).map((m) => ({ id: m.id, name: m.name })),
  };
}

/** Capability sets tried (in order) when the router chooses the provider ("Auto"). */
const AUTO_CAP_SETS: Record<ProductionStrategy, Capability[][]> = {
  full: [
    ['AUDIO_TO_AUDIO'],
    ['TEXT_TO_MUSIC', 'STEM_CONDITIONING'],
    ['TEXT_TO_MUSIC'],
    ['MIDI_CONDITIONING'],
  ],
  stems: [['AUDIO_TO_AUDIO'], ['STEM_CONDITIONING'], ['TEXT_TO_MUSIC']],
  hybrid: [['AUDIO_TO_AUDIO'], ['STEM_CONDITIONING'], ['TEXT_TO_MUSIC']],
};

function neverUpload(): DataKind[] {
  return (useStudio.getState().project?.meta.settings.neverUpload ?? []) as DataKind[];
}

/** Resolve the provider for a production and how it would be used for the strategy. */
export function resolveProduction(
  choice: string | undefined,
  modelId: string | undefined,
  strategy: ProductionStrategy,
  ctx: Omit<PlanContext, 'hasInpaint'>,
): ProductionResolution {
  let provider: ResolvedProvider | undefined;
  let error: string | undefined;
  if (!choice || choice === 'auto') {
    for (const caps of AUTO_CAP_SETS[strategy]) {
      try {
        const d = getRouter().select({ role: 'production', capabilities: caps, neverUpload: neverUpload() });
        provider = describeProvider(d.providerId, d.modelId);
        if (provider) {
          provider.reasons = d.reasons;
          break;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (provider) error = undefined;
    else error = error ?? 'No production provider is available';
  } else {
    const id = providerIdForChoice(choice)!;
    provider = describeProvider(id, modelId);
    if (!provider) error = `Provider “${choice}” is not installed`;
    else if (provider.status !== 'ready')
      error = `${provider.name} is ${provider.status}${provider.error ? ` (${provider.error})` : ''}`;
  }
  const plan = planStrategy(strategy, provider?.capabilities ?? [], {
    ...ctx,
    hasInpaint: provider?.hasInpaint ?? false,
  });
  return { provider, plan, error };
}

/** Cost estimate for `generations` audio generations of `durationSeconds` each (spec §60). */
export function productionEstimate(
  provider: ResolvedProvider | undefined,
  durationSeconds: number,
  generations: number,
): CostEstimate {
  if (!provider || generations <= 0)
    return {
      minUsd: 0,
      maxUsd: 0,
      basis: generations <= 0 ? 'the provider is not called' : 'no provider',
      known: true,
      currency: 'USD',
    };
  return estimateCost(
    {
      location: provider.location,
      pricing: provider.pricing,
      defaultModel: provider.defaultModel,
      name: provider.name,
    },
    { kind: 'audio', durationSeconds, generations },
    provider.modelId,
  );
}

// ---------------------------------------------------------------------------
// Orchestrated calls
// ---------------------------------------------------------------------------

/** Data flows the user already confirmed for a production batch (provider + data kinds). */
const consented = new Set<string>();

export interface ProductionRunOptions<T> {
  choice: string;
  modelId?: string;
  caps: Capability[];
  dataKinds: DataKind[];
  durationSeconds: number;
  title: string;
  signal: AbortSignal;
  /**
   * A production batch id: the first generation of a batch shows the orchestrator's data-flow /
   * cost confirmation; later generations of the same batch to the same provider with the same
   * data reuse that consent (one dialog per batch instead of one per stem).
   */
  consentKey?: string;
  execute: (instance: ProviderInstance, modelId: string | undefined, signal: AbortSignal) => Promise<T>;
}

export async function runProduction<T>(o: ProductionRunOptions<T>): Promise<OrchestratorResult<T>> {
  const never = neverUpload();
  let predicted = providerIdForChoice(o.choice);
  if (!predicted) {
    try {
      predicted = getRouter().select({
        role: 'production',
        capabilities: o.caps,
        dataKinds: o.dataKinds,
        neverUpload: never,
      }).providerId;
    } catch {
      predicted = undefined;
    }
  }
  const kinds = [...o.dataKinds].sort().join(',');
  const key = o.consentKey && predicted ? `${o.consentKey}|${predicted}|${kinds}` : undefined;
  const attempt = async (): Promise<OrchestratorResult<T>> => {
    const skip = !!key && consented.has(key);
    let res: OrchestratorResult<T>;
    try {
      res = await runOrchestrated(o, never, skip ? predicted : providerIdForChoice(o.choice), skip);
    } catch (err) {
      throw friendlyError(err, predicted);
    }
    if (o.consentKey) consented.add(`${o.consentKey}|${res.provenance.providerId}|${kinds}`);
    return res;
  };
  // Only one confirmation dialog can be pending: generations that will ask (cloud data flows not
  // yet confirmed for this batch) take turns; once one is confirmed, the others reuse the consent.
  if (key && !consented.has(key) && confirmationNeeded(predicted, o.dataKinds)) return exclusive(attempt);
  if (!key && confirmationNeeded(predicted, o.dataKinds)) return exclusive(attempt);
  return attempt();
}

let gate: Promise<void> = Promise.resolve();

/** Run `fn` after every earlier exclusive run has finished. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = gate;
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Whether the orchestrator will show the data-flow confirmation for this provider and data. */
function confirmationNeeded(
  providerId: string | undefined,
  dataKinds: DataKind[],
  role: 'production' | 'vocals' = 'production',
): boolean {
  const d = providerId ? describeProvider(providerId) : undefined;
  if (!d) return false;
  const mode = useSettings.getState().routing?.privacyConfirm ?? DEFAULT_ROUTING_SETTINGS.privacyConfirm;
  const flow = describeDataFlow(
    { dataKinds, role },
    { providerId: d.id, providerName: d.name, location: d.location },
  );
  return (
    needsPrivacyConfirmation(mode, flow, useSettings.getState().routing.trustedProviderIds) ||
    !!dataFlowRightsWarning(useStudio.getState().project, flow)
  );
}

/**
 * Singing synthesis for hybrid vocals goes through `aiAudio.synthesizeSinging` (role "vocals");
 * runs that will ask for confirmation take turns so concurrent candidates never open two dialogs.
 */
export function singingTurn<T>(choice: string | undefined, fn: () => Promise<T>): Promise<T> {
  let id: string | undefined =
    !choice || choice === 'auto' ? undefined : choice === 'internal' ? INTERNAL_FOR_ROLE.vocals : choice;
  if (!id) {
    try {
      id = getRouter().select({ role: 'vocals', neverUpload: neverUpload() }).providerId;
    } catch {
      id = undefined;
    }
  }
  return confirmationNeeded(id, ['midi', 'lyrics'], 'vocals') ? exclusive(fn) : fn();
}

function runOrchestrated<T>(
  o: ProductionRunOptions<T>,
  never: DataKind[],
  providerId: string | undefined,
  skip: boolean,
): Promise<OrchestratorResult<T>> {
  return getOrchestrator().run<T>({
    role: 'production',
    // A reused consent pins the provider it was given for (no silent fallback elsewhere).
    providerId,
    modelId: o.choice === 'auto' ? undefined : o.modelId,
    capabilities: o.caps,
    dataKinds: o.dataKinds,
    estimateInput: { kind: 'audio', durationSeconds: Math.max(1, o.durationSeconds) },
    neverUpload: never,
    title: o.title,
    skipConfirm: skip,
    signal: o.signal,
    execute: (inst, model, signal) => o.execute(inst, model, signal),
  });
}

/** Provider failures in words a musician can act on (the task log keeps the original message). */
function friendlyError(err: unknown, predicted: string | undefined): unknown {
  if (!isProviderError(err)) return err;
  const id = err.providerId ?? predicted ?? '';
  const entry = id ? getRegistry().getEntry(id) : undefined;
  const name = entry?.instance.descriptor.name ?? (id || 'The provider');
  const local = entry?.instance.descriptor.location === 'local';
  const at = local && entry?.config?.baseUrl ? ` at ${entry.config.baseUrl}` : '';
  let message: string | undefined;
  if (err.kind === 'network')
    message = `${name} is not reachable${at} (${err.message}). ${local ? 'Start the local model / bridge, then retry.' : 'Check your connection, then retry.'}`;
  else if (err.kind === 'auth')
    message = `${name} rejected the request (${err.message}). Check its API key in Settings → Providers.`;
  else if (err.kind === 'rate-limit')
    message = `${name} is rate-limiting requests (${err.message}). Retry in a moment.`;
  else if (err.kind === 'unavailable')
    message = `${name} is unavailable right now (${err.message}). Retry later or choose another provider.`;
  if (!message) return err;
  return new ProviderError(err.kind, message, { providerId: err.providerId, status: err.status, cause: err });
}

// ---------------------------------------------------------------------------
// Hardware awareness (spec §31, §61) — degrades gracefully without the local server
// ---------------------------------------------------------------------------

export interface ServerModelEntry {
  id: string;
  name: string;
  category: string;
  provider?: string;
  version?: string;
  sizeGb?: number;
  license?: string;
  requirements?: {
    minVramGb?: number;
    recommendedVramGb?: number;
    minRamGb?: number;
    cpuOk?: boolean;
    minCpuCores?: number;
  };
  capabilities?: string[];
  installed?: boolean;
  compatibility?: CompatibilityResult;
  presetId?: string;
}

export type ServerHardware = HardwareInfo & {
  freeRamGb?: number;
  platform?: string;
  os?: string;
  detectedAt?: string;
};

interface HardwareState {
  status: 'idle' | 'loading' | 'ok' | 'offline' | 'error';
  hardware?: ServerHardware;
  models?: ServerModelEntry[];
  error?: string;
  fetchedAt?: number;
}

export const useHardware = create<HardwareState>(() => ({ status: 'idle' }));

async function fetchJson<T>(url: string, ms = 5000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch GET /api/hardware and /api/models from the local server (cached for a minute). */
export async function refreshHardware(force = false): Promise<void> {
  const st = useHardware.getState();
  if (st.status === 'loading') return;
  if (!force && st.fetchedAt && Date.now() - st.fetchedAt < 60_000 && st.status !== 'idle') return;
  if (useRuntime.getState().server.status !== 'online') {
    useHardware.setState({ status: 'offline', fetchedAt: Date.now(), error: undefined });
    return;
  }
  useHardware.setState({ status: 'loading' });
  try {
    const base = serverBase();
    const [hardware, report] = await Promise.all([
      fetchJson<ServerHardware>(`${base}/api/hardware`),
      fetchJson<{ categories?: { models?: ServerModelEntry[] }[] }>(`${base}/api/models`).catch(
        () => undefined,
      ),
    ]);
    const models = report?.categories?.flatMap((c) => c.models ?? []) ?? [];
    useHardware.setState({ status: 'ok', hardware, models, fetchedAt: Date.now(), error: undefined });
  } catch (err) {
    useHardware.setState({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      fetchedAt: Date.now(),
    });
  }
}

export function catalogEntryFor(
  provider: Pick<ResolvedProvider, 'presetId' | 'name'>,
): LocalModelEntry | undefined {
  const audio = LOCAL_MODEL_CATALOG.filter((m) => m.category === 'audio');
  return (
    audio.find((m) => provider.presetId && m.presetId === provider.presetId) ??
    audio.find((m) => provider.name.toLowerCase().includes(m.name.split(' ')[0].toLowerCase()))
  );
}

export interface HardwareLine {
  label: string;
  value: string;
}

export interface HardwareView {
  kind: 'internal' | 'local' | 'cloud';
  title: string;
  lines: HardwareLine[];
  rating?: CompatibilityResult['rating'];
  ratingLabel?: string;
  reasons: string[];
  note?: string;
}

const supported = (caps: Capability[], ...any: Capability[]) =>
  any.some((c) => caps.includes(c)) ? 'Supported' : 'Not supported';

/** The "hardware requirements before generation" panel (spec §31 example, §61 classification). */
export function hardwareView(provider: ResolvedProvider, hw: HardwareState): HardwareView {
  const caps = provider.capabilities;
  const common: HardwareLine[] = [
    {
      label: 'Generation type',
      value:
        caps.includes('TEXT_TO_MUSIC') || caps.includes('AUDIO_TO_AUDIO')
          ? 'Music'
          : caps.includes('STEM_GENERATION')
            ? 'Stems (DSP production)'
            : 'Music',
    },
    {
      label: 'Audio conditioning',
      value: supported(caps, 'AUDIO_TO_AUDIO', 'STEM_CONDITIONING', 'REFERENCE_AUDIO', 'MIDI_CONDITIONING'),
    },
    { label: 'Lyrics', value: supported(caps, 'LYRIC_CONDITIONING') },
  ];
  if (provider.location === 'internal') {
    const threads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 0 : 0;
    return {
      kind: 'internal',
      title: `${provider.name} · On-device`,
      lines: [
        { label: 'Runs on', value: 'This browser (Web Workers, CPU)' },
        { label: 'VRAM requirement', value: 'None — no GPU needed' },
        { label: 'CPU', value: threads ? `${threads} threads available` : 'any' },
        ...common,
      ],
      rating: 'excellent',
      ratingLabel: COMPATIBILITY_LABELS.excellent,
      reasons: ['Deterministic DSP; works offline'],
    };
  }
  if (provider.location === 'cloud') {
    return {
      kind: 'cloud',
      title: `${provider.name} · Cloud`,
      lines: [
        { label: 'Runs on', value: `${provider.name} servers` },
        { label: 'Local hardware', value: 'Not needed' },
        ...common,
      ],
      reasons: [],
      note: 'Song data (and audio, when the strategy sends it) leaves this device — you confirm the data flow before anything is sent.',
    };
  }
  const entry = catalogEntryFor(provider);
  const server = hw.models?.find(
    (m) =>
      (provider.presetId && m.presetId === provider.presetId && m.category === 'audio') ||
      (entry && m.id === entry.id),
  );
  const req = server?.requirements ?? entry?.requirements;
  const lines: HardwareLine[] = [{ label: 'Runs on', value: 'This machine (local model)' }];
  if (req) {
    const vram = req.minVramGb
      ? `~${req.minVramGb} GB+${req.recommendedVramGb && req.recommendedVramGb > req.minVramGb ? ` (${req.recommendedVramGb} GB recommended)` : ''}`
      : req.cpuOk
        ? 'None (CPU)'
        : 'unknown';
    lines.push({ label: 'VRAM requirement', value: vram });
    if (req.minRamGb) lines.push({ label: 'RAM requirement', value: `${req.minRamGb} GB` });
  } else lines.push({ label: 'VRAM requirement', value: 'Not published for this model' });
  if (entry?.sizeGb) lines.push({ label: 'Model size', value: `${entry.sizeGb} GB` });
  lines.push(...common);
  let compat: CompatibilityResult | undefined = server?.compatibility;
  if (!compat && entry && hw.hardware) {
    try {
      compat = classifyCompatibility(entry, hw.hardware);
    } catch {
      compat = undefined;
    }
  }
  const view: HardwareView = {
    kind: 'local',
    title: `${entry?.name ?? provider.name} · Local`,
    lines,
    reasons: compat?.reasons ?? [],
  };
  if (compat) {
    view.rating = compat.rating;
    view.ratingLabel = COMPATIBILITY_LABELS[compat.rating];
    if (compat.suggestedQuantization)
      view.reasons = [...view.reasons, `Suggested quantization: ${compat.suggestedQuantization}`];
  }
  if (server?.installed === false) view.note = 'The Model Manager does not see this model installed yet.';
  if (hw.status === 'offline')
    view.note = 'Hardware unknown — start the Song Deck server (apps/server) to detect GPU, VRAM and RAM.';
  else if (hw.status === 'error') view.note = `Hardware detection failed: ${hw.error ?? 'unknown error'}`;
  else if (hw.status === 'loading' || hw.status === 'idle') view.note = 'Detecting hardware…';
  return view;
}
