import { expect, type Page } from '@playwright/test';

/**
 * Shared Compose steps: open the builder, apply a starting point ("Alt-rock band", "Emo pop-punk",
 * "Dreamy synth-pop", "Cinematic orchestral", "Laid-back hip-hop", "Folk & country") and generate
 * the song straight to the workbench — entirely on-device.
 */
export type Starter = 'Alt-rock band' | 'Emo pop-punk' | 'Dreamy synth-pop' | 'Cinematic orchestral' | 'Laid-back hip-hop' | 'Folk & country';

/** Open Compose from wherever we are (home screen button, else the Compose mode tab). */
export async function openComposer(page: Page): Promise<void> {
  const home = page.getByRole('button', { name: 'Compose a new song' });
  if (await home.isVisible().catch(() => false)) await home.click();
  else await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.getByTestId('compose-builder')).toBeVisible();
  // A previous lyrics-first run may have left the Lyrics tab open.
  await page.getByTestId('compose-builder').getByRole('tab', { name: /^Sound/ }).click();
}

/** Builder → Generate song → workbench, from a starting point. */
export async function composeQuickSong(page: Page, starter: Starter = 'Alt-rock band', timeout = 90_000): Promise<void> {
  await openComposer(page);
  await page.getByTestId('compose-builder').getByRole('button', { name: starter, exact: true }).click();
  await page.getByRole('button', { name: 'Generate song' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout });
}
