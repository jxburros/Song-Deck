import { expect, test, type Page } from '@playwright/test';
import { composeQuickSong } from './compose-helpers';
import { mkdirSync } from 'node:fs';

/**
 * Produce mode (Phase 3, spec §28-§31, §38, §39, §54, §60, §64), end to end and entirely on-device:
 * compose → guide render (guide_mix.wav + reference stems) → Strategy B with the built-in DSP
 * producer → two candidates (A/B) → instant A/B switching → select + use produced stems in the
 * mix → regenerate a bar range of a candidate (new version B2, everything else preserved).
 */

const SHOTS = '/tmp/claude-0';
mkdirSync(SHOTS, { recursive: true });

test.describe.configure({ timeout: 900_000 });

async function composeSong(page: Page) {
  await page.goto('/');
  await composeQuickSong(page, 'Alt-rock band', 60_000);
}

async function comparePosition(page: Page): Promise<number> {
  const text = (await page.getByTestId('compare-position').first().textContent()) ?? '';
  const m = /(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

test('guide render, A/B candidates, adopt stems and regenerate a region', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Long renders: surface the page's own errors and warnings in the test output.
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });

  await composeSong(page);

  // ---- Produce: guide render (spec §28) -----------------------------------------------------
  await page.getByRole('button', { name: 'Produce', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Produce', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Built-in instrument library/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // The other renderers are available: external DAW (per-stem MIDI export + import) and sample instruments.
  await page.getByRole('radio', { name: /External DAW rendering/ }).click();
  await expect(page.getByRole('button', { name: 'Export stem MIDI (.zip)' })).toBeVisible();
  await page.getByRole('radio', { name: /User sample instruments/ }).click();
  await expect(page.getByRole('table', { name: 'Sample instrument assignments' })).toBeVisible();
  await page.getByRole('radio', { name: /Built-in instrument library/ }).click();

  await page.getByRole('button', { name: 'Render guide' }).click();
  const guideAssets = page.getByTestId('guide-assets');
  await expect(guideAssets).toBeVisible({ timeout: 300_000 });
  for (const f of [
    'guide_mix.wav',
    'drums_reference.wav',
    'bass_reference.wav',
    'guitar_reference.wav',
    'keys_reference.wav',
    'strings_reference.wav',
    'vocal_melody_reference.wav',
  ]) {
    await expect(guideAssets.getByText(f, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('up to date', { exact: false }).first()).toBeVisible();
  // Listen to each reference: switch sources while playing.
  const guideDeck = page.getByTestId('guide-deck');
  await expect(guideDeck.getByRole('radio', { name: 'Drums', exact: true })).toBeEnabled({ timeout: 60_000 });
  await guideDeck.getByRole('button', { name: 'Play comparison' }).click();
  await guideDeck.getByRole('radio', { name: 'Drums', exact: true }).click();
  await expect(guideDeck.getByRole('radio', { name: 'Drums', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await guideDeck.getByRole('radio', { name: 'Bass', exact: true }).click();
  await guideDeck.getByRole('button', { name: 'Pause comparison' }).click();
  await page.screenshot({ path: `${SHOTS}/produce-guide.png`, fullPage: true });

  // ---- Production: Strategy B with the on-device producer (spec §29, §30, §38, §60) ----------
  await page.getByRole('tab', { name: /Production/ }).click();
  await page.getByRole('radio', { name: /Strategy B — Stem Production/ }).click();
  await expect(page.getByRole('radio', { name: /Strategy B — Stem Production/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('combobox', { name: 'Provider' }).first().selectOption('internal');
  const provider = page.getByTestId('production-provider');
  await expect(provider).toContainText('Built-in DSP producer');
  await expect(provider).toContainText('STEM_CONDITIONING');
  await expect(provider).toContainText('INPAINTING');
  // Prompt generated from the song + editable instructions.
  await expect(page.getByTestId('final-prompt')).toContainText('BPM');
  await page
    .getByRole('textbox', { name: 'Production instructions' })
    .fill('tight punchy drums, wide guitars');
  await page.getByRole('textbox', { name: 'Negative prompt' }).click();
  await expect(page.getByTestId('final-prompt')).toContainText('tight punchy drums');
  // Estimate + duration + hardware before generating.
  const estimate = page.getByTestId('production-estimate');
  await expect(estimate).toContainText('Estimated generation');
  await expect(estimate).toContainText('free');
  await expect(estimate).toContainText('VRAM requirement');
  await expect(estimate).toContainText('Excellent');
  await page.screenshot({ path: `${SHOTS}/produce-production.png`, fullPage: true });

  await page.getByLabel('Number of candidates').fill('2');
  await page.getByTestId('generate-candidates').click();
  await expect(page.getByTestId('produce-task').first()).toBeVisible({ timeout: 30_000 });

  // ---- Candidates: A/B comparison (spec §54) -------------------------------------------------
  await page.getByRole('tab', { name: /Candidates/ }).click();
  await expect(page.getByTestId('candidate-A')).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId('candidate-B')).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId('candidate-A')).toContainText('Stem Production');
  await expect(page.getByTestId('candidate-A')).toContainText('Same composition');

  const deck = page.getByTestId('candidate-deck');
  const radioA = deck.getByRole('radio', { name: 'A', exact: true });
  const radioB = deck.getByRole('radio', { name: 'B', exact: true });
  await expect(radioB).toBeEnabled({ timeout: 120_000 });
  await deck.getByRole('button', { name: 'Play comparison' }).click();
  await radioA.click();
  await expect(radioA).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(700);
  const beforeSwitch = await comparePosition(page);
  await radioB.click();
  await expect(radioB).toHaveAttribute('aria-checked', 'true');
  await expect(radioA).toHaveAttribute('aria-checked', 'false');
  await page.waitForTimeout(500);
  // Same playback position keeps running across the switch.
  expect(await comparePosition(page)).toBeGreaterThanOrEqual(beforeSwitch);
  await page.keyboard.press('2'); // keys switch sources too (1 = guide, 2 = A, 3 = B)
  await expect(radioA).toHaveAttribute('aria-checked', 'true');
  await deck.getByRole('button', { name: 'Pause comparison' }).click();

  // Rate, annotate, select B and adopt its stems.
  const cardB = page.getByTestId('candidate-B');
  await cardB.getByRole('radio', { name: '4 stars' }).click();
  await cardB.getByLabel('Notes for candidate B').fill('punchier chorus');
  await cardB.getByLabel('Notes for candidate B').press('Enter');
  await cardB.getByRole('button', { name: 'Select B' }).click();
  await expect(cardB).toContainText('Selected');
  await cardB.getByRole('button', { name: 'Use produced stems in the mix' }).click();
  await expect(cardB).toContainText('In the mix');
  await cardB.getByRole('button', { name: 'Provenance' }).click();
  await expect(cardB.getByRole('table', { name: 'Stems of candidate B' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/produce-candidates.png`, fullPage: true });

  // The produced stems are ordinary audio tracks in Mix & Master.
  await page.getByRole('button', { name: 'Mix & Master', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mix & Master' })).toBeVisible();
  await expect(page.getByText('Bass · B').first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/produce-mix.png` });

  // ---- Selective regeneration (spec §39) -----------------------------------------------------
  await page.getByRole('button', { name: 'Produce', exact: true }).click();
  await page.getByRole('tab', { name: /Regenerate region/ }).click();
  const which = page.getByLabel('Candidate to regenerate');
  const options = await which.locator('option').allTextContents();
  await which.selectOption({ label: options.find((o) => o.startsWith('B — '))! });
  await page.getByLabel('From bar').fill('3');
  await page.getByLabel('To bar').fill('4');
  await expect(page.getByTestId('region-method')).toContainText('Re-produce the region');
  await page.screenshot({ path: `${SHOTS}/produce-regenerate.png`, fullPage: true });
  await page.getByRole('button', { name: 'Regenerate bars 3–4' }).click();
  await page.getByRole('tab', { name: /Candidates/ }).click();
  await expect(page.getByTestId('candidate-B2')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('candidate-B2')).toContainText('bars 3–4 regenerated');
  await page.screenshot({ path: `${SHOTS}/produce-candidates-b2.png`, fullPage: true });

  expect(errors, errors.join('\n')).toEqual([]);
});
