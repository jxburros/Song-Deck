import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONNECTABLE_PRESET_IDS,
  DirectTransport,
  EncryptedCredentialStore,
  MemoryCredentialStore,
  MemoryKeyValue,
  ProviderError,
  ProviderRegistry,
  cleanPastedKey,
  configFromPreset,
  connectedConfig,
  createProvider,
  describeConnectError,
  detectKeyProvider,
  detectLocalServices,
  getPreset,
  groupModels,
  isLoopbackUrl,
  modelUses,
  probeLocalService,
  probeProvider,
  recommendModels,
  type ModelInfo,
  type WebCryptoLike,
} from '../src';
import { depsWith, jsonResponse, mockFetch } from './helpers';

const GEMINI_KEY = 'AIzaSy0123456789abcdefghijklmnopqrstuvw';

// ---------------------------------------------------------------------------
// Key formats
// ---------------------------------------------------------------------------

describe('key format detection', () => {
  const one = (key: string) => detectKeyProvider(key).matches.map((m) => `${m.presetId}:${m.confidence}`);

  it('recognises documented prefixes with certainty', () => {
    expect(one(GEMINI_KEY)).toEqual(['gemini:certain']);
    expect(one('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).toEqual(['anthropic:certain']);
    expect(one('gsk_abcdefghijklmnopqrstuvwxyz0123456789')).toEqual(['groq:certain']);
    expect(one('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')).toEqual(['openai:certain']);
    expect(one('sk-svcacct-abcdefghijklmnopqrstuvwxyz0123')).toEqual(['openai:certain']);
    expect(one('sk-abcdefghijT3BlbkFJklmnopqrstuvwxyz0123')).toEqual(['openai:certain']);
    expect(one(`sk_${'0123456789abcdef'.repeat(3)}`)).toEqual(['elevenlabs-music:certain']);
    expect(one(`tgp_v1_${'a'.repeat(43)}`)).toEqual(['together:certain']);
  });

  it('offers a short list for ambiguous sk- keys and nothing for unknown formats', () => {
    expect(one('sk-abcdefghijklmnopqrstuvwxyz0123456789abcdefghij')).toEqual(['openai:possible', 'stability-audio:possible', 'moonshot:possible']);
    expect(one('LLM|1234567890|abcdefghijklmnop')).toEqual([]);
    expect(detectKeyProvider('xai-abcdefghijklmnopqrstuvwxyz').unsupported).toBe('xAI');
  });

  it('cleans pasted text and rejects things that are not keys', () => {
    expect(cleanPastedKey(`  GEMINI_API_KEY="${GEMINI_KEY}"\n`)).toBe(GEMINI_KEY);
    expect(cleanPastedKey(`export OPENAI_API_KEY=sk-proj-abc;`)).toBe('sk-proj-abc');
    expect(cleanPastedKey('Bearer gsk_abc')).toBe('gsk_abc');
    expect(detectKeyProvider('').problem).toBeTruthy();
    expect(detectKeyProvider('short').problem).toMatch(/too short/);
    expect(detectKeyProvider('two words here-and-more-text').problem).toMatch(/more than one/);
  });

  it('every connectable preset exists', () => {
    for (const id of CONNECTABLE_PRESET_IDS) expect(getPreset(id)?.requiresCredential).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Encrypted browser key store
// ---------------------------------------------------------------------------

describe('encrypted credential store', () => {
  const crypto = webcrypto as unknown as WebCryptoLike;

  it('round-trips secrets without storing plaintext, with a non-extractable key', async () => {
    const kv = new MemoryKeyValue();
    const store = new EncryptedCredentialStore(kv, { crypto });
    await store.set('provider:gemini', GEMINI_KEY, 'Gemini API key');
    expect(await store.get('provider:gemini')).toBe(GEMINI_KEY);
    expect(await store.has('provider:gemini')).toBe(true);
    expect(await store.list()).toEqual([{ ref: 'provider:gemini', label: 'Gemini API key', updatedAt: expect.any(String) }]);
    const dump = JSON.stringify([...kv.data.entries()], (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
    expect(dump).not.toContain(GEMINI_KEY);
    const key = kv.data.get('master-key') as { extractable: boolean; algorithm: { name: string } };
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
    // A second store over the same storage (a page reload) decrypts with the persisted key.
    expect(await new EncryptedCredentialStore(kv, { crypto }).get('provider:gemini')).toBe(GEMINI_KEY);
    expect(await store.get('provider:missing')).toBeUndefined();
  });

  it('fails with a different key, a tampered ciphertext, or a record moved to another ref', async () => {
    const kv = new MemoryKeyValue();
    const store = new EncryptedCredentialStore(kv, { crypto });
    await store.set('provider:openai', 'sk-proj-secret-value-0123456789');
    const record = kv.data.get('secret:provider:openai') as { iv: Uint8Array; ct: Uint8Array };

    const other = new MemoryKeyValue();
    other.data.set('secret:provider:openai', record);
    await expect(new EncryptedCredentialStore(other, { crypto }).get('provider:openai')).rejects.toThrow(/could not be decrypted/);

    const tampered = new Uint8Array(record.ct);
    tampered[0] ^= 1;
    kv.data.set('secret:provider:openai', { ...record, ct: tampered });
    await expect(store.get('provider:openai')).rejects.toBeInstanceOf(ProviderError);

    kv.data.set('secret:provider:openai', record);
    kv.data.set('secret:provider:groq', record);
    await expect(store.get('provider:groq')).rejects.toThrow(/could not be decrypted/);
    expect(await store.get('provider:openai')).toBe('sk-proj-secret-value-0123456789');
  });

  it('forgets single keys and everything (including the encryption key)', async () => {
    const kv = new MemoryKeyValue();
    const store = new EncryptedCredentialStore(kv, { crypto });
    await store.set('a', 'secret-a-0123456789');
    await store.set('b', 'secret-b-0123456789');
    await store.delete('a');
    expect((await store.list()).map((r) => r.ref)).toEqual(['b']);
    const oldKey = kv.data.get('master-key');
    await store.clear();
    expect(kv.data.size).toBe(0);
    await store.set('c', 'secret-c-0123456789');
    expect(kv.data.get('master-key')).not.toBe(oldKey);
    expect(await store.get('c')).toBe('secret-c-0123456789');
  });

  it('serves a DirectTransport like any credential store', async () => {
    const store = new EncryptedCredentialStore(new MemoryKeyValue(), { crypto });
    await store.set('provider:groq', 'gsk_test_0123456789abcdef');
    const m = mockFetch(() => jsonResponse({ data: [] }));
    await new DirectTransport(store, { fetch: m.fetch }).fetch('https://api.groq.com/openai/v1/models', {}, { type: 'bearer', credentialRef: 'provider:groq' });
    expect(m.calls[0].headers.get('authorization')).toBe('Bearer gsk_test_0123456789abcdef');
  });
});

// ---------------------------------------------------------------------------
// Models → app uses → recommendations
// ---------------------------------------------------------------------------

const GEMINI_MODELS = {
  models: [
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.5-pro-preview-06-05', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-lite', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-3-27b-it', inputTokenLimit: 131072, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
    { name: 'models/lyria-3-clip-preview', displayName: 'Lyria 3 Clip', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/lyria-realtime-exp', supportedGenerationMethods: ['bidiGenerateContent'] },
  ],
};

describe('model grouping and recommendations', () => {
  const llm = (id: string, tier: number, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, qualityTier: tier, capabilities: ['TEXT_INPUT', 'TEXT_REASONING', 'MUSIC_THEORY_REASONING', 'MIDI_GENERATION', 'MIDI_EDITING', 'LYRIC_GENERATION', 'MIXING'], ...extra });

  it('maps capabilities to app uses', () => {
    expect(modelUses(llm('x', 3))).toEqual(['composition', 'lyrics', 'midi-editing', 'theory', 'mixing']);
    expect(modelUses({ capabilities: [...llm('x', 3).capabilities, 'AUDIO_UNDERSTANDING'] })).toContain('audio-understanding');
    expect(modelUses({ capabilities: ['TEXT_TO_MUSIC', 'INSTRUMENTAL_ONLY'] })).toEqual(['music']);
    expect(modelUses({ capabilities: ['SINGING_SYNTHESIS'] })).toEqual(['singing']);
    expect(modelUses({ capabilities: [] })).toEqual([]);
  });

  it('groups by primary use, hides models the app cannot use, and recommends the best per use', () => {
    const models: ModelInfo[] = [
      llm('gpt-4.1-mini', 4),
      llm('gpt-5', 5),
      llm('gpt-5-2025-08-07', 5),
      llm('gpt-4o', 5),
      llm('gpt-5-nano', 3),
      { id: 'gemini-audio', qualityTier: 4, capabilities: [...llm('a', 4).capabilities, 'AUDIO_INPUT', 'AUDIO_UNDERSTANDING'] },
      { id: 'music-gen', qualityTier: 4, capabilities: ['TEXT_TO_MUSIC'] },
      { id: 'text-embedding-3-large', capabilities: [] },
    ];
    const g = groupModels(models);
    expect(g.groups.map((x) => x.id)).toEqual(['writing', 'music']);
    expect(g.groups[0].models[0].model.id).toBe('gpt-5');
    expect(g.unusable.map((m) => m.id)).toEqual(['text-embedding-3-large']);
    const rec = recommendModels(models);
    expect(rec.byUse.composition).toBe('gpt-5');
    expect(rec.byUse['audio-understanding']).toBe('gemini-audio');
    expect(rec.byUse.music).toBe('music-gen');
    expect(rec.selected).toEqual(['gpt-5', 'gemini-audio', 'music-gen']);
    expect(rec.defaultModel).toBe('gpt-5');
  });
});

// ---------------------------------------------------------------------------
// Validation probes per provider (mocked fetch)
// ---------------------------------------------------------------------------

function transportFor(fetchFn: ReturnType<typeof mockFetch>['fetch'], ref: string, key: string) {
  return new DirectTransport(new MemoryCredentialStore({ [ref]: key }), { fetch: fetchFn });
}

describe('connect probes', () => {
  it('Gemini: lists models with the key header, reports Lyria as music, recommends sensibly', async () => {
    const m = mockFetch(() => jsonResponse(GEMINI_MODELS));
    const r = await probeProvider('gemini', { transport: transportFor(m.fetch, 'provider:gemini', GEMINI_KEY) });
    expect(m.calls[0].url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=1000/);
    expect(m.calls[0].headers.get('x-goog-api-key')).toBe(GEMINI_KEY);
    expect(r.listed).toBe(true);
    expect(r.note).toMatch(/Lyria/);
    const ids = r.models.map((x) => x.id);
    expect(ids).toContain('lyria-3-clip-preview');
    // Models Song Deck cannot use are reported without capabilities (for "show all").
    expect(r.models.find((x) => x.id === 'text-embedding-004')?.capabilities).toEqual([]);
    expect(r.models.find((x) => x.id === 'lyria-realtime-exp')?.capabilities).toEqual([]);
    expect(groupModels(r.models).unusable.map((x) => x.id).sort()).toEqual(['imagen-4.0-generate-001', 'lyria-realtime-exp', 'text-embedding-004']);
    const lyria = r.models.find((x) => x.id === 'lyria-3-clip-preview')!;
    expect(modelUses(lyria)).toEqual(['music']);
    const rec = recommendModels(r.models);
    expect(rec.byUse.composition).toBe('gemini-2.5-pro'); // stable beats the preview snapshot
    expect(rec.selected).toEqual(['gemini-2.5-pro', 'lyria-3-clip-preview']);
    const g = groupModels(r.models);
    expect(g.groups.map((x) => x.id)).toEqual(['writing', 'music']);
  });

  it('OpenAI-compatible presets: GET {base}/models with a bearer key', async () => {
    const m = mockFetch(() => jsonResponse({ object: 'list', data: [{ id: 'gpt-5' }, { id: 'gpt-4o-mini' }, { id: 'whisper-1' }, { id: 'dall-e-3' }] }));
    const r = await probeProvider('openai', { transport: transportFor(m.fetch, 'provider:openai', 'sk-proj-test0123456789') });
    expect(m.calls[0].url).toBe('https://api.openai.com/v1/models');
    expect(m.calls[0].headers.get('authorization')).toBe('Bearer sk-proj-test0123456789');
    const g = groupModels(r.models);
    expect(g.groups[0].models.map((x) => x.model.id)).toEqual(['gpt-5', 'gpt-4o-mini']);
    expect(g.unusable.map((x) => x.id).sort()).toEqual(['dall-e-3', 'whisper-1']);
    const groq = mockFetch(() => jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile' }] }));
    await probeProvider('groq', { transport: transportFor(groq.fetch, 'provider:groq', 'gsk_abc0123456789') });
    expect(groq.calls[0].url).toBe('https://api.groq.com/openai/v1/models');
  });

  it('Anthropic: GET /v1/models through the SDK with x-api-key', async () => {
    const m = mockFetch(() =>
      jsonResponse({
        data: [
          { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 64000 },
          { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
        ],
        has_more: false,
        first_id: 'claude-opus-5-5',
        last_id: 'claude-haiku-4-5',
      }),
    );
    const r = await probeProvider('anthropic', { transport: transportFor(m.fetch, 'provider:anthropic', 'sk-ant-api03-test') });
    expect(m.calls[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(m.calls[0].headers.get('x-api-key')).toBe('sk-ant-api03-test');
    expect(recommendModels(r.models).selected).toEqual(['claude-opus-5-5']);
  });

  it('ElevenLabs: validates with GET /v1/models and presents Eleven Music', async () => {
    const m = mockFetch(() => jsonResponse([{ model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true }]));
    const r = await probeProvider('elevenlabs-music', { transport: transportFor(m.fetch, 'provider:elevenlabs-music', 'sk_test') });
    expect(m.calls[0].url).toBe('https://api.elevenlabs.io/v1/models');
    expect(m.calls[0].headers.get('xi-api-key')).toBe('sk_test');
    expect(r.listed).toBe(false);
    expect(groupModels(r.models).groups[0].models.map((x) => x.model.id)).toEqual(['music_v1']);
    expect(groupModels(r.models).unusable.map((x) => x.id)).toEqual(['eleven_multilingual_v2']);

    const restricted = mockFetch(() => jsonResponse({ detail: { status: 'missing_permissions', message: 'The API key is missing the permission models_read' } }, 401));
    const r2 = await probeProvider('elevenlabs-music', { transport: transportFor(restricted.fetch, 'provider:elevenlabs-music', 'sk_test') });
    expect(r2.models.map((x) => x.id)).toEqual(['music_v1']);

    const bad = mockFetch(() => jsonResponse({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401));
    const err = await probeProvider('elevenlabs-music', { transport: transportFor(bad.fetch, 'provider:elevenlabs-music', 'sk_bad') }).catch((e) => e);
    expect(describeConnectError(err, 'ElevenLabs').kind).toBe('invalid-key');
  });

  it('Stability AI: validates with GET /v1/user/balance and presents known Stable Audio models', async () => {
    const m = mockFetch(() => jsonResponse({ credits: 42.5 }));
    const r = await probeProvider('stability-audio', { transport: transportFor(m.fetch, 'provider:stability-audio', 'sk-stab-0123456789') });
    expect(m.calls[0].url).toBe('https://api.stability.ai/v1/user/balance');
    expect(m.calls[0].headers.get('authorization')).toBe('Bearer sk-stab-0123456789');
    expect(r.account).toEqual([{ label: 'Credits', value: '42.50' }]);
    expect(r.models.map((x) => x.id).sort()).toEqual(['stable-audio-2', 'stable-audio-2.5']);
    expect(modelUses(r.models[0])).toEqual(['music']);
  });

  it('describes invalid keys, quota and network failures', async () => {
    const invalid = mockFetch(() => jsonResponse({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, 400));
    const e1 = await probeProvider('gemini', { transport: transportFor(invalid.fetch, 'provider:gemini', GEMINI_KEY) }).catch((e) => e);
    expect(describeConnectError(e1, 'Google Gemini').kind).toBe('invalid-key');
    const quota = mockFetch(() => jsonResponse({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } }, 429));
    const e2 = await probeProvider('gemini', { transport: transportFor(quota.fetch, 'provider:gemini', GEMINI_KEY) }).catch((e) => e);
    expect(describeConnectError(e2, 'Google Gemini').kind).toBe('quota');
    const down = mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const e3 = await probeProvider('openai', { transport: transportFor(down.fetch, 'provider:openai', 'sk-proj-x0123456789') }).catch((e) => e);
    const d = describeConnectError(e3, 'OpenAI', { browserOnly: true });
    expect(d.kind).toBe('network');
    expect(d.message).toMatch(/CORS/);
    expect(describeConnectError(new ProviderError('auth', 'Incorrect API key provided', { status: 401 }), 'OpenAI').kind).toBe('invalid-key');
    expect(describeConnectError(new ProviderError('auth', 'Payment required', { status: 402 }), 'OpenAI').kind).toBe('quota');
  });
});

// ---------------------------------------------------------------------------
// Connected configs, enabled models, Gemini Lyria
// ---------------------------------------------------------------------------

describe('connected provider configs', () => {
  it('builds an enabled config with the chosen models and a default', async () => {
    const m = mockFetch(() => jsonResponse(GEMINI_MODELS));
    const probe = await probeProvider('gemini', { transport: transportFor(m.fetch, 'provider:gemini', GEMINI_KEY) });
    const cfg = connectedConfig('gemini', { selected: ['gemini-2.5-pro', 'gemini-2.5-flash', 'lyria-3-clip-preview'], probe });
    expect(cfg).toMatchObject({ id: 'gemini', presetId: 'gemini', enabled: true, credentialRef: 'provider:gemini', defaultModel: 'gemini-2.5-pro', enabledModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'lyria-3-clip-preview'] });
    expect(JSON.stringify(cfg)).not.toContain(GEMINI_KEY);

    // The registry keeps only the chosen models; the Lyria pick adds music generation.
    const reg = new ProviderRegistry();
    reg.configure([cfg], depsWith(m.fetch, { 'provider:gemini': GEMINI_KEY }));
    const models = await reg.discoverModels('gemini');
    expect(models.map((x) => x.id).sort()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro', 'lyria-3-clip-preview']);
    expect(reg.findCompatible(['TEXT_TO_MUSIC'], { interface: 'audioGeneration' })[0]?.models.map((x) => x.id)).toEqual(['lyria-3-clip-preview']);
    expect(reg.findCompatible(['MUSIC_THEORY_REASONING'], { interface: 'composition' })[0]?.models.map((x) => x.id).sort()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);

    const stab = connectedConfig('stability-audio', { selected: ['stable-audio-2.5'], probe: { listed: false, models: [{ id: 'stable-audio-2.5', capabilities: ['TEXT_TO_MUSIC'] }] } });
    expect(stab).toMatchObject({ defaultModel: 'stable-audio-2.5', models: [{ id: 'stable-audio-2.5' }] });
    expect(stab.enabledModels).toBeUndefined();
  });

  it('Gemini Lyria generates music through generateContent and reads inline audio', async () => {
    const audio = Buffer.from('ID3fakeaudio').toString('base64');
    const m = mockFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: '[Verse] la la' }, { inlineData: { mimeType: 'audio/mpeg', data: audio } }] } }] }));
    const cfg = { ...configFromPreset('gemini'), enabledModels: ['gemini-2.5-pro', 'lyria-3-clip-preview'], defaultModel: 'gemini-2.5-pro' };
    const inst = createProvider(cfg, depsWith(m.fetch, { 'provider:gemini': GEMINI_KEY }));
    expect(inst.descriptor.capabilities).toContain('TEXT_TO_MUSIC');
    const res = await inst.audioGeneration!.generateMusic({ prompt: 'Upbeat indie pop', durationSeconds: 30, bpm: 120, model: 'gemini-2.5-pro' });
    expect(m.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent');
    expect(JSON.stringify(JSON.parse(m.calls[0].body!))).toContain('Upbeat indie pop. 120 BPM');
    expect(res.audio.mimeType).toBe('audio/mpeg');
    expect(res.model).toBe('lyria-3-clip-preview');
    // Without a chosen Lyria model the provider is a plain LLM.
    expect(createProvider(configFromPreset('gemini'), depsWith(m.fetch)).audioGeneration).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Local services (mocked fetch; the server tests use real HTTP servers)
// ---------------------------------------------------------------------------

describe('local service probes', () => {
  it('only probes loopback addresses', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.4:11434')).toBe(false);
    expect(isLoopbackUrl('https://api.openai.com')).toBe(false);
  });

  it('reads Ollama tags, OpenAI-compatible model lists and bridge /info', async () => {
    const m = mockFetch((call) => {
      if (call.url === 'http://127.0.0.1:11434/api/tags') return jsonResponse({ models: [{ name: 'llama3.1:8b', details: { parameter_size: '8.0B' } }, { name: 'nomic-embed-text:latest' }] });
      if (call.url === 'http://127.0.0.1:8080/v1/models') return jsonResponse({ data: [{ id: 'qwen2.5-7b-instruct' }] });
      if (call.url === 'http://127.0.0.1:8812/info') return jsonResponse({ name: 'htdemucs', version: '4.0', capabilities: ['source_separation', 'stem_output'] });
      throw new TypeError('connect ECONNREFUSED');
    });
    const found = await detectLocalServices(
      [
        { presetId: 'ollama', baseUrl: 'http://127.0.0.1:11434', kind: 'ollama' },
        { presetId: 'llama-cpp', baseUrl: 'http://127.0.0.1:8080/v1', kind: 'openai' },
        { presetId: 'demucs-local', baseUrl: 'http://127.0.0.1:8812', kind: 'bridge' },
        { presetId: 'vllm', baseUrl: 'http://127.0.0.1:8000/v1', kind: 'openai' },
      ],
      { fetch: m.fetch },
    );
    expect(found.map((s) => `${s.presetId}:${s.status}`)).toEqual(['ollama:found', 'llama-cpp:found', 'demucs-local:found', 'vllm:absent']);
    expect(found[0].models.map((x) => x.id)).toEqual(['llama3.1:8b']);
    expect(found[1].models[0].capabilities).toContain('MIDI_EDITING');
    expect(found[2]).toMatchObject({ version: '4.0', capabilities: ['SOURCE_SEPARATION', 'STEM_OUTPUT'] });
    const remote = await probeLocalService({ presetId: 'ollama', baseUrl: 'http://10.0.0.2:11434', kind: 'ollama' }, { fetch: m.fetch });
    expect(remote.status).toBe('error');
    expect(m.calls.some((c) => c.url.includes('10.0.0.2'))).toBe(false);
  });
});
