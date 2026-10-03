import { useEffect, useRef, useState } from 'react';
import { createTimeMap, sectionLayout, type Project, type Track, type VocalTake } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { decodeAudioBytes } from '../../state/assets';
import { describeMicError, listInputs, micSupport, type MicError, type RecorderPhase } from '../../engine/capture-recorder';
import { VocalTakeRecorder } from '../../engine/vocal-recorder';
import { activeRender, applyVocalMonitoring, renderTrackFor, takesTrackFor } from '../../engine/vocal-model';
import { activateTake, deactivateTake, removeTake, saveTake, takeClip } from '../../engine/vocal-takes';
import { enqueueTranscribeTake, logVocalActivity } from '../../engine/vocal-sync';
import { Badge, Button, Field, NumberInput, Select, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { LevelMeter } from '../transcribe/widgets';
import { AssetAudition, TaskLine, assetById, errorText, playFrom } from './shared';
import { PendingVocalProposals } from './Proposals';
import { useVocalSession } from './session';

/**
 * Recorded vocals (spec §33): record takes with the microphone while the song plays (count-in,
 * latency compensation, input meter, headphones reminder), audition and choose the active take,
 * and optionally transcribe a take into the vocal MIDI so the symbolic layer stays in sync.
 */
export function RecordingPanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const st = useStudio.getState();
  const session = useVocalSession();
  const prefs = session.recording;
  const setPrefs = (patch: Partial<typeof prefs>) => session.set({ recording: { ...prefs, ...patch } });
  const userName = useSettings((s) => s.userName);
  const recorder = useRef<VocalTakeRecorder | null>(null);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [level, setLevel] = useState({ rmsDb: -90, peakDb: -90 });
  const [beat, setBeat] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [delay, setDelay] = useState<number | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<MicError | null>(() => {
    const s = micSupport();
    return s.ok ? null : s.reason!;
  });
  const [saving, setSaving] = useState(false);
  const stopRef = useRef<() => void>(() => undefined);
  const spans = sectionLayout(song).filter((s) => track.notes.some((n) => n.tick >= s.startTick && n.tick < s.endTick));
  const allSpans = sectionLayout(song);
  const startSpan = allSpans.find((s) => s.section.id === prefs.startSectionId) ?? spans[0] ?? allSpans[0];
  const takesTrack = takesTrackFor(song, track.id);
  const takes = song.vocals.takes.filter((t) => t.trackId === takesTrack?.id);

  const get = () => {
    if (!recorder.current) {
      recorder.current = new VocalTakeRecorder({
        onPhase: setPhase,
        onLevel: setLevel,
        onCountIn: (b) => setBeat(b),
        onTime: setElapsed,
        onDelay: setDelay,
        onAutoStop: () => stopRef.current(),
      });
    }
    return recorder.current;
  };
  useEffect(() => () => recorder.current?.close(), []);

  const enable = async (id?: string) => {
    setError(null);
    try {
      const r = get();
      if (r.isOpen && id !== undefined) r.close();
      await r.open(id || undefined);
      setDevices(await listInputs());
    } catch (err) {
      setError(describeMicError(err));
    }
  };

  const vocalIds = () => [track.id, renderTrackFor(song, track.id)?.id, takesTrack?.id].filter((x): x is string => !!x);

  const start = async () => {
    if (!startSpan) return;
    setError(null);
    setElapsed(0);
    setBeat(null);
    setDelay(null);
    try {
      const r = get();
      if (!r.isOpen) {
        await r.open(prefs.deviceId || undefined);
        setDevices(await listInputs());
      }
      const cur = useStudio.getState().project?.song ?? song;
      await r.start({ song: cur, startTick: startSpan.startTick, endTick: prefs.stopAtSectionEnd ? startSpan.endTick : undefined, countInBars: prefs.countInBars, guide: prefs.guide, vocalTrackIds: vocalIds() });
    } catch (err) {
      setError(describeMicError(err));
    }
  };

  const stop = async () => {
    const r = recorder.current;
    if (!r || saving) return;
    setSaving(true);
    try {
      const res = await r.stop();
      const audio = await decodeAudioBytes(res.bytes);
      const dur = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
      if (dur < 0.5) throw new Error('The take is too short — record at least a second.');
      const offset = Math.max(0, res.measuredDelaySeconds + prefs.latencyMs / 1000);
      const device = devices.find((d) => d.deviceId === prefs.deviceId)?.label;
      const saved = await saveTake({
        projectId: project.meta.id,
        midiTrackId: track.id,
        audio,
        startTick: res.startTick,
        offsetSeconds: offset,
        measuredDelaySeconds: res.measuredDelaySeconds,
        latencyMs: prefs.latencyMs,
        sectionName: startSpan?.section.name,
        inputLabel: device || undefined,
      });
      logVocalActivity('take', `${saved.name} recorded (${dur.toFixed(1)} s, aligned with ${(offset * 1000).toFixed(0)} ms compensation)`);
      st.toast('success', `${saved.name} saved and active — audition it or play the song.`);
    } catch (err) {
      if (err instanceof Error && err.message === 'Not recording') return;
      st.toast('error', `Recording failed: ${errorText(err)}`);
    } finally {
      setSaving(false);
      setBeat(null);
    }
  };
  stopRef.current = () => void stop();

  const commitSong = (fn: (s: typeof song) => typeof song, message: string) => {
    const cur = useStudio.getState().project?.song;
    if (!cur) return;
    st.commit(applyVocalMonitoring(fn(cur), track.id).song, message, 'vocals');
  };

  const activate = (t: VocalTake) =>
    commitSong((s) => {
      const next = activateTake(s, t.id);
      return { ...next, vocals: { ...next.vocals, mode: 'recorded' } };
    }, `Active take → ${t.name}`);
  const muteTake = (t: VocalTake) => commitSong((s) => deactivateTake(s, t.id), `Deactivated ${t.name}`);
  const deleteTake = (t: VocalTake) => commitSong((s) => removeTake(s, t.id), `Removed ${t.name} (audio kept in the project)`);
  const transcribe = (t: VocalTake) => {
    const task = enqueueTranscribeTake({ projectId: project.meta.id, takeId: t.id }, `Transcribe ${t.name} → ${track.name}`);
    session.set({ tasks: { ...session.tasks, transcribe: task.id } });
  };

  const recording = phase === 'recording';
  const counting = phase === 'count-in';
  const open = phase !== 'idle' && phase !== 'requesting';
  const unsupported = error && (error.kind === 'unsupported' || error.kind === 'insecure');
  const tm = createTimeMap(song);
  const render = activeRender(project, track.id);

  return (
    <div className="col" style={{ gap: 12 }} data-testid="recording-panel">
      <div className="callout warning small vx-headphones" data-testid="headphones-reminder">
        <Icon name="alert" size={13} />
        <span>
          <strong>Use headphones.</strong> The song plays while you record — through speakers it bleeds into the microphone and ends up in the take. Voice processing (echo
          cancellation, noise suppression, auto-gain) is off so pitch and dynamics stay intact.
        </span>
      </div>
      <div className="vx-two">
        <div className="panel">
          <div className="panel-header">
            <Icon name="mic" />
            <h3 className="grow">Record a take</h3>
            {recording && (
              <span className="row" style={{ color: 'var(--danger)', fontWeight: 600 }} aria-live="polite">
                <Icon name="record" size={12} /> {elapsed.toFixed(1)} s
              </span>
            )}
          </div>
          <div className="panel-body col">
            <LevelMeter rmsDb={level.rmsDb} peakDb={level.peakDb} active={open} />
            <div className="grid-2">
              <Field label="Start at">
                <Select
                  value={startSpan?.section.id ?? ''}
                  onChange={(id) => setPrefs({ startSectionId: id })}
                  options={allSpans.map((s) => ({ value: s.section.id, label: `${s.section.name} · bar ${s.startBar + 1}` }))}
                  aria-label="Take start"
                />
              </Field>
              <Field label="Input">
                <Select
                  value={prefs.deviceId}
                  onChange={(id) => {
                    setPrefs({ deviceId: id });
                    void enable(id);
                  }}
                  options={[{ value: '', label: 'Default microphone' }, ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))]}
                  aria-label="Input device"
                />
              </Field>
              <Field label="Count-in">
                <div className="row">
                  <Toggle on={prefs.countInBars > 0} onChange={(on) => setPrefs({ countInBars: on ? 1 : 0 })} label={prefs.countInBars > 0 ? `${prefs.countInBars} bar` : 'Off'} />
                  {prefs.countInBars > 0 && <NumberInput size="sm" value={prefs.countInBars} min={1} max={4} onChange={(v) => setPrefs({ countInBars: Math.round(v) })} style={{ width: 52 }} aria-label="Count-in bars" />}
                </div>
              </Field>
              <Field label="Latency compensation (ms)" hint={delay !== null ? `Measured playback delay ${(delay * 1000).toFixed(0)} ms is added automatically` : 'Added to the measured playback delay; raise it if takes sound late'}>
                <NumberInput value={prefs.latencyMs} min={0} max={500} onChange={(v) => setPrefs({ latencyMs: Math.round(v) })} aria-label="Latency compensation" />
              </Field>
            </div>
            <div className="row wrap">
              <Toggle on={prefs.stopAtSectionEnd} onChange={(v) => setPrefs({ stopAtSectionEnd: v })} label={`Stop at the end of ${startSpan?.section.name ?? 'the section'}`} />
              <Toggle on={prefs.guide} onChange={(v) => setPrefs({ guide: v })} label="Hear the guide vocal" />
            </div>
            <div className="row wrap">
              {!open && !recording && (
                <Button icon="mic" onClick={() => void enable(prefs.deviceId)} disabled={!!unsupported || phase === 'requesting'}>
                  {phase === 'requesting' ? 'Waiting for permission…' : 'Enable microphone'}
                </Button>
              )}
              {!recording && !counting ? (
                <Button variant="danger" icon="record" onClick={() => void start()} disabled={!!unsupported || saving || phase === 'requesting' || phase === 'stopping'} aria-label="Record take">
                  Record take
                </Button>
              ) : (
                <Button variant="primary" icon="stop" onClick={() => (counting ? recorder.current?.cancel() : void stop())} aria-label="Stop recording">
                  {counting ? 'Cancel count-in' : 'Stop'}
                </Button>
              )}
              {counting && (
                <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-text)' }} aria-live="assertive" data-testid="count-in">
                  {beat ?? '·'}
                </span>
              )}
              {saving && <span className="small muted">Saving the take…</span>}
            </div>
            {error && (
              <div className="callout danger small" role="alert" data-testid="mic-error">
                <strong>{error.kind === 'denied' ? 'Microphone blocked' : error.kind === 'no-device' ? 'No microphone' : error.kind === 'busy' ? 'Microphone busy' : 'Recording unavailable'}</strong>
                <div>{error.message}</div>
              </div>
            )}
            <div className="small dim">
              Recording starts after the count-in together with playback from {startSpan?.section.name ?? 'the chosen section'}. Takes are stored as WAV recordings in the
              project and credited to {userName || 'you'} as performer.
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-header">
            <Icon name="layers" />
            <h3 className="grow">Takes</h3>
            <span className="small dim">
              {takes.length} take{takes.length === 1 ? '' : 's'} · {takes.filter((t) => t.active).length} active
            </span>
          </div>
          <div className="panel-body col">
            {!takes.length && <div className="small muted">No takes yet. Recorded takes appear here; the active ones are what plays in Recorded-vocal mode{render ? ' (instead of the render)' : ''}.</div>}
            {takes
              .slice()
              .reverse()
              .map((t) => {
                const tc = takeClip(song, t);
                const meta = assetById(project, t.assetId);
                const at = tc ? tm.tickToSeconds(tc.clip.tick) : 0;
                return (
                  <div key={t.id} className={`card col vx-take ${t.active ? 'active' : ''}`} style={{ gap: 6 }} data-testid="vocal-take">
                    <div className="row between">
                      <strong>{t.name}</strong>
                      {t.active ? <Badge tone="success">active</Badge> : <Badge>inactive</Badge>}
                    </div>
                    <AssetAudition meta={meta} height={32} label={t.name} />
                    <div className="row wrap">
                      <Button size="sm" icon="play" onClick={() => playFrom(Math.max(0, at - 1))} title="Play the song from just before the take">
                        Play in song
                      </Button>
                      {t.active ? (
                        <Button size="sm" variant="ghost" onClick={() => muteTake(t)}>
                          Deactivate
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" onClick={() => activate(t)}>
                          Use this take
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" icon="midi" onClick={() => transcribe(t)} title="Transcribe the sung take into the vocal MIDI (as a proposal)">
                        Transcribe to vocal MIDI
                      </Button>
                      <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${t.name}`} onClick={() => deleteTake(t)} />
                    </div>
                    {tc && <div className="small dim">Aligned with {(tc.clip.offsetSeconds * 1000).toFixed(0)} ms compensation</div>}
                  </div>
                );
              })}
            <TaskLine taskId={session.tasks.transcribe} />
            <PendingVocalProposals project={project} compact />
          </div>
        </div>
      </div>
    </div>
  );
}
