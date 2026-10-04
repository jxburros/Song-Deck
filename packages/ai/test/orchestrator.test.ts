import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  CapabilityRouter,
  createInternalProvider,
  ProviderRegistry,
  BudgetManager,
  buildMusicContext,
  ConsentRequiredError,
  createManagedGatewayHandler,
  createManagedProvider,
  configFromPreset,
  MemoryBudgetPersistence,
  Orchestrator,
  PrivacyDeclinedError,
  ProviderError,
  toProvenanceRecord,
  type DataFlowDescriptor,
} from '../src';
import { bodyJson, depsWith, FAKE_WAV, jsonResponse, makeSong, mockFetch } from './helpers';
import { makeWorld, musicProvider } from './fixtures';

const T0 = Date.parse('2026-10-03T12:00:00Z');

function orchestratorFor(
  w: ReturnType<typeof makeWorld>,
  extra: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {},
) {
  let t = T0;
  return new Orchestrator({
    registry: w.registry,
    router: w.router,
    settings: () => w.settings,
    clock: { now: () => (t += 1000) },
    ...extra,
  });
}

describe('Orchestrator', () => {
  it('runs connected services without routine prompts but still asks for other providers and explicit checks', async () => {
    const w = makeWorld({ privacyConfirm: 'cloud', trustedProviderIds: ['gemini'] });
    const confirm = vi.fn(async () => true);
    const orch = orchestratorFor(w, { confirm });
    const ctx = buildMusicContext(makeSong(), { instruction: 'x' });
    await orch.explain({ context: ctx }, { providerId: 'gemini' });
    expect(confirm).not.toHaveBeenCalled();
    await orch.explain({ context: ctx }, { providerId: 'anthropic' });
    expect(confirm).toHaveBeenCalledTimes(1);
    w.settings.privacyConfirm = 'always';
    await orch.explain({ context: ctx }, { providerId: 'gemini' });
    expect(confirm).toHaveBeenCalledTimes(2);
    w.settings.privacyConfirm = 'cloud';
    await orchestratorFor(w, { confirm, forceConfirm: () => true }).explain(
      { context: ctx },
      { providerId: 'gemini' },
    );
    expect(confirm).toHaveBeenCalledTimes(3);
    w.settings.trustedProviderIds = [];
    await orch.explain({ context: ctx }, { providerId: 'gemini' });
    expect(confirm).toHaveBeenCalledTimes(4);
  });

  it('routes, executes and returns provenance + data flow', async () => {
    const w = makeWorld({ priorities: { quality: 1, cost: 0, latency: 0 } });
    const orch = orchestratorFor(w);
    const ctx = buildMusicContext(makeSong(), {
      instruction: 'Give the bass more movement',
      sectionId: 'sec_ch1',
    });
    const out = await orch.modifyComposition({ context: ctx }, { providerId: 'gemini' });
    expect(out.result.explanation).toBe('ok');
    expect(out.provenance).toMatchObject({
      role: 'midi-editing',
      providerId: 'gemini',
      providerName: 'Google Gemini',
      location: 'cloud',
      cloud: true,
      attempts: 1,
    });
    expect(out.provenance.costUsd).toBeCloseTo(0.001, 10); // actual cost reported by the provider
    expect(out.provenance.startedAt).toBe('2026-10-03T12:00:01.000Z');
    expect(out.dataFlow.items.filter((i) => i.included).map((i) => i.kind)).toEqual([
      'song-description',
      'chord-progression',
      'midi',
      'lyrics',
      'project-metadata',
    ]);
    expect(out.dataFlow.leavesDevice).toBe(true);
    // The LLM request carried routing hints.
    expect(w.gemini.fake.requests[0].hints).toMatchObject({ role: 'midi-editing', quality: 'standard' });
    const rec = toProvenanceRecord(out.provenance, {
      id: 'prov_1',
      artifactId: 'rev_9',
      artifactName: 'bass edit',
      artifactKind: 'midi',
      seed: 3,
    });
    expect(rec).toMatchObject({
      providerId: 'gemini',
      cloud: true,
      seed: 3,
      generatedAt: out.provenance.finishedAt,
      artifactKind: 'midi',
    });
  });

  it('asks for privacy confirmation for cloud requests and stops when declined', async () => {
    const w = makeWorld({ privacyConfirm: 'cloud', priorities: { quality: 1, cost: 0, latency: 0 } });
    const flows: DataFlowDescriptor[] = [];
    const confirm = vi.fn(async (flow: DataFlowDescriptor) => {
      flows.push(flow);
      return false;
    });
    const orch = orchestratorFor(w, { confirm });
    const ctx = buildMusicContext(makeSong(), { instruction: 'x' });
    await expect(
      orch.chat({ context: ctx, question: 'Why does the chorus feel weak?' }),
    ).rejects.toBeInstanceOf(PrivacyDeclinedError);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(flows[0].leavesDevice).toBe(true);
    expect(w.gemini.fake.requests.length + w.anthropic.fake.requests.length).toBe(0);
    // Local providers need no confirmation under 'cloud'.
    const local = await orch.chat({ context: ctx, question: 'q' }, { providerId: 'ollama' });
    expect(local.provenance.providerId).toBe('ollama');
    expect(confirm).toHaveBeenCalledTimes(1);
    // Without a confirm handler, cloud requests needing confirmation are declined (fail closed).
    const noHandler = orchestratorFor(w);
    await expect(
      noHandler.chat({ context: ctx, question: 'q' }, { providerId: 'gemini' }),
    ).rejects.toBeInstanceOf(PrivacyDeclinedError);
  });

  it('forceConfirm asks even when the privacy setting would not', async () => {
    const w = makeWorld({ privacyConfirm: 'never' });
    const confirm = vi.fn(async () => true);
    const forceConfirm = vi.fn((flow: DataFlowDescriptor) => flow.leavesDevice);
    const orch = orchestratorFor(w, { confirm, forceConfirm });
    const ctx = buildMusicContext(makeSong(), { instruction: 'x' });
    await orch.explain({ context: ctx }, { providerId: 'gemini' });
    expect(forceConfirm).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    await orch.explain({ context: ctx }, { providerId: 'ollama' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('privacyConfirm "audio" only asks when audio leaves the device', async () => {
    const w = makeWorld({ privacyConfirm: 'audio' });
    const confirm = vi.fn(async () => true);
    const orch = orchestratorFor(w, { confirm });
    const ctx = buildMusicContext(makeSong(), { instruction: 'x' });
    await orch.explain({ context: ctx }, { providerId: 'gemini' });
    expect(confirm).not.toHaveBeenCalled();
    w.gemini.fake.requests.length = 0;
    await orch
      .analyze(
        { audio: { mimeType: 'audio/wav', data: FAKE_WAV }, question: 'key?' },
        { providerId: 'gemini' },
      )
      .catch(() => undefined);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('enforces budgets and reports warnings; records spend', async () => {
    const w = makeWorld({ priorities: { quality: 1, cost: 0, latency: 0 } });
    const budget = new BudgetManager(
      { perGenerationUsd: 0.5, dailyUsd: 2, warningThreshold: 0.5 },
      new MemoryBudgetPersistence(),
      { now: () => T0, timeZone: 'utc' },
    );
    const orch = orchestratorFor(w, { budget });
    // 3 minutes on ElevenLabs @ $0.50/min → $1.50–$1.73 > $0.50 per generation.
    await expect(
      orch.generateMusic({ prompt: 'p', durationSeconds: 180 }, { providerId: 'elevenlabs-music' }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(w.eleven.calls).toBe(0);
    budget.setLimits({ perGenerationUsd: 5, dailyUsd: 2, warningThreshold: 0.5 });
    const out = await orch.generateMusic(
      { prompt: 'p', durationSeconds: 120 },
      { providerId: 'elevenlabs-music' },
    );
    expect(out.budgetWarning).toMatch(/daily spend would reach/);
    expect(out.provenance.costEstimated).toBe(true);
    expect(budget.totals().todayUsd).toBeGreaterThan(0.99);
    expect(budget.entries()[0]).toMatchObject({
      providerId: 'elevenlabs-music',
      role: 'production',
      estimated: true,
    });
    // The next generation would exceed the daily limit.
    await expect(
      orch.generateMusic({ prompt: 'p', durationSeconds: 120 }, { providerId: 'elevenlabs-music' }),
    ).rejects.toThrow(/daily limit/);
  });

  it('falls back to another provider when the low-confidence rule fires', async () => {
    const w = makeWorld({
      mode: 'rules',
      rules: [
        { kind: 'prefer-local' },
        { kind: 'fallback-if-low-confidence', threshold: 0.7, fallbackProviderId: 'gemini' },
      ],
      priorities: { quality: 1, cost: 0, latency: 0 },
    });
    // The local model answers with low confidence.
    w.registry.unregister('internal');
    w.ollama.fake.requests.length = 0;
    (w.ollama.fake as unknown as { replies: string[] }).replies.splice(
      0,
      1,
      '{"explanation":"unsure","confidence":0.4,"operations":[]}',
    );
    const events: string[] = [];
    const orch = orchestratorFor(w, { onEvent: (e) => events.push(e.type) });
    const ctx = buildMusicContext(makeSong(), { instruction: 'reharmonize the chorus' });
    const out = await orch.modifyComposition({ context: ctx });
    expect(w.ollama.fake.requests).toHaveLength(1);
    expect(w.gemini.fake.requests).toHaveLength(1);
    expect(out.provenance.providerId).toBe('gemini');
    expect(out.provenance.fallbackFrom).toBe('ollama');
    expect(out.provenance.fallbackReason).toMatch(/confidence 40% < 70%/);
    expect(out.provenance.attempts).toBe(2);
    expect(out.result.confidence).toBe(0.9);
    expect(events).toEqual(expect.arrayContaining(['routed', 'started', 'fallback', 'succeeded']));
    // The fallback respects privacy: offline → no fallback, original result kept.
    w.settings.offline = true;
    const offline = await orch.modifyComposition({ context: ctx });
    expect(offline.provenance.providerId).toBe('ollama');
    expect(offline.result.confidence).toBe(0.4);
  });

  it('tries the next provider when one is unavailable', async () => {
    const w = makeWorld({ priorities: { quality: 1, cost: 0, latency: 0 } });
    w.registry.unregister('elevenlabs-music');
    w.registry.register(
      musicProvider('elevenlabs-music', 'cloud', ['TEXT_TO_MUSIC', 'INSTRUMENTAL_ONLY'], {
        tier: 5,
        fail: new ProviderError('unavailable', 'HTTP 503'),
      }),
    );
    const orch = orchestratorFor(w);
    const out = await orch.generateMusic({ prompt: 'p', durationSeconds: 30, instrumental: true });
    expect(out.provenance.providerId).toBe('ace-step-local');
    expect(out.attempts[0]).toMatchObject({ providerId: 'elevenlabs-music', error: 'HTTP 503' });
    expect(out.provenance.attempts).toBe(2);
    // Explicit provider requests do not silently switch providers.
    await expect(
      orch.generateMusic(
        { prompt: 'p', durationSeconds: 30, instrumental: true },
        { providerId: 'elevenlabs-music' },
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('applies timeouts and cancellation', async () => {
    const w = makeWorld();
    const orch = orchestratorFor(w);
    const never = () => new Promise<never>(() => undefined);
    await expect(orch.run({ role: 'mastering', timeoutMs: 20, execute: never })).rejects.toMatchObject({
      kind: 'timeout',
    });
    const ac = new AbortController();
    const p = orch.run({ role: 'mastering', signal: ac.signal, execute: never });
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('voice conversion requires consent before routing', async () => {
    const w = makeWorld();
    const orch = orchestratorFor(w);
    await expect(
      orch.convertVoice({
        audio: { mimeType: 'audio/wav', data: FAKE_WAV },
        targetVoice: { id: 'celebrity', kind: 'third-party' },
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });
});

describe('Managed "Automatic" gateway', () => {
  it('serves LLM and audio requests through the server orchestrator, honoring privacy', async () => {
    const w = makeWorld({ priorities: { quality: 1, cost: 0, latency: 0 } });
    const handler = createManagedGatewayHandler(orchestratorFor(w));
    // Client side: managed adapter whose transport calls the handler directly.
    const transport = {
      kind: 'test',
      async fetch(url: string, init: RequestInit = {}) {
        const out = await handler(
          new URL(url, 'http://localhost').pathname,
          JSON.parse(String(init.body ?? '{}')),
          init.signal ?? undefined,
        );
        if (out.bytes)
          return new Response(new Uint8Array(out.bytes), {
            status: out.status,
            headers: {
              'content-type': out.contentType ?? 'application/octet-stream',
              ...(out.headers ?? {}),
            },
          });
        return new Response(JSON.stringify(out.json), {
          status: out.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const managed = createManagedProvider(configFromPreset('managed', { baseUrl: 'http://localhost' }), {
      transport,
      retry: { baseDelayMs: 0 },
    });
    const res = await managed.llm!.complete({
      messages: [{ role: 'user', content: 'Plan a song' }],
      hints: { role: 'composition', quality: 'final' },
    });
    expect(res.text).toContain('"explanation":"ok"');
    // Final quality routes to a top-tier cloud model of the SERVER (exactly one call).
    expect(w.gemini.fake.requests.length + w.anthropic.fake.requests.length).toBe(1);
    expect(w.ollama.fake.requests).toHaveLength(0);

    // Never-upload of recorded vocals keeps audio analysis off third-party clouds → 503 with reasons.
    const blocked = await managed
      .llm!.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'audio', audio: { mimeType: 'audio/wav', data: FAKE_WAV } },
              { type: 'text', text: 'analyze' },
            ],
          },
        ],
        hints: { role: 'analysis', dataKinds: ['recorded-vocals'], neverUpload: ['recorded-vocals'] },
      })
      .catch((e) => e);
    expect(blocked).toBeInstanceOf(ProviderError);
    expect((blocked as ProviderError).status).toBe(503);

    // Audio: production routed among the server's providers; bytes + provenance headers come back.
    const audio = await managed.audioGeneration!.generateMusic({
      prompt: 'anthemic chorus',
      durationSeconds: 30,
      instrumental: true,
      hints: { quality: 'final' },
    });
    expect([...audio.audio.data]).toEqual([...FAKE_WAV]);
    expect(audio.model).toBe('elevenlabs-music-model');
    // Draft quality + localOnly-like privacy goes local.
    const draft = await managed.audioGeneration!.generateMusic({
      prompt: 'demo',
      durationSeconds: 30,
      instrumental: true,
      guideAudio: { mimeType: 'audio/wav', data: FAKE_WAV },
      hints: { quality: 'draft' },
    });
    expect(draft.model).toBe('ace-step-local-model');

    const models = await handler('/api/managed/models', {});
    expect((models.json as { capabilities: string[] }).capabilities).toEqual(
      expect.arrayContaining(['TEXT_TO_MUSIC', 'MIDI_EDITING']),
    );
    expect((await handler('/api/managed/nope', {})).status).toBe(404);
    expect((await handler('/api/managed/audio', { request: { op: 'bogus' } })).status).toBe(400);
  });
});

describe('end-to-end: settings → registry → router → orchestrator → adapter', () => {
  it('modifies a composition through the Anthropic adapter with privacy confirmation and budget', async () => {
    const reply = {
      id: 'msg_e2e',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            explanation: 'Walking bass in the chorus',
            confidence: 0.82,
            operations: [
              {
                op: 'replace_notes',
                track: 'Bass',
                start_bar: 13,
                end_bar: 13,
                notes: [
                  { pitch: 'E2', bar: 13, beat: 1, duration_beats: 1, velocity: 96 },
                  { pitch: 'G2', bar: 13, beat: 2, duration_beats: 1, velocity: 90 },
                ],
                reason: 'movement',
              },
            ],
          }),
        },
      ],
      stop_reason: 'end_turn',
      stop_details: null,
      usage: { input_tokens: 4000, output_tokens: 600 },
    };
    const m = mockFetch(() => jsonResponse(reply));
    const registry = new ProviderRegistry({
      deps: depsWith(m.fetch, { 'provider:anthropic': 'sk-ant-e2e-0123456789abcdef' }),
    });
    registry.register(createInternalProvider({ capabilities: ['MIXING'] }));
    registry.configure([configFromPreset('anthropic')]);
    const settings = {
      mode: 'manual' as const,
      profileId: 'final-production',
      rules: [],
      offline: false,
      neverUpload: [],
      priorities: { quality: 0.5, cost: 0.3, latency: 0.2 },
      privacyConfirm: 'cloud' as const,
    };
    const router = new CapabilityRouter(registry, { settings });
    const budget = new BudgetManager({ dailyUsd: 10, warningThreshold: 0.8 }, new MemoryBudgetPersistence(), {
      timeZone: 'utc',
    });
    const flows: string[] = [];
    const orch = new Orchestrator({
      registry,
      router,
      budget,
      confirm: async (flow) => (
        flows.push(
          `${flow.providerName}:${flow.items
            .filter((i) => i.included)
            .map((i) => i.kind)
            .join(',')}`,
        ),
        true
      ),
    });
    const ctx = buildMusicContext(makeSong(), {
      instruction: 'Give the bass a walking line in the chorus',
      sectionId: 'sec_ch1',
    });
    const out = await orch.modifyComposition({ context: ctx });

    expect(out.decision.reasons[0]).toBe('Assigned in profile "Final Production"');
    expect(flows).toEqual(['Anthropic:song-description,chord-progression,midi,lyrics,project-metadata']);
    expect(out.result.operations).toEqual([
      {
        op: 'replace_notes',
        track: 'Bass',
        region: { start_bar: 13, end_bar: 13 },
        notes: [
          { pitch: 40, bar: 13, beat: 1, duration_beats: 1, velocity: 96 },
          { pitch: 43, bar: 13, beat: 2, duration_beats: 1, velocity: 90 },
        ],
        reason: 'movement',
      },
    ]);
    expect(out.provenance).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
      cloud: true,
    });
    expect(out.provenance.costUsd).toBeCloseTo((4000 * 4 + 600 * 20) / 1e6, 10);
    expect(budget.totals().todayUsd).toBeCloseTo(0.028, 10);
    const body = bodyJson(m.calls[0]) as Record<string, any>;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.messages[0].content).toContain('INSTRUCTION: Give the bass a walking line in the chorus');
    expect(body.system).toContain('Music IR conventions');
  });
});
