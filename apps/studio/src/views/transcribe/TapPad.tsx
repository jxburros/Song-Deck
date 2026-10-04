import { useCallback, useEffect, useRef, useState } from 'react';
import { auditionNote } from '../../engine/audition';
import { Button, Field, Select } from '../../ui/kit';
import { tapTempo } from './model';

export const TAP_SOUNDS: { value: string; label: string; pitch: number; drum: boolean }[] = [
  { value: 'clap', label: 'Clap (drums)', pitch: 39, drum: true },
  { value: 'kick', label: 'Kick (drums)', pitch: 36, drum: true },
  { value: 'snare', label: 'Snare (drums)', pitch: 38, drum: true },
  { value: 'hat', label: 'Closed hi-hat (drums)', pitch: 42, drum: true },
  { value: 'rim', label: 'Side stick (drums)', pitch: 37, drum: true },
  { value: 'note', label: 'Rhythm on one note (C4)', pitch: 60, drum: false },
];

/** A take resets when the pause between taps is longer than this. */
const NEW_TAKE_SECONDS = 3;

/**
 * Tap a rhythm (spec §27): click/touch the pad or press Space / T. Shows a live tempo estimate
 * and the taps on a timeline. Space is captured here so it does not toggle the transport.
 */
export function TapPad({
  onUse,
  sound,
  onSound,
}: {
  onUse: (taps: number[]) => void;
  sound: string;
  onSound: (v: string) => void;
}) {
  const [taps, setTaps] = useState<number[]>([]);
  const [flash, setFlash] = useState(0);
  const t0 = useRef<number | null>(null);
  const last = useRef<number>(0);
  const sel = TAP_SOUNDS.find((s) => s.value === sound) ?? TAP_SOUNDS[0];

  const tap = useCallback(() => {
    const now = performance.now() / 1000;
    if (t0.current === null || now - last.current > NEW_TAKE_SECONDS) {
      t0.current = now;
      setTaps([0]);
    } else setTaps((prev) => [...prev, now - t0.current!]);
    last.current = now;
    setFlash((f) => f + 1);
    auditionNote(sel.pitch, 110, sel.drum);
  }, [sel.pitch, sel.drum]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.modal-backdrop')) return; // a dialog owns the keyboard
      if (e.key === ' ' || e.key.toLowerCase() === 't') {
        // Capture phase on window: runs before the global Space = play/pause hotkey.
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) tap();
      }
    };
    // Space activates a focused button on keyup — swallow it so tapping never clicks "Clear" etc.
    const onKeyUp = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      )
        return;
      if (document.querySelector('.modal-backdrop')) return;
      if (e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, [tap]);

  const bpm = tapTempo(taps);
  const span = taps.length ? Math.max(taps[taps.length - 1], 1) : 1;
  return (
    <div className="col" style={{ gap: 10 }} data-testid="tap-pad">
      <button
        type="button"
        className="tap-pad"
        onPointerDown={(e) => {
          e.preventDefault();
          tap();
        }}
        aria-label="Tap pad"
        style={{
          height: 132,
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-strong)',
          background: flash % 2 ? 'var(--accent-soft)' : 'var(--bg-elev-2)',
          color: 'var(--text)',
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: '0.08em',
          cursor: 'pointer',
          transition: 'background 60ms',
          userSelect: 'none',
          touchAction: 'manipulation',
        }}
      >
        TAP
        <div className="small muted" style={{ fontWeight: 500, letterSpacing: 0, marginTop: 4 }}>
          click / touch · or press Space or T
        </div>
      </button>
      <div className="row between">
        <div>
          <span className="mono" style={{ fontSize: 20, fontWeight: 700 }} data-testid="tap-bpm">
            {bpm ? Math.round(bpm) : '—'}
          </span>{' '}
          <span className="muted small">BPM (live estimate) · {taps.length} taps</span>
        </div>
        <span className="small dim">Pause {NEW_TAKE_SECONDS} s to start a new take</span>
      </div>
      <svg
        width="100%"
        height={22}
        viewBox="0 0 400 22"
        preserveAspectRatio="none"
        style={{ background: 'var(--bg-input)', borderRadius: 6, border: '1px solid var(--border)' }}
        aria-hidden
      >
        {taps.map((t, i) => (
          <rect key={i} x={6 + (t / span) * 386} y={4} width={3} height={14} rx={1} fill="var(--accent)" />
        ))}
      </svg>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Tap sound">
          <Select
            value={sound}
            onChange={onSound}
            options={TAP_SOUNDS.map((s) => ({ value: s.value, label: s.label }))}
            aria-label="Tap sound"
          />
        </Field>
        <div className="spacer" />
        <Button
          onClick={() => {
            setTaps([]);
            t0.current = null;
          }}
          disabled={!taps.length}
        >
          Clear
        </Button>
        <Button variant="primary" icon="midi" disabled={taps.length < 2} onClick={() => onUse(taps)}>
          Convert taps to MIDI
        </Button>
      </div>
    </div>
  );
}
