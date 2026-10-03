import { create } from 'zustand';
import type { GenreProfile, InstrumentProfile } from '@songdeck/core';
import type { BudgetLimits, ProviderConfig, ProviderProfile, RoutingSettings } from '@songdeck/ai';
import { localGet, localSet } from './persistence';

/**
 * User-level settings (persisted in localStorage). NEVER contains secrets: API keys live in the
 * local server's vault (OS keychain) or, without a server, in an in-memory session store (spec §7).
 */

export interface RenderNodeConfig {
  id: string;
  name: string;
  url: string;
  token?: string;
  enabled: boolean;
}

export interface StudioSettings {
  theme: 'dark' | 'light';
  userName: string;
  /** Base URL of the local Song Deck server. '' = same origin (dev proxy or served by the server). */
  serverUrl: string;
  /** Route provider calls through the server so keys stay in the OS keychain. */
  useServerProxy: boolean;
  providers: ProviderConfig[];
  customProfiles: ProviderProfile[];
  routing: RoutingSettings;
  budget: BudgetLimits;
  exportPrefs: { sampleRate: 44100 | 48000; bitDepth: 16 | 24; mp3Kbps: 128 | 192 | 256 | 320 };
  renderNodes: RenderNodeConfig[];
  /** Distribute stem renders across enabled render nodes. */
  useRenderNodes: boolean;
  enabledPlugins: string[];
  customGenres: GenreProfile[];
  customInstruments: InstrumentProfile[];
  showTheoryHints: boolean;
}

export const DEFAULT_ROUTING: RoutingSettings = {
  mode: 'automatic',
  profileId: undefined,
  rules: [],
  offline: false,
  neverUpload: [],
  priorities: { quality: 0.5, cost: 0.3, latency: 0.2 },
  privacyConfirm: 'cloud',
} as RoutingSettings;

const DEFAULTS: StudioSettings = {
  theme: 'dark',
  userName: 'Me',
  serverUrl: '',
  useServerProxy: true,
  providers: [],
  customProfiles: [],
  routing: DEFAULT_ROUTING,
  budget: { perGenerationUsd: 2, dailyUsd: 10, monthlyUsd: 50, warningThreshold: 0.8 } as BudgetLimits,
  exportPrefs: { sampleRate: 44100, bitDepth: 24, mp3Kbps: 256 },
  renderNodes: [],
  useRenderNodes: false,
  enabledPlugins: [],
  customGenres: [],
  customInstruments: [],
  showTheoryHints: true,
};

interface SettingsState extends StudioSettings {
  update(patch: Partial<StudioSettings>): void;
  upsertProvider(config: ProviderConfig): void;
  removeProvider(id: string): void;
}

const persisted = localGet<Partial<StudioSettings>>('settings', {});

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  ...persisted,
  routing: { ...DEFAULT_ROUTING, ...(persisted.routing ?? {}) },
  update(patch) {
    set(patch);
    persist(get());
  },
  upsertProvider(config) {
    const providers = get()
      .providers.filter((p) => p.id !== config.id)
      .concat(config);
    set({ providers });
    persist(get());
  },
  removeProvider(id) {
    set({ providers: get().providers.filter((p) => p.id !== id) });
    persist(get());
  },
}));

function persist(s: SettingsState) {
  const { update: _u, upsertProvider: _a, removeProvider: _r, ...data } = s;
  void _u;
  void _a;
  void _r;
  localSet('settings', data);
}

export function serverBase(): string {
  let url = useSettings.getState().serverUrl.trim().replace(/\/+$/, '');
  // "localhost:7788" → "http://localhost:7788" ('' keeps same-origin requests).
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return url;
}
