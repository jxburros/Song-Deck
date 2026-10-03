import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CAPABILITY_INFO, type Capability, type ProviderLocation, type ProviderStatus } from '@songdeck/ai';
import { Badge, Button, Modal } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/icons';

/** Small building blocks shared by the settings tabs. */

export function TabHeader({
  icon,
  title,
  lede,
  actions,
  spec,
}: {
  icon: IconName;
  title: string;
  lede: ReactNode;
  actions?: ReactNode;
  spec?: string;
}) {
  return (
    <header className="st-head">
      <div className="st-head-icon">
        <Icon name={icon} size={20} />
      </div>
      <div className="grow">
        <h1>
          {title}
          {spec && <span className="st-spec">{spec}</span>}
        </h1>
        <div className="lede">{lede}</div>
      </div>
      {actions && <div className="st-head-actions">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  icon,
  sub,
  actions,
  children,
  id,
  className = '',
  testId,
}: {
  title: ReactNode;
  icon?: IconName;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      className={`panel st-panel ${className}`}
      id={id}
      data-testid={testId}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <div className="panel-header">
        {icon && <Icon name={icon} />}
        <div className="grow" style={{ minWidth: 0 }}>
          <h3>{title}</h3>
        </div>
        {actions}
      </div>
      <div className="panel-body">
        {sub && <div className="st-sub">{sub}</div>}
        {children}
      </div>
    </section>
  );
}

export function Row({
  name,
  detail,
  children,
  className = '',
}: {
  name: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`st-row ${className}`}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="st-row-name">{name}</div>
        {detail && <div className="small dim st-row-detail">{detail}</div>}
      </div>
      {children && <div className="st-row-actions">{children}</div>}
    </div>
  );
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | undefined> = {
  ready: 'success',
  unconfigured: 'warning',
  error: 'danger',
  offline: 'danger',
};

const STATUS_LABEL: Record<string, string> = {
  ready: 'Ready',
  unconfigured: 'Needs setup',
  error: 'Error',
  offline: 'Unreachable',
  disabled: 'Disabled',
};

export function StatusPill({
  status,
  title,
  label,
}: {
  status: ProviderStatus | 'disabled';
  title?: string;
  label?: string;
}) {
  return (
    <span className={`st-status ${status}`} title={title}>
      <span
        className={`status-dot ${STATUS_TONE[status] === 'success' ? 'ok' : STATUS_TONE[status] === 'warning' ? 'warn' : STATUS_TONE[status] === 'danger' ? 'err' : ''}`}
      />
      {label ?? STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function LocationBadge({ location }: { location: ProviderLocation }) {
  if (location === 'cloud')
    return (
      <Badge tone="warning" title="Requests leave this device">
        <Icon name="cloud" size={11} /> Cloud
      </Badge>
    );
  if (location === 'local')
    return (
      <Badge tone="success" title="Runs on this machine or your network">
        <Icon name="cpu" size={11} /> Local
      </Badge>
    );
  return (
    <Badge tone="ai" title="Song Deck's deterministic engine — offline and free">
      <Icon name="shield" size={11} /> On-device
    </Badge>
  );
}

export function CapBadges({
  caps,
  max = 6,
  inferred,
}: {
  caps: readonly Capability[] | readonly string[];
  max?: number;
  inferred?: boolean;
}) {
  const list = caps as readonly string[];
  const shown = list.slice(0, max);
  return (
    <span className="st-caps">
      {shown.map((c) => (
        <span
          key={c}
          className={`st-cap ${inferred ? 'inferred' : ''}`}
          title={CAPABILITY_INFO[c as Capability]?.description ?? c}
        >
          {CAPABILITY_INFO[c as Capability]?.label ?? c}
        </span>
      ))}
      {list.length > max && (
        <span
          className="st-cap more"
          title={list
            .slice(max)
            .map((c) => CAPABILITY_INFO[c as Capability]?.label ?? c)
            .join(', ')}
        >
          +{list.length - max}
        </span>
      )}
    </span>
  );
}

/** Multi-select chips. */
export function ChipSet<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: readonly { value: T; label: string; title?: string }[];
  value: readonly T[];
  onChange: (v: T[]) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="chip-list" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={`chip ${on ? 'on' : ''}`}
            aria-pressed={on}
            title={o.title}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
          >
            {on && <Icon name="check" size={12} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented single choice. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`st-seg-btn ${o.value === value ? 'on' : ''}`}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'warning' | 'danger' | 'success';
}) {
  return (
    <div className={`st-stat ${tone ?? ''}`}>
      <div className="st-stat-label">{label}</div>
      <div className="st-stat-value">{value}</div>
      {sub && <div className="st-stat-sub">{sub}</div>}
    </div>
  );
}

export function Meter({ value, max, warnAt }: { value: number; max?: number; warnAt?: number }) {
  if (!max || max <= 0) return null;
  const frac = Math.max(0, Math.min(1, value / max));
  const tone = frac >= 1 ? 'danger' : warnAt !== undefined && frac >= warnAt ? 'warning' : '';
  return (
    <div
      className={`st-meter ${tone}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div style={{ width: `${frac * 100}%` }} />
    </div>
  );
}

export function usd(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0.00';
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function bytesLabel(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function timeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Download a JSON document. */
export function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function readJsonFile<T>(file: File): Promise<T> {
  const text = await file.text();
  return JSON.parse(text) as T;
}

/** Confirmation modal for destructive actions. */
export function ConfirmModal({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  requireText,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  /** User must type this text to enable the confirm button. */
  requireText?: string;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = !requireText || typed.trim() === requireText;
  return (
    <Modal
      title={title}
      icon={danger ? 'alert' : 'info'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="col">
        {children}
        {requireText && (
          <label className="field">
            <span className="field-label">Type {requireText} to confirm</span>
            <input
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={`Type ${requireText} to confirm`}
              autoFocus
            />
          </label>
        )}
      </div>
    </Modal>
  );
}

/** Highlight + scroll into view when `active` (deep links). */
export function useFocusRef<T extends HTMLElement>(active: boolean): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ref.current.classList.add('st-flash');
    const t = setTimeout(() => ref.current?.classList.remove('st-flash'), 1600);
    return () => clearTimeout(t);
  }, [active]);
  return ref;
}

/** Re-render every `ms` (relative times, countdowns). */
export function useTicker(ms: number, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return n;
}

/** Number input where blank means "not set" (undefined). */
export function OptNumber({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  size,
  scale = 1,
  ...rest
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  size?: 'sm';
  /** Display = value / scale (e.g. ms shown as seconds with scale 1000). */
  scale?: number;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'size' | 'min' | 'max' | 'step'
>) {
  const shown = value === undefined ? '' : String(Math.round((value / scale) * 1e6) / 1e6);
  const [draft, setDraft] = useState(shown);
  const last = useRef(shown);
  if (last.current !== shown) {
    last.current = shown;
    if (draft.trim() === '' ? value !== undefined : Number(draft) * scale !== value) setDraft(shown);
  }
  return (
    <input
      className={`input mono ${size ?? ''}`}
      type="number"
      inputMode="decimal"
      value={draft}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw.trim() === '') return onChange(undefined);
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
        onChange(clamped * scale);
      }}
      onBlur={() => setDraft(shown)}
      {...rest}
    />
  );
}

export function Empty({ icon = 'info', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="st-empty">
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}
