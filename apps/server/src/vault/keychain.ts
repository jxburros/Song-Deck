/**
 * OS keychain vault via the optional `@napi-rs/keyring` module: macOS Keychain, Windows Credential
 * Manager, Linux Secret Service (GNOME Keyring / KWallet). Service name: `songdeck`.
 *
 * Keychains cannot be enumerated portably, so references, labels and timestamps (never secrets)
 * are kept in `<dataDir>/vault-index.json`.
 *
 * On Linux the entry is pinned to the Secret Service: the kernel keyring fallback is not
 * persistent across reboots, which would silently lose keys — the encrypted file is used instead.
 */
import path from 'node:path';
import { Mutex, readJsonFile, writeFileAtomic } from '../http-util';
import {
  type CredentialVault,
  type KeychainModuleLoader,
  type KeyringEntry,
  type KeyringModule,
  type VaultEntryMeta,
  VaultError,
} from './types';

export const KEYCHAIN_SERVICE = 'songdeck';

interface IndexFile {
  format: 'songdeck-vault-index';
  version: 1;
  refs: Record<string, { label?: string; updatedAt: string }>;
}

export const defaultKeychainLoader: KeychainModuleLoader = async () => {
  // A variable specifier keeps the optional dependency out of static resolution and typechecking.
  const specifier = '@napi-rs/keyring';
  const mod = (await import(specifier)) as Partial<KeyringModule> & { default?: Partial<KeyringModule> };
  if (typeof mod.AsyncEntry === 'function') return mod as KeyringModule;
  if (mod.default && typeof mod.default.AsyncEntry === 'function') return mod.default as KeyringModule;
  return undefined;
};

export function keychainEntryOptions(): unknown {
  return process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined;
}

async function withTimeout<T>(ms: number, what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new VaultError('keychain-timeout', `OS keychain did not respond to ${what} within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class KeychainVault implements CredentialVault {
  readonly backend = 'keychain' as const;
  private readonly indexFile: string;
  private readonly mutex = new Mutex();

  constructor(
    private readonly mod: KeyringModule,
    readonly dataDir: string,
    private readonly entryOptions: unknown = keychainEntryOptions(),
    // Generous: the OS may ask the user to allow access (e.g. macOS after a Node.js update).
    private readonly timeoutMs = 60_000,
    readonly detail?: string,
  ) {
    this.indexFile = path.join(dataDir, 'vault-index.json');
  }

  private entry(ref: string): KeyringEntry {
    return new this.mod.AsyncEntry(KEYCHAIN_SERVICE, ref, this.entryOptions);
  }

  private async readIndex(): Promise<IndexFile> {
    let parsed: IndexFile | undefined;
    try {
      parsed = await readJsonFile<IndexFile>(this.indexFile);
    } catch {
      parsed = undefined;
    }
    if (
      !parsed ||
      parsed.format !== 'songdeck-vault-index' ||
      typeof parsed.refs !== 'object' ||
      parsed.refs === null
    ) {
      return { format: 'songdeck-vault-index', version: 1, refs: {} };
    }
    return parsed;
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    await writeFileAtomic(this.indexFile, JSON.stringify(index, null, 2), 0o600);
  }

  async get(ref: string): Promise<string | undefined> {
    const value = await withTimeout(this.timeoutMs, 'a read', (signal) =>
      this.entry(ref).getPassword(signal),
    );
    return value === null || value === undefined ? undefined : value;
  }

  async set(ref: string, secret: string, label?: string): Promise<void> {
    await this.mutex.run(async () => {
      await withTimeout(this.timeoutMs, 'a write', (signal) => this.entry(ref).setPassword(secret, signal));
      const index = await this.readIndex();
      index.refs[ref] = { ...(label !== undefined ? { label } : {}), updatedAt: new Date().toISOString() };
      await this.writeIndex(index);
    });
  }

  async delete(ref: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const removed = await withTimeout(this.timeoutMs, 'a delete', (signal) => {
        const e = this.entry(ref);
        return (e.deleteCredential ?? e.deletePassword).call(e, signal);
      });
      const index = await this.readIndex();
      const indexed = Object.prototype.hasOwnProperty.call(index.refs, ref);
      if (indexed) {
        delete index.refs[ref];
        await this.writeIndex(index);
      }
      return Boolean(removed) || indexed;
    });
  }

  async list(): Promise<VaultEntryMeta[]> {
    const index = await this.readIndex();
    return Object.entries(index.refs)
      .map(([ref, e]) => ({
        ref,
        ...(typeof e.label === 'string' ? { label: e.label } : {}),
        updatedAt: String(e.updatedAt),
      }))
      .sort((a, b) => a.ref.localeCompare(b.ref));
  }
}

/**
 * Verify that the keychain really works (write, read back, delete a probe entry). Throws with a
 * readable reason otherwise (no D-Bus session, locked keychain, missing native binary…).
 */
export async function probeKeychain(
  mod: KeyringModule,
  entryOptions: unknown,
  timeoutMs = 5000,
): Promise<void> {
  const account = `__songdeck_probe__${process.pid}`;
  const value = `probe-${Date.now()}`;
  const entry = new mod.AsyncEntry(KEYCHAIN_SERVICE, account, entryOptions);
  await withTimeout(timeoutMs, 'the probe write', (signal) => entry.setPassword(value, signal));
  try {
    const read = await withTimeout(timeoutMs, 'the probe read', (signal) => entry.getPassword(signal));
    if (read !== value)
      throw new VaultError('keychain-unreliable', 'OS keychain returned a different value than was stored');
  } finally {
    await withTimeout(timeoutMs, 'the probe delete', (signal) =>
      (entry.deleteCredential ?? entry.deletePassword).call(entry, signal),
    ).catch(() => undefined);
  }
}
