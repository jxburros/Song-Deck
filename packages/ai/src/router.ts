/**
 * Capability router (spec §49 model routing, §6 profiles, §51 offline mode, §50 privacy).
 *
 * Modes:
 *  - manual    — the profile's assignment for the role is used (falls back to the internal engine
 *                when the assigned provider is not installed, unless fallbackToInternal = false)
 *  - automatic — compatible providers are scored by quality / cost / latency priorities
 *                (the profile, when set, is a strong hint)
 *  - rules     — automatic + routing rules (prefer-local, prefer-provider, cloud-only-for-final,
 *                never-upload, max-cost, fallback-if-low-confidence)
 * In every mode: offline ⇒ only local/internal providers; "never upload X" ⇒ cloud providers are
 * excluded when the request contains X; providers must have ALL required capabilities.
 */
import { type Capability, capabilityLabel, missingCapabilities } from './capabilities';
import { type CostEstimate, type CostEstimateInput, estimateCost, formatCostRange } from './cost';
import { type ExcludedCandidate, NoCompatibleProviderError } from './errors';
import { DATA_KIND_INFO, type PrivacyConfirmMode } from './privacy';
import { describeAssignment, getProfile, type ProviderProfile, type RoleAssignment } from './profiles';
import type { ProviderRegistry, RegistryEntry } from './registry';
import { ROLE_INFO } from './roles';
import type { DataKind, ProviderInterfaceName, ProviderLocation, QualityLevel, TaskRole } from './types';

export type RoutingMode = 'manual' | 'automatic' | 'rules';

export type RoutingRule =
  | { kind: 'prefer-local'; enabled?: boolean }
  | {
      kind: 'fallback-if-low-confidence';
      threshold: number;
      fallbackProviderId: string;
      fallbackModelId?: string;
      roles?: TaskRole[];
      enabled?: boolean;
    }
  | { kind: 'cloud-only-for-final'; roles: TaskRole[]; enabled?: boolean }
  | { kind: 'never-upload'; dataKinds: DataKind[]; enabled?: boolean }
  | { kind: 'prefer-provider'; role: TaskRole; providerId: string; modelId?: string; enabled?: boolean }
  | { kind: 'max-cost'; usd: number; roles?: TaskRole[]; enabled?: boolean };

export interface RoutingSettings {
  mode: RoutingMode;
  profileId?: string;
  rules: RoutingRule[];
  /** Offline mode (spec §51): cloud providers are unavailable. */
  offline: boolean;
  /** Data kinds that must never be sent to cloud providers. */
  neverUpload: DataKind[];
  /** Relative weights for automatic routing. */
  priorities: { quality: number; cost: number; latency: number };
  privacyConfirm: PrivacyConfirmMode;
  /** Connected providers allowed to run without routine cloud confirmation. Always-ask still wins. */
  trustedProviderIds?: string[];
  /** When an assigned provider is unavailable, use the internal engine if it can do the task (default true). */
  fallbackToInternal?: boolean;
}

export const DEFAULT_ROUTING_SETTINGS: RoutingSettings = {
  mode: 'automatic',
  rules: [],
  offline: false,
  neverUpload: [],
  priorities: { quality: 0.5, cost: 0.3, latency: 0.2 },
  privacyConfirm: 'cloud',
  fallbackToInternal: true,
};

export interface RouteRequest {
  role: TaskRole;
  /** Required capabilities (default: the role's). */
  capabilities?: Capability[];
  /** Data contained in the request (default: the role's). */
  dataKinds?: DataKind[];
  quality?: QualityLevel;
  estimateInput?: CostEstimateInput;
  /** Provider interface needed (default: the role's). */
  interface?: ProviderInterfaceName;
  /** Force a provider (and model) for this request. */
  providerId?: string;
  modelId?: string;
  excludeProviderIds?: string[];
  /** Extra never-upload kinds (e.g. project settings). */
  neverUpload?: DataKind[];
  /** Per-request routing overrides. */
  settings?: Partial<RoutingSettings>;
}

export interface RouteCandidate {
  providerId: string;
  providerName: string;
  modelId?: string;
  location: ProviderLocation;
  score: number;
  reasons: string[];
  estimate: CostEstimate;
}

export interface RouteDecision {
  role: TaskRole;
  mode: RoutingMode;
  providerId: string;
  providerName: string;
  modelId?: string;
  location: ProviderLocation;
  /** Why this provider was chosen. */
  reasons: string[];
  /** Other eligible providers, best first (used for fallbacks). */
  alternatives: RouteCandidate[];
  requirements: Capability[];
  estimate: CostEstimate;
  score: number;
}

export interface RouteEvaluation {
  settings: RoutingSettings;
  requirements: Capability[];
  dataKinds: DataKind[];
  eligible: RouteCandidate[];
  excluded: ExcludedCandidate[];
}

export interface CapabilityRouterOptions {
  settings?: RoutingSettings | (() => RoutingSettings);
  /** Custom profiles (built-in profiles are always available). */
  profiles?: ProviderProfile[] | (() => ProviderProfile[]);
}

const isActive = (r: RoutingRule) => r.enabled !== false;

function mergeSettings(base: RoutingSettings, over?: Partial<RoutingSettings>): RoutingSettings {
  if (!over) return base;
  return {
    ...base,
    ...over,
    priorities: { ...base.priorities, ...(over.priorities ?? {}) },
    rules: over.rules ?? base.rules,
    neverUpload: over.neverUpload ?? base.neverUpload,
  };
}

export class CapabilityRouter {
  constructor(
    readonly registry: ProviderRegistry,
    private readonly opts: CapabilityRouterOptions = {},
  ) {}

  settings(): RoutingSettings {
    const s = typeof this.opts.settings === 'function' ? this.opts.settings() : this.opts.settings;
    return { ...DEFAULT_ROUTING_SETTINGS, ...(s ?? {}) };
  }

  profiles(): ProviderProfile[] {
    const p = typeof this.opts.profiles === 'function' ? this.opts.profiles() : this.opts.profiles;
    return p ?? [];
  }

  profile(settings = this.settings()): ProviderProfile | undefined {
    return getProfile(settings.profileId, this.profiles());
  }

  /** Effective never-upload kinds (settings + rules + request). */
  neverUpload(settings: RoutingSettings, req?: RouteRequest): DataKind[] {
    const set = new Set<DataKind>(settings.neverUpload);
    for (const r of settings.rules)
      if (r.kind === 'never-upload' && isActive(r)) for (const k of r.dataKinds) set.add(k);
    for (const k of req?.neverUpload ?? []) set.add(k);
    return [...set];
  }

  private scoreCandidate(
    entry: RegistryEntry,
    modelTier: number | undefined,
    estimate: CostEstimate,
    settings: RoutingSettings,
    quality: QualityLevel | undefined,
  ): number {
    const d = entry.instance.descriptor;
    let { quality: wq, cost: wc, latency: wl } = settings.priorities;
    if (quality === 'final') wq *= 2;
    if (quality === 'draft') {
      wc *= 1.5;
      wl *= 1.5;
    }
    const total = wq + wc + wl || 1;
    const q = (modelTier ?? d.qualityTier ?? 3) / 5;
    const c = d.location !== 'cloud' ? 1 : !estimate.known ? 0.4 : 1 / (1 + estimate.maxUsd * 20);
    const l =
      entry.latencyMs !== undefined
        ? 1 / (1 + entry.latencyMs / 10_000)
        : d.location === 'internal'
          ? 1
          : d.location === 'local'
            ? 0.6
            : 0.7;
    return (wq * q + wc * c + wl * l) / total;
  }

  private estimateFor(entry: RegistryEntry, req: RouteRequest, modelId: string | undefined): CostEstimate {
    const d = entry.instance.descriptor;
    return estimateCost(
      {
        location: d.location,
        pricing: entry.config?.pricing ?? d.pricing,
        defaultModel: entry.config?.defaultModel ?? d.defaultModel,
      },
      req.estimateInput,
      modelId,
    );
  }

  /** Evaluate every registered provider for a request: eligible candidates and exclusion reasons. */
  evaluate(req: RouteRequest): RouteEvaluation {
    const settings = mergeSettings(this.settings(), req.settings);
    const info = ROLE_INFO[req.role];
    const requirements = req.capabilities?.length ? [...req.capabilities] : [...info.capabilities];
    const iface = req.interface ?? info.interface;
    const dataKinds = req.dataKinds ?? info.dataKinds;
    const never = this.neverUpload(settings, req);
    const blocked = dataKinds.filter((k) => never.includes(k));
    const rulesMode = settings.mode === 'rules';
    const eligible: RouteCandidate[] = [];
    const excluded: ExcludedCandidate[] = [];
    const forced = req.providerId ? (this.registry.resolveId(req.providerId) ?? req.providerId) : undefined;

    for (const entry of this.registry.allEntries()) {
      const d = entry.instance.descriptor;
      const reasons: string[] = [];
      if (forced && d.id !== forced) continue;
      if (req.excludeProviderIds?.some((x) => x === d.id || x === d.presetId))
        reasons.push('excluded for this request');
      if (!entry.instance[iface])
        reasons.push(
          `does not provide ${iface === 'audioGeneration' ? 'audio generation' : iface === 'voiceConversion' ? 'voice conversion' : iface}`,
        );
      if (entry.status !== 'ready')
        reasons.push(`status: ${entry.status}${entry.error ? ` (${entry.error})` : ''}`);
      if (d.location === 'cloud' && settings.offline)
        reasons.push('offline mode: cloud providers are disabled');
      if (d.location === 'cloud' && blocked.length)
        reasons.push(`never upload: ${blocked.map((k) => DATA_KIND_INFO[k].label.toLowerCase()).join(', ')}`);
      if (rulesMode && d.location === 'cloud') {
        for (const r of settings.rules) {
          if (
            r.kind === 'cloud-only-for-final' &&
            isActive(r) &&
            r.roles.includes(req.role) &&
            req.quality !== 'final'
          )
            reasons.push('rule: cloud production only for final renders');
        }
      }

      // Model choice + capability check.
      const requestedModel = forced === d.id ? req.modelId : undefined;
      const defaultModel = entry.config?.defaultModel ?? d.defaultModel;
      const models = entry.models ?? [];
      let modelId: string | undefined;
      let modelTier: number | undefined;
      let modelNote: string | undefined;
      const providerMissing = () => missingCapabilities(this.registry.capabilitiesOf(d.id), requirements);
      if (models.length) {
        const compatible = models.filter(
          (m) => missingCapabilities(this.registry.capabilitiesOf(d.id, m.id), requirements).length === 0,
        );
        const known = (id: string | undefined) => (id ? models.find((m) => m.id === id) : undefined);
        if (requestedModel) {
          // An explicitly requested model is never silently replaced.
          const m = known(requestedModel);
          if (m && !compatible.includes(m))
            reasons.push(
              `model ${requestedModel} lacks ${missingCapabilities(this.registry.capabilitiesOf(d.id, m.id), requirements).map(capabilityLabel).join(', ')}`,
            );
          else if (!m && providerMissing().length)
            reasons.push(`missing ${providerMissing().map(capabilityLabel).join(', ')}`);
          modelId = requestedModel;
          modelTier = m?.qualityTier;
        } else {
          const dm = known(defaultModel);
          if (defaultModel && (!dm || compatible.includes(dm))) {
            modelId = defaultModel;
            modelTier = dm?.qualityTier;
            if (!dm && providerMissing().length)
              reasons.push(`missing ${providerMissing().map(capabilityLabel).join(', ')}`);
          } else if (compatible.length) {
            const best = [...compatible].sort(
              (a, b) => (b.qualityTier ?? 0) - (a.qualityTier ?? 0) || a.id.localeCompare(b.id),
            )[0];
            modelId = best.id;
            modelTier = best.qualityTier;
            if (dm)
              modelNote = `default model ${defaultModel} lacks ${missingCapabilities(this.registry.capabilitiesOf(d.id, dm.id), requirements).map(capabilityLabel).join(', ')}`;
          } else if (iface === 'lyricTranscription' && !providerMissing().length) {
            // Speech-to-text endpoints pick their own model (whisper-1, scribe_v1…) when the
            // listed models are chat models only.
            modelId = undefined;
          } else {
            const missing = providerMissing();
            reasons.push(
              missing.length
                ? `missing ${missing.map(capabilityLabel).join(', ')}`
                : `no model supports ${requirements.map(capabilityLabel).join(' + ')}`,
            );
          }
        }
      } else {
        const missing = providerMissing();
        if (missing.length) reasons.push(`missing ${missing.map(capabilityLabel).join(', ')}`);
        modelId = requestedModel ?? defaultModel;
        // An LLM endpoint that was discovered and reported no usable model (e.g. nothing pulled in Ollama).
        if (
          iface !== 'audioGeneration' &&
          entry.instance.llm &&
          entry.modelsUpdatedAt !== undefined &&
          !modelId &&
          !entry.config?.models?.length
        ) {
          reasons.push('no models available');
        }
      }

      const estimate = this.estimateFor(entry, req, modelId);
      if (rulesMode) {
        for (const r of settings.rules) {
          if (
            r.kind === 'max-cost' &&
            isActive(r) &&
            (!r.roles || r.roles.includes(req.role)) &&
            estimate.known &&
            estimate.maxUsd > r.usd
          ) {
            reasons.push(
              `rule: estimated ${formatCostRange(estimate)} exceeds max cost $${r.usd.toFixed(2)}`,
            );
          }
        }
      }
      if (reasons.length) {
        excluded.push({ providerId: d.id, providerName: d.name, reasons });
        continue;
      }
      const why: string[] = [];
      if (modelId) why.push(`model ${modelId}`);
      if (modelNote) why.push(modelNote);
      why.push(`${d.location}`, `cost ${formatCostRange(estimate)}`);
      eligible.push({
        providerId: d.id,
        providerName: d.name,
        modelId,
        location: d.location,
        score: this.scoreCandidate(entry, modelTier, estimate, settings, req.quality),
        reasons: why,
        estimate,
      });
    }
    if (forced && !eligible.length && !excluded.length)
      excluded.push({ providerId: forced, providerName: forced, reasons: ['not installed'] });
    return { settings, requirements, dataKinds, eligible, excluded };
  }

  /** Choose a provider (and model) for a request, or throw NoCompatibleProviderError. */
  select(req: RouteRequest): RouteDecision {
    const ev = this.evaluate(req);
    const { settings, requirements } = ev;
    const profile = this.profile(settings);
    const assignment: RoleAssignment | undefined = profile?.assignments[req.role];
    const fail = (message?: string): never => {
      throw new NoCompatibleProviderError(req.role, requirements, ev.excluded, message);
    };
    if (!req.providerId && assignment === 'disabled')
      fail(`The role "${req.role}" is disabled in profile "${profile!.name}"`);
    if (!ev.eligible.length) fail();

    const byScore = (list: RouteCandidate[]) =>
      [...list].sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId));
    const decide = (chosen: RouteCandidate, reasons: string[]): RouteDecision => {
      const alternatives = byScore(ev.eligible.filter((c) => c.providerId !== chosen.providerId));
      return {
        role: req.role,
        mode: settings.mode,
        providerId: chosen.providerId,
        providerName: chosen.providerName,
        modelId: chosen.modelId,
        location: chosen.location,
        reasons: [...reasons, ...chosen.reasons],
        alternatives,
        requirements,
        estimate: chosen.estimate,
        score: chosen.score,
      };
    };
    const internalBest = () => byScore(ev.eligible.filter((c) => c.location === 'internal'))[0];
    /** Use a model named by a profile/rule unless it is known to lack a required capability. */
    const applyModel = (c: RouteCandidate, modelId: string | undefined): void => {
      if (!modelId || c.modelId === modelId) return;
      const entry = this.registry.getEntry(c.providerId);
      if (!entry) return;
      const knownModel = entry.models?.find((m) => m.id === modelId);
      const missing = knownModel
        ? missingCapabilities(this.registry.capabilitiesOf(c.providerId, modelId), requirements)
        : [];
      if (missing.length) {
        c.reasons.push(
          `model ${modelId} lacks ${missing.map(capabilityLabel).join(', ')} — using ${c.modelId ?? 'the default model'}`,
        );
        return;
      }
      c.modelId = modelId;
      c.estimate = this.estimateFor(entry, req, modelId);
      c.reasons = c.reasons.map((r) =>
        r.startsWith('model ')
          ? `model ${modelId}`
          : r.startsWith('cost ')
            ? `cost ${formatCostRange(c.estimate)}`
            : r,
      );
    };

    // Explicit provider for this request.
    if (req.providerId) return decide(ev.eligible[0], ['Requested explicitly']);

    if (settings.mode === 'manual') {
      if (assignment === 'internal') {
        const c = internalBest();
        if (!c)
          fail(
            `Profile "${profile!.name}" assigns ${req.role} to the internal engine, but no internal provider can do it`,
          );
        return decide(c!, [`Assigned to the internal engine in profile "${profile!.name}"`]);
      }
      if (assignment && typeof assignment === 'object') {
        const id = this.registry.resolveId(assignment.providerId) ?? assignment.providerId;
        const c = ev.eligible.find((x) => x.providerId === id);
        if (c) {
          applyModel(c, assignment.modelId);
          return decide(c, [`Assigned in profile "${profile!.name}"`]);
        }
        const why = ev.excluded.find((x) => x.providerId === id)?.reasons.join('; ') ?? 'not installed';
        const fallback = settings.fallbackToInternal !== false ? internalBest() : undefined;
        if (fallback)
          return decide(fallback, [
            `Assigned provider ${describeAssignment(assignment)} unavailable (${why}) — using the internal engine`,
          ]);
        fail(`Assigned provider ${describeAssignment(assignment)} for ${req.role} is unavailable: ${why}`);
      }
      // No assignment for this role: prefer the internal engine, else the best candidate.
      const c = internalBest() ?? byScore(ev.eligible)[0];
      return decide(c, [
        profile
          ? `No assignment for ${req.role} in profile "${profile.name}"`
          : 'Manual mode without a profile',
      ]);
    }

    // automatic / rules: score with bonuses.
    const bonus = new Map<string, { value: number; reasons: string[] }>();
    const addBonus = (id: string, value: number, reason: string) => {
      const b = bonus.get(id) ?? { value: 0, reasons: [] };
      b.value += value;
      b.reasons.push(reason);
      bonus.set(id, b);
    };
    if (assignment && typeof assignment === 'object') {
      const id = this.registry.resolveId(assignment.providerId) ?? assignment.providerId;
      if (ev.eligible.some((c) => c.providerId === id))
        addBonus(id, 0.5, `preferred by profile "${profile!.name}"`);
    } else if (assignment === 'internal') {
      for (const c of ev.eligible)
        if (c.location === 'internal')
          addBonus(c.providerId, 0.5, `profile "${profile!.name}" prefers the internal engine`);
    }
    if (settings.mode === 'rules') {
      for (const r of settings.rules) {
        if (!isActive(r)) continue;
        if (r.kind === 'prefer-local')
          for (const c of ev.eligible)
            if (c.location !== 'cloud') addBonus(c.providerId, 1, 'rule: use local models whenever possible');
        if (r.kind === 'prefer-provider' && r.role === req.role) {
          const id = this.registry.resolveId(r.providerId) ?? r.providerId;
          const c = ev.eligible.find((x) => x.providerId === id);
          if (c) {
            applyModel(c, r.modelId);
            addBonus(id, 2, `rule: prefer ${c.providerName} for ${req.role}`);
          }
        }
      }
    }
    const scored = ev.eligible.map((c) => ({ ...c, score: c.score + (bonus.get(c.providerId)?.value ?? 0) }));
    ev.eligible.splice(0, ev.eligible.length, ...scored);
    const best = byScore(scored)[0];
    const why = bonus.get(best.providerId)?.reasons ?? [];
    return decide(best, [
      settings.mode === 'rules' ? 'Rules routing' : 'Automatic routing',
      ...why,
      `score ${best.score.toFixed(2)}`,
    ]);
  }

  /**
   * The fallback-if-low-confidence rule (rules mode): when a result's confidence is below the
   * threshold, route to the fallback provider — if privacy/offline settings allow it.
   */
  lowConfidenceFallback(
    req: RouteRequest,
    decision: RouteDecision,
    confidence: number | undefined,
  ): { decision: RouteDecision; reason: string } | undefined {
    if (confidence === undefined || !Number.isFinite(confidence)) return undefined;
    const settings = mergeSettings(this.settings(), req.settings);
    if (settings.mode !== 'rules') return undefined;
    for (const r of settings.rules) {
      if (r.kind !== 'fallback-if-low-confidence' || !isActive(r)) continue;
      if (r.roles && !r.roles.includes(req.role)) continue;
      if (confidence >= r.threshold) continue;
      const target = this.registry.resolveId(r.fallbackProviderId) ?? r.fallbackProviderId;
      if (target === decision.providerId) continue;
      try {
        const d = this.select({ ...req, providerId: target, modelId: r.fallbackModelId });
        return {
          decision: d,
          reason: `confidence ${(confidence * 100).toFixed(0)}% < ${(r.threshold * 100).toFixed(0)}% — falling back to ${d.providerName}`,
        };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
