import { decodeFlac, decodeWav, type AudioData } from '@songdeck/audio';
import type { AudioAssetMeta } from '@songdeck/core';
import { deleteAsset, getAsset, listProjectAssets, putAsset } from './persistence';

/**
 * Audio asset cache: original bytes (as stored in the .songproject package) plus a lazily
 * decoded planar float representation for playback, rendering and analysis.
 */

export interface AssetEntry {
  meta: AudioAssetMeta;
  bytes: Uint8Array;
  decoded?: AudioData;
}

function isWav(bytes: Uint8Array) {
  return (
    bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
  );
}

function isFlac(bytes: Uint8Array) {
  return bytes.length > 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
}

/** Decode any browser-supported audio file (WAV/FLAC natively; MP3/AAC/OGG via Web Audio). */
export async function decodeAudioBytes(bytes: Uint8Array): Promise<AudioData> {
  if (isWav(bytes)) return decodeWav(bytes);
  if (isFlac(bytes)) {
    try {
      return decodeFlac(bytes);
    } catch {
      /* fall through to the browser decoder */
    }
  }
  const Ctx: typeof OfflineAudioContext =
    (globalThis as unknown as { OfflineAudioContext: typeof OfflineAudioContext }).OfflineAudioContext ??
    (globalThis as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This environment cannot decode compressed audio');
  const ctx = new Ctx(2, 1, 44100);
  const copy = bytes.slice().buffer;
  const buf = await ctx.decodeAudioData(copy);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
  return { sampleRate: buf.sampleRate, channels };
}

export function guessMime(fileName: string, bytes?: Uint8Array): string {
  if (bytes && isWav(bytes)) return 'audio/wav';
  if (bytes && isFlac(bytes)) return 'audio/flac';
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'aac':
      return 'audio/aac';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

class AssetStore {
  private entries = new Map<string, AssetEntry>();
  private projectId: string | null = null;

  reset(projectId: string | null) {
    this.entries.clear();
    this.projectId = projectId;
  }

  async add(meta: AudioAssetMeta, bytes: Uint8Array, decoded?: AudioData): Promise<void> {
    this.entries.set(meta.id, { meta, bytes, decoded });
    if (this.projectId)
      await putAsset({ id: meta.id, projectId: this.projectId, bytes, mimeType: meta.mimeType });
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
    await deleteAsset(id);
  }

  async bytes(meta: AudioAssetMeta): Promise<Uint8Array | undefined> {
    const e = this.entries.get(meta.id);
    if (e) return e.bytes;
    const stored = await getAsset(meta.id);
    if (!stored) return undefined;
    this.entries.set(meta.id, { meta, bytes: stored.bytes });
    return stored.bytes;
  }

  async audio(meta: AudioAssetMeta): Promise<AudioData | undefined> {
    const e = this.entries.get(meta.id);
    if (e?.decoded) return e.decoded;
    const bytes = await this.bytes(meta);
    if (!bytes) return undefined;
    const decoded = await decodeAudioBytes(bytes);
    const entry = this.entries.get(meta.id);
    if (entry) entry.decoded = decoded;
    return decoded;
  }

  decodedSync(id: string): AudioData | undefined {
    return this.entries.get(id)?.decoded;
  }

  /** All asset bytes for packaging (.songproject). */
  async allBytes(metas: AudioAssetMeta[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    if (this.projectId) {
      for (const s of await listProjectAssets(this.projectId)) out.set(s.id, s.bytes);
    }
    for (const m of metas) {
      const e = this.entries.get(m.id);
      if (e) out.set(m.id, e.bytes);
    }
    return out;
  }
}

export const assetStore = new AssetStore();
