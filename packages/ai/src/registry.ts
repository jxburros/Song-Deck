/**
 * Provider registry & capability negotiation (spec §5, §59): "Which installed provider can
 * perform this?" — never "Is provider X installed?".
 */
import { type Capability, hasCapabilities, missingCapabilities, unionCapabilities } from './capabilities';
import type { ProviderConfig } from './config';
import { toProviderError } from './errors';
import { type CreateProviderDeps, createProvider, finalizeInstance } from './factory';
import { getPreset } from './presets';
import type {
  ModelInfo,
  ProviderInstance,
  ProviderInterfaceName,
  ProviderLocation,
  ProviderStatus,
  VoiceInfo,
} from './types';

export interface RegistryEntry {
  instance: ProviderInstance;
  config?: ProviderConfig;
  status: ProviderStatus;
  error?: string;
  models?: ModelInfo[];
  modelsUpdatedAt?: number;
  /** 'config' = created by configure(); 'manual' = registered by the app (internal providers…). */
  source: 'config' | 'manual';
  /** Exponentially-weighted average latency (ms) observed by the orchestrator. */
  latencyMs?: number;
  /** Voices reported by singing / voice-conversion providers (last discovery). */
  voices?: VoiceInfo[];
}

export interface ProviderSummary {
  id: string;
  name: string;
  location: ProviderLocation;
  adapter: string;
  enabled: boolean;
  status: ProviderStatus;
  error?: string;
  capabilities: Capability[];
  models: ModelInfo[];
  config?: ProviderConfig;
  interfaces: ProviderInterfaceName[];
}

export interface CompatibleProvider {
  providerId: string;
  providerName: string;
  location: ProviderLocation;
  status: ProviderStatus;
  /** Models satisfying ALL requirements (empty when the provider has no model list but qualifies itself). */
  models: ModelInfo[];
  qualityTier: number;
}

export interface ConfigureResult {
  created: string[];
  disabled: string[];
  errors: { id: string; error: string }[];
}

export interface ProviderRegistryOptions {
  /** Dependencies for configure() (transport, credentials…). */
  deps?: CreateProviderDeps;
  now?: () => number;
  /** Model cache lifetime (default 10 minutes). */
  modelTtlMs?: number;
}

const INTERFACES: ProviderInterfaceName[] = [
  'llm',
  'composition',
  'audioGeneration',
  'singing',
  'transcription',
  'separation',
  'voiceConversion',
  'mastering',
];
/** Adapters whose discovered capabilities replace preset defaults (bridges report what they really do). */
const SELF_DESCRIBING_ADAPTERS = new Set(['local-music']);

type Listener = () => void;

export class ProviderRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly disabled = new Map<string, ProviderConfig>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;

  constructor(private readonly opts: ProviderRegistryOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* listeners must not break the registry */
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Register a provider instance (internal providers, test doubles, plugins). */
  register(
    instance: ProviderInstance,
    opts: { status?: ProviderStatus; source?: 'config' | 'manual' } = {},
  ): ProviderInstance {
    const inst = finalizeInstance(instance);
    const id = inst.descriptor.id;
    const previous = this.entries.get(id);
    previous?.instance.dispose?.();
    this.entries.set(id, {
      instance: inst,
      config: inst.config,
      status: opts.status ?? 'ready',
      source: opts.source ?? 'manual',
    });
    this.disabled.delete(id);
    this.emit();
    return inst;
  }

  unregister(id: string): boolean {
    const e = this.entries.get(id);
    if (e) e.instance.dispose?.();
    const had = this.entries.delete(id) || this.disabled.delete(id);
    if (had) this.emit();
    return had;
  }

  /**
   * (Re)create providers from persisted configs. Previously configured providers are replaced;
   * manually registered (internal) providers are kept. Disabled configs are listed but not routable.
   */
  configure(
    configs: ProviderConfig[],
    deps: CreateProviderDeps | undefined = this.opts.deps,
  ): ConfigureResult {
    const result: ConfigureResult = { created: [], disabled: [], errors: [] };
    for (const [id, e] of [...this.entries]) {
      if (e.source === 'config') {
        e.instance.dispose?.();
        this.entries.delete(id);
      }
    }
    this.disabled.clear();
    for (const config of configs) {
      if (!config.enabled) {
        this.disabled.set(config.id, config);
        result.disabled.push(config.id);
        continue;
      }
      if (!deps) {
        result.errors.push({ id: config.id, error: 'No transport configured' });
        this.disabled.set(config.id, config);
        continue;
      }
      try {
        const inst = createProvider(config, deps);
        this.entries.set(config.id, {
          instance: inst,
          config,
          status: initialStatus(config),
          source: 'config',
          models: config.modelCatalog?.filter(
            (m) => !config.enabledModels?.length || config.enabledModels.includes(m.id),
          ),
          ...(initialStatus(config) === 'unconfigured' ? { error: unconfiguredReason(config) } : {}),
        });
        result.created.push(config.id);
      } catch (err) {
        result.errors.push({ id: config.id, error: (err as Error).message });
        this.disabled.set(config.id, config);
      }
    }
    this.emit();
    return result;
  }

  get(id: string): ProviderInstance | undefined {
    return this.entries.get(id)?.instance;
  }

  getEntry(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  getConfig(id: string): ProviderConfig | undefined {
    return this.entries.get(id)?.config ?? this.disabled.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Enabled entries (routable when ready). */
  allEntries(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  /** Resolve a provider id or a preset id (profiles reference presets) to a registered provider id. */
  resolveId(idOrPreset: string): string | undefined {
    if (this.entries.has(idOrPreset)) return idOrPreset;
    for (const [id, e] of this.entries)
      if (e.config?.presetId === idOrPreset || e.instance.descriptor.presetId === idOrPreset) return id;
    return undefined;
  }

  status(id: string): ProviderStatus | undefined {
    if (this.disabled.has(id)) return 'unconfigured';
    return this.entries.get(id)?.status;
  }

  setStatus(id: string, status: ProviderStatus, error?: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.status = status;
    e.error = error;
    this.emit();
  }

  recordLatency(id: string, ms: number): void {
    const e = this.entries.get(id);
    if (!e || !Number.isFinite(ms)) return;
    e.latencyMs = e.latencyMs === undefined ? ms : e.latencyMs * 0.7 + ms * 0.3;
  }

  list(): ProviderSummary[] {
    const out: ProviderSummary[] = [];
    for (const [id, e] of this.entries) {
      const d = e.instance.descriptor;
      out.push({
        id,
        name: d.name,
        location: d.location,
        adapter: d.adapter,
        enabled: true,
        status: e.status,
        ...(e.error ? { error: e.error } : {}),
        capabilities: this.capabilitiesOf(id),
        models: e.models ?? [],
        ...(e.config ? { config: e.config } : {}),
        interfaces: INTERFACES.filter((k) => !!e.instance[k]),
      });
    }
    for (const [id, c] of this.disabled) {
      const preset = getPreset(c.presetId);
      out.push({
        id,
        name: c.name,
        location: c.location,
        adapter: c.adapter,
        enabled: false,
        status: 'unconfigured',
        capabilities: c.capabilities ?? preset?.capabilities ?? [],
        models: [],
        config: c,
        interfaces: [],
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Voices reported by a singing / voice-conversion provider (discover first). */
  voices(id: string): VoiceInfo[] {
    return this.entries.get(id)?.voices ?? [];
  }

  /** Cached models (discover first with discoverModels). */
  models(id: string): ModelInfo[] {
    return this.entries.get(id)?.models ?? [];
  }

  /** Provider-level capabilities (config override > descriptor ∪ discovered models), or one model's. */
  capabilitiesOf(id: string, modelId?: string): Capability[] {
    const e = this.entries.get(id);
    if (!e) return [];
    const override = e.config?.capabilities;
    if (modelId) {
      const manual = e.config?.models?.find((m) => m.id === modelId)?.capabilities;
      if (manual?.length) return [...manual];
      const m = e.models?.find((x) => x.id === modelId);
      // A provider-level override also corrects heuristically inferred model capabilities.
      if (m) return m.capabilitiesInferred && override?.length ? [...override] : [...m.capabilities];
    }
    if (override?.length) return [...override];
    const modelCaps = (e.models ?? []).flatMap((m) => m.capabilities);
    if (SELF_DESCRIBING_ADAPTERS.has(e.instance.descriptor.adapter) && modelCaps.length)
      return unionCapabilities(modelCaps);
    return unionCapabilities(e.instance.descriptor.capabilities, modelCaps);
  }

  listByCapability(caps: Capability | Capability[]): ProviderInstance[] {
    const need = Array.isArray(caps) ? caps : [caps];
    return [...this.entries.keys()]
      .filter((id) => hasCapabilities(this.capabilitiesOf(id), need))
      .map((id) => this.entries.get(id)!.instance);
  }

  /** Discover models (cached; `force` refreshes) and update the provider status. */
  async discoverModels(
    id: string,
    opts: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelInfo[]> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Unknown provider "${id}"`);
    const ttl = this.opts.modelTtlMs ?? 10 * 60_000;
    if (!opts.force && e.models && e.modelsUpdatedAt !== undefined && this.now() - e.modelsUpdatedAt < ttl)
      return e.models;
    const inst = e.instance;
    try {
      // Models from every interface that can list them (multi-interface providers such as the
      // managed gateway contribute LLM and audio models); same ids are merged.
      const byId = new Map<string, ModelInfo>();
      const add = (list: ModelInfo[]) => {
        for (const m of list) {
          const prev = byId.get(m.id);
          byId.set(
            m.id,
            prev ? { ...prev, ...m, capabilities: unionCapabilities(prev.capabilities, m.capabilities) } : m,
          );
        }
      };
      if (inst.llm) add(await inst.llm.listModels(opts.signal));
      if (inst.audioGeneration) add(await inst.audioGeneration.discoverModels(opts.signal));
      // Voices are not models; listing them checks reachability and feeds voice pickers.
      if (inst.singing) e.voices = await inst.singing.listVoices(opts.signal);
      else if (inst.voiceConversion?.listVoices)
        e.voices = await inst.voiceConversion.listVoices(opts.signal);
      const chosen = e.config?.enabledModels?.length ? new Set(e.config.enabledModels) : undefined;
      const models = [...byId.values()].filter((m) => !chosen || chosen.has(m.id));
      e.models = models;
      e.modelsUpdatedAt = this.now();
      if (e.status !== 'unconfigured') {
        e.status = 'ready';
        e.error = undefined;
      }
      this.emit();
      return models;
    } catch (err) {
      const pe = toProviderError(err, id);
      // Missing secret (no HTTP status) → unconfigured; rejected key (401/403) → error.
      e.status =
        pe.kind === 'network'
          ? 'offline'
          : pe.kind === 'auth' && pe.status === undefined
            ? 'unconfigured'
            : 'error';
      e.error = pe.message;
      this.emit();
      throw pe;
    }
  }

  /** Discover all providers in parallel; failures only update statuses. */
  async discoverAll(
    opts: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<Record<string, ModelInfo[] | Error>> {
    const out: Record<string, ModelInfo[] | Error> = {};
    await Promise.all(
      [...this.entries.keys()].map(async (id) => {
        try {
          out[id] = await this.discoverModels(id, opts);
        } catch (err) {
          out[id] = err as Error;
        }
      }),
    );
    return out;
  }

  /**
   * Providers + models satisfying ALL requirements (spec §59). Unavailable providers are skipped
   * unless `includeUnavailable`.
   */
  findCompatible(
    requirements: Capability[],
    opts: {
      interface?: ProviderInterfaceName;
      includeUnavailable?: boolean;
      locations?: ProviderLocation[];
    } = {},
  ): CompatibleProvider[] {
    const out: CompatibleProvider[] = [];
    for (const [id, e] of this.entries) {
      const d = e.instance.descriptor;
      if (opts.interface && !e.instance[opts.interface]) continue;
      if (!opts.includeUnavailable && e.status !== 'ready') continue;
      if (opts.locations && !opts.locations.includes(d.location)) continue;
      const models = (e.models ?? []).filter((m) =>
        hasCapabilities(this.capabilitiesOf(id, m.id), requirements),
      );
      const providerOk = hasCapabilities(this.capabilitiesOf(id), requirements);
      if (e.models?.length && !models.length) continue;
      if (!e.models?.length && !providerOk) continue;
      out.push({
        providerId: id,
        providerName: d.name,
        location: d.location,
        status: e.status,
        models,
        qualityTier: d.qualityTier ?? 3,
      });
    }
    return out.sort((a, b) => b.qualityTier - a.qualityTier || a.providerName.localeCompare(b.providerName));
  }

  /** Why a provider cannot satisfy requirements (empty = it can). */
  missingFor(id: string, requirements: Capability[], modelId?: string): Capability[] {
    return missingCapabilities(this.capabilitiesOf(id, modelId), requirements);
  }
}

function needsCredential(config: ProviderConfig): boolean {
  return config.auth.type !== 'none';
}

function unconfiguredReason(config: ProviderConfig): string {
  if (needsCredential(config) && !config.credentialRef) return 'No API key configured';
  if (config.adapter === 'google-lyria' && !(config.extra?.vertexProject ?? config.project))
    return 'Google Cloud project id missing';
  return 'Not configured';
}

function initialStatus(config: ProviderConfig): ProviderStatus {
  if (needsCredential(config) && !config.credentialRef) return 'unconfigured';
  if (config.adapter === 'google-lyria' && !(config.extra?.vertexProject ?? config.project))
    return 'unconfigured';
  return 'ready';
}
