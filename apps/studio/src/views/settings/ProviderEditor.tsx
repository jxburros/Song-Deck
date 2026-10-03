import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  CAPABILITY_INFO,
  defaultCredentialRef,
  getPreset,
  validateProviderConfig,
  type AdapterKind,
  type AuthType,
  type Capability,
  type CapabilityGroup,
  type CustomHttpTemplate,
  type ManualModel,
  type ModelInfo,
  type ModelPricing,
  type PricingInfo,
  type ProviderConfig,
  type ProviderExtra,
} from '@songdeck/ai';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { useRuntime } from '../../engine/runtime';
import { deleteCredential, getBudget, getRegistry, saveCredential, useAiRuntime } from '../../engine/ai';
import { Badge, Button, Field, Select, TextInput, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ADAPTER_LABELS, STRUCTURED_MODES } from './constants';
import { checkProvider, credentialLocations, describeVaultBackend, refreshVault, syncProvidersNow, type CredentialWhere } from './api';
import { CapBadges, ChipSet, ConfirmModal, LocationBadge, OptNumber, Panel, Segmented, StatusPill, errorMessage } from './ui';

/**
 * Provider configuration editor (spec §4.1 custom endpoint fields, §7 BYOK, §60 budgets/pricing).
 * Secrets are entered into a password field and go straight to `saveCredential` — the server
 * vault (OS keychain) or, without a server, this browser session. They never enter the config.
 */

const LLM_ADAPTERS = new Set<AdapterKind>(['openai-compatible', 'anthropic', 'gemini', 'ollama', 'custom-http', 'managed']);
/** Adapters a preset-less custom LLM endpoint may use. */
const CUSTOM_LLM_ADAPTERS: AdapterKind[] = ['openai-compatible', 'ollama', 'custom-http'];

const TEMPLATE_PLACEHOLDERS: { token: string; hint: string }[] = [
  { token: '{{system}}', hint: 'System prompt, JSON-escaped (put inside quotes)' },
  { token: '{{prompt}}', hint: 'Last user message, JSON-escaped (put inside quotes)' },
  { token: '{{model}}', hint: 'Model id, JSON-escaped (put inside quotes)' },
  { token: '{{messages_json}}', hint: 'Chat messages as a raw JSON array' },
  { token: '{{schema_json}}', hint: 'Expected output JSON schema (raw JSON)' },
  { token: '{{max_tokens}}', hint: 'Max output tokens (number)' },
  { token: '{{temperature}}', hint: 'Temperature (number)' },
  { token: '{{system_json}}', hint: 'System prompt as a quoted JSON string' },
  { token: '{{prompt_json}}', hint: 'User prompt as a quoted JSON string' },
];

const SAMPLE_VALUES: Record<string, string> = {
  system: 'You are a music theory assistant.',
  prompt: 'Suggest a chord progression in E minor.',
  messages_json: '[{"role":"user","content":"Suggest a chord progression in E minor."}]',
  schema_json: '{"type":"object","properties":{"chords":{"type":"array","items":{"type":"string"}}}}',
  max_tokens: '512',
  temperature: '0.7',
  system_json: '"You are a music theory assistant."',
  prompt_json: '"Suggest a chord progression in E minor."',
};

const DEFAULT_TEMPLATE: CustomHttpTemplate = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"model":"{{model}}","messages":{{messages_json}},"max_tokens":{{max_tokens}}}',
  responseTextPath: 'choices[0].message.content',
  inputTokensPath: 'usage.prompt_tokens',
  outputTokensPath: 'usage.completion_tokens',
};

function renderTemplate(body: string, model: string): { text: string; json: boolean; error?: string } {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const text = body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k: string) => {
    if (k === 'model') return esc(model || 'model-id');
    if (k === 'system' || k === 'prompt') return esc(SAMPLE_VALUES[k]);
    return SAMPLE_VALUES[k] ?? `{{${k}}}`;
  });
  try {
    JSON.parse(text);
    return { text, json: true };
  } catch (err) {
    return { text, json: false, error: errorMessage(err) };
  }
}

/** Drop empty optional fields so validation and the server see a clean config. */
export function cleanConfig(c: ProviderConfig): ProviderConfig {
  const out: ProviderConfig = { ...c, name: c.name.trim(), baseUrl: c.baseUrl.trim() };
  for (const k of ['organization', 'project', 'region', 'defaultModel', 'credentialRef'] as const) {
    const v = out[k];
    if (typeof v === 'string' && !v.trim()) delete out[k];
    else if (typeof v === 'string') out[k] = v.trim();
  }
  if (out.models && !out.models.length) delete out.models;
  if (out.models) out.models = out.models.filter((m) => m.id.trim()).map((m) => ({ ...m, id: m.id.trim(), ...(m.capabilities?.length ? {} : { capabilities: undefined }) }));
  if (out.capabilities && !out.capabilities.length) delete out.capabilities;
  const auth = { ...out.auth };
  if (auth.type === 'none') {
    delete auth.name;
    delete auth.prefix;
  }
  if (auth.type === 'bearer' && !auth.name?.trim()) delete auth.name;
  if (!auth.prefix) delete auth.prefix;
  out.auth = auth;
  if (out.budget && Object.values(out.budget).every((v) => v === undefined)) delete out.budget;
  if (out.extra) {
    const extra: ProviderExtra = {};
    for (const [k, v] of Object.entries(out.extra)) if (v !== undefined && v !== '') extra[k] = v;
    out.extra = Object.keys(extra).length ? extra : undefined;
    if (!out.extra) delete out.extra;
  }
  return out;
}

function usePrevious<T>(v: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = v;
  });
  return ref.current;
}

export function ProviderEditor({ initial, isNew, onClose }: { initial: ProviderConfig; isNew: boolean; onClose: () => void }) {
  const providers = useSettings((s) => s.providers);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const removeProvider = useSettings((s) => s.removeProvider);
  const useServerProxy = useSettings((s) => s.useServerProxy);
  const offline = useSettings((s) => s.routing.offline);
  const server = useRuntime((s) => s.server.status);
  const vaultBackend = useAiRuntime((s) => s.vaultBackend);
  const summaries = useAiRuntime((s) => s.providers);
  const version = useAiRuntime((s) => s.version);
  const toast = useStudio((s) => s.toast);

  const [draft, setDraft] = useState<ProviderConfig>(() => structuredClone(initial));
  const [savedId, setSavedId] = useState<string | null>(isNew ? null : initial.id);
  const [keyInput, setKeyInput] = useState('');
  const [keyWhere, setKeyWhere] = useState<CredentialWhere | 'unknown'>('unknown');
  const [keyNote, setKeyNote] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showPricing, setShowPricing] = useState(!!initial.pricing);

  const preset = getPreset(draft.presetId);
  const isLlm = LLM_ADAPTERS.has(draft.adapter);
  const cleaned = useMemo(() => cleanConfig(draft), [draft]);
  const problems = useMemo(() => {
    const p = validateProviderConfig(cleaned);
    if (!savedId && providers.some((x) => x.id === cleaned.id)) p.unshift(`id “${cleaned.id}” is already used by another provider`);
    const t = cleaned.extra?.customTemplate;
    if (cleaned.adapter === 'custom-http' && (!t?.body?.trim() || !t.responseTextPath?.trim())) p.push('the request template needs a body and a response text path');
    return p;
  }, [cleaned, providers, savedId]);
  const saved = savedId ? providers.find((p) => p.id === savedId) : undefined;
  const dirty = !saved || JSON.stringify(cleanConfig(saved)) !== JSON.stringify(cleaned);
  const summary = savedId ? summaries.find((s) => s.id === savedId) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const models: ModelInfo[] = useMemo(() => (savedId ? getRegistry().models(savedId) : []), [savedId, version]);
  const credentialRef = draft.credentialRef || defaultCredentialRef(draft.id);
  const needsKey = draft.auth.type !== 'none';
  const cloudBlocked = offline && draft.location === 'cloud';

  const set = (patch: Partial<ProviderConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const setExtra = (patch: Partial<ProviderExtra>) => setDraft((d) => ({ ...d, extra: { ...(d.extra ?? {}), ...patch } }));

  // Keep the default credential reference in step with the id while the provider is new.
  const prevId = usePrevious(draft.id);
  useEffect(() => {
    if (savedId || prevId === undefined || prevId === draft.id) return;
    setDraft((d) => (d.credentialRef === defaultCredentialRef(prevId) ? { ...d, credentialRef: defaultCredentialRef(d.id) } : d));
  }, [draft.id, prevId, savedId]);

  const refreshKey = async () => {
    if (!needsKey) return setKeyWhere('none');
    const loc = await credentialLocations([credentialRef]);
    setKeyWhere(loc[credentialRef] ?? 'none');
  };
  useEffect(() => {
    void refreshKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialRef, needsKey, server, useServerProxy]);

  /** Persist the draft (and wait for the server to know it, so proxied calls are allowed). */
  const save = async (quiet = false, config: ProviderConfig = cleaned): Promise<boolean> => {
    if (problems.length) {
      setResult({ tone: 'danger', text: `Fix ${problems.length} problem${problems.length > 1 ? 's' : ''} first.` });
      return false;
    }
    const hadModels = models.length > 0;
    upsertProvider(config);
    setSavedId(config.id);
    await syncProvidersNow();
    // Re-creating the provider drops its model cache: refresh it quietly when it had models.
    if (hadModels && config.enabled && !(offline && config.location === 'cloud')) void getRegistry().discoverModels(config.id).catch(() => undefined);
    if (!quiet) toast('success', `Saved ${config.name}`);
    return true;
  };

  const storeKey = async () => {
    const secret = keyInput.trim();
    if (!secret) return;
    setBusy('key');
    try {
      // The config must exist (and be synced) so the server scopes the key to this provider.
      const withRef = cleanConfig({ ...draft, credentialRef });
      if (!draft.credentialRef) set({ credentialRef });
      const ok = await save(true, withRef);
      if (!ok) return;
      const where = await saveCredential(credentialRef, secret, `${draft.name} ${preset?.credentialLabel ?? 'API key'}`);
      setKeyInput('');
      if (where === 'vault') {
        const backend = (await refreshVault()) ?? vaultBackend;
        setKeyNote({
          tone: 'success',
          text: `Stored ${backend === 'keychain' ? 'in the OS keychain' : `in the server’s ${describeVaultBackend(backend)}${backend === 'encrypted-file' ? ' (no OS keychain on this machine)' : ''}`} via the local Song Deck server (backend: ${backend ?? 'vault'}). The browser never sees it again.`,
        });
      } else {
        setKeyNote({
          tone: 'warning',
          text: 'Kept in this browser session only — not saved. It is forgotten when you reload. Start the local server (and enable “use the server’s keychain vault & proxy”) to store keys in the OS keychain.',
        });
      }
      await refreshKey();
    } catch (err) {
      setKeyNote({ tone: 'danger', text: `Could not store the key: ${errorMessage(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const removeKey = async () => {
    setBusy('key');
    try {
      await deleteCredential(credentialRef);
      setKeyNote({ tone: 'success', text: 'Key deleted.' });
      await refreshKey();
    } catch (err) {
      setKeyNote({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const discover = async (mode: 'discover' | 'test') => {
    if (dirty && !(await save(true))) return;
    if (!cleaned.enabled) {
      setResult({ tone: 'warning', text: 'Enable the provider to discover models or test it.' });
      return;
    }
    if (cloudBlocked) {
      setResult({ tone: 'warning', text: 'Offline mode is on: cloud providers are not contacted. Turn it off under Privacy to test this provider.' });
      return;
    }
    setBusy(mode);
    setResult(null);
    try {
      setResult(await checkProvider(cleaned, mode));
    } catch (err) {
      setResult({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const testPrompt = async () => {
    if (dirty && !(await save(true))) return;
    if (cloudBlocked) {
      setResult({ tone: 'warning', text: 'Offline mode is on: nothing is sent to cloud providers.' });
      return;
    }
    setBusy('prompt');
    setResult(null);
    const t0 = performance.now();
    try {
      const inst = getRegistry().get(cleaned.id);
      if (!inst?.llm) throw new Error('This provider has no language-model interface');
      const res = await inst.llm.complete({ model: cleaned.defaultModel, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 16 });
      const ms = Math.round(performance.now() - t0);
      // Even a test prompt is spend (spec §60).
      if (res.costUsd) getBudget().record({ providerId: cleaned.id, providerName: cleaned.name, modelId: res.model, role: 'chat', costUsd: res.costUsd, note: 'test prompt' });
      setResult({
        tone: 'success',
        text: `${res.model} answered “${res.text.trim().slice(0, 80)}” in ${ms} ms${res.usage ? ` · ${res.usage.inputTokens}+${res.usage.outputTokens} tokens` : ''}${res.costUsd !== undefined ? ` · $${res.costUsd.toFixed(5)}` : ''}.`,
      });
    } catch (err) {
      setResult({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (savedId) {
      removeProvider(savedId);
      await syncProvidersNow();
    }
    // Keep a key that another provider still references.
    const shared = providers.some((p) => p.id !== savedId && (p.credentialRef || defaultCredentialRef(p.id)) === credentialRef);
    if (needsKey && !shared) await deleteCredential(credentialRef).catch(() => undefined);
    toast('success', `Removed ${draft.name}`);
    onClose();
  };

  const suggested = useMemo(() => {
    const ids = new Set<string>([...models.map((m) => m.id), ...(preset?.suggestedModels ?? []), ...(draft.models ?? []).map((m) => m.id)]);
    return [...ids].filter(Boolean);
  }, [models, preset, draft.models]);

  const status = !saved ? undefined : !saved.enabled ? 'disabled' : (summary?.status ?? 'unconfigured');

  return (
    <div className="st-editor" data-testid="provider-editor">
      <div className="st-editor-bar">
        <Button variant="ghost" icon="chevronRight" onClick={onClose} className="st-back" aria-label="Back to providers">
          Providers
        </Button>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 10 }}>
            <h2 className="ellipsis" style={{ margin: 0 }}>
              {draft.name || 'New provider'}
            </h2>
            <LocationBadge location={draft.location} />
            {status && (
              <StatusPill
                status={needsKey && keyWhere === 'none' && status === 'ready' ? 'unconfigured' : status}
                label={needsKey && keyWhere === 'none' && status === 'ready' ? 'Needs key' : undefined}
                title={summary?.error}
              />
            )}
            {dirty && <Badge tone="accent">{savedId ? 'Unsaved changes' : 'Not saved yet'}</Badge>}
          </div>
          <div className="small dim">
            {preset ? `${preset.name} preset` : 'Custom endpoint'} · {ADAPTER_LABELS[draft.adapter]} adapter · id <span className="mono">{draft.id}</span>
          </div>
        </div>
        <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
          <Button icon="rebuild" onClick={() => void discover('discover')} disabled={!!busy}>
            {busy === 'discover' ? 'Discovering…' : 'Discover models'}
          </Button>
          <Button icon="check" onClick={() => void discover('test')} disabled={!!busy}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </Button>
          <Button variant="primary" icon="check" onClick={() => void save()} disabled={!!busy || !dirty || problems.length > 0}>
            Save
          </Button>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="callout danger st-problems" role="alert">
          <strong>Configuration problems</strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {result && (
        <div className={`callout ${result.tone}`} role="status" data-testid="provider-result">
          {result.text}
        </div>
      )}
      {cloudBlocked && (
        <div className="callout warning">
          <Icon name="shield" size={14} /> Offline mode is on — this cloud provider is unavailable until you turn it off under Privacy.
        </div>
      )}
      {preset && (preset.setupNotes.length > 0 || preset.docsUrl) && (
        <div className="callout st-notes">
          <div className="row between">
            <strong>Setup</strong>
            {preset.docsUrl && (
              <a href={preset.docsUrl} target="_blank" rel="noreferrer noopener">
                API documentation ↗
              </a>
            )}
          </div>
          <ul>
            {preset.setupNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="st-editor-grid">
        <Panel title="Connection" icon="server" sub="Spec §4.1: name, endpoint URL, where it runs.">
          <div className="grid-2">
            <Field label="Name">
              <TextInput value={draft.name} onChange={(name) => set({ name })} aria-label="Provider name" />
            </Field>
            <Field label="Id" hint={savedId ? 'Fixed after the first save (profiles and rules refer to it).' : 'Letters, digits and . _ : -'}>
              <TextInput mono value={draft.id} onChange={(id) => set({ id: id.replace(/[^A-Za-z0-9._:-]/g, '-') })} disabled={!!savedId} aria-label="Provider id" />
            </Field>
          </div>
          <Field
            label={draft.adapter === 'managed' ? 'Gateway URL' : 'Endpoint URL'}
            hint={
              draft.adapter === 'managed'
                ? 'Empty = this Song Deck server (same origin).'
                : draft.adapter === 'google-lyria'
                  ? '{location} is replaced by the Vertex location below.'
                  : draft.adapter === 'openai-compatible'
                    ? 'Base URL including the version path, e.g. http://localhost:8000/v1 — /models and /chat/completions are appended.'
                    : undefined
            }
          >
            <TextInput mono value={draft.baseUrl} onChange={(baseUrl) => set({ baseUrl })} placeholder="http://localhost:8000/v1" aria-label="Endpoint URL" />
          </Field>
          <div className="grid-2">
            <Field label="Location" hint="Cloud = data leaves this device (privacy indicator, offline mode).">
              <Segmented
                label="Location"
                value={draft.location}
                onChange={(location) => set({ location })}
                options={[
                  { value: 'local', label: 'Local / my network' },
                  { value: 'cloud', label: 'Cloud' },
                ]}
              />
            </Field>
            <Field label="Adapter">
              {!preset && CUSTOM_LLM_ADAPTERS.includes(draft.adapter) ? (
                <Select
                  value={draft.adapter}
                  onChange={(adapter) =>
                    setDraft((d) => ({
                      ...d,
                      adapter,
                      ...(adapter === 'custom-http' && !d.extra?.customTemplate ? { extra: { ...(d.extra ?? {}), customTemplate: structuredClone(DEFAULT_TEMPLATE) }, structuredOutput: 'prompt' as const } : {}),
                    }))
                  }
                  options={CUSTOM_LLM_ADAPTERS.map((a) => ({ value: a, label: ADAPTER_LABELS[a] }))}
                  aria-label="Adapter"
                />
              ) : (
                <div className="st-static">{ADAPTER_LABELS[draft.adapter]}</div>
              )}
            </Field>
          </div>
          <div className="grid-2">
            <Field label="Quality tier" hint="Used by automatic routing (1 draft … 5 best).">
              <Select
                value={String(draft.qualityTier ?? preset?.qualityTier ?? 3)}
                onChange={(v) => set({ qualityTier: Number(v) })}
                options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: `${v} — ${['draft', 'basic', 'good', 'great', 'best'][Number(v) - 1]}` }))}
                aria-label="Quality tier"
              />
            </Field>
            <Field label="Status">
              <Toggle on={draft.enabled} onChange={(enabled) => set({ enabled })} label={draft.enabled ? 'Enabled' : 'Disabled'} />
            </Field>
          </div>
        </Panel>

        <Panel title="Authentication" icon="key" sub="Spec §7: keys live in the OS keychain via the local server — never in settings or project files.">
          <div className="grid-2">
            <Field label="Authentication">
              <Select<AuthType>
                value={draft.auth.type}
                onChange={(type) => set({ auth: { ...draft.auth, type, ...(type === 'header' && !draft.auth.name ? { name: 'x-api-key' } : {}), ...(type === 'query' && !draft.auth.name ? { name: 'key' } : {}) } })}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'bearer', label: 'Bearer token' },
                  { value: 'header', label: 'Custom header' },
                  { value: 'query', label: 'Query parameter' },
                ]}
                aria-label="Authentication type"
              />
            </Field>
            {(draft.auth.type === 'header' || draft.auth.type === 'query') && (
              <Field label={draft.auth.type === 'header' ? 'Header name' : 'Parameter name'}>
                <TextInput mono value={draft.auth.name ?? ''} onChange={(name) => set({ auth: { ...draft.auth, name } })} />
              </Field>
            )}
            {draft.auth.type === 'bearer' && (
              <Field label="Prefix" hint="Default “Bearer ”.">
                <TextInput mono value={draft.auth.prefix ?? ''} placeholder="Bearer " onChange={(prefix) => set({ auth: { ...draft.auth, prefix } })} />
              </Field>
            )}
          </div>
          {needsKey ? (
            <>
              <div className="st-key-status">
                <Icon name="key" size={14} />
                {keyWhere === 'vault' ? (
                  <span>
                    Key stored in the server vault <span className="dim">({describeVaultBackend(vaultBackend)})</span>
                  </span>
                ) : keyWhere === 'session' ? (
                  <span>Key held for this browser session only</span>
                ) : keyWhere === 'none' ? (
                  <span className="muted">No key stored yet</span>
                ) : (
                  <span className="dim">Checking…</span>
                )}
                <span className="grow" />
                <span className="small dim mono" title="Vault reference (the config stores only this)">
                  {credentialRef}
                </span>
              </div>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void storeKey();
                }}
              >
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={keyWhere === 'vault' || keyWhere === 'session' ? 'Enter a new key to replace it' : `Paste your ${preset?.credentialLabel ?? 'API key'}`}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  aria-label={preset?.credentialLabel ?? 'API key'}
                />
                <Button type="submit" variant="primary" icon="lock" disabled={!keyInput.trim() || !!busy}>
                  {busy === 'key' ? 'Saving…' : 'Save key'}
                </Button>
                {(keyWhere === 'vault' || keyWhere === 'session') && (
                  <Button variant="ghost" icon="trash" onClick={() => void removeKey()} disabled={!!busy} title="Delete the stored key">
                    Delete
                  </Button>
                )}
              </form>
              {keyNote && (
                <div className={`callout ${keyNote.tone}`} data-testid="key-note">
                  {keyNote.text}
                </div>
              )}
              <div className="small dim">
                {server === 'online' && useServerProxy
                  ? 'Keys go to the local server and are injected server-side into requests for this provider only.'
                  : 'No local server: the key would stay in this tab’s memory and requests go directly from the browser.'}
              </div>
              <details className="st-adv">
                <summary>Vault reference</summary>
                <Field label="Credential reference" hint="Several providers may share one key by using the same reference.">
                  <TextInput mono value={draft.credentialRef ?? ''} placeholder={defaultCredentialRef(draft.id)} onChange={(v) => set({ credentialRef: v })} />
                </Field>
              </details>
            </>
          ) : (
            <div className="small muted">This endpoint is called without credentials. Switch to Bearer, a header or a query parameter if the server needs a key.</div>
          )}
        </Panel>

        {(draft.location === 'cloud' || draft.adapter === 'google-lyria' || draft.organization || draft.project || draft.region) && (
          <Panel title="Account & region" icon="users" sub="Spec §7: organization / project ids and region.">
            <div className="grid-3">
              <Field label="Organization">
                <TextInput value={draft.organization ?? ''} onChange={(organization) => set({ organization })} />
              </Field>
              <Field label="Project">
                <TextInput value={draft.project ?? ''} onChange={(project) => set({ project })} />
              </Field>
              <Field label="Region">
                <TextInput value={draft.region ?? ''} onChange={(region) => set({ region })} />
              </Field>
            </div>
          </Panel>
        )}

        <Panel
          title="Models"
          icon="layers"
          className="st-span-2"
          sub="Capabilities are discovered from the provider, never hard-coded (spec §3.1). Inferred capabilities can be corrected per model."
          actions={
            <Button size="sm" icon="rebuild" onClick={() => void discover('discover')} disabled={!!busy}>
              Discover
            </Button>
          }
        >
          <div className="grid-3">
            <Field label="Default model / model id">
              <TextInput mono value={draft.defaultModel ?? ''} onChange={(defaultModel) => set({ defaultModel })} list={`models-${draft.id}`} placeholder={preset?.suggestedModels?.[0] ?? 'model id'} aria-label="Default model" />
              <datalist id={`models-${draft.id}`}>
                {suggested.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Context length" hint="Tokens (num_ctx for Ollama).">
              <OptNumber value={draft.contextLength} onChange={(contextLength) => set({ contextLength })} min={256} step={1024} placeholder="auto" aria-label="Context length" />
            </Field>
            {isLlm && (
              <Field label="Max output tokens">
                <OptNumber value={draft.extra?.maxOutputTokens} onChange={(maxOutputTokens) => setExtra({ maxOutputTokens })} min={16} step={256} placeholder="default" />
              </Field>
            )}
          </div>
          <ModelTable models={models} defaultModel={draft.defaultModel} onUse={(id) => set({ defaultModel: id })} />
          <ManualModels value={draft.models ?? []} onChange={(m) => set({ models: m })} />
        </Panel>

        <Panel title="Capabilities" icon="sparkles" sub="What this provider advertises to the router (spec §5). Leave empty to use the preset and discovered capabilities.">
          <CapabilityPicker
            value={draft.capabilities ?? []}
            effective={summary?.capabilities ?? preset?.capabilities ?? []}
            onChange={(capabilities) => set({ capabilities })}
          />
        </Panel>

        <Panel title="Requests" icon="tasks" sub="Structured output support, timeout, concurrency and rate limits.">
          {isLlm && (
            <Field label="Structured output support" hint={STRUCTURED_MODES.find((m) => m.value === (draft.structuredOutput ?? preset?.structuredOutput ?? 'json_schema'))?.hint}>
              <Select
                value={draft.structuredOutput ?? preset?.structuredOutput ?? 'json_schema'}
                onChange={(structuredOutput) => set({ structuredOutput })}
                options={STRUCTURED_MODES.map((m) => ({ value: m.value, label: m.label }))}
                aria-label="Structured output support"
              />
            </Field>
          )}
          <div className="grid-3">
            <Field label="Timeout (s)">
              <OptNumber value={draft.timeoutMs} onChange={(v) => set({ timeoutMs: v ?? 120_000 })} min={1} max={3600} scale={1000} aria-label="Timeout seconds" />
            </Field>
            <Field label="Concurrency">
              <OptNumber value={draft.concurrency} onChange={(v) => set({ concurrency: Math.max(1, Math.round(v ?? 1)) })} min={1} max={64} aria-label="Concurrency" />
            </Field>
            <Field label="Requests / min">
              <OptNumber value={draft.requestsPerMinute} onChange={(requestsPerMinute) => set({ requestsPerMinute })} min={1} max={100000} placeholder="no limit" aria-label="Requests per minute" />
            </Field>
          </div>
        </Panel>

        <Panel title="Cost & budget" icon="info" sub="Per-provider limits on top of the global budget (spec §60). Pricing drives cost estimates; unknown pricing shows “unknown cost”.">
          <div className="grid-3">
            <Field label="Per generation ($)">
              <OptNumber value={draft.budget?.perGenerationUsd} onChange={(perGenerationUsd) => set({ budget: { ...draft.budget, perGenerationUsd } })} min={0} step={0.1} placeholder="—" />
            </Field>
            <Field label="Daily ($)">
              <OptNumber value={draft.budget?.dailyUsd} onChange={(dailyUsd) => set({ budget: { ...draft.budget, dailyUsd } })} min={0} step={1} placeholder="—" />
            </Field>
            <Field label="Monthly ($)">
              <OptNumber value={draft.budget?.monthlyUsd} onChange={(monthlyUsd) => set({ budget: { ...draft.budget, monthlyUsd } })} min={0} step={5} placeholder="—" />
            </Field>
          </div>
          <Toggle
            on={showPricing}
            onChange={(on) => {
              setShowPricing(on);
              if (on && !draft.pricing) set({ pricing: structuredClone(preset?.pricing ?? { currency: 'USD' }) });
              if (!on) set({ pricing: undefined });
            }}
            label={preset?.pricing ? 'Override the preset’s pricing' : 'Set pricing'}
          />
          {!showPricing && <PricingSummary pricing={preset?.pricing} />}
          {showPricing && draft.pricing && <PricingEditor value={draft.pricing} onChange={(pricing) => set({ pricing })} />}
        </Panel>

        <AdapterOptions draft={draft} setExtra={setExtra} />
      </div>

      <div className="st-editor-foot">
        {isLlm && savedId && (
          <Button variant="ai" icon="chat" onClick={() => void testPrompt()} disabled={!!busy} title={`Sends “Reply with the single word OK.” (about 10 tokens) to ${draft.name}${draft.location === 'cloud' ? ' — leaves this device' : ''}`}>
            {busy === 'prompt' ? 'Waiting for the model…' : 'Send a test prompt'}
          </Button>
        )}
        <div className="spacer" />
        {savedId && (
          <Button variant="danger" icon="trash" onClick={() => setConfirmRemove(true)}>
            Remove provider
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || problems.length > 0 || !!busy}>
          Save
        </Button>
      </div>

      {confirmRemove && (
        <ConfirmModal title={`Remove ${draft.name}?`} confirmLabel="Remove provider and key" danger onClose={() => setConfirmRemove(false)} onConfirm={remove}>
          The provider configuration is deleted{needsKey ? ', and its stored key is deleted from the vault' : ''}. Projects keep their provenance records — they never depend on a provider (spec §2.2).
        </ConfirmModal>
      )}
    </div>
  );
}

function ModelTable({ models, defaultModel, onUse }: { models: ModelInfo[]; defaultModel?: string; onUse: (id: string) => void }) {
  const [all, setAll] = useState(false);
  if (!models.length) return <div className="small muted st-models-empty">No models discovered yet. Save the provider and click Discover — or enter models manually below.</div>;
  const shown = all ? models : models.slice(0, 12);
  return (
    <div className="st-table-wrap">
      <table className="table st-models" data-testid="model-table">
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Context</th>
            <th>Tier</th>
            <th>Capabilities</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((m) => (
            <tr key={m.id}>
              <td>
                <div className="mono st-model-id">{m.id}</div>
                {m.name && m.name !== m.id && <div className="small dim">{m.name}</div>}
              </td>
              <td className="num">{m.contextLength ? m.contextLength.toLocaleString() : '—'}</td>
              <td>{m.qualityTier ?? '—'}</td>
              <td>
                <CapBadges caps={m.capabilities} max={5} inferred={m.capabilitiesInferred} />
                <div className="row" style={{ gap: 4, marginTop: 3 }}>
                  {m.capabilitiesInferred && (
                    <Badge tone="warning" title="Capabilities inferred from the model id — correct them with a manual entry or a capability override">
                      inferred
                    </Badge>
                  )}
                  {m.manual && <Badge>manual</Badge>}
                </div>
              </td>
              <td style={{ textAlign: 'right' }}>
                {defaultModel === m.id ? (
                  <Badge tone="accent">default</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onUse(m.id)}>
                    Use
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {models.length > 12 && (
        <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${models.length} models`}
        </Button>
      )}
    </div>
  );
}

const CAP_OPTIONS = CAPABILITIES.map((c) => ({ value: c, label: CAPABILITY_INFO[c].label, title: CAPABILITY_INFO[c].description }));

function ManualModels({ value, onChange }: { value: ManualModel[]; onChange: (v: ManualModel[]) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const setAt = (i: number, patch: Partial<ManualModel>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="st-manual">
      <div className="row between">
        <h4 style={{ margin: 0 }}>Manual model entries</h4>
        <Button
          size="sm"
          icon="plus"
          onClick={() => {
            onChange([...value, { id: '' }]);
            setOpen(value.length);
          }}
        >
          Add model
        </Button>
      </div>
      {value.length === 0 && <div className="small dim">For servers that cannot list models, or to correct a model’s capabilities.</div>}
      {value.map((m, i) => (
        <div key={i} className="st-manual-row">
          <div className="row">
            <TextInput size="sm" mono value={m.id} placeholder="model id" onChange={(id) => setAt(i, { id })} aria-label="Manual model id" />
            <TextInput size="sm" value={m.name ?? ''} placeholder="display name" onChange={(name) => setAt(i, { name: name || undefined })} />
            <OptNumber size="sm" value={m.contextLength} placeholder="context" min={256} onChange={(contextLength) => setAt(i, { contextLength })} />
            <OptNumber size="sm" value={m.qualityTier} placeholder="tier" min={1} max={5} onChange={(qualityTier) => setAt(i, { qualityTier })} />
            <Button size="sm" variant="ghost" onClick={() => setOpen(open === i ? null : i)}>
              {m.capabilities?.length ? `${m.capabilities.length} caps` : 'Capabilities'}
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove model" />
          </div>
          {open === i && <ChipSet label="Model capabilities" options={CAP_OPTIONS} value={m.capabilities ?? []} onChange={(capabilities) => setAt(i, { capabilities })} />}
        </div>
      ))}
    </div>
  );
}

function CapabilityPicker({ value, effective, onChange }: { value: Capability[]; effective: readonly Capability[]; onChange: (v: Capability[]) => void }) {
  const override = value.length > 0;
  const groups = Object.keys(CAPABILITY_GROUPS) as CapabilityGroup[];
  return (
    <div className="col">
      <div className="row between">
        <Toggle on={override} onChange={(on) => onChange(on ? [...effective] : [])} label="Override capabilities" />
        {!override && <span className="small dim">{effective.length} advertised</span>}
      </div>
      {override ? (
        groups.map((g) => {
          const caps = CAPABILITIES.filter((c) => CAPABILITY_INFO[c].group === g);
          return (
            <div key={g} className="st-capgroup">
              <div className="field-label">{CAPABILITY_GROUPS[g].label}</div>
              <ChipSet label={CAPABILITY_GROUPS[g].label} options={caps.map((c) => ({ value: c, label: CAPABILITY_INFO[c].label, title: CAPABILITY_INFO[c].description }))} value={value} onChange={(v) => onChange(v)} />
            </div>
          );
        })
      ) : (
        <CapBadges caps={effective} max={40} />
      )}
    </div>
  );
}

function PricingSummary({ pricing }: { pricing?: PricingInfo }) {
  if (!pricing) return <div className="small dim">No pricing published for this provider — costs show as “unknown cost” and budgets cannot be verified.</div>;
  const rows = Object.entries(pricing.models ?? {}).slice(0, 8);
  return (
    <div className="small muted">
      {pricing.perGenerationUsd !== undefined && <div>${pricing.perGenerationUsd} per generation</div>}
      {pricing.perClipUsd !== undefined && (
        <div>
          ${pricing.perClipUsd} per {pricing.clipSeconds ?? 30}-second clip
        </div>
      )}
      {rows.length > 0 && (
        <div className="st-price-list">
          {rows.map(([id, p]) => (
            <span key={id} className="mono">
              {id}: ${p.inputPerMTok ?? '—'} / ${p.outputPerMTok ?? '—'} per MTok
            </span>
          ))}
        </div>
      )}
      {pricing.note && <div className="dim">{pricing.note}</div>}
    </div>
  );
}

const PRICE_FIELDS: { key: keyof ModelPricing; label: string }[] = [
  { key: 'inputPerMTok', label: 'Input $/MTok' },
  { key: 'outputPerMTok', label: 'Output $/MTok' },
  { key: 'perGenerationUsd', label: '$ / generation' },
  { key: 'perSecondUsd', label: '$ / second' },
  { key: 'perMinuteUsd', label: '$ / minute' },
  { key: 'perClipUsd', label: '$ / clip' },
  { key: 'clipSeconds', label: 'Clip seconds' },
];

function PricingEditor({ value, onChange }: { value: PricingInfo; onChange: (v: PricingInfo) => void }) {
  const models = Object.entries(value.models ?? {});
  const setModel = (id: string, patch: Partial<ModelPricing> | null, newId?: string) => {
    const next: Record<string, ModelPricing> = {};
    for (const [k, p] of models) {
      if (k !== id) next[k] = p;
      else if (patch) next[newId ?? k] = { ...p, ...patch };
    }
    onChange({ ...value, models: next });
  };
  return (
    <div className="col">
      <div className="grid-4">
        {PRICE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <OptNumber size="sm" value={value[f.key]} min={0} step={0.01} onChange={(v) => onChange({ ...value, [f.key]: v })} />
          </Field>
        ))}
      </div>
      <div className="field-label">Per-model token prices</div>
      {models.map(([id, p]) => (
        <div key={id} className="row">
          <TextInput size="sm" mono value={id} onChange={(nid) => setModel(id, {}, nid)} aria-label="Priced model id" />
          <OptNumber size="sm" value={p.inputPerMTok} min={0} step={0.01} placeholder="in" onChange={(inputPerMTok) => setModel(id, { inputPerMTok })} />
          <OptNumber size="sm" value={p.outputPerMTok} min={0} step={0.01} placeholder="out" onChange={(outputPerMTok) => setModel(id, { outputPerMTok })} />
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setModel(id, null)} aria-label="Remove price" />
        </div>
      ))}
      <div className="row">
        <Button size="sm" icon="plus" onClick={() => onChange({ ...value, models: { ...(value.models ?? {}), [`model-${models.length + 1}`]: {} } })}>
          Add model price
        </Button>
        <TextInput size="sm" value={value.note ?? ''} placeholder="Note (source, date)" onChange={(note) => onChange({ ...value, note: note || undefined })} />
      </div>
    </div>
  );
}

function AdapterOptions({ draft, setExtra }: { draft: ProviderConfig; setExtra: (p: Partial<ProviderExtra>) => void }) {
  const x = draft.extra ?? {};
  switch (draft.adapter) {
    case 'anthropic':
      return (
        <Panel title="Anthropic options" icon="sliders" sub="Effort trades depth for speed and cost; refusal fallbacks retry declined requests on a fallback model server-side.">
          <div className="grid-2">
            <Field label="Effort">
              <Select
                value={x.effort ?? 'medium'}
                onChange={(effort) => setExtra({ effort })}
                options={(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((v) => ({ value: v, label: v }))}
                aria-label="Effort"
              />
            </Field>
            <Field label="Refusal fallback">
              <Toggle on={x.refusalFallback !== false} onChange={(refusalFallback) => setExtra({ refusalFallback })} label={x.refusalFallback !== false ? 'On' : 'Off'} />
            </Field>
          </div>
        </Panel>
      );
    case 'openai-compatible':
      return (
        <Panel title="OpenAI-compatible options" icon="sliders" sub="Which max-token field the server expects and which JSON-schema dialect it accepts.">
          <div className="grid-2">
            <Field label="Max-tokens parameter">
              <Select
                value={x.maxTokensParam ?? (draft.location === 'cloud' ? 'max_completion_tokens' : 'max_tokens')}
                onChange={(maxTokensParam) => setExtra({ maxTokensParam })}
                options={[
                  { value: 'max_tokens', label: 'max_tokens' },
                  { value: 'max_completion_tokens', label: 'max_completion_tokens' },
                ]}
              />
            </Field>
            <Field label="Schema dialect">
              <Select
                value={x.schemaDialect ?? (draft.location === 'cloud' ? 'openai-strict' : 'json-schema')}
                onChange={(schemaDialect) => setExtra({ schemaDialect })}
                options={[
                  { value: 'openai-strict', label: 'OpenAI strict' },
                  { value: 'json-schema', label: 'Plain JSON schema' },
                  { value: 'prompt-only', label: 'Prompt only' },
                ]}
              />
            </Field>
          </div>
        </Panel>
      );
    case 'google-lyria':
      return (
        <Panel title="Vertex AI (Lyria)" icon="cloud" sub="Lyria runs in your Google Cloud project; the access token is stored as the key.">
          <div className="grid-2">
            <Field label="GCP project id">
              <TextInput mono value={x.vertexProject ?? ''} onChange={(vertexProject) => setExtra({ vertexProject })} aria-label="GCP project id" />
            </Field>
            <Field label="Location">
              <TextInput mono value={x.vertexLocation ?? 'us-central1'} onChange={(vertexLocation) => setExtra({ vertexLocation })} />
            </Field>
          </div>
        </Panel>
      );
    case 'custom-http':
      return <TemplateEditor value={x.customTemplate} model={draft.defaultModel ?? ''} onChange={(customTemplate) => setExtra({ customTemplate })} />;
    case 'elevenlabs-music':
    case 'stability-audio':
      return (
        <Panel title="Audio output" icon="wave">
          <div className="grid-3">
            <Field label="Output format">
              <TextInput mono value={x.outputFormat ?? ''} placeholder={draft.adapter === 'elevenlabs-music' ? 'mp3_44100_128' : 'wav'} onChange={(outputFormat) => setExtra({ outputFormat })} />
            </Field>
            {draft.adapter === 'stability-audio' && (
              <>
                <Field label="Steps">
                  <OptNumber value={x.steps} min={1} max={200} onChange={(steps) => setExtra({ steps })} placeholder="default" />
                </Field>
                <Field label="CFG scale">
                  <OptNumber value={x.cfgScale} min={0} max={30} step={0.5} onChange={(cfgScale) => setExtra({ cfgScale })} placeholder="default" />
                </Field>
              </>
            )}
          </div>
        </Panel>
      );
    default:
      return null;
  }
}

function TemplateEditor({ value, model, onChange }: { value?: CustomHttpTemplate; model: string; onChange: (t: CustomHttpTemplate) => void }) {
  const t: CustomHttpTemplate = value ?? DEFAULT_TEMPLATE;
  const set = (patch: Partial<CustomHttpTemplate>) => onChange({ ...t, ...patch });
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const preview = useMemo(() => renderTemplate(t.body, model), [t.body, model]);
  const headers = Object.entries(t.headers ?? {});
  const insert = (token: string) => {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? t.body.length;
    const end = el?.selectionEnd ?? t.body.length;
    set({ body: t.body.slice(0, start) + token + t.body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const setHeader = (i: number, k: string, v: string) => {
    const next = headers.map(([hk, hv], j) => (j === i ? [k, v] : [hk, hv]) as [string, string]);
    set({ headers: Object.fromEntries(next.filter(([hk]) => hk.trim())) });
  };
  const secretHeader = headers.some(([k]) => /^(authorization|x-api-key|api-key|x-goog-api-key|xi-api-key)$/i.test(k));
  return (
    <Panel title="Request template" icon="pencil" className="st-span-2" sub="Custom HTTP endpoint (spec §4.1): describe the request and where the answer is. Authentication is added from the settings above — never put keys in headers here.">
      <div className="grid-3">
        <Field label="Method">
          <Select value={t.method ?? 'POST'} onChange={(method) => set({ method })} options={['POST', 'PUT', 'GET'] as const} />
        </Field>
        <Field label="URL" hint="Optional; defaults to the endpoint URL. May contain {{model}}.">
          <TextInput mono value={t.url ?? ''} onChange={(url) => set({ url: url || undefined })} placeholder="(endpoint URL)" />
        </Field>
        <Field label="Response text path" hint="Dots and [index], e.g. choices[0].message.content">
          <TextInput mono value={t.responseTextPath} onChange={(responseTextPath) => set({ responseTextPath })} aria-label="Response text path" />
        </Field>
      </div>
      <div className="field-label">Headers</div>
      {headers.map(([k, v], i) => (
        <div key={i} className="row">
          <TextInput size="sm" mono value={k} onChange={(nk) => setHeader(i, nk, v)} />
          <TextInput size="sm" mono value={v} onChange={(nv) => setHeader(i, k, nv)} />
          <Button size="sm" variant="ghost" icon="trash" onClick={() => set({ headers: Object.fromEntries(headers.filter((_, j) => j !== i)) })} aria-label="Remove header" />
        </div>
      ))}
      <Button size="sm" icon="plus" onClick={() => set({ headers: { ...(t.headers ?? {}), [`x-header-${headers.length + 1}`]: '' } })}>
        Add header
      </Button>
      {secretHeader && <div className="callout warning small">Credentials belong in Authentication above (stored in the vault), not in template headers.</div>}
      <div className="row between" style={{ marginTop: 6 }}>
        <span className="field-label">Body</span>
        <div className="row wrap" style={{ gap: 4 }}>
          {TEMPLATE_PLACEHOLDERS.map((p) => (
            <button key={p.token} type="button" className="chip st-token" title={p.hint} onClick={() => insert(p.token)}>
              {p.token}
            </button>
          ))}
        </div>
      </div>
      <textarea className="textarea mono" value={t.body} onChange={(e) => set({ body: e.target.value })} rows={6} ref={bodyRef} aria-label="Body template" spellCheck={false} />
      <div className={`st-preview ${preview.json ? 'ok' : 'bad'}`}>
        <div className="row between small">
          <span>Preview with sample values</span>
          <span>{preview.json ? '✓ valid JSON' : `✗ not valid JSON — ${preview.error}`}</span>
        </div>
        <pre>{preview.text}</pre>
      </div>
      <div className="grid-2">
        <Field label="Input tokens path">
          <TextInput mono value={t.inputTokensPath ?? ''} placeholder="usage.prompt_tokens" onChange={(v) => set({ inputTokensPath: v || undefined })} />
        </Field>
        <Field label="Output tokens path">
          <TextInput mono value={t.outputTokensPath ?? ''} placeholder="usage.completion_tokens" onChange={(v) => set({ outputTokensPath: v || undefined })} />
        </Field>
        <Field label="Models URL (GET)">
          <TextInput mono value={t.modelsUrl ?? ''} placeholder="optional" onChange={(v) => set({ modelsUrl: v || undefined })} />
        </Field>
        <Field label="Models path">
          <TextInput mono value={t.modelsPath ?? ''} placeholder="data" onChange={(v) => set({ modelsPath: v || undefined })} />
        </Field>
      </div>
    </Panel>
  );
}
