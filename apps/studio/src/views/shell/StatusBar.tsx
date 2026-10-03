import { ENGINE_VERSION } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { useRuntime } from '../../engine/runtime';
import { Icon } from '../../ui/icons';

export function StatusBar() {
  const project = useStudio((s) => s.project);
  const saving = useStudio((s) => s.saving);
  const setTaskDrawer = useStudio((s) => s.setTaskDrawer);
  const drawerOpen = useStudio((s) => s.taskDrawerOpen);
  const server = useRuntime((s) => s.server);
  const tasks = useRuntime((s) => s.tasks);
  const routing = useSettings((s) => s.routing);
  const providers = useSettings((s) => s.providers);
  const running = tasks.filter((t) => t.status === 'running').length;
  const queued = tasks.filter((t) => t.status === 'queued').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const head = project?.history.revisions.find(
    (r) => r.id === project.history.branches.find((b) => b.id === project.history.currentBranchId)?.headRevisionId,
  );
  const cloudCount = providers.filter((p) => p.enabled && p.location === 'cloud').length;

  return (
    <footer className="statusbar">
      {project ? (
        <span title="Autosaved to this device">
          <span className={`status-dot ${saving ? 'busy' : 'ok'}`} style={{ display: 'inline-block', marginRight: 5 }} />
          {saving ? 'Saving…' : 'Saved'}
          {head && ` · v${head.number}`}
        </span>
      ) : (
        <span>No project open</span>
      )}
      <button onClick={() => useStudio.getState().setMode('settings')} title="Local Song Deck server (vault, proxy, render nodes, collaboration)">
        <span className={`status-dot ${server.status === 'online' ? 'ok' : server.status === 'offline' ? 'warn' : ''}`} />
        Server: {server.status === 'online' ? `online${server.info?.vault ? ` · vault: ${server.info.vault.backend}` : ''}` : server.status === 'offline' ? 'not running (browser-only mode)' : 'checking…'}
      </button>
      <button onClick={() => useStudio.getState().setMode('settings')} title="AI routing & privacy">
        <Icon name={routing.offline ? 'shield' : 'cloud'} size={12} />
        {routing.offline ? 'Offline mode — nothing leaves this device' : `AI routing: ${routing.mode}${cloudCount ? ` · ${cloudCount} cloud provider${cloudCount > 1 ? 's' : ''}` : ' · on-device engine'}`}
      </button>
      <div className="spacer" />
      <button onClick={() => setTaskDrawer(!drawerOpen)} title="Generation queue">
        <span className={`status-dot ${running ? 'busy' : failed ? 'err' : 'ok'}`} />
        Tasks: {running} running{queued ? ` · ${queued} queued` : ''}
        {failed ? ` · ${failed} failed` : ''}
      </button>
      <span className="dim">engine {ENGINE_VERSION}</span>
    </footer>
  );
}
