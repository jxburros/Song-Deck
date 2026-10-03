import { describe, expect, it } from 'vitest';
import { MemoryKeyValue } from '@songdeck/ai';
import { BrowserCredentialStore } from '../src/engine/credentials';

describe('browser credential store', () => {
  it('encrypts keys into its backend and reports where they are', async () => {
    const kv = new MemoryKeyValue();
    const store = new BrowserCredentialStore(kv);
    expect(store.persistent).toBe(true);
    expect(await store.put('provider:groq', 'gsk_test_0123456789abcdef', 'Groq API key')).toBe('browser');
    expect(await store.where('provider:groq')).toBe('browser');
    expect(await store.get('provider:groq')).toBe('gsk_test_0123456789abcdef');
    expect(JSON.stringify([...kv.data.values()], (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v))).not.toContain('gsk_test');
    // A reload (a new store over the same database) still has it.
    expect(await new BrowserCredentialStore(kv).get('provider:groq')).toBe('gsk_test_0123456789abcdef');
    expect((await store.list()).map((r) => r.ref)).toEqual(['provider:groq']);
    await store.clear();
    expect(await store.where('provider:groq')).toBe('none');
    expect(kv.data.size).toBe(0);
  });

  it('falls back to this tab’s memory without a backend', async () => {
    const store = new BrowserCredentialStore(null);
    expect(store.persistent).toBe(false);
    expect(await store.put('provider:openai', 'sk-proj-abc0123456789')).toBe('session');
    expect(await store.where('provider:openai')).toBe('session');
    expect(await store.get('provider:openai')).toBe('sk-proj-abc0123456789');
    await store.delete('provider:openai');
    expect(await store.get('provider:openai')).toBeUndefined();
  });
});
