import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import {
  BUILTIN_GENRES,
  BUILTIN_INSTRUMENTS,
  applyBuilderConstraints,
  defaultMacros,
  describeChoices,
  getInstrument,
  listTags,
  parseChordSymbol,
  parsePromptToBlueprint,
  planComposition,
  randomSeed,
  resolveTagIds,
  type Blueprint,
  type BuilderChoices,
  type CompositionPlan,
  type EditSelection,
  type Song,
} from '@songdeck/core';
import {
  BudgetManager,
  CapabilityRouter,
  DEFAULT_ROUTING_SETTINGS,
  DirectTransport,
  Orchestrator,
  ProviderRegistry,
  ROLE_INFO,
  ServerProxyTransport,
  ServerVaultClient,
  buildMusicContext,
  contextDataKinds,
  roleCapabilitySets,
  toProvenanceRecord,
  type ArtifactInfo,
  type ChatMessage as AiChatMessage,
  type CostEstimate,
  type CostEstimateInput,
  type DataFlowDescriptor,
  type DataKind,
  type OrchestratorEvent,
  type OrchestratorResult,
  type ProviderInstance,
  type ProviderSummary,
  type RoutingSettings,
  type RunProvenance,
  type TaskRole,
  type Transport,
} from '@songdeck/ai';
import { useStudio } from '../state/store';
import { serverBase, useSettings } from '../state/settings';
import { kvGet, kvSet } from '../state/persistence';
import { useRuntime } from './runtime';
import { createInternalProviders } from './internalProviders';
import { INTERNAL_FOR_ROLE } from './internalDescriptors';
import { allCustomGenres, allCustomInstruments, loadEnabledPlugins, onPluginProviders } from './plugins';
import { propose } from './proposals';
import { browserCredentials } from './credentials';
import { dataFlowRightsWarning } from './rights';

/**
 * Studio AI runtime (spec §2.2, §5-§8, §49-§50, §59-§60).
 *
 *  registry ── configured providers (BYOK cloud, local endpoints, managed) + on-device engines + plugins
 *  router   ── capability negotiation under the user's routing mode, profile and rules
 *  orchestrator ── privacy confirmation (data-flow indicator), budgets, timeouts, fallbacks, provenance
 *
 * Every AI feature in the studio calls one of the `ai*` functions below with a `providerChoice`:
 * 'auto' (router decides), 'internal' (on-device engine), or an explicit provider id.
 */

export interface AiRuntimeState {
  version: number;
  providers: ProviderSummary[];
  transport: 'proxy' | 'direct';
  vaultBackend?: string;
  events: (OrchestratorEvent & { at: string })[];
}

export const useAiRuntime = create<AiRuntimeState>(() => ({
  version: 0,
  providers: [],
  transport: 'direct',
  events: [],
}));

/**
 * Secrets held by the browser when the server vault is not in use: encrypted at rest in IndexedDB
 * (or this tab's memory where that is unavailable) — see engine/credentials.ts.
 */
export { browserCredentials };

let registry: ProviderRegistry | null = null;
let router: CapabilityRouter | null = null;
let orchestrator: Orchestrator | null = null;
let budget: BudgetManager | null = null;
let transportKind: 'proxy' | 'direct' = 'direct';

function routingSettings(): RoutingSettings {
  return { ...DEFAULT_ROUTING_SETTINGS, ...(useSettings.getState().routing as Partial<RoutingSettings>) };
}

function currentTransport(): Transport {
  const online = useRuntime.getState().server.status === 'online';
  if (online && useSettings.getState().useServerProxy) {
    transportKind = 'proxy';
    return new ServerProxyTransport(serverBase());
  }
  transportKind = 'direct';
  return new DirectTransport(browserCredentials);
}

function bump() {
  const s = useAiRuntime.getState();
  useAiRuntime.setState({
    version: s.version + 1,
    providers: registry?.list() ?? [],
    transport: transportKind,
  });
}

/** Sync provider configs (no secrets) to the local server: proxy allowlist, credential scope, managed gateway. */
async function syncProvidersToServer() {
  if (useRuntime.getState().server.status !== 'online') return;
  try {
    await fetch(`${serverBase()}/api/providers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providers: useSettings.getState().providers }),
    });
  } catch {
    /* server optional */
  }
}

function configureProviders() {
  if (!registry) return;
  const deps = { transport: currentTransport(), credentials: browserCredentials };
  // The managed "Automatic" gateway runs on the local server: an empty base URL means that server.
  const base = serverBase();
  const providers = useSettings
    .getState()
    .providers.map((p) =>
      p.adapter === 'managed' && !p.baseUrl?.trim() && base ? { ...p, baseUrl: base } : p,
    );
  const result = registry.configure(providers, deps);
  for (const e of result.errors) console.warn(`[ai] provider ${e.id}: ${e.error}`);
  bump();
  void syncProvidersToServer();
}

export function initAi(): void {
  if (registry) return;
  registry = new ProviderRegistry({
    deps: { transport: currentTransport(), credentials: browserCredentials },
  });
  for (const p of createInternalProviders({
    song: () => useStudio.getState().project?.song ?? null,
    selection: () => useStudio.getState().selection,
    seed: () => randomSeed(),
  })) {
    registry.register(p);
  }
  router = new CapabilityRouter(registry, {
    settings: routingSettings,
    profiles: () => useSettings.getState().customProfiles,
  });
  budget = new BudgetManager(useSettings.getState().budget, {
    load: async () => (await kvGet('spend-ledger')) ?? [],
    save: async (entries) => kvSet('spend-ledger', entries),
  });
  orchestrator = new Orchestrator({
    registry,
    router,
    budget,
    settings: routingSettings,
    confirm: (flow: DataFlowDescriptor, estimate: CostEstimate, ctx) =>
      useStudio.getState().requestConfirm({
        kind: 'dataflow',
        title: `Send to ${flow.providerName}?`,
        body: {
          message: `${ROLE_INFO[ctx.role].label}: this request will be processed by ${flow.providerName}.`,
          dataFlow: flow,
          estimate,
          model: ctx.decision.modelId,
          warning: ctx.budgetWarning,
          // Uploaded audio attested as personal study, or flagged/matched by the rights checks (docs/RIGHTS.md).
          rightsWarning: dataFlowRightsWarning(useStudio.getState().project, flow),
          confirmLabel: 'Send',
        },
      }),
    // The rights reminder is always shown, whatever the confirmation setting (docs/RIGHTS.md).
    forceConfirm: (flow: DataFlowDescriptor) => !!dataFlowRightsWarning(useStudio.getState().project, flow),
    onEvent: (e) => {
      const events = [{ ...e, at: new Date().toISOString() }, ...useAiRuntime.getState().events].slice(0, 80);
      useAiRuntime.setState({ events });
    },
  });
  registry.subscribe(bump);
  configureProviders();

  // Reconfigure when provider configs, routing, budgets or server connectivity change.
  let prev = useSettings.getState();
  useSettings.subscribe((s) => {
    if (
      s.providers !== prev.providers ||
      s.useServerProxy !== prev.useServerProxy ||
      s.serverUrl !== prev.serverUrl
    )
      configureProviders();
    if (s.budget !== prev.budget) budget?.setLimits(s.budget);
    if (s.routing !== prev.routing || s.customProfiles !== prev.customProfiles) bump();
    prev = s;
  });
  let prevServer = useRuntime.getState().server.status;
  useRuntime.subscribe((r) => {
    if (r.server.status !== prevServer) {
      prevServer = r.server.status;
      configureProviders();
      if (r.server.status === 'online') {
        void refreshVaultStatus();
        // The server hosts plugin files: load enabled plugins once it is reachable.
        void loadEnabledPlugins();
      }
    }
  });
  onPluginProviders((instances, removedIds) => {
    for (const id of removedIds ?? []) registry?.unregister(id);
    for (const inst of instances) registry?.register(inst);
    bump();
  });
  void loadEnabledPlugins();
  if (useRuntime.getState().server.status === 'online') void refreshVaultStatus();
}

export function getRegistry(): ProviderRegistry {
  if (!registry) initAi();
  return registry!;
}

export function getRouter(): CapabilityRouter {
  if (!router) initAi();
  return router!;
}

export function getOrchestrator(): Orchestrator {
  if (!orchestrator) initAi();
  return orchestrator!;
}

export function getBudget(): BudgetManager {
  if (!budget) initAi();
  return budget!;
}

// ---------------------------------------------------------------------------
// Credentials (BYOK, spec §7): server vault (OS keychain) when available, else encrypted in this
// browser (session memory where the browser cannot store them).
// ---------------------------------------------------------------------------

export async function refreshVaultStatus(): Promise<void> {
  try {
    const st = await new ServerVaultClient(serverBase()).status();
    useAiRuntime.setState({ vaultBackend: st.backend });
  } catch {
    useAiRuntime.setState({ vaultBackend: undefined });
  }
}

function vaultInUse(): boolean {
  return useRuntime.getState().server.status === 'online' && useSettings.getState().useServerProxy;
}

export async function saveCredential(
  ref: string,
  secret: string,
  label?: string,
): Promise<'vault' | 'browser' | 'session'> {
  if (vaultInUse()) {
    await new ServerVaultClient(serverBase()).setSecret(ref, secret, label);
    // One place per key: a copy left in the browser would outlive a vault deletion.
    await browserCredentials.delete(ref);
    await syncProvidersToServer();
    return 'vault';
  }
  return browserCredentials.put(ref, secret, label);
}

export async function deleteCredential(ref: string): Promise<void> {
  if (useRuntime.getState().server.status === 'online') {
    try {
      await new ServerVaultClient(serverBase()).deleteSecret(ref);
    } catch {
      /* not in vault */
    }
  }
  await browserCredentials.delete(ref);
}

export async function hasCredential(ref: string): Promise<boolean> {
  if (vaultInUse()) {
    try {
      return await new ServerVaultClient(serverBase()).has(ref);
    } catch {
      return false;
    }
  }
  return (await browserCredentials.where(ref)) !== 'none';
}

/** Keys held by this browser (encrypted or session-only) — candidates to move into the server vault. */
export async function browserKeyRefs(): Promise<{ ref: string; label?: string }[]> {
  return browserCredentials.list();
}

/** Move browser-held keys into the server vault (OS keychain), then delete them from the browser. */
export async function moveBrowserKeysToVault(): Promise<{ moved: number; failed: string[] }> {
  if (!vaultInUse()) throw new Error('The local server (with its vault & proxy) is not in use');
  const vault = new ServerVaultClient(serverBase());
  let moved = 0;
  const failed: string[] = [];
  for (const { ref, label } of await browserCredentials.list()) {
    try {
      const secret = await browserCredentials.get(ref);
      if (!secret) continue;
      await vault.setSecret(ref, secret, label);
      await browserCredentials.delete(ref);
      moved++;
    } catch {
      failed.push(ref);
    }
  }
  await syncProvidersToServer();
  void refreshVaultStatus();
  return { moved, failed };
}

/** Forget every key stored in this browser (the server vault is untouched). */
export async function forgetBrowserKeys(): Promise<void> {
  await browserCredentials.clear();
}

// ---------------------------------------------------------------------------
// Provider choice helpers
// ---------------------------------------------------------------------------

export interface RoleOption {
  value: string;
  label: string;
  disabled?: boolean;
  location?: string;
}

/** Options for a provider picker: Auto, on-device engine, and every compatible provider. */
export function roleOptions(role: TaskRole): RoleOption[] {
  const reg = getRegistry();
  const info = ROLE_INFO[role];
  // Production can generate from text or perform the composition (MIDI / stem conditioning, audio
  // to audio) — the on-device producer does the latter (spec §29-§30, §38).
  const sets = roleCapabilitySets(role);
  const out: RoleOption[] = [];
  let predicted = 'no compatible provider';
  for (const capabilities of sets) {
    try {
      predicted = getRouter().select({ role, capabilities }).providerName;
      break;
    } catch {
      /* try the next way to serve this role */
    }
  }
  out.push({ value: 'auto', label: `Auto (${routingSettings().mode}) → ${predicted}` });
  const internalId = INTERNAL_FOR_ROLE[role];
  if (internalId && reg.has(internalId))
    out.push({ value: 'internal', label: `${reg.get(internalId)!.descriptor.name}`, location: 'internal' });
  const seen = new Set<string>();
  const compatible = sets.flatMap((capabilities) =>
    reg.findCompatible(capabilities, { interface: info.interface, includeUnavailable: true }),
  );
  for (const c of compatible) {
    if (c.location === 'internal' || seen.has(c.providerId)) continue;
    seen.add(c.providerId);
    out.push({
      value: c.providerId,
      label: `${c.providerName} · ${c.location}${c.status !== 'ready' ? ` (${c.status})` : ''}`,
      disabled: c.status !== 'ready' || (routingSettings().offline && c.location === 'cloud'),
      location: c.location,
    });
  }
  return out;
}

export interface RoleRoute {
  providerId: string;
  providerName: string;
  location: string;
  /** The on-device engine (no model). */
  internal: boolean;
}

/**
 * Who would serve a role for a picker choice — a router dry run for "auto" (the same selection
 * `roleOptions` predicts), the on-device engine for "internal", or the chosen provider. Null when
 * nothing can serve it.
 */
export function routeFor(role: TaskRole, choice: string | undefined): RoleRoute | null {
  const reg = getRegistry();
  let id: string | undefined;
  if (choice === 'internal') id = INTERNAL_FOR_ROLE[role];
  else if (!choice || choice === 'auto') {
    for (const capabilities of roleCapabilitySets(role)) {
      try {
        id = getRouter().select({ role, capabilities }).providerId;
        break;
      } catch {
        /* try the next way to serve this role */
      }
    }
  } else id = choice;
  const inst = id ? reg.get(id) : undefined;
  if (!id || !inst) return null;
  const location = inst.descriptor.location;
  return { providerId: id, providerName: inst.descriptor.name, location, internal: location === 'internal' };
}

/** `routeFor` as a hook: re-evaluated when providers, routing or plugins change. */
export function useRoleRoute(role: TaskRole, choice: string | undefined): RoleRoute | null {
  const version = useAiRuntime((s) => s.version);
  const routing = useSettings((s) => s.routing);
  useEffect(() => {
    initAi();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => routeFor(role, choice), [role, choice, version, routing]);
}

export function useRoleOptions(role: TaskRole): RoleOption[] {
  const version = useAiRuntime((s) => s.version);
  const routing = useSettings((s) => s.routing);
  useEffect(() => {
    initAi();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => roleOptions(role), [role, version, routing]);
}

function providerIdFor(role: TaskRole, choice: string | undefined): string | undefined {
  if (!choice || choice === 'auto') return undefined;
  if (choice === 'internal') return INTERNAL_FOR_ROLE[role];
  return choice;
}

export function sourceLabel(p: RunProvenance): string {
  const where = p.location === 'internal' ? 'on-device' : p.location;
  return `${p.providerName}${p.modelId ? ` · ${p.modelId}` : ''} · ${where}${p.costUsd ? ` · $${p.costUsd.toFixed(4)}` : ''}${p.fallbackFrom ? ` (fallback from ${p.fallbackFrom})` : ''}`;
}

export interface AiCallOptions {
  providerChoice?: string;
  signal?: AbortSignal;
  quality?: 'draft' | 'standard' | 'final';
  seed?: number;
}

function projectNeverUpload(): DataKind[] {
  return (useStudio.getState().project?.meta.settings.neverUpload ?? []) as DataKind[];
}

/** Run any role through the orchestrator (generic entry point used by all modes). */
export async function runRole<T>(
  role: TaskRole,
  opts: AiCallOptions & {
    dataKinds?: DataKind[];
    estimateInput?: CostEstimateInput;
    capabilities?: Parameters<Orchestrator['run']>[0]['capabilities'];
    title?: string;
    execute: (instance: ProviderInstance, modelId: string | undefined, signal: AbortSignal) => Promise<T>;
  },
): Promise<OrchestratorResult<T>> {
  return getOrchestrator().run<T>({
    role,
    providerId: providerIdFor(role, opts.providerChoice),
    capabilities: opts.capabilities,
    dataKinds: opts.dataKinds,
    quality: opts.quality,
    estimateInput: opts.estimateInput,
    neverUpload: projectNeverUpload(),
    title: opts.title,
    signal: opts.signal,
    execute: (instance, modelId, signal) => opts.execute(instance, modelId, signal),
  });
}

/** Convert a run's provenance into a project provenance record and store it (spec §64). */
export function recordProvenance(
  p: RunProvenance,
  artifact: Omit<ArtifactInfo, 'id'> & { id?: string },
): void {
  const rec = toProvenanceRecord(p, { id: artifact.id ?? `prov_${Date.now().toString(36)}`, ...artifact });
  if (p.costUsd !== undefined) rec.costUsd = p.costUsd;
  useStudio.getState().addProvenance(rec);
}

// ---------------------------------------------------------------------------
// Composition (spec §10, §15)
// ---------------------------------------------------------------------------

/** Merge a model-produced blueprint onto the deterministic one so it is always complete and valid. */
export function sanitizeBlueprint(
  candidate: Partial<Blueprint> | undefined,
  prompt: string,
  seed: number,
): Blueprint {
  const base = parsePromptToBlueprint(prompt, { seed, customGenres: allCustomGenres() });
  if (!candidate) return base;
  const knownInstruments = new Set([...BUILTIN_INSTRUMENTS, ...allCustomInstruments()].map((i) => i.id));
  const knownGenres = new Set([...BUILTIN_GENRES, ...allCustomGenres()].map((g) => g.id));
  const tempo = Number(candidate.tempo);
  const bp: Blueprint = {
    ...base,
    title:
      typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : base.title,
    prompt,
    tempo: Number.isFinite(tempo) && tempo >= 30 && tempo <= 300 ? Math.round(tempo) : base.tempo,
    meter:
      candidate.meter && candidate.meter.numerator > 0 && [2, 4, 8, 16].includes(candidate.meter.denominator)
        ? candidate.meter
        : base.meter,
    key:
      candidate.key &&
      Number.isInteger(candidate.key.tonic) &&
      candidate.key.tonic >= 0 &&
      candidate.key.tonic < 12
        ? candidate.key
        : base.key,
    styles:
      Array.isArray(candidate.styles) && candidate.styles.length ? candidate.styles.map(String) : base.styles,
    genreBlend: (candidate.genreBlend ?? []).filter((g) => knownGenres.has(g.genreId) && g.weight > 0),
    moods:
      Array.isArray(candidate.moods) && candidate.moods.length ? candidate.moods.map(String) : base.moods,
    instrumentation: (candidate.instrumentation ?? [])
      .filter((t) => t && typeof t.name === 'string')
      .map((t) => ({
        ...t,
        instrumentId: knownInstruments.has(t.instrumentId)
          ? t.instrumentId
          : getInstrument(t.instrumentId, allCustomInstruments()).id,
      })),
    structure: (candidate.structure ?? [])
      .filter((s) => s && typeof s.name === 'string')
      .map((s) => ({
        ...s,
        bars: Math.max(1, Math.min(64, Math.round(Number(s.bars) || 8))),
        energy: Math.max(0, Math.min(100, Number(s.energy ?? 50))),
      })),
    vocal: candidate.vocal ?? base.vocal,
    lyricsTheme: candidate.lyricsTheme ?? base.lyricsTheme,
    macros: { ...defaultMacros(), ...base.macros, ...(candidate.macros ?? {}) },
    seed,
  };
  // Tags: only ids the catalog knows (a model's invented tags are dropped).
  const tags = resolveTagIds(Array.isArray(candidate.tags) ? candidate.tags.map(String) : []);
  if (tags.length) bp.tags = tags;
  else if (!bp.tags?.length) delete bp.tags;
  if (!bp.genreBlend.length) bp.genreBlend = base.genreBlend;
  if (!bp.instrumentation.length) bp.instrumentation = base.instrumentation;
  if (!bp.structure.length) bp.structure = base.structure;
  return bp;
}

/** Keep model plans usable: drop unparseable chords, fall back per section to the on-device plan. */
export function sanitizePlan(plan: CompositionPlan | undefined, blueprint: Blueprint): CompositionPlan {
  const base = planComposition(blueprint, { seed: blueprint.seed, customGenres: allCustomGenres() });
  if (!plan || !Array.isArray(plan.sections) || !plan.sections.length) return base;
  return {
    ...base,
    ...plan,
    key: plan.key && Number.isInteger(plan.key.tonic) ? plan.key : base.key,
    tempo: Number.isFinite(plan.tempo) && plan.tempo >= 30 && plan.tempo <= 300 ? plan.tempo : base.tempo,
    meter: plan.meter?.numerator ? plan.meter : base.meter,
    sections: plan.sections.map((s, i) => {
      const fallback = base.sections[Math.min(i, base.sections.length - 1)];
      const harmony = (s.harmony ?? []).filter((h) => !!parseChordSymbol(h));
      return {
        name: s.name || fallback.name,
        kind: s.kind || fallback.kind,
        bars: Math.max(1, Math.min(64, Math.round(Number(s.bars) || fallback.bars))),
        harmony: harmony.length ? harmony : fallback.harmony,
        energy: Math.max(0, Math.min(100, Number(s.energy ?? fallback.energy))),
        energyEnd: s.energyEnd !== undefined ? Math.max(0, Math.min(100, Number(s.energyEnd))) : undefined,
        purpose: s.purpose || fallback.purpose,
        feel: s.feel,
      };
    }),
  };
}

/**
 * Design a blueprint from words. With `choices` (the Compose builder), the user's choices are hard
 * constraints: they go into the request and are re-applied to whatever comes back, so the model
 * fills in detail but cannot override them; their lyrics are sent too (and never rewritten).
 */
export async function aiDesignBlueprint(
  prompt: string,
  opts: AiCallOptions & { seed: number; choices?: BuilderChoices },
): Promise<{ blueprint: Blueprint; source: string; provenance: RunProvenance }> {
  const custom = { customGenres: allCustomGenres(), customInstruments: allCustomInstruments() };
  const choices = opts.choices;
  const lyrics = choices?.lyrics?.sections.length ? choices.lyrics.text : undefined;
  const constraints = choices ? describeChoices(choices, custom) : [];
  const r = await runRole('composition', {
    ...opts,
    dataKinds: lyrics ? ['song-description', 'lyrics'] : ['song-description'],
    estimateInput: {
      kind: 'llm',
      role: 'composition',
      inputChars: prompt.length + (lyrics?.length ?? 0) + constraints.join('\n').length + 6000,
    },
    title: 'Design Song Blueprint',
    execute: async (instance, model, signal) => {
      const res = await instance.composition!.designBlueprint({
        prompt,
        model,
        signal,
        defaults: { seed: opts.seed, macros: defaultMacros() },
        genres: [...BUILTIN_GENRES, ...custom.customGenres].map((g) => ({ id: g.id, name: g.name })),
        instruments: [...BUILTIN_INSTRUMENTS, ...custom.customInstruments].map((i) => ({
          id: i.id,
          name: i.name,
          family: i.family,
        })),
        tags: listTags().map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
        ...(constraints.length ? { constraints } : {}),
        ...(lyrics ? { lyrics } : {}),
      });
      let blueprint =
        instance.descriptor.location === 'internal'
          ? res.blueprint
          : sanitizeBlueprint(res.blueprint, prompt, opts.seed);
      if (choices) blueprint = applyBuilderConstraints(blueprint, choices, { seed: opts.seed, ...custom });
      return { ...res, blueprint };
    },
  });
  return { blueprint: r.result.blueprint, source: sourceLabel(r.provenance), provenance: r.provenance };
}

export async function aiPlanSong(
  blueprint: Blueprint,
  opts: AiCallOptions & { seed: number },
): Promise<{ plan: CompositionPlan; source: string; provenance: RunProvenance }> {
  const r = await runRole('composition', {
    ...opts,
    dataKinds: ['song-description', 'chord-progression'],
    estimateInput: { kind: 'llm', role: 'composition', inputChars: JSON.stringify(blueprint).length + 6000 },
    title: 'Plan composition',
    execute: async (instance, model, signal) => {
      const res = await instance.composition!.planSong({
        blueprint: { ...blueprint, seed: opts.seed },
        model,
        signal,
      });
      return { ...res, plan: sanitizePlan(res.plan, { ...blueprint, seed: opts.seed }) };
    },
  });
  return {
    plan: { ...r.result.plan, source: r.provenance.providerName },
    source: sourceLabel(r.provenance),
    provenance: r.provenance,
  };
}

// ---------------------------------------------------------------------------
// Editing, conversation, explanation, mixing (spec §20, §41, §43, §44)
// ---------------------------------------------------------------------------

export async function aiEdit(
  song: Song,
  instruction: string,
  selection: EditSelection,
  opts: AiCallOptions,
): Promise<{ explanation: string; source: string; proposalCreated: boolean }> {
  const context = buildMusicContext(song, { instruction, selection });
  const r = await runRole('midi-editing', {
    ...opts,
    dataKinds: contextDataKinds(context) as DataKind[],
    estimateInput: { kind: 'llm', role: 'midi-editing', inputChars: JSON.stringify(context).length },
    title: instruction,
    execute: (instance, model, signal) =>
      instance.composition!.modifyComposition({ context, instruction, model, signal }),
  });
  const res = r.result;
  const errors = res.errors.length
    ? `\n(${res.errors.length} invalid operation${res.errors.length > 1 ? 's were' : ' was'} dropped)`
    : '';
  const proposal = propose(
    song,
    res.operations,
    {
      title: instruction,
      source: r.provenance.location === 'internal' ? 'internal' : r.provenance.providerName,
      modelId: r.provenance.modelId,
      instruction,
      explanation: `${res.explanation}${errors}`,
    },
    { openPianoRoll: true },
  );
  return {
    explanation: `${res.explanation}${errors}`,
    source: sourceLabel(r.provenance),
    proposalCreated: !!proposal,
  };
}

export async function aiChat(
  song: Song,
  history: { role: string; content: string }[],
  selection: EditSelection,
  opts: AiCallOptions,
): Promise<{ answer: string; source: string; proposalId?: string }> {
  const question = history.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const context = buildMusicContext(song, { instruction: question, selection });
  const prior: AiChatMessage[] = history
    .slice(0, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  const r = await runRole('chat', {
    ...opts,
    dataKinds: contextDataKinds(context) as DataKind[],
    estimateInput: {
      kind: 'llm',
      role: 'chat',
      inputChars: JSON.stringify(context).length + question.length,
    },
    title: 'Assistant',
    execute: (instance, model, signal) =>
      instance.composition!.chat({ context, history: prior, question, model, signal }),
  });
  let proposalId: string | undefined;
  if (r.result.operations.length) {
    const p = propose(song, r.result.operations, {
      title: question.length > 60 ? `${question.slice(0, 57)}…` : question,
      source: r.provenance.location === 'internal' ? 'internal' : r.provenance.providerName,
      modelId: r.provenance.modelId,
      instruction: question,
      explanation: r.result.answer,
    });
    proposalId = p?.id;
  }
  const suggestions = r.result.suggestions?.length
    ? `\n\nYou could also ask: ${r.result.suggestions.slice(0, 3).join(' · ')}`
    : '';
  return { answer: `${r.result.answer}${suggestions}`, source: sourceLabel(r.provenance), proposalId };
}

export async function aiExplain(
  song: Song,
  sectionId: string,
  opts: AiCallOptions,
): Promise<{ text: string; source: string }> {
  const context = buildMusicContext(song, {
    instruction: 'Explain the harmony and musical function of this section.',
    sectionId,
  });
  const r = await runRole('analysis', {
    ...opts,
    dataKinds: contextDataKinds(context) as DataKind[],
    estimateInput: { kind: 'llm', role: 'analysis', inputChars: JSON.stringify(context).length },
    title: 'Explain music',
    execute: (instance, model, signal) =>
      instance.composition!.explainMusic({ context, sectionId, model, signal }),
  });
  const s = r.result.suggestions?.length ? `\n\nIdeas:\n• ${r.result.suggestions.join('\n• ')}` : '';
  return { text: `${r.result.explanation}${s}`, source: sourceLabel(r.provenance) };
}

export async function aiMix(
  song: Song,
  instruction: string,
  opts: AiCallOptions,
): Promise<{ explanation: string; source: string; proposalCreated: boolean; proposalId?: string }> {
  const context = buildMusicContext(song, { instruction, includeMixer: true });
  const r = await runRole('mixing', {
    ...opts,
    dataKinds: ['song-description', 'project-metadata'],
    estimateInput: { kind: 'llm', role: 'mixing', inputChars: JSON.stringify(context).length },
    title: instruction,
    execute: (instance, model, signal) =>
      instance.composition!.mixAssist({ context, instruction, model, signal }),
  });
  const p = propose(song, r.result.operations, {
    title: instruction,
    source: r.provenance.location === 'internal' ? 'internal' : r.provenance.providerName,
    modelId: r.provenance.modelId,
    instruction,
    explanation: r.result.explanation,
  });
  return {
    explanation: r.result.explanation,
    source: sourceLabel(r.provenance),
    proposalCreated: !!p,
    proposalId: p?.id,
  };
}

export async function aiLyrics(
  song: Song,
  sections: {
    sectionId: string;
    name: string;
    kind?: Song['sections'][number]['kind'];
    lines: number;
    syllables?: number[];
    existing?: string[];
    locked?: boolean;
  }[],
  opts: AiCallOptions & { theme?: string; style?: string; instruction?: string },
): Promise<{
  sections: { sectionId: string; lines: string[] }[];
  source: string;
  provenance: RunProvenance;
  notes?: string;
}> {
  const context = buildMusicContext(song, {
    instruction: opts.instruction ?? 'Write lyrics that fit these sections.',
  });
  const r = await runRole('lyrics', {
    ...opts,
    dataKinds: ['song-description', 'lyrics'],
    estimateInput: { kind: 'llm', role: 'lyrics', inputChars: JSON.stringify(context).length },
    title: 'Write lyrics',
    execute: (instance, model, signal) =>
      instance.composition!.generateLyrics({
        context,
        theme: opts.theme ?? song.blueprint?.lyricsTheme,
        style: opts.style ?? song.blueprint?.moods.join(', '),
        language: song.vocals.language,
        instruction: opts.instruction,
        sections: sections.map((s) => ({
          name: s.name,
          kind: s.kind,
          lines: s.lines,
          syllables: s.syllables,
          existing: s.existing,
          locked: s.locked,
        })),
        model,
        signal,
      }),
  });
  const out = sections.map((s, i) => ({
    sectionId: s.sectionId,
    lines: (r.result.sections.find((x) => x.section === s.name) ?? r.result.sections[i])?.lines ?? [],
  }));
  return {
    sections: out,
    source: sourceLabel(r.provenance),
    provenance: r.provenance,
    notes: r.result.notes,
  };
}

// ---------------------------------------------------------------------------
// Audio roles: thin wrappers over the orchestrator for Produce, Vocals, Transcribe, Rebuild, Master.
// ---------------------------------------------------------------------------

function runOpts(role: TaskRole, opts: AiCallOptions) {
  return {
    providerId: providerIdFor(role, opts.providerChoice),
    signal: opts.signal,
    quality: opts.quality,
    neverUpload: projectNeverUpload(),
  };
}

export const aiAudio = {
  generateMusic: (req: Parameters<Orchestrator['generateMusic']>[0], opts: AiCallOptions = {}) =>
    getOrchestrator().generateMusic(req, runOpts('production', opts)),
  transformAudio: (req: Parameters<Orchestrator['transformAudio']>[0], opts: AiCallOptions = {}) =>
    getOrchestrator().transformAudio(req, runOpts('production', opts)),
  synthesizeSinging: (req: Parameters<Orchestrator['synthesizeSinging']>[0], opts: AiCallOptions = {}) =>
    getOrchestrator().synthesizeSinging(req, runOpts('vocals', opts)),
  regeneratePhrase: (req: Parameters<Orchestrator['regeneratePhrase']>[0], opts: AiCallOptions = {}) =>
    getOrchestrator().regeneratePhrase(req, runOpts('vocals', opts)),
  transcribe: (req: Parameters<Orchestrator['transcribe']>[0], opts: AiCallOptions = {}) =>
    getOrchestrator().transcribe(req, runOpts('transcription', opts)),
  separate: (req: Parameters<Orchestrator['separate']>[0], opts: AiCallOptions = {}) =>
    getOrchestrator().separate(req, runOpts('separation', opts)),
  master: (req: Parameters<Orchestrator['master']>[0], opts: AiCallOptions = {}) =>
    getOrchestrator().master(req, runOpts('mastering', opts)),
  convertVoice: (req: Parameters<Orchestrator['convertVoice']>[0], opts: AiCallOptions = {}) =>
    getOrchestrator().convertVoice(req, runOpts('voice-conversion', opts)),
};

// The provider registry, router and orchestrator are page-wide singletons: reload instead of hot-swapping.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
