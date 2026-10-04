import { memo, useMemo, useState } from 'react';
import { createTimeMap, sectionLayout, songDurationSeconds, type Song, type Track } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { formatTime, usePlayhead } from '../../hooks';
import { Button } from '../../ui/kit';

const TrackLane = memo(function TrackLane({
  song,
  track,
  duration,
}: {
  song: Song;
  track: Track;
  duration: number;
}) {
  const time = useMemo(() => createTimeMap(song), [song]);
  return (
    <svg
      viewBox="0 0 1000 24"
      preserveAspectRatio="none"
      aria-label={`${track.name}: ${track.kind === 'midi' ? `${track.notes.length} notes` : `${track.clips.length} clips`}`}
      role="img"
    >
      {track.notes
        .filter((_, i) => i % Math.max(1, Math.ceil(track.notes.length / 600)) === 0)
        .map((n) => (
          <rect
            key={n.id}
            x={(1000 * time.tickToSeconds(n.tick)) / duration}
            y={3 + ((127 - n.pitch) / 127) * 15}
            width={Math.max(
              1,
              (1000 * (time.tickToSeconds(n.tick + n.duration) - time.tickToSeconds(n.tick))) / duration,
            )}
            height={4}
            rx={1}
            fill={track.color}
          />
        ))}
      {track.clips.map((c) => (
        <g key={c.id}>
          <rect
            x={(1000 * time.tickToSeconds(c.tick)) / duration}
            y={3}
            width={(1000 * c.durationSeconds) / duration}
            height={18}
            rx={3}
            fill={track.color}
            opacity={c.muted ? 0.25 : 0.75}
          />
          <title>
            {c.name ?? track.name} · {formatTime(c.durationSeconds)}
          </title>
        </g>
      ))}
    </svg>
  );
});

export function ProjectTimeline() {
  const song = useStudio((s) => s.project?.song);
  const pos = usePlayhead();
  const [collapsed, setCollapsed] = useState(false);
  const time = useMemo(() => (song ? createTimeMap(song) : null), [song]);
  const duration = useMemo(() => {
    if (!song || !time) return 1;
    let end = songDurationSeconds(song);
    for (const t of song.tracks) {
      for (const n of t.notes) end = Math.max(end, time.tickToSeconds(n.tick + n.duration));
      for (const c of t.clips) end = Math.max(end, time.tickToSeconds(c.tick) + c.durationSeconds);
    }
    return Math.max(1, end);
  }, [song, time]);
  if (!song || !time) return null;
  const st = useStudio.getState();
  return (
    <section className="project-timeline" aria-label="Live project timeline" data-testid="project-timeline">
      <div className="timeline-ruler">
        <Button size="sm" variant="ghost" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? 'Show timeline' : 'Hide timeline'}
        </Button>
        <label className="timeline-seek">
          <span className="sr-only">Seek project playback</span>
          <input
            aria-label="Seek project playback"
            type="range"
            min={0}
            max={duration}
            step={0.01}
            value={Math.min(pos, duration)}
            onChange={(e) => st.seek(Number(e.target.value))}
          />
        </label>
        <span className="small muted">
          {formatTime(pos)} / {formatTime(duration)}
        </span>
      </div>
      {!collapsed && (
        <div className="timeline-scroll">
          <div className="timeline-row">
            <span className="small muted">Arrangement</span>
            <div className="timeline-sections">
              {sectionLayout(song).map((s) => (
                <button
                  key={s.section.id}
                  title={`${s.section.name} · bar ${s.startBar + 1}`}
                  style={{
                    left: `${(100 * time.tickToSeconds(s.startTick)) / duration}%`,
                    width: `${(100 * (time.tickToSeconds(s.endTick) - time.tickToSeconds(s.startTick))) / duration}%`,
                  }}
                  onClick={() => st.seek(time.tickToSeconds(s.startTick))}
                >
                  {s.section.name}
                </button>
              ))}
            </div>
          </div>
          {!song.tracks.length && <p className="small muted">Add tracks to see the arrangement here.</p>}
          {song.tracks.map((t) => (
            <div className="timeline-row" key={t.id}>
              <button
                className="timeline-track-name"
                title={`Open ${t.name}`}
                onClick={() => {
                  st.selectTrack(t.id);
                  st.setWorkbenchView('arrangement');
                }}
              >
                {t.name}
              </button>
              <div
                className="timeline-lane"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  st.seek(Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration)));
                }}
              >
                <TrackLane song={song} track={t} duration={duration} />
                <span
                  className="timeline-playhead"
                  style={{ left: `${(100 * Math.min(pos, duration)) / duration}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
