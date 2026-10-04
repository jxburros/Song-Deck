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

const NAV: NavItem[] = [
  { tab: 'providers', label: 'Providers', icon: 'plug', hint: 'Cloud keys, local models, custom endpoints' },
  { tab: 'routing', label: 'Profiles & routing', icon: 'sliders', hint: 'Who handles each task, and why' },
  { tab: 'privacy', label: 'Privacy', icon: 'shield', hint: 'Offline mode, never-upload, data flow' },
  { tab: 'budget', label: 'Budget & spend', icon: 'tasks', hint: 'Limits and the spend ledger' },
  { tab: 'models', label: 'Models & hardware', icon: 'cpu', hint: 'What runs well on this machine' },
  { tab: 'nodes', label: 'Render nodes', icon: 'server', hint: 'Distribute stem renders' },
  { tab: 'plugins', label: 'Plugins & profiles', icon: 'layers', hint: 'Plugins, genres, instruments' },
  { tab: 'collab', label: 'Collaboration', icon: 'users', hint: 'Share projects, work together live' },
  { tab: 'general', label: 'General', icon: 'settings', hint: 'Theme, server, storage, about' },
];

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
    if (tab !== 'budget') return;
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
      return routing.offline ? <span className="st-nav-meta on">Offline</span> : null;
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
  privacy: () => <PrivacyTab />,
  budget: () => <BudgetTab />,
  models: () => <ModelsTab />,
  nodes: () => <NodesTab />,
  plugins: () => <PluginsTab />,
  collab: () => <CollabTab />,
  general: () => <GeneralTab />,
};

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
          <h2>Settings</h2>
          <p>Use whichever AI you want — or none.</p>
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
            <button
              key={n.tab}
              type="button"
              role="tab"
              aria-selected={tab === n.tab}
              className={`st-nav-item ${tab === n.tab ? 'active' : ''}`}
              onClick={() => setTab(n.tab)}
              title={n.hint}
            >
              <Icon name={n.icon} size={15} />
              <span className="grow">
                <span className="st-nav-label">{n.label}</span>
                <span className="st-nav-hint">{n.hint}</span>
              </span>
              <NavMeta tab={n.tab} />
            </button>
          ))}
        </nav>
      </aside>
      <section
        className="st-content"
        role="tabpanel"
        aria-label={NAV.find((n) => n.tab === tab)?.label}
        ref={content}
      >
        <div className="st-inner" key={tab}>
          {VIEWS[tab]()}
        </div>
      </section>
    </div>
  );
}
