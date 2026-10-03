/**
 * Prints the contrast table in docs/BRAND.md from the shipped theme.css:
 *   npx tsx apps/studio/test/contrast-table.ts
 * Each row reports the lowest ratio over the surfaces that pair is checked against.
 */
import { PAIRS, measure, themeTokens, type Pair } from './contrast';

const tokens = themeTokens();
const groups = new Map<string, Pair[]>();
for (const p of PAIRS) {
  const key = `${p.fg}|${p.bg.startsWith('--bg') ? 'surfaces' : p.bg}|${p.min}`;
  groups.set(key, [...(groups.get(key) ?? []), p]);
}
const lowest = (theme: 'dark' | 'light', pairs: Pair[]) => {
  let worst = pairs[0];
  let ratio = Infinity;
  for (const p of pairs) {
    const r = measure(theme, p, tokens);
    if (r < ratio) [ratio, worst] = [r, p];
  }
  return `${ratio.toFixed(2)} (${(worst.on ?? worst.bg).replace('--', '')})`;
};
console.log('| Foreground | Background | Use | AA min | Dark: lowest | Light: lowest |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const [key, pairs] of groups) {
  const [fg, bg, min] = key.split('|');
  const bgLabel = bg === 'surfaces' ? pairs.map((p) => `\`${p.bg}\``).join(', ') : `\`${bg}\`${pairs[0].on ? ` over ${pairs.map((p) => p.on!.replace('--', '')).join('/')}` : ''}`;
  console.log(`| \`${fg}\` | ${bgLabel} | ${pairs[0].use} | ${min}:1 | ${lowest('dark', pairs)} | ${lowest('light', pairs)} |`);
}
