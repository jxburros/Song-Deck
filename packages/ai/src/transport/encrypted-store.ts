/**
 * EncryptedCredentialStore — API keys encrypted at rest in the browser (spec §7), for when the
 * local server's vault (OS keychain) is not available. The server vault stays preferred.
 *
 * - One AES-GCM 256 key is generated once with WebCrypto as NON-EXTRACTABLE and kept in the
 *   key-value backend (IndexedDB stores CryptoKey objects by structured clone, so the raw key
 *   bytes are never visible to page code, storage dumps or exports).
 * - Each secret is stored as `{ iv, ct }` (12-byte random IV, ciphertext + GCM tag). The reference
 *   is bound as additional authenticated data, so a ciphertext copied to another reference — or
 *   altered in any way — fails to decrypt instead of yielding a wrong key.
 * - Plaintext never touches localStorage, settings, projects, exports or logs.
 *
 * Threat model (docs/CREDENTIALS.md): this protects keys at rest against casual reads of the
 * browser profile on disk and against other sites (same-origin policy). It does NOT protect
 * against script running in this origin (XSS, a malicious plugin) or someone using the unlocked
 * browser profile — they can ask this store to decrypt, exactly as the app does.
 *
 * The storage is behind `KeyValueBackend` so the store is unit-testable in Node with
 * `MemoryKeyValue` and `globalThis.crypto` (Node 20+ ships WebCrypto).
 */
import { ProviderError } from '../errors';
import type { CredentialStore } from '../types';

/** Minimal async key-value storage (IndexedDB in the studio, a Map in tests). Values are structured-cloneable. */
export interface KeyValueBackend {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryKeyValue implements KeyValueBackend {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }
}

/** One stored secret (never contains plaintext). */
export interface EncryptedRecord {
  v: 1;
  iv: Uint8Array;
  ct: Uint8Array;
  label?: string;
  updatedAt: string;
}

/**
 * The slice of WebCrypto this store uses, typed structurally so the package compiles both with the
 * DOM lib (studio) and with Node's types (server, tests) without either.
 */
type CryptoKeyLike = object;
interface SubtleLike {
  generateKey(algorithm: { name: string; length: number }, extractable: boolean, usages: string[]): Promise<unknown>;
  encrypt(algorithm: { name: string; iv: Uint8Array<ArrayBuffer>; additionalData?: Uint8Array<ArrayBuffer> }, key: never, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  decrypt(algorithm: { name: string; iv: Uint8Array<ArrayBuffer>; additionalData?: Uint8Array<ArrayBuffer> }, key: never, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}
export interface WebCryptoLike {
  subtle: SubtleLike;
  getRandomValues<T extends Uint8Array<ArrayBuffer>>(array: T): T;
}

const MASTER_KEY = 'master-key';
const SECRET_PREFIX = 'secret:';

export interface EncryptedCredentialStoreOptions {
  /** WebCrypto implementation (default: globalThis.crypto). */
  crypto?: WebCryptoLike;
}

/** True when this runtime can run the encrypted store (secure context with WebCrypto subtle). */
export function encryptedStoreSupported(c: WebCryptoLike | undefined = defaultCrypto()): boolean {
  return !!c?.subtle && typeof c.getRandomValues === 'function';
}

export class EncryptedCredentialStore implements CredentialStore {
  private readonly crypto: WebCryptoLike;
  private keyPromise?: Promise<CryptoKeyLike>;

  constructor(
    private readonly kv: KeyValueBackend,
    opts: EncryptedCredentialStoreOptions = {},
  ) {
    const c = opts.crypto ?? defaultCrypto();
    if (!c || !encryptedStoreSupported(c)) throw new Error('WebCrypto is not available (the encrypted key store needs a secure context)');
    this.crypto = c;
  }

  /** The store's AES-GCM key: loaded from the backend, or generated (non-extractable) on first use. */
  private masterKey(): Promise<CryptoKeyLike> {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        const existing = await this.kv.get<CryptoKeyLike>(MASTER_KEY);
        if (existing) return existing;
        const key = (await this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])) as CryptoKeyLike;
        await this.kv.set(MASTER_KEY, key);
        return key;
      })();
      this.keyPromise.catch(() => (this.keyPromise = undefined));
    }
    return this.keyPromise;
  }

  private aad(ref: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`songdeck-credential:${ref}`);
  }

  async set(ref: string, secret: string, label?: string): Promise<void> {
    if (!secret) throw new ProviderError('bad-request', 'Secret must not be empty');
    const key = await this.masterKey();
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(ref) }, key as never, new TextEncoder().encode(secret)));
    const record: EncryptedRecord = { v: 1, iv, ct, updatedAt: new Date().toISOString(), ...(label ? { label } : {}) };
    await this.kv.set(SECRET_PREFIX + ref, record);
  }

  /**
   * Decrypt a secret. Resolves undefined when nothing is stored; throws an `auth` ProviderError when
   * the record cannot be decrypted (store reset, tampering) so the UI can ask for the key again.
   */
  async get(ref: string): Promise<string | undefined> {
    const record = await this.kv.get<EncryptedRecord>(SECRET_PREFIX + ref);
    if (!record) return undefined;
    const key = await this.masterKey();
    try {
      const pt = await this.crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(record.iv), additionalData: this.aad(ref) }, key as never, toBuffer(record.ct));
      return new TextDecoder().decode(pt);
    } catch {
      throw new ProviderError('auth', `The stored key "${ref}" could not be decrypted (the browser key store was reset or altered) — enter the key again`);
    }
  }

  async delete(ref: string): Promise<void> {
    await this.kv.delete(SECRET_PREFIX + ref);
  }

  async list(): Promise<{ ref: string; label?: string; updatedAt?: string }[]> {
    const out: { ref: string; label?: string; updatedAt?: string }[] = [];
    for (const k of await this.kv.keys()) {
      if (!k.startsWith(SECRET_PREFIX)) continue;
      const r = await this.kv.get<EncryptedRecord>(k);
      out.push({ ref: k.slice(SECRET_PREFIX.length), ...(r?.label ? { label: r.label } : {}), ...(r?.updatedAt ? { updatedAt: r.updatedAt } : {}) });
    }
    return out.sort((a, b) => a.ref.localeCompare(b.ref));
  }

  async has(ref: string): Promise<boolean> {
    return (await this.kv.get(SECRET_PREFIX + ref)) !== undefined;
  }

  /** Forget every stored secret AND the encryption key (a fresh key is generated on next use). */
  async clear(): Promise<void> {
    for (const k of await this.kv.keys()) await this.kv.delete(k);
    this.keyPromise = undefined;
  }
}

function defaultCrypto(): WebCryptoLike | undefined {
  return (globalThis as { crypto?: WebCryptoLike }).crypto;
}

/** A standalone ArrayBuffer-backed copy (records read back from IndexedDB may be views). */
function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}
