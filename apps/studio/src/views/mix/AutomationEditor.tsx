import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import {
  TRACK_NEUTRAL,
  barLengthTicks,
  barToTick,
  createTimeMap,
  randomId,
  sectionLayout,
  songLengthTicks,
  tickToBar,
  tickToMusical,
  ticksPerBeat,
  type AutomationLane,
  type AutomationParam,
  type AutomationPoint,
  type Song,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { player } from '../../engine/player';
import { useElementSize } from '../../hooks';
import { Badge, Button, EmptyState, Select, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { alpha, cssVar, sectionColor, useThemeName } from '../../ui/theme';
import {
  AUTOMATION_META,
  AUTOMATION_PARAMS,
  MASTER,
  automationDenorm,
  automationNorm,
  isStripLocked,
  roundAutomation,
  staticAutomationValue,
  targetName,
} from './mixModel';

/**
 * Automation editor (spec §40 "automation"): lanes of track or master parameters over the song
 * timeline with section markers. Click to add a point, drag to move, double-click to delete,
 * right-click to toggle a segment between linear and step. Keyboard: arrows move the selected
 * point, Delete removes it. Every gesture commits one revision.
 */

type Snap = 'off' | 'bar' | 'beat' | '8th' | '16th';
const HEADER_W = 212;
const LANE_H = 96;
const RULER_H = 38;
const POINT_R = 5;

function snapTick(song: Song, tick: number, snap: Snap, end: number): number {
  const t = Math.max(0, Math.min(end, tick));
  if (snap === 'off') return Math.round(t);
  const p = tickToBar(song, t);
  const barStart = barToTick(song, p.bar);
  const unit =
    snap === 'bar' ? barLengthTicks(p.meter, song.ppq) : snap === 'beat' ? ticksPerBeat(p.meter.denominator, song.ppq) : snap === '8th' ? song.ppq / 2 : song.ppq / 4;
  return Math.max(0, Math.min(end, Math.round(barStart + Math.round((t - barStart) / unit) * unit)));
}

function snapUnit(song: Song, tick: number, snap: Snap): number {
  const p = tickToBar(song, tick);
  if (snap === 'bar') return barLengthTicks(p.meter, song.ppq);
  if (snap === '8th') return song.ppq / 2;
  if (snap === '16th') return song.ppq / 4;
  return ticksPerBeat(p.meter.denominator, song.ppq);
}

function posLabel(song: Song, tick: number): string {
  const m = tickToMusical(song, tick);
  return `${m.bar}.${Math.floor(m.beat)}${m.beat % 1 > 0.01 ? `.${Math.round((m.beat % 1) * 4) + 1}` : ''}`;
}

function laneTitle(song: Song, lane: Pick<AutomationLane, 'target' | 'param'>): string {
  return `${targetName(song, lane.target)} · ${AUTOMATION_META[lane.param].label}`;
}

function commitAutomation(song: Song, automation: AutomationLane[], message: string) {
  useStudio.getState().commit({ ...song, automation }, message, 'mix');
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

function Ruler({ song, width, end }: { song: Song; width: number; end: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useThemeName();
  useEffect(() => {
    const c = ref.current;
    if (!c || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(RULER_H * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${RULER_H}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, RULER_H);
    const x = (t: number) => (t / end) * width;
    ctx.font = `600 10.5px ${cssVar('--font-ui')}`;
    ctx.textBaseline = 'middle';
    for (const span of sectionLayout(song)) {
      const x0 = x(span.startTick);
      const x1 = x(span.endTick);
      const color = sectionColor(span.section.kind);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.22;
      ctx.fillRect(x0 + 1, 2, Math.max(1, x1 - x0 - 2), 18);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillRect(x0 + 1, 2, 3, 18);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 6, 2, Math.max(0, x1 - x0 - 8), 18);
      ctx.clip();
      ctx.fillStyle = cssVar('--text');
      ctx.fillText(span.section.name, x0 + 8, 11);
      ctx.restore();
    }
    // Bar numbers.
    const bars = tickToBar(song, Math.max(0, end - 1)).bar + 1;
    const pxPerBar = width / Math.max(1, bars);
    const every = pxPerBar >= 28 ? 1 : pxPerBar >= 14 ? 2 : pxPerBar >= 7 ? 4 : 8;
    ctx.font = `10px ${cssVar('--font-mono')}`;
    ctx.fillStyle = cssVar('--text-dim');
    ctx.strokeStyle = cssVar('--grid-bar');
    for (let b = 0; b < bars; b++) {
      const bx = Math.round(x(barToTick(song, b))) + 0.5;
      ctx.beginPath();
      ctx.moveTo(bx, 24);
      ctx.lineTo(bx, b % every === 0 ? RULER_H : 31);
      ctx.stroke();
      if (b % every === 0) {
        ctx.textAlign = 'left';
        ctx.fillText(String(b + 1), bx + 3, 30);
      }
    }
  }, [song, width, end, theme]);
  return <canvas ref={ref} className="mx-auto-ruler" aria-hidden />;
}

// ---------------------------------------------------------------------------
// Lane canvas
// ---------------------------------------------------------------------------

interface LaneCanvasProps {
  song: Song;
  lane: AutomationLane;
  points: AutomationPoint[];
  width: number;
  end: number;
  locked: boolean;
  selectedIndex: number | null;
  snap: Snap;
  newCurve: 'linear' | 'step';
  onSelectPoint: (i: number | null) => void;
  onDraft: (points: AutomationPoint[] | null) => void;
  onCommit: (points: AutomationPoint[], message: string) => void;
}

function LaneCanvas({ song, lane, points, width, end, locked, selectedIndex, snap, newCurve, onSelectPoint, onDraft, onCommit }: LaneCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ index: number; points: AutomationPoint[]; moved: boolean; created: boolean } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const theme = useThemeName();
  const meta = AUTOMATION_META[lane.param];
  const staticValue = staticAutomationValue(song.mixer, lane.target, lane.param);
  const PAD = 7;
  const plotH = LANE_H - PAD * 2;
  const xOf = (t: number) => (t / end) * width;
  const yOf = (v: number) => PAD + (1 - automationNorm(lane.param, v)) * plotH;
  const tickOf = (x: number) => (x / width) * end;
  const valueOf = (y: number) => roundAutomation(lane.param, automationDenorm(lane.param, 1 - (y - PAD) / plotH));
  const title = laneTitle(song, lane);

  useEffect(() => {
    const c = ref.current;
    if (!c || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(LANE_H * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${LANE_H}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, LANE_H);
    const enabled = lane.enabled;
    const color = enabled ? cssVar('--ai') : cssVar('--text-dim');
    // Grid: sections and bars.
    ctx.strokeStyle = cssVar('--grid-line');
    const bars = tickToBar(song, Math.max(0, end - 1)).bar + 1;
    const pxPerBar = width / Math.max(1, bars);
    const every = pxPerBar >= 10 ? 1 : 4;
    for (let b = 0; b <= bars; b += every) {
      const bx = Math.round(xOf(barToTick(song, b))) + 0.5;
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, LANE_H);
      ctx.stroke();
    }
    ctx.strokeStyle = cssVar('--grid-bar');
    for (const span of sectionLayout(song)) {
      const sx = Math.round(xOf(span.startTick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, LANE_H);
      ctx.stroke();
    }
    // Center/zero reference for bipolar params.
    if (lane.param === 'pan' || lane.param.endsWith('Db')) {
      const zy = Math.round(yOf(0)) + 0.5;
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = cssVar('--border-strong');
      ctx.beginPath();
      ctx.moveTo(0, zy);
      ctx.lineTo(width, zy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Static value (no points, or lane disabled).
    if (!points.length || !enabled) {
      const sy = yOf(staticValue);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = cssVar('--text-dim');
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (points.length) {
      // Curve with fill.
      const path = new Path2D();
      path.moveTo(0, yOf(points[0].value));
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const y = yOf(p.value);
        path.lineTo(xOf(p.tick), y);
        const next = points[i + 1];
        if (next && (p.curve ?? 'linear') === 'step') path.lineTo(xOf(next.tick), y);
        if (!next) path.lineTo(width, y);
      }
      const fill = new Path2D(path);
      fill.lineTo(width, LANE_H);
      fill.lineTo(0, LANE_H);
      fill.closePath();
      ctx.fillStyle = alpha(color, enabled ? 0.12 : 0.06);
      ctx.fill(fill);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke(path);
      ctx.lineWidth = 1;
      // Points.
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const x = xOf(p.tick);
        const y = yOf(p.value);
        const sel = i === selectedIndex;
        ctx.beginPath();
        if ((p.curve ?? 'linear') === 'step') ctx.rect(x - POINT_R, y - POINT_R, POINT_R * 2, POINT_R * 2);
        else ctx.arc(x, y, sel || i === hover ? POINT_R + 1.5 : POINT_R, 0, Math.PI * 2);
        ctx.fillStyle = sel ? cssVar('--accent') : color;
        ctx.fill();
        ctx.strokeStyle = cssVar('--bg');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // Value tag for the hovered / selected point.
      const tagIndex = drag.current ? drag.current.index : (hover ?? selectedIndex);
      const tp = tagIndex !== null ? points[tagIndex] : undefined;
      if (tp) {
        const text = `${posLabel(song, tp.tick)} · ${meta.fmt(tp.value)}`;
        ctx.font = `11px ${cssVar('--font-ui')}`;
        const tw = ctx.measureText(text).width + 10;
        const x = Math.min(width - tw - 2, Math.max(2, xOf(tp.tick) - tw / 2));
        const y = yOf(tp.value) < 26 ? yOf(tp.value) + 9 : yOf(tp.value) - 26;
        ctx.fillStyle = cssVar('--bg-elev-3');
        ctx.fillRect(x, y, tw, 17);
        ctx.fillStyle = cssVar('--text');
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + 5, y + 9);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, lane, points, width, end, selectedIndex, hover, staticValue, theme]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitPoint = (x: number, y: number): number | null => {
    let best: number | null = null;
    let bd = 9;
    points.forEach((p, i) => {
      const d = Math.hypot(xOf(p.tick) - x, yOf(p.value) - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    ref.current?.focus();
    if (locked) return;
    const { x, y } = local(e);
    let index = hitPoint(x, y);
    let pts = points.map((p) => ({ ...p }));
    let created = false;
    if (index === null) {
      const tick = snapTick(song, tickOf(x), snap, end);
      const existing = pts.findIndex((p) => p.tick === tick);
      const pt: AutomationPoint = { tick, value: valueOf(y), curve: newCurve };
      if (existing >= 0) pts[existing] = pt;
      else pts.push(pt);
      pts.sort((a, b) => a.tick - b.tick);
      index = pts.indexOf(pt);
      created = true;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { index, points: pts, moved: false, created };
    onSelectPoint(index);
    onDraft(pts);
  };
  const onPointerMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    const d = drag.current;
    if (!d) {
      setHover(hitPoint(x, y));
      return;
    }
    const pts = d.points.map((p) => ({ ...p }));
    const cur = pts[d.index];
    const prevT = d.index > 0 ? pts[d.index - 1].tick : 0;
    const nextT = d.index < pts.length - 1 ? pts[d.index + 1].tick : end;
    const tick = e.altKey ? cur.tick : Math.max(prevT, Math.min(nextT, snapTick(song, tickOf(x), snap, end)));
    const value = e.shiftKey ? cur.value : valueOf(y);
    pts[d.index] = { ...cur, tick, value };
    d.points = pts;
    d.moved = true;
    onDraft(pts);
  };
  const end_ = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    onDraft(null);
    if (!d.created && !d.moved) return;
    const p = d.points[d.index];
    onCommit(
      d.points,
      d.created
        ? `Automation: ${laneTitle(song, lane)} — point at ${posLabel(song, p.tick)} (${meta.fmt(p.value)})`
        : `Automation: ${laneTitle(song, lane)} — moved point to ${posLabel(song, p.tick)} (${meta.fmt(p.value)})`,
    );
  };
  const removeAt = (i: number) => {
    const p = points[i];
    const pts = points.filter((_, k) => k !== i);
    onSelectPoint(null);
    onCommit(pts, `Automation: ${laneTitle(song, lane)} — removed point at ${posLabel(song, p.tick)}`);
  };
  const onDoubleClick = (e: RMouseEvent<HTMLCanvasElement>) => {
    if (locked) return;
    const { x, y } = local(e);
    const i = hitPoint(x, y);
    if (i !== null) removeAt(i);
  };
  const onContextMenu = (e: RMouseEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    const i = hitPoint(x, y);
    if (i === null) return;
    e.preventDefault();
    if (locked) return;
    const pts = points.map((p, k) => (k === i ? { ...p, curve: (p.curve ?? 'linear') === 'step' ? ('linear' as const) : ('step' as const) } : p));
    onSelectPoint(i);
    onCommit(pts, `Automation: ${laneTitle(song, lane)} — ${pts[i].curve} segment at ${posLabel(song, pts[i].tick)}`);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (locked || selectedIndex === null || !points[selectedIndex]) return;
    const i = selectedIndex;
    const p = points[i];
    let next: AutomationPoint | null = null;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeAt(i);
      return;
    }
    const n = automationNorm(lane.param, p.value);
    const stepN = e.shiftKey ? 0.01 : 0.04;
    if (e.key === 'ArrowUp') next = { ...p, value: roundAutomation(lane.param, automationDenorm(lane.param, n + stepN)) };
    if (e.key === 'ArrowDown') next = { ...p, value: roundAutomation(lane.param, automationDenorm(lane.param, n - stepN)) };
    const unit = snapUnit(song, p.tick, snap === 'off' ? 'beat' : snap);
    const prevT = i > 0 ? points[i - 1].tick : 0;
    const nextT = i < points.length - 1 ? points[i + 1].tick : end;
    if (e.key === 'ArrowLeft') next = { ...p, tick: Math.max(prevT, p.tick - unit) };
    if (e.key === 'ArrowRight') next = { ...p, tick: Math.min(nextT, p.tick + unit) };
    if (!next) return;
    e.preventDefault();
    const pts = points.map((q, k) => (k === i ? next! : q));
    onCommit(pts, `Automation: ${laneTitle(song, lane)} — ${posLabel(song, next.tick)} ${meta.fmt(next.value)}`);
  };

  return (
    <canvas
      ref={ref}
      className={`mx-auto-canvas ${locked ? 'locked' : ''}`}
      tabIndex={0}
      role="application"
      aria-label={`${title} automation lane. Click to add points; arrows move the selected point; Delete removes it.`}
      style={{ touchAction: 'none', cursor: locked ? 'not-allowed' : hover !== null ? 'grab' : 'crosshair' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end_}
      onPointerCancel={end_}
      onPointerLeave={() => !drag.current && setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    />
  );
}

/** Playhead line over the lanes, positioned by a rAF loop (no React re-render per frame). */
function PlayheadOverlay({ song, width, end }: { song: Song; width: number; end: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const tm = useMemo(() => createTimeMap(song), [song]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current;
      if (el) {
        const tick = tm.secondsToTick(player.position());
        const x = (tick / end) * width;
        el.style.transform = `translateX(${x.toFixed(1)}px)`;
        el.style.opacity = tick > 0 && tick <= end ? '1' : '0';
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tm, width, end]);
  return <div ref={ref} className="mx-auto-playhead" style={{ left: HEADER_W }} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export function AutomationEditor({ song, defaultTarget }: { song: Song; defaultTarget?: string | null }) {
  const [hostRef, size] = useElementSize<HTMLDivElement>();
  const [snap, setSnap] = useState<Snap>('beat');
  const [newCurve, setNewCurve] = useState<'linear' | 'step'>('linear');
  const [target, setTarget] = useState<string>(defaultTarget && song.tracks.some((t) => t.id === defaultTarget) ? defaultTarget : (song.tracks[0]?.id ?? MASTER));
  const [param, setParam] = useState<AutomationParam>('volumeDb');
  const [selected, setSelected] = useState<{ laneId: string; index: number } | null>(null);
  const [draft, setDraft] = useState<{ laneId: string; points: AutomationPoint[] } | null>(null);
  const [zoom, setZoom] = useState<'fit' | '2' | '4' | '8'>('fit');
  const end = Math.max(1, songLengthTicks(song));
  const fit = Math.max(size.width - HEADER_W - 2, 320);
  const width = zoom === 'fit' ? fit : Math.round(fit * Number(zoom));
  const lanes = song.automation;

  const targetOptions = [
    ...song.tracks.map((t) => ({ value: t.id, label: t.name })),
    { value: MASTER, label: 'Master' },
  ];
  const paramOptions = AUTOMATION_PARAMS.filter((p) => target !== MASTER || AUTOMATION_META[p].masterOk).map((p) => ({ value: p, label: AUTOMATION_META[p].label }));
  const existing = lanes.find((l) => l.target === target && l.param === param);
  const targetLocked = isStripLocked(song, target);

  const addLane = () => {
    if (existing) {
      document.getElementById(`lane-${existing.id}`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const lane: AutomationLane = { id: randomId('auto'), target, param, points: [], enabled: true };
    commitAutomation(song, [...lanes, lane], `Added automation lane: ${laneTitle(song, lane)}`);
  };
  const updateLane = (id: string, patch: Partial<AutomationLane>, message: string) =>
    commitAutomation(
      song,
      lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      message,
    );

  return (
    <div className="panel mx-automation">
      <div className="panel-header wrap">
        <Icon name="sliders" />
        <h3>Automation</h3>
        <span className="small dim grow">Parameter changes over time — rendered identically in playback and exports.</span>
      </div>
      <div className="mx-auto-toolbar">
        <div className="row wrap">
          <span className="field-label">Add lane</span>
          <Select size="sm" value={target} onChange={(v) => {
            setTarget(v);
            if (v === MASTER && !AUTOMATION_META[param].masterOk) setParam('volumeDb');
          }} options={targetOptions} aria-label="Automation target" style={{ width: 170 }} />
          <Select size="sm" value={param} onChange={setParam} options={paramOptions} aria-label="Automation parameter" style={{ width: 150 }} />
          <Button size="sm" icon="plus" onClick={addLane} disabled={targetLocked} title={targetLocked ? 'This strip is locked' : existing ? 'Lane exists — scroll to it' : 'Add an automation lane'}>
            {existing ? 'Show lane' : 'Add lane'}
          </Button>
        </div>
        <div className="row wrap">
          <span className="field-label">Snap</span>
          <Select
            size="sm"
            value={snap}
            onChange={setSnap}
            options={[
              { value: 'bar', label: 'Bar' },
              { value: 'beat', label: 'Beat' },
              { value: '8th', label: '1/8' },
              { value: '16th', label: '1/16' },
              { value: 'off', label: 'Off' },
            ]}
            aria-label="Snap"
            style={{ width: 80 }}
          />
          <span className="field-label">Zoom</span>
          <Select
            size="sm"
            value={zoom}
            onChange={setZoom}
            options={[
              { value: 'fit', label: 'Fit song' },
              { value: '2', label: '2×' },
              { value: '4', label: '4×' },
              { value: '8', label: '8×' },
            ]}
            aria-label="Timeline zoom"
            style={{ width: 92 }}
          />
          <span className="field-label">New points</span>
          <Select
            size="sm"
            value={newCurve}
            onChange={setNewCurve}
            options={[
              { value: 'linear', label: 'Linear ramp' },
              { value: 'step', label: 'Step (hold)' },
            ]}
            aria-label="Curve for new points"
            style={{ width: 120 }}
          />
        </div>
      </div>
      <div className="mx-auto-scroll" ref={hostRef}>
        {lanes.length === 0 ? (
          <EmptyState icon="sliders" title="No automation lanes yet">
            Pick a track (or the master) and a parameter, then click <strong>Add lane</strong>. Click inside a lane to add points; drag them to shape fades,
            swells and rides across sections.
          </EmptyState>
        ) : (
          <div className="mx-auto-content" style={{ width: HEADER_W + width }}>
            <div className="mx-auto-row ruler">
              <div className="mx-auto-head ruler-head small dim">Bars · sections</div>
              <Ruler song={song} width={width} end={end} />
            </div>
            {lanes.map((lane) => {
              const locked = isStripLocked(song, lane.target);
              const points = draft?.laneId === lane.id ? draft.points : lane.points;
              const meta = AUTOMATION_META[lane.param];
              const track = song.tracks.find((t) => t.id === lane.target);
              const sel = selected?.laneId === lane.id ? selected.index : null;
              const selPoint = sel !== null ? lane.points[sel] : undefined;
              return (
                <div className={`mx-auto-row ${lane.enabled ? '' : 'disabled'}`} key={lane.id} id={`lane-${lane.id}`}>
                  <div className="mx-auto-head">
                    <div className="row" style={{ gap: 6 }}>
                      <span className="mx-color-dot" style={{ background: lane.target === MASTER ? 'var(--accent)' : (track?.color ?? TRACK_NEUTRAL) }} />
                      <span className="ellipsis grow" style={{ fontWeight: 600 }} title={laneTitle(song, lane)}>
                        {targetName(song, lane.target)}
                      </span>
                      {locked && <Icon name="lock" size={12} />}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="trash"
                        aria-label={`Remove ${laneTitle(song, lane)} lane`}
                        title="Remove lane"
                        disabled={locked}
                        onClick={() => commitAutomation(song, lanes.filter((l) => l.id !== lane.id), `Removed automation lane: ${laneTitle(song, lane)}`)}
                      />
                    </div>
                    <div className="row between small">
                      <span className="muted">{meta.label}</span>
                      <Badge>
                        {lane.points.length} {lane.points.length === 1 ? 'point' : 'points'}
                      </Badge>
                    </div>
                    <div className="row between small">
                      <Toggle
                        on={lane.enabled}
                        onChange={(v) => !locked && updateLane(lane.id, { enabled: v }, `${v ? 'Enabled' : 'Disabled'} automation: ${laneTitle(song, lane)}`)}
                        label={lane.enabled ? 'On' : 'Off'}
                        title="Enable / bypass this lane"
                      />
                      {selPoint ? (
                        <Select
                          size="sm"
                          value={selPoint.curve ?? 'linear'}
                          onChange={(v) =>
                            !locked &&
                            updateLane(
                              lane.id,
                              { points: lane.points.map((p, k) => (k === sel ? { ...p, curve: v } : p)) },
                              `Automation: ${laneTitle(song, lane)} — ${v} segment`,
                            )
                          }
                          options={[
                            { value: 'linear', label: 'Linear' },
                            { value: 'step', label: 'Step' },
                          ]}
                          aria-label="Selected point curve"
                          style={{ width: 78 }}
                        />
                      ) : (
                        <span className="dim">{lane.points.length ? 'select a point' : 'click lane to add'}</span>
                      )}
                    </div>
                  </div>
                  <LaneCanvas
                    song={song}
                    lane={lane}
                    points={points}
                    width={width}
                    end={end}
                    locked={locked}
                    selectedIndex={sel}
                    snap={snap}
                    newCurve={newCurve}
                    onSelectPoint={(i) => setSelected(i === null ? null : { laneId: lane.id, index: i })}
                    onDraft={(pts) => setDraft(pts ? { laneId: lane.id, points: pts } : null)}
                    onCommit={(pts, message) => {
                      const sorted = [...pts].sort((a, b) => a.tick - b.tick);
                      const moved = sel !== null ? pts[sel] : undefined;
                      updateLane(lane.id, { points: sorted, enabled: true }, message);
                      if (moved) setSelected({ laneId: lane.id, index: sorted.indexOf(moved) });
                    }}
                  />
                </div>
              );
            })}
            <PlayheadOverlay song={song} width={width} end={end} />
          </div>
        )}
      </div>
      {lanes.length > 0 && (
        <div className="mx-auto-help small dim">
          Click = add point · drag = move (Shift locks value, Alt locks time) · double-click = delete · right-click = linear/step · arrows nudge the selected point
        </div>
      )}
    </div>
  );
}
