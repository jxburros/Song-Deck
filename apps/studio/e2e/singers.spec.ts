import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { composeQuickSong } from './compose-helpers';
import { openTool, songStep } from './nav';

/**
 * Singers and their ranges, end to end: create a singer from a voice type, adjust a zone, assign
 * them to the lead vocal, read the range check, propose and accept the key that suits them, see the
 * zones in the piano roll and the track details, and keep the singer in My singers.
 */

const SHOTS = '/tmp/claude-0';
mkdirSync(SHOTS, { recursive: true });

test.describe.configure({ timeout: 300_000 });

async function axe(page: Page, selectors: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(100);
    let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    for (const s of selectors) builder = builder.include(s);
    const results = await builder.analyze();
    found.push(
      ...results.violations.map((v) => `[${theme}] ${v.id} — ${v.help}: ${v.nodes[0]?.target.join(' ')}`),
    );
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  return found;
}

test('singer ranges: zones, range check, a better key and the piano roll', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await composeQuickSong(page, 'Alt-rock band', 90_000);

  // ---- Vocals → Singers: a new singer from a voice type, one zone adjusted ----------------------
  await openTool(page, 'Singers and ranges');
  const panel = page.getByTestId('singers-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Singer of this part' })).toHaveValue('');
  await panel.getByRole('button', { name: 'New singer…' }).click();
  const editor = page.getByTestId('singer-editor');
  await editor.getByRole('textbox', { name: 'Singer name' }).fill('Robin');
  await editor.getByRole('combobox', { name: 'Voice type' }).selectOption('baritone');
  await editor.getByRole('button', { name: 'Use typical zones' }).click();
  await expect(editor.getByRole('textbox', { name: 'Lowest note' })).toHaveValue('A2');
  await editor.getByRole('textbox', { name: 'Easy up to' }).fill('C4');
  await expect(editor.getByText(/^sweet spot D3–C4 · easy B2–C4/)).toBeVisible();
  expect(await axe(page, ['[data-testid="singer-editor"]'])).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/singer-editor.png` });
  await page.getByTestId('singer-save').click();
  await expect(editor).toBeHidden();

  // ---- The singer sings the lead vocal: zones and the range check ------------------------------
  await expect(panel.getByRole('combobox', { name: 'Singer of this part' })).not.toHaveValue('');
  const card = panel.getByTestId('singer-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Robin');
  await expect(card).toContainText('sings Lead Vocal');
  const check = panel.getByTestId('range-check');
  await expect(check).toBeVisible();
  await expect(check.getByRole('img')).toHaveAttribute('aria-label', /%/);
  await page.screenshot({ path: `${SHOTS}/singers-panel.png`, fullPage: true });
  expect(await axe(page, ['[data-testid="singers-panel"]'])).toEqual([]);

  // ---- A better key for Robin: propose, accept in the piano roll, the check improves -------------
  const propose = check.getByRole('button', { name: 'Propose this change' });
  if (await propose.isVisible()) {
    // The suggestion says what the part becomes; after accepting it, the check agrees.
    const suggestion = (await check.getByText(/^Better for Robin/).textContent()) ?? '';
    const promised = /which makes it ([a-z ]+)\.$|still ([a-z ]+)\)\.$/i.exec(suggestion.trim());
    expect(promised).not.toBeNull();
    await propose.click();
    await songStep(page, 'Write');
    await page.getByRole('tab', { name: 'Piano Roll' }).click();
    await page.getByRole('button', { name: 'Accept' }).click();
    await openTool(page, 'Singers and ranges');
    await expect(check.locator('.badge')).toHaveText(new RegExp(`^${promised![1] ?? promised![2]}$`, 'i'));
    await expect(check.getByRole('button', { name: 'Propose this change' })).toHaveCount(0);
  }

  // ---- My singers keeps Robin for other songs --------------------------------------------------
  await card.getByRole('button', { name: 'Save to My singers' }).click();
  await expect(panel.getByRole('heading', { name: 'My singers' })).toBeVisible();

  // ---- Piano roll and track details show the singer -------------------------------------------
  await songStep(page, 'Write');
  await page.getByRole('tab', { name: 'Piano Roll' }).click();
  await page.getByRole('combobox', { name: 'Track' }).selectOption({ label: 'Lead Vocal' });
  await expect(page.getByText('Singer: Robin')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/singer-piano-roll.png` });
  const head = page.getByTestId('track-header').filter({ hasText: 'Lead Vocal' });
  await page.getByRole('tab', { name: 'Arrangement' }).click();
  await expect(head).toContainText('Sung by Robin');
  await head.getByRole('button', { name: 'Lead Vocal options' }).click();
  await page.getByRole('menuitem', { name: 'Track details' }).click();
  const details = page.getByTestId('track-singer');
  await expect(details.getByRole('combobox', { name: 'Singer' })).not.toHaveValue('');
  await expect(details.getByTestId('range-check')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/singer-track-details.png` });

  expect(errors, errors.join('\n')).toEqual([]);
});
