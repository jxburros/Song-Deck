import { describe, expect, it } from 'vitest';
import {
  AnthropicLLM,
  configFromPreset,
  createProvider,
  OPERATIONS_SCHEMA,
  ProviderError,
  ServerProxyTransport,
  type JsonSchema,
  type ProviderConfig,
} from '../src';
import { bodyJson, depsWith, jsonResponse, mockFetch } from './helpers';

const SECRET = 'sk-ant-test-secret-0123456789abcdef';

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: 'internal', signature: 'sig' },
      { type: 'text', text: '{"explanation":"ok","confidence":0.9,"operations":[]}' },
    ],
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 200 },
    ...overrides,
  };
}

function anthropicConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return configFromPreset('anthropic', overrides);
}

function walk(s: JsonSchema, visit: (n: JsonSchema) => void): void {
  visit(s);
  for (const c of Object.values(s.properties ?? {})) walk(c, visit);
  if (s.items) walk(s.items, visit);
  for (const b of s.anyOf ?? []) walk(b, visit);
}

describe('Anthropic adapter (official SDK + custom fetch)', () => {
  it('sends structured-output requests to /v1/messages with x-api-key and anthropic-version', async () => {
    const m = mockFetch(() => jsonResponse(message()));
    const inst = createProvider(anthropicConfig(), depsWith(m.fetch, { 'provider:anthropic': SECRET }));
    const res = await inst.llm!.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      responseSchema: OPERATIONS_SCHEMA,
      schemaName: 'operations',
      maxTokens: 1000,
    });

    expect(m.calls).toHaveLength(1);
    const call = m.calls[0];
    // claude-opus-5-5 on the first-party API uses the refusal-fallback beta → /v1/messages?beta=true
    expect(call.url.startsWith('https://api.anthropic.com/v1/messages')).toBe(true);
    expect(call.method).toBe('POST');
    expect(call.headers.get('x-api-key')).toBe(SECRET);
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
    const body = bodyJson(call);
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(1000);
    expect(body.system).toBe('sys');
    const oc = body.output_config as { format: { type: string; schema: JsonSchema }; effort: string };
    expect(oc.format.type).toBe('json_schema');
    expect(oc.effort).toBe('medium');
    // Never send sampling params or thinking config.
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('thinking');
    // Anthropic dialect: additionalProperties false everywhere, no numeric/array/string constraints.
    walk(oc.format.schema, (n) => {
      if (n.type === 'object') expect(n.additionalProperties).toBe(false);
      for (const k of [
        'minimum',
        'maximum',
        'multipleOf',
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
        'exclusiveMinimum',
      ])
        expect(n).not.toHaveProperty(k);
    });
    // Text comes from text blocks only (thinking skipped); JSON parsed.
    expect(res.text).toBe('{"explanation":"ok","confidence":0.9,"operations":[]}');
    expect(res.json).toEqual({ explanation: 'ok', confidence: 0.9, operations: [] });
    expect(res.structured).toBe('native');
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
    // claude-opus-5-5 at $4/$20 per MTok.
    expect(res.costUsd).toBeCloseTo((1000 * 4 + 200 * 20) / 1e6, 10);
  });

  it('opts into server-side refusal fallbacks for supported models on the first-party API', async () => {
    const m = mockFetch(() => jsonResponse(message()));
    const inst = createProvider(anthropicConfig(), depsWith(m.fetch, { 'provider:anthropic': SECRET }));
    await inst.llm!.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const call = m.calls[0];
    expect(call.url).toContain('/v1/messages');
    expect(call.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = bodyJson(call);
    expect(body.fallbacks).toBe('default');
    expect(body).not.toHaveProperty('betas');
  });

  it('does not use fallbacks for other models, custom base URLs, or when disabled', async () => {
    for (const cfg of [
      anthropicConfig({ defaultModel: 'claude-haiku-4-5' }),
      anthropicConfig({ baseUrl: 'https://gateway.example.com' }),
      anthropicConfig({ extra: { refusalFallback: false, effort: 'high' } }),
    ]) {
      const m = mockFetch(() => jsonResponse(message({ model: cfg.defaultModel })));
      const inst = createProvider(cfg, depsWith(m.fetch, { 'provider:anthropic': SECRET }));
      await inst.llm!.complete({ messages: [{ role: 'user', content: 'hi' }] });
      const call = m.calls[0];
      expect(call.headers.get('anthropic-beta')).toBeNull();
      expect(bodyJson(call)).not.toHaveProperty('fallbacks');
      expect(call.url).toBe(`${cfg.baseUrl.replace(/\/$/, '')}/v1/messages`);
    }
  });

  it('checks stop_reason === "refusal" before reading content', async () => {
    const m = mockFetch(() =>
      jsonResponse(
        message({
          content: [{ type: 'text', text: '{"partial": true' }],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined for safety reasons' },
        }),
      ),
    );
    const inst = createProvider(anthropicConfig(), depsWith(m.fetch, { 'provider:anthropic': SECRET }));
    const err = await inst
      .llm!.complete({ messages: [{ role: 'user', content: 'x' }], responseSchema: OPERATIONS_SCHEMA })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('refusal');
    expect((err as ProviderError).category).toBe('cyber');
    expect((err as ProviderError).message).toBe('Declined for safety reasons');
  });

  it('maps max_tokens with JSON output to a truncated error carrying the partial text', async () => {
    const m = mockFetch(() =>
      jsonResponse(
        message({
          content: [{ type: 'text', text: '{"operations":[{"op":"add_notes"' }],
          stop_reason: 'max_tokens',
        }),
      ),
    );
    const inst = createProvider(
      anthropicConfig({ defaultModel: 'claude-sonnet-4-6' }),
      depsWith(m.fetch, { 'provider:anthropic': SECRET }),
    );
    const err = (await inst
      .llm!.complete({ messages: [{ role: 'user', content: 'x' }], responseSchema: OPERATIONS_SCHEMA })
      .catch((e) => e)) as ProviderError;
    expect(err.kind).toBe('truncated');
    expect(err.partialText).toContain('add_notes');
  });

  it('maps SDK error classes to normalized ProviderError kinds', async () => {
    const cases: [number, string][] = [
      [401, 'auth'],
      [429, 'rate-limit'],
      [400, 'bad-request'],
      [529, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      const m = mockFetch(() =>
        jsonResponse(
          { type: 'error', error: { type: 'x', message: `boom ${status}` } },
          status,
          status === 429 ? { 'retry-after': '0' } : {},
        ),
      );
      const inst = createProvider(
        anthropicConfig({ defaultModel: 'claude-haiku-4-5' }),
        depsWith(m.fetch, { 'provider:anthropic': SECRET }),
      );
      const err = (await inst
        .llm!.complete({ messages: [{ role: 'user', content: 'x' }] })
        .catch((e) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe(kind);
      expect(err.message).toContain(`boom ${status}`);
      // 429 and 5xx are retried (max 2 retries) by our pipeline.
      expect(m.calls.length).toBe(kind === 'rate-limit' || kind === 'unavailable' ? 3 : 1);
    }
  });

  it('reports a missing credential as an auth error without calling the API', async () => {
    const m = mockFetch(() => jsonResponse(message()));
    const inst = createProvider(anthropicConfig(), depsWith(m.fetch, {}));
    const err = (await inst
      .llm!.complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e)) as ProviderError;
    expect(err.kind).toBe('auth');
    expect(m.calls).toHaveLength(0);
  });

  it('discovers models and maps the capabilities object to the taxonomy', async () => {
    const m = mockFetch((call) => {
      expect(call.url).toContain('https://api.anthropic.com/v1/models');
      return jsonResponse({
        data: [
          {
            type: 'model',
            id: 'claude-opus-5-5',
            display_name: 'Claude Opus 5.5',
            created_at: '2026-01-01T00:00:00Z',
            max_input_tokens: 1000000,
            max_tokens: 128000,
            capabilities: {
              structured_outputs: { supported: true },
              image_input: { supported: true },
              effort: {
                supported: true,
                low: { supported: true },
                medium: { supported: true },
                high: { supported: true },
                max: { supported: true },
                xhigh: { supported: true },
              },
              thinking: {
                supported: true,
                types: { adaptive: { supported: true }, enabled: { supported: false } },
              },
            },
          },
          {
            type: 'model',
            id: 'claude-legacy',
            display_name: 'Legacy',
            created_at: '2024-01-01T00:00:00Z',
            max_input_tokens: 50000,
            max_tokens: 4096,
            capabilities: { structured_outputs: { supported: false }, effort: { supported: false } },
          },
        ],
        has_more: false,
        first_id: 'claude-opus-5-5',
        last_id: 'claude-legacy',
      });
    });
    const inst = createProvider(anthropicConfig(), depsWith(m.fetch, { 'provider:anthropic': SECRET }));
    const models = await inst.llm!.listModels();
    const opus = models.find((x) => x.id === 'claude-opus-5-5')!;
    expect(opus.capabilities).toEqual(
      expect.arrayContaining(['STRUCTURED_JSON', 'LONG_CONTEXT', 'TOOL_CALLING', 'MIDI_EDITING']),
    );
    expect(opus.contextLength).toBe(1000000);
    expect(opus.qualityTier).toBe(5);
    const legacy = models.find((x) => x.id === 'claude-legacy')!;
    expect(legacy.capabilities).not.toContain('STRUCTURED_JSON');
    expect(legacy.capabilities).not.toContain('LONG_CONTEXT');

    // A model without structured outputs / effort gets prompt-only JSON and no effort.
    const m2 = mockFetch(() => jsonResponse(message({ model: 'claude-legacy' })));
    const llm = new AnthropicLLM(anthropicConfig(), {
      transport: depsWith(m2.fetch, { 'provider:anthropic': SECRET }).transport,
    });
    (llm as unknown as { models: Map<string, unknown> }).models = new Map([[legacy.id, legacy]]);
    const params = llm.buildParams(
      { messages: [{ role: 'user', content: 'x' }], responseSchema: OPERATIONS_SCHEMA },
      'claude-legacy',
    );
    expect(params).not.toHaveProperty('output_config');
    expect(String(params.system)).toContain('Respond with a single JSON object');
  });

  it('routes through ServerProxyTransport with a placeholder key and credentialRef in the envelope', async () => {
    const proxy = mockFetch(() => jsonResponse(message({ model: 'claude-sonnet-4-6' })));
    const transport = new ServerProxyTransport('http://localhost:4317', { fetch: proxy.fetch });
    const inst = createProvider(anthropicConfig({ defaultModel: 'claude-sonnet-4-6' }), {
      transport,
      retry: { baseDelayMs: 0 },
    });
    const res = await inst.llm!.complete({ messages: [{ role: 'user', content: 'hello' }] });
    expect(res.model).toBe('claude-sonnet-4-6');
    expect(proxy.calls).toHaveLength(1);
    expect(proxy.calls[0].url).toBe('http://localhost:4317/api/proxy');
    const env = bodyJson(proxy.calls[0]) as {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
      bodyEncoding: string;
      credentialRef: string;
      auth: { type: string; name: string };
    };
    expect(env.url).toBe('https://api.anthropic.com/v1/messages');
    expect(env.method).toBe('POST');
    expect(env.headers['x-api-key']).toBe('proxy-managed');
    expect(env.headers['anthropic-version']).toBe('2023-06-01');
    expect(env.credentialRef).toBe('provider:anthropic');
    expect(env.auth).toEqual({ type: 'header', name: 'x-api-key' });
    expect(env.bodyEncoding).toBe('utf8');
    expect(JSON.parse(env.body).messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('retries once without effort when the API rejects it', async () => {
    let n = 0;
    const m = mockFetch((call) => {
      n++;
      const body = bodyJson(call) as { output_config?: { effort?: string } };
      if (body.output_config?.effort)
        return jsonResponse(
          {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'effort is not supported for this model' },
          },
          400,
        );
      return jsonResponse(message({ model: 'claude-haiku-4-5' }));
    });
    const inst = createProvider(
      anthropicConfig({ defaultModel: 'claude-haiku-4-5' }),
      depsWith(m.fetch, { 'provider:anthropic': SECRET }),
    );
    const res = await inst.llm!.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.model).toBe('claude-haiku-4-5');
    expect(n).toBe(2);
  });
});

describe('Claude on cloud platforms', () => {
  it('Bedrock: Messages API on bedrock-mantle.{region} with the Bedrock key in x-api-key, no fallbacks', async () => {
    const m = mockFetch(() => jsonResponse(message({ model: 'anthropic.claude-opus-5-5' })));
    const config = configFromPreset('anthropic-bedrock', { region: 'eu-west-1' });
    const inst = createProvider(config, depsWith(m.fetch, { 'provider:anthropic-bedrock': 'bedrock-token' }));
    const models = await inst.llm!.listModels();
    expect(models.map((x) => x.id)).toContain('anthropic.claude-sonnet-5-5');
    expect(m.calls).toHaveLength(0); // no Models API on Bedrock
    const res = await inst.llm!.complete({
      messages: [{ role: 'user', content: 'hi' }],
      responseSchema: OPERATIONS_SCHEMA,
    });
    const call = m.calls[0];
    expect(call.url).toBe('https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages');
    expect(call.headers.get('x-api-key')).toBe('bedrock-token');
    const body = bodyJson(call);
    expect(body.model).toBe('anthropic.claude-opus-5-5');
    expect(body).not.toHaveProperty('fallbacks');
    expect(res.costUsd).toBeCloseTo((1000 * 4 + 200 * 20) / 1e6, 8);
  });

  it('Bedrock: drops structured output when the platform rejects it and retries in prompt mode', async () => {
    let n = 0;
    const m = mockFetch(() =>
      n++ === 0
        ? jsonResponse(
            {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'output_config.format: not supported' },
            },
            400,
          )
        : jsonResponse(message()),
    );
    const inst = createProvider(
      configFromPreset('anthropic-bedrock'),
      depsWith(m.fetch, { 'provider:anthropic-bedrock': 'tok' }),
    );
    const res = await inst.llm!.complete({
      messages: [{ role: 'user', content: 'hi' }],
      responseSchema: OPERATIONS_SCHEMA,
    });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0].url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
    expect((bodyJson(m.calls[1]).output_config as { format?: unknown } | undefined)?.format).toBeUndefined();
    expect(res.structured).toBe('prompt');
  });

  it('Vertex: rawPredict URL with the model in the path and anthropic_version in the body', async () => {
    const m = mockFetch(() => jsonResponse(message()));
    const config = configFromPreset('anthropic-vertex', {
      extra: { vertexProject: 'my-proj', vertexLocation: 'global' },
    });
    const inst = createProvider(config, depsWith(m.fetch, { 'provider:anthropic-vertex': 'ya29.token' }));
    await inst.llm!.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const call = m.calls[0];
    expect(call.url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict',
    );
    expect(call.headers.get('authorization')).toBe('Bearer ya29.token');
    const body = bodyJson(call);
    expect(body).not.toHaveProperty('model');
    expect(body.anthropic_version).toBe('vertex-2023-10-16');
    expect(body).not.toHaveProperty('fallbacks');
  });

  it('Vertex: regional host and a clear error without a project id', async () => {
    const m = mockFetch(() => jsonResponse(message()));
    const regional = createProvider(
      configFromPreset('anthropic-vertex', { extra: { vertexProject: 'p', vertexLocation: 'us-east5' } }),
      depsWith(m.fetch, { 'provider:anthropic-vertex': 'ya29.token' }),
    );
    await regional.llm!.complete({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(m.calls[0].url).toBe(
      'https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-5-5:rawPredict',
    );
    const noProject = createProvider(
      configFromPreset('anthropic-vertex'),
      depsWith(m.fetch, { 'provider:anthropic-vertex': 'ya29.token' }),
    );
    await expect(noProject.llm!.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /project id/,
    );
  });
});
