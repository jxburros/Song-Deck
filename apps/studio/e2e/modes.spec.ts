import { expect, test } from '@playwright/test';

/** Every mode opens with a song loaded (and without one where allowed) and never throws. */

const MODES = ['Compose', 'Workbench', 'Generate', 'Transcribe', 'Rebuild', 'Produce', 'Vocals', 'Mix & Master', 'Export'] as const;
const PROJECTLESS = new Set(['Compose', 'Generate', 'Transcribe', 'Rebuild']);

test('every mode renders with and without a project', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByText('AI that gives you the song back.')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Modes' });

  for (const mode of PROJECTLESS) {
    await nav.getByRole('button', { name: mode, exact: true }).click();
    await expect(page.locator('main')).not.toContainText('This view ran into a problem');
  }
  for (const mode of MODES) if (!PROJECTLESS.has(mode)) await expect(nav.getByRole('button', { name: mode, exact: true })).toBeDisabled();

  await nav.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.getByLabel('Song prompt').fill('Slow cinematic orchestral piece in C minor with strings, brass, piano and timpani. Instrumental.');
  await page.getByRole('button', { name: 'Draft Song Blueprint' }).click();
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await page.getByRole('button', { name: 'Generate MIDI composition' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible();

  for (const mode of MODES) {
    await nav.getByRole('button', { name: mode, exact: true }).click();
    await expect(nav.getByRole('button', { name: mode, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('main')).not.toContainText('This view ran into a problem');
    await page.waitForTimeout(300);
  }
  await page.getByTitle(/^Settings/).click();
  await expect(page.locator('main')).not.toContainText('This view ran into a problem');

  // Workbench views and side panels.
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click();
  for (const view of ['Arrangement', 'Piano Roll', 'Pattern', 'Chords', 'Structure', 'Theory']) {
    await page.getByRole('tab', { name: view }).click();
    await page.waitForTimeout(150);
  }
  for (const panel of ['AI Edit', 'Assistant', 'Proposals', 'Macros', 'Locks', 'Variation', 'History', 'Inspector']) {
    await page.locator('.right-tabs .tab', { hasText: panel }).click();
    await page.waitForTimeout(100);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
