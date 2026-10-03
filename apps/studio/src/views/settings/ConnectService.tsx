import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APP_USES,
  CONNECTABLE_PRESET_IDS,
  configFromPreset,
  connectedConfig,
  defaultCredentialRef,
  describeConnectError,
  detectKeyProvider,
  getPreset,
  groupModels,
  recommendModels,
  type AppUseId,
  type ConnectProbeResult,
  type DetectedLocalService,
  type ModelInfo,
  type ProviderConfig,
} from '@songdeck/ai';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { useRuntime } from '../../engine/runtime';
import { getRegistry, saveCredential, useAiRuntime } from '../../engine/ai';
import { Badge, Button, Modal, Select } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { probeKey, scanLocalServices, serverOnline, syncProvidersNow, type LocalScan } from './api';
import { LocationBadge, errorMessage } from './ui';

/**
 * "Connect a service" (spec §3, §4, §7): the easy way to add a provider.
 *
 *  1. Paste a key → the provider is recognised from the key format (or picked from a short list).
 *  2. The key is checked live and every model the account can use is listed, grouped by what it
 *     can do in Song Deck; the best model per use is pre-ticked.
 *  3. "Add" creates or updates the provider (enabled, chosen models, default model) and stores the
 *     key: in the local server's vault when it runs, otherwise encrypted in this browser.
 *
 * Local servers found on this machine are listed alongside, each with a one-click Add.
 * The full provider editor stays available as "Advanced".
 */

const USE_LABEL = Object.fromEntries(APP_USES.map((u) => [u.id, u.label])) as Record<AppUseId, string>;

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok'; result: ConnectProbeResult } | { kind: 'error'; message: string };

export function ConnectServiceModal({
  onClose,
  onAdvanced,
  initialPresetId,
  existing,
}: {
  onClose: () => void;
  /** Open the full provider editor for a preset (Advanced). */
  onAdvanced: (presetId: string) => void;
  initialPresetId?: string;
  /** Re-choose the models of an already connected provider (no key needed). */
  existing?: ProviderConfig;
}) {
  // The modal re-focuses itself whenever onClose changes identity: keep it stable.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  const offline = useSettings((s) => s.routing.offline);

  return (
    <Modal title={existing ? `Choose models — ${existing.name}` : 'Connect a service'} icon="plug" onClose={close} wide>
      <div className="col st-connect" data-testid="connect-service">
        {existing ? (
          <ManageModels config={existing} onDone={close} />
        ) : (
          <>
            <KeyConnect initialPresetId={initialPresetId} onDone={close} onAdvanced={onAdvanced} offline={offline} />
            <section className="st-connect-local">
              <h3>Found on this machine</h3>
              <LocalServicesList compact />
            </section>
            <div className="small dim">
              Need something else — a custom endpoint, a remote GPU box, Vertex AI?{' '}
              <button type="button" className="linklike" onClick={() => onAdvanced('')}>
                Add a provider manually (Advanced)
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Paste a key
// ---------------------------------------------------------------------------

function KeyConnect({ initialPresetId, onDone, onAdvanced, offline }: { initialPresetId?: string; onDone: () => void; onAdvanced: (presetId: string) => void; offline: boolean }) {
  const providers = useSettings((s) => s.providers);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const toast = useStudio((s) => s.toast);
  const server = useRuntime((s) => s.server.status);
  const useServerProxy = useSettings((s) => s.useServerProxy);
  const vaultBackend = useAiRuntime((s) => s.vaultBackend);
  const [raw, setRaw] = useState('');
  const [picked, setPicked] = useState<string>(initialPresetId ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const detection = useMemo(() => detectKeyProvider(raw), [raw]);
  const certain = detection.matches.length === 1 && detection.matches[0].confidence !== 'possible' ? detection.matches[0].presetId : undefined;
  const choices = detection.matches.length ? detection.matches.map((m) => m.presetId) : [...CONNECTABLE_PRESET_IDS];
  const presetId = certain ?? (choices.includes(picked) ? picked : '');
  const preset = getPreset(presetId);
  const existing = providers.find((p) => p.presetId === presetId);

  const check = useCallback(
    async (id: string, key: string) => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setPhase({ kind: 'checking' });
      try {
        const result = await probeKey(id, key, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setSelected(new Set(recommendModels(result.models).selected));
        setShowAll(false);
        setPhase({ kind: 'ok', result });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: 'error', message: describeConnectError(err, getPreset(id)?.name ?? id, { browserOnly: !serverOnline() }).message });
      }
    },
    [setPhase],
  );

  // Recognised keys are checked as soon as they are pasted.
  useEffect(() => {
    setPhase({ kind: 'idle' });
    abort.current?.abort();
    if (!certain || detection.problem || offline) return;
    const t = setTimeout(() => void check(certain, detection.key), 350);
    return () => clearTimeout(t);
  }, [certain, detection.key, detection.problem, offline, check]);

  useEffect(() => () => abort.current?.abort(), []);

  const add = async () => {
    if (phase.kind !== 'ok' || !preset) return;
    setAdding(true);
    try {
      const id = existing?.id ?? uniqueId(preset.id, new Set(providers.map((p) => p.id)));
      const config = connectedConfig(preset.id, { id, selected: [...selected], probe: phase.result, existing });
      upsertProvider(config);
      await syncProvidersNow();
      const where = await saveCredential(config.credentialRef ?? defaultCredentialRef(id), detection.key, `${preset.name} ${preset.credentialLabel ?? 'API key'}`);
      // Fill model pickers right away (the registry was rebuilt with the new config).
      void getRegistry()
        .discoverModels(id, { force: true })
        .catch(() => undefined);
      toast(
        where === 'session' ? 'warning' : 'success',
        `${existing ? 'Updated' : 'Connected'} ${preset.name} — ${selected.size} model${selected.size === 1 ? '' : 's'} ready.${where === 'session' ? ' This browser cannot store the key: it is forgotten on reload.' : ''}`,
      );
      onDone();
    } catch (err) {
      setPhase({ kind: 'error', message: `Could not save: ${errorMessage(err)}` });
    } finally {
      setAdding(false);
    }
  };

  const storage =
    server === 'online' && useServerProxy
      ? `The key goes to the local Song Deck server (${vaultBackend === 'keychain' ? 'OS keychain' : (vaultBackend ?? 'vault')}); this page never keeps it.`
      : 'The key is stored encrypted in this browser (it survives reloads; start the local server to keep keys in the OS keychain instead).';

  return (
    <section className="st-connect-key">
      <label className="st-connect-label" htmlFor="connect-key">
        Paste an API key
      </label>
      <div className="row">
        <input
          id="connect-key"
          className="input mono grow"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          placeholder="AIza…, sk-ant-…, sk-proj-…, gsk_…, sk_…"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-label="API key"
        />
        {!certain && (
          <Select
            value={presetId}
            onChange={setPicked}
            options={[{ value: '', label: detection.matches.length ? 'Which service is this?' : 'Choose the service…' }, ...choices.map((id) => ({ value: id, label: getPreset(id)?.name ?? id }))]}
            aria-label="Service"
          />
        )}
        {!certain && (
          <Button variant="primary" icon="check" onClick={() => void check(presetId, detection.key)} disabled={!presetId || !!detection.problem || phase.kind === 'checking' || offline}>
            Check key
          </Button>
        )}
      </div>
      <div className="small dim st-connect-hint" data-testid="connect-detected">
        {raw.trim() === '' ? (
          'Song Deck recognises the service from the key and lists the models you can use. Nothing is saved until you click Add.'
        ) : detection.problem ? (
          detection.problem
        ) : detection.unsupported ? (
          `This looks like a key for ${detection.unsupported}, which Song Deck cannot connect to with a key.`
        ) : certain ? (
          <>
            <Icon name="check" size={12} /> Looks like a <strong>{getPreset(certain)?.name}</strong> key.
          </>
        ) : detection.matches.length ? (
          'This key format is used by several services — pick the right one.'
        ) : (
          'Unknown key format — pick the service it belongs to.'
        )}
      </div>
      {offline && (
        <div className="callout warning">
          <Icon name="shield" size={14} /> Offline mode is on: nothing is sent to cloud services. Turn it off under Privacy to connect one.
        </div>
      )}

      {phase.kind === 'checking' && (
        <div className="callout" role="status">
          Checking the key with {preset?.name ?? 'the service'}…
        </div>
      )}
      {phase.kind === 'error' && (
        <div className="callout danger" role="alert" data-testid="connect-error">
          {phase.message}
          {preset && (
            <div className="small" style={{ marginTop: 4 }}>
              <button type="button" className="linklike" onClick={() => onAdvanced(preset.id)}>
                Set up {preset.name} manually instead
              </button>
            </div>
          )}
        </div>
      )}
      {phase.kind === 'ok' && preset && (
        <>
          <ModelChooser result={phase.result} selected={selected} onChange={setSelected} showAll={showAll} onShowAll={setShowAll} />
          <div className="small dim">
            <Icon name="lock" size={12} /> {storage}
          </div>
          <div className="row">
            {existing && <span className="small muted">Updates your existing {existing.name} provider.</span>}
            <span className="grow" />
            <Button variant="primary" icon="plus" onClick={() => void add()} disabled={!selected.size || adding} data-testid="connect-add">
              {adding ? 'Adding…' : `${existing ? 'Update' : 'Add'} ${preset.name}${selected.size ? ` (${selected.size} model${selected.size === 1 ? '' : 's'})` : ''}`}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Models grouped by what they do in Song Deck
// ---------------------------------------------------------------------------

function ModelChooser({
  result,
  selected,
  onChange,
  showAll,
  onShowAll,
}: {
  result: ConnectProbeResult;
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
}) {
  const grouped = useMemo(() => groupModels(result.models), [result.models]);
  const rec = useMemo(() => new Set(recommendModels(result.models).selected), [result.models]);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const usable = grouped.groups.reduce((n, g) => n + g.models.length, 0);
  const row = (m: ModelInfo, uses: AppUseId[]) => (
    <label key={m.id} className={`st-connect-model ${uses.length ? '' : 'unusable'}`} data-testid="connect-model">
      <input type="checkbox" checked={selected.has(m.id)} disabled={!uses.length} onChange={() => toggle(m.id)} aria-label={m.id} />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="row" style={{ gap: 6 }}>
          <strong className="ellipsis">{m.name ?? m.id}</strong>
          {m.name && m.name !== m.id && <span className="mono small dim ellipsis">{m.id}</span>}
          {rec.has(m.id) && <Badge tone="accent">Recommended</Badge>}
        </span>
        <span className="st-uses">
          {uses.length ? uses.map((u) => <span key={u} className="st-use">{USE_LABEL[u]}</span>) : <span className="small dim">Not used by Song Deck</span>}
        </span>
      </span>
    </label>
  );
  return (
    <div className="st-connect-models" data-testid="connect-models">
      <div className="row between">
        <span className="small">
          <Icon name="check" size={12} /> Key accepted — {usable} model{usable === 1 ? '' : 's'} you can use in Song Deck{result.listed ? '' : ' (known models; this service does not list them)'}.
          {result.account?.map((a) => (
            <span key={a.label} className="muted">
              {' '}
              {a.label}: {a.value}.
            </span>
          ))}
        </span>
        <span className="row" style={{ gap: 6 }}>
          <Button size="sm" variant="ghost" onClick={() => onChange(new Set(rec))}>
            Recommended
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange(new Set())}>
            None
          </Button>
        </span>
      </div>
      {result.note && <div className="small muted">{result.note}</div>}
      {grouped.groups.map((g) => (
        <section key={g.id} className="st-connect-group" data-testid={`connect-group-${g.id}`} aria-label={g.label}>
          <div className="row between">
            <h4>{g.label}</h4>
            <span className="small dim">{g.description}</span>
          </div>
          {g.models.map(({ model, uses }) => row(model, uses))}
        </section>
      ))}
      {!usable && <div className="callout warning">This account has no models Song Deck can use.</div>}
      {grouped.unusable.length > 0 && (
        <label className="row small muted" style={{ gap: 6 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => onShowAll(e.target.checked)} />
          Show all {result.models.length} models (including {grouped.unusable.length} Song Deck cannot use: embeddings, images, speech…)
        </label>
      )}
      {showAll && grouped.unusable.length > 0 && (
        <section className="st-connect-group" data-testid="connect-group-unusable">
          <h4>Other models</h4>
          {grouped.unusable.map((m) => row(m, []))}
        </section>
      )}
    </div>
  );
}

/** Re-choose the models of a connected provider, listing them with its stored key. */
function ManageModels({ config, onDone }: { config: ProviderConfig; onDone: () => void }) {
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const toast = useStudio((s) => s.toast);
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const inst = getRegistry().get(config.id);
        let result: ConnectProbeResult;
        if (inst?.llm) {
          result = { presetId: config.presetId ?? '', models: await inst.llm.listModels(), listed: true };
        } else if (inst?.audioGeneration) {
          // Music services without a model list: Song Deck's known models for the preset.
          const preset = getPreset(config.presetId);
          const ids = [...new Set([...(config.models ?? []).map((m) => m.id), ...(preset?.suggestedModels ?? []), ...(preset?.defaultModel ? [preset.defaultModel] : [])])];
          result = { presetId: config.presetId ?? '', models: ids.map((id) => ({ id, capabilities: [...(preset?.capabilities ?? [])] })), listed: false };
        } else throw new Error('This provider has no models to choose from');
        if (!alive) return;
        const current = config.enabledModels?.length ? config.enabledModels : config.models?.length ? config.models.map((m) => m.id) : recommendModels(result.models).selected;
        setSelected(new Set(current.filter((id) => result.models.some((m) => m.id === id))));
        setPhase({ kind: 'ok', result });
      } catch (err) {
        if (alive) setPhase({ kind: 'error', message: describeConnectError(err, config.name, { browserOnly: !serverOnline() }).message });
      }
    })();
    return () => {
      alive = false;
    };
  }, [config]);

  const save = async () => {
    if (phase.kind !== 'ok') return;
    upsertProvider(connectedConfig(config.presetId ?? '', { id: config.id, selected: [...selected], probe: phase.result, existing: config }));
    await syncProvidersNow();
    void getRegistry()
      .discoverModels(config.id, { force: true })
      .catch(() => undefined);
    toast('success', `${config.name}: ${selected.size} model${selected.size === 1 ? '' : 's'} in use`);
    onDone();
  };

  return (
    <section className="st-connect-key">
      {phase.kind === 'checking' && <div className="callout">Listing models…</div>}
      {phase.kind === 'error' && (
        <div className="callout danger" role="alert" data-testid="connect-error">
          {phase.message}
        </div>
      )}
      {phase.kind === 'ok' && (
        <>
          <ModelChooser result={phase.result} selected={selected} onChange={setSelected} showAll={showAll} onShowAll={setShowAll} />
          <div className="row">
            <span className="grow" />
            <Button variant="primary" icon="check" onClick={() => void save()} disabled={!selected.size}>
              Use {selected.size} model{selected.size === 1 ? '' : 's'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Found on this machine
// ---------------------------------------------------------------------------

/** The provider config a detected local service turns into (one click). */
export function configForLocalService(s: DetectedLocalService, taken: Set<string>): ProviderConfig {
  const preset = getPreset(s.presetId);
  const config = configFromPreset(s.presetId, { id: uniqueId(s.presetId, taken) });
  // Keep the preset's spelling (localhost) unless the service runs somewhere else.
  const presetPort = preset ? new URL(preset.baseUrl).port : '';
  if (new URL(s.baseUrl).port !== presetPort) config.baseUrl = s.baseUrl;
  const rec = recommendModels(s.models.map((m) => ({ ...m })));
  if (rec.defaultModel && preset?.category === 'llm') config.defaultModel = rec.defaultModel;
  return config;
}

function sameService(c: ProviderConfig, s: DetectedLocalService): boolean {
  if (c.presetId !== s.presetId) return false;
  try {
    return new URL(c.baseUrl).port === new URL(s.baseUrl).port;
  } catch {
    return false;
  }
}

export function LocalServicesList({ compact }: { compact?: boolean }) {
  const providers = useSettings((s) => s.providers);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const toast = useStudio((s) => s.toast);
  const server = useRuntime((s) => s.server.status);
  const [scan, setScan] = useState<LocalScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setScan(await scanLocalServices());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // With the server, scanning is cheap and complete: do it right away. From the browser every
  // closed port logs a console error, so wait for the user's click.
  useEffect(() => {
    if (server === 'online') void run();
  }, [server, run]);

  const found = (scan?.services ?? []).filter((s) => s.status === 'found');
  const origin = typeof window !== 'undefined' ? window.location.origin : 'this page';

  const add = async (s: DetectedLocalService) => {
    const config = configForLocalService(s, new Set(providers.map((p) => p.id)));
    upsertProvider(config);
    await syncProvidersNow();
    void getRegistry()
      .discoverModels(config.id, { force: true })
      .catch(() => undefined);
    toast('success', `Added ${s.name}${s.models.length ? ` — ${s.models.length} model${s.models.length === 1 ? '' : 's'}` : ''}`);
  };

  return (
    <div className="col st-local" data-testid="local-services">
      <div className="row between">
        <span className="small dim">
          {scan
            ? scan.via === 'server'
              ? `Checked Ollama, LM Studio, llama.cpp, vLLM and the Song Deck bridges through the local server.`
              : `Checked from this page — servers that do not allow ${origin} cannot be seen.`
            : server === 'online'
              ? 'Looking for local AI servers…'
              : 'Look for Ollama, LM Studio, llama.cpp, vLLM and Song Deck bridges running on this machine.'}
        </span>
        <Button size="sm" icon="rebuild" onClick={() => void run()} disabled={busy}>
          {busy ? 'Scanning…' : scan ? 'Scan again' : 'Scan this machine'}
        </Button>
      </div>
      {error && <div className="callout danger">{error}</div>}
      {found.map((s) => {
        const added = providers.find((c) => sameService(c, s));
        return (
          <div key={`${s.presetId}@${s.baseUrl}`} className="st-local-item" data-testid={`local-${s.presetId}`}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <strong className="ellipsis">{s.name}</strong>
                <LocationBadge location="local" />
                <span className="mono small dim">{s.baseUrl}</span>
              </div>
              <div className="small muted ellipsis">
                {s.models.length ? `${s.models.length} model${s.models.length === 1 ? '' : 's'}: ${s.models.slice(0, compact ? 4 : 8).map((m) => m.name ?? m.id).join(', ')}${s.models.length > (compact ? 4 : 8) ? '…' : ''}` : 'No models loaded yet'}
              </div>
            </div>
            {added ? (
              <Badge tone="success">Added</Badge>
            ) : (
              <Button size="sm" variant="primary" icon="plus" onClick={() => void add(s)} aria-label={`Add ${s.name}`}>
                Add
              </Button>
            )}
          </div>
        );
      })}
      {scan && !found.length && (
        <div className="small muted" data-testid="local-none">
          {scan.via === 'server' ? (
            'Nothing running right now. Start Ollama, LM Studio’s server, llama-server or a Song Deck bridge, then scan again.'
          ) : (
            <>
              Nothing found from this page. Browsers can only reach local servers that allow this page: start the Song Deck server to detect everything (
              <code>npx tsx apps/server/src/cli.ts</code>), or start Ollama with <code>OLLAMA_ORIGINS={origin}</code> and turn on “Enable CORS” in LM Studio’s server settings.
            </>
          )}
        </div>
      )}
    </div>
  );
}
