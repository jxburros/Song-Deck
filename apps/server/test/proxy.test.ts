import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json, startMock, startServer, type MockServer, type TestServer } from './helpers';

let srv: TestServer;
let upstream: MockServer;
let other: MockServer;

const SECRET = 'sk-live-0123456789abcdef0123';

async function setSecret(ref: string, secret: string) {
  const res = await fetch(`${srv.url}/api/vault/${encodeURIComponent(ref)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  expect(res.status).toBe(204);
}

async function registerProviders(providers: unknown[]) {
  const res = await fetch(`${srv.url}/api/providers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers }),
  });
  expect(res.status).toBe(200);
}

function provider(id: string, baseUrl: string, auth: Record<string, unknown>, credentialRef?: string) {
  return {
    id,
    name: id,
    adapter: 'openai-compatible',
    enabled: true,
    location: 'cloud',
    baseUrl,
    auth,
    credentialRef,
    timeoutMs: 30000,
    concurrency: 2,
  };
}

function proxy(envelope: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${srv.url}/api/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(envelope),
  });
}

beforeEach(async () => {
  upstream = await startMock((req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/v1/echo') {
      res.writeHead(201, {
        'content-type': 'application/octet-stream',
        'x-upstream': 'yes',
        'set-cookie': 'session=abc; HttpOnly',
        'access-control-allow-origin': '*',
      });
      res.end(body);
      return;
    }
    if (url.pathname === '/v1/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          auth: req.headers.authorization ?? null,
          key: req.headers['x-api-key'] ?? null,
          q: url.searchParams.get('key'),
        }),
      );
      return;
    }
    if (url.pathname === '/v1/status') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
      return;
    }
    if (url.pathname === '/v1/redirect-same') {
      res.writeHead(307, { location: '/v1/json' });
      res.end();
      return;
    }
    if (url.pathname === '/v1/redirect-out') {
      res.writeHead(302, { location: `${other.url}/v1/json` });
      res.end();
      return;
    }
    if (url.pathname === '/v1/redirect-path') {
      res.writeHead(302, { location: '/v2/json' });
      res.end();
      return;
    }
    if (url.pathname === '/v1/redirect-userinfo') {
      const target = new URL(`${other.url}/v1/json`);
      target.username = 'user';
      target.password = 'password';
      res.writeHead(302, { location: target.href });
      res.end();
      return;
    }
    if (url.pathname === '/v1/redirect-query') {
      res.writeHead(302, { location: `${other.url}/v1/json?key=public&key=${url.searchParams.get('key')}` });
      res.end();
      return;
    }
    if (url.pathname === '/v1/redirect-evil') {
      res.writeHead(302, { location: 'https://evil.example/steal' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  other = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ other: true, auth: req.headers.authorization ?? null }));
  });
  srv = await startServer();
});

afterEach(async () => {
  await srv.close();
  await upstream.close();
  await other.close();
});

describe('provider proxy', () => {
  it('injects a bearer token from the vault', async () => {
    await registerProviders([
      provider('openai', `${upstream.url}/v1`, { type: 'bearer' }, 'provider:openai'),
    ]);
    await setSecret('provider:openai', SECRET);
    const res = await proxy({
      url: `${upstream.url}/v1/json`,
      method: 'GET',
      headers: { accept: 'application/json' },
      credentialRef: 'provider:openai',
      auth: { type: 'bearer' },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, auth: `Bearer ${SECRET}` });
  });

  it('overrides placeholder header credentials (x-api-key: proxy-managed)', async () => {
    await registerProviders([
      provider(
        'anthropic',
        `${upstream.url}/v1`,
        { type: 'header', name: 'x-api-key' },
        'provider:anthropic',
      ),
    ]);
    await setSecret('provider:anthropic', SECRET);
    const res = await proxy({
      url: `${upstream.url}/v1/json`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'proxy-managed',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ hello: 'world' }),
      bodyEncoding: 'utf8',
      credentialRef: 'provider:anthropic',
      auth: { type: 'header', name: 'x-api-key', prefix: '' },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.key).toBe(SECRET);
    const seen = upstream.requests.at(-1)!;
    expect(seen.headers['x-api-key']).toBe(SECRET);
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen.body.toString()).toBe('{"hello":"world"}');
  });

  it('appends query-parameter credentials', async () => {
    await registerProviders([
      provider('gemini', `${upstream.url}/v1`, { type: 'query', name: 'key' }, 'provider:gemini'),
    ]);
    await setSecret('provider:gemini', SECRET);
    const res = await proxy({
      url: `${upstream.url}/v1/json?alt=json&key=placeholder`,
      method: 'GET',
      headers: {},
      credentialRef: 'provider:gemini',
      auth: { type: 'query', name: 'key' },
    });
    expect(await json(res)).toMatchObject({ q: SECRET });
    expect(upstream.requests.at(-1)!.url).toBe(`/v1/json?alt=json&key=${SECRET}`);
  });

  it('passes binary bodies and statuses through unchanged and filters headers', async () => {
    await registerProviders([provider('local', `${upstream.url}/v1`, { type: 'none' })]);
    const bytes = Buffer.from(Array.from({ length: 256 * 4 }, (_, i) => i % 256));
    const res = await proxy(
      {
        url: `${upstream.url}/v1/echo`,
        method: 'POST',
        headers: { 'content-type': 'audio/wav', cookie: 'studio=1', host: 'evil' },
        body: bytes.toString('base64'),
        bodyEncoding: 'base64',
      },
      { origin: 'http://localhost:5173' },
    );
    expect(res.status).toBe(201);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(res.headers.get('set-cookie')).toBeNull();
    // Our CORS headers win over the upstream's.
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const seen = upstream.requests.at(-1)!;
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.host).toBe(new URL(upstream.url).host);
    expect(seen.body.equals(bytes)).toBe(true);
  });

  it('relays upstream error statuses with their headers (not as proxy errors)', async () => {
    const res = await proxy({ url: `${upstream.url}/v1/status`, method: 'GET', headers: {} });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get('x-songdeck-proxy-error')).toBeNull();
    expect(await json(res)).toEqual({ error: { message: 'slow down' } });
  });

  it('allows loopback URLs without registration but rejects non-allowlisted hosts', async () => {
    const local = await proxy({ url: `${upstream.url}/v1/json`, method: 'GET', headers: {} });
    expect(local.status).toBe(200);
    const res = await proxy({
      url: 'https://api.example.com/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-songdeck-proxy-error')).toBe('1');
    expect(await json(res)).toMatchObject({ code: 'not-allowlisted' });
  });

  it('honours origin + path-prefix allowlisting of registered providers', async () => {
    const { computeAllowlist, ruleMatches } = await import('../src/providers');
    const rules = computeAllowlist([
      provider('openai', 'https://api.openai.com/v1', { type: 'bearer' }, 'provider:openai') as never,
    ]);
    expect(ruleMatches(rules[0], new URL('https://api.openai.com/v1/chat/completions'))).toBe(true);
    expect(ruleMatches(rules[0], new URL('https://api.openai.com/v1'))).toBe(true);
    expect(ruleMatches(rules[0], new URL('https://api.openai.com/v10/x'))).toBe(false);
    expect(ruleMatches(rules[0], new URL('https://api.openai.com/other'))).toBe(false);
    expect(ruleMatches(rules[0], new URL('https://api.openai.com.evil.example/v1/x'))).toBe(false);
    expect(ruleMatches(rules[0], new URL('http://api.openai.com/v1/x'))).toBe(false);
    const lyria = computeAllowlist([
      {
        ...provider(
          'lyria',
          'https://{location}-aiplatform.googleapis.com/v1',
          { type: 'bearer' },
          'provider:lyria',
        ),
        adapter: 'google-lyria',
        extra: { vertexLocation: 'europe-west4' },
      } as never,
    ]);
    expect(
      lyria.some((r) =>
        ruleMatches(
          r,
          new URL(
            'https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/publishers/google/models/lyria-002:predict',
          ),
        ),
      ),
    ).toBe(true);
    const claudeClouds = computeAllowlist([
      {
        ...provider(
          'bedrock',
          'https://bedrock-mantle.{region}.api.aws/anthropic',
          { type: 'header', name: 'x-api-key' },
          'provider:bedrock',
        ),
        adapter: 'anthropic',
        region: 'eu-west-1',
      } as never,
      {
        ...provider(
          'vertex',
          'https://{location}-aiplatform.googleapis.com/v1',
          { type: 'bearer' },
          'provider:vertex',
        ),
        adapter: 'anthropic',
        extra: { vertexLocation: 'global' },
      } as never,
    ]);
    const allowed = (url: string) => claudeClouds.find((r) => ruleMatches(r, new URL(url)))?.providerId;
    expect(allowed('https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages')).toBe('bedrock');
    expect(
      allowed(
        'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/claude-opus-5-5:rawPredict',
      ),
    ).toBe('vertex');
    expect(allowed('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages')).toBeUndefined();
  });

  it('download hosts allow credential-free https GETs of result files only', async () => {
    const { computeAllowlist, isValidDownloadHost } = await import('../src/providers');
    const { credentialInScope, isAllowlisted } = await import('../src/proxy');
    const rules = computeAllowlist([
      {
        ...provider('mureka', 'https://api.mureka.ai', { type: 'bearer' }, 'provider:mureka'),
        extra: { downloadHosts: ['*.mureka.ai', 'files.example.net', '*.com', 'not a host'] },
      } as never,
    ]);
    const u = (s: string) => new URL(s);
    expect(isAllowlisted(u('https://cdn.mureka.ai/song.mp3'), rules, 'GET')).toBe(true);
    expect(isAllowlisted(u('https://files.example.net/x.wav'), rules, 'GET')).toBe(true);
    expect(isAllowlisted(u('https://cdn.mureka.ai/song.mp3'), rules, 'POST')).toBe(false);
    expect(isAllowlisted(u('http://cdn.mureka.ai/song.mp3'), rules, 'GET')).toBe(false);
    expect(isAllowlisted(u('https://evil.com/x'), rules, 'GET')).toBe(false);
    expect(credentialInScope(u('https://cdn.mureka.ai/song.mp3'), 'provider:mureka', rules)).toBe(false);
    expect(credentialInScope(u('https://api.mureka.ai/v1/song/generate'), 'provider:mureka', rules)).toBe(
      true,
    );
    expect(isValidDownloadHost('*.com')).toBe(false);
    expect(isValidDownloadHost('*.cloudfront.net')).toBe(true);
  });

  it('only sends a credential to its own provider', async () => {
    await registerProviders([
      provider('a', `${upstream.url}/v1`, { type: 'bearer' }, 'provider:a'),
      provider('b', `${other.url}/v1`, { type: 'bearer' }, 'provider:b'),
    ]);
    await setSecret('provider:a', SECRET);
    const res = await proxy({
      url: `${other.url}/v1/json`,
      method: 'GET',
      headers: {},
      credentialRef: 'provider:a',
      auth: { type: 'bearer' },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'credential-scope' });
    expect(other.requests).toHaveLength(0);
  });

  it('reports a missing secret as a proxy error (502 + header)', async () => {
    await registerProviders([
      provider('openai', `${upstream.url}/v1`, { type: 'bearer' }, 'provider:openai'),
    ]);
    const res = await proxy({
      url: `${upstream.url}/v1/json`,
      method: 'GET',
      headers: {},
      credentialRef: 'provider:openai',
      auth: { type: 'bearer' },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get('x-songdeck-proxy-error')).toBe('1');
    expect((await json(res)).error).toMatch(/No secret stored for credential "provider:openai"/);
    expect(upstream.requests).toHaveLength(0);
  });

  it('reports unreachable upstreams as 502 proxy errors', async () => {
    const deadUrl = upstream.url;
    await upstream.close();
    const res = await proxy({ url: `${deadUrl}/v1/json`, method: 'GET', headers: {} });
    expect(res.status).toBe(502);
    expect(res.headers.get('x-songdeck-proxy-error')).toBe('1');
    expect(await json(res)).toMatchObject({ code: 'upstream-error' });
    upstream = await startMock((_req, res) => res.end());
  });

  it('validates envelopes', async () => {
    for (const env of [
      {},
      { url: 'ftp://x/y' },
      { url: 'not a url' },
      { url: `${upstream.url}/v1/json`, method: 'TRACE' },
      { url: `${upstream.url}/v1/json`, method: 'GET', body: 'x' },
      { url: `${upstream.url}/v1/json`, headers: { a: 1 } },
    ]) {
      const res = await proxy(env);
      expect(res.status, JSON.stringify(env)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.headers.get('x-songdeck-proxy-error')).toBe('1');
    }
  });

  it('follows allowlisted redirects but drops credentials that leave the provider scope', async () => {
    await registerProviders([
      provider('a', `${upstream.url}/v1`, { type: 'bearer' }, 'provider:a'),
      provider('b', `${other.url}/v1`, { type: 'none' }),
    ]);
    await setSecret('provider:a', SECRET);
    const same = await proxy({
      url: `${upstream.url}/v1/redirect-same`,
      method: 'GET',
      headers: {},
      credentialRef: 'provider:a',
      auth: { type: 'bearer' },
    });
    expect(await json(same)).toMatchObject({ ok: true, auth: `Bearer ${SECRET}` });
    const out = await proxy({
      url: `${upstream.url}/v1/redirect-out`,
      method: 'GET',
      headers: {},
      credentialRef: 'provider:a',
      auth: { type: 'bearer' },
    });
    expect(await json(out)).toEqual({ other: true, auth: null });
    const evil = await proxy({
      url: `${upstream.url}/v1/redirect-evil`,
      method: 'GET',
      headers: {},
      credentialRef: 'provider:a',
      auth: { type: 'bearer' },
    });
    expect(evil.status).toBe(502);
    expect(await json(evil)).toMatchObject({ code: 'redirect-not-allowlisted' });
  });

  it('never forwards client authorization headers to another origin', async () => {
    const same = await proxy({
      url: `${upstream.url}/v1/redirect-same`,
      headers: { Authorization: 'Bearer client-secret', 'X-Api-Key': 'client-key' },
    });
    expect(await json(same)).toMatchObject({ auth: 'Bearer client-secret', key: 'client-key' });
    const out = await proxy({
      url: `${upstream.url}/v1/redirect-out`,
      headers: { Authorization: 'Bearer client-secret', 'X-Api-Key': 'client-key' },
    });
    expect(await json(out)).toEqual({ other: true, auth: null });
    const forwarded = other.requests.at(-1)!;
    expect(forwarded.headers['x-api-key']).toBeUndefined();
  });

  it('strips custom client auth headers when a redirect leaves the credential path scope', async () => {
    await registerProviders([
      provider('a', `${upstream.url}/v1`, { type: 'header', name: 'x-custom-auth' }, 'provider:a'),
    ]);
    await setSecret('provider:a', SECRET);
    await proxy({
      url: `${upstream.url}/v1/redirect-path`,
      headers: { 'X-Custom-Auth': 'client-secret' },
      credentialRef: 'provider:a',
      auth: { type: 'header', name: 'x-custom-auth' },
    });
    expect(upstream.requests.at(-1)!.url).toBe('/v2/json');
    expect(upstream.requests.at(-1)!.headers['x-custom-auth']).toBeUndefined();
  });

  it('rejects redirects with embedded credentials before contacting the target', async () => {
    const res = await proxy({ url: `${upstream.url}/v1/redirect-userinfo` });
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ code: 'bad-redirect' });
    expect(other.requests).toHaveLength(0);
  });

  it('removes echoed query credentials even after a duplicate public parameter', async () => {
    await registerProviders([
      provider('a', `${upstream.url}/v1`, { type: 'query', name: 'key' }, 'provider:a'),
    ]);
    await setSecret('provider:a', SECRET);
    const res = await proxy({
      url: `${upstream.url}/v1/redirect-query`,
      credentialRef: 'provider:a',
      auth: { type: 'query', name: 'key' },
    });
    expect(res.status).toBe(200);
    expect(other.requests.at(-1)!.url).not.toContain(SECRET);
  });

  it('rejects provider configs that contain secrets', async () => {
    const res = await fetch(`${srv.url}/api/providers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          {
            ...provider('x', 'https://api.openai.com/v1', { type: 'bearer' }),
            apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: 'secret-in-config' });
    const ok = await fetch(`${srv.url}/api/providers`);
    expect((await json(ok)).providers).toEqual([]);
  });

  it('persists provider configs', async () => {
    await registerProviders([
      provider('openai', 'https://api.openai.com/v1', { type: 'bearer' }, 'provider:openai'),
    ]);
    const list = await json(await fetch(`${srv.url}/api/providers`));
    expect(list.providers).toHaveLength(1);
    const dataDir = srv.dataDir;
    await srv.close({ keepData: true });
    srv = await startServer({ dataDir });
    expect((await json(await fetch(`${srv.url}/api/providers`))).providers[0]).toMatchObject({
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });
  });
});
