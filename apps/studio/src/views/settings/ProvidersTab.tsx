import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CONNECTABLE_PRESET_IDS,
  LLM_BASE_CAPABILITIES,
  PROVIDER_PRESETS,
  configFromPreset,
  defaultCredentialRef,
  getPreset,
  type Capability,
  type ProviderConfig,
  type ProviderPreset,
  type ProviderSummary,
} from '@songdeck/ai';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { useRuntime } from '../../engine/runtime';
import {
  browserKeyRefs,
  forgetBrowserKeys,
  getRegistry,
  initAi,
  moveBrowserKeysToVault,
  useAiRuntime,
} from '../../engine/ai';
import { Badge, Button, Modal, TextInput, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ADAPTER_LABELS, GALLERY_GROUPS } from './constants';
import { checkProvider, credentialLocations, syncProvidersNow, type CredentialWhere } from './api';
import { ProviderEditor } from './ProviderEditor';
import { ConnectServiceModal, LocalServicesList } from './ConnectService';
import { useSettingsNav } from './nav';
import { CapBadges, Empty, LocationBadge, Panel, StatusPill, TabHeader, errorMessage } from './ui';

/**
 * Providers (spec §3 cloud providers, §4 local AI, §5 capability registry, §7 BYOK, §8 managed).
 */

/** A preset-less OpenAI-compatible endpoint covering the spec §4 custom endpoint fields. */
const CUSTOM_OPENAI: ProviderPreset = {
  id: '__custom-openai',
  name: 'OpenAI-compatible endpoint',
  category: 'llm',
  adapter: 'openai-compatible',
  location: 'local',
  description:
    'Any server speaking the OpenAI Chat Completions API — vLLM, TGI, LocalAI, a remote GPU box, a gateway. Name, endpoint URL, authentication, model id, context length, capabilities, structured output, timeout, concurrency.',
  baseUrl: 'http://localhost:8000/v1',
  auth: { type: 'none' },
  requiresCredential: false,
  capabilities: [...LLM_BASE_CAPABILITIES, 'STRUCTURED_JSON'] as Capability[],
  structuredOutput: 'json_schema',
  timeoutMs: 300_000,
  concurrency: 1,
  qualityTier: 3,
  setupNotes: [],
};

function uniqueId(base: string, taken: Set<string>): string {
  const clean = base.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

export function newConfigFor(preset: ProviderPreset, taken: Set<string>): ProviderConfig {
  if (preset.id === CUSTOM_OPENAI.id) {
    const id = uniqueId('custom-endpoint', taken);
    return {
      id,
      name: 'Custom endpoint',
      adapter: 'openai-compatible',
      enabled: true,
      location: 'local',
      baseUrl: CUSTOM_OPENAI.baseUrl,
      auth: { type: 'none' },
      credentialRef: defaultCredentialRef(id),
      timeoutMs: 300_000,
      concurrency: 1,
      structuredOutput: 'json_schema',
      qualityTier: 3,
      extra: { maxTokensParam: 'max_tokens', schemaDialect: 'json-schema' },
    };
  }
  return configFromPreset(preset.id, { id: uniqueId(preset.id, taken) });
}

export default function ProvidersTab() {
  const providers = useSettings((s) => s.providers);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const offline = useSettings((s) => s.routing.offline);
  const useServerProxy = useSettings((s) => s.useServerProxy);
  const summaries = useAiRuntime((s) => s.providers);
  const vaultBackend = useAiRuntime((s) => s.vaultBackend);
  const server = useRuntime((s) => s.server.status);
  const focus = useSettingsNav((s) => s.focus);
  const clearFocus = useSettingsNav((s) => s.clearFocus);
  const toast = useStudio((s) => s.toast);
  const [editing, setEditing] = useState<{ config: ProviderConfig; isNew: boolean } | null>(null);
  const [gallery, setGallery] = useState(false);
  const [keys, setKeys] = useState<Record<string, CredentialWhere>>({});
  const [checking, setChecking] = useState(false);
  const [connect, setConnect] = useState<{ presetId?: string; existing?: ProviderConfig } | null>(null);
  const [browserKeys, setBrowserKeys] = useState<{ ref: string; label?: string }[]>([]);
  const [keysBusy, setKeysBusy] = useState(false);

  useEffect(() => {
    initAi();
  }, []);

  // Deep links: openSettings('providers', '<id>' | 'add' | 'add:<presetId>').
  useEffect(() => {
    if (!focus) return;
    if (focus === 'add') setGallery(true);
    else if (focus === 'connect') setConnect({});
    else if (focus.startsWith('connect:')) setConnect({ presetId: focus.slice(8) });
    else if (focus.startsWith('add:')) {
      const preset = getPreset(focus.slice(4));
      if (preset)
        setEditing({ config: newConfigFor(preset, new Set(providers.map((p) => p.id))), isNew: true });
    } else {
      const config = providers.find((p) => p.id === focus);
      if (config) setEditing({ config, isNew: false });
    }
    clearFocus();
  }, [focus, providers, clearFocus]);

  const refs = useMemo(
    () =>
      providers
        .filter((p) => p.auth.type !== 'none')
        .map((p) => p.credentialRef || defaultCredentialRef(p.id)),
    [providers],
  );
  useEffect(() => {
    if (editing) return;
    let alive = true;
    void credentialLocations(refs).then((r) => alive && setKeys(r));
    void browserKeyRefs().then((r) => alive && setBrowserKeys(r));
    return () => {
      alive = false;
    };
  }, [refs, server, useServerProxy, editing, connect]);

  const vaultActive = server === 'online' && useServerProxy;
  const refreshKeys = async () => {
    setKeys(await credentialLocations(refs));
    setBrowserKeys(await browserKeyRefs());
  };
  const moveKeys = async () => {
    setKeysBusy(true);
    try {
      const r = await moveBrowserKeysToVault();
      toast(
        r.failed.length ? 'warning' : 'success',
        `Moved ${r.moved} key${r.moved === 1 ? '' : 's'} into the server vault${r.failed.length ? ` (${r.failed.length} could not be moved)` : ''}`,
      );
    } catch (err) {
      toast('error', `Could not move the keys: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setKeysBusy(false);
      await refreshKeys();
    }
  };
  const forgetKeys = async () => {
    setKeysBusy(true);
    await forgetBrowserKeys();
    setKeysBusy(false);
    toast('success', 'Forgot every key stored in this browser');
    await refreshKeys();
  };
  const closeConnect = useCallback(() => setConnect(null), []);
  const openAdvanced = useCallback(
    (presetId: string) => {
      setConnect(null);
      const preset = getPreset(presetId);
      if (preset)
        setEditing({ config: newConfigFor(preset, new Set(providers.map((p) => p.id))), isNew: true });
      else setGallery(true);
    },
    [providers],
  );

  const builtIn = summaries.filter((s) => !s.config && s.location === 'internal');
  const plugin = summaries.filter((s) => !s.config && s.location !== 'internal');

  const checkAll = async () => {
    setChecking(true);
    const reg = getRegistry();
    let ok = 0;
    let failed = 0;
    await Promise.all(
      providers
        .filter((p) => p.enabled && !(offline && p.location === 'cloud') && reg.has(p.id))
        .map(async (p) => {
          try {
            const r = await checkProvider(p);
            if (r.tone === 'danger') failed++;
            else ok++;
          } catch {
            failed++;
          }
        }),
    );
    setChecking(false);
    toast(
      failed ? 'warning' : 'success',
      `Checked ${ok + failed} provider${ok + failed === 1 ? '' : 's'}: ${ok} reachable${failed ? `, ${failed} with problems` : ''}`,
    );
  };

  if (editing) {
    return (
      <ProviderEditor
        key={editing.config.id}
        initial={editing.config}
        isNew={editing.isNew}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <>
      <TabHeader
        icon="plug"
        title="AI services"
        lede={
          <>
            Connect a service to start songs from a prompt, ask for changes in words and make realistic audio.
            Use cloud keys, local model servers or custom endpoints; the on-device engine is always there.
          </>
        }
        actions={
          <>
            <Button icon="rebuild" onClick={() => void checkAll()} disabled={checking || !providers.length}>
              {checking ? 'Checking…' : 'Check all'}
            </Button>
            <Button
              icon="plus"
              onClick={() => setGallery(true)}
              title="Advanced: pick a preset and fill in every field yourself"
            >
              Add provider
            </Button>
            <Button variant="primary" icon="plug" onClick={() => setConnect({})}>
              Connect a service
            </Button>
          </>
        }
      />

      <div className="callout st-keys-callout">
        <Icon name="key" size={14} />
        {vaultActive ? (
          <span>
            Keys are stored by the local server ({vaultBackend ?? 'vault'}) and injected server-side through
            its proxy. They are never written to settings, projects or this browser.
          </span>
        ) : server === 'online' ? (
          <span>
            The server proxy is off (General): keys entered now are stored encrypted in this browser and
            requests go straight from the browser.
          </span>
        ) : (
          <span>Keys are saved encrypted in this browser and are ready to use after reload.</span>
        )}
      </div>
      {browserKeys.length > 0 && (
        <div className="callout row wrap" data-testid="browser-keys">
          <Icon name="key" size={14} />
          <span className="grow">
            {browserKeys.length} key{browserKeys.length === 1 ? ' is' : 's are'} stored in this browser
            {vaultActive ? ' — the local server is running: move them into its vault (OS keychain)?' : '.'}
          </span>
          {vaultActive && (
            <Button
              size="sm"
              variant="primary"
              icon="shield"
              onClick={() => void moveKeys()}
              disabled={keysBusy}
            >
              Move to server vault
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            onClick={() => void forgetKeys()}
            disabled={keysBusy}
            title="Delete every key stored in this browser"
          >
            Forget browser keys
          </Button>
        </div>
      )}

      {providers.length === 0 ? (
        <Panel title="Your providers" icon="plug">
          <Empty icon="sparkles">
            No providers yet — everything runs on the deterministic on-device engine.{' '}
            <strong>Connect a service</strong> to paste an API key (Gemini, Claude, OpenAI, ElevenLabs…) or
            add a local server found on this machine; <strong>Add provider</strong> covers everything else.
          </Empty>
        </Panel>
      ) : (
        <div className="st-provider-grid" data-testid="provider-list">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              config={p}
              summary={summaries.find((s) => s.id === p.id)}
              keyWhere={
                p.auth.type === 'none' ? undefined : keys[p.credentialRef || defaultCredentialRef(p.id)]
              }
              offline={offline}
              onEdit={() => setEditing({ config: p, isNew: false })}
              onModels={() => setConnect({ existing: p })}
              onToggle={async (enabled) => {
                upsertProvider({ ...p, enabled });
                await syncProvidersNow();
              }}
            />
          ))}
        </div>
      )}

      <Panel
        title="Found on this machine"
        icon="cpu"
        sub="Local AI servers that are running now — add one with a click."
        testId="local-services-panel"
      >
        <LocalServicesList />
      </Panel>

      <Panel
        title="On-device engines"
        icon="shield"
        sub="Deterministic, free, offline — registered as ordinary providers with capabilities, so routing treats them like any other (spec §2.2, §51)."
      >
        <div className="st-engine-list">
          {builtIn.map((s) => (
            <div key={s.id} className="st-engine">
              <div className="row between">
                <strong>{s.name}</strong>
                <StatusPill status={s.status} />
              </div>
              <CapBadges caps={s.capabilities} max={8} />
            </div>
          ))}
        </div>
      </Panel>

      {plugin.length > 0 && (
        <Panel
          title="Plugin providers"
          icon="layers"
          sub="Contributed by enabled plugins (Plugins & profiles)."
        >
          <div className="st-engine-list">
            {plugin.map((s) => (
              <div key={s.id} className="st-engine">
                <div className="row between">
                  <strong>{s.name}</strong>
                  <span className="row">
                    <LocationBadge location={s.location} />
                    <StatusPill status={s.status} />
                  </span>
                </div>
                <CapBadges caps={s.capabilities} max={8} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {connect && (
        <ConnectServiceModal
          onClose={closeConnect}
          onAdvanced={openAdvanced}
          initialPresetId={connect.presetId}
          existing={connect.existing}
        />
      )}

      {gallery && (
        <ProviderGallery
          onClose={() => setGallery(false)}
          onPick={(preset) => {
            setGallery(false);
            setEditing({ config: newConfigFor(preset, new Set(providers.map((p) => p.id))), isNew: true });
          }}
          configured={providers}
        />
      )}
    </>
  );
}

function ProviderCard({
  config,
  summary,
  keyWhere,
  offline,
  onEdit,
  onModels,
  onToggle,
}: {
  config: ProviderConfig;
  summary?: ProviderSummary;
  keyWhere?: CredentialWhere;
  offline: boolean;
  onEdit: () => void;
  onModels: () => void;
  onToggle: (enabled: boolean) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const routing = useSettings((s) => s.routing);
  const allowRequests = useSettings((s) => s.allowProviderRequests);
  const allowed = routing.trustedProviderIds?.includes(config.id) ?? false;
  const preset = getPreset(config.presetId);
  const needsKey = config.auth.type !== 'none' && keyWhere === 'none';
  const status = !config.enabled
    ? 'disabled'
    : needsKey && summary?.status === 'ready'
      ? 'unconfigured'
      : (summary?.status ?? 'unconfigured');
  const caps = summary?.capabilities?.length
    ? summary.capabilities
    : (config.capabilities ?? preset?.capabilities ?? []);
  const models = summary?.models ?? [];
  const blocked = offline && config.location === 'cloud';
  const canChooseModels =
    CONNECTABLE_PRESET_IDS.includes(config.presetId ?? '') || !!summary?.interfaces.includes('llm');
  const discover = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await checkProvider(config);
      if (r.tone === 'danger') setErr(r.text);
      else setNote(r.text);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      className={`st-provider ${!config.enabled ? 'off' : ''} ${blocked ? 'blocked' : ''}`}
      data-testid={`provider-${config.id}`}
      aria-label={config.name}
    >
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="st-provider-name ellipsis">{config.name}</div>
          <div className="small dim ellipsis">
            {preset?.name ?? 'Custom endpoint'} · {ADAPTER_LABELS[config.adapter]}
          </div>
        </div>
        <Toggle
          on={config.enabled}
          onChange={(v) => void onToggle(v)}
          title={config.enabled ? 'Disable' : 'Enable'}
        />
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <LocationBadge location={config.location} />
        <StatusPill
          status={status}
          title={needsKey ? 'No API key stored yet — open Configure to add one' : summary?.error}
          label={needsKey && config.enabled ? 'Needs key' : undefined}
        />
        {blocked && (
          <Badge tone="danger" title="Offline mode: cloud providers are unavailable">
            Unavailable offline
          </Badge>
        )}
        {models.length > 0 && (
          <Badge>
            {models.length} model{models.length === 1 ? '' : 's'}
          </Badge>
        )}
        {config.defaultModel && <Badge title="Default model">{config.defaultModel}</Badge>}
      </div>
      <CapBadges caps={caps} max={5} />
      {summary?.error && config.enabled && <div className="small st-provider-error">{summary.error}</div>}
      {err && <div className="small st-provider-error">{err}</div>}
      {note && !err && <div className="small muted">{note}</div>}
      {config.location === 'cloud' && !allowed && (
        <Button
          size="sm"
          onClick={() => allowRequests(config.id)}
          disabled={!config.enabled || blocked || (config.auth.type !== 'none' && !keyWhere) || needsKey}
          title="Allow requests to this service without routine permission prompts"
        >
          Allow requests
        </Button>
      )}
      <div className="st-provider-foot">
        <span
          className="small muted"
          title={keyWhere === 'browser' ? 'Stored encrypted in this browser (IndexedDB, AES-GCM)' : undefined}
        >
          <Icon name="key" size={12} />{' '}
          {config.auth.type === 'none'
            ? 'No key needed'
            : keyWhere === 'vault'
              ? 'Key in vault'
              : keyWhere === 'browser'
                ? 'Key in browser'
                : keyWhere === 'session'
                  ? 'Key in session only'
                  : keyWhere === 'none'
                    ? 'No key stored'
                    : '…'}
        </span>
        <span className="grow" />
        <Button
          size="sm"
          variant="ghost"
          icon="rebuild"
          onClick={() => void discover()}
          disabled={busy || !config.enabled || blocked}
          title="Test the connection and discover models"
          aria-label={`Test ${config.name}`}
        >
          {busy ? '…' : ''}
        </Button>
        {canChooseModels && (
          <Button
            size="sm"
            variant="ghost"
            icon="layers"
            onClick={onModels}
            disabled={!config.enabled || blocked}
            title="Choose which models Song Deck uses"
          >
            Models
          </Button>
        )}
        <Button size="sm" icon="pencil" onClick={onEdit}>
          Configure
        </Button>
      </div>
    </article>
  );
}

function ProviderGallery({
  onClose,
  onPick,
  configured,
}: {
  onClose: () => void;
  onPick: (p: ProviderPreset) => void;
  configured: ProviderConfig[];
}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const match = (p: ProviderPreset) =>
    !query || `${p.name} ${p.description} ${p.capabilities.join(' ')}`.toLowerCase().includes(query);
  const used = new Set(configured.map((c) => c.presetId).filter(Boolean));
  return (
    <Modal title="Add a provider" icon="plug" onClose={onClose} wide>
      <div className="col st-gallery" data-testid="provider-gallery">
        <TextInput
          value={q}
          onChange={setQ}
          placeholder="Search providers and capabilities…"
          aria-label="Search providers"
          autoFocus
        />
        {GALLERY_GROUPS.map((g) => {
          const items = [
            ...(g.id === 'custom' ? [CUSTOM_OPENAI] : []),
            ...PROVIDER_PRESETS.filter(g.match),
          ].filter(match);
          if (!items.length) return null;
          return (
            <section key={g.id} className="st-gallery-group">
              <div className="row between">
                <h3 style={{ margin: 0 }}>{g.label}</h3>
                <span className="small dim">{g.description}</span>
              </div>
              <div className="st-gallery-grid">
                {items.map((p) => (
                  <article key={p.id} className="st-preset" aria-label={p.name}>
                    <div className="row between" style={{ alignItems: 'flex-start' }}>
                      <strong>{p.name}</strong>
                      <span className="row" style={{ gap: 4 }}>
                        {used.has(p.id) && <Badge tone="accent">added</Badge>}
                        <LocationBadge location={p.location} />
                      </span>
                    </div>
                    <div className="small muted st-preset-desc">{p.description}</div>
                    <CapBadges caps={p.capabilities} max={4} />
                    {p.setupNotes.length > 0 && (
                      <details className="st-preset-notes">
                        <summary>Setup</summary>
                        <ul>
                          {p.setupNotes.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <div className="row" style={{ marginTop: 'auto' }}>
                      <span className="small dim">
                        {p.requiresCredential
                          ? `Needs ${p.credentialLabel ?? 'an API key'}`
                          : p.location === 'local'
                            ? 'No key needed'
                            : 'No key'}
                      </span>
                      <span className="grow" />
                      {p.docsUrl && (
                        <a
                          href={p.docsUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="small nowrap"
                        >
                          Docs ↗
                        </a>
                      )}
                      <Button
                        size="sm"
                        variant="primary"
                        icon="plus"
                        onClick={() => onPick(p)}
                        aria-label={`Add ${p.name}`}
                      >
                        Add
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
