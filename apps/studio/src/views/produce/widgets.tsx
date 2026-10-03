import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AudioData } from '@songdeck/audio';
import type { TaskRecord } from '@songdeck/core';
import { CAPABILITY_INFO, type Capability } from '@songdeck/ai';
import { useStudio } from '../../state/store';
import { assetStore } from '../../state/assets';
import { taskQueue, useRuntime } from '../../engine/runtime';
import { useTaskRecord } from '../../engine/mix-tasks';
import { Badge, Button, Progress, Spinner, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { formatTime, useElementSize } from '../../hooks';
import { comparePlayer, useComparePosition, useCompareState } from './comparePlayer';
import { useProduceUi } from './state';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function money(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return 'free';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function relTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(d)) return '';
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------

const peakCache = new WeakMap<AudioData, Map<number, Float32Array>>();

function peaksFor(a: AudioData, cols: number): Float32Array {
  let m = peakCache.get(a);
  if (!m) {
    m = new Map();
    peakCache.set(a, m);
  }
  const hit = m.get(cols);
  if (hit) return hit;
  const L = a.channels[0] ?? new Float32Array(0);
  const R = a.channels[1] ?? L;
  const n = L.length;
  const out = new Float32Array(cols * 2);
  const step = n / Math.max(1, cols);
  for (let c = 0; c < cols; c++) {
    const s = Math.floor(c * step);
    const e = Math.min(n, Math.floor((c + 1) * step));
    const stride = Math.max(1, Math.floor((e - s) / 600));
    let mn = 0;
    let mx = 0;
    for (let i = s; i < e; i += stride) {
      const v = (L[i] + R[i]) * 0.5;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out[c * 2] = mn;
    out[c * 2 + 1] = mx;
  }
  m.set(cols, out);
  return out;
}

export interface Marker {
  seconds: number;
  label: string;
}

/** Waveform of `audio` with section markers, an optional region and a playhead; click to seek. */
export function Waveform({
  audio,
  duration,
  position,
  onSeek,
  markers = [],
  region,
  height = 84,
  label,
}: {
  audio: AudioData | null;
  duration: number;
  position?: number;
  onSeek?: (seconds: number) => void;
  markers?: Marker[];
  region?: { start: number; end: number } | null;
  height?: number;
  label?: string;
}) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudio((s) => s.project?.meta.id);
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.width * dpr);
    cv.height = Math.round(height * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.width, height);
    const css = getComputedStyle(document.documentElement);
    const mid = height / 2;
    g.fillStyle = css.getPropertyValue('--border').trim() || '#262c37';
    g.fillRect(0, mid, size.width, 1);
    if (!audio) return;
    const audioDur = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
    const cols = Math.max(1, Math.round(size.width * Math.min(1, audioDur / Math.max(0.001, duration))));
    const peaks = peaksFor(audio, cols);
    g.fillStyle = css.getPropertyValue('--ai').trim() || '#46c2cb';
    for (let x = 0; x < cols; x++) {
      const mn = peaks[x * 2];
      const mx = peaks[x * 2 + 1];
      const y0 = mid - Math.min(1, mx) * (mid - 2);
      const y1 = mid - Math.max(-1, mn) * (mid - 2);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [audio, size.width, height, duration, theme]);
  const pct = (s: number) => `${Math.max(0, Math.min(100, (s / Math.max(0.001, duration)) * 100))}%`;
  return (
    <div
      ref={ref}
      className="pd-wave"
      style={{ height }}
      role={onSeek ? 'slider' : 'img'}
      aria-label={label ?? 'Waveform'}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? Math.round(duration) : undefined}
      aria-valuenow={onSeek ? Math.round(position ?? 0) : undefined}
      tabIndex={onSeek ? 0 : undefined}
      onKeyDown={(e) => {
        if (!onSeek) return;
        if (e.key === 'ArrowRight') onSeek(Math.min(duration, (position ?? 0) + 5));
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, (position ?? 0) - 5));
      }}
      onMouseDown={(e) => {
        if (!onSeek || !size.width) return;
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
      }}
    >
      <canvas ref={canvas} style={{ width: '100%', height }} />
      {region && region.end > region.start && <div className="pd-wave-region" style={{ left: pct(region.start), width: `calc(${pct(region.end)} - ${pct(region.start)})` }} />}
      {markers.map((m, i) => {
        const next = markers[i + 1]?.seconds ?? duration;
        return (
          <div key={i}>
            <div className="pd-wave-marker" style={{ left: pct(m.seconds) }} />
            <div className="pd-wave-label" style={{ left: pct(m.seconds), width: `calc(${pct(next)} - ${pct(m.seconds)})` }} title={m.label}>
              {m.label}
            </div>
          </div>
        );
      })}
      {position !== undefined && <div className="pd-wave-playhead" style={{ left: pct(position) }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comparison deck (spec §54)
// ---------------------------------------------------------------------------

export interface DeckSource {
  key: string;
  label: string;
  sub?: string;
  assetId: string;
  lufs?: number;
  tone?: 'guide' | 'candidate' | 'stem';
}

/**
 * Loads the sources' audio, keeps them in lock-step in the comparison player and switches between
 * them instantly at the same position (radio buttons, or keys 1–9). Several decks may be mounted;
 * the one you interact with claims the shared player.
 */
export function CompareDeck({
  owner,
  sources,
  markers,
  region,
  title,
  hint,
  keyboard = true,
  testId,
}: {
  owner: string;
  sources: DeckSource[];
  markers?: Marker[];
  region?: { start: number; end: number } | null;
  title?: ReactNode;
  hint?: ReactNode;
  keyboard?: boolean;
  testId?: string;
}) {
  useCompareState();
  const pos = useComparePosition();
  const assets = useStudio((s) => s.project?.meta.assets);
  const levelMatch = useProduceUi((s) => s.compareLevelMatch);
  const [loaded, setLoaded] = useState<{ key: string; audio: AudioData; lufs?: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sig = sources.map((s) => `${s.key}:${s.assetId}:${s.lufs ?? ''}`).join('|');

  const claim = (list = loaded) => {
    comparePlayer.setSources(owner, list);
    const preferred = useProduceUi.getState().compareActive;
    if (preferred && comparePlayer.has(preferred) && comparePlayer.active !== preferred) comparePlayer.setActive(preferred);
  };

  useEffect(() => {
    let alive = true;
    if (!sources.length || !assets) {
      setLoaded([]);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const out: { key: string; audio: AudioData; lufs?: number }[] = [];
        for (const s of sources) {
          const meta = assets.find((a) => a.id === s.assetId);
          if (!meta) continue;
          const audio = await assetStore.audio(meta);
          if (audio) out.push({ key: s.key, audio, lufs: s.lufs });
        }
        if (!alive) return;
        setLoaded(out);
        // Take over the player unless another deck is playing.
        if (!comparePlayer.playing || comparePlayer.owner === owner) claim(out);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, owner, assets?.length]);

  useEffect(() => () => comparePlayer.release(owner), [owner]);
  useEffect(() => comparePlayer.setMatching(levelMatch), [levelMatch]);

  // An outside "Listen to X" (compareActive) switches this deck when X is one of its sources.
  const preferred = useProduceUi((s) => s.compareActive);
  useEffect(() => {
    if (!preferred || !loaded.some((l) => l.key === preferred)) return;
    if (comparePlayer.owner !== owner) claim();
    if (comparePlayer.active !== preferred) comparePlayer.setActive(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferred, loaded]);

  const mine = comparePlayer.owner === owner;
  const select = (key: string) => {
    if (!mine) claim();
    comparePlayer.setActive(key);
    useProduceUi.getState().set({ compareActive: key });
  };

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || comparePlayer.owner !== owner) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9 && sources[n - 1] && comparePlayer.has(sources[n - 1].key)) {
        comparePlayer.setActive(sources[n - 1].key);
        useProduceUi.getState().set({ compareActive: sources[n - 1].key });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboard, sources, owner]);

  const playing = mine && comparePlayer.playing;
  const duration = mine ? comparePlayer.duration() : Math.max(0, ...loaded.map((l) => (l.audio.channels[0]?.length ?? 0) / l.audio.sampleRate));
  const active = mine ? comparePlayer.active : null;
  const activeAudio = mine ? comparePlayer.activeAudio() : (loaded[0]?.audio ?? null);
  const ready = loaded.length > 0 && !loading;

  return (
    <div className="pd-deck" data-testid={testId}>
      <div className="pd-deck-head">
        <Button
          variant={playing ? 'default' : 'primary'}
          icon={playing ? 'pause' : 'play'}
          onClick={() => {
            if (playing) comparePlayer.pause();
            else {
              if (!mine) claim();
              void comparePlayer.play();
            }
          }}
          disabled={!ready}
          aria-label={playing ? 'Pause comparison' : 'Play comparison'}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button variant="ghost" icon="stop" aria-label="Stop comparison" disabled={!mine} onClick={() => comparePlayer.stop()} />
        <span className="mono small pd-deck-time" data-testid="compare-position">
          {formatTime(mine ? pos : 0)} / {formatTime(duration)}
        </span>
        {title && <span className="pd-deck-title">{title}</span>}
        <div className="spacer" />
        {loading && (
          <span className="row small dim">
            <Spinner /> Loading audio…
          </span>
        )}
        <Toggle on={levelMatch} onChange={(v) => useProduceUi.getState().set({ compareLevelMatch: v })} label={<span className="small">Level-match</span>} title="Play every source at the quietest one’s loudness (judge production, not volume)" />
      </div>
      <div className="pd-deck-sources" role="radiogroup" aria-label="Compare sources">
        {sources.map((s, i) => {
          const on = active === s.key;
          const gain = mine ? comparePlayer.matchGainDb(s.key) : 0;
          const has = loaded.some((l) => l.key === s.key);
          return (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={s.label}
              className={`pd-src ${s.tone ?? 'candidate'} ${on ? 'on' : ''}`}
              disabled={!has}
              onClick={() => select(s.key)}
              title={`${s.label}${s.sub ? ` — ${s.sub}` : ''}${keyboard && i < 9 ? ` (key ${i + 1})` : ''}`}
            >
              <span className="pd-src-label">{s.label}</span>
              {s.sub && <span className="pd-src-sub ellipsis">{s.sub}</span>}
              {levelMatch && gain < -0.05 && <span className="pd-src-gain mono">{gain.toFixed(1)} dB</span>}
            </button>
          );
        })}
      </div>
      <Waveform
        audio={activeAudio}
        duration={duration || 1}
        position={mine ? pos : 0}
        onSeek={(s) => {
          if (!mine) claim();
          comparePlayer.seek(s);
        }}
        markers={markers}
        region={region}
        label="Comparison waveform — click to seek"
      />
      {error && <div className="callout danger small">{error}</div>}
      {hint && <div className="small dim">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks (spec §63)
// ---------------------------------------------------------------------------

export function TaskLine({ id, onDone, compact }: { id: string | null | undefined; onDone?: (t: TaskRecord) => void; compact?: boolean }) {
  const t = useTaskRecord(id);
  const status = t?.status;
  // Fire on the transition to "succeeded" only (not when a panel re-mounts with a finished task).
  const prev = useRef(status);
  useEffect(() => {
    const was = prev.current;
    prev.current = status;
    if (t && status === 'succeeded' && was !== undefined && was !== 'succeeded') onDone?.(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  if (!t) return null;
  return <TaskRow t={t} compact={compact} />;
}

function TaskRow({ t, compact }: { t: TaskRecord; compact?: boolean }) {
  const active = t.status === 'running' || t.status === 'queued' || t.status === 'paused';
  if (active) {
    return (
      <div className="pd-task" role="status" aria-live="polite" data-testid="produce-task">
        <div className="row between small">
          <span className="row ellipsis" style={{ gap: 6 }}>
            <Spinner /> <span className="ellipsis">{compact ? t.title : `${t.title} — ${t.message ?? t.status}`}</span>
          </span>
          <span className="row" style={{ gap: 4 }}>
            <span className="mono dim">{Math.round(t.progress * 100)}%</span>
            {t.status === 'running' && (
              <Button size="sm" variant="ghost" onClick={() => taskQueue.pause(t.id)} title="Pause (resumes from the last finished stem)">
                Pause
              </Button>
            )}
            {t.status === 'paused' && (
              <Button size="sm" variant="ghost" onClick={() => taskQueue.resume(t.id)}>
                Resume
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => taskQueue.cancel(t.id)}>
              Cancel
            </Button>
          </span>
        </div>
        {compact && t.message && <div className="small dim ellipsis">{t.message}</div>}
        <Progress value={t.progress} ai />
      </div>
    );
  }
  if (t.status === 'failed') {
    return (
      <div className="callout danger small pd-task-msg" role="alert">
        <div>
          <strong>{t.title}</strong> failed: {t.error}
        </div>
        <Button size="sm" variant="ghost" onClick={() => taskQueue.retry(t.id)}>
          Retry
        </Button>
      </div>
    );
  }
  if (t.status === 'cancelled') return <div className="small dim">{t.title} — cancelled.</div>;
  return (
    <div className="small pd-task-done">
      <Icon name="check" size={13} /> {t.title}
      {t.costUsd ? <span className="mono dim"> · {money(t.costUsd)}</span> : null}
    </div>
  );
}

/** All production tasks (guide renders, candidates, regenerations) — newest first. */
export function ProductionQueue() {
  const tasks = useRuntime((s) => s.tasks);
  const list = useMemo(
    () =>
      tasks
        .filter((t) => t.type.startsWith('produce.'))
        .sort((a, b) => {
          const act = (x: TaskRecord) => (x.status === 'running' ? 0 : x.status === 'queued' || x.status === 'paused' ? 1 : 2);
          return act(a) - act(b) || b.createdAt.localeCompare(a.createdAt);
        })
        .slice(0, 8),
    [tasks],
  );
  if (!list.length) return <div className="small dim">No production tasks yet. Guide renders, candidates and regenerations run here — cancellable, resumable and retryable.</div>;
  return (
    <div className="col" style={{ gap: 6 }}>
      {list.map((t) => (
        <TaskRow key={t.id} t={t} compact />
      ))}
      <Button size="sm" variant="ghost" icon="tasks" onClick={() => useStudio.getState().setTaskDrawer(true)}>
        Open generation queue
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capabilities, ratings
// ---------------------------------------------------------------------------

export function CapabilityBadges({ caps, all, wanted }: { caps: Capability[]; all: Capability[]; wanted?: Set<Capability> }) {
  return (
    <div className="pd-caps" aria-label="Provider capabilities">
      {all.map((c) => {
        const have = caps.includes(c);
        const want = wanted?.has(c);
        return (
          <span
            key={c}
            className={`pd-cap ${have ? 'have' : 'missing'} ${want && !have ? 'wanted' : ''}`}
            title={`${CAPABILITY_INFO[c]?.label ?? c}: ${CAPABILITY_INFO[c]?.description ?? ''}${have ? '' : ' — not supported'}`}
          >
            {have ? '✓' : want ? '!' : '–'} {c}
          </span>
        );
      })}
    </div>
  );
}

export function Stars({ value, onChange, label }: { value: number | undefined; onChange: (v: number | undefined) => void; label: string }) {
  return (
    <div className="pd-stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          className={`pd-star ${(value ?? 0) >= n ? 'on' : ''}`}
          onClick={() => onChange(value === n ? undefined : n)}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export function SourceTone({ location }: { location: string | undefined }) {
  if (location === 'internal') return <Badge tone="success">on-device</Badge>;
  if (location === 'local') return <Badge tone="ai">local</Badge>;
  if (location === 'cloud') return <Badge tone="warning">cloud</Badge>;
  return null;
}
