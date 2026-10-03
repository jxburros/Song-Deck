import { useEffect, useRef } from 'react';
import type { CompressorSettings } from '@songdeck/core';
import { Toggle } from '../../ui/kit';
import { Knob } from './controls';
import { FIELD_META, fmtDb } from './mixModel';

/** Static gain-reduction curve of the engine's soft-knee compressor (dB, ≤ 0). */
export function gainReduction(x: number, c: Pick<CompressorSettings, 'thresholdDb' | 'ratio' | 'kneeDb'>): number {
  const T = c.thresholdDb;
  const R = Math.max(1, c.ratio);
  const W = Math.max(0, c.kneeDb);
  const d = x - T;
  if (2 * d < -W) return 0;
  if (W > 0 && 2 * Math.abs(d) <= W) {
    const t = d + W / 2;
    return ((1 / R - 1) * t * t) / (2 * W);
  }
  return d * (1 / R - 1);
}

function TransferCurve({ comp, size = 118 }: { comp: CompressorSettings; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    c.style.width = `${size}px`;
    c.style.height = `${size}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f;
    ctx.fillStyle = v('--bg-input', '#0f1217');
    ctx.fillRect(0, 0, size, size);
    const MIN = -60;
    const MAXO = 12;
    const px = (db: number) => ((db - MIN) / (0 - MIN)) * size;
    const py = (db: number) => size - ((db - MIN) / (MAXO - MIN)) * size;
    ctx.strokeStyle = v('--grid-line', 'rgba(255,255,255,0.05)');
    ctx.lineWidth = 1;
    for (let db = -48; db <= 0; db += 12) {
      ctx.beginPath();
      ctx.moveTo(px(db) + 0.5, 0);
      ctx.lineTo(px(db) + 0.5, size);
      ctx.moveTo(0, py(db) + 0.5);
      ctx.lineTo(size, py(db) + 0.5);
      ctx.stroke();
    }
    // Unity line.
    ctx.strokeStyle = v('--border-strong', '#343b48');
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px(MIN), py(MIN));
    ctx.lineTo(px(0), py(0));
    ctx.stroke();
    ctx.setLineDash([]);
    // Threshold marker.
    ctx.strokeStyle = v('--warning', '#f5c451');
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(px(comp.thresholdDb) + 0.5, 0);
    ctx.lineTo(px(comp.thresholdDb) + 0.5, size);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Curve.
    ctx.strokeStyle = comp.enabled ? v('--ai', '#46c2cb') : v('--text-dim', '#646d7c');
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const x = MIN + (i / 120) * (0 - MIN);
      const y = x + (comp.enabled ? gainReduction(x, comp) + comp.makeupDb : 0);
      if (i === 0) ctx.moveTo(px(x), py(y));
      else ctx.lineTo(px(x), py(y));
    }
    ctx.stroke();
  }, [comp, size]);
  return <canvas ref={ref} className="mx-transfer" role="img" aria-label="Compressor transfer curve" />;
}

export function CompressorEditor({
  comp,
  onPreview,
  onCommit,
  onCommitSoon,
  disabled,
  title,
  glue,
}: {
  comp: CompressorSettings;
  onPreview: (next: CompressorSettings) => void;
  onCommit: () => void;
  onCommitSoon: () => void;
  disabled?: boolean;
  title: string;
  glue?: boolean;
}) {
  const knob = (key: keyof CompressorSettings, label: string, def: number, extra: { bipolar?: boolean; step?: number } = {}) => {
    const meta = FIELD_META[`compressor.${key}`];
    return (
      <Knob
        value={comp[key] as number}
        min={meta.min}
        max={meta.max}
        log={meta.log}
        step={extra.step}
        defaultValue={def}
        onPreview={(v) => onPreview({ ...comp, enabled: true, [key]: v })}
        onCommit={onCommit}
        onKeyCommit={onCommitSoon}
        label={label}
        ariaLabel={`${title} ${glue ? 'glue compressor' : 'compressor'} ${label.toLowerCase()}`}
        format={meta.fmt}
        disabled={disabled}
        size={30}
        tone="ai"
      />
    );
  };
  // Approximate gain reduction at a hot -6 dBFS peak for the readout.
  const grAtHot = comp.enabled ? gainReduction(-6, comp) : 0;
  return (
    <div className={`mx-comp ${comp.enabled ? '' : 'off'} ${disabled ? 'disabled' : ''}`}>
      <div className="row between">
        <Toggle
          on={comp.enabled}
          onChange={(v) => {
            if (disabled) return;
            onPreview({ ...comp, enabled: v });
            onCommit();
          }}
          label={glue ? 'Glue compressor' : 'Compressor'}
        />
        <span className="small dim mono" title="Static gain reduction for a −6 dBFS peak">
          GR@−6: {fmtDb(grAtHot)} dB
        </span>
      </div>
      <div className="mx-comp-body">
        <TransferCurve comp={comp} />
        <div className="mx-comp-knobs">
          {knob('thresholdDb', 'Thresh', glue ? -14 : -18, { step: 0.5 })}
          {knob('ratio', 'Ratio', glue ? 2 : 3)}
          {knob('attackMs', 'Attack', glue ? 25 : 10)}
          {knob('releaseMs', 'Release', glue ? 200 : 120)}
          {knob('kneeDb', 'Knee', 6, { step: 0.5 })}
          {knob('makeupDb', 'Makeup', glue ? 1 : 0, { step: 0.1 })}
        </div>
      </div>
    </div>
  );
}
