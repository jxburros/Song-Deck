/**
 * Budgets (spec §60): per-generation, daily and monthly limits with a warning threshold, plus
 * optional per-provider budgets from ProviderConfig.budget. Spend is recorded after each call.
 */
import type { ProviderBudget } from './config';
import { type CostEstimate, formatUsd } from './cost';
import type { TaskRole } from './types';

export interface BudgetLimits {
  perGenerationUsd?: number;
  dailyUsd?: number;
  monthlyUsd?: number;
  /** Fraction (0..1) of a daily/monthly limit at which to warn (default 0.8). */
  warningThreshold: number;
}

export interface SpendEntry {
  /** ISO timestamp. */
  at: string;
  providerId: string;
  providerName?: string;
  modelId?: string;
  role?: TaskRole;
  costUsd: number;
  /** True when the provider reported no actual cost and the estimate was recorded. */
  estimated?: boolean;
  note?: string;
}

export interface BudgetPersistence {
  load(): SpendEntry[] | Promise<SpendEntry[]>;
  save(entries: SpendEntry[]): void | Promise<void>;
}

export class MemoryBudgetPersistence implements BudgetPersistence {
  entries: SpendEntry[] = [];
  constructor(initial: SpendEntry[] = []) {
    this.entries = [...initial];
  }
  load(): SpendEntry[] {
    return [...this.entries];
  }
  save(entries: SpendEntry[]): void {
    this.entries = [...entries];
  }
}

export interface BudgetCheck {
  allowed: boolean;
  warning?: string;
  /** Why the request is not allowed (or empty). */
  reasons: string[];
  projected: { dailyUsd: number; monthlyUsd: number };
}

export interface BudgetTotals {
  todayUsd: number;
  monthUsd: number;
  totalUsd: number;
  byProvider: Record<string, { todayUsd: number; monthUsd: number; totalUsd: number }>;
  entries: number;
}

export interface BudgetManagerOptions {
  now?: () => number;
  /** Day/month boundaries in local time (default) or UTC. */
  timeZone?: 'local' | 'utc';
  /** Drop entries older than this many days when saving (default 400). */
  retainDays?: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = { warningThreshold: 0.8 };

export class BudgetManager {
  private list: SpendEntry[] = [];
  private loaded: Promise<void>;
  private readonly now: () => number;

  constructor(
    private limitsValue: BudgetLimits = DEFAULT_BUDGET_LIMITS,
    private readonly persistence?: BudgetPersistence,
    private readonly opts: BudgetManagerOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.loaded = Promise.resolve(persistence?.load())
      .then((entries) => {
        if (Array.isArray(entries)) this.list = [...entries, ...this.list];
      })
      .catch(() => undefined);
  }

  /** Resolves once persisted entries are loaded. */
  ready(): Promise<void> {
    return this.loaded;
  }

  get limits(): BudgetLimits {
    return this.limitsValue;
  }

  setLimits(limits: BudgetLimits): void {
    this.limitsValue = limits;
  }

  entries(): SpendEntry[] {
    return [...this.list];
  }

  private dayKey(t: number): string {
    const d = new Date(t);
    return this.opts.timeZone === 'utc'
      ? d.toISOString().slice(0, 10)
      : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  private monthKey(t: number): string {
    const d = new Date(t);
    return this.opts.timeZone === 'utc'
      ? d.toISOString().slice(0, 7)
      : `${d.getFullYear()}-${d.getMonth() + 1}`;
  }

  totals(): BudgetTotals {
    const now = this.now();
    const day = this.dayKey(now);
    const month = this.monthKey(now);
    const out: BudgetTotals = {
      todayUsd: 0,
      monthUsd: 0,
      totalUsd: 0,
      byProvider: {},
      entries: this.list.length,
    };
    for (const e of this.list) {
      const t = Date.parse(e.at);
      if (!Number.isFinite(t)) continue;
      const p = (out.byProvider[e.providerId] ??= { todayUsd: 0, monthUsd: 0, totalUsd: 0 });
      out.totalUsd += e.costUsd;
      p.totalUsd += e.costUsd;
      if (this.monthKey(t) === month) {
        out.monthUsd += e.costUsd;
        p.monthUsd += e.costUsd;
        if (this.dayKey(t) === day) {
          out.todayUsd += e.costUsd;
          p.todayUsd += e.costUsd;
        }
      }
    }
    return out;
  }

  /**
   * Check an estimate against the limits. Unknown cost is allowed with a warning when limits are
   * set (the cost cannot be verified).
   */
  check(
    estimate: CostEstimate,
    ctx: { providerId?: string; providerBudget?: ProviderBudget } = {},
  ): BudgetCheck {
    const limits = this.limitsValue;
    const threshold =
      limits.warningThreshold > 0 && limits.warningThreshold <= 1 ? limits.warningThreshold : 0.8;
    const totals = this.totals();
    const cost = estimate.known ? estimate.maxUsd : 0;
    const reasons: string[] = [];
    const warnings: string[] = [];
    const projected = { dailyUsd: totals.todayUsd + cost, monthlyUsd: totals.monthUsd + cost };
    const anyLimit =
      limits.perGenerationUsd !== undefined ||
      limits.dailyUsd !== undefined ||
      limits.monthlyUsd !== undefined ||
      !!ctx.providerBudget;

    const checkLimits = (scope: string, l: ProviderBudget, today: number, month: number) => {
      if (l.perGenerationUsd !== undefined && cost > l.perGenerationUsd)
        reasons.push(
          `${scope}estimated ${formatUsd(cost)} exceeds the per-generation limit ${formatUsd(l.perGenerationUsd)}`,
        );
      if (l.dailyUsd !== undefined) {
        if (today + cost > l.dailyUsd)
          reasons.push(
            `${scope}daily limit ${formatUsd(l.dailyUsd)} would be exceeded (spent ${formatUsd(today)} today)`,
          );
        else if (cost > 0 && today + cost >= threshold * l.dailyUsd)
          warnings.push(
            `${scope}daily spend would reach ${formatUsd(today + cost)} of ${formatUsd(l.dailyUsd)} (${Math.round(((today + cost) / l.dailyUsd) * 100)}%)`,
          );
      }
      if (l.monthlyUsd !== undefined) {
        if (month + cost > l.monthlyUsd)
          reasons.push(
            `${scope}monthly limit ${formatUsd(l.monthlyUsd)} would be exceeded (spent ${formatUsd(month)} this month)`,
          );
        else if (cost > 0 && month + cost >= threshold * l.monthlyUsd)
          warnings.push(
            `${scope}monthly spend would reach ${formatUsd(month + cost)} of ${formatUsd(l.monthlyUsd)} (${Math.round(((month + cost) / l.monthlyUsd) * 100)}%)`,
          );
      }
    };
    checkLimits('', limits, totals.todayUsd, totals.monthUsd);
    if (ctx.providerBudget && ctx.providerId) {
      const p = totals.byProvider[ctx.providerId] ?? { todayUsd: 0, monthUsd: 0, totalUsd: 0 };
      checkLimits(`${ctx.providerId}: `, ctx.providerBudget, p.todayUsd, p.monthUsd);
    }
    if (!estimate.known && anyLimit)
      warnings.push('Cost is unknown for this provider — budget limits cannot be verified');
    const result: BudgetCheck = { allowed: reasons.length === 0, reasons, projected };
    if (warnings.length) result.warning = warnings.join('; ');
    return result;
  }

  /** Record spend (actual cost when known, otherwise the estimate). */
  record(entry: Omit<SpendEntry, 'at'> & { at?: string }): SpendEntry {
    const e: SpendEntry = {
      ...entry,
      at: entry.at ?? new Date(this.now()).toISOString(),
      costUsd: Math.max(0, entry.costUsd),
    };
    this.list.push(e);
    const retain = (this.opts.retainDays ?? 400) * 86_400_000;
    const cutoff = this.now() - retain;
    this.list = this.list.filter((x) => Date.parse(x.at) >= cutoff);
    void Promise.resolve(this.persistence?.save(this.list)).catch(() => undefined);
    return e;
  }

  reset(): void {
    this.list = [];
    void Promise.resolve(this.persistence?.save([])).catch(() => undefined);
  }
}
