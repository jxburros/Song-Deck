import type { Project } from '@songdeck/core';

/**
 * Local persistence (IndexedDB). Projects live on this device by default (spec §51 offline);
 * the optional local server adds disk storage, collaboration and render nodes.
 *
 * Stores:
 *  - summaries: lightweight list entries for the project browser
 *  - projects:  full Project objects (song + history snapshots + meta)
 *  - assets:    audio bytes keyed by asset id
 *  - kv:        settings, budget ledger, persisted task queue
 */

const DB_NAME = 'songdeck';
const DB_VERSION = 1;

export interface ProjectSummary {
  id: string;
  name: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  tracks: number;
  sections: number;
  bpm: number;
  keyName: string;
  revisions: number;
  branch: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) return Promise.reject(new Error('IndexedDB unavailable'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'meta.id' });
        if (!db.objectStoreNames.contains('assets')) {
          const s = db.createObjectStore('assets', { keyPath: 'id' });
          s.createIndex('projectId', 'projectId');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result: T;
        const req = fn(t);
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  if (!hasIndexedDb()) return [];
  const all = await tx<ProjectSummary[]>(['summaries'], 'readonly', (t) => t.objectStore('summaries').getAll());
  return (all ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveProject(project: Project, summary: ProjectSummary): Promise<void> {
  if (!hasIndexedDb()) return;
  await tx(['projects', 'summaries'], 'readwrite', (t) => {
    t.objectStore('projects').put(project);
    t.objectStore('summaries').put(summary);
  });
}

export async function loadProject(id: string): Promise<Project | undefined> {
  if (!hasIndexedDb()) return undefined;
  return tx<Project | undefined>(['projects'], 'readonly', (t) => t.objectStore('projects').get(id));
}

export async function deleteProject(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  const assetIds = await tx<IDBValidKey[]>(['assets'], 'readonly', (t) => t.objectStore('assets').index('projectId').getAllKeys(id));
  await tx(['projects', 'summaries', 'assets'], 'readwrite', (t) => {
    t.objectStore('projects').delete(id);
    t.objectStore('summaries').delete(id);
    for (const k of assetIds ?? []) t.objectStore('assets').delete(k);
  });
}

export interface StoredAsset {
  id: string;
  projectId: string;
  bytes: Uint8Array;
  mimeType: string;
}

export async function putAsset(asset: StoredAsset): Promise<void> {
  if (!hasIndexedDb()) return;
  await tx(['assets'], 'readwrite', (t) => {
    t.objectStore('assets').put(asset);
  });
}

export async function getAsset(id: string): Promise<StoredAsset | undefined> {
  if (!hasIndexedDb()) return undefined;
  return tx<StoredAsset | undefined>(['assets'], 'readonly', (t) => t.objectStore('assets').get(id));
}

export async function listProjectAssets(projectId: string): Promise<StoredAsset[]> {
  if (!hasIndexedDb()) return [];
  return tx<StoredAsset[]>(['assets'], 'readonly', (t) => t.objectStore('assets').index('projectId').getAll(projectId));
}

export async function deleteAsset(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  await tx(['assets'], 'readwrite', (t) => {
    t.objectStore('assets').delete(id);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (!hasIndexedDb()) return undefined;
  const row = await tx<{ key: string; value: T } | undefined>(['kv'], 'readonly', (t) => t.objectStore('kv').get(key));
  return row?.value;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  if (!hasIndexedDb()) return;
  await tx(['kv'], 'readwrite', (t) => {
    t.objectStore('kv').put({ key, value });
  });
}

/** Small synchronous settings cache in localStorage (UI prefs only, never secrets). */
export function localGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`songdeck:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function localSet<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`songdeck:${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) — settings stay in memory */
  }
}
