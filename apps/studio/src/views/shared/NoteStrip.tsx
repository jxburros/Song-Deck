import { useEffect, useMemo, useRef } from 'react';
import { useElementSize } from '../../hooks';
import { useThemeName } from '../../ui/theme';

/**
 * A small read-only piano roll (canvas) for previews: transcriptions, generated parts, rebuilt
 * tracks. Notes can be coloured by confidence so uncertain material is obvious at a glance
 * (spec §25: "clearly communicate confidence when transcription is uncertain").
 */

export interface StripNote {
  pitch: number;
  tick: number;
  duration: number;
  velocity?: number;
  /** 0..1 */
  confidence?: number;
}

export interface NoteStripProps {
  notes: readonly StripNote[];
  ppq?: number;
  meter?: { numerator: number; denominator: number };
  /** First tick shown (default 0). */
  startTick?: number;
  /** Ticks shown (default: last note end rounded up to a whole bar). */
  totalTicks?: number;
  height?: number;
  colorBy?: 'confidence' | 'velocity' | 'flat';
  /** Base colour for 'flat' / 'velocity' modes. */
  color?: string;
  /** Notes below this confidence are drawn as "low" (default 0.6, matches the piano roll). */
  lowConfidence?: number;
  /** Compress rows to the drum sounds actually used. */
  drums?: boolean;
  /** Highlighted tick range (e.g. a phrase selected for substitution). */
  highlight?: { startTick: number; endTick: number } | null;
  playheadTick?: number | null;
  /** Number of the first bar on the ruler (1-based). */
  firstBarNumber?: number;
  ariaLabel?: string;
  /** Click on the ruler/body → 1-based bar number. */
  onBarClick?: (bar1: number) => void;
  testId?: string;
}

export type ConfidenceBucket = 'high' | 'medium' | 'low';

export function confidenceBucket(c: number | undefined, low = 0.6): ConfidenceBucket {
  if (c === undefined) return 'high';
  if (c < low) return 'low';
  if (c < 0.8) return 'medium';
  return 'high';
}

const BUCKET_VAR: Record<ConfidenceBucket, string> = {
  high: '--success',
  medium: '--warning',
  low: '--danger',
};

const DRUM_LABELS: Record<number, string> = {
  35: 'Kick',
  36: 'Kick',
  37: 'Stick',
  38: 'Snare',
  39: 'Clap',
  40: 'Snare',
  41: 'Tom F',
  42: 'Hat',
  43: 'Tom F',
  44: 'Hat P',
  45: 'Tom L',
  46: 'Hat O',
  47: 'Tom M',
  48: 'Tom H',
  49: 'Crash',
  50: 'Tom H',
  51: 'Ride',
  52: 'China',
  53: 'Bell',
  54: 'Tamb',
  55: 'Splash',
  56: 'Cowbell',
  57: 'Crash',
  59: 'Ride',
};

const NOTE_GUTTER = 34;
const DRUM_GUTTER = 50;
const RULER = 16;

export function NoteStrip({
  notes,
  ppq = 480,
  meter = { numerator: 4, denominator: 4 },
  startTick = 0,
  totalTicks,
  height = 140,
  colorBy = 'confidence',
  color,
  lowConfidence = 0.6,
  drums = false,
  highlight,
  playheadTick,
  firstBarNumber = 1,
  ariaLabel,
  onBarClick,
  testId = 'note-strip',
}: NoteStripProps) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const theme = useThemeName();
  const GUTTER = drums ? DRUM_GUTTER : NOTE_GUTTER;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const beatTicks = (4 * ppq) / (meter.denominator || 4);
  const barTicks = Math.max(1, (meter.numerator || 4) * beatTicks);
  const span = useMemo(() => {
    if (totalTicks && totalTicks > 0) return totalTicks;
    const end = notes.reduce((m, n) => Math.max(m, n.tick + n.duration), 0) - startTick;
    return Math.max(barTicks, Math.ceil(Math.max(1, end) / barTicks) * barTicks);
  }, [notes, totalTicks, startTick, barTicks]);

  const rows = useMemo(() => {
    if (drums) {
      const used = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => b - a);
      return used.length ? used : [38, 36];
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of notes) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    if (!Number.isFinite(lo)) {
      lo = 55;
      hi = 72;
    }
    lo -= 2;
    hi += 2;
    while (hi - lo < 14) {
      lo--;
      hi++;
    }
    const out: number[] = [];
    for (let p = hi; p >= lo; p--) out.push(p);
    return out;
  }, [notes, drums]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const w = size.width;
    if (!canvas || w <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim();
    const bodyW = w - GUTTER;
    const bodyH = height - RULER;
    const rowH = bodyH / rows.length;
    const pxPerTick = bodyW / span;
    const xOf = (t: number) => GUTTER + (t - startTick) * pxPerTick;
    const rowIndex = new Map(rows.map((p, i) => [p, i]));

    g.fillStyle = col('--bg-input');
    g.fillRect(0, 0, w, height);
    // Rows: black keys shaded, C rows labelled.
    g.font = `10px ${col('--font-ui') || 'sans-serif'}`;
    g.textBaseline = 'middle';
    rows.forEach((p, i) => {
      const y = RULER + i * rowH;
      if (!drums && [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12)) {
        g.fillStyle = col('--row-shade');
        g.fillRect(GUTTER, y, bodyW, rowH);
      }
      const label = drums
        ? (DRUM_LABELS[p] ?? String(p))
        : p % 12 === 0
          ? `C${Math.floor(p / 12) - 1}`
          : null;
      // C labels are an octave apart and never collide; drum rows thin out only when tiny.
      if (label && (!drums || rowH >= 9 || i % 2 === 0)) {
        g.fillStyle = col('--text-dim');
        g.fillText(label, 4, y + rowH / 2);
        if (!drums) {
          g.fillStyle = col('--grid-beat');
          g.fillRect(GUTTER, y + rowH - 0.5, bodyW, 0.5);
        }
      }
    });
    // Highlight
    if (highlight && highlight.endTick > highlight.startTick) {
      const x0 = Math.max(GUTTER, xOf(highlight.startTick));
      const x1 = Math.min(w, xOf(highlight.endTick));
      g.fillStyle = col('--accent-soft');
      g.fillRect(x0, RULER, Math.max(0, x1 - x0), bodyH);
      g.strokeStyle = col('--accent');
      g.lineWidth = 1;
      g.strokeRect(x0 + 0.5, RULER + 0.5, Math.max(0, x1 - x0 - 1), bodyH - 1);
    }
    // Grid: beats and bars + ruler.
    g.fillStyle = col('--bg-elev-2');
    g.fillRect(0, 0, w, RULER);
    for (let t = 0; t <= span + 1; t += beatTicks) {
      const x = Math.round(xOf(startTick + t)) + 0.5;
      const isBar = t % barTicks === 0;
      g.fillStyle = isBar ? col('--grid-bar') : col('--grid-beat');
      g.fillRect(x, isBar ? 0 : RULER, 1, isBar ? height : bodyH);
      if (isBar && t < span) {
        const bar = firstBarNumber + Math.round(t / barTicks);
        const showEvery = Math.max(1, Math.ceil(28 / Math.max(1, barTicks * pxPerTick)));
        if ((bar - firstBarNumber) % showEvery === 0) {
          g.fillStyle = col('--text-muted');
          g.fillText(String(bar), x + 3, RULER / 2);
        }
      }
    }
    // Notes
    for (const n of notes) {
      const ri = rowIndex.get(n.pitch);
      if (ri === undefined) continue;
      const x = xOf(n.tick);
      if (x > w || x + n.duration * pxPerTick < GUTTER) continue;
      const y = RULER + ri * rowH;
      const nw = Math.max(drums ? 3 : 2, n.duration * pxPerTick - 1);
      const nh = Math.max(2, rowH - 1);
      const bucket = confidenceBucket(n.confidence, lowConfidence);
      let fill = color ?? col('--accent');
      if (colorBy === 'confidence') fill = col(BUCKET_VAR[bucket]);
      g.globalAlpha = colorBy === 'velocity' ? 0.35 + ((n.velocity ?? 100) / 127) * 0.65 : 0.92;
      g.fillStyle = fill;
      g.fillRect(x, y + 0.5, drums ? Math.min(nw, Math.max(3, rowH)) : nw, nh);
      g.globalAlpha = 1;
      if (colorBy === 'confidence' && bucket === 'low') {
        g.setLineDash([2, 2]);
        g.strokeStyle = col('--text');
        g.lineWidth = 1;
        g.strokeRect(
          x + 0.5,
          y + 1,
          Math.max(1, (drums ? Math.min(nw, Math.max(3, rowH)) : nw) - 1),
          Math.max(1, nh - 1),
        );
        g.setLineDash([]);
      }
    }
    // Playhead
    if (
      playheadTick !== undefined &&
      playheadTick !== null &&
      playheadTick >= startTick &&
      playheadTick <= startTick + span
    ) {
      const x = Math.round(xOf(playheadTick)) + 0.5;
      g.fillStyle = col('--playhead');
      g.fillRect(x - 0.5, 0, 2, height);
    }
    // Gutter edge
    g.fillStyle = col('--border');
    g.fillRect(GUTTER - 1, 0, 1, height);
  }, [
    notes,
    rows,
    size.width,
    height,
    span,
    startTick,
    beatTicks,
    barTicks,
    colorBy,
    color,
    lowConfidence,
    drums,
    highlight,
    playheadTick,
    firstBarNumber,
    GUTTER,
    theme,
  ]);

  const low =
    colorBy === 'confidence'
      ? notes.filter((n) => confidenceBucket(n.confidence, lowConfidence) === 'low').length
      : 0;
  return (
    <div
      ref={wrapRef}
      style={{
        position: 'relative',
        width: '100%',
        height,
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        border: '1px solid var(--border)',
        cursor: onBarClick ? 'pointer' : undefined,
      }}
      data-testid={testId}
      onClick={(e) => {
        if (!onBarClick || size.width <= GUTTER) return;
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const x = e.clientX - r.left - GUTTER;
        if (x < 0) return;
        const tick = startTick + (x / (size.width - GUTTER)) * span;
        onBarClick(firstBarNumber + Math.floor((tick - startTick) / barTicks));
      }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={
          ariaLabel ?? `${notes.length} notes${colorBy === 'confidence' ? `, ${low} low-confidence` : ''}`
        }
        style={{ display: 'block' }}
      />
    </div>
  );
}

/** Legend for confidence colouring, with per-bucket counts. */
export function ConfidenceLegend({
  notes,
  lowConfidence = 0.6,
}: {
  notes?: readonly StripNote[];
  lowConfidence?: number;
}) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const n of notes ?? []) counts[confidenceBucket(n.confidence, lowConfidence)]++;
  const item = (bucket: ConfidenceBucket, label: string) => (
    <span className="row small" style={{ gap: 5 }} key={bucket}>
      <span
        style={{
          width: 14,
          height: 9,
          borderRadius: 2,
          background: `var(${BUCKET_VAR[bucket]})`,
          outline: bucket === 'low' ? '1px dashed var(--text)' : undefined,
          outlineOffset: -1,
        }}
      />
      <span className="muted">
        {label}
        {notes ? ` · ${counts[bucket]}` : ''}
      </span>
    </span>
  );
  return (
    <div
      className="row wrap"
      style={{ gap: 14 }}
      data-testid="confidence-legend"
      aria-label="Confidence legend"
    >
      {item('high', 'High ≥ 80%')}
      {item('medium', `Medium ${Math.round(lowConfidence * 100)}–80%`)}
      {item('low', `Low < ${Math.round(lowConfidence * 100)}% — check these`)}
    </div>
  );
}
