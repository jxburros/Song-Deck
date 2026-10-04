import { describe, expect, it } from 'vitest';
import {
  CapabilityRouter,
  configFromPreset,
  createManagedProvider,
  NoCompatibleProviderError,
  ProviderRegistry,
  type RouteRequest,
  type RoutingSettings,
} from '../src';
import { makeWorld } from './fixtures';
import { depsWith, jsonResponse, mockFetch } from './helpers';

const QUALITY_FIRST: RoutingSettings = {
  mode: 'automatic',
  rules: [],
  offline: false,
  neverUpload: [],
  priorities: { quality: 1, cost: 0, latency: 0 },
  privacyConfirm: 'never',
};

const llmEstimate: RouteRequest['estimateInput'] = { kind: 'llm', role: 'midi-editing', inputChars: 20_000 };

describe('CapabilityRouter — automatic', () => {
  it('scores by quality/cost/latency priorities', () => {
    const w = makeWorld({ priorities: { quality: 1, cost: 0, latency: 0 } });
    const d = w.router.select({ role: 'midi-editing', estimateInput: llmEstimate });
    expect(['anthropic', 'gemini']).toContain(d.providerId);
    expect(d.location).toBe('cloud');
    expect(d.alternatives.map((a) => a.providerId)).toEqual(expect.arrayContaining(['ollama', 'internal']));

    w.settings.priorities = { quality: 0, cost: 1, latency: 0 };
    const cheap = w.router.select({ role: 'midi-editing', estimateInput: llmEstimate });
    expect(cheap.location).not.toBe('cloud');
    expect(['ollama', 'internal']).toContain(cheap.providerId);
  });

  it('final quality weighs quality more; estimates are attached', () => {
    const w = makeWorld({ priorities: { quality: 0.4, cost: 0.4, latency: 0.2 } });
    const d = w.router.select({
      role: 'composition',
      quality: 'final',
      estimateInput: { kind: 'llm', role: 'composition', inputChars: 8000 },
    });
    expect(d.location).toBe('cloud');
    expect(d.estimate.known).toBe(true);
    expect(d.estimate.maxUsd).toBeGreaterThan(0);
    expect(d.reasons[0]).toBe('Automatic routing');
  });

  it('uses the profile as a hint in automatic mode', () => {
    const w = makeWorld({
      profileId: 'final-production',
      priorities: { quality: 0.5, cost: 0.5, latency: 0 },
    });
    const d = w.router.select({ role: 'composition', estimateInput: llmEstimate });
    expect(d.providerId).toBe('anthropic');
    expect(d.reasons.join(' ')).toContain('preferred by profile "Final Production"');
  });
});

describe('CapabilityRouter — manual', () => {
  it('uses the profile assignment (preset ids resolve to registered providers)', () => {
    const w = makeWorld({ mode: 'manual', profileId: 'final-production' });
    const d = w.router.select({ role: 'composition' });
    expect(d.providerId).toBe('anthropic');
    expect(d.modelId).toBe('claude-opus-5-5');
    expect(d.reasons[0]).toContain('Assigned in profile "Final Production"');
    expect(w.router.select({ role: 'analysis' }).providerId).toBe('gemini');
    expect(w.router.select({ role: 'production', capabilities: ['TEXT_TO_MUSIC'] }).providerId).toBe(
      'elevenlabs-music',
    );
    expect(w.router.select({ role: 'mixing' }).providerId).toBe('internal');
  });

  it('falls back to the internal engine when the assigned provider is missing', () => {
    const w = makeWorld({ mode: 'manual', profileId: 'cloud-quality' });
    // cloud-quality assigns composition to "openai", which is not installed.
    const d = w.router.select({ role: 'composition' });
    expect(d.providerId).toBe('internal');
    expect(d.reasons[0]).toMatch(
      /Assigned provider openai unavailable \(not installed\) — using the internal engine/,
    );
    w.settings.fallbackToInternal = false;
    expect(() => w.router.select({ role: 'composition' })).toThrow(NoCompatibleProviderError);
  });

  it('a disabled role throws a NoCompatibleProviderError', () => {
    const w = makeWorld({ mode: 'manual', profileId: 'cheap-draft' });
    expect(() => w.router.select({ role: 'vocals' })).toThrow(/disabled in profile "Cheap Draft"/);
  });
});

describe('CapabilityRouter — rules', () => {
  it('prefer-local: use local models whenever possible', () => {
    const w = makeWorld({
      mode: 'rules',
      rules: [{ kind: 'prefer-local' }],
      priorities: { quality: 1, cost: 0, latency: 0 },
    });
    const d = w.router.select({ role: 'chat', estimateInput: llmEstimate });
    expect(d.location).not.toBe('cloud');
    expect(d.reasons.join(' ')).toContain('use local models whenever possible');
  });

  it('prefer-provider for a role (with model)', () => {
    const w = makeWorld({
      mode: 'rules',
      rules: [{ kind: 'prefer-provider', role: 'harmony', providerId: 'ollama', modelId: 'llama3.1:8b' }],
    });
    const d = w.router.select({ role: 'harmony' });
    expect(d.providerId).toBe('ollama');
    expect(d.modelId).toBe('llama3.1:8b');
  });

  it('cloud-only-for-final: drafts stay local, final renders may use the cloud', () => {
    const w = makeWorld({
      mode: 'rules',
      rules: [{ kind: 'cloud-only-for-final', roles: ['production'] }],
      priorities: { quality: 1, cost: 0, latency: 0 },
    });
    const draft = w.router.select({
      role: 'production',
      quality: 'draft',
      estimateInput: { kind: 'audio', durationSeconds: 120 },
    });
    expect(draft.providerId).toBe('ace-step-local');
    const final = w.router.select({
      role: 'production',
      quality: 'final',
      estimateInput: { kind: 'audio', durationSeconds: 120 },
    });
    expect(final.providerId).toBe('elevenlabs-music');
    const ev = w.router.evaluate({ role: 'production', quality: 'standard' });
    expect(ev.excluded.find((x) => x.providerId === 'elevenlabs-music')!.reasons).toContain(
      'rule: cloud production only for final renders',
    );
  });

  it('max-cost excludes candidates whose estimate exceeds the limit', () => {
    const w = makeWorld({
      mode: 'rules',
      rules: [{ kind: 'max-cost', usd: 0.5 }],
      priorities: { quality: 1, cost: 0, latency: 0 },
    });
    const d = w.router.select({ role: 'production', estimateInput: { kind: 'audio', durationSeconds: 180 } });
    expect(d.providerId).toBe('ace-step-local');
    const ev = w.router.evaluate({
      role: 'production',
      estimateInput: { kind: 'audio', durationSeconds: 180 },
    });
    expect(ev.excluded.find((x) => x.providerId === 'elevenlabs-music')!.reasons[0]).toMatch(
      /exceeds max cost \$0\.50/,
    );
  });
});

describe('CapabilityRouter — privacy, offline and capability negotiation', () => {
  it('offline mode allows only local/internal providers', () => {
    const w = makeWorld({ offline: true, priorities: { quality: 1, cost: 0, latency: 0 } });
    const d = w.router.select({ role: 'midi-editing' });
    expect(d.location).not.toBe('cloud');
    const ev = w.router.evaluate({ role: 'midi-editing' });
    for (const id of ['gemini', 'anthropic'])
      expect(ev.excluded.find((x) => x.providerId === id)!.reasons).toContain(
        'offline mode: cloud providers are disabled',
      );
    // Audio understanding is only available in the cloud → no compatible provider offline.
    expect(() => w.router.select({ role: 'analysis', capabilities: ['AUDIO_UNDERSTANDING'] })).toThrow(
      NoCompatibleProviderError,
    );
  });

  it('"never upload recorded vocals" excludes cloud providers for requests containing them', () => {
    const w = makeWorld({
      neverUpload: ['recorded-vocals'],
      priorities: { quality: 1, cost: 0, latency: 0 },
    });
    const err = (() => {
      try {
        w.router.select({
          role: 'analysis',
          capabilities: ['AUDIO_UNDERSTANDING'],
          dataKinds: ['recorded-vocals'],
        });
      } catch (e) {
        return e as NoCompatibleProviderError;
      }
      return undefined;
    })()!;
    expect(err).toBeInstanceOf(NoCompatibleProviderError);
    expect(err.excluded.find((x) => x.providerId === 'gemini')!.reasons).toContain(
      'never upload: recorded vocals',
    );
    // Same request without vocals may go to Gemini.
    expect(
      w.router.select({
        role: 'analysis',
        capabilities: ['AUDIO_UNDERSTANDING'],
        dataKinds: ['reference-audio'],
      }).providerId,
    ).toBe('gemini');
    // The never-upload rule works the same way.
    const w2 = makeWorld({
      mode: 'rules',
      rules: [{ kind: 'never-upload', dataKinds: ['recorded-vocals'] }],
    });
    expect(() =>
      w2.router.select({
        role: 'analysis',
        capabilities: ['AUDIO_UNDERSTANDING'],
        dataKinds: ['recorded-vocals'],
      }),
    ).toThrow(NoCompatibleProviderError);
  });

  it('NoCompatibleProviderError lists why each candidate was excluded', () => {
    const w = makeWorld();
    w.registry.setStatus('anthropic', 'unconfigured', 'No API key configured');
    try {
      w.router.select({ role: 'vocals' });
      throw new Error('expected failure');
    } catch (e) {
      const err = e as NoCompatibleProviderError;
      expect(err).toBeInstanceOf(NoCompatibleProviderError);
      expect(err.requirements).toEqual(['SINGING_SYNTHESIS']);
      const byId = Object.fromEntries(err.excluded.map((x) => [x.providerId, x.reasons]));
      expect(byId.ollama).toEqual(['does not provide singing', 'missing Singing synthesis']);
      expect(byId.anthropic).toContain('status: unconfigured (No API key configured)');
      expect(byId['ace-step-local'][0]).toBe('does not provide singing');
      expect(err.message).toContain('No compatible provider for vocals');
    }
  });

  it('findCompatible answers "which installed provider can perform this?" (spec §59)', () => {
    const w = makeWorld();
    const res = w.registry.findCompatible(['TEXT_TO_MUSIC', 'LYRIC_CONDITIONING', 'VOCAL_GENERATION']);
    expect(res.map((r) => r.providerId)).toEqual(['elevenlabs-music', 'ace-step-local']);
    expect(w.registry.findCompatible(['AUDIO_TO_AUDIO']).map((r) => r.providerId)).toEqual([
      'ace-step-local',
    ]);
    expect(
      w.registry.findCompatible([
        'SINGING_SYNTHESIS',
        'MIDI_CONDITIONING',
        'LYRIC_CONDITIONING',
        'REGION_GENERATION',
      ]),
    ).toEqual([]);
  });

  it('model-level capabilities choose a compatible model', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      descriptor: {
        id: 'oa',
        name: 'OpenAI',
        adapter: 'openai-compatible',
        location: 'cloud',
        capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING', 'AUDIO_INPUT', 'AUDIO_UNDERSTANDING'],
        qualityTier: 5,
      },
      llm: {
        listModels: async () => [
          { id: 'gpt-text', capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING'], qualityTier: 5 },
          {
            id: 'gpt-audio',
            capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING', 'AUDIO_INPUT', 'AUDIO_UNDERSTANDING'],
            qualityTier: 4,
          },
        ],
        complete: async () => ({ text: '', model: 'x', stopReason: 'end_turn' }),
      },
    });
    await registry.discoverModels('oa');
    const router = new CapabilityRouter(registry, {
      settings: {
        mode: 'automatic',
        rules: [],
        offline: false,
        neverUpload: [],
        priorities: { quality: 1, cost: 0, latency: 0 },
        privacyConfirm: 'never',
      },
    });
    expect(router.select({ role: 'analysis' }).modelId).toBe('gpt-text');
    expect(router.select({ role: 'analysis', capabilities: ['AUDIO_UNDERSTANDING'] }).modelId).toBe(
      'gpt-audio',
    );
    expect(registry.findCompatible(['AUDIO_UNDERSTANDING'])[0].models.map((m) => m.id)).toEqual([
      'gpt-audio',
    ]);
  });

  it('multi-interface providers (managed) stay routable for audio after LLM model discovery', async () => {
    const m = mockFetch(() =>
      jsonResponse({
        capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING', 'MIDI_EDITING', 'TEXT_TO_MUSIC'],
      }),
    );
    const registry = new ProviderRegistry();
    registry.register(
      createManagedProvider(
        configFromPreset('managed', { baseUrl: 'http://localhost:4317' }),
        depsWith(m.fetch),
      ),
    );
    await registry.discoverModels('managed');
    expect(registry.models('managed').map((x) => x.id)).toEqual(['auto']);
    const router = new CapabilityRouter(registry, { settings: QUALITY_FIRST });
    expect(router.select({ role: 'production', capabilities: ['TEXT_TO_MUSIC'] }).providerId).toBe('managed');
    expect(router.select({ role: 'midi-editing' }).providerId).toBe('managed');
  });

  it('excludes LLM endpoints that report no models; overrides correct inferred capabilities', async () => {
    const empty = mockFetch(() => jsonResponse({ models: [] }));
    const registry = new ProviderRegistry({ deps: depsWith(empty.fetch) });
    registry.configure([
      configFromPreset('ollama'),
      configFromPreset('vllm', {
        capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING', 'AUDIO_UNDERSTANDING', 'AUDIO_INPUT'],
      }),
    ]);
    await registry.discoverModels('ollama');
    const router = new CapabilityRouter(registry, { settings: QUALITY_FIRST });
    const ev = router.evaluate({ role: 'chat' });
    expect(ev.excluded.find((x) => x.providerId === 'ollama')!.reasons).toContain('no models available');

    const listing = mockFetch(() => jsonResponse({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    const r2 = new ProviderRegistry({ deps: depsWith(listing.fetch) });
    r2.configure([
      configFromPreset('vllm', {
        capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING', 'AUDIO_UNDERSTANDING', 'AUDIO_INPUT'],
      }),
    ]);
    await r2.discoverModels('vllm');
    expect(r2.capabilitiesOf('vllm', 'qwen2.5-7b-instruct')).toContain('AUDIO_UNDERSTANDING');
    const router2 = new CapabilityRouter(r2, { settings: QUALITY_FIRST });
    expect(router2.select({ role: 'analysis', capabilities: ['AUDIO_UNDERSTANDING'] })).toMatchObject({
      providerId: 'vllm',
      modelId: 'qwen2.5-7b-instruct',
    });
  });

  it('never silently replaces an explicitly requested model; profile models refresh the estimate', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      descriptor: {
        id: 'oa',
        name: 'OpenAI',
        adapter: 'openai-compatible',
        location: 'cloud',
        capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING'],
        qualityTier: 5,
      },
      llm: {
        listModels: async () => [
          { id: 'gpt-text', capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING'], qualityTier: 5 },
          {
            id: 'gpt-audio',
            capabilities: ['TEXT_REASONING', 'MUSIC_THEORY_REASONING', 'AUDIO_INPUT', 'AUDIO_UNDERSTANDING'],
            qualityTier: 4,
          },
        ],
        complete: async () => ({ text: '', model: 'x', stopReason: 'end_turn' }),
      },
    });
    await registry.discoverModels('oa');
    const router = new CapabilityRouter(registry, { settings: QUALITY_FIRST });
    expect(() =>
      router.select({
        role: 'analysis',
        capabilities: ['AUDIO_UNDERSTANDING'],
        providerId: 'oa',
        modelId: 'gpt-text',
      }),
    ).toThrow(/model gpt-text lacks Audio understanding/);
    expect(router.select({ role: 'analysis', providerId: 'oa', modelId: 'gpt-audio' }).modelId).toBe(
      'gpt-audio',
    );

    const w = makeWorld({ mode: 'manual', profileId: 'fable' });
    w.registry.getEntry('anthropic')!.instance.descriptor.pricing = {
      models: {
        'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
        'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
      },
    };
    w.registry.getEntry('anthropic')!.instance.descriptor.defaultModel = 'claude-opus-5-5';
    const custom = new CapabilityRouter(w.registry, {
      settings: () => w.settings,
      profiles: [
        {
          id: 'fable',
          name: 'Fable',
          description: '',
          assignments: { composition: { providerId: 'anthropic', modelId: 'claude-fable-5-1' } },
        },
      ],
    });
    const d = custom.select({
      role: 'composition',
      estimateInput: { kind: 'llm', role: 'composition', inputTokens: 1000, outputTokens: 1000 },
    });
    expect(d.modelId).toBe('claude-fable-5-1');
    expect(d.estimate.minUsd).toBeCloseTo((1000 * 10 + 1000 * 50) / 1e6, 10);
    expect(d.reasons).toContain('model claude-fable-5-1');
  });
});
