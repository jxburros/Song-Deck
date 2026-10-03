/**
 * Credential vault (spec §7): secrets live in the OS keychain where possible, otherwise in an
 * AES-256-GCM encrypted file in the data directory, or only in memory (`--no-persist`, tests).
 * Secrets are never returned over HTTP — only references, labels and timestamps.
 */

export type VaultBackendName = 'keychain' | 'encrypted-file' | 'memory';

/** 'auto' = OS keychain when it works, otherwise the encrypted file. */
export type VaultPreference = 'auto' | VaultBackendName;

export interface VaultEntryMeta {
  ref: string;
  label?: string;
  updatedAt: string;
}

export interface CredentialVault {
  readonly backend: VaultBackendName;
  /** Human-readable detail (e.g. why the keychain was not used). */
  readonly detail?: string;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string, label?: string): Promise<void>;
  /** Resolves true when an entry was removed. */
  delete(ref: string): Promise<boolean>;
  list(): Promise<VaultEntryMeta[]>;
}

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** Subset of `@napi-rs/keyring` used by the keychain backend. */
export interface KeyringEntry {
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  getPassword(signal?: AbortSignal | null): Promise<string | undefined | null>;
  deleteCredential?(signal?: AbortSignal | null): Promise<boolean>;
  deletePassword(signal?: AbortSignal | null): Promise<boolean>;
}

export interface KeyringModule {
  AsyncEntry: new (service: string, account: string, options?: unknown) => KeyringEntry;
}

/** Loads the keyring module (undefined/throw = unavailable). Injectable for tests. */
export type KeychainModuleLoader = () => Promise<KeyringModule | undefined>;

export const REF_PATTERN = /^[A-Za-z0-9._:@/+=-]{1,256}$/;
export const MAX_SECRET_LENGTH = 64 * 1024;
export const MAX_LABEL_LENGTH = 200;

export function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_PATTERN.test(ref) && ref !== '.' && ref !== '..';
}
