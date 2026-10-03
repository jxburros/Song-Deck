import { expect, test, type Download, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { attestUpload } from './rights';

/**
 * Mix & Master and Export, end to end and entirely on-device:
 * compose → mixer fader → AI mix assistant proposal → accept → loudness analysis → mastering
 * (Master.wav asset) → A/B → exports (MIDI, WAV, MP3, stems, MusicXML, PDF, DAW, everything).
 */

const SHOTS = '/tmp/claude-0';
mkdirSync(SHOTS, { recursive: true });

test.describe.configure({ timeout: 420_000 });

async function composeSong(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compose a new song' }).click();
  await page
    .getByLabel('Song prompt')
    .fill('Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.');
  await page.getByRole('button', { name: 'Draft Song Blueprint' }).click();
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await page.getByRole('button', { name: 'Generate MIDI composition' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout: 90_000 });
}

async function download(page: Page, action: () => Promise<void>, timeout = 180_000): Promise<{ d: Download; bytes: Uint8Array }> {
  const pending = page.waitForEvent('download', { timeout });
  await action();
  const d = await pending;
  const path = await d.path();
  return { d, bytes: new Uint8Array(readFileSync(path!)) };
}

const ascii = (b: Uint8Array, n: number, off = 0) => String.fromCharCode(...b.slice(off, off + n));

test('mix, master and export a composed song', async ({ page }) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await composeSong(page);

  // ---- Mix & Master: console ------------------------------------------------------------
  await page.getByRole('button', { name: 'Mix & Master' }).click();
  await expect(page.getByRole('heading', { name: 'Mix & Master' })).toBeVisible();
  const strips = page.locator('.mx-strip');
  expect(await strips.count()).toBeGreaterThan(4);

  const fader = page.getByRole('slider', { name: /^Bass volume$/ }).first();
  await expect(fader).toBeVisible();
  const before = Number(await fader.getAttribute('aria-valuenow'));
  const box = (await fader.boundingBox())!;
  const thumb = fader.locator('.mx-fader-thumb');
  const tb = (await thumb.boundingBox())!;
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2 - box.height * 0.18, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => Number(await fader.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  // Keyboard nudge (+0.5 dB) commits after a short pause.
  const afterDrag = Number(await fader.getAttribute('aria-valuenow'));
  await fader.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => Number(await fader.getAttribute('aria-valuenow'))).toBeCloseTo(Math.min(12, afterDrag + 0.5), 1);

  // EQ insert toggle on a strip and the inspector curve.
  await expect(page.getByRole('img', { name: /EQ frequency response/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mix-console.png` });

  // ---- AI Mix Assistant ------------------------------------------------------------------
  await page.getByLabel('Mix instruction').fill('Make the vocal clearer.');
  await page.getByRole('button', { name: 'Propose mix change' }).click();
  const proposal = page.getByTestId('mix-proposal').first();
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(proposal.getByRole('table', { name: 'Proposed mixer changes' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mix-assistant.png` });
  await proposal.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByTestId('mix-proposal')).toHaveCount(0);

  // A second, compound request from the spec (automation in the last chorus + drier vocal).
  await page.getByLabel('Mix instruction').fill('Bring the violin forward in the last chorus and make the vocal slightly drier.');
  await page.getByRole('button', { name: 'Propose mix change' }).click();
  await expect(page.getByTestId('mix-proposal').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('mix-proposal').first().getByRole('button', { name: 'Accept' }).click();

  // ---- Automation --------------------------------------------------------------------------
  await page.getByRole('tab', { name: 'Automation' }).click();
  await expect(page.locator('.mx-automation')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mix-automation.png` });

  // ---- Mastering ---------------------------------------------------------------------------
  await page.getByRole('tab', { name: 'Mastering' }).click();
  await page.getByRole('radio', { name: /Streaming/ }).click();
  await page.getByRole('button', { name: 'Analyze mix' }).click();
  await expect(page.getByTestId('mix-integrated')).toHaveText(/−\d+\.\d/, { timeout: 180_000 });
  await page.getByRole('button', { name: 'Master', exact: true }).click();
  await expect(page.getByTestId('master-integrated')).toHaveText(/−1[34]\.\d/, { timeout: 240_000 });
  await expect(page.getByText('Master.wav').first()).toBeVisible();
  // A/B: switch sides while playing.
  await page.getByRole('button', { name: 'Play A/B' }).click();
  await page.getByRole('radio', { name: /^A Mix/ }).click();
  await page.getByRole('radio', { name: /^B Master/ }).click();
  await page.getByRole('button', { name: 'Pause A/B' }).click();
  await page.screenshot({ path: `${SHOTS}/mix-mastering.png` });

  // ---- Export ------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Export', exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/export.png`, fullPage: true });

  const mid = await download(page, () => page.getByRole('button', { name: 'Song.mid' }).click());
  expect(mid.d.suggestedFilename()).toMatch(/\.mid$/);
  expect(ascii(mid.bytes, 4)).toBe('MThd');

  const tracks = await download(page, () => page.getByRole('button', { name: 'Tracks .zip' }).click());
  const midiFiles = Object.keys(unzipSync(tracks.bytes));
  expect(midiFiles.length).toBeGreaterThan(4);
  expect(midiFiles.every((f) => f.endsWith('.mid'))).toBe(true);

  const wav = await download(page, () => page.getByRole('button', { name: 'Mix.wav' }).click());
  expect(wav.d.suggestedFilename()).toMatch(/ - Mix\.wav$/);
  expect(ascii(wav.bytes, 4)).toBe('RIFF');
  expect(ascii(wav.bytes, 4, 8)).toBe('WAVE');
  expect(wav.bytes.length).toBeGreaterThan(1_000_000);

  const masterWav = await download(page, () => page.getByRole('button', { name: 'Master.wav' }).first().click());
  expect(ascii(masterWav.bytes, 4)).toBe('RIFF');

  await page.getByRole('combobox', { name: 'Audio format' }).selectOption('mp3');
  const mp3 = await download(page, () => page.getByRole('button', { name: 'Mix.mp3' }).click());
  expect(mp3.d.suggestedFilename()).toMatch(/\.mp3$/);
  expect(mp3.bytes[0] === 0xff && (mp3.bytes[1] & 0xe0) === 0xe0).toBe(true);
  // AAC needs a WebCodecs AAC encoder; open-source Chromium has none, so it must explain itself.
  await page.getByRole('combobox', { name: 'Audio format' }).selectOption('aac');
  const aacOk = await page.evaluate(async () => {
    const Enc = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
    if (!Enc) return false;
    return !!(await Enc.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 256000 })).supported;
  });
  if (aacOk) {
    const aac = await download(page, () => page.getByRole('button', { name: 'Mix.aac' }).click());
    expect(aac.bytes[0]).toBe(0xff);
  } else {
    await expect(page.getByText(/AAC encoder|AudioEncoder/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mix.aac' })).toBeDisabled();
  }
  await page.getByRole('combobox', { name: 'Audio format' }).selectOption('wav');

  const stems = await download(page, () => page.getByRole('button', { name: 'Stems.zip' }).click());
  const stemFiles = Object.keys(unzipSync(stems.bytes));
  expect(stemFiles).toEqual(expect.arrayContaining(['Vocals.wav', 'Drums.wav', 'Bass.wav']));

  const xml = await download(page, () => page.getByRole('button', { name: '.musicxml' }).click());
  expect(new TextDecoder().decode(xml.bytes.slice(0, 200))).toContain('<?xml');

  const pdf = await download(page, () => page.getByRole('button', { name: '.pdf' }).click());
  expect(ascii(pdf.bytes, 5)).toBe('%PDF-');

  const chords = await download(page, () => page.getByRole('button', { name: 'Chords.txt' }).click());
  expect(chords.bytes.length).toBeGreaterThan(20);

  const project = await download(page, () => page.getByRole('button', { name: '.songproject' }).click());
  expect(ascii(project.bytes, 2)).toBe('PK');

  const reaper = await download(page, () => page.getByRole('button', { name: 'Reaper .zip' }).click());
  const reaperFiles = Object.keys(unzipSync(reaper.bytes));
  expect(reaperFiles.some((f) => f.endsWith('.rpp'))).toBe(true);

  const everything = await download(page, () => page.getByRole('button', { name: 'Export everything (.zip)' }).click(), 300_000);
  const all = Object.keys(unzipSync(everything.bytes));
  expect(all).toEqual(expect.arrayContaining(['Master.wav', 'Instrumental.wav', 'Acapella.wav', 'Stems.zip', 'Song.mid', 'Song.musicxml']));
  expect(all.some((f) => f.endsWith('.songproject'))).toBe(true);

  await page.screenshot({ path: `${SHOTS}/export-done.png`, fullPage: true });
  expect(errors, errors.join('\n')).toEqual([]);
});

/** A short stereo 16-bit WAV (sine with a slow tremolo) to import as a stem. */
function stemWav(seconds = 3, sampleRate = 44100): Buffer {
  const frames = seconds * sampleRate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const v = Math.round(0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t)) * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('stem import, strip locks, automation drawing and EQ editing', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await composeSong(page);
  await page.getByRole('button', { name: 'Mix & Master' }).click();
  await expect(page.getByRole('heading', { name: 'Mix & Master' })).toBeVisible();
  const before = await page.locator('.mx-strip').count();

  // ---- Stem mixing: import an audio file as a new audio track ---------------------------------
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import stem/audio' }).click()]);
  await chooser.setFiles({ name: 'backing_vocals_stem.wav', mimeType: 'audio/wav', buffer: stemWav() });
  await attestUpload(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/0:03 · 44\.1 kHz · stereo/)).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Stem group' })).toHaveValue('vocals');
  await dialog.getByRole('button', { name: 'Add audio track' }).click();
  const stem = page.getByRole('group', { name: 'backing vocals stem channel strip' });
  await expect(stem).toBeVisible();
  expect(await page.locator('.mx-strip').count()).toBe(before + 1);
  await expect(stem.getByRole('slider', { name: 'backing vocals stem volume' })).toHaveAttribute('aria-valuenow', '0');

  // ---- Locks: a locked strip is read-only and the AI never touches it -------------------------
  await stem.locator('.lock-btn').click();
  await expect(stem.getByRole('slider', { name: 'backing vocals stem volume' })).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel('Mix instruction').fill('Make the vocal clearer.');
  await page.getByRole('button', { name: 'Propose mix change' }).click();
  const proposal = page.getByTestId('mix-proposal').first();
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(proposal.getByRole('rowheader', { name: 'backing vocals stem' })).toHaveCount(0);
  await proposal.getByRole('button', { name: 'Reject' }).click();

  // ---- EQ: keyboard on the inspector knobs (selected strip) ------------------------------------
  const firstStrip = page.locator('.mx-strip').first();
  await firstStrip.locator('.mx-strip-name').click();
  const gain = page.getByRole('slider', { name: /Low-mid gain$/ }).first();
  const g0 = Number(await gain.getAttribute('aria-valuenow'));
  await gain.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => Number(await gain.getAttribute('aria-valuenow'))).toBeLessThan(g0);
  await page.screenshot({ path: `${SHOTS}/mix-eq.png` });

  // ---- Automation: add a lane, draw two points, delete one ------------------------------------
  await page.getByRole('tab', { name: 'Automation' }).click();
  const target = page.getByRole('combobox', { name: 'Automation target' });
  const firstName = (await target.locator('option').first().textContent())!.trim();
  await target.selectOption({ index: 0 });
  await page.getByRole('combobox', { name: 'Automation parameter' }).selectOption('volumeDb');
  await page.getByRole('button', { name: 'Add lane' }).click();
  const lane = page.getByRole('application', { name: new RegExp(`^${firstName} · Volume automation lane`) });
  await expect(lane).toBeVisible();
  const lb = (await lane.boundingBox())!;
  await page.mouse.click(lb.x + lb.width * 0.25, lb.y + lb.height * 0.3);
  await page.mouse.click(lb.x + lb.width * 0.7, lb.y + lb.height * 0.7);
  const row = page.locator('.mx-auto-row', { has: lane });
  await expect(row.getByText('2 points')).toBeVisible();
  // Double-click the second point → removed.
  await page.mouse.dblclick(lb.x + lb.width * 0.7, lb.y + lb.height * 0.7);
  await expect(row.getByText('1 point', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mix-automation-edit.png` });

  // ---- Stems export includes the imported audio track individually ---------------------------
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Export', exact: true })).toBeVisible();
  const stems = await download(page, () => page.getByRole('button', { name: 'Stems.zip' }).click());
  const files = Object.keys(unzipSync(stems.bytes));
  expect(files.some((f) => /^Audio tracks\/\d\d backing vocals stem\.wav$/.test(f))).toBe(true);
  expect(files).toContain('Vocals.wav');

  const dawproject = await download(page, () => page.getByRole('button', { name: '.dawproject' }).click());
  const daw = Object.keys(unzipSync(dawproject.bytes));
  expect(daw).toEqual(expect.arrayContaining(['project.xml', 'metadata.xml']));

  expect(errors, errors.join('\n')).toEqual([]);
});
