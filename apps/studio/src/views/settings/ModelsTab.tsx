import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOCAL_MODEL_CATALOG, getPreset, type LocalModelEntry } from '@songdeck/ai';
import { useSettings } from '../../state/settings';
import { useRuntime, checkServer } from '../../engine/runtime';
import { Badge, Button, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import {
  getHardware,
  getModels,
  rescanModels,
  type CompatibilityRating,
  type HardwareReport,
  type ModelEntry,
  type ModelsReport,
} from './api';
import { openSettings } from './nav';
import { CapBadges, Empty, Panel, Segmented, TabHeader, errorMessage, timeAgo } from './ui';

/** Local hardware awareness (spec §61) and the Model Manager (spec §62). */

const CATEGORIES = [
  { id: 'composition', label: 'Composition' },
  { id: 'audio', label: 'Audio' },
  { id: 'vocals', label: 'Vocals' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'separation', label: 'Separation' },
  { id: 'mastering', label: 'Mastering' },
] as const;

const RATING: Record<CompatibilityRating, { label: string; tone: 'success' | 'ai' | 'warning' | 'danger' }> =
  {
    excellent: { label: 'Excellent', tone: 'success' },
    compatible: { label: 'Compatible', tone: 'ai' },
    slow: { label: 'Slow', tone: 'warning' },
    insufficient: { label: 'Insufficient Hardware', tone: 'danger' },
  };

function requirementText(r: ModelEntry['requirements']): string {
  const parts: string[] = [];
  if (r.recommendedVramGb !== undefined && r.recommendedVramGb > 0) {
    parts.push(
      r.minVramGb && r.minVramGb !== r.recommendedVramGb
        ? `${r.minVramGb}–${r.recommendedVramGb} GB VRAM`
        : `${r.recommendedVramGb} GB VRAM`,
    );
  } else if (r.cpuOk) parts.push('CPU');
  if (r.minRamGb) parts.push(`${r.minRamGb} GB RAM`);
  if (r.cpuOk && (r.recommendedVramGb ?? 0) > 0) parts.push('CPU possible');
  if (r.minCpuCores) parts.push(`${r.minCpuCores}+ threads`);
  return parts.join(' · ') || '—';
}

function catalogAsEntries(): ModelEntry[] {
  return LOCAL_MODEL_CATALOG.map((m: LocalModelEntry) => ({
    id: m.id,
    name: m.name,
    category: m.category === 'voice-conversion' ? 'vocals' : m.category,
    provider: getPreset(m.presetId)?.name ?? m.runtime,
    version: m.version,
    sizeGb: m.sizeGb,
    license: m.license,
    requirements: m.requirements,
    capabilities: m.capabilities,
    installed: false,
    updateStatus: 'unknown',
    compatibility: {
      rating: 'compatible',
      reasons: ['hardware unknown — start the local server to detect it'],
    },
    source: 'catalog',
    description: m.notes,
    homepage: m.homepage,
    install: m.install,
    presetId: m.presetId,
    quantizations: m.quantizations,
  }));
}

export default function ModelsTab() {
  const server = useRuntime((s) => s.server.status);
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [report, setReport] = useState<ModelsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<string>('all');
  const [installedOnly, setInstalledOnly] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const [hw, models] = await Promise.all([getHardware(refresh), refresh ? rescanModels() : getModels()]);
      setHardware(hw);
      setReport(models);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (server === 'online') void load(false);
  }, [server, load]);

  const online = server === 'online';
  /** Compatibility ratings exist only when the server's model manager answered. */
  const rated = online && !!report;
  const entries = useMemo<ModelEntry[]>(
    () =>
      rated && report
        ? report.categories.flatMap((c) => c.models.map((m) => ({ ...m, category: c.id })))
        : catalogAsEntries(),
    [rated, report],
  );
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of entries) out[e.category] = (out[e.category] ?? 0) + 1;
    return out;
  }, [entries]);
  const visible = entries.filter(
    (e) => (cat === 'all' || e.category === cat) && (!installedOnly || e.installed),
  );

  return (
    <>
      <TabHeader
        icon="cpu"
        title="Models & hardware"
        spec="§61 §62"
        lede="One place for local models: what is installed, what your hardware can run well, and which quantization to pick when it is tight."
        actions={
          online ? (
            <Button icon="rebuild" onClick={() => void load(true)} disabled={loading}>
              {loading ? 'Scanning…' : 'Rescan'}
            </Button>
          ) : (
            <Button icon="rebuild" onClick={() => void checkServer()}>
              Check for the server
            </Button>
          )
        }
      />

      {!online && (
        <div className="callout warning" data-testid="models-offline">
          <strong>Start the local server to detect your hardware.</strong> The browser cannot see your GPU,
          VRAM, RAM or installed models. Run <code>npx tsx apps/server/src/cli.ts</code> — the catalog below
          shows each model’s requirements in the meantime.
        </div>
      )}
      {error && <div className="callout danger">Could not read the model manager: {error}</div>}

      {online && <HardwarePanel hw={hardware} loading={loading && !hardware} />}

      <Panel
        title="Model manager"
        icon="layers"
        testId="model-manager"
        sub={
          online && report
            ? `Scanned ${timeAgo(report.scannedAt)} · compatibility rated against this machine.`
            : 'Curated catalog of local models (requirements are guidance).'
        }
        actions={
          online ? (
            <Toggle on={installedOnly} onChange={setInstalledOnly} label="Installed only" />
          ) : undefined
        }
      >
        <Segmented
          label="Category"
          value={cat}
          onChange={setCat}
          options={[
            { value: 'all', label: `All (${entries.length})` },
            ...CATEGORIES.map((c) => ({ value: c.id, label: `${c.label} (${counts[c.id] ?? 0})` })),
          ]}
        />
        {visible.length === 0 ? (
          <Empty icon="layers">
            {installedOnly ? 'No installed models in this category.' : 'No models in this category.'}
          </Empty>
        ) : (
          <div className="st-model-list">
            {CATEGORIES.filter((c) => cat === 'all' || c.id === cat).map((c) => {
              const list = visible.filter((e) => e.category === c.id);
              if (!list.length) return null;
              return (
                <section key={c.id} aria-label={`${c.label} models`}>
                  <h4 className="st-model-cat">{c.label}</h4>
                  {list.map((m) => (
                    <ModelRow key={`${m.source}-${m.id}`} m={m} online={rated} />
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </Panel>

      {online && report && report.sources.length > 0 && (
        <Panel title="Discovery sources" icon="server" sub="Where the server looked for installed models.">
          <div className="st-sources">
            {report.sources.map((s) => (
              <div key={`${s.source}-${s.url ?? ''}`} className="st-source">
                <span
                  className={`status-dot ${s.status === 'ok' ? 'ok' : s.status === 'disabled' ? '' : s.status === 'unreachable' ? 'warn' : 'err'}`}
                />
                <strong>{s.source}</strong>
                {s.url && <span className="mono small dim">{s.url}</span>}
                <span className="grow" />
                <span className="small muted">
                  {s.status === 'ok' ? `${s.count} found` : (s.error ?? s.status)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

function HardwarePanel({ hw, loading }: { hw: HardwareReport | null; loading: boolean }) {
  if (loading || !hw)
    return (
      <Panel title="This machine" icon="cpu">
        Detecting hardware…
      </Panel>
    );
  const backends = hw.accelerationBackends ?? hw.backends ?? [];
  return (
    <Panel
      title="This machine"
      icon="cpu"
      testId="hardware"
      sub={`${hw.os ?? hw.platform ?? ''}${hw.arch ? ` · ${hw.arch}` : ''}${hw.detectedAt ? ` · detected ${timeAgo(hw.detectedAt)}` : ''}`}
    >
      <div className="st-hw">
        <div className="st-hw-tile">
          <div className="st-hw-label">
            <Icon name="layers" size={13} /> GPU
          </div>
          {hw.gpus.length ? (
            hw.gpus.map((g, i) => (
              <div key={i}>
                <div className="st-hw-value">{g.name}</div>
                <div className="small dim">
                  {g.unifiedMemory || g.vramGb === 0 ? 'shared memory' : `${g.vramGb} GB VRAM`}
                  {g.backend ? ` · ${g.backend}` : ''}
                  {g.driver ? ` · driver ${g.driver}` : ''}
                </div>
              </div>
            ))
          ) : (
            <div className="st-hw-value muted">No GPU detected</div>
          )}
        </div>
        <div className="st-hw-tile">
          <div className="st-hw-label">
            <Icon name="grid" size={13} /> VRAM
          </div>
          <div className="st-hw-value">
            {hw.gpus.length ? `${Math.max(...hw.gpus.map((g) => g.vramGb))} GB` : '—'}
          </div>
          <div className="small dim">
            {hw.unifiedMemory ? 'unified memory (uses system RAM)' : 'largest dedicated GPU'}
          </div>
        </div>
        <div className="st-hw-tile">
          <div className="st-hw-label">
            <Icon name="server" size={13} /> RAM
          </div>
          <div className="st-hw-value">{hw.ramGb} GB</div>
          {hw.freeRamGb !== undefined && <div className="small dim">{hw.freeRamGb} GB free</div>}
        </div>
        <div className="st-hw-tile">
          <div className="st-hw-label">
            <Icon name="cpu" size={13} /> CPU
          </div>
          <div className="st-hw-value">
            {hw.cpu.cores} cores
            {hw.cpu.threads && hw.cpu.threads !== hw.cpu.cores ? ` / ${hw.cpu.threads} threads` : ''}
          </div>
          <div className="small dim ellipsis" title={hw.cpu.model}>
            {hw.cpu.model ?? ''}
          </div>
        </div>
        <div className="st-hw-tile">
          <div className="st-hw-label">
            <Icon name="folder" size={13} /> Storage
          </div>
          <div className="st-hw-value">
            {hw.storageFreeGb !== undefined ? `${Math.round(hw.storageFreeGb)} GB free` : '—'}
          </div>
          <div className="small dim">where models are stored</div>
        </div>
        <div className="st-hw-tile">
          <div className="st-hw-label">
            <Icon name="sparkles" size={13} /> Acceleration
          </div>
          <div className="row wrap" style={{ gap: 4 }}>
            {backends.length ? (
              backends.map((b) => (
                <Badge key={b} tone={b === 'cpu' ? undefined : 'success'}>
                  {b}
                </Badge>
              ))
            ) : (
              <span className="muted">CPU only</span>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function ModelRow({ m, online }: { m: ModelEntry; online: boolean }) {
  const providers = useSettings((s) => s.providers);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rating = RATING[m.compatibility.rating] ?? RATING.compatible;
  const configured = !!m.presetId && providers.some((p) => p.presetId === m.presetId || p.id === m.presetId);
  return (
    <article className={`st-model ${open ? 'open' : ''}`} data-testid="model-row" aria-label={m.name}>
      <button type="button" className="st-model-main" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="st-model-title">
          <strong>{m.name}</strong>
          <span className="small dim">
            {m.provider} · v{m.installedVersion ?? m.version}
            {m.sizeGb !== undefined
              ? ` · ${m.sizeGb < 1 ? `${Math.round(m.sizeGb * 1000)} MB` : `${m.sizeGb} GB`}`
              : ''}
          </span>
        </div>
        <span className="st-model-req small muted">{requirementText(m.requirements)}</span>
        <span className="st-model-status">
          {m.installed ? (
            m.updateStatus === 'update-available' ? (
              <Badge tone="warning">Update available</Badge>
            ) : (
              <Badge tone="success">Installed</Badge>
            )
          ) : online ? (
            <Badge>Not installed</Badge>
          ) : (
            <Badge>Catalog</Badge>
          )}
        </span>
        <span className="st-model-rating">
          {online ? (
            <Badge tone={rating.tone} title={m.compatibility.reasons.join('; ')}>
              {rating.label}
            </Badge>
          ) : (
            <Badge title="Start the local server to rate compatibility">Unrated</Badge>
          )}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </button>
      {open && (
        <div className="st-model-detail">
          {m.description && <p className="small">{m.description}</p>}
          <dl className="kv">
            <dt>Capabilities</dt>
            <dd>
              <CapBadges caps={m.capabilities} max={12} />
            </dd>
            <dt>License</dt>
            <dd>{m.license}</dd>
            <dt>Hardware</dt>
            <dd>{requirementText(m.requirements)}</dd>
            {online && (
              <>
                <dt>Compatibility</dt>
                <dd>
                  <strong>{rating.label}</strong> — {m.compatibility.reasons.join('; ') || 'no notes'}
                  {m.compatibility.suggestedQuantization && (
                    <div>
                      Suggested quantization: <Badge tone="ai">{m.compatibility.suggestedQuantization}</Badge>
                    </div>
                  )}
                </dd>
              </>
            )}
            {m.quantizations && m.quantizations.length > 0 && (
              <>
                <dt>Variants</dt>
                <dd className="mono small">
                  {m.quantizations.map((q) => `${q.id} ${q.sizeGb} GB / ${q.vramGb} GB VRAM`).join(' · ')}
                </dd>
              </>
            )}
            <dt>Location</dt>
            <dd className="mono small">{m.location ?? (m.installed ? 'installed' : 'not installed')}</dd>
            <dt>Update status</dt>
            <dd>{m.updateStatus.replace(/-/g, ' ')}</dd>
            {m.installedVia?.length ? (
              <>
                <dt>Found via</dt>
                <dd>{m.installedVia.join(', ')}</dd>
              </>
            ) : null}
          </dl>
          <div className="row wrap">
            {m.install && (
              <Button
                size="sm"
                icon="copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(m.install!).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? 'Copied' : <code>{m.install}</code>}
              </Button>
            )}
            {m.homepage && (
              <a className="small" href={m.homepage} target="_blank" rel="noreferrer noopener">
                Homepage ↗
              </a>
            )}
            <span className="grow" />
            {m.presetId &&
              (configured ? (
                <Badge tone="success">Provider configured</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  icon="plug"
                  onClick={() => openSettings('providers', `add:${m.presetId}`)}
                >
                  Connect as a provider
                </Button>
              ))}
          </div>
        </div>
      )}
    </article>
  );
}
