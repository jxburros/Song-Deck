import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  configFromPreset,
  createProvider,
  decodeMultipart,
  DirectTransport,
  encodeMultipart,
  HttpClient,
  MemoryCredentialStore,
  ProviderError,
  RateLimiter,
  RequestGate,
  Semaphore,
  ServerProxyTransport,
  ServerVaultClient,
  withRetry,
  type Clock,
} from '../src';
import { bodyJson, bytesResponse, FAKE_WAV, jsonResponse, mockFetch } from './helpers';

describe('DirectTransport', () => {
  it('injects secrets per auth spec (bearer, header, query, none)', async () => {
    const m = mockFetch(() => jsonResponse({}));
    const t = new DirectTransport(new MemoryCredentialStore({ k: 'SECRET' }), { fetch: m.fetch });
    await t.fetch('https://a.example/x', { headers: { 'x-api-key': 'placeholder' } }, { type: 'bearer', credentialRef: 'k' });
    await t.fetch('https://a.example/x', { headers: { 'x-api-key': 'placeholder' } }, { type: 'header', name: 'x-api-key', credentialRef: 'k' });
    await t.fetch('https://a.example/x?a=1', {}, { type: 'query', name: 'key', credentialRef: 'k' });
    await t.fetch('https://a.example/x', {}, { type: 'header', name: 'Authorization', prefix: 'Token ', credentialRef: 'k' });
    await t.fetch('https://a.example/x', {}, { type: 'none' });
    expect(m.calls[0].headers.get('authorization')).toBe('Bearer SECRET');
    expect(m.calls[1].headers.get('x-api-key')).toBe('SECRET');
    expect(m.calls[2].url).toBe('https://a.example/x?a=1&key=SECRET');
    expect(m.calls[3].headers.get('authorization')).toBe('Token SECRET');
    expect(m.calls[4].headers.get('authorization')).toBeNull();
  });

  it('fails with an auth error when the secret is missing', async () => {
    const m = mockFetch(() => jsonResponse({}));
    const t = new DirectTransport(new MemoryCredentialStore(), { fetch: m.fetch });
    await expect(t.fetch('https://a.example', {}, { type: 'bearer', credentialRef: 'missing' })).rejects.toMatchObject({ kind: 'auth' });
    await expect(t.fetch('https://a.example', {}, { type: 'bearer' })).rejects.toMatchObject({ kind: 'auth' });
    expect(m.calls).toHaveLength(0);
  });
});

describe('ServerProxyTransport', () => {
  it('wraps requests in the proxy envelope (binary bodies as base64) and passes binary responses through', async () => {
    const audioOut = new Uint8Array(256).map((_, i) => i);
    const proxy = mockFetch(() => bytesResponse(audioOut, 'audio/wav', { 'x-upstream': 'yes' }));
    const t = new ServerProxyTransport('http://localhost:4317/', { fetch: proxy.fetch, headers: { 'x-songdeck-session': 'abc' } });
    const mp = encodeMultipart([{ name: 'prompt', value: 'hello' }, { name: 'audio', data: FAKE_WAV, filename: 'in.wav', contentType: 'audio/wav' }], 'BOUNDARY');
    const res = await t.fetch(
      'https://api.stability.ai/v2beta/audio/stable-audio-2/audio-to-audio',
      { method: 'POST', headers: { 'content-type': mp.contentType, accept: 'audio/*', 'content-length': '999' }, body: mp.body },
      { type: 'bearer', credentialRef: 'provider:stability-audio' },
    );
    expect(proxy.calls[0].url).toBe('http://localhost:4317/api/proxy');
    expect(proxy.calls[0].method).toBe('POST');
    expect(proxy.calls[0].headers.get('x-songdeck-session')).toBe('abc');
    const env = bodyJson(proxy.calls[0]) as Record<string, any>;
    expect(env).toMatchObject({
      url: 'https://api.stability.ai/v2beta/audio/stable-audio-2/audio-to-audio',
      method: 'POST',
      bodyEncoding: 'base64',
      credentialRef: 'provider:stability-audio',
      auth: { type: 'bearer' },
    });
    expect(env.headers['content-type']).toBe('multipart/form-data; boundary=BOUNDARY');
    expect(env.headers).not.toHaveProperty('content-length');
    expect([...base64ToBytes(env.body)]).toEqual([...mp.body]);
    // Upstream passthrough (status, headers, binary body).
    expect(res.status).toBe(200);
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...audioOut]);
  });

  it('sends JSON bodies as utf8, passes upstream errors through, and surfaces proxy failures', async () => {
    const proxy = mockFetch((call) => {
      const env = bodyJson(call) as Record<string, any>;
      if (env.url.includes('fail')) return new Response(JSON.stringify({ error: 'No secret for provider:x in vault' }), { status: 502, headers: { 'content-type': 'application/json', 'x-songdeck-proxy-error': '1' } });
      return jsonResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '3' });
    });
    const t = new ServerProxyTransport('', { fetch: proxy.fetch });
    const res = await t.fetch('https://api.example.com/v1/x', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } }, { type: 'header', name: 'x-api-key', credentialRef: 'provider:x' });
    expect(proxy.calls[0].url).toBe('/api/proxy');
    const env = bodyJson(proxy.calls[0]) as Record<string, any>;
    expect(env.body).toBe('{"a":1}');
    expect(env.bodyEncoding).toBe('utf8');
    expect(env.auth).toEqual({ type: 'header', name: 'x-api-key' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    const err = (await t.fetch('https://fail.example.com', {}, { type: 'bearer', credentialRef: 'provider:x' }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('auth');
    expect(err.message).toContain('No secret');
  });

  it('works end-to-end for adapters (OpenAI through the proxy keeps keys server-side)', async () => {
    const proxy = mockFetch(() => jsonResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const inst = createProvider(configFromPreset('openai', { defaultModel: 'gpt-4.1' }), { transport: new ServerProxyTransport('http://127.0.0.1:4317', { fetch: proxy.fetch }) });
    const res = await inst.llm!.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('hello');
    const env = bodyJson(proxy.calls[0]) as Record<string, any>;
    expect(env.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(env.credentialRef).toBe('provider:openai');
    expect(env.headers).not.toHaveProperty('authorization');
  });
});

describe('ServerVaultClient', () => {
  it('lists refs and writes/deletes secrets (write-only)', async () => {
    const m = mockFetch((call) => {
      if (call.method === 'GET') return jsonResponse({ backend: 'keychain', refs: [{ ref: 'provider:openai', label: 'OpenAI', updatedAt: '2026-10-01T00:00:00Z' }] });
      return new Response(null, { status: 204 });
    });
    const vault = new ServerVaultClient('http://localhost:4317', { fetch: m.fetch });
    const status = await vault.status();
    expect(status.backend).toBe('keychain');
    expect(await vault.has('provider:openai')).toBe(true);
    await vault.setSecret('provider:anthropic', 'sk-ant-xyz', 'Anthropic');
    await vault.deleteSecret('provider:anthropic');
    expect(m.calls[2]).toMatchObject({ url: 'http://localhost:4317/api/vault/provider%3Aanthropic', method: 'PUT' });
    expect(bodyJson(m.calls[2])).toEqual({ secret: 'sk-ant-xyz', label: 'Anthropic' });
    expect(m.calls[3]).toMatchObject({ url: 'http://localhost:4317/api/vault/provider%3Aanthropic', method: 'DELETE' });
    expect(await vault.asCredentialStore().get('provider:openai')).toBeUndefined();
  });
});

describe('multipart & base64', () => {
  it('round-trips fields and binary files', () => {
    const data = new Uint8Array([0, 13, 10, 45, 45, 255]);
    const mp = encodeMultipart([{ name: 'a', value: 1 }, { name: 'f', data, filename: 'x.bin' }]);
    const parts = decodeMultipart(mp.body, mp.contentType);
    expect(parts.map((p) => p.name)).toEqual(['a', 'f']);
    expect(parts[0].text).toBe('1');
    expect([...parts[1].data]).toEqual([...data]);
    expect(parts[1].contentType).toBe('application/octet-stream');
  });
  it('base64 matches Node', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 100, 1001]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37) & 255);
      const enc = bytesToBase64(bytes);
      expect(enc).toBe(Buffer.from(bytes).toString('base64'));
      expect([...base64ToBytes(enc)]).toEqual([...bytes]);
    }
  });
});

describe('limits, retries, timeouts', () => {
  it('semaphore caps concurrency', async () => {
    const gate = new RequestGate({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    const job = () =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 6 }, job));
    expect(peak).toBe(2);
    const s = new Semaphore(1);
    const release = await s.acquire();
    const ac = new AbortController();
    const waiting = s.acquire(ac.signal);
    ac.abort();
    await expect(waiting).rejects.toBeTruthy();
    release();
    expect(s.inUse).toBe(0);
  });

  it('rate limiter waits for the window', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const clock: Clock = {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    };
    const rl = new RateLimiter(2, clock);
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(sleeps).toEqual([60_001]);
  });

  it('retries 429/5xx with backoff (max 2) honoring Retry-After', async () => {
    let n = 0;
    const m = mockFetch(() => (++n < 3 ? jsonResponse({ error: 'busy' }, n === 1 ? 429 : 503, n === 1 ? { 'retry-after': '1' } : {}) : jsonResponse({ ok: true })));
    const delays: number[] = [];
    const clock: Clock = { now: () => 0, sleep: async (ms) => void delays.push(ms) };
    const http = new HttpClient({ providerId: 'p', transport: new DirectTransport(undefined, { fetch: m.fetch }), retry: { clock, baseDelayMs: 100 } });
    expect(await http.json({ url: 'https://x.example' })).toEqual({ ok: true });
    expect(m.calls).toHaveLength(3);
    expect(delays).toEqual([1000, 200]);
    // Non-retryable errors fail immediately.
    const bad = mockFetch(() => jsonResponse({ error: { message: 'nope' } }, 400));
    const http2 = new HttpClient({ providerId: 'p', transport: new DirectTransport(undefined, { fetch: bad.fetch }), retry: { clock } });
    await expect(http2.json({ url: 'https://x.example' })).rejects.toMatchObject({ kind: 'bad-request', message: 'nope', status: 400 });
    expect(bad.calls).toHaveLength(1);
    // withRetry gives up after 2 retries.
    let tries = 0;
    await expect(withRetry(async () => {
      tries++;
      throw new ProviderError('unavailable', 'down');
    }, { clock })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(tries).toBe(3);
  });

  it('times out slow requests and honors cancellation', async () => {
    const slow = async (_u: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(jsonResponse({})), 1000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const http = new HttpClient({ providerId: 'p', transport: new DirectTransport(undefined, { fetch: slow }), timeoutMs: 20 });
    await expect(http.json({ url: 'https://slow.example' })).rejects.toMatchObject({ kind: 'timeout' });
    const http2 = new HttpClient({ providerId: 'p', transport: new DirectTransport(undefined, { fetch: slow }), timeoutMs: 5000 });
    const ac = new AbortController();
    const p = http2.json({ url: 'https://slow.example', signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
