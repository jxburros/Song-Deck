import { describe, expect, it } from 'vitest';
import {
  assertNoSecrets,
  BUILTIN_PROFILES,
  buildMusicGenerationRequest,
  buildProductionPrompt,
  CAPABILITIES,
  CAPABILITY_INFO,
  classifyCompatibility,
  configFingerprint,
  ConfigurationError,
  configFromPreset,
  createInternalProvider,
  createProvider,
  findSecretsInConfig,
  getCatalogModel,
  inferModelCapabilities,
  LOCAL_MODEL_CATALOG,
  PROVIDER_PRESETS,
  ProviderRegistry,
  sanitizeConfig,
  planCandidates,
  TASK_ROLES,
  validateProviderConfig,
  type HardwareInfo,
} from '../src';
import { depsWith, jsonResponse, makeSong, mockFetch } from './helpers';

describe('capabilities & presets', () => {
  it('every capability has info; every preset is valid, secret-free and constructible', () => {
    for (const c of CAPABILITIES) expect(CAPABILITY_INFO[c].label.length).toBeGreaterThan(0);
    const required = [
      'openai',
      'anthropic',
      'gemini',
      'moonshot',
      'llama-api',
      'together',
      'groq',
      'ollama',
      'llama-cpp',
      'lm-studio',
      'vllm',
      'custom-llm-http',
      'elevenlabs-music',
      'stability-audio',
      'google-lyria',
      'ace-step-local',
      'diffsinger-local',
      'demucs-local',
      'basic-pitch-local',
      'rvc-local',
      'custom-audio-http',
      'managed',
    ];
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(required));
    const deps = depsWith(mockFetch(() => jsonResponse({})).fetch);
    for (const preset of PROVIDER_PRESETS) {
      const cfg = configFromPreset(preset.id);
      expect(validateProviderConfig(cfg), preset.id).toEqual([]);
      expect(findSecretsInConfig(cfg), preset.id).toEqual([]);
      expect(cfg.credentialRef === undefined, preset.id).toBe(!preset.requiresCredential);
      const inst = createProvider(cfg, deps);
      expect(inst.descriptor.capabilities.length, preset.id).toBeGreaterThan(0);
      expect(inst.descriptor.location).toBe(preset.location);
      const ifaces = [
        'llm',
        'audioGeneration',
        'singing',
        'transcription',
        'separation',
        'voiceConversion',
        'mastering',
      ].filter((k) => (inst as unknown as Record<string, unknown>)[k]);
      expect(ifaces.length, preset.id).toBeGreaterThan(0);
      if (inst.llm) expect(inst.composition, preset.id).toBeDefined();
    }
    // Anthropic pricing defaults as editable data.
    expect(configFromPreset('anthropic').defaultModel).toBe('claude-opus-5-5');
    expect(PROVIDER_PRESETS.find((p) => p.id === 'anthropic')!.pricing!.models!['claude-fable-5-1']).toEqual({
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
    expect(PROVIDER_PRESETS.find((p) => p.id === 'elevenlabs-music')!.pricing!.perMinuteUsd).toBe(0.15);
    expect(PROVIDER_PRESETS.find((p) => p.id === 'llama-api')!.pricing).toBeUndefined();
  });

  it('rejects secrets in configs (keys never live in project/settings files)', () => {
    const cfg = configFromPreset('openai', {
      extra: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz' } as never,
    });
    expect(findSecretsInConfig(cfg)).toEqual(['extra.apiKey']);
    expect(() => assertNoSecrets(cfg)).toThrow(ConfigurationError);
    expect(() => createProvider(cfg, depsWith(mockFetch(() => jsonResponse({})).fetch))).toThrow(
      /must not contain secrets/,
    );
    expect(sanitizeConfig(cfg).extra).toEqual({
      maxTokensParam: 'max_completion_tokens',
      schemaDialect: 'openai-strict',
    });
    const header = configFromPreset('custom-llm-http', {
      extra: {
        customTemplate: {
          body: '{}',
          responseTextPath: 'x',
          headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123' },
        },
      },
    });
    expect(findSecretsInConfig(header)).toEqual(['extra.customTemplate.headers.Authorization']);
    expect(
      validateProviderConfig({ ...configFromPreset('openai'), timeoutMs: 0, auth: { type: 'header' } }),
    ).toEqual(
      expect.arrayContaining(['timeoutMs must be > 0', 'auth.name is required for auth type header']),
    );
    expect(configFingerprint(configFromPreset('openai'), 'gpt-5')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('built-in profiles cover the spec profiles and every role', () => {
    expect(BUILTIN_PROFILES.map((p) => p.name)).toEqual([
      'Cloud Quality',
      'Local Only',
      'Cheap Draft',
      'Final Production',
    ]);
    const local = BUILTIN_PROFILES.find((p) => p.id === 'local-only')!;
    for (const role of TASK_ROLES) expect(local.assignments[role], role).toBeDefined();
    for (const a of Object.values(local.assignments))
      if (typeof a === 'object')
        expect(PROVIDER_PRESETS.find((p) => p.id === a.providerId)!.location).toBe('local');
    expect(BUILTIN_PROFILES.find((p) => p.id === 'cheap-draft')!.assignments.vocals).toBe('disabled');
  });

  it('infers model capabilities heuristically', () => {
    expect(inferModelCapabilities('text-embedding-3-small')).toBeUndefined();
    expect(inferModelCapabilities('llama-3.1-8b-instant')).toMatchObject({
      qualityTier: 2,
      capabilitiesInferred: true,
    });
    expect(inferModelCapabilities('llama-3.1-8b-instant')!.capabilities).toEqual(
      expect.arrayContaining(['TOOL_CALLING', 'LONG_CONTEXT']),
    );
    expect(inferModelCapabilities('qwen3:235b')!.qualityTier).toBe(5);
    expect(inferModelCapabilities('phi4-mini', { parameterSize: '3.8B' })!.qualityTier).toBe(1);
    expect(inferModelCapabilities('my-model', { serverCapabilities: ['embedding'] })).toBeUndefined();
    expect(inferModelCapabilities('some-model', { structuredOutput: false })!.capabilities).not.toContain(
      'STRUCTURED_JSON',
    );
  });
});

describe('ProviderRegistry', () => {
  it('configures providers from configs, tracks statuses and discovers models', async () => {
    const m = mockFetch((call) => {
      if (call.url.includes('localhost:11434')) throw new TypeError('fetch failed');
      return jsonResponse({ data: [{ id: 'gpt-5' }] });
    });
    const registry = new ProviderRegistry({
      deps: depsWith(m.fetch, { 'provider:openai': 'sk-test-0123456789abcdefghij' }),
    });
    registry.register(createInternalProvider({ capabilities: ['MIDI_EDITING'] }));
    const result = registry.configure([
      configFromPreset('openai'),
      configFromPreset('anthropic', { credentialRef: undefined }),
      configFromPreset('ollama'),
      configFromPreset('groq', { enabled: false }),
    ]);
    expect(result.created).toEqual(['openai', 'anthropic', 'ollama']);
    expect(result.disabled).toEqual(['groq']);
    expect(registry.status('anthropic')).toBe('unconfigured');
    expect(registry.getEntry('anthropic')!.error).toBe('No API key configured');
    expect(registry.status('groq')).toBe('unconfigured');
    expect(registry.list().find((p) => p.id === 'groq')!.enabled).toBe(false);
    const models = await registry.discoverModels('openai');
    expect(models.map((x) => x.id)).toEqual(['gpt-5']);
    expect(registry.status('openai')).toBe('ready');
    expect(registry.capabilitiesOf('openai', 'gpt-5')).toContain('STRUCTURED_JSON');
    await expect(registry.discoverModels('ollama')).rejects.toMatchObject({ kind: 'network' });
    expect(registry.status('ollama')).toBe('offline');
    // Cached until forced.
    await registry.discoverModels('openai');
    expect(m.calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(1);
    // Internal providers survive reconfiguration.
    registry.configure([]);
    expect(registry.list().map((p) => p.id)).toEqual(['internal']);
    expect(registry.resolveId('internal')).toBe('internal');
  });
});

describe('local hardware & model catalog', () => {
  const rig = (o: Partial<HardwareInfo>): HardwareInfo => ({
    gpus: [],
    ramGb: 32,
    cpu: { cores: 8, threads: 16 },
    backends: ['cpu'],
    storageFreeGb: 500,
    ...o,
  });
  const rtx = (vram: number): HardwareInfo =>
    rig({
      gpus: [{ name: 'RTX', vendor: 'nvidia', vramGb: vram, backend: 'cuda' }],
      backends: ['cuda', 'cpu'],
    });

  it('classifies ACE-Step and LLMs by VRAM, suggesting quantizations', () => {
    const ace = getCatalogModel('ace-step-1.5')!;
    expect(classifyCompatibility(ace, rtx(12)).rating).toBe('excellent');
    expect(classifyCompatibility(ace, rtx(6)).rating).toBe('compatible');
    expect(classifyCompatibility(ace, rtx(2))).toMatchObject({
      rating: 'insufficient',
      reasons: ['needs 4 GB GPU memory, 2.0 GB available'],
    });
    expect(classifyCompatibility(ace, rig({}))).toMatchObject({ rating: 'insufficient' });
    const mistral = getCatalogModel('mistral-small-3.2-24b')!;
    expect(classifyCompatibility(mistral, rtx(14))).toMatchObject({
      rating: 'compatible',
      suggestedQuantization: 'Q3_K_M',
    });
    const llama = getCatalogModel('llama-3.1-8b-instruct')!;
    expect(classifyCompatibility(llama, rig({}))).toMatchObject({
      rating: 'slow',
      suggestedQuantization: 'Q4_K_M',
    });
    expect(classifyCompatibility(llama, rig({ cpu: { cores: 2 } })).rating).toBe('insufficient');
    // Apple silicon unified memory counts as GPU memory.
    expect(
      classifyCompatibility(
        llama,
        rig({
          gpus: [{ name: 'M3', vendor: 'apple', vramGb: 0 }],
          ramGb: 16,
          backends: ['metal'],
          unifiedMemory: true,
        }),
      ).rating,
    ).toBe('excellent');
  });

  it('CPU-first models and resource limits', () => {
    expect(classifyCompatibility(getCatalogModel('basic-pitch')!, rig({})).rating).toBe('excellent');
    expect(classifyCompatibility(getCatalogModel('demucs-htdemucs')!, rig({})).rating).toBe('slow');
    expect(classifyCompatibility(getCatalogModel('demucs-htdemucs')!, rtx(8)).rating).toBe('excellent');
    expect(classifyCompatibility(getCatalogModel('gemma-3-12b')!, rtx(24)).rating).toBe('excellent');
    expect(classifyCompatibility(getCatalogModel('gemma-3-12b')!, rig({ ramGb: 8 }))).toMatchObject({
      rating: 'insufficient',
      reasons: ['needs 16 GB RAM, 8 GB available'],
    });
    expect(
      classifyCompatibility(getCatalogModel('ace-step-1.5')!, { ...rtx(24), storageFreeGb: 1 }).rating,
    ).toBe('insufficient');
    const categories = new Set(LOCAL_MODEL_CATALOG.map((m) => m.category));
    expect([...categories].sort()).toEqual([
      'audio',
      'composition',
      'mastering',
      'separation',
      'transcription',
      'vocals',
      'voice-conversion',
    ]);
  });
});

describe('production helpers', () => {
  it('builds production prompts from the composition', () => {
    const song = makeSong();
    const full = buildProductionPrompt(song);
    expect(full.prompt).toBe(
      'Emo, Pop-punk, Bass, Drums, tenor lead vocal, Melancholy verses, Cathartic chorus, 120 BPM, E minor, warm analog tape, wide guitars',
    );
    expect(full.negativePrompt).toBe('lo-fi noise');
    const chorus = buildProductionPrompt(song, { sectionId: 'sec_ch1', extra: 'gang vocals' });
    expect(chorus.prompt).toContain('chorus, Emotional release, peak energy, full arrangement');
    expect(chorus.prompt.endsWith('gang vocals')).toBe(true);
    const stem = buildProductionPrompt(song, { trackId: 'trk_bass' });
    expect(stem.prompt).toContain('solo Bass stem');
    expect(stem.prompt).not.toContain('Drums');
    expect(stem.negativePrompt).toBe('lo-fi noise, vocals, drums, other instruments');
    expect(buildProductionPrompt(makeSong({ instrumental: true })).negativePrompt).toBe(
      'lo-fi noise, vocals',
    );
    expect(buildProductionPrompt(song, { maxLength: 20 }).prompt).toBe('Emo, Pop-punk, Bass');
  });

  it('plans deterministic A/B/C candidates and generation requests', () => {
    const c = planCandidates(3, 1234);
    expect(c.map((x) => x.label)).toEqual(['A', 'B', 'C']);
    expect(c[0].seed).toBe(1234);
    expect(new Set(c.map((x) => x.seed)).size).toBe(3);
    expect(planCandidates(3, 1234)).toEqual(c);
    const req = buildMusicGenerationRequest(makeSong(), { sectionIds: ['sec_ch1'], seed: 9 });
    expect(req).toMatchObject({
      durationSeconds: 16,
      bpm: 120,
      key: 'E minor',
      meter: '4/4',
      instrumental: false,
      seed: 9,
    });
    expect(req.sections).toEqual([
      {
        name: 'Chorus 1',
        kind: 'chorus',
        startSeconds: 0,
        endSeconds: 16,
        energy: 85,
        lines: ['Fire in the sky', 'Carry me home'],
      },
    ]);
    expect(req.lyrics).toBe('[chorus]\nFire in the sky\nCarry me home');
    expect(req.song).toBeUndefined();
  });
});
