import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { newerVersion, UpdateService } from '../src/updates';
import { startServer, tempDir } from './helpers';

const dirs: string[] = [];
const services: UpdateService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture({ corrupt = false, unsafe = false, incomplete = false } = {}) {
  const root = tempDir();
  dirs.push(root);
  const files: Record<string, Uint8Array> = {
    'song-deck-0.2.0/package.json': strToU8(JSON.stringify({ name: 'song-deck', version: '0.2.0' })),
    'song-deck-0.2.0/server/songdeck-runtime.mjs': strToU8('// runtime'),
    'song-deck-0.2.0/server/worker-entry.mjs': strToU8('// worker'),
    'song-deck-0.2.0/studio/index.html': strToU8('<html></html>'),
  };
  if (unsafe) files['song-deck-0.2.0/../../escaped'] = strToU8('no');
  if (incomplete) delete files['song-deck-0.2.0/server/songdeck-runtime.mjs'];
  const archive = zipSync(files);
  const digest = createHash('sha256').update(archive).digest('hex');
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/latest'))
      return Response.json({
        tag_name: 'v0.2.0',
        draft: false,
        prerelease: false,
        assets: [
          { name: 'song-deck-0.2.0.zip', id: 1 },
          { name: 'SHA256SUMS.txt', id: 2 },
        ],
      });
    if (String(url).endsWith('/2'))
      return new Response(`${corrupt ? '0'.repeat(64) : digest}  song-deck-0.2.0.zip\n`);
    return new Response(Buffer.from(archive));
  });
  const restart = vi.fn();
  const options = { installRoot: root, fetch: fetchMock, version: '0.1.0', restart };
  const service = new UpdateService(path.join(root, 'data'), options);
  services.push(service);
  return { root, service, fetchMock, restart, options };
}

describe('release updates', () => {
  it('compares versions numerically and never downgrades to older or prerelease builds', () => {
    expect(newerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(newerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(newerVersion('0.1.0', '0.2.0')).toBe(false);
    expect(newerVersion('0.2.0-beta.1', '0.1.0')).toBe(false);
    expect(newerVersion('0.2.0', '0.2.0-beta.1')).toBe(true);
    expect(newerVersion('../0.2.0', '0.1.0')).toBe(false);
  });
  it('does not contact GitHub until asked, and check alone does not write an update', async () => {
    const { service, fetchMock, root } = fixture();
    await service.init();
    expect(fetchMock).not.toHaveBeenCalled();
    await service.run(false);
    expect(service.status()).toMatchObject({ available: true, latestVersion: '0.2.0', automatic: false });
    expect(readdirSync(root)).not.toContain('.songdeck-updates');
  });
  it('verifies, stages and persists an update without restarting or modifying app data', async () => {
    const { service, root, restart, options } = fixture();
    await service.init();
    await service.run(true);
    const pending = JSON.parse(readFileSync(path.join(root, '.songdeck-updates/pending.json'), 'utf8'));
    expect(pending.version).toBe('0.2.0');
    expect(
      readFileSync(path.join(root, '.songdeck-updates', pending.directory, 'studio/index.html'), 'utf8'),
    ).toContain('<html>');
    expect(restart).not.toHaveBeenCalled();
    const next = new UpdateService(path.join(root, 'data'), options);
    services.push(next);
    await next.init();
    expect(next.status().pendingVersion).toBe('0.2.0');
    next.restart();
    expect(restart).toHaveBeenCalledOnce();
  });
  it.each([{ corrupt: true }, { unsafe: true }, { incomplete: true }])(
    'rejects an invalid archive without activation: %j',
    async (invalid) => {
      const { service, root } = fixture(invalid);
      await expect(service.run(true)).rejects.toThrow();
      expect(service.status().pendingVersion).toBeUndefined();
      expect(readdirSync(root)).not.toContain('.songdeck-updates');
    },
  );
  it('persists opt-in, downloads in the background, and respects opt-out across startup', async () => {
    const { service, root, options, fetchMock, restart } = fixture();
    await service.init();
    await service.setAutomatic(true);
    await vi.waitFor(() => expect(service.status().pendingVersion).toBe('0.2.0'));
    expect(JSON.parse(readFileSync(path.join(root, 'data/updates.json'), 'utf8')).automatic).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    await service.setAutomatic(false);
    fetchMock.mockClear();
    const next = new UpdateService(path.join(root, 'data'), options);
    services.push(next);
    await next.init();
    expect(next.status().automatic).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('serializes operations and rejects restarts during active jobs', async () => {
    const { service, options, root } = fixture();
    const first = service.run(true);
    await expect(service.run(true)).rejects.toThrow('already running');
    await first;
    const busy = new UpdateService(path.join(root, 'data'), { ...options, isBusy: () => true });
    services.push(busy);
    await busy.init();
    expect(() => busy.restart()).toThrow('Finish server jobs');
  });
  it('handles unavailable private releases without exposing credentials', async () => {
    const root = tempDir();
    dirs.push(root);
    const service = new UpdateService(root, {
      fetch: async () => new Response(null, { status: 404 }),
      token: 'secret-for-test',
    });
    services.push(service);
    await expect(service.run(false)).rejects.toThrow('SONGDECK_UPDATE_TOKEN');
    expect(JSON.stringify(service.status())).not.toContain('secret-for-test');
    await expect(service.setAutomatic(true)).rejects.toThrow('Start Song Deck');
  });
  it('protects mutation routes, validates preferences, and uses existing bearer auth', async () => {
    const { options } = fixture();
    const server = await startServer({ updates: options, token: 'local-test-token' });
    try {
      expect((await fetch(`${server.url}/api/updates`)).status).toBe(401);
      const auth = { authorization: 'Bearer local-test-token' };
      expect((await fetch(`${server.url}/api/updates/check`, { method: 'POST', headers: auth })).status).toBe(
        403,
      );
      const headers = { ...auth, 'x-songdeck-client': 'updates', 'content-type': 'application/json' };
      expect(
        (
          await fetch(`${server.url}/api/updates/settings`, {
            method: 'PUT',
            headers,
            body: '{"automatic":"yes"}',
          })
        ).status,
      ).toBe(400);
      const result = await fetch(`${server.url}/api/updates/install`, { method: 'POST', headers });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ pendingVersion: '0.2.0' });
    } finally {
      await server.close();
    }
  });
});
