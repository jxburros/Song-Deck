import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SCHEMAS,
  configFromPreset,
  createProvider,
  CustomHttpLLM,
  LLMCompositionProvider,
  OPERATIONS_SCHEMA,
  ProviderError,
  renderTemplate,
  type JsonSchema,
} from '../src';
import { bodyJson, depsWith, FAKE_WAV, jsonResponse, mockFetch } from './helpers';

const OPENAI_KEY = 'sk-test-openai-0123456789abcdefghij';

function chatCompletion(content: string, finish = 'stop') {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'gpt-5-mini-2025-08-07',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1200, completion_tokens: 300 },
  };
}

function everyObject(s: JsonSchema, visit: (n: JsonSchema) => void): void {
  if (s.properties) visit(s);
  for (const c of Object.values(s.properties ?? {})) everyObject(c, visit);
  if (s.items) everyObject(s.items, visit);
  for (const b of s.anyOf ?? []) everyObject(b, visit);
}

describe('OpenAI-compatible adapter', () => {
  it('sends strict json_schema response_format with all properties required', async () => {
    const m = mockFetch(() => jsonResponse(chatCompletion('{"explanation":"x","confidence":0.8,"operations":[]}')));
    const cfg = configFromPreset('openai', { defaultModel: 'gpt-5-mini', organization: 'org_123', project: 'proj_456' });
    const inst = createProvider(cfg, depsWith(m.fetch, { 'provider:openai': OPENAI_KEY }));
    const res = await inst.llm!.complete({ system: 'You are helpful', messages: [{ role: 'user', content: 'go' }], responseSchema: OPERATIONS_SCHEMA, schemaName: 'operations', maxTokens: 2048 });

    const call = m.calls[0];
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`);
    expect(call.headers.get('openai-organization')).toBe('org_123');
    expect(call.headers.get('openai-project')).toBe('proj_456');
    const body = bodyJson(call) as Record<string, any>;
    expect(body.model).toBe('gpt-5-mini');
    expect(body.max_completion_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('operations');
    expect(body.response_format.json_schema.strict).toBe(true);
    const schema = body.response_format.json_schema.schema as JsonSchema;
    everyObject(schema, (o) => {
      expect(o.additionalProperties).toBe(false);
      expect([...(o.required ?? [])].sort()).toEqual(Object.keys(o.properties!).sort());
    });
    // Optional canonical fields became nullable.
    const item = (schema.properties!.operations as JsonSchema).items!;
    expect(item.properties!.track.type).toEqual(['string', 'null']);
    expect(item.properties!.op.type).toBe('string');
    expect(res.json).toEqual({ explanation: 'x', confidence: 0.8, operations: [] });
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(res.costUsd).toBeCloseTo((1200 * 0.25 + 300 * 2) / 1e6, 10);
    expect(res.structured).toBe('native');
  });

  it('uses json_object mode with the schema described in the prompt', async () => {
    const m = mockFetch(() => jsonResponse(chatCompletion('{"answer":"hi","suggestions":[],"operations":[],"confidence":1}')));
    const cfg = configFromPreset('moonshot', { defaultModel: 'kimi-k2-0905-preview' });
    const inst = createProvider(cfg, depsWith(m.fetch, { 'provider:moonshot': 'sk-moonshot-0123456789abcdef' }));
    await inst.llm!.complete({ system: 'base', messages: [{ role: 'user', content: 'q' }], responseSchema: CANONICAL_SCHEMAS.chat_answer, schemaName: 'chat_answer', maxTokens: 500 });
    const body = bodyJson(m.calls[0]) as Record<string, any>;
    expect(m.calls[0].url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(500);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('base');
    expect(body.messages[0].content).toContain('JSON');
    expect(body.messages[0].content).toContain('"answer"');
  });

  it('downgrades json_schema → json_object when the endpoint rejects response_format', async () => {
    const m = mockFetch((call) => {
      const body = bodyJson(call) as Record<string, any>;
      if (body.response_format?.type === 'json_schema') return jsonResponse({ error: { message: "response_format 'json_schema' is not supported" } }, 400);
      return jsonResponse(chatCompletion('```json\n{"explanation":"ok","confidence":0.5,"operations":[]}\n```'));
    });
    const cfg = configFromPreset('vllm', { defaultModel: 'qwen' });
    const inst = createProvider(cfg, depsWith(m.fetch));
    const res = await inst.llm!.complete({ messages: [{ role: 'user', content: 'x' }], responseSchema: OPERATIONS_SCHEMA });
    expect(m.calls).toHaveLength(2);
    expect((bodyJson(m.calls[1]) as Record<string, any>).response_format).toEqual({ type: 'json_object' });
    expect(res.json).toEqual({ explanation: 'ok', confidence: 0.5, operations: [] });
    expect(res.structured).toBe('json-mode');
    // Local presets send no Authorization header.
    expect(m.calls[0].headers.get('authorization')).toBeNull();
    expect(m.calls[0].url).toBe('http://localhost:8000/v1/chat/completions');
  });

  it('local servers get the plain json-schema dialect (non-strict)', async () => {
    const m = mockFetch(() => jsonResponse(chatCompletion('{"explanation":"ok","confidence":0.5,"operations":[]}')));
    const inst = createProvider(configFromPreset('llama-cpp', { defaultModel: 'local' }), depsWith(m.fetch));
    await inst.llm!.complete({ messages: [{ role: 'user', content: 'x' }], responseSchema: OPERATIONS_SCHEMA, schemaName: 'operations' });
    const rf = (bodyJson(m.calls[0]) as Record<string, any>).response_format;
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(false);
    const item = rf.json_schema.schema.properties.operations.items;
    expect(item.required).toEqual(['op']);
    expect(item.properties.track.type).toBe('string');
  });

  it('maps refusals, content filters and truncation', async () => {
    const refusal = mockFetch(() => jsonResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'I cannot help with that' } }] }));
    const inst = createProvider(configFromPreset('openai', { defaultModel: 'gpt-4.1' }), depsWith(refusal.fetch, { 'provider:openai': OPENAI_KEY }));
    const e1 = (await inst.llm!.complete({ messages: [{ role: 'user', content: 'x' }], responseSchema: OPERATIONS_SCHEMA }).catch((e) => e)) as ProviderError;
    expect(e1.kind).toBe('refusal');
    const trunc = mockFetch(() => jsonResponse(chatCompletion('{"operations":[', 'length')));
    const inst2 = createProvider(configFromPreset('openai', { defaultModel: 'gpt-4.1' }), depsWith(trunc.fetch, { 'provider:openai': OPENAI_KEY }));
    const e2 = (await inst2.llm!.complete({ messages: [{ role: 'user', content: 'x' }], responseSchema: OPERATIONS_SCHEMA }).catch((e) => e)) as ProviderError;
    expect(e2.kind).toBe('truncated');
  });

  it('discovers models from /models and infers capabilities', async () => {
    const m = mockFetch(() =>
      jsonResponse({
        object: 'list',
        data: [
          { id: 'gpt-5', object: 'model', owned_by: 'openai' },
          { id: 'text-embedding-3-large', object: 'model', owned_by: 'openai' },
          { id: 'whisper-1', object: 'model', owned_by: 'openai' },
          { id: 'gpt-4o-audio-preview', object: 'model', owned_by: 'openai' },
        ],
      }),
    );
    const inst = createProvider(configFromPreset('openai'), depsWith(m.fetch, { 'provider:openai': OPENAI_KEY }));
    const models = await inst.llm!.listModels();
    expect(m.calls[0].url).toBe('https://api.openai.com/v1/models');
    expect(m.calls[0].method).toBe('GET');
    expect(models.map((x) => x.id)).toEqual(['gpt-4o-audio-preview', 'gpt-5']);
    const gpt5 = models.find((x) => x.id === 'gpt-5')!;
    expect(gpt5.capabilitiesInferred).toBe(true);
    expect(gpt5.capabilities).toEqual(expect.arrayContaining(['TEXT_REASONING', 'STRUCTURED_JSON', 'TOOL_CALLING', 'LONG_CONTEXT', 'MIDI_EDITING']));
    expect(gpt5.qualityTier).toBe(5);
    expect(models.find((x) => x.id === 'gpt-4o-audio-preview')!.capabilities).toContain('AUDIO_INPUT');
  });

  it('reads Groq/Together style model metadata (context window)', async () => {
    const m = mockFetch(() => jsonResponse([{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat', context_length: 131072 }, { id: 'some-image-model', type: 'image' }]));
    const inst = createProvider(configFromPreset('together'), depsWith(m.fetch, { 'provider:together': 'tgp_v1_0123456789abcdef' }));
    const models = await inst.llm!.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].contextLength).toBe(131072);
    expect(models[0].capabilities).toContain('LONG_CONTEXT');
    expect(models[0].qualityTier).toBe(4);
  });
});

describe('Gemini adapter', () => {
  const GEMINI_KEY = 'AIzaSyTestKey0123456789abcdefghijklmnop';
  const geminiReply = (text: string, finishReason = 'STOP') => ({
    candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100, thoughtsTokenCount: 20 },
    modelVersion: 'gemini-2.5-pro',
  });

  it('posts generateContent with x-goog-api-key, systemInstruction and responseSchema (OpenAPI subset)', async () => {
    const m = mockFetch(() => jsonResponse(geminiReply('{"explanation":"done","confidence":0.7,"operations":[]}')));
    const inst = createProvider(configFromPreset('gemini', { defaultModel: 'gemini-2.5-pro' }), depsWith(m.fetch, { 'provider:gemini': GEMINI_KEY }));
    const res = await inst.llm!.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'prev' }, { role: 'user', content: 'again' }], responseSchema: OPERATIONS_SCHEMA, maxTokens: 999 });
    const call = m.calls[0];
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(call.headers.get('x-goog-api-key')).toBe(GEMINI_KEY);
    const body = bodyJson(call) as Record<string, any>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.maxOutputTokens).toBe(999);
    const schema = body.generationConfig.responseSchema;
    expect(schema.type).toBe('OBJECT');
    expect(JSON.stringify(schema)).not.toContain('additionalProperties');
    const item = schema.properties.operations.items;
    expect(item.properties.track.nullable).toBe(true);
    expect(item.properties.track.type).toBe('STRING');
    expect(item.required).toEqual(['op']);
    expect(item.propertyOrdering[0]).toBe('op');
    expect(res.text).toBe('{"explanation":"done","confidence":0.7,"operations":[]}');
    expect(res.usage).toEqual({ inputTokens: 500, outputTokens: 120 });
    expect(res.json).toEqual({ explanation: 'done', confidence: 0.7, operations: [] });
  });

  it('sends audio inline (AUDIO_UNDERSTANDING) for music analysis', async () => {
    const m = mockFetch(() => jsonResponse(geminiReply('{"summary":"Upbeat pop-punk in E minor","observations":[{"topic":"tempo","detail":"~120 BPM"}],"key":"E minor","tempo":120,"confidence":0.8}')));
    const inst = createProvider(configFromPreset('gemini', { defaultModel: 'gemini-2.5-flash' }), depsWith(m.fetch, { 'provider:gemini': GEMINI_KEY }));
    const out = await inst.composition!.analyzeMusic({ audio: { mimeType: 'audio/wav', data: FAKE_WAV }, question: 'What key and tempo?' });
    const body = bodyJson(m.calls[0]) as Record<string, any>;
    const parts = body.contents[0].parts;
    expect(parts[0].inline_data.mime_type).toBe('audio/wav');
    expect(parts[0].inline_data.data).toBe(Buffer.from(FAKE_WAV).toString('base64'));
    expect(parts[1].text).toContain('What key and tempo?');
    expect(out.key).toBe('E minor');
    expect(out.tempo).toBe(120);
    expect(out.observations).toHaveLength(1);
  });

  it('treats SAFETY / blocked prompts as refusals and lists generateContent models', async () => {
    const m = mockFetch(() => jsonResponse(geminiReply('', 'SAFETY')));
    const inst = createProvider(configFromPreset('gemini', { defaultModel: 'gemini-2.5-pro' }), depsWith(m.fetch, { 'provider:gemini': GEMINI_KEY }));
    const err = (await inst.llm!.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)) as ProviderError;
    expect(err.kind).toBe('refusal');

    const list = mockFetch(() =>
      jsonResponse({
        models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    );
    const inst2 = createProvider(configFromPreset('gemini'), depsWith(list.fetch, { 'provider:gemini': GEMINI_KEY }));
    const models = await inst2.llm!.listModels();
    expect(list.calls[0].url).toContain('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(models.map((x) => x.id)).toEqual(['gemini-2.5-pro']);
    expect(models[0].capabilities).toEqual(expect.arrayContaining(['AUDIO_INPUT', 'AUDIO_UNDERSTANDING', 'LONG_CONTEXT', 'STRUCTURED_JSON']));
  });
});

describe('Ollama adapter', () => {
  it('lists /api/tags (+ /api/show) and chats with format = JSON schema', async () => {
    const m = mockFetch((call) => {
      if (call.url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'llama3.1:8b', size: 4_900_000_000, details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_K_M' } }, { name: 'nomic-embed-text:latest', details: { parameter_size: '137M' } }] });
      if (call.url.endsWith('/api/show')) {
        const model = (bodyJson(call) as { model: string }).model;
        return jsonResponse(model.startsWith('nomic') ? { capabilities: ['embedding'] } : { model_info: { 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] });
      }
      return jsonResponse({ model: 'llama3.1:8b', message: { role: 'assistant', content: '<think>hmm</think>{"explanation":"e","confidence":0.6,"operations":[]}' }, done: true, done_reason: 'stop', prompt_eval_count: 321, eval_count: 54 });
    });
    const inst = createProvider(configFromPreset('ollama'), depsWith(m.fetch));
    const models = await inst.llm!.listModels();
    expect(models.map((x) => x.id)).toEqual(['llama3.1:8b']);
    expect(models[0].capabilities).toEqual(expect.arrayContaining(['TOOL_CALLING', 'LONG_CONTEXT']));
    expect(models[0].qualityTier).toBe(2);
    const res = await inst.llm!.complete({ system: 'sys', messages: [{ role: 'user', content: 'x' }], responseSchema: OPERATIONS_SCHEMA, maxTokens: 777 });
    const chat = m.calls.find((c) => c.url.endsWith('/api/chat'))!;
    expect(chat.url).toBe('http://localhost:11434/api/chat');
    const body = bodyJson(chat) as Record<string, any>;
    expect(body.model).toBe('llama3.1:8b');
    expect(body.stream).toBe(false);
    expect(body.format.type).toBe('object');
    expect(body.format.properties.operations.items.properties.op.enum).toContain('replace_notes');
    expect(body.options).toEqual({ num_ctx: 8192, num_predict: 777 });
    expect(body.messages[0].role).toBe('system');
    expect(res.json).toEqual({ explanation: 'e', confidence: 0.6, operations: [] });
    expect(res.usage).toEqual({ inputTokens: 321, outputTokens: 54 });
    expect(res.costUsd).toBe(0);
  });
});

describe('Custom HTTP LLM adapter', () => {
  it('renders the request template and reads the response text path', async () => {
    const m = mockFetch(() => jsonResponse({ results: [{ text: '{"answer":"ok","suggestions":[],"operations":[],"confidence":0.9}' }], usage: { in: 10, out: 5 } }));
    const cfg = configFromPreset('custom-llm-http', {
      baseUrl: 'http://localhost:9000/api/{{model}}/generate',
      defaultModel: 'my model',
      extra: {
        customTemplate: {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-client': 'songdeck' },
          body: '{"system":"{{system}}","prompt":"{{prompt}}","schema":{{schema_json}},"max_new_tokens":{{max_tokens}},"history":{{messages_json}}}',
          responseTextPath: 'results[0].text',
          inputTokensPath: 'usage.in',
          outputTokensPath: 'usage.out',
        },
      },
    });
    const inst = createProvider(cfg, depsWith(m.fetch));
    const res = await inst.llm!.complete({ system: 'Say "hi"\nnow', messages: [{ role: 'user', content: 'Line "one"' }], responseSchema: CANONICAL_SCHEMAS.chat_answer, maxTokens: 64 });
    const call = m.calls[0];
    expect(call.url).toBe('http://localhost:9000/api/my%20model/generate');
    expect(call.headers.get('x-client')).toBe('songdeck');
    const body = bodyJson(call) as Record<string, any>;
    expect(body.system.startsWith('Say "hi"\nnow')).toBe(true);
    expect(body.prompt).toBe('Line "one"');
    expect(body.max_new_tokens).toBe(64);
    expect(body.schema.type).toBe('object');
    expect(body.history[0].role).toBe('system');
    expect(res.json).toEqual({ answer: 'ok', suggestions: [], operations: [], confidence: 0.9 });
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('renderTemplate escapes strings and inserts raw JSON', () => {
    const out = renderTemplate('{"p":"{{prompt}}","m":{{messages_json}},"t":{{temperature}}}', { system: '', prompt: 'a"b\\c', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 });
    expect(JSON.parse(out)).toEqual({ p: 'a"b\\c', m: [{ role: 'user', content: 'x' }], t: null });
    expect(new CustomHttpLLM(configFromPreset('custom-llm-http'), {} as never)).toBeTruthy();
  });

  it('LLM providers get a composition provider auto-derived', () => {
    const inst = createProvider(configFromPreset('custom-llm-http'), depsWith(mockFetch(() => jsonResponse({})).fetch));
    expect(inst.composition).toBeInstanceOf(LLMCompositionProvider);
  });
});
