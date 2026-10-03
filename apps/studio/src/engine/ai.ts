import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import {
  BUILTIN_GENRES,
  BUILTIN_INSTRUMENTS,
  defaultMacros,
  getInstrument,
  parseChordSymbol,
  parsePromptToBlueprint,
  planComposition,
  randomSeed,
  type Blueprint,
  type CompositionPlan,
  type EditSelection,
  type Song,
} from '@songdeck/core';
import {
  BudgetManager,
  CapabilityRouter,
  DEFAULT_ROUTING_SETTINGS,
  DirectTransport,
  MemoryCredentialStore,
  Orchestrator,
  ProviderRegistry,
  ROLE_INFO,
  ServerProxyTransport,
  ServerVaultClient,
  buildMusicContext,
  contextDataKinds,
  toProvenanceRecord,
  type ArtifactInfo,
  type ChatMessage as AiChatMessage,
  type Capability,
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

export const useAiRuntime = create<AiRuntimeState>(() => ({ version: 0, providers: [], transport: 'direct', events: [] }));

/** Session-only secrets when no local server is running (never persisted, spec §7). */
export const sessionCredentials = new MemoryCredentialStore();

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
  return new DirectTransport(sessionCredentials);
}

function bump() {
  const s = useAiRuntime.getState();
  useAiRuntime.setState({ version: s.version + 1, providers: registry?.list() ?? [], transport: transportKind });
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
  const deps = { transport: currentTransport(), credentials: sessionCredentials };
  // The managed "Automatic" gateway runs on the local server: an empty base URL means that server.
  const base = serverBase();
  const providers = useSettings.getState().providers.map((p) => (p.adapter === 'managed' && !p.baseUrl?.trim() && base ? { ...p, baseUrl: base } : p));
  const result = registry.configure(providers, deps);
  for (const e of result.errors) console.warn(`[ai] provider ${e.id}: ${e.error}`);
  bump();
  void syncProvidersToServer();
}

export function initAi(): void {
  if (registry) return;
  registry = new ProviderRegistry({ deps: { transport: currentTransport(), credentials: sessionCredentials } });
  for (const p of createInternalProviders({
    song: () => useStudio.getState().project?.song ?? null,
    selection: () => useStudio.getState().selection,
    seed: () => randomSeed(),
  })) {
    registry.register(p);
  }
  router = new CapabilityRouter(registry, { settings: routingSettings, profiles: () => useSettings.getState().customProfiles });
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
          confirmLabel: 'Send',
        },
      }),
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
    if (s.providers !== prev.providers || s.useServerProxy !== prev.useServerProxy || s.serverUrl !== prev.serverUrl) configureProviders();
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
// Credentials (BYOK, spec §7): server vault (OS keychain) when available, else session memory.
// ---------------------------------------------------------------------------

export async function refreshVaultStatus(): Promise<void> {
  try {
    const st = await new ServerVaultClient(serverBase()).status();
    useAiRuntime.setState({ vaultBackend: st.backend });
  } catch {
    useAiRuntime.setState({ vaultBackend: undefined });
  }
}

export async function saveCredential(ref: string, secret: string, label?: string): Promise<'vault' | 'session'> {
  if (useRuntime.getState().server.status === 'online' && useSettings.getState().useServerProxy) {
    await new ServerVaultClient(serverBase()).setSecret(ref, secret, label);
    await syncProvidersToServer();
    return 'vault';
  }
  await sessionCredentials.set(ref, secret, label);
  return 'session';
}

export async function deleteCredential(ref: string): Promise<void> {
  if (useRuntime.getState().server.status === 'online') {
    try {
      await new ServerVaultClient(serverBase()).deleteSecret(ref);
    } catch {
      /* not in vault */
    }
  }
  await sessionCredentials.delete(ref);
}

export async function hasCredential(ref: string): Promise<boolean> {
  if (useRuntime.getState().server.status === 'online' && useSettings.getState().useServerProxy) {
    try {
      return await new ServerVaultClient(serverBase()).has(ref);
    } catch {
      return false;
    }
  }
  return (await sessionCredentials.get(ref)) !== undefined;
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

/**
 * Capability sets that can serve a role, in order of preference. Production can be done by
 * generating from text, or by performing the composition (MIDI or stem conditioning, audio to
 * audio) — the on-device producer does the latter (spec §29-§30, §38).
 */
const ROLE_CAPABILITY_SETS: Partial<Record<TaskRole, Capability[][]>> = {
  production: [['TEXT_TO_MUSIC'], ['MIDI_CONDITIONING'], ['STEM_CONDITIONING'], ['AUDIO_TO_AUDIO']],
};

/** Options for a provider picker: Auto, on-device engine, and every compatible provider. */
export function roleOptions(role: TaskRole): RoleOption[] {
  const reg = getRegistry();
  const info = ROLE_INFO[role];
  const sets = ROLE_CAPABILITY_SETS[role] ?? [info.capabilities];
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
  if (internalId && reg.has(internalId)) out.push({ value: 'internal', label: `${reg.get(internalId)!.descriptor.name}`, location: 'internal' });
  const seen = new Set<string>();
  const compatible = sets.flatMap((capabilities) => reg.findCompatible(capabilities, { interface: info.interface, includeUnavailable: true }));
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
export function recordProvenance(p: RunProvenance, artifact: Omit<ArtifactInfo, 'id'> & { id?: string }): void {
  const rec = toProvenanceRecord(p, { id: artifact.id ?? `prov_${Date.now().toString(36)}`, ...artifact });
  if (p.costUsd !== undefined) rec.costUsd = p.costUsd;
  useStudio.getState().addProvenance(rec);
}

// ---------------------------------------------------------------------------
// Composition (spec §10, §15)
// ---------------------------------------------------------------------------

/** Merge a model-produced blueprint onto the deterministic one so it is always complete and valid. */
export function sanitizeBlueprint(candidate: Partial<Blueprint> | undefined, prompt: string, seed: number): Blueprint {
  const base = parsePromptToBlueprint(prompt, { seed, customGenres: allCustomGenres() });
  if (!candidate) return base;
  const knownInstruments = new Set([...BUILTIN_INSTRUMENTS, ...allCustomInstruments()].map((i) => i.id));
  const knownGenres = new Set([...BUILTIN_GENRES, ...allCustomGenres()].map((g) => g.id));
  const tempo = Number(candidate.tempo);
  const bp: Blueprint = {
    ...base,
    title: typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : base.title,
    prompt,
    tempo: Number.isFinite(tempo) && tempo >= 30 && tempo <= 300 ? Math.round(tempo) : base.tempo,
    meter: candidate.meter && candidate.meter.numerator > 0 && [2, 4, 8, 16].includes(candidate.meter.denominator) ? candidate.meter : base.meter,
    key: candidate.key && Number.isInteger(candidate.key.tonic) && candidate.key.tonic >= 0 && candidate.key.tonic < 12 ? candidate.key : base.key,
    styles: Array.isArray(candidate.styles) && candidate.styles.length ? candidate.styles.map(String) : base.styles,
    genreBlend: (candidate.genreBlend ?? []).filter((g) => knownGenres.has(g.genreId) && g.weight > 0),
    moods: Array.isArray(candidate.moods) && candidate.moods.length ? candidate.moods.map(String) : base.moods,
    instrumentation: (candidate.instrumentation ?? [])
      .filter((t) => t && typeof t.name === 'string')
      .map((t) => ({ ...t, instrumentId: knownInstruments.has(t.instrumentId) ? t.instrumentId : getInstrument(t.instrumentId, allCustomInstruments()).id })),
    structure: (candidate.structure ?? [])
      .filter((s) => s && typeof s.name === 'string')
      .map((s) => ({ ...s, bars: Math.max(1, Math.min(64, Math.round(Number(s.bars) || 8))), energy: Math.max(0, Math.min(100, Number(s.energy ?? 50))) })),
    vocal: candidate.vocal ?? base.vocal,
    lyricsTheme: candidate.lyricsTheme ?? base.lyricsTheme,
    macros: { ...defaultMacros(), ...base.macros, ...(candidate.macros ?? {}) },
    seed,
  };
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

export async function aiDesignBlueprint(prompt: string, opts: AiCallOptions & { seed: number }): Promise<{ blueprint: Blueprint; source: string; provenance: RunProvenance }> {
  const r = await runRole('composition', {
    ...opts,
    dataKinds: ['song-description'],
    estimateInput: { kind: 'llm', role: 'composition', inputChars: prompt.length + 6000 },
    title: 'Design Song Blueprint',
    execute: async (instance, model, signal) => {
      const res = await instance.composition!.designBlueprint({
        prompt,
        model,
        signal,
        defaults: { seed: opts.seed, macros: defaultMacros() },
        genres: [...BUILTIN_GENRES, ...allCustomGenres()].map((g) => ({ id: g.id, name: g.name })),
        instruments: [...BUILTIN_INSTRUMENTS, ...allCustomInstruments()].map((i) => ({ id: i.id, name: i.name, family: i.family })),
      });
      return { ...res, blueprint: instance.descriptor.location === 'internal' ? res.blueprint : sanitizeBlueprint(res.blueprint, prompt, opts.seed) };
    },
  });
  return { blueprint: r.result.blueprint, source: sourceLabel(r.provenance), provenance: r.provenance };
}

export async function aiPlanSong(blueprint: Blueprint, opts: AiCallOptions & { seed: number }): Promise<{ plan: CompositionPlan; source: string; provenance: RunProvenance }> {
  const r = await runRole('composition', {
    ...opts,
    dataKinds: ['song-description', 'chord-progression'],
    estimateInput: { kind: 'llm', role: 'composition', inputChars: JSON.stringify(blueprint).length + 6000 },
    title: 'Plan composition',
    execute: async (instance, model, signal) => {
      const res = await instance.composition!.planSong({ blueprint: { ...blueprint, seed: opts.seed }, model, signal });
      return { ...res, plan: sanitizePlan(res.plan, { ...blueprint, seed: opts.seed }) };
    },
  });
  return { plan: { ...r.result.plan, source: r.provenance.providerName }, source: sourceLabel(r.provenance), provenance: r.provenance };
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
    execute: (instance, model, signal) => instance.composition!.modifyComposition({ context, instruction, model, signal }),
  });
  const res = r.result;
  const errors = res.errors.length ? `\n(${res.errors.length} invalid operation${res.errors.length > 1 ? 's were' : ' was'} dropped)` : '';
  const proposal = propose(song, res.operations, {
    title: instruction,
    source: r.provenance.location === 'internal' ? 'internal' : r.provenance.providerName,
    modelId: r.provenance.modelId,
    instruction,
    explanation: `${res.explanation}${errors}`,
  }, { openPianoRoll: true });
  return { explanation: `${res.explanation}${errors}`, source: sourceLabel(r.provenance), proposalCreated: !!proposal };
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
    estimateInput: { kind: 'llm', role: 'chat', inputChars: JSON.stringify(context).length + question.length },
    title: 'Assistant',
    execute: (instance, model, signal) => instance.composition!.chat({ context, history: prior, question, model, signal }),
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
  const suggestions = r.result.suggestions?.length ? `\n\nYou could also ask: ${r.result.suggestions.slice(0, 3).join(' · ')}` : '';
  return { answer: `${r.result.answer}${suggestions}`, source: sourceLabel(r.provenance), proposalId };
}

export async function aiExplain(song: Song, sectionId: string, opts: AiCallOptions): Promise<{ text: string; source: string }> {
  const context = buildMusicContext(song, { instruction: 'Explain the harmony and musical function of this section.', sectionId });
  const r = await runRole('analysis', {
    ...opts,
    dataKinds: contextDataKinds(context) as DataKind[],
    estimateInput: { kind: 'llm', role: 'analysis', inputChars: JSON.stringify(context).length },
    title: 'Explain music',
    execute: (instance, model, signal) => instance.composition!.explainMusic({ context, sectionId, model, signal }),
  });
  const s = r.result.suggestions?.length ? `\n\nIdeas:\n• ${r.result.suggestions.join('\n• ')}` : '';
  return { text: `${r.result.explanation}${s}`, source: sourceLabel(r.provenance) };
}

export async function aiMix(song: Song, instruction: string, opts: AiCallOptions): Promise<{ explanation: string; source: string; proposalCreated: boolean; proposalId?: string }> {
  const context = buildMusicContext(song, { instruction, includeMixer: true });
  const r = await runRole('mixing', {
    ...opts,
    dataKinds: ['song-description', 'project-metadata'],
    estimateInput: { kind: 'llm', role: 'mixing', inputChars: JSON.stringify(context).length },
    title: instruction,
    execute: (instance, model, signal) => instance.composition!.mixAssist({ context, instruction, model, signal }),
  });
  const p = propose(song, r.result.operations, {
    title: instruction,
    source: r.provenance.location === 'internal' ? 'internal' : r.provenance.providerName,
    modelId: r.provenance.modelId,
    instruction,
    explanation: r.result.explanation,
  });
  return { explanation: r.result.explanation, source: sourceLabel(r.provenance), proposalCreated: !!p, proposalId: p?.id };
}

export async function aiLyrics(
  song: Song,
  sections: { sectionId: string; name: string; kind?: Song['sections'][number]['kind']; lines: number; syllables?: number[]; existing?: string[]; locked?: boolean }[],
  opts: AiCallOptions & { theme?: string; style?: string; instruction?: string },
): Promise<{ sections: { sectionId: string; lines: string[] }[]; source: string; provenance: RunProvenance; notes?: string }> {
  const context = buildMusicContext(song, { instruction: opts.instruction ?? 'Write lyrics that fit these sections.' });
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
        sections: sections.map((s) => ({ name: s.name, kind: s.kind, lines: s.lines, syllables: s.syllables, existing: s.existing, locked: s.locked })),
        model,
        signal,
      }),
  });
  const out = sections.map((s, i) => ({
    sectionId: s.sectionId,
    lines: (r.result.sections.find((x) => x.section === s.name) ?? r.result.sections[i])?.lines ?? [],
  }));
  return { sections: out, source: sourceLabel(r.provenance), provenance: r.provenance, notes: r.result.notes };
}

// ---------------------------------------------------------------------------
// Audio roles: thin wrappers over the orchestrator for Produce, Vocals, Transcribe, Rebuild, Master.
// ---------------------------------------------------------------------------

function runOpts(role: TaskRole, opts: AiCallOptions) {
  return { providerId: providerIdFor(role, opts.providerChoice), signal: opts.signal, quality: opts.quality, neverUpload: projectNeverUpload() };
}

export const aiAudio = {
  generateMusic: (req: Parameters<Orchestrator['generateMusic']>[0], opts: AiCallOptions = {}) => getOrchestrator().generateMusic(req, runOpts('production', opts)),
  transformAudio: (req: Parameters<Orchestrator['transformAudio']>[0], opts: AiCallOptions = {}) => getOrchestrator().transformAudio(req, runOpts('production', opts)),
  synthesizeSinging: (req: Parameters<Orchestrator['synthesizeSinging']>[0], opts: AiCallOptions = {}) => getOrchestrator().synthesizeSinging(req, runOpts('vocals', opts)),
  regeneratePhrase: (req: Parameters<Orchestrator['regeneratePhrase']>[0], opts: AiCallOptions = {}) => getOrchestrator().regeneratePhrase(req, runOpts('vocals', opts)),
  transcribe: (req: Parameters<Orchestrator['transcribe']>[0], opts: AiCallOptions = {}) => getOrchestrator().transcribe(req, runOpts('transcription', opts)),
  separate: (req: Parameters<Orchestrator['separate']>[0], opts: AiCallOptions = {}) => getOrchestrator().separate(req, runOpts('separation', opts)),
  master: (req: Parameters<Orchestrator['master']>[0], opts: AiCallOptions = {}) => getOrchestrator().master(req, runOpts('mastering', opts)),
  convertVoice: (req: Parameters<Orchestrator['convertVoice']>[0], opts: AiCallOptions = {}) => getOrchestrator().convertVoice(req, runOpts('voice-conversion', opts)),
};
