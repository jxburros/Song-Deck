import type { AudioAssetMeta, Song } from '@songdeck/core';
import { useStudio } from '../state/store';
import { assetStore } from '../state/assets';
import { player } from './player';

let started = false;

/**
 * Keep every audio clip of the open song playable (stems, produced audio, vocal renders, takes):
 * when the song or its assets change, any clip asset the player does not have yet is decoded and
 * handed to it once — so clips sound in every mode, including straight after a reload.
 */
export function initClipAssetSync(): void {
  if (started) return;
  started = true;
  const pending = new Set<string>();
  let lastSong: Song | null = null;
  let lastAssets: AudioAssetMeta[] | null = null;
  const sync = () => {
    const p = useStudio.getState().project;
    if (!p || (p.song === lastSong && p.meta.assets === lastAssets)) return;
    lastSong = p.song;
    lastAssets = p.meta.assets;
    for (const t of p.song.tracks) {
      for (const c of t.clips ?? []) {
        if (player.hasAsset(c.assetId) || pending.has(c.assetId)) continue;
        const meta = p.meta.assets.find((a) => a.id === c.assetId);
        if (!meta) continue;
        pending.add(c.assetId);
        assetStore
          .audio(meta)
          .then((audio) => {
            if (audio) player.provideAsset(c.assetId, audio);
          })
          .catch(() => {
            /* undecodable asset: the clip stays silent */
          })
          .finally(() => pending.delete(c.assetId));
      }
    }
  };
  useStudio.subscribe(sync);
  sync();
}
