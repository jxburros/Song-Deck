import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers';

let srv: TestServer;
afterEach(async () => {
  await srv?.close();
});

const FP = 'AQAAS1qcMIkUJsBz4j9-43twXIEfTD_45MEuShIqnjhD';

function lookup(body: unknown) {
  return fetch(`${srv.url}/api/content-check/acoustid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('content check (AcoustID through the vault)', () => {
  it('looks a fingerprint up with the vault key and never needs the key in the browser', async () => {
    const seen: { url: string; body: string }[] = [];
    srv = await startServer({
      proxy: {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          seen.push({ url: String(input), body: String(init?.body ?? '') });
          return new Response(
            JSON.stringify({
              status: 'ok',
              results: [
                {
                  id: 't1',
                  score: 0.91,
                  recordings: [{ id: 'r1', title: 'Night Drive', artists: [{ name: 'The Examples' }] }],
                },
              ],
            }),
            {
              headers: { 'content-type': 'application/json' },
            },
          );
        }) as typeof fetch,
      },
    });
    const health = (await (await fetch(`${srv.url}/api/health`)).json()) as { features: string[] };
    expect(health.features).toContain('content-check');

    // No key yet → 412, nothing sent upstream.
    let res = await lookup({ fingerprint: FP, duration: 200 });
    expect(res.status).toBe(412);
    expect(seen).toHaveLength(0);

    await fetch(`${srv.url}/api/vault/${encodeURIComponent('content-check:acoustid')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'acoustid-app-key' }),
    });
    res = await lookup({ fingerprint: FP, duration: 199.6 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      service: 'AcoustID',
      status: 'matched',
      matches: [
        {
          service: 'AcoustID',
          score: 0.91,
          trackId: 't1',
          recordingId: 'r1',
          title: 'Night Drive',
          artists: ['The Examples'],
        },
      ],
    });
    const url = new URL(seen[0].url);
    expect(url.host).toBe('api.acoustid.org');
    expect(url.searchParams.get('client')).toBe('acoustid-app-key');
    expect(Object.fromEntries(new URLSearchParams(seen[0].body))).toEqual({
      format: 'json',
      meta: 'recordings releasegroups',
      duration: '200',
      fingerprint: FP,
    });
  });

  it('validates the body and reports upstream failures as 502', async () => {
    srv = await startServer({
      proxy: {
        fetch: (async () =>
          new Response(JSON.stringify({ status: 'error', error: { code: 4, message: 'invalid API key' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      },
    });
    for (const bad of [
      {},
      { fingerprint: 'x y', duration: 10 },
      { fingerprint: FP, duration: -1 },
      { fingerprint: FP, duration: 'long' },
      [],
    ]) {
      expect((await lookup(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    await fetch(`${srv.url}/api/vault/${encodeURIComponent('content-check:acoustid')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'wrong' }),
    });
    const res = await lookup({ fingerprint: FP, duration: 30 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: 'acoustid-failed',
      error: 'AcoustID: invalid API key',
      details: { kind: 'auth' },
    });
  });
});
