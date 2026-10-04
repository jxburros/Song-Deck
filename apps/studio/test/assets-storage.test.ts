import { describe, expect, it, vi } from 'vitest';
import type { AudioAssetMeta } from '@songdeck/core';

// Browser storage stand-in: every write fails as it does when the origin's quota is used up.
const putAsset = vi.fn(async () => {
  throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
});
vi.mock('../src/state/persistence', () => ({
  putAsset: (...args: unknown[]) => (putAsset as (...a: unknown[]) => Promise<void>)(...args),
  getAsset: async () => undefined,
  deleteAsset: async () => undefined,
  listProjectAssets: async () => [],
}));

const { assetStore, isQuotaError } = await import('../src/state/assets');

const meta = (id: string) => ({ id, name: `${id}.wav`, mimeType: 'audio/wav' }) as unknown as AudioAssetMeta;

describe('asset store when browser storage is full', () => {
  it('keeps the audio for the session, flags it unsaved and reports it once per asset', async () => {
    const full = vi.fn();
    assetStore.onStorageFull(full);
    assetStore.reset('project-1');
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(assetStore.add(meta('a'), bytes)).resolves.toBeUndefined();
    expect(putAsset).toHaveBeenCalledTimes(1);
    expect(full).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(assetStore.isUnsaved('a')).toBe(true);
    // Still usable this session: playback, rendering and export read it from memory.
    expect(await assetStore.bytes(meta('a'))).toBe(bytes);
    expect((await assetStore.allBytes([meta('a')])).get('a')).toBe(bytes);

    await assetStore.remove('a');
    expect(assetStore.isUnsaved('a')).toBe(false);
  });

  it('still fails on storage errors other than a full quota', async () => {
    putAsset.mockImplementationOnce(async () => {
      throw Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' });
    });
    assetStore.reset('project-1');
    await expect(assetStore.add(meta('b'), new Uint8Array([1]))).rejects.toThrow('closing');
  });

  it('recognises quota errors from Chromium and Firefox', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError(new Error('nope'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});
