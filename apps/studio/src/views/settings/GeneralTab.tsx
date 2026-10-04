import { useEffect, useState } from 'react';
import { ENGINE_VERSION } from '@songdeck/core';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { checkServer, useRuntime } from '../../engine/runtime';
import { browserCredentials, deleteCredential, useAiRuntime } from '../../engine/ai';
import { disconnectCollab } from '../../engine/collab';
import { Badge, Button, CommitText, Field, Select, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import studioPkg from '../../../package.json';
import UpdatesPanel from './UpdatesPanel';
import { describeVaultBackend, vaultInfo, type VaultInfo } from './api';
import { ConfirmModal, Panel, Segmented, TabHeader, bytesLabel, timeAgo } from './ui';

/** General: appearance, identity, local server & vault, export defaults, storage, about, reset. */

interface StorageInfo {
  usage?: number;
  quota?: number;
  persisted?: boolean;
  supported: boolean;
}

async function readStorage(): Promise<StorageInfo> {
  const sm = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!sm?.estimate) return { supported: false };
  const [est, persisted] = await Promise.all([
    sm.estimate(),
    sm.persisted ? sm.persisted() : Promise.resolve(undefined),
  ]);
  return { usage: est.usage, quota: est.quota, persisted, supported: true };
}

/** Wipe everything this studio stored on the device (IndexedDB stores, localStorage/sessionStorage keys, browser-held keys). */
async function clearLocalData(alsoVault: boolean): Promise<void> {
  disconnectCollab('clearing local data');
  // Close the project first so no pending autosave writes it back.
  if (useStudio.getState().project) useStudio.getState().closeProject();
  if (alsoVault) {
    for (const p of useSettings.getState().providers)
      if (p.credentialRef) await deleteCredential(p.credentialRef).catch(() => undefined);
  }
  await browserCredentials.clear();
  await new Promise<void>((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve();
    const req = indexedDB.open('songdeck');
    req.onerror = () => resolve();
    req.onsuccess = () => {
      const db = req.result;
      const stores = Array.from(db.objectStoreNames);
      if (!stores.length) {
        db.close();
        return resolve();
      }
      const tx = db.transaction(stores, 'readwrite');
      for (const s of stores) tx.objectStore(s).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    };
  });
  for (const store of [localStorage, sessionStorage]) {
    try {
      for (const k of Object.keys(store)) if (k.startsWith('songdeck:')) store.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  }
}

export default function GeneralTab() {
  const s = useSettings();
  const server = useRuntime((st) => st.server);
  const vaultBackend = useAiRuntime((st) => st.vaultBackend);
  const projects = useStudio((st) => st.projects);
  const toast = useStudio((st) => st.toast);
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [alsoVault, setAlsoVault] = useState(false);

  useEffect(() => {
    if (server.status === 'online') void vaultInfo().then(setVault);
    else setVault(null);
  }, [server.status, server.checkedAt]);
  useEffect(() => {
    void readStorage().then(setStorage);
  }, []);

  const check = async () => {
    setChecking(true);
    await checkServer();
    setChecking(false);
  };

  return (
    <>
      <TabHeader
        icon="settings"
        title="General"
        lede="Appearance, your name, the local Song Deck server and its keychain vault, export defaults, storage on this device."
      />

      <UpdatesPanel />

      <div className="st-two">
        <Panel title="Appearance & identity" icon="eye">
          <Field label="Theme">
            <Segmented
              label="Theme"
              value={s.theme}
              onChange={(theme) => s.update({ theme })}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
            />
          </Field>
          <Field label="Your name" hint="Author of your revisions and your name in collaboration rooms.">
            <CommitText
              value={s.userName}
              onCommit={(v) => s.update({ userName: v.trim() || 'Me' })}
              aria-label="Your name"
            />
          </Field>
          <Toggle
            on={s.showTheoryHints}
            onChange={(showTheoryHints) => s.update({ showTheoryHints })}
            label="Show theory hints in the workbench"
          />
        </Panel>

        <Panel
          title="Local Song Deck server"
          icon="server"
          testId="server-panel"
          actions={
            <Button size="sm" icon="rebuild" onClick={() => void check()} disabled={checking}>
              {checking ? 'Checking…' : 'Check now'}
            </Button>
          }
        >
          <div className="st-server-status">
            <span
              className={`status-dot ${server.status === 'online' ? 'ok' : server.status === 'offline' ? 'warn' : ''}`}
            />
            <div className="grow">
              <strong data-testid="server-status">
                {server.status === 'online'
                  ? `Online — ${server.info?.name ?? 'songdeck-server'} ${server.info?.version ?? ''}`
                  : server.status === 'offline'
                    ? 'Not running — browser-only mode'
                    : 'Checking…'}
              </strong>
              <div className="small dim">
                {server.checkedAt ? `checked ${timeAgo(server.checkedAt)}` : ''}
                {server.status === 'online' && (vault?.backend ?? vaultBackend)
                  ? ` · vault: ${describeVaultBackend(vault?.backend ?? vaultBackend)}`
                  : ''}
              </div>
            </div>
          </div>
          {server.status === 'online' && server.info?.features?.length ? (
            <div className="row wrap" style={{ gap: 4 }}>
              {server.info.features.map((f) => (
                <Badge key={f}>{f}</Badge>
              ))}
            </div>
          ) : null}
          {vault?.detail && <div className="small dim">{vault.detail}</div>}
          <Field
            label="Server URL"
            hint="Empty = this page’s origin (the dev server proxies /api to port 7788, or the server serves the studio itself)."
          >
            <CommitText
              mono
              value={s.serverUrl}
              placeholder="(same origin)"
              onCommit={(v) => {
                s.update({ serverUrl: v.trim().replace(/\/+$/, '') });
                void check();
              }}
              aria-label="Server URL"
            />
          </Field>
          <Toggle
            on={s.useServerProxy}
            onChange={(useServerProxy) => s.update({ useServerProxy })}
            label="Use the server’s keychain vault & proxy for provider keys"
          />
          <div className="small dim">
            {s.useServerProxy
              ? 'Provider keys are stored by the server (OS keychain where available) and injected server-side; the browser never holds them.'
              : 'Keys stay in this tab’s memory and requests go directly from the browser to providers (they must allow CORS).'}
          </div>
          {server.status === 'offline' && (
            <div className="callout small">
              Start it with <code>npx tsx apps/server/src/cli.ts</code> (or <code>npm run start:server</code>)
              for the keychain vault, provider proxy, hardware detection, render nodes, plugins and
              collaboration.
            </div>
          )}
        </Panel>
      </div>

      <div className="st-two">
        <Panel title="Export defaults" icon="export">
          <div className="grid-3">
            <Field label="Sample rate">
              <Select
                value={String(s.exportPrefs.sampleRate)}
                onChange={(v) =>
                  s.update({ exportPrefs: { ...s.exportPrefs, sampleRate: Number(v) as 44100 | 48000 } })
                }
                options={[
                  { value: '44100', label: '44.1 kHz' },
                  { value: '48000', label: '48 kHz' },
                ]}
                aria-label="Default sample rate"
              />
            </Field>
            <Field label="WAV bit depth">
              <Select
                value={String(s.exportPrefs.bitDepth)}
                onChange={(v) =>
                  s.update({ exportPrefs: { ...s.exportPrefs, bitDepth: Number(v) as 16 | 24 } })
                }
                options={[
                  { value: '16', label: '16-bit' },
                  { value: '24', label: '24-bit' },
                ]}
                aria-label="Default bit depth"
              />
            </Field>
            <Field label="MP3 bitrate">
              <Select
                value={String(s.exportPrefs.mp3Kbps)}
                onChange={(v) =>
                  s.update({ exportPrefs: { ...s.exportPrefs, mp3Kbps: Number(v) as 128 | 192 | 256 | 320 } })
                }
                options={['128', '192', '256', '320'].map((k) => ({ value: k, label: `${k} kbps` }))}
                aria-label="Default MP3 bitrate"
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Storage on this device" icon="folder" testId="storage-panel">
          {storage?.supported ? (
            <>
              <div className="row between">
                <span>
                  <strong>{bytesLabel(storage.usage)}</strong> used of {bytesLabel(storage.quota)} available
                  to Song Deck
                </span>
                <Badge tone={storage.persisted ? 'success' : undefined}>
                  {storage.persisted ? 'Persistent' : 'Best-effort'}
                </Badge>
              </div>
              <div className="st-meter">
                <div
                  style={{
                    width: `${Math.min(100, ((storage.usage ?? 0) / Math.max(1, storage.quota ?? 1)) * 100)}%`,
                  }}
                />
              </div>
              <div className="small dim">
                {projects.length} project{projects.length === 1 ? '' : 's'} with full history and audio in
                IndexedDB. Settings (never keys) in localStorage.
              </div>
              {!storage.persisted && navigator.storage?.persist && (
                <Button
                  size="sm"
                  icon="lock"
                  onClick={async () => {
                    const ok = await navigator.storage.persist();
                    toast(
                      ok ? 'success' : 'warning',
                      ok
                        ? 'Storage is now persistent — the browser will not evict your projects.'
                        : 'The browser declined persistent storage.',
                    );
                    setStorage(await readStorage());
                  }}
                >
                  Make storage persistent
                </Button>
              )}
            </>
          ) : (
            <div className="small muted">This browser does not report storage usage.</div>
          )}
        </Panel>
      </div>

      <Panel title="About" icon="info">
        <dl className="kv">
          <dt>Song Deck Studio</dt>
          <dd className="mono">{studioPkg.version}</dd>
          <dt>Engine</dt>
          <dd className="mono">
            {ENGINE_VERSION} <span className="dim">(same blueprint + seed + engine version ⇒ same song)</span>
          </dd>
          <dt>Server</dt>
          <dd className="mono">{server.status === 'online' ? `${server.info?.version ?? '?'}` : '—'}</dd>
          <dt>Docs</dt>
          <dd>
            <span className="mono">Song Deck.md</span> (product specification) ·{' '}
            <span className="mono">docs/ARCHITECTURE.md</span> ·{' '}
            <span className="mono">apps/server/README.md</span>
          </dd>
          <dt>Promise</dt>
          <dd className="muted">
            Generate a song. Keep the song. Change the notes, the instruments, the singer, the production. Use
            whichever AI you want — or none.
          </dd>
        </dl>
      </Panel>

      <Panel title="Danger zone" icon="alert" className="st-danger">
        <div className="row between wrap">
          <div>
            <strong>Clear all local data</strong>
            <div className="small muted">
              Deletes every project, version history, audio asset, setting, spend ledger and queued task
              stored by Song Deck in this browser.
            </div>
          </div>
          <Button variant="danger" icon="trash" onClick={() => setConfirm(true)}>
            Clear all local data…
          </Button>
        </div>
      </Panel>

      {confirm && (
        <ConfirmModal
          title="Clear all local data?"
          confirmLabel="Delete everything and reload"
          danger
          requireText="DELETE"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await clearLocalData(alsoVault);
            window.location.reload();
          }}
        >
          <p>
            This permanently removes <strong>{projects.length}</strong> project
            {projects.length === 1 ? '' : 's'} and everything else Song Deck stored in this browser. Export
            any project you want to keep as a .songproject first. Shared projects on the server are not
            affected.
          </p>
          {server.status === 'online' && (
            <Toggle
              on={alsoVault}
              onChange={setAlsoVault}
              label="Also delete my provider keys from the server vault"
            />
          )}
          <div className="small dim">
            <Icon name="info" size={12} /> The page reloads afterwards.
          </div>
        </ConfirmModal>
      )}
    </>
  );
}
