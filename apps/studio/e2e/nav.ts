import { expect, type Page } from '@playwright/test';

/**
 * Navigation through the redesigned shell: the rail (Songs, Single Track, Library, Settings), a
 * song's three steps (Write · Sound · Export) and its More tools hub.
 */
export type Area = 'Songs' | 'Single Track' | 'Library' | 'Settings';
export type SongStep = 'Write' | 'Sound' | 'Export';

export function rail(page: Page, area: Area) {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: area, exact: true });
}

export async function openArea(page: Page, area: Area): Promise<void> {
  await rail(page, area).click();
}

export function stepButton(page: Page, step: SongStep) {
  return page
    .getByRole('navigation', { name: 'Song steps' })
    .getByRole('button', { name: step, exact: true });
}

/** Go to one of the open song's steps, coming back from anywhere in the app. */
export async function songStep(page: Page, step: SongStep): Promise<void> {
  if (
    !(await stepButton(page, step)
      .isVisible()
      .catch(() => false))
  )
    await openArea(page, 'Songs');
  await stepButton(page, step).click();
  await expect(stepButton(page, step)).toHaveAttribute('aria-current', 'page');
}

/** Open the More tools hub for the open song. */
export async function openMoreTools(page: Page): Promise<void> {
  if (
    await page
      .getByRole('heading', { name: 'More tools', level: 1 })
      .isVisible()
      .catch(() => false)
  )
    return;
  if (
    !(await stepButton(page, 'Write')
      .isVisible()
      .catch(() => false))
  )
    await openArea(page, 'Songs');
  await page.getByTitle('Every detailed editor for this song').click();
  await expect(page.getByRole('heading', { name: 'More tools', level: 1 })).toBeVisible();
}

/** Open one detailed tool (e.g. 'Piano roll', 'Lyrics', 'Mastering') from More tools. */
export async function openTool(page: Page, name: string): Promise<void> {
  await openMoreTools(page);
  await page
    .locator('.tools-item')
    .filter({ has: page.locator('.tools-name', { hasText: new RegExp(`^${escape(name)}$`) }) })
    .click();
}

/** Open a Settings section by its label (e.g. 'AI services', 'Which model does what'). */
export async function openSettingsTab(page: Page, label: string | RegExp): Promise<void> {
  if (
    !(await page
      .getByTestId('settings-mode')
      .isVisible()
      .catch(() => false))
  )
    await openArea(page, 'Settings');
  await page.getByRole('tab', { name: label }).click();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A track's header in Write's arrangement. */
export function trackHeader(page: Page, name: string) {
  return page.getByTestId('track-header').filter({ hasText: name }).first();
}

/** Run one action from a track's options menu (Edit notes, Mute, Solo, Lock track, …). */
export async function trackAction(page: Page, name: string, action: string | RegExp): Promise<void> {
  await trackHeader(page, name)
    .getByRole('button', { name: `${name} options`, exact: true })
    .click();
  await page
    .getByRole('menu', { name: `${name} options`, exact: true })
    .getByRole('menuitem', { name: action })
    .click();
}

/** Export step, with every format shown (the five quick exports plus More formats). */
export async function openExportFormats(page: Page): Promise<void> {
  await songStep(page, 'Export');
  await expect(page.getByRole('heading', { name: 'Take it with you' })).toBeVisible();
  const more = page.locator('details.ex-more');
  if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open))) await more.locator('summary').click();
}
