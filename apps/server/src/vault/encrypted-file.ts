/**
 * Encrypted-file vault: AES-256-GCM, a random 32-byte key in `<dataDir>/vault.key` (0600) and the
 * entries in `<dataDir>/vault.enc`. Every entry has its own random 96-bit nonce and is
 * authenticated together with its reference, label and timestamp (AAD), so modified ciphertext,
 * swapped entries or edited metadata are detected on read.
 *
 * This protects secrets at rest against casual disclosure (backups of the vault file without the
 * key, accidental sharing); it cannot protect against malware running as the same user. That is
 * why the OS keychain is preferred whenever it works.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Mutex, writeFileAtomic } from '../http-util';
import { type CredentialVault, type VaultEntryMeta, VaultError } from './types';

interface StoredEntry {
  label?: string;
  updatedAt: string;
  /** base64 96-bit nonce */
  iv: string;
  /** base64 128-bit GCM tag */
  tag: string;
  /** base64 ciphertext */
  data: string;
}

interface VaultFile {
  format: 'songdeck-vault';
  version: 1;
  cipher: 'aes-256-gcm';
  entries: Record<string, StoredEntry>;
}

const KEY_BYTES = 32;

function aad(ref: string, label: string | undefined, updatedAt: string): Buffer {
  return Buffer.from(JSON.stringify(['songdeck-vault', 1, ref, label ?? null, updatedAt]), 'utf8');
}

export class EncryptedFileVault implements CredentialVault {
  readonly backend = 'encrypted-file' as const;
  readonly keyFile: string;
  readonly vaultFile: string;
  private key?: Buffer;
  private readonly mutex = new Mutex();

  constructor(
    readonly dataDir: string,
    readonly detail?: string,
  ) {
    this.keyFile = path.join(dataDir, 'vault.key');
    this.vaultFile = path.join(dataDir, 'vault.enc');
  }

  /** Create or load the key and verify the vault file parses. */
  async init(): Promise<void> {
    await this.loadKey();
    await this.readFile();
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key) return this.key;
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let key: Buffer | undefined;
    try {
      key = await fsp.readFile(this.keyFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (!key) {
      const existing = await this.readFile().catch(() => undefined);
      if (existing && Object.keys(existing.entries).length) {
        throw new VaultError(
          'vault-key-missing',
          `${this.keyFile} is missing, so the secrets in ${this.vaultFile} cannot be decrypted. Restore the key or move vault.enc aside to start a new vault.`,
        );
      }
      const fresh = randomBytes(KEY_BYTES);
      try {
        await fsp.writeFile(this.keyFile, fresh, { mode: 0o600, flag: 'wx' });
        key = fresh;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        key = await fsp.readFile(this.keyFile);
      }
    }
    if (key.length !== KEY_BYTES) {
      throw new VaultError('vault-key-invalid', `${this.keyFile} must contain exactly ${KEY_BYTES} bytes`);
    }
    if (process.platform !== 'win32') {
      try {
        const st = await fsp.stat(this.keyFile);
        if ((st.mode & 0o077) !== 0) await fsp.chmod(this.keyFile, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.key = key;
    return key;
  }

  private async readFile(): Promise<VaultFile> {
    let text: string;
    try {
      text = await fsp.readFile(this.vaultFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { format: 'songdeck-vault', version: 1, cipher: 'aes-256-gcm', entries: {} };
      throw err;
    }
    let parsed: VaultFile;
    try {
      parsed = JSON.parse(text) as VaultFile;
    } catch {
      throw new VaultError('vault-corrupt', `${this.vaultFile} is not valid JSON (corrupted or tampered with)`);
    }
    if (!parsed || parsed.format !== 'songdeck-vault' || parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      throw new VaultError('vault-corrupt', `${this.vaultFile} has an unknown format`);
    }
    return parsed;
  }

  private async writeVault(file: VaultFile): Promise<void> {
    await writeFileAtomic(this.vaultFile, JSON.stringify(file, null, 1), 0o600);
  }

  private encrypt(key: Buffer, ref: string, secret: string, label: string | undefined, updatedAt: string): StoredEntry {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(ref, label, updatedAt));
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ...(label !== undefined ? { label } : {}),
      updatedAt,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: data.toString('base64'),
    };
  }

  private decrypt(key: Buffer, ref: string, entry: StoredEntry): string {
    try {
      const iv = Buffer.from(entry.iv, 'base64');
      const tag = Buffer.from(entry.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('bad nonce or tag');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad(ref, entry.label, entry.updatedAt));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new VaultError(
        'vault-tampered',
        `Vault entry "${ref}" failed authentication (vault.enc was modified or vault.key does not belong to it)`,
      );
    }
  }

  async get(ref: string): Promise<string | undefined> {
    const key = await this.loadKey();
    const file = await this.readFile();
    const entry = Object.prototype.hasOwnProperty.call(file.entries, ref) ? file.entries[ref] : undefined;
    if (!entry) return undefined;
    return this.decrypt(key, ref, entry);
  }

  async set(ref: string, secret: string, label?: string): Promise<void> {
    await this.mutex.run(async () => {
      const key = await this.loadKey();
      const file = await this.readFile();
      file.entries[ref] = this.encrypt(key, ref, secret, label, new Date().toISOString());
      await this.writeVault(file);
    });
  }

  async delete(ref: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const file = await this.readFile();
      if (!Object.prototype.hasOwnProperty.call(file.entries, ref)) return false;
      delete file.entries[ref];
      await this.writeVault(file);
      return true;
    });
  }

  async list(): Promise<VaultEntryMeta[]> {
    const file = await this.readFile();
    return Object.entries(file.entries)
      .map(([ref, e]) => ({ ref, ...(typeof e.label === 'string' ? { label: e.label } : {}), updatedAt: String(e.updatedAt) }))
      .sort((a, b) => a.ref.localeCompare(b.ref));
  }
}
