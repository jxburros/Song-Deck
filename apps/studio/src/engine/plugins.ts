import { create } from 'zustand';
import * as core from '@songdeck/core';
import type { GenreProfile, InstrumentProfile, Song } from '@songdeck/core';
import { createInternalProvider, type InternalProviderSpec, type PricingInfo, type ProviderInstance } from '@songdeck/ai';
import type { SampleInstrument } from '@songdeck/audio';
import { serverBase, useSettings } from '../state/settings';
import { loadSfzInstrument } from './sfz-loader';

/**
 * Plugin ecosystem (spec §57, Phase 5).
 *
 * Plugins are discovered by the local server (`songdeck-plugin.json` manifests) but their code
 * only ever runs here, in the studio, after the user explicitly enables them. A plugin's entry
 * module exports `register(api)` and may contribute AI providers, music models, singing engines,
 * transcription engines (all as ProviderInstances advertising capabilities), instruments,
 * genre profiles and exporters.
 */

export type PluginKind = 'ai-provider' | 'music-model' | 'singing-engine' | 'transcription-engine' | 'instrument' | 'genre-profile' | 'exporter';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  description?: string;
  author?: string;
  entry?: string;
  files?: string[];
  permissions?: string[];
  homepage?: string;
}

export interface Exporter {
  id: string;
  name: string;
  extension: string;
  mimeType: string;
  description?: string;
  export(song: Song): Uint8Array | string | Promise<Uint8Array | string>;
}

/** A provider implemented by a plugin (spec §57: AI providers, music models, singing and transcription engines). */
export interface PluginProviderSpec extends InternalProviderSpec {
  /**
   * Where the provider sends data: 'local' (this machine or network) or 'cloud' (a remote
   * service — privacy confirmation, offline mode and budgets then apply, spec §50, §60).
   */
  location: 'local' | 'cloud';
  pricing?: PricingInfo;
}

export interface SongDeckPluginApi {
  apiVersion: 1;
  core: typeof core;
  ai: {
    /** Build a provider instance to pass to `registerProvider`. */
    createProvider(spec: PluginProviderSpec): ProviderInstance;
  };
  registerGenre(profile: GenreProfile): void;
  registerInstrument(profile: InstrumentProfile): void;
  /**
   * Register a sampled instrument: an SFZ file plus WAV/FLAC samples shipped in the plugin
   * (spec §57 "Instruments: Soundfonts"). The profile's General MIDI program is the fallback
   * sound wherever the samples are unavailable (e.g. a project opened without the plugin).
   */
  registerSampleInstrument(def: { profile: InstrumentProfile; sfz: string }): Promise<void>;
  registerExporter(exporter: Exporter): void;
  registerProvider(instance: ProviderInstance): void;
  /** URL of a file shipped with the plugin (samples, SFZ, JSON…). */
  fileUrl(path: string): string;
  log(message: string): void;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  status: 'loaded' | 'error' | 'disabled';
  error?: string;
  contributions: string[];
}

interface ExtensionsState {
  available: PluginManifest[];
  loaded: Record<string, LoadedPlugin>;
  genres: GenreProfile[];
  instruments: InstrumentProfile[];
  /** Sampled instruments by patch id (`sfz:<plugin>/<instrument>`). */
  sampleInstruments: Record<string, SampleInstrument>;
  exporters: Exporter[];
  providers: ProviderInstance[];
  scanError?: string;
}

export const useExtensions = create<ExtensionsState>(() => ({
  available: [],
  loaded: {},
  genres: [],
  instruments: [],
  sampleInstruments: {},
  exporters: [],
  providers: [],
}));

type ProviderListener = (instances: ProviderInstance[]) => void;
const providerListeners = new Set<ProviderListener>();

/** The AI runtime subscribes so plugin providers join the capability registry. */
export function onPluginProviders(fn: ProviderListener): () => void {
  providerListeners.add(fn);
  fn(useExtensions.getState().providers);
  return () => providerListeners.delete(fn);
}

export async function scanPlugins(): Promise<PluginManifest[]> {
  try {
    const res = await fetch(`${serverBase()}/api/plugins`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { plugins?: PluginManifest[] } | PluginManifest[];
    const list = Array.isArray(data) ? data : (data.plugins ?? []);
    useExtensions.setState({ available: list, scanError: undefined });
    return list;
  } catch (err) {
    useExtensions.setState({ scanError: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function loadPlugin(manifest: PluginManifest): Promise<void> {
  const contributions: string[] = [];
  const fileUrl = (p: string) => `${serverBase()}/api/plugins/${encodeURIComponent(manifest.id)}/files/${p.split('/').map(encodeURIComponent).join('/')}`;
  const api: SongDeckPluginApi = {
    apiVersion: 1,
    core,
    ai: {
      createProvider({ location, pricing, ...spec }) {
        const inst = createInternalProvider({ ...spec, id: spec.id ?? manifest.id, name: spec.name ?? manifest.name });
        return {
          ...inst,
          descriptor: {
            ...inst.descriptor,
            location,
            pricing: pricing ?? (location === 'cloud' ? undefined : inst.descriptor.pricing),
            description: spec.description ?? `Provided by the ${manifest.name} plugin`,
          },
        };
      },
    },
    registerGenre(profile) {
      useExtensions.setState((s) => ({ genres: [...s.genres.filter((g) => g.id !== profile.id), { ...profile, builtIn: false }] }));
      contributions.push(`genre ${profile.name}`);
    },
    registerInstrument(profile) {
      useExtensions.setState((s) => ({ instruments: [...s.instruments.filter((i) => i.id !== profile.id), { ...profile, custom: true }] }));
      contributions.push(`instrument ${profile.name}`);
    },
    async registerSampleInstrument({ profile, sfz }) {
      const patchId = `sfz:${manifest.id}/${profile.id}`;
      const loaded = await loadSfzInstrument(sfz, async (path) => {
        const res = await fetch(fileUrl(path));
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      });
      useExtensions.setState((s) => ({
        sampleInstruments: { ...s.sampleInstruments, [patchId]: { ...loaded.instrument, name: loaded.instrument.name ?? profile.name } },
        instruments: [...s.instruments.filter((i) => i.id !== profile.id), { ...profile, patchId, custom: true }],
      }));
      contributions.push(`sampled instrument ${profile.name} (${loaded.samples} samples, ${Math.round(loaded.bytes / 1024)} KB)`);
    },
    registerExporter(exporter) {
      useExtensions.setState((s) => ({ exporters: [...s.exporters.filter((e) => e.id !== exporter.id), exporter] }));
      contributions.push(`exporter ${exporter.name}`);
    },
    registerProvider(instance) {
      useExtensions.setState((s) => ({ providers: [...s.providers.filter((p) => p.descriptor.id !== instance.descriptor.id), instance] }));
      contributions.push(`provider ${instance.descriptor.name}`);
      for (const l of providerListeners) l(useExtensions.getState().providers);
    },
    fileUrl,
    log(message) {
      console.info(`[plugin ${manifest.id}] ${message}`);
    },
  };
  try {
    if (!manifest.entry) throw new Error('Manifest has no entry module');
    const mod = (await import(/* @vite-ignore */ fileUrl(manifest.entry))) as { register?: (api: SongDeckPluginApi) => void | Promise<void>; default?: { register?: (api: SongDeckPluginApi) => void } };
    const register = mod.register ?? mod.default?.register;
    if (typeof register !== 'function') throw new Error('Entry module does not export register(api)');
    await register(api);
    useExtensions.setState((s) => ({ loaded: { ...s.loaded, [manifest.id]: { manifest, status: 'loaded', contributions } } }));
  } catch (err) {
    useExtensions.setState((s) => ({
      loaded: { ...s.loaded, [manifest.id]: { manifest, status: 'error', error: err instanceof Error ? err.message : String(err), contributions } },
    }));
  }
}

export function unloadPlugin(id: string): void {
  // Contributions are keyed by the ids the plugin registered; reload the page for a clean unload of code.
  useExtensions.setState((s) => {
    const loaded = { ...s.loaded };
    if (loaded[id]) loaded[id] = { ...loaded[id], status: 'disabled' };
    return { loaded };
  });
}

/** Load every plugin the user has enabled (called at startup and after toggling). */
export async function loadEnabledPlugins(): Promise<void> {
  const enabled = new Set(useSettings.getState().enabledPlugins);
  if (!enabled.size) return;
  const list = await scanPlugins();
  for (const m of list) {
    if (enabled.has(m.id) && useExtensions.getState().loaded[m.id]?.status !== 'loaded') await loadPlugin(m);
  }
}

/** All custom genre profiles: user-defined (settings) + project-bundled + plugin-provided. */
export function allCustomGenres(projectGenres: GenreProfile[] = []): GenreProfile[] {
  const byId = new Map<string, GenreProfile>();
  for (const g of [...useExtensions.getState().genres, ...useSettings.getState().customGenres, ...projectGenres]) byId.set(g.id, g);
  return Array.from(byId.values());
}

/** All custom instrument profiles: user-defined + project-bundled + plugin-provided. */
export function allCustomInstruments(projectInstruments: InstrumentProfile[] = []): InstrumentProfile[] {
  const byId = new Map<string, InstrumentProfile>();
  for (const i of [...useExtensions.getState().instruments, ...useSettings.getState().customInstruments, ...projectInstruments]) byId.set(i.id, i);
  return Array.from(byId.values());
}
