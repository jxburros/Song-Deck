import { create } from 'zustand';
import { useStudio } from '../../state/store';

/**
 * Settings navigation (deep-linkable): any part of the studio can open a settings tab — and focus
 * an item in it (a provider id, a plugin id…) — with `openSettings('providers', 'openai')`.
 * The active tab is mirrored in the URL hash (`#settings/<tab>[/<focus>]`) while Settings is open,
 * so a link like `/#settings/privacy` opens straight into that tab.
 */

export type SettingsTab = 'providers' | 'routing' | 'privacy' | 'budget' | 'models' | 'nodes' | 'plugins' | 'collab' | 'general';

export const SETTINGS_TABS: readonly SettingsTab[] = ['providers', 'routing', 'privacy', 'budget', 'models', 'nodes', 'plugins', 'collab', 'general'];

interface NavState {
  tab: SettingsTab;
  /** Item to focus inside the tab (provider id, plugin id, genre id…). */
  focus: string | null;
  setTab(tab: SettingsTab, focus?: string | null): void;
  clearFocus(): void;
}

const LAST_TAB_KEY = 'songdeck:settings-tab';

function isTab(v: unknown): v is SettingsTab {
  return typeof v === 'string' && (SETTINGS_TABS as readonly string[]).includes(v);
}

function fromHash(): { tab: SettingsTab; focus: string | null } | null {
  if (typeof window === 'undefined') return null;
  const m = /^#settings\/([a-z]+)(?:\/(.+))?$/.exec(window.location.hash);
  if (!m || !isTab(m[1])) return null;
  return { tab: m[1], focus: m[2] ? decodeURIComponent(m[2]) : null };
}

function initialTab(): SettingsTab {
  try {
    const last = sessionStorage.getItem(LAST_TAB_KEY);
    if (isTab(last)) return last;
  } catch {
    /* storage unavailable */
  }
  return 'providers';
}

const linked = fromHash();

export const useSettingsNav = create<NavState>((set) => ({
  tab: linked?.tab ?? initialTab(),
  focus: linked?.focus ?? null,
  setTab(tab, focus = null) {
    set({ tab, focus });
    try {
      sessionStorage.setItem(LAST_TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  },
  clearFocus() {
    set({ focus: null });
  },
}));

/** Open Settings at a tab (and optionally focus an item in it). */
export function openSettings(tab: SettingsTab = 'providers', focus?: string): void {
  useSettingsNav.getState().setTab(tab, focus ?? null);
  useStudio.getState().setMode('settings');
}

/** Keep the URL hash in sync with the visible tab (called by SettingsMode). */
export function syncHash(tab: SettingsTab | null): void {
  if (typeof window === 'undefined') return;
  const url = `${window.location.pathname}${window.location.search}${tab ? `#settings/${tab}` : ''}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== url) window.history.replaceState(window.history.state, '', url);
}

// A deep link opened the page: show Settings right away.
if (linked) queueMicrotask(() => useStudio.getState().setMode('settings'));
