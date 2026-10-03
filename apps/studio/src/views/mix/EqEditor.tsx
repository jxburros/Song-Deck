import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { defaultEq, type EqSettings } from '@songdeck/core';
import { useElementSize } from '../../hooks';
import { Toggle } from '../../ui/kit';
import { alpha, cssVar, useThemeName } from '../../ui/theme';
import { Knob } from './controls';
import { BANDS, bandActive, bandResponse, eqResponse, freqToX, logFreqs, roundFreq, xToFreq, type BandSpec } from './eqMath';
import { fmtDb, fmtHz, fmtHzUnit } from './mixModel';

/**
 * EQ: a frequency-response curve drawn from the RBJ formulas the engine uses, with draggable
 * band nodes (drag = frequency/gain, wheel = Q, double-click = reset band) and a knob row for
 * precise, keyboard-accessible control of every band.
 */

const DISPLAY_DB = 18;

function setupCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/** Tiny EQ curve for channel strips. */
export function EqThumb({ eq, width = 72, height = 26, onClick, label }: { eq: EqSettings; width?: number; height?: number; onClick?: () => void; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const freqs = useMemo(() => logFreqs(48), []);
  const theme = useThemeName();
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = setupCanvas(c, width, height);
    if (!ctx) return;
    const resp = eqResponse(eq, freqs);
    const mid = height / 2;
    ctx.strokeStyle = cssVar('--border-strong');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(width, mid + 0.5);
    ctx.stroke();
    ctx.strokeStyle = eq.enabled ? cssVar('--accent') : cssVar('--text-dim');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < freqs.length; i++) {
      const x = (i / (freqs.length - 1)) * (width - 2) + 1;
      const y = mid - (Math.max(-DISPLAY_DB, Math.min(DISPLAY_DB, resp[i])) / DISPLAY_DB) * (mid - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [eq, width, height, freqs, theme]);
  return (
    <button type="button" className={`mx-eq-thumb ${eq.enabled ? '' : 'off'}`} onClick={onClick} title={`${label} — open EQ`} aria-label={`${label} EQ (open editor)`}>
      <canvas ref={ref} width={width} height={height} aria-hidden />
    </button>
  );
}

interface DragState {
  band: BandSpec;
  pointerId: number;
}

export function EqEditor({
  eq,
  onPreview,
  onCommit,
  onCommitSoon,
  disabled,
  height = 210,
  title,
}: {
  eq: EqSettings;
  onPreview: (next: EqSettings) => void;
  onCommit: () => void;
  /** Debounced commit (wheel / keyboard). */
  onCommitSoon: () => void;
  disabled?: boolean;
  height?: number;
  title: string;
}) {
  const [hostRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const theme = useThemeName();
  const width = Math.max(240, size.width);
  const PAD_L = 30;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 18;
  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;
  const yOf = (db: number) => PAD_T + plotH / 2 - (Math.max(-DISPLAY_DB, Math.min(DISPLAY_DB, db)) / DISPLAY_DB) * (plotH / 2);
  const dbOf = (y: number) => ((PAD_T + plotH / 2 - y) / (plotH / 2)) * DISPLAY_DB;
  const freqs = useMemo(() => logFreqs(Math.max(64, Math.round(plotW / 2))), [plotW]);

  const nodePos = (b: BandSpec): { x: number; y: number; on: boolean } => {
    const f = eq[b.freqKey] as number;
    if (b.type === 'highpass' || b.type === 'lowpass') {
      const on = f > 10;
      const ff = on ? f : b.type === 'highpass' ? 20 : 20000;
      return { x: freqToX(ff, PAD_L, plotW), y: yOf(0), on };
    }
    const g = (eq[b.gainKey!] as number) ?? 0;
    return { x: freqToX(f, PAD_L, plotW), y: yOf(g), on: Math.abs(g) > 0.01 };
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || size.width === 0) return;
    const ctx = setupCanvas(c, width, height);
    if (!ctx) return;
    const grid = cssVar('--grid-line');
    const gridStrong = cssVar('--grid-bar');
    const dim = cssVar('--text-dim');
    const accent = cssVar('--accent');
    ctx.fillStyle = cssVar('--bg-input');
    ctx.fillRect(PAD_L, PAD_T, plotW, plotH);
    ctx.font = `10px ${cssVar('--font-mono')}`;
    ctx.textBaseline = 'middle';
    // Frequency grid.
    const majors = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    for (let dec = 10; dec <= 10000; dec *= 10) {
      for (let m = 1; m < 10; m++) {
        const f = dec * m;
        if (f < 20 || f > 20000) continue;
        const x = Math.round(freqToX(f, PAD_L, plotW)) + 0.5;
        ctx.strokeStyle = majors.includes(f) ? gridStrong : grid;
        ctx.globalAlpha = majors.includes(f) ? 0.55 : 1;
        ctx.beginPath();
        ctx.moveTo(x, PAD_T);
        ctx.lineTo(x, PAD_T + plotH);
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (majors.includes(f)) {
          ctx.fillStyle = dim;
          ctx.textAlign = 'center';
          ctx.fillText(fmtHz(f), x, height - 8);
        }
      }
    }
    // Gain grid.
    for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.strokeStyle = db === 0 ? gridStrong : grid;
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(PAD_L + plotW, y);
      ctx.stroke();
      ctx.fillStyle = dim;
      ctx.textAlign = 'right';
      ctx.fillText(db > 0 ? `+${db}` : `${db}`.replace('-', '−'), PAD_L - 4, y);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_L, PAD_T, plotW, plotH);
    ctx.clip();
    // Focused band contribution.
    const focus = BANDS.find((b) => b.id === (dragging ?? hover));
    if (focus && bandActive(eq, focus)) {
      const r = bandResponse(eq, focus, freqs);
      ctx.strokeStyle = focus.color;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < freqs.length; i++) {
        const x = freqToX(freqs[i], PAD_L, plotW);
        const y = yOf(r[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // Total response.
    const resp = eqResponse(eq, freqs);
    const zeroY = yOf(0);
    ctx.beginPath();
    ctx.moveTo(PAD_L, zeroY);
    for (let i = 0; i < freqs.length; i++) ctx.lineTo(freqToX(freqs[i], PAD_L, plotW), yOf(resp[i]));
    ctx.lineTo(PAD_L + plotW, zeroY);
    ctx.closePath();
    ctx.fillStyle = eq.enabled ? alpha(accent, 0.13) : alpha(dim, 0.08);
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < freqs.length; i++) {
      const x = freqToX(freqs[i], PAD_L, plotW);
      const y = yOf(resp[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = eq.enabled ? accent : dim;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    // Nodes.
    for (const b of BANDS) {
      const p = nodePos(b);
      const focused = b.id === hover || b.id === dragging;
      ctx.beginPath();
      ctx.arc(p.x, p.y, focused ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = p.on && eq.enabled ? b.color : cssVar('--bg-elev-3');
      ctx.fill();
      ctx.lineWidth = focused ? 2 : 1.5;
      ctx.strokeStyle = b.color;
      ctx.stroke();
      if (focused) {
        const f = eq[b.freqKey] as number;
        const g = b.gainKey ? (eq[b.gainKey] as number) : 0;
        const text = b.type === 'highpass' || b.type === 'lowpass' ? `${b.short} ${f > 10 ? fmtHzUnit(f) : 'off'}` : `${b.short} ${fmtHzUnit(f)} ${fmtDb(g)} dB`;
        ctx.font = `11px ${cssVar('--font-ui')}`;
        const tw = ctx.measureText(text).width + 10;
        const tx = Math.min(PAD_L + plotW - tw, Math.max(PAD_L, p.x - tw / 2));
        const ty = p.y < PAD_T + 26 ? p.y + 12 : p.y - 26;
        ctx.fillStyle = cssVar('--bg-elev-3');
        ctx.fillRect(tx, ty, tw, 17);
        ctx.fillStyle = cssVar('--text');
        ctx.textAlign = 'left';
        ctx.fillText(text, tx + 5, ty + 9);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eq, width, height, size.width, hover, dragging, freqs, theme]);

  const hit = (x: number, y: number): BandSpec | null => {
    let best: BandSpec | null = null;
    let bestD = 12;
    for (const b of BANDS) {
      const p = nodePos(b);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const applyDrag = (b: BandSpec, x: number, y: number) => {
    const f = Math.min(b.maxHz, Math.max(b.minHz, roundFreq(xToFreq(x, PAD_L, plotW))));
    let next: EqSettings = { ...eq, enabled: true, [b.freqKey]: f };
    if (b.gainKey) {
      const g = Math.round(Math.max(-DISPLAY_DB, Math.min(DISPLAY_DB, dbOf(y))) * 10) / 10;
      next = { ...next, [b.gainKey]: Math.abs(g) < 0.25 ? 0 : g };
    }
    onPreview(next);
  };

  const onPointerDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (disabled || e.button !== 0) return;
    const { x, y } = local(e);
    const b = hit(x, y);
    if (!b) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { band: b, pointerId: e.pointerId };
    setDragging(b.id);
  };
  const onPointerMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    if (drag.current) {
      applyDrag(drag.current.band, x, y);
      return;
    }
    const b = hit(x, y);
    setHover(b?.id ?? null);
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(null);
    onCommit();
  };
  // Wheel = Q (needs a non-passive native listener to stop the page from scrolling).
  const wheelRef = useRef<(e: WheelEvent) => void>(() => undefined);
  wheelRef.current = (e: WheelEvent) => {
    if (disabled) return;
    const { x, y } = local(e);
    const b = hit(x, y);
    if (!b?.qKey) return;
    e.preventDefault();
    const q = (eq[b.qKey] as number) || 1;
    const nq = Math.round(Math.max(0.1, Math.min(18, q * Math.exp(-e.deltaY * 0.0015))) * 100) / 100;
    onPreview({ ...eq, [b.qKey]: nq });
    onCommitSoon();
  };
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const fn = (e: WheelEvent) => wheelRef.current(e);
    c.addEventListener('wheel', fn, { passive: false });
    return () => c.removeEventListener('wheel', fn);
  }, []);
  const onDoubleClick = (e: RMouseEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const { x, y } = local(e);
    const b = hit(x, y);
    if (!b) return;
    const d = defaultEq();
    const reset: Partial<EqSettings> =
      b.type === 'highpass' || b.type === 'lowpass'
        ? { [b.freqKey]: 0 }
        : { [b.freqKey]: d[b.freqKey], [b.gainKey!]: 0, ...(b.qKey ? { [b.qKey]: d[b.qKey] } : {}) };
    onPreview({ ...eq, ...reset });
    onCommit();
  };

  const setBand = (patch: Partial<EqSettings>) => onPreview({ ...eq, enabled: true, ...patch });

  return (
    <div className={`mx-eq ${disabled ? 'disabled' : ''}`}>
      <div className="mx-eq-plot" ref={hostRef}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${title} EQ frequency response`}
          style={{ cursor: disabled ? 'not-allowed' : hover || dragging ? 'grab' : 'default', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={() => !drag.current && setHover(null)}
          onDoubleClick={onDoubleClick}
        />
      </div>
      <div className="mx-eq-bands">
        {BANDS.map((b) => {
          const f = eq[b.freqKey] as number;
          const cut = b.type === 'highpass' || b.type === 'lowpass';
          const on = cut ? f > 10 : true;
          return (
            <div key={b.id} className={`mx-eq-band ${bandActive(eq, b) ? 'active' : ''}`} style={{ ['--band' as string]: b.color }} onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(null)}>
              <div className="mx-eq-band-head">
                <span className="dot" />
                <span>{b.label}</span>
                {cut && (
                  <Toggle
                    on={on}
                    onChange={(v) => {
                      if (disabled) return;
                      setBand({ [b.freqKey]: v ? (b.type === 'highpass' ? 80 : 12000) : 0 });
                      onCommit();
                    }}
                    title={`${b.label} ${on ? 'on' : 'off'}`}
                    label={<span className="mx-sr">{`${title} ${b.label.toLowerCase()} filter`}</span>}
                  />
                )}
              </div>
              <div className="mx-eq-band-knobs">
                <Knob
                  value={on ? Math.max(b.minHz, Math.min(b.maxHz, f)) : b.type === 'highpass' ? b.minHz : b.maxHz}
                  min={b.minHz}
                  max={b.maxHz}
                  log
                  defaultValue={cut ? (b.type === 'highpass' ? 80 : 12000) : (defaultEq()[b.freqKey] as number)}
                  onPreview={(v) => setBand({ [b.freqKey]: roundFreq(v) })}
                  onCommit={onCommit}
                  onKeyCommit={onCommitSoon}
                  label="Freq"
                  ariaLabel={`${title} ${b.label} frequency`}
                  format={fmtHzUnit}
                  disabled={disabled || (cut && !on)}
                  size={28}
                  tone="muted"
                />
                {b.gainKey && (
                  <Knob
                    value={eq[b.gainKey] as number}
                    min={-24}
                    max={24}
                    step={0.1}
                    bipolar
                    defaultValue={0}
                    onPreview={(v) => setBand({ [b.gainKey!]: v })}
                    onCommit={onCommit}
                    onKeyCommit={onCommitSoon}
                    label="Gain"
                    ariaLabel={`${title} ${b.label} gain`}
                    format={(v) => `${fmtDb(v)} dB`}
                    disabled={disabled}
                    size={28}
                  />
                )}
                {b.qKey && (
                  <Knob
                    value={(eq[b.qKey] as number) || 1}
                    min={0.1}
                    max={18}
                    log
                    defaultValue={1}
                    onPreview={(v) => setBand({ [b.qKey!]: v })}
                    onCommit={onCommit}
                    onKeyCommit={onCommitSoon}
                    label="Q"
                    ariaLabel={`${title} ${b.label} Q`}
                    format={(v) => v.toFixed(2)}
                    disabled={disabled}
                    size={28}
                    tone="muted"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
