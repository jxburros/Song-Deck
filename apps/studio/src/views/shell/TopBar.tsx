import { createTimeMap, tickToMusical, keyAtBar, keyName } from '@songdeck/core';
import { useStudio, type Mode } from '../../state/store';
import { Icon, BrandMark, type IconName } from '../../ui/icons';
import { Button } from '../../ui/kit';
import { formatTime, usePlayhead, usePlayerState } from '../../hooks';

const MODES: { mode: Mode; label: string; icon: IconName; needsProject?: boolean; title: string }[] = [
  { mode: 'compose', label: 'Compose', icon: 'compose', title: 'Prompt → Blueprint → Plan → MIDI (spec §25 Compose)' },
  { mode: 'workbench', label: 'Workbench', icon: 'workbench', needsProject: true, title: 'MIDI Workbench: arrangement, piano roll, patterns, chords, structure, theory' },
  { mode: 'generate', label: 'Generate MIDI', icon: 'midi', title: 'Create individual musical assets' },
  { mode: 'transcribe', label: 'Transcribe', icon: 'mic', title: 'Audio → MIDI: humming, singing, instruments, taps' },
  { mode: 'rebuild', label: 'Rebuild', icon: 'rebuild', title: 'Reconstruct a recording as an editable project' },
  { mode: 'produce', label: 'Produce', icon: 'produce', needsProject: true, title: 'Guide renders and AI production (A/B candidates)' },
  { mode: 'vocals', label: 'Vocals', icon: 'music', needsProject: true, title: 'Lyrics, vocal melody, singing synthesis, recordings' },
  { mode: 'mix', label: 'Mix & Master', icon: 'mixer', needsProject: true, title: 'Mixer, automation, AI mix assistant, mastering' },
  { mode: 'export', label: 'Export', icon: 'export', needsProject: true, title: 'MIDI, audio, stems, sheets, MusicXML, DAW projects' },
];

function Transport() {
  const song = useStudio((s) => s.project?.song ?? null);
  const metronome = useStudio((s) => s.transport.metronome);
  const loopEnabled = useStudio((s) => s.transport.loop.enabled);
  const playing = usePlayerState();
  const pos = usePlayhead();
  const tm = song ? createTimeMap(song) : null;
  const tick = tm ? tm.secondsToTick(pos) : 0;
  const mus = song ? tickToMusical(song, tick) : { bar: 1, beat: 1 };
  const bpm = song && tm ? Math.round(tm.bpmAt(tick)) : 120;
  const key = song ? keyName(keyAtBar(song, Math.max(0, mus.bar - 1))) : '';
  const st = useStudio.getState();
  return (
    <div className="transport" aria-label="Transport">
      <Button variant="ghost" size="sm" icon="rewind" title="Return to start" onClick={() => st.seek(0)} disabled={!song} />
      <Button
        variant="ghost"
        size="sm"
        icon={playing ? 'pause' : 'play'}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        onClick={() => st.togglePlay()}
        disabled={!song}
      />
      <Button variant="ghost" size="sm" icon="stop" title="Stop (Enter)" onClick={() => st.stop()} disabled={!song} />
      <Button
        variant="ghost"
        size="sm"
        icon="loop"
        title="Loop selection"
        active={loopEnabled}
        onClick={() => st.setLoop({ enabled: !loopEnabled })}
        disabled={!song}
      />
      <Button variant="ghost" size="sm" icon="metronome" title="Metronome" active={metronome} onClick={() => st.toggleMetronome()} disabled={!song} />
      <span className="time" title="Bar.Beat · time">
        {mus.bar}.{Math.floor(mus.beat)} · {formatTime(pos)}
      </span>
      {song && (
        <span className="tempo" title="Tempo and key at playhead">
          {bpm} BPM · {key}
        </span>
      )}
    </div>
  );
}

export function TopBar() {
  const mode = useStudio((s) => s.mode);
  const project = useStudio((s) => s.project);
  const setMode = useStudio((s) => s.setMode);
  const branch = project?.history.branches.find((b) => b.id === project.history.currentBranchId);

  return (
    <header className="topbar">
      <div className="brand" onClick={() => setMode('home')} title="Projects">
        <BrandMark />
        <span>Song Deck</span>
      </div>
      {project && (
        <div className="row" style={{ minWidth: 0 }}>
          <span className="project-name ellipsis" title={project.meta.name}>
            {project.meta.name}
          </span>
          {branch && (
            <button className="badge accent" style={{ cursor: 'pointer' }} title="Branches & version history" onClick={() => {
              useStudio.getState().setRightPanel('history');
              setMode('workbench');
            }}>
              <Icon name="branch" size={12} /> {branch.name}
            </button>
          )}
        </div>
      )}
      <nav className="modes" aria-label="Modes">
        {MODES.map((m) => (
          <button
            key={m.mode}
            className={`mode-tab ${mode === m.mode ? 'active' : ''}`}
            onClick={() => setMode(m.mode)}
            disabled={m.needsProject && !project}
            title={m.title}
            style={m.needsProject && !project ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
          >
            <Icon name={m.icon} size={15} />
            {m.label}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      {project && (
        <div className="row">
          <Button variant="ghost" size="sm" icon="undo" title="Undo (Ctrl/Cmd+Z)" onClick={() => useStudio.getState().undo()} />
          <Button variant="ghost" size="sm" icon="redo" title="Redo (Ctrl/Cmd+Shift+Z)" onClick={() => useStudio.getState().redo()} />
        </div>
      )}
      <Transport />
      <Button variant="ghost" icon="settings" title="Settings: providers, privacy, budgets, models, plugins" onClick={() => setMode('settings')} active={mode === 'settings'} />
    </header>
  );
}
