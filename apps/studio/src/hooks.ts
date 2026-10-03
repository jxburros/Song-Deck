import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { GenreProfile, InstrumentProfile } from '@songdeck/core';
import { player } from './engine/player';
import { useExtensions } from './engine/plugins';
import { useSettings } from './state/settings';
import { useStudio } from './state/store';
import { mergeById } from './state/profiles';

/** Current playhead position in seconds, updated every animation frame while playing. */
export function usePlayhead(): number {
  const [pos, setPos] = useState(() => player.position());
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setPos(player.position());
      raf = requestAnimationFrame(loop);
    };
    const unsub = player.subscribe(() => {
      cancelAnimationFrame(raf);
      if (player.playing) raf = requestAnimationFrame(loop);
      else setPos(player.position());
    });
    if (player.playing) raf = requestAnimationFrame(loop);
    return () => {
      unsub();
      cancelAnimationFrame(raf);
    };
  }, []);
  return pos;
}

/** Re-render on player state changes (play/pause/stop). */
export function usePlayerState() {
  return useSyncExternalStore(
    (cb) => player.subscribe(cb),
    () => player.playing,
  );
}

/** Track an element's size (for canvases). */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Global keyboard shortcuts (ignored while typing in inputs). */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = []) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const combo = `${e.metaKey || e.ctrlKey ? 'mod+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
      const fn = map[combo];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, '0')}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const NO_GENRES: GenreProfile[] = [];
const NO_INSTRUMENTS: InstrumentProfile[] = [];

/**
 * Custom genre profiles visible to the composer (spec §14): plugin-provided, user-defined in
 * Settings and bundled with the open project, de-duplicated by id (later sources win).
 * Reactive counterpart of `allCustomGenres()`.
 */
export function useCustomGenres(): GenreProfile[] {
  const plugin = useExtensions((s) => s.genres);
  const user = useSettings((s) => s.customGenres);
  const project = useStudio((s) => s.project?.meta.customGenres ?? NO_GENRES);
  return useMemo(() => mergeById(plugin, user, project), [plugin, user, project]);
}

/** Custom instrument profiles from plugins, Settings and the open project (see useCustomGenres). */
export function useCustomInstruments(): InstrumentProfile[] {
  const plugin = useExtensions((s) => s.instruments);
  const user = useSettings((s) => s.customInstruments);
  const project = useStudio((s) => s.project?.meta.customInstruments ?? NO_INSTRUMENTS);
  return useMemo(() => mergeById(plugin, user, project), [plugin, user, project]);
}
