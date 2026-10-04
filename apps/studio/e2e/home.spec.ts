import { expect, test } from '@playwright/test';

test('project library opens by keyboard and keeps deletion separate', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Empty project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New empty project' });
  await dialog.getByRole('textbox').fill('Ice study');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Song Deck — projects', exact: true }).click();
  const project = page.getByRole('button', { name: 'Open Ice study', exact: true });
  await expect(project).toBeVisible();
  await project.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('compose-builder')).toBeVisible();
  await page.getByRole('button', { name: 'Song Deck — projects', exact: true }).click();
  await page.getByTitle('Delete project', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete project?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(project).toBeVisible();
});

test('home creation actions remain reachable on phones', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI proposes. You shape it.' })).toBeVisible();
  const home = page.locator('.home-page');
  expect(await home.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Start from lyrics', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Lyrics/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Song Deck — projects', exact: true }).click();
  await page.getByRole('button', { name: 'Browse Library', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Studio mode' })).toHaveValue('library');
});
