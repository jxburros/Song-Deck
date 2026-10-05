import { expect, type Page } from '@playwright/test';

/**
 * Shared Start-a-song steps: start from lyrics, apply a starting point ("Alt-rock band", "Emo
 * pop-punk", "Dreamy synth-pop", "Cinematic orchestral", "Laid-back hip-hop", "Folk & country") on
 * the Shape step and create the song straight to Write — entirely on-device.
 */
export type Starter =
  | 'Alt-rock band'
  | 'Emo pop-punk'
  | 'Dreamy synth-pop'
  | 'Cinematic orchestral'
  | 'Laid-back hip-hop'
  | 'Folk & country';

export const QUICK_LYRICS =
  '[Verse]\nCity lights are fading slow\nI keep the window open\n[Chorus]\nLeaving home tonight';

/** Open Start a song from wherever we are: the Songs home tile, else the rail's Songs → home. */
export async function openComposer(page: Page): Promise<void> {
  const builder = page.getByTestId('compose-builder');
  if (await builder.isVisible().catch(() => false)) return;
  const tile = page.getByRole('button', { name: 'Start from lyrics' });
  if (!(await tile.isVisible().catch(() => false))) {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: 'Songs', exact: true })
      .click();
  }
  await tile.click();
  await expect(builder).toBeVisible();
}

/** Go to one step of Start a song. */
export async function composeStep(page: Page, step: 'Material' | 'Shape'): Promise<void> {
  await page
    .getByTestId('compose-builder')
    .getByRole('navigation', { name: 'New song steps' })
    .getByRole('button', { name: new RegExp(step) })
    .click();
}

/** Material step: make sure there are some lyrics, so the song has starting material. */
export async function addQuickLyrics(page: Page, lyrics = QUICK_LYRICS): Promise<void> {
  const builder = page.getByTestId('compose-builder');
  await composeStep(page, 'Material');
  const box = builder.getByRole('textbox', { name: 'Lyrics', exact: true });
  if (!(await box.isVisible().catch(() => false))) {
    await builder.getByTestId('material').getByRole('button', { name: 'Lyrics', exact: true }).click();
  }
  if (!(await box.inputValue()).trim()) await box.fill(lyrics);
}

/** Material step: lyrics as placeholder words (a sung song without your own lyrics). */
export async function usePlaceholderLyrics(page: Page): Promise<void> {
  const builder = page.getByTestId('compose-builder');
  await composeStep(page, 'Material');
  const mode = builder.getByRole('combobox', { name: 'Lyrics starting point' });
  if (!(await mode.isVisible().catch(() => false))) {
    await builder.getByTestId('material').getByRole('button', { name: 'Lyrics', exact: true }).click();
  }
  await mode.selectOption({ label: 'Placeholder words' });
}

/** Move to the Shape step of Start a song. */
export async function openShape(page: Page): Promise<void> {
  await composeStep(page, 'Shape');
}

/** Start a song → placeholder lyrics → Shape → a starting point → Create song → Write. */
export async function composeQuickSong(
  page: Page,
  starter: Starter = 'Alt-rock band',
  timeout = 90_000,
): Promise<void> {
  await openComposer(page);
  await usePlaceholderLyrics(page);
  await openShape(page);
  await page.getByTestId('compose-builder').getByRole('button', { name: starter, exact: true }).click();
  await page.getByRole('button', { name: 'Create song' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout });
}
