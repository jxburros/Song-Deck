import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reads the design tokens out of src/styles/theme.css and computes WCAG 2.x contrast ratios, so the
 * contrast test (and docs/BRAND.md's table) are always computed from the shipped CSS.
 */

export type Theme = 'dark' | 'light';
type Rgba = [number, number, number, number];

const THEME_CSS = fileURLToPath(new URL('../src/styles/theme.css', import.meta.url));

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`theme.css has no "${selector}" block`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out[m[1]] = m[2].trim();
  return out;
}

/** Custom properties per theme (light inherits everything it does not redefine). */
export function themeTokens(css = readFileSync(THEME_CSS, 'utf8')): Record<Theme, Record<string, string>> {
  const dark = block(css, ':root');
  return { dark, light: { ...dark, ...block(css, ":root[data-theme='light']") } };
}

export function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error(`Not a colour: ${value}`);
}

/** Resolve a token (following var() references) to a colour, compositing translucent ones over `over`. */
export function resolve(tokens: Record<string, string>, name: string, over?: string): Rgba {
  let value = tokens[name];
  for (let i = 0; value && /^var\(/.test(value) && i < 8; i++) value = tokens[value.slice(4, -1).trim()];
  if (!value) throw new Error(`Unknown token ${name}`);
  const c = parseColor(value);
  if (c[3] >= 1) return c;
  const base = over ? resolve(tokens, over) : ([0, 0, 0, 1] as Rgba);
  return [0, 1, 2].map((i) => c[i] * c[3] + base[i] * (1 - c[3])).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Pair {
  fg: string;
  bg: string;
  /** For a translucent `bg` (soft badge fills): the surface it sits on. */
  on?: string;
  min: number;
  use: string;
}

const SURFACES = ['--bg', '--bg-elev-1', '--bg-elev-2', '--bg-elev-3', '--bg-input'];
const TEXT = [
  '--text',
  '--text-muted',
  '--text-dim',
  '--accent-text',
  '--ai',
  '--success',
  '--danger',
  '--warning',
];

/** The token pairs the UI actually renders, with their WCAG AA minimums. */
export const PAIRS: Pair[] = [
  ...TEXT.flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: 4.5, use: 'text on surfaces' }))),
  ...[
    ['--accent-text', '--accent-soft'],
    ['--ai', '--ai-soft'],
    ['--success', '--success-soft'],
    ['--danger', '--danger-soft'],
    ['--warning', '--warning-soft'],
  ].flatMap(([fg, bg]) =>
    ['--bg-elev-1', '--bg-elev-2', '--bg-input'].map((on) => ({
      fg,
      bg,
      on,
      min: 4.5,
      use: 'badges, chips, selected tabs',
    })),
  ),
  { fg: '--on-accent', bg: '--accent', min: 4.5, use: 'primary button' },
  { fg: '--on-accent', bg: '--accent-strong', min: 4.5, use: 'primary button (hover)' },
  { fg: '--on-ai', bg: '--ai-fill', min: 4.5, use: 'solo / A-B toggles' },
  { fg: '--on-warning', bg: '--warning-fill', min: 4.5, use: 'mute toggle' },
  ...['--accent', '--playhead', '--lock', '--ai', '--success', '--danger', '--warning'].flatMap((fg) =>
    ['--bg', '--bg-elev-1', '--bg-elev-2'].map((bg) => ({
      fg,
      bg,
      min: 3,
      use: 'focus ring, playhead, icons, indicators',
    })),
  ),
];

export function measure(theme: Theme, pair: Pair, tokens = themeTokens()): number {
  const t = tokens[theme];
  const bg = resolve(t, pair.bg, pair.on);
  return contrast(resolve(t, pair.fg), bg);
}
