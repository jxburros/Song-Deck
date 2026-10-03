import { EncryptedCredentialStore, MemoryCredentialStore, encryptedStoreSupported, type CredentialStore, type KeyValueBackend } from '@songdeck/ai';

/**
 * Browser-side API keys (spec §7) for when the local server's vault is not available.
 *
 * Keys are encrypted with AES-GCM under a non-extractable WebCrypto key; key and ciphertexts live
 * in their own IndexedDB database (`songdeck-keys`), separate from projects so exports, backups
 * and "clear projects" never touch them. Where WebCrypto or IndexedDB is unavailable (private
 * windows of some browsers, non-secure origins) keys fall back to this tab's memory.
 * See docs/CREDENTIALS.md for what this does and does not protect against.
 */

const DB_NAME = 'songdeck-keys';
const STORE = 'kv';

/** IndexedDB key-value backend (CryptoKey objects are stored by structured clone). */
export class IdbKeyValue implements KeyValueBackend {
  private dbPromise?: Promise<IDBDatabase>;

  private db(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      this.dbPromise.catch(() => (this.dbPromise = undefined));
    }
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let result: T;
      const req = fn(t.objectStore(STORE));
      if (req) req.onsuccess = () => (result = req.result);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.run('readwrite', (s) => {
      s.put(value, key);
    });
  }

  async delete(key: string): Promise<void> {
    await this.run('readwrite', (s) => {
      s.delete(key);
    });
  }

  async keys(): Promise<string[]> {
    return ((await this.run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? []).map(String);
  }
}

export type BrowserKeyWhere = 'browser' | 'session' | 'none';

/** Encrypted IndexedDB store with an in-memory fallback. */
export class BrowserCredentialStore implements CredentialStore {
  private readonly memory = new MemoryCredentialStore();
  private encrypted?: EncryptedCredentialStore;

  constructor(backend: KeyValueBackend | null = typeof indexedDB !== 'undefined' ? new IdbKeyValue() : null) {
    if (backend && encryptedStoreSupported()) {
      try {
        this.encrypted = new EncryptedCredentialStore(backend);
      } catch {
        this.encrypted = undefined;
      }
    }
  }

  /** Whether keys survive a reload (false = this tab's memory only). */
  get persistent(): boolean {
    return !!this.encrypted;
  }

  async get(ref: string): Promise<string | undefined> {
    const mem = await this.memory.get(ref);
    if (mem !== undefined) return mem;
    return this.encrypted ? this.encrypted.get(ref) : undefined;
  }

  /** Store a key; resolves where it went ('browser' = encrypted on this device). */
  async put(ref: string, secret: string, label?: string): Promise<'browser' | 'session'> {
    if (this.encrypted) {
      try {
        await this.encrypted.set(ref, secret, label);
        await this.memory.delete(ref);
        return 'browser';
      } catch {
        // IndexedDB refused (quota, private mode): keep the key for this tab only.
        this.encrypted = undefined;
      }
    }
    await this.memory.set(ref, secret, label);
    return 'session';
  }

  async set(ref: string, secret: string, label?: string): Promise<void> {
    await this.put(ref, secret, label);
  }

  async delete(ref: string): Promise<void> {
    await this.memory.delete(ref);
    await this.encrypted?.delete(ref).catch(() => undefined);
  }

  async list(): Promise<{ ref: string; label?: string; updatedAt?: string }[]> {
    const enc = this.encrypted ? await this.encrypted.list().catch(() => []) : [];
    const mem = await this.memory.list();
    const refs = new Set(enc.map((r) => r.ref));
    return [...enc, ...mem.filter((r) => !refs.has(r.ref))];
  }

  async where(ref: string): Promise<BrowserKeyWhere> {
    if (this.memory.has(ref)) return 'session';
    if (this.encrypted && (await this.encrypted.has(ref).catch(() => false))) return 'browser';
    return 'none';
  }

  /** Forget every browser-held key (and the encryption key itself). */
  async clear(): Promise<void> {
    this.memory.clear();
    await this.encrypted?.clear().catch(() => undefined);
  }
}

export const browserCredentials = new BrowserCredentialStore();
