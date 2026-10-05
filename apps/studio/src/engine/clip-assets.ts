import type { AudioAssetMeta, Song } from '@songdeck/core';
import { useStudio } from '../state/store';
import { assetStore } from '../state/assets';
import { player } from './player';

let started = false;

/** Audio assets a song plays: clips of audio tracks and frozen instrument-plugin renders. */
export function songAudioAssetIds(song: Song): string[] {
  const ids = new Set<string>();
  for (const t of song.tracks) {
    for (const c of t.clips ?? []) ids.add(c.assetId);
    const r = t.instrumentPlugin?.render;
    if (r && !t.instrumentPlugin?.bypass) ids.add(r.assetId);
  }
  return [...ids];
}

/**
 * Keep every audio clip of the open song playable (stems, produced audio, vocal renders, takes,
 * instrument-plugin renders):
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
    for (const assetId of songAudioAssetIds(p.song)) {
      if (player.hasAsset(assetId) || pending.has(assetId)) continue;
      const meta = p.meta.assets.find((a) => a.id === assetId);
      if (!meta) continue;
      pending.add(assetId);
      assetStore
        .audio(meta)
        .then((audio) => {
          if (audio) player.provideAsset(assetId, audio);
        })
        .catch(() => {
          /* undecodable asset: the clip stays silent */
        })
        .finally(() => pending.delete(assetId));
    }
  };
  useStudio.subscribe(sync);
  sync();
}
