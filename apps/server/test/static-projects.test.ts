import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeProjectName } from '../src/projects';
import { json, rawRequest, startServer, tempDir, type TestServer } from './helpers';

let srv: TestServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function studioDist(): string {
  const root = tempDir('songdeck-dist-');
  dirs.push(root);
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><title>Song Deck</title><div id="root"></div>',
  );
  writeFileSync(path.join(root, 'assets', 'index-Bq3xY7aZ.js'), 'console.log("studio")');
  writeFileSync(path.join(root, 'assets', 'index-Dk2a9QwE.css'), 'body{}');
  writeFileSync(path.join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(root, '.secret'), 'nope');
  return root;
}

describe('static studio hosting', () => {
  it('serves files with MIME types, caching and SPA fallback', async () => {
    srv = await startServer({ staticDir: studioDist() });
    const index = await fetch(`${srv.url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('Song Deck');
    const js = await fetch(`${srv.url}/assets/index-Bq3xY7aZ.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${srv.url}/assets/index-Dk2a9QwE.css`)).headers.get('content-type')).toBe(
      'text/css; charset=utf-8',
    );
    expect((await fetch(`${srv.url}/favicon.svg`)).headers.get('content-type')).toBe('image/svg+xml');
    // Client-side routes fall back to index.html…
    const route = await fetch(`${srv.url}/projects/my-song/workbench`, { headers: { accept: 'text/html' } });
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<div id="root">');
    // …missing assets do not.
    expect((await fetch(`${srv.url}/assets/missing-abc.js`)).status).toBe(404);
    // API paths never fall back to the SPA.
    const api = await fetch(`${srv.url}/api/unknown`);
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toMatch(/json/);
    expect((await json(api)).code).toBe('not-found');
    expect(await json(await fetch(`${srv.url}/api/health`))).toMatchObject({
      features: expect.arrayContaining(['static']),
    });
    // Write methods are rejected.
    expect((await fetch(`${srv.url}/index.html`, { method: 'POST' })).status).toBe(405);
  });

  it('applies containment checks to the SPA fallback index', async () => {
    const dist = studioDist();
    const outside = tempDir('songdeck-outside-');
    dirs.push(outside);
    writeFileSync(path.join(outside, 'index.html'), 'OUTSIDE SECRET');
    rmSync(path.join(dist, 'index.html'));
    // Junctions do not require symlink privileges on Windows.
    symlinkSync(outside, path.join(dist, 'external'), 'junction');
    symlinkSync(path.join(dist, 'external', 'index.html'), path.join(dist, 'index.html'));
    srv = await startServer({ staticDir: dist });
    for (const route of ['/', '/songs/example', '/missing.html']) {
      const res = await fetch(`${srv.url}${route}`, { headers: { accept: 'text/html' } });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('OUTSIDE SECRET');
    }
  });

  it('is path-traversal safe and hides dotfiles', async () => {
    const dist = studioDist();
    writeFileSync(path.join(path.dirname(dist), 'outside-secret.txt'), 'TOP SECRET');
    srv = await startServer({ staticDir: dist });
    for (const p of [
      '/..%2Foutside-secret.txt',
      '/assets/..%2F..%2Foutside-secret.txt',
      '/%2e%2e/outside-secret.txt',
      '/.secret',
      '/..%5Coutside-secret.txt',
    ]) {
      const res = await rawRequest(srv.url, { path: p });
      expect(res.body.toString(), p).not.toContain('TOP SECRET');
      expect(res.body.toString(), p).not.toContain('nope');
    }
    rmSync(path.join(path.dirname(dist), 'outside-secret.txt'), { force: true });
  });
});

describe('project storage', () => {
  // A ZIP local-file-header signature followed by some payload (the server only checks the signature).
  const zip = (name: string) =>
    Buffer.concat([
      Buffer.from('PK\u0003\u0004', 'binary'),
      Buffer.from(JSON.stringify({ name, pad: 'x'.repeat(64) })),
    ]);

  it('stores, lists, downloads, replaces and deletes .songproject packages', async () => {
    srv = await startServer();
    expect(await json(await fetch(`${srv.url}/api/projects`))).toEqual({ projects: [] });
    const bytes = zip('Night Drive');
    const put = await fetch(`${srv.url}/api/projects/Night%20Drive`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    expect(put.status).toBe(201);
    expect(await json(put)).toMatchObject({
      name: 'Night Drive',
      file: 'Night Drive.songproject',
      size: bytes.length,
    });
    const list = await json(await fetch(`${srv.url}/api/projects`));
    expect(list.projects).toEqual([
      { name: 'Night Drive', file: 'Night Drive.songproject', size: bytes.length, mtime: expect.any(String) },
    ]);
    const get = await fetch(`${srv.url}/api/projects/Night%20Drive.songproject`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/octet-stream');
    expect(get.headers.get('content-disposition')).toContain('Night%20Drive.songproject');
    expect(Buffer.from(await get.arrayBuffer()).equals(bytes)).toBe(true);
    const replaced = await fetch(`${srv.url}/api/projects/Night%20Drive`, { method: 'PUT', body: zip('v2') });
    expect(replaced.status).toBe(200);
    expect((await fetch(`${srv.url}/api/projects/Night%20Drive`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${srv.url}/api/projects/Night%20Drive`)).status).toBe(404);
  });

  it('rejects non-ZIP bodies, empty bodies and oversized uploads', async () => {
    srv = await startServer({ limits: { projectBytes: 2048 } });
    const notZip = await fetch(`${srv.url}/api/projects/x`, { method: 'PUT', body: 'hello world' });
    expect(notZip.status).toBe(400);
    expect((await json(notZip)).code).toBe('not-a-songproject');
    const empty = await fetch(`${srv.url}/api/projects/x`, { method: 'PUT', body: '' });
    expect(empty.status).toBe(400);
    const big = await fetch(`${srv.url}/api/projects/x`, {
      method: 'PUT',
      body: Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(4096)]),
    });
    expect(big.status).toBe(413);
    expect((await json(await fetch(`${srv.url}/api/projects`))).projects).toEqual([]);
  });

  it('sanitizes names so uploads stay inside the projects directory', async () => {
    expect(sanitizeProjectName('../../etc/passwd')).toBe('_etc_passwd');
    expect(sanitizeProjectName('My Song (Demo).songproject')).toBe('My Song (Demo)');
    expect(sanitizeProjectName('Ballade für Klavier')).toBe('Ballade für Klavier');
    expect(() => sanitizeProjectName('...')).toThrow();
    expect(() => sanitizeProjectName('CON')).toThrow();
    expect(() => sanitizeProjectName('')).toThrow();
    srv = await startServer();
    const res = await fetch(`${srv.url}/api/projects/${encodeURIComponent('../../evil')}`, {
      method: 'PUT',
      body: zip('evil'),
    });
    expect(res.status).toBe(201);
    expect((await json(res)).file).toBe('_evil.songproject');
    expect(
      (await json(await fetch(`${srv.url}/api/projects`))).projects.map((p: { file: string }) => p.file),
    ).toEqual(['_evil.songproject']);
  });
});
