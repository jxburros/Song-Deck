import type { StemGroup, TrackRole } from './types';

/**
 * Track colours (docs/BRAND.md). Twelve hues spaced around the wheel and tuned to the brand pink's
 * contrast: each is about 5.4:1 against the dark theme's #121212 background and at least 3:1
 * against the light theme's #f2f2f2, so notes, clips and colour chips read the same in both
 * themes. Vocals take the brand pink itself.
 */
export const TRACK_PALETTE = [
  '#ff299c', // pink (brand)
  '#ee554c', // coral
  '#de6907', // orange
  '#b38007', // gold
  '#8f8f0b', // olive
  '#0ca02d', // green
  '#019d7e', // teal
  '#03999d', // cyan
  '#0b95c0', // blue
  '#3587fb', // azure
  '#8778fc', // violet
  '#bb65df', // orchid
] as const;

/** Neutral for custom tracks and unknown roles (5.1:1 on #121212, 3.3:1 on #f2f2f2). */
export const TRACK_NEUTRAL = '#858585';

export const ROLE_COLORS: Record<TrackRole, string> = {
  vocal: TRACK_PALETTE[0],
  drums: TRACK_PALETTE[1],
  percussion: TRACK_PALETTE[2],
  bass: TRACK_PALETTE[3],
  'rhythm-guitar': TRACK_PALETTE[4],
  'lead-guitar': TRACK_PALETTE[5],
  keys: TRACK_PALETTE[6],
  'synth-seq': TRACK_PALETTE[7],
  strings: TRACK_PALETTE[8],
  'synth-pad': TRACK_PALETTE[9],
  'synth-arp': TRACK_PALETTE[10],
  'synth-lead': TRACK_PALETTE[11],
  custom: TRACK_NEUTRAL,
};

export const STEM_COLORS: Record<StemGroup, string> = {
  vocals: ROLE_COLORS.vocal,
  drums: ROLE_COLORS.drums,
  bass: ROLE_COLORS.bass,
  guitars: ROLE_COLORS['rhythm-guitar'],
  keys: ROLE_COLORS.keys,
  strings: ROLE_COLORS.strings,
  others: TRACK_NEUTRAL,
};

export function colorForRole(role: string): string {
  return ROLE_COLORS[role as TrackRole] ?? TRACK_NEUTRAL;
}

/** The n-th palette colour, cycling — for tracks without a meaningful role (imports, plugins). */
export function paletteColor(index: number): string {
  const n = TRACK_PALETTE.length;
  return TRACK_PALETTE[((Math.floor(index) % n) + n) % n];
}
