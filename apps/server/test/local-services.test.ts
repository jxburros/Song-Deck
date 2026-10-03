import { afterEach, describe, expect, it } from 'vitest';
import type { HardwareInfo } from '../src/hardware';
import type { ModelEntry } from '../src/models';
import { json, startMock, startServer, type MockServer, type TestServer } from './helpers';

/**
 * Local service detection (`GET /api/local-services`, the model manager) against real local HTTP
 * servers on random ports, and key validation (`POST /api/connect/probe`) against a mocked upstream.
 */

let srv: TestServer | undefined;
const mocks: MockServer[] = [];
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  for (const m of mocks.splice(0)) await m.close();
});

const HW: HardwareInfo = {
  cpu: { model: 'Test CPU', cores: 8, threads: 16 },
  ramGb: 32,
  freeRamGb: 20,
  gpus: [],
  storageFreeGb: 500,
  backends: ['cpu'],
  accelerationBackends: ['cpu'],
  platform: 'linux',
  arch: 'x64',
  os: 'linux test',
  detectedAt: '2026-01-01T00:00:00.000Z',
};

const reply = (res: import('node:http').ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function fakeServices() {
  const ollama = await startMock((req, res) => (req.url === '/api/tags' ? reply(res, { models: [{ name: 'qwen3:8b', details: { parameter_size: '8.2B' } }, { name: 'nomic-embed-text:latest' }] }) : reply(res, {}, 404)));
  const llamaCpp = await startMock((req, res) => (req.url === '/v1/models' ? reply(res, { object: 'list', data: [{ id: 'gemma-3-12b-it-Q4_K_M.gguf', object: 'model' }] }) : reply(res, {}, 404)));
  const vllm = await startMock((req, res) => (req.url === '/v1/models' ? reply(res, { data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct', max_model_len: 131072 }] }) : reply(res, {}, 404)));
  const demucs = await startMock((req, res) => (req.url === '/info' ? reply(res, { name: 'htdemucs', version: '4.0.1', capabilities: ['SOURCE_SEPARATION', 'VOCAL_ISOLATION', 'STEM_OUTPUT'] }) : reply(res, {}, 404)));
  const custom = await startMock((req, res) => (req.url === '/info' ? reply(res, { name: 'My Synth Model', models: [{ id: 'synth-1', name: 'Synth 1', capabilities: ['text_to_music'] }] }) : reply(res, {}, 404)));
  mocks.push(ollama, llamaCpp, vllm, demucs, custom);
  // A port nothing listens on (the mock is closed right away).
  const gone = await startMock(() => undefined);
  await gone.close();
  return { ollama, llamaCpp, vllm, demucs, custom, gone };
}

describe('local service detection', () => {
  it('GET /api/local-services finds running servers on configurable URLs, with their models', async () => {
    const f = await fakeServices();
    srv = await startServer({
      discovery: {
        ollamaUrl: f.ollama.url,
        lmStudioUrl: `${f.gone.url}/v1`,
        timeoutMs: 1000,
        localServices: [
          { presetId: 'llama-cpp', baseUrl: `${f.llamaCpp.url}/v1`, kind: 'openai' },
          { presetId: 'vllm', baseUrl: `${f.vllm.url}/v1`, kind: 'openai' },
          { presetId: 'demucs-local', baseUrl: f.demucs.url, kind: 'bridge' },
          { presetId: 'custom-audio-http', baseUrl: f.custom.url, kind: 'bridge' },
          { presetId: 'rvc-local', baseUrl: f.gone.url, kind: 'bridge' },
          // Never probed: not on this machine.
          { presetId: 'ace-step-local', baseUrl: 'http://203.0.113.9:8810', kind: 'bridge' },
        ],
      },
    });
    const t0 = Date.now();
    const res = await fetch(`${srv.url}/api/local-services`);
    expect(res.status).toBe(200);
    const { services } = await json<{ services: { presetId: string; status: string; baseUrl: string; models: { id: string; capabilities: string[] }[]; capabilities?: string[]; version?: string }[] }>(res);
    expect(Date.now() - t0).toBeLessThan(5000);
    const by = Object.fromEntries(services.map((s) => [s.presetId, s]));
    expect(Object.keys(by).sort()).toEqual(['custom-audio-http', 'demucs-local', 'llama-cpp', 'lm-studio', 'ollama', 'rvc-local', 'vllm']);
    expect(by.ollama).toMatchObject({ status: 'found', baseUrl: f.ollama.url });
    expect(by.ollama.models.map((m) => m.id)).toEqual(['qwen3:8b']);
    expect(by['llama-cpp'].models[0]).toMatchObject({ id: 'gemma-3-12b-it-Q4_K_M.gguf', capabilities: expect.arrayContaining(['LYRIC_GENERATION']) });
    expect(by.vllm.models[0].capabilities).toContain('LONG_CONTEXT');
    expect(by['demucs-local']).toMatchObject({ status: 'found', version: '4.0.1', capabilities: ['SOURCE_SEPARATION', 'VOCAL_ISOLATION', 'STEM_OUTPUT'] });
    expect(by['custom-audio-http'].models).toEqual([{ id: 'synth-1', name: 'Synth 1', capabilities: ['TEXT_TO_MUSIC'] }]);
    expect(by['lm-studio'].status).toBe('absent');
    expect(by['rvc-local'].status).toBe('absent');
  });

  it('the model manager lists models of unconfigured llama.cpp / vLLM servers and bridges', async () => {
    const f = await fakeServices();
    srv = await startServer({
      hardware: { detect: async () => HW },
      discovery: {
        timeoutMs: 1000,
        localServices: [
          { presetId: 'llama-cpp', baseUrl: `${f.llamaCpp.url}/v1`, kind: 'openai' },
          { presetId: 'vllm', baseUrl: `${f.vllm.url}/v1`, kind: 'openai' },
          { presetId: 'demucs-local', baseUrl: f.demucs.url, kind: 'bridge' },
        ],
      },
    });
    const report = await json<{ categories: { id: string; models: ModelEntry[] }[]; sources: { source: string; status: string }[] }>(await fetch(`${srv.url}/api/models`));
    const models = report.categories.flatMap((c) => c.models);
    expect(models.some((m) => m.name === 'gemma-3-12b-it-Q4_K_M.gguf' && m.installed && m.provider === 'llama.cpp server')).toBe(true);
    // vLLM's model is in the catalog: the catalog entry is marked installed through vLLM.
    expect(models.find((m) => m.installedVia?.some((v) => v.startsWith('vLLM@')))).toMatchObject({ id: 'llama-3.1-8b-instruct', installed: true });
    const sep = report.categories.find((c) => c.id === 'separation')!.models;
    expect(sep.some((m) => m.installed && m.installedVia?.includes('provider:demucs-local'))).toBe(true);
    expect(report.sources.find((s) => s.source === 'local:demucs-local')?.status).toBe('ok');
  });
});

describe('connect probe', () => {
  it('validates a key against the preset URL only and never echoes or stores it', async () => {
    const seen: { url: string; key?: string }[] = [];
    const upstream: typeof fetch = async (input, init) => {
      const url = String(input);
      const key = new Headers(init?.headers).get('x-goog-api-key') ?? undefined;
      seen.push({ url, key });
      if (key !== 'AIzaSyGOOD0123456789abcdefghijklmnopqrs') return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }] }), { headers: { 'content-type': 'application/json' } });
    };
    srv = await startServer({ proxy: { fetch: upstream } });
    const post = (body: unknown) => fetch(`${srv!.url}/api/connect/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const ok = await json(await post({ presetId: 'gemini', secret: ' AIzaSyGOOD0123456789abcdefghijklmnopqrs ' }));
    expect(ok.ok).toBe(true);
    expect(ok.result.models.map((m: { id: string }) => m.id)).toEqual(['gemini-2.5-pro']);
    expect(seen[0].url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models/);

    const bad = await (await post({ presetId: 'gemini', secret: 'AIzaSyBAD00123456789abcdefghijklmnopqrs' })).text();
    expect(JSON.parse(bad)).toMatchObject({ ok: false, error: { kind: 'bad-request', status: 400, message: expect.stringMatching(/API key not valid/) } });
    expect(bad).not.toContain('AIzaSyBAD');

    // Only connectable cloud presets; the caller cannot pick a URL.
    expect((await post({ presetId: 'ollama', secret: 'x' })).status).toBe(400);
    expect((await post({ presetId: 'gemini', secret: '', baseUrl: 'http://evil.example' })).status).toBe(400);
    expect(seen.every((s) => s.url.startsWith('https://generativelanguage.googleapis.com/'))).toBe(true);
    // Nothing was written to the vault.
    expect((await json(await fetch(`${srv.url}/api/vault`))).refs).toEqual([]);
  });
});
