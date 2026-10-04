import { expect, test } from '@playwright/test';
import { composeQuickSong } from './compose-helpers';

/** Every mode opens with a song loaded (and without one where allowed) and never throws. */

const MODES = [
  'Compose',
  'Workbench',
  'Add Track',
  'Transcribe Track',
  'Single Track',
  'Library',
  'Produce',
  'Vocals',
  'Mix & Master',
  'Export',
] as const;
const PROJECTLESS = new Set(['Compose', 'Single Track', 'Library']);

test('every mode renders with and without a project', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI proposes. You shape it.' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: /Modes|Project tools/ });

  for (const mode of PROJECTLESS) {
    await nav.getByRole('button', { name: mode, exact: true }).click();
    await expect(page.locator('main')).not.toContainText('This view ran into a problem');
  }
  for (const mode of MODES)
    if (!PROJECTLESS.has(mode))
      await expect(nav.getByRole('button', { name: mode, exact: true })).toHaveCount(0);

  await composeQuickSong(page, 'Cinematic orchestral');

  for (const mode of MODES) {
    if (!PROJECTLESS.has(mode)) await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await nav.getByRole('button', { name: mode, exact: true }).click();
    await expect(nav.getByRole('button', { name: mode, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('main')).not.toContainText('This view ran into a problem');
    await page.waitForTimeout(300);
  }
  await page.getByTitle(/^Settings/).click();
  await expect(page.locator('main')).not.toContainText('This view ran into a problem');

  // Workbench views and side panels.
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click();
  for (const view of ['Arrangement', 'Piano Roll', 'Pattern', 'Chords', 'Structure', 'Theory']) {
    await page.getByRole('tab', { name: view }).click();
    await page.waitForTimeout(150);
  }
  for (const panel of [
    'AI Edit',
    'Assistant',
    'Proposals',
    'Macros',
    'Locks',
    'Variation',
    'History',
    'Inspector',
  ]) {
    await page.locator('.right-tabs .tab', { hasText: panel }).click();
    await page.waitForTimeout(100);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
