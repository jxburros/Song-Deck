import { useEffect, useMemo } from 'react';
import {
  createTimeMap,
  keyAtBar,
  keyName,
  sectionLayout,
  songDurationSeconds,
  tickToMusical,
} from '@songdeck/core';
import { useStudio, type Mode } from '../../state/store';
import { useSettings } from '../../state/settings';
import { openSettings } from '../settings/nav';
import { useRuntime } from '../../engine/runtime';
import { Icon, BrandMark, type IconName } from '../../ui/icons';
import { Button } from '../../ui/kit';
import { formatTime, usePlayhead, usePlayerState } from '../../hooks';
import { sectionColor } from '../../ui/theme';
import { CollabPresence } from '../shared/CollabPresence';

/**
 * The studio shell: a rail with the areas (Songs, Single Track, AI Audio, Library, Settings), and — while a
 * song is open — a song header (steps Write · Sound · Export, More tools) and a player bar.
 */

/** Modes that belong to an open song: its three steps, the More tools hub and the detailed tools. */
export const SONG_MODES: Mode[] = [
  'workbench',
  'sound',
  'export',
  'tools',
  'produce',
  'vocals',
  'mix',
  'generate',
  'transcribe',
];

/** Detailed tools reached from More tools, with the label the song header shows for them. */
export const TOOL_LABELS: Partial<Record<Mode, string>> = {
  produce: 'Production',
  vocals: 'Vocals',
  mix: 'Mixing and mastering',
  generate: 'Describe a part',
  transcribe: 'Part from audio',
};

type Area = 'songs' | 'single' | 'audio' | 'library' | 'settings';

export function areaOf(mode: Mode): Area {
  if (mode === 'single') return 'single';
  if (mode === 'audio') return 'audio';
  if (mode === 'library') return 'library';
  if (mode === 'settings') return 'settings';
  return 'songs';
}

const AREAS: { area: Area; mode: Mode; label: string; icon: IconName; title: string }[] = [
  { area: 'songs', mode: 'home', label: 'Songs', icon: 'music', title: 'Make and open songs' },
  {
    area: 'single',
    mode: 'single',
    label: 'Single Track',
    icon: 'waveform',
    title: 'Make one part on its own: audio to MIDI, generate MIDI or audio',
  },
  {
    area: 'audio',
    mode: 'audio',
    label: 'AI Audio',
    icon: 'wave',
    title: 'How songs become audio: the pipeline, connected engines, their inputs and settings',
  },
  {
    area: 'library',
    mode: 'library',
    label: 'Library',
    icon: 'book',
    title: 'Uploads, saved parts and Single Track results, usable in any song',
  },
];

/** Where the Songs area was last: coming back from another area returns there. */
let lastSongsMode: Mode = 'home';

export function Rail() {
  const mode = useStudio((s) => s.mode);
  const setMode = useStudio((s) => s.setMode);
  const hasProject = useStudio((s) => !!s.project);
  const offline = useSettings((s) => s.routing.offline);
  const active = areaOf(mode);
  useEffect(() => {
    if (areaOf(mode) === 'songs') lastSongsMode = mode;
  }, [mode]);
  const open = (a: Area, target: Mode) => {
    if (a !== 'songs' || active === 'songs') return setMode(target);
    setMode(!hasProject && SONG_MODES.includes(lastSongsMode) ? 'home' : lastSongsMode);
  };
  const item = (
    a: (typeof AREAS)[number] | { area: Area; mode: Mode; label: string; icon: IconName; title: string },
  ) => (
    <button
      key={a.area}
      type="button"
      className={`rail-item ${active === a.area ? 'active' : ''}`}
      aria-current={active === a.area ? 'page' : undefined}
      title={a.title}
      onClick={() => open(a.area, a.mode)}
    >
      <Icon name={a.icon} size={22} />
      <span>{a.label}</span>
    </button>
  );
  return (
    <nav className="rail" aria-label="Main">
      <button
        type="button"
        className="rail-brand"
        onClick={() => setMode('home')}
        title="Song Deck — songs"
        aria-label="Song Deck — songs"
      >
        <BrandMark />
      </button>
      {AREAS.map(item)}
      <div className="rail-spacer" />
      {offline && (
        <button
          type="button"
          className="rail-offline"
          title="Offline mode — nothing leaves this device"
          aria-label="Offline mode — nothing leaves this device"
          onClick={() => openSettings('privacy')}
        >
          <Icon name="shield" size={16} />
          <span>Offline</span>
        </button>
      )}
      {item({
        area: 'settings',
        mode: 'settings',
        label: 'Settings',
        icon: 'settings',
        title: 'Settings: AI services, privacy and spending, general',
      })}
    </nav>
  );
}

const STEPS: { mode: 'workbench' | 'sound' | 'export'; label: string; num: string; title: string }[] = [
  { mode: 'workbench', label: 'Write', num: '01', title: 'Arrangement, notes, chords, lyrics and changes' },
  { mode: 'sound', label: 'Sound', num: '02', title: 'Instruments, levels, audio versions and finish' },
  { mode: 'export', label: 'Export', num: '03', title: 'Audio, stems, MIDI, backups and more formats' },
];

function QueueChip() {
  const tasks = useRuntime((s) => s.tasks);
  const open = useStudio((s) => s.taskDrawerOpen);
  const running = tasks.filter((t) => t.status === 'running').length;
  const queued = tasks.filter((t) => t.status === 'queued').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  if (!running && !queued && !failed && !open) return null;
  const label = [running && `${running} running`, queued && `${queued} queued`, failed && `${failed} failed`]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      className={`queue-chip ${failed ? 'failed' : ''}`}
      title="Generation queue"
      aria-expanded={open}
      onClick={() => useStudio.getState().setTaskDrawer(!open)}
    >
      <span className={`diamond ${running ? '' : failed ? 'warn' : 'off'}`} />
      Queue{label ? ` · ${label}` : ''}
    </button>
  );
}

export function SongHeader() {
  const mode = useStudio((s) => s.mode);
  const project = useStudio((s) => s.project);
  const saving = useStudio((s) => s.saving);
  const setMode = useStudio((s) => s.setMode);
  if (!project) return null;
  const branch = project.history.branches.find((b) => b.id === project.history.currentBranchId);
  const head = project.history.revisions.find((r) => r.id === branch?.headRevisionId);
  const tool = TOOL_LABELS[mode];
  const inTools = mode === 'tools' || !!tool;
  return (
    <header className="song-header">
      <div className="song-title">
        <nav aria-label="Breadcrumb" className="crumbs">
          <button type="button" className="crumb" onClick={() => setMode('home')}>
            Songs
          </button>
          <span aria-hidden="true">/</span>
          {inTools && (
            <>
              <button type="button" className="crumb" onClick={() => setMode('tools')}>
                More tools
              </button>
              {tool && <span aria-hidden="true">/</span>}
              {tool && <span className="crumb-current">{tool}</span>}
            </>
          )}
        </nav>
        <div className="row" style={{ gap: 10, minWidth: 0 }}>
          <span className="song-name ellipsis" title={project.meta.name}>
            {project.meta.name}
          </span>
          <span className="saved-state" title="Saved on this device as you work">
            <span className={`diamond ${saving ? 'warn' : 'ok'}`} />
            {saving ? 'Saving…' : 'Saved'}
            {head ? ` · v${head.number}` : ''}
          </span>
          {branch && branch.name !== 'main' && (
            <button
              type="button"
              className="badge accent branch-badge"
              title="Branches & version history"
              onClick={() => {
                useStudio.getState().setRightPanel('history');
                setMode('workbench');
              }}
            >
              <Icon name="branch" size={12} /> {branch.name}
            </button>
          )}
        </div>
      </div>
      <nav className="steps" aria-label="Song steps">
        {STEPS.map((s) => (
          <button
            key={s.mode}
            type="button"
            className="step"
            aria-current={mode === s.mode ? 'page' : undefined}
            title={s.title}
            onClick={() => setMode(s.mode)}
          >
            <span className="num" aria-hidden="true">
              {s.num}
            </span>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <div className="song-actions">
        <CollabPresence />
        <QueueChip />
        <Button
          variant="ghost"
          icon="undo"
          title="Undo (Ctrl/Cmd+Z)"
          aria-label="Undo"
          onClick={() => useStudio.getState().undo()}
        />
        <Button
          variant="ghost"
          icon="redo"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          aria-label="Redo"
          onClick={() => useStudio.getState().redo()}
        />
        <Button
          icon={mode === 'tools' ? 'close' : 'grid'}
          active={inTools}
          aria-pressed={mode === 'tools'}
          title="Every detailed editor for this song"
          onClick={() => setMode(mode === 'tools' ? useStudio.getState().songStep : 'tools')}
        >
          {mode === 'tools' ? 'Close More tools' : 'More tools'}
        </Button>
      </div>
    </header>
  );
}

export function PlayerBar() {
  const song = useStudio((s) => s.project?.song ?? null);
  const metronome = useStudio((s) => s.transport.metronome);
  const loopEnabled = useStudio((s) => s.transport.loop.enabled);
  const playing = usePlayerState();
  const pos = usePlayhead();
  const time = useMemo(() => (song ? createTimeMap(song) : null), [song]);
  const layout = useMemo(() => (song ? sectionLayout(song) : []), [song]);
  const duration = useMemo(() => (song ? Math.max(1, songDurationSeconds(song)) : 1), [song]);
  if (!song || !time) return null;
  const st = useStudio.getState();
  const tick = time.secondsToTick(pos);
  const mus = tickToMusical(song, tick);
  const bpm = Math.round(time.bpmAt(tick));
  const key = keyName(keyAtBar(song, Math.max(0, mus.bar - 1)));
  const meter = song.meterMap[0];
  const at = Math.min(100, (pos / duration) * 100);
  return (
    <footer className="player-bar" aria-label="Player">
      <Button
        variant="ghost"
        icon="rewind"
        title="Return to start"
        aria-label="Return to start"
        onClick={() => st.seek(0)}
      />
      <Button
        variant="primary"
        className="play-btn"
        icon={playing ? 'pause' : 'play'}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => st.togglePlay()}
      />
      <Button variant="ghost" icon="stop" title="Stop (Enter)" aria-label="Stop" onClick={() => st.stop()} />
      <span className="player-time mono" title="Bar.Beat · time">
        {formatTime(pos)} <span className="dim">/ {formatTime(duration)}</span>
        <span className="player-bar-beat dim">
          {' '}
          · {mus.bar}.{Math.floor(mus.beat)}
        </span>
      </span>
      <div className="player-sections">
        {layout.map((span) => {
          const start = time.tickToSeconds(span.startTick);
          const end = time.tickToSeconds(span.endTick);
          return (
            <span
              key={span.section.id}
              className="player-section"
              style={{
                flexGrow: Math.max(0.1, end - start),
                ['--sec' as string]: sectionColor(span.section.kind),
              }}
              aria-hidden="true"
            />
          );
        })}
        <span className="player-head" style={{ left: `${at}%` }} aria-hidden="true" />
        <input
          className="player-seek"
          type="range"
          aria-label="Seek project playback"
          aria-valuetext={`${formatTime(pos)}, bar ${mus.bar}`}
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(pos, duration)}
          onChange={(e) => st.seek(Number(e.target.value))}
        />
      </div>
      <span className="player-readout mono" title="Tempo and key at playhead">
        {bpm} BPM · {key}
        {meter ? ` · ${meter.numerator}/${meter.denominator}` : ''}
      </span>
      <Button
        variant="ghost"
        icon="loop"
        title="Loop selection"
        aria-label="Loop selection"
        active={loopEnabled}
        aria-pressed={loopEnabled}
        onClick={() => st.setLoop({ enabled: !loopEnabled })}
      />
      <Button
        variant="ghost"
        icon="metronome"
        title="Metronome"
        aria-label="Metronome"
        active={metronome}
        aria-pressed={metronome}
        onClick={() => st.toggleMetronome()}
      />
    </footer>
  );
}
