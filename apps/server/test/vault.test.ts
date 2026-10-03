import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVault, EncryptedFileVault, KeychainVault, MemoryVault, type KeyringModule } from '../src/vault';
import { json, startServer, tempDir, type TestServer } from './helpers';

let srv: TestServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = tempDir('songdeck-vault-');
  dirs.push(d);
  return d;
};

async function exerciseHttpVault(url: string, expectedBackend: string) {
  const put = await fetch(`${url}/api/vault/${encodeURIComponent('provider:openai')}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'sk-test-super-secret-value-123456', label: 'OpenAI key' }),
  });
  expect(put.status).toBe(204);
  const list = await fetch(`${url}/api/vault`);
  const text = await list.text();
  expect(text).not.toContain('sk-test-super-secret'); // never returned
  const body = JSON.parse(text);
  expect(body.backend).toBe(expectedBackend);
  expect(body.refs).toEqual([{ ref: 'provider:openai', label: 'OpenAI key', updatedAt: expect.any(String) }]);
  const del = await fetch(`${url}/api/vault/${encodeURIComponent('provider:openai')}`, { method: 'DELETE' });
  expect(del.status).toBe(204);
  expect((await json(await fetch(`${url}/api/vault`))).refs).toEqual([]);
}

describe('vault over HTTP', () => {
  it('memory backend: set / list / delete without exposing secrets', async () => {
    srv = await startServer({ vault: 'memory' });
    await exerciseHttpVault(srv.url, 'memory');
  });

  it('encrypted-file backend: set / list / delete', async () => {
    srv = await startServer({ vault: 'encrypted-file' });
    await exerciseHttpVault(srv.url, 'encrypted-file');
  });

  it('validates references, secrets and labels', async () => {
    srv = await startServer();
    const put = (ref: string, body: unknown) => fetch(`${srv!.url}/api/vault/${ref}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put('bad%20ref', { secret: 'x' })).status).toBe(400);
    expect((await put('a%00b', { secret: 'x' })).status).toBe(400);
    expect((await put('%E0%A4%A', { secret: 'x' })).status).toBe(400); // malformed percent-encoding
    expect((await put('ok', { secret: '' })).status).toBe(400);
    expect((await put('ok', { secret: 42 })).status).toBe(400);
    expect((await put('ok', { secret: 'x', label: 'y'.repeat(500) })).status).toBe(400);
    expect((await put('ok', ['secret'])).status).toBe(400);
    expect((await put('ok', { secret: 'x' })).status).toBe(204);
  });

  it('--no-persist forces the memory vault', async () => {
    srv = await startServer({ vault: 'encrypted-file', persist: false });
    expect((await json(await fetch(`${srv.url}/api/vault`))).backend).toBe('memory');
  });
});

describe('encrypted-file vault', () => {
  it('stores ciphertext only, with a 0600 key, and survives a restart', async () => {
    const d = dir();
    const v1 = new EncryptedFileVault(d);
    await v1.init();
    await v1.set('provider:anthropic', 'sk-ant-plaintext-should-not-appear', 'Anthropic');
    const file = readFileSync(path.join(d, 'vault.enc'), 'utf8');
    expect(file).not.toContain('sk-ant-plaintext');
    expect(file).not.toContain(Buffer.from('sk-ant-plaintext-should-not-appear').toString('base64'));
    expect(readFileSync(path.join(d, 'vault.key')).length).toBe(32);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(d, 'vault.key')).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(d, 'vault.enc')).mode & 0o777).toBe(0o600);
    }
    const v2 = new EncryptedFileVault(d);
    await v2.init();
    expect(await v2.get('provider:anthropic')).toBe('sk-ant-plaintext-should-not-appear');
    expect(await v2.list()).toEqual([{ ref: 'provider:anthropic', label: 'Anthropic', updatedAt: expect.any(String) }]);
    expect(await v2.get('missing')).toBeUndefined();
    expect(await v2.delete('provider:anthropic')).toBe(true);
    expect(await v2.delete('provider:anthropic')).toBe(false);
  });

  it('uses a fresh nonce per entry and per write', async () => {
    const d = dir();
    const v = new EncryptedFileVault(d);
    await v.init();
    await v.set('a', 'same-secret');
    await v.set('b', 'same-secret');
    const entries = JSON.parse(readFileSync(path.join(d, 'vault.enc'), 'utf8')).entries;
    expect(entries.a.iv).not.toBe(entries.b.iv);
    expect(entries.a.data).not.toBe(entries.b.data);
  });

  it('detects tampering with ciphertext, metadata or swapped entries', async () => {
    const d = dir();
    const v = new EncryptedFileVault(d);
    await v.init();
    await v.set('a', 'secret-a', 'A');
    await v.set('b', 'secret-b', 'B');
    const file = path.join(d, 'vault.enc');
    const original = readFileSync(file, 'utf8');

    const flip = JSON.parse(original);
    const data = Buffer.from(flip.entries.a.data, 'base64');
    data[0] ^= 0xff;
    flip.entries.a.data = data.toString('base64');
    writeFileSync(file, JSON.stringify(flip));
    await expect(new EncryptedFileVault(d).get('a')).rejects.toMatchObject({ code: 'vault-tampered' });
    expect(await new EncryptedFileVault(d).get('b')).toBe('secret-b'); // other entries unaffected

    const relabel = JSON.parse(original);
    relabel.entries.a.label = 'Evil';
    writeFileSync(file, JSON.stringify(relabel));
    await expect(new EncryptedFileVault(d).get('a')).rejects.toMatchObject({ code: 'vault-tampered' });

    const swapped = JSON.parse(original);
    swapped.entries.a = { ...swapped.entries.b, label: 'A' };
    writeFileSync(file, JSON.stringify(swapped));
    await expect(new EncryptedFileVault(d).get('a')).rejects.toMatchObject({ code: 'vault-tampered' });

    writeFileSync(file, '{not json');
    await expect(new EncryptedFileVault(d).get('a')).rejects.toMatchObject({ code: 'vault-corrupt' });
  });

  it('refuses to decrypt with a different key and never overwrites existing secrets with a new key', async () => {
    const d = dir();
    const v = new EncryptedFileVault(d);
    await v.init();
    await v.set('a', 'secret-a');
    writeFileSync(path.join(d, 'vault.key'), Buffer.alloc(32, 7));
    await expect(new EncryptedFileVault(d).get('a')).rejects.toMatchObject({ code: 'vault-tampered' });
    rmSync(path.join(d, 'vault.key'));
    await expect(new EncryptedFileVault(d).init()).rejects.toMatchObject({ code: 'vault-key-missing' });
  });

  it('surfaces vault errors over HTTP as JSON errors', async () => {
    const d = dir();
    srv = await startServer({ vault: 'encrypted-file', dataDir: d });
    await fetch(`${srv.url}/api/vault/a`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 's' }) });
    writeFileSync(path.join(d, 'vault.enc'), 'garbage');
    const res = await fetch(`${srv.url}/api/vault`);
    expect(res.status).toBe(500);
    expect(await json(res)).toMatchObject({ code: 'vault-corrupt' });
  });
});

function fakeKeyring(behavior: 'ok' | 'fail' | 'wrong-value' = 'ok') {
  const store = new Map<string, string>();
  const mod: KeyringModule = {
    AsyncEntry: class {
      constructor(
        private service: string,
        private account: string,
      ) {}
      async setPassword(pw: string) {
        if (behavior === 'fail') throw new Error('Platform failure: no secret service');
        store.set(`${this.service}/${this.account}`, pw);
      }
      async getPassword() {
        const v = store.get(`${this.service}/${this.account}`);
        return behavior === 'wrong-value' && v !== undefined ? `${v}-corrupted` : (v ?? null);
      }
      async deletePassword() {
        return store.delete(`${this.service}/${this.account}`);
      }
    },
  };
  return { mod, store };
}

describe('vault backend selection', () => {
  it('falls back to the encrypted file when the keyring module is missing', async () => {
    const vault = await createVault({
      dataDir: dir(),
      keychain: async () => {
        throw new Error("Cannot find module '@napi-rs/keyring'");
      },
    });
    expect(vault.backend).toBe('encrypted-file');
    expect(vault.detail).toMatch(/keyring/);
    await vault.set('x', 'y');
    expect(await vault.get('x')).toBe('y');
  });

  it('falls back when the keychain probe fails or is unreliable', async () => {
    expect((await createVault({ dataDir: dir(), keychain: async () => fakeKeyring('fail').mod })).backend).toBe('encrypted-file');
    expect((await createVault({ dataDir: dir(), keychain: async () => fakeKeyring('wrong-value').mod })).backend).toBe('encrypted-file');
    expect((await createVault({ dataDir: dir(), keychain: async () => undefined })).backend).toBe('encrypted-file');
  });

  it('falls back when the keychain hangs', async () => {
    const hanging: KeyringModule = {
      AsyncEntry: class {
        setPassword() {
          return new Promise<void>(() => undefined);
        }
        getPassword() {
          return new Promise<string>(() => undefined);
        }
        deletePassword() {
          return Promise.resolve(false);
        }
      },
    };
    const vault = await createVault({ dataDir: dir(), keychain: async () => hanging, probeTimeoutMs: 100 });
    expect(vault.backend).toBe('encrypted-file');
  });

  it('uses a working keychain and keeps only an index (no secrets) on disk', async () => {
    const d = dir();
    const { mod, store } = fakeKeyring('ok');
    const vault = await createVault({ dataDir: d, keychain: async () => mod });
    expect(vault).toBeInstanceOf(KeychainVault);
    expect(vault.backend).toBe('keychain');
    expect(store.size).toBe(0); // probe entry cleaned up
    await vault.set('provider:gemini', 'AIzaSyD-secret-gemini-key-00000000000', 'Gemini');
    expect(store.get('songdeck/provider:gemini')).toBe('AIzaSyD-secret-gemini-key-00000000000');
    expect(await vault.get('provider:gemini')).toBe('AIzaSyD-secret-gemini-key-00000000000');
    const index = readFileSync(path.join(d, 'vault-index.json'), 'utf8');
    expect(index).toContain('provider:gemini');
    expect(index).not.toContain('AIzaSyD');
    expect(await vault.list()).toEqual([{ ref: 'provider:gemini', label: 'Gemini', updatedAt: expect.any(String) }]);
    expect(await vault.delete('provider:gemini')).toBe(true);
    expect(await vault.list()).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('honours an explicit memory preference', async () => {
    const vault = await createVault({ dataDir: dir(), prefer: 'memory' });
    expect(vault).toBeInstanceOf(MemoryVault);
  });
});
