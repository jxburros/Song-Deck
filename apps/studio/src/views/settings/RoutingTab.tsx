import { useEffect, useMemo, useState } from 'react';
import {
  BUILTIN_PROFILES,
  CAPABILITY_INFO,
  DATA_KINDS,
  DATA_KIND_INFO,
  NoCompatibleProviderError,
  PROVIDER_PRESETS,
  ROLE_INFO,
  TASK_ROLES,
  describeAssignment,
  formatCostRange,
  type DataKind,
  type ExcludedCandidate,
  type ProviderProfile,
  type QualityLevel,
  type RoleAssignment,
  type RouteDecision,
  type RoutingMode,
  type RoutingRule,
  type RoutingSettings,
  type TaskRole,
} from '@songdeck/ai';
import { DEFAULT_ROUTING, useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { getRegistry, getRouter, initAi, useAiRuntime } from '../../engine/ai';
import { Badge, Button, Field, Modal, Select, Slider, TextArea, TextInput, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ChipSet, LocationBadge, OptNumber, Panel, Segmented, TabHeader, errorMessage } from './ui';

/**
 * Profiles & routing (spec §6 provider profiles, §49 model routing, §59 capability negotiation).
 */

export function useRouting(): [RoutingSettings, (patch: Partial<RoutingSettings>) => void] {
  const routing = useSettings((s) => s.routing);
  const update = useSettings((s) => s.update);
  const merged = useMemo(() => ({ ...DEFAULT_ROUTING, ...routing }) as RoutingSettings, [routing]);
  return [merged, (patch) => update({ routing: { ...merged, ...patch } })];
}

const MODES: { value: RoutingMode; label: string; icon: string; text: string }[] = [
  {
    value: 'manual',
    label: 'Manual',
    icon: 'pointer',
    text: 'You pick who does every task — through a profile, or per request in each mode.',
  },
  {
    value: 'automatic',
    label: 'Automatic',
    icon: 'sparkles',
    text: 'Song Deck chooses by capability, quality, cost and latency for each task.',
  },
  {
    value: 'rules',
    label: 'Rules',
    icon: 'sliders',
    text: 'Automatic, governed by your rules: local first, confidence fallbacks, never-upload, cost caps…',
  },
];

/** The spec §49 example rules as one-click presets. */
export const RULE_PRESETS: { id: string; label: string; rule: RoutingRule }[] = [
  { id: 'prefer-local', label: 'Use local models whenever possible', rule: { kind: 'prefer-local' } },
  {
    id: 'confidence-gemini',
    label: 'If local confidence < 70%: use Gemini',
    rule: { kind: 'fallback-if-low-confidence', threshold: 0.7, fallbackProviderId: 'gemini' },
  },
  {
    id: 'cloud-final',
    label: 'Use cloud production only for Final renders',
    rule: { kind: 'cloud-only-for-final', roles: ['production'] },
  },
  {
    id: 'never-vocals',
    label: 'Never upload vocals',
    rule: { kind: 'never-upload', dataKinds: ['recorded-vocals'] },
  },
];

const RULE_KINDS: { kind: RoutingRule['kind']; label: string }[] = [
  { kind: 'prefer-local', label: 'Prefer local models' },
  { kind: 'fallback-if-low-confidence', label: 'Fallback when confidence is low' },
  { kind: 'cloud-only-for-final', label: 'Cloud only for final renders' },
  { kind: 'never-upload', label: 'Never upload data' },
  { kind: 'prefer-provider', label: 'Prefer a provider for a role' },
  { kind: 'max-cost', label: 'Maximum cost per request' },
];

function newRule(kind: RoutingRule['kind']): RoutingRule {
  switch (kind) {
    case 'prefer-local':
      return { kind };
    case 'fallback-if-low-confidence':
      return { kind, threshold: 0.7, fallbackProviderId: 'gemini' };
    case 'cloud-only-for-final':
      return { kind, roles: ['production'] };
    case 'never-upload':
      return { kind, dataKinds: ['recorded-vocals'] };
    case 'prefer-provider':
      return { kind, role: 'composition', providerId: 'internal-composer' };
    case 'max-cost':
      return { kind, usd: 0.5 };
  }
}

const sameRule = (a: RoutingRule, b: RoutingRule) => {
  const strip = (r: RoutingRule) => JSON.stringify({ ...r, enabled: undefined });
  return strip(a) === strip(b);
};

export const ROLE_OPTIONS = TASK_ROLES.map((r) => ({
  value: r,
  label: ROLE_INFO[r].label,
  title: ROLE_INFO[r].description,
}));
const DATA_OPTIONS = DATA_KINDS.map((k) => ({
  value: k,
  label: DATA_KIND_INFO[k].label,
  title: DATA_KIND_INFO[k].description,
}));

/** Provider choices for profiles and rules: configured, on-device/plugin and not-yet-configured presets. */
function useProviderChoices(): { value: string; label: string }[] {
  const providers = useSettings((s) => s.providers);
  const summaries = useAiRuntime((s) => s.providers);
  return useMemo(() => {
    const out: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const p of providers) {
      out.push({ value: p.id, label: `${p.name}${p.enabled ? '' : ' (disabled)'}` });
      seen.add(p.id);
      if (p.presetId) seen.add(p.presetId);
    }
    for (const s of summaries) {
      if (seen.has(s.id)) continue;
      out.push({ value: s.id, label: `${s.name}${s.location === 'internal' ? ' (on-device)' : ''}` });
      seen.add(s.id);
    }
    for (const p of PROVIDER_PRESETS)
      if (!seen.has(p.id)) out.push({ value: p.id, label: `${p.name} (not configured)` });
    return out;
  }, [providers, summaries]);
}

export default function RoutingTab() {
  const [routing, setRouting] = useRouting();
  useEffect(() => {
    initAi();
  }, []);
  return (
    <>
      <TabHeader
        icon="sliders"
        title="Profiles & routing"
        spec="§6 §49 §59"
        lede="Which provider handles each task — composition, MIDI edits, lyrics, analysis, transcription, separation, production, vocals, mixing, mastering — and why. Profiles assign providers per role; rules shape automatic choices."
      />
      <Panel title="Routing mode" icon="sliders">
        <div className="st-mode-cards" role="radiogroup" aria-label="Routing mode">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={routing.mode === m.value}
              className={`card selectable st-mode-card ${routing.mode === m.value ? 'selected' : ''}`}
              onClick={() => setRouting({ mode: m.value })}
            >
              <div className="row">
                <Icon name={m.icon} />
                <strong>{m.label}</strong>
              </div>
              <div className="small muted">{m.text}</div>
            </button>
          ))}
        </div>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <Toggle
            on={routing.fallbackToInternal !== false}
            onChange={(fallbackToInternal) => setRouting({ fallbackToInternal })}
            label="When an assigned provider is unavailable, fall back to the on-device engine"
          />
        </div>
      </Panel>
      <ProfilesPanel routing={routing} setRouting={setRouting} />
      <PrioritiesPanel routing={routing} setRouting={setRouting} />
      <RulesPanel routing={routing} setRouting={setRouting} />
      <RoutingPreview />
    </>
  );
}

// ---------------------------------------------------------------------------
// Profiles (spec §6)
// ---------------------------------------------------------------------------

function ProfilesPanel({
  routing,
  setRouting,
}: {
  routing: RoutingSettings;
  setRouting: (p: Partial<RoutingSettings>) => void;
}) {
  const custom = useSettings((s) => s.customProfiles);
  const update = useSettings((s) => s.update);
  const providerNames = useProviderNames();
  const [editing, setEditing] = useState<ProviderProfile | null>(null);
  const all = [...BUILTIN_PROFILES, ...custom];
  const duplicate = (p: ProviderProfile) => {
    const ids = new Set(all.map((x) => x.id));
    let id = `custom-${p.id}`;
    for (let i = 2; ids.has(id); i++) id = `custom-${p.id}-${i}`;
    setEditing({ ...structuredClone(p), id, name: `${p.name} (custom)`, builtIn: false });
  };
  return (
    <Panel
      title="Provider profiles"
      icon="users"
      sub="A profile assigns a provider (and model) to each role. In Manual mode it decides; in Automatic and Rules mode it is a strong hint."
      actions={
        <Button
          size="sm"
          icon="plus"
          onClick={() =>
            setEditing({
              id: `custom-${Date.now().toString(36)}`,
              name: 'My profile',
              description: '',
              assignments: {},
            })
          }
        >
          New profile
        </Button>
      }
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="field-label">Active profile</span>
        <Select
          value={routing.profileId ?? ''}
          onChange={(v) => setRouting({ profileId: v || undefined })}
          options={[
            { value: '', label: 'None — capability routing only' },
            ...all.map((p) => ({ value: p.id, label: `${p.name}${p.builtIn ? '' : ' (custom)'}` })),
          ]}
          aria-label="Active profile"
          style={{ maxWidth: 340 }}
        />
      </div>
      <div className="st-profile-grid">
        {all.map((p) => {
          const active = routing.profileId === p.id;
          return (
            <article
              key={p.id}
              className={`st-profile ${active ? 'active' : ''}`}
              aria-label={`Profile ${p.name}`}
            >
              <div className="row between">
                <strong>{p.name}</strong>
                {active ? (
                  <Badge tone="accent">Active</Badge>
                ) : p.builtIn ? (
                  <Badge>Built-in</Badge>
                ) : (
                  <Badge tone="ai">Custom</Badge>
                )}
              </div>
              <div className="small muted st-profile-desc">{p.description}</div>
              <dl className="st-assign">
                {TASK_ROLES.filter((r) => p.assignments[r] !== undefined)
                  .slice(0, 7)
                  .map((r) => (
                    <div key={r}>
                      <dt>{ROLE_INFO[r].label}</dt>
                      <dd className={p.assignments[r] === 'disabled' ? 'dim' : ''}>
                        {assignmentLabel(p.assignments[r], providerNames)}
                      </dd>
                    </div>
                  ))}
              </dl>
              <div className="row" style={{ marginTop: 'auto' }}>
                {!active && (
                  <Button size="sm" variant="primary" onClick={() => setRouting({ profileId: p.id })}>
                    Use
                  </Button>
                )}
                {active && (
                  <Button size="sm" onClick={() => setRouting({ profileId: undefined })}>
                    Deactivate
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon="copy" onClick={() => duplicate(p)}>
                  Duplicate
                </Button>
                {!p.builtIn && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="pencil"
                      onClick={() => setEditing(structuredClone(p))}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label={`Delete ${p.name}`}
                      onClick={() => {
                        update({ customProfiles: custom.filter((x) => x.id !== p.id) });
                        if (active) setRouting({ profileId: undefined });
                      }}
                    />
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {editing && (
        <ProfileEditor
          profile={editing}
          onClose={() => setEditing(null)}
          onSave={(p) => {
            const rest = custom.filter((x) => x.id !== p.id);
            update({ customProfiles: [...rest, { ...p, builtIn: false }] });
            setEditing(null);
          }}
        />
      )}
    </Panel>
  );
}

function useProviderNames(): Map<string, string> {
  const choices = useProviderChoices();
  return useMemo(
    () =>
      new Map(
        choices.map((c) => [c.value, c.label.replace(/ \((not configured|on-device|disabled)\)$/, '')]),
      ),
    [choices],
  );
}

function assignmentLabel(a: RoleAssignment | undefined, names: Map<string, string>): string {
  if (a === undefined) return 'Automatic';
  if (a === 'internal') return 'On-device engine';
  if (a === 'disabled') return 'Disabled';
  const name = names.get(a.providerId) ?? describeAssignment(a);
  return a.modelId ? `${name} · ${a.modelId}` : name;
}

function ProfileEditor({
  profile,
  onClose,
  onSave,
}: {
  profile: ProviderProfile;
  onClose: () => void;
  onSave: (p: ProviderProfile) => void;
}) {
  const [p, setP] = useState<ProviderProfile>(profile);
  const choices = useProviderChoices();
  const setRole = (role: TaskRole, a: RoleAssignment | undefined) => {
    const assignments = { ...p.assignments };
    if (a === undefined) delete assignments[role];
    else assignments[role] = a;
    setP({ ...p, assignments });
  };
  return (
    <Modal
      title={`Profile: ${p.name || 'untitled'}`}
      icon="users"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!p.name.trim()}
            onClick={() => onSave({ ...p, name: p.name.trim() })}
          >
            Save profile
          </Button>
        </>
      }
    >
      <div className="col">
        <div className="grid-2">
          <Field label="Name">
            <TextInput value={p.name} onChange={(name) => setP({ ...p, name })} aria-label="Profile name" />
          </Field>
          <Field label="Id">
            <TextInput mono value={p.id} disabled onChange={() => undefined} />
          </Field>
        </div>
        <Field label="Description">
          <TextArea value={p.description} onChange={(description) => setP({ ...p, description })} rows={2} />
        </Field>
        <table className="table st-role-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Handled by</th>
              <th>Model (optional)</th>
            </tr>
          </thead>
          <tbody>
            {TASK_ROLES.map((role) => {
              const a = p.assignments[role];
              const kind =
                a === undefined
                  ? 'auto'
                  : a === 'internal'
                    ? 'internal'
                    : a === 'disabled'
                      ? 'disabled'
                      : a.providerId;
              return (
                <tr key={role}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{ROLE_INFO[role].label}</div>
                    <div className="small dim">
                      {ROLE_INFO[role].capabilities.map((c) => CAPABILITY_INFO[c].label).join(' + ')}
                    </div>
                  </td>
                  <td>
                    <Select
                      size="sm"
                      value={kind}
                      aria-label={`${ROLE_INFO[role].label} assignment`}
                      onChange={(v) =>
                        setRole(
                          role,
                          v === 'auto'
                            ? undefined
                            : v === 'internal'
                              ? 'internal'
                              : v === 'disabled'
                                ? 'disabled'
                                : {
                                    providerId: v,
                                    ...(typeof a === 'object' && a.providerId === v && a.modelId
                                      ? { modelId: a.modelId }
                                      : {}),
                                  },
                        )
                      }
                      options={[
                        { value: 'auto', label: 'Automatic (no assignment)' },
                        { value: 'internal', label: 'On-device engine' },
                        { value: 'disabled', label: 'Disabled' },
                        ...choices,
                      ]}
                    />
                  </td>
                  <td>
                    {typeof a === 'object' ? (
                      <TextInput
                        size="sm"
                        mono
                        value={a.modelId ?? ''}
                        placeholder="provider default"
                        onChange={(modelId) =>
                          setRole(role, { providerId: a.providerId, ...(modelId ? { modelId } : {}) })
                        }
                      />
                    ) : (
                      <span className="small dim">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------

function PrioritiesPanel({
  routing,
  setRouting,
}: {
  routing: RoutingSettings;
  setRouting: (p: Partial<RoutingSettings>) => void;
}) {
  const pr = routing.priorities;
  const total = pr.quality + pr.cost + pr.latency || 1;
  const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
  return (
    <Panel
      title="Automatic routing priorities"
      icon="sliders"
      sub="How automatic and rules routing weigh compatible providers. Final-quality requests double the quality weight; drafts favour cost and speed."
    >
      <div className="grid-3">
        <Slider
          label="Quality"
          value={pr.quality}
          onChange={(quality) => setRouting({ priorities: { ...pr, quality } })}
          format={() => pct(pr.quality)}
          left="ignore"
          right="matters most"
          accent
        />
        <Slider
          label="Cost"
          value={pr.cost}
          onChange={(cost) => setRouting({ priorities: { ...pr, cost } })}
          format={() => pct(pr.cost)}
          left="ignore"
          right="cheapest"
          accent
        />
        <Slider
          label="Latency"
          value={pr.latency}
          onChange={(latency) => setRouting({ priorities: { ...pr, latency } })}
          format={() => pct(pr.latency)}
          left="ignore"
          right="fastest"
          accent
        />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Rules (spec §49)
// ---------------------------------------------------------------------------

function RulesPanel({
  routing,
  setRouting,
}: {
  routing: RoutingSettings;
  setRouting: (p: Partial<RoutingSettings>) => void;
}) {
  const rules = routing.rules;
  const choices = useProviderChoices();
  const setRules = (next: RoutingRule[]) => setRouting({ rules: next });
  const setAt = (i: number, r: RoutingRule) => setRules(rules.map((x, j) => (j === i ? r : x)));
  const [adding, setAdding] = useState<RoutingRule['kind']>('prefer-local');
  return (
    <Panel
      title="Routing rules"
      icon="tasks"
      sub="Spec §49 Rules mode. Never-upload rules apply in every mode; the others shape routing in Rules mode."
      actions={
        routing.mode !== 'rules' && rules.some((r) => r.kind !== 'never-upload' && r.enabled !== false) ? (
          <Badge tone="warning">Inactive outside Rules mode</Badge>
        ) : undefined
      }
      testId="routing-rules"
    >
      <div className="st-rule-presets">
        <span className="field-label">Examples from the spec</span>
        <div className="chip-list">
          {RULE_PRESETS.map((p) => {
            const has = rules.some((r) => sameRule(r, p.rule));
            return (
              <button
                key={p.id}
                type="button"
                className={`chip ${has ? 'on' : ''}`}
                aria-pressed={has}
                onClick={() =>
                  setRules(
                    has ? rules.filter((r) => !sameRule(r, p.rule)) : [...rules, structuredClone(p.rule)],
                  )
                }
              >
                {has ? <Icon name="check" size={12} /> : <Icon name="plus" size={12} />}
                {p.label}
              </button>
            );
          })}
        </div>
        {routing.mode !== 'rules' && (
          <div className="row small muted">
            <span>
              Routing is currently <strong>{routing.mode}</strong> — never-upload rules already apply; the
              others take effect in Rules mode.
            </span>
            <Button size="sm" variant="ai" onClick={() => setRouting({ mode: 'rules' })}>
              Switch to Rules mode
            </Button>
          </div>
        )}
      </div>
      {rules.length === 0 && <div className="small dim">No rules yet.</div>}
      <ol className="st-rules">
        {rules.map((r, i) => (
          <li key={i} className={`st-rule ${r.enabled === false ? 'off' : ''}`} data-testid="routing-rule">
            <Toggle
              on={r.enabled !== false}
              onChange={(on) => setAt(i, { ...r, enabled: on })}
              title={r.enabled === false ? 'Enable rule' : 'Disable rule'}
            />
            <div className="grow col" style={{ gap: 6 }}>
              <div className="st-rule-text">{describeRule(r, choices)}</div>
              <RuleFields rule={r} onChange={(nr) => setAt(i, nr)} choices={choices} />
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={() => setRules(rules.filter((_, j) => j !== i))}
              aria-label="Delete rule"
            />
          </li>
        ))}
      </ol>
      <div className="row">
        <Select
          value={adding}
          onChange={setAdding}
          options={RULE_KINDS.map((k) => ({ value: k.kind, label: k.label }))}
          aria-label="Rule kind"
          style={{ maxWidth: 300 }}
        />
        <Button icon="plus" onClick={() => setRules([...rules, newRule(adding)])}>
          Add rule
        </Button>
      </div>
    </Panel>
  );
}

function providerLabel(id: string, choices: { value: string; label: string }[]): string {
  return (
    choices.find((c) => c.value === id)?.label.replace(/ \((not configured|on-device|disabled)\)$/, '') ?? id
  );
}

function rolesText(roles: TaskRole[] | undefined): string {
  if (!roles?.length) return 'all roles';
  return roles.map((r) => (ROLE_INFO[r]?.label ?? r).toLowerCase()).join(', ');
}

export function describeRule(r: RoutingRule, choices: { value: string; label: string }[] = []): string {
  switch (r.kind) {
    case 'prefer-local':
      return 'Use local models whenever possible.';
    case 'fallback-if-low-confidence':
      return `If confidence < ${Math.round(r.threshold * 100)}%: use ${providerLabel(r.fallbackProviderId, choices)}${r.fallbackModelId ? ` (${r.fallbackModelId})` : ''} — ${rolesText(r.roles)}.`;
    case 'cloud-only-for-final':
      return `Use cloud providers for ${rolesText(r.roles)} only for Final renders.`;
    case 'never-upload':
      return `Never upload ${r.dataKinds.map((k) => (DATA_KIND_INFO[k]?.label ?? k).toLowerCase()).join(', ') || '…'}.`;
    case 'prefer-provider':
      return `Prefer ${providerLabel(r.providerId, choices)}${r.modelId ? ` (${r.modelId})` : ''} for ${(ROLE_INFO[r.role]?.label ?? r.role).toLowerCase()}.`;
    case 'max-cost':
      return `Skip providers estimated above $${r.usd.toFixed(2)} per request — ${rolesText(r.roles)}.`;
  }
}

function RuleFields({
  rule,
  onChange,
  choices,
}: {
  rule: RoutingRule;
  onChange: (r: RoutingRule) => void;
  choices: { value: string; label: string }[];
}) {
  switch (rule.kind) {
    case 'prefer-local':
      return null;
    case 'fallback-if-low-confidence':
      return (
        <div className="st-rule-fields">
          <Slider
            value={rule.threshold}
            min={0.1}
            max={0.99}
            step={0.01}
            onChange={(threshold) => onChange({ ...rule, threshold })}
            format={(v) => `${Math.round(v * 100)}%`}
            label="Confidence threshold"
          />
          <Field label="Fallback provider">
            <Select
              size="sm"
              value={rule.fallbackProviderId}
              onChange={(fallbackProviderId) => onChange({ ...rule, fallbackProviderId })}
              options={choices}
              aria-label="Fallback provider"
            />
          </Field>
          <Field label="Model">
            <TextInput
              size="sm"
              mono
              value={rule.fallbackModelId ?? ''}
              placeholder="default"
              onChange={(m) => onChange({ ...rule, fallbackModelId: m || undefined })}
            />
          </Field>
          <Field label="Roles (none = all)" className="st-span-all">
            <ChipSet
              label="Roles"
              options={ROLE_OPTIONS}
              value={rule.roles ?? []}
              onChange={(roles) => onChange({ ...rule, roles: roles.length ? roles : undefined })}
            />
          </Field>
        </div>
      );
    case 'cloud-only-for-final':
      return (
        <ChipSet
          label="Roles"
          options={ROLE_OPTIONS}
          value={rule.roles}
          onChange={(roles) => onChange({ ...rule, roles })}
        />
      );
    case 'never-upload':
      return (
        <ChipSet
          label="Data kinds"
          options={DATA_OPTIONS}
          value={rule.dataKinds}
          onChange={(dataKinds) => onChange({ ...rule, dataKinds })}
        />
      );
    case 'prefer-provider':
      return (
        <div className="st-rule-fields">
          <Field label="Role">
            <Select
              size="sm"
              value={rule.role}
              onChange={(role) => onChange({ ...rule, role })}
              options={ROLE_OPTIONS}
              aria-label="Role"
            />
          </Field>
          <Field label="Provider">
            <Select
              size="sm"
              value={rule.providerId}
              onChange={(providerId) => onChange({ ...rule, providerId })}
              options={choices}
              aria-label="Preferred provider"
            />
          </Field>
          <Field label="Model">
            <TextInput
              size="sm"
              mono
              value={rule.modelId ?? ''}
              placeholder="default"
              onChange={(m) => onChange({ ...rule, modelId: m || undefined })}
            />
          </Field>
        </div>
      );
    case 'max-cost':
      return (
        <div className="st-rule-fields">
          <Field label="Max $ per request">
            <OptNumber
              size="sm"
              value={rule.usd}
              min={0}
              step={0.05}
              onChange={(usd) => onChange({ ...rule, usd: usd ?? 0 })}
              aria-label="Maximum cost"
            />
          </Field>
          <Field label="Roles (none = all)" className="st-span-2">
            <ChipSet
              label="Roles"
              options={ROLE_OPTIONS}
              value={rule.roles ?? []}
              onChange={(roles) => onChange({ ...rule, roles: roles.length ? roles : undefined })}
            />
          </Field>
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Live routing preview (router.select / router.evaluate)
// ---------------------------------------------------------------------------

interface PreviewRow {
  role: TaskRole;
  decision?: RouteDecision;
  error?: string;
  excluded: ExcludedCandidate[];
}

export function RoutingPreview({ compact }: { compact?: boolean }) {
  const routing = useSettings((s) => s.routing);
  const customProfiles = useSettings((s) => s.customProfiles);
  const version = useAiRuntime((s) => s.version);
  const projectNever = useStudio((s) => s.project?.meta.settings.neverUpload) as DataKind[] | undefined;
  const [quality, setQuality] = useState<QualityLevel>('standard');
  const [extra, setExtra] = useState<DataKind[]>([]);
  const [open, setOpen] = useState<Set<TaskRole>>(new Set());

  const rows = useMemo<PreviewRow[]>(() => {
    initAi();
    const router = getRouter();
    return TASK_ROLES.map((role) => {
      const dataKinds = [...new Set([...ROLE_INFO[role].dataKinds, ...extra])];
      const req = { role, quality, dataKinds, neverUpload: projectNever ?? [] };
      // Providers that cannot do this kind of task at all (wrong interface) are noise here.
      const relevant = (list: ExcludedCandidate[]) =>
        list.filter((x) => !x.reasons.some((r) => r.startsWith('does not provide')));
      let excluded: ExcludedCandidate[] = [];
      try {
        excluded = relevant(router.evaluate(req).excluded);
      } catch {
        excluded = [];
      }
      try {
        return { role, decision: router.select(req), excluded };
      } catch (err) {
        if (err instanceof NoCompatibleProviderError)
          return { role, error: err.message.split(':')[0], excluded: relevant(err.excluded) };
        return { role, error: errorMessage(err), excluded };
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routing, customProfiles, version, projectNever, quality, extra]);

  const toggle = (role: TaskRole) => {
    const next = new Set(open);
    if (next.has(role)) next.delete(role);
    else next.add(role);
    setOpen(next);
  };
  const regSize = getRegistry().allEntries().length;

  return (
    <Panel
      title="Routing preview"
      icon="eye"
      testId="routing-preview"
      sub={`Who would handle each task right now — with the reasons from the capability router (${regSize} registered providers${projectNever?.length ? `; this project never uploads ${projectNever.length} data kind${projectNever.length > 1 ? 's' : ''}` : ''}).`}
      actions={
        <div className="row">
          <Segmented
            label="Quality"
            value={quality}
            onChange={setQuality}
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'standard', label: 'Standard' },
              { value: 'final', label: 'Final' },
            ]}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen(open.size ? new Set() : new Set(TASK_ROLES))}
          >
            {open.size ? 'Hide details' : 'Show details'}
          </Button>
        </div>
      }
    >
      {!compact && (
        <div className="row wrap st-sim">
          <span className="field-label">Simulate a request that also contains</span>
          <ChipSet
            label="Simulated data"
            options={DATA_OPTIONS.filter((o) =>
              ['recorded-vocals', 'reference-audio', 'guide-audio', 'stems', 'lyrics', 'midi'].includes(
                o.value,
              ),
            )}
            value={extra}
            onChange={setExtra}
          />
        </div>
      )}
      <div className="st-table-wrap">
        <table className="table st-preview-table">
          <thead>
            <tr>
              <th style={{ width: 190 }}>Task</th>
              <th>Chosen provider</th>
              <th>Why</th>
              <th className="num">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <PreviewTableRow key={r.role} row={r} open={open.has(r.role)} onToggle={() => toggle(r.role)} />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function PreviewTableRow({ row, open, onToggle }: { row: PreviewRow; open: boolean; onToggle: () => void }) {
  const info = ROLE_INFO[row.role];
  const d = row.decision;
  return (
    <>
      <tr data-testid={`route-${row.role}`} className={d ? '' : 'st-route-none'}>
        <td>
          <div style={{ fontWeight: 600 }}>{info.label}</div>
          <div className="small dim">
            {info.capabilities.map((c) => CAPABILITY_INFO[c].label).join(' + ')}
          </div>
        </td>
        <td>
          {d ? (
            <div className="col" style={{ gap: 3 }}>
              <span className="row" style={{ gap: 6 }}>
                <strong className="st-route-name">{d.providerName}</strong>
                <LocationBadge location={d.location} />
              </span>
              {d.modelId && <span className="small mono dim">{d.modelId}</span>}
            </div>
          ) : (
            <span className="row" style={{ gap: 6 }}>
              <Icon name="alert" size={14} />
              <strong>No compatible provider</strong>
            </span>
          )}
        </td>
        <td>
          <div className="small">{d ? d.reasons.slice(0, 3).join(' · ') : row.error}</div>
          {row.excluded.length > 0 && (
            <button type="button" className="st-linkbtn small" onClick={onToggle} aria-expanded={open}>
              {open ? 'Hide' : `${row.excluded.length} excluded`}
              {d && d.alternatives.length
                ? ` · ${d.alternatives.length} alternative${d.alternatives.length > 1 ? 's' : ''}`
                : ''}
            </button>
          )}
          {open && (
            <ul className="st-excluded">
              {d?.alternatives.map((a) => (
                <li key={`alt-${a.providerId}`}>
                  <span className="ok">✓</span> <strong>{a.providerName}</strong> — eligible, score{' '}
                  {a.score.toFixed(2)} ({a.reasons.join(', ')})
                </li>
              ))}
              {row.excluded.map((x) => (
                <li key={x.providerId} data-testid="excluded-provider">
                  <span className="no">✗</span> <strong>{x.providerName}</strong> — {x.reasons.join('; ')}
                </li>
              ))}
            </ul>
          )}
        </td>
        <td className="num nowrap">
          {d ? (d.estimate.known && d.estimate.maxUsd === 0 ? 'free' : formatCostRange(d.estimate)) : '—'}
        </td>
      </tr>
    </>
  );
}
