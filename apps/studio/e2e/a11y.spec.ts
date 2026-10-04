import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { composeQuickSong, openComposer } from './compose-helpers';

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
  const nav = page.getByRole('navigation', { name: 'Project tools' });
  const both = async (label: string) => {
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      found.push(...(await scan(page, `${label} [${theme}]`)));
    }
    await setTheme(page, 'dark');
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI proposes. You shape it.' })).toBeVisible();
  await both('Home');

  await openComposer(page);
  await both('Compose builder');
  await page
    .getByTestId('compose-builder')
    .getByRole('tab', { name: /^Lyrics/ })
    .click();
  await both('Compose lyrics');

  await composeQuickSong(page, 'Alt-rock band');
  await both('Workbench');
  for (const mode of ['Vocals', 'Mix & Master', 'Export'] as const) {
    await nav.getByRole('button', { name: mode, exact: true }).click();
    await page.waitForTimeout(300);
    await both(mode);
  }
  await page.getByTitle(/^Settings/).click();
  await both('Settings');

  expect(found, found.join('\n')).toEqual([]);
});
