import { useEffect, useMemo, useState } from 'react';
import { ROLE_INFO, type BudgetLimits, type BudgetTotals, type SpendEntry } from '@songdeck/ai';
import { useSettings } from '../../state/settings';
import { getBudget, initAi, useAiRuntime } from '../../engine/ai';
import { Button, Field, Slider, Toggle } from '../../ui/kit';
import { ConfirmModal, Empty, Meter, OptNumber, Panel, Stat, TabHeader, downloadJson, usd } from './ui';

/** Cost awareness (spec §60): per-generation / daily / monthly limits, warning threshold, spend ledger. */

type LimitKey = 'perGenerationUsd' | 'dailyUsd' | 'monthlyUsd';

const LIMITS: { key: LimitKey; label: string; hint: string; step: number; fallback: number }[] = [
  {
    key: 'perGenerationUsd',
    label: 'Per generation',
    hint: 'Requests estimated above this are blocked before they are sent.',
    step: 0.1,
    fallback: 2,
  },
  { key: 'dailyUsd', label: 'Daily', hint: 'Spend since midnight (local time).', step: 1, fallback: 10 },
  { key: 'monthlyUsd', label: 'Monthly', hint: 'Spend this calendar month.', step: 5, fallback: 50 },
];

export default function BudgetTab() {
  const budget = useSettings((s) => s.budget);
  const providers = useSettings((s) => s.providers);
  const update = useSettings((s) => s.update);
  const version = useAiRuntime((s) => s.version);
  const events = useAiRuntime((s) => s.events.length);
  const summaries = useAiRuntime((s) => s.providers);
  const [entries, setEntries] = useState<SpendEntry[]>([]);
  const [totals, setTotals] = useState<BudgetTotals | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    initAi();
    const b = getBudget();
    let alive = true;
    void b.ready().then(() => {
      if (!alive) return;
      setEntries(b.entries());
      setTotals(b.totals());
    });
    return () => {
      alive = false;
    };
  }, [version, events, n]);

  const setLimits = (next: BudgetLimits) => {
    update({ budget: next });
    getBudget().setLimits(next);
  };
  const threshold =
    budget.warningThreshold > 0 && budget.warningThreshold <= 1 ? budget.warningThreshold : 0.8;
  const names = useMemo(
    () =>
      new Map([
        ...summaries.map((s) => [s.id, s.name] as const),
        ...providers.map((p) => [p.id, p.name] as const),
      ]),
    [summaries, providers],
  );
  const ledger = [...entries].reverse();
  const tone = (spent: number, limit?: number) =>
    limit === undefined
      ? undefined
      : spent >= limit
        ? 'danger'
        : spent >= threshold * limit
          ? 'warning'
          : undefined;

  return (
    <>
      <TabHeader
        icon="tasks"
        title="Spending"
        lede="Cloud models report estimated cost before a request and actual cost after it. Limits are checked before anything is sent; local and on-device work is always free."
        actions={
          <Button
            icon="download"
            onClick={() =>
              downloadJson(`songdeck-spend-${new Date().toISOString().slice(0, 10)}.json`, entries)
            }
            disabled={!entries.length}
          >
            Export ledger
          </Button>
        }
      />

      <div className="st-stats" data-testid="budget-totals">
        <Stat
          label="Today"
          value={usd(totals?.todayUsd ?? 0)}
          sub={budget.dailyUsd !== undefined ? `of ${usd(budget.dailyUsd)}` : 'no daily limit'}
          tone={tone(totals?.todayUsd ?? 0, budget.dailyUsd)}
        />
        <Stat
          label="This month"
          value={usd(totals?.monthUsd ?? 0)}
          sub={budget.monthlyUsd !== undefined ? `of ${usd(budget.monthlyUsd)}` : 'no monthly limit'}
          tone={tone(totals?.monthUsd ?? 0, budget.monthlyUsd)}
        />
        <Stat
          label="All time"
          value={usd(totals?.totalUsd ?? 0)}
          sub={`${totals?.entries ?? 0} paid request${totals?.entries === 1 ? '' : 's'}`}
        />
        <Stat label="Warn at" value={`${Math.round(threshold * 100)}%`} sub="of a daily / monthly limit" />
      </div>
      <div className="st-two">
        <div className="col" style={{ gap: 4 }}>
          <span className="small muted">Today</span>
          <Meter value={totals?.todayUsd ?? 0} max={budget.dailyUsd} warnAt={threshold} />
        </div>
        <div className="col" style={{ gap: 4 }}>
          <span className="small muted">This month</span>
          <Meter value={totals?.monthUsd ?? 0} max={budget.monthlyUsd} warnAt={threshold} />
        </div>
      </div>

      <Panel
        title="Limits"
        icon="lock"
        sub="Turn a limit off to leave it unlimited. Unknown provider pricing is allowed with a warning, because it cannot be verified."
      >
        <div className="grid-3">
          {LIMITS.map((l) => {
            const on = budget[l.key] !== undefined;
            return (
              <div key={l.key} className="card st-limit">
                <div className="row between">
                  <strong>{l.label}</strong>
                  <Toggle
                    on={on}
                    onChange={(v) => setLimits({ ...budget, [l.key]: v ? l.fallback : undefined })}
                    title={on ? 'Remove limit' : 'Set limit'}
                  />
                </div>
                <Field hint={l.hint}>
                  <div className="row">
                    <span className="muted">$</span>
                    <OptNumber
                      value={budget[l.key]}
                      min={0}
                      step={l.step}
                      disabled={!on}
                      placeholder="unlimited"
                      onChange={(v) => setLimits({ ...budget, [l.key]: v })}
                      aria-label={`${l.label} limit`}
                    />
                  </div>
                </Field>
              </div>
            );
          })}
        </div>
        <Slider
          label="Warning threshold"
          value={threshold}
          min={0.5}
          max={1}
          step={0.05}
          onChange={(warningThreshold) => setLimits({ ...budget, warningThreshold })}
          format={(v) => `${Math.round(v * 100)}%`}
          left="warn early"
          right="only at the limit"
          accent
        />
      </Panel>

      {totals && Object.keys(totals.byProvider).length > 0 && (
        <Panel title="By provider" icon="plug">
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th className="num">Today</th>
                <th className="num">This month</th>
                <th className="num">All time</th>
                <th style={{ width: 180 }}>Provider budget</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(totals.byProvider).map(([id, t]) => {
                const pb = providers.find((p) => p.id === id)?.budget;
                return (
                  <tr key={id}>
                    <td>{names.get(id) ?? id}</td>
                    <td className="num">{usd(t.todayUsd)}</td>
                    <td className="num">{usd(t.monthUsd)}</td>
                    <td className="num">{usd(t.totalUsd)}</td>
                    <td>
                      {pb?.monthlyUsd ? (
                        <Meter value={t.monthUsd} max={pb.monthlyUsd} warnAt={threshold} />
                      ) : (
                        <span className="small dim">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel
        title="Spend ledger"
        icon="history"
        testId="spend-ledger"
        actions={
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            onClick={() => setConfirmReset(true)}
            disabled={!entries.length}
          >
            Reset
          </Button>
        }
      >
        {ledger.length === 0 ? (
          <Empty icon="tasks">
            Nothing spent yet. Requests to paid cloud providers appear here with their actual (or estimated)
            cost.
          </Empty>
        ) : (
          <div className="st-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Task</th>
                  <th className="num">Cost</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {ledger.slice(0, 200).map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td className="nowrap small">{new Date(e.at).toLocaleString()}</td>
                    <td>{e.providerName ?? names.get(e.providerId) ?? e.providerId}</td>
                    <td className="mono small">{e.modelId ?? '—'}</td>
                    <td>{e.role ? (ROLE_INFO[e.role]?.label ?? e.role) : '—'}</td>
                    <td className="num">
                      {usd(e.costUsd)}
                      {e.estimated && (
                        <span className="dim" title="Provider reported no usage; the estimate was recorded">
                          {' '}
                          est.
                        </span>
                      )}
                    </td>
                    <td className="small dim">{e.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {confirmReset && (
        <ConfirmModal
          title="Reset the spend ledger?"
          confirmLabel="Reset ledger"
          danger
          onClose={() => setConfirmReset(false)}
          onConfirm={() => {
            getBudget().reset();
            setConfirmReset(false);
            setN((x) => x + 1);
          }}
        >
          All recorded spend is deleted from this device and daily / monthly totals start from zero. Your
          providers’ own billing is not affected.
        </ConfirmModal>
      )}
    </>
  );
}
