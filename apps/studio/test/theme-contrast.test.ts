import { describe, expect, it } from 'vitest';
import { TRACK_NEUTRAL, TRACK_PALETTE } from '@songdeck/core';
import { PAIRS, contrast, measure, parseColor, resolve, themeTokens, type Theme } from './contrast';

/** WCAG AA for every text/background token pair the studio renders, in both themes (docs/BRAND.md). */

const tokens = themeTokens();
const THEMES: Theme[] = ['dark', 'light'];

describe('theme contrast (WCAG AA)', () => {
  for (const theme of THEMES) {
    it(`${theme}: every token pair meets its minimum`, () => {
      const failures = PAIRS.map((p) => ({ ...p, ratio: measure(theme, p, tokens) }))
        .filter((p) => p.ratio < p.min)
        .map(
          (p) =>
            `${p.fg} on ${p.bg}${p.on ? ` over ${p.on}` : ''}: ${p.ratio.toFixed(2)} < ${p.min} (${p.use})`,
        );
      expect(failures).toEqual([]);
    });

    it(`${theme}: track colours stand out from the editor background (3:1)`, () => {
      const bg = resolve(tokens[theme], '--bg');
      for (const c of [...TRACK_PALETTE, TRACK_NEUTRAL])
        expect(contrast(parseColor(c), bg), c).toBeGreaterThanOrEqual(3);
    });
  }

  it('keeps the brand palette in its agreed roles', () => {
    const { dark, light } = tokens;
    expect(dark['--accent']).toBe('#7eebff');
    expect(dark['--playhead']).toBe('#7eebff');
    expect(dark['--ai']).toBe('#c5d1d9');
    expect(dark['--lock']).toBe('#fdca40');
    expect(dark['--border-strong']).toBe('#59666f');
    expect(light['--ai-fill']).toBe('#c5d1d9');
    expect(light['--warning-fill']).toBe('#fdca40');
    expect(TRACK_PALETTE[0]).toBe('#ff299c');
  });

  it('measures the documented reference pairs correctly', () => {
    // White text on the brand pink is the case the palette brief called out (~3.3:1, fails AA).
    expect(contrast(parseColor('#ffffff'), parseColor('#ff299c'))).toBeCloseTo(3.47, 1);
    expect(contrast(parseColor('#000000'), parseColor('#ffffff'))).toBeCloseTo(21, 5);
  });
});
