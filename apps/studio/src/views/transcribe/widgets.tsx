import { useMemo } from 'react';
import type { AudioData } from '@songdeck/audio';
import { formatDuration } from '../../hooks';

/** Horizontal input level meter (dBFS), with clip indication. */
export function LevelMeter({ rmsDb, peakDb, active }: { rmsDb: number; peakDb: number; active: boolean }) {
  const pct = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
  const clipping = peakDb > -1;
  return (
    <div
      className="col"
      style={{ gap: 3 }}
      aria-label="Input level"
      role="meter"
      aria-valuemin={-60}
      aria-valuemax={0}
      aria-valuenow={Math.round(Math.max(-60, rmsDb))}
    >
      <div
        style={{
          position: 'relative',
          height: 10,
          borderRadius: 5,
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
          opacity: active ? 1 : 0.5,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct(rmsDb)}%`,
            background:
              'linear-gradient(to right, var(--success) 0%, var(--success) 70%, var(--warning) 88%, var(--danger) 100%)',
            transition: 'width 60ms linear',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: 2,
            left: `calc(${pct(peakDb)}% - 1px)`,
            background: clipping ? 'var(--danger)' : 'var(--text)',
          }}
        />
      </div>
      <div className="row between small dim">
        <span>{active ? `${Math.max(-60, Math.round(rmsDb))} dB` : 'Input off'}</span>
        {clipping ? (
          <span style={{ color: 'var(--danger)' }}>Clipping — move back or lower the input gain</span>
        ) : rmsDb < -50 && active ? (
          <span>Very quiet — move closer</span>
        ) : (
          <span>&nbsp;</span>
        )}
      </div>
    </div>
  );
}

/** Peak waveform overview with an optional playhead. */
export function Waveform({
  audio,
  height = 48,
  position,
  color = 'var(--ai)',
}: {
  audio: AudioData;
  height?: number;
  position?: number | null;
  color?: string;
}) {
  const W = 600;
  const path = useMemo(() => {
    const ch = audio.channels;
    const len = ch[0]?.length ?? 0;
    if (!len) return '';
    const cols = W;
    const step = Math.max(1, Math.floor(len / cols));
    let d = '';
    const mid = height / 2;
    for (let c = 0; c < cols; c++) {
      const start = Math.floor((c * len) / cols);
      let peak = 0;
      for (let i = start; i < Math.min(len, start + step); i += Math.max(1, Math.floor(step / 64))) {
        for (const x of ch) {
          const a = Math.abs(x[i]);
          if (a > peak) peak = a;
        }
      }
      const h = Math.max(0.5, Math.min(1, peak) * (mid - 1));
      d += `M${c + 0.5} ${mid - h}L${c + 0.5} ${mid + h}`;
    }
    return d;
  }, [audio, height]);
  const duration = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        style={{
          display: 'block',
          background: 'var(--bg-input)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
        }}
        role="img"
        aria-label={`Waveform, ${formatDuration(duration)}`}
      >
        <path d={path} stroke={color} strokeWidth={1} opacity={0.85} />
        {position !== null && position !== undefined && duration > 0 && (
          <rect
            x={(position / duration) * W - 0.75}
            y={0}
            width={1.5}
            height={height}
            fill="var(--playhead)"
          />
        )}
      </svg>
    </div>
  );
}

export function audioSummary(audio: AudioData): string {
  const sec = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
  return `${formatDuration(sec)} · ${(audio.sampleRate / 1000).toFixed(1)} kHz · ${audio.channels.length === 1 ? 'mono' : `${audio.channels.length} ch`}`;
}

export function pct(v: number | undefined): string {
  return v === undefined ? '—' : `${Math.round(v * 100)}%`;
}

export function confidenceTone(v: number | undefined): 'success' | 'warning' | 'danger' | undefined {
  if (v === undefined) return undefined;
  return v >= 0.8 ? 'success' : v >= 0.6 ? 'warning' : 'danger';
}
