import type { SVGProps } from 'react';

/** Inline stroke icons (24×24 grid, currentColor). */
const PATHS: Record<string, string> = {
  play: 'M7 5v14l11-7z',
  pause: 'M7 5h3v14H7zM14 5h3v14h-3z',
  stop: 'M6 6h12v12H6z',
  record: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  loop: 'M4 12a6 6 0 0 1 6-6h8m0 0-3-3m3 3-3 3M20 12a6 6 0 0 1-6 6H6m0 0 3 3m-3-3 3-3',
  metronome: 'M9 3h6l3 18H6L9 3zM12 14l5-7',
  rewind: 'M11 6 4 12l7 6V6zM20 6l-7 6 7 6V6z',
  compose: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  workbench: 'M3 5h18M3 12h18M3 19h18M8 3v4M16 10v4M11 17v4',
  midi: 'M4 4h16v16H4zM8 4v9M12 4v9M16 4v9M6 13h4M10 13h4M14 13h4',
  wave: 'M2 12h2l2-6 3 12 3-14 3 16 3-10 2 2h2',
  rebuild: 'M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.4 6.4L3 16M3 21v-5h5',
  produce: 'M12 3v18M5 8v8M19 6v12M8.5 5v14M15.5 9v6',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  mixer: 'M6 3v18M12 3v18M18 3v18M4 15h4M10 8h4M16 13h4',
  export: 'M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  home: 'M3 11 12 4l9 7M5 10v10h14V10',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12l5 5L20 7',
  sparkles:
    'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 3l.6 1.4L7 5l-1.4.6L5 7l-.6-1.4L3 5l1.4-.6z',
  dice: 'M4 4h16v16H4zM8.5 8.5h.01M15.5 15.5h.01M15.5 8.5h.01M8.5 15.5h.01M12 12h.01',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  upload: 'M12 21V9m0 0-4 4m4-4 4 4M4 7V4h16v3',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M4 21h16',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  alert: 'M12 3 2 21h20L12 3zM12 10v5M12 18h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  cloud: 'M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 1 0 6 17.5 4 4 0 0 0 7 19z',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  plug: 'M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zM15.5 7.5l3 3L22 7l-3-3',
  zoomIn: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3M11 8v6M8 11h6',
  zoomOut: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3M8 11h6',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  pointer: 'M4 4l7 17 2.5-7.5L21 11z',
  scissors:
    'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  waveform: 'M3 12h1M6 8v8M9 5v14M12 9v6M15 6v12M18 10v4M21 12h0',
};

export type IconName = keyof typeof PATHS | string;

export function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const d = PATHS[name] ?? PATHS.info;
  const filled = name === 'play' || name === 'pause' || name === 'stop' || name === 'record';
  return (
    <svg
      className="icon-svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

/**
 * The Song Deck mark: a fanned deck of cards in the brand colours, the front card carrying a
 * waveform (docs/brand/logo-a.svg; keep public/favicon.svg in step). The brand colours are fixed
 * here, not themed: the ink tile keeps them legible on light and dark surfaces alike.
 */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#121212" />
      <rect x="20" y="11" width="28" height="38" rx="5" fill="#fdca40" transform="rotate(-20 34 61)" />
      <rect
        x="20"
        y="11"
        width="28"
        height="38"
        rx="5"
        fill="#32cbff"
        stroke="#121212"
        strokeWidth="2"
        transform="rotate(-5 34 61)"
      />
      <g transform="rotate(11 34 61) translate(2 -1)">
        <rect x="18" y="12" width="28" height="38" rx="5" fill="#ff299c" stroke="#121212" strokeWidth="2" />
        <rect x="20.5" y="27" width="4" height="10" rx="2" fill="#121212" />
        <rect x="26.5" y="21" width="4" height="22" rx="2" fill="#121212" />
        <rect x="32.5" y="24" width="4" height="16" rx="2" fill="#121212" />
        <rect x="38.5" y="28" width="4" height="8" rx="2" fill="#121212" />
      </g>
    </svg>
  );
}
