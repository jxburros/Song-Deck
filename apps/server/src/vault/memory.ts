import type { CredentialVault, VaultEntryMeta } from './types';

/** Session-only vault: secrets are forgotten when the server exits (`--no-persist`, tests). */
export class MemoryVault implements CredentialVault {
  readonly backend = 'memory' as const;
  private readonly entries = new Map<string, { secret: string; label?: string; updatedAt: string }>();

  constructor(readonly detail?: string) {}

  async get(ref: string): Promise<string | undefined> {
    return this.entries.get(ref)?.secret;
  }

  async set(ref: string, secret: string, label?: string): Promise<void> {
    this.entries.set(ref, { secret, label, updatedAt: new Date().toISOString() });
  }

  async delete(ref: string): Promise<boolean> {
    return this.entries.delete(ref);
  }

  async list(): Promise<VaultEntryMeta[]> {
    return [...this.entries.entries()]
      .map(([ref, e]) => ({
        ref,
        ...(e.label !== undefined ? { label: e.label } : {}),
        updatedAt: e.updatedAt,
      }))
      .sort((a, b) => a.ref.localeCompare(b.ref));
  }
}
