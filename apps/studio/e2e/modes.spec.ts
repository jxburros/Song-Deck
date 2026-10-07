import { expect, test } from '@playwright/test';
import { composeQuickSong } from './compose-helpers';
import { openArea, openMoreTools, openTool, rail, songStep, stepButton, type Area } from './nav';

/** Every area, song step and detailed tool opens with a song loaded (and without one where allowed). */

const AREAS: Area[] = ['Single Track', 'AI Audio', 'Library', 'Settings', 'Songs'];

const TOOLS = [
  'Piano roll',
  'Pattern editor',
  'Chords',
  'Structure editor',
  'Theory',
  'Macros',
  'Locks',
  'Lyrics',
  'Vocal melody',
  'Expression',
  'Singer and render',
  'Change the vocals in words',
  'Record a take',
  'Voice library',
  'Voice conversion',
  'Guide sound',
  'Production plan',
  'Audio versions',
  'Regenerate a region',
  'Full console',
  'Mix assistant',
  'Automation',
  'Mastering',
  'History and branches',
  'Variations and Song DNA',
  'Inspector',
  'Provenance, rights and credits',
  'Assistant',
  'Proposal history',
  'Describe a part',
  'A part from audio',
];

test('every area, step and tool renders with and without a song', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make a song' })).toBeVisible();

  for (const area of AREAS) {
    await openArea(page, area);
    await expect(rail(page, area)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('main')).not.toContainText('This view ran into a problem');
  }
  // No song yet: no song steps.
  await expect(page.getByRole('navigation', { name: 'Song steps' })).toHaveCount(0);

  await composeQuickSong(page, 'Cinematic orchestral');

  for (const step of ['Write', 'Sound', 'Export'] as const) {
    await songStep(page, step);
    await expect(page.locator('main')).not.toContainText('This view ran into a problem');
  }

  // Leaving for another area and coming back returns to the song.
  await openArea(page, 'Library');
  await openArea(page, 'Songs');
  await expect(stepButton(page, 'Export')).toHaveAttribute('aria-current', 'page');

  for (const tool of TOOLS) {
    await openTool(page, tool);
    await expect(page.locator('main')).not.toContainText('This view ran into a problem');
    await page.waitForTimeout(150);
  }

  // Write's editors, then the More tools search.
  await songStep(page, 'Write');
  for (const view of ['Arrangement', 'Piano Roll']) {
    await page.getByRole('tab', { name: view }).click();
    await page.waitForTimeout(150);
  }
  await openMoreTools(page);
  await page.getByLabel('Find a tool').fill('loudness');
  await expect(page.locator('.tools-item')).toHaveCount(1);
  await expect(page.locator('.tools-item')).toContainText('Mastering');
  expect(errors, errors.join('\n')).toEqual([]);
});
