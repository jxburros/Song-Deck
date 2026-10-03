import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { FADER_TICKS, dbToPos, fmtDb, posToDb } from './mixModel';

/**
 * Mixer controls: vertical dB fader and rotary knob. Both are ARIA sliders (keyboard: arrows,
 * Shift for fine steps, PageUp/PageDown for coarse steps; double-click resets), preview while
 * dragging (`onPreview`) and commit once on release (`onCommit`).
 */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------------------
// Fader
// ---------------------------------------------------------------------------

export function Fader({
  value,
  onPreview,
  onCommit,
  onKeyCommit,
  label,
  disabled,
  height = 188,
  resetDb = 0,
  min = -96,
  max = 12,
}: {
  value: number;
  onPreview: (db: number) => void;
  onCommit: () => void;
  /** Commit used for keyboard nudges (usually debounced). Defaults to onCommit. */
  onKeyCommit?: () => void;
  label: string;
  disabled?: boolean;
  height?: number;
  resetDb?: number;
  min?: number;
  max?: number;
}) {
  const THUMB = 28;
  const usable = height - THUMB;
  const drag = useRef<{ lastY: number; pos: number } | null>(null);
  const pos = dbToPos(value);
  const round = (db: number) => (db <= -90 ? -96 : Math.round(Math.min(max, Math.max(min, db)) * 10) / 10);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.focus();
    const rect = el.getBoundingClientRect();
    let p = pos;
    if (!(e.target as HTMLElement).closest('.mx-fader-thumb')) {
      p = clamp01(1 - (e.clientY - rect.top - THUMB / 2) / usable);
      onPreview(round(posToDb(p)));
    }
    drag.current = { lastY: e.clientY, pos: p };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const scale = e.shiftKey ? 0.2 : 1;
    d.pos = clamp01(d.pos - ((e.clientY - d.lastY) * scale) / usable);
    d.lastY = e.clientY;
    onPreview(round(posToDb(d.pos)));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    onCommit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const fine = e.shiftKey ? 0.1 : 0.5;
    const base = value <= -90 ? -60 : value;
    let next: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = base + fine;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = value <= -60 ? -96 : base - fine;
    else if (e.key === 'PageUp') next = base + 3;
    else if (e.key === 'PageDown') next = value <= -60 ? -96 : base - 3;
    else if (e.key === '0') next = resetDb;
    if (next === null) return;
    e.preventDefault();
    onPreview(round(next));
    (onKeyCommit ?? onCommit)();
  };

  return (
    <div className={`mx-fader ${disabled ? 'disabled' : ''}`} style={{ height }}>
      <div className="mx-fader-scale" aria-hidden>
        {FADER_TICKS.map((t) => (
          <span key={t} className={t === 0 ? 'unity' : ''} style={{ bottom: THUMB / 2 + dbToPos(t) * usable - 6 }}>
            {t > 0 ? `+${t}` : t === 0 ? '0' : `${t}`.replace('-', '−')}
          </span>
        ))}
      </div>
      <div
        className="mx-fader-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 10) / 10}
        aria-valuetext={`${fmtDb(value)} dB`}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          if (disabled) return;
          onPreview(resetDb);
          onCommit();
        }}
        title={disabled ? 'Locked' : 'Drag (Shift = fine) · double-click = 0 dB · arrows nudge'}
      >
        <div className="mx-fader-groove" />
        <div className="mx-fader-fill" style={{ bottom: THUMB / 2, height: pos * usable }} />
        <div className="mx-fader-thumb" style={{ bottom: pos * usable }}>
          <i />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knob
// ---------------------------------------------------------------------------

const START = -135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.01) return '';
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function Knob({
  value,
  min,
  max,
  defaultValue,
  onPreview,
  onCommit,
  onKeyCommit,
  label,
  ariaLabel,
  format,
  bipolar,
  log,
  disabled,
  size = 30,
  tone = 'accent',
  step,
}: {
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onPreview: (v: number) => void;
  onCommit: () => void;
  onKeyCommit?: () => void;
  /** Short visible caption under the knob. */
  label: string;
  ariaLabel: string;
  format: (v: number) => string;
  bipolar?: boolean;
  log?: boolean;
  disabled?: boolean;
  size?: number;
  tone?: 'accent' | 'ai' | 'muted';
  /** Value quantization (linear knobs). */
  step?: number;
}) {
  const [active, setActive] = useState(false);
  const drag = useRef<{ x: number; y: number; n: number } | null>(null);
  const norm = (v: number) => (log ? Math.log(Math.max(min, v) / min) / Math.log(max / min) : (v - min) / (max - min));
  const denorm = (n: number) => {
    const t = clamp01(n);
    let v = log ? min * Math.pow(max / min, t) : min + t * (max - min);
    if (step) v = Math.round(v / step) * step;
    else if (log) v = v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
    else v = Math.round(v * 1000) / 1000;
    return Math.min(max, Math.max(min, v));
  };
  const n = clamp01(norm(value));
  const angle = START + n * SWEEP;
  const zeroN = bipolar ? clamp01(norm(log ? Math.sqrt(min * max) : (min + max) / 2)) : 0;
  const zeroAngle = START + zeroN * SWEEP;
  const c = size / 2;
  const r = size / 2 - 3;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, n };
    setActive(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const scale = e.shiftKey ? 720 : 170;
    d.n = clamp01(d.n + (e.clientX - d.x - (e.clientY - d.y)) / scale);
    d.x = e.clientX;
    d.y = e.clientY;
    onPreview(denorm(d.n));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
    onCommit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const inc = e.shiftKey ? 0.005 : 0.02;
    let next: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = n + inc;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = n - inc;
    else if (e.key === 'PageUp') next = n + 0.1;
    else if (e.key === 'PageDown') next = n - 0.1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    if (next === null) return;
    e.preventDefault();
    onPreview(denorm(next));
    (onKeyCommit ?? onCommit)();
  };

  useEffect(() => () => void (drag.current = null), []);

  return (
    <div className={`mx-knob ${disabled ? 'disabled' : ''} ${active ? 'active' : ''}`}>
      <div
        className="mx-knob-dial"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={format(value)}
        aria-disabled={disabled || undefined}
        title={`${ariaLabel}: ${format(value)}${disabled ? ' (locked)' : ' · drag · double-click resets'}`}
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          if (disabled) return;
          onPreview(defaultValue);
          onCommit();
        }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <path d={arc(c, c, r, START, START + SWEEP)} className="mx-knob-track" />
          <path d={bipolar ? arc(c, c, r, Math.min(zeroAngle, angle), Math.max(zeroAngle, angle)) : arc(c, c, r, START, angle)} className={`mx-knob-value ${tone}`} />
          <circle cx={c} cy={c} r={r - 4} className="mx-knob-cap" />
          {(() => {
            const [x0, y0] = polar(c, c, r * 0.18, angle);
            const [x1, y1] = polar(c, c, r - 4.5, angle);
            return <line x1={x0} y1={y0} x2={x1} y2={y1} className="mx-knob-pointer" />;
          })()}
        </svg>
      </div>
      <div className="mx-knob-label">
        <span className="name">{label}</span>
        <span className="val">{format(value)}</span>
      </div>
    </div>
  );
}
