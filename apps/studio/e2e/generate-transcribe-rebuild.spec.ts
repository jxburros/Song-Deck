import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestUpload } from './rights';

/**
 * Generate MIDI / Transcribe / Rebuild (spec §25-§27), entirely on-device:
 *  - generate two alternatives from a prompt (notation + audio preview) and export .mid
 *  - transcribe an uploaded sine-melody WAV (synthesized here) and start a project from it
 *  - tap a rhythm with the keyboard and convert it to MIDI
 *  - record from a (fake) microphone, with Chromium's fake media devices
 *  - rebuild a short synthesized multi-instrument mix and open it as a project (with stems)
 */

const FIXTURES = join(tmpdir(), 'songdeck-e2e-fixtures');
mkdirSync(FIXTURES, { recursive: true });

function wav(channels: Float32Array[], sampleRate: number): Buffer {
  const frames = channels[0].length;
  const nch = channels.length;
  const data = Buffer.alloc(frames * nch * 2);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      data.writeInt16LE(Math.round(v * 32767), (i * nch + c) * 2);
    }
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

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A sung-like sine melody (C major scale fragment) at 120 BPM, one note per beat. */
function melodyFixture(): string {
  const sr = 22050;
  const beat = 0.5;
  const pitches = [60, 62, 64, 65, 67, 69, 67, 64, 62, 60];
  const lead = 0.25;
  const total = lead + pitches.length * beat + 0.5;
  const x = new Float32Array(Math.round(total * sr));
  let phase = 0;
  pitches.forEach((p, i) => {
    const start = Math.round((lead + i * beat) * sr);
    const len = Math.round(beat * 0.9 * sr);
    for (let j = 0; j < len; j++) {
      const t = j / sr;
      const env = Math.min(1, t / 0.02) * Math.min(1, (len - j) / sr / 0.04);
      const vib = 1 + 0.003 * Math.sin(2 * Math.PI * 5.5 * t);
      phase += (2 * Math.PI * hz(p) * vib) / sr;
      x[start + j] = 0.5 * env * (Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
    }
  });
  const file = join(FIXTURES, 'sine-melody.wav');
  writeFileSync(file, wav([x], sr));
  return file;
}

/** ~8 s mix at 120 BPM: kick + snare + hats, a bass line, sustained chords and a lead melody (stereo). */
function mixFixture(): string {
  const sr = 22050;
  const bpm = 120;
  const beat = 60 / bpm;
  const bars = 4;
  const total = bars * 4 * beat + 0.5;
  const n = Math.round(total * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const add = (t0: number, len: number, fn: (t: number) => number, panL = 0.5, panR = 0.5) => {
    const s0 = Math.round(t0 * sr);
    const ln = Math.round(len * sr);
    for (let j = 0; j < ln && s0 + j < n; j++) {
      const v = fn(j / sr);
      L[s0 + j] += v * panL;
      R[s0 + j] += v * panR;
    }
  };
  const chords = [
    [57, 60, 64],
    [53, 57, 60],
    [48, 52, 55],
    [55, 59, 62],
  ]; // Am F C G
  const bass = [45, 41, 36, 43];
  const melody = [76, 74, 72, 74, 72, 69, 72, 71, 67, 69, 71, 72, 74, 72, 71, 69];
  for (let b = 0; b < bars; b++) {
    const bt = b * 4 * beat;
    for (let k = 0; k < 4; k++) {
      const t = bt + k * beat;
      // kick on 1 and 3, snare on 2 and 4, closed hats on eighths
      if (k % 2 === 0)
        add(
          t,
          0.25,
          (s) => 0.9 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-s * 30)) * s) * Math.exp(-s * 14),
        );
      else
        add(
          t,
          0.18,
          (s) =>
            0.45 * rnd() * Math.exp(-s * 22) + 0.25 * Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s * 25),
        );
      for (const h of [0, 0.5]) add(t + h * beat, 0.05, (s) => 0.12 * rnd() * Math.exp(-s * 90), 0.35, 0.65);
      // bass on every beat
      const bf = hz(bass[b]);
      add(
        t,
        beat * 0.85,
        (s) =>
          0.35 *
          Math.min(1, s / 0.01) *
          Math.exp(-s * 2) *
          (Math.sin(2 * Math.PI * bf * s) + 0.3 * Math.sin(4 * Math.PI * bf * s)),
      );
      // lead melody, one note per beat
      const mf = hz(melody[b * 4 + k]);
      add(
        t,
        beat * 0.9,
        (s) =>
          0.22 *
          Math.min(1, s / 0.02) *
          Math.min(1, (beat * 0.9 - s) / 0.05) *
          Math.sin(2 * Math.PI * mf * s * (1 + 0.004 * Math.sin(2 * Math.PI * 5 * s))),
        0.5,
        0.5,
      );
    }
    // sustained chord pad, slightly wide
    for (const p of chords[b]) {
      const f = hz(p);
      add(
        bt,
        4 * beat,
        (s) =>
          0.07 *
          Math.min(1, s / 0.05) *
          (Math.sin(2 * Math.PI * f * s) + 0.5 * Math.sin(2 * Math.PI * 2 * f * s)),
        0.65,
        0.35,
      );
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  for (let i = 0; i < n; i++) {
    L[i] *= 0.9 / peak;
    R[i] *= 0.9 / peak;
  }
  const file = join(FIXTURES, 'mix-120bpm.wav');
  writeFileSync(file, wav([L, R], sr));
  return file;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Mode tabs in the top bar (matched by label prefix: "Generate" / "Generate MIDI"…). */
function modeTab(page: Page, label: 'Generate' | 'Transcribe' | 'Rebuild') {
  return page
    .getByRole('navigation', { name: 'Modes' })
    .getByRole('button', { name: new RegExp(`^${label}`) });
}

async function openMode(page: Page, label: 'Generate' | 'Transcribe' | 'Rebuild') {
  await page.goto('/');
  await expect(page.getByText('AI that gives you the song back.')).toBeVisible();
  await modeTab(page, label).click();
}

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/claude-0';

// Chromium fake media devices: the "microphone" plays the sine-melody fixture (recording test).
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${melodyFixture()}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

test('generate two alternatives from a prompt, preview them and export .mid', async ({ page }) => {
  const errors = collectErrors(page);
  await openMode(page, 'Generate');
  await expect(page.getByTestId('generate-mode')).toBeVisible();
  await page.getByLabel('Asset prompt').fill('Create a melancholy 8-bar cello melody in D minor.');
  await page.getByTestId('generate-run').click();
  await expect(page.getByTestId('asset-request-form')).toBeVisible();
  // The prompt was understood: instrument, key and bars.
  await expect(page.getByLabel('Instrument')).toHaveValue('cello');
  await expect(page.getByLabel('Key mode')).toHaveValue('minor');
  await expect(page.getByLabel('Bars')).toHaveValue('8');
  await page.getByLabel('Alternatives').fill('2');
  await page.getByRole('button', { name: /Generate 2 alternatives/ }).click();
  const cards = page.getByTestId('alternative-card');
  await expect(cards).toHaveCount(2);
  // Notation preview (SVG staff with notes) on every card.
  await expect(cards.nth(0).getByTestId('notation')).toBeVisible();
  await expect(cards.nth(1).getByTestId('notation')).toBeVisible();
  expect(await cards.nth(0).locator('[data-testid="notation"] path').count()).toBeGreaterThan(10);
  // Audio preview renders and plays.
  await cards.nth(0).getByRole('button', { name: 'Play A' }).click();
  await expect(cards.nth(0).getByRole('button', { name: 'Stop A' })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/e2e-generate.png`, fullPage: false });
  await cards.nth(0).getByRole('button', { name: 'Stop A' }).click();
  // Export .mid
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    cards.nth(1).getByRole('button', { name: 'Export B as MIDI' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.mid$/);
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('MThd');
  // Open as a project → piano roll.
  await cards.nth(0).getByRole('button', { name: 'Open A as new project' }).click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('generate drum pattern shows a step grid and inserts into a project as a proposal', async ({ page }) => {
  const errors = collectErrors(page);
  await openMode(page, 'Generate');
  await page.getByLabel('Asset prompt').fill('Make a pop-punk drum pattern at 176 BPM.');
  await page.getByTestId('generate-run').click();
  const cards = page.getByTestId('alternative-card');
  await expect(cards.first()).toBeVisible();
  await expect(cards.first().getByTestId('drum-grid')).toBeVisible();
  await expect(page.getByLabel('Tempo')).toHaveValue('176');
  // No project yet → "Insert into new project" creates one.
  await cards.first().getByRole('button', { name: 'Insert A' }).click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();
  // Back in Generate, insert alternative B into the now-open project as a new track (proposal).
  await modeTab(page, 'Generate').click();
  await page.getByLabel('Asset prompt').fill('Make a pop-punk drum pattern at 176 BPM.');
  await page.getByTestId('generate-run').click();
  await expect(cards.first()).toBeVisible();
  await cards.first().getByRole('button', { name: 'Insert A' }).click();
  await expect(page.getByTestId('insert-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Create proposal' }).click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();
  await expect(page.locator('.right-tabs .tab', { hasText: 'Proposals' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).first().click();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('transcribe an uploaded WAV melody and start a project from the idea', async ({ page }) => {
  const errors = collectErrors(page);
  const file = melodyFixture();
  await openMode(page, 'Transcribe');
  await expect(page.getByTestId('transcribe-mode')).toBeVisible();
  await page.getByRole('radio', { name: 'Singing' }).click();
  await page.getByRole('tab', { name: 'Upload' }).click();
  await page.getByTestId('upload-drop').locator('input[type=file]').setInputFiles(file);
  await attestUpload(page);
  await expect(page.getByTestId('capture-summary')).toBeVisible();
  const summary = page.getByTestId('transcription-summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(summary).toContainText('BPM');
  await expect(summary).toContainText(/notes/);
  const noteCount = parseInt((await summary.textContent())!.match(/(\d+) notes/)![1], 10);
  expect(noteCount).toBeGreaterThanOrEqual(6);
  await expect(page.getByTestId('transcription-strip')).toBeVisible();
  await expect(page.getByTestId('confidence-legend')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/e2e-transcribe.png`, fullPage: false });
  // Notation view of the transcription
  await page.getByRole('tab', { name: 'Notation' }).click();
  await expect(page.getByTestId('transcription-result').getByTestId('notation')).toBeVisible();
  // Export MIDI
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-transcription').click(),
  ]);
  expect(
    readFileSync(await download.path())
      .subarray(0, 4)
      .toString('latin1'),
  ).toBe('MThd');
  // New project from this idea → workbench, recording stored with provenance + analysis.
  await page.getByTestId('new-project-from-idea').click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();
  // The project is saved asynchronously after the workbench opens: wait for it to land.
  await expect
    .poll(async () => {
      const meta = await page.evaluate(async () => {
        const req = indexedDB.open('songdeck');
        const db: IDBDatabase = await new Promise((res, rej) => {
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const all: {
          meta: { assets: { kind: string }[]; provenance: unknown[] };
          analysis: { kind: string }[];
        }[] = await new Promise((res) => {
          const r = db.transaction('projects').objectStore('projects').getAll();
          r.onsuccess = () => res(r.result);
        });
        return all.map((p) => ({
          assets: p.meta.assets.map((a) => a.kind),
          provenance: p.meta.provenance.length,
          analysis: p.analysis.map((a) => a.kind),
        }));
      });
      return meta.some(
        (p) => p.assets.includes('recording') && p.provenance > 0 && p.analysis.includes('transcription'),
      );
    })
    .toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('tap a rhythm with the keyboard and convert it to MIDI', async ({ page }) => {
  const errors = collectErrors(page);
  await openMode(page, 'Transcribe');
  await page.getByRole('tab', { name: 'Tap rhythm' }).click();
  await expect(page.getByTestId('tap-pad')).toBeVisible();
  await page.getByRole('heading', { name: 'Transcribe' }).click(); // focus the page, not an input
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 2 ? 'Space' : 't');
    await page.waitForTimeout(250);
  }
  await expect(page.getByTestId('tap-bpm')).not.toHaveText('—');
  // Space must not have started the transport (no project → nothing to play, but no error either).
  await page.getByRole('button', { name: 'Convert taps to MIDI' }).click();
  const summary = page.getByTestId('transcription-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/8 hits|7 hits|6 hits/);
  await expect(page.getByTestId('transcription-strip')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test.describe('microphone capture', () => {
  test('record from the microphone with a count-in and transcribe the take', async ({ page }) => {
    const errors = collectErrors(page);
    await openMode(page, 'Transcribe');
    await page.getByRole('radio', { name: 'Humming' }).click();
    await page.getByLabel('Tempo mode').selectOption('manual');
    await page.getByLabel('Manual BPM').fill('180');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByTestId('count-in')).toBeVisible();
    await expect(page.getByText(/Recording \d/)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(3500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByTestId('capture-summary')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('transcription-summary')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('transcription-summary')).toContainText('180 BPM');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test('rebuild a synthesized mix and open it as a project with stems', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  const file = mixFixture();
  await openMode(page, 'Rebuild');
  await expect(page.getByTestId('rebuild-mode')).toBeVisible();
  await expect(page.getByTestId('rebuild-honesty')).toContainText('lower confidence than neural separators');
  await page.getByTestId('rebuild-drop').locator('input[type=file]').setInputFiles(file);
  await attestUpload(page);
  await expect(page.getByTestId('rebuild-source')).toBeVisible();
  await page.getByLabel('Project title').fill('E2E Rebuild');
  await page.getByTestId('start-rebuild').click();
  const pipeline = page.getByTestId('rebuild-pipeline');
  await expect(pipeline.locator('li')).toHaveCount(10);
  await expect(page.getByTestId('rebuild-summary')).toBeVisible({ timeout: 180_000 });
  for (const stage of [
    'separation',
    'tempo',
    'key',
    'chords',
    'transcription',
    'classification',
    'midi',
    'structure',
  ]) {
    await expect(pipeline.locator(`li[data-stage="${stage}"]`)).toHaveAttribute(
      'data-status',
      /done|skipped/,
    );
  }
  await expect(page.getByTestId('rebuild-tracks').locator('tbody tr')).not.toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/e2e-rebuild.png`, fullPage: false });
  await page.getByTestId('open-rebuild-project').click();
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout: 120_000 });
  const rows = page.locator('.wb-left .track-row');
  expect(await rows.count()).toBeGreaterThan(4);
  await expect(page.locator('.wb-left .track-row', { hasText: 'stem' }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/e2e-rebuild-project.png`, fullPage: false });
  expect(errors, errors.join('\n')).toEqual([]);
});
