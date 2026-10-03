import { expect, test, type Page } from '@playwright/test';

/**
 * Locking guarantee through the UI (spec §22): "Regenerate unlocked material" changes only
 * unlocked components, and every regeneration is a reversible revision (spec §52).
 */

interface TrackSnapshot {
  id: string;
  name: string;
  notes: string;
}

/**
 * Read the live song from the studio's own store module. In the Vite dev server the page can
 * import `/src/state/store.ts` and gets the same module instance the app uses.
 */
async function snapshot(page: Page): Promise<TrackSnapshot[]> {
  return page.evaluate(
    `import('/src/state/store.ts').then(({ useStudio }) =>
      useStudio.getState().project.song.tracks.map((t) => ({ id: t.id, name: t.name, notes: JSON.stringify(t.notes) })))`,
  );
}

async function composeSong(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compose a new song' }).click();
  await page
    .getByLabel('Song prompt')
    .fill('Emo pop-punk at 164 BPM in E minor: melancholy verses, cathartic chorus. Drums, bass, rhythm guitar, lead guitar, piano.');
  await page.getByRole('button', { name: 'Draft Song Blueprint' }).click();
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await page.getByRole('button', { name: 'Generate MIDI composition' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible();
}

test('regenerating unlocked material never touches locked tracks, and undo restores it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await composeSong(page);

  const before = await snapshot(page);
  const drums = before.find((t) => /drum/i.test(t.name));
  expect(drums, 'composed song has a drum track').toBeTruthy();
  expect(before.length).toBeGreaterThan(3);

  // Lock the drum track from its track row.
  const drumRow = page.locator('.wb-left .track-row', { hasText: drums!.name }).first();
  await drumRow.locator('.lock-btn').click();
  await expect(drumRow.locator('.lock-btn')).toHaveAttribute('aria-pressed', 'true');

  // Regenerate everything that is unlocked.
  await page.getByRole('button', { name: 'Regenerate unlocked', exact: true }).click();
  await expect(page.getByText(/locked material unchanged/i)).toBeVisible();

  const after = await snapshot(page);
  expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
  // Locked: byte-identical. Unlocked: at least one track got new material.
  expect(after.find((t) => t.id === drums!.id)!.notes).toBe(drums!.notes);
  const changed = after.filter((t) => t.notes !== before.find((b) => b.id === t.id)!.notes);
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.some((t) => t.id === drums!.id)).toBe(false);

  // The regeneration is a revision: undo brings every track back exactly.
  await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
  const undone = await snapshot(page);
  expect(undone).toEqual(before);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('regenerating a single track leaves every other track untouched', async ({ page }) => {
  await composeSong(page);
  const before = await snapshot(page);
  const bass = before.find((t) => /bass/i.test(t.name));
  expect(bass, 'composed song has a bass track').toBeTruthy();

  await page.locator('.wb-left .track-row', { hasText: bass!.name }).first().click();
  await page.getByRole('button', { name: 'Regenerate track', exact: true }).click();
  await expect(page.getByText(/locked material unchanged/i)).toBeVisible();

  const after = await snapshot(page);
  for (const t of after) {
    const prev = before.find((b) => b.id === t.id)!;
    if (t.id === bass!.id) expect(t.notes).not.toBe(prev.notes);
    else expect(t.notes, `${t.name} must not change`).toBe(prev.notes);
  }
});

test('accepting a proposal keeps edits made while it was pending', async ({ page }) => {
  await composeSong(page);
  const before = await snapshot(page);
  const bass = before.find((t) => /bass/i.test(t.name))!;
  const drums = before.find((t) => /drum/i.test(t.name))!;

  await page.locator('.wb-left .track-row', { hasText: bass.name }).first().click();
  await page.locator('.right-tabs .tab', { hasText: 'AI Edit' }).click();
  await page.getByLabel('Edit instruction').fill('Make the bass busier.');
  await page.getByRole('button', { name: 'Propose change' }).click();
  await expect(page.getByRole('button', { name: 'Accept' }).first()).toBeVisible();

  // While the proposal is pending, mute the drums (a separate revision).
  await page.locator('.wb-left .track-row', { hasText: drums.name }).first().locator('.ms-btn.mute').click();
  await page.getByRole('button', { name: 'Accept' }).first().click();

  const state = await page.evaluate(
    `import('/src/state/store.ts').then(({ useStudio }) => {
      const song = useStudio.getState().project.song;
      return { drumsMuted: !!song.mixer.channels[${JSON.stringify(drums.id)}]?.mute, bassNotes: JSON.stringify(song.tracks.find((t) => t.id === ${JSON.stringify(bass.id)}).notes) };
    })`,
  );
  expect(state).toMatchObject({ drumsMuted: true });
  expect((state as { bassNotes: string }).bassNotes).not.toBe(bass.notes);
});
