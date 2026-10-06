import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { composeQuickSong } from './compose-helpers';
import { attestUpload } from './rights';
import { openTool, songStep } from './nav';

/**
 * MIDI attached to an audio track, end to end and on-device: import a sung line as an audio
 * track → Make MIDI from it → switch between hearing the audio and the MIDI → edit in the piano
 * roll → tune the recording to the MIDI (the tuned render lands and plays).
 */

const SHOTS = '/tmp/claude-0';
mkdirSync(SHOTS, { recursive: true });

test.describe.configure({ timeout: 360_000 });

/** A sung-like mono line (harmonic voice, vibrato, ~20 cents sharp): A3 C4 D4 E4, 0.6 s each. */
function sungLineWav(sampleRate = 44100): Buffer {
  const notes = [57, 60, 62, 64];
  const noteSec = 0.6;
  const gapSec = 0.15;
  const seconds = notes.length * (noteSec + gapSec) + 0.5;
  const frames = Math.round(seconds * sampleRate);
  const x = new Float64Array(frames);
  const partials = [1, 0.6, 0.45, 0.3, 0.2];
  notes.forEach((p, k) => {
    const start = Math.round((0.2 + k * (noteSec + gapSec)) * sampleRate);
    const len = Math.round(noteSec * sampleRate);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const midi = p + 0.2 + 0.25 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.2);
      phase += (2 * Math.PI * 440 * Math.pow(2, (midi - 69) / 12)) / sampleRate;
      const env = Math.min(1, i / 400, (len - i) / 800);
      let v = 0;
      partials.forEach((a, h) => (v += a * Math.sin((h + 1) * phase)));
      x[start + i] += 0.18 * env * v;
    }
  });
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** WCAG 2.1 A/AA violations inside the given elements, in both themes. */
async function scan(page: Page, selectors: string[]): Promise<string[]> {
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

async function importSungLine(page: Page): Promise<void> {
  await openTool(page, 'Full console');
  await expect(page.getByRole('heading', { name: 'Mix & Master' })).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import stem/audio' }).click(),
  ]);
  await chooser.setFiles({ name: 'lead_vocal_take.wav', mimeType: 'audio/wav', buffer: sungLineWav() });
  await attestUpload(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox', { name: 'Stem group' })).toHaveValue('vocals');
  await dialog.getByRole('button', { name: 'Add audio track' }).click();
  await expect(page.getByRole('group', { name: 'lead vocal take channel strip' })).toBeVisible();
}

test('make MIDI from an audio track, switch audio ⇄ MIDI and tune the audio to it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await composeQuickSong(page, 'Alt-rock band', 90_000);
  await importSungLine(page);

  // ---- Write: the audio track's menu makes MIDI from it ---------------------------------------
  await songStep(page, 'Write');
  const head = page.getByTestId('track-header').filter({ hasText: 'lead vocal take' });
  await expect(head).toContainText('Audio · 1 clips');
  await head.getByRole('button', { name: 'lead vocal take options' }).click();
  await page.getByRole('menuitem', { name: /Make MIDI from audio/ }).click();
  const dialog = page.getByRole('dialog', { name: /Make MIDI from “lead vocal take”/ });
  await dialog.getByRole('combobox', { name: 'Recording content' }).selectOption('melody');
  await dialog.getByRole('combobox', { name: 'Provider' }).selectOption('internal');
  await dialog.getByTestId('make-midi-start').click();
  await expect(head).toContainText('4 notes', { timeout: 120_000 });

  // ---- The switch: hear the MIDI through an instrument, then the recording again ----------------
  const plays = head.getByRole('radiogroup', { name: 'lead vocal take plays' });
  await expect(plays.getByRole('radio', { name: 'Audio' })).toHaveAttribute('aria-checked', 'true');
  await plays.getByRole('radio', { name: 'MIDI' }).click();
  await expect(plays.getByRole('radio', { name: 'MIDI' })).toHaveAttribute('aria-checked', 'true');
  await expect(head).toContainText('4 notes · Synth Lead');
  await page.screenshot({ path: `${SHOTS}/audio-midi-arrangement.png` });
  await plays.getByRole('radio', { name: 'Audio' }).click();
  await expect(plays.getByRole('radio', { name: 'Audio' })).toHaveAttribute('aria-checked', 'true');
  await expect(head).not.toContainText('Synth Lead');

  // ---- Piano roll: the attached MIDI is editable; tune the recording to it --------------------
  await head.getByRole('button', { name: 'lead vocal take options' }).click();
  await page.getByRole('menuitem', { name: 'Edit MIDI' }).click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Track' })).toHaveValue(/.+/);
  const bar = page.getByTestId('audio-midi-bar');
  await expect(bar).toBeVisible();
  await bar.getByRole('switch').click();
  await expect(bar.getByText(/Tuned: 4 notes/)).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: `${SHOTS}/audio-midi-piano-roll.png` });

  // ---- Inspector: tuning settings re-render automatically --------------------------------------
  await bar.getByRole('button', { name: 'Tuning settings' }).click();
  const panel = page.getByTestId('audio-midi-panel');
  await expect(panel).toBeVisible();
  // An audio track's details offer its stem group, not an instrument it does not have.
  const stemGroup = page.getByRole('combobox', { name: 'Stem group' });
  await expect(stemGroup).toHaveValue('vocals');
  await expect(page.getByRole('combobox', { name: 'MIDI instrument' })).toHaveValue('synth-lead');
  await expect(
    page.locator('select').filter({ has: page.locator('option:checked', { hasText: 'Drum Kit' }) }),
  ).toHaveCount(0);
  await stemGroup.selectOption('others');
  await expect(stemGroup).toHaveValue('others');
  await stemGroup.selectOption('vocals');
  await expect(stemGroup).toHaveValue('vocals');
  await panel.getByRole('button', { name: 'Hard tune' }).click();
  await expect(panel.getByText(/Tuned: 4 notes/)).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: `${SHOTS}/audio-midi-inspector.png` });
  expect(await scan(page, ['[data-testid="audio-midi-panel"]', '[data-testid="audio-midi-bar"]'])).toEqual(
    [],
  );
  await page.getByRole('tab', { name: 'Arrangement' }).click();
  await expect(head).toContainText('4 notes · tuned');
  expect(await scan(page, ['[data-testid="track-header"]'])).toEqual([]);

  expect(errors, errors.join('\n')).toEqual([]);
});
