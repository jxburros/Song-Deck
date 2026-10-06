import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  barToTick,
  channelFor,
  createTimeMap,
  getInstrument,
  hasAttachedMidi,
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
import { useCustomInstruments, usePlayhead } from '../../hooks';
import { LockButton } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { saveSongToLibrary } from '../../state/library';
import { colorForRole, setChannel } from './tracks';
import { sectionColor } from '../../ui/theme';
import { useLoopSync } from './useLoopSync';
import { MakeMidiDialog, PlaySwitch, canTune } from '../shared/AudioMidiPanel';
import {
  copyAttachedMidiToTrack,
  removeAttachedMidi,
  setAudioMidiPlay,
  setTuningEnabled,
} from '../../engine/audio-midi';

const HEAD_W = 200;
const SECTION_H = 22;
const RULER_H = 20;
const CHORD_H = 22;
const HEADER_H = SECTION_H + RULER_H + CHORD_H;

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
  // MIDI attached to audio is drawn faintly under the clips while the recording plays.
  const noteAlpha = hasAttachedMidi(track) && track.audioMidi.play === 'audio' ? 0.45 : 1;
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
        boxShadow: locked ? 'inset 0 0 0 1px color-mix(in srgb, var(--lock) 55%, transparent)' : undefined,
      }}
      onClick={(e) => {
        e.stopPropagation();
        st.selectTrack(track.id);
        st.setSelection({
          startTick: span.startTick,
          endTick: span.endTick,
          sectionIds: [span.section.id],
          trackIds: [track.id],
          noteIds: [],
        });
      }}
      onDoubleClick={() => {
        st.selectTrack(track.id);
        st.setWorkbenchView('piano-roll');
      }}
      title={`${track.name} · ${span.section.name}${locked ? ' (locked)' : ''}`}
    >
      {notes.length > 0 && (
        <svg
          width={Math.max(2, w - 2)}
          height={h - 6}
          style={{ position: 'absolute', left: 0, top: 0 }}
          aria-hidden="true"
        >
          {notes.map((n) => {
            const nx = ((n.tick - span.startTick) / len) * (w - 2);
            const nw = Math.max(1.5, (n.duration / len) * (w - 2));
            const ny = 4 + inner - ((n.pitch - lo + 0.5) / range) * inner;
            return (
              <rect
                key={n.id}
                x={nx}
                y={ny - 1.5}
                width={nw}
                height={3}
                rx={1}
                fill={color}
                opacity={(0.35 + (n.velocity / 127) * 0.65) * noteAlpha}
              />
            );
          })}
        </svg>
      )}
      {changed && (
        <span
          className="badge warning"
          style={{ position: 'absolute', left: 4, top: 3, height: 15, fontSize: 9, padding: '0 4px' }}
        >
          Δ proposal
        </span>
      )}
      <div style={{ position: 'absolute', right: 2, top: 2 }}>
        <LockButton
          locked={locked}
          onToggle={() =>
            st.toggleLock(
              LockKeys.trackSection(track.id, span.section.id),
              `${explicitLock ? 'Unlocked' : 'Locked'} ${track.name} · ${span.section.name}`,
            )
          }
          title={locked && !explicitLock ? 'Locked via track or section lock' : undefined}
        />
      </div>
    </div>
  );
});

/** Sticky track header: name, instrument and size, plus a menu with the track's actions. */
function TrackHead({ song, track, selected }: { song: Song; track: Track; selected: boolean }) {
  const st = useStudio.getState();
  const customInstruments = useCustomInstruments();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ch = channelFor(song, track.id);
  const locked = !!song.locks[LockKeys.track(track.id)];
  const inst = getInstrument(track.instrumentId, customInstruments);
  const attached = hasAttachedMidi(track) ? track.audioMidi : null;
  const [makeMidi, setMakeMidi] = useState(false);
  const size = attached
    ? `${track.notes.length} notes`
    : track.kind === 'audio'
      ? `${track.clips.length} clips`
      : `${track.notes.length} notes`;
  // Audio with MIDI made from it: the switch shows what plays; the note says how.
  const attachedNote = attached
    ? attached.play === 'midi'
      ? getInstrument(attached.instrumentId, customInstruments).name
      : attached.tuning?.enabled && canTune(track)
        ? 'tuned'
        : ''
    : '';
  const act = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };
  return (
    <div
      className={`arr-track-head ${selected ? 'selected' : ''}`}
      data-testid="track-header"
      onClick={() => st.selectTrack(track.id)}
      onDoubleClick={() => {
        st.selectTrack(track.id);
        if (track.kind === 'midi' || attached) st.setWorkbenchView('piano-roll');
      }}
    >
      <span className="arr-track-color" style={{ background: track.color || colorForRole(track.role) }} />
      <div className="arr-track-text">
        <div className="ellipsis arr-track-name">{track.name}</div>
        {attached ? (
          <div
            className="row arr-track-sub"
            title={`${attached.play === 'midi' ? 'Plays the MIDI' : 'Plays the audio'}${attachedNote ? ` (${attachedNote})` : ''} · ${size}`}
          >
            <PlaySwitch track={track} size="sm" />
            <span className="ellipsis small dim">
              {size}
              {attachedNote ? ` · ${attachedNote}` : ''}
            </span>
          </div>
        ) : (
          <div className="ellipsis small dim">
            {track.kind === 'audio' ? 'Audio' : inst.name} · {size}
          </div>
        )}
      </div>
      {(ch.mute || ch.solo || locked) && (
        <span className="arr-track-flags small" aria-label="Track state">
          {ch.mute && <span title="Muted">M</span>}
          {ch.solo && <span title="Soloed">S</span>}
          {locked && <Icon name="lock" size={12} />}
        </span>
      )}
      <button
        type="button"
        className="arr-track-more"
        aria-label={`${track.name} options`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          e.stopPropagation();
          st.selectTrack(track.id);
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu(menu ? null : { x: r.right + 4, y: r.top });
        }}
      >
        <Icon name="more" size={16} />
      </button>
      {menu && (
        <>
          <div className="menu-backdrop" onClick={(e) => (e.stopPropagation(), setMenu(null))} />
          <div
            className="menu panel"
            role="menu"
            aria-label={`${track.name} options`}
            style={{
              left: Math.min(menu.x, window.innerWidth - 270),
              top: Math.min(menu.y, window.innerHeight - 330),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="menu-title">{track.name}</span>
            {track.kind === 'midi' && (
              <button type="button" role="menuitem" onClick={act(() => st.setWorkbenchView('piano-roll'))}>
                <Icon name="pencil" /> Edit notes
              </button>
            )}
            {track.kind === 'audio' && !attached && (
              <button type="button" role="menuitem" onClick={act(() => setMakeMidi(true))}>
                <Icon name="midi" /> Make MIDI from audio…
              </button>
            )}
            {attached && (
              <>
                <button type="button" role="menuitem" onClick={act(() => st.setWorkbenchView('piano-roll'))}>
                  <Icon name="pencil" /> Edit MIDI
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={act(() => setAudioMidiPlay(track.id, attached.play === 'midi' ? 'audio' : 'midi'))}
                >
                  <Icon name={attached.play === 'midi' ? 'waveform' : 'midi'} />{' '}
                  {attached.play === 'midi' ? 'Play the audio' : 'Play the MIDI'}
                </button>
                {canTune(track) && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={act(() => setTuningEnabled(track.id, !attached.tuning?.enabled))}
                  >
                    <Icon name="sliders" />{' '}
                    {attached.tuning?.enabled ? 'Stop tuning the audio' : 'Tune the audio to the MIDI'}
                  </button>
                )}
                <button type="button" role="menuitem" onClick={act(() => copyAttachedMidiToTrack(track.id))}>
                  <Icon name="copy" /> Copy MIDI to a new track
                </button>
                <button type="button" role="menuitem" onClick={act(() => setMakeMidi(true))}>
                  <Icon name="rebuild" /> Remake MIDI…
                </button>
                <button type="button" role="menuitem" onClick={act(() => removeAttachedMidi(track.id))}>
                  <Icon name="trash" /> Remove MIDI
                </button>
              </>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={act(
                () =>
                  void saveSongToLibrary(song, [track.id]).then(
                    () => st.toast('success', 'Saved to Library'),
                    (e) => st.toast('error', `Could not save to Library: ${String(e)}`),
                  ),
              )}
            >
              <Icon name="book" /> Save track to Library
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={act(() =>
                st.commit(
                  setChannel(song, track.id, { mute: !ch.mute }),
                  `${ch.mute ? 'Unmuted' : 'Muted'} ${track.name}`,
                  'mix',
                ),
              )}
            >
              <Icon name="minus" /> {ch.mute ? 'Unmute' : 'Mute'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={act(() =>
                st.commit(
                  setChannel(song, track.id, { solo: !ch.solo }),
                  `${ch.solo ? 'Unsoloed' : 'Soloed'} ${track.name}`,
                  'mix',
                ),
              )}
            >
              <Icon name="eye" /> {ch.solo ? 'Unsolo' : 'Solo'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={act(() =>
                st.toggleLock(LockKeys.track(track.id), `${locked ? 'Unlocked' : 'Locked'} ${track.name}`),
              )}
            >
              <Icon name={locked ? 'unlock' : 'lock'} /> {locked ? 'Unlock track' : 'Lock track'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={act(() => {
                st.setRightPanel('inspector');
                st.setMode('workbench');
              })}
            >
              <Icon name="info" /> Track details
            </button>
          </div>
        </>
      )}
      {makeMidi && <MakeMidiDialog track={track} onClose={() => setMakeMidi(false)} />}
    </div>
  );
}

export default function ArrangementView() {
  const song = useStudio((s) => s.project?.song ?? null);
  const view = useStudio((s) => s.view);
  const selection = useStudio((s) => s.selection);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const follow = useStudio((s) => s.transport.follow);
  const proposal = useStudio((s) =>
    s.proposals.find((p) => p.id === s.activeProposalId && p.status === 'pending'),
  );
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
      for (const span of layout)
        if (ticks.some((t) => t >= span.startTick && t < span.endTick))
          set.add(`${td.trackId}:${span.section.id}`);
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
  const selW =
    selection.startTick !== undefined && selection.endTick !== undefined
      ? (selection.endTick - selection.startTick) * pxPerTick
      : 0;

  return (
    <div
      ref={scrollRef}
      className="scroll"
      style={{ position: 'absolute', inset: 0 }}
      data-testid="arrangement"
    >
      <div style={{ width: HEAD_W + totalWidth, position: 'relative', minHeight: '100%' }}>
        {/* Header: sections, bar ruler, chords */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 4,
            display: 'flex',
            background: 'var(--bg-elev-1)',
            borderBottom: '1px solid var(--border-strong)',
          }}
        >
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
            style={{
              position: 'relative',
              width: totalWidth,
              height: HEADER_H,
              cursor: 'pointer',
              userSelect: 'none',
            }}
            onPointerDown={onRulerDown}
            onPointerMove={onRulerMove}
            onPointerUp={onRulerUp}
          >
            {layout.map((span) => {
              const locked = !!song.locks[LockKeys.section(span.section.id)];
              const active = !!selection.sectionIds?.includes(span.section.id);
              return (
                <div
                  key={span.section.id}
                  className={`arr-section ${active ? 'active' : ''}`}
                  style={{
                    left: span.startTick * pxPerTick,
                    width: (span.endTick - span.startTick) * pxPerTick,
                    height: SECTION_H,
                    ['--sec' as string]: sectionColor(span.section.kind),
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="arr-section-name"
                    title={`Select ${span.section.name} (scope for changes and regeneration)${span.section.purpose ? ` — ${span.section.purpose}` : ''}`}
                    aria-pressed={active}
                    onClick={() =>
                      st.setSelection(
                        active
                          ? { startTick: undefined, endTick: undefined, sectionIds: [], noteIds: [] }
                          : {
                              startTick: span.startTick,
                              endTick: span.endTick,
                              sectionIds: [span.section.id],
                              noteIds: [],
                            },
                      )
                    }
                  >
                    {span.section.name}
                  </button>
                  {(locked || active) && (
                    <LockButton
                      locked={locked}
                      onToggle={() =>
                        st.toggleLock(
                          LockKeys.section(span.section.id),
                          `${locked ? 'Unlocked' : 'Locked'} section ${span.section.name}`,
                        )
                      }
                    />
                  )}
                </div>
              );
            })}
            <svg
              width={totalWidth}
              height={RULER_H}
              style={{ position: 'absolute', top: SECTION_H, left: 0 }}
              aria-hidden="true"
            >
              {Array.from({ length: bars + 1 }, (_, b) => {
                const x = barToTick(song, b) * pxPerTick;
                const showNum = view.pxPerBeat * 4 >= 22 || b % 4 === 0;
                return (
                  <g key={b}>
                    <line x1={x} x2={x} y1={b % 4 === 0 ? 4 : 10} y2={RULER_H} stroke="var(--grid-bar)" />
                    {showNum && b < bars && (
                      <text
                        x={x + 3}
                        y={13}
                        fontSize={10}
                        fill="var(--text-muted)"
                        fontFamily="var(--font-mono)"
                      >
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
              <div
                style={{
                  position: 'absolute',
                  left: selX,
                  width: selW,
                  top: SECTION_H,
                  height: RULER_H,
                  background: 'var(--accent-soft)',
                  borderBottom: '2px solid var(--accent)',
                }}
              />
            )}
          </div>
        </div>

        {/* Track rows */}
        {song.tracks.map((track) => (
          <div
            key={track.id}
            style={{ display: 'flex', height: view.trackHeight, borderBottom: '1px solid var(--border)' }}
          >
            <TrackHead song={song} track={track} selected={track.id === selectedTrackId} />
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
                  selected={
                    !!selection.sectionIds?.includes(span.section.id) &&
                    (!selection.trackIds?.length || selection.trackIds.includes(track.id))
                  }
                />
              ))}
              {track.clips.map((c) => {
                const playsMidi = hasAttachedMidi(track) && track.audioMidi.play === 'midi';
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
                      background: playsMidi ? 'transparent' : `${track.color || colorForRole(track.role)}22`,
                      border: `1px ${playsMidi ? 'dashed' : 'solid'} ${track.color || colorForRole(track.role)}`,
                      borderRadius: 5,
                      fontSize: 11,
                      padding: '2px 6px',
                      overflow: 'hidden',
                      opacity: c.muted || playsMidi ? 0.4 : 1,
                      // clicks reach the section block underneath (select, double-click to edit)
                      pointerEvents: 'none',
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
              background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
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
