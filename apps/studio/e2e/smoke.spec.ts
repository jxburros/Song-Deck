import { expect, test } from '@playwright/test';

/**
 * End-to-end smoke test of the Phase 1 loop, entirely on-device (no AI keys):
 * prompt → blueprint → plan → MIDI → workbench → lock → regenerate → AI edit proposal → accept → export.
 */
test('compose a song, edit it with words, and keep control', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByText('AI that gives you the song back.')).toBeVisible();

  await page.getByRole('button', { name: 'Compose a new song' }).click();
  await page.getByLabel('Song prompt').fill(
    'Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.',
  );
  await page.getByRole('button', { name: 'Draft Song Blueprint' }).click();
  await expect(page.getByText('Song Blueprint')).toBeVisible();
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await expect(page.getByText('Composition Plan')).toBeVisible();
  await page.getByRole('button', { name: 'Generate MIDI composition' }).click();

  // Workbench with tracks and sections.
  await expect(page.getByTestId('arrangement')).toBeVisible();
  const trackRows = page.locator('.wb-left .track-row');
  expect(await trackRows.count()).toBeGreaterThan(4);

  // Piano roll renders.
  await page.getByRole('tab', { name: 'Piano Roll' }).click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();

  // AI edit → proposal → accept.
  await page.getByRole('tab', { name: 'Arrangement' }).click();
  const bassRow = page.locator('.wb-left .track-row', { hasText: 'Bass' }).first();
  await bassRow.click();
  await page.locator('.right-tabs .tab', { hasText: 'AI Edit' }).click();
  await page.getByLabel('Edit instruction').fill('Make the bass busier.');
  await page.getByRole('button', { name: 'Propose change' }).click();
  await expect(page.locator('.right-tabs .tab', { hasText: 'Proposals' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).first().click();

  // Theory view explains the music.
  await page.getByRole('tab', { name: 'Theory' }).click();
  await expect(page.getByTestId('theory-view')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
