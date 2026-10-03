import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json, rawRequest, startServer, tempDir, type TestServer } from './helpers';

let srv: TestServer;
let bundled: string;
let user: string;
let outside: string;

function plugin(root: string, dirName: string, manifest: unknown, files: Record<string, string> = {}) {
  const dir = path.join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'songdeck-plugin.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
  );
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

beforeEach(async () => {
  bundled = tempDir('songdeck-plugins-a-');
  user = tempDir('songdeck-plugins-b-');
  outside = tempDir('songdeck-outside-');
  writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
  plugin(
    bundled,
    'lofi-genre',
    {
      id: 'lofi-genre',
      name: 'Lo-fi Genre Pack',
      version: '1.0.0',
      kind: 'genre-profile',
      description: 'Lo-fi hip hop rules',
      author: 'Song Deck',
      entry: 'index.js',
      files: ['data/lofi.json'],
      permissions: ['provider-registry'],
    },
    {
      'index.js': 'export function register(api) { api.log("hi"); }',
      'data/lofi.json': '{"id":"lofi"}',
      '.env': 'SECRET=1',
      'sounds/kick.wav': 'RIFF....WAVE',
    },
  );
  plugin(bundled, 'broken-json', '{ "id": "broken", ');
  plugin(bundled, 'bad-fields', { id: 'Bad Id!', name: '', version: 'one', kind: 'spaceship' });
  plugin(bundled, 'missing-entry', {
    id: 'missing-entry',
    name: 'Missing entry',
    version: '0.1.0',
    kind: 'exporter',
    description: '',
    author: 'x',
    entry: 'nope.js',
  });
  plugin(bundled, 'escape-entry', {
    id: 'escape-entry',
    name: 'Escape',
    version: '0.1.0',
    kind: 'exporter',
    description: '',
    author: 'x',
    entry: '../../etc/passwd.js',
  });
  mkdirSync(path.join(bundled, 'not-a-plugin'));
  const reaper = plugin(
    user,
    'reaper-export',
    {
      id: 'reaper-export',
      name: 'Reaper exporter',
      version: '0.2.0-beta.1',
      kind: 'exporter',
      description: 'RPP export',
      author: 'Community',
      entry: 'dist/main.mjs',
    },
    { 'dist/main.mjs': 'export const register = () => {};' },
  );
  plugin(user, 'dupe', {
    id: 'lofi-genre',
    name: 'Duplicate',
    version: '1.0.0',
    kind: 'genre-profile',
    description: '',
    author: '',
  });
  try {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(reaper, 'leak.txt'));
  } catch {
    /* symlinks may be unavailable (Windows without privileges) */
  }
  srv = await startServer({ pluginDirs: [bundled, user] });
});

afterEach(async () => {
  await srv.close();
  for (const d of [bundled, user, outside]) rmSync(d, { recursive: true, force: true });
});

describe('plugin host', () => {
  it('scans manifests, validates them and reports load errors', async () => {
    const res = await fetch(`${srv.url}/api/plugins`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.plugins.map((p: { id: string }) => p.id).sort()).toEqual(['lofi-genre', 'reaper-export']);
    const lofi = body.plugins.find((p: { id: string }) => p.id === 'lofi-genre');
    expect(lofi).toMatchObject({
      name: 'Lo-fi Genre Pack',
      version: '1.0.0',
      kind: 'genre-profile',
      entry: 'index.js',
      entryUrl: '/api/plugins/lofi-genre/files/index.js',
      files: ['data/lofi.json'],
      permissions: ['provider-registry'],
    });
    const errors = body.errors as { dir: string; error: string; id?: string }[];
    const byDir = (name: string) => errors.find((e) => path.basename(e.dir) === name);
    expect(byDir('broken-json')?.error).toMatch(/not valid JSON/);
    expect(byDir('bad-fields')?.error).toMatch(/id must match/);
    expect(byDir('bad-fields')?.error).toMatch(/kind must be one of/);
    expect(byDir('missing-entry')?.error).toMatch(/does not exist/);
    expect(byDir('escape-entry')?.error).toMatch(/relative path/);
    expect(byDir('dupe')?.error).toMatch(/duplicate plugin id/);
    expect(byDir('not-a-plugin')).toBeUndefined();
  });

  it('serves plugin files with correct MIME types', async () => {
    const js = await fetch(`${srv.url}/api/plugins/lofi-genre/files/index.js`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await js.text()).toContain('register');
    const data = await fetch(`${srv.url}/api/plugins/lofi-genre/files/data/lofi.json`);
    expect(data.headers.get('content-type')).toMatch(/application\/json/);
    const wav = await fetch(`${srv.url}/api/plugins/lofi-genre/files/sounds/kick.wav`);
    expect(wav.headers.get('content-type')).toBe('audio/wav');
    const mjs = await fetch(`${srv.url}/api/plugins/reaper-export/files/dist/main.mjs`);
    expect(mjs.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('rejects traversal, hidden files, directories, symlink escapes and unknown plugins', async () => {
    const statusOf = async (p: string) => (await rawRequest(srv.url, { path: p })).status;
    expect(
      await statusOf('/api/plugins/lofi-genre/files/..%2F..%2F..%2Fetc%2Fpasswd'),
    ).toBeGreaterThanOrEqual(400);
    expect(await statusOf('/api/plugins/lofi-genre/files/..%5C..%5Csecret.txt')).toBeGreaterThanOrEqual(400);
    expect(await statusOf('/api/plugins/lofi-genre/files/%2Fetc%2Fpasswd')).toBeGreaterThanOrEqual(400);
    expect(
      await statusOf(`/api/plugins/lofi-genre/files/${encodeURIComponent(path.join(outside, 'secret.txt'))}`),
    ).toBeGreaterThanOrEqual(400);
    expect(await statusOf('/api/plugins/lofi-genre/files/data/%2e%2e/%2e%2e/%2e%2e/secret.txt')).toBe(404);
    expect(await statusOf('/api/plugins/lofi-genre/files/a%00b')).toBeGreaterThanOrEqual(400);
    expect(await statusOf('/api/plugins/lofi-genre/files/.env')).toBe(404);
    expect(await statusOf('/api/plugins/lofi-genre/files/data')).toBe(404);
    expect(await statusOf('/api/plugins/lofi-genre/files/missing.js')).toBe(404);
    expect(await statusOf('/api/plugins/nope/files/index.js')).toBe(404);
    expect(await statusOf('/api/plugins/reaper-export/files/leak.txt')).toBe(404);
    for (const p of [
      '/api/plugins/lofi-genre/files/..%2F..%2F..%2Fetc%2Fpasswd',
      '/api/plugins/reaper-export/files/leak.txt',
    ]) {
      expect((await rawRequest(srv.url, { path: p })).body.toString()).not.toContain('TOP SECRET');
    }
  });
});
