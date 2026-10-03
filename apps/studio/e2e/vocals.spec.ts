import { expect, test, type Page } from '@playwright/test';
import { composeQuickSong } from './compose-helpers';
import { mkdirSync } from 'node:fs';

/**
 * Vocals mode (Phase 4), end to end and entirely on-device:
 * compose with a vocal → placeholder lyrics → align → render with the built-in singer (audio track)
 * → "Add vibrato here" on one phrase (only that phrase is re-sung and spliced) → regenerate only
 * the second chorus vocal → consent: conversion to an unauthorized voice is blocked, a consented
 * voice is added → record a take with the (fake) microphone.
 */

const SHOTS = '/tmp/claude-0';
mkdirSync(SHOTS, { recursive: true });

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  permissions: ['microphone'],
});
test.describe.configure({ timeout: 480_000 });

async function composeSong(page: Page) {
  await page.goto('/');
  await composeQuickSong(page, 'Alt-rock band', 60_000);
}

async function lastTaskSucceeded(page: Page, scope = page.getByTestId('vocals-mode')) {
  await expect(scope.getByTestId('vocal-task').last()).toHaveAttribute('data-status', 'succeeded', {
    timeout: 150_000,
  });
}

test('vocals: lyrics, alignment, singing render, phrase & section regeneration, consent, takes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await composeSong(page);

  // ---- Vocals mode + vocal modes (§33) ----------------------------------------------------
  await page.getByRole('button', { name: 'Vocals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vocals', exact: true })).toBeVisible();
  const modes = page.getByRole('radiogroup', { name: 'Vocal mode' });
  await expect(modes.getByRole('radio')).toHaveCount(6);
  await expect(modes.getByRole('radio', { name: /Vocal melody only/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.screenshot({ path: `${SHOTS}/vocals-overview.png` });

  // ---- Lyrics: placeholder lyrics, live syllable counts, alignment (§33-§35, §48) ----------
  await page.getByRole('tab', { name: 'Lyrics' }).click();
  await page.getByRole('button', { name: 'Write lyrics' }).click();
  await expect(page.getByTestId('lyrics-source')).toContainText('Placeholder lyrics', { timeout: 30_000 });
  const verse = page.getByLabel('Lyrics for Verse 1');
  await expect(verse).not.toHaveValue('');
  // Placeholder lines are fitted to the phrases: one syllable per note.
  const firstCount = page
    .getByTestId('lyric-section')
    .filter({ hasText: 'Verse 1' })
    .getByTestId('syllable-count')
    .first();
  await expect(firstCount).toContainText('✓');
  // Live syllable count while typing: shorten line 1 to two syllables.
  await verse.focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.type('Oh no');
  await expect(firstCount).toContainText('2/');
  await expect(firstCount).toContainText('syl');
  await expect(page.getByTestId('phoneme-preview').first()).toContainText('N OW');
  await page.keyboard.press('Control+Enter'); // commit → syllables re-attached (extra notes become melismas)
  await expect(firstCount).toContainText('you');
  await page.getByRole('button', { name: 'Align lyrics to melody' }).click();
  await expect(page.getByTestId('alignment-report')).toContainText('Syllables');
  // Fit the melody's rhythm to the lyrics (a proposal): the line's notes are merged to two.
  await page.getByRole('button', { name: 'Fit melody rhythm to lyrics' }).click();
  const fit = page
    .getByTestId('vocal-proposal')
    .filter({ hasText: 'Fit the vocal rhythm to the lyrics' })
    .first();
  await expect(fit).toBeVisible();
  await fit.getByRole('button', { name: 'Accept proposal' }).click();
  await expect(
    page.getByTestId('vocal-proposal').filter({ hasText: 'Fit the vocal rhythm to the lyrics' }),
  ).toHaveCount(0);
  await expect(firstCount).toContainText('2/2');
  await expect(page.getByTestId('lyric-validation')).toContainText('lyrics align with the vocal events');
  await page.screenshot({ path: `${SHOTS}/vocals-lyrics.png` });

  // ---- Render with the built-in singer (§34) → audio track -----------------------------------
  await page.getByRole('tab', { name: 'Render' }).click();
  await expect(page.getByTestId('no-render')).toBeVisible();
  await page.getByRole('button', { name: 'Render lead vocal' }).click();
  await lastTaskSucceeded(page);
  const current = page.getByTestId('current-render');
  await expect(current).toContainText('Lead Vocal (render)');
  await expect(current).toContainText('lead_vocal-v1.wav');
  await expect(current).toContainText('vocal.mid v');
  await expect(current).toContainText('lyrics.txt v');
  await expect(page.getByTestId('vocal-summary')).toContainText('lead_vocal-v1.wav');
  await expect(modes.getByRole('radio', { name: /Placeholder vocal/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.screenshot({ path: `${SHOTS}/vocals-render.png` });

  // ---- §35 expression support is shown for the chosen singer --------------------------------
  await page.getByRole('tab', { name: 'Expression' }).click();
  await expect(page.getByTestId('expression-support')).toContainText('Unsupported parameters are ignored');

  // ---- §37 "Add vibrato here." on one phrase → only that phrase is re-sung --------------------
  await page.getByRole('tab', { name: 'Regenerate' }).click();
  await page.getByTestId('vocal-phrase').nth(1).click();
  await page.getByRole('button', { name: 'Add vibrato here.' }).click();
  await expect(page.getByLabel('Vocal instruction')).toHaveValue('Add vibrato here.');
  await page.getByRole('button', { name: 'Propose vocal change' }).click();
  await expect(page.getByTestId('instruction-result')).toContainText('vibrato');
  const vibrato = page.getByTestId('regenerate-panel').getByTestId('vocal-proposal').first();
  await expect(vibrato).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/vocals-regenerate.png` });
  await vibrato.getByRole('button', { name: 'Accept and re-sing' }).click();
  await expect(page.getByTestId('vocal-summary')).toContainText('lead_vocal-v2.wav', { timeout: 150_000 });

  // ---- §37 "Regenerate only the second chorus vocal." ----------------------------------------
  await page.getByLabel('Vocal instruction').fill('Regenerate only the second chorus vocal.');
  await page.getByRole('button', { name: 'Propose vocal change' }).click();
  await expect(page.getByTestId('instruction-result')).toContainText('Chorus 2');
  const chorus = page.getByTestId('regenerate-panel').getByTestId('vocal-proposal').first();
  await expect(chorus).toContainText('Chorus 2');
  await chorus.getByRole('button', { name: 'Accept and re-sing' }).click();
  await expect(page.getByTestId('vocal-summary')).toContainText('lead_vocal-v3.wav', { timeout: 150_000 });
  await page.getByRole('tab', { name: 'Render' }).click();
  await expect(page.getByTestId('render-row').filter({ hasText: 'chorus-2-vocal-v' })).toHaveCount(1);
  await expect(page.getByTestId('current-render')).toContainText('In sync');
  await page.screenshot({ path: `${SHOTS}/vocals-render-history.png` });
  // Going back to the first render: it predates both edits, so they show as out of date.
  await page
    .getByTestId('render-row')
    .filter({ hasText: 'lead_vocal-v1.wav' })
    .getByRole('button', { name: 'Use' })
    .click();
  await expect(page.getByTestId('current-render')).toContainText('lead_vocal-v1.wav');
  await expect(page.getByTestId('stale-render')).toContainText('Chorus 2');
  await page
    .getByTestId('render-row')
    .filter({ hasText: 'lead_vocal-v3.wav' })
    .getByRole('button', { name: 'Use' })
    .click();
  await expect(page.getByTestId('current-render')).toContainText('In sync');

  // The render is an ordinary audio track in Mix & Master.
  await page.getByRole('button', { name: 'Mix & Master' }).click();
  await expect(page.locator('.mx-strip', { hasText: 'Lead Vocal (render)' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Vocals', exact: true }).click();

  // ---- §36 consent: conversion to an unauthorized voice is blocked ----------------------------
  await page.getByRole('tab', { name: 'Voices' }).click();
  await page.getByRole('button', { name: 'Add voice model' }).click();
  await page.getByLabel('Voice name').fill('Jamie demo');
  await page.getByLabel('Voice kind').selectOption('imported');
  await page.getByRole('button', { name: 'Save without authorization' }).click();
  await expect(page.getByTestId('voice-row').filter({ hasText: 'Jamie demo' })).toContainText(
    'Consent required',
  );

  await page.getByRole('tab', { name: 'Conversion' }).click();
  await expect(page.getByTestId('conversion-target')).toContainText('Jamie demo');
  await page.getByRole('button', { name: 'Render & convert' }).click();
  await expect(page.getByTestId('conversion-blocked')).toContainText('requires a consent attestation');
  await expect(page.getByTestId('conversion-panel').getByTestId('vocal-task')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/vocals-consent-blocked.png` });
  // Attest authorization for that voice right from the blocked state.
  await page.getByTestId('conversion-blocked').getByRole('button', { name: 'Attest authorization' }).click();
  await expect(page.getByLabel('Voice name')).toHaveValue('Jamie demo');
  await page.getByLabel('Rights holder').fill('Jamie Demo');
  await page.getByLabel('Authorization basis').selectOption('written-permission');
  await page.getByLabel('I confirm I am authorized to use this voice').check();
  await page.getByRole('button', { name: 'Save authorization' }).click();
  await expect(page.getByTestId('conversion-target')).toContainText('Authorized');

  // Add a consented voice.
  await page.getByRole('tab', { name: 'Voices' }).click();
  await page.getByRole('button', { name: 'Add voice model' }).click();
  await page.getByLabel('Voice name').fill('My voice');
  await page.getByLabel('Rights holder').fill('Alex Example');
  await page.getByLabel('Authorization basis').selectOption('own-voice');
  await page.getByLabel('Evidence').fill('Recorded myself for this project.');
  await expect(page.getByRole('button', { name: 'Save authorized voice' })).toBeDisabled();
  await page.getByLabel('I confirm I am authorized to use this voice').check();
  await page.screenshot({ path: `${SHOTS}/vocals-consent-modal.png` });
  await page.getByRole('button', { name: 'Save authorized voice' }).click();
  const mine = page.getByTestId('voice-row').filter({ hasText: 'My voice' });
  await expect(mine).toContainText('Authorized');
  await mine.getByRole('button', { name: 'Conversion target' }).click();
  await page.getByRole('tab', { name: 'Conversion' }).click();
  await expect(page.getByTestId('conversion-target')).toContainText('Authorized');
  await page.getByRole('button', { name: 'Render & convert' }).click();
  await expect(page.getByTestId('conversion-error')).toContainText(
    'No voice-conversion provider is configured',
  );
  await page.screenshot({ path: `${SHOTS}/vocals-voices.png` });

  // ---- Recorded vocal (§33): a take with the fake microphone ---------------------------------
  await page.getByRole('tab', { name: 'Record' }).click();
  await page.getByLabel('Count-in bars').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Record take' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.waitForTimeout(3500);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('vocal-take')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('vocal-take').first()).toContainText('active');
  await expect(modes.getByRole('radio', { name: /Recorded vocal/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: `${SHOTS}/vocals-takes.png` });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('vocals: per-section melody, phrase expression, voices, vocal-mode monitoring and take transcription', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await composeSong(page);
  await page.getByRole('button', { name: 'Vocals', exact: true }).click();
  const modes = page.getByRole('radiogroup', { name: 'Vocal mode' });

  // A render first, so later edits re-sing only what changed.
  await page.getByRole('tab', { name: 'Render' }).click();
  await page.getByRole('button', { name: 'Render lead vocal' }).click();
  await lastTaskSucceeded(page);
  await expect(page.getByTestId('vocal-summary')).toContainText('lead_vocal-v1.wav');

  // Vocal melody: regenerate one section → only that section is re-sung (instrumentation untouched).
  await page.getByRole('tab', { name: 'Melody' }).click();
  await expect(page.getByTestId('vocal-melody-strip')).toBeVisible();
  await page.getByRole('button', { name: 'Regenerate the vocal melody in Chorus 1' }).click();
  await expect(page.getByTestId('vocal-summary')).toContainText('lead_vocal-v2.wav', { timeout: 150_000 });
  await page.screenshot({ path: `${SHOTS}/vocals-melody.png` });

  // Phrase expression (§35) → set_expression on the phrase's notes → that phrase is re-sung.
  await page.getByRole('tab', { name: 'Expression' }).click();
  await page.getByTestId('vocal-phrase').first().click();
  await page.getByLabel('Phrase Onset').selectOption('scoop');
  await page.getByLabel('Phrase Release').selectOption('breathy');
  await page.getByRole('button', { name: /^Apply to \d+ notes?$/ }).click();
  await expect(page.getByTestId('vocal-summary')).toContainText('lead_vocal-v3.wav', { timeout: 150_000 });
  await page.screenshot({ path: `${SHOTS}/vocals-expression.png` });
  // Default expression changes every note → the whole render is out of date.
  await page.getByLabel('Default Release').selectOption('falling');
  await page.getByRole('tab', { name: 'Render' }).click();
  await expect(page.getByTestId('stale-render')).toBeVisible();

  // Another stock voice → the render says it must be rendered again.
  await page.getByRole('tab', { name: 'Voices' }).click();
  await page
    .getByTestId('voice-row')
    .filter({ hasText: 'Baritone — deep' })
    .getByRole('button', { name: 'Sing with this' })
    .click();
  await page.getByRole('tab', { name: 'Render' }).click();
  await expect(page.getByTestId('current-render')).toContainText('render again');

  // Vocal mode "No vocal": the render track is muted in the mixer.
  await modes.getByRole('radio', { name: /No vocal/ }).click();
  await expect(modes.getByRole('radio', { name: /No vocal/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Mix & Master' }).click();
  await expect(page.getByRole('button', { name: 'Mute Lead Vocal (render)' }).first()).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Vocals', exact: true }).click();
  await modes.getByRole('radio', { name: /AI singer/ }).click();
  await page.getByRole('button', { name: 'Mix & Master' }).click();
  await expect(page.getByRole('button', { name: 'Mute Lead Vocal (render)' }).first()).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Mute Lead Vocal', exact: true }).first()).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Vocals', exact: true }).click();

  // Recorded vocal: a take, then transcribe it back into the vocal MIDI (a proposal).
  await page.getByRole('tab', { name: 'Record' }).click();
  await expect(page.getByTestId('headphones-reminder')).toBeVisible();
  await page.getByRole('button', { name: 'Record take' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  const take = page.getByTestId('vocal-take').first();
  await expect(take).toContainText('active', { timeout: 30_000 });
  await take.getByRole('button', { name: 'Transcribe to vocal MIDI' }).click();
  await expect(page.getByTestId('recording-panel').getByTestId('vocal-task').last()).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 120_000 },
  );
  await page.screenshot({ path: `${SHOTS}/vocals-transcribe.png` });

  expect(errors, errors.join('\n')).toEqual([]);
});
