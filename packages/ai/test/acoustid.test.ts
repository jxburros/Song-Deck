import { describe, expect, it } from 'vitest';
import {
  ACOUSTID_CREDENTIAL_REF,
  CAPABILITY_INFO,
  DirectTransport,
  MemoryCredentialStore,
  ProviderError,
  ServerProxyTransport,
  createAcoustIdProvider,
  isCapability,
  parseAcoustIdResponse,
} from '../src';
import { jsonResponse, mockFetch } from './helpers';

const FP = 'AQAAS1qcMIkUJsBz4j9-43twXIEfTD_45MEuShIqnjhD';

const OK = {
  status: 'ok',
  results: [
    {
      id: 'acoustid-track-1',
      score: 0.97,
      recordings: [
        {
          id: 'mbid-rec-1',
          title: 'Night Drive',
          artists: [
            { id: 'a1', name: 'The Examples' },
            { id: 'a2', name: 'Guest' },
          ],
          releasegroups: [{ id: 'rg1', title: 'Test Album' }],
        },
      ],
    },
    { id: 'acoustid-track-2', score: 0.2, recordings: [{ id: 'mbid-rec-2', title: 'Low score' }] },
  ],
};

function provider(handler: Parameters<typeof mockFetch>[0], key: string | null = 'app-key-123') {
  const m = mockFetch(handler);
  const creds = new MemoryCredentialStore(key ? { [ACOUSTID_CREDENTIAL_REF]: key } : {});
  const p = createAcoustIdProvider({
    transport: new DirectTransport(creds, { fetch: m.fetch }),
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  return { p, calls: m.calls };
}

describe('AcoustID adapter', () => {
  it('posts only the fingerprint and duration, with the key as the client parameter', async () => {
    const { p, calls } = provider(() => jsonResponse(OK));
    const r = await p.identify({ fingerprint: FP, durationSeconds: 211.6 });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.acoustid.org/v2/lookup');
    expect(url.searchParams.get('client')).toBe('app-key-123');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(form)).toEqual({
      format: 'json',
      meta: 'recordings releasegroups',
      duration: '212',
      fingerprint: FP,
    });
    expect(r.status).toBe('matched');
    expect(r.matches).toEqual([
      {
        service: 'AcoustID',
        score: 0.97,
        trackId: 'acoustid-track-1',
        recordingId: 'mbid-rec-1',
        title: 'Night Drive',
        artists: ['The Examples', 'Guest'],
        releaseTitle: 'Test Album',
      },
    ]);
    expect(p.sends).toMatch(/fingerprint and the duration/);
  });

  it('reports no match', async () => {
    const { p } = provider(() => jsonResponse({ status: 'ok', results: [] }));
    expect(await p.identify({ fingerprint: FP, durationSeconds: 30 })).toEqual({
      service: 'AcoustID',
      status: 'no-match',
      matches: [],
    });
  });

  it('maps AcoustID errors (HTTP 400 + JSON) to provider errors', async () => {
    const { p } = provider(() =>
      jsonResponse({ status: 'error', error: { code: 4, message: 'invalid API key' } }, 400),
    );
    await expect(p.identify({ fingerprint: FP, durationSeconds: 30 })).rejects.toMatchObject({
      kind: 'auth',
      message: 'AcoustID: invalid API key',
    });
  });

  it('needs a stored key and valid input, and retries a 503 once', async () => {
    const { p: noKey, calls } = provider(() => jsonResponse(OK), null);
    await expect(noKey.identify({ fingerprint: FP, durationSeconds: 30 })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(calls).toHaveLength(0);
    const { p } = provider(() => jsonResponse(OK));
    await expect(p.identify({ fingerprint: 'not base64!', durationSeconds: 30 })).rejects.toBeInstanceOf(
      ProviderError,
    );
    await expect(p.identify({ fingerprint: FP, durationSeconds: 0.2 })).rejects.toMatchObject({
      kind: 'bad-request',
    });
    let n = 0;
    const flaky = provider(() => (n++ === 0 ? jsonResponse({ error: 'busy' }, 503) : jsonResponse(OK)));
    expect((await flaky.p.identify({ fingerprint: FP, durationSeconds: 30 })).status).toBe('matched');
    expect(flaky.calls).toHaveLength(2);
  });

  it('works through the local server proxy (key stays in the vault)', async () => {
    const m = mockFetch(() => jsonResponse(OK));
    const p = createAcoustIdProvider({
      transport: new ServerProxyTransport('http://localhost:7788', { fetch: m.fetch }),
    });
    await p.identify({ fingerprint: FP, durationSeconds: 60 });
    const envelope = JSON.parse(m.calls[0].body!);
    expect(m.calls[0].url).toBe('http://localhost:7788/api/proxy');
    expect(envelope).toMatchObject({
      url: 'https://api.acoustid.org/v2/lookup',
      method: 'POST',
      credentialRef: ACOUSTID_CREDENTIAL_REF,
      auth: { type: 'query', name: 'client' },
    });
    expect(JSON.stringify(envelope)).not.toContain('app-key');
  });

  it('parses defensively', () => {
    expect(() => parseAcoustIdResponse(null)).toThrow(/unreadable/);
    expect(parseAcoustIdResponse({ status: 'ok', results: [{ id: 't', score: 0.8 }] }).matches).toEqual([
      { service: 'AcoustID', score: 0.8, trackId: 't' },
    ]);
    expect(
      parseAcoustIdResponse({ status: 'ok', results: [{ score: 'x', recordings: 'nope' }] }).status,
    ).toBe('no-match');
  });

  it('is a capability in the taxonomy', () => {
    expect(isCapability('CONTENT_IDENTIFICATION')).toBe(true);
    expect(CAPABILITY_INFO.CONTENT_IDENTIFICATION.group).toBe('audio-analysis');
  });
});
