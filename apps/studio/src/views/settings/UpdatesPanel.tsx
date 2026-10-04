import { useEffect, useState } from 'react';
import { useRuntime } from '../../engine/runtime';
import { serverBase, useSettings } from '../../state/settings';
import { Button } from '../../ui/kit';
import studioPkg from '../../../package.json';
import { serverJson } from './api';
import { ConfirmModal, Panel } from './ui';

interface UpdateStatus {
  currentVersion: string;
  latestVersion?: string;
  pendingVersion?: string;
  available: boolean;
  automatic: boolean;
  supported: boolean;
  busy: boolean;
  checkedAt?: string;
  error?: string;
  releasesUrl: string;
}
const RELEASES = 'https://github.com/jxburros/Song-Deck/releases';
const headers = { 'content-type': 'application/json', 'x-songdeck-client': 'updates' };

export default function UpdatesPanel() {
  const server = useRuntime((s) => s.server);
  const serverUrl = useSettings((s) => s.serverUrl);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [restartTarget, setRestartTarget] = useState('');
  const restarting = Boolean(restartTarget);
  const [restarted, setRestarted] = useState(false);
  const online = server.status === 'online';
  const supported = online && server.info?.features?.includes('updates');

  useEffect(() => {
    let active = true;
    setStatus(null);
    setError('');
    if (!supported) return;
    const refresh = () =>
      void serverJson<UpdateStatus>('/api/updates')
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [supported, serverUrl]);

  useEffect(() => {
    if (!restartTarget) return;
    const target = restartTarget;
    const base = serverBase();
    let active = true;
    const timer = setInterval(() => {
      void fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
        .then(async (res) => {
          if (!res.ok) return;
          const health = (await res.json()) as { version: string };
          if (active && health.version === target) {
            setRestartTarget('');
            setRestarted(true);
          }
        })
        .catch(() => undefined);
    }, 1500);
    const timeout = setTimeout(() => {
      setRestartTarget('');
      setError(
        'The updated server has not returned yet. Check the server terminal; the launcher restores the previous version if startup fails.',
      );
    }, 45_000);
    return () => {
      active = false;
      clearInterval(timer);
      clearTimeout(timeout);
    };
  }, [restartTarget]);

  async function run(name: string, automatic?: boolean) {
    setAction(name);
    setError('');
    try {
      const next = await serverJson<UpdateStatus>(`/api/updates/${name}`, {
        method: name === 'settings' ? 'PUT' : 'POST',
        headers,
        ...(name === 'settings' ? { body: JSON.stringify({ automatic }) } : {}),
      });
      if (name === 'restart') setRestartTarget(status?.pendingVersion ?? '');
      else setStatus(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed.');
    } finally {
      setAction('');
    }
  }
  const busy = Boolean(action || status?.busy || restarting);
  const needsReload = restarted || Boolean(status && status.currentVersion !== studioPkg.version);
  return (
    <Panel title="App updates" icon="rebuild" testId="updates-panel">
      <div className="row between wrap">
        <div>
          <strong>Song Deck {status?.currentVersion ?? studioPkg.version}</strong>
          <div className="small dim">Stable releases from the Song Deck GitHub repository.</div>
        </div>
        <a href={RELEASES} target="_blank" rel="noreferrer">
          Release notes & downloads
        </a>
      </div>
      {!online ? (
        <p className="small muted">
          Start the local Song Deck server to check for and install updates. For a browser-only installation,
          download the latest studio build from Releases.
        </p>
      ) : !supported ? (
        <p className="callout small">
          This server does not support in-app updates yet. Install the latest Song Deck build from Releases,
          then restart the server.
        </p>
      ) : (
        <>
          {status && !status.supported && (
            <p className="callout small">
              Restart the server using <code>npm run start:server</code> (source checkout) or{' '}
              <code>node server/songdeck-server.mjs</code> (download) to enable installation and automatic
              updates.
            </p>
          )}
          <div role="status" aria-live="polite">
            {needsReload
              ? 'Update applied. Reload the studio when your work is saved.'
              : restarting
                ? 'Restarting the server…'
                : status?.busy
                  ? 'Checking and preparing the update…'
                  : status?.pendingVersion
                    ? `Version ${status.pendingVersion} is ready. It will apply the next time the server starts.`
                    : status?.available
                      ? `Version ${status.latestVersion} is available.`
                      : status?.checkedAt
                        ? 'You’re up to date.'
                        : 'Check for the latest available version.'}
          </div>
          {status?.checkedAt && (
            <div className="small dim">Last checked: {new Date(status.checkedAt).toLocaleString()}</div>
          )}
          <div className="row wrap">
            <Button size="sm" onClick={() => void run('check')} disabled={busy || !status}>
              Check for updates
            </Button>
            {status?.available && !status.pendingVersion && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void run('install')}
                disabled={busy || !status.supported}
              >
                Download update
              </Button>
            )}
            {status?.pendingVersion && !restarted && (
              <Button size="sm" variant="primary" onClick={() => setConfirm(true)} disabled={busy}>
                Restart to update
              </Button>
            )}
            {needsReload && (
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload studio
              </Button>
            )}
          </div>
          <label className="row">
            <input
              type="checkbox"
              checked={status?.automatic ?? false}
              disabled={busy || !status?.supported}
              onChange={(e) => void run('settings', e.target.checked)}
            />
            Automatically download and install updates on next start
          </label>
          <p className="small dim">
            When enabled, the server checks GitHub at startup and every six hours, even when the studio is
            closed. Downloads are verified before installation. Song Deck never automatically restarts or
            reloads your session. Turning this off stops future downloads; an update already downloaded still
            applies on next start.
          </p>
        </>
      )}
      {(error || status?.error) && (
        <div role="alert" className="callout small">
          {error || status?.error}
        </div>
      )}
      {confirm && (
        <ConfirmModal
          title="Restart to apply the update?"
          confirmLabel="Restart server"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            setConfirm(false);
            await run('restart');
          }}
        >
          <p>
            Save your work and finish any generation, recording, or uploads in all open tabs first. The local
            server will briefly disconnect. Projects and settings are kept. The studio will offer a reload
            after the server returns.
          </p>
        </ConfirmModal>
      )}
    </Panel>
  );
}
