import { create } from 'zustand';
import {
  createProject,
  midiToSong,
  packProject,
  randomId,
  songToMidi,
  unpackProject,
  type Song,
  type ProjectMeta,
  type AudioAssetMeta,
} from '@songdeck/core';
import { libraryPut, libraryList, libraryDelete, putAsset } from './persistence';
import type { PendingAttestation } from '../engine/rights';
import { assetStore, guessMime } from './assets';
import { downloadBytes, slugify } from '../engine/capture-files';
import { useStudio } from './store';

export interface LibraryAsset {
  meta: AudioAssetMeta;
  bytes: Uint8Array;
}
export interface LibraryItem {
  id: string;
  name: string;
  kind: 'midi' | 'collection' | 'audio' | 'file';
  createdAt: string;
  song?: Song;
  assets: LibraryAsset[];
  metadata?: ProjectMeta;
  attestation?: PendingAttestation;
  file?: { name: string; mime: string; bytes: Uint8Array };
}
export type LibraryDraft = Omit<LibraryItem, 'id' | 'createdAt'>;
export const useLibrary = create<{
  items: LibraryItem[];
  refresh(): Promise<void>;
  save(item: LibraryDraft): Promise<LibraryItem>;
  remove(id: string): Promise<void>;
}>((set, get) => ({
  items: [],
  async refresh() {
    set({ items: (await libraryList<LibraryItem>()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  },
  async save(draft) {
    const item = structuredClone({ ...draft, id: randomId('lib'), createdAt: new Date().toISOString() });
    await libraryPut(item);
    set({ items: [item, ...get().items] });
    return item;
  },
  async remove(id) {
    await libraryDelete(id);
    set({ items: get().items.filter((i) => i.id !== id) });
  },
}));

/** Fresh identities for every copied entity and reference, including clip assets and mixer keys. */
export function independentCopy(item: LibraryItem): LibraryItem {
  const ids = new Map<string, string>();
  function collect(v: unknown) {
    if (!v || typeof v !== 'object' || v instanceof Uint8Array) return;
    if ('id' in v && typeof v.id === 'string') ids.set(v.id, randomId('copy'));
    Object.values(v).forEach(collect);
  }
  collect(item);
  const remap = (s: string) =>
    ids.get(s) ??
    s
      .split(':')
      .map((p) => ids.get(p) ?? p)
      .join(':');
  function copy(v: unknown): unknown {
    if (typeof v === 'string') return remap(v);
    if (v instanceof Uint8Array) return v.slice();
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [remap(k), copy(val)]));
    return v;
  }
  const result = copy(item) as LibraryItem;
  for (const asset of result.assets) {
    const ext = asset.meta.path.split('.').pop() ?? 'bin';
    asset.meta.path = `assets/${asset.meta.id}.${ext}`;
  }
  return result;
}

export async function saveSongToLibrary(song: Song, trackIds?: string[]) {
  const snapshot = structuredClone(song);
  if (trackIds) {
    snapshot.tracks = snapshot.tracks.filter((t) => trackIds.includes(t.id));
    snapshot.phrases = snapshot.phrases.filter((p) => trackIds.includes(p.trackId));
    snapshot.lyrics = snapshot.lyrics.filter((l) => !l.trackId || trackIds.includes(l.trackId));
    snapshot.mixer.channels = Object.fromEntries(
      Object.entries(snapshot.mixer.channels).filter(([id]) => trackIds.includes(id)),
    );
    snapshot.automation =
      snapshot.automation?.filter((a) => a.target === 'master' || trackIds.includes(a.target)) ?? [];
  }
  const project = useStudio.getState().project;
  const needed = new Set(snapshot.tracks.flatMap((t) => t.clips.map((c) => c.assetId)));
  const assets: LibraryAsset[] = [];
  for (const id of needed) {
    const meta = project?.meta.assets.find((a) => a.id === id);
    const bytes = meta && (await assetStore.bytes(meta));
    if (!meta || !bytes)
      throw new Error('An audio file is unavailable. Restore it before saving this collection.');
    assets.push({ meta, bytes });
  }
  const name = trackIds?.length === 1 ? (snapshot.tracks[0]?.name ?? snapshot.title) : snapshot.title;
  return useLibrary.getState().save({
    name,
    kind: snapshot.tracks.length === 1 && snapshot.tracks[0].kind === 'midi' ? 'midi' : 'collection',
    song: snapshot,
    assets,
    metadata: project?.song.id === song.id ? structuredClone(project.meta) : undefined,
  });
}

export async function fileToLibraryDraft(file: File, uploaded = false): Promise<LibraryDraft> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.(mid|midi)$/i.test(file.name)) {
    const song = midiToSong(bytes, { title: file.name.replace(/\.(mid|midi)$/i, '') });
    return {
      name: song.title,
      kind: song.tracks.length > 1 ? 'collection' : 'midi',
      song,
      assets: [],
      file: { name: file.name, mime: 'audio/midi', bytes },
    };
  }
  if (/\.songproject$/i.test(file.name)) {
    const { project, assets } = unpackProject(bytes);
    return {
      name: project.meta.name,
      kind: 'collection',
      song: project.song,
      metadata: project.meta,
      assets: project.meta.assets.map((meta) => {
        const data = assets.get(meta.id);
        if (!data) throw new Error(`Missing audio: ${meta.name}`);
        return { meta, bytes: data };
      }),
    };
  }
  const isAudio =
    file.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|m4a|aac|webm|opus)$/i.test(file.name);
  let attestation: PendingAttestation | undefined;
  if (uploaded && isAudio) {
    const { requestAttestation } = await import('../engine/rights');
    const result = await requestAttestation([{ name: file.name, bytes }], {
      context: 'library-compose',
      purpose: 'Save or compose with uploaded audio',
    });
    if (!result) throw Object.assign(new Error('Import cancelled'), { name: 'AbortError' });
    attestation = result[0];
  }
  return {
    name: file.name,
    kind:
      file.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|m4a|aac|webm|opus)$/i.test(file.name)
        ? 'audio'
        : 'file',
    assets: [],
    attestation,
    file: { name: file.name, mime: file.type || guessMime(file.name, bytes), bytes },
  };
}

export function exportLibraryItem(item: LibraryItem) {
  if (item.file) return downloadBytes(item.file.bytes, item.file.name, item.file.mime);
  if (!item.song) return;
  if (item.kind === 'midi')
    return downloadBytes(songToMidi(item.song), `${slugify(item.name)}.mid`, 'audio/midi');
  const project = createProject(item.name, item.song);
  if (item.metadata)
    project.meta = {
      ...structuredClone(item.metadata),
      id: project.meta.id,
      name: item.name,
      createdAt: project.meta.createdAt,
      updatedAt: project.meta.updatedAt,
    };
  project.meta.assets = item.assets.map((a) => a.meta);
  downloadBytes(
    packProject(project, new Map(item.assets.map((a) => [a.meta.id, a.bytes]))),
    `${slugify(item.name)}.songproject`,
  );
}

/** Persist copied bytes against a captured project id, then attach metadata without switching projects. */
export async function attachLibraryAssets(items: LibraryItem[], projectId: string): Promise<void> {
  for (const item of items)
    for (const a of item.assets) {
      await putAsset({ id: a.meta.id, projectId, bytes: a.bytes, mimeType: a.meta.mimeType });
    }
  if (useStudio.getState().project?.meta.id !== projectId)
    throw new Error('The active project changed. Return to the intended project to add these files.');
  useStudio.getState().updateProject((p) => {
    const meta = structuredClone(p.meta);
    for (const item of items) {
      meta.assets.push(...item.assets.map((a) => a.meta));
      if (item.attestation)
        meta.attestations = [
          ...(meta.attestations ?? []),
          { ...item.attestation, assetId: item.assets[0]?.meta.id },
        ];
      if (item.metadata) {
        meta.provenance.push(...item.metadata.provenance);
        meta.attestations = [...(meta.attestations ?? []), ...(item.metadata.attestations ?? [])];
        meta.customInstruments = [
          ...meta.customInstruments,
          ...item.metadata.customInstruments.filter(
            (i) => !meta.customInstruments.some((x) => x.id === i.id),
          ),
        ];
        meta.customGenres = [
          ...meta.customGenres,
          ...item.metadata.customGenres.filter((i) => !meta.customGenres.some((x) => x.id === i.id)),
        ];
      }
    }
    return { ...p, meta };
  });
}
