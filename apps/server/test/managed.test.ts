import {
  createProvider,
  ProviderError,
  ServerProxyTransport,
  ServerVaultClient,
  type ProviderConfig,
} from '@songdeck/ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardedFetch } from '../src/managed';
import { json, startMock, startServer, type MockServer, type TestServer } from './helpers';

let srv: TestServer;
let llm: MockServer;
const SECRET = 'sk-mock-0123456789abcdefghij';

/** A minimal OpenAI-compatible server. */
async function startMockOpenAI(): Promise<MockServer> {
  return startMock((req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'test' }] }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      const parsed = JSON.parse(body.toString() || '{}') as { messages?: { content: unknown }[] };
      const last = JSON.stringify(parsed.messages?.at(-1)?.content ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'mock-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: `Hello from mock (${last.length} chars)` },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
}

function providerConfig(location: 'cloud' | 'local'): ProviderConfig {
  return {
    id: 'mock-llm',
    name: 'Mock LLM',
    adapter: 'openai-compatible',
    enabled: true,
    location,
    baseUrl: `${llm.url}/v1`,
    auth: { type: 'bearer' },
    credentialRef: 'provider:mock-llm',
    defaultModel: 'mock-model',
    structuredOutput: 'prompt',
    timeoutMs: 10_000,
    concurrency: 2,
  };
}

async function configure(location: 'cloud' | 'local') {
  const vault = new ServerVaultClient(srv.url);
  await vault.setSecret('provider:mock-llm', SECRET, 'Mock key');
  const res = await fetch(`${srv.url}/api/providers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers: [providerConfig(location)] }),
  });
  expect(res.status).toBe(200);
}

function managedLlm(body: Record<string, unknown>) {
  return fetch(`${srv.url}/api/managed/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const llmBody = (privacy: Record<string, unknown> = {}) => ({
  role: 'composition',
  quality: 'standard',
  request: { messages: [{ role: 'user', content: 'Plan a melancholy song in E minor' }], maxTokens: 64 },
  privacy: { neverUpload: [], dataKinds: ['song-description'], ...privacy },
});

beforeEach(async () => {
  llm = await startMockOpenAI();
  srv = await startServer();
});

afterEach(async () => {
  await srv.close();
  await llm.close();
});

describe('managed "Automatic" gateway', () => {
  it('routes an LLM request to a configured provider with the key from the vault', async () => {
    await configure('cloud');
    const res = await managedLlm(llmBody());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.text).toMatch(/^Hello from mock/);
    expect(body.provenance).toMatchObject({ providerId: 'mock-llm', role: 'composition', cloud: true });
    const call = llm.requests.find((r) => r.url === '/v1/chat/completions');
    expect(call?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect((await json(await fetch(`${srv.url}/api/health`))).features).toContain('managed');
  });

  it('honours neverUpload and offline flags and answers 503 when nothing is compatible', async () => {
    await configure('cloud');
    const never = await managedLlm(llmBody({ neverUpload: ['song-description'] }));
    expect(never.status).toBe(503);
    expect(await json(never)).toMatchObject({
      code: 'no-compatible-provider',
      error: expect.stringMatching(/No compatible provider/),
    });
    const offline = await managedLlm({ ...llmBody(), offline: true });
    expect(offline.status).toBe(503);
    const localOnly = await managedLlm(llmBody({ localOnly: true }));
    expect(localOnly.status).toBe(503);
    expect(llm.requests.filter((r) => r.url === '/v1/chat/completions')).toHaveLength(0);
    const audio = await fetch(`${srv.url}/api/managed/audio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'production',
        quality: 'draft',
        request: { op: 'generateMusic', params: { prompt: 'lofi', durationSeconds: 10 } },
        privacy: { neverUpload: [], dataKinds: ['song-description'] },
      }),
    });
    expect(audio.status).toBe(503);
  });

  it('serves offline requests from local providers', async () => {
    await configure('local');
    const res = await managedLlm({
      ...llmBody({ neverUpload: ['song-description', 'midi'] }),
      offline: true,
    });
    expect(res.status).toBe(200);
    expect((await json(res)).provenance).toMatchObject({ providerId: 'mock-llm', cloud: false });
  });

  it('reports which roles can be served and the gateway capabilities', async () => {
    let status = await json(await fetch(`${srv.url}/api/managed/status`));
    expect(status.available).toBe(true);
    expect(status.roles.composition).toMatchObject({ available: false, localAvailable: false });
    await configure('cloud');
    status = await json(await fetch(`${srv.url}/api/managed/status`));
    expect(status.providers).toEqual([
      expect.objectContaining({ id: 'mock-llm', status: 'ready', location: 'cloud' }),
    ]);
    expect(status.roles.composition).toMatchObject({
      available: true,
      providerId: 'mock-llm',
      location: 'cloud',
      localAvailable: false,
    });
    expect(status.roles.production.available).toBe(false);
    expect(status.roles.vocals.available).toBe(false);
    const models = await json(
      await fetch(`${srv.url}/api/managed/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(models.providers.map((p: { id: string }) => p.id)).toEqual(['mock-llm']);
    expect(models.capabilities).toContain('TEXT_REASONING');
  });

  it('never routes to managed providers (no gateway loops) and validates requests', async () => {
    await fetch(`${srv.url}/api/providers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          {
            id: 'auto',
            name: 'Automatic',
            adapter: 'managed',
            enabled: true,
            location: 'cloud',
            baseUrl: srv.url,
            auth: { type: 'none' },
            timeoutMs: 1000,
            concurrency: 1,
          },
        ],
      }),
    });
    const res = await managedLlm(llmBody());
    expect(res.status).toBe(503);
    const bad = await managedLlm({ role: 'composition', request: {} });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ code: 'bad-request', error: expect.any(String) });
  });
});

describe('@songdeck/ai ServerProxyTransport ↔ /api/proxy', () => {
  it('lets a browser-side provider call through the proxy without holding the key', async () => {
    await configure('cloud');
    const transport = new ServerProxyTransport(srv.url);
    const provider = createProvider(providerConfig('cloud'), {
      transport,
      retry: { retries: 0, baseDelayMs: 0 },
    });
    const out = await provider.llm!.complete({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 16,
    });
    expect(out.text).toMatch(/^Hello from mock/);
    const models = await provider.llm!.listModels();
    expect(models.map((m) => m.id)).toContain('mock-model');
    // A vault miss surfaces as an auth ProviderError on the client.
    await new ServerVaultClient(srv.url).deleteSecret('provider:mock-llm');
    const err = await provider
      .llm!.complete({ messages: [{ role: 'user', content: 'hello' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('auth');
  });
});

describe('managed gateway transport', () => {
  it('keeps credentials on same-origin redirects only and refuses non-allowlisted ones', async () => {
    const b = await startMock((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: 'b', key: req.headers['x-api-key'] ?? null }));
    });
    const a = await startMock((req, res) => {
      if (req.url === '/same') {
        res.writeHead(307, { location: '/final' });
        res.end();
      } else if (req.url === '/cross') {
        res.writeHead(302, { location: `${b.url}/landing` });
        res.end();
      } else if (req.url === '/evil') {
        res.writeHead(302, { location: 'https://evil.example/' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ host: 'a', key: req.headers['x-api-key'] ?? null }));
      }
    });
    try {
      const allowed = (u: URL) => u.origin === new URL(a.url).origin || u.origin === new URL(b.url).origin;
      const f = guardedFetch((input, init) => globalThis.fetch(input, init), allowed);
      const headers = { 'x-api-key': 'k-secret', accept: 'application/json' };
      expect(await (await f(`${a.url}/same`, { headers })).json()).toEqual({ host: 'a', key: 'k-secret' });
      expect(await (await f(`${a.url}/cross`, { headers })).json()).toEqual({ host: 'b', key: null });
      await expect(f(`${a.url}/evil`, { headers })).rejects.toThrow(/refused/);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
