import { expect, test } from '@playwright/test';
import { openArea, rail } from './nav';

test('songs open by keyboard and keep deletion separate', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Empty project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New empty project' });
  await dialog.getByRole('textbox').fill('Ice study');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('compose-builder')).toBeVisible();
  await page.getByRole('button', { name: 'Song Deck — songs', exact: true }).click();
  const project = page.getByRole('button', { name: 'Open Ice study', exact: true });
  await expect(project).toBeVisible();
  await project.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('compose-builder')).toBeVisible();
  await page.getByRole('button', { name: 'Song Deck — songs', exact: true }).click();
  await page.getByTitle('Delete project', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete project?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(project).toBeVisible();
});

test('home creation actions remain reachable on phones', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make a song' })).toBeVisible();
  const home = page.locator('.home-page');
  expect(await home.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Start from lyrics', exact: true }).click();
  await expect(
    page.getByTestId('compose-builder').getByRole('textbox', { name: 'Lyrics', exact: true }),
  ).toBeVisible();
  // The rail is a bottom bar on phones, with every area one tap away.
  for (const area of ['Single Track', 'Library', 'Settings', 'Songs'] as const) {
    await openArea(page, area);
    await expect(rail(page, area)).toHaveAttribute('aria-current', 'page');
  }
});
