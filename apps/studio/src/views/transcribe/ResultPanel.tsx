import { SaveLibraryButton } from '../library/SaveLibraryButton';
import { useComposeInputs } from '../compose/inputs';
import { useComposeSession } from '../compose/session';
import { useMemo, useState } from 'react';
import {
  BUILTIN_INSTRUMENTS,
  getInstrument,
  keyName,
  randomId,
  songToMidi,
  type InstrumentProfile,
  type Proposal,
  type TaskRecord,
} from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { taskQueue } from '../../engine/runtime';
import { jobs } from '../../engine/jobs';
import { previewPlayer, usePreviewId, usePreviewPosition } from '../../engine/capture-playback';
import { downloadBytes, slugify } from '../../engine/capture-files';
import { buildIdeaSong, type InsertRequest } from '../../engine/capture-song';
import { Badge, Button, Field, Progress, Select, Spinner, Tabs } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ConfidenceLegend, NoteStrip } from '../shared/NoteStrip';
import { NotationPreview } from '../shared/NotationPreview';
import { InsertDialog } from '../generate/InsertDialog';
import { Waveform, confidenceTone, pct } from './widgets';
import {
  lowConfidenceRegions,
  SOURCES,
  type Capture,
  type TranscribeOptions,
  type TranscriptionView,
} from './model';
import { recordTranscriptionInProject, storeCaptureAsset } from './persist';

const ORIGINAL_ID = 'transcribe-original';
const MIDI_ID = 'transcribe-midi';

export function ResultPanel({
  standalone = false,
  capture,
  view,
  task,
  options,
  onRerun,
}: {
  standalone?: boolean;
  capture: Capture | null;
  view: TranscriptionView | null;
  task: TaskRecord | null;
  options: TranscribeOptions;
  onRerun: () => void;
}) {
  const project = useStudio((s) => (standalone ? null : s.project));
  const st = useStudio.getState();
  const customInstruments = useSettings((s) => s.customInstruments);
  const instruments: InstrumentProfile[] = useMemo(
    () => [...BUILTIN_INSTRUMENTS, ...customInstruments],
    [customInstruments],
  );
  const [display, setDisplay] = useState<'roll' | 'notation'>('roll');
  const [instrumentChoice, setInstrumentChoice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new-track' | 'replace' | null>(null);
  const [rendering, setRendering] = useState(false);
  const playing = usePreviewId();
  const posOriginal = usePreviewPosition(ORIGINAL_ID);
  const posMidi = usePreviewPosition(MIDI_ID);

  const instrumentId = instrumentChoice ?? view?.suggestedInstrumentId ?? 'piano';
  const inst = getInstrument(instrumentId, customInstruments);
  const barTicks = view ? (view.meter.numerator * 4 * view.ppq) / view.meter.denominator : 1920;
  const regions = useMemo(() => (view ? lowConfidenceRegions(view.notes, barTicks) : []), [view, barTicks]);
  const sourceLabel = SOURCES.find((s) => s.value === options.source)?.label ?? options.source;
  const ideaTitle =
    capture?.origin === 'taps'
      ? 'Tapped rhythm'
      : capture?.origin === 'clap'
        ? 'Clapped pattern'
        : `${sourceLabel} idea`;

  const playheadTick = (() => {
    if (!view) return null;
    if (posMidi !== null) return (posMidi * view.bpm * view.ppq) / 60;
    if (posOriginal !== null) return ((posOriginal - view.offsetSeconds) * view.bpm * view.ppq) / 60;
    return null;
  })();

  const ideaSong = () =>
    buildIdeaSong({
      title: ideaTitle,
      bpm: view!.bpm,
      meter: view!.meter,
      key: view!.key ?? { tonic: 0, mode: 'major' },
      notes: view!.notes,
      instrumentId: inst.id,
      role: view!.drums
        ? inst.isDrumKit
          ? inst.defaultRole
          : 'drums'
        : inst.defaultRole === 'custom'
          ? view!.role
          : inst.defaultRole,
      trackName: inst.name,
      bars: view!.bars,
      origin: `transcription:${options.source}`,
      customInstruments,
    });

  const exportMidi = () => {
    if (!view) return;
    try {
      downloadBytes(
        songToMidi(ideaSong()),
        `${slugify(ideaTitle)}-${Math.round(view.bpm)}bpm.mid`,
        'audio/midi',
      );
    } catch (err) {
      st.toast('error', `MIDI export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Single Track: carry the transcription into Start a song as MIDI material. */
  const startSong = () => {
    if (!view) return;
    const song = ideaSong();
    useComposeInputs.getState().add({
      id: randomId('idea'),
      name: song.title,
      kind: 'midi',
      createdAt: new Date().toISOString(),
      song,
      assets: [],
    });
    useComposeSession.getState().start('midi');
    st.setMode('compose');
  };

  const newProject = async () => {
    if (!view || !capture) return;
    try {
      const song = ideaSong();
      const created = await st.newProject(ideaTitle, song);
      st.commit(
        created.song,
        `Transcribed ${sourceLabel.toLowerCase()} (${view.notes.length} notes)`,
        'import',
      );
      const asset = await storeCaptureAsset(capture);
      recordTranscriptionInProject({
        capture,
        view,
        options,
        asset,
        trackId: created.song.tracks[0]?.id,
        trackName: created.song.tracks[0]?.name ?? inst.name,
        taskId: task?.id,
      });
      st.selectTrack(created.song.tracks[0]?.id ?? null);
      st.setWorkbenchView('piano-roll');
      st.toast('success', `New project “${ideaTitle}” created from your idea`);
    } catch (err) {
      st.toast('error', `Could not create the project: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const playOriginal = async () => {
    if (playing === ORIGINAL_ID) return previewPlayer.stop();
    if (capture?.audio) await previewPlayer.play(ORIGINAL_ID, capture.audio);
  };

  const playMidi = async () => {
    if (playing === MIDI_ID) return previewPlayer.stop();
    if (!view) return;
    setRendering(true);
    try {
      const audio = await jobs.call<AudioData>('renderMix', { song: ideaSong(), sampleRate: 44100 });
      await previewPlayer.play(MIDI_ID, audio);
    } catch (err) {
      st.toast(
        'error',
        `Could not render the MIDI preview: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setRendering(false);
    }
  };

  const onProposed = async (p: Proposal, req: InsertRequest) => {
    if (!capture || !view) return;
    try {
      const asset = await storeCaptureAsset(capture);
      const target =
        req.mode === 'replace'
          ? req.trackId
          : p.after.tracks.find((t) => !p.before.tracks.some((b) => b.id === t.id))?.id;
      recordTranscriptionInProject({
        capture,
        view,
        options,
        asset,
        trackId: target,
        trackName: req.mode === 'replace' ? undefined : req.trackName,
        taskId: task?.id,
        proposalId: p.id,
        insert: req,
      });
    } catch (err) {
      st.toast(
        'warning',
        `The proposal was created, but the recording could not be stored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    st.toast(
      'success',
      req.mode === 'replace'
        ? 'Phrase substitution proposed — review it in the piano roll.'
        : 'New track proposed — review it in the piano roll.',
    );
  };

  // ------------------------------------------------------------------ status states
  const running = task && (task.status === 'queued' || task.status === 'running' || task.status === 'paused');
  return (
    <div className="panel" data-testid="transcription-result">
      <div className="panel-header">
        <Icon name="midi" />
        <h3 className="grow">Result</h3>
        {view && <Badge tone="ai">{view.method}</Badge>}
        {capture && capture.origin !== 'taps' && !running && (
          <Button size="sm" icon="rebuild" onClick={onRerun} title="Run again with the current options">
            Re-run
          </Button>
        )}
      </div>
      <div className="panel-body col" style={{ gap: 12 }}>
        {!capture && (
          <div className="muted small">
            Record, upload, tap or clap something — the transcription appears here with a confidence for every
            note.
          </div>
        )}

        {running && task && (
          <div className="col" style={{ gap: 6 }} data-testid="transcription-progress">
            <div className="row">
              <Spinner />
              <span className="grow">
                {task.message ?? (task.status === 'queued' ? 'Queued…' : 'Transcribing…')}
              </span>
              <Button size="sm" variant="danger" icon="close" onClick={() => taskQueue.cancel(task.id)}>
                Cancel
              </Button>
            </div>
            <Progress value={task.progress} ai />
          </div>
        )}
        {task && task.status === 'failed' && (
          <div className="callout danger small" role="alert">
            <strong>Transcription failed.</strong> {task.error}
            <div className="row" style={{ marginTop: 6 }}>
              <Button size="sm" onClick={() => taskQueue.retry(task.id)}>
                Retry
              </Button>
            </div>
          </div>
        )}
        {task && task.status === 'cancelled' && <div className="callout small">Transcription cancelled.</div>}

        {view && (
          <>
            <div className="row wrap" data-testid="transcription-summary">
              <Badge
                tone={confidenceTone(view.bpmConfidence)}
                title="Tempo used to place notes on bars and beats"
              >
                {Math.round(view.bpm * 10) / 10} BPM · {view.bpmSource}
                {view.bpmConfidence !== undefined ? ` · ${pct(view.bpmConfidence)}` : ''}
              </Badge>
              {view.key ? (
                <Badge tone={confidenceTone(view.keyConfidence)} title="Key used for spelling and snapping">
                  {keyName(view.key)} · {view.keySource}
                  {view.keyConfidence !== undefined ? ` · ${pct(view.keyConfidence)}` : ''}
                </Badge>
              ) : (
                !view.drums && <Badge>key unknown</Badge>
              )}
              <Badge>
                {view.notes.length}{' '}
                {view.drums
                  ? view.notes.length === 1
                    ? 'hit'
                    : 'hits'
                  : view.notes.length === 1
                    ? 'note'
                    : 'notes'}{' '}
                · {view.bars} {view.bars === 1 ? 'bar' : 'bars'} · {view.meter.numerator}/
                {view.meter.denominator}
              </Badge>
              <Badge tone={confidenceTone(view.confidence)} title="Overall transcription confidence">
                confidence {pct(view.confidence)}
              </Badge>
            </div>
            {view.warnings.length > 0 && (
              <div className="callout warning small" data-testid="transcription-warnings">
                {view.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}

            <div className="row between wrap">
              <Tabs
                value={display}
                onChange={setDisplay}
                tabs={[
                  { value: 'roll', label: 'Piano roll', icon: 'midi' },
                  { value: 'notation', label: 'Notation', icon: 'music' },
                ]}
              />
              <ConfidenceLegend notes={view.notes} />
            </div>
            {display === 'roll' ? (
              <NoteStrip
                notes={view.notes}
                ppq={view.ppq}
                meter={view.meter}
                totalTicks={view.bars * barTicks}
                height={view.drums ? 120 : 170}
                drums={view.drums}
                playheadTick={playheadTick}
                ariaLabel={`Transcription: ${view.notes.length} notes`}
                testId="transcription-strip"
              />
            ) : (
              <div
                style={{
                  background: 'var(--bg-elev-1)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: 6,
                }}
              >
                <NotationPreview
                  notes={view.notes}
                  ppq={view.ppq}
                  meter={view.meter}
                  keySignature={view.key}
                  clef={view.drums ? 'percussion' : inst.isDrumKit ? 'auto' : inst.clef}
                  transpose={view.drums ? 0 : (inst.notationTranspose ?? 0)}
                  drums={view.drums}
                  bars={view.bars}
                  maxBars={16}
                />
              </div>
            )}
            {regions.length > 0 ? (
              <div className="small" data-testid="low-confidence-regions">
                <Icon
                  name="alert"
                  size={12}
                  style={{ display: 'inline', verticalAlign: '-2px', color: 'var(--danger)' }}
                />{' '}
                Check{' '}
                {regions.map((r, i) => (
                  <span key={i}>
                    {i > 0 ? ', ' : ''}
                    <strong>
                      bar{r.to > r.from ? 's' : ''} {r.from}
                      {r.to > r.from ? `–${r.to}` : ''}
                    </strong>{' '}
                    ({r.count} uncertain)
                  </span>
                ))}{' '}
                — uncertain notes are outlined; listen back and fix them in the piano roll after inserting.
              </div>
            ) : (
              view.notes.length > 0 && <div className="small muted">No low-confidence notes.</div>
            )}

            {capture?.audio && <Waveform audio={capture.audio} height={40} position={posOriginal} />}
            <div className="row wrap">
              {capture?.audio && (
                <Button
                  size="sm"
                  icon={playing === ORIGINAL_ID ? 'stop' : 'play'}
                  onClick={() => void playOriginal()}
                >
                  {playing === ORIGINAL_ID ? 'Stop' : 'Play original'}
                </Button>
              )}
              <Button
                size="sm"
                icon={playing === MIDI_ID ? 'stop' : 'play'}
                onClick={() => void playMidi()}
                disabled={!view.notes.length || rendering}
              >
                {rendering ? 'Rendering…' : playing === MIDI_ID ? 'Stop' : 'Play MIDI'}
              </Button>
              <span className="small dim">A/B the performance against the transcription.</span>
            </div>

            <div className="divider" />
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field
                label="Instrument"
                hint={view.suggestedInstrumentId === instrumentId ? 'Suggested from the source' : undefined}
              >
                <Select
                  value={instrumentId}
                  onChange={setInstrumentChoice}
                  options={instruments.map((i) => ({ value: i.id, label: i.name }))}
                  aria-label="Transcription instrument"
                />
              </Field>
              <div className="spacer" />
              <SaveLibraryButton song={ideaSong} />
              {capture?.bytes && (
                <SaveLibraryButton
                  label="Save original audio"
                  file={async () => ({
                    name: capture.name,
                    kind: 'audio',
                    assets: [],
                    attestation: capture.attestation,
                    file: {
                      name: capture.name,
                      mime: capture.mimeType ?? 'audio/wav',
                      bytes: capture.bytes!,
                    },
                  })}
                />
              )}
              {!standalone && (
                <>
                  <Button
                    variant="ai"
                    icon="plus"
                    disabled={!view.notes.length}
                    onClick={() => (project ? setDialog('new-track') : void newProject())}
                    data-testid="insert-new-track"
                  >
                    {project ? 'Insert as new track…' : 'Insert as new track (new project)'}
                  </Button>
                  <Button
                    icon="scissors"
                    disabled={
                      !view.notes.length || !project || !project.song.tracks.some((t) => t.kind === 'midi')
                    }
                    onClick={() => setDialog('replace')}
                    title={
                      project
                        ? 'Substitute a phrase of an existing track (spec §73)'
                        : 'Open a project to replace a phrase in one of its tracks'
                    }
                    data-testid="replace-phrase"
                  >
                    Replace a phrase…
                  </Button>
                </>
              )}
              <Button
                icon="download"
                disabled={!view.notes.length}
                onClick={exportMidi}
                data-testid="export-transcription"
              >
                Export MIDI
              </Button>
              {standalone ? (
                <Button
                  variant="primary"
                  icon="sparkles"
                  disabled={!view.notes.length}
                  onClick={startSong}
                  data-testid="start-song-from-idea"
                >
                  Start a song with it
                </Button>
              ) : (
                <Button
                  icon="folder"
                  disabled={!view.notes.length}
                  onClick={() => void newProject()}
                  data-testid="new-project-from-idea"
                >
                  New project from this idea
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      {dialog && project && view && (
        <InsertDialog
          title={
            dialog === 'replace'
              ? 'Replace a phrase with the transcription'
              : 'Insert the transcription as a new track'
          }
          song={project.song}
          defaultMode={dialog}
          allowSourceRange
          material={{
            notes: view.notes,
            bars: view.bars,
            ppq: view.ppq,
            meter: view.meter,
            key: view.key,
            instrumentId: inst.id,
            role: view.drums ? 'drums' : inst.defaultRole === 'custom' ? view.role : inst.defaultRole,
            trackName:
              capture?.origin === 'taps' ? 'Tapped rhythm' : `${inst.name} (${sourceLabel.toLowerCase()})`,
            drums: view.drums,
          }}
          source="songdeck-dsp"
          instruction={`${sourceLabel} → MIDI`}
          explanation={`Transcribed on-device (${view.method}); ${Math.round(view.bpm)} BPM, overall confidence ${pct(view.confidence)}. Low-confidence notes are outlined in the piano roll.`}
          proposalTitle={(req) =>
            req.mode === 'replace'
              ? `Substitute bars ${req.targetBar}–${req.endBar} with ${sourceLabel.toLowerCase()} transcription`
              : `Add transcribed ${sourceLabel.toLowerCase()} as “${req.trackName}”`
          }
          onClose={() => setDialog(null)}
          onProposed={(p, req) => void onProposed(p, req)}
        />
      )}
    </div>
  );
}
