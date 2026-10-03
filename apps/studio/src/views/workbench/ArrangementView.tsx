import { memo, useEffect, useMemo, useRef } from 'react';
import {
  barToTick,
  createTimeMap,
  LockKeys,
  isTrackSectionLocked,
  sectionLayout,
  songLengthBars,
  songLengthTicks,
  type SectionSpan,
  type Song,
  type Track,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { usePlayhead } from '../../hooks';
import { LockButton } from '../../ui/kit';
import { colorForRole } from './SidePanel';
import { useLoopSync } from './useLoopSync';

const HEAD_W = 172;
const SECTION_H = 22;
const RULER_H = 20;
const CHORD_H = 22;
const HEADER_H = SECTION_H + RULER_H + CHORD_H;

const SECTION_COLORS: Record<string, string> = {
  intro: '#4b5563',
  verse: '#2f6f8f',
  'pre-chorus': '#7a5c2e',
  chorus: '#8f3b2f',
  'post-chorus': '#7d3b5c',
  bridge: '#4c3f8f',
  breakdown: '#2f5f4f',
  build: '#7a6a2e',
  drop: '#8f2f4f',
  solo: '#5f7a2e',
  interlude: '#3f5f6f',
  'final-chorus': '#a3402c',
  outro: '#4b5563',
  custom: '#4b5563',
};

const SectionBlock = memo(function SectionBlock({
  song,
  track,
  span,
  x,
  w,
  h,
  changed,
  selected,
}: {
  song: Song;
  track: Track;
  span: SectionSpan;
  x: number;
  w: number;
  h: number;
  changed: boolean;
  selected: boolean;
}) {
  const st = useStudio.getState();
  const notes = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
  const locked = isTrackSectionLocked(song, track.id, span.section.id);
  const explicitLock = !!song.locks[LockKeys.trackSection(track.id, span.section.id)];
  const color = track.color || colorForRole(track.role);
  const len = span.endTick - span.startTick || 1;
  let lo = 127;
  let hi = 0;
  for (const n of track.notes) {
    if (n.pitch < lo) lo = n.pitch;
    if (n.pitch > hi) hi = n.pitch;
  }
  if (hi < lo) {
    lo = 48;
    hi = 72;
  }
  const range = Math.max(12, hi - lo + 1);
  const inner = h - 10;
  return (
    <div
      className="arr-block"
      style={{
        position: 'absolute',
        left: x + 1,
        top: 3,
        width: Math.max(2, w - 2),
        height: h - 6,
        borderRadius: 5,
        background: notes.length ? `${color}22` : 'transparent',
        border: `1px solid ${selected ? 'var(--accent)' : changed ? 'var(--diff-modified)' : notes.length ? `${color}55` : 'var(--border)'}`,
        borderStyle: notes.length || track.kind === 'audio' ? 'solid' : 'dashed',
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: locked ? 'inset 0 0 0 1px rgba(245,196,81,0.55)' : undefined,
      }}
      onClick={(e) => {
        e.stopPropagation();
        st.selectTrack(track.id);
        st.setSelection({ startTick: span.startTick, endTick: span.endTick, sectionIds: [span.section.id], trackIds: [track.id], noteIds: [] });
      }}
      onDoubleClick={() => {
        st.selectTrack(track.id);
        st.setWorkbenchView('piano-roll');
      }}
      title={`${track.name} · ${span.section.name}${locked ? ' (locked)' : ''}`}
    >
      {notes.length > 0 && (
        <svg width={Math.max(2, w - 2)} height={h - 6} style={{ position: 'absolute', left: 0, top: 0 }} aria-hidden="true">
          {notes.map((n) => {
            const nx = ((n.tick - span.startTick) / len) * (w - 2);
            const nw = Math.max(1.5, (n.duration / len) * (w - 2));
            const ny = 4 + inner - ((n.pitch - lo + 0.5) / range) * inner;
            return <rect key={n.id} x={nx} y={ny - 1.5} width={nw} height={3} rx={1} fill={color} opacity={0.35 + (n.velocity / 127) * 0.65} />;
          })}
        </svg>
      )}
      {changed && (
        <span className="badge warning" style={{ position: 'absolute', left: 4, top: 3, height: 15, fontSize: 9, padding: '0 4px' }}>
          Δ proposal
        </span>
      )}
      <div style={{ position: 'absolute', right: 2, top: 2 }}>
        <LockButton
          locked={locked}
          onToggle={() =>
            st.toggleLock(LockKeys.trackSection(track.id, span.section.id), `${explicitLock ? 'Unlocked' : 'Locked'} ${track.name} · ${span.section.name}`)
          }
          title={locked && !explicitLock ? 'Locked via track or section lock' : undefined}
        />
      </div>
    </div>
  );
});

export default function ArrangementView() {
  const song = useStudio((s) => s.project?.song ?? null);
  const view = useStudio((s) => s.view);
  const selection = useStudio((s) => s.selection);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const follow = useStudio((s) => s.transport.follow);
  const proposal = useStudio((s) => s.proposals.find((p) => p.id === s.activeProposalId && p.status === 'pending'));
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startTick: number; moved: boolean } | null>(null);
  const pos = usePlayhead();
  useLoopSync();

  const ppq = song?.ppq ?? 480;
  const pxPerTick = view.pxPerBeat / ppq;
  const totalTicks = song ? songLengthTicks(song) : 0;
  const totalWidth = Math.ceil(totalTicks * pxPerTick) + 200;
  const layout = useMemo(() => (song ? sectionLayout(song) : []), [song]);
  const tm = useMemo(() => (song ? createTimeMap(song) : null), [song]);
  const playX = tm ? tm.secondsToTick(pos) * pxPerTick : 0;

  const changedTrackSections = useMemo(() => {
    const set = new Set<string>();
    if (!proposal || !song) return set;
    for (const td of proposal.diff.tracks) {
      const ticks = [...td.added, ...td.removed, ...td.modified.map((m) => m.after)].map((n) => n.tick);
      for (const span of layout) if (ticks.some((t) => t >= span.startTick && t < span.endTick)) set.add(`${td.trackId}:${span.section.id}`);
    }
    return set;
  }, [proposal, layout, song]);

  // Follow the playhead while playing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow) return;
    const visibleStart = el.scrollLeft;
    const visibleEnd = visibleStart + el.clientWidth - HEAD_W;
    if (playX < visibleStart || playX > visibleEnd - 40) el.scrollLeft = Math.max(0, playX - 80);
  }, [playX, follow]);

  if (!song || !tm) return null;
  const st = useStudio.getState();
  const bars = songLengthBars(song);
  const tickAtX = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - HEAD_W + el.scrollLeft;
    return Math.max(0, Math.min(totalTicks, x / pxPerTick));
  };
  const snapBar = (tick: number) => {
    let best = 0;
    for (let b = 0; b <= bars; b++) {
      const t = barToTick(song, b);
      if (Math.abs(t - tick) < Math.abs(barToTick(song, best) - tick)) best = b;
    }
    return barToTick(song, best);
  };

  const onRulerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startTick: tickAtX(e.clientX), moved: false };
  };
  const onRulerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) > 4) d.moved = true;
    if (d.moved) {
      const a = snapBar(d.startTick);
      const b = snapBar(tickAtX(e.clientX));
      st.setSelection({ startTick: Math.min(a, b), endTick: Math.max(a, b), sectionIds: [], noteIds: [] });
    }
  };
  const onRulerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved) st.seek(tm.tickToSeconds(tickAtX(e.clientX)));
  };

  const selX = selection.startTick !== undefined ? selection.startTick * pxPerTick : 0;
  const selW = selection.startTick !== undefined && selection.endTick !== undefined ? (selection.endTick - selection.startTick) * pxPerTick : 0;

  return (
    <div ref={scrollRef} className="scroll" style={{ position: 'absolute', inset: 0 }} data-testid="arrangement">
      <div style={{ width: HEAD_W + totalWidth, position: 'relative', minHeight: '100%' }}>
        {/* Header: sections, bar ruler, chords */}
        <div style={{ position: 'sticky', top: 0, zIndex: 4, display: 'flex', background: 'var(--bg-elev-1)', borderBottom: '1px solid var(--border-strong)' }}>
          <div
            style={{
              position: 'sticky',
              left: 0,
              zIndex: 5,
              width: HEAD_W,
              height: HEADER_H,
              background: 'var(--bg-elev-1)',
              borderRight: '1px solid var(--border)',
              display: 'grid',
              gridTemplateRows: `${SECTION_H}px ${RULER_H}px ${CHORD_H}px`,
              fontSize: 10.5,
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              padding: '0 10px',
              alignItems: 'center',
            }}
          >
            <span>Sections</span>
            <span>Bars</span>
            <span>Chords</span>
          </div>
          <div
            style={{ position: 'relative', width: totalWidth, height: HEADER_H, cursor: 'pointer', userSelect: 'none' }}
            onPointerDown={onRulerDown}
            onPointerMove={onRulerMove}
            onPointerUp={onRulerUp}
          >
            {layout.map((span) => (
              <div
                key={span.section.id}
                style={{
                  position: 'absolute',
                  left: span.startTick * pxPerTick,
                  width: (span.endTick - span.startTick) * pxPerTick,
                  top: 0,
                  height: SECTION_H,
                  background: SECTION_COLORS[span.section.kind] ?? '#4b5563',
                  borderRight: '1px solid var(--bg)',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '3px 6px',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                }}
                title={`${span.section.name}${span.section.purpose ? ` — ${span.section.purpose}` : ''}`}
              >
                {span.section.name}
                {song.locks[LockKeys.section(span.section.id)] ? ' 🔒' : ''}
              </div>
            ))}
            <svg width={totalWidth} height={RULER_H} style={{ position: 'absolute', top: SECTION_H, left: 0 }} aria-hidden="true">
              {Array.from({ length: bars + 1 }, (_, b) => {
                const x = barToTick(song, b) * pxPerTick;
                const showNum = view.pxPerBeat * 4 >= 22 || b % 4 === 0;
                return (
                  <g key={b}>
                    <line x1={x} x2={x} y1={b % 4 === 0 ? 4 : 10} y2={RULER_H} stroke="var(--grid-bar)" />
                    {showNum && b < bars && (
                      <text x={x + 3} y={13} fontSize={10} fill="var(--text-muted)" fontFamily="var(--font-mono)">
                        {b + 1}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {song.chords.map((c) => (
              <div
                key={c.id}
                style={{
                  position: 'absolute',
                  top: SECTION_H + RULER_H + 2,
                  left: c.tick * pxPerTick + 1,
                  width: Math.max(4, c.duration * pxPerTick - 2),
                  height: CHORD_H - 4,
                  borderRadius: 4,
                  background: 'var(--bg-elev-3)',
                  border: '1px solid var(--border)',
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '0 4px',
                  lineHeight: `${CHORD_H - 6}px`,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                }}
                title={`${c.symbol}${c.roman ? ` (${c.roman})` : ''}`}
                onDoubleClick={() => st.setWorkbenchView('chords')}
              >
                {c.symbol}
              </div>
            ))}
            {selW > 0 && (
              <div style={{ position: 'absolute', left: selX, width: selW, top: SECTION_H, height: RULER_H, background: 'var(--accent-soft)', borderBottom: '2px solid var(--accent)' }} />
            )}
          </div>
        </div>

        {/* Track rows */}
        {song.tracks.map((track) => (
          <div key={track.id} style={{ display: 'flex', height: view.trackHeight, borderBottom: '1px solid var(--border)' }}>
            <div
              onClick={() => st.selectTrack(track.id)}
              style={{
                position: 'sticky',
                left: 0,
                zIndex: 2,
                width: HEAD_W,
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 10px',
                background: track.id === selectedTrackId ? 'var(--bg-elev-3)' : 'var(--bg-elev-1)',
                borderRight: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              <span style={{ width: 4, alignSelf: 'stretch', margin: '8px 0', borderRadius: 2, background: track.color || colorForRole(track.role) }} />
              <div style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 600, fontSize: 12 }}>
                  {track.name}
                </div>
                <div className="ellipsis small dim">{track.role}</div>
              </div>
            </div>
            <div style={{ position: 'relative', width: totalWidth, flex: 'none' }}>
              {layout.map((span) => (
                <SectionBlock
                  key={span.section.id}
                  song={song}
                  track={track}
                  span={span}
                  x={span.startTick * pxPerTick}
                  w={(span.endTick - span.startTick) * pxPerTick}
                  h={view.trackHeight}
                  changed={changedTrackSections.has(`${track.id}:${span.section.id}`)}
                  selected={!!selection.sectionIds?.includes(span.section.id) && (!selection.trackIds?.length || selection.trackIds.includes(track.id))}
                />
              ))}
              {track.clips.map((c) => {
                const x = tm.secondsToTick(tm.tickToSeconds(c.tick)) * pxPerTick;
                const endTick = tm.secondsToTick(tm.tickToSeconds(c.tick) + c.durationSeconds);
                return (
                  <div
                    key={c.id}
                    style={{
                      position: 'absolute',
                      left: x,
                      width: Math.max(4, (endTick - c.tick) * pxPerTick),
                      top: 4,
                      height: view.trackHeight - 8,
                      background: 'var(--ai-soft)',
                      border: '1px solid var(--ai)',
                      borderRadius: 5,
                      fontSize: 11,
                      padding: '2px 6px',
                      overflow: 'hidden',
                      opacity: c.muted ? 0.4 : 1,
                    }}
                    title={c.name}
                  >
                    {c.name ?? 'Audio clip'}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {selW > 0 && (
          <div
            style={{
              position: 'absolute',
              left: HEAD_W + selX,
              width: selW,
              top: HEADER_H,
              bottom: 0,
              background: 'rgba(255,138,61,0.06)',
              borderLeft: '1px solid var(--accent)',
              borderRight: '1px solid var(--accent)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        )}
        <div
          style={{
            position: 'absolute',
            left: HEAD_W + playX,
            top: 0,
            bottom: 0,
            width: 2,
            background: 'var(--playhead)',
            pointerEvents: 'none',
            zIndex: 3,
          }}
        />
      </div>
    </div>
  );
}
