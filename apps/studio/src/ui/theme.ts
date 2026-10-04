import { TRACK_NEUTRAL, TRACK_PALETTE, type SectionKind } from '@songdeck/core';
import { useSettings } from '../state/settings';

/**
 * Theme access for canvas-drawn views. Colours live in styles/theme.css as custom properties;
 * canvases read them at draw time, and call useThemeName() so a theme switch re-renders (and so
 * redraws) them.
 */

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** `#rgb`/`#rrggbb`/`rgb()`/`rgba()` with its alpha multiplied by `a` (for canvas fills). */
export function alpha(color: string, a: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(c);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${(m[4] === undefined ? 1 : Number(m[4])) * a})`;
  return c;
}

export function useThemeName(): 'dark' | 'light' {
  return useSettings((s) => s.theme);
}

/** Section colours (arrangement header, automation ruler), drawn from the track palette. */
export const SECTION_COLORS: Record<SectionKind, string> = {
  intro: TRACK_NEUTRAL,
  verse: TRACK_PALETTE[8],
  'pre-chorus': TRACK_PALETTE[3],
  chorus: TRACK_PALETTE[0],
  'post-chorus': TRACK_PALETTE[11],
  bridge: TRACK_PALETTE[10],
  breakdown: TRACK_PALETTE[6],
  build: TRACK_PALETTE[2],
  drop: TRACK_PALETTE[1],
  solo: TRACK_PALETTE[5],
  interlude: TRACK_PALETTE[7],
  'final-chorus': TRACK_PALETTE[0],
  outro: TRACK_NEUTRAL,
  custom: TRACK_NEUTRAL,
};

export function sectionColor(kind: string): string {
  return SECTION_COLORS[kind as SectionKind] ?? TRACK_NEUTRAL;
}
