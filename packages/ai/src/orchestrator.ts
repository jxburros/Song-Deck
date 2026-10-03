/**
 * AI Orchestrator: route → privacy confirmation → budget check → execute (timeout, cancellation)
 * → low-confidence fallback rule → record spend → provenance (spec §49, §50, §60, §63, §64).
 *
 * Providers are reached only through capability routing, so every feature keeps working when a
 * provider disappears (another compatible provider or the internal engine takes over).
 */
import type { ProvenanceRecord, ProvenanceSource } from '@songdeck/core';
import type { Capability } from './capabilities';
import { assertVoiceConsent } from './consent';
import { contextDataKinds, musicContextToPrompt, type MusicContext } from './context';
import { type CostEstimate, type CostEstimateInput, midpointUsd } from './cost';
import type { BudgetManager } from './budget';
import { BudgetExceededError, isAvailabilityError, PrivacyDeclinedError, ProviderError, toProviderError } from './errors';
import { describeDataFlow, needsPrivacyConfirmation, type DataFlowDescriptor } from './privacy';
import type { ProviderRegistry } from './registry';
import { ROLE_INFO } from './roles';
import type { CapabilityRouter, RouteDecision, RouteRequest, RoutingSettings } from './router';
import { raceAbort, withTimeout } from './transport/limiter';
import type {
  AnalyzeMusicRequest,
  AnalyzeMusicResult,
  AudioGenerationResult,
  AudioTransformRequest,
  ChatRequest,
  ChatResult,
  DataKind,
  DesignBlueprintRequest,
  DesignBlueprintResult,
  ExplainMusicRequest,
  ExplainMusicResult,
  GenerateLyricsRequest,
  GenerateLyricsResult,
  MasteringRequest,
  MasteringResult,
  MixAssistRequest,
  MixAssistResult,
  ModifyCompositionRequest,
  ModifyCompositionResult,
  MusicGenerationRequest,
  PhraseRegenerationRequest,
  PlanSongRequest,
  PlanSongResult,
  ProviderInstance,
  ProviderInterfaceName,
  ProviderLocation,
  QualityLevel,
  RequestHints,
  SeparationRequest,
  SeparationResult,
  SingingRequest,
  SingingResult,
  TaskRole,
  TranscriptionRequest,
  TranscriptionResult,
  VoiceConversionRequest,
  VoiceConversionResult,
} from './types';

export interface ConfirmContext {
  role: TaskRole;
  decision: RouteDecision;
  budgetWarning?: string;
}

export type OrchestratorEvent =
  | { type: 'routed'; role: TaskRole; decision: RouteDecision }
  | { type: 'confirm'; role: TaskRole; flow: DataFlowDescriptor; estimate: CostEstimate }
  | { type: 'budget-warning'; role: TaskRole; warning: string }
  | { type: 'started'; role: TaskRole; providerId: string; modelId?: string }
  | { type: 'fallback'; role: TaskRole; from: string; to: string; reason: string }
  | { type: 'succeeded'; role: TaskRole; provenance: RunProvenance }
  | { type: 'failed'; role: TaskRole; providerId: string; error: string };

export interface OrchestratorOptions {
  registry: ProviderRegistry;
  router: CapabilityRouter;
  budget?: BudgetManager;
  /** Routing/privacy settings (default: the router's settings). */
  settings?: RoutingSettings | (() => RoutingSettings);
  /**
   * Privacy confirmation (spec §50). Called when settings.privacyConfirm requires it; return false
   * to cancel. Without a handler, requests that need confirmation are declined (fail closed).
   */
  confirm?: (flow: DataFlowDescriptor, estimate: CostEstimate, ctx: ConfirmContext) => Promise<boolean>;
  clock?: { now(): number };
  /** Default execution timeout when the provider config has none (default 300 s). */
  defaultTimeoutMs?: number;
  /** Try the next eligible provider when one is unavailable (network/5xx/429/timeout/auth). Default true. */
  fallbackOnError?: boolean;
  onEvent?: (event: OrchestratorEvent) => void;
}

export interface OrchestratorTask<T> {
  role: TaskRole;
  capabilities?: Capability[];
  dataKinds?: DataKind[];
  quality?: QualityLevel;
  estimateInput?: CostEstimateInput;
  interface?: ProviderInterfaceName;
  providerId?: string;
  modelId?: string;
  excludeProviderIds?: string[];
  neverUpload?: DataKind[];
  /** Per-run routing overrides (mode, priorities, offline…). */
  routing?: Partial<RoutingSettings>;
  timeoutMs?: number;
  title?: string;
  /** The caller already obtained consent for this data flow (e.g. server-side gateway). */
  skipConfirm?: boolean;
  execute: (instance: ProviderInstance, modelId: string | undefined, signal: AbortSignal, decision: RouteDecision) => Promise<T>;
  signal?: AbortSignal;
}

/** How a result was produced (store with the artifact, spec §64). */
export interface RunProvenance {
  role: TaskRole;
  providerId: string;
  providerName: string;
  modelId?: string;
  location: ProviderLocation;
  /** Whether data left the device. */
  cloud: boolean;
  costUsd?: number;
  /** True when costUsd is an estimate (provider reported no usage). */
  costEstimated?: boolean;
  startedAt: string;
  finishedAt: string;
  /** Provider attempts (> 1 after fallbacks). */
  attempts: number;
  fallbackFrom?: string;
  fallbackReason?: string;
  confidence?: number;
}

export interface AttemptRecord {
  providerId: string;
  modelId?: string;
  error?: string;
  confidence?: number;
}

export interface OrchestratorResult<T> {
  result: T;
  provenance: RunProvenance;
  dataFlow: DataFlowDescriptor;
  decision: RouteDecision;
  estimate: CostEstimate;
  budgetWarning?: string;
  attempts: AttemptRecord[];
}

/** Per-call options of the convenience methods. */
export interface RunOptions {
  quality?: QualityLevel;
  signal?: AbortSignal;
  providerId?: string;
  modelId?: string;
  /** Override the data kinds this request contains (privacy indicator / never-upload). */
  dataKinds?: DataKind[];
  neverUpload?: DataKind[];
  timeoutMs?: number;
  routing?: Partial<RoutingSettings>;
  excludeProviderIds?: string[];
  /** The caller already obtained consent for this data flow. */
  skipConfirm?: boolean;
}

interface AttemptOutcome<T> {
  result: T;
  flow: DataFlowDescriptor;
  costUsd?: number;
  costEstimated: boolean;
  budgetWarning?: string;
  startedAt: number;
  finishedAt: number;
  modelId?: string;
}

function confidenceOf(result: unknown): number | undefined {
  const c = (result as { confidence?: unknown } | null)?.confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
}

function actualCostOf(result: unknown): number | undefined {
  const r = result as { costUsd?: unknown; meta?: { costUsd?: unknown } } | null;
  const c = r?.costUsd ?? r?.meta?.costUsd;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
}

function actualModelOf(result: unknown): string | undefined {
  const r = result as { model?: unknown; meta?: { model?: unknown } } | null;
  const m = r?.meta?.model ?? r?.model;
  return typeof m === 'string' && m ? m : undefined;
}

const SYSTEM_PROMPT_CHARS = 7000;

export class Orchestrator {
  readonly registry: ProviderRegistry;
  readonly router: CapabilityRouter;
  readonly budget?: BudgetManager;
  private readonly now: () => number;

  constructor(private readonly opts: OrchestratorOptions) {
    this.registry = opts.registry;
    this.router = opts.router;
    this.budget = opts.budget;
    this.now = opts.clock ? () => opts.clock!.now() : () => Date.now();
  }

  settings(): RoutingSettings {
    const s = typeof this.opts.settings === 'function' ? this.opts.settings() : this.opts.settings;
    return s ?? this.router.settings();
  }

  private emit(e: OrchestratorEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch {
      /* listeners must not break runs */
    }
  }

  private routeRequest<T>(task: OrchestratorTask<T>): RouteRequest {
    const settings = { ...this.settings(), ...(task.routing ?? {}) };
    return {
      role: task.role,
      capabilities: task.capabilities,
      dataKinds: task.dataKinds,
      quality: task.quality,
      estimateInput: task.estimateInput,
      interface: task.interface,
      providerId: task.providerId,
      modelId: task.modelId,
      excludeProviderIds: task.excludeProviderIds,
      neverUpload: task.neverUpload,
      settings,
    };
  }

  /** Route, confirm, check budget, execute, apply fallbacks and record spend. */
  async run<T>(task: OrchestratorTask<T>): Promise<OrchestratorResult<T>> {
    const req = this.routeRequest(task);
    const decision = this.router.select(req);
    this.emit({ type: 'routed', role: task.role, decision });
    const attempts: AttemptRecord[] = [];
    const fallbackOnError = this.opts.fallbackOnError !== false && !task.providerId;
    // Alternatives are re-routed lazily (explicit provider, same privacy/offline/capability filters).
    let altIndex = 0;
    const nextAlternative = (): RouteDecision | undefined => {
      while (altIndex < decision.alternatives.length) {
        const alt = decision.alternatives[altIndex++];
        try {
          return this.router.select({ ...req, providerId: alt.providerId, modelId: alt.modelId });
        } catch {
          /* no longer eligible */
        }
      }
      return undefined;
    };
    let lastError: unknown;
    let target: RouteDecision | undefined = decision;
    while (target) {
      let outcome: AttemptOutcome<T>;
      try {
        outcome = await this.attempt(task, req, target);
      } catch (err) {
        lastError = err;
        attempts.push({ providerId: target.providerId, modelId: target.modelId, error: (err as Error)?.message ?? String(err) });
        this.emit({ type: 'failed', role: task.role, providerId: target.providerId, error: (err as Error)?.message ?? String(err) });
        const next = fallbackOnError && isAvailabilityError(err) && !task.signal?.aborted ? nextAlternative() : undefined;
        if (next) {
          this.emit({ type: 'fallback', role: task.role, from: target.providerId, to: next.providerId, reason: (err as Error).message });
          target = next;
          continue;
        }
        throw err;
      }
      const confidence = confidenceOf(outcome.result);
      attempts.push({ providerId: target.providerId, modelId: outcome.modelId, confidence });
      const fb = this.router.lowConfidenceFallback(req, target, confidence);
      if (fb) {
        this.emit({ type: 'fallback', role: task.role, from: target.providerId, to: fb.decision.providerId, reason: fb.reason });
        try {
          const second = await this.attempt(task, req, fb.decision);
          const c2 = confidenceOf(second.result);
          attempts.push({ providerId: fb.decision.providerId, modelId: second.modelId, confidence: c2 });
          return this.assemble(task, fb.decision, second, attempts, { fallbackFrom: target.providerId, fallbackReason: fb.reason, previousCost: outcome.costUsd });
        } catch (err) {
          attempts.push({ providerId: fb.decision.providerId, error: (err as Error)?.message ?? String(err) });
          this.emit({ type: 'failed', role: task.role, providerId: fb.decision.providerId, error: (err as Error)?.message ?? String(err) });
          // Keep the original (low-confidence) result.
        }
      }
      return this.assemble(task, target, outcome, attempts);
    }
    throw lastError ?? new ProviderError('unknown', 'No provider attempt was made');
  }

  private assemble<T>(
    task: OrchestratorTask<T>,
    decision: RouteDecision,
    o: AttemptOutcome<T>,
    attempts: AttemptRecord[],
    extra: { fallbackFrom?: string; fallbackReason?: string; previousCost?: number } = {},
  ): OrchestratorResult<T> {
    const provenance: RunProvenance = {
      role: task.role,
      providerId: decision.providerId,
      providerName: decision.providerName,
      location: decision.location,
      cloud: decision.location === 'cloud',
      startedAt: new Date(o.startedAt).toISOString(),
      finishedAt: new Date(o.finishedAt).toISOString(),
      attempts: attempts.length,
    };
    const modelId = o.modelId ?? decision.modelId;
    if (modelId) provenance.modelId = modelId;
    const totalCost = o.costUsd === undefined && extra.previousCost === undefined ? undefined : (o.costUsd ?? 0) + (extra.previousCost ?? 0);
    if (totalCost !== undefined) provenance.costUsd = totalCost;
    if (o.costEstimated) provenance.costEstimated = true;
    if (extra.fallbackFrom) provenance.fallbackFrom = extra.fallbackFrom;
    if (extra.fallbackReason) provenance.fallbackReason = extra.fallbackReason;
    const conf = confidenceOf(o.result);
    if (conf !== undefined) provenance.confidence = conf;
    this.emit({ type: 'succeeded', role: task.role, provenance });
    const out: OrchestratorResult<T> = { result: o.result, provenance, dataFlow: o.flow, decision, estimate: decision.estimate, attempts: [...attempts] };
    if (o.budgetWarning) out.budgetWarning = o.budgetWarning;
    return out;
  }

  private async attempt<T>(task: OrchestratorTask<T>, req: RouteRequest, decision: RouteDecision): Promise<AttemptOutcome<T>> {
    const instance = this.registry.get(decision.providerId);
    if (!instance) throw new ProviderError('unavailable', `Provider ${decision.providerId} is no longer registered`, { providerId: decision.providerId });
    const entry = this.registry.getEntry(decision.providerId);
    const settings = { ...this.settings(), ...(task.routing ?? {}) };
    const estimate = decision.estimate;
    const flow = describeDataFlow({ dataKinds: req.dataKinds ?? ROLE_INFO[task.role].dataKinds, role: task.role, title: task.title }, decision);

    let budgetWarning: string | undefined;
    if (this.budget) {
      const check = this.budget.check(estimate, { providerId: decision.providerId, providerBudget: entry?.config?.budget });
      if (!check.allowed) throw new BudgetExceededError(check.reasons);
      budgetWarning = check.warning;
      if (budgetWarning) this.emit({ type: 'budget-warning', role: task.role, warning: budgetWarning });
    }
    if (!task.skipConfirm && needsPrivacyConfirmation(settings.privacyConfirm, flow)) {
      this.emit({ type: 'confirm', role: task.role, flow, estimate });
      if (!this.opts.confirm) throw new PrivacyDeclinedError(decision.providerId, 'This request needs your confirmation before data leaves the device, but no confirmation handler is available');
      const ok = await this.opts.confirm(flow, estimate, { role: task.role, decision, ...(budgetWarning ? { budgetWarning } : {}) });
      if (!ok) throw new PrivacyDeclinedError(decision.providerId);
    }

    const timeoutMs = task.timeoutMs ?? entry?.config?.timeoutMs ?? this.opts.defaultTimeoutMs ?? 300_000;
    const t = withTimeout(task.signal, timeoutMs);
    const startedAt = this.now();
    this.emit({ type: 'started', role: task.role, providerId: decision.providerId, modelId: decision.modelId });
    let result: T;
    try {
      result = await raceAbort(task.execute(instance, decision.modelId, t.signal, decision), t.signal);
    } catch (err) {
      let e: unknown = err;
      if (t.signal.aborted && !(err instanceof ProviderError && err.kind !== 'cancelled')) {
        e = t.timedOut() ? new ProviderError('timeout', `${decision.providerName} did not finish within ${Math.round(timeoutMs / 1000)} s`, { providerId: decision.providerId }) : new ProviderError('cancelled', 'Cancelled', { providerId: decision.providerId });
      } else if (!(err instanceof Error) || (err.name !== 'ConsentRequiredError' && err.name !== 'BudgetExceededError' && err.name !== 'PrivacyDeclinedError' && err.name !== 'ConfigurationError')) {
        e = toProviderError(err, decision.providerId);
      }
      // An unreachable LOCAL server (e.g. Ollama not running) is marked offline until rediscovered.
      if (e instanceof ProviderError && e.kind === 'network' && decision.location === 'local') this.registry.setStatus(decision.providerId, 'offline', e.message);
      throw e;
    } finally {
      t.dispose();
    }
    const finishedAt = this.now();
    this.registry.recordLatency(decision.providerId, finishedAt - startedAt);
    const actual = actualCostOf(result);
    const costUsd = decision.location === 'cloud' ? (actual ?? midpointUsd(estimate)) : (actual ?? 0);
    const costEstimated = decision.location === 'cloud' && actual === undefined && costUsd !== undefined;
    if (this.budget && costUsd !== undefined && costUsd > 0) {
      this.budget.record({ providerId: decision.providerId, providerName: decision.providerName, modelId: actualModelOf(result) ?? decision.modelId, role: task.role, costUsd, estimated: costEstimated });
    }
    const out: AttemptOutcome<T> = { result, flow, costEstimated, startedAt, finishedAt };
    if (costUsd !== undefined) out.costUsd = costUsd;
    if (budgetWarning) out.budgetWarning = budgetWarning;
    const model = actualModelOf(result) ?? decision.modelId;
    if (model) out.modelId = model;
    return out;
  }

  // -------------------------------------------------------------------------
  // Convenience methods
  // -------------------------------------------------------------------------

  private hints(role: TaskRole, opts: RunOptions, dataKinds: DataKind[]): RequestHints {
    const h: RequestHints = { role, quality: opts.quality ?? 'standard', dataKinds };
    const never = [...this.router.neverUpload({ ...this.settings(), ...(opts.routing ?? {}) }), ...(opts.neverUpload ?? [])];
    if (never.length) h.neverUpload = [...new Set(never)];
    return h;
  }

  private llmTask<R>(role: TaskRole, opts: RunOptions, dataKinds: DataKind[], inputChars: number, capabilities: Capability[] | undefined, call: (inst: ProviderInstance, model: string | undefined, signal: AbortSignal, hints: RequestHints) => Promise<R>): Promise<OrchestratorResult<R>> {
    const kinds = opts.dataKinds ?? dataKinds;
    const hints = this.hints(role, opts, kinds);
    return this.run<R>({
      role,
      capabilities,
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'llm', role, inputChars: inputChars + SYSTEM_PROMPT_CHARS },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: (inst, model, signal) => {
        if (!inst.composition) throw new ProviderError('unsupported', `${inst.descriptor.name} cannot do ${role}`, { providerId: inst.descriptor.id });
        return call(inst, model, signal, hints);
      },
    });
  }

  private ctxChars(ctx?: MusicContext): number {
    return ctx ? musicContextToPrompt(ctx).length : 0;
  }

  planSong(req: PlanSongRequest, opts: RunOptions = {}): Promise<OrchestratorResult<PlanSongResult>> {
    const kinds: DataKind[] = req.context ? contextDataKinds(req.context) : ['song-description'];
    return this.llmTask('composition', opts, kinds, (req.prompt?.length ?? 0) + this.ctxChars(req.context) + (req.blueprint ? 1500 : 0), undefined, (inst, model, signal, hints) =>
      inst.composition!.planSong({ ...req, model: req.model ?? model, signal, hints }),
    );
  }

  designBlueprint(req: DesignBlueprintRequest, opts: RunOptions = {}): Promise<OrchestratorResult<DesignBlueprintResult>> {
    return this.llmTask('composition', opts, ['song-description'], req.prompt.length + 2000, undefined, (inst, model, signal, hints) =>
      inst.composition!.designBlueprint({ ...req, model: req.model ?? model, signal, hints }),
    );
  }

  modifyComposition(req: ModifyCompositionRequest, opts: RunOptions = {}): Promise<OrchestratorResult<ModifyCompositionResult>> {
    return this.llmTask('midi-editing', opts, contextDataKinds(req.context), this.ctxChars(req.context), undefined, (inst, model, signal, hints) =>
      inst.composition!.modifyComposition({ ...req, model: req.model ?? model, signal, hints }),
    );
  }

  chat(req: ChatRequest, opts: RunOptions = {}): Promise<OrchestratorResult<ChatResult>> {
    const historyChars = (req.history ?? []).reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 500), 0);
    return this.llmTask('chat', opts, contextDataKinds(req.context), this.ctxChars(req.context) + historyChars + req.question.length, undefined, (inst, model, signal, hints) =>
      inst.composition!.chat({ ...req, model: req.model ?? model, signal, hints }),
    );
  }

  generateLyrics(req: GenerateLyricsRequest, opts: RunOptions = {}): Promise<OrchestratorResult<GenerateLyricsResult>> {
    const kinds: DataKind[] = req.context ? [...new Set<DataKind>([...contextDataKinds(req.context), 'lyrics'])] : ['song-description', 'lyrics'];
    return this.llmTask('lyrics', opts, kinds, this.ctxChars(req.context) + 1500, undefined, (inst, model, signal, hints) =>
      inst.composition!.generateLyrics({ ...req, model: req.model ?? model, signal, hints }),
    );
  }

  mixAssist(req: MixAssistRequest, opts: RunOptions = {}): Promise<OrchestratorResult<MixAssistResult>> {
    return this.llmTask('mixing', opts, ['song-description', 'project-metadata'], this.ctxChars(req.context), undefined, (inst, model, signal, hints) =>
      inst.composition!.mixAssist({ ...req, model: req.model ?? model, signal, hints }),
    );
  }

  /** Theory View explanation (spec §43). */
  explain(req: ExplainMusicRequest, opts: RunOptions = {}): Promise<OrchestratorResult<ExplainMusicResult>> {
    return this.llmTask('analysis', opts, contextDataKinds(req.context), this.ctxChars(req.context), undefined, (inst, model, signal, hints) =>
      inst.composition!.explainMusic({ ...req, model: req.model ?? model, signal, hints }),
    );
  }

  /** Music analysis of the project and/or audio (audio requires AUDIO_UNDERSTANDING). */
  analyze(req: AnalyzeMusicRequest, opts: RunOptions = {}): Promise<OrchestratorResult<AnalyzeMusicResult>> {
    const kinds: DataKind[] = [...(req.context ? contextDataKinds(req.context) : ['song-description' as DataKind]), ...(req.audio ? (['reference-audio'] as DataKind[]) : [])];
    const caps: Capability[] | undefined = req.audio ? ['AUDIO_UNDERSTANDING', 'AUDIO_INPUT'] : undefined;
    return this.llmTask('analysis', opts, kinds, this.ctxChars(req.context) + (req.audio ? 40_000 : 0), caps, (inst, model, signal, hints) =>
      inst.composition!.analyzeMusic({ ...req, model: req.model ?? model, signal, hints }),
    );
  }

  generateMusic(req: MusicGenerationRequest, opts: RunOptions = {}): Promise<OrchestratorResult<AudioGenerationResult>> {
    const caps: Capability[] = ['TEXT_TO_MUSIC'];
    const vocalRequest = !!req.lyrics && !req.instrumental;
    if (vocalRequest) caps.push('LYRIC_CONDITIONING', 'VOCAL_GENERATION');
    if (req.instrumental) caps.push('INSTRUMENTAL_ONLY');
    if (req.guideAudio) caps.push('AUDIO_TO_AUDIO');
    if (req.referenceAudio) caps.push('REFERENCE_AUDIO');
    const kinds: DataKind[] = opts.dataKinds ?? [
      'song-description',
      ...(req.song || req.sections?.length ? (['chord-progression'] as DataKind[]) : []),
      ...(vocalRequest ? (['lyrics'] as DataKind[]) : []),
      ...(req.guideAudio ? (['guide-audio'] as DataKind[]) : []),
      ...(req.referenceAudio ? (['reference-audio'] as DataKind[]) : []),
    ];
    const hints = this.hints('production', opts, kinds);
    return this.run({
      role: 'production',
      capabilities: caps,
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'audio', durationSeconds: req.durationSeconds, generations: req.samples ?? 1 },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: (inst, model, signal) => inst.audioGeneration!.generateMusic({ ...req, model: req.model ?? model, signal, hints }),
    });
  }

  transformAudio(req: AudioTransformRequest, opts: RunOptions = {}): Promise<OrchestratorResult<AudioGenerationResult>> {
    const kinds = opts.dataKinds ?? ['guide-audio'];
    const hints = this.hints('production', opts, kinds);
    return this.run({
      role: 'production',
      capabilities: ['AUDIO_TO_AUDIO'],
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'audio', durationSeconds: req.durationSeconds ?? req.audio.durationSeconds ?? 30 },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: (inst, model, signal) => inst.audioGeneration!.transformAudio({ ...req, model: req.model ?? model, signal, hints }),
    });
  }

  synthesizeSinging(req: SingingRequest, opts: RunOptions = {}): Promise<OrchestratorResult<SingingResult>> {
    const kinds = opts.dataKinds ?? ['midi', 'lyrics'];
    const hints = this.hints('vocals', opts, kinds);
    const duration = req.notes.reduce((m, n) => Math.max(m, n.startSeconds + n.durationSeconds), 0);
    return this.run({
      role: 'vocals',
      capabilities: ['SINGING_SYNTHESIS'],
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'audio', durationSeconds: duration },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: (inst, model, signal) => inst.singing!.synthesizeSinging({ ...req, model: req.model ?? model, signal, hints }),
    });
  }

  /** Regenerate one vocal phrase only (spec §37; requires REGION_GENERATION). */
  regeneratePhrase(req: PhraseRegenerationRequest, opts: RunOptions = {}): Promise<OrchestratorResult<SingingResult>> {
    const kinds = opts.dataKinds ?? ['midi', 'lyrics'];
    const hints = this.hints('vocals', opts, kinds);
    return this.run({
      role: 'vocals',
      capabilities: ['SINGING_SYNTHESIS', 'REGION_GENERATION'],
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'audio', durationSeconds: req.endSeconds - req.startSeconds },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: async (inst, model, signal) => {
        if (!inst.singing?.regeneratePhrase) throw new ProviderError('unsupported', `${inst.descriptor.name} cannot regenerate single phrases`, { providerId: inst.descriptor.id });
        return inst.singing.regeneratePhrase({ ...req, model: req.model ?? model, signal, hints });
      },
    });
  }

  transcribe(req: TranscriptionRequest, opts: RunOptions = {}): Promise<OrchestratorResult<TranscriptionResult>> {
    const kinds = opts.dataKinds ?? ['reference-audio'];
    const hints = this.hints('transcription', opts, kinds);
    return this.run({
      role: 'transcription',
      capabilities: ['AUDIO_TRANSCRIPTION'],
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'audio', durationSeconds: req.audio.durationSeconds ?? 180 },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: (inst, model, signal) => inst.transcription!.transcribeNotes({ ...req, model: req.model ?? model, signal, hints }),
    });
  }

  separate(req: SeparationRequest, opts: RunOptions = {}): Promise<OrchestratorResult<SeparationResult>> {
    const kinds = opts.dataKinds ?? ['reference-audio'];
    const hints = this.hints('separation', opts, kinds);
    return this.run({
      role: 'separation',
      capabilities: ['SOURCE_SEPARATION'],
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'audio', durationSeconds: req.audio.durationSeconds ?? 180 },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: (inst, model, signal) => inst.separation!.separateStems({ ...req, model: req.model ?? model, signal, hints }),
    });
  }

  master(req: MasteringRequest, opts: RunOptions = {}): Promise<OrchestratorResult<MasteringResult>> {
    const kinds = opts.dataKinds ?? (req.reference ? ['stems', 'reference-audio'] : ['stems']);
    const hints = this.hints('mastering', opts, kinds);
    return this.run({
      role: 'mastering',
      capabilities: req.reference ? ['MASTERING', 'REFERENCE_AUDIO'] : ['MASTERING'],
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'audio', durationSeconds: req.audio.durationSeconds ?? 180 },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: (inst, model, signal) => inst.mastering!.master({ ...req, model: req.model ?? model, signal, hints }),
    });
  }

  /** Voice conversion: consent is verified BEFORE routing, so nothing leaves the app without it (spec §36). */
  async convertVoice(req: VoiceConversionRequest, opts: RunOptions = {}): Promise<OrchestratorResult<VoiceConversionResult>> {
    assertVoiceConsent(req.targetVoice, req.consent);
    const kinds = opts.dataKinds ?? ['recorded-vocals'];
    const hints = this.hints('voice-conversion', opts, kinds);
    return this.run({
      role: 'voice-conversion',
      capabilities: ['VOICE_CONVERSION'],
      dataKinds: kinds,
      quality: opts.quality,
      estimateInput: { kind: 'audio', durationSeconds: req.audio.durationSeconds ?? 60 },
      providerId: opts.providerId,
      modelId: opts.modelId,
      neverUpload: opts.neverUpload,
      routing: opts.routing,
      excludeProviderIds: opts.excludeProviderIds,
      skipConfirm: opts.skipConfirm,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      execute: (inst, model, signal) => inst.voiceConversion!.convertVoice({ ...req, model: req.model ?? model, signal, hints }),
    });
  }
}

export interface ArtifactInfo {
  id: string;
  artifactId: string;
  artifactName: string;
  artifactKind: ProvenanceRecord['artifactKind'];
  sources?: ProvenanceSource[];
  seed?: number;
  parameters?: Record<string, unknown>;
  engineVersion?: string;
  taskId?: string;
}

/** Convert run provenance into the project's ProvenanceRecord (spec §64). */
export function toProvenanceRecord(p: RunProvenance, artifact: ArtifactInfo): ProvenanceRecord {
  const rec: ProvenanceRecord = {
    id: artifact.id,
    artifactId: artifact.artifactId,
    artifactName: artifact.artifactName,
    artifactKind: artifact.artifactKind,
    sources: artifact.sources ?? [],
    providerId: p.providerId,
    providerName: p.providerName,
    generatedAt: p.finishedAt,
    cloud: p.cloud,
  };
  if (p.modelId) rec.modelId = p.modelId;
  if (artifact.seed !== undefined) rec.seed = artifact.seed;
  if (artifact.parameters) rec.parameters = artifact.parameters;
  if (artifact.engineVersion) rec.engineVersion = artifact.engineVersion;
  if (artifact.taskId) rec.taskId = artifact.taskId;
  if (p.costUsd !== undefined) rec.costUsd = p.costUsd;
  return rec;
}
