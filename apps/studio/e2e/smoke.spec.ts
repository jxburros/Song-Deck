import { expect, test } from '@playwright/test';
import { addQuickLyrics, openComposer, openShape } from './compose-helpers';
import { openTool } from './nav';

/**
 * End-to-end smoke test of the Phase 1 loop, entirely on-device (no AI keys):
 * Start a song → Shape → blueprint → plan → MIDI → Write → regenerate → change in words → accept.
 */
test('compose a song, edit it with words, and keep control', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make a song' })).toBeVisible();

  // Material → Shape → review the blueprint → plan → MIDI (the long way; composeQuickSong is the short one).
  await openComposer(page);
  await addQuickLyrics(page);
  await openShape(page);
  const builder = page.getByTestId('compose-builder');
  await builder.getByRole('button', { name: 'Alt-rock band', exact: true }).click();
  await expect(page.getByTestId('builder-instrument')).toHaveCount(5);
  await builder.getByRole('checkbox', { name: /Review the blueprint and plan/ }).check();
  await page.getByRole('button', { name: 'Review the blueprint' }).click();
  await expect(page.getByRole('heading', { name: 'Song Blueprint' })).toBeVisible();
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await expect(page.getByRole('heading', { name: 'Composition Plan' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate MIDI composition' }).click();

  // Write: arrangement with tracks and sections.
  await expect(page.getByTestId('arrangement')).toBeVisible();
  expect(await page.getByTestId('track-header').count()).toBeGreaterThan(4);

  // Piano roll renders.
  await page.getByRole('tab', { name: 'Piano Roll' }).click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();

  // Change in words → proposal → accept.
  await page.getByRole('tab', { name: 'Arrangement' }).click();
  await page.getByTestId('track-header').filter({ hasText: 'Bass' }).first().click();
  await expect(page.locator('.scope-chip').first()).toBeVisible();
  await page.getByLabel('Edit instruction').fill('Make the bass busier.');
  await page.getByRole('button', { name: 'Propose change' }).click();
  await page.getByRole('button', { name: 'Accept' }).first().click();

  // Theory explains the music.
  await openTool(page, 'Theory');
  await expect(page.getByTestId('theory-view')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
