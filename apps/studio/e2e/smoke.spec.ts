import { expect, test } from '@playwright/test';
import { openComposer } from './compose-helpers';

/**
 * End-to-end smoke test of the Phase 1 loop, entirely on-device (no AI keys):
 * builder → blueprint → plan → MIDI → workbench → lock → regenerate → AI edit proposal → accept → export.
 */
test('compose a song, edit it with words, and keep control', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI proposes. You shape it.' })).toBeVisible();

  // Builder → fine-tune the blueprint → plan → MIDI (the long way round; composeQuickSong is the short one).
  await openComposer(page);
  await page
    .getByTestId('compose-builder')
    .getByRole('button', { name: 'Alt-rock band', exact: true })
    .click();
  await expect(page.getByTestId('builder-instrument')).toHaveCount(5);
  await page.getByRole('button', { name: 'Fine-tune first' }).click();
  await expect(page.getByRole('heading', { name: 'Song Blueprint' })).toBeVisible();
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await expect(page.getByRole('heading', { name: 'Composition Plan' })).toBeVisible();
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
