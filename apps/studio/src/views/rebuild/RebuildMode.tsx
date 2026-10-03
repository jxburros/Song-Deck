import { useState } from 'react';
import { randomId } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { decodeAudioBytes, guessMime } from '../../state/assets';
import { taskQueue } from '../../engine/runtime';
import { enqueueTask, isActive, useTask } from '../../engine/capture-tasks';
import { previewPlayer, usePreviewId, usePreviewPosition, useStopPreviewOnUnmount } from '../../engine/capture-playback';
import { AUDIO_ACCEPT, baseName, readFileBytes } from '../../engine/capture-files';
import { externalProvider, type RebuildTaskInput, type RebuildTaskOutput } from '../../engine/handlers/analysis';
import { ProviderPicker } from '../shared/ProviderPicker';
import { Badge, Button, Field, FileButton, Progress, Spinner, TextInput, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { Waveform, audioSummary } from '../transcribe/widgets';
import { Pipeline } from './Pipeline';
import { RebuildSummary } from './RebuildSummary';
import { openRebuildAsProject } from './openProject';
import { useRebuildSession } from './session';

const SOURCE_ID = 'rebuild-source';

export default function RebuildMode() {
  const s = useRebuildSession();
  const st = useStudio.getState();
  const task = useTask<RebuildTaskOutput>(s.taskId);
  const stemsTask = useTask(s.stemsTaskId);
  const playing = usePreviewId();
  const pos = usePreviewPosition(SOURCE_ID);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  useStopPreviewOnUnmount();

  const running = isActive(task);
  const result = task?.status === 'succeeded' ? (task.result as RebuildTaskOutput | undefined) : undefined;

  const onFiles = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setLoading(true);
    try {
      const bytes = await readFileBytes(f);
      const audio = await decodeAudioBytes(bytes);
      const durationSeconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
      if (durationSeconds < 1) throw new Error('The recording is shorter than a second.');
      previewPlayer.stop();
      s.set({
        source: { name: f.name, bytes, mimeType: guessMime(f.name, bytes), audio, durationSeconds },
        title: baseName(f.name),
        taskId: null,
        runId: null,
        stemsTaskId: null,
        opened: null,
      });
    } catch (err) {
      st.toast('error', `Could not read ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const start = () => {
    if (!s.source) return;
    const runId = randomId('run');
    const input: RebuildTaskInput = { runId, audio: s.source.audio, title: s.title.trim() || baseName(s.source.name), separationProvider: s.separationProvider };
    const ext = externalProvider('separation', s.separationProvider);
    const rec = enqueueTask({ type: 'analysis.rebuild', title: `Rebuild “${input.title}”`, input, runner: ext ? `local + ${ext.name}` : 'local', providerId: ext ? ext.providerId : 'internal-analysis' });
    s.set({ taskId: rec.id, runId, opened: null, stemsTaskId: null });
  };

  const open = async () => {
    if (!s.source || !result) return;
    setOpening('Preparing…');
    try {
      const project = await openRebuildAsProject({
        title: s.title,
        song: result.song,
        report: result.report,
        providedStems: result.stems,
        separation: result.separation,
        separationProvider: s.separationProvider,
        source: s.source,
        taskId: task?.id,
        keepStems: s.keepStems,
        onStatus: setOpening,
        onStemsTask: (id) => s.set({ stemsTaskId: id }),
      });
      s.set({ opened: { projectId: project.meta.id, name: project.meta.name } });
      st.setWorkbenchView('arrangement');
      st.toast('success', `Opened “${project.meta.name}” — ${result.song.tracks.length} rebuilt tracks${s.keepStems ? ' plus separated stems (muted) for A/B' : ''}`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') st.toast('info', 'Stem separation was cancelled — the project was not created.');
      else st.toast('error', `Could not open the project: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="mode-page" data-testid="rebuild-mode">
      <div className="page-header">
        <div className="grow">
          <h1>Rebuild</h1>
          <div className="lede">
            Attempt to reconstruct an existing recording as an <strong>editable project</strong>: stems, tempo and beats, key, chords, notes, instruments and song
            structure — each with an honest confidence, so you know what to check.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        <div className="col" style={{ flex: '1 1 380px', maxWidth: 470, gap: 14, minWidth: 0 }}>
          <div className="panel">
            <div className="panel-header">
              <Icon name="wave" />
              <h3 className="grow">Recording</h3>
            </div>
            <div className="panel-body col" style={{ gap: 10 }}>
              <div
                className="col"
                style={{
                  gap: 8,
                  alignItems: 'center',
                  padding: '18px 12px',
                  border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--border-strong)'}`,
                  borderRadius: 'var(--radius)',
                  background: dragOver ? 'var(--accent-soft)' : 'transparent',
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  void onFiles(Array.from(e.dataTransfer.files));
                }}
                data-testid="rebuild-drop"
              >
                <div className="small muted">Drop a song (WAV, FLAC, MP3, OGG, M4A)</div>
                <FileButton accept={AUDIO_ACCEPT} onFile={(f) => void onFiles(f)} variant={s.source ? 'default' : 'primary'}>
                  {loading ? 'Reading…' : s.source ? 'Choose another recording' : 'Upload a recording'}
                </FileButton>
              </div>
              {s.source && (
                <div className="col" style={{ gap: 6 }} data-testid="rebuild-source">
                  <div className="row between">
                    <strong className="ellipsis" title={s.source.name}>
                      {s.source.name}
                    </strong>
                    <span className="small muted">{audioSummary(s.source.audio)}</span>
                  </div>
                  <Waveform audio={s.source.audio} height={44} position={pos} />
                  <div className="row">
                    <Button size="sm" icon={playing === SOURCE_ID ? 'stop' : 'play'} onClick={() => (playing === SOURCE_ID ? previewPlayer.stop() : void previewPlayer.play(SOURCE_ID, s.source!.audio))}>
                      {playing === SOURCE_ID ? 'Stop' : 'Play'}
                    </Button>
                  </div>
                  <Field label="Project title">
                    <TextInput value={s.title} onChange={(title) => s.set({ title })} aria-label="Project title" />
                  </Field>
                </div>
              )}
            </div>
          </div>

          <div className="callout small" data-testid="rebuild-honesty">
            <strong>How the built-in rebuild works.</strong> Everything runs on this device with classic signal processing — harmonic/percussive separation and
            spectral masks, onset-based beat tracking, chroma key/chord estimation, YIN and harmonic-salience pitch tracking, heuristic instrument classification.
            It is fast, private and works offline, but expect <em>lower confidence than neural separators and transcribers</em> (e.g. Demucs, Basic Pitch): dense mixes,
            distorted guitars and reverb-heavy vocals are hard. A local or cloud provider can replace individual stages (Settings → Providers); the confidence shown
            for every stage tells you where to listen.
          </div>

          <div className="panel">
            <div className="panel-body col" style={{ gap: 10 }}>
              <Field label="Source separation" hint="Auto follows your routing rules. Other stages always run on this device.">
                <ProviderPicker role="separation" value={s.separationProvider} onChange={(separationProvider) => s.set({ separationProvider })} />
              </Field>
              <Toggle on={s.keepStems} onChange={(keepStems) => s.set({ keepStems })} label="Also keep separated stems as audio tracks (A/B against the rebuilt MIDI)" />
              <div className="row">
                {!running ? (
                  <Button variant="primary" size="lg" icon="rebuild" disabled={!s.source} onClick={start} data-testid="start-rebuild">
                    {result ? 'Rebuild again' : 'Rebuild'}
                  </Button>
                ) : (
                  <Button variant="danger" size="lg" icon="close" onClick={() => task && taskQueue.cancel(task.id)} data-testid="cancel-rebuild">
                    Cancel
                  </Button>
                )}
                {running && task && (
                  <div className="grow col" style={{ gap: 4 }}>
                    <span className="small muted ellipsis">{task.message ?? 'Queued…'}</span>
                    <Progress value={task.progress} ai />
                  </div>
                )}
              </div>
              {task?.status === 'failed' && (
                <div className="callout danger small" role="alert">
                  <strong>Rebuild failed.</strong> {task.error}
                  <div style={{ marginTop: 6 }}>
                    <Button size="sm" onClick={() => taskQueue.retry(task.id)}>
                      Retry
                    </Button>
                  </div>
                </div>
              )}
              {task?.status === 'cancelled' && <div className="callout small">Rebuild cancelled.</div>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3 className="grow">Pipeline</h3>
              {task && <Badge tone={task.status === 'succeeded' ? 'success' : task.status === 'failed' ? 'danger' : running ? 'ai' : undefined}>{task.status}</Badge>}
            </div>
            <div className="panel-body">
              <Pipeline runId={s.runId} task={task} hasAudio={!!s.source} opened={!!s.opened} />
            </div>
          </div>
        </div>

        <div style={{ flex: '2 1 560px', minWidth: 0 }}>
          <div className="panel">
            <div className="panel-header">
              <Icon name="layers" />
              <h3 className="grow">Reconstruction</h3>
              {result && (
                <>
                  {opening && (
                    <span className="row small muted">
                      <Spinner /> {opening}
                      {stemsTask && isActive(stemsTask) && <span className="mono">{Math.round(stemsTask.progress * 100)}%</span>}
                    </span>
                  )}
                  {s.opened ? (
                    <Button variant="success" icon="workbench" onClick={() => st.setMode('workbench')}>
                      Opened — go to workbench
                    </Button>
                  ) : (
                    <Button variant="primary" icon="folder" disabled={!!opening} onClick={() => void open()} data-testid="open-rebuild-project">
                      Open as project
                    </Button>
                  )}
                </>
              )}
            </div>
            <div className="panel-body">
              {result ? (
                <RebuildSummary song={result.song} report={result.report} />
              ) : running ? (
                <div className="empty-state">
                  <Spinner />
                  <div>Reconstructing… follow the pipeline on the left. You can keep working in other modes; the task continues in the queue.</div>
                </div>
              ) : (
                <div className="muted small">Upload a recording and press Rebuild. The result — tempo, key, meter, sections, chords and tracks with confidence — appears here.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
