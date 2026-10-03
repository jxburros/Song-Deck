import { useEffect, useRef, useState } from 'react';
import { randomId } from '@songdeck/core';
import { decodeAudioBytes } from '../../state/assets';
import { MicRecorder, describeMicError, listInputs, micSupport, type MicError, type RecorderPhase } from '../../engine/capture-recorder';
import { Button, Field, NumberInput, Select, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { LevelMeter } from './widgets';
import type { Capture } from './model';

/**
 * Microphone capture (hum, sing, play, or clap — spec §27) with input level, an optional
 * count-in at the working tempo, and graceful handling of blocked / missing microphones.
 */
export function RecordPanel({
  kind,
  bpm,
  beatsPerBar,
  onCaptured,
}: {
  kind: 'record' | 'clap';
  /** Count-in tempo (project or manual tempo). */
  bpm: number;
  beatsPerBar: number;
  onCaptured: (c: Capture) => void;
}) {
  const recorder = useRef<MicRecorder | null>(null);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [level, setLevel] = useState({ rmsDb: -90, peakDb: -90 });
  const [error, setError] = useState<MicError | null>(() => {
    const s = micSupport();
    return s.ok ? null : s.reason!;
  });
  const [countIn, setCountIn] = useState(true);
  const [countBars, setCountBars] = useState(1);
  const [beat, setBeat] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [decoding, setDecoding] = useState(false);

  const get = () => {
    if (!recorder.current) {
      recorder.current = new MicRecorder({
        onPhase: setPhase,
        onLevel: (l) => setLevel(l),
        onCountIn: (b) => setBeat(b),
        onTime: (t) => setElapsed(t),
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

  const start = async () => {
    setError(null);
    setElapsed(0);
    setBeat(null);
    try {
      const r = get();
      if (!r.isOpen) {
        await r.open(deviceId || undefined);
        setDevices(await listInputs());
      }
      await r.start({ countIn: countIn ? { beats: Math.max(1, countBars) * beatsPerBar, bpm, beatsPerBar } : null, maxSeconds: 600 });
      setBeat(null);
    } catch (err) {
      setError(describeMicError(err));
    }
  };

  const stop = async () => {
    const r = recorder.current;
    if (!r) return;
    try {
      const res = await r.stop();
      setDecoding(true);
      const audio = await decodeAudioBytes(res.bytes);
      const durationSeconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
      if (durationSeconds < 0.3) throw new Error('The take is too short — record at least a second of audio.');
      const time = new Date();
      onCaptured({
        id: randomId('cap'),
        name: `${kind === 'clap' ? 'Clapped pattern' : 'Recording'} ${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        origin: kind === 'clap' ? 'clap' : 'mic',
        bytes: res.bytes,
        mimeType: res.mimeType,
        audio,
        durationSeconds,
        countInBpm: countIn ? bpm : undefined,
        createdAt: time.toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error && err.name === 'MicError' ? (err as MicError) : describeMicError(err));
    } finally {
      setDecoding(false);
    }
  };

  const recording = phase === 'recording';
  const counting = phase === 'count-in';
  const open = phase !== 'idle' && phase !== 'requesting';
  const unsupported = error && (error.kind === 'unsupported' || error.kind === 'insecure');

  return (
    <div className="col" style={{ gap: 10 }} data-testid={kind === 'clap' ? 'clap-panel' : 'record-panel'}>
      <div className="small muted">
        {kind === 'clap'
          ? 'Clap (or tap on a table) the drum pattern; claps are transcribed as drum hits you can re-voice as kick / snare / hats.'
          : 'Hum or sing a melody, sing a bass line, or play an instrument. Voice processing (echo cancellation, noise suppression, auto-gain) is turned off so pitch and dynamics stay intact.'}
      </div>
      <LevelMeter rmsDb={level.rmsDb} peakDb={level.peakDb} active={open} />
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        {devices.length > 1 && (
          <Field label="Input">
            <Select
              value={deviceId}
              onChange={(id) => {
                setDeviceId(id);
                void enable(id);
              }}
              options={[{ value: '', label: 'Default microphone' }, ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))]}
              aria-label="Input device"
            />
          </Field>
        )}
        <Field label="Count-in">
          <div className="row">
            <Toggle on={countIn} onChange={setCountIn} label={countIn ? `${countBars} bar @ ${Math.round(bpm)} BPM` : 'Off'} />
            {countIn && <NumberInput size="sm" value={countBars} min={1} max={4} onChange={(v) => setCountBars(Math.round(v))} style={{ width: 52 }} aria-label="Count-in bars" />}
          </div>
        </Field>
      </div>
      <div className="row wrap">
        {!open && !recording && (
          <Button icon="mic" onClick={() => void enable(deviceId)} disabled={!!unsupported || phase === 'requesting'}>
            {phase === 'requesting' ? 'Waiting for permission…' : 'Enable microphone'}
          </Button>
        )}
        {!recording && !counting ? (
          <Button variant="danger" icon="record" onClick={() => void start()} disabled={!!unsupported || decoding || phase === 'requesting' || phase === 'stopping'} aria-label={kind === 'clap' ? 'Record claps' : 'Record'}>
            {kind === 'clap' ? 'Record claps' : 'Record'}
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
        {recording && (
          <span className="row" style={{ color: 'var(--danger)', fontWeight: 600 }} aria-live="polite">
            <Icon name="record" size={12} /> Recording {elapsed.toFixed(1)} s
          </span>
        )}
        {decoding && <span className="small muted">Decoding…</span>}
      </div>
      {error && (
        <div className="callout danger small" role="alert" data-testid="mic-error">
          <strong>{error.kind === 'denied' ? 'Microphone blocked' : error.kind === 'no-device' ? 'No microphone' : error.kind === 'busy' ? 'Microphone busy' : 'Recording unavailable'}</strong>
          <div>{error.message}</div>
          {!unsupported && (
            <Button size="sm" style={{ marginTop: 6 }} onClick={() => void enable(deviceId)}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
