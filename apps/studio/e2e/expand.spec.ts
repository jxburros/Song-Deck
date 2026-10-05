import { encodeWav, renderSong } from '../../../packages/audio/src';
import { midiToSong } from '../../../packages/core/src';
import { attestUpload } from './rights';
import { test, expect, type Page } from '@playwright/test';
import { createEmptySong, defaultChannelStrip, songToMidi } from '../../../packages/core/src';
import { openComposer } from './compose-helpers';
import { stepButton } from './nav';

function clip() {
  const song = createEmptySong({ id: 'expand-source', title: 'Short hook', seed: 1, bpm: 120 });
  song.sections = [{ id: 'clip', name: 'Clip', kind: 'custom', bars: 2, energy: 60 }];
  song.tracks = [
    {
      id: 'piano',
      name: 'Piano',
      kind: 'midi',
      role: 'keys',
      instrumentId: 'piano',
      color: '#5599ee',
      stemGroup: 'keys',
      constraints: {},
      clips: [],
      notes: [60, 64, 67, 64, 62, 65, 69, 65].map((pitch, i) => ({
        id: `note-${i}`,
        tick: i * 480,
        pitch,
        duration: 360,
        velocity: 90,
      })),
    },
  ];
  song.mixer.channels.piano = defaultChannelStrip();
  return Buffer.from(songToMidi(song));
}

/** Develop a short clip is offered on Start a song's Material step. */
async function openExpand(page: Page) {
  await openComposer(page);
  await page.getByRole('button', { name: 'Develop a short clip', exact: true }).click();
  await expect(page.getByTestId('expand-mode')).toBeVisible();
}

test('expand an imported hook, vary it, download MIDI and open a new project', async ({ page }) => {
  await page.goto('/');
  await openExpand(page);
  const view = page.getByTestId('expand-mode');
  await view
    .locator('input[type=file]')
    .setInputFiles({ name: 'hook.mid', mimeType: 'audio/midi', buffer: clip() });
  await expect(view.getByText('hook.mid', { exact: true })).toBeVisible();
  await view.getByLabel('Source part 1', { exact: true }).selectOption('hook');
  await view.getByLabel('Section 2 bars', { exact: true }).fill('4');
  await view.getByLabel('Section 3 bars', { exact: true }).fill('4');
  await view.getByLabel('Expansion seed').fill('23');
  await view.getByRole('button', { name: 'Expand MIDI', exact: true }).click();
  const result = page.getByTestId('expansion-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Hook · 2 bars · kept');
  await expect(view.getByRole('alert')).toHaveCount(0);
  await result.getByRole('button', { name: 'Preview expansion' }).click();
  await expect(result.getByRole('button', { name: 'Stop preview' })).toBeVisible();
  await result.getByRole('button', { name: 'Stop preview' }).click();
  const downloaded = page.waitForEvent('download');
  await result.getByRole('button', { name: 'Download MIDI' }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/expanded.mid$/);
  await view.getByRole('button', { name: 'New variation', exact: true }).click();
  await expect(result).toBeVisible();
  await expect(view.getByLabel('Expansion seed')).not.toHaveValue('23');
  await result.getByRole('button', { name: 'Open as new project' }).click();
  await expect(stepButton(page, 'Write')).toHaveAttribute('aria-current', 'page');
  await openExpand(page);
  await expect(page.getByTestId('expansion-result')).toBeVisible();
});

test('source labels and arrangement remain usable on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openExpand(page);
  const view = page.getByTestId('expand-mode');
  await view
    .locator('input[type=file]')
    .setInputFiles({ name: 'hook.mid', mimeType: 'audio/midi', buffer: clip() });
  await view.getByRole('button', { name: 'Add source label' }).click();
  await expect(view.getByLabel('Source part 2', { exact: true })).toBeVisible();
  await view.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect(view.getByLabel('Section 4 type', { exact: true })).toBeVisible();
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflows).toBe(false);
});

test('transcribes an audio clip locally and expands after the existing upload attestation', async ({
  page,
}) => {
  const audio = renderSong(midiToSong(clip()), { sampleRate: 22050 });
  const wav = Buffer.from(encodeWav(audio));
  await page.goto('/');
  await openExpand(page);
  const view = page.getByTestId('expand-mode');
  await view
    .locator('input[type=file]')
    .setInputFiles({ name: 'piano-hook.wav', mimeType: 'audio/wav', buffer: wav });
  await attestUpload(page);
  await expect(view.getByText('piano-hook.wav', { exact: true })).toBeVisible({ timeout: 60000 });
  await expect(view.getByText(/Audio transcription is approximate/)).toBeVisible();
  await view.getByRole('button', { name: 'Expand MIDI', exact: true }).click();
  await expect(page.getByTestId('expansion-result')).toBeVisible();
  await expect(view.getByRole('alert')).toHaveCount(0);
});
