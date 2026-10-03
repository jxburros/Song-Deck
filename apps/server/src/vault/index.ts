/**
 * Vault selection and HTTP routes (`GET /api/vault`, `PUT|DELETE /api/vault/:ref`).
 */
import { HttpError, isPlainObject, readJson, sendJson, sendNoContent } from '../http-util';
import type { Logger } from '../logger';
import type { Router } from '../router';
import { EncryptedFileVault } from './encrypted-file';
import { defaultKeychainLoader, KeychainVault, keychainEntryOptions, probeKeychain } from './keychain';
import { MemoryVault } from './memory';
import {
  type CredentialVault,
  isValidRef,
  type KeychainModuleLoader,
  MAX_LABEL_LENGTH,
  MAX_SECRET_LENGTH,
  type VaultPreference,
  VaultError,
} from './types';

export * from './types';
export { EncryptedFileVault } from './encrypted-file';
export { KeychainVault, probeKeychain, KEYCHAIN_SERVICE } from './keychain';
export { MemoryVault } from './memory';

export interface CreateVaultOptions {
  dataDir: string;
  prefer?: VaultPreference;
  keychain?: KeychainModuleLoader;
  logger?: Logger;
  probeTimeoutMs?: number;
}

/** Try the OS keychain; resolves the vault or the reason it is unusable. */
async function tryKeychain(opts: CreateVaultOptions): Promise<{ vault?: KeychainVault; reason?: string }> {
  let mod;
  try {
    mod = await (opts.keychain ?? defaultKeychainLoader)();
  } catch (err) {
    return { reason: `@napi-rs/keyring is not available (${(err as Error)?.message ?? String(err)})` };
  }
  if (!mod) return { reason: '@napi-rs/keyring is not available' };
  const entryOptions = keychainEntryOptions();
  try {
    await probeKeychain(mod, entryOptions, opts.probeTimeoutMs ?? 5000);
  } catch (err) {
    return { reason: `OS keychain probe failed: ${(err as Error)?.message ?? String(err)}` };
  }
  return { vault: new KeychainVault(mod, opts.dataDir, entryOptions) };
}

/**
 * Pick the most secure working backend: OS keychain → encrypted file. `memory` only when asked
 * for (`--no-persist`, tests).
 */
export async function createVault(opts: CreateVaultOptions): Promise<CredentialVault> {
  const prefer = opts.prefer ?? 'auto';
  if (prefer === 'memory')
    return new MemoryVault('Secrets are kept in memory only and are forgotten when the server stops');
  let fallbackReason: string | undefined;
  if (prefer === 'auto' || prefer === 'keychain') {
    const { vault, reason } = await tryKeychain(opts);
    if (vault) return vault;
    fallbackReason = reason;
    opts.logger?.[prefer === 'keychain' ? 'warn' : 'info'](
      `Vault: ${reason}; using the encrypted file vault instead`,
    );
  }
  const fileVault = new EncryptedFileVault(
    opts.dataDir,
    fallbackReason ? `OS keychain unavailable: ${fallbackReason}` : undefined,
  );
  await fileVault.init();
  return fileVault;
}

function vaultHttpError(err: unknown): unknown {
  if (err instanceof VaultError) return new HttpError(500, err.code, err.message);
  return err;
}

export function registerVaultRoutes(
  router: Router,
  getVault: () => CredentialVault,
  jsonLimit: number,
): void {
  router.get('/api/vault', async ({ res }) => {
    const vault = getVault();
    try {
      // Secrets are NEVER returned — only references and metadata.
      sendJson(res, 200, {
        backend: vault.backend,
        ...(vault.detail ? { detail: vault.detail } : {}),
        refs: await vault.list(),
      });
    } catch (err) {
      throw vaultHttpError(err);
    }
  });

  router.put('/api/vault/:ref', async ({ req, res, params }) => {
    const ref = params.ref;
    if (!isValidRef(ref))
      throw new HttpError(
        400,
        'invalid-ref',
        'Invalid credential reference (letters, digits and . _ : @ / + = - only, max 256)',
      );
    const body = await readJson<unknown>(req, jsonLimit);
    if (!isPlainObject(body)) throw new HttpError(400, 'bad-request', 'Body must be { secret, label? }');
    const { secret, label } = body as { secret?: unknown; label?: unknown };
    if (typeof secret !== 'string' || secret.length === 0)
      throw new HttpError(400, 'invalid-secret', 'secret must be a non-empty string');
    if (secret.length > MAX_SECRET_LENGTH)
      throw new HttpError(400, 'invalid-secret', `secret must be at most ${MAX_SECRET_LENGTH} characters`);
    if (
      label !== undefined &&
      label !== null &&
      (typeof label !== 'string' || label.length > MAX_LABEL_LENGTH)
    ) {
      throw new HttpError(
        400,
        'invalid-label',
        `label must be a string of at most ${MAX_LABEL_LENGTH} characters`,
      );
    }
    try {
      await getVault().set(ref, secret, typeof label === 'string' ? label : undefined);
    } catch (err) {
      throw vaultHttpError(err);
    }
    sendNoContent(res);
  });

  router.delete('/api/vault/:ref', async ({ res, params }) => {
    const ref = params.ref;
    if (!isValidRef(ref)) throw new HttpError(400, 'invalid-ref', 'Invalid credential reference');
    try {
      await getVault().delete(ref);
    } catch (err) {
      throw vaultHttpError(err);
    }
    sendNoContent(res);
  });
}

/**
 * Read-only `@songdeck/ai` CredentialStore over the vault, for server-side transports (the
 * managed gateway). Secrets resolved here never leave the server.
 */
export function vaultCredentialReader(getVault: () => CredentialVault): {
  get(ref: string): Promise<string | undefined>;
} {
  return { get: (ref: string) => getVault().get(ref) };
}
