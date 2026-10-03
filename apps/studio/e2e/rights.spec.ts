import { expect, test, type Page } from '@playwright/test';
import { attestUpload, withRiffInfo } from './rights';

/**
 * Upload rights attestations (docs/RIGHTS.md), on-device only:
 *  - a WAV carrying a RIFF ICOP copyright chunk shows the warning in Transcribe and Rebuild,
 *  - the upload cannot proceed without an attestation (Cancel abandons it),
 *  - the attestation appears in the Inspector's rights panel and the Export notice,
 *  - re-uploading the same file pre-fills the dialog (one click).
 */

function wav(channels: Float32Array[], sampleRate: number): Buffer {
  const frames = channels[0].length;
  const nch = channels.length;
  const data = Buffer.alloc(frames * nch * 2);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nch; c++)
      data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), (i * nch + c) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(nch, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * nch * 2, 28);
  h.writeUInt16LE(nch * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A sung-like melody, one note per beat at 120 BPM, tagged as a commercial release. */
function taggedMelody(): Buffer {
  const sr = 22050;
  const pitches = [60, 62, 64, 65, 67, 65, 64, 62];
  const x = new Float32Array(Math.round((0.25 + pitches.length * 0.5 + 0.5) * sr));
  let phase = 0;
  pitches.forEach((p, i) => {
    const start = Math.round((0.25 + i * 0.5) * sr);
    const len = Math.round(0.45 * sr);
    for (let j = 0; j < len; j++) {
      const env = Math.min(1, j / sr / 0.02) * Math.min(1, (len - j) / sr / 0.04);
      phase += (2 * Math.PI * hz(p)) / sr;
      x[start + j] = 0.5 * env * (Math.sin(phase) + 0.25 * Math.sin(2 * phase));
    }
  });
  return withRiffInfo(wav([x], sr), [
    ['INAM', 'Night Drive'],
    ['IART', 'The Examples'],
    ['ICOP', 'Copyright 2020 Example Records'],
  ]);
}

/** ~4 s of drums + bass + chords (stereo), tagged with a copyright notice. */
function taggedMix(): Buffer {
  const sr = 22050;
  const beat = 0.5;
  const n = Math.round(4.5 * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let b = 0; b < 8; b++) {
    const s0 = Math.round(b * beat * sr);
    for (let j = 0; j < 0.12 * sr && s0 + j < n; j++) {
      const t = j / sr;
      const kick =
        b % 2 === 0
          ? Math.sin(2 * Math.PI * (60 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 18) * 0.8
          : rnd() * Math.exp(-t * 25) * 0.4;
      L[s0 + j] += kick;
      R[s0 + j] += kick;
    }
    const root = [45, 45, 41, 43][Math.floor(b / 2) % 4];
    for (let j = 0; j < beat * sr && s0 + j < n; j++) {
      const t = j / sr;
      const bass = 0.3 * Math.sin(2 * Math.PI * hz(root) * t) * Math.exp(-t * 2);
      const chord = 0.08 * [0, 4, 7].reduce((a, iv) => a + Math.sin(2 * Math.PI * hz(root + 24 + iv) * t), 0);
      L[s0 + j] += bass + chord;
      R[s0 + j] += bass + chord * 0.8;
    }
  }
  return withRiffInfo(wav([L, R], sr), [['ICOP', '(P) 2019 Some Label']]);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/claude-0';

const modeTab = (page: Page, label: string) =>
  page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: new RegExp(`^${label}`) });

async function openInspector(page: Page) {
  await page.locator('.right-tabs .tab', { hasText: 'Inspector' }).click();
  await expect(page.getByTestId('rights-attestations')).toBeVisible();
}

test('Transcribe: a copyright-tagged upload warns, needs an attestation and is remembered', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const file = { name: 'tagged-melody.wav', mimeType: 'audio/wav', buffer: taggedMelody() };
  await page.goto('/');
  await modeTab(page, 'Transcribe').click();
  await page.getByRole('radio', { name: 'Singing' }).click();
  await page.getByRole('tab', { name: 'Upload' }).click();
  const input = page.getByTestId('upload-drop').locator('input[type=file]');

  // The warning lists what was found; nothing proceeds without a basis; Cancel abandons the upload.
  await input.setInputFiles(file);
  const dialog = page.getByTestId('attestation-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('attestation-warning')).toContainText('“Copyright 2020 Example Records”');
  await expect(dialog.getByTestId('attestation-warning')).toContainText('commercial release');
  await expect(page.getByTestId('attest-confirm')).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/e2e-attestation-dialog.png` });
  await dialog.getByRole('textbox', { name: 'Attested by' }).fill('');
  await dialog.getByRole('radio', { name: 'Public domain or open licence' }).check();
  await expect(page.getByTestId('attest-confirm')).toBeDisabled(); // needs a licence name and a person
  await page.getByRole('button', { name: 'Cancel upload' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('capture-summary')).toHaveCount(0);

  // Attest as personal study → the transcription runs.
  await input.setInputFiles(file);
  await attestUpload(page, {
    basis: 'Personal study only, not for release',
    attestedBy: 'E2E Tester',
    expectWarning: 'Copyright 2020 Example Records',
  });
  await expect(page.getByTestId('capture-summary')).toBeVisible();
  await expect(page.getByTestId('transcription-summary')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('new-project-from-idea').click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();

  // The attestation is stored with the project and shown in the Inspector's rights panel.
  await openInspector(page);
  const card = page.getByTestId('rights-attestation').filter({ hasText: 'tagged-melody.wav' });
  await expect(card).toContainText('personal study only');
  await expect(card).toContainText('Attested by E2E Tester');
  await expect(card).toContainText('Copyright 2020 Example Records');
  await page.screenshot({ path: `${SHOTS}/e2e-attestation-inspector.png` });

  // Export reminds about it.
  await modeTab(page, 'Export').click();
  await expect(page.getByTestId('export-rights-notice')).toContainText('tagged-melody.wav');

  // Re-uploading the same file pre-fills the answer: one click.
  await modeTab(page, 'Transcribe').click();
  await page.getByRole('tab', { name: 'Upload' }).click();
  await page
    .getByTestId('upload-drop')
    .locator('input[type=file]')
    .setInputFiles({ ...file, name: 'same-file-renamed.wav' });
  await expect(page.getByTestId('attestation-prefilled')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Personal study only, not for release' })).toBeChecked();
  await expect(dialog.getByRole('textbox', { name: 'Attested by' })).toHaveValue('E2E Tester');
  await page.getByTestId('attest-confirm').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('capture-summary')).toContainText('same-file-renamed');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Rebuild: a copyright-tagged upload warns and its attestation travels into the project', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await modeTab(page, 'Rebuild').click();
  await page
    .getByTestId('rebuild-drop')
    .locator('input[type=file]')
    .setInputFiles({ name: 'tagged-mix.wav', mimeType: 'audio/wav', buffer: taggedMix() });
  await expect(page.getByTestId('rebuild-source')).toHaveCount(0); // not used before the attestation
  await attestUpload(page, {
    basis: 'I have a licence or written permission',
    licence: 'Sync licence #42',
    expectWarning: '(P) 2019 Some Label',
  });
  await expect(page.getByTestId('rebuild-source')).toBeVisible();
  await page.getByLabel('Project title').fill('E2E Rights Rebuild');
  await page.getByTestId('start-rebuild').click();
  await expect(page.getByTestId('rebuild-summary')).toBeVisible({ timeout: 180_000 });
  await page.getByTestId('open-rebuild-project').click();
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout: 120_000 });
  await openInspector(page);
  const card = page.getByTestId('rights-attestation').filter({ hasText: 'tagged-mix.wav' });
  await expect(card).toContainText('licensed / permission');
  await expect(card).toContainText('Licence: Sync licence #42');
  await expect(card).toContainText('(P) 2019 Some Label');
  expect(errors, errors.join('\n')).toEqual([]);
});
