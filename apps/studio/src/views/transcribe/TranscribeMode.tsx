import { useMemo, useState } from 'react';
import { keyName, randomId } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { decodeAudioBytes, guessMime } from '../../state/assets';
import { enqueueTask, useTask } from '../../engine/capture-tasks';
import { useStopPreviewOnUnmount } from '../../engine/capture-playback';
import { AUDIO_ACCEPT, baseName, readFileBytes } from '../../engine/capture-files';
import { externalProvider, type TranscribeTaskInput } from '../../engine/handlers/analysis';
import { ProviderPicker } from '../shared/ProviderPicker';
import { Badge, Button, Field, FileButton, NumberInput, Select, Tabs, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { RecordPanel } from './RecordPanel';
import { TapPad, TAP_SOUNDS } from './TapPad';
import { ResultPanel } from './ResultPanel';
import { Waveform, audioSummary } from './widgets';
import {
  GRID_BEATS,
  SOURCES,
  normalizeTranscription,
  tapTempo,
  type Capture,
  type GridChoice,
  type TranscribeOptions,
  type TranscriptionView,
} from './model';
import { tapsToTranscription } from './taps';
import { useTranscribeSession, type InputTab, type RunContext } from './session';

export default function TranscribeMode() {
  const project = useStudio((s) => s.project);
  const song = project?.song ?? null;
  const st = useStudio.getState();
  const projectBpm = song ? Math.round((song.tempoMap[0]?.bpm ?? 120) * 100) / 100 : null;
  const beatsPerBar = song?.meterMap[0]?.numerator ?? 4;
  const session = useTranscribeSession();
  const options: TranscribeOptions = session.options ?? {
    provider: 'auto',
    source: 'humming',
    tempoMode: song ? 'project' : 'detect',
    manualBpm: projectBpm ?? 100,
    grid: '1/16',
    snapToKey: false,
    keyMode: 'detect',
  };
  const { inputTab, capture, taskId, runCtx, tapView, tapSound } = session;
  const setInputTab = (inputTab: InputTab) => session.set({ inputTab });
  const setCapture = (capture: Capture | null) => session.set({ capture });
  const setTaskId = (taskId: string | null) => session.set({ taskId });
  const setRunCtx = (runCtx: RunContext | null) => session.set({ runCtx });
  const setTapView = (tapView: TranscriptionView | null) => session.set({ tapView });
  const setTapSound = (tapSound: string) => session.set({ tapSound });
  const [dragOver, setDragOver] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const task = useTask(taskId);
  useStopPreviewOnUnmount();

  const set = (patch: Partial<TranscribeOptions>) => session.set({ options: { ...options, ...patch } });
  const countInBpm = options.tempoMode === 'manual' ? options.manualBpm : (projectBpm ?? options.manualBpm);

  const view: TranscriptionView | null = useMemo(() => {
    if (capture?.origin === 'taps') return tapView;
    if (task?.status === 'succeeded' && runCtx) return normalizeTranscription(task.result, runCtx);
    return null;
  }, [capture, tapView, task, runCtx]);

  const resolveTempo = (c: Capture, o: TranscribeOptions): { bpm?: number; source: TranscriptionView['bpmSource'] } => {
    if (o.tempoMode === 'project' && projectBpm) return { bpm: projectBpm, source: 'project' };
    if (o.tempoMode === 'manual') return { bpm: o.manualBpm, source: 'manual' };
    if (c.countInBpm) return { bpm: c.countInBpm, source: 'count-in' };
    return { bpm: undefined, source: 'detected' };
  };

  const run = (c: Capture, o: TranscribeOptions = options) => {
    if (c.origin === 'taps') {
      convertTaps(c, o);
      return;
    }
    if (!c.audio) return;
    const source = c.origin === 'clap' ? 'drums' : o.source;
    const tempo = resolveTempo(c, o);
    const key = o.keyMode === 'project' && song && source !== 'drums' ? song.keyMap[0]?.key : undefined;
    const gridBeats = GRID_BEATS[o.grid];
    const input: TranscribeTaskInput = {
      runId: randomId('run'),
      audio: c.audio,
      source,
      bpm: tempo.bpm,
      key,
      quantizeBeats: gridBeats,
      snapToKey: o.snapToKey && source !== 'drums' ? true : undefined,
      label: c.name,
      provider: o.provider,
    };
    const ext = externalProvider('transcription', o.provider);
    const rec = enqueueTask({
      type: 'analysis.transcribe',
      title: `Transcribe “${c.name}” (${SOURCES.find((s) => s.value === source)?.label ?? source})`,
      input,
      runner: ext ? ext.name : 'local',
      providerId: ext ? ext.providerId : 'internal-analysis',
    });
    setRunCtx({
      source,
      requestedBpm: tempo.bpm,
      bpmSource: tempo.source,
      requestedKey: key,
      gridBeats,
      durationSeconds: c.durationSeconds,
      meter: { numerator: beatsPerBar, denominator: song?.meterMap[0]?.denominator ?? 4 },
    });
    setTaskId(rec.id);
  };

  const convertTaps = (c: Capture, o: TranscribeOptions) => {
    const taps = c.taps ?? [];
    const sound = TAP_SOUNDS.find((s) => s.value === tapSound) ?? TAP_SOUNDS[0];
    const tempo = o.tempoMode === 'project' && projectBpm ? { bpm: projectBpm, src: 'project' as const } : o.tempoMode === 'manual' ? { bpm: o.manualBpm, src: 'manual' as const } : { bpm: tapTempo(taps) ?? 100, src: 'taps' as const };
    setTaskId(null);
    setTapView(
      tapsToTranscription(taps, {
        bpm: tempo.bpm,
        bpmSource: tempo.src,
        gridBeats: GRID_BEATS[o.grid] || 0.25,
        pitch: sound.pitch,
        drums: sound.drum,
        meter: { numerator: beatsPerBar, denominator: song?.meterMap[0]?.denominator ?? 4 },
        key: !sound.drum && song ? song.keyMap[0]?.key : undefined,
      }),
    );
  };

  const accept = (c: Capture) => {
    setCapture(c);
    setTapView(null);
    run(c);
  };

  const onFiles = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setLoadingFile(true);
    try {
      const bytes = await readFileBytes(f);
      const audio = await decodeAudioBytes(bytes);
      const durationSeconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
      if (durationSeconds < 0.2) throw new Error('The file is too short.');
      accept({ id: randomId('cap'), name: baseName(f.name), origin: 'upload', bytes, mimeType: guessMime(f.name, bytes), audio, durationSeconds, createdAt: new Date().toISOString() });
    } catch (err) {
      st.toast('error', `Could not read ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingFile(false);
    }
  };

  const onTaps = (taps: number[]) => {
    const c: Capture = { id: randomId('cap'), name: `Tapped rhythm (${taps.length} taps)`, origin: 'taps', taps, durationSeconds: taps[taps.length - 1] ?? 0, createdAt: new Date().toISOString() };
    setCapture(c);
    convertTaps(c, options);
  };

  const sourceLocked = capture?.origin === 'clap' || inputTab === 'clap' || inputTab === 'tap';

  return (
    <div className="mode-page" data-testid="transcribe-mode">
      <div className="page-header">
        <div className="grow">
          <h1>Transcribe</h1>
          <div className="lede">
            Audio → MIDI. Hum a melody, sing a bass line, tap or clap a rhythm, play an instrument or drop in a rough voice memo — the AI then refines <em>your</em> idea
            instead of inventing one. Every note carries a confidence so uncertain material is easy to spot.
          </div>
        </div>
        {project ? (
          <Badge tone="accent" title="Insert / replace targets this project">
            <Icon name="folder" size={11} /> {project.meta.name}
          </Badge>
        ) : (
          <Badge title="Results can start a new project">No project open</Badge>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        <div className="col" style={{ flex: '1 1 380px', maxWidth: 480, gap: 14, minWidth: 0 }}>
          <div className="panel">
            <div className="panel-header">
              <h3 className="grow">1 · What are you transcribing?</h3>
            </div>
            <div className="panel-body col">
              <div className="chip-list" role="radiogroup" aria-label="Source type">
                {SOURCES.map((s) => (
                  <button
                    key={s.value}
                    role="radio"
                    aria-checked={options.source === s.value}
                    className={`chip ${options.source === s.value ? 'on' : ''}`}
                    disabled={sourceLocked && s.value !== 'drums'}
                    title={s.hint}
                    onClick={() => set({ source: s.value })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="small muted">
                {inputTab === 'clap'
                  ? 'Claps are transcribed with the drums path.'
                  : inputTab === 'tap'
                    ? 'Taps become a rhythm on the sound you choose.'
                    : SOURCES.find((s) => s.value === options.source)?.hint}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3 className="grow">2 · Capture</h3>
            </div>
            <div className="panel-body col" style={{ gap: 12 }}>
              <Tabs
                value={inputTab}
                onChange={setInputTab}
                tabs={[
                  { value: 'record', label: 'Record', icon: 'mic' },
                  { value: 'upload', label: 'Upload', icon: 'upload' },
                  { value: 'tap', label: 'Tap rhythm', icon: 'metronome' },
                  { value: 'clap', label: 'Clap', icon: 'waveform' },
                ]}
              />
              {inputTab === 'record' && <RecordPanel kind="record" bpm={countInBpm} beatsPerBar={beatsPerBar} onCaptured={accept} />}
              {inputTab === 'clap' && <RecordPanel kind="clap" bpm={countInBpm} beatsPerBar={beatsPerBar} onCaptured={accept} />}
              {inputTab === 'tap' && <TapPad onUse={onTaps} sound={tapSound} onSound={setTapSound} />}
              {inputTab === 'upload' && (
                <div
                  className="col"
                  style={{
                    gap: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '22px 12px',
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
                  data-testid="upload-drop"
                >
                  <Icon name="upload" size={22} />
                  <div className="small muted">Drop a voice memo or audio file (WAV, MP3, FLAC, OGG, M4A, WebM)</div>
                  <FileButton accept={AUDIO_ACCEPT} onFile={(f) => void onFiles(f)}>
                    {loadingFile ? 'Reading…' : 'Choose audio file'}
                  </FileButton>
                </div>
              )}
              {capture && capture.origin !== 'taps' && capture.audio && (
                <div className="card col" style={{ gap: 6 }} data-testid="capture-summary">
                  <div className="row between">
                    <strong className="ellipsis">{capture.name}</strong>
                    <span className="small muted">{audioSummary(capture.audio)}</span>
                  </div>
                  <Waveform audio={capture.audio} height={36} />
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3 className="grow">3 · Options</h3>
            </div>
            <div className="panel-body col" style={{ gap: 10 }}>
              <div className="grid-2">
                <Field label="Tempo" hint={options.tempoMode === 'detect' ? (capture?.countInBpm ? `Count-in tempo (${Math.round(capture.countInBpm)} BPM) is used.` : 'Estimated from the audio.') : undefined}>
                  <Select
                    value={options.tempoMode}
                    onChange={(tempoMode) => set({ tempoMode })}
                    options={[
                      { value: 'detect', label: 'Detect' },
                      { value: 'project', label: projectBpm ? `Project tempo (${Math.round(projectBpm)})` : 'Project tempo (no project)', disabled: !song },
                      { value: 'manual', label: 'Manual' },
                    ]}
                    aria-label="Tempo mode"
                  />
                </Field>
                <Field label="Manual BPM">
                  <NumberInput value={options.manualBpm} min={30} max={300} onChange={(manualBpm) => set({ manualBpm })} disabled={options.tempoMode !== 'manual'} aria-label="Manual BPM" />
                </Field>
                <Field label="Quantize grid">
                  <Select
                    value={options.grid}
                    onChange={(grid) => set({ grid: grid as GridChoice })}
                    options={[
                      { value: 'off', label: 'Off (keep timing)' },
                      { value: '1/8', label: '1/8' },
                      { value: '1/16', label: '1/16' },
                      { value: '1/8T', label: '1/8 triplet' },
                    ]}
                    aria-label="Quantize grid"
                  />
                </Field>
                <Field label="Key">
                  <Select
                    value={options.keyMode}
                    onChange={(keyMode) => set({ keyMode })}
                    options={[
                      { value: 'detect', label: 'Detect' },
                      { value: 'project', label: song ? `Project key (${keyName(song.keyMap[0]?.key ?? { tonic: 0, mode: 'major' })})` : 'Project key (no project)', disabled: !song },
                    ]}
                    aria-label="Key mode"
                  />
                </Field>
              </div>
              <Toggle on={options.snapToKey} onChange={(snapToKey) => set({ snapToKey })} label="Snap out-of-key notes to the key" />
              <Field label="Transcription engine" hint="Auto follows your routing rules; the on-device engine never uploads anything. Taps are always converted on-device.">
                <ProviderPicker role="transcription" value={options.provider} onChange={(provider) => set({ provider })} />
              </Field>
              <div className="row">
                <Button
                  variant="primary"
                  icon="midi"
                  disabled={!capture || (capture.origin !== 'taps' && !capture.audio) || (!!task && (task.status === 'running' || task.status === 'queued'))}
                  onClick={() => capture && run(capture)}
                  data-testid="run-transcription"
                >
                  {view || task ? 'Transcribe again' : 'Transcribe'}
                </Button>
                <span className="small dim">Runs on this device in the generation queue (cancellable).</span>
              </div>
            </div>
          </div>
        </div>

        <div style={{ flex: '2 1 560px', minWidth: 0 }}>
          <ResultPanel capture={capture} view={view} task={capture?.origin === 'taps' ? null : task} options={options} onRerun={() => capture && run(capture)} />
        </div>
      </div>
    </div>
  );
}

