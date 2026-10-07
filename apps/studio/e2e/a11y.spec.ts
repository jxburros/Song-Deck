import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addQuickLyrics, composeQuickSong, openComposer, openShape } from './compose-helpers';
import { openArea, openMoreTools, openTool, songStep } from './nav';

/**
 * Automated accessibility checks (axe-core, WCAG 2.1 A/AA) on the main screens in both themes.
 * Canvas-drawn editors are not inspected by axe; their contrast comes from the theme tokens,
 * which apps/studio/test/theme-contrast.test.ts checks.
 */

async function scan(page: Page, label: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map(
    (v) =>
      `${label}: ${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join('\n    ')}`,
  );
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(100);
}

test('main screens have no WCAG A/AA violations in either theme', async ({ page }) => {
  test.setTimeout(180_000);
  const found: string[] = [];
  const both = async (label: string) => {
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      found.push(...(await scan(page, `${label} [${theme}]`)));
    }
    await setTheme(page, 'dark');
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make a song' })).toBeVisible();
  await both('Songs');

  await openComposer(page);
  await addQuickLyrics(page);
  await both('Start a song · Material');
  await openShape(page);
  await both('Start a song · Shape');

  await composeQuickSong(page, 'Alt-rock band');
  await both('Write');
  for (const step of ['Sound', 'Export'] as const) {
    await songStep(page, step);
    await page.waitForTimeout(300);
    await both(step);
  }
  await openMoreTools(page);
  await both('More tools');
  for (const tool of ['Lyrics', 'Full console'] as const) {
    await openTool(page, tool);
    await page.waitForTimeout(300);
    await both(tool);
  }
  for (const area of ['Single Track', 'AI Audio', 'Library', 'Settings'] as const) {
    await openArea(page, area);
    await page.waitForTimeout(300);
    await both(area);
  }

  expect(found, found.join('\n')).toEqual([]);
});
