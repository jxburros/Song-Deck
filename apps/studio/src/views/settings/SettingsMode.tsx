import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSettings } from '../../state/settings';
import { useRuntime } from '../../engine/runtime';
import { getBudget, initAi, useAiRuntime } from '../../engine/ai';
import { useExtensions } from '../../engine/plugins';
import { useCollab } from '../../engine/collab';
import { Icon, type IconName } from '../../ui/icons';
import { syncHash, useSettingsNav, type SettingsTab } from './nav';
import { usd } from './ui';
import ProvidersTab from './ProvidersTab';
import RoutingTab from './RoutingTab';
import PrivacyTab from './PrivacyTab';
import BudgetTab from './BudgetTab';
import ModelsTab from './ModelsTab';
import NodesTab from './NodesTab';
import PluginsTab from './PluginsTab';
import CollabTab from './CollabTab';
import GeneralTab from './GeneralTab';
import './settings.css';

/**
 * Settings mode — "use whichever AI you want, or none" (spec §3-§8, §49-§51, §57, §60-§62,
 * Phase 5 collaboration / plugins / render nodes). Tabs are deep-linkable through `openSettings`.
 */

interface NavItem {
  tab: SettingsTab;
  label: string;
  icon: IconName;
  hint: string;
}

/** Everyday settings first; the rest under Advanced. Tab ids stay stable for deep links. */
const NAV: NavItem[] = [
  {
    tab: 'providers',
    label: 'AI services',
    icon: 'plug',
    hint: 'Connect a service, local models, custom endpoints',
  },
  {
    tab: 'privacy',
    label: 'Privacy and spending',
    icon: 'shield',
    hint: 'Offline mode, what leaves, limits, spend',
  },
  { tab: 'general', label: 'General', icon: 'settings', hint: 'Theme, your name, updates, server, storage' },
];
const ADVANCED: NavItem[] = [
  {
    tab: 'routing',
    label: 'Which model does what',
    icon: 'sliders',
    hint: 'Profiles and routing rules per task',
  },
  { tab: 'models', label: 'Models and hardware', icon: 'cpu', hint: 'What runs well on this machine' },
  { tab: 'nodes', label: 'Render nodes', icon: 'server', hint: 'Distribute stem renders' },
  {
    tab: 'plugins',
    label: 'Plugins, genres, instruments',
    icon: 'layers',
    hint: 'Plugins and your own profiles',
  },
  { tab: 'collab', label: 'Collaboration', icon: 'users', hint: 'Share projects, comments, live rooms' },
];
const ALL_NAV = [...NAV, ...ADVANCED];

/** Budget lives with Privacy; its own deep link still lands on it. */
const navTab = (tab: SettingsTab): SettingsTab => (tab === 'budget' ? 'privacy' : tab);

function PrivacyAndSpending({ focusBudget }: { focusBudget: boolean }) {
  const budget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusBudget) budget.current?.scrollIntoView({ block: 'start' });
  }, [focusBudget]);
  return (
    <>
      <PrivacyTab />
      <div ref={budget} className="st-joined" id="settings-budget">
        <BudgetTab />
      </div>
    </>
  );
}

function NavMeta({ tab }: { tab: SettingsTab }): ReactNode {
  const providers = useSettings((s) => s.providers);
  const routing = useSettings((s) => s.routing);
  const renderNodes = useSettings((s) => s.renderNodes);
  const useNodes = useSettings((s) => s.useRenderNodes);
  const enabledPlugins = useSettings((s) => s.enabledPlugins);
  const summaries = useAiRuntime((s) => s.providers);
  const version = useAiRuntime((s) => s.version);
  const server = useRuntime((s) => s.server.status);
  const collab = useCollab((s) => s.status);
  const peers = useCollab((s) => s.peers.length);
  const loaded = useExtensions((s) => Object.values(s.loaded).filter((p) => p.status === 'loaded').length);
  const [today, setToday] = useState(0);
  useEffect(() => {
    if (tab !== 'privacy') return;
    const b = getBudget();
    void b.ready().then(() => setToday(b.totals().todayUsd));
  }, [tab, version]);
  switch (tab) {
    case 'providers': {
      const errors = summaries.filter(
        (p) => p.config && p.enabled && (p.status === 'error' || p.status === 'offline'),
      ).length;
      return (
        <span className="st-nav-meta">
          {errors > 0 && (
            <span
              className="status-dot err"
              title={`${errors} provider${errors > 1 ? 's' : ''} with errors`}
            />
          )}
          {providers.length || ''}
        </span>
      );
    }
    case 'routing':
      return <span className="st-nav-meta">{routing.mode === 'automatic' ? 'auto' : routing.mode}</span>;
    case 'privacy':
      return routing.offline ? (
        <span className="st-nav-meta on">Offline</span>
      ) : today > 0 ? (
        <span className="st-nav-meta">{usd(today)}</span>
      ) : null;
    case 'budget':
      return today > 0 ? <span className="st-nav-meta">{usd(today)}</span> : null;
    case 'models':
      return (
        <span
          className={`status-dot ${server === 'online' ? 'ok' : ''}`}
          title={
            server === 'online'
              ? 'Hardware detection available'
              : 'Start the local server for hardware detection'
          }
        />
      );
    case 'nodes':
      return renderNodes.length ? (
        <span className={`st-nav-meta ${useNodes ? 'on' : ''}`}>
          {renderNodes.filter((n) => n.enabled).length}
        </span>
      ) : null;
    case 'plugins':
      return enabledPlugins.length ? (
        <span className="st-nav-meta">
          {loaded}/{enabledPlugins.length}
        </span>
      ) : null;
    case 'collab':
      return collab === 'disconnected' ? null : (
        <span className="st-nav-meta">
          <span className={`status-dot ${collab === 'connected' ? 'ok' : 'busy'}`} />
          {collab === 'connected' ? peers + 1 : ''}
        </span>
      );
    case 'general':
      return (
        <span
          className={`status-dot ${server === 'online' ? 'ok' : server === 'offline' ? 'warn' : ''}`}
          title={`Local server: ${server}`}
        />
      );
    default:
      return null;
  }
}

const VIEWS: Record<SettingsTab, () => ReactNode> = {
  providers: () => <ProvidersTab />,
  routing: () => <RoutingTab />,
  privacy: () => <PrivacyAndSpending focusBudget={false} />,
  budget: () => <PrivacyAndSpending focusBudget />,
  models: () => <ModelsTab />,
  nodes: () => <NodesTab />,
  plugins: () => <PluginsTab />,
  collab: () => <CollabTab />,
  general: () => <GeneralTab />,
};

function NavButton({ item, active, onPick }: { item: NavItem; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`st-nav-item ${active ? 'active' : ''}`}
      onClick={onPick}
      title={item.hint}
    >
      <Icon name={item.icon} size={15} />
      <span className="grow">
        <span className="st-nav-label">{item.label}</span>
        <span className="st-nav-hint">{item.hint}</span>
      </span>
      <NavMeta tab={item.tab} />
    </button>
  );
}

export default function SettingsMode() {
  const tab = useSettingsNav((s) => s.tab);
  const setTab = useSettingsNav((s) => s.setTab);
  const server = useRuntime((s) => s.server);
  const offline = useSettings((s) => s.routing.offline);
  const mode = useSettings((s) => s.routing.mode);

  useEffect(() => {
    initAi();
  }, []);

  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    syncHash(tab);
    content.current?.scrollTo(0, 0);
  }, [tab]);
  useEffect(() => () => syncHash(null), []);

  return (
    <div className="st-page" data-testid="settings-mode">
      <aside className="st-nav">
        <div className="st-nav-head">
          <span className="eyebrow-rule">Settings</span>
          <h2>Song Deck works without AI</h2>
          <p>Connect a service when you want prompts, changes in words and realistic audio.</p>
          <div className="st-nav-status">
            <span>
              <span
                className={`status-dot ${server.status === 'online' ? 'ok' : server.status === 'offline' ? 'warn' : ''}`}
              />
              {server.status === 'online'
                ? `Server online${server.info?.vault ? ` · ${server.info.vault.backend}` : ''}`
                : server.status === 'offline'
                  ? 'Browser-only mode'
                  : 'Checking server…'}
            </span>
            <span>
              <Icon name={offline ? 'shield' : 'cloud'} size={12} />
              {offline ? 'Offline — nothing leaves this device' : `Routing: ${mode}`}
            </span>
          </div>
        </div>
        <nav
          className="st-nav-list"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
        >
          {NAV.map((n) => (
            <NavButton key={n.tab} item={n} active={navTab(tab) === n.tab} onPick={() => setTab(n.tab)} />
          ))}
          <div className="st-nav-group" role="presentation">
            <span className="eyebrow-rule">Advanced</span>
          </div>
          {ADVANCED.map((n) => (
            <NavButton key={n.tab} item={n} active={navTab(tab) === n.tab} onPick={() => setTab(n.tab)} />
          ))}
        </nav>
      </aside>
      <section
        className="st-content"
        role="tabpanel"
        aria-label={ALL_NAV.find((n) => n.tab === navTab(tab))?.label}
        ref={content}
      >
        <div className="st-inner" key={tab}>
          {VIEWS[tab]()}
        </div>
      </section>
    </div>
  );
}
