import { useEffect, useRef } from 'react';
import { player } from '../../engine/player';

/**
 * Live level meters. One requestAnimationFrame loop polls `player.meters` (per-track and
 * master peak/RMS from the playback renderer) and writes straight to the DOM — no React
 * re-render per frame. Ballistics: instant attack, ~26 dB/s peak fall, 1.5 s peak hold,
 * latching clip indicator (click to reset).
 */

export const MASTER_METER = '__master';
const FLOOR_DB = -60;
const CEIL_DB = 6;

interface Entry {
  fill: HTMLDivElement;
  rms: HTMLDivElement;
  hold: HTMLDivElement;
  clip: HTMLButtonElement;
  readout?: HTMLElement | null;
  level: number;
  rmsLevel: number;
  holdDb: number;
  holdUntil: number;
  clipped: boolean;
  shownHold: string;
}

const entries = new Map<string, Set<Entry>>();
let raf = 0;
let last = 0;

const frac = (db: number) => Math.max(0, Math.min(1, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)));

function loop(t: number) {
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
  last = t;
  const snap = player.playing ? player.meters : null;
  for (const [id, set] of entries) {
    const m = snap ? (id === MASTER_METER ? snap.master : snap.tracks[id]) : undefined;
    const peak = m?.peakDb ?? -120;
    const rms = m?.rmsDb ?? -120;
    for (const e of set) {
      e.level = peak >= e.level ? peak : Math.max(peak, e.level - 26 * dt);
      e.rmsLevel = rms >= e.rmsLevel ? rms : Math.max(rms, e.rmsLevel - 16 * dt);
      if (e.level >= e.holdDb) {
        e.holdDb = e.level;
        e.holdUntil = t + 1500;
      } else if (t > e.holdUntil) e.holdDb = Math.max(e.level, e.holdDb - 20 * dt);
      e.fill.style.height = `${(frac(e.level) * 100).toFixed(2)}%`;
      e.rms.style.height = `${(frac(e.rmsLevel) * 100).toFixed(2)}%`;
      e.hold.style.bottom = `${(frac(e.holdDb) * 100).toFixed(2)}%`;
      e.hold.style.opacity = e.holdDb > FLOOR_DB ? '1' : '0';
      if (peak > -0.05 && !e.clipped) {
        e.clipped = true;
        e.clip.classList.add('on');
      }
      if (e.readout) {
        const text =
          e.holdDb <= FLOOR_DB ? '−∞' : `${e.holdDb < 0 ? '−' : '+'}${Math.abs(e.holdDb).toFixed(1)}`;
        if (text !== e.shownHold) {
          e.readout.textContent = text;
          e.shownHold = text;
        }
      }
    }
  }
  raf = entries.size ? requestAnimationFrame(loop) : 0;
}

function register(id: string, e: Entry): () => void {
  let set = entries.get(id);
  if (!set) entries.set(id, (set = new Set()));
  set.add(e);
  if (!raf) {
    last = 0;
    raf = requestAnimationFrame(loop);
  }
  return () => {
    set!.delete(e);
    if (!set!.size) entries.delete(id);
    if (!entries.size && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** Vertical level meter bound to a track id (or MASTER_METER). */
export function MeterBar({
  id,
  height,
  label,
  readoutId,
}: {
  id: string;
  height: number;
  label: string;
  readoutId?: string;
}) {
  const fill = useRef<HTMLDivElement>(null);
  const rms = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLButtonElement>(null);
  const entryRef = useRef<Entry | null>(null);
  useEffect(() => {
    if (!fill.current || !rms.current || !hold.current || !clip.current) return;
    const e: Entry = {
      fill: fill.current,
      rms: rms.current,
      hold: hold.current,
      clip: clip.current,
      readout: readoutId ? document.getElementById(readoutId) : null,
      level: -120,
      rmsLevel: -120,
      holdDb: -120,
      holdUntil: 0,
      clipped: false,
      shownHold: '',
    };
    entryRef.current = e;
    return register(id, e);
  }, [id, readoutId]);
  return (
    <div
      className="mx-meter"
      style={{ height, ['--mh' as string]: `${height - 7}px` }}
      role="group"
      aria-label={`${label} level meter`}
    >
      <button
        ref={clip}
        type="button"
        className="mx-meter-clip"
        title="Clip indicator — click to reset"
        aria-label={`${label} clip indicator`}
        onClick={() => {
          const e = entryRef.current;
          if (!e) return;
          e.clipped = false;
          e.clip.classList.remove('on');
          e.holdDb = -120;
        }}
      />
      <div className="mx-meter-body">
        <div className="mx-meter-fill" ref={fill} />
        <div className="mx-meter-rms" ref={rms} />
        <div className="mx-meter-hold" ref={hold} />
        <div className="mx-meter-zero" style={{ bottom: `${frac(0) * 100}%` }} />
      </div>
    </div>
  );
}
