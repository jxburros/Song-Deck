import { useMemo, useState } from 'react';
import {
  DATA_KINDS,
  DATA_KIND_INFO,
  ROLE_INFO,
  TASK_ROLES,
  describeDataFlow,
  formatCostRange,
  type DataFlowDescriptor,
  type DataKind,
  type OrchestratorEvent,
  type PrivacyConfirmMode,
  type ProviderLocation,
  type TaskRole,
} from '@songdeck/ai';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { useAiRuntime } from '../../engine/ai';
import { Badge, Button, Select, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { PRIVACY_CONFIRM_OPTIONS } from './constants';
import { useRouting } from './RoutingTab';
import { ChipSet, Empty, LocationBadge, Panel, TabHeader, timeAgo, usd } from './ui';
import { ContentCheckPanel } from './ContentCheckPanel';

/** Privacy controls (spec §50) and offline mode (spec §51). */

const DATA_OPTIONS = DATA_KINDS.map((k) => ({
  value: k,
  label: DATA_KIND_INFO[k].label,
  title: DATA_KIND_INFO[k].description,
}));

export function DataFlowCard({ flow }: { flow: DataFlowDescriptor }) {
  return (
    <div className="card st-flow" data-testid="dataflow-sample">
      <div className="small dim" style={{ marginBottom: 4 }}>
        {flow.title}
      </div>
      <div className="row between" style={{ marginBottom: 8, alignItems: 'flex-start' }}>
        <div>
          <div className="field-label">Sending to</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{flow.providerName}</div>
          {flow.modelId && <div className="small mono dim">{flow.modelId}</div>}
        </div>
        <Badge tone={flow.leavesDevice ? 'warning' : 'success'}>
          {flow.location === 'cloud'
            ? 'Cloud — leaves this device'
            : flow.location === 'local'
              ? 'Local model — stays on this machine'
              : 'On-device engine'}
        </Badge>
      </div>
      <div className="field-label" style={{ marginBottom: 6 }}>
        Data
      </div>
      <ul className="dataflow-list">
        {flow.items.map((it) => (
          <li key={it.kind}>
            <span className={it.included ? 'yes' : 'no'}>{it.included ? '✓' : '✗'}</span>
            <span className={it.included ? '' : 'dim'}>{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PrivacyTab() {
  const [routing, setRouting] = useRouting();
  const providers = useSettings((s) => s.providers);
  const project = useStudio((s) => s.project);
  const updateProject = useStudio((s) => s.updateProject);
  const summaries = useAiRuntime((s) => s.providers);
  const cloud = providers.filter((p) => p.enabled && p.location === 'cloud');
  const local = summaries.filter((s) => s.enabled && s.location !== 'cloud');
  const projectNever = (project?.meta.settings.neverUpload ?? []) as DataKind[];
  const ruleNever = routing.rules.flatMap((r) =>
    r.kind === 'never-upload' && r.enabled !== false ? r.dataKinds : [],
  );

  return (
    <>
      <TabHeader
        icon="shield"
        title="Privacy"
        spec="§50 §51"
        lede="Connected services can run without repeated prompts. Manage permissions here, or turn on offline mode to keep requests on this device."
      />

      <Panel title="Offline mode" icon="shield" testId="offline-panel">
        <div className={`st-offline ${routing.offline ? 'on' : ''}`}>
          <div className="grow">
            <div className="row" style={{ gap: 10 }}>
              <Toggle
                on={routing.offline}
                onChange={(offline) => setRouting({ offline })}
                label={<strong>Offline mode — nothing leaves this device</strong>}
              />
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              Cloud providers are excluded from routing and cannot be contacted. Local models, the
              deterministic theory engine, MIDI generation, local transcription, separation, singing,
              rendering and mixing keep working (spec §51).
            </div>
          </div>
          <div className="st-offline-lists">
            <div>
              <div className="field-label">
                {routing.offline ? 'Unavailable now' : 'Unavailable when offline'}
              </div>
              {cloud.length ? (
                <ul className="st-plain" data-testid="offline-unavailable">
                  {cloud.map((p) => (
                    <li key={p.id}>
                      <Icon name="cloud" size={12} /> {p.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="small dim">No cloud providers configured.</div>
              )}
            </div>
            <div>
              <div className="field-label">Keeps working</div>
              <ul className="st-plain">
                {local.slice(0, 7).map((p) => (
                  <li key={p.id}>
                    <Icon name={p.location === 'internal' ? 'shield' : 'cpu'} size={12} /> {p.name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="Connected service permissions"
        icon="plug"
        sub="Connect and use allows routine requests to that service. Always ask overrides these permissions."
      >
        {cloud.length ? (
          cloud.map((p) => (
            <Toggle
              key={p.id}
              on={routing.trustedProviderIds?.includes(p.id) ?? false}
              onChange={(allowed) =>
                setRouting({
                  trustedProviderIds: allowed
                    ? [...new Set([...(routing.trustedProviderIds ?? []), p.id])]
                    : (routing.trustedProviderIds ?? []).filter((id) => id !== p.id),
                })
              }
              label={`Allow ${p.name} without routine prompts`}
            />
          ))
        ) : (
          <div className="small muted">No cloud services connected yet.</div>
        )}
      </Panel>

      <Panel
        title="Confirm before sending"
        icon="eye"
        sub="When to show the data-flow confirmation (provider, model, data, estimated cost) before a request."
      >
        <div className="st-radio-cards" role="radiogroup" aria-label="Privacy confirmation">
          {PRIVACY_CONFIRM_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={routing.privacyConfirm === o.value}
              className={`card selectable ${routing.privacyConfirm === o.value ? 'selected' : ''}`}
              onClick={() => setRouting({ privacyConfirm: o.value as PrivacyConfirmMode })}
            >
              <strong>{o.label}</strong>
              <div className="small muted">{o.hint}</div>
            </button>
          ))}
        </div>
      </Panel>

      <div className="st-two">
        <Panel
          title="Never upload — everywhere"
          icon="lock"
          sub="These data kinds are never sent to cloud providers, in every routing mode. Cloud providers are excluded from requests that contain them."
        >
          <ChipSet
            label="Never upload (global)"
            options={DATA_OPTIONS}
            value={routing.neverUpload}
            onChange={(neverUpload) => setRouting({ neverUpload })}
          />
          {ruleNever.length > 0 && (
            <div className="small muted" style={{ marginTop: 8 }}>
              Also blocked by routing rules:{' '}
              {[...new Set(ruleNever)].map((k) => DATA_KIND_INFO[k]?.label ?? k).join(', ')}.
            </div>
          )}
        </Panel>
        <Panel
          title={project ? `Never upload — “${project.meta.name}”` : 'Never upload — this project'}
          icon="folder"
          sub="Stored in the project file, so it travels with the project to collaborators."
        >
          {project ? (
            <ChipSet
              label="Never upload (project)"
              options={DATA_OPTIONS}
              value={projectNever}
              onChange={(neverUpload) =>
                updateProject((p) => ({
                  ...p,
                  meta: { ...p.meta, settings: { ...p.meta.settings, neverUpload } },
                }))
              }
            />
          ) : (
            <Empty icon="folder">Open a project to set its own never-upload list.</Empty>
          )}
        </Panel>
      </div>

      <ContentCheckPanel />
      <DataFlowExplainer />
      <ActivityLog />
    </>
  );
}

function DataFlowExplainer() {
  const summaries = useAiRuntime((s) => s.providers);
  const [role, setRole] = useState<TaskRole>('production');
  const [target, setTarget] = useState('gemini-sample');
  const options = useMemo(
    () => [
      {
        value: 'gemini-sample',
        label: 'Gemini (example, cloud)',
        name: 'Gemini',
        location: 'cloud' as ProviderLocation,
      },
      ...summaries.map((s) => ({
        value: s.id,
        label: `${s.name} (${s.location === 'internal' ? 'on-device' : s.location})`,
        name: s.name,
        location: s.location,
      })),
    ],
    [summaries],
  );
  const chosen = options.find((o) => o.value === target) ?? options[0];
  const dataKinds: DataKind[] =
    role === 'production' && target === 'gemini-sample'
      ? ['song-description', 'chord-progression', 'midi']
      : ROLE_INFO[role].dataKinds;
  const flow = describeDataFlow(
    {
      dataKinds,
      role,
      show: ['song-description', 'chord-progression', 'midi', 'lyrics', 'recorded-vocals', 'reference-audio'],
    },
    { providerName: chosen.name, location: chosen.location },
  );
  return (
    <Panel
      title="The data-flow indicator"
      icon="info"
      sub="Every provider request is described before it is sent: who receives it, whether it leaves the device, and exactly which kinds of project data are included."
    >
      <div className="st-two">
        <div className="col">
          <p className="small">
            The indicator appears in the confirmation dialog (per your setting above) and in the activity log
            below. A ✓ means that kind of data is part of the request; ✗ means it is not. Location badges tell
            you where it goes: <LocationBadge location="cloud" /> leaves this device,{' '}
            <LocationBadge location="local" /> stays on your machine or network,{' '}
            <LocationBadge location="internal" /> never leaves Song Deck.
          </p>
          <div className="grid-2">
            <label className="field">
              <span className="field-label">Task</span>
              <Select
                value={role}
                onChange={setRole}
                options={TASK_ROLES.map((r) => ({ value: r, label: ROLE_INFO[r].label }))}
                aria-label="Sample task"
              />
            </label>
            <label className="field">
              <span className="field-label">Provider</span>
              <Select
                value={chosen.value}
                onChange={setTarget}
                options={options.map((o) => ({ value: o.value, label: o.label }))}
                aria-label="Sample provider"
              />
            </label>
          </div>
        </div>
        <DataFlowCard flow={flow} />
      </div>
    </Panel>
  );
}

const roleLabel = (r: TaskRole) => ROLE_INFO[r]?.label ?? r;

function eventText(e: OrchestratorEvent): {
  icon: string;
  tone: string;
  title: string;
  detail: string;
  provider?: string;
  location?: ProviderLocation;
} {
  switch (e.type) {
    case 'routed':
      return {
        icon: 'sliders',
        tone: '',
        title: `Routed ${roleLabel(e.role)}`,
        detail: e.decision.reasons.slice(0, 3).join(' · '),
        provider: e.decision.providerName,
        location: e.decision.location,
      };
    case 'confirm':
      return {
        icon: 'eye',
        tone: 'warning',
        title: 'Asked for confirmation',
        detail: `Data: ${
          e.flow.items
            .filter((i) => i.included)
            .map((i) => i.label)
            .join(', ') || 'none'
        } · ${formatCostRange(e.estimate)}`,
        provider: e.flow.providerName,
        location: e.flow.location,
      };
    case 'budget-warning':
      return { icon: 'alert', tone: 'warning', title: 'Budget warning', detail: e.warning };
    case 'started':
      return {
        icon: 'play',
        tone: '',
        title: `Started ${roleLabel(e.role)}`,
        detail: e.modelId ? `model ${e.modelId}` : '',
        provider: e.providerId,
      };
    case 'fallback':
      return {
        icon: 'rebuild',
        tone: 'warning',
        title: 'Fell back',
        detail: `${e.from} → ${e.to}: ${e.reason}`,
      };
    case 'succeeded': {
      const p = e.provenance;
      const sent = (ROLE_INFO[e.role]?.dataKinds ?? [])
        .map((k) => DATA_KIND_INFO[k]?.label.toLowerCase() ?? k)
        .join(', ');
      return {
        icon: 'check',
        tone: 'success',
        title: `${roleLabel(e.role)} done`,
        detail: `${p.cloud ? `Left the device (${sent})` : 'Stayed on this device'}${p.modelId ? ` · ${p.modelId}` : ''}${p.costUsd !== undefined ? ` · ${usd(p.costUsd)}${p.costEstimated ? ' (est.)' : ''}` : ''}${p.fallbackFrom ? ` · fallback from ${p.fallbackFrom}` : ''}`,
        provider: p.providerName,
        location: p.location,
      };
    }
    case 'failed':
      return {
        icon: 'alert',
        tone: 'danger',
        title: `${roleLabel(e.role)} failed`,
        detail: e.error,
        provider: e.providerId,
      };
  }
}

function ActivityLog() {
  const events = useAiRuntime((s) => s.events);
  const [all, setAll] = useState(false);
  const filtered = all ? events : events.filter((e) => e.type !== 'started' && e.type !== 'routed');
  return (
    <Panel
      title="Recent AI activity"
      icon="history"
      sub="Which provider received what, this session. On-device requests never leave Song Deck."
      actions={
        <div className="row">
          <Toggle on={all} onChange={setAll} label="Include routing steps" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useAiRuntime.setState({ events: [] })}
            disabled={!events.length}
          >
            Clear
          </Button>
        </div>
      }
      testId="ai-activity"
    >
      {filtered.length === 0 ? (
        <Empty icon="history">No AI requests yet this session.</Empty>
      ) : (
        <ul className="st-activity">
          {filtered.slice(0, 40).map((e, i) => {
            const t = eventText(e);
            return (
              <li key={`${e.at}-${i}`} className={t.tone}>
                <Icon name={t.icon} size={14} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <strong>{t.title}</strong>
                    {t.provider && <span className="muted">→ {t.provider}</span>}
                    {t.location && <LocationBadge location={t.location} />}
                  </div>
                  {t.detail && <div className="small dim ellipsis">{t.detail}</div>}
                </div>
                <span className="small dim nowrap">{timeAgo(e.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
