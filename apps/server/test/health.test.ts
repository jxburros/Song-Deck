import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig, SERVER_VERSION } from '../src/config';
import { json, rawRequest, startServer, type TestServer } from './helpers';

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

describe('health & routing', () => {
  it('reports name, version, vault backend, features and data dir', async () => {
    srv = await startServer();
    const res = await fetch(`${srv.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await json(res);
    expect(body).toMatchObject({
      name: 'songdeck-server',
      version: SERVER_VERSION,
      vault: { backend: 'memory' },
      dataDir: srv.dataDir,
      auth: { required: false },
    });
    expect(body.features).toEqual(
      expect.arrayContaining([
        'vault',
        'proxy',
        'providers',
        'hardware',
        'models',
        'collab',
        'plugins',
        'projects',
      ]),
    );
  });

  it('answers unknown routes with a uniform JSON 404 and wrong methods with 405', async () => {
    srv = await startServer();
    const nf = await fetch(`${srv.url}/api/nope`);
    expect(nf.status).toBe(404);
    expect(await json(nf)).toMatchObject({ code: 'not-found', error: expect.any(String) });
    const na = await fetch(`${srv.url}/api/health`, { method: 'DELETE' });
    expect(na.status).toBe(405);
    expect(na.headers.get('allow')).toContain('GET');
    expect(await json(na)).toMatchObject({ code: 'method-not-allowed' });
    // Non-API paths without a static dir are 404 JSON too.
    const root = await fetch(`${srv.url}/`);
    expect(root.status).toBe(404);
  });

  it('rejects invalid JSON and oversized bodies', async () => {
    srv = await startServer({ limits: { jsonBytes: 1024 } });
    const bad = await fetch(`${srv.url}/api/vault/x`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    expect((await json(bad)).code).toBe('invalid-json');
    const big = await fetch(`${srv.url}/api/vault/x`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'x'.repeat(5000) }),
    });
    expect(big.status).toBe(413);
    expect((await json(big)).code).toBe('payload-too-large');
  });
});

describe('CORS', () => {
  it('answers preflights from allowed origins', async () => {
    srv = await startServer();
    const res = await rawRequest(`${srv.url}/api/vault/provider%3Aopenai`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toContain('PUT');
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
    expect(res.headers.vary).toContain('Origin');
  });

  it('adds CORS headers to allowed cross-origin requests and exposes custom headers', async () => {
    srv = await startServer();
    const res = await rawRequest(`${srv.url}/api/health`, { headers: { origin: 'http://127.0.0.1:5173' } });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(res.headers['access-control-expose-headers']).toContain('x-songdeck-report');
  });

  it('rejects other origins, including their preflights', async () => {
    srv = await startServer();
    const pre = await rawRequest(`${srv.url}/api/vault`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(pre.status).toBe(403);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const get = await rawRequest(`${srv.url}/api/vault`, { headers: { origin: 'https://evil.example' } });
    expect(get.status).toBe(403);
    expect(JSON.parse(get.body.toString()).code).toBe('origin-not-allowed');
  });

  it('allows same-origin requests and custom --allow-origin values', async () => {
    srv = await startServer({ allowOrigins: ['https://studio.example'] });
    const same = await rawRequest(`${srv.url}/api/health`, { headers: { origin: srv.url } });
    expect(same.status).toBe(200);
    const custom = await rawRequest(`${srv.url}/api/health`, {
      headers: { origin: 'https://studio.example' },
    });
    expect(custom.headers['access-control-allow-origin']).toBe('https://studio.example');
    const dflt = await rawRequest(`${srv.url}/api/health`, { headers: { origin: 'http://localhost:5173' } });
    expect(dflt.status).toBe(403);
  });

  it('blocks DNS-rebinding Host headers on a loopback bind', async () => {
    srv = await startServer();
    const res = await rawRequest(`${srv.url}/api/health`, { headers: { host: 'attacker.example:7788' } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString()).code).toBe('bad-host');
    const ok = await rawRequest(`${srv.url}/api/health`, { headers: { host: 'localhost:7788' } });
    expect(ok.status).toBe(200);
  });
});

describe('token auth', () => {
  it('requires the bearer token everywhere except /api/health', async () => {
    srv = await startServer({ token: 'let-me-in' });
    const health = await json(await fetch(`${srv.url}/api/health`));
    expect(health.auth).toEqual({ required: true });
    expect(health.dataDir).toBeUndefined(); // not revealed without the token
    const denied = await fetch(`${srv.url}/api/vault`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Bearer');
    expect((await json(denied)).code).toBe('unauthorized');
    const wrong = await fetch(`${srv.url}/api/vault`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${srv.url}/api/vault`, { headers: { authorization: 'Bearer let-me-in' } });
    expect(ok.status).toBe(200);
    const query = await fetch(`${srv.url}/api/vault?access_token=let-me-in`);
    expect(query.status).toBe(200);
    const healthAuthed = await json(
      await fetch(`${srv.url}/api/health`, { headers: { authorization: 'Bearer let-me-in' } }),
    );
    expect(healthAuthed.dataDir).toBe(srv.dataDir);
  });

  it('refuses to bind a non-loopback host without a token', () => {
    expect(() => resolveConfig({ host: '0.0.0.0' })).toThrow(/token/i);
    expect(() => resolveConfig({ host: '0.0.0.0', token: 'x' })).not.toThrow();
    expect(() => resolveConfig({ host: 'localhost' })).not.toThrow();
  });
});
