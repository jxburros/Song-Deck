import { expect, test, type Page } from '@playwright/test';

/**
 * MIDI keyboard capture (spec §27 "play an instrument … and convert that performance into MIDI"),
 * driven by a fake Web MIDI input injected before the app loads.
 */

declare global {
  interface Window {
    __midi(bytes: number[]): void;
  }
}

async function pianoNotes(page: Page): Promise<number> {
  return page.evaluate(
    `import('/src/state/store.ts').then(({ useStudio }) =>
      useStudio.getState().project.song.tracks.find((t) => t.name === 'Piano').notes.length)`,
  );
}

test('records a MIDI keyboard take into the selected track as one undoable revision', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const input = Object.assign(new EventTarget(), { id: 'fake-keys', name: 'Fake Keys', manufacturer: 'Song Deck', type: 'input', state: 'connected' });
    const access = Object.assign(new EventTarget(), { inputs: new Map([[input.id, input]]), outputs: new Map(), sysexEnabled: false });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) });
    window.__midi = (bytes: number[]) => {
      const e = new Event('midimessage');
      Object.defineProperty(e, 'data', { value: new Uint8Array(bytes) });
      input.dispatchEvent(e);
    };
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Compose a new song' }).click();
  await page.getByLabel('Song prompt').fill('Laid-back hip-hop beat at 88 BPM with jazzy piano, upright bass and swung drums.');
  await page.getByRole('button', { name: 'Draft Song Blueprint' }).click();
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await page.getByRole('button', { name: 'Generate MIDI composition' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible();

  await page.locator('.wb-left .track-row', { hasText: 'Piano' }).first().click();
  await page.getByRole('tab', { name: 'Piano Roll' }).click();
  await expect(page.getByTestId('piano-roll')).toBeVisible();
  const before = await pianoNotes(page);

  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Stop · \d+ notes$/ })).toBeVisible();
  for (const pitch of [60, 64, 67]) {
    await page.evaluate((p) => window.__midi([0x90, p, 100]), pitch);
    await page.waitForTimeout(120);
    await page.evaluate((p) => window.__midi([0x80, p, 0]), pitch);
  }
  await page.getByRole('button', { name: 'Stop · 3 notes' }).click();
  await expect(page.getByText('Recorded 3 notes into Piano.')).toBeVisible();
  expect(await pianoNotes(page)).toBe(before + 3);

  await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
  expect(await pianoNotes(page)).toBe(before);
  expect(errors, errors.join('\n')).toEqual([]);
});
