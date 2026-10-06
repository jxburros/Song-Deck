import { useEffect, useMemo, useState } from 'react';
import {
  BUILTIN_INSTRUMENTS,
  DEFAULT_TUNING,
  HARD_TUNING,
  audioMidiIsStale,
  hasAttachedMidi,
  tuningRenderIsCurrent,
  tuningRenderIsStale,
  type AudioMidiMode,
  type AudioTuningSettings,
  type Song,
  type Track,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useCustomInstruments } from '../../hooks';
import { Badge, Button, Field, Modal, Select, Slider, Spinner, Toggle } from '../../ui/kit';
import { ProviderPicker } from './ProviderPicker';
import { useTask } from '../../engine/capture-tasks';
import {
  copyAttachedMidiToTrack,
  guessMode,
  makeMidiFromAudio,
  notesLockedReason,
  removeAttachedMidi,
  renderTuning,
  setAudioMidiInstrument,
  setAudioMidiPlay,
  setTuningEnabled,
  setTuningSettings,
  useAudioMidi,
  type MakeMidiMode,
} from '../../engine/audio-midi';

/**
 * MIDI attached to an audio track: make it from the recording, switch what plays (the recording
 * or the MIDI through an instrument), edit it in the piano roll, and tune the recording to it.
 */

const MODE_LABEL: Record<AudioMidiMode, string> = {
  melody: 'One line (voice, bass, lead)',
  chords: 'Chords (piano, guitar)',
  drums: 'Drums',
};

const MODE_OPTIONS: { value: MakeMidiMode; label: string }[] = [
  { value: 'auto', label: 'Auto (from the track)' },
  { value: 'melody', label: 'One note at a time — voice, bass, lead lines' },
  { value: 'chords', label: 'Several notes at once — piano, guitar, chords' },
  { value: 'drums', label: 'Drums and percussion' },
];

/** Tuning works on one pitch at a time. */
export function canTune(track: Track): boolean {
  return hasAttachedMidi(track) && track.audioMidi.mode === 'melody';
}

/** "Make MIDI from audio": choose what the recording holds and the transcription engine. */
export function MakeMidiDialog({ track, onClose }: { track: Track; onClose: () => void }) {
  const guess = guessMode(track);
  const [mode, setMode] = useState<MakeMidiMode>(track.audioMidi?.mode ?? 'auto');
  const [provider, setProvider] = useState('auto');
  const st = useStudio.getState();
  const song = useStudio((s) => s.project?.song);
  const remake = hasAttachedMidi(track);
  const locked = song ? notesLockedReason(song, track) : null;
  const start = () => {
    makeMidiFromAudio(track.id, mode, provider);
    st.toast('info', `Making MIDI from “${track.name}”…`);
    onClose();
  };
  return (
    <Modal
      title={`${remake ? 'Remake' : 'Make'} MIDI from “${track.name}”`}
      icon="midi"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="midi"
            onClick={start}
            disabled={!!locked}
            title={locked ?? undefined}
            data-testid="make-midi-start"
          >
            {remake ? 'Remake MIDI' : 'Make MIDI'}
          </Button>
        </>
      }
    >
      <div className="col">
        <p className="small muted" style={{ margin: 0 }}>
          The recording is turned into editable notes that sit exactly under the audio (no grid). The audio
          itself is kept: switch between hearing the recording and the MIDI at any time, and edit the notes in
          the piano roll.{remake ? ' Remaking replaces the current notes.' : ''}
        </p>
        {locked && (
          <div className="small" role="alert" style={{ color: 'var(--warning)' }}>
            {locked}
          </div>
        )}
        <Field
          label="What is in the recording?"
          hint={
            mode === 'auto'
              ? guess
                ? `This track looks like: ${MODE_LABEL[guess].toLowerCase()}.`
                : 'The instrument is detected from the sound.'
              : mode === 'melody'
                ? 'Single-line MIDI can also tune the recording (pitch correction).'
                : undefined
          }
        >
          <Select value={mode} onChange={setMode} options={MODE_OPTIONS} aria-label="Recording content" />
        </Field>
        <Field
          label="Transcription engine"
          hint="Auto follows your routing rules; the on-device engine never uploads anything."
        >
          <ProviderPicker role="transcription" value={provider} onChange={setProvider} />
        </Field>
      </div>
    </Modal>
  );
}

/** Two-way switch: what the track plays. */
export function PlaySwitch({ track, size }: { track: Track; size?: 'sm' }) {
  if (!hasAttachedMidi(track)) return null;
  const play = track.audioMidi.play;
  return (
    <div
      className={`tabs audio-midi-switch ${size === 'sm' ? 'sm' : ''}`}
      role="radiogroup"
      aria-label={`${track.name} plays`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {(['audio', 'midi'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={play === v}
          className={`tab ${play === v ? 'active' : ''}`}
          onClick={() => play !== v && setAudioMidiPlay(track.id, v)}
          title={v === 'audio' ? 'Play the recording' : 'Play the MIDI through its instrument'}
        >
          {v === 'audio' ? 'Audio' : 'MIDI'}
        </button>
      ))}
    </div>
  );
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** One-line state of the tuned recording. */
function useTuningStatus(song: Song, track: Track): { text: string; busy: boolean; failed?: string } {
  const job = useAudioMidi((s) => s.tuning[track.id]);
  const task = useTask(
    job && (job.status === 'queued' || job.status === 'running') ? (job.taskId ?? null) : null,
  );
  if (!hasAttachedMidi(track) || !track.audioMidi.tuning?.enabled) return { text: '', busy: false };
  if (track.audioMidi.play === 'midi')
    return { text: 'The tuned recording plays when the track plays audio.', busy: false };
  if (job?.status === 'queued' || job?.status === 'running')
    return {
      text: `Tuning the recording… ${task ? Math.round((task.progress ?? 0) * 100) : 0}%`,
      busy: true,
    };
  if (job?.status === 'failed') return { text: 'Tuning failed.', busy: false, failed: job.error };
  const render = track.audioMidi.tuning.render;
  if (render && tuningRenderIsCurrent(song, track))
    return {
      text: `Tuned: ${render.tunedNotes ?? 0} notes${render.skippedNotes ? ` (${render.skippedNotes} without a clear pitch left as recorded)` : ''}.`,
      busy: false,
    };
  if (tuningRenderIsStale(song, track))
    return { text: 'Updating after your edits — the original recording plays until then.', busy: true };
  return { text: '', busy: false };
}

/** Correction / flatten / speed sliders, committed on release. */
function TuningControls({ track }: { track: Track }) {
  const tuning = { ...DEFAULT_TUNING, ...track.audioMidi?.tuning };
  const [draft, setDraft] = useState<AudioTuningSettings>(tuning);
  useEffect(() => {
    setDraft({ amount: tuning.amount, flatten: tuning.flatten, speedMs: tuning.speedMs });
  }, [tuning.amount, tuning.flatten, tuning.speedMs]);
  const commit = (patch: Partial<AudioTuningSettings>) => setTuningSettings(track.id, patch);
  const preset =
    tuning.amount === HARD_TUNING.amount &&
    tuning.flatten === HARD_TUNING.flatten &&
    tuning.speedMs === HARD_TUNING.speedMs
      ? 'hard'
      : tuning.amount === DEFAULT_TUNING.amount &&
          tuning.flatten === DEFAULT_TUNING.flatten &&
          tuning.speedMs === DEFAULT_TUNING.speedMs
        ? 'natural'
        : 'custom';
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" active={preset === 'natural'} onClick={() => commit(DEFAULT_TUNING)}>
          Natural
        </Button>
        <Button size="sm" active={preset === 'hard'} onClick={() => commit(HARD_TUNING)}>
          Hard tune
        </Button>
        {preset === 'custom' && <Badge>Custom</Badge>}
      </div>
      <Slider
        label="Correction"
        value={draft.amount}
        onChange={(amount) => setDraft({ ...draft, amount })}
        onCommit={(amount) => commit({ amount })}
        format={pct}
        left="Keep intonation"
        right="Exact pitch"
      />
      <Slider
        label="Flatten drift and vibrato"
        value={draft.flatten}
        onChange={(flatten) => setDraft({ ...draft, flatten })}
        onCommit={(flatten) => commit({ flatten })}
        format={pct}
        left="Natural"
        right="Flat"
      />
      <Slider
        label="Retune speed"
        value={draft.speedMs}
        min={0}
        max={300}
        step={5}
        onChange={(speedMs) => setDraft({ ...draft, speedMs })}
        onCommit={(speedMs) => commit({ speedMs })}
        format={(v) => (v === 0 ? 'Instant' : `${Math.round(v)} ms`)}
        left="Robotic"
        right="Smooth"
      />
    </div>
  );
}

/** Full panel (track inspector): make / remake, play switch, instrument, tuning, copy, remove. */
export function AudioMidiPanel({ song, track }: { song: Song; track: Track }) {
  const st = useStudio.getState();
  const customInstruments = useCustomInstruments();
  const instruments = useMemo(() => [...BUILTIN_INSTRUMENTS, ...customInstruments], [customInstruments]);
  const making = useAudioMidi((s) => s.making[track.id]);
  const makeTask = useTask(
    making && (making.status === 'queued' || making.status === 'running') ? (making.taskId ?? null) : null,
  );
  const [dialog, setDialog] = useState(false);
  const status = useTuningStatus(song, track);
  if (track.kind !== 'audio') return null;
  const busyMaking = making?.status === 'queued' || making?.status === 'running';
  const attached = hasAttachedMidi(track) ? track.audioMidi : null;

  return (
    <div className="col audio-midi-panel" data-testid="audio-midi-panel">
      <div className="row between">
        <span className="field-label">MIDI from this audio</span>
        {attached && <Badge tone="accent">{MODE_LABEL[attached.mode]}</Badge>}
      </div>
      {busyMaking ? (
        <div className="row small">
          <Spinner /> Making MIDI… {makeTask ? `${Math.round((makeTask.progress ?? 0) * 100)}%` : ''}
        </div>
      ) : !attached ? (
        <>
          <div className="small muted">
            Turn this recording into editable MIDI. The audio is kept: switch between hearing the audio and
            the MIDI, edit the notes, and tune a sung or played line to them.
          </div>
          {making?.status === 'failed' && (
            <div className="small" style={{ color: 'var(--danger)' }}>
              Failed: {making.error}
            </div>
          )}
          <div className="row">
            <Button
              size="sm"
              variant="primary"
              icon="midi"
              onClick={() => setDialog(true)}
              data-testid="make-midi"
            >
              Make MIDI…
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="small muted">
            {track.notes.length} {attached.mode === 'drums' ? 'hits' : 'notes'}
            {attached.method ? ` · ${attached.method}` : ''}
            {attached.confidence !== undefined ? ` · confidence ${pct(attached.confidence)}` : ''}
          </div>
          {audioMidiIsStale(song, track) && (
            <div className="small" role="status" style={{ color: 'var(--warning)' }}>
              The audio changed since this MIDI was made.{' '}
              <Button size="sm" variant="ghost" onClick={() => setDialog(true)}>
                Remake MIDI
              </Button>
            </div>
          )}
          <Field label="Plays">
            <PlaySwitch track={track} />
          </Field>
          <Field
            label="MIDI instrument"
            hint="Plays the notes when the track plays MIDI, and in MIDI exports."
          >
            <Select
              value={attached.instrumentId}
              onChange={(id) => setAudioMidiInstrument(track.id, id)}
              options={instruments.map((i) => ({ value: i.id, label: i.name }))}
              aria-label="MIDI instrument"
            />
          </Field>
          {canTune(track) ? (
            <>
              <Toggle
                on={!!attached.tuning?.enabled}
                onChange={(on) => setTuningEnabled(track.id, on)}
                label="Tune the audio to the MIDI"
                title="Pitch-correct the recording so it follows the notes (autotune)"
              />
              {attached.tuning?.enabled && (
                <>
                  <TuningControls track={track} />
                  {status.text && (
                    <div className="row small muted" role="status">
                      {status.busy && <Spinner />} {status.text}
                    </div>
                  )}
                  {status.failed && (
                    <div className="small" style={{ color: 'var(--danger)' }}>
                      {status.failed}{' '}
                      <Button size="sm" variant="ghost" onClick={() => renderTuning(track.id)}>
                        Retry
                      </Button>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="small muted">
              Tuning works on single-line MIDI (voice, bass, lead). Remake the MIDI as “one note at a time” to
              tune this recording.
            </div>
          )}
          <div className="row wrap">
            <Button
              size="sm"
              icon="pencil"
              onClick={() => {
                st.selectTrack(track.id);
                st.setWorkbenchView('piano-roll');
              }}
            >
              Edit MIDI
            </Button>
            <Button size="sm" icon="copy" onClick={() => copyAttachedMidiToTrack(track.id)}>
              Copy to a MIDI track
            </Button>
            <Button size="sm" icon="rebuild" onClick={() => setDialog(true)}>
              Remake…
            </Button>
            <Button size="sm" variant="danger" icon="trash" onClick={() => removeAttachedMidi(track.id)}>
              Remove MIDI
            </Button>
          </div>
        </>
      )}
      {dialog && <MakeMidiDialog track={track} onClose={() => setDialog(false)} />}
    </div>
  );
}

/** Compact bar above the piano roll for an audio track's MIDI. */
export function AudioMidiBar({ song, track }: { song: Song; track: Track }) {
  const st = useStudio.getState();
  const status = useTuningStatus(song, track);
  if (!hasAttachedMidi(track)) return null;
  const tuning = track.audioMidi.tuning;
  return (
    <div className="row wrap audio-midi-bar" data-testid="audio-midi-bar">
      <Badge tone="accent" title="These notes were made from the track's recording">
        MIDI from audio
      </Badge>
      <span className="small muted">Plays</span>
      <PlaySwitch track={track} size="sm" />
      {canTune(track) && (
        <Toggle
          on={!!tuning?.enabled}
          onChange={(on) => setTuningEnabled(track.id, on)}
          label="Tune audio to MIDI"
          title="Pitch-correct the recording so it follows these notes (autotune)"
        />
      )}
      {status.text && (
        <span className="row small muted" role="status" style={{ gap: 4 }}>
          {status.busy && <Spinner />}
          {status.failed ? `Tuning failed: ${status.failed}` : status.text}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        icon="sliders"
        onClick={() => {
          st.setRightPanel('inspector');
          st.setMode('workbench');
        }}
      >
        {canTune(track) ? 'Tuning settings' : 'MIDI settings'}
      </Button>
    </div>
  );
}
