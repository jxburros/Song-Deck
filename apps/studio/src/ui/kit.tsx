import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

type Variant = 'default' | 'primary' | 'ai' | 'danger' | 'success' | 'ghost';

export function Button({
  variant = 'default',
  size,
  icon,
  active,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'lg';
  icon?: IconName;
  active?: boolean;
}) {
  const cls = [
    'btn',
    variant !== 'default' ? variant : '',
    size ?? '',
    !children && icon ? 'icon' : '',
    active ? 'active' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className}`}>
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  size,
  mono,
  type = 'text',
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  size?: 'sm';
  mono?: boolean;
  type?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size'>) {
  return (
    <input
      className={`input ${size ?? ''} ${mono ? 'mono' : ''}`}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  size,
  ...rest
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: 'sm';
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'size' | 'min' | 'max' | 'step'
>) {
  return (
    <input
      className={`input mono ${size ?? ''}`}
      type="number"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
      }}
      {...rest}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  ...rest
}: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number } & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
>) {
  return (
    <textarea
      className="textarea"
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  size,
  ...rest
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly ({ value: T; label: string; disabled?: boolean } | T)[];
  size?: 'sm';
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'size'>) {
  return (
    <select
      className={`select ${size ?? ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      {...rest}
    >
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <option key={opt.value} value={opt.value} disabled={(opt as { disabled?: boolean }).disabled}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  left,
  right,
  format,
  accent,
  onCommit,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: ReactNode;
  left?: string;
  right?: string;
  format?: (v: number) => string;
  accent?: boolean;
  /** Called on pointer release (commit point for undo history). */
  onCommit?: (v: number) => void;
  /** Accessible name for the range input (defaults to a plain-text `label`). */
  ariaLabel?: string;
}) {
  return (
    <div className="field">
      {(label || format) && (
        <div className="row between">
          {label && <span className="field-label">{label}</span>}
          {format && <span className="mono small muted">{format(value)}</span>}
        </div>
      )}
      <input
        type="range"
        className={`slider ${accent ? 'accent' : ''}`}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        aria-valuetext={format ? format(value) : undefined}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
      />
      {(left || right) && (
        <div className="row between small dim">
          <span>{left}</span>
          <span>{right}</span>
        </div>
      )}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  label,
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  title?: string;
}) {
  return (
    <label className="row toggle-label" style={{ cursor: 'pointer' }} title={title}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`toggle ${on ? 'on' : ''}`}
        onClick={() => onChange(!on)}
      />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: readonly { value: T; label: ReactNode; icon?: IconName; title?: string }[];
  className?: string;
}) {
  return (
    <div className={`tabs ${className}`} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          title={t.title}
          className={`tab ${t.value === value ? 'active' : ''}`}
          onClick={() => onChange(t.value)}
        >
          {t.icon && <Icon name={t.icon} size={14} />}
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone?: 'accent' | 'ai' | 'success' | 'danger' | 'warning';
  title?: string;
}) {
  return (
    <span className={`badge ${tone ?? ''}`} title={title}>
      {children}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  icon,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  icon?: IconName;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" ref={ref} tabIndex={-1}>
        <div className="modal-header">
          {icon && <Icon name={icon} />}
          <h2 className="grow">{title}</h2>
          <Button variant="ghost" icon="close" onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Progress({ value, ai }: { value: number; ai?: boolean }) {
  return (
    <div className={`progress ${ai ? 'ai' : ''}`}>
      <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Working" />;
}

export function LockButton({
  locked,
  onToggle,
  title,
}: {
  locked: boolean;
  onToggle: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`lock-btn ${locked ? 'locked' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={title ?? (locked ? 'Locked — click to unlock' : 'Unlocked — click to lock')}
      aria-pressed={locked}
    >
      <Icon name={locked ? 'lock' : 'unlock'} size={13} />
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <Icon name={icon} size={32} />}
      <h2>{title}</h2>
      {children && <div style={{ maxWidth: 520 }}>{children}</div>}
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
  icon,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-header">
        {icon && <Icon name={icon} />}
        <h3 className="grow">{title}</h3>
        {actions}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

export function Kv({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Meter({ db, height = 80 }: { db: number; height?: number }) {
  const pct = Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <div className="meter" style={{ height }}>
      <div style={{ height: `${pct * 100}%` }} />
    </div>
  );
}

/** File picker button. */
export function FileButton({
  accept,
  onFile,
  children,
  icon = 'upload',
  variant,
  multiple,
}: {
  accept?: string;
  onFile: (files: File[]) => void;
  children: ReactNode;
  icon?: IconName;
  variant?: Variant;
  multiple?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button icon={icon} variant={variant} onClick={() => ref.current?.click()}>
        {children}
      </Button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFile(files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Text input that only commits on blur/Enter (one revision per edit, not per keystroke). */
export function CommitText({
  value,
  onCommit,
  size,
  mono,
  placeholder,
  ...rest
}: { value: string; onCommit: (v: string) => void; size?: 'sm'; mono?: boolean; placeholder?: string } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'size'
>) {
  const [draft, setDraft] = useStateCompat(value);
  return (
    <input
      className={`input ${size ?? ''} ${mono ? 'mono' : ''}`}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
      {...rest}
    />
  );
}

/** Number input that commits on blur/Enter. */
export function CommitNumber({
  value,
  onCommit,
  min,
  max,
  step = 1,
  size,
  ...rest
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: 'sm';
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'size' | 'min' | 'max' | 'step'
>) {
  const [draft, setDraft] = useStateCompat(String(value));
  const commit = () => {
    const v = parseFloat(draft);
    if (!Number.isFinite(v)) return setDraft(String(value));
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    if (clamped !== value) onCommit(clamped);
    setDraft(String(clamped));
  };
  return (
    <input
      className={`input mono ${size ?? ''}`}
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      {...rest}
    />
  );
}

/** useState that resets when the upstream value changes (controlled-with-draft pattern). */
function useStateCompat<T>(upstream: T): [T, (v: T) => void] {
  const [state, setState] = useState(upstream);
  const prev = useRef(upstream);
  if (prev.current !== upstream) {
    prev.current = upstream;
    if (state !== upstream) setState(upstream);
  }
  return [state, setState];
}
