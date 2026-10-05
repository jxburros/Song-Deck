import { expect, test } from '@playwright/test';
import { composeStep, openComposer, openShape } from './compose-helpers';
import { openTool, trackHeader } from './nav';

/**
 * Start a song, offline: (a) the exact instruments and counts picked on Shape are the tracks you get,
 * next to your own material; (b) lyrics-first — pasted lyrics with [Verse]/[Chorus] headers are sung,
 * shown in Vocals and locked; (c) a song needs some material and at least one basic.
 */

/** A one-note C4 MIDI riff (format 1, one track). */
const RIFF = Buffer.from([
  ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0],
  ...[
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 13, 0x00, 0x90, 0x3c, 0x64, 0x83, 0x60, 0x80, 0x3c, 0x40, 0x00, 0xff,
    0x2f, 0x00,
  ],
]);

test('builder: the instruments and counts you pick are exactly the tracks you get', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await openComposer(page);
  const builder = page.getByTestId('compose-builder');

  // Offline: no prompt to add, and nothing to create from yet.
  await expect(
    builder.getByTestId('material').getByRole('button', { name: 'Prompt', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Song description')).toHaveCount(0);
  await builder.getByRole('button', { name: 'Remove lyrics' }).click();
  await expect(builder.getByRole('button', { name: 'Create now, rest on Auto' })).toHaveCount(0);
  await expect(builder).toContainText('Add some starting material');

  // Material: one MIDI riff (an instrumental song).
  await builder
    .getByTestId('material')
    .locator('input[type=file][accept*=".mid"]')
    .setInputFiles({ name: 'riff.mid', mimeType: 'audio/midi', buffer: RIFF });
  await expect(builder.getByTestId('compose-input')).toHaveCount(1);
  await openShape(page);

  // Genre: search, pick, see the influence slider.
  await builder.getByLabel('Search genres').fill('folk');
  await builder.getByTestId('builder-genres').getByRole('button', { name: 'Folk', exact: true }).click();
  await expect(builder.getByLabel('Folk influence')).toBeVisible();
  // With no instruments yet, the builder suggests a line-up for the genre.
  await expect(builder.getByTestId('instrument-suggestion')).toContainText('Suggested for Folk');

  // Instruments: Acoustic Guitar × 2, Cello × 1, Drum Kit × 1.
  const instruments = builder.getByTestId('builder-instruments');
  await builder.getByLabel('Search instruments').fill('acoustic');
  await instruments.getByRole('button', { name: 'Acoustic Guitar', exact: true }).click();
  await builder.getByRole('button', { name: 'More Acoustic Guitar' }).click();
  await builder.getByLabel('Search instruments').fill('cello');
  await instruments.getByRole('button', { name: 'Cello', exact: true }).click();
  await builder.getByLabel('Search instruments').fill('drum kit');
  await instruments.getByRole('button', { name: 'Drum Kit', exact: true }).click();
  await expect(builder.getByTestId('builder-instrument')).toHaveCount(3);
  await expect(
    builder
      .getByTestId('builder-instrument')
      .filter({ hasText: 'Acoustic Guitar' })
      .getByTestId('instrument-count'),
  ).toHaveText('× 2');

  // Mood (whole song), instrumental, an exact tempo.
  await builder.getByLabel('Search moods').fill('warm');
  await builder.getByTestId('builder-moods').getByRole('button', { name: 'Warm', exact: true }).click();
  await builder.getByLabel('Vocal', { exact: true }).selectOption('none');
  await builder.getByLabel('Tempo', { exact: true }).selectOption('bpm');
  await builder.getByLabel('BPM').fill('96');
  await expect(builder.getByTestId('builder-summary')).toContainText('4 tracks');
  await expect(builder.getByTestId('builder-summary')).toContainText('96 BPM');

  await page.getByRole('button', { name: 'Create song' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout: 60_000 });

  // The four picked tracks, plus the riff kept as its own (locked) track.
  const names = await page.getByTestId('track-header').allTextContents();
  expect(names).toHaveLength(5);
  const has = (n: string) => names.filter((t) => t.includes(n)).length;
  expect(has('Acoustic Guitar')).toBe(2);
  expect(has('Cello')).toBe(1);
  expect(has('Drums')).toBe(1);
  expect(has('Vocal')).toBe(0);
  const song = (await page.evaluate(`import('/src/state/store.ts').then(({ useStudio }) => {
    const s = useStudio.getState().project.song;
    const composed = s.tracks.filter((t) => !s.locks['track:' + t.id]);
    return { bpm: s.tempoMap[0].bpm, tags: (s.blueprint && s.blueprint.tags) || [], ids: composed.map((t) => t.instrumentId).sort() };
  })`)) as { bpm: number; tags: string[]; ids: string[] };
  expect(song.bpm).toBe(96);
  expect(song.tags).toContain('warm');
  expect(song.ids).toEqual(['acoustic-guitar', 'acoustic-guitar', 'cello', 'drum-kit']);
  expect(errors, errors.join('\n')).toEqual([]);
});

const LYRICS = `[Verse 1]
Under the streetlights I wait for the rain
Counting the cars as they carry my name

[Chorus]
Hold on, hold on to me
We were never meant to be free

[Verse 2]
Nobody answers the call
Shadows are taller than all

[Chorus]`;

test('lyrics-first: pasted lyrics are sung, shown in Vocals and locked', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start from lyrics' }).click();
  const builder = page.getByTestId('compose-builder');
  await builder.getByLabel('Lyrics', { exact: true }).fill(LYRICS);

  // Live preview of the detected sections, with editable kinds and syllable counts.
  const rows = builder.getByTestId('lyric-preview-section');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute('data-kind', 'verse');
  await expect(rows.nth(1)).toHaveAttribute('data-kind', 'chorus');
  await expect(rows.nth(3)).toHaveAttribute('data-kind', 'chorus');
  await expect(rows.nth(0)).toContainText('syllables');
  await expect(builder.getByLabel('Kind of section 2 (Chorus)')).toHaveValue('chorus');

  // Then Shape for the sound.
  await builder.getByRole('button', { name: 'Next: shape the song' }).click();
  await builder.getByRole('button', { name: 'Folk & country', exact: true }).click();
  await page.getByRole('button', { name: 'Create song' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout: 60_000 });

  await openTool(page, 'Lyrics');
  const verse = page.getByLabel('Lyrics for Verse 1');
  await expect(verse).toHaveValue(
    'Under the streetlights I wait for the rain\nCounting the cars as they carry my name',
  );
  await expect(verse).toHaveAttribute('readonly', '');
  const verseSection = page.getByTestId('lyric-section').filter({ hasText: 'Verse 1' });
  await expect(verseSection.locator('.lock-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Lyrics for Chorus', { exact: true })).toHaveValue(
    'Hold on, hold on to me\nWe were never meant to be free',
  );
  // The lyric writer is the user, not an AI.
  const rights = (await page.evaluate(
    `import('/src/state/store.ts').then(({ useStudio }) => useStudio.getState().project.meta.rights.lyricWriters)`,
  )) as string[];
  expect(rights.length).toBeGreaterThan(0);
  expect(rights.join(' ')).not.toMatch(/AI|Placeholder/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('lyrics-first: an instrumental starting point still gets a singer for your lyrics', async ({ page }) => {
  await page.goto('/');
  await openComposer(page);
  const builder = page.getByTestId('compose-builder');
  // "Laid-back hip-hop" is instrumental; pasting lyrics afterwards brings the vocal back.
  await openShape(page);
  await builder.getByRole('button', { name: 'Laid-back hip-hop', exact: true }).click();
  await composeStep(page, 'Material');
  await builder.getByLabel('Lyrics', { exact: true }).fill(LYRICS);
  await builder.getByRole('button', { name: 'Create now, rest on Auto' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('track-header').filter({ hasText: 'Lead Vocal' })).toHaveCount(1);
  await expect(trackHeader(page, 'Lead Vocal')).toBeVisible();
});
